/**
 * Flywheel Task
 * Fee collection and SOL airdrop distribution (Rewards Claim system)
 *
 * v11.0 - Changed from PUMP token airdrops to direct SOL airdrops
 * v13.0 - KOTH bonus now distributed to all holders of king token (not just creator)
 * v14.0 - Updated to work with proportional point system (Top 250 holders)
 * v17.0 - Separated fee collection (1 min, >0.05 SOL) from airdrop (15 min, >1 SOL)
 * v23.0 - Refresh fee share BPS before airdrop to handle dynamic reward distribution changes
 * v25.4 - Fixed next check time countdown to update after fee collection
 * v25.23 - AMM fee monitoring with alerts, optimized batch size (25 transfers)
 * v25.37 - Fixed error handling: RPC errors no longer incorrectly deactivate tokens
 * v25.38 - AI-based KOTH selection (volume, holders, age, consistency) evaluated hourly
 * v25.39 - Fresh data guarantee: Holder scanner runs before each airdrop distribution
 * v25.46 - Twitter announcements when KOTH changes (with AI reasoning)
 * v25.75 - Fixed fee claiming for FEE program tokens: use feeVaultAddress as both vault+config
 * v25.76 - Threshold now considers SUM of platform + robinhood fees; improved FEE program handling
 * v25.97 - Robinhood fee claiming: always use distribute_creator_fees on PUMP program
 * v25.98 - Fix fee sharing config lookup: FEE tokens use bcVault, PUMP tokens use sharingConfigPDA
 * v25.100 - Fix AMM claim: ammVaultAuth from feeVaultPubkey (matches AMM pool.coin_creator)
 * v25.101 - Fix DistributeCreatorFees: correct discriminator and account structure from tx analysis
 * v25.102 - Fix DistributeCreatorFees: account #2 is bonding_curve PDA, not coinCreator
 * v25.103 - Fix DistributeCreatorFees: need BOTH bonding_curve AND sharing_config accounts
 * v25.104 - Fix DistributeCreatorFees: remove claimer account (not in successful tx)
 * v25.105 - Fix: check balance at PUMP creator-vault (same vault used for distribution)
 * v25.110 - CRITICAL: Reordered airdrop flow - validate ALL data BEFORE sending ANY transactions
 *           Previously KOTH was sent before community validation, causing partial airdrops on failure
 * v25.111 - CRITICAL: Fixed airdrop recording - now tracks ACTUAL lamports sent, not planned pool
 *           Fixed KOTH failure: rebuilds community plan with full pool instead of losing funds
 *           Fixed airdrop_logs.amount and user_airdrop_history to reflect reality
 * This eliminates the need to fund token accounts (ATAs) for recipients
 */
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const {
    getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, PROGRAMS, WALLETS } = require('../config/constants');
const { logger, pump, solana, jupiter, redis, mutex, mintExtractor, claudeKoth, twitter } = require('../services');

// RACE CONDITION FIX: Use mutex for atomic lock/unlock instead of boolean flags
const buybackMutex = mutex.getMutex('flywheel_buyback');
const airdropMutex = mutex.getMutex('flywheel_airdrop');

// Import Robinhood scanner for fee claiming
const robinhoodScanner = require('./robinhoodScanner');

// v25.51: Import PAGS fee scanner for automatic fee detection and collection
const pagsFeeScanner = require('./pagsFeeScanner');

// v25.39: Import holder scanner to refresh data before airdrop
const holderScanner = require('./holderScanner');

// v25.21: Cache for fee_sharing_config accounts to reduce RPC calls
// Key: creatorPubkey string, Value: { config, timestamp }
const feeSharingConfigCache = new Map();
const CONFIG_CACHE_TTL_MS = 600000; // 10 minutes - configs rarely change
// M-5/L-3 FIX: Proactively evict stale cache entries every 20 minutes to prevent unbounded growth
setInterval(() => {
    const cutoff = Date.now() - CONFIG_CACHE_TTL_MS * 2;
    for (const [key, val] of feeSharingConfigCache.entries()) {
        if (val.timestamp < cutoff) feeSharingConfigCache.delete(key);
    }
}, CONFIG_CACHE_TTL_MS * 2);

// v25.23: AMM fee monitoring configuration
// Track pending AMM fees and alert when they accumulate above threshold
const AMM_FEE_ALERT_THRESHOLD_SOL = 0.5; // Alert when pending AMM fees exceed 0.5 SOL
const AMM_FEE_MONITOR_INTERVAL_MS = 300000; // Check every 5 minutes
let lastAmmFeeAlert = 0; // Prevent alert spam
let totalPendingAmmFees = 0; // Track for monitoring

// v25.23: Optimized batch sizes
// SOL transfers: ~40 bytes instruction + ~32 bytes per account = ~72 bytes per transfer
// v25.114: Transaction size limit is 1232 bytes. Each transfer adds 49 bytes (32 key + 17 instruction).
// Fixed overhead: ~219 bytes (sig + header + blockhash + 3 fixed accounts + 2 compute budget ix).
// Max recipients: floor((1232 - 219) / 49) = 20. Going above 20 causes TX serialization failures.
// Previous value of 25 caused 7/8 batches to fail (only last partial batch succeeded).
const AIRDROP_BATCH_SIZE = 20;
const KOTH_BATCH_SIZE = 20;

// v25.38: AI-based KOTH selection system
// Evaluates tokens on multiple metrics instead of just market cap
const KOTH_EVALUATION_INTERVAL_MS = 30 * 60 * 1000; // v25.41: Every 30 minutes (reduced from hourly)
// M-6 FIX: Single module-level constant used by both evaluateKothCandidates and processAirdrop
const KOTH_MIN_HOLDERS = 10;
const KOTH_MIN_MARKET_CAP = 1000;
const KOTH_MIN_VOLUME = 100;
// H-6 FIX: Cooldown prevents same token from winning KOTH repeatedly
const KOTH_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
// Cooldowns are stored in Redis (key: koth_cooldown:<mint>, value: expiresAtMs as string)
// so they survive process restarts and deploys.
async function setKothCooldown(mint) {
    const expiresAt = Date.now() + KOTH_COOLDOWN_MS;
    const redisConn = redis.getConnection();
    if (redisConn) {
        await redisConn.set(`koth_cooldown:${mint}`, String(expiresAt), 'PX', KOTH_COOLDOWN_MS);
    }
}
async function isKothCooldownActive(mint) {
    const redisConn = redis.getConnection();
    if (!redisConn) return false;
    const val = await redisConn.get(`koth_cooldown:${mint}`);
    return val !== null && parseInt(val) > Date.now();
}
async function clearKothCooldown(mint) {
    const redisConn = redis.getConnection();
    if (redisConn) await redisConn.del(`koth_cooldown:${mint}`);
}
let lastKothEvaluation = 0;
let currentKothMint = null;
let currentKothScore = 0;
let currentKothReasoning = '';
let lastTweetedKothMint = null; // v25.46: Track last tweeted KOTH to avoid duplicates

/**
 * v25.40: Reset the KOTH evaluation cache
 * Called by admin endpoints to force a fresh evaluation
 */
function resetKothCache() {
    lastKothEvaluation = 0;
    currentKothMint = null;
    currentKothScore = 0;
    currentKothReasoning = '';
    logger.info('[KOTH] Evaluation cache reset - next call will re-evaluate');
}

/**
 * v25.38: Smart KOTH Scoring Algorithm
 * Calculates a composite score based on multiple health and engagement metrics
 * All data comes from existing database - no additional RPC calls needed
 *
 * Note: This is a deterministic weighted algorithm, not an LLM/AI model.
 * The term "smart" refers to multi-factor analysis vs simple market cap sorting.
 *
 * Scoring weights (total = 100):
 * - Market Cap (25%): Higher market cap indicates market confidence
 * - Volume (35%): Trading activity shows engagement (primary factor)
 * - Holder Growth (20%): Growing holder base is healthy
 * - Volume Consistency (10%): Steady volume > pump and dump patterns
 * - Token Age (10%): Older tokens with sustained metrics are more reliable
 */
const KOTH_SCORING_WEIGHTS = {
    marketCap: 25,
    volume: 35,
    holderGrowth: 20,
    volumeConsistency: 10,
    tokenAge: 10
};

/**
 * Calculate KOTH score for a single token
 * @param {Object} token - Token data from database
 * @param {Object} stats - Aggregated stats for normalization
 * @returns {Object} Score breakdown and total
 */
function calculateKothScore(token, stats) {
    const scores = {};

    // 1. Market Cap Score (logarithmic scale, normalized) - 25%
    // Higher market cap = higher score, but diminishing returns
    const mcapLog = token.marketCap > 0 ? Math.log10(token.marketCap) : 0;
    const maxMcapLog = stats.maxMarketCap > 0 ? Math.log10(stats.maxMarketCap) : 1;
    scores.marketCap = maxMcapLog > 0 ? (mcapLog / maxMcapLog) * KOTH_SCORING_WEIGHTS.marketCap : 0;

    // 2. Volume Score (logarithmic scale, normalized) - 35%
    // Higher 24hr volume = more active trading (primary factor)
    const volLog = token.volume24h > 0 ? Math.log10(token.volume24h) : 0;
    const maxVolLog = stats.maxVolume > 0 ? Math.log10(stats.maxVolume) : 1;
    scores.volume = maxVolLog > 0 ? (volLog / maxVolLog) * KOTH_SCORING_WEIGHTS.volume : 0;

    // 3. Holder Growth Score - 20%
    // Positive growth is rewarded, decline is penalized
    // holderGrowth is calculated as % change from previous scan
    const growthScore = token.holderGrowth !== undefined
        ? Math.min(1, Math.max(0, (token.holderGrowth + 0.1) / 0.2)) // -10% to +10% range normalized
        : 0.5; // Default to neutral if no data
    scores.holderGrowth = growthScore * KOTH_SCORING_WEIGHTS.holderGrowth;

    // 4. Volume Consistency Score - 10%
    // Measures how stable volume is (avg volume vs current)
    // Tokens with steady volume score higher than pump-and-dump patterns
    const volumeRatio = token.avgVolume > 0 ? token.volume24h / token.avgVolume : 1;
    // Sweet spot is 0.8x to 1.5x of average (not too low, not suspiciously high)
    const consistencyScore = volumeRatio >= 0.5 && volumeRatio <= 2.0
        ? 1 - Math.abs(volumeRatio - 1) / 2
        : 0.3;
    scores.volumeConsistency = consistencyScore * KOTH_SCORING_WEIGHTS.volumeConsistency;

    // 5. Token Age Score (logarithmic, rewards longevity) - 10%
    // Tokens that have been around longer with good metrics are more reliable
    const ageHours = token.ageHours || 0;
    const ageScore = ageHours > 0 ? Math.min(1, Math.log10(ageHours + 1) / 3) : 0; // Max at ~1000 hours
    scores.tokenAge = ageScore * KOTH_SCORING_WEIGHTS.tokenAge;

    // Calculate total score
    const totalScore = Object.values(scores).reduce((sum, s) => sum + s, 0);

    return {
        scores,
        totalScore: Math.round(totalScore * 100) / 100,
        breakdown: {
            marketCap: `${scores.marketCap.toFixed(1)}/${KOTH_SCORING_WEIGHTS.marketCap}`,
            volume: `${scores.volume.toFixed(1)}/${KOTH_SCORING_WEIGHTS.volume}`,
            holderGrowth: `${scores.holderGrowth.toFixed(1)}/${KOTH_SCORING_WEIGHTS.holderGrowth}`,
            volumeConsistency: `${scores.volumeConsistency.toFixed(1)}/${KOTH_SCORING_WEIGHTS.volumeConsistency}`,
            tokenAge: `${scores.tokenAge.toFixed(1)}/${KOTH_SCORING_WEIGHTS.tokenAge}`
        }
    };
}

/**
 * v25.38: Evaluate and select the best KOTH candidate
 * Runs hourly, uses only database queries (no RPC calls)
 *
 * @param {Object} db - Database connection
 * @returns {Object} Selected KOTH token with score and reasoning
 */
async function evaluateKothCandidates(db) {
    // Uses module-level KOTH_MIN_HOLDERS, KOTH_MIN_MARKET_CAP, KOTH_MIN_VOLUME constants
    try {
        // Get all eligible tokens with their metrics (combined query for platform + robinhood tokens)
        // v25.63: Tokens can be in both platform AND PAGS (fee splitting allowed)
        // v25.64: Now includes Robinhood partner tokens in KOTH evaluation
        const candidates = await db.all(`
            SELECT mint, ticker, name, "marketCap", volume24h, "holderCount", timestamp, actualHolders, source FROM (
                SELECT
                    t.mint,
                    t.ticker,
                    t.name,
                    t."marketCap",
                    t.volume24h,
                    t."holderCount",
                    t.timestamp,
                    COUNT(th."holderPubkey") as actualHolders,
                    'platform' as source
                FROM tokens t
                LEFT JOIN token_holders th ON th.mint = t.mint
                WHERE t."marketCap" >= $1
                AND t.volume24h >= $2
                GROUP BY t.mint, t.ticker, t.name, t."marketCap", t.volume24h, t."holderCount", t.timestamp
                HAVING COUNT(th."holderPubkey") >= $3

                UNION ALL

                SELECT
                    rt.mint,
                    rt.ticker,
                    rt.name,
                    rt."marketCap",
                    rt.volume24h,
                    0 as "holderCount",
                    rt."discoveredAt" as timestamp,
                    COUNT(rth."holderPubkey") as actualHolders,
                    'robinhood' as source
                FROM robinhood_tokens rt
                LEFT JOIN robinhood_token_holders rth ON rth.mint = rt.mint
                WHERE rt."isActive" = 1
                AND rt."marketCap" >= $1
                AND rt.volume24h >= $2
                GROUP BY rt.mint, rt.ticker, rt.name, rt."marketCap", rt.volume24h, rt."discoveredAt"
                HAVING COUNT(rth."holderPubkey") >= $3
            )
            ORDER BY "marketCap" DESC
            LIMIT 50
        `, [KOTH_MIN_MARKET_CAP, KOTH_MIN_VOLUME, KOTH_MIN_HOLDERS]);

        // v25.69: Enhanced logging for KOTH candidate sources
        const platformCandidates = candidates.filter(c => c.source === 'platform');
        const robinhoodCandidates = candidates.filter(c => c.source === 'robinhood');
        logger.info(`[KOTH] Candidates found: ${candidates.length} total (${platformCandidates.length} platform, ${robinhoodCandidates.length} robinhood)`);

        // v25.69: If no robinhood candidates, log why they're not qualifying
        if (robinhoodCandidates.length === 0) {
            const robinhoodStatus = await db.all(`
                SELECT
                    rt.mint, rt.ticker, rt."marketCap", rt.volume24h, rt."isActive",
                    COUNT(rth."holderPubkey") as holderCount
                FROM robinhood_tokens rt
                LEFT JOIN robinhood_token_holders rth ON rth.mint = rt.mint
                WHERE rt."isActive" = 1
                GROUP BY rt.mint, rt.ticker, rt."marketCap", rt.volume24h, rt."isActive"
                ORDER BY rt.volume24h DESC
                LIMIT 5
            `);

            if (robinhoodStatus.length > 0) {
                logger.info(`[KOTH] Robinhood tokens not qualifying for KOTH:`);
                for (const token of robinhoodStatus) {
                    const issues = [];
                    if ((token.marketCap || 0) < KOTH_MIN_MARKET_CAP) issues.push(`mcap $${token.marketCap || 0} < $${KOTH_MIN_MARKET_CAP}`);
                    if ((token.volume24h || 0) < KOTH_MIN_VOLUME) issues.push(`vol $${token.volume24h || 0} < $${KOTH_MIN_VOLUME}`);
                    if ((token.holderCount || 0) < KOTH_MIN_HOLDERS) issues.push(`holders ${token.holderCount || 0} < ${KOTH_MIN_HOLDERS}`);
                    if (issues.length > 0) {
                        logger.info(`[KOTH]   - ${token.ticker || token.mint?.slice(0, 8)}: ${issues.join(', ')}`);
                    }
                }
            } else {
                logger.info(`[KOTH] No active Robinhood tokens in database`);
            }
        }

        if (candidates.length === 0) {
            // v25.69: Debug why no candidates - check what robinhood tokens exist but don't qualify
            const ineligibleRobinhood = await db.all(`
                SELECT
                    rt.mint, rt.ticker, rt."marketCap", rt.volume24h,
                    COUNT(rth."holderPubkey") as holderCount
                FROM robinhood_tokens rt
                LEFT JOIN robinhood_token_holders rth ON rth.mint = rt.mint
                WHERE rt."isActive" = 1
                GROUP BY rt.mint, rt.ticker, rt."marketCap", rt.volume24h
                ORDER BY rt.volume24h DESC
                LIMIT 5
            `);

            if (ineligibleRobinhood.length > 0) {
                for (const token of ineligibleRobinhood) {
                    const issues = [];
                    if ((token.marketCap || 0) < KOTH_MIN_MARKET_CAP) issues.push(`mcap ${token.marketCap || 0} < ${KOTH_MIN_MARKET_CAP}`);
                    if ((token.volume24h || 0) < KOTH_MIN_VOLUME) issues.push(`vol ${token.volume24h || 0} < ${KOTH_MIN_VOLUME}`);
                    if ((token.holderCount || 0) < KOTH_MIN_HOLDERS) issues.push(`holders ${token.holderCount || 0} < ${KOTH_MIN_HOLDERS}`);
                    logger.info(`[KOTH] Robinhood ${token.ticker || token.mint?.slice(0, 8)} not eligible: ${issues.join(', ')}`);
                }
            }

            logger.info('[KOTH] No eligible candidates found');
            return { token: null, score: 0, reasoning: 'No tokens meet minimum requirements' };
        }

        // Calculate aggregate stats for normalization
        const stats = {
            maxMarketCap: Math.max(...candidates.map(t => t.marketCap || 0)),
            maxVolume: Math.max(...candidates.map(t => t.volume24h || 0)),
            maxHolders: Math.max(...candidates.map(t => t.actualHolders || 0))
        };

        // Score each candidate
        const scoredCandidates = candidates.map(token => {
            // Calculate token age in hours (timestamp is epoch ms BIGINT)
            const ts = typeof token.timestamp === 'number' ? token.timestamp : parseInt(token.timestamp) || 0;
            const ageHours = ts > 0
                ? (Date.now() - ts) / (1000 * 60 * 60)
                : 0;

            const tokenWithMetrics = {
                ...token,
                holderCount: token.actualHolders || 0,
                ageHours,
                // For now, assume neutral growth and consistent volume
                // These could be enhanced with historical tracking later
                holderGrowth: 0,
                avgVolume: token.volume24h // No historical data yet
            };

            const scoreResult = calculateKothScore(tokenWithMetrics, stats);

            return {
                ...token,
                ...scoreResult,
                ageHours
            };
        });

        // Sort by total score
        scoredCandidates.sort((a, b) => b.totalScore - a.totalScore);

        // H-6 FIX: Skip tokens still in KOTH cooldown (won within last 6 hours)
        // Cooldowns are Redis-backed so they survive restarts and deploys.
        const cooldownChecks = await Promise.all(scoredCandidates.map(c => isKothCooldownActive(c.mint)));
        const eligibleCandidates = scoredCandidates.filter((c, i) => {
            if (cooldownChecks[i]) {
                logger.debug(`[KOTH] ${c.ticker} skipped — in cooldown`);
                return false;
            }
            return true;
        });

        if (eligibleCandidates.length === 0) {
            logger.info('[KOTH] All top candidates are in cooldown — using top candidate anyway');
            eligibleCandidates.push(scoredCandidates[0]);
        }

        // Select the winner
        const winner = eligibleCandidates[0] || scoredCandidates[0];
        const runnerUp = scoredCandidates[1];

        // Generate reasoning
        const reasoning = generateKothReasoning(winner, runnerUp, stats);

        const sourceLabel = winner.source === 'robinhood' ? '🤝 Robinhood Partner' : '🚀 Platform';
        logger.info(`[KOTH] 👑 AI Selected: ${winner.ticker} (Score: ${winner.totalScore}/100) [${sourceLabel}]`);
        logger.info(`[KOTH] Breakdown: ${JSON.stringify(winner.breakdown)}`);

        return {
            token: winner,
            score: winner.totalScore,
            reasoning,
            breakdown: winner.breakdown,
            source: winner.source || 'platform',
            candidates: scoredCandidates.slice(0, 5).map(c => ({
                ticker: c.ticker,
                score: c.totalScore,
                marketCap: c.marketCap,
                source: c.source || 'platform'
            }))
        };

    } catch (e) {
        logger.error('[KOTH] Evaluation error', { error: e.message });
        return { token: null, score: 0, reasoning: `Evaluation failed: ${e.message}` };
    }
}

