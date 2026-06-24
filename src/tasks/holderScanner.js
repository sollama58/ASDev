/**
 * Holder Scanner Task
 * Updates token holders and calculates global points
 *
 * v14.0 - Changed to Top 250 holders with proportional points based on holdings
 *         Points are now calculated proportionally to token balance, not just position count
 * v17.0 - Fixed expected airdrop calculation to use actual SOL balance (not PUMP holdings)
 * v18.0 - Changed from top 10 tokens to all tokens with >$100 24hr volume
 * v25.4 - Volume-weighted points: higher volume tokens distribute more points
 *         Dynamic scaling based on current eligible tokens' volume range
 * v25.20 - STABILITY: Added RPC retry logic with exponential backoff
 * v25.22 - SCALABILITY: Added mutex to prevent task overlap, parallel RPC batching
 * v25.110 - CRITICAL: Fixed Redis sync - points/airdrops now synced after calculation
 *           This fixes airdrop sending only one transaction (stale Redis data)
 * v25.112 - KOTH selection now reads AI-selected KOTH from Redis to match flywheel
 */
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { BN } = require('@coral-xyz/anchor');
const axios = require('axios');
const config = require('../config/env');
const { TOKENS, PROGRAMS, WALLETS } = require('../config/constants');
const { logger, mutex, postgres, redis } = require('../services');
const { fetchTokenAccountsHeliusDAS } = require('../services/heliusDAS');

// v25.22 SCALABILITY: Mutex to prevent overlapping holder scans
const holderScannerMutex = mutex.getMutex('holder_scanner');

// v25.20: RPC retry configuration
const RPC_MAX_RETRIES = 3;
const RPC_BASE_DELAY_MS = 1000;

// v25.22 SCALABILITY: RPC batching configuration
const RPC_PARALLEL_BATCH_SIZE = 5; // Process 5 tokens in parallel

/**
 * v25.20: Execute RPC call with exponential backoff retry
 */
