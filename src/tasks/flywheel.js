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
const { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const config = require('../config/env');
const { WALLETS } = require('../config/constants');
const { logger, solana, jupiter, redis, mutex, claudeKoth, twitter } = require('../services');
const { payableSet } = require('../services/recipientFilter');

// RACE CONDITION FIX: Use mutex for atomic lock/unlock instead of boolean flags
const buybackMutex = mutex.getMutex('flywheel_buyback');
const airdropMutex = mutex.getMutex('flywheel_airdrop');

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
        // Get all eligible platform tokens with their metrics
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
            )
            ORDER BY "marketCap" DESC
            LIMIT 50
        `, [KOTH_MIN_MARKET_CAP, KOTH_MIN_VOLUME, KOTH_MIN_HOLDERS]);

        logger.info(`[KOTH] Candidates found: ${candidates.length}`);

        if (candidates.length === 0) {
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

        const sourceLabel = '🚀 Platform';
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
const TOKEN_AIRDROP_THRESHOLD_LAMPORTS = Math.round(config.TOKEN_AIRDROP_THRESHOLD_SOL * 1e9);

// v26.0: Fixed 1B token supply for all pump.fun tokens (1B * 10^6 decimals)
const PUMP_FUN_TOTAL_SUPPLY_BIG = BigInt('1000000000000000');

// v26.0: Minimum per-recipient airdrop (0.01 SOL). Recipients below this are skipped.
const MIN_RECIPIENT_LAMPORTS = Math.floor(0.01 * 1e9); // 10_000_000 lamports

// v28.0 FEE SPLIT: every claimed lamport is divided four ways. These are fractions of the
// GROSS claimed amount and sum to exactly 1.0.
//
// Supersedes the v27.0 scheme, which took 95% as "rewards" and split that 50/50 between
// per-token holders and the central pool (so 47.5% each), transferring the remaining 5% to
// the platform wallets as 4.5% + 0.5%.
//
// Headline: 50% holders / 25% central pool / 25% platform, where the platform quarter is
// 24.5% buyback-burn + 0.5% upkeep.
const FEE_SPLIT = {
    holders:     0.50,   // credited to the originating token's pending_airdrop_lamports
    centralPool: 0.25,   // credited to the cross-token central pool
    buybackBurn: 0.245,  // swept on-chain to WALLETS.BUYBACK_BURN
    upkeep:      0.005,  // swept on-chain to WALLETS.FEE_05
};

/**
 * Split a claimed fee amount four ways using exact integer arithmetic.
 *
 * Every share is floored and the rounding remainder is given to holders, so the four parts
 * always sum to exactly `lamports` -- no lamport is created or destroyed by the split. This
 * matters because the holder and central-pool shares are *accounting* credits while the
 * buyback-burn and upkeep shares are later moved on-chain: if the parts summed to more than
 * the input, the platform would eventually try to transfer SOL it never claimed.
 *
 * @param {number} lamports - Gross claimed amount
 * @returns {{holders:number, centralPool:number, buybackBurn:number, upkeep:number}}
 */
function splitClaimedFees(lamports) {
    const gross = Math.floor(Number(lamports) || 0);
    if (gross <= 0) return { holders: 0, centralPool: 0, buybackBurn: 0, upkeep: 0 };

    const centralPool = Math.floor(gross * FEE_SPLIT.centralPool);
    const buybackBurn = Math.floor(gross * FEE_SPLIT.buybackBurn);
    const upkeep      = Math.floor(gross * FEE_SPLIT.upkeep);
    // Holders absorb the remainder so the four parts reconcile exactly to `gross`.
    const holders     = gross - centralPool - buybackBurn - upkeep;

    return { holders, centralPool, buybackBurn, upkeep };
}

// Minimum central pool balance before triggering a distribution
const CENTRAL_POOL_THRESHOLD_LAMPORTS = Math.round(5.0 * 1e9); // 5 SOL

// v28.0: Eligibility threshold for receiving fee attribution and central-pool shares.
// This file previously hardcoded $100 in four queries while holderScanner used the
// configured AIRDROP_MIN_VOLUME_USD (raised to $250 in v27.5), so tokens between the two
// figures were credited with pool balances that the distributor would never pay out --
// the lamports just accumulated against a token that could never clear the volume gate.
const MIN_VOLUME_USD = config.AIRDROP_MIN_VOLUME_USD || 100;

// v28.0: Minimum accrued platform cut (buyback-burn + upkeep) before sweeping it on-chain.
// Sweeping in batches keeps transaction fees from eating small claims.
const PLATFORM_SWEEP_THRESHOLD_LAMPORTS = Math.round(0.05 * 1e9); // 0.05 SOL

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
        // v28.2: db.run returns { changes, lastID }, never rowCount — so this guard compared
        // undefined === 0 and could not fire. A missing stats row silently dropped the credit.
        if (result?.changes === 0) {
            logger.error(`[CentralPool] addToCentralPool: stats row not found — ${lamports} lamports NOT credited`);
        }
    } catch (e) {
        logger.error(`[CentralPool] addToCentralPool failed — ${lamports} lamports NOT credited`, { error: e.message });
        throw e; // re-throw so caller can handle
    }
}

/**
 * v28.0: Atomically accrue the platform's cut of a claim.
 *
 * The buyback-burn and upkeep shares are *not* transferred at claim time. Previously the
 * 4.5%/0.5% transfer fired only once per platform claim, so part of the platform cut simply
 * accumulated in the dev wallet with nothing
 * tracking it. Accruing here instead means every claim path contributes identically, and a
 * single periodic sweep moves the total out -- one transaction rather than one per claim.
 */
async function accruePlatformFees(db, { buybackBurn = 0, upkeep = 0 }) {
    const credit = async (key, lamports) => {
        if (lamports <= 0) return;
        try {
            // Upsert: these keys are seeded in createSchema, but an older database that
            // predates them would otherwise silently match zero rows and lose the accrual.
            await db.run(
                `INSERT INTO stats (key, value) VALUES ($2, $1)
                 ON CONFLICT (key) DO UPDATE SET value = stats.value + $1`,
                [lamports, key]
            );
        } catch (e) {
            logger.error(`[PlatformFees] Failed to accrue ${lamports} lamports to ${key}`, { error: e.message });
            throw e;
        }
    };
    await credit('pendingBuybackBurnLamports', buybackBurn);
    await credit('pendingUpkeepLamports', upkeep);
}

/**
 * v28.0: Sweep the accrued platform cut on-chain.
 *
 * Uses the same reserve-before-send ordering as the airdrop paths: the pending counters are
 * decremented first, in one transaction, and credited back if the transfer fails. A crash
 * between the decrement and the transfer therefore under-pays the platform -- recoverable on
 * the next claim -- rather than paying it twice, which is not.
 */
async function processPlatformFeeSweep(deps) {
    const { devKeypair, db } = deps;

    let pendingBurn = 0;
    let pendingUpkeep = 0;
    try {
        const rows = await db.all(
            "SELECT key, value FROM stats WHERE key IN ('pendingBuybackBurnLamports','pendingUpkeepLamports')"
        );
        for (const r of rows) {
            if (r.key === 'pendingBuybackBurnLamports') pendingBurn = Math.floor(Number(r.value) || 0);
            if (r.key === 'pendingUpkeepLamports') pendingUpkeep = Math.floor(Number(r.value) || 0);
        }
    } catch (e) {
        logger.warn('[PlatformFees] Could not read pending platform fees', { error: e.message });
        return;
    }

    const total = pendingBurn + pendingUpkeep;
    if (total < PLATFORM_SWEEP_THRESHOLD_LAMPORTS) return;

    // Never try to send more than the wallet actually holds.
    try {
        const balance = await deps.connection.getBalance(devKeypair.publicKey);
        const SAFETY_RESERVE = Math.round(0.05 * LAMPORTS_PER_SOL);
        if (balance - SAFETY_RESERVE < total) {
            logger.warn('[PlatformFees] Wallet balance below accrued platform cut, deferring sweep', {
                balanceSol: balance / LAMPORTS_PER_SOL,
                accruedSol: total / LAMPORTS_PER_SOL
            });
            return;
        }
    } catch (e) {
        logger.warn('[PlatformFees] Balance check failed, deferring sweep', { error: e.message });
        return;
    }

    // Reserve: zero the counters before sending anything.
    try {
        await db.transaction(async (tx) => {
            const r1 = await tx.run(
                "UPDATE stats SET value = value - $1 WHERE key = 'pendingBuybackBurnLamports' AND value >= $1",
                [pendingBurn]
            );
            if (pendingBurn > 0 && r1.changes === 0) throw new Error('buyback-burn accrual changed mid-sweep');
            const r2 = await tx.run(
                "UPDATE stats SET value = value - $1 WHERE key = 'pendingUpkeepLamports' AND value >= $1",
                [pendingUpkeep]
            );
            if (pendingUpkeep > 0 && r2.changes === 0) throw new Error('upkeep accrual changed mid-sweep');
        });
    } catch (e) {
        logger.warn('[PlatformFees] Could not reserve platform cut, skipping sweep', { error: e.message });
        return;
    }

    try {
        const feeTx = new Transaction();
        solana.addPriorityFee(feeTx, { units: 10_000 }); // two transfers
        if (pendingBurn > 0) {
            feeTx.add(SystemProgram.transfer({
                fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.BUYBACK_BURN, lamports: pendingBurn
            }));
        }
        if (pendingUpkeep > 0) {
            feeTx.add(SystemProgram.transfer({
                fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_05, lamports: pendingUpkeep
            }));
        }
        feeTx.feePayer = devKeypair.publicKey;
        const sig = await solana.sendTxWithRetry(feeTx, [devKeypair]);

        await db.run(
            `INSERT INTO stats (key, value) VALUES ($2, $1)
             ON CONFLICT (key) DO UPDATE SET value = stats.value + $1`,
            [pendingBurn, 'lifetimeBuybackBurnLamports']
        ).catch(() => {});
        await db.run(
            `INSERT INTO stats (key, value) VALUES ($2, $1)
             ON CONFLICT (key) DO UPDATE SET value = stats.value + $1`,
            [pendingUpkeep, 'lifetimeUpkeepLamports']
        ).catch(() => {});

        logger.info(`[PlatformFees] Swept ${(total / LAMPORTS_PER_SOL).toFixed(4)} SOL platform cut`, {
            buybackBurnSol: pendingBurn / LAMPORTS_PER_SOL,
            upkeepSol: pendingUpkeep / LAMPORTS_PER_SOL,
            buybackBurnWallet: WALLETS.BUYBACK_BURN.toString(),
            signature: sig
        });
    } catch (e) {
        // Transfer failed: put the accrual back so the next sweep retries it.
        logger.error('[PlatformFees] Sweep transfer failed, restoring accrual', { error: e.message });
        await accruePlatformFees(db, { buybackBurn: pendingBurn, upkeep: pendingUpkeep }).catch((restoreErr) => {
            logger.error('[PlatformFees] CRITICAL: could not restore accrual after failed sweep', {
                buybackBurn: pendingBurn, upkeep: pendingUpkeep, error: restoreErr.message
            });
        });
    }
}

/**
 * v26.0: Per-token airdrop distribution
 *
 * Replaces the global pool system. Each token has its own
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

        // Collect all tokens with pools above threshold
        const VALID_TABLES = { platform: { tokens: 'tokens', holders: 'token_holders' } };

        const platformTokensToAirdrop = await db.all(
            'SELECT mint, ticker, pending_airdrop_lamports FROM tokens WHERE pending_airdrop_lamports >= $1',
            [TOKEN_AIRDROP_THRESHOLD_LAMPORTS]
        );

        // Refresh holder data before distribution. v30.2: the tokens about to be paid are
        // force-rescanned whatever the scanner's throttles say, and a scan already in flight is
        // waited for rather than skipped -- payouts should not run on stale holder lists.
        try {
            const refreshResult = await holderScanner.updateGlobalState(deps, {
                forceMints: platformTokensToAirdrop.map(t => t.mint),
                wait: true,
            });
            if (refreshResult?.scanCompleted) {
                logger.info('[TokenAirdrop] Holder data refreshed successfully');
            } else if (refreshResult?.skipped) {
                logger.warn('[TokenAirdrop] Holder scan unavailable — using cached data');
            }
        } catch (holderErr) {
            logger.warn('[TokenAirdrop] Holder refresh failed, using cached data', { error: holderErr.message });
        }

        const allToDistribute = platformTokensToAirdrop.map(t => ({ ...t, source: 'platform' }));

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

        logger.info(`[TokenAirdrop] Processing ${allToDistribute.length} token pools`);

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

                // v30.2: defence in depth -- the scanner already drops these, but a holder list
                // written before that change, or by an older process, must not be able to pay
                // the platform wallet itself or a program-owned account (where SOL is stranded).
                const payable = await payableSet(connection, holders.map(h => h.holderPubkey));
                const devWallet = devKeypair.publicKey.toString();
                const payableHolders = holders.filter(h => h.holderPubkey !== devWallet && payable.has(h.holderPubkey));

                // Build weighted holder list — ASDF Top 100 and ANSEM Top 1000 each get 2× (stack to 4× if both)
                const weightedHolders = payableHolders.map(h => {
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

                // v30.2: shares under MIN_RECIPIENT_LAMPORTS and the rounding remainder are NOT
                // paid out. They used to be added to recipients[0] -- the largest holder -- which
                // on a typical coin handed that one wallet every small holder's share (and on a
                // graduated coin, handed it to the AMM pool). Only totalPlanned is reserved
                // below, so everything unallocated simply stays in this token's pool and is
                // paid, pro rata, in a later cycle once it has grown.

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

                // v27.6 CRASH SAFETY: reserve the planned amount out of the pool *before*
                // sending anything. Previously every batch was sent first and the pool was
                // decremented afterwards, so a crash or redeploy between the final send and
                // that UPDATE replayed the whole pool next run and paid every holder twice.
                //
                // The reservation and the ledger row are written in one transaction, and the
                // conditional WHERE makes the reservation atomic against a concurrent worker:
                // whoever decrements first wins, the loser reserves nothing and skips.
                let reserved = false;
                try {
                    await db.transaction(async (tx) => {
                        const res = await tx.run(
                            `UPDATE ${tables.tokens} SET pending_airdrop_lamports = pending_airdrop_lamports - $1
                             WHERE mint = $2 AND pending_airdrop_lamports >= $1`,
                            [totalPlanned, token.mint]
                        );
                        if (res.changes === 0) {
                            throw new Error('pool no longer holds the planned amount');
                        }
                        await tx.run(
                            `INSERT INTO airdrop_reservations
                                (airdrop_id, mint, token_source, planned_lamports, sent_lamports, status, created_at, updated_at)
                             VALUES ($1, $2, $3, $4, 0, 'sending', $5, $5)`,
                            [airdropId, token.mint, token.source, totalPlanned, Date.now()]
                        );
                        reserved = true;
                    });
                } catch (reserveErr) {
                    logger.warn(`[TokenAirdrop] ${token.ticker}: could not reserve pool, skipping`, { error: reserveErr.message });
                    continue;
                }
                if (!reserved) continue;

                for (let i = 0; i < recipients.length; i += AIRDROP_BATCH_SIZE) {
                    const batch = recipients.slice(i, i + AIRDROP_BATCH_SIZE);
                    const result = await sendSolAirdropBatch(batch, deps);
                    if (result?.signature) {
                        allSignatures.push(result.signature);
                        actualSentLamports += result.actualLamports;
                        // Record progress after each batch so a crash leaves an accurate
                        // account of what actually went out.
                        await db.run(
                            `UPDATE airdrop_reservations SET sent_lamports = $1, updated_at = $2 WHERE airdrop_id = $3`,
                            [actualSentLamports, Date.now(), airdropId]
                        ).catch(() => {});
                    }
                    if (i + AIRDROP_BATCH_SIZE < recipients.length) {
                        await new Promise(r => setTimeout(r, 300));
                    }
                }

                // Settle the reservation: bank what was sent, return the unsent remainder to
                // the pool. Done in one transaction so the ledger and the pool cannot diverge.
                const unsentLamports = totalPlanned - actualSentLamports;
                try {
                    await db.transaction(async (tx) => {
                        if (actualSentLamports > 0) {
                            await tx.run(
                                `UPDATE ${tables.tokens} SET lifetime_airdrop_lamports = lifetime_airdrop_lamports + $1 WHERE mint = $2`,
                                [actualSentLamports, token.mint]
                            );
                        }
                        if (unsentLamports > 0) {
                            await tx.run(
                                `UPDATE ${tables.tokens} SET pending_airdrop_lamports = pending_airdrop_lamports + $1 WHERE mint = $2`,
                                [unsentLamports, token.mint]
                            );
                        }
                        await tx.run(
                            `UPDATE airdrop_reservations SET sent_lamports = $1, status = $2, updated_at = $3 WHERE airdrop_id = $4`,
                            [actualSentLamports, actualSentLamports > 0 ? 'completed' : 'aborted', Date.now(), airdropId]
                        );
                    });
                } catch (settleErr) {
                    // The reservation row stays 'sending' and is reported at startup.
                    logger.error(`[TokenAirdrop] ${token.ticker}: failed to settle reservation ${airdropId}`, { error: settleErr.message });
                }

                if (actualSentLamports > 0) {
                    availableBalance -= actualSentLamports;

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

    // Fetch all eligible platform tokens with their market cap
    const eligiblePlatform = await db.all(
        'SELECT mint, "marketCap" as mcap FROM tokens WHERE volume24h >= $1',
        [MIN_VOLUME_USD]
    );
    const allEligible = eligiblePlatform;

    if (allEligible.length === 0) {
        logger.info('[CentralPool] No eligible tokens for central pool distribution');
        return;
    }

    const totalMcap = allEligible.reduce((s, t) => s + (parseFloat(t.mcap) || 0), 0);
    if (totalMcap === 0) return;

    const mcapByMint = new Map(allEligible.map(t => [t.mint, parseFloat(t.mcap) || 0]));

    // Fetch all holders and bonus sets in parallel
    const platformMints  = eligiblePlatform.map(t => t.mint).filter(Boolean);

    const [platformHolders, asdfTop100, ansemTop1000] = await Promise.all([
        platformMints.length > 0
            ? db.all('SELECT "holderPubkey", balance, mint FROM token_holders WHERE mint = ANY($1)', [platformMints])
            : [],
        redis.getAsdfTop100Holders().catch(() => new Set()),
        redis.getAnsemTop1000Holders().catch(() => new Set()),
    ]);

    // Build user score map: mcap-weighted ownership, with 2× bonus for ASDF Top 100 and ANSEM Top 1000
    // At avg mcap (1/N share) → 1.0×; at 0 mcap → 0.5×; at 2× avg → 1.5× (capped).
    const N = allEligible.length;
    const userScores = new Map();
    for (const h of platformHolders) {
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

    // v30.2: never pay the platform wallet itself or a program-owned account.
    const cpPayable = await payableSet(connection, [...userScores.keys()]);
    const cpDevWallet = devKeypair.publicKey.toString();
    for (const pubkey of [...userScores.keys()]) {
        if (pubkey === cpDevWallet || !cpPayable.has(pubkey)) userScores.delete(pubkey);
    }
    const payableScore = Array.from(userScores.values()).reduce((s, v) => s + v, 0);
    if (payableScore === 0) return;

    // Build recipient list
    const recipients = [];
    for (const [pubkey, score] of userScores.entries()) {
        try {
            const share = Math.floor(distributable * score / payableScore);
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

    // v27.6 CRASH SAFETY: same reserve-before-send ordering as the per-token pools above.
    let reserved = false;
    try {
        await db.transaction(async (tx) => {
            const res = await tx.run(
                `UPDATE stats SET value = value - $1 WHERE key = 'centralPoolLamports' AND value >= $1`,
                [totalPlanned]
            );
            if (res.changes === 0) {
                throw new Error('central pool no longer holds the planned amount');
            }
            await tx.run(
                `INSERT INTO airdrop_reservations
                    (airdrop_id, mint, token_source, planned_lamports, sent_lamports, status, created_at, updated_at)
                 VALUES ($1, NULL, 'central_pool', $2, 0, 'sending', $3, $3)`,
                [airdropId, totalPlanned, Date.now()]
            );
            reserved = true;
        });
    } catch (reserveErr) {
        logger.warn('[CentralPool] Could not reserve central pool, skipping', { error: reserveErr.message });
        return;
    }
    if (!reserved) return;

    for (let i = 0; i < recipients.length; i += AIRDROP_BATCH_SIZE) {
        const batch = recipients.slice(i, i + AIRDROP_BATCH_SIZE);
        const result = await sendSolAirdropBatch(batch, deps);
        if (result?.signature) {
            allSignatures.push(result.signature);
            actualSentLamports += result.actualLamports;
            await db.run(
                `UPDATE airdrop_reservations SET sent_lamports = $1, updated_at = $2 WHERE airdrop_id = $3`,
                [actualSentLamports, Date.now(), airdropId]
            ).catch(() => {});
        }
        if (i + AIRDROP_BATCH_SIZE < recipients.length) {
            await new Promise(r => setTimeout(r, 300));
        }
    }

    // Settle: bank what was sent, return the unsent remainder to the pool.
    const unsentLamports = totalPlanned - actualSentLamports;
    try {
        await db.transaction(async (tx) => {
            if (actualSentLamports > 0) {
                await tx.run(
                    "UPDATE stats SET value = value + $1 WHERE key = 'lifetimeCentralPoolLamports'",
                    [actualSentLamports]
                );
            }
            if (unsentLamports > 0) {
                await tx.run(
                    "UPDATE stats SET value = value + $1 WHERE key = 'centralPoolLamports'",
                    [unsentLamports]
                );
            }
            await tx.run(
                `UPDATE airdrop_reservations SET sent_lamports = $1, status = $2, updated_at = $3 WHERE airdrop_id = $4`,
                [actualSentLamports, actualSentLamports > 0 ? 'completed' : 'aborted', Date.now(), airdropId]
            );
        });
    } catch (settleErr) {
        logger.error(`[CentralPool] Failed to settle reservation ${airdropId}`, { error: settleErr.message });
    }

    if (actualSentLamports > 0) {

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
                // L-4: Persist lastKothEvaluation timestamp in Redis for cross-process durability
                try {
                    await redisConn.set('koth_last_evaluation', String(now), 'EX', Math.ceil(KOTH_EVALUATION_INTERVAL_MS * 3 / 1000));
                } catch (_) { /* non-fatal */ }

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
 * Every quote mint our own coins were launched in.
 *
 * Needed because de-listing a mint from QuoteControl stops new creates but does not stop the
 * curves already quoted in it: they keep trading and keep accruing creator fees, and pump.fun's
 * own sweep only walks the currently-listed mints. Passing these explicitly is what keeps a
 * de-listed quote's fees reachable.
 */
async function ourQuoteMints(db) {
    try {
        const rows = await db.all('SELECT DISTINCT quote_mint FROM tokens WHERE quote_mint IS NOT NULL');
        return rows.map(r => r.quote_mint).filter(Boolean);
    } catch (e) {
        logger.debug('[FeeCollection] Could not list our quote mints', { error: e.message });
        return [];
    }
}

/**
 * What is waiting to be claimed, per quote mint, priced in lamports.
 *
 * v30.1: replaces the two hand-rolled vault reads. Custom Pairs mean a coin quoted in a
 * tokenised asset accrues its creator fees in that asset, so a SOL-only probe reported a
 * pending balance of zero while real fees piled up in vault ATAs, and the claim never fired.
 *
 * Everything downstream -- the threshold, the 50/25/24.5/0.5 split, the per-token pools -- is
 * lamport-denominated, so each token balance is priced through Jupiter. A quote with no route
 * is reported with `lamports: null` and left out of the total rather than counted as zero:
 * unknown is not the same as nothing, and treating it as nothing would be a silent hole.
 */
async function surveyCreatorFees(deps) {
    const { connection, devKeypair, db } = deps;
    const pumpLaunch = require('../services/pumpLaunch');

    const balances = await pumpLaunch.fetchCollectableFees({
        connection,
        creator: devKeypair.publicKey,
        extraQuoteMints: await ourQuoteMints(db),
    });

    let totalLamports = 0;
    const entries = [];

    for (const b of balances) {
        if (b.isSol) {
            const lamports = b.total.toNumber();
            totalLamports += lamports;
            entries.push({ ...b, lamports });
            continue;
        }
        let lamports = null;
        try {
            lamports = await jupiter.quoteTokenToSol(b.mint, b.total.toString());
        } catch (e) {
            logger.debug('[FeeCollection] Could not price a quote asset', { mint: b.mint, error: e.message });
        }
        if (lamports !== null) totalLamports += lamports;
        else logger.warn('[FeeCollection] No SOL route for a quote asset holding fees', { mint: b.mint, amount: b.total.toString() });
        entries.push({ ...b, lamports });
    }

    return { totalLamports, entries };
}

// A collect leg costs well under this; the budget is per transaction, and requesting more
// than a transaction uses costs nothing beyond a marginally higher priority-fee base.
const CU_PER_FEE_INSTRUCTION = 60_000;
const CU_MAX_PER_TX = 1_400_000;

/**
 * Claim creator fees in every quote mint and convert the proceeds to SOL.
 *
 * Returns the total in lamports, measured rather than assumed: the vault balances are
 * surveyed before and after the sweep, and only the difference is credited. That is what
 * makes a partial sweep safe -- if the third of five transactions fails, the quotes it would
 * have collected still show a full balance afterwards and contribute nothing -- and it is why
 * this does not use a wallet balance delta, which in `full` mode is polluted by the deploy
 * worker spending from the same wallet concurrently.
 */
async function claimCreatorFees(deps, survey = null) {
    const { connection, devKeypair, db } = deps;
    const pumpLaunch = require('../services/pumpLaunch');

    const before = survey || await surveyCreatorFees(deps);
    if (!before.entries.length) return 0;

    const extraQuoteMints = await ourQuoteMints(db);
    const instructions = await pumpLaunch.buildCollectAllFeesInstructions({
        connection,
        creator: devKeypair.publicKey,
        feePayer: devKeypair.publicKey,
        extraQuoteMints,
    });
    if (!instructions.length) return 0;

    const groups = pumpLaunch.planFeeTransactions(instructions, devKeypair.publicKey, CU_MAX_PER_TX);
    logger.info('[FeeCollection] Sweeping creator fees', {
        quotes: before.entries.length, instructions: instructions.length, transactions: groups.length,
    });

    // Sent strictly in order and abandoned on the first failure: the SDK emits each quote's
    // instructions contiguously as [create-ATA-if-missing, collect, collect], so a group can
    // begin with a collect whose destination ATA the previous group creates.
    let sent = 0;
    for (const group of groups) {
        const tx = new Transaction();
        solana.addPriorityFee(tx, { units: Math.min(CU_MAX_PER_TX, CU_PER_FEE_INSTRUCTION * group.length) });
        for (const ix of group) tx.add(ix);
        tx.feePayer = devKeypair.publicKey;
        try {
            await solana.sendTxWithRetry(tx, [devKeypair]);
            sent++;
        } catch (e) {
            logger.warn('[FeeCollection] Fee sweep stopped part-way', {
                sentTransactions: sent, ofTransactions: groups.length, error: e.message,
            });
            break;
        }
    }
    if (sent === 0) return 0;

    // Raw balances, not a priced survey: what is left is only needed to work out how much
    // each quote moved, and pricing it would spend a Jupiter quote per mint for nothing.
    const after = await pumpLaunch.fetchCollectableFees({
        connection,
        creator: devKeypair.publicKey,
        extraQuoteMints,
    });
    const remaining = new Map(after.map(e => [e.mint, e.total]));

    let totalLamports = 0;
    for (const entry of before.entries) {
        const left = remaining.get(entry.mint) || new BN(0);
        const moved = entry.total.sub(left);
        // Fees keep accruing while the sweep runs, so a quote can end up holding more than it
        // started with. Nothing was lost; there is simply nothing to credit for it this cycle.
        if (moved.lten(0)) continue;

        if (entry.isSol) {
            totalLamports += moved.toNumber();
            continue;
        }

        // The tokens are now sitting in our quote ATA. Only the amount this sweep actually
        // moved is swapped -- the wallet may hold the same asset on purpose, to seed launches
        // quoted in it, and swapping that away would break those launches.
        const swap = await jupiter.swapTokenToSol(moved.toString(), entry.mint, devKeypair, connection);
        if (swap && swap.outAmount > 0) {
            totalLamports += swap.outAmount;
        } else {
            // Claimed but unconverted. The tokens are safe in the ATA and the next cycle's
            // sweep will not see them again, so this is logged loudly rather than swallowed.
            logger.warn('[FeeCollection] Claimed fees could not be converted to SOL and are held as tokens', {
                mint: entry.mint, amount: moved.toString(),
            });
        }
    }

    return totalLamports;
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

    // v27.4 BUGFIX: Hoisted out of the try block. It was declared with `const` inside
    // try{}, which made it inaccessible in catch{} (separate block scope) — every
    // reference to it below (`validItems?.length`, `validItems.map(...)`) threw a
    // ReferenceError the moment any batch actually failed, before the dead-letter
    // Redis logging (L-6) ever ran. Since sendSolAirdropBatch is async, that thrown
    // error just became a rejected promise that Promise.allSettled swallowed upstream —
    // so failed batches were still retried correctly, but the audit trail of exactly
    // which recipients failed was silently never written.
    let validItems = [];

    try {
        const tx = new Transaction();
        // v30.2: priority fees are charged on the REQUESTED compute limit, not what is used.
        // A system transfer is ~150 CU; the old default of 300k CU for a 20-transfer batch
        // paid priority on roughly 75x the compute it needed.
        solana.addPriorityFee(tx, { units: Math.max(5_000, 1_000 + 450 * batch.length) });

        // Filter valid items and add SOL transfer instructions
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
        // L-6: Log failed recipients to Redis dead-letter list for auditing
        try {
            const redisConn = redis.getConnection();
            if (redisConn && validItems?.length > 0) {
                const entry = JSON.stringify({
                    timestamp: Date.now(),
                    error: e.message,
                    recipients: validItems.map(i => ({ pubkey: i.user.toString(), lamports: i.amount }))
                });
                await redisConn.lpush('airdrop_dead_letter', entry);
                await redisConn.ltrim('airdrop_dead_letter', 0, 999); // Keep last 1000 entries
            }
        } catch (_) { /* non-fatal */ }
        return null;
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
        // v30.1: one survey across every quote mint, priced in lamports. The rent-exempt
        // minimum a live SOL vault can never release is already excluded by the survey, so
        // pending fees no longer include lamports the platform cannot actually collect.
        let survey = { totalLamports: 0, entries: [] };
        try {
            survey = await surveyCreatorFees(deps);
        } catch (e) {
            logger.debug('[FeeCollection] Creator fee survey failed', { error: e.message });
        }

        const totalPendingFees = new BN(survey.totalLamports);
        const tokenQuotes = survey.entries.filter(e => !e.isSol);
        // v30.2: published for /api/health, which no longer reads the vaults itself.
        await redis.setPlatformSnapshot({ pendingFeesLamports: survey.totalLamports });
        logger.info(`[FeeCollection] Platform pending fees: ${(survey.totalLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`
            + (tokenQuotes.length ? ` (across SOL and ${tokenQuotes.length} token quote${tokenQuotes.length === 1 ? '' : 's'})` : ''));

        // v17.0: Fee threshold is 0.05 SOL
        const threshold = new BN(Math.round((config.FEE_THRESHOLD_SOL || 0.05) * LAMPORTS_PER_SOL));

        if (totalPendingFees.gte(threshold)) {
            logger.info(`[FeeCollection] Claiming ${(totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL in fees...`);

            let claimedAmount = await claimCreatorFees(deps, survey);

            if (claimedAmount > 0) {
                await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [claimedAmount, 'lifetimeCreatorFeesLamports']);
                logger.info(`[FeeCollection] Claimed ${(claimedAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL from creator fees`);

                // v28.0: 50% to per-token holder pools (by volume), 25% central pool, 25% platform
                try {
                    const platformSplit = splitClaimedFees(claimedAmount);
                    const perTokenCredit = platformSplit.holders;
                    const centralCredit = platformSplit.centralPool;
                    const totalRewardCredit = perTokenCredit + centralCredit;

                    const eligiblePlatformTokens = await db.all(
                        'SELECT mint, volume24h FROM tokens WHERE volume24h >= $1',
                        [MIN_VOLUME_USD]
                    );
                    const totalPlatformVol = eligiblePlatformTokens.reduce((s, t) => s + (parseFloat(t.volume24h) || 0), 0);
                    // v28.2: atomic — see runPurchaseAndFees above for why.
                    await db.transaction(async (tx) => {
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
                                await tx.run(
                                    'UPDATE tokens SET pending_airdrop_lamports = pending_airdrop_lamports + $1 WHERE mint = $2',
                                    [share, tok.mint]
                                );
                            }
                        }
                    } else if (perTokenCredit > 0) {
                        // No eligible platform tokens to distribute to — redirect to central pool to avoid losing funds
                        await addToCentralPool(tx, perTokenCredit);
                        logger.info(`[FeeCollection] No eligible platform tokens — redirected ${(perTokenCredit / LAMPORTS_PER_SOL).toFixed(4)} SOL per-token credit to central pool`);
                    }
                    if (centralCredit > 0) {
                        await addToCentralPool(tx, centralCredit);
                    }
                    await accruePlatformFees(tx, platformSplit);
                    });
                    logger.info(`[FeeCollection] Attributed ${(totalRewardCredit / LAMPORTS_PER_SOL).toFixed(4)} SOL platform fees: ${(perTokenCredit / LAMPORTS_PER_SOL).toFixed(4)} to per-token pools, ${(centralCredit / LAMPORTS_PER_SOL).toFixed(4)} to central pool, ${((platformSplit.buybackBurn + platformSplit.upkeep) / LAMPORTS_PER_SOL).toFixed(4)} to platform`);
                } catch (attrErr) {
                    logger.warn('[FeeCollection] Platform fee attribution failed', { error: attrErr.message });
                }
            }
            await new Promise(r => setTimeout(r, 1000));

            // v28.0: the platform's 25% was accrued at attribution time; sweep it when the
            // which the old per-claim transfer never touched.
            //
            // Run every cycle rather than only after a claim: the sweep is self-gating on the
            // threshold (a single cheap stats read when there is nothing to do), and that way
            // an accrual left just under the threshold cannot sit stranded waiting for a claim
            // large enough to push it over.
            await processPlatformFeeSweep(deps);

            if (claimedAmount > 0) {
                // v25.4: Log to frontend
                // v25.115: Enhanced with full breakdown
                if (logPurchase) {
                    await logPurchase('FEE_CLAIM', {
                        status: 'SUCCESS',
                        feesClaimedSol: (claimedAmount / LAMPORTS_PER_SOL).toFixed(4),
                        // v30.1: was hard-coded at 5%, which stopped being the platform's cut
                        // when the split became 50/25/24.5/0.5. Read it from the splitter so
                        // the figure the frontend shows cannot drift from the one it books.
                        platformFeeSol: ((splitClaimedFees(claimedAmount).buybackBurn
                            + splitClaimedFees(claimedAmount).upkeep) / LAMPORTS_PER_SOL).toFixed(4),
                        pendingBeforeClaimSol: (totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                        quoteAssetsPending: survey.entries.length,
                        thresholdSol: (config.FEE_THRESHOLD_SOL || 0.05).toFixed(2)
                    });
                }
            }
        } else {
            logger.info(`[FeeCollection] Below threshold: ${(totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL pending, need ${config.FEE_THRESHOLD_SOL || 0.05} SOL`);
            // v25.115: Always log fee check to frontend (even at 0 pending)
            if (logPurchase) {
                await logPurchase('FEE_CHECK', {
                    status: 'BELOW_THRESHOLD',
                    pendingSol: (totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                    quoteAssetsPending: survey.entries.length,
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
// v30.2: graceful drain for worker shutdown. Scheduled runs stop starting once `stopping` is
// set, and drain() resolves when the runs already in flight have finished -- so a redeploy
// does not kill an airdrop or a fee sweep between a send and its bookkeeping.
let stopping = false;
let inFlight = 0;
function tracked(fn) {
    return async (...args) => {
        if (stopping) return;
        inFlight++;
        try {
            return await fn(...args);
        } finally {
            inFlight--;
        }
    };
}
async function drain(timeoutMs = 160_000) {
    stopping = true;
    const deadline = Date.now() + timeoutMs;
    while (inFlight > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
    }
    return inFlight === 0;
}

// v30.2: the `logs` table gained a FEE_CHECK row every few minutes and was never pruned.
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS, 10) || 30;
async function pruneLogs(db) {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400_000).toISOString();
    const res = await db.run('DELETE FROM logs WHERE timestamp < $1', [cutoff]).catch(e => {
        logger.debug('[Flywheel] Log prune failed', { error: e.message });
        return null;
    });
    if (res?.changes) logger.info(`[Flywheel] Pruned ${res.changes} log rows older than ${LOG_RETENTION_DAYS} days`);
}

async function start(deps) {
    const { db } = deps;
    const workers = require('./workers');

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

    const feeRun = tracked(() => runFeeCollection(deps));
    const airdropRun = tracked(() => processTokenAirdrops(deps));
    const seedRun = tracked(() => workers.reconcileSeedPositions(deps));

    const feeInterval = config.FEE_COLLECTION_INTERVAL || 600000;
    setInterval(feeRun, feeInterval);
    logger.info(`Fee collection started (${feeInterval / 1000}s interval, >${config.FEE_THRESHOLD_SOL || 0.05} SOL threshold)`);

    // v26.0: Per-token airdrop processing every 15 minutes
    setInterval(airdropRun, airdropInterval);
    logger.info(`Per-token airdrop distribution started (${airdropInterval / 60000}min interval, >${config.TOKEN_AIRDROP_THRESHOLD_SOL} SOL threshold per token)`);

    // v30.2: retry seed positions whose post-launch sell never ran, and prune old logs.
    setInterval(seedRun, 10 * 60 * 1000);
    setInterval(() => pruneLogs(db), 24 * 60 * 60 * 1000);

    // v25.64: Staggered initial runs to avoid RPC spike at startup
    setTimeout(feeRun, 30000);
    setTimeout(airdropRun, 120000);
    setTimeout(seedRun, 90000);
    setTimeout(() => pruneLogs(db), 60000);

    // Run KOTH evaluation early so Redis has a valid selection before holderScanner first reads it.
    // would be excluded from KOTH during that window.
    setTimeout(() => evaluateKothCandidates(db).catch(e => logger.warn('[KOTH] Startup evaluation failed', { error: e.message })), 10000);
}

module.exports = { claimCreatorFees, surveyCreatorFees, processTokenAirdrops, sendSolAirdropBatch, runFeeCollection, start, drain, getAiSelectedKoth, resetKothCache, splitClaimedFees, processPlatformFeeSweep, FEE_SPLIT };
