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
const { BN } = require('@coral-xyz/anchor');
const axios = require('axios');
const config = require('../config/env');
const { PROGRAMS, WALLETS } = require('../config/constants');
const { logger, mutex, redis, pump } = require('../services');
const { fetchTokenAccountsHeliusDAS } = require('../services/heliusDAS');
const { payableSet } = require('../services/recipientFilter');

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

// v27.5 EFFICIENCY: Tiered scan cadence — the top N tokens by volume (the ones most likely
// to actually have holder churn between cycles) get scanned every run (HOLDER_UPDATE_INTERVAL,
// default 5min). Everything else is still recalculated into points/airdrops every run using
// whatever holder data is already in the DB, but its on-chain getProgramAccounts rescan is
// throttled to once per SLOW_TIER_RESCAN_MS — cutting RPC volume for the long tail of
// low-volume eligible tokens without staling out the tokens that matter most.
// v30.2 RPC: the fast tier is now "about to be paid" rather than "most traded". Holder lists
// only move money at airdrop time; everywhere else they feed UI estimates, which do not need
// five-minute freshness. So a token is rescanned every cycle only when its pool is at least
// half way to the payout threshold (plus the top few by volume, so the busiest coins' UI
// stays current); everything else rescans every SLOW_TIER_RESCAN_MS. processTokenAirdrops
// additionally forces a fresh scan of exactly the tokens it is about to pay.
const FAST_TIER_SIZE = 5; // top N tokens by 24h volume scanned every cycle
const FAST_TIER_POOL_FRACTION = 0.5; // ...and any token whose pool is this close to paying out
const SLOW_TIER_RESCAN_MS = 30 * 60 * 1000; // 30 minutes

// v27.5 EFFICIENCY: On top of the tier cadence, skip the rescan entirely (regardless of tier)
// when a token's 24h volume hasn't moved at all since its last scan — zero volume change means
// no swaps happened, so a rescan can only return the same holder balances already on file.
// INACTIVE_TOKEN_FORCE_RESCAN_MS is a safety net that forces a rescan periodically anyway, in
// case holders moved via a non-swap transfer or volume tracking itself lagged.
const INACTIVE_TOKEN_FORCE_RESCAN_MS = 2 * 60 * 60 * 1000; // 2 hours
const lastScannedAt = new Map(); // mint -> timestamp of last actual on-chain holder rescan
const lastScannedVolume = new Map(); // mint -> volume24h at time of last on-chain holder rescan

// v27.5 EFFICIENCY: Once a token is confirmed to have too many holders for getProgramAccounts
// (a deterministic, response-size-limit failure — see isTooManyAccountsError), skip straight to
// the Helius DAS fallback on future scans instead of re-attempting a call that's certain to fail
// identically every time. Rechecked periodically in case the holder count ever drops back under
// the limit (and self-heals immediately the moment a real attempt succeeds — see processToken).
const knownTooManyAccounts = new Map(); // mint -> timestamp of last confirmed "too many accounts"
const TOO_MANY_ACCOUNTS_RECHECK_MS = 24 * 60 * 60 * 1000; // 1 day

