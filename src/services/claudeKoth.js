/**
 * Claude AI KOTH Selection Service
 * v25.38 - Uses Claude to intelligently select the King of the Pill
 * v25.39 - Optimized for credit efficiency (Haiku model, reduced tokens)
 * v25.40 - Enhanced debugging with Redis log storage and admin controls
 *
 * This service calls Claude API to analyze token metrics and select
 * the best candidate for KOTH based on multiple factors.
 *
 * Cost optimization:
 * - Uses claude-haiku (fastest, cheapest) - sufficient for structured selection
 * - Limits candidates to top 10 to reduce input tokens
 * - max_tokens capped at 512 (response is ~200 tokens)
 * - Caches results for 1 hour to minimize API calls
 *
 * Debugging:
 * - Detailed logging at each step of the selection process
 * - Evaluation logs stored in Redis for admin panel access
 * - Manual refresh capability via admin endpoints
 */
const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('../config/env');
const logger = require('./logger');

// Model selection - Haiku 4.5 is cheaper than Sonnet and sufficient for this task
// $1/MTok input, $5/MTok output vs Sonnet's $3/$15
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CANDIDATES = 10; // Limit candidates to reduce input tokens
const MAX_RESPONSE_TOKENS = 1024; // Increased from 512 to handle longer reasoning

// Redis key for KOTH evaluation logs
const KOTH_LOG_KEY = 'koth_ai_evaluation_logs';
const KOTH_CURRENT_KEY = 'koth_ai_current';
const KOTH_LOG_MAX_ENTRIES = 100; // Keep last 100 evaluations
const KOTH_LOG_TTL = 86400 * 7; // 7 days TTL

// Initialize Anthropic client (lazy initialization)
let anthropic = null;
let redisClient = null;

function getClient() {
    if (!anthropic && config.ANTHROPIC_API_KEY) {
        anthropic = new Anthropic({
            apiKey: config.ANTHROPIC_API_KEY
        });
    }
    return anthropic;
}

/**
 * Set Redis client for log storage
 * Called during service initialization
 */
function setRedisClient(client) {
    redisClient = client;
    logger.debug('[ClaudeKOTH] Redis client configured for log storage');
}

/**
 * Log a KOTH evaluation event to Redis
 * Maintains a rolling log of the last MAX_ENTRIES evaluations
 */
async function logEvaluation(entry) {
    if (!redisClient) {
        logger.debug('[ClaudeKOTH] No Redis client, skipping log storage');
        return;
    }

    try {
        const logEntry = {
            ...entry,
            timestamp: Date.now(),
            timestampISO: new Date().toISOString()
        };

        // Add to list (LPUSH adds to head)
        await redisClient.lpush(KOTH_LOG_KEY, JSON.stringify(logEntry));

        // Trim to keep only last MAX_ENTRIES
        await redisClient.ltrim(KOTH_LOG_KEY, 0, KOTH_LOG_MAX_ENTRIES - 1);

        // Refresh TTL
        await redisClient.expire(KOTH_LOG_KEY, KOTH_LOG_TTL);

        logger.debug('[ClaudeKOTH] Evaluation logged', { type: entry.type });
    } catch (error) {
        logger.debug('[ClaudeKOTH] Failed to store log entry', { error: error.message });
    }
}

/**
 * Get all KOTH evaluation logs from Redis
 */
async function getEvaluationLogs(limit = 50) {
    if (!redisClient) {
        return [];
    }

    try {
        const logs = await redisClient.lrange(KOTH_LOG_KEY, 0, limit - 1);
        return logs.map(log => {
            try {
                return JSON.parse(log);
            } catch (e) {
                return { raw: log, parseError: true };
            }
        });
    } catch (error) {
        logger.error('[ClaudeKOTH] Failed to retrieve logs', { error: error.message });
        return [];
    }
}

/**
 * Store current KOTH selection in Redis
 */
async function setCurrentKoth(selection) {
    if (!redisClient) return;

    try {
        await redisClient.set(KOTH_CURRENT_KEY, JSON.stringify({
            ...selection,
            updatedAt: Date.now(),
            updatedAtISO: new Date().toISOString()
        }), 'EX', 7200); // 2 hour TTL
    } catch (error) {
        logger.debug('[ClaudeKOTH] Failed to store current KOTH', { error: error.message });
    }
}