async function withRetry(fn, context = 'RPC call') {
    let lastError;
    for (let attempt = 0; attempt < RPC_MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            const delay = RPC_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
            logger.debug(`[HolderScanner] ${context} failed (attempt ${attempt + 1}/${RPC_MAX_RETRIES}), retrying in ${delay.toFixed(0)}ms`, { error: e.message });
            if (attempt < RPC_MAX_RETRIES - 1) {
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}

// fetchTokenAccountsHeliusDAS is imported from ../services/heliusDAS

// Constants for point calculation
const TOP_HOLDERS_LIMIT = 250; // Track top 250 holders per eligible token
const SAFETY_RESERVE_SOL = 0.1; // v25.78: Reserve 0.1 SOL for operations
const MIN_VOLUME_USD = config.AIRDROP_MIN_VOLUME_USD || 100; // v18.0: Minimum 24hr volume for eligibility

// v25.36: Pump.fun standard total supply (1 billion tokens with 6 decimals)
// All pump.fun tokens have fixed 1B supply - use this for accurate % of supply calculation
const PUMP_FUN_TOTAL_SUPPLY = BigInt('1000000000000000'); // 1B tokens * 10^6 decimals

/**
 * Update global state (holders, points, expected airdrops)
 *
 * v14.0 - New proportional point system:
 * - Track top 250 holders of each eligible token
 * - Each token contributes 1000 base points distributed proportionally among holders
 * - ASDF multiplier: 2x total points if top 100 ASDF holder
 * - KOTH: informational AI spotlight only (v26.0: no fee allocation)
 *
 * v18.0 - Eligibility now based on volume threshold:
 * - All tokens with >$100 24hr volume are eligible (no limit)
 *
 * v23.0 - Removed creator bonus (no longer 2x for creators)
 * - Includes both tokens table and robinhood_tokens table
 *
 * v25.36 - Points now proportional to % of TOTAL SUPPLY (1B tokens):
 * - Previously: points = (balance / tracked holders balance) * token points
 * - Now: points = (balance / 1B total supply) * token points
 * - This ensures fair distribution based on actual ownership percentage
 *
 * v26.0 - Per-token airdrop pool system (replaces global pooling):
 * - expectedAirdrop = SUM over held tokens of (token.pending_airdrop_lamports * holderBalance / 1B)
 * - Points are informational only; airdrop share determined by token supply ownership
 * - KOTH is now an AI spotlight (no fee allocation)
 */
async function updateGlobalState(deps) {
    const { connection, devKeypair, db, globalState } = deps;

    // v25.22 SCALABILITY: Prevent overlapping holder scans
    // If previous scan still running, skip this one
    // C-1 FIX: Return { scanCompleted: false } so callers know whether fresh data was written
    const release = await holderScannerMutex.tryAcquire();
    if (!release) {
        logger.info('[HolderScanner] Skipping - previous scan still in progress');
        return { scanCompleted: false, skipped: true };
    }

    try {
        // v18.0: Get all tokens with >$100 24hr volume (no limit)
        // v25.4: Include volume24h for dynamic volume weighting
        // v25.63: Tokens can be in both platform AND PAGS (fee splitting allowed)
        const eligibleTokens = await db.all(
            'SELECT mint, "userPubkey", volume24h, ticker FROM tokens WHERE volume24h >= $1 ORDER BY volume24h DESC',
            [MIN_VOLUME_USD]
        );
        const eligibleMints = eligibleTokens.map(t => t.mint);

        logger.info(`[HolderScanner] Found ${eligibleTokens.length} eligible tokens with >${MIN_VOLUME_USD} USD volume`);

        // v17.0: Get actual SOL balance (for wallet monitoring)
        try {
            const solBalance = await connection.getBalance(devKeypair.publicKey);
            globalState.devSolBalance = solBalance / LAMPORTS_PER_SOL;
        } catch (e) {
            globalState.devSolBalance = 0;
        }

        // 2. Identify KOTH Token (for expected airdrop calculation)
        // v25.112: Read AI-selected KOTH from Redis (set by flywheel) to match actual distribution
        // Falls back to highest market cap if Redis data unavailable
        let kothToken = null;
        let kothSource = 'platform';
        try {
            const redisConn = redis.getConnection();
            if (redisConn) {
                const kothData = await redisConn.get('koth_ai_selection');
                if (kothData) {
                    const parsed = JSON.parse(kothData);
                    if (parsed.mint) {
                        // v25.113: Check both platform and robinhood token tables
                        kothToken = await db.get('SELECT mint, "userPubkey" FROM tokens WHERE mint = $1', [parsed.mint]);
                        if (!kothToken) {
                            const rhToken = await db.get('SELECT mint, "creatorPubkey" as "userPubkey" FROM robinhood_tokens WHERE mint = $1', [parsed.mint]);
                            if (rhToken) {
                                kothToken = rhToken;
                                kothSource = 'robinhood';
                            }
                        }
                    }
                }
            }
        } catch (e) {
            logger.debug('[HolderScanner] Failed to read KOTH from Redis, using fallback', { error: e.message });
        }
        if (!kothToken) {
            kothToken = await db.get('SELECT mint, "userPubkey" FROM tokens ORDER BY "marketCap" DESC LIMIT 1');
        }

        // --- END CALCULATION PREP ---

        // v18.0: Update holders for all eligible tokens (>$100 volume) - tracking Top 250 with balances
        // v25.65: Critical bugfix - don't delete holders on RPC failure
        // v25.66: Added fallback for tokens with many holders
        for (const token of eligibleTokens) {
            try {
                if (!token.mint) continue;

                const tokenMintPublicKey = new PublicKey(token.mint);
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
                    PROGRAMS.PUMP
                );

                const holdersToInsert = [];
                const bondingCurvePDAStr = bondingCurvePDA.toString();
                const threshold = new BN(1000000); // Minimum balance threshold (dust filter)
                let scanSucceeded = false;
                let usedFallback = false;

                try {
                    // v25.114: Query BOTH Token and Token-2022 programs
                    // Some tokens use standard SPL Token, others use Token-2022
                    // Previously only queried TOKEN_2022 which missed standard Token holders
                    // v25.115: Use Promise.allSettled so one failing query doesn't discard results from the other
                    const results = await Promise.allSettled([
                        withRetry(
                            () => connection.getProgramAccounts(PROGRAMS.TOKEN, {
                                filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: token.mint } }],
                                encoding: 'base64'
                            }),
                            `getProgramAccounts(TOKEN) for ${token.mint.slice(0, 8)}`
                        ),
                        withRetry(
                            () => connection.getProgramAccounts(PROGRAMS.TOKEN_2022, {
                                filters: [{ memcmp: { offset: 0, bytes: token.mint } }],
                                encoding: 'base64'
                            }),
                            `getProgramAccounts(TOKEN_2022) for ${token.mint.slice(0, 8)}`
                        )
                    ]);

                    let tokenAccounts = results[0].status === 'fulfilled' ? results[0].value : [];
                    let token2022Accounts = results[1].status === 'fulfilled' ? results[1].value : [];
                    if (results[0].status === 'rejected') logger.debug(`[HolderScanner] TOKEN query failed for ${token.mint.slice(0, 8)}: ${results[0].reason?.message}`);
                    if (results[1].status === 'rejected') logger.debug(`[HolderScanner] TOKEN_2022 query failed for ${token.mint.slice(0, 8)}: ${results[1].reason?.message}`);

                    // v25.115: Detect "too many accounts" from settled results to trigger DAS fallback
                    // Promise.allSettled never throws, so the outer catch block can't detect this
                    const tooManyToken = results[0].status === 'rejected' && (results[0].reason?.message?.includes('Too many accounts') || results[0].reason?.message?.includes('too many'));
                    const tooManyToken2022 = results[1].status === 'rejected' && (results[1].reason?.message?.includes('Too many accounts') || results[1].reason?.message?.includes('too many'));
                    if (tooManyToken || tooManyToken2022) {
                        logger.debug(`[HolderScanner] ${token.ticker || token.mint.slice(0, 8)} has too many holders, using Helius DAS API`);
                        usedFallback = true;
                        tokenAccounts = [];
                        token2022Accounts = [];
                    }

                    const accounts = [...tokenAccounts, ...token2022Accounts];

                    // v25.65: Handle both Buffer and base64 array tuple formats from RPC
                    const parsedAccounts = accounts.map(acc => {
                        try {
                            const data = Array.isArray(acc.account.data)
                                ? Buffer.from(acc.account.data[0], 'base64')
                                : Buffer.from(acc.account.data);
                            if (data.length < 72) return null;

                            const owner = new PublicKey(data.slice(32, 64)).toString();
                            const amount = new BN(data.slice(64, 72), 'le');
                            return { owner, amount };
                        } catch (parseErr) {
                            return null;
                        }
                    })
                    .filter(a => a !== null)
                    .sort((a, b) => b.amount.cmp(a.amount));

                    for (const acc of parsedAccounts) {
                        if (holdersToInsert.length >= TOP_HOLDERS_LIMIT) break;
                        if (acc.amount.lte(threshold)) continue;

                        if (acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== bondingCurvePDAStr) {
                            holdersToInsert.push({
                                mint: token.mint,
                                owner: acc.owner,
                                balance: acc.amount.toString()
                            });
                        }
                    }
                    // v25.115: If "too many accounts" was detected above, usedFallback is already set
                    // and accounts array is empty - don't mark as succeeded yet, let DAS fallback handle it
                    if (!usedFallback) {
                        scanSucceeded = true;
                    }
                } catch (scanErr) {
                    // Note: Promise.allSettled never throws, but other code in the try block could
                    logger.error(`Failed to scan holders for ${token.mint}`, { error: scanErr.message });
                }

                // v25.66: Use Helius DAS API fallback for tokens with many holders (gets all 250)
                if (usedFallback) {
                    const dasAccounts = await fetchTokenAccountsHeliusDAS(token.mint, TOP_HOLDERS_LIMIT, 'HolderScanner');

                    if (dasAccounts && dasAccounts.length > 0) {
                        // Sort by balance descending and filter
                        const sortedAccounts = dasAccounts
                            .filter(acc => {
                                const bal = new BN(acc.balance);
                                return bal.gt(threshold) && acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== bondingCurvePDAStr;
                            })
                            .sort((a, b) => {
                                const balA = new BN(a.balance);
                                const balB = new BN(b.balance);
                                return balB.cmp(balA);
                            })
                            .slice(0, TOP_HOLDERS_LIMIT);

                        for (const acc of sortedAccounts) {
                            holdersToInsert.push({
                                mint: token.mint,
                                owner: acc.owner,
                                balance: acc.balance
                            });
                        }
                        scanSucceeded = true;
                    } else {
                        logger.warn(`[HolderScanner] Helius DAS returned no results for ${token.ticker || token.mint.slice(0, 8)} - preserving existing`);
                    }
                }

                // v25.65: Only update database if scan succeeded
                // Don't delete existing holders if scan failed
                if (!scanSucceeded) {
                    await new Promise(r => setTimeout(r, 500)); // Shorter delay after failure
                    continue;
                }

                // v25.65: Check if we have existing holders before potentially clearing them
                const existingHolders = await db.get(
                    'SELECT COUNT(*) as count FROM token_holders WHERE mint = $1',
                    [token.mint]
                );
                const hadExistingHolders = (existingHolders?.count || 0) > 0;

                // H-7 FIX: Wrap DELETE + INSERT in a single DB transaction so a write
                // error after DELETE cannot leave the token with zero holders.
                try {
                    if (holdersToInsert.length > 0) {
                        await db.transaction(async (tx) => {
                            await tx.run('DELETE FROM token_holders WHERE mint = $1', [token.mint]);
                            let rank = 1;
                            for (const h of holdersToInsert) {
                                await tx.run(
                                    'INSERT INTO token_holders (mint, "holderPubkey", rank, balance, "lastUpdated") VALUES ($1, $2, $3, $4, $5) ON CONFLICT (mint, "holderPubkey") DO UPDATE SET rank = $3, balance = $4, "lastUpdated" = $5',
                                    [h.mint, h.owner, rank, h.balance, Date.now()]
                                );
                                rank++;
                            }
                        });
                    } else if (hadExistingHolders) {
                        // v25.65: RPC returned 0 but we had holders - preserve existing, log warning
                        logger.warn(`[HolderScanner] ${token.ticker || token.mint.slice(0, 8)} RPC returned 0 holders but had ${existingHolders.count} - preserving existing`);
                    }
                } catch (err) {
                    logger.error(`[HolderScanner] DB update failed for ${token.mint}`, { error: err.message });
                }
            } catch (e) {
                logger.error(`Holder update loop error for ${token.mint}: ${e.message}`);
            }

            await new Promise(r => setTimeout(r, 2000));
        }

        // v25.22 SCALABILITY: Refresh materialized views after holder updates
        try {
            await postgres.refreshMaterializedViews();
            logger.debug('[HolderScanner] Materialized views refreshed');
        } catch (mvErr) {
            logger.warn('[HolderScanner] Failed to refresh materialized views', { error: mvErr.message });
        }

        // v26.2: Points = pure supply ownership — (balance / 1B supply) × BASE_POINTS_PER_TOKEN
        // Volume weight and feeShareBps removed: per-token pools already embed those economics.
        const BASE_POINTS_PER_TOKEN = 1000;
        let rawPointsMap = new Map(); // pubkey -> { basePoints, robinhoodPoints, positionsCount }
        let tempTotalPoints = 0;

        if (eligibleMints.length > 0) {
            // BATCH: single query for all eligible token holders
            const allPlatformHolderRows = await db.all(
                `SELECT "holderPubkey", balance, mint FROM token_holders WHERE mint = ANY($1) ORDER BY mint, rank ASC`,
                [eligibleMints]
            );
            const platformHoldersByMint = new Map();
            for (const row of allPlatformHolderRows) {
                if (!platformHoldersByMint.has(row.mint)) platformHoldersByMint.set(row.mint, []);
                platformHoldersByMint.get(row.mint).push(row);
            }
            logger.debug(`[HolderScanner] Platform: loaded ${allPlatformHolderRows.length} holder rows for ${eligibleMints.length} tokens`);

            for (const token of eligibleTokens) {
                if (!token.mint) continue;
                const holders = platformHoldersByMint.get(token.mint) || [];
                if (holders.length === 0) continue;

                for (const holder of holders) {
                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance === BigInt(0)) continue;

                    // Points = % of total 1B supply × BASE_POINTS_PER_TOKEN
                    const proportionalPoints = Number((holderBalance * BigInt(BASE_POINTS_PER_TOKEN * 1000)) / PUMP_FUN_TOTAL_SUPPLY) / 1000;

                    const entry = rawPointsMap.get(holder.holderPubkey) || {
                        basePoints: 0,
                        robinhoodPoints: 0,
                        positionsCount: 0
                    };
                    entry.basePoints += proportionalPoints;
                    entry.positionsCount++;
                    rawPointsMap.set(holder.holderPubkey, entry);
                }
            }
        }

        // v12.0: Include Robinhood token holders in points calculation
        // Holders of tokens that share fees with us also earn airdrop eligibility
        // v16.0: Points are now scaled proportionally to our fee share percentage
        // v18.0: All robinhood tokens with >$100 volume are eligible (no limit)
        // v25.4: Also apply volume weighting to Robinhood tokens
        // v25.63: Tokens can be in both platform AND PAGS (fee splitting allowed)
        // v25.64: Added detailed logging for debugging Robinhood token issues
        // v25.67: Enhanced debugging for volume-excluded tokens
        let robinhoodPointsTotal = 0;
        let robinhoodHoldersWithPoints = 0;
        try {
            // v26.1: Single query for all active robinhood tokens (replaces 3 separate queries)
            const allActiveRobinhoodTokens = await db.all(
                'SELECT mint, "feeShareBps", ticker, volume24h FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL'
            );

            // Split into eligible (above volume threshold) and below-threshold for logging
            const robinhoodTokens = allActiveRobinhoodTokens.filter(t => (parseFloat(t.volume24h) || 0) >= MIN_VOLUME_USD);
            const robinhoodMints = robinhoodTokens.map(t => t.mint).filter(m => m);

            const belowVolumeTokens = allActiveRobinhoodTokens.filter(t => (parseFloat(t.volume24h) || 0) < MIN_VOLUME_USD);
            if (belowVolumeTokens.length > 0) {
                const belowVolumeList = belowVolumeTokens.map(t => `${t.ticker || t.mint.slice(0, 8)}($${(parseFloat(t.volume24h) || 0).toFixed(0)})`).join(', ');
                logger.info(`[HolderScanner] Robinhood tokens below volume threshold ($${MIN_VOLUME_USD}): ${belowVolumeList}`);
            }

            logger.info(`[HolderScanner] Robinhood: ${allActiveRobinhoodTokens.length} total active, ${robinhoodMints.length} with volume >= $${MIN_VOLUME_USD}`);

            if (robinhoodMints.length > 0) {
                // v26.1: BATCH - single query for all robinhood token holders (replaces N per-token queries)
                const allRhHolderRows = await db.all(
                    `SELECT "holderPubkey", balance, mint FROM robinhood_token_holders WHERE mint = ANY($1) ORDER BY mint, rank ASC`,
                    [robinhoodMints]
                );
                const rhHoldersByMint = new Map();
                for (const row of allRhHolderRows) {
                    if (!rhHoldersByMint.has(row.mint)) rhHoldersByMint.set(row.mint, []);
                    rhHoldersByMint.get(row.mint).push(row);
                }
                logger.debug(`[HolderScanner] Robinhood: loaded ${allRhHolderRows.length} holder rows for ${robinhoodMints.length} tokens`);

                // v26.2: Points = pure supply ownership, no volume/feeShare scaling
                for (const rhToken of robinhoodTokens) {
                    if (!rhToken.mint) continue;

                    const holders = rhHoldersByMint.get(rhToken.mint) || [];
                    if (holders.length === 0) {
                        logger.debug(`[HolderScanner] Robinhood token ${rhToken.ticker || rhToken.mint.slice(0, 8)} has 0 holders in tracking table`);
                        continue;
                    }

                    let tokenPointsDistributed = 0;
                    for (const holder of holders) {
                        const holderBalance = BigInt(holder.balance || '0');
                        if (holderBalance === BigInt(0)) continue;

                        const proportionalPoints = Number((holderBalance * BigInt(BASE_POINTS_PER_TOKEN * 1000)) / PUMP_FUN_TOTAL_SUPPLY) / 1000;

                        const entry = rawPointsMap.get(holder.holderPubkey) || {
                            basePoints: 0,
                            robinhoodPoints: 0,
                            positionsCount: 0
                        };
                        entry.robinhoodPoints += proportionalPoints;
                        entry.positionsCount++;
                        rawPointsMap.set(holder.holderPubkey, entry);

                        tokenPointsDistributed += proportionalPoints;
                        robinhoodHoldersWithPoints++;
                    }
                    robinhoodPointsTotal += tokenPointsDistributed;

                    logger.debug(`[HolderScanner] Robinhood ${rhToken.ticker || rhToken.mint.slice(0, 8)}: ${holders.length} holders, ${tokenPointsDistributed.toFixed(2)} points`);
                }

                logger.info(`[HolderScanner] Robinhood points: ${robinhoodPointsTotal.toFixed(2)} total across ${robinhoodHoldersWithPoints} holder positions`);
            }
        } catch (e) {
            logger.error('[HolderScanner] Robinhood holder points calculation error', { error: e.message });
        }

        // Fetch ASDF Top 100 holders from Redis (single source of truth)
        // globalState.asdfTop50Holders may be empty if asdfSync.start() was never called
        const asdfTop100Holders = await redis.getAsdfTop100Holders();
        logger.info(`[HolderScanner] ASDF Top 100: ${asdfTop100Holders.size} holders loaded from Redis`);

        // Calculate final points including ASDF multiplier
        for (const [pubkey, data] of rawPointsMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;

            // CHECK ASDF MULTIPLIER (Top 100)
            const isAsdfTop100 = asdfTop100Holders.has(pubkey);

            // Total base points from all sources (v23.0: removed creatorBonus)
            const basePoints = data.basePoints + data.robinhoodPoints;
            const totalPoints = basePoints * (isAsdfTop100 ? 2 : 1);

            if (totalPoints > 0) {
                tempTotalPoints += totalPoints;
            }
        }

        globalState.totalPoints = tempTotalPoints;
        globalState.communityPot = 0; // v26.0: Deprecated - per-token pools replace global pooling
        globalState.kothPot = 0; // v26.0: KOTH is now informational only
        logger.info(`[HolderScanner] Global Points: ${globalState.totalPoints.toFixed(2)}`);

        // v26.1: Build per-user expected airdrop using ASDF-weighted formula
        // ASDF Top 100 holders receive 2× weight in actual airdrop distribution
        // Expected = sum over tokens of (distributable * effectiveBal / totalEffectiveBal)
        const userExpectedAirdropMap = new Map();
        let totalPendingAirdropLamports = 0;
        try {
            const pendingRows = await db.all(`
                SELECT mint, pending_airdrop_lamports, 'platform' as source FROM tokens WHERE pending_airdrop_lamports > 0
                UNION ALL
                SELECT mint, pending_airdrop_lamports, 'robinhood' as source FROM robinhood_tokens WHERE pending_airdrop_lamports > 0 AND "isActive" = 1
            `);

            // BATCH: fetch all holders for pending tokens in 2 queries (one per table)
            const platformPendingMints = pendingRows.filter(r => r.source === 'platform').map(r => r.mint);
            const robinhoodPendingMints = pendingRows.filter(r => r.source === 'robinhood').map(r => r.mint);
            const pendingByMint = new Map(pendingRows.map(r => [r.mint, r]));

            const [platformPendingHolders, robinhoodPendingHolders] = await Promise.all([
                platformPendingMints.length > 0
                    ? db.all(`SELECT "holderPubkey", balance, mint FROM token_holders WHERE mint = ANY($1)`, [platformPendingMints])
                    : [],
                robinhoodPendingMints.length > 0
                    ? db.all(`SELECT "holderPubkey", balance, mint FROM robinhood_token_holders WHERE mint = ANY($1)`, [robinhoodPendingMints])
                    : []
            ]);

            // Group holders by mint
            const holdersByMint = new Map();
            for (const h of [...platformPendingHolders, ...robinhoodPendingHolders]) {
                if (!holdersByMint.has(h.mint)) holdersByMint.set(h.mint, []);
                holdersByMint.get(h.mint).push(h);
            }

            for (const row of pendingRows) {
                const pendingLamports = BigInt(row.pending_airdrop_lamports || 0);
                if (pendingLamports === BigInt(0)) continue;
                totalPendingAirdropLamports += Number(pendingLamports);
                const distributable = pendingLamports * BigInt(99) / BigInt(100);
                const holders = holdersByMint.get(row.mint) || [];

                // Compute weighted totals — ASDF Top 100 get 2× effective balance
                const weightedHolders = holders.map(h => {
                    const bal = BigInt(h.balance || '0');
                    const weight = asdfTop100Holders.has(h.holderPubkey) ? BigInt(2) : BigInt(1);
                    return { holderPubkey: h.holderPubkey, balance: bal, effectiveBal: bal * weight };
                });
                const totalEffectiveBal = weightedHolders.reduce((sum, h) => sum + h.effectiveBal, BigInt(0));
                if (totalEffectiveBal === BigInt(0)) continue;

                for (const h of weightedHolders) {
                    if (h.balance === BigInt(0)) continue;
                    const expectedLamports = Number(distributable * h.effectiveBal / totalEffectiveBal);
                    const prev = userExpectedAirdropMap.get(h.holderPubkey) || 0;
                    userExpectedAirdropMap.set(h.holderPubkey, prev + expectedLamports / LAMPORTS_PER_SOL);
                }
            }
            globalState.availableSolForAirdrop = totalPendingAirdropLamports / LAMPORTS_PER_SOL;
            logger.info(`[HolderScanner] Per-token expected airdrops (ASDF-weighted): ${userExpectedAirdropMap.size} users, total pending: ${globalState.availableSolForAirdrop.toFixed(4)} SOL`);
        } catch (e) {
            logger.error('[HolderScanner] Failed to compute per-token expected airdrops', { error: e.message });
            globalState.availableSolForAirdrop = 0;
        }

        // v27.0: Add each user's expected share from the central pool, tracked separately for UI breakdown
        const centralPoolExpectedMap = new Map(); // pubkey -> central pool expected SOL
        try {
            const centralPoolRow = await db.get("SELECT value FROM stats WHERE key = 'centralPoolLamports'");
            const centralPoolLamports = Number(centralPoolRow?.value || 0);

            if (centralPoolLamports > 0) {
                // Fetch all eligible tokens (platform + robinhood) with volume
                const cpPlatform = await db.all(
                    'SELECT mint, volume24h FROM tokens WHERE volume24h >= $1',
                    [MIN_VOLUME_USD]
                );
                const cpRobinhood = await db.all(
                    'SELECT mint, volume24h FROM robinhood_tokens WHERE "isActive" = 1 AND volume24h >= $1',
                    [MIN_VOLUME_USD]
                );
                const cpAllEligible = [...cpPlatform, ...cpRobinhood];
                const cpTotalVol = cpAllEligible.reduce((s, t) => s + (parseFloat(t.volume24h) || 0), 0);

                if (cpTotalVol > 0 && cpAllEligible.length > 0) {
                    const cpVolByMint = new Map(cpAllEligible.map(t => [t.mint, parseFloat(t.volume24h) || 0]));
                    const cpPlatformMints = cpPlatform.map(t => t.mint).filter(Boolean);
                    const cpRobinhoodMints = cpRobinhood.map(t => t.mint).filter(Boolean);

                    const [cpPlatformHolders, cpRobinhoodHolders] = await Promise.all([
                        cpPlatformMints.length > 0
                            ? db.all('SELECT "holderPubkey", balance, mint FROM token_holders WHERE mint = ANY($1)', [cpPlatformMints])
                            : [],
                        cpRobinhoodMints.length > 0
                            ? db.all('SELECT "holderPubkey", balance, mint FROM robinhood_token_holders WHERE mint = ANY($1)', [cpRobinhoodMints])
                            : []
                    ]);

                    // Build volume-weighted score per user
                    const cpN = cpAllEligible.length;
                    const cpUserScores = new Map();
                    for (const h of [...cpPlatformHolders, ...cpRobinhoodHolders]) {
                        const vol = cpVolByMint.get(h.mint) || 0;
                        const balance = BigInt(h.balance || '0');
                        if (balance === BigInt(0)) continue;
                        const PUMP_SUPPLY = BigInt('1000000000000000');
                        // ±50% volume scaling matching central pool distribution formula
                        const volMultiplier = Math.min(1.5, Math.max(0.5, 0.5 + (vol / cpTotalVol) * cpN * 0.5));
                        const balanceRatio = Number(balance * BigInt(1e9) / PUMP_SUPPLY) / 1e9;
                        const contribution = balanceRatio * volMultiplier;
                        if (contribution > 0) {
                            cpUserScores.set(h.holderPubkey, (cpUserScores.get(h.holderPubkey) || 0) + contribution);
                        }
                    }

                    const cpTotalScore = Array.from(cpUserScores.values()).reduce((s, v) => s + v, 0);
                    if (cpTotalScore > 0) {
                        const cpDistributable = centralPoolLamports * 0.99;
                        for (const [pubkey, score] of cpUserScores.entries()) {
                            if (pubkey === devKeypair.publicKey.toString()) continue;
                            const expectedCentralSol = (cpDistributable * score / cpTotalScore) / LAMPORTS_PER_SOL;
                            centralPoolExpectedMap.set(pubkey, expectedCentralSol);
                            const prev = userExpectedAirdropMap.get(pubkey) || 0;
                            userExpectedAirdropMap.set(pubkey, prev + expectedCentralSol);
                        }
                        globalState.availableSolForAirdrop += centralPoolLamports / LAMPORTS_PER_SOL;
                        logger.info(`[HolderScanner] Central pool expected airdrops: ${cpUserScores.size} users, pending: ${(centralPoolLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
                    }
                }
            }
        } catch (cpErr) {
            logger.error('[HolderScanner] Failed to compute central pool expected airdrops', { error: cpErr.message });
        }

        // Update expected airdrops and points map
        globalState.userExpectedAirdrops.clear();
        globalState.userPointsMap.clear();

        const userPointsData = [];
        for (const [pubkey, data] of rawPointsMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;

            const isAsdfTop100 = asdfTop100Holders.has(pubkey);
            const multiplier = isAsdfTop100 ? 2 : 1;
            const basePoints = data.basePoints + data.robinhoodPoints;
            const points = basePoints * multiplier;

            if (points > 0) {
                globalState.userPointsMap.set(pubkey, points);

                // v26.0: Expected airdrop is the sum of per-token shares from pending pools
                const expected = userExpectedAirdropMap.get(pubkey) || 0;

                globalState.userExpectedAirdrops.set(pubkey, expected);

                userPointsData.push({
                    pubkey,
                    basePoints: data.basePoints,
                    robinhoodPoints: data.robinhoodPoints,
                    multiplier,
                    totalPoints: points,
                    expectedAirdropSol: expected,
                    centralPoolExpectedSol: centralPoolExpectedMap.get(pubkey) || 0,
                    positionsCount: data.positionsCount || 0,
                    isAsdfHolder: isAsdfTop100
                });
            }
        }

        // v26.0: Include users with expected airdrops but zero points (e.g. token holders of pending tokens with no eligible volume)
        for (const [pubkey, expected] of userExpectedAirdropMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;
            if (!globalState.userExpectedAirdrops.has(pubkey) && expected > 0) {
                globalState.userExpectedAirdrops.set(pubkey, expected);
                userPointsData.push({
                    pubkey,
                    basePoints: 0,
                    robinhoodPoints: 0,
                    multiplier: 1,
                    totalPoints: 0,
                    expectedAirdropSol: expected,
                    centralPoolExpectedSol: centralPoolExpectedMap.get(pubkey) || 0,
                    positionsCount: 0,
                    isAsdfHolder: false
                });
            }
        }

        // v25.110: CRITICAL FIX - Sync points and expected airdrops to Redis
        // The setter on globalState only triggers when assigning a new Map, not when using .set()
        // This ensures airdrop distribution reads fresh data from Redis
        try {
            await redis.setTotalPoints(globalState.totalPoints);
            await redis.setAllUserPoints(globalState.userPointsMap);
            await redis.setAllUserExpectedAirdrops(globalState.userExpectedAirdrops);
            logger.info(`[HolderScanner] Synced to Redis: ${globalState.userPointsMap.size} users, ${globalState.totalPoints.toFixed(2)} total points`);
        } catch (redisErr) {
            logger.error('[HolderScanner] Failed to sync to Redis', { error: redisErr.message });
        }

        // Write to user_points table (matches workers.js - single source of truth for check-holder API)
        // C-5 FIX: Run UPSERT first, DELETE stale rows AFTER — eliminates the empty-data window
        // where readers see zero points between the old DELETE and the new inserts.
        const now = Date.now();
        try {
            const BATCH_SIZE = 100;
            for (let i = 0; i < userPointsData.length; i += BATCH_SIZE) {
                const batch = userPointsData.slice(i, i + BATCH_SIZE);
                const values = batch.map((_, idx) => {
                    const base = idx * 10;
                    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
                }).join(', ');
                const params = batch.flatMap(u => [
                    u.pubkey, u.basePoints, u.robinhoodPoints, u.multiplier,
                    u.totalPoints, u.expectedAirdropSol, u.positionsCount, u.isAsdfHolder, now,
                    u.centralPoolExpectedSol || 0
                ]);
                await db.run(`
                    INSERT INTO user_points (pubkey, base_points, robinhood_points, multiplier, total_points, expected_airdrop_sol, positions_count, is_asdf_holder, updated_at, central_pool_expected_sol)
                    VALUES ${values}
                    ON CONFLICT (pubkey) DO UPDATE SET
                        base_points = EXCLUDED.base_points, robinhood_points = EXCLUDED.robinhood_points,
                        multiplier = EXCLUDED.multiplier, total_points = EXCLUDED.total_points,
                        expected_airdrop_sol = EXCLUDED.expected_airdrop_sol, positions_count = EXCLUDED.positions_count,
                        is_asdf_holder = EXCLUDED.is_asdf_holder, updated_at = EXCLUDED.updated_at,
                        central_pool_expected_sol = EXCLUDED.central_pool_expected_sol
                `, params);
            }
            // Delete genuinely stale rows (holders who weren't updated in this scan) AFTER fresh data is written
            await db.run('DELETE FROM user_points WHERE updated_at < $1 OR updated_at IS NULL', [now - 3600000]);
            logger.info(`[HolderScanner] Wrote ${userPointsData.length} users to user_points table`);
        } catch (dbErr) {
            logger.error('[HolderScanner] Failed to write user_points table', { error: dbErr.message });
        }

        return { scanCompleted: true };
    } catch (e) {
        logger.error("Holder scanner error", { error: e.message });
        return { scanCompleted: false, error: e.message };
    } finally {
        // v25.22: Always release mutex
        if (release) release();
    }
}

/**
 * Start the holder scanner interval
 */
function start(deps) {
    setInterval(() => updateGlobalState(deps), config.HOLDER_UPDATE_INTERVAL);
    setTimeout(() => updateGlobalState(deps), 5000);
    logger.info("Holder scanner started");
}

module.exports = { updateGlobalState, start };
