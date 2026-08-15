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
const { logger, mutex, postgres, redis, pump } = require('../services');
const { fetchTokenAccountsHeliusDAS } = require('../services/heliusDAS');

// v25.22 SCALABILITY: Mutex to prevent overlapping holder scans
const holderScannerMutex = mutex.getMutex('holder_scanner');

// v25.20: RPC retry configuration
const RPC_MAX_RETRIES = 3;
const RPC_BASE_DELAY_MS = 1000;

// v25.22 SCALABILITY: RPC batching configuration
const RPC_PARALLEL_BATCH_SIZE = 5; // Process 5 tokens in parallel

/**
 * v27.3: Detect the "too many accounts" getProgramAccounts error, which is deterministic
 * (retrying without narrowing the query will fail identically every time) and should
 * fall straight through to the Helius DAS fallback instead of being retried.
 */
function isTooManyAccountsError(e) {
    return !!(e?.message?.includes('Too many accounts') || e?.message?.includes('too many'));
}

/**
 * v25.20: Execute RPC call with exponential backoff retry
 * v27.3: Accepts an optional shouldRetry predicate so callers can opt out of retrying
 * errors that are known to be non-transient (e.g. "Too many accounts").
 */
async function withRetry(fn, context = 'RPC call', shouldRetry = () => true) {
    let lastError;
    for (let attempt = 0; attempt < RPC_MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            if (!shouldRetry(e)) {
                logger.debug(`[HolderScanner] ${context} failed with non-retryable error, skipping remaining retries`, { error: e.message });
                throw e;
            }
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

// Token program cache: avoids querying the wrong SPL program after first successful scan
// Saves ~50% of getProgramAccounts RPC calls once warmed up.
// v27.5 EFFICIENCY: A mint's SPL program (Token vs Token-2022) is fixed permanently at
// creation — Solana has no mechanism to migrate a mint between programs after the fact.
// The old 2h TTL was re-querying BOTH programs for EVERY eligible token every 2 hours
// forever, doubling that scan's getProgramAccounts calls (the most expensive Helius call
// type) for an answer that can never change. Use a long TTL purely as a self-healing
// safety net (e.g. recovering from a bad cache entry), not as a real "recheck" — 30 days
// effectively eliminates the recurring cost while still bounding staleness.
const tokenProgramCache = new Map(); // mint -> 'TOKEN' | 'TOKEN_2022' | 'BOTH'
const tokenProgramConfirmedAt = new Map(); // mint -> timestamp
const PROGRAM_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days (safety net only — this never actually changes)

// Periodic cleanup to prevent unbounded growth if tokens churn
setInterval(() => {
    const cutoff = Date.now() - PROGRAM_CACHE_TTL * 3;
    for (const [mint, ts] of tokenProgramConfirmedAt) {
        if (ts < cutoff) {
            tokenProgramCache.delete(mint);
            tokenProgramConfirmedAt.delete(mint);
        }
    }
}, 6 * 60 * 60 * 1000); // Run every 6 hours

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

        // v27.3: Cache dev wallet PUMP holdings in Redis for the stats API.
        // This used to live in workers.js's now-removed duplicate holder scanner.
        try {
            const devPumpAta = await getAssociatedTokenAddress(
                TOKENS.PUMP, devKeypair.publicKey, false, PROGRAMS.TOKEN_2022
            );
            const tokenBal = await connection.getTokenAccountBalance(devPumpAta);
            await redis.setDevPumpHoldings(tokenBal.value.uiAmount || 0);
        } catch (e) {
            // Non-critical — leave the last cached value in Redis (it has its own TTL)
            logger.debug('[HolderScanner] Failed to fetch dev PUMP holdings', { error: e.message });
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
        // C-1: Process tokens in parallel batches of RPC_PARALLEL_BATCH_SIZE (5) with 200ms between batches
        const tokenBatches = [];
        for (let i = 0; i < eligibleTokens.length; i += RPC_PARALLEL_BATCH_SIZE) {
            tokenBatches.push(eligibleTokens.slice(i, i + RPC_PARALLEL_BATCH_SIZE));
        }

        async function processToken(token) {
            try {
                if (!token.mint) return;

                const tokenMintPublicKey = new PublicKey(token.mint);
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
                    PROGRAMS.PUMP
                );

                const holdersToInsert = [];
                const bondingCurvePDAStr = bondingCurvePDA.toString();
                // Exclude the Pump AMM pool PDA — after graduation, pool holds tokens as LP
                const ammPoolStr = pump.getPumpAmmPDAs(tokenMintPublicKey).pool.toString();
                const threshold = new BN(1000000); // Minimum balance threshold (dust filter)
                let scanSucceeded = false;
                let usedFallback = false;

                try {
                    // Use program cache to skip querying the wrong SPL program (~50% RPC savings once warmed)
                    // Cache expires every 2h so program changes are eventually detected
                    const cachedProg = tokenProgramCache.get(token.mint);
                    const cacheAge = Date.now() - (tokenProgramConfirmedAt.get(token.mint) || 0);
                    const validCache = cachedProg && cacheAge < PROGRAM_CACHE_TTL;
                    const queryPrograms = [];
                    if (!validCache || cachedProg === 'TOKEN' || cachedProg === 'BOTH') queryPrograms.push('TOKEN');
                    if (!validCache || cachedProg === 'TOKEN_2022' || cachedProg === 'BOTH') queryPrograms.push('TOKEN_2022');

                    const rawResults = await Promise.allSettled(queryPrograms.map(prog =>
                        withRetry(
                            () => connection.getProgramAccounts(prog === 'TOKEN' ? PROGRAMS.TOKEN : PROGRAMS.TOKEN_2022, {
                                filters: prog === 'TOKEN'
                                    ? [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: token.mint } }]
                                    : [{ memcmp: { offset: 0, bytes: token.mint } }],
                                encoding: 'base64'
                            }),
                            `getProgramAccounts(${prog}) for ${token.mint.slice(0, 8)}`,
                            // v27.3: "Too many accounts" is deterministic — don't burn retries on it,
                            // fall straight through to the Helius DAS fallback below.
                            (e) => !isTooManyAccountsError(e)
                        )
                    ));

                    const getProgResult = (prog) => {
                        const idx = queryPrograms.indexOf(prog);
                        if (idx === -1) return { accounts: [], rejected: false, reason: null };
                        const r = rawResults[idx];
                        return { accounts: r.status === 'fulfilled' ? r.value : [], rejected: r.status === 'rejected', reason: r.reason };
                    };
                    const tokenRes = getProgResult('TOKEN');
                    const t2022Res = getProgResult('TOKEN_2022');
                    let tokenAccounts = tokenRes.accounts;
                    let token2022Accounts = t2022Res.accounts;

                    if (tokenRes.rejected) logger.debug(`[HolderScanner] TOKEN query failed for ${token.mint.slice(0, 8)}: ${tokenRes.reason?.message}`);
                    if (t2022Res.rejected) logger.debug(`[HolderScanner] TOKEN_2022 query failed for ${token.mint.slice(0, 8)}: ${t2022Res.reason?.message}`);

                    // Detect "too many accounts" from settled results to trigger DAS fallback
                    const isTooMany = (r) => r.rejected && isTooManyAccountsError(r.reason);
                    const tooManyToken = isTooMany(tokenRes);
                    const tooManyToken2022 = isTooMany(t2022Res);
                    if (tooManyToken || tooManyToken2022) {
                        logger.debug(`[HolderScanner] ${token.ticker || token.mint.slice(0, 8)} has too many holders, using Helius DAS API`);
                        usedFallback = true;
                        tokenAccounts = [];
                        token2022Accounts = [];
                    }

                    // Update program cache only when querying both programs AND both returned without error.
                    // Transient RPC failures must not poison the cache (e.g. TOKEN fails → wrongly cached as TOKEN_2022-only).
                    if (queryPrograms.length === 2 && !tokenRes.rejected && !t2022Res.rejected && !tooManyToken && !tooManyToken2022) {
                        const hasToken = tokenAccounts.length > 0;
                        const hasT2022 = token2022Accounts.length > 0;
                        if (hasToken || hasT2022) {
                            tokenProgramCache.set(token.mint, hasToken && hasT2022 ? 'BOTH' : hasToken ? 'TOKEN' : 'TOKEN_2022');
                            tokenProgramConfirmedAt.set(token.mint, Date.now());
                        }
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

                        if (acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== bondingCurvePDAStr && acc.owner !== ammPoolStr) {
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
                                return bal.gt(threshold) && acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== bondingCurvePDAStr && acc.owner !== ammPoolStr;
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
                    return;
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
        } // end processToken()

        for (const batch of tokenBatches) {
            await Promise.allSettled(batch.map(processToken));
            await new Promise(r => setTimeout(r, 200)); // 200ms between batches (was 2s per token)
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
            // H-6: DB-side aggregation — GROUP BY eliminates loading all rows into Node.js
            const platformAggRows = await db.all(
                `SELECT "holderPubkey",
                    SUM((balance::bigint * 1000)::numeric / 1000000000000000) AS "basePoints",
                    COUNT(*) AS "positionsCount"
                 FROM token_holders WHERE mint = ANY($1) AND balance > '0'
                 GROUP BY "holderPubkey"`,
                [eligibleMints]
            );
            logger.debug(`[HolderScanner] Platform: aggregated ${platformAggRows.length} unique holders from ${eligibleMints.length} tokens`);
            for (const row of platformAggRows) {
                rawPointsMap.set(row.holderPubkey, {
                    basePoints: parseFloat(row.basePoints) || 0,
                    robinhoodPoints: 0,
                    positionsCount: parseInt(row.positionsCount) || 0
                });
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
                // H-6: DB-side aggregation for robinhood holders
                const robinhoodAggRows = await db.all(
                    `SELECT "holderPubkey",
                        SUM((balance::bigint * 1000)::numeric / 1000000000000000) AS "robinhoodPoints",
                        COUNT(*) AS "positionsCount"
                     FROM robinhood_token_holders WHERE mint = ANY($1) AND balance > '0'
                     GROUP BY "holderPubkey"`,
                    [robinhoodMints]
                );
                logger.debug(`[HolderScanner] Robinhood: aggregated ${robinhoodAggRows.length} unique holders from ${robinhoodMints.length} tokens`);
                for (const row of robinhoodAggRows) {
                    const pts = parseFloat(row.robinhoodPoints) || 0;
                    const existing = rawPointsMap.get(row.holderPubkey);
                    if (existing) {
                        existing.robinhoodPoints += pts;
                        existing.positionsCount += parseInt(row.positionsCount) || 0;
                    } else {
                        rawPointsMap.set(row.holderPubkey, { basePoints: 0, robinhoodPoints: pts, positionsCount: parseInt(row.positionsCount) || 0 });
                    }
                    robinhoodPointsTotal += pts;
                }
                robinhoodHoldersWithPoints = robinhoodAggRows.length;
                logger.info(`[HolderScanner] Robinhood points: ${robinhoodPointsTotal.toFixed(2)} total across ${robinhoodHoldersWithPoints} unique holders`);
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

        // v27.1: Build per-user expected airdrop using ASDF + ANSEM weighted formula
        // ASDF Top 100 and ANSEM Top 1000 each receive 2× weight (4× if holding both)
        const ansemTop1000Holders = await redis.getAnsemTop1000Holders().catch(() => new Set());

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

                // ASDF Top 100 and ANSEM Top 1000 each get 2× effective balance (4× if both)
                const weightedHolders = holders.map(h => {
                    const bal = BigInt(h.balance || '0');
                    const asdfMult  = asdfTop100Holders.has(h.holderPubkey)   ? BigInt(2) : BigInt(1);
                    const ansemMult = ansemTop1000Holders.has(h.holderPubkey) ? BigInt(2) : BigInt(1);
                    return { holderPubkey: h.holderPubkey, balance: bal, effectiveBal: bal * asdfMult * ansemMult };
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
            logger.info(`[HolderScanner] Per-token expected airdrops (ASDF+ANSEM weighted): ${userExpectedAirdropMap.size} users, total pending: ${globalState.availableSolForAirdrop.toFixed(4)} SOL`);
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
                // Fetch all eligible tokens (platform + robinhood) with market cap
                const cpPlatform = await db.all(
                    'SELECT mint, "marketCap" as mcap FROM tokens WHERE volume24h >= $1',
                    [MIN_VOLUME_USD]
                );
                const cpRobinhood = await db.all(
                    'SELECT mint, "marketCap" as mcap FROM robinhood_tokens WHERE "isActive" = 1 AND volume24h >= $1',
                    [MIN_VOLUME_USD]
                );
                const cpAllEligible = [...cpPlatform, ...cpRobinhood];
                const cpTotalMcap = cpAllEligible.reduce((s, t) => s + (parseFloat(t.mcap) || 0), 0);

                if (cpTotalMcap > 0 && cpAllEligible.length > 0) {
                    const cpMcapByMint = new Map(cpAllEligible.map(t => [t.mint, parseFloat(t.mcap) || 0]));
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

                    // Build mcap-weighted score per user, with ASDF Top 100 and ANSEM Top 1000 2× bonus
                    const cpN = cpAllEligible.length;
                    const cpUserScores = new Map();
                    for (const h of [...cpPlatformHolders, ...cpRobinhoodHolders]) {
                        const mcap    = cpMcapByMint.get(h.mint) || 0;
                        const balance = BigInt(h.balance || '0');
                        if (balance === BigInt(0)) continue;
                        const PUMP_SUPPLY = BigInt('1000000000000000');
                        // ±50% mcap scaling matching actual distribution formula
                        const mcapMultiplier = Math.min(1.5, Math.max(0.5, 0.5 + (mcap / cpTotalMcap) * cpN * 0.5));
                        const balanceRatio   = Number(balance * BigInt(1e9) / PUMP_SUPPLY) / 1e9;
                        const asdfMult       = asdfTop100Holders.has(h.holderPubkey)   ? 2 : 1;
                        const ansemMult      = ansemTop1000Holders.has(h.holderPubkey) ? 2 : 1;
                        const contribution   = balanceRatio * mcapMultiplier * asdfMult * ansemMult;
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