/**
 * Generate human-readable reasoning for KOTH selection
 */
function generateKothReasoning(winner, runnerUp, stats) {
    const reasons = [];

    // Highlight top scoring categories
    const breakdown = winner.scores || {};
    const sortedMetrics = Object.entries(breakdown)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3);

    for (const [metric, score] of sortedMetrics) {
        const weight = KOTH_SCORING_WEIGHTS[metric];

        switch (metric) {
            case 'volume':
                reasons.push(`Strong trading activity ($${(winner.volume24h || 0).toLocaleString()} 24hr volume)`);
                break;
            case 'marketCap':
                reasons.push(`Solid market cap ($${(winner.marketCap || 0).toLocaleString()})`);
                break;
            case 'holderGrowth':
                if (score > KOTH_SCORING_WEIGHTS.holderGrowth * 0.6) {
                    reasons.push('Growing holder base');
                }
                break;
            case 'volumeConsistency':
                if (score > KOTH_SCORING_WEIGHTS.volumeConsistency * 0.6) {
                    reasons.push('Consistent trading volume');
                }
                break;
            case 'tokenAge':
                if (winner.ageHours > 24) {
                    reasons.push(`Established token (${Math.round(winner.ageHours / 24)} days old)`);
                }
                break;
        }
    }

    let reasoning = `${winner.ticker} selected as King of the Pill. `;
    reasoning += reasons.slice(0, 3).join('. ') + '.';

    if (runnerUp) {
        const scoreDiff = winner.totalScore - runnerUp.totalScore;
        if (scoreDiff < 5) {
            reasoning += ` Close competition with ${runnerUp.ticker} (${runnerUp.totalScore.toFixed(1)} pts).`;
        }
    }

    return reasoning;
}

// v27.0: Per-token airdrop threshold raised to 1 SOL
const TOKEN_AIRDROP_THRESHOLD_LAMPORTS = Math.round((parseFloat(process.env.TOKEN_AIRDROP_THRESHOLD_SOL) || 1.0) * 1e9);

// v26.0: Fixed 1B token supply for all pump.fun tokens (1B * 10^6 decimals)
const PUMP_FUN_TOTAL_SUPPLY_BIG = BigInt('1000000000000000');

// v26.0: Minimum per-recipient airdrop (0.01 SOL). Recipients below this are skipped.
const MIN_RECIPIENT_LAMPORTS = Math.floor(0.01 * 1e9); // 10_000_000 lamports

// v27.0: Pooling mechanic — 50% of token creator rewards go to per-token holders,
// 50% go into the central pool distributed by volume-weighted cross-token holdings.
const CREATOR_REWARD_HOLDER_SPLIT = 0.5;
const CREATOR_REWARD_POOL_SPLIT = 0.5;
// Minimum central pool balance before triggering a distribution
const CENTRAL_POOL_THRESHOLD_LAMPORTS = Math.round(5.0 * 1e9); // 5 SOL

/**
 * v27.0: Atomically add lamports to the central pool stat.
 */
async function addToCentralPool(db, lamports) {
    if (lamports <= 0) return;
    try {
        const result = await db.run(
            "UPDATE stats SET value = value + $1 WHERE key = 'centralPoolLamports'",
            [lamports]
        );
        if (result?.rowCount === 0) {
            logger.error(`[CentralPool] addToCentralPool: stats row not found — ${lamports} lamports NOT credited`);
        }
    } catch (e) {
        logger.error(`[CentralPool] addToCentralPool failed — ${lamports} lamports NOT credited`, { error: e.message });
        throw e; // re-throw so caller can handle
    }
}

/**
 * v26.0: Per-token airdrop distribution
 *
 * Replaces the global pool system. Each token (platform + robinhood) has its own
 * pending_airdrop_lamports balance credited from that token's creator fees.
 * When a token's pool exceeds TOKEN_AIRDROP_THRESHOLD_LAMPORTS, its holders receive
 * a proportional airdrop based on their share of the 1B total supply.
 *
 * Distribution is per-token and independent — no cross-token pooling.
 * KOTH bonus is removed; each token's holders are rewarded by their own token's fees.
 */
