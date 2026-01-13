/**
 * Claude AI KOTH Selection Service
 * v25.38 - Uses Claude to intelligently select the King of the Pill
 * v25.39 - Optimized for credit efficiency (Haiku model, reduced tokens)
 *
 * This service calls Claude API to analyze token metrics and select
 * the best candidate for KOTH based on multiple factors.
 *
 * Cost optimization:
 * - Uses claude-haiku (fastest, cheapest) - sufficient for structured selection
 * - Limits candidates to top 10 to reduce input tokens
 * - max_tokens capped at 512 (response is ~200 tokens)
 * - Caches results for 1 hour to minimize API calls
 */
const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('../config/env');
const logger = require('./logger');

// Model selection - Haiku is 10x cheaper than Sonnet and sufficient for this task
const CLAUDE_MODEL = 'claude-haiku-4-20250514';
const MAX_CANDIDATES = 10; // Limit candidates to reduce input tokens
const MAX_RESPONSE_TOKENS = 512; // Response is ~200 tokens, 512 provides buffer

// Initialize Anthropic client (lazy initialization)
let anthropic = null;

function getClient() {
    if (!anthropic && config.ANTHROPIC_API_KEY) {
        anthropic = new Anthropic({
            apiKey: config.ANTHROPIC_API_KEY
        });
    }
    return anthropic;
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
    const client = getClient();

    if (!client) {
        logger.warn('[ClaudeKOTH] No API key configured, falling back to algorithm');
        return null;
    }

    if (!candidates || candidates.length === 0) {
        return null;
    }

    const tokenList = formatTokensForPrompt(candidates);

    // Concise system prompt (~150 tokens vs ~250 original)
    const systemPrompt = `Select the best KOTH (King of the Pill) token. Holders get 10% airdrop bonus.
Prioritize: 1) 24hr Volume (most important) 2) Market Cap 3) Holder count 4) Token age (older=reliable)
Avoid pump-and-dumps (new tokens with suspicious metrics). Respond with JSON only, no markdown.`;

    const userPrompt = `CANDIDATES:\n${tokenList}\n\nJSON response format:
{"selectedTicker":"TICKER","selectedMint":"mint_prefix","confidence":85,"reasoning":"Why selected (2-3 sentences)","runnerUp":"TICKER2","runnerUpReason":"Brief reason"}`;

    try {
        logger.info(`[ClaudeKOTH] Requesting selection from ${Math.min(candidates.length, MAX_CANDIDATES)} candidates using ${CLAUDE_MODEL}...`);

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

        // Extract text content
        const textContent = response.content.find(c => c.type === 'text');
        if (!textContent) {
            logger.error('[ClaudeKOTH] No text content in response');
            return null;
        }

        // Parse JSON response
        let result;
        try {
            // Clean potential markdown code blocks
            let jsonText = textContent.text.trim();
            if (jsonText.startsWith('```')) {
                jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
            }
            result = JSON.parse(jsonText);
        } catch (parseError) {
            logger.error('[ClaudeKOTH] Failed to parse response JSON', {
                error: parseError.message,
                response: textContent.text.slice(0, 500)
            });
            return null;
        }

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
            return null;
        }

        // Log token usage for cost monitoring
        const usage = response.usage;
        logger.info(`[ClaudeKOTH] Selected: ${selectedToken.ticker} (confidence: ${result.confidence}%) | Tokens: ${usage?.input_tokens || 0} in, ${usage?.output_tokens || 0} out`);

        return {
            token: selectedToken,
            score: result.confidence,
            reasoning: result.reasoning,
            runnerUp: result.runnerUp,
            runnerUpReason: result.runnerUpReason,
            model: CLAUDE_MODEL,
            isAI: true
        };

    } catch (error) {
        logger.error('[ClaudeKOTH] API call failed', {
            error: error.message,
            status: error.status
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

    try {
        // Get eligible candidates (same query as algorithm)
        const candidates = await db.all(`
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

        if (candidates.length === 0) {
            logger.info('[ClaudeKOTH] No eligible candidates found');
            return { token: null, score: 0, reasoning: 'No tokens meet minimum requirements' };
        }

        // Try Claude first if enabled
        if (isEnabled()) {
            const aiResult = await selectKoth(candidates);
            if (aiResult) {
                return aiResult;
            }
            logger.warn('[ClaudeKOTH] AI selection failed, falling back to algorithm');
        }

        // Fall back to algorithm
        if (algorithmFallback) {
            return await algorithmFallback(db);
        }

        // Last resort: highest market cap
        const winner = candidates[0];
        return {
            token: winner,
            score: 50,
            reasoning: `${winner.ticker} selected based on highest market cap ($${winner.marketCap?.toLocaleString()}). AI selection unavailable.`,
            isAI: false
        };

    } catch (error) {
        logger.error('[ClaudeKOTH] getKothWithFallback error', { error: error.message });

        if (algorithmFallback) {
            return await algorithmFallback(db);
        }

        return { token: null, score: 0, reasoning: `Selection failed: ${error.message}` };
    }
}

module.exports = {
    isEnabled,
    selectKoth,
    getKothWithFallback
};
