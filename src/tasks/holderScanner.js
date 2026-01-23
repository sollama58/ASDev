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
 */
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { BN } = require('@coral-xyz/anchor');
const axios = require('axios');
const config = require('../config/env');
const { TOKENS, PROGRAMS, WALLETS } = require('../config/constants');
const { logger, mutex, postgres } = require('../services');

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

            const result = response.data?.result;
            if (!result || !result.token_accounts || result.token_accounts.length === 0) {
                break;
            }

            for (const acc of result.token_accounts) {
                if (accounts.length >= limit) break;
                if (acc.owner && acc.amount) {
                    accounts.push({
                        owner: acc.owner,
                        balance: acc.amount.toString()
                    });
                }
            }

            if (result.token_accounts.length < pageSize) {
                break;
            }

            page++;
            await new Promise(r => setTimeout(r, 100));
        }

        return accounts;
    } catch (e) {
        logger.warn(`[HolderScanner] Helius DAS API failed for ${mint.slice(0, 8)}: ${e.message}`);
        return null;
    }
}

// Constants for point calculation
const TOP_HOLDERS_LIMIT = 250; // Track top 250 holders per eligible token
const SAFETY_RESERVE_SOL = 0.5; // Reserve 0.5 SOL for operations
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
 * - KOTH: 10% of airdrop reserved for king token holders (unchanged)
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
 */
