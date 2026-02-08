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
    const KOTH_MIN_HOLDERS = 10;
    const KOTH_MIN_MARKET_CAP = 1000;
    const KOTH_MIN_VOLUME = 100;

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
            // Calculate token age in hours
            const ageHours = token.timestamp
                ? (Date.now() - token.timestamp) / (1000 * 60 * 60)
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

        // Select the winner
        const winner = scoredCandidates[0];
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
                        const configAccount = isFeeProgram ? bcVault : sharingConfigPDA;
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

                            const ourShare = Math.floor(bcPendingLamports * (token.feeShareBps / 10000));
                            tokenClaimed += ourShare;
                            totalClaimed += ourShare;
                            claimedTokens.push({
                                ticker: token.ticker || token.creatorPubkey.slice(0, 8),
                                amount: ourShare,
                                source: 'BC'
                            });

                            await db.run(
                                'UPDATE robinhood_tokens SET "lastFeesClaimed" = $1, "totalFeesCollected" = "totalFeesCollected" + $2, "pendingFees" = 0 WHERE id = $3',
                                [Date.now(), ourShare / LAMPORTS_PER_SOL, token.id]
                            );

                            logger.info(`[Robinhood] ${token.ticker}: Distributed ${(bcPendingLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (our share: ${(ourShare / LAMPORTS_PER_SOL).toFixed(6)} SOL @ ${token.feeShareBps/100}%)`);
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
                        const ourShare = ammFeeSol * (token.feeShareBps / 10000);

                        logger.info(`[Robinhood/AMM] ${token.ticker}: Found ${ammFeeSol.toFixed(6)} SOL in AMM vault (our share: ${ourShare.toFixed(6)} SOL @ ${token.feeShareBps/100}%)`);

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
                            const ourShareLamports = Math.floor(ammFeeLamports * (token.feeShareBps / 10000));
                            totalClaimed += ourShareLamports;
                            claimedTokens.push({
                                ticker: token.ticker || token.creatorPubkey.slice(0, 8),
                                amount: ourShareLamports,
                                source: 'AMM'
                            });

                            // Update database
                            await db.run(
                                'UPDATE robinhood_tokens SET "lastFeesClaimed" = $1, "totalFeesCollected" = "totalFeesCollected" + $2 WHERE id = $3',
                                [Date.now(), ourShareLamports / LAMPORTS_PER_SOL, token.id]
                            );

                            logger.info(`[Robinhood/AMM] ${token.ticker}: Distributed ${ammFeeSol.toFixed(6)} SOL via TransferCreatorFeesToPump (our share: ${ourShare.toFixed(6)} SOL @ ${token.feeShareBps/100}%)`);

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
            await holderScanner.updateGlobalState(deps);
            logger.info('[Airdrop] Holder data refreshed successfully');
            logEvent('HOLDER_REFRESH', 'Holder data refreshed successfully', { durationMs: Date.now() - holderRefreshStart });
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
        const KOTH_MIN_HOLDERS = 10;
        const KOTH_MAX_PERCENT = 0.10; // 10% cap

        const kothResult = await getAiSelectedKoth(db);
        const kothToken = kothResult.token ? await db.get(
            'SELECT "userPubkey", ticker, mint, "marketCap" FROM tokens WHERE mint = $1',
            [kothResult.token.mint]
        ) : null;

        if (kothResult.reasoning) {
            logger.info(`[KOTH] AI Reasoning: ${kothResult.reasoning}`);
        }

        // 3. Build KOTH distribution plan (but don't send yet)
        let kothBatch = [];
        let kothHolders = [];
        if (kothToken && kothToken.mint) {
            kothHolders = await db.all(
                'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC',
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

        const airdropSucceeded = successfulBatches > 0 || failedBatches === 0;

        logger.info(`SOL Airdrop Complete. Success: ${successfulBatches}, Failed: ${failedBatches}, Actual sent: ${actualTotalSolSent.toFixed(4)} SOL (KOTH: ${actualKothSolSent.toFixed(4)}, Community: ${(actualCommunityLamportsSent / LAMPORTS_PER_SOL).toFixed(4)})`);

        // v13.0: Track KOTH holder recipients count
        const kothHolderCount = kothToken?.mint ? (await db.get(
            'SELECT COUNT(*) as count FROM token_holders WHERE mint = $1',
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

        // Try SOL airdrop (internally checks balance & threshold)
        await processAirdrop(deps);
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
                        // FEE program token - both vaults derived from feeVaultAddress
                        const feeVaultPubkey = new PublicKey(token.feeVaultAddress);
                        bcVaultAddr = feeVaultPubkey;
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
                        tokenBcFees = Math.floor(pendingLamports * (token.feeShareBps / 10000));
                    }

                    // Check AMM vault (for graduated tokens)
                    try {
                        const ammVaultAtaKey = await ammVaultAta;
                        const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                        const ammBalance = parseInt(bal.value.amount) || 0;
                        if (ammBalance > 0) {
                            tokenAmmFees = Math.floor(ammBalance * (token.feeShareBps / 10000));
                        }
                    } catch (e) {
                        // AMM vault may not exist for non-graduated tokens
                    }

                    const tokenTotalFees = tokenBcFees + tokenAmmFees;
                    if (tokenTotalFees > 0) {
                        robinhoodPendingFees = robinhoodPendingFees.add(new BN(tokenTotalFees));
                        logger.info(`[FeeCollection] ${token.ticker}: ${(tokenTotalFees / LAMPORTS_PER_SOL).toFixed(4)} SOL pending (BC: ${(tokenBcFees / LAMPORTS_PER_SOL).toFixed(4)}, AMM: ${(tokenAmmFees / LAMPORTS_PER_SOL).toFixed(4)}) @ ${token.feeShareBps / 100}%`);
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
                if (logPurchase) {
                    await logPurchase('FEE_CLAIM', {
                        status: 'SUCCESS',
                        feesClaimedSol: (claimedAmount / LAMPORTS_PER_SOL).toFixed(4),
                        platformFeeSol: ((claimedAmount * 0.05) / LAMPORTS_PER_SOL).toFixed(4)
                    });
                }
            }
        } else {
            // v25.77: Log with breakdown of platform vs robinhood
            logger.info(`[FeeCollection] Below threshold: ${(totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL pending (platform: ${(platformPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} + robinhood: ${(robinhoodPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)}), need ${config.FEE_THRESHOLD_SOL || 0.05} SOL`);
            // v25.12: Log skip events to frontend so users know system is working
            if (logPurchase && totalPendingFees.toNumber() > 0) {
                await logPurchase('FEE_CHECK', {
                    status: 'PENDING',
                    pendingSol: (totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                    platformPendingSol: (platformPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                    robinhoodPendingSol: (robinhoodPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
                    thresholdSol: (config.FEE_THRESHOLD_SOL || 0.05).toFixed(2),
                    reason: 'Below threshold'
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
    try {
        const pags = require('../services/pags');
        pagsFeeScanner.init({
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

    // Airdrop processing every 15 minutes
    setInterval(() => processAirdrop(deps), airdropInterval);
    logger.info(`Airdrop distribution started (${airdropInterval / 60000}min interval, >${config.AIRDROP_THRESHOLD_SOL || 1.0} SOL threshold)`);

    // v25.64: Staggered initial runs to avoid RPC spike at startup
    setTimeout(() => runFeeCollection(deps), 30000); // Fee collection at 30s (was 5s)
    setTimeout(() => processAirdrop(deps), 120000); // Airdrop at 2min (was 10s)
}

module.exports = { claimCreatorFees, claimRobinhoodFees, processAirdrop, sendSolAirdropBatch, runPurchaseAndFees, runFeeCollection, refreshAllFeeShares, start, getAiSelectedKoth, resetKothCache };