async function processTokenAirdrops(deps) {
    const { connection, devKeypair, db } = deps;

    const release = await airdropMutex.tryAcquire();
    if (!release) {
        logger.info('[TokenAirdrop] Skipping - already in progress');
        return;
    }

    // v25.43: Always evaluate KOTH (informational only - no longer drives distribution)
    try {
        await getAiSelectedKoth(db);
    } catch (kothErr) {
        logger.warn('[TokenAirdrop] KOTH evaluation failed (non-critical)', { error: kothErr.message });
    }

    try {
        const SAFETY_RESERVE = 0.1 * LAMPORTS_PER_SOL;
        const walletBalance = await connection.getBalance(devKeypair.publicKey);
        let availableBalance = walletBalance - SAFETY_RESERVE;

        if (availableBalance <= 0) {
            logger.info('[TokenAirdrop] No balance available (below safety reserve)');
            return;
        }

        // Update next airdrop timestamp for countdown UI
        const airdropInterval = config.AIRDROP_INTERVAL || 900000;
        await db.run('UPDATE stats SET value = $1 WHERE key = $2', [Date.now() + airdropInterval, 'nextAirdropTimestamp']).catch(() => {});

        // Refresh holder data before distribution
        try {
            const refreshResult = await holderScanner.updateGlobalState(deps);
            if (refreshResult?.scanCompleted) {
                logger.info('[TokenAirdrop] Holder data refreshed successfully');
            } else if (refreshResult?.skipped) {
                logger.warn('[TokenAirdrop] Holder scan skipped (in progress) — using cached data');
            }
        } catch (holderErr) {
            logger.warn('[TokenAirdrop] Holder refresh failed, using cached data', { error: holderErr.message });
        }

        // Collect all tokens with pools above threshold
        const VALID_TABLES = { platform: { tokens: 'tokens', holders: 'token_holders' }, robinhood: { tokens: 'robinhood_tokens', holders: 'robinhood_token_holders' } };

        const platformTokensToAirdrop = await db.all(
            'SELECT mint, ticker, pending_airdrop_lamports FROM tokens WHERE pending_airdrop_lamports >= $1',
            [TOKEN_AIRDROP_THRESHOLD_LAMPORTS]
        );
        const robinhoodTokensToAirdrop = await db.all(
            'SELECT mint, ticker, pending_airdrop_lamports FROM robinhood_tokens WHERE "isActive" = 1 AND pending_airdrop_lamports >= $1',
            [TOKEN_AIRDROP_THRESHOLD_LAMPORTS]
        );

        const allToDistribute = [
            ...platformTokensToAirdrop.map(t => ({ ...t, source: 'platform' })),
            ...robinhoodTokensToAirdrop.map(t => ({ ...t, source: 'robinhood' }))
        ];

        if (allToDistribute.length === 0) {
            logger.info(`[TokenAirdrop] No tokens above ${(TOKEN_AIRDROP_THRESHOLD_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} SOL threshold`);
            // Still attempt central pool distribution — it accumulates independently and should fire at 5 SOL
            try {
                await processCentralPoolAirdrop(deps);
            } catch (centralErr) {
                logger.error('[CentralPool] Distribution failed', { error: centralErr.message });
            }
            return;
        }

        logger.info(`[TokenAirdrop] Processing ${allToDistribute.length} token pools (${platformTokensToAirdrop.length} platform, ${robinhoodTokensToAirdrop.length} robinhood)`);

        // Fetch bonus-holder sets once — ASDF Top 100 and ANSEM Top 1000 each receive 2× weight
        const [asdfTop100, ansemTop1000] = await Promise.all([
            redis.getAsdfTop100Holders().catch(() => new Set()),
            redis.getAnsemTop1000Holders().catch(() => new Set()),
        ]);

        for (const token of allToDistribute) {
            if (availableBalance < TOKEN_AIRDROP_THRESHOLD_LAMPORTS) {
                logger.warn('[TokenAirdrop] Wallet balance too low to continue — stopping');
                break;
            }

            try {
                const tables = VALID_TABLES[token.source];
                if (!tables) continue;

                const poolAmount = Math.min(Number(token.pending_airdrop_lamports), availableBalance);
                if (poolAmount < TOKEN_AIRDROP_THRESHOLD_LAMPORTS) continue;

                // 99% distributed, 1% dust buffer
                const distributable = Math.floor(poolAmount * 0.99);

                const holders = await db.all(
                    `SELECT "holderPubkey", balance FROM ${tables.holders} WHERE mint = $1 ORDER BY rank ASC`,
                    [token.mint]
                );

                if (!holders || holders.length === 0) {
                    logger.debug(`[TokenAirdrop] ${token.ticker}: No holders tracked, skipping`);
                    continue;
                }

                // Build weighted holder list — ASDF Top 100 and ANSEM Top 1000 each get 2× (stack to 4× if both)
                const weightedHolders = holders.map(h => {
                    const bal = BigInt(h.balance || '0');
                    const asdfMult  = asdfTop100.has(h.holderPubkey)  ? BigInt(2) : BigInt(1);
                    const ansemMult = ansemTop1000.has(h.holderPubkey) ? BigInt(2) : BigInt(1);
                    return { holderPubkey: h.holderPubkey, balance: bal, effectiveBal: bal * asdfMult * ansemMult };
                });

                const totalEffectiveBal = weightedHolders.reduce((sum, h) => sum + h.effectiveBal, BigInt(0));
                if (totalEffectiveBal === BigInt(0)) {
                    logger.debug(`[TokenAirdrop] ${token.ticker}: No effective holder balance, skipping`);
                    continue;
                }

                const bonusCount = weightedHolders.filter(h => h.effectiveBal > h.balance).length;
                if (bonusCount > 0) {
                    logger.debug(`[TokenAirdrop] ${token.ticker}: ${bonusCount} holders with bonus weight (ASDF Top 100 and/or ANSEM Top 1000)`);
                }

                // Share proportional to weighted effective balance
                const recipients = [];
                const distributableBig = BigInt(Math.floor(distributable));
                let allocatedSoFar = BigInt(0);

                for (const holder of weightedHolders) {
                    try {
                        if (holder.balance <= BigInt(0)) continue;

                        const shareBig = distributableBig * holder.effectiveBal / totalEffectiveBal;
                        const share = Number(shareBig);
                        if (share >= MIN_RECIPIENT_LAMPORTS) {
                            recipients.push({ user: new PublicKey(holder.holderPubkey), amount: share });
                            allocatedSoFar += shareBig;
                        }
                    } catch (e) {
                        logger.debug(`[TokenAirdrop] Skipping invalid holder ${holder.holderPubkey}: ${e.message}`);
                    }
                }

                // Distribute dust remainder to largest-share recipient to prevent lamport leakage
                const dust = Number(distributableBig - allocatedSoFar);
                if (dust > 0 && recipients.length > 0) {
                    recipients[0].amount += dust;
                }

                if (recipients.length === 0) {
                    logger.debug(`[TokenAirdrop] ${token.ticker}: All holder shares below 0.01 SOL minimum threshold`);
                    continue;
                }

                const totalPlanned = recipients.reduce((sum, r) => sum + r.amount, 0);
                if (totalPlanned > availableBalance) {
                    logger.warn(`[TokenAirdrop] ${token.ticker}: Planned ${(totalPlanned / LAMPORTS_PER_SOL).toFixed(4)} SOL exceeds available ${(availableBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL, skipping`);
                    continue;
                }

                logger.info(`[TokenAirdrop] ${token.ticker} (${token.source}): Distributing ${(distributable / LAMPORTS_PER_SOL).toFixed(4)} SOL pool to ${recipients.length} holders`);

                const airdropId = `token_${token.mint.slice(0, 8)}_${Date.now()}`;
                const allSignatures = [];
                let actualSentLamports = 0;

                for (let i = 0; i < recipients.length; i += AIRDROP_BATCH_SIZE) {
                    const batch = recipients.slice(i, i + AIRDROP_BATCH_SIZE);
                    const result = await sendSolAirdropBatch(batch, deps);
                    if (result?.signature) {
                        allSignatures.push(result.signature);
                        actualSentLamports += result.actualLamports;
                    }
                    if (i + AIRDROP_BATCH_SIZE < recipients.length) {
                        await new Promise(r => setTimeout(r, 300));
                    }
                }

                if (actualSentLamports > 0) {
                    availableBalance -= actualSentLamports;

                    // Decrement pending pool, accumulate lifetime
                    await db.run(
                        `UPDATE ${tables.tokens} SET pending_airdrop_lamports = GREATEST(0, pending_airdrop_lamports - $1), lifetime_airdrop_lamports = lifetime_airdrop_lamports + $1 WHERE mint = $2`,
                        [actualSentLamports, token.mint]
                    );

                    const actualSolSent = actualSentLamports / LAMPORTS_PER_SOL;

                    // Log airdrop event
                    await db.run(
                        'INSERT INTO airdrop_logs (amount, recipients, "totalPoints", signatures, details, timestamp, mint, token_source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                        [
                            actualSolSent,
                            recipients.length,
                            0,
                            allSignatures.join(','),
                            JSON.stringify({ ticker: token.ticker, source: token.source, airdropId, txCount: allSignatures.length }),
                            new Date().toISOString(),
                            token.mint,
                            token.source
                        ]
                    );

                    // Log per-user distribution history (chunked to stay under pg 65535 param limit)
                    const airdropTimestamp = Date.now();
                    const HISTORY_CHUNK = 1000; // 6 params each → max 6000 params per query
                    try {
                        for (let hi = 0; hi < recipients.length; hi += HISTORY_CHUNK) {
                            const chunk = recipients.slice(hi, hi + HISTORY_CHUNK);
                            const values = chunk.map((_, idx) => {
                                const b = idx * 6;
                                return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6})`;
                            }).join(', ');
                            const params = chunk.flatMap(r => [
                                r.user.toString(), airdropId,
                                r.amount / LAMPORTS_PER_SOL, 0,
                                airdropTimestamp, token.mint
                            ]);
                            await db.run(
                                `INSERT INTO user_airdrop_history ("userPubkey", "airdropId", amount, points, timestamp, mint) VALUES ${values}`,
                                params
                            );
                        }
                    } catch (histErr) {
                        logger.warn('[TokenAirdrop] Failed to log user history', { error: histErr.message });
                    }

                    logger.info(`✅ [TokenAirdrop] ${token.ticker}: ${actualSolSent.toFixed(4)} SOL sent to ${recipients.length} holders in ${allSignatures.length} txs`);
                } else {
                    logger.warn(`[TokenAirdrop] ${token.ticker}: All batches failed — pool balance preserved`);
                }
            } catch (tokenErr) {
                logger.error(`[TokenAirdrop] Error processing ${token.ticker || token.mint?.slice(0, 8)}`, { error: tokenErr.message });
            }

            await new Promise(r => setTimeout(r, 500)); // Rate-limit between tokens
        }

        // v27.0: Distribute the central pool after all per-token distributions
        try {
            await processCentralPoolAirdrop(deps);
        } catch (centralErr) {
            logger.error('[CentralPool] Distribution failed', { error: centralErr.message });
        }

    } catch (e) {
        logger.error('[TokenAirdrop] Critical error', { error: e.message });
    } finally {
        await release();
    }
}

/**
 * v27.0: Central pool airdrop distribution
 *
 * Distributes the central pool (accumulated from 50% of all token creator rewards) to
 * token holders across all eligible tokens. Each user's share is proportional to their
 * volume-weighted holdings: sum over each token they hold of
 *   (holderBalance / TOTAL_SUPPLY) × (tokenVolume24h / totalVolume)
 *
 * This rewards users who hold tokens with high trading activity, scaled by how much
 * of each token they own.
 */
async function processCentralPoolAirdrop(deps) {
    const { connection, devKeypair, db } = deps;

    const poolRow = await db.get("SELECT value FROM stats WHERE key = 'centralPoolLamports'");
    const centralPoolLamports = Number(poolRow?.value || 0);

    if (centralPoolLamports < CENTRAL_POOL_THRESHOLD_LAMPORTS) {
        logger.debug(`[CentralPool] Below threshold (${(centralPoolLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL < ${(CENTRAL_POOL_THRESHOLD_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} SOL), skipping`);
        return;
    }

    const SAFETY_RESERVE = 0.1 * LAMPORTS_PER_SOL;
    const walletBalance = await connection.getBalance(devKeypair.publicKey);
    const availableBalance = walletBalance - SAFETY_RESERVE;

    if (availableBalance < CENTRAL_POOL_THRESHOLD_LAMPORTS) {
        logger.warn('[CentralPool] Wallet balance too low for central pool distribution');
        return;
    }

    // Fetch all eligible tokens (platform + robinhood) with their market cap
    const eligiblePlatform = await db.all(
        'SELECT mint, "marketCap" as mcap FROM tokens WHERE volume24h >= $1',
        [100]
    );
    const eligibleRobinhood = await db.all(
        'SELECT mint, "marketCap" as mcap FROM robinhood_tokens WHERE "isActive" = 1 AND volume24h >= $1',
        [100]
    );
    const allEligible = [...eligiblePlatform, ...eligibleRobinhood];

    if (allEligible.length === 0) {
        logger.info('[CentralPool] No eligible tokens for central pool distribution');
        return;
    }

    const totalMcap = allEligible.reduce((s, t) => s + (parseFloat(t.mcap) || 0), 0);
    if (totalMcap === 0) return;

    const mcapByMint = new Map(allEligible.map(t => [t.mint, parseFloat(t.mcap) || 0]));

    // Fetch all holders and bonus sets in parallel
    const platformMints  = eligiblePlatform.map(t => t.mint).filter(Boolean);
    const robinhoodMints = eligibleRobinhood.map(t => t.mint).filter(Boolean);

    const [platformHolders, robinhoodHolders, asdfTop100, ansemTop1000] = await Promise.all([
        platformMints.length > 0
            ? db.all('SELECT "holderPubkey", balance, mint FROM token_holders WHERE mint = ANY($1)', [platformMints])
            : [],
        robinhoodMints.length > 0
            ? db.all('SELECT "holderPubkey", balance, mint FROM robinhood_token_holders WHERE mint = ANY($1)', [robinhoodMints])
            : [],
        redis.getAsdfTop100Holders().catch(() => new Set()),
        redis.getAnsemTop1000Holders().catch(() => new Set()),
    ]);

    // Build user score map: mcap-weighted ownership, with 2× bonus for ASDF Top 100 and ANSEM Top 1000
    // At avg mcap (1/N share) → 1.0×; at 0 mcap → 0.5×; at 2× avg → 1.5× (capped).
    const N = allEligible.length;
    const userScores = new Map();
    for (const h of [...platformHolders, ...robinhoodHolders]) {
        const mcap    = mcapByMint.get(h.mint) || 0;
        const balance = BigInt(h.balance || '0');
        if (balance === BigInt(0)) continue;
        const mcapRatio      = mcap / totalMcap;
        const mcapMultiplier = Math.min(1.5, Math.max(0.5, 0.5 + mcapRatio * N * 0.5));
        const balanceRatio   = Number(balance * BigInt(1e9) / PUMP_FUN_TOTAL_SUPPLY_BIG) / 1e9;
        const asdfMult       = asdfTop100.has(h.holderPubkey)  ? 2 : 1;
        const ansemMult      = ansemTop1000.has(h.holderPubkey) ? 2 : 1;
        const contribution   = balanceRatio * mcapMultiplier * asdfMult * ansemMult;
        if (contribution > 0) {
            userScores.set(h.holderPubkey, (userScores.get(h.holderPubkey) || 0) + contribution);
        }
    }

    if (userScores.size === 0) {
        logger.info('[CentralPool] No holders found for eligible tokens');
        return;
    }

    const totalScore = Array.from(userScores.values()).reduce((s, v) => s + v, 0);
    if (totalScore === 0) return;

    const poolToDistribute = Math.min(centralPoolLamports, availableBalance);
    const distributable = Math.floor(poolToDistribute * 0.99); // 1% dust buffer

    // Build recipient list
    const recipients = [];
    for (const [pubkey, score] of userScores.entries()) {
        try {
            const share = Math.floor(distributable * score / totalScore);
            if (share >= MIN_RECIPIENT_LAMPORTS) {
                recipients.push({ user: new PublicKey(pubkey), amount: share });
            }
        } catch (e) {
            logger.debug(`[CentralPool] Skipping invalid holder ${pubkey}: ${e.message}`);
        }
    }

    if (recipients.length === 0) {
        logger.info('[CentralPool] All recipient shares below minimum threshold');
        return;
    }

    const totalPlanned = recipients.reduce((s, r) => s + r.amount, 0);
    if (totalPlanned > availableBalance) {
        logger.warn(`[CentralPool] Planned ${(totalPlanned / LAMPORTS_PER_SOL).toFixed(4)} SOL exceeds available ${(availableBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL, skipping`);
        return;
    }

    logger.info(`[CentralPool] Distributing ${(distributable / LAMPORTS_PER_SOL).toFixed(4)} SOL central pool to ${recipients.length} holders across ${allEligible.length} tokens (mcap-weighted, ASDF/ANSEM 2× bonus)`);

    const airdropId = `central_${Date.now()}`;
    const allSignatures = [];
    let actualSentLamports = 0;

    for (let i = 0; i < recipients.length; i += AIRDROP_BATCH_SIZE) {
        const batch = recipients.slice(i, i + AIRDROP_BATCH_SIZE);
        const result = await sendSolAirdropBatch(batch, deps);
        if (result?.signature) {
            allSignatures.push(result.signature);
            actualSentLamports += result.actualLamports;
        }
        if (i + AIRDROP_BATCH_SIZE < recipients.length) {
            await new Promise(r => setTimeout(r, 300));
        }
    }

    if (actualSentLamports > 0) {
        // Decrement central pool and accumulate lifetime stat
        await db.run(
            "UPDATE stats SET value = GREATEST(0, value - $1) WHERE key = 'centralPoolLamports'",
            [actualSentLamports]
        );
        await db.run(
            "UPDATE stats SET value = value + $1 WHERE key = 'lifetimeCentralPoolLamports'",
            [actualSentLamports]
        );

        const actualSolSent = actualSentLamports / LAMPORTS_PER_SOL;

        // Log airdrop event
        await db.run(
            'INSERT INTO airdrop_logs (amount, recipients, "totalPoints", signatures, details, timestamp, mint, token_source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
                actualSolSent,
                recipients.length,
                0,
                allSignatures.join(','),
                JSON.stringify({ source: 'central_pool', airdropId, txCount: allSignatures.length, tokenCount: allEligible.length }),
                new Date().toISOString(),
                null,
                'central_pool'
            ]
        );

        // Log per-user history
        const airdropTimestamp = Date.now();
        try {
            const HISTORY_BATCH_SIZE = 100;
            for (let i = 0; i < recipients.length; i += HISTORY_BATCH_SIZE) {
                const batch = recipients.slice(i, i + HISTORY_BATCH_SIZE);
                const values = batch.map((_, idx) => {
                    const b = idx * 6;
                    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6})`;
                }).join(', ');
                const params = batch.flatMap(r => [
                    r.user.toString(), airdropId,
                    r.amount / LAMPORTS_PER_SOL, 0,
                    airdropTimestamp, null
                ]);
                await db.run(
                    `INSERT INTO user_airdrop_history ("userPubkey", "airdropId", amount, points, timestamp, mint) VALUES ${values}`,
                    params
                );
            }
        } catch (histErr) {
            logger.warn('[CentralPool] Failed to log user history', { error: histErr.message });
        }

        logger.info(`✅ [CentralPool] ${actualSolSent.toFixed(4)} SOL distributed to ${recipients.length} holders in ${allSignatures.length} txs`);
    } else {
        logger.warn('[CentralPool] All batches failed — central pool balance preserved');
    }
}

/**
 * v25.38: Get the current AI-selected KOTH
 * Uses Claude AI for intelligent selection, falls back to weighted algorithm
 * Re-evaluates hourly, uses cached result between evaluations
 */
async function getAiSelectedKoth(db) {
    const now = Date.now();

    // Re-evaluate if hour has passed or no current selection
    if (!currentKothMint || (now - lastKothEvaluation) >= KOTH_EVALUATION_INTERVAL_MS) {
        let result;

        // Try Claude AI first if enabled, fall back to weighted algorithm
        if (claudeKoth.isEnabled()) {
            logger.info('[KOTH] 🤖 Using Claude AI for KOTH selection...');
            result = await claudeKoth.getKothWithFallback(db, evaluateKothCandidates);
        } else {
            logger.info('[KOTH] Using weighted algorithm for KOTH selection (AI not configured)');
            result = await evaluateKothCandidates(db);
        }

        if (result.token) {
            const isNewKoth = currentKothMint !== result.token.mint;
            currentKothMint = result.token.mint;
            currentKothScore = result.score;
            currentKothReasoning = result.reasoning;
            lastKothEvaluation = now;
            // H-6 FIX: Apply cooldown so winner can't dominate every cycle (Redis-backed, survives restart)
            await setKothCooldown(result.token.mint);
            logger.debug(`[KOTH] Cooldown set for ${result.token.ticker} — eligible again in ${KOTH_COOLDOWN_MS / 3600000}h`);

            // Store in Redis for API access
            const redisConn = redis.getConnection();
            if (redisConn) {
                await redisConn.set('koth_ai_selection', JSON.stringify({
                    mint: result.token.mint,
                    ticker: result.token.ticker,
                    name: result.token.name,
                    source: result.token.source || 'platform', // v25.71: Include token source for frontend
                    score: result.score,
                    reasoning: result.reasoning,
                    breakdown: result.breakdown,
                    candidates: result.candidates,
                    evaluatedAt: now,
                    isAI: result.isAI || false,
                    model: result.model || null,
                    runnerUp: result.runnerUp || null,
                    runnerUpReason: result.runnerUpReason || null
                }), 'EX', 7200); // 2 hour TTL
            }

            // v25.46: Tweet announcement when KOTH changes
            // Only tweet if this is a NEW king (different from last tweeted)
            if (isNewKoth && lastTweetedKothMint !== result.token.mint) {
                try {
                    const tweetUrl = await twitter.postKothTweet(
                        result.token.name || result.token.ticker,
                        result.token.ticker,
                        result.token.mint,
                        result.reasoning
                    );
                    if (tweetUrl) {
                        lastTweetedKothMint = result.token.mint;
                        logger.info(`[KOTH] 📢 Announced new king on Twitter: ${result.token.ticker}`);
                    }
                } catch (tweetErr) {
                    // Log but don't fail - Twitter is non-critical
                    logger.warn('[KOTH] Twitter announcement failed', { error: tweetErr.message });
                }
            }
        }

        return result;
    }

    // Return cached selection
    return {
        token: { mint: currentKothMint },
        score: currentKothScore,
        reasoning: currentKothReasoning
    };
}

/**
 * v25.21: Get fee sharing config with caching
 * v25.75: Now handles both PUMP program PDAs and FEE program accounts
 * Reduces RPC calls by caching parsed configs
 *
 * @param {Object} connection - Solana connection
 * @param {PublicKey} configAccount - The config account (PDA for PUMP, or FEE account)
 * @param {PublicKey} creatorPubkey - Creator pubkey (for cache key)
 * @param {boolean} isFeeProgram - If true, account is FEE program (not PUMP PDA)
 */
async function getCachedFeeSharingConfig(connection, configAccount, creatorPubkey, isFeeProgram = false) {
    const cacheKey = configAccount.toString(); // v25.75: Use account address as cache key
    const cached = feeSharingConfigCache.get(cacheKey);

    // Return cached if fresh
    if (cached && (Date.now() - cached.timestamp) < CONFIG_CACHE_TTL_MS) {
        return cached.config;
    }

    // Fetch fresh config
    try {
        const configInfo = await connection.getAccountInfo(configAccount);
        if (configInfo && configInfo.data) {
            let configData = null;

            // v25.75: Detect account type by owner and use appropriate parser
            if (isFeeProgram || configInfo.owner.equals(PROGRAMS.FEE)) {
                // FEE program account - use mintExtractor's FEE account parser
                // We need a dummy wallet key just for parsing structure (we want all shareholders)
                const dummyWallet = creatorPubkey; // Use creator as dummy (we just need allShareholders)
                const result = mintExtractor.parseFeeAccountSharingConfig
                    ? await Promise.resolve(require('../services/mintExtractor').parseFeeAccountSharingConfig(configInfo.data, dummyWallet, 'cache'))
                    : null;

                if (result && result.allShareholders) {
                    // Convert to expected format with PublicKey objects
                    configData = {
                        creator: result.originalCreator ? new PublicKey(result.originalCreator) : creatorPubkey,
                        shareholders: result.allShareholders.map(s => ({
                            pubkey: new PublicKey(s.pubkey),
                            shareBps: s.bps
                        }))
                    };
                }
            } else {
                // PUMP program PDA - use robinhoodScanner's parser
                configData = robinhoodScanner.parseFeeSharingConfig(configInfo.data, configAccount);
            }

            if (configData) {
                feeSharingConfigCache.set(cacheKey, {
                    config: configData,
                    timestamp: Date.now()
                });
                return configData;
            }
        }
    } catch (e) {
        logger.debug(`[Robinhood] Failed to fetch config for ${cacheKey.slice(0, 8)}`, { error: e.message });
    }

    return null;
}

/**
 * Claim creator fees from bonding curve and AMM
 */
async function claimCreatorFees(deps) {
    const { connection, devKeypair } = deps;
    const { bcVault, ammVaultAuth, ammVaultAta } = pump.getCreatorFeeVaults(devKeypair.publicKey);

    const tx = new Transaction();
    solana.addPriorityFee(tx);

    let claimedSomething = false;
    let totalClaimed = 0;

    // Claim Bonding Curve Fees
    try {
        const bcInfo = await connection.getAccountInfo(bcVault);
        if (bcInfo && bcInfo.lamports > 0) {
            const discriminator = pump.buildClaimFeesData();
            const [eventAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("__event_authority")], PROGRAMS.PUMP
            );

            const keys = [
                { pubkey: devKeypair.publicKey, isSigner: false, isWritable: true },
                { pubkey: bcVault, isSigner: false, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false }
            ];

            tx.add(new TransactionInstruction({ keys, programId: PROGRAMS.PUMP, data: discriminator }));
            claimedSomething = true;
            totalClaimed += bcInfo.lamports;
        }
    } catch (e) {
        logger.debug('Failed to claim BC fees', { error: e.message });
    }

    // Claim AMM Fees
    try {
        const myWsolAta = await getAssociatedTokenAddress(TOKENS.WSOL, devKeypair.publicKey);
        try {
            await getAccount(connection, myWsolAta);
        } catch {
            tx.add(createAssociatedTokenAccountInstruction(
                devKeypair.publicKey, myWsolAta, devKeypair.publicKey, TOKENS.WSOL
            ));
        }

        const ammVaultAtaKey = await ammVaultAta;
        const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));

        if (new BN(bal.value.amount).gt(new BN(0))) {
            const ammDiscriminator = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);
            const [eventAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("__event_authority")], PROGRAMS.PUMP_AMM
            );

            const keys = [
                { pubkey: TOKENS.WSOL, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: devKeypair.publicKey, isSigner: true, isWritable: false },
                { pubkey: ammVaultAuth, isSigner: false, isWritable: false },
                { pubkey: ammVaultAtaKey, isSigner: false, isWritable: true },
                { pubkey: myWsolAta, isSigner: false, isWritable: true },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.PUMP_AMM, isSigner: false, isWritable: false }
            ];

            tx.add(new TransactionInstruction({ keys, programId: PROGRAMS.PUMP_AMM, data: ammDiscriminator }));
            tx.add(createCloseAccountInstruction(myWsolAta, devKeypair.publicKey, devKeypair.publicKey));
            claimedSomething = true;
            totalClaimed += Number(bal.value.amount);
        }
    } catch (e) {
        logger.debug('Failed to claim AMM fees', { error: e.message });
    }

    if (claimedSomething) {
        tx.feePayer = devKeypair.publicKey;
        await solana.sendTxWithRetry(tx, [devKeypair]);
        return totalClaimed;
    }
    return 0;
}

