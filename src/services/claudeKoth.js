/**
 * Claude AI KOTH Selection Service
 * v25.38 - Uses Claude to intelligently select the King of the Pill
 * v25.39 - Optimized for credit efficiency (Haiku model, reduced tokens)
 * v25.40 - Enhanced debugging with Redis log storage and admin controls
 * v25.70 - Now includes Robinhood partner tokens in KOTH candidates
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
 * v25.70: Now includes source type (platform vs robinhood partner)
 */
function formatTokensForPrompt(tokens) {
    // Limit to MAX_CANDIDATES to reduce input tokens
    const limited = tokens.slice(0, MAX_CANDIDATES);

    return limited.map((t, i) => {
        const ageHours = t.timestamp ? Math.round((Date.now() - t.timestamp) / (1000 * 60 * 60)) : 0;
        // v25.70: Include source type in prompt
        const sourceLabel = t.source === 'robinhood' ? '🤝Partner' : '🚀Platform';
        // Compact format: ~50 tokens per candidate vs ~80 in verbose format
        return `${i + 1}. ${t.ticker} (${sourceLabel}): MCap $${(t.marketCap || 0).toLocaleString()}, Vol $${(t.volume24h || 0).toLocaleString()}, ${t.actualHolders || t.holderCount || 0} holders, ${ageHours}h old [${t.mint.slice(0, 8)}]`;
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

    // Concise system prompt - explicitly forbid markdown
    const systemPrompt = `You select the KOTH (King of the Pill) token from candidates. KOTH holders get 10% airdrop bonus.
Prioritize: 1) 24hr Volume 2) Market Cap 3) Holder count 4) Token age
CRITICAL: Output ONLY raw JSON. No markdown, no code blocks, no backticks. Just the JSON object.`;

    const userPrompt = `CANDIDATES:\n${tokenList}\n\nRespond with this exact JSON structure (no markdown):
{"selectedTicker":"X","selectedMint":"prefix","confidence":50,"reasoning":"One sentence why.","runnerUp":"Y"}`;

    try {
        logger.info(`[ClaudeKOTH] Requesting selection from ${Math.min(candidates.length, MAX_CANDIDATES)} candidates using ${CLAUDE_MODEL}...`);

        const apiStartTime = Date.now();
        const response = await client.messages.create({
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
            const jsonStart = jsonText.indexOf('{');
            if (jsonStart !== -1) {
                jsonText = jsonText.slice(jsonStart);

                // If JSON is truncated, try to salvage what we can
                try {
                    result = JSON.parse(jsonText);
                } catch (e) {
                    // Try to fix truncated JSON
                    logger.debug('[ClaudeKOTH] Attempting to recover truncated JSON...');

                    // Remove any trailing incomplete key-value pairs
                    // e.g., "runnerUpReason":"Second-  ->  remove this incomplete part
                    jsonText = jsonText.replace(/,\s*"[^"]*":\s*"[^"]*$/g, '');

                    // If still truncated mid-string, close it
                    if (jsonText.match(/"[^"]*$/)) {
                        jsonText += '"';
                    }

                    // Count and balance braces
                    let openBraces = (jsonText.match(/\{/g) || []).length;
                    let closeBraces = (jsonText.match(/\}/g) || []).length;
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

            // Validate required fields exist
            if (!result.selectedTicker || !result.selectedMint) {
                throw new Error('Missing required fields: selectedTicker or selectedMint');
            }

            // Set defaults for optional fields
            result.confidence = result.confidence || 50;
            result.reasoning = result.reasoning || 'Selected based on metrics.';
            result.runnerUp = result.runnerUp || null;

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
    // v25.41: Simplified - only consider top 10 leaderboard tokens (by 24hr volume)
    // v25.70: Now includes both platform AND robinhood tokens, selecting top 10 by volume
    // This reduces API calls and ensures KOTH is always a visible, active token

    logger.debug('[ClaudeKOTH] Starting KOTH selection with fallback', {
        aiEnabled: isEnabled()
    });

    try {
        // v25.70: Get top 10 tokens by 24hr volume from BOTH platform and robinhood tokens
        const queryStart = Date.now();
        let candidates = await db.all(`
            SELECT mint, ticker, name, "marketCap", volume24h, "holderCount", timestamp, actualHolders, source
            FROM (
                SELECT
                    t.mint,
                    t.ticker,
                    t.name,
                    t."marketCap",
                    t.volume24h,
                    t."holderCount",
                    t.timestamp,
                    COALESCE((SELECT COUNT(*) FROM token_holders th WHERE th.mint = t.mint), 0) as actualHolders,
                    'platform' as source
                FROM tokens t
                WHERE t.volume24h > 0

                UNION ALL

                SELECT
                    rt.mint,
                    rt.ticker,
                    rt.name,
                    rt."marketCap",
                    rt.volume24h,
                    0 as "holderCount",
                    rt."discoveredAt" as timestamp,
                    COALESCE((SELECT COUNT(*) FROM robinhood_token_holders rth WHERE rth.mint = rt.mint), 0) as actualHolders,
                    'robinhood' as source
                FROM robinhood_tokens rt
                WHERE rt."isActive" = 1 AND rt.volume24h > 0
            )
            ORDER BY volume24h DESC
            LIMIT 10
        `);
        const queryDuration = Date.now() - queryStart;

        // v25.70: Log source breakdown
        const platformCount = candidates.filter(c => c.source === 'platform').length;
        const robinhoodCount = candidates.filter(c => c.source === 'robinhood').length;

        logger.debug('[ClaudeKOTH] Candidate query completed', {
            candidateCount: candidates.length,
            platformCount,
            robinhoodCount,
            queryDurationMs: queryDuration
        });

        await logEvaluation({
            type: 'CANDIDATE_QUERY',
            candidateCount: candidates.length,
            platformCount,
            robinhoodCount,
            queryDurationMs: queryDuration,
            message: `Top 10 tokens by 24hr volume (${platformCount} platform, ${robinhoodCount} robinhood)`
        });

        if (candidates.length === 0) {
            logger.warn('[ClaudeKOTH] No candidates found - no tokens with volume');
            await logEvaluation({
                type: 'NO_CANDIDATES_AT_ALL',
                message: 'No tokens with any volume found'
            });
            return { token: null, score: 0, reasoning: 'No tokens with trading volume found' };
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
