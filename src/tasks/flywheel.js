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
 * This eliminates the need to fund token accounts (ATAs) for recipients
 */
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const {
    getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction, TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, PROGRAMS, WALLETS } = require('../config/constants');
const { logger, pump, solana, jupiter, redis, mutex, mintExtractor } = require('../services');

// RACE CONDITION FIX: Use mutex for atomic lock/unlock instead of boolean flags
const buybackMutex = mutex.getMutex('flywheel_buyback');
const airdropMutex = mutex.getMutex('flywheel_airdrop');

// Import Robinhood scanner for fee claiming
const robinhoodScanner = require('./robinhoodScanner');

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
// Transaction limit: ~1232 bytes, with overhead ~200 bytes = ~1032 bytes available
// Safe calculation: 1032 / 72 ≈ 14 transfers (conservative) to 1032 / 40 ≈ 25 (optimistic)
// Testing shows 25 transfers work reliably with priority fees
const AIRDROP_BATCH_SIZE = 25; // Increased from 21 for better throughput
const KOTH_BATCH_SIZE = 25; // Increased from 21 for consistency

/**
 * v25.21: Get fee sharing config with caching
 * Reduces RPC calls by caching parsed configs
 */
async function getCachedFeeSharingConfig(connection, sharingConfigPDA, creatorPubkey) {
    const cacheKey = creatorPubkey.toString();
    const cached = feeSharingConfigCache.get(cacheKey);

    // Return cached if fresh
    if (cached && (Date.now() - cached.timestamp) < CONFIG_CACHE_TTL_MS) {
        return cached.config;
    }

    // Fetch fresh config
    try {
        const configInfo = await connection.getAccountInfo(sharingConfigPDA);
        if (configInfo && configInfo.data) {
            const configData = robinhoodScanner.parseFeeSharingConfig(configInfo.data, sharingConfigPDA);
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
                const { bcVault, ammVaultAuth, ammVaultAta, sharingConfigPDA } = pump.getShareholderFeeVaults(creatorPubkey);

                let tokenClaimed = 0;

                // v25.19 FIX: Read the fee_sharing_config account to get all shareholders
                // The distribute_creator_fees instruction requires ALL shareholders as accounts
                // v25.21: Use cached config to reduce RPC calls
                try {
                    // Check if there are fees to distribute first
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    const pendingLamports = bcInfo ? bcInfo.lamports - 5000 : 0; // Subtract rent-exempt minimum

                    if (pendingLamports > 0) {
                        // v25.21: Use cached fee_sharing_config to reduce RPC calls
                        const configData = await getCachedFeeSharingConfig(connection, sharingConfigPDA, creatorPubkey);

                        if (configData && configData.shareholders && configData.shareholders.length > 0) {
                                const tx = new Transaction();
                                solana.addPriorityFee(tx);

                                const distributeDiscriminator = pump.buildDistributeFeesData();
                                const [eventAuthority] = PublicKey.findProgramAddressSync(
                                    [Buffer.from("__event_authority")], PROGRAMS.PUMP
                                );

                                // Build distribute instruction with ALL shareholders
                                // Account order: sharing_config, creator_vault, [all shareholders...], system_program, event_authority, program
                                const distributeKeys = [
                                    { pubkey: sharingConfigPDA, isSigner: false, isWritable: true },
                                    { pubkey: bcVault, isSigner: false, isWritable: true },
                                ];

                                // Add ALL shareholders as writable accounts (they receive the distribution)
                                for (const shareholder of configData.shareholders) {
                                    distributeKeys.push({
                                        pubkey: shareholder.pubkey,
                                        isSigner: false,
                                        isWritable: true
                                    });
                                }

                                // Add system accounts
                                distributeKeys.push(
                                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                                    { pubkey: eventAuthority, isSigner: false, isWritable: false },
                                    { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false }
                                );

                                tx.add(new TransactionInstruction({
                                    keys: distributeKeys,
                                    programId: PROGRAMS.PUMP,
                                    data: distributeDiscriminator
                                }));

                                // Calculate our share based on feeShareBps
                                const ourShare = Math.floor(pendingLamports * (token.feeShareBps / 10000));
                                tokenClaimed = ourShare;

                                // Execute the distribution transaction
                                try {
                                    tx.feePayer = devKeypair.publicKey;
                                    await solana.sendTxWithRetry(tx, [devKeypair]);

                                    totalClaimed += tokenClaimed;
                                    claimedTokens.push({
                                        ticker: token.ticker || token.creatorPubkey.slice(0, 8),
                                        amount: tokenClaimed
                                    });

                                    // Update token stats
                                    await db.run(
                                        'UPDATE robinhood_tokens SET "lastFeesClaimed" = $1, "totalFeesCollected" = "totalFeesCollected" + $2 WHERE id = $3',
                                        [Date.now(), tokenClaimed / LAMPORTS_PER_SOL, token.id]
                                    );

                                    logger.info(`[Robinhood] Distributed fees from ${token.ticker || 'Unknown'}: ${(tokenClaimed / LAMPORTS_PER_SOL).toFixed(6)} SOL (our share)`);
                                } catch (txErr) {
                                    logger.debug(`[Robinhood] Distribute tx failed for ${token.ticker || token.creatorPubkey}`, {
                                        error: txErr.message,
                                        shareholders: configData.shareholders.length
                                    });
                                }
                        } else {
                            logger.debug(`[Robinhood] No valid fee sharing config found for ${token.ticker || token.creatorPubkey}`);
                        }
                    }
                } catch (e) {
                    logger.debug(`[Robinhood] BC fee distribution failed for ${token.creatorPubkey}`, { error: e.message });
                }

                // Also check AMM vault for graduated tokens
                // Note: AMM fee distribution has a different instruction structure
                // v25.23: Enhanced monitoring with database tracking and alerts
                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                    const ammFeeLamports = parseInt(bal.value.amount) || 0;

                    if (ammFeeLamports > 0) {
                        const ammFeeSol = ammFeeLamports / LAMPORTS_PER_SOL;
                        const ourShare = ammFeeSol * (token.feeShareBps / 10000);

                        // Track total pending AMM fees
                        totalPendingAmmFees += ammFeeLamports;

                        // Log with more detail for monitoring
                        logger.info(`[Robinhood/AMM] Pending fees for ${token.ticker}: ${ammFeeSol.toFixed(6)} SOL (our share: ${ourShare.toFixed(6)} SOL @ ${token.feeShareBps/100}%)`);

                        // Update database with pending AMM fees for this token
                        await db.run(
                            'UPDATE robinhood_tokens SET "pendingAmmFees" = $1 WHERE mint = $2',
                            [ammFeeSol, token.mint]
                        ).catch(() => {}); // Don't fail if column doesn't exist yet
                    }
                } catch (e) {
                    logger.debug(`[Robinhood/AMM] Check failed for ${token.ticker}`, { error: e.message });
                }

                await new Promise(r => setTimeout(r, 500)); // Rate limiting between tokens

            } catch (e) {
                logger.error(`[Robinhood] Fee claim error for ${token.creatorPubkey}`, { error: e.message });
            }
        }
    } catch (e) {
        logger.error('[Robinhood] Claim fees error', { error: e.message });
    }

    // v25.23: AMM fee monitoring - alert if pending fees exceed threshold
    const pendingAmmSol = totalPendingAmmFees / LAMPORTS_PER_SOL;
    if (pendingAmmSol > AMM_FEE_ALERT_THRESHOLD_SOL) {
        const now = Date.now();
        // Only alert every 5 minutes to prevent spam
        if (now - lastAmmFeeAlert > AMM_FEE_MONITOR_INTERVAL_MS) {
            lastAmmFeeAlert = now;
            logger.warn(`[Robinhood/AMM] ALERT: ${pendingAmmSol.toFixed(4)} SOL in pending AMM fees cannot be claimed (awaiting Pump.fun AMM distribution instruction documentation)`);

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
            return { total: 0, updated: 0, deactivated: 0 };
        }

        const platformWallet = devKeypair.publicKey.toString();
        let updated = 0;
        let deactivated = 0;

        for (const token of tokens) {
            try {
                const verification = await mintExtractor.verifyFeeRecipient(
                    token.mint,
                    platformWallet,
                    connection
                );

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
                logger.debug(`[FeeShareRefresh] Error for ${token.mint}`, { error: e.message });
            }
        }

        if (updated > 0 || deactivated > 0) {
            logger.info(`[FeeShareRefresh] Complete: ${updated} updated, ${deactivated} deactivated out of ${tokens.length} tokens`);
        }

        return { total: tokens.length, updated, deactivated };
    } catch (e) {
        logger.error('[FeeShareRefresh] Error', { error: e.message });
        return { total: 0, updated: 0, deactivated: 0, error: e.message };
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

    try {
        // Get current SOL balance available for airdrop
        const solBalance = await connection.getBalance(devKeypair.publicKey);

        // Calculate airdrop pool: SOL balance minus safety reserve (0.5 SOL for operations)
        const SAFETY_RESERVE = 0.5 * LAMPORTS_PER_SOL;
        // v17.0: Minimum 1 SOL to trigger airdrop (configurable)
        const MIN_AIRDROP_POOL = (config.AIRDROP_THRESHOLD_SOL || 1.0) * LAMPORTS_PER_SOL;

        const availableForAirdrop = solBalance - SAFETY_RESERVE;

        // Basic Threshold Check - need at least MIN_AIRDROP_POOL SOL after reserve
        if (availableForAirdrop < MIN_AIRDROP_POOL) {
            logger.info(`[Airdrop] Below threshold: ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL available, need ${config.AIRDROP_THRESHOLD_SOL || 1.0} SOL`);
            return; // Lock will be released in finally block
        }

        logger.info(`SOL AIRDROP TRIGGERED: ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL available for distribution`);

        // v23.0: Refresh fee share BPS for all Robinhood tokens before calculating points
        // This ensures points reflect current on-chain reward percentages
        logger.info('[Airdrop] Refreshing fee share percentages before distribution...');
        await refreshAllFeeShares(deps);

        // v25.13: Verify Redis is connected before proceeding
        if (!redis.isRedisConnected()) {
            logger.error('[Airdrop] ABORTED: Redis not connected - cannot fetch user points safely');
            return;
        }

        // Total Amount to be distributed (99% of available pool)
        const totalDistributable = Math.floor(availableForAirdrop * 0.99);
        let kothAmount = 0;
        let communityAmount = totalDistributable;
        let kothTxSignature = null;

        // 1. Identify King of the Hill (Highest MCAP)
        // v25.22 SECURITY: Added minimum requirements to prevent KOTH manipulation
        // Token must have at least 10 holders and $1000 market cap to qualify
        const KOTH_MIN_HOLDERS = 10;
        const KOTH_MIN_MARKET_CAP = 1000; // $1000 USD
        const KOTH_MAX_PERCENT = 0.10; // 10% cap

        const kothToken = await db.get(
            'SELECT userPubkey, ticker, mint, "marketCap" FROM tokens WHERE "marketCap" >= $1 ORDER BY "marketCap" DESC LIMIT 1',
            [KOTH_MIN_MARKET_CAP]
        );

        // 2. Process KOTH Payout (10%) - v13.0: Now distributed to all holders of the king token
        // v25.22 SECURITY: Only process if token meets minimum requirements
        if (kothToken && kothToken.mint) {
            // Get all holders of the king token
            const kothHolders = await db.all(
                'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC',
                [kothToken.mint]
            );

            // v25.22 SECURITY: Require minimum holder count to prevent single-holder manipulation
            if (kothHolders && kothHolders.length >= KOTH_MIN_HOLDERS) {
                kothAmount = Math.floor(totalDistributable * KOTH_MAX_PERCENT);
                communityAmount = totalDistributable - kothAmount;

                logger.info(`👑 King of the Hill: ${kothToken.ticker} (MCAP: $${kothToken.marketCap?.toFixed(0) || 0}) - Distributing ${(kothAmount / LAMPORTS_PER_SOL).toFixed(2)} SOL to ${kothHolders.length} holders`);

                try {
                    // Calculate total balance for proportional distribution
                    const totalBalance = kothHolders.reduce((sum, h) => sum + BigInt(h.balance || '0'), BigInt(0));

                    // Build KOTH distribution batch (proportional to holdings)
                    const kothBatch = [];
                    for (const holder of kothHolders) {
                        try {
                            const holderBalance = BigInt(holder.balance || '0');
                            if (holderBalance <= BigInt(0)) continue;

                            // Calculate proportional share
                            // BUG FIX: Added check for kothHolders.length to prevent division by zero
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

                    // v25.22 SCALABILITY: Increased batch size
                    // Send KOTH distributions in batches
                    // v25.23: Use optimized batch size constant
                    let kothSignatures = [];
                    for (let i = 0; i < kothBatch.length; i += KOTH_BATCH_SIZE) {
                        const batch = kothBatch.slice(i, i + KOTH_BATCH_SIZE);
                        const sig = await sendSolAirdropBatch(batch, deps);
                        if (sig) {
                            kothSignatures.push(sig);
                        }
                        if (i + KOTH_BATCH_SIZE < kothBatch.length) {
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }

                    if (kothSignatures.length > 0) {
                        kothTxSignature = kothSignatures.join(',');
                        logger.info(`✅ KOTH Holder Payout Complete: ${kothSignatures.length} transactions sent to ${kothBatch.length} holders`);
                    } else {
                        logger.error("❌ KOTH Payout Failed - returning funds to community pool");
                        communityAmount += kothAmount;
                        kothAmount = 0;
                    }
                } catch (e) {
                    logger.error(`KOTH Logic Error: ${e.message}`);
                    communityAmount += kothAmount;
                    kothAmount = 0;
                }
            } else {
                // v25.22 SECURITY: Not enough holders (< KOTH_MIN_HOLDERS), skip KOTH to prevent manipulation
                logger.info(`👑 King of the Hill: ${kothToken.ticker} - Only ${kothHolders?.length || 0} holders (need ${KOTH_MIN_HOLDERS} min), skipping KOTH bonus`);
                // kothAmount stays 0, communityAmount stays totalDistributable
            }
        } else {
            // v25.22: No qualifying KOTH token found (none meets $1000 market cap minimum)
            logger.debug('[Airdrop] No KOTH token qualifies (needs $1000 min market cap)');
        }

        // 3. Process Community Distribution (Remaining 90%)
        // v13.0: Fetch from Redis for cross-process consistency
        const userPointsMap = await redis.getAllUserPoints();
        const totalPoints = await redis.getTotalPoints();

        const userPoints = Array.from(userPointsMap.entries())
            .map(([pubkey, points]) => ({ pubkey: new PublicKey(pubkey), points }))
            .filter(user => user.points > 0);

        if (totalPoints === 0 || userPoints.length === 0) {
            logger.warn('[Airdrop] No eligible users found (totalPoints=0 or no users with points). Skipping distribution.');
            return; // Lock will be released in finally block
        }

        // v25.13: Pre-calculate total distribution to validate against available balance
        let plannedDistribution = 0;
        const distributionPlan = [];
        for (const user of userPoints) {
            const share = Math.floor((communityAmount * user.points) / totalPoints);
            if (share > 0) {
                plannedDistribution += share;
                distributionPlan.push({ user: user.pubkey, amount: share, points: user.points });
            }
        }

        // Validate we're not trying to send more than available
        const totalPlannedWithKoth = plannedDistribution + kothAmount;
        if (totalPlannedWithKoth > availableForAirdrop) {
            logger.error(`[Airdrop] ABORTED: Planned distribution (${totalPlannedWithKoth / LAMPORTS_PER_SOL} SOL) exceeds available (${availableForAirdrop / LAMPORTS_PER_SOL} SOL)`);
            return;
        }

        // v25.22 SECURITY: RACE CONDITION FIX - Use atomic balance verification
        // Re-check balance right before distribution starts and require exact match or surplus
        const finalBalanceCheck = await connection.getBalance(devKeypair.publicKey);
        const finalAvailable = finalBalanceCheck - SAFETY_RESERVE;

        // v25.22: If balance decreased significantly since calculation, abort
        // Allow small variance (up to 0.01 SOL for tx fees that may have occurred)
        const BALANCE_TOLERANCE = 0.01 * LAMPORTS_PER_SOL;
        if (finalAvailable < totalPlannedWithKoth - BALANCE_TOLERANCE) {
            logger.error(`[Airdrop] ABORTED: Balance changed during preparation (race condition detected). Initial: ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL, Now: ${(finalAvailable / LAMPORTS_PER_SOL).toFixed(4)} SOL, Planned: ${(totalPlannedWithKoth / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            return;
        }

        // v25.22: If balance increased, recalculate with new balance (don't overspend original calculation)
        // We use the ORIGINAL planned amounts to prevent mid-airdrop manipulation
        if (finalAvailable > availableForAirdrop) {
            logger.info(`[Airdrop] Balance increased during preparation (${((finalAvailable - availableForAirdrop) / LAMPORTS_PER_SOL).toFixed(4)} SOL). Using original plan to prevent manipulation.`);
        }

        logger.info(`Distributing ${(communityAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL to ${distributionPlan.length} users (Community Pool)`);

        // v25.13: Generate unique airdrop ID for idempotency protection
        airdropId = `airdrop_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        // v25.13: Create pending airdrop record before distribution starts
        // This allows recovery if server crashes mid-airdrop
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

        // v25.22 SCALABILITY: Increased batch size and parallel processing
        // SOL transfers can handle more per batch since no ATA creation needed
        // Transaction size: ~80 bytes per transfer, limit ~1232 bytes = ~15 transfers safe
        // With optimized instruction packing: 21 transfers fit safely
        // v25.23: Use optimized batch size constant (AIRDROP_BATCH_SIZE = 25)
        const PARALLEL_BATCHES = 3; // Process 3 batches concurrently
        let allSignatures = [];

        // Add KOTH sig if it exists
        if (kothTxSignature) allSignatures.push(`KOTH:${kothTxSignature}`);

        let successfulBatches = 0;
        let failedBatches = 0;
        let failedUsers = []; // v25.13: Track failed recipients for potential retry

        // v25.22 SCALABILITY: Split distribution plan into batches
        // v25.23: Using optimized AIRDROP_BATCH_SIZE (25 transfers)
        const batches = [];
        for (let i = 0; i < distributionPlan.length; i += AIRDROP_BATCH_SIZE) {
            batches.push(distributionPlan.slice(i, i + AIRDROP_BATCH_SIZE).map(r => ({
                user: r.user,
                amount: r.amount
            })));
        }

        // v25.22 SCALABILITY: Process batches in parallel groups
        for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
            const parallelGroup = batches.slice(i, i + PARALLEL_BATCHES);

            // Send all batches in this group concurrently
            const results = await Promise.allSettled(
                parallelGroup.map(batch => sendSolAirdropBatch(batch, deps))
            );

            // Process results
            results.forEach((result, idx) => {
                const batch = parallelGroup[idx];
                if (result.status === 'fulfilled' && result.value) {
                    allSignatures.push(result.value);
                    successfulBatches++;
                } else {
                    failedBatches++;
                    failedUsers.push(...batch.map(u => u.user.toString()));
                }
            });

            // Small delay between parallel groups to avoid overwhelming RPC
            if (i + PARALLEL_BATCHES < batches.length) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        // v25.13: Retry failed batches once before giving up
        // v25.22 SCALABILITY: Use parallel retry processing
        if (failedUsers.length > 0 && failedBatches > 0) {
            logger.info(`[Airdrop] Retrying ${failedUsers.length} users from ${failedBatches} failed batches...`);

            // Wait a bit before retrying
            await new Promise(r => setTimeout(r, 1000));

            // Rebuild failed batches from distribution plan
            const failedRecipients = distributionPlan.filter(r => failedUsers.includes(r.user.toString()));
            let retrySuccesses = 0;
            const stillFailedUsers = [];

            // v25.22 SCALABILITY: Split into batches for parallel retry
            // v25.23: Using optimized AIRDROP_BATCH_SIZE (25 transfers)
            const retryBatches = [];
            for (let i = 0; i < failedRecipients.length; i += AIRDROP_BATCH_SIZE) {
                retryBatches.push(failedRecipients.slice(i, i + AIRDROP_BATCH_SIZE).map(r => ({
                    user: r.user,
                    amount: r.amount
                })));
            }

            // Process retry batches in parallel (2 at a time for retries - more conservative)
            const PARALLEL_RETRIES = 2;
            for (let i = 0; i < retryBatches.length; i += PARALLEL_RETRIES) {
                const parallelGroup = retryBatches.slice(i, i + PARALLEL_RETRIES);

                const results = await Promise.allSettled(
                    parallelGroup.map(batch => sendSolAirdropBatch(batch, deps))
                );

                results.forEach((result, idx) => {
                    const batch = parallelGroup[idx];
                    if (result.status === 'fulfilled' && result.value) {
                        allSignatures.push(`RETRY:${result.value}`);
                        retrySuccesses++;
                        successfulBatches++;
                        failedBatches--;
                    } else {
                        stillFailedUsers.push(...batch.map(u => u.user.toString()));
                    }
                });

                // Longer delay between retry groups
                if (i + PARALLEL_RETRIES < retryBatches.length) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }

            if (retrySuccesses > 0) {
                logger.info(`[Airdrop] Retry recovered ${retrySuccesses} batches`);
            }
            if (stillFailedUsers.length > 0) {
                logger.error(`[Airdrop] PERMANENT FAILURES: ${stillFailedUsers.length} users could not receive airdrop: ${stillFailedUsers.slice(0, 5).join(', ')}${stillFailedUsers.length > 5 ? '...' : ''}`);
                // Update failedUsers to only contain permanently failed users
                failedUsers.length = 0;
                failedUsers.push(...stillFailedUsers);
            } else {
                failedUsers.length = 0; // All retries succeeded
            }
        }

        // Mark airdrop as successful (used for timestamp update logic)
        const airdropSucceeded = successfulBatches > 0 || failedBatches === 0;

        logger.info(`SOL Airdrop Complete. Success: ${successfulBatches}, Failed: ${failedBatches}`);

        // Log in SOL (convert from lamports for display)
        const totalDistributedSol = totalDistributable / LAMPORTS_PER_SOL;
        const kothAmountSol = kothAmount / LAMPORTS_PER_SOL;

        // v13.0: Track KOTH holder recipients count
        const kothHolderCount = kothToken?.mint ? (await db.get(
            'SELECT COUNT(*) as count FROM token_holders WHERE mint = $1',
            [kothToken.mint]
        ))?.count || 0 : 0;

        const details = JSON.stringify({
            id: airdropId, // v25.13: Include airdrop ID for tracking
            success: successfulBatches,
            failed: failedBatches,
            failedUsers: failedUsers.length > 0 ? failedUsers.slice(0, 20) : [], // v25.13: Track failed users (max 20)
            kothWinner: kothToken?.ticker || 'None',
            kothAmount: kothAmountSol,
            kothHolders: kothAmount > 0 ? kothHolderCount : 0, // v13.0: Number of KOTH holders who received
            currency: 'SOL', // Mark as SOL airdrop for backwards compatibility
            airdropSucceeded // v25.13: Track overall success status
        });

        // v13.0: Recipients now includes KOTH holders instead of just creator
        // v25.13: Use distributionPlan.length for accurate recipient count
        const totalRecipients = distributionPlan.length + (kothAmount > 0 ? kothHolderCount : 0);

        await db.run(
            'INSERT INTO airdrop_logs (amount, recipients, "totalPoints", signatures, details, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
            [totalDistributedSol, totalRecipients, totalPoints, allSignatures.join(','), details, new Date().toISOString()]
        );

        // v25.18: Log individual user airdrop distributions for shareable stats
        const airdropTimestamp = Date.now();
        try {
            // Batch insert user distributions (only for successful distributions)
            const successfulRecipients = distributionPlan.filter(r => !failedUsers.includes(r.user.toString()));
            if (successfulRecipients.length > 0) {
                // Build batch insert with multiple VALUES (5 params per row)
                const values = successfulRecipients.map((r, i) => {
                    const base = i * 5;
                    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
                }).join(', ');

                const params = successfulRecipients.flatMap(r => [
                    r.user.toString(),
                    airdropId,
                    r.amount / LAMPORTS_PER_SOL, // Store in SOL
                    r.points,
                    airdropTimestamp
                ]);

                await db.run(
                    `INSERT INTO user_airdrop_history ("userPubkey", "airdropId", amount, points, timestamp) VALUES ${values}`,
                    params
                );
                logger.debug(`[Airdrop] Logged ${successfulRecipients.length} user distributions to history`);
            }
        } catch (historyErr) {
            logger.warn('[Airdrop] Failed to log user airdrop history', { error: historyErr.message });
            // Don't fail the airdrop for history logging errors
        }

        // v25.13: Mark airdrop as completed for finally block
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
 * @returns {string|null} - Transaction signature or null on failure
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

        if (validItems.length === 0) return null;

        // Add SOL transfer instructions for each valid recipient
        for (const item of validItems) {
            tx.add(SystemProgram.transfer({
                fromPubkey: devKeypair.publicKey,
                toPubkey: item.user,
                lamports: item.amount
            }));
        }

        const sig = await solana.sendTxWithRetry(tx, [devKeypair]);
        return sig;
    } catch (e) {
        logger.error(`SOL Airdrop batch failed`, { error: e.message });
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
        const SAFETY_RESERVE = 0.5 * LAMPORTS_PER_SOL;
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

        // Check pending fees (both BC and AMM)
        let totalPendingFees = new BN(0);
        try {
            const bcInfo = await connection.getAccountInfo(bcVault);
            if (bcInfo) totalPendingFees = totalPendingFees.add(new BN(bcInfo.lamports));
        } catch (e) {
            // v25.14 ROBUSTNESS: Log RPC errors instead of silently ignoring
            logger.debug('[FeeCollection] BC vault check failed', { error: e.message });
        }

        try {
            const ammVaultAtaKey = await ammVaultAta;
            const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
            totalPendingFees = totalPendingFees.add(new BN(bal.value.amount));
        } catch (e) {
            // v25.14 ROBUSTNESS: Log RPC errors instead of silently ignoring
            logger.debug('[FeeCollection] AMM vault check failed', { error: e.message });
        }

        // v17.0: Fee threshold is 0.05 SOL
        const threshold = new BN((config.FEE_THRESHOLD_SOL || 0.05) * LAMPORTS_PER_SOL);

        if (totalPendingFees.gte(threshold)) {
            logger.info(`[FeeCollection] Claiming ${(totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL in fees...`);

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
            logger.debug(`[FeeCollection] Below threshold: ${(totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL pending, need ${config.FEE_THRESHOLD_SOL || 0.05} SOL`);
            // v25.12: Log skip events to frontend so users know system is working
            if (logPurchase && totalPendingFees.toNumber() > 0) {
                await logPurchase('FEE_CHECK', {
                    status: 'PENDING',
                    pendingSol: (totalPendingFees.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
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
 */
function start(deps) {
    // Fee collection every 1 minute
    const feeInterval = config.FEE_COLLECTION_INTERVAL || 60000;
    setInterval(() => runFeeCollection(deps), feeInterval);
    logger.info(`Fee collection started (${feeInterval / 1000}s interval, >${config.FEE_THRESHOLD_SOL || 0.05} SOL threshold)`);

    // Airdrop processing every 15 minutes
    const airdropInterval = config.AIRDROP_INTERVAL || 900000;
    setInterval(() => processAirdrop(deps), airdropInterval);
    logger.info(`Airdrop distribution started (${airdropInterval / 60000}min interval, >${config.AIRDROP_THRESHOLD_SOL || 1.0} SOL threshold)`);

    // Initial runs after short delay
    setTimeout(() => runFeeCollection(deps), 5000);
    setTimeout(() => processAirdrop(deps), 10000);
}

module.exports = { claimCreatorFees, claimRobinhoodFees, processAirdrop, sendSolAirdropBatch, runPurchaseAndFees, runFeeCollection, refreshAllFeeShares, start };