/**
 * Claim creator fees from Robinhood tokens (external tokens sharing fees with us)
 * v12.0 - New feature for fee sharing partnerships
 * v25.73 - CRITICAL FIX: Use feeVaultAddress when available for fee sharing tokens
 *
 * Note: For fee sharing configs, we need to call distribute_creator_fees first
 * to have fees distributed to all shareholders, then claim our share
 */
async function claimRobinhoodFees(deps) {
    const { connection, devKeypair, db } = deps;

    let totalClaimed = 0;
    const claimedTokens = [];

    try {
        // Get all active Robinhood tokens (v25.14 SCALABILITY: Limit to 500 tokens)
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 LIMIT 500');

        for (const token of tokens) {
            try {
                const creatorPubkey = new PublicKey(token.creatorPubkey);

                // v25.101: Determine vault type and addresses based on token configuration
                // Two types: FEE program accounts (feeVaultAddress set) or PUMP program PDAs
                let bcVault;           // Where to check BC fee balance
                let pumpBcVault;       // PUMP program's creator-vault (for distribute instruction)
                let coinCreator;       // coin_creator account (feeVaultAddress or original creator)
                let ammVaultAuth, ammVaultAta, sharingConfigPDA;
                let isFeeProgram = false;

                if (token.feeVaultAddress) {
                    // v25.105: FEE program tokens - fees are in PUMP creator-vault, NOT feeVaultAddress
                    // From successful tx analysis: creator_vault (account 3) is PUMP PDA where SOL fees are
                    // The feeVaultAddress is only the sharing_config (account 2), not where fees are stored
                    const feeVaultPubkey = new PublicKey(token.feeVaultAddress);

                    // coin_creator = feeVaultAddress (sharing_config for instruction account 2)
                    coinCreator = feeVaultPubkey;

                    // PUMP bc_vault derived from original creator - THIS IS WHERE FEES ARE
                    const creatorVaults = pump.getShareholderFeeVaults(creatorPubkey);
                    pumpBcVault = creatorVaults.bcVault;
                    sharingConfigPDA = creatorVaults.sharingConfigPDA;

                    // v25.105: Check balance at PUMP creator-vault (same as where we distribute from)
                    bcVault = pumpBcVault;

                    // v25.100: AMM vaults derived from feeVaultPubkey (matches AMM pool.coin_creator)
                    const feeVaults = pump.getShareholderFeeVaults(feeVaultPubkey);
                    ammVaultAuth = feeVaults.ammVaultAuth;
                    ammVaultAta = feeVaults.ammVaultAta;
                    isFeeProgram = true;

                    logger.debug(`[Robinhood] ${token.ticker}: FEE program - coinCreator=${token.feeVaultAddress.slice(0, 8)}..., bcVault/pumpBcVault from creator ${token.creatorPubkey.slice(0, 8)}...`);
                } else {
                    // Legacy path: PUMP program fee sharing - derive from original creator
                    const vaults = pump.getShareholderFeeVaults(creatorPubkey);
                    bcVault = vaults.bcVault;
                    pumpBcVault = vaults.bcVault;  // Same for PUMP program tokens
                    coinCreator = vaults.sharingConfigPDA;  // For PUMP tokens, coin_creator = sharingConfigPDA
                    ammVaultAuth = vaults.ammVaultAuth;
                    ammVaultAta = vaults.ammVaultAta;
                    sharingConfigPDA = vaults.sharingConfigPDA;
                }

                let tokenClaimed = 0;

                // v25.79: Check BC vault for pending fees
                // CRITICAL FIX: Use 5000 lamports buffer (matches health.js and threshold)
                let bcPendingLamports = 0;
                let bcInfo = null;

                try {
                    bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo) {
                        const rentExemptMin = 5000; // Small buffer matching health.js
                        bcPendingLamports = Math.max(0, bcInfo.lamports - rentExemptMin);
                    }
                } catch (e) {
                    logger.debug(`[Robinhood] ${token.ticker}: BC vault check failed - ${e.message}`);
                }

                // v25.88: Only claim BC fees if over 0.05 SOL threshold (50M lamports)
                const BC_CLAIM_THRESHOLD = 50000000; // 0.05 SOL
                if (bcPendingLamports > BC_CLAIM_THRESHOLD) {
                    try {
                        // v25.97: All Robinhood tokens use distribute_creator_fees on PUMP program
                        // This distributes fees to all shareholders in the sharing config
                        logger.info(`[Robinhood] ${token.ticker}: BC vault has ${(bcPendingLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL pending - calling distribute_creator_fees...`);

                        // v25.98: Get sharing config from correct source
                        // FEE program tokens: shareholders embedded in bcVault (feeVaultAddress)
                        // PUMP program tokens: shareholders in separate sharingConfigPDA
                        const configAccount = isFeeProgram ? coinCreator : sharingConfigPDA;
                        const configData = await getCachedFeeSharingConfig(connection, configAccount, creatorPubkey, isFeeProgram);

                        if (configData && configData.shareholders && configData.shareholders.length > 0) {
                            const tx = new Transaction();
                            solana.addPriorityFee(tx);

                            const distributeDiscriminator = pump.buildDistributeFeesData();
                            const [eventAuthority] = PublicKey.findProgramAddressSync(
                                [Buffer.from("__event_authority")], PROGRAMS.PUMP
                            );

                            // v25.104: Exact account structure from successful tx 2cGnFzu4w12n995MxTHo8BKFbb2V5FHJ4aeCQh69mxhkmhuyrnBH9zMSMwQ2tt9GhoZMardqgSXDPjm4SAA3i8AV
                            // DistributeCreatorFees: mint, bonding_curve, sharing_config, creator_vault, system, event_auth, program, ...shareholders
                            // NO separate claimer account - signer is implicit in transaction
                            const mintPubkey = new PublicKey(token.mint);
                            const { bondingCurve } = pump.getPumpPDAs(mintPubkey);
                            const distributeKeys = [
                                { pubkey: mintPubkey, isSigner: false, isWritable: false },
                                { pubkey: bondingCurve, isSigner: false, isWritable: true },
                                { pubkey: coinCreator, isSigner: false, isWritable: true },  // sharing_config (feeVaultAddress)
                                { pubkey: pumpBcVault, isSigner: false, isWritable: true },  // creator_vault
                                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                                { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false },
                            ];
                            for (const sh of configData.shareholders) {
                                distributeKeys.push({ pubkey: sh.pubkey, isSigner: false, isWritable: true });
                            }

                            tx.add(new TransactionInstruction({
                                keys: distributeKeys,
                                programId: PROGRAMS.PUMP,
                                data: distributeDiscriminator
                            }));

                            tx.feePayer = devKeypair.publicKey;
                            await solana.sendTxWithRetry(tx, [devKeypair]);

                            const ourShare = Math.floor(bcPendingLamports * ((token.feeShareBps ?? 10000) / 10000));
                            tokenClaimed += ourShare;
                            totalClaimed += ourShare;
                            claimedTokens.push({
                                ticker: token.ticker || token.creatorPubkey.slice(0, 8),
                                amount: ourShare,
                                source: 'BC'
                            });

                            // v27.0: Split 95% of our share: 50% to per-token holders, 50% to central pool
                            const bcTotalReward = Math.floor(ourShare * 0.95);
                            const bcAirdropCredit = Math.floor(bcTotalReward * CREATOR_REWARD_HOLDER_SPLIT);
                            const bcCentralCredit = bcTotalReward - bcAirdropCredit;
                            await db.run(
                                'UPDATE robinhood_tokens SET "lastFeesClaimed" = $1, "totalFeesCollected" = "totalFeesCollected" + $2, "pendingFees" = 0, pending_airdrop_lamports = pending_airdrop_lamports + $3 WHERE id = $4',
                                [Date.now(), ourShare / LAMPORTS_PER_SOL, bcAirdropCredit, token.id]
                            );
                            if (bcCentralCredit > 0) {
                                await addToCentralPool(db, bcCentralCredit);
                            }

                            logger.info(`[Robinhood] ${token.ticker}: Distributed ${(bcPendingLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (our share: ${(ourShare / LAMPORTS_PER_SOL).toFixed(6)} SOL, ${(bcAirdropCredit / LAMPORTS_PER_SOL).toFixed(6)} to token pool, ${(bcCentralCredit / LAMPORTS_PER_SOL).toFixed(6)} to central pool)`);

                            // v25.113: Cross-record to PAGS if this token is also a PAGS beneficiary
                            // v25.114: Use on-chain shareholder BPS for PAGS wallet, not DB value
                            try {
                                const pagsBeneficiary = await db.get(
                                    'SELECT id, "feeShareBps" FROM pags_beneficiaries WHERE mint = $1 AND "isActive" = 1',
                                    [token.mint]
                                );
                                if (pagsBeneficiary) {
                                    const pagsService = require('../services/pags');
                                    // Look up PAGS wallet's actual on-chain share from configData
                                    let pagsShareBps = pagsBeneficiary.feeShareBps; // fallback to DB
                                    if (config.PAGS_WALLET && configData && configData.shareholders) {
                                        const pagsShareholder = configData.shareholders.find(
                                            sh => sh.pubkey.toString() === config.PAGS_WALLET
                                        );
                                        if (pagsShareholder) {
                                            pagsShareBps = pagsShareholder.shareBps;
                                            logger.debug(`[Robinhood] PAGS on-chain share for ${token.ticker}: ${pagsShareBps/100}% (DB: ${pagsBeneficiary.feeShareBps/100}%)`);
                                        }
                                    }
                                    const pagsShareLamports = Math.floor(bcPendingLamports * (pagsShareBps / 10000));
                                    const pagsShareSol = pagsShareLamports / LAMPORTS_PER_SOL;
                                    if (pagsShareSol > 0.000001) {
                                        await pagsService.recordFeeCollection(token.mint, pagsShareSol, 'robinhood_cross_claim', null, false);
                                        logger.info(`[Robinhood] Cross-recorded ${pagsShareSol.toFixed(6)} SOL to PAGS for ${token.ticker} (${pagsShareBps/100}% on-chain)`);
                                    }
                                    // Update PAGS vault balance cache to prevent double-count
                                    pagsFeeScanner.updateVaultBalanceCache(token.mint, 5000, 0);
                                }
                            } catch (crossErr) {
                                logger.debug('[Robinhood] PAGS cross-record failed (non-critical)', { mint: token.mint, error: crossErr.message });
                            }
                        } else {
                            logger.warn(`[Robinhood] ${token.ticker}: No sharing config found at ${sharingConfigPDA.toString().slice(0, 8)}...`);
                        }
                    } catch (e) {
                        logger.info(`[Robinhood] BC distribute failed for ${token.ticker}: ${e.message}`, {
                            bcVault: bcVault.toString(),
                            sharingConfigPDA: sharingConfigPDA.toString()
                        });
                    }
                } else {
                    logger.debug(`[Robinhood] ${token.ticker}: No pending BC fees (balance: ${bcInfo?.lamports || 0})`);
                }

                // v25.112: BUGFIX - AMM fees use TransferCreatorFeesToPump + distribute_creator_fees
                // collect_creator_fee requires signer to be creator, which fails for fee-sharing tokens (error 2006)
                // The correct approach: transfer AMM fees to BC vault, then distribute to shareholders
                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                    const ammFeeLamports = parseInt(bal.value.amount) || 0;

                    // v25.88: Only claim AMM fees if over 0.05 SOL threshold
                    const AMM_CLAIM_THRESHOLD = 50000000; // 0.05 SOL
                    if (ammFeeLamports > AMM_CLAIM_THRESHOLD) {
                        const ammFeeSol = ammFeeLamports / LAMPORTS_PER_SOL;
                        const ourShare = ammFeeSol * ((token.feeShareBps ?? 10000) / 10000);

                        logger.info(`[Robinhood/AMM] ${token.ticker}: Found ${ammFeeSol.toFixed(6)} SOL in AMM vault (our share: ${ourShare.toFixed(6)} SOL @ ${(token.feeShareBps ?? 10000)/100}%)`);

                        try {
                            const ammTx = new Transaction();
                            solana.addPriorityFee(ammTx);

                            const mintPubkey = new PublicKey(token.mint);
                            const { pool } = pump.getPumpAmmPDAs(mintPubkey);

                            // v25.112: Read coin_creator from AMM pool (authoritative for graduated tokens)
                            let ammCoinCreator = coinCreator;
                            try {
                                const poolAccountInfo = await connection.getAccountInfo(pool);
                                if (poolAccountInfo && poolAccountInfo.data.length >= 43) {
                                    ammCoinCreator = new PublicKey(poolAccountInfo.data.slice(11, 43));
                                    logger.debug(`[Robinhood/AMM] ${token.ticker}: Using AMM pool coin_creator: ${ammCoinCreator.toString().slice(0, 8)}...`);
                                }
                            } catch (e) {
                                logger.debug(`[Robinhood/AMM] ${token.ticker}: Could not read AMM pool, using fallback coin_creator`);
                            }

                            // Derive vaults from coin_creator for consistency
                            const ammVaults = pump.getShareholderFeeVaults(ammCoinCreator);
                            const ammVaultAuthKey = ammVaults.ammVaultAuth;
                            const ammVaultAtaResolved = await ammVaults.ammVaultAta;
                            const bcVaultKey = ammVaults.bcVault;

                            // Step 1: TransferCreatorFeesToPump - moves wSOL from AMM vault to BC vault
                            const transferDiscriminator = pump.buildTransferFeesToPumpData();

                            // v25.113: BUGFIX - Account 8 must be event_authority, NOT pool
                            // Reference: successful tx 2cGnFzu4w12n995MxTHo8BKFbb2V5FHJ4aeCQh69mxhkmhuyrnBH9zMSMwQ2tt9GhoZMardqgSXDPjm4SAA3i8AV
                            const [ammEventAuthority] = PublicKey.findProgramAddressSync(
                                [Buffer.from("__event_authority")], PROGRAMS.PUMP_AMM
                            );

                            const transferKeys = [
                                { pubkey: TOKENS.WSOL, isSigner: false, isWritable: false },           // 0: wsol_mint
                                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // 1: token_program
                                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 2: system_program
                                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 3: ata_program
                                { pubkey: ammCoinCreator, isSigner: false, isWritable: false },        // 4: coin_creator
                                { pubkey: ammVaultAuthKey, isSigner: false, isWritable: true },        // 5: amm_vault_auth
                                { pubkey: ammVaultAtaResolved, isSigner: false, isWritable: true },    // 6: amm_vault_ata (wSOL)
                                { pubkey: bcVaultKey, isSigner: false, isWritable: true },             // 7: bc_vault (destination)
                                { pubkey: ammEventAuthority, isSigner: false, isWritable: false },     // 8: event_authority (NOT pool!)
                                { pubkey: PROGRAMS.PUMP_AMM, isSigner: false, isWritable: false },     // 9: pump_amm_program
                            ];

                            ammTx.add(new TransactionInstruction({
                                keys: transferKeys,
                                programId: PROGRAMS.PUMP_AMM,
                                data: transferDiscriminator
                            }));

                            // Step 2: distribute_creator_fees - distributes from BC vault to shareholders
                            // Get shareholders from config (re-use from BC claim if we have it)
                            const configAccount = isFeeProgram ? new PublicKey(token.feeVaultAddress) : ammVaults.sharingConfigPDA;
                            const ammConfigData = await getCachedFeeSharingConfig(connection, configAccount, creatorPubkey, isFeeProgram);

                            if (ammConfigData && ammConfigData.shareholders && ammConfigData.shareholders.length > 0) {
                                const distributeDiscriminator = pump.buildDistributeFeesData();
                                const [eventAuthority] = PublicKey.findProgramAddressSync(
                                    [Buffer.from("__event_authority")], PROGRAMS.PUMP
                                );

                                const { bondingCurve } = pump.getPumpPDAs(mintPubkey);
                                const distributeKeys = [
                                    { pubkey: mintPubkey, isSigner: false, isWritable: false },
                                    { pubkey: bondingCurve, isSigner: false, isWritable: true },
                                    { pubkey: ammCoinCreator, isSigner: false, isWritable: true },  // sharing_config / coin_creator
                                    { pubkey: bcVaultKey, isSigner: false, isWritable: true },       // creator_vault
                                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                                    { pubkey: eventAuthority, isSigner: false, isWritable: false },
                                    { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false },
                                ];
                                for (const sh of ammConfigData.shareholders) {
                                    distributeKeys.push({ pubkey: sh.pubkey, isSigner: false, isWritable: true });
                                }

                                ammTx.add(new TransactionInstruction({
                                    keys: distributeKeys,
                                    programId: PROGRAMS.PUMP,
                                    data: distributeDiscriminator
                                }));
                            } else {
                                // No shareholders found - can still try transfer only
                                logger.warn(`[Robinhood/AMM] ${token.ticker}: No shareholders found, attempting transfer only`);
                            }

                            ammTx.feePayer = devKeypair.publicKey;
                            await solana.sendTxWithRetry(ammTx, [devKeypair]);

                            // Distribution succeeded!
                            const ourShareLamports = Math.floor(ammFeeLamports * ((token.feeShareBps ?? 10000) / 10000));
                            totalClaimed += ourShareLamports;
                            claimedTokens.push({
                                ticker: token.ticker || token.creatorPubkey.slice(0, 8),
                                amount: ourShareLamports,
                                source: 'AMM'
                            });

                            // v27.0: Split 95% of our AMM share: 50% to per-token holders, 50% to central pool
                            const ammTotalReward = Math.floor(ourShareLamports * 0.95);
                            const ammAirdropCredit = Math.floor(ammTotalReward * CREATOR_REWARD_HOLDER_SPLIT);
                            const ammCentralCredit = ammTotalReward - ammAirdropCredit;
                            await db.run(
                                'UPDATE robinhood_tokens SET "lastFeesClaimed" = $1, "totalFeesCollected" = "totalFeesCollected" + $2, "pendingAmmFees" = 0, pending_airdrop_lamports = pending_airdrop_lamports + $3 WHERE id = $4',
                                [Date.now(), ourShareLamports / LAMPORTS_PER_SOL, ammAirdropCredit, token.id]
                            );
                            if (ammCentralCredit > 0) {
                                await addToCentralPool(db, ammCentralCredit);
                            }

                            logger.info(`[Robinhood/AMM] ${token.ticker}: Distributed ${ammFeeSol.toFixed(6)} SOL (our share: ${ourShare.toFixed(6)} SOL, ${(ammAirdropCredit / LAMPORTS_PER_SOL).toFixed(6)} to token pool, ${(ammCentralCredit / LAMPORTS_PER_SOL).toFixed(6)} to central pool)`);

                            // v25.113: Cross-record to PAGS if this token is also a PAGS beneficiary
                            // v25.114: Use on-chain shareholder BPS for PAGS wallet, not DB value
                            try {
                                const pagsBeneficiary = await db.get(
                                    'SELECT id, "feeShareBps" FROM pags_beneficiaries WHERE mint = $1 AND "isActive" = 1',
                                    [token.mint]
                                );
                                if (pagsBeneficiary) {
                                    const pagsService = require('../services/pags');
                                    // Look up PAGS wallet's actual on-chain share from ammConfigData
                                    let pagsShareBps = pagsBeneficiary.feeShareBps; // fallback to DB
                                    if (config.PAGS_WALLET && ammConfigData && ammConfigData.shareholders) {
                                        const pagsShareholder = ammConfigData.shareholders.find(
                                            sh => sh.pubkey.toString() === config.PAGS_WALLET
                                        );
                                        if (pagsShareholder) {
                                            pagsShareBps = pagsShareholder.shareBps;
                                            logger.debug(`[Robinhood/AMM] PAGS on-chain share for ${token.ticker}: ${pagsShareBps/100}% (DB: ${pagsBeneficiary.feeShareBps/100}%)`);
                                        }
                                    }
                                    const pagsShareLamports = Math.floor(ammFeeLamports * (pagsShareBps / 10000));
                                    const pagsShareSol = pagsShareLamports / LAMPORTS_PER_SOL;
                                    if (pagsShareSol > 0.000001) {
                                        await pagsService.recordFeeCollection(token.mint, pagsShareSol, 'robinhood_cross_claim', null, false);
                                        logger.info(`[Robinhood/AMM] Cross-recorded ${pagsShareSol.toFixed(6)} SOL to PAGS for ${token.ticker} (${pagsShareBps/100}% on-chain)`);
                                    }
                                    pagsFeeScanner.updateVaultBalanceCache(token.mint, 5000, 0);
                                }
                            } catch (crossErr) {
                                logger.debug('[Robinhood/AMM] PAGS cross-record failed (non-critical)', { mint: token.mint, error: crossErr.message });
                            }

                        } catch (claimErr) {
                            // AMM distribution failed - track as pending for monitoring
                            totalPendingAmmFees += ammFeeLamports;

                            // Update database with pending AMM fees
                            await db.run(
                                'UPDATE robinhood_tokens SET "pendingAmmFees" = $1 WHERE mint = $2',
                                [ammFeeSol, token.mint]
                            ).catch(() => {});

                            logger.info(`[Robinhood/AMM] ${token.ticker}: AMM distribution failed - ${claimErr.message}`);
                        }
                    }
                } catch (e) {
                    logger.debug(`[Robinhood/AMM] ${token.ticker}: Check failed - ${e.message}`);
                }

                await new Promise(r => setTimeout(r, 500)); // Rate limiting between tokens

            } catch (e) {
                logger.error(`[Robinhood] Fee claim error for ${token.creatorPubkey}`, { error: e.message });
            }
        }
    } catch (e) {
        logger.error('[Robinhood] Claim fees error', { error: e.message });
    }

    // v25.112: AMM fee monitoring - alert if pending fees exceed threshold
    // Now using TransferCreatorFeesToPump + distribute_creator_fees pattern
    const pendingAmmSol = totalPendingAmmFees / LAMPORTS_PER_SOL;
    if (pendingAmmSol > AMM_FEE_ALERT_THRESHOLD_SOL) {
        const now = Date.now();
        // Only alert every 5 minutes to prevent spam
        if (now - lastAmmFeeAlert > AMM_FEE_MONITOR_INTERVAL_MS) {
            lastAmmFeeAlert = now;
            logger.warn(`[Robinhood/AMM] ALERT: ${pendingAmmSol.toFixed(4)} SOL in pending AMM fees failed to distribute (check transaction errors)`);

            // Store total pending AMM fees in stats for dashboard visibility
            await db.run(
                'INSERT INTO stats (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
                ['pendingAmmFeesLamports', totalPendingAmmFees]
            ).catch(() => {});
        }
    }

    // Reset for next cycle
    totalPendingAmmFees = 0;

    return { totalClaimed, claimedTokens, pendingAmmSol };
}