/**
 * Get current KOTH selection from Redis
 */
async function getCurrentKoth() {
    if (!redisClient) return null;

    try {
        const data = await redisClient.get(KOTH_CURRENT_KEY);
        return data ? JSON.parse(data) : null;
    } catch (error) {
        logger.debug('[ClaudeKOTH] Failed to retrieve current KOTH', { error: error.message });
        return null;
    }
}

/**
 * Clear current KOTH cache to force refresh
 */
async function clearCurrentKoth() {
    if (!redisClient) return false;

    try {
        await redisClient.del(KOTH_CURRENT_KEY);
        logger.info('[ClaudeKOTH] Current KOTH cache cleared');
        return true;
    } catch (error) {
        logger.error('[ClaudeKOTH] Failed to clear KOTH cache', { error: error.message });
        return false;
    }
}

/**
 * Check if Claude AI KOTH is available
 */
function isEnabled() {
    return config.KOTH_AI_ENABLED && !!config.ANTHROPIC_API_KEY;
}

/**
 * Format token data for Claude prompt (compact format to save tokens)
 */
function formatTokensForPrompt(tokens) {
    // Limit to MAX_CANDIDATES to reduce input tokens
    const limited = tokens.slice(0, MAX_CANDIDATES);

    return limited.map((t, i) => {
        const ageHours = t.timestamp ? Math.round((Date.now() - t.timestamp) / (1000 * 60 * 60)) : 0;
        // Compact format: ~50 tokens per candidate vs ~80 in verbose format
        return `${i + 1}. ${t.ticker}: MCap $${(t.marketCap || 0).toLocaleString()}, Vol $${(t.volume24h || 0).toLocaleString()}, ${t.actualHolders || t.holderCount || 0} holders, ${ageHours}h old [${t.mint.slice(0, 8)}]`;
    }).join('\n');
}

/**
 * Call Claude to select the KOTH
 *
 * @param {Array} candidates - Array of eligible token objects
 * @returns {Object} Selection result with winner, reasoning, and score
 */