async function updateGlobalState(deps) {
    const { connection, devKeypair, db, globalState } = deps;

    // v25.22 SCALABILITY: Prevent overlapping holder scans
    // If previous scan still running, skip this one
    const release = await holderScannerMutex.tryAcquire();
    if (!release) {
        logger.info('[HolderScanner] Skipping - previous scan still in progress');
        return;
    }

    try {
        // v18.0: Get all tokens with >$100 24hr volume (no limit)
        // v25.4: Include volume24h for dynamic volume weighting
        // v25.63: Tokens can be in both platform AND PAGS (fee splitting allowed)
        const eligibleTokens = await db.all(
            'SELECT mint, userPubkey, volume24h FROM tokens WHERE volume24h >= $1 ORDER BY volume24h DESC',
            [MIN_VOLUME_USD]
        );
        const eligibleMints = eligibleTokens.map(t => t.mint);

        // v25.4: Calculate volume range for dynamic weighting
        let platformMinVolume = MIN_VOLUME_USD;
        let platformMaxVolume = MIN_VOLUME_USD;
        if (eligibleTokens.length > 0) {
            const volumes = eligibleTokens.map(t => parseFloat(t.volume24h) || MIN_VOLUME_USD);
            platformMinVolume = Math.min(...volumes);
            platformMaxVolume = Math.max(...volumes);
        }

        logger.info(`[HolderScanner] Found ${eligibleTokens.length} eligible tokens with >${MIN_VOLUME_USD} USD volume (range: $${platformMinVolume.toFixed(0)} - $${platformMaxVolume.toFixed(0)})`);

        // v17.0: Get actual SOL balance for expected airdrop calculation (not PUMP holdings)
        let availableSolForAirdrop = 0;
        try {
            const solBalance = await connection.getBalance(devKeypair.publicKey);
            // Available for airdrop = SOL balance minus safety reserve
            const safetyReserveLamports = SAFETY_RESERVE_SOL * LAMPORTS_PER_SOL;
            availableSolForAirdrop = Math.max(0, (solBalance - safetyReserveLamports) / LAMPORTS_PER_SOL);
            globalState.devSolBalance = solBalance / LAMPORTS_PER_SOL;
        } catch (e) {
            availableSolForAirdrop = 0;
            globalState.devSolBalance = 0;
        }

        // --- CALCULATION LOGIC ---

        // 1. Determine Pots (based on actual SOL available for airdrop)
        const totalDistributable = availableSolForAirdrop * 0.99; // 99% distributed, 1% dust buffer

        // KOTH gets 10% of the distributable amount
        const kothPot = totalDistributable * 0.10;

        // Community gets the remaining 90%
        const communityPot = totalDistributable * 0.90;

        // 2. Identify KOTH Token (for expected airdrop calculation)
        const kothToken = await db.get('SELECT mint, userPubkey FROM tokens ORDER BY "marketCap" DESC LIMIT 1');

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
                    // v25.20: Use retry logic for RPC calls
                    const accounts = await withRetry(
                        () => connection.getProgramAccounts(PROGRAMS.TOKEN_2022, {
                            filters: [
                                { memcmp: { offset: 0, bytes: token.mint } }
                            ],
                            encoding: 'base64'
                        }),
                        `getProgramAccounts for ${token.mint.slice(0, 8)}`
                    );

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
                    scanSucceeded = true;
                } catch (scanErr) {
                    // v25.66: Check if this is a "too many accounts" error - use Helius DAS API fallback
                    if (scanErr.message?.includes('Too many accounts') || scanErr.message?.includes('too many')) {
                        logger.debug(`[HolderScanner] ${token.ticker || token.mint.slice(0, 8)} has too many holders, using Helius DAS API`);
                        usedFallback = true;
                    } else {
                        logger.error(`Failed to scan holders for ${token.mint}`, { error: scanErr.message });
                    }
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

                // v25.20: PostgreSQL compatible - delete then insert (no explicit transaction needed for simple ops)
                try {
                    // v25.65: Only delete+insert if we got holders, or token is genuinely new with no holders
                    if (holdersToInsert.length > 0) {
                        await db.run('DELETE FROM token_holders WHERE mint = $1', [token.mint]);

                        let rank = 1;
                        for (const h of holdersToInsert) {
                            await db.run(
                                'INSERT INTO token_holders (mint, "holderPubkey", rank, balance, "lastUpdated") VALUES ($1, $2, $3, $4, $5) ON CONFLICT (mint, "holderPubkey") DO UPDATE SET rank = $3, balance = $4, "lastUpdated" = $5',
                                [h.mint, h.owner, rank, h.balance, Date.now()]
                            );
                            rank++;
                        }
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
                const volumeWeight = calculateVolumeWeight(tokenVolume, platformMinVolume, platformMaxVolume);
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
                        robinhoodPoints: 0
                    };

                    entry.basePoints += proportionalPoints;
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
        let robinhoodPointsTotal = 0;
        let robinhoodHoldersWithPoints = 0;
        try {
            // v25.64: First check total active Robinhood tokens (before volume filter)
            const totalRobinhoodTokens = await db.get(
                'SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL'
            );

            const robinhoodTokens = await db.all(
                'SELECT mint, "feeShareBps", ticker, volume24h FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL AND volume24h >= $1',
                [MIN_VOLUME_USD]
            );
            const robinhoodMints = robinhoodTokens.map(t => t.mint).filter(m => m);

            // v25.4: Calculate volume range for Robinhood tokens
            let rhMinVolume = MIN_VOLUME_USD;
            let rhMaxVolume = MIN_VOLUME_USD;
            if (robinhoodTokens.length > 0) {
                const rhVolumes = robinhoodTokens.map(t => parseFloat(t.volume24h) || MIN_VOLUME_USD);
                rhMinVolume = Math.min(...rhVolumes);
                rhMaxVolume = Math.max(...rhVolumes);
            }

            // v25.64: Enhanced logging to debug Robinhood token eligibility issues
            logger.info(`[HolderScanner] Robinhood: ${totalRobinhoodTokens?.count || 0} total active, ${robinhoodMints.length} with volume >= $${MIN_VOLUME_USD} (range: $${rhMinVolume.toFixed(0)} - $${rhMaxVolume.toFixed(0)})`);

            if (robinhoodMints.length > 0) {
                // For each robinhood token, calculate volume-weighted proportional points scaled by fee share
                for (const rhToken of robinhoodTokens) {
                    if (!rhToken.mint) continue;

                    // v25.4: Calculate volume weight for this Robinhood token
                    const tokenVolume = parseFloat(rhToken.volume24h) || MIN_VOLUME_USD;
                    const volumeWeight = calculateVolumeWeight(tokenVolume, rhMinVolume, rhMaxVolume);
                    const weightedBasePoints = BASE_POINTS_PER_TOKEN * volumeWeight;

                    // Get fee share multiplier (100% = 10000 bps = 1.0 multiplier)
                    const feeShareBps = rhToken.feeShareBps || 10000; // Default to 100% if not set
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
                            robinhoodPoints: 0
                        };
                        entry.robinhoodPoints += scaledPoints;
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

        // Calculate final points including ASDF multiplier
        for (const [pubkey, data] of rawPointsMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;

            // CHECK ASDF MULTIPLIER (Top 100)
            const isAsdfTop100 = globalState.asdfTop50Holders.has(pubkey);

            // Total base points from all sources (v23.0: removed creatorBonus)
            const basePoints = data.basePoints + data.robinhoodPoints;
            const totalPoints = basePoints * (isAsdfTop100 ? 2 : 1);

            if (totalPoints > 0) {
                tempTotalPoints += totalPoints;
            }
        }

        globalState.totalPoints = tempTotalPoints;
        globalState.availableSolForAirdrop = availableSolForAirdrop; // v17.0: Track available SOL
        globalState.communityPot = communityPot; // v19.0: Track community pot for debugging
        globalState.kothPot = kothPot; // v19.0: Track KOTH pot for debugging
        logger.info(`[HolderScanner] Global Points: ${globalState.totalPoints.toFixed(2)} | Available SOL: ${availableSolForAirdrop.toFixed(4)} | Community Pot: ${communityPot.toFixed(4)} SOL | KOTH Pot: ${kothPot.toFixed(4)} SOL`);

        // Update expected airdrops and points map
        globalState.userExpectedAirdrops.clear();
        globalState.userPointsMap.clear();

        // Get KOTH holders for expected airdrop calculation
        let kothHoldersMap = new Map(); // pubkey -> proportional share of KOTH pot
        if (kothToken && kothToken.mint) {
            const kothHolders = await db.all(
                'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1',
                [kothToken.mint]
            );

            let kothTotalBalance = BigInt(0);
            for (const h of kothHolders) {
                kothTotalBalance += BigInt(h.balance || '0');
            }

            if (kothTotalBalance > BigInt(0)) {
                for (const holder of kothHolders) {
                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance === BigInt(0)) continue;

                    const share = Number(holderBalance * BigInt(10000) / kothTotalBalance) / 10000;
                    kothHoldersMap.set(holder.holderPubkey, share * kothPot);
                }
            }
        }

        for (const [pubkey, data] of rawPointsMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;

            const isAsdfTop100 = globalState.asdfTop50Holders.has(pubkey);
            const basePoints = data.basePoints + data.robinhoodPoints;
            const points = basePoints * (isAsdfTop100 ? 2 : 1);

            if (points > 0) {
                globalState.userPointsMap.set(pubkey, points);

                let expected = 0;

                // Community share based on points
                if (communityPot > 0 && globalState.totalPoints > 0) {
                    const share = points / globalState.totalPoints;
                    expected = share * communityPot;
                }

                // Add KOTH bonus if applicable
                const kothBonus = kothHoldersMap.get(pubkey) || 0;
                expected += kothBonus;

                globalState.userExpectedAirdrops.set(pubkey, expected);
            }
        }

        // Edge Case: KOTH holders with 0 community points still get their KOTH share
        for (const [pubkey, kothShare] of kothHoldersMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;
            if (!globalState.userExpectedAirdrops.has(pubkey) && kothShare > 0) {
                globalState.userExpectedAirdrops.set(pubkey, kothShare);
            }
        }

    } catch (e) {
        logger.error("Holder scanner error", { error: e.message });
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