/**
 * Refresh fee share BPS for all active Robinhood tokens
 * v23.0 - Called before airdrop to ensure points reflect current on-chain reward percentages
 * This is important because Pump.fun allows creators to change reward distribution dynamically
 *
 * @param {Object} deps - Dependencies including connection, devKeypair, db
 * @returns {Object} - Summary of refresh results
 */
async function refreshAllFeeShares(deps) {
    const { connection, devKeypair, db } = deps;

    try {
        // v25.14 SCALABILITY: Limit to 500 tokens to prevent memory issues
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 LIMIT 500');

        if (tokens.length === 0) {
            return { total: 0, updated: 0, deactivated: 0, errors: 0 };
        }

        const platformWallet = devKeypair.publicKey.toString();
        let updated = 0;
        let deactivated = 0;
        let errors = 0;

        for (const token of tokens) {
            try {
                const verification = await mintExtractor.verifyFeeRecipient(
                    token.mint,
                    platformWallet,
                    connection
                );

                // v25.37: Check for error flag - don't deactivate on RPC errors
                // This prevents incorrectly removing tokens due to network issues
                if (verification.error) {
                    errors++;
                    logger.warn(`[FeeShareRefresh] ${token.ticker} (${token.mint.slice(0, 8)}...) - Verification error, keeping current state: ${verification.error}`);
                    continue;
                }

                if (!verification.isRecipient) {
                    // No longer a fee recipient - deactivate
                    await db.run(
                        'UPDATE robinhood_tokens SET "isActive" = 0 WHERE mint = $1',
                        [token.mint]
                    );
                    deactivated++;
                    logger.warn(`[FeeShareRefresh] ${token.ticker} (${token.mint.slice(0, 8)}...) - No longer a fee recipient, deactivated`);
                } else if (verification.feeShareBps !== token.feeShareBps) {
                    // Fee share changed - update
                    await db.run(
                        'UPDATE robinhood_tokens SET "feeShareBps" = $1 WHERE mint = $2',
                        [verification.feeShareBps, token.mint]
                    );
                    updated++;
                    logger.info(`[FeeShareRefresh] ${token.ticker} - Fee share updated: ${token.feeShareBps} -> ${verification.feeShareBps} bps`);
                }

                // Rate limit
                await new Promise(r => setTimeout(r, 50));

            } catch (e) {
                // v25.37: Count errors but don't deactivate - could be temporary issue
                errors++;
                logger.warn(`[FeeShareRefresh] Error for ${token.ticker} (${token.mint.slice(0, 8)}...): ${e.message}`);
            }
        }

        if (updated > 0 || deactivated > 0 || errors > 0) {
            logger.info(`[FeeShareRefresh] Complete: ${updated} updated, ${deactivated} deactivated, ${errors} errors out of ${tokens.length} tokens`);
        }

        return { total: tokens.length, updated, deactivated, errors };
    } catch (e) {
        logger.error('[FeeShareRefresh] Error', { error: e.message });
        return { total: 0, updated: 0, deactivated: 0, errors: 1, error: e.message };
    }
}

/**
 * Process SOL airdrop distribution
 * Updated with "King of the Hill" (KOTH) Logic
 *
 * v11.0 - Now distributes SOL directly instead of PUMP tokens
 * v23.0 - Refreshes fee share BPS before calculating points
 * This uses the same distribution rules (points, percentages) but sends SOL
 * Benefits: No ATA creation needed, lower transaction costs, simpler logic
 */