async function selectKoth(candidates) {
    const startTime = Date.now();
    const client = getClient();

    // Log evaluation start
    await logEvaluation({
        type: 'EVALUATION_START',
        candidateCount: candidates?.length || 0,
        aiEnabled: isEnabled(),
        hasClient: !!client
    });

    if (!client) {
        logger.warn('[ClaudeKOTH] No API key configured, falling back to algorithm');
        await logEvaluation({
            type: 'NO_API_KEY',
            message: 'Anthropic API key not configured'
        });
        return null;
    }

    if (!candidates || candidates.length === 0) {
        logger.debug('[ClaudeKOTH] No candidates provided');
        await logEvaluation({
            type: 'NO_CANDIDATES',
            message: 'No eligible candidates provided'
        });
        return null;
    }

    // Log candidates summary
    const candidateSummary = candidates.slice(0, MAX_CANDIDATES).map(t => ({
        ticker: t.ticker,
        mint: t.mint.slice(0, 8) + '...',
        marketCap: t.marketCap || 0,
        volume24h: t.volume24h || 0,
        holders: t.actualHolders || t.holderCount || 0
    }));

    logger.debug('[ClaudeKOTH] Evaluating candidates', { count: candidateSummary.length });
    await logEvaluation({
        type: 'CANDIDATES_PREPARED',
        count: candidateSummary.length,
        totalAvailable: candidates.length,
        candidates: candidateSummary
    });

    const tokenList = formatTokensForPrompt(candidates);

    // Concise system prompt (~150 tokens vs ~250 original)
    const systemPrompt = `Select the best KOTH (King of the Pill) token. Holders get 10% airdrop bonus.
Prioritize: 1) 24hr Volume (most important) 2) Market Cap 3) Holder count 4) Token age (older=reliable)
Avoid pump-and-dumps (new tokens with suspicious metrics). Respond with JSON only, no markdown.`;

    const userPrompt = `CANDIDATES:\n${tokenList}\n\nJSON response format:
{"selectedTicker":"TICKER","selectedMint":"mint_prefix","confidence":85,"reasoning":"Why selected (2-3 sentences)","runnerUp":"TICKER2","runnerUpReason":"Brief reason"}`;

    try {
        logger.info(`[ClaudeKOTH] Requesting selection from ${Math.min(candidates.length, MAX_CANDIDATES)} candidates using ${CLAUDE_MODEL}...`);

        const apiStartTime = Date.now();
        const response = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: MAX_RESPONSE_TOKENS,
            messages: [
                {
                    role: 'user',
                    content: userPrompt
                }
            ],
            system: systemPrompt
        });
        const apiDuration = Date.now() - apiStartTime;

        // Log API response stats
        const usage = response.usage;
        await logEvaluation({
            type: 'API_RESPONSE',
            model: CLAUDE_MODEL,
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            apiDurationMs: apiDuration,
            stopReason: response.stop_reason
        });

        // Extract text content
        const textContent = response.content.find(c => c.type === 'text');
        if (!textContent) {
            logger.error('[ClaudeKOTH] No text content in response');
            await logEvaluation({
                type: 'ERROR',
                error: 'No text content in Claude response',
                responseContent: JSON.stringify(response.content).slice(0, 200)
            });
            return null;
        }

        // Parse JSON response
        let result;
        try {
            // Clean potential markdown code blocks (handles both complete and truncated responses)
            let jsonText = textContent.text.trim();

            // Remove opening markdown fence
            if (jsonText.startsWith('```')) {
                jsonText = jsonText.replace(/^```json?\n?/, '');
            }

            // Remove closing markdown fence (if present)
            jsonText = jsonText.replace(/\n?```\s*$/, '').trim();

            // Try to extract valid JSON even if truncated
            // Look for the opening brace and try to find matching close
            const jsonStart = jsonText.indexOf('{');
            if (jsonStart !== -1) {
                jsonText = jsonText.slice(jsonStart);

                // If JSON is truncated, try to salvage what we can
                try {
                    result = JSON.parse(jsonText);
                } catch (e) {
                    // Try to fix truncated JSON by adding closing braces/quotes
                    // Count open braces and brackets
                    let openBraces = (jsonText.match(/\{/g) || []).length;
                    let closeBraces = (jsonText.match(/\}/g) || []).length;

                    // If truncated mid-string, close the string
                    if (jsonText.match(/"[^"]*$/)) {
                        jsonText += '"';
                    }

                    // Add missing closing braces
                    while (closeBraces < openBraces) {
                        jsonText += '}';
                        closeBraces++;
                    }

                    result = JSON.parse(jsonText);
                    logger.warn('[ClaudeKOTH] Recovered truncated JSON response');
                }
            } else {
                throw new Error('No JSON object found in response');
            }
        } catch (parseError) {
            logger.error('[ClaudeKOTH] Failed to parse response JSON', {
                error: parseError.message,
                response: textContent.text.slice(0, 500)
            });
            await logEvaluation({
                type: 'PARSE_ERROR',
                error: parseError.message,
                rawResponse: textContent.text.slice(0, 500)
            });
            return null;
        }

        // Log parsed result
        await logEvaluation({
            type: 'PARSED_RESULT',
            selectedTicker: result.selectedTicker,
            selectedMint: result.selectedMint,
            confidence: result.confidence,
            reasoning: result.reasoning,
            runnerUp: result.runnerUp
        });

        // Find the selected token
        const selectedToken = candidates.find(t =>
            t.ticker === result.selectedTicker ||
            t.mint === result.selectedMint ||
            t.mint.startsWith(result.selectedMint?.slice(0, 8))
        );

        if (!selectedToken) {
            logger.error('[ClaudeKOTH] Selected token not found in candidates', {
                selectedTicker: result.selectedTicker,
                selectedMint: result.selectedMint
            });
            await logEvaluation({
                type: 'TOKEN_NOT_FOUND',
                error: 'Selected token not found in candidates',
                selectedTicker: result.selectedTicker,
                selectedMint: result.selectedMint,
                availableTickers: candidates.map(c => c.ticker)
            });
            return null;
        }

        // Log token usage for cost monitoring
        const totalDuration = Date.now() - startTime;
        logger.info(`[ClaudeKOTH] Selected: ${selectedToken.ticker} (confidence: ${result.confidence}%) | Tokens: ${usage?.input_tokens || 0} in, ${usage?.output_tokens || 0} out`);

        const selectionResult = {
            token: selectedToken,
            score: result.confidence,
            reasoning: result.reasoning,
            runnerUp: result.runnerUp,
            runnerUpReason: result.runnerUpReason,
            model: CLAUDE_MODEL,
            isAI: true
        };

        // Log successful selection
        await logEvaluation({
            type: 'SELECTION_SUCCESS',
            selectedTicker: selectedToken.ticker,
            selectedMint: selectedToken.mint,
            confidence: result.confidence,
            reasoning: result.reasoning,
            runnerUp: result.runnerUp,
            runnerUpReason: result.runnerUpReason,
            tokenMetrics: {
                marketCap: selectedToken.marketCap,
                volume24h: selectedToken.volume24h,
                holders: selectedToken.actualHolders || selectedToken.holderCount
            },
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            totalDurationMs: totalDuration,
            apiDurationMs: apiDuration
        });

        // Store current selection
        await setCurrentKoth(selectionResult);

        return selectionResult;

    } catch (error) {
        logger.error('[ClaudeKOTH] API call failed', {
            error: error.message,
            status: error.status
        });

        // Log API error
        await logEvaluation({
            type: 'API_ERROR',
            error: error.message,
            status: error.status,
            code: error.code,
            stack: error.stack?.slice(0, 500)
        });

        // Don't throw - let caller fall back to algorithm
        return null;
    }
}

