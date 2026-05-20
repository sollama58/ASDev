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

/**
 * v25.66: Fetch token accounts using Helius DAS API with pagination
 * v25.67: Fixed response parsing - handle both result wrapper and direct response
 * This handles tokens with many holders that exceed getProgramAccounts limits
 * @param {string} mint - Token mint address
 * @param {number} limit - Max accounts to fetch
 * @returns {Promise<Array<{owner: string, balance: string}>>}
 */
async function fetchTokenAccountsHeliusDAS(mint, limit = 250) {
    if (!config.HELIUS_API_KEY) {
        logger.warn('[HolderScanner] No HELIUS_API_KEY configured, cannot use DAS API fallback');
        return null;
    }

    const accounts = [];
    let page = 1;
    const pageSize = 100;

    try {
        while (accounts.length < limit) {
            const response = await axios.post(
                `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                {
                    jsonrpc: '2.0',
                    id: 'token-accounts',
                    method: 'getTokenAccounts',
                    params: {
                        mint: mint,
                        page: page,
                        limit: pageSize,
                        options: {
                            showZeroBalance: false
                        }
                    }
                },
                { timeout: 15000 }
            );

            // v25.67: Handle both wrapped (jsonrpc result) and direct response formats
            const result = response.data?.result || response.data;
            const tokenAccounts = result?.token_accounts || [];

            if (tokenAccounts.length === 0) {
                // v25.67: Log first page failure for debugging
                if (page === 1) {
                    logger.debug(`[HolderScanner] Helius DAS returned 0 accounts for ${mint.slice(0, 8)} (page 1)`, {
                        hasResult: !!response.data?.result,
                        directData: !!response.data?.token_accounts,
                        responseKeys: Object.keys(response.data || {}).slice(0, 5)
                    });
                }
                break;
            }

            for (const acc of tokenAccounts) {
                if (accounts.length >= limit) break;
                // v25.67: Handle amount as number or string, also check for tokenAmount nested structure
                const owner = acc.owner;
                const amount = acc.amount ?? acc.tokenAmount?.amount ?? acc.balance;

                if (owner && amount !== undefined && amount !== null && amount !== 0 && amount !== '0') {
                    accounts.push({
                        owner: owner,
                        balance: amount.toString()
                    });
                }
            }

            if (tokenAccounts.length < pageSize) {
                break;
            }

            page++;
            await new Promise(r => setTimeout(r, 100));
        }

        // v25.67: Log success for debugging
        if (accounts.length > 0) {
            logger.debug(`[HolderScanner] Helius DAS found ${accounts.length} accounts for ${mint.slice(0, 8)}`);
        }

        return accounts;
    } catch (e) {
        logger.warn(`[HolderScanner] Helius DAS API failed for ${mint.slice(0, 8)}: ${e.message}`);
        return null;
    }
}

// Constants for point calculation
const TOP_HOLDERS_LIMIT = 250; // Track top 250 holders per eligible token
const SAFETY_RESERVE_SOL = 0.1; // v25.78: Reserve 0.1 SOL for operations
const MIN_VOLUME_USD = config.AIRDROP_MIN_VOLUME_USD || 100; // v18.0: Minimum 24hr volume for eligibility

// v25.4: Volume weight range (min multiplier to max multiplier)
const VOLUME_WEIGHT_MIN = 0.1;  // Lowest volume token gets 0.1x base points
const VOLUME_WEIGHT_MAX = 5.0;  // Highest volume token gets 5.0x base points

// v25.36: Pump.fun standard total supply (1 billion tokens with 6 decimals)
// All pump.fun tokens have fixed 1B supply - use this for accurate % of supply calculation
const PUMP_FUN_TOTAL_SUPPLY = BigInt('1000000000000000'); // 1B tokens * 10^6 decimals

/**
 * v25.4: Calculate dynamic volume weight for a token
 * Uses logarithmic scaling relative to the volume range of all eligible tokens
 * @param {number} tokenVolume - This token's 24hr volume
 * @param {number} minVolume - Minimum volume among eligible tokens
 * @param {number} maxVolume - Maximum volume among eligible tokens
 * @returns {number} Weight multiplier between VOLUME_WEIGHT_MIN and VOLUME_WEIGHT_MAX
 */
function calculateVolumeWeight(tokenVolume, minVolume, maxVolume) {
    // Edge case: all tokens have same volume
    if (maxVolume <= minVolume || minVolume <= 0) {
        return 1.0; // Default to 1x if no range
    }

    // Use log scale to prevent extreme tokens from dominating
    const logMin = Math.log10(minVolume);
    const logMax = Math.log10(maxVolume);
    const logVolume = Math.log10(Math.max(tokenVolume, minVolume));

    // Normalize to 0-1 range based on log position
    const normalized = (logVolume - logMin) / (logMax - logMin);

    // Scale to weight range
    const weight = VOLUME_WEIGHT_MIN + (normalized * (VOLUME_WEIGHT_MAX - VOLUME_WEIGHT_MIN));

    return Math.max(VOLUME_WEIGHT_MIN, Math.min(VOLUME_WEIGHT_MAX, weight));
}

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

        // v25.4: Calculate COMBINED volume range across all sources for dynamic weighting
        // Must match frontend leaderboard which uses a single combined range for all tokens
        const combinedVolumeRange = await db.get(`
            SELECT MIN(vol) as min_vol, MAX(vol) as max_vol FROM (
                SELECT volume24h as vol FROM tokens WHERE volume24h >= $1
                UNION ALL
                SELECT volume24h as vol FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL AND volume24h >= $1
            ) combined`, [MIN_VOLUME_USD]
        );
        const globalMinVolume = parseFloat(combinedVolumeRange?.min_vol) || MIN_VOLUME_USD;
        const globalMaxVolume = parseFloat(combinedVolumeRange?.max_vol) || MIN_VOLUME_USD;

        logger.info(`[HolderScanner] Found ${eligibleTokens.length} eligible tokens with >${MIN_VOLUME_USD} USD volume (combined range: $${globalMinVolume.toFixed(0)} - $${globalMaxVolume.toFixed(0)})`);

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
                    const dasAccounts = await fetchTokenAccountsHeliusDAS(token.mint, TOP_HOLDERS_LIMIT);

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

        // v14.0: Calculate global points with proportional holdings
        // v25.4: Points are now volume-weighted - higher volume tokens distribute more points
        // Base points = 1000, scaled by volume weight (0.5x to 2.0x based on relative volume)
        // v23.0: Removed creator bonus - all holders earn same points proportionally
        const BASE_POINTS_PER_TOKEN = 1000;
        let rawPointsMap = new Map(); // pubkey -> { basePoints, robinhoodPoints }
        let tempTotalPoints = 0;

        if (eligibleMints.length > 0) {
            // v25.4: For each eligible token, calculate volume-weighted proportional points
            for (const token of eligibleTokens) {
                if (!token.mint) continue;

                // v25.4: Calculate volume weight for this token (0.5x to 2.0x)
                const tokenVolume = parseFloat(token.volume24h) || MIN_VOLUME_USD;
                const volumeWeight = calculateVolumeWeight(tokenVolume, globalMinVolume, globalMaxVolume);
                const weightedPointsForToken = BASE_POINTS_PER_TOKEN * volumeWeight;

                // Get all holders with balances for this token
                const holders = await db.all(
                    'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC',
                    [token.mint]
                );

                if (holders.length === 0) continue;

                // v25.36: Distribute points based on % of TOTAL SUPPLY, not % of tracked holders
                for (const holder of holders) {
                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance === BigInt(0)) continue;

                    // v25.36: Calculate points based on % of total supply (1B tokens)
                    // If user holds 1% of total supply, they get 1% of the token's weighted points
                    const proportionalPoints = Number((holderBalance * BigInt(Math.round(weightedPointsForToken * 1000))) / PUMP_FUN_TOTAL_SUPPLY) / 1000;

                    // Accumulate points
                    const entry = rawPointsMap.get(holder.holderPubkey) || {
                        basePoints: 0,
                        robinhoodPoints: 0,
                        positionsCount: 0
                    };

                    entry.basePoints += proportionalPoints;
                    entry.positionsCount++;
                    rawPointsMap.set(holder.holderPubkey, entry);
                }

                logger.debug(`[HolderScanner] ${token.mint.slice(0, 8)}: Vol $${tokenVolume.toFixed(0)} -> ${volumeWeight.toFixed(2)}x weight -> ${weightedPointsForToken.toFixed(0)} points`);
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
            // v25.64: First check total active Robinhood tokens (before volume filter)
            const totalRobinhoodTokens = await db.get(
                'SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL'
            );

            // v25.67: Get all active tokens to show which ones are below volume threshold
            const allActiveRobinhoodTokens = await db.all(
                'SELECT mint, ticker, volume24h FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL'
            );

            const robinhoodTokens = await db.all(
                'SELECT mint, "feeShareBps", ticker, volume24h FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL AND volume24h >= $1',
                [MIN_VOLUME_USD]
            );
            const robinhoodMints = robinhoodTokens.map(t => t.mint).filter(m => m);

            // v25.67: Log tokens that are active but below volume threshold
            const belowVolumeTokens = allActiveRobinhoodTokens.filter(t => (parseFloat(t.volume24h) || 0) < MIN_VOLUME_USD);
            if (belowVolumeTokens.length > 0) {
                const belowVolumeList = belowVolumeTokens.map(t => `${t.ticker || t.mint.slice(0, 8)}($${(parseFloat(t.volume24h) || 0).toFixed(0)})`).join(', ');
                logger.info(`[HolderScanner] Robinhood tokens below volume threshold ($${MIN_VOLUME_USD}): ${belowVolumeList}`);
            }

            // v25.64: Enhanced logging to debug Robinhood token eligibility issues
            // Volume range uses combined global range (computed above) to match frontend leaderboard
            logger.info(`[HolderScanner] Robinhood: ${totalRobinhoodTokens?.count || 0} total active, ${robinhoodMints.length} with volume >= $${MIN_VOLUME_USD} (using combined range: $${globalMinVolume.toFixed(0)} - $${globalMaxVolume.toFixed(0)})`);

            // v25.67: Also check holder counts for eligible tokens
            if (robinhoodMints.length > 0) {
                for (const rhToken of robinhoodTokens) {
                    const holderCount = await db.get(
                        'SELECT COUNT(*) as count FROM robinhood_token_holders WHERE mint = $1',
                        [rhToken.mint]
                    );
                    if ((holderCount?.count || 0) === 0) {
                        logger.warn(`[HolderScanner] Robinhood ${rhToken.ticker || rhToken.mint.slice(0, 8)} has volume $${(parseFloat(rhToken.volume24h) || 0).toFixed(0)} but 0 holders in DB`);
                    }
                }
            }

            if (robinhoodMints.length > 0) {
                // For each robinhood token, calculate volume-weighted proportional points scaled by fee share
                for (const rhToken of robinhoodTokens) {
                    if (!rhToken.mint) continue;

                    // v25.4: Calculate volume weight for this Robinhood token
                    const tokenVolume = parseFloat(rhToken.volume24h) || MIN_VOLUME_USD;
                    const volumeWeight = calculateVolumeWeight(tokenVolume, globalMinVolume, globalMaxVolume);
                    const weightedBasePoints = BASE_POINTS_PER_TOKEN * volumeWeight;

                    // Get fee share multiplier (100% = 10000 bps = 1.0 multiplier)
                    // C-3 FIX: Use ?? not || — feeShareBps=0 is falsy and must NOT default to 10000
                    const feeShareBps = rhToken.feeShareBps ?? 10000;
                    const feeShareMultiplier = feeShareBps / 10000; // Convert BPS to decimal (1000 bps = 0.1 = 10%)

                    const holders = await db.all(
                        'SELECT "holderPubkey", balance FROM robinhood_token_holders WHERE mint = $1 ORDER BY rank ASC',
                        [rhToken.mint]
                    );

                    // v25.64: Log when a token has no holders in the tracking table
                    if (holders.length === 0) {
                        logger.debug(`[HolderScanner] Robinhood token ${rhToken.ticker || rhToken.mint.slice(0, 8)} has 0 holders in tracking table`);
                        continue;
                    }

                    // v25.36: Distribute points based on % of TOTAL SUPPLY, scaled by fee share
                    let tokenPointsDistributed = 0;
                    for (const holder of holders) {
                        const holderBalance = BigInt(holder.balance || '0');
                        if (holderBalance === BigInt(0)) continue;

                        // v25.36: Calculate points based on % of total supply (1B tokens)
                        const baseProportionalPoints = Number((holderBalance * BigInt(Math.round(weightedBasePoints * 1000))) / PUMP_FUN_TOTAL_SUPPLY) / 1000;
                        // Scale by our fee share percentage (100% share = full points, 50% share = half points)
                        const scaledPoints = baseProportionalPoints * feeShareMultiplier;

                        const entry = rawPointsMap.get(holder.holderPubkey) || {
                            basePoints: 0,
                            robinhoodPoints: 0,
                            positionsCount: 0
                        };
                        entry.robinhoodPoints += scaledPoints;
                        entry.positionsCount++;
                        rawPointsMap.set(holder.holderPubkey, entry);

                        tokenPointsDistributed += scaledPoints;
                        robinhoodHoldersWithPoints++;
                    }
                    robinhoodPointsTotal += tokenPointsDistributed;

                    logger.debug(`[HolderScanner] Robinhood ${rhToken.ticker || rhToken.mint.slice(0, 8)}: ${holders.length} holders, ${tokenPointsDistributed.toFixed(2)} points distributed`);
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

        // v26.0: Build per-user expected airdrop from each token's pending_airdrop_lamports
        // Each user's expected = sum of (token.pending_airdrop_lamports * holder_balance / PUMP_FUN_TOTAL_SUPPLY)
        const userExpectedAirdropMap = new Map();
        let totalPendingAirdropLamports = 0;
        try {
            const pendingRows = await db.all(`
                SELECT mint, pending_airdrop_lamports, 'platform' as source FROM tokens WHERE pending_airdrop_lamports > 0
                UNION ALL
                SELECT mint, pending_airdrop_lamports, 'robinhood' as source FROM robinhood_tokens WHERE pending_airdrop_lamports > 0 AND "isActive" = 1
            `);
            for (const row of pendingRows) {
                const pendingLamports = BigInt(row.pending_airdrop_lamports || 0);
                if (pendingLamports === BigInt(0)) continue;
                totalPendingAirdropLamports += Number(pendingLamports);
                const holdersTable = row.source === 'robinhood' ? 'robinhood_token_holders' : 'token_holders';
                const holders = await db.all(`SELECT "holderPubkey", balance FROM ${holdersTable} WHERE mint = $1`, [row.mint]);
                for (const h of holders) {
                    const bal = BigInt(h.balance || '0');
                    if (bal === BigInt(0)) continue;
                    const expectedLamports = Number(pendingLamports * bal / PUMP_FUN_TOTAL_SUPPLY);
                    const prev = userExpectedAirdropMap.get(h.holderPubkey) || 0;
                    userExpectedAirdropMap.set(h.holderPubkey, prev + expectedLamports / LAMPORTS_PER_SOL);
                }
            }
            globalState.availableSolForAirdrop = totalPendingAirdropLamports / LAMPORTS_PER_SOL;
            logger.info(`[HolderScanner] Per-token expected airdrops: ${userExpectedAirdropMap.size} users, total pending: ${globalState.availableSolForAirdrop.toFixed(4)} SOL`);
        } catch (e) {
            logger.error('[HolderScanner] Failed to compute per-token expected airdrops', { error: e.message });
            globalState.availableSolForAirdrop = 0;
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
                    u.pubkey, u.basePoints, u.robinhoodPoints, u.multiplier,
                    u.totalPoints, u.expectedAirdropSol, u.positionsCount, u.isAsdfHolder, now
                ]);
                await db.run(`
                    INSERT INTO user_points (pubkey, base_points, robinhood_points, multiplier, total_points, expected_airdrop_sol, positions_count, is_asdf_holder, updated_at)
                    VALUES ${values}
                    ON CONFLICT (pubkey) DO UPDATE SET
                        base_points = EXCLUDED.base_points, robinhood_points = EXCLUDED.robinhood_points,
                        multiplier = EXCLUDED.multiplier, total_points = EXCLUDED.total_points,
                        expected_airdrop_sol = EXCLUDED.expected_airdrop_sol, positions_count = EXCLUDED.positions_count,
                        is_asdf_holder = EXCLUDED.is_asdf_holder, updated_at = EXCLUDED.updated_at
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