async function processAirdrop(deps) {
    const { connection, devKeypair, db, globalState } = deps;

    // RACE CONDITION FIX: Use mutex for atomic locking
    const release = await airdropMutex.tryAcquire();
    if (!release) {
        logger.info('[Airdrop] Skipping - already in progress');
        return;
    }

    // v25.13: Track success at function scope for finally block
    let airdropCompleted = false;
    let airdropId = null;

    // v25.113: Structured event timeline for full airdrop process logging
    const airdropStartTime = Date.now();
    const airdropLog = {
        events: [],
        balances: {},
        distribution: {},
        timing: { startedAt: airdropStartTime }
    };
    const logEvent = (type, message, data = null) => {
        const event = { type, message, ts: Date.now(), elapsed: Date.now() - airdropStartTime };
        if (data) event.data = data;
        airdropLog.events.push(event);
    };

    try {
        // Get current SOL balance available for airdrop
        const solBalance = await connection.getBalance(devKeypair.publicKey);

        // v25.78: Calculate airdrop pool: SOL balance minus safety reserve (0.1 SOL for operations)
        const SAFETY_RESERVE = 0.1 * LAMPORTS_PER_SOL;
        // v17.0: Minimum 1 SOL to trigger airdrop (configurable)
        const MIN_AIRDROP_POOL = (config.AIRDROP_THRESHOLD_SOL || 1.0) * LAMPORTS_PER_SOL;

        const availableForAirdrop = solBalance - SAFETY_RESERVE;

        // v25.43: ALWAYS evaluate KOTH (even without airdrop) so frontend stays updated
        // This runs every time processAirdrop is called (every 15 min) with internal 30-min cache
        try {
            await getAiSelectedKoth(db);
        } catch (kothErr) {
            logger.warn('[Airdrop] KOTH evaluation failed, continuing...', { error: kothErr.message });
        }

        // Basic Threshold Check - need at least MIN_AIRDROP_POOL SOL after reserve
        if (availableForAirdrop < MIN_AIRDROP_POOL) {
            logger.info(`[Airdrop] Below threshold: ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL available, need ${config.AIRDROP_THRESHOLD_SOL || 1.0} SOL`);
            // v25.29: Still update timestamp so countdown stays synchronized
            // This ensures frontend shows accurate next attempt time
            const airdropInterval = config.AIRDROP_INTERVAL || 900000;
            const nextAirdropTime = Date.now() + airdropInterval;
            await db.run('UPDATE stats SET value = $1 WHERE key = $2', [nextAirdropTime, 'nextAirdropTimestamp']).catch(() => {});
            return; // Lock will be released in finally block
        }

        logger.info(`SOL AIRDROP TRIGGERED: ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL available for distribution`);
        airdropLog.balances.initial = solBalance / LAMPORTS_PER_SOL;
        airdropLog.balances.available = availableForAirdrop / LAMPORTS_PER_SOL;
        logEvent('TRIGGERED', `Airdrop triggered with ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL available`, {
            walletBalance: solBalance / LAMPORTS_PER_SOL,
            available: availableForAirdrop / LAMPORTS_PER_SOL,
            safetyReserve: 0.1,
            threshold: config.AIRDROP_THRESHOLD_SOL || 1.0
        });

        // v25.39: Refresh holder data BEFORE distribution to ensure fresh points
        // This is critical - without fresh data, users who bought/sold recently won't have accurate points
        logger.info('[Airdrop] Refreshing holder data and points before distribution...');
        const holderRefreshStart = Date.now();
        try {
            // C-1 FIX: Check return value — if scan was skipped (mutex held by interval),
            // log a clear warning so we know airdrop may proceed on up-to-5-min stale points.
            const refreshResult = await holderScanner.updateGlobalState(deps);
            if (refreshResult?.scanCompleted) {
                logger.info('[Airdrop] Holder data refreshed successfully');
                logEvent('HOLDER_REFRESH', 'Holder data refreshed successfully', { durationMs: Date.now() - holderRefreshStart });
            } else if (refreshResult?.skipped) {
                logger.warn('[Airdrop] Holder scan was skipped (previous scan in progress) — proceeding with cached points data');
                logEvent('HOLDER_REFRESH', 'Holder scan skipped — using cached data', { durationMs: Date.now() - holderRefreshStart, skipped: true });
            } else {
                logger.warn('[Airdrop] Holder refresh returned unexpected result, using cached data');
            }
        } catch (holderError) {
            // Log but don't abort - proceed with last known data
            logger.warn('[Airdrop] Holder refresh failed, using cached data', { error: holderError.message });
            logEvent('HOLDER_REFRESH', `Holder refresh failed, using cached data: ${holderError.message}`, { durationMs: Date.now() - holderRefreshStart, error: holderError.message });
        }

        // v23.0: Refresh fee share BPS for all Robinhood tokens before calculating points
        // This ensures points reflect current on-chain reward percentages
        logger.info('[Airdrop] Refreshing fee share percentages before distribution...');
        await refreshAllFeeShares(deps);
        logEvent('FEE_SHARE_REFRESH', 'Fee share percentages refreshed');

        // v25.13: Verify Redis is connected before proceeding
        if (!redis.isRedisConnected()) {
            logger.error('[Airdrop] ABORTED: Redis not connected - cannot fetch user points safely');
            logEvent('ABORTED', 'Redis not connected - cannot fetch user points safely');
            return;
        }

        // Total Amount to be distributed (99% of available pool)
        const totalDistributable = Math.floor(availableForAirdrop * 0.99);
        let kothAmount = 0;
        let communityAmount = totalDistributable;
        let kothTxSignature = null;

        // v25.110: CRITICAL FIX - Validate ALL data BEFORE sending ANY transactions
        // Previously KOTH was sent before community validation, causing partial airdrops on failure

        // 1. Fetch community distribution data first (validation before any sends)
        const userPointsMap = await redis.getAllUserPoints();
        const totalPoints = await redis.getTotalPoints();

        const userPoints = Array.from(userPointsMap.entries())
            .map(([pubkey, points]) => ({ pubkey: new PublicKey(pubkey), points }))
            .filter(user => user.points > 0);

        logEvent('DATA_LOADED', `Loaded ${userPoints.length} eligible users with ${totalPoints.toFixed(2)} total points from Redis`, {
            eligibleUsers: userPoints.length,
            totalPoints,
            totalDistributable: totalDistributable / LAMPORTS_PER_SOL
        });

        if (totalPoints === 0 || userPoints.length === 0) {
            logger.warn('[Airdrop] No eligible users found (totalPoints=0 or no users with points). Skipping distribution.');
            logEvent('ABORTED', 'No eligible users found');
            const airdropInterval = config.AIRDROP_INTERVAL || 900000;
            const nextAirdropTime = Date.now() + airdropInterval;
            await db.run('UPDATE stats SET value = $1 WHERE key = $2', [nextAirdropTime, 'nextAirdropTimestamp']).catch(() => {});
            return; // Lock will be released in finally block
        }

        // 2. Identify King of the Hill using AI scoring system
        // v25.38: AI-based selection considers multiple metrics (volume, holders, age, etc.)
        const KOTH_MAX_PERCENT = 0.10; // 10% cap

        const kothResult = await getAiSelectedKoth(db);
        // v25.113: Check both platform and robinhood token tables
        let kothToken = kothResult.token ? await db.get(
            'SELECT "userPubkey", ticker, mint, "marketCap" FROM tokens WHERE mint = $1',
            [kothResult.token.mint]
        ) : null;
        let kothSource = 'platform';
        if (!kothToken && kothResult.token) {
            const rhToken = await db.get(
                'SELECT "creatorPubkey" as "userPubkey", ticker, mint, "marketCap" FROM robinhood_tokens WHERE mint = $1',
                [kothResult.token.mint]
            );
            if (rhToken) {
                kothToken = rhToken;
                kothSource = 'robinhood';
            }
        }

        if (kothResult.reasoning) {
            logger.info(`[KOTH] AI Reasoning: ${kothResult.reasoning}`);
        }

        // 3. Build KOTH distribution plan (but don't send yet)
        let kothBatch = [];
        let kothHolders = [];
        // H-1 FIX: Re-validate KOTH token's current volume before distribution.
        // Selection may be up to 2h stale (Redis TTL). A token that crashed to 0 volume
        // after selection must not receive the 10% KOTH bonus.
        if (kothToken && kothToken.mint) {
            const kothCurrentRow = kothSource === 'robinhood'
                ? await db.get('SELECT volume24h FROM robinhood_tokens WHERE mint = $1', [kothToken.mint])
                : await db.get('SELECT volume24h FROM tokens WHERE mint = $1', [kothToken.mint]);
            if (!kothCurrentRow || (parseFloat(kothCurrentRow.volume24h) || 0) < KOTH_MIN_VOLUME) {
                logger.warn(`[KOTH] ${kothToken.ticker} no longer meets minimum volume at distribution time — skipping KOTH bonus`);
                kothToken = null;
            }
        }
        if (kothToken && kothToken.mint) {
            // v25.113: Query correct holder table based on token source
            const holdersTable = kothSource === 'robinhood' ? 'robinhood_token_holders' : 'token_holders';
            const VALID_HOLDER_TABLES = ['token_holders', 'robinhood_token_holders'];
            if (!VALID_HOLDER_TABLES.includes(holdersTable)) throw new Error(`Invalid holders table: ${holdersTable}`);
            kothHolders = await db.all(
                `SELECT "holderPubkey", balance FROM ${holdersTable} WHERE mint = $1 ORDER BY rank ASC`,
                [kothToken.mint]
            );

            if (kothHolders && kothHolders.length >= KOTH_MIN_HOLDERS) {
                kothAmount = Math.floor(totalDistributable * KOTH_MAX_PERCENT);
                communityAmount = totalDistributable - kothAmount;

                logger.info(`👑 King of the Hill: ${kothToken.ticker} (MCAP: $${kothToken.marketCap?.toFixed(0) || 0}) - Planning ${(kothAmount / LAMPORTS_PER_SOL).toFixed(2)} SOL to ${kothHolders.length} holders`);

                const totalBalance = kothHolders.reduce((sum, h) => sum + BigInt(h.balance || '0'), BigInt(0));

                for (const holder of kothHolders) {
                    try {
                        const holderBalance = BigInt(holder.balance || '0');
                        if (holderBalance <= BigInt(0)) continue;

                        const share = totalBalance > BigInt(0)
                            ? Number((BigInt(kothAmount) * holderBalance) / totalBalance)
                            : (kothHolders.length > 0 ? Math.floor(kothAmount / kothHolders.length) : 0);

                        if (share > 0) {
                            kothBatch.push({ user: new PublicKey(holder.holderPubkey), amount: share });
                        }
                    } catch (e) {
                        logger.debug(`Skipping invalid KOTH holder: ${holder.holderPubkey}`);
                    }
                }
                logEvent('KOTH_SELECTED', `KOTH: ${kothToken.ticker} - ${kothBatch.length} recipients, ${(kothAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL allocated`, {
                    ticker: kothToken.ticker,
                    mint: kothToken.mint,
                    marketCap: kothToken.marketCap,
                    holderCount: kothHolders.length,
                    recipientCount: kothBatch.length,
                    amountSOL: kothAmount / LAMPORTS_PER_SOL,
                    reasoning: kothResult.reasoning
                });
            } else {
                logger.info(`👑 King of the Hill: ${kothToken.ticker} - Only ${kothHolders?.length || 0} holders (need ${KOTH_MIN_HOLDERS} min), skipping KOTH bonus`);
                logEvent('KOTH_SKIPPED', `${kothToken.ticker} has only ${kothHolders?.length || 0} holders (need ${KOTH_MIN_HOLDERS} min)`, { ticker: kothToken.ticker, holderCount: kothHolders?.length || 0, minRequired: KOTH_MIN_HOLDERS });
            }
        } else {
            logger.debug('[Airdrop] No KOTH token qualifies (needs $1000 min market cap)');
            logEvent('KOTH_SKIPPED', 'No KOTH token qualifies');
        }

        // 4. Build community distribution plan
        let plannedDistribution = 0;
        const distributionPlan = [];
        let dustFilteredCount = 0;
        for (const user of userPoints) {
            const share = Math.floor((communityAmount * user.points) / totalPoints);
            if (share > 0) {
                plannedDistribution += share;
                distributionPlan.push({ user: user.pubkey, amount: share, points: user.points });
            } else {
                dustFilteredCount++;
            }
        }

        logEvent('PLAN_BUILT', `Distribution plan: ${distributionPlan.length} community recipients + ${kothBatch.length} KOTH recipients`, {
            communityRecipients: distributionPlan.length,
            kothRecipients: kothBatch.length,
            communitySOL: communityAmount / LAMPORTS_PER_SOL,
            kothSOL: kothAmount / LAMPORTS_PER_SOL,
            plannedSOL: (plannedDistribution + kothAmount) / LAMPORTS_PER_SOL,
            dustFiltered: dustFilteredCount
        });

        // 5. Validate total planned distribution
        const totalPlannedWithKoth = plannedDistribution + kothAmount;
        if (totalPlannedWithKoth > availableForAirdrop) {
            logger.error(`[Airdrop] ABORTED: Planned distribution (${totalPlannedWithKoth / LAMPORTS_PER_SOL} SOL) exceeds available (${availableForAirdrop / LAMPORTS_PER_SOL} SOL)`);
            logEvent('ABORTED', `Planned ${totalPlannedWithKoth / LAMPORTS_PER_SOL} SOL exceeds available ${availableForAirdrop / LAMPORTS_PER_SOL} SOL`);
            return;
        }

        // 6. Final balance check before ANY transactions
        const finalBalanceCheck = await connection.getBalance(devKeypair.publicKey);
        const finalAvailable = finalBalanceCheck - SAFETY_RESERVE;

        const BALANCE_TOLERANCE = 0.01 * LAMPORTS_PER_SOL;
        if (finalAvailable < totalPlannedWithKoth - BALANCE_TOLERANCE) {
            logger.error(`[Airdrop] ABORTED: Balance changed during preparation (race condition detected). Initial: ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL, Now: ${(finalAvailable / LAMPORTS_PER_SOL).toFixed(4)} SOL, Planned: ${(totalPlannedWithKoth / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            logEvent('ABORTED', 'Balance changed during preparation (race condition)', { initial: availableForAirdrop / LAMPORTS_PER_SOL, now: finalAvailable / LAMPORTS_PER_SOL });
            return;
        }

        logEvent('VALIDATION_PASSED', 'All pre-flight checks passed, starting transactions', {
            finalBalance: finalBalanceCheck / LAMPORTS_PER_SOL,
            plannedTotal: totalPlannedWithKoth / LAMPORTS_PER_SOL
        });

        if (finalAvailable > availableForAirdrop) {
            logger.info(`[Airdrop] Balance increased during preparation (${((finalAvailable - availableForAirdrop) / LAMPORTS_PER_SOL).toFixed(4)} SOL). Using original plan to prevent manipulation.`);
        }

        // ============================================================
        // ALL VALIDATIONS PASSED - NOW SAFE TO SEND TRANSACTIONS
        // ============================================================

        logger.info(`Distributing ${(totalDistributable / LAMPORTS_PER_SOL).toFixed(4)} SOL total (${(kothAmount / LAMPORTS_PER_SOL).toFixed(4)} KOTH + ${(communityAmount / LAMPORTS_PER_SOL).toFixed(4)} Community)`);

        // v25.111: Generate airdrop ID early for pending record
        airdropId = `airdrop_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        // Create pending airdrop record before distribution starts
        try {
            await db.run(
                `INSERT INTO stats (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
                ['pending_airdrop', JSON.stringify({
                    id: airdropId,
                    startedAt: Date.now(),
                    plannedAmount: totalPlannedWithKoth / LAMPORTS_PER_SOL,
                    recipientCount: distributionPlan.length,
                    kothAmount: kothAmount / LAMPORTS_PER_SOL
                })]
            );
        } catch (e) {
            logger.warn('[Airdrop] Failed to create pending record', { error: e.message });
        }

        // v25.111: Track actual lamports sent for accurate recording
        let actualKothLamportsSent = 0;
        let actualCommunityLamportsSent = 0;
        let allSignatures = [];
        let successfulBatches = 0;
        let failedBatches = 0;
        let failedUsers = [];

        // 7. Send KOTH distributions (now safe - all validations passed)
        if (kothBatch.length > 0) {
            try {
                let kothSignatures = [];
                for (let i = 0; i < kothBatch.length; i += KOTH_BATCH_SIZE) {
                    const batch = kothBatch.slice(i, i + KOTH_BATCH_SIZE);
                    const result = await sendSolAirdropBatch(batch, deps);
                    if (result?.signature) {
                        kothSignatures.push(result.signature);
                        // v25.112: Track ACTUAL lamports sent (excludes dust-filtered items)
                        actualKothLamportsSent += result.actualLamports;
                    }
                    // result is non-null but no signature = dust-only batch (not a failure)
                    if (i + KOTH_BATCH_SIZE < kothBatch.length) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }

                if (kothSignatures.length > 0) {
                    kothTxSignature = kothSignatures.join(',');
                    allSignatures.push(`KOTH:${kothTxSignature}`);
                    logger.info(`✅ KOTH Holder Payout Complete: ${kothSignatures.length} transactions, ${(actualKothLamportsSent / LAMPORTS_PER_SOL).toFixed(4)} SOL sent to ${kothBatch.length} holders`);
                    logEvent('KOTH_SENT', `KOTH payout complete: ${(actualKothLamportsSent / LAMPORTS_PER_SOL).toFixed(4)} SOL in ${kothSignatures.length} tx`, {
                        txCount: kothSignatures.length,
                        actualSOL: actualKothLamportsSent / LAMPORTS_PER_SOL,
                        recipients: kothBatch.length
                    });
                } else {
                    logger.error("❌ KOTH Payout Failed - funds remain in wallet for next cycle");
                    logEvent('KOTH_FAILED', 'All KOTH batches failed - funds remain for next cycle');
                    kothAmount = 0;
                }
            } catch (e) {
                logger.error(`KOTH Logic Error: ${e.message}`);
                logEvent('KOTH_FAILED', `KOTH error: ${e.message}`, { error: e.message });
                kothAmount = 0;
            }
        }

        // 8. Send community distributions
        // v25.111: If KOTH failed, rebuild distribution plan with full pool
        if (kothBatch.length > 0 && kothAmount === 0 && actualKothLamportsSent === 0) {
            // KOTH completely failed - recalculate community shares with full pool
            communityAmount = totalDistributable;
            distributionPlan.length = 0;
            plannedDistribution = 0;
            for (const user of userPoints) {
                const share = Math.floor((communityAmount * user.points) / totalPoints);
                if (share > 0) {
                    plannedDistribution += share;
                    distributionPlan.push({ user: user.pubkey, amount: share, points: user.points });
                }
            }
            logger.info(`[Airdrop] KOTH failed - redistributing full pool to ${distributionPlan.length} community users (${(communityAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
            logEvent('KOTH_REDISTRIBUTED', `KOTH failed - full pool redistributed to ${distributionPlan.length} community users`, { communitySOL: communityAmount / LAMPORTS_PER_SOL, recipients: distributionPlan.length });
        }

        logger.info(`Distributing ${(communityAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL to ${distributionPlan.length} users (Community Pool)`);

        // v25.23: Use optimized batch size constant (AIRDROP_BATCH_SIZE = 25)
        const PARALLEL_BATCHES = 3;

        // Split distribution plan into batches
        const batches = [];
        for (let i = 0; i < distributionPlan.length; i += AIRDROP_BATCH_SIZE) {
            batches.push(distributionPlan.slice(i, i + AIRDROP_BATCH_SIZE).map(r => ({
                user: r.user,
                amount: r.amount
            })));
        }

        // Process batches in parallel groups
        for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
            const parallelGroup = batches.slice(i, i + PARALLEL_BATCHES);

            const results = await Promise.allSettled(
                parallelGroup.map(batch => sendSolAirdropBatch(batch, deps))
            );

            results.forEach((result, idx) => {
                const batch = parallelGroup[idx];
                if (result.status === 'fulfilled' && result.value?.signature) {
                    allSignatures.push(result.value.signature);
                    successfulBatches++;
                    // v25.112: Track ACTUAL lamports sent (excludes dust-filtered items)
                    actualCommunityLamportsSent += result.value.actualLamports;
                } else if (result.status === 'fulfilled' && result.value !== null) {
                    // v25.112: Dust-only batch - all items were below dust threshold, not a failure
                    logger.debug(`[Airdrop] Batch had no sendable items (all dust-filtered)`);
                } else {
                    failedBatches++;
                    failedUsers.push(...batch.map(u => u.user.toString()));
                }
            });

            if (i + PARALLEL_BATCHES < batches.length) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        logEvent('COMMUNITY_SENT', `Community batches complete: ${successfulBatches} succeeded, ${failedBatches} failed, ${(actualCommunityLamportsSent / LAMPORTS_PER_SOL).toFixed(4)} SOL sent`, {
            successfulBatches,
            failedBatches,
            actualSOL: actualCommunityLamportsSent / LAMPORTS_PER_SOL,
            failedUserCount: failedUsers.length,
            totalBatches: batches.length
        });

        // Retry failed batches once before giving up
        if (failedUsers.length > 0 && failedBatches > 0) {
            logger.info(`[Airdrop] Retrying ${failedUsers.length} users from ${failedBatches} failed batches...`);
            await new Promise(r => setTimeout(r, 1000));

            const failedRecipients = distributionPlan.filter(r => failedUsers.includes(r.user.toString()));
            let retrySuccesses = 0;
            const stillFailedUsers = [];

            const retryBatches = [];
            for (let i = 0; i < failedRecipients.length; i += AIRDROP_BATCH_SIZE) {
                retryBatches.push(failedRecipients.slice(i, i + AIRDROP_BATCH_SIZE).map(r => ({
                    user: r.user,
                    amount: r.amount
                })));
            }

            const PARALLEL_RETRIES = 2;
            for (let i = 0; i < retryBatches.length; i += PARALLEL_RETRIES) {
                const parallelGroup = retryBatches.slice(i, i + PARALLEL_RETRIES);

                const results = await Promise.allSettled(
                    parallelGroup.map(batch => sendSolAirdropBatch(batch, deps))
                );

                results.forEach((result, idx) => {
                    const batch = parallelGroup[idx];
                    if (result.status === 'fulfilled' && result.value?.signature) {
                        allSignatures.push(`RETRY:${result.value.signature}`);
                        retrySuccesses++;
                        successfulBatches++;
                        failedBatches--;
                        // v25.112: Track ACTUAL recovered lamports (excludes dust-filtered)
                        actualCommunityLamportsSent += result.value.actualLamports;
                    } else if (result.status === 'fulfilled' && result.value !== null) {
                        // v25.112: Dust-only retry batch - not a failure
                        logger.debug(`[Airdrop] Retry batch had no sendable items (all dust-filtered)`);
                    } else {
                        stillFailedUsers.push(...batch.map(u => u.user.toString()));
                    }
                });

                if (i + PARALLEL_RETRIES < retryBatches.length) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }

            if (retrySuccesses > 0) {
                logger.info(`[Airdrop] Retry recovered ${retrySuccesses} batches`);
            }
            if (stillFailedUsers.length > 0) {
                logger.error(`[Airdrop] PERMANENT FAILURES: ${stillFailedUsers.length} users could not receive airdrop: ${stillFailedUsers.slice(0, 5).join(', ')}${stillFailedUsers.length > 5 ? '...' : ''}`);
                failedUsers.length = 0;
                failedUsers.push(...stillFailedUsers);
            } else {
                failedUsers.length = 0;
            }

            logEvent('RETRY', `Retry complete: ${retrySuccesses} recovered, ${stillFailedUsers.length} permanent failures`, {
                recovered: retrySuccesses,
                permanentFailures: stillFailedUsers.length,
                failedWallets: stillFailedUsers.slice(0, 10)
            });
        }

        // v25.111: Calculate ACTUAL amounts sent (not planned amounts)
        const actualTotalLamportsSent = actualKothLamportsSent + actualCommunityLamportsSent;
        const actualTotalSolSent = actualTotalLamportsSent / LAMPORTS_PER_SOL;
        const actualKothSolSent = actualKothLamportsSent / LAMPORTS_PER_SOL;

        const airdropSucceeded = successfulBatches > 0;

        logger.info(`SOL Airdrop Complete. Success: ${successfulBatches}, Failed: ${failedBatches}, Actual sent: ${actualTotalSolSent.toFixed(4)} SOL (KOTH: ${actualKothSolSent.toFixed(4)}, Community: ${(actualCommunityLamportsSent / LAMPORTS_PER_SOL).toFixed(4)})`);

        // v13.0: Track KOTH holder recipients count (check correct table based on source)
        const kothHoldersTable = kothSource === 'robinhood' ? 'robinhood_token_holders' : 'token_holders';
        const VALID_KOTH_TABLES = ['token_holders', 'robinhood_token_holders'];
        if (!VALID_KOTH_TABLES.includes(kothHoldersTable)) throw new Error(`Invalid holders table: ${kothHoldersTable}`);
        const kothHolderCount = kothToken?.mint ? (await db.get(
            `SELECT COUNT(*) as count FROM ${kothHoldersTable} WHERE mint = $1`,
            [kothToken.mint]
        ))?.count || 0 : 0;

        // v25.113: Finalize airdrop event log
        airdropLog.timing.completedAt = Date.now();
        airdropLog.timing.durationMs = Date.now() - airdropStartTime;
        airdropLog.balances.finalSent = actualTotalSolSent;
        airdropLog.distribution = {
            totalRecipients: (distributionPlan.filter(r => !failedUsers.includes(r.user.toString())).length) + (actualKothLamportsSent > 0 ? kothBatch.length : 0),
            communityRecipients: distributionPlan.filter(r => !failedUsers.includes(r.user.toString())).length,
            kothRecipients: actualKothLamportsSent > 0 ? kothBatch.length : 0,
            topRecipients: distributionPlan
                .filter(r => !failedUsers.includes(r.user.toString()))
                .sort((a, b) => b.amount - a.amount)
                .slice(0, 10)
                .map(r => ({ wallet: r.user.toString().slice(0, 8) + '...' + r.user.toString().slice(-4), sol: r.amount / LAMPORTS_PER_SOL, points: r.points }))
        };
        logEvent('COMPLETED', `Airdrop complete: ${actualTotalSolSent.toFixed(4)} SOL sent to ${airdropLog.distribution.totalRecipients} recipients in ${(airdropLog.timing.durationMs / 1000).toFixed(1)}s`, {
            actualSOL: actualTotalSolSent,
            kothSOL: actualKothSolSent,
            communitySOL: actualCommunityLamportsSent / LAMPORTS_PER_SOL,
            successBatches: successfulBatches,
            failedBatches,
            durationMs: airdropLog.timing.durationMs
        });

        // v25.113: Include full event timeline in details JSON
        const details = JSON.stringify({
            id: airdropId,
            success: successfulBatches,
            failed: failedBatches,
            failedUsers: failedUsers.length > 0 ? failedUsers.slice(0, 20) : [],
            kothWinner: kothToken?.ticker || 'None',
            kothAmount: actualKothSolSent,
            communityAmount: actualCommunityLamportsSent / LAMPORTS_PER_SOL,
            plannedAmount: totalDistributable / LAMPORTS_PER_SOL,
            kothHolders: actualKothLamportsSent > 0 ? kothHolderCount : 0,
            currency: 'SOL',
            airdropSucceeded,
            log: airdropLog
        });

        // v25.111: Use actual recipient count (successful only)
        const successfulCommunityRecipients = distributionPlan.filter(r => !failedUsers.includes(r.user.toString()));
        const totalRecipients = successfulCommunityRecipients.length + (actualKothLamportsSent > 0 ? kothBatch.length : 0);

        // v25.111: Record ACTUAL SOL sent, not planned pool
        await db.run(
            'INSERT INTO airdrop_logs (amount, recipients, "totalPoints", signatures, details, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
            [actualTotalSolSent, totalRecipients, totalPoints, allSignatures.join(','), details, new Date().toISOString()]
        );

        // Log individual user airdrop distributions (only successful ones)
        const airdropTimestamp = Date.now();
        try {
            if (successfulCommunityRecipients.length > 0) {
                const values = successfulCommunityRecipients.map((r, i) => {
                    const base = i * 5;
                    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
                }).join(', ');

                const params = successfulCommunityRecipients.flatMap(r => [
                    r.user.toString(),
                    airdropId,
                    r.amount / LAMPORTS_PER_SOL,
                    r.points,
                    airdropTimestamp
                ]);

                await db.run(
                    `INSERT INTO user_airdrop_history ("userPubkey", "airdropId", amount, points, timestamp) VALUES ${values}`,
                    params
                );
                logger.debug(`[Airdrop] Logged ${successfulCommunityRecipients.length} user distributions to history`);
            }
        } catch (historyErr) {
            logger.warn('[Airdrop] Failed to log user airdrop history', { error: historyErr.message });
        }

        airdropCompleted = airdropSucceeded;

        // Clear status after run
        globalState.conservationStatus = null;

    } catch (e) {
        logger.error("SOL Airdrop Failed", { error: e.message, airdropId });
    } finally {
        // RACE CONDITION FIX: Release mutex
        await release();

        // v25.13: Clear pending airdrop record
        if (airdropId) {
            try {
                await db.run('DELETE FROM stats WHERE key = $1', ['pending_airdrop']);
            } catch (e) {
                logger.debug('[Airdrop] Failed to clear pending record', { error: e.message });
            }
        }

        // v25.13: Only update next airdrop timestamp if airdrop completed successfully
        // This prevents misleading countdowns when airdrop failed
        const airdropInterval = config.AIRDROP_INTERVAL || 900000;
        const nextAirdropTime = Date.now() + airdropInterval;
        try {
            if (airdropCompleted) {
                await db.run('UPDATE stats SET value = $1 WHERE key = $2', [nextAirdropTime, 'nextAirdropTimestamp']);
                logger.debug(`[Flywheel] Next airdrop scheduled for ${new Date(nextAirdropTime).toISOString()}`);
            } else if (airdropId) {
                // Airdrop was attempted but failed - schedule retry sooner (5 minutes)
                const retryTime = Date.now() + 300000;
                await db.run('UPDATE stats SET value = $1 WHERE key = $2', [retryTime, 'nextAirdropTimestamp']);
                logger.warn(`[Flywheel] Airdrop failed - scheduling retry in 5 minutes`);
            }
            // If airdropId is null, airdrop wasn't triggered (threshold not met) - don't update timestamp
        } catch (e) {
            logger.warn('[Flywheel] Failed to update nextAirdropTimestamp', { error: e.message });
        }
    }
}

/**
 * Send a batch of SOL airdrop transfers
 * v11.0 - Simplified: No ATA creation needed, just native SOL transfers
 *
 * @param {Array} batch - Array of {user: PublicKey, amount: number (lamports)}
 * @param {Object} deps - Dependencies including connection and devKeypair
 * @returns {{signature: string, actualLamports: number}|{signature: null, actualLamports: 0}|null}
 *          Object with signature and actual lamports on success,
 *          {signature: null, actualLamports: 0} if all items were dust-filtered (not a failure),
 *          null on actual transaction failure
 */
async function sendSolAirdropBatch(batch, deps) {
    const { connection, devKeypair } = deps;

    try {
        const tx = new Transaction();
        solana.addPriorityFee(tx);

        // Filter valid items and add SOL transfer instructions
        const validItems = [];

        for (const item of batch) {
            try {
                // Validate the pubkey
                const userPubkey = item.user instanceof PublicKey ? item.user : new PublicKey(item.user);

                // Skip if amount is too small (dust)
                if (item.amount < 1000) { // Less than 0.000001 SOL
                    logger.debug(`Skipping dust amount for ${userPubkey.toString()}: ${item.amount} lamports`);
                    continue;
                }

                validItems.push({ user: userPubkey, amount: item.amount });
            } catch (err) {
                logger.warn(`Skipping invalid user in SOL airdrop batch: ${item.user?.toString?.() || 'unknown'}`);
            }
        }

        // v25.112: Return non-null for dust-only batches (not a failure, just nothing to send)
        if (validItems.length === 0) return { signature: null, actualLamports: 0 };

        // Add SOL transfer instructions for each valid recipient
        for (const item of validItems) {
            tx.add(SystemProgram.transfer({
                fromPubkey: devKeypair.publicKey,
                toPubkey: item.user,
                lamports: item.amount
            }));
        }

        const sig = await solana.sendTxWithRetry(tx, [devKeypair]);
        // v25.112: Return actual lamports sent (only valid items, excludes dust-filtered)
        const actualLamports = validItems.reduce((sum, item) => sum + item.amount, 0);
        return { signature: sig, actualLamports };
    } catch (e) {
        logger.error(`SOL Airdrop batch failed (${validItems?.length || batch.length} transfers)`, { error: e.message });
        return null;
    }
}

/**
 * Run the main flywheel cycle
 *
 * v11.0 - Simplified: No ATA cost calculations needed for SOL airdrops
 * The flywheel now collects fees, distributes to fee wallets, and triggers
 * SOL airdrops when balance exceeds threshold
 */
async function runPurchaseAndFees(deps) {
    const { connection, devKeypair, db, globalState, recordClaim, updateNextCheckTime, logPurchase } = deps;

    // RACE CONDITION FIX: Use mutex for atomic locking
    const release = await buybackMutex.tryAcquire();
    if (!release) {
        logger.info('[Flywheel] Skipping - already in progress');
        return;
    }

    let logData = {
        status: 'SKIPPED',
        reason: 'Unknown',
        feesCollected: 0,
        robinhoodFeesCollected: 0,
        solSpent: 0,
        transfer9_5: 0,
        transfer0_5: 0
    };

    try {
        const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(devKeypair.publicKey);
        let totalPendingFees = new BN(0);

        try {
            const bcInfo = await connection.getAccountInfo(bcVault);
            if (bcInfo) totalPendingFees = totalPendingFees.add(new BN(bcInfo.lamports));
        } catch (e) {
            logger.debug('Failed to fetch BC fees', { error: e.message });
        }

        try {
            const ammVaultAtaKey = await ammVaultAta;
            const bal = await connection.getTokenAccountBalance(ammVaultAtaKey);
            if (bal.value.amount) totalPendingFees = totalPendingFees.add(new BN(bal.value.amount));
        } catch (e) {
            logger.debug('Failed to fetch AMM fees', { error: e.message });
        }

        logData.feesCollected = totalPendingFees.toNumber() / LAMPORTS_PER_SOL;

        const threshold = new BN(config.FEE_THRESHOLD_SOL * LAMPORTS_PER_SOL);
        let claimedAmount = 0;

        if (totalPendingFees.gte(threshold)) {
            logger.info("Claiming fees...");
            claimedAmount = await claimCreatorFees(deps);

            if (claimedAmount > 0) {
                await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [claimedAmount, 'lifetimeCreatorFeesLamports']);
                await recordClaim(claimedAmount);

                // v27.0: Attribute 95% of platform fees: 50% to per-token holder pools (by volume), 50% to central pool
                try {
                    const totalRewardCredit = Math.floor(claimedAmount * 0.95);
                    const perTokenCredit = Math.floor(totalRewardCredit * CREATOR_REWARD_HOLDER_SPLIT);
                    const centralCredit = totalRewardCredit - perTokenCredit;

                    const eligiblePlatformTokens = await db.all(
                        'SELECT mint, volume24h FROM tokens WHERE volume24h >= $1',
                        [100]
                    );
                    const totalPlatformVol = eligiblePlatformTokens.reduce((s, t) => s + (parseFloat(t.volume24h) || 0), 0);
                    if (totalPlatformVol > 0 && eligiblePlatformTokens.length > 0) {
                        let totalAttributed = 0;
                        const shares = eligiblePlatformTokens.map(tok => {
                            const share = Math.floor(perTokenCredit * ((parseFloat(tok.volume24h) || 0) / totalPlatformVol));
                            totalAttributed += share;
                            return { tok, share };
                        });
                        // Add rounding remainder to the highest-volume token
                        const remainder = perTokenCredit - totalAttributed;
                        if (remainder > 0 && shares.length > 0) {
                            shares[0].share += remainder;
                        }
                        for (const { tok, share } of shares) {
                            if (share > 0) {
                                await db.run(
                                    'UPDATE tokens SET pending_airdrop_lamports = pending_airdrop_lamports + $1 WHERE mint = $2',
                                    [share, tok.mint]
                                );
                            }
                        }
                    } else if (perTokenCredit > 0) {
                        // No eligible platform tokens to distribute to — redirect to central pool to avoid losing funds
                        await addToCentralPool(db, perTokenCredit);
                        logger.info(`[FeeCollection] No eligible platform tokens — redirected ${(perTokenCredit / LAMPORTS_PER_SOL).toFixed(4)} SOL per-token credit to central pool`);
                    }
                    if (centralCredit > 0) {
                        await addToCentralPool(db, centralCredit);
                    }
                    logger.info(`[FeeCollection] Attributed ${(totalRewardCredit / LAMPORTS_PER_SOL).toFixed(4)} SOL platform fees: ${(perTokenCredit / LAMPORTS_PER_SOL).toFixed(4)} to per-token pools, ${(centralCredit / LAMPORTS_PER_SOL).toFixed(4)} to central pool`);
                } catch (attrErr) {
                    logger.warn('[FeeCollection] Platform fee attribution failed', { error: attrErr.message });
                }
            }
            await new Promise(r => setTimeout(r, 2000));
        } else {
            logData.reason = `Threshold not met`;
        }

        // v12.0: Claim fees from Robinhood tokens (external tokens sharing fees with us)
        try {
            const { totalClaimed: robinhoodClaimed, claimedTokens } = await claimRobinhoodFees(deps);
            if (robinhoodClaimed > 0) {
                logger.info(`[Robinhood] Total claimed: ${(robinhoodClaimed / LAMPORTS_PER_SOL).toFixed(6)} SOL from ${claimedTokens.length} tokens`);
                logData.robinhoodFeesCollected = robinhoodClaimed / LAMPORTS_PER_SOL;
                claimedAmount += robinhoodClaimed;

                // Track lifetime Robinhood fees
                await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [robinhoodClaimed, 'lifetimeRobinhoodFeesLamports']);
            }
        } catch (e) {
            logger.debug('[Robinhood] Fee claiming skipped', { error: e.message });
        }

        const realBalance = await connection.getBalance(devKeypair.publicKey);

        // v11.0: Simplified airdrop status for SOL airdrops (no ATA costs)
        // v13.0: Fetch from Redis for cross-process consistency
        // v25.78: Safety reserve is 0.1 SOL for operations
        const SAFETY_RESERVE = 0.1 * LAMPORTS_PER_SOL;
        const MIN_AIRDROP_POOL = 0.1 * LAMPORTS_PER_SOL;
        const currentUserPointsMap = await redis.getAllUserPoints();
        const eligibleUsers = Array.from(currentUserPointsMap.keys());
        const availableForAirdrop = realBalance - SAFETY_RESERVE;

        // Update conservation status (simplified - no ATA calculations)
        globalState.conservationStatus = {
            eligibleCount: eligibleUsers.length,
            missingAtas: 0, // Not applicable for SOL airdrops
            estimatedCost: SAFETY_RESERVE / LAMPORTS_PER_SOL,
            currentSol: realBalance / LAMPORTS_PER_SOL,
            availableForAirdrop: availableForAirdrop / LAMPORTS_PER_SOL,
            isConserving: false, // Never conserving for SOL airdrops (no ATA rent)
            currency: 'SOL'
        };

        // Fee distribution when we have claimed fees
        if (claimedAmount > 0) {
            const spendable = claimedAmount;
            const MIN_SPEND = 0.02 * LAMPORTS_PER_SOL;

            if (spendable > MIN_SPEND) {
                // Distribution: 95% goes to airdrop pool, 4.5% ASDF Fee, 0.5% Upkeep
                const transfer9_5 = Math.floor(spendable * 0.045);
                const transfer0_5 = Math.floor(spendable * 0.005);
                // Remaining 95% stays in wallet for SOL airdrops

                logData.solSpent = (transfer9_5 + transfer0_5) / LAMPORTS_PER_SOL;
                logData.transfer9_5 = transfer9_5 / LAMPORTS_PER_SOL;
                logData.transfer0_5 = transfer0_5 / LAMPORTS_PER_SOL;

                // Fee distribution
                const feeTx = new Transaction();
                solana.addPriorityFee(feeTx);
                feeTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_95, lamports: transfer9_5 }));
                feeTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_05, lamports: transfer0_5 }));
                await solana.sendTxWithRetry(feeTx, [devKeypair]);
                logger.info("Fees Distributed (5% to wallets, 95% retained for SOL airdrop pool)");
                logData.status = 'SUCCESS';
                logData.reason = 'Fees Distributed';
            } else {
                logData.status = 'LOW_SPEND_SKIP';
                logData.reason = 'Claimed amount too small';
            }
        }

        // v26.0: Per-token airdrop distribution (replaces global processAirdrop)
        await processTokenAirdrops(deps);
        await logPurchase('FLYWHEEL_CYCLE', logData);

    } catch (e) {
        logData.status = 'CRITICAL_ERROR';
        logData.reason = e.message;
        await logPurchase('FLYWHEEL_CYCLE', logData);
        logger.error("CRITICAL FLYWHEEL ERROR", { message: e.message });
    } finally {
        // RACE CONDITION FIX: Release mutex
        await release();
        await updateNextCheckTime();
    }
}