/**
 * Get KOTH selection with fallback
 * Tries Claude first, falls back to weighted algorithm if unavailable
 *
 * @param {Object} db - Database connection
 * @param {Function} algorithmFallback - Fallback function to use if Claude fails
 * @returns {Object} Selection result
 */
async function getKothWithFallback(db, algorithmFallback) {
    const KOTH_MIN_HOLDERS = 10;
    const KOTH_MIN_MARKET_CAP = 1000;
    const KOTH_MIN_VOLUME = 100;

    logger.debug('[ClaudeKOTH] Starting KOTH selection with fallback', {
        aiEnabled: isEnabled(),
        minHolders: KOTH_MIN_HOLDERS,
        minMarketCap: KOTH_MIN_MARKET_CAP,
        minVolume: KOTH_MIN_VOLUME
    });

    try {
        // Get eligible candidates (same query as algorithm)
        const queryStart = Date.now();
        let candidates = await db.all(`
            SELECT
                t.mint,
                t.ticker,
                t.name,
                t."marketCap",
                t.volume24h,
                t."holderCount",
                t.timestamp,
                COUNT(th."holderPubkey") as actualHolders
            FROM tokens t
            LEFT JOIN token_holders th ON th.mint = t.mint
            WHERE t."marketCap" >= $1
            AND t.volume24h >= $2
            GROUP BY t.mint, t.ticker, t.name, t."marketCap", t.volume24h, t."holderCount", t.timestamp
            HAVING COUNT(th."holderPubkey") >= $3
            ORDER BY t."marketCap" DESC
            LIMIT 20
        `, [KOTH_MIN_MARKET_CAP, KOTH_MIN_VOLUME, KOTH_MIN_HOLDERS]);
        const queryDuration = Date.now() - queryStart;

        logger.debug('[ClaudeKOTH] Candidate query completed', {
            candidateCount: candidates.length,
            queryDurationMs: queryDuration
        });

        await logEvaluation({
            type: 'CANDIDATE_QUERY',
            candidateCount: candidates.length,
            queryDurationMs: queryDuration,
            criteria: {
                minHolders: KOTH_MIN_HOLDERS,
                minMarketCap: KOTH_MIN_MARKET_CAP,
                minVolume: KOTH_MIN_VOLUME
            }
        });

        if (candidates.length === 0) {
            logger.info('[ClaudeKOTH] No candidates meet strict requirements, falling back to top 10 by volume');
            await logEvaluation({
                type: 'NO_ELIGIBLE_CANDIDATES',
                message: 'No tokens meet minimum requirements, trying volume fallback'
            });

            // Fallback: Get top 10 tokens by 24hr volume regardless of other criteria
            const fallbackQueryStart = Date.now();
            candidates = await db.all(`
                SELECT
                    t.mint,
                    t.ticker,
                    t.name,
                    t."marketCap",
                    t.volume24h,
                    t."holderCount",
                    t.timestamp,
                    COALESCE((SELECT COUNT(*) FROM token_holders th WHERE th.mint = t.mint), 0) as actualHolders
                FROM tokens t
                WHERE t.volume24h > 0
                ORDER BY t.volume24h DESC
                LIMIT 10
            `);
            const fallbackQueryDuration = Date.now() - fallbackQueryStart;

            logger.info('[ClaudeKOTH] Volume fallback query completed', {
                candidateCount: candidates.length,
                queryDurationMs: fallbackQueryDuration
            });

            await logEvaluation({
                type: 'VOLUME_FALLBACK_QUERY',
                candidateCount: candidates.length,
                queryDurationMs: fallbackQueryDuration,
                message: 'Using top 10 tokens by volume as candidates'
            });

            // If still no candidates, return null
            if (candidates.length === 0) {
                logger.warn('[ClaudeKOTH] No candidates found even with volume fallback');
                await logEvaluation({
                    type: 'NO_CANDIDATES_AT_ALL',
                    message: 'No tokens with any volume found'
                });
                return { token: null, score: 0, reasoning: 'No tokens with trading volume found' };
            }
        }

        // Try Claude first if enabled
        if (isEnabled()) {
            const aiResult = await selectKoth(candidates);
            if (aiResult) {
                return aiResult;
            }
            logger.warn('[ClaudeKOTH] AI selection failed, falling back to algorithm');
            await logEvaluation({
                type: 'FALLBACK_TO_ALGORITHM',
                reason: 'AI selection returned null'
            });
        } else {
            await logEvaluation({
                type: 'AI_DISABLED',
                reason: 'KOTH AI is not enabled or API key missing'
            });
        }

        // Fall back to algorithm
        if (algorithmFallback) {
            logger.debug('[ClaudeKOTH] Using algorithm fallback');
            const fallbackResult = await algorithmFallback(db);
            await logEvaluation({
                type: 'ALGORITHM_FALLBACK_RESULT',
                selectedTicker: fallbackResult?.token?.ticker,
                score: fallbackResult?.score,
                reasoning: fallbackResult?.reasoning
            });
            return fallbackResult;
        }

        // Last resort: highest market cap
        const winner = candidates[0];
        const lastResortResult = {
            token: winner,
            score: 50,
            reasoning: `${winner.ticker} selected based on highest market cap ($${winner.marketCap?.toLocaleString()}). AI selection unavailable.`,
            isAI: false
        };

        await logEvaluation({
            type: 'LAST_RESORT_SELECTION',
            selectedTicker: winner.ticker,
            selectedMint: winner.mint,
            marketCap: winner.marketCap,
            reason: 'No AI or algorithm fallback available'
        });

        return lastResortResult;

    } catch (error) {
        logger.error('[ClaudeKOTH] getKothWithFallback error', { error: error.message });

        await logEvaluation({
            type: 'FALLBACK_ERROR',
            error: error.message,
            stack: error.stack?.slice(0, 500)
        });

        if (algorithmFallback) {
            logger.debug('[ClaudeKOTH] Using algorithm fallback after error');
            return await algorithmFallback(db);
        }

        return { token: null, score: 0, reasoning: `Selection failed: ${error.message}` };
    }
}

/**
 * Get KOTH service status for admin panel
 */
function getStatus() {
    return {
        enabled: isEnabled(),
        model: CLAUDE_MODEL,
        maxCandidates: MAX_CANDIDATES,
        maxResponseTokens: MAX_RESPONSE_TOKENS,
        hasApiKey: !!config.ANTHROPIC_API_KEY,
        hasRedisClient: !!redisClient
    };
}

module.exports = {
    // Core functions
    isEnabled,
    selectKoth,
    getKothWithFallback,

    // Redis log management
    setRedisClient,
    getEvaluationLogs,
    getCurrentKoth,
    clearCurrentKoth,

    // Admin/debug functions
    getStatus,
    logEvaluation
};