// Periodic cleanup so tokens that drop out of eligibility don't leak memory forever
setInterval(() => {
    const cutoff = Date.now() - SLOW_TIER_RESCAN_MS * 6;
    for (const [mint, ts] of lastScannedAt) {
        if (ts < cutoff) {
            lastScannedAt.delete(mint);
            lastScannedVolume.delete(mint);
        }
    }
    const tooManyCutoff = Date.now() - TOO_MANY_ACCOUNTS_RECHECK_MS * 3;
    for (const [mint, ts] of knownTooManyAccounts) {
        if (ts < tooManyCutoff) knownTooManyAccounts.delete(mint);
    }
}, 60 * 60 * 1000); // Run hourly

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
async function updateGlobalState(deps, opts = {}) {
    const { connection, devKeypair, db, globalState } = deps;
    // v30.2: `forceMints` are rescanned regardless of the throttles below -- the airdrop passes
    // the tokens it is about to pay, and it passes `wait` so that a scan already in flight
    // delays the payout instead of letting it proceed on stale holder data.
    const forceMints = new Set(opts.forceMints || []);

    // v25.22 SCALABILITY: Prevent overlapping holder scans
    // C-1 FIX: Return { scanCompleted: false } so callers know whether fresh data was written
    let release = null;
    if (opts.wait) {
        try {
            release = await holderScannerMutex.acquire(10 * 60 * 1000, 20 * 60 * 1000);
        } catch (e) {
            release = null;
        }
    } else {
        release = await holderScannerMutex.tryAcquire(20 * 60 * 1000);
    }
    if (!release) {
        logger.info('[HolderScanner] Skipping - previous scan still in progress');
        return { scanCompleted: false, skipped: true };
    }

    try {
        // v18.0: Get all tokens with >$100 24hr volume (no limit)
        // v25.4: Include volume24h for dynamic volume weighting
        // v30.2: also every token with a pending pool, whatever its volume -- those are the
        // tokens that can actually be paid, so their holder lists must exist and be current.
        const eligibleTokens = await db.all(
            `SELECT mint, "userPubkey", volume24h, ticker, quote_mint,
                    COALESCE(pending_airdrop_lamports, 0) AS pending_airdrop_lamports
               FROM tokens
              WHERE volume24h >= $1 OR pending_airdrop_lamports > 0
              ORDER BY volume24h DESC NULLS LAST`,
            [MIN_VOLUME_USD]
        );
        const eligibleMints = eligibleTokens
            .filter(t => (parseFloat(t.volume24h) || 0) >= MIN_VOLUME_USD)
            .map(t => t.mint);

        const payoutThreshold = Math.round((config.TOKEN_AIRDROP_THRESHOLD_SOL || 1) * LAMPORTS_PER_SOL);
        const fastTierMints = new Set([
            ...eligibleTokens.slice(0, FAST_TIER_SIZE).map(t => t.mint),
            ...eligibleTokens
                .filter(t => Number(t.pending_airdrop_lamports) >= payoutThreshold * FAST_TIER_POOL_FRACTION)
                .map(t => t.mint),
            ...forceMints,
        ]);

        logger.info(`[HolderScanner] Found ${eligibleTokens.length} eligible tokens with >${MIN_VOLUME_USD} USD volume`);

        // v30.2: the wallet balance is published for /api/health, which used to fetch it
        // itself on every cache refresh. The PUMP-token holdings lookup that sat here fed a
        // feature that no longer exists and cost an RPC call every scan, so it is gone.
        try {
            const solBalance = await connection.getBalance(devKeypair.publicKey);
            globalState.devSolBalance = solBalance / LAMPORTS_PER_SOL;
            await redis.setPlatformSnapshot({ walletBalanceLamports: solBalance });
        } catch (e) {
            logger.debug('[HolderScanner] Wallet balance lookup failed', { error: e.message });
        }

        // 2. Identify KOTH Token (for expected airdrop calculation)
        // v25.112: Read AI-selected KOTH from Redis (set by flywheel) to match actual distribution
        // Falls back to highest market cap if Redis data unavailable
        let kothToken = null;
        try {
            const redisConn = redis.getConnection();
            if (redisConn) {
                const kothData = await redisConn.get('koth_ai_selection');
                if (kothData) {
                    const parsed = JSON.parse(kothData);
                    if (parsed.mint) {
                        kothToken = await db.get('SELECT mint, "userPubkey" FROM tokens WHERE mint = $1', [parsed.mint]);
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

                // v27.5 EFFICIENCY: Two independent throttles on the on-chain rescan, both just
                // skip the RPC call and leave existing token_holders rows in place — the
                // points/airdrop calculation below reads whatever's in the DB regardless of how
                // recently it was refreshed, so this only trades a bit of staleness on
                // low-volume/inactive tokens for a real cut in RPC volume:
                //  1. Slow-tier tokens (everything outside the top FAST_TIER_SIZE by volume)
                //     only rescan once per SLOW_TIER_RESCAN_MS.
                //  2. Any token (regardless of tier) whose 24h volume hasn't changed since its
                //     last scan is skipped until INACTIVE_TOKEN_FORCE_RESCAN_MS has passed —
                //     zero volume change means no swaps, so holder balances can't have moved.
                const lastScan = lastScannedAt.get(token.mint) || 0;
                const timeSinceLastScan = Date.now() - lastScan;
                const isFastTier = fastTierMints.has(token.mint);
                const forced = forceMints.has(token.mint);

                if (!forced && !isFastTier && timeSinceLastScan < SLOW_TIER_RESCAN_MS) {
                    return;
                }

                const lastVolume = lastScannedVolume.get(token.mint);
                const volumeUnchanged = lastScan > 0 && lastVolume === token.volume24h;
                if (!forced && volumeUnchanged && timeSinceLastScan < INACTIVE_TOKEN_FORCE_RESCAN_MS) {
                    return;
                }

                const tokenMintPublicKey = new PublicKey(token.mint);
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
                    PROGRAMS.PUMP
                );

                const holdersToInsert = [];
                const bondingCurvePDAStr = bondingCurvePDA.toString();
                // Exclude the Pump AMM pool PDA — after graduation, pool holds tokens as LP.
                // v30.2: keyed on the coin's own quote asset (Custom Pairs), and derived through
                // the SDK; the old derivation never matched a real pool.
                const ammPoolStr = pump.getPumpAmmPDAs(tokenMintPublicKey, token.quote_mint).pool.toString();
                const devWalletStr = devKeypair.publicKey.toString();
                const isExcludedOwner = (owner) =>
                    owner === WALLETS.PUMP_LIQUIDITY || owner === bondingCurvePDAStr ||
                    owner === ammPoolStr || owner === devWalletStr;
                // Candidates are taken with headroom over TOP_HOLDERS_LIMIT because some will be
                // dropped by the payable-owner check below.
                const CANDIDATE_LIMIT = TOP_HOLDERS_LIMIT + 50;
                const threshold = new BN(1000000); // Minimum balance threshold (dust filter)
                let scanSucceeded = false;
                let usedFallback = false;

                try {
                    // v27.5 EFFICIENCY: If a previous scan already confirmed this token has too
                    // many holders for getProgramAccounts to return, skip straight to the DAS
                    // fallback instead of re-attempting (and re-paying for) a call that's
                    // deterministically certain to fail identically. Rechecked periodically in
                    // case the holder count ever drops back under the RPC response-size limit.
                    const knownTooManyTs = knownTooManyAccounts.get(token.mint);
                    const skipToFallback = knownTooManyTs && (Date.now() - knownTooManyTs) < TOO_MANY_ACCOUNTS_RECHECK_MS;

                    let tokenAccounts = [];
                    let token2022Accounts = [];

                    if (skipToFallback) {
                        logger.debug(`[HolderScanner] ${token.ticker || token.mint.slice(0, 8)} known to have too many holders (cached), skipping getProgramAccounts`);
                        usedFallback = true;
                    } else {
                        // Use program cache to skip querying the wrong SPL program (~50% RPC savings once warmed)
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
                        tokenAccounts = tokenRes.accounts;
                        token2022Accounts = t2022Res.accounts;

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
                            knownTooManyAccounts.set(token.mint, Date.now());
                        } else if (queryPrograms.length === 2 && !tokenRes.rejected && !t2022Res.rejected) {
                            // Real attempt succeeded without hitting the limit — holder count is
                            // back under it, so clear any stale "too many accounts" cache entry
                            // immediately instead of waiting for TOO_MANY_ACCOUNTS_RECHECK_MS.
                            knownTooManyAccounts.delete(token.mint);
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
                        if (holdersToInsert.length >= CANDIDATE_LIMIT) break;
                        if (acc.amount.lte(threshold)) continue;

                        if (!isExcludedOwner(acc.owner)) {
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
                                return bal.gt(threshold) && !isExcludedOwner(acc.owner);
                            })
                            .sort((a, b) => {
                                const balA = new BN(a.balance);
                                const balB = new BN(b.balance);
                                return balB.cmp(balA);
                            })
                            .slice(0, CANDIDATE_LIMIT);

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

                // v30.2: keep only owners that can actually receive SOL. A token account can be
                // owned by a program -- a pool, a vault, a locker -- and SOL paid to one is
                // stranded. Dropping them here, rather than only at payout time, also keeps them
                // out of every share's denominator, so real holders' shares are not diluted.
                if (holdersToInsert.length > 0) {
                    const payable = await payableSet(connection, holdersToInsert.map(h => h.owner));
                    const before = holdersToInsert.length;
                    const kept = holdersToInsert.filter(h => payable.has(h.owner)).slice(0, TOP_HOLDERS_LIMIT);
                    if (kept.length < Math.min(before, TOP_HOLDERS_LIMIT)) {
                        logger.debug(`[HolderScanner] ${token.ticker || token.mint.slice(0, 8)}: dropped non-payable owners`, {
                            candidates: before, kept: kept.length
                        });
                    }
                    holdersToInsert.length = 0;
                    holdersToInsert.push(...kept);
                }

                // v27.5: Record a successful on-chain rescan so the throttles above measure
                // from the last time we actually fetched fresh holder data, not just the last
                // time this function ran.
                lastScannedAt.set(token.mint, Date.now());
                lastScannedVolume.set(token.mint, token.volume24h);

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
                        // v30.2: one multi-row INSERT instead of one statement per holder (up to
                        // 250 round-trips per token per scan). Owners are de-duplicated first:
                        // one wallet can hold several token accounts of the same mint, and a
                        // single INSERT may not touch the same conflict key twice.
                        const seenOwners = new Set();
                        const rows = holdersToInsert.filter(h => !seenOwners.has(h.owner) && seenOwners.add(h.owner));
                        const now = Date.now();
                        await db.transaction(async (tx) => {
                            await tx.run('DELETE FROM token_holders WHERE mint = $1', [token.mint]);
                            const values = rows.map((_, i) =>
                                `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(', ');
                            const params = rows.flatMap((h, i) => [h.mint, h.owner, i + 1, h.balance, now]);
                            await tx.run(
                                `INSERT INTO token_holders (mint, "holderPubkey", rank, balance, "lastUpdated") VALUES ${values}
                                 ON CONFLICT (mint, "holderPubkey") DO UPDATE SET rank = EXCLUDED.rank, balance = EXCLUDED.balance, "lastUpdated" = EXCLUDED."lastUpdated"`,
                                params
                            );
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

        // v26.2: Points = pure supply ownership — (balance / 1B supply) × BASE_POINTS_PER_TOKEN
        // Volume weight and feeShareBps removed: per-token pools already embed those economics.
        const BASE_POINTS_PER_TOKEN = 1000;
        let rawPointsMap = new Map(); // pubkey -> { basePoints, positionsCount }
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
                    positionsCount: parseInt(row.positionsCount) || 0
                });
            }
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
            const basePoints = data.basePoints;
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
                SELECT mint, pending_airdrop_lamports FROM tokens WHERE pending_airdrop_lamports > 0
            `);

            // BATCH: fetch every pending token's holders in a single query
            const platformPendingMints = pendingRows.map(r => r.mint).filter(Boolean);

            const platformPendingHolders = platformPendingMints.length > 0
                ? await db.all(`SELECT "holderPubkey", balance, mint FROM token_holders WHERE mint = ANY($1)`, [platformPendingMints])
                : [];

            // Group holders by mint
            const holdersByMint = new Map();
            for (const h of platformPendingHolders) {
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
                // Fetch every eligible platform token with market cap
                const cpPlatform = await db.all(
                    'SELECT mint, "marketCap" as mcap FROM tokens WHERE volume24h >= $1',
                    [MIN_VOLUME_USD]
                );
                const cpAllEligible = cpPlatform;
                const cpTotalMcap = cpAllEligible.reduce((s, t) => s + (parseFloat(t.mcap) || 0), 0);

                if (cpTotalMcap > 0 && cpAllEligible.length > 0) {
                    const cpMcapByMint = new Map(cpAllEligible.map(t => [t.mint, parseFloat(t.mcap) || 0]));
                    const cpPlatformMints = cpPlatform.map(t => t.mint).filter(Boolean);

                    const cpPlatformHolders = cpPlatformMints.length > 0
                        ? await db.all('SELECT "holderPubkey", balance, mint FROM token_holders WHERE mint = ANY($1)', [cpPlatformMints])
                        : [];

                    // Build mcap-weighted score per user, with ASDF Top 100 and ANSEM Top 1000 2× bonus
                    const cpN = cpAllEligible.length;
                    const cpUserScores = new Map();
                    for (const h of cpPlatformHolders) {
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
            const basePoints = data.basePoints;
            const points = basePoints * multiplier;

            if (points > 0) {
                globalState.userPointsMap.set(pubkey, points);

                // v26.0: Expected airdrop is the sum of per-token shares from pending pools
                const expected = userExpectedAirdropMap.get(pubkey) || 0;

                globalState.userExpectedAirdrops.set(pubkey, expected);

                userPointsData.push({
                    pubkey,
                    basePoints: data.basePoints,
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
                    const base = idx * 9;
                    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
                }).join(', ');
                const params = batch.flatMap(u => [
                    u.pubkey, u.basePoints, u.multiplier,
                    u.totalPoints, u.expectedAirdropSol, u.positionsCount, u.isAsdfHolder, now,
                    u.centralPoolExpectedSol || 0
                ]);
                await db.run(`
                    INSERT INTO user_points (pubkey, base_points, multiplier, total_points, expected_airdrop_sol, positions_count, is_asdf_holder, updated_at, central_pool_expected_sol)
                    VALUES ${values}
                    ON CONFLICT (pubkey) DO UPDATE SET
                        base_points = EXCLUDED.base_points,
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