/**
 * Run fee collection only (called every 1 minute)
 * v17.0: Separated from airdrop processing for more frequent fee collection
 * v25.4: Added logging to frontend logs for visibility
 */
async function runFeeCollection(deps) {
    const { connection, devKeypair, db, globalState, logPurchase } = deps;

    // RACE CONDITION FIX: Use mutex for atomic locking
    const release = await buybackMutex.tryAcquire();
    if (!release) {
        logger.debug('[FeeCollection] Skipping - already in progress');
        return;
    }

    try {
        const { bcVault, ammVaultAuth, ammVaultAta } = pump.getCreatorFeeVaults(devKeypair.publicKey);

        // Check pending platform fees (both BC and AMM)
        let platformPendingFees = new BN(0);
        try {
            const bcInfo = await connection.getAccountInfo(bcVault);
            if (bcInfo) platformPendingFees = platformPendingFees.add(new BN(bcInfo.lamports));
        } catch (e) {
            // v25.14 ROBUSTNESS: Log RPC errors instead of silently ignoring
            logger.debug('[FeeCollection] BC vault check failed', { error: e.message });
        }

        try {
            const ammVaultAtaKey = await ammVaultAta;
            const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
            platformPendingFees = platformPendingFees.add(new BN(bal.value.amount));
        } catch (e) {
            // v25.14 ROBUSTNESS: Log RPC errors instead of silently ignoring
            logger.debug('[FeeCollection] AMM vault check failed', { error: e.message });
        }

        // v25.79: Check Robinhood token pending fees for threshold calculation (BC + AMM)
        // CRITICAL: For fee sharing tokens, BOTH vaults are derived from feeVaultAddress
        let robinhoodPendingFees = new BN(0);
        try {
            const robinhoodTokens = await db.all('SELECT mint, ticker, "creatorPubkey", "feeShareBps", "feeVaultAddress" FROM robinhood_tokens WHERE "isActive" = 1 LIMIT 100');
            logger.info(`[FeeCollection] Found ${robinhoodTokens.length} active Robinhood tokens to check`);
            for (const token of robinhoodTokens) {
                try {
                    // v25.79: CRITICAL FIX - For fee sharing tokens, BOTH BC and AMM vaults
                    // are derived from feeVaultAddress. AMM pool stores coinCreator as creator.
                    let bcVaultAddr;
                    let ammVaultAta;

                    if (token.feeVaultAddress) {
                        // FEE program token - BC vault is PUMP creator-vault PDA (where fees accumulate)
                        // Must match claimRobinhoodFees which uses pumpBcVault from creatorPubkey
                        const creatorPubkey = new PublicKey(token.creatorPubkey);
                        const creatorVaults = pump.getShareholderFeeVaults(creatorPubkey);
                        bcVaultAddr = creatorVaults.bcVault;
                        // AMM vaults derived from feeVaultAddress (matches AMM pool.coin_creator)
                        const feeVaultPubkey = new PublicKey(token.feeVaultAddress);
                        const feeVaults = pump.getShareholderFeeVaults(feeVaultPubkey);
                        ammVaultAta = feeVaults.ammVaultAta;
                    } else {
                        // PUMP program token - derive from creatorPubkey
                        const creatorPubkey = new PublicKey(token.creatorPubkey);
                        const vaults = pump.getShareholderFeeVaults(creatorPubkey);
                        bcVaultAddr = vaults.bcVault;
                        ammVaultAta = vaults.ammVaultAta;
                    }

                    // Check BOTH BC and AMM vaults
                    const rentMin = 5000; // Small buffer for pending fee calculation
                    let tokenBcFees = 0;
                    let tokenAmmFees = 0;

                    // Check BC vault
                    const bcInfo = await connection.getAccountInfo(bcVaultAddr);
                    if (bcInfo && bcInfo.lamports > rentMin) {
                        const pendingLamports = bcInfo.lamports - rentMin;
                        tokenBcFees = Math.floor(pendingLamports * ((token.feeShareBps ?? 10000) / 10000));
                    }

                    // Check AMM vault (for graduated tokens)
                    try {
                        const ammVaultAtaKey = await ammVaultAta;
                        const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                        const ammBalance = parseInt(bal.value.amount) || 0;
                        if (ammBalance > 0) {
                            tokenAmmFees = Math.floor(ammBalance * ((token.feeShareBps ?? 10000) / 10000));
                        }
                    } catch (e) {
                        // AMM vault may not exist for non-graduated tokens
                    }

                    const tokenTotalFees = tokenBcFees + tokenAmmFees;
                    if (tokenTotalFees > 0) {
                        robinhoodPendingFees = robinhoodPendingFees.add(new BN(tokenTotalFees));
                        logger.info(`[FeeCollection] ${token.ticker}: ${(tokenTotalFees / LAMPORTS_PER_SOL).toFixed(4)} SOL pending (BC: ${(tokenBcFees / LAMPORTS_PER_SOL).toFixed(4)}, AMM: ${(tokenAmmFees / LAMPORTS_PER_SOL).toFixed(4)}) @ ${(token.feeShareBps ?? 10000) / 100}%`);
                    }
                } catch (e) {
                    logger.debug(`[FeeCollection] ${token.ticker}: Error checking pending fees - ${e.message}`);
                }
            }
            logger.info(`[FeeCollection] Robinhood pending fees total: ${(robinhoodPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${robinhoodTokens.length} tokens`);
        } catch (e) {
            logger.debug('[FeeCollection] Robinhood pending fees check failed', { error: e.message });
        }

        // v25.76: Total pending = platform + robinhood (for threshold check)
        // v25.77: Also log platform pending for visibility
        logger.info(`[FeeCollection] Platform pending fees: ${(platformPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        const totalPendingFees = platformPendingFees.add(robinhoodPendingFees);
        logger.info(`[FeeCollection] Total pending fees: ${(totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL (platform: ${(platformPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} + robinhood: ${(robinhoodPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)})`);

        // v17.0: Fee threshold is 0.05 SOL
        const threshold = new BN((config.FEE_THRESHOLD_SOL || 0.05) * LAMPORTS_PER_SOL);

        if (totalPendingFees.gte(threshold)) {
            logger.info(`[FeeCollection] Claiming ${(totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL in fees (platform: ${(platformPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)}, robinhood: ${(robinhoodPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)})...`);

            let claimedAmount = await claimCreatorFees(deps);

            if (claimedAmount > 0) {
                await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [claimedAmount, 'lifetimeCreatorFeesLamports']);
                logger.info(`[FeeCollection] Claimed ${(claimedAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL from creator fees`);

                // v27.0: Attribute 95% of platform fees: 50% to per-token holder pools (by volume), 50% to central pool
                try {
                    const totalRewardCredit = Math.floor(claimedAmount * 0.95);
                    const perTokenCredit = Math.floor(totalRewardCredit * CREATOR_REWARD_HOLDER_SPLIT);
                    const centralCredit = totalRewardCredit - perTokenCredit;

                    const eligiblePlatformTokens = await db.all(
                        'SELECT mint, volume24h FROM tokens WHERE volume24h >= $1',
                        [100]
                    );
                    const totalPlatformVol = eligiblePlatformTokens.reduce((s, t) => s + (parseFloat(t.volume24h) || 0), 0);
                    if (totalPlatformVol > 0 && eligiblePlatformTokens.length > 0) {
                        let totalAttributed = 0;
                        const shares = eligiblePlatformTokens.map(tok => {
                            const share = Math.floor(perTokenCredit * ((parseFloat(tok.volume24h) || 0) / totalPlatformVol));
                            totalAttributed += share;
                            return { tok, share };
                        });
                        const remainder = perTokenCredit - totalAttributed;
                        if (remainder > 0 && shares.length > 0) {
                            shares[0].share += remainder;
                        }
                        for (const { tok, share } of shares) {
                            if (share > 0) {
                                await db.run(
                                    'UPDATE tokens SET pending_airdrop_lamports = pending_airdrop_lamports + $1 WHERE mint = $2',
                                    [share, tok.mint]
                                );
                            }
                        }
                    } else if (perTokenCredit > 0) {
                        // No eligible platform tokens to distribute to — redirect to central pool to avoid losing funds
                        await addToCentralPool(db, perTokenCredit);
                        logger.info(`[FeeCollection] No eligible platform tokens — redirected ${(perTokenCredit / LAMPORTS_PER_SOL).toFixed(4)} SOL per-token credit to central pool`);
                    }
                    if (centralCredit > 0) {
                        await addToCentralPool(db, centralCredit);
                    }
                    logger.info(`[FeeCollection] Attributed ${(totalRewardCredit / LAMPORTS_PER_SOL).toFixed(4)} SOL platform fees: ${(perTokenCredit / LAMPORTS_PER_SOL).toFixed(4)} to per-token pools, ${(centralCredit / LAMPORTS_PER_SOL).toFixed(4)} to central pool`);
                } catch (attrErr) {
                    logger.warn('[FeeCollection] Platform fee attribution failed', { error: attrErr.message });
                }
            }
            await new Promise(r => setTimeout(r, 1000));

            // Also claim Robinhood fees
            try {
                const { totalClaimed: robinhoodClaimed, claimedTokens } = await claimRobinhoodFees(deps);
                if (robinhoodClaimed > 0) {
                    logger.info(`[FeeCollection] Claimed ${(robinhoodClaimed / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${claimedTokens.length} Robinhood tokens`);
                    await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [robinhoodClaimed, 'lifetimeRobinhoodFeesLamports']);
                    claimedAmount += robinhoodClaimed;
                }
            } catch (e) {
                logger.debug('[FeeCollection] Robinhood fee claiming skipped', { error: e.message });
            }

            // v25.51: Also collect PAGS fees from Pump.fun vaults
            try {
                const pagsResult = await pagsFeeScanner.collectAllFees();
                if (pagsResult.totalClaimed > 0) {
                    logger.info(`[FeeCollection] Claimed ${pagsResult.totalClaimed.toFixed(4)} SOL from ${pagsResult.claimedCount} PAGS tokens`);
                    await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [pagsResult.totalClaimed * LAMPORTS_PER_SOL, 'lifetimePagsFeesLamports']);
                }
            } catch (e) {
                logger.debug('[FeeCollection] PAGS fee collection skipped', { error: e.message });
            }

            // Distribute platform fees (5% to fee wallets)
            if (claimedAmount > 0) {
                const MIN_SPEND = 0.01 * LAMPORTS_PER_SOL;
                if (claimedAmount > MIN_SPEND) {
                    const transfer9_5 = Math.floor(claimedAmount * 0.045);
                    const transfer0_5 = Math.floor(claimedAmount * 0.005);

                    const feeTx = new Transaction();
                    solana.addPriorityFee(feeTx);
                    feeTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_95, lamports: transfer9_5 }));
                    feeTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_05, lamports: transfer0_5 }));
                    await solana.sendTxWithRetry(feeTx, [devKeypair]);
                    logger.info(`[FeeCollection] Distributed ${((transfer9_5 + transfer0_5) / LAMPORTS_PER_SOL).toFixed(4)} SOL to platform (5%)`);
                }

                // v25.4: Log to frontend
                // v25.115: Enhanced with full breakdown
                if (logPurchase) {
                    await logPurchase('FEE_CLAIM', {
                        status: 'SUCCESS',
                        feesClaimedSol: (claimedAmount / LAMPORTS_PER_SOL).toFixed(4),
                        platformFeeSol: ((claimedAmount * 0.05) / LAMPORTS_PER_SOL).toFixed(4),
                        pendingBeforeClaimSol: (totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                        platformPendingSol: (platformPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                        robinhoodPendingSol: (robinhoodPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                        thresholdSol: (config.FEE_THRESHOLD_SOL || 0.05).toFixed(2)
                    });
                }
            }
        } else {
            // v25.77: Log with breakdown of platform vs robinhood
            logger.info(`[FeeCollection] Below threshold: ${(totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL pending (platform: ${(platformPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} + robinhood: ${(robinhoodPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)}), need ${config.FEE_THRESHOLD_SOL || 0.05} SOL`);
            // v25.115: Always log fee check to frontend (even at 0 pending)
            if (logPurchase) {
                await logPurchase('FEE_CHECK', {
                    status: 'BELOW_THRESHOLD',
                    pendingSol: (totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                    platformPendingSol: (platformPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                    robinhoodPendingSol: (robinhoodPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                    thresholdSol: (config.FEE_THRESHOLD_SOL || 0.05).toFixed(2),
                    progressPercent: Math.min(100, Math.round((totalPendingFees.toNumber() / threshold.toNumber()) * 100)),
                    reason: totalPendingFees.toNumber() === 0 ? 'No pending fees' : 'Below threshold'
                });
            }
        }
    } catch (e) {
        logger.error('[FeeCollection] Error', { error: e.message });
        // v25.12: Log errors to frontend
        if (logPurchase) {
            await logPurchase('FEE_CHECK', {
                status: 'ERROR',
                reason: e.message
            }).catch(() => {}); // Don't throw if logging fails
        }
    } finally {
        await release();
        // v25.4: Update next check time for frontend countdown
        if (deps.updateNextCheckTime) {
            await deps.updateNextCheckTime();
        }
    }
}

/**
 * Start the flywheel intervals
 * v17.0: Separate intervals for fee collection (1 min) and airdrop (15 min)
 * v25.29: Initialize nextAirdropTimestamp on startup for accurate frontend countdown
 */
async function start(deps) {
    const { db } = deps;

    // v25.29: Initialize nextAirdropTimestamp on startup
    // This ensures frontend countdown is accurate even after server restart
    const airdropInterval = config.AIRDROP_INTERVAL || 900000;
    const nextAirdropTime = Date.now() + airdropInterval;
    try {
        // Check if timestamp exists and is in the past
        const existing = await db.get('SELECT value FROM stats WHERE key = $1', ['nextAirdropTimestamp']);
        const existingTime = existing?.value ? parseInt(existing.value) : 0;

        if (!existingTime || existingTime < Date.now()) {
            // Initialize or reset expired timestamp
            await db.run(
                'INSERT INTO stats (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
                ['nextAirdropTimestamp', nextAirdropTime]
            );
            logger.info(`[Flywheel] Initialized nextAirdropTimestamp: ${new Date(nextAirdropTime).toISOString()}`);
        } else {
            logger.info(`[Flywheel] Using existing nextAirdropTimestamp: ${new Date(existingTime).toISOString()}`);
        }
    } catch (e) {
        logger.warn('[Flywheel] Failed to initialize nextAirdropTimestamp', { error: e.message });
    }

    // v25.51: Initialize PAGS fee scanner
    // v25.113: Awaited to allow DB cache hydration for external claim detection
    try {
        const pags = require('../services/pags');
        await pagsFeeScanner.init({
            db: deps.db,
            connection: deps.connection,
            pagsKeypair: deps.pagsKeypair,
            devKeypair: deps.devKeypair,
            solana,
            pags
        });
    } catch (e) {
        logger.warn('[Flywheel] PAGS fee scanner init failed', { error: e.message });
    }

    // Fee collection every 1 minute
    const feeInterval = config.FEE_COLLECTION_INTERVAL || 60000;
    setInterval(() => runFeeCollection(deps), feeInterval);
    logger.info(`Fee collection started (${feeInterval / 1000}s interval, >${config.FEE_THRESHOLD_SOL || 0.05} SOL threshold)`);

    // v26.0: Per-token airdrop processing every 15 minutes
    setInterval(() => processTokenAirdrops(deps), airdropInterval);
    logger.info(`Per-token airdrop distribution started (${airdropInterval / 60000}min interval, >${process.env.TOKEN_AIRDROP_THRESHOLD_SOL || 0.05} SOL threshold per token)`);

    // v25.64: Staggered initial runs to avoid RPC spike at startup
    setTimeout(() => runFeeCollection(deps), 30000); // Fee collection at 30s (was 5s)
    setTimeout(() => processTokenAirdrops(deps), 120000); // Airdrop at 2min (was 10s)

    // Run KOTH evaluation early so Redis has a valid selection before holderScanner first reads it.
    // Without this, the first ~30 minutes after startup would have no KOTH and Robinhood tokens
    // would be excluded from KOTH during that window.
    setTimeout(() => evaluateKothCandidates(db).catch(e => logger.warn('[KOTH] Startup evaluation failed', { error: e.message })), 10000);
}

module.exports = { claimCreatorFees, claimRobinhoodFees, processAirdrop, processTokenAirdrops, sendSolAirdropBatch, runPurchaseAndFees, runFeeCollection, refreshAllFeeShares, start, getAiSelectedKoth, resetKothCache };
