/**
 * Flywheel Task
 * Fee collection, buyback, and airdrop distribution
 */
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
    createCloseAccountInstruction, TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, PROGRAMS, WALLETS } = require('../config/constants');
const { logger, pump, solana, jupiter } = require('../services');
const { createRunGuard, maxRunAge } = require('./runGuard');

const FLYWHEEL_INTERVAL_MS = 5 * 60 * 1000;

// Overlap guards that recover if a run hangs on a call that never returns.
const cycleGuard = createRunGuard('Flywheel', maxRunAge(FLYWHEEL_INTERVAL_MS));
const airdropGuard = createRunGuard('Airdrop', maxRunAge(FLYWHEEL_INTERVAL_MS));

// Re-scan eligible users' ATAs at most this often while the eligible set is unchanged.
const ATA_SCAN_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Read the dev wallet's pending creator fees (bonding curve + AMM vault).
 * Returns lamports for each source; a failed read counts as 0.
 */
async function readPendingFees(deps) {
    const { connection, devKeypair } = deps;
    const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(devKeypair.publicKey);
    let bcLamports = 0;
    let ammLamports = 0;

    try {
        const bcInfo = await connection.getAccountInfo(bcVault);
        if (bcInfo) bcLamports = bcInfo.lamports;
    } catch (e) {
        logger.debug('Failed to fetch BC fees', { error: e.message });
    }

    try {
        const ammVaultAtaKey = await ammVaultAta;
        const bal = await connection.getTokenAccountBalance(ammVaultAtaKey);
        if (bal.value.amount) ammLamports = Number(bal.value.amount);
    } catch (e) {
        logger.debug('Failed to fetch AMM fees', { error: e.message });
    }

    return { bcLamports, ammLamports };
}

/**
 * Refresh the wallet readings the /health endpoint shows (SOL balance, pending fees, PUMP holdings)
 * and cache them on globalState so the route does not have to hit the RPC itself.
 */
async function refreshWalletState(deps) {
    const { connection, devKeypair, globalState } = deps;

    const pending = await readPendingFees(deps);
    globalState.pendingFeesLamports = pending.bcLamports + pending.ammLamports;

    try {
        globalState.devSolBalanceLamports = await connection.getBalance(devKeypair.publicKey);
    } catch (e) {
        logger.debug('Failed to fetch SOL balance', { error: e.message });
    }

    try {
        const devPumpAta = await getAssociatedTokenAddress(TOKENS.PUMP, devKeypair.publicKey, false, PROGRAMS.TOKEN_2022);
        const tokenBal = await connection.getTokenAccountBalance(devPumpAta);
        globalState.devPumpHoldings = tokenBal.value.uiAmount || 0;
    } catch (e) {
        globalState.devPumpHoldings = 0;
    }

    globalState.walletStateUpdatedAt = Date.now();
    return pending;
}

/**
 * Claim creator fees from bonding curve and AMM.
 * `pending` is the { bcLamports, ammLamports } reading the caller already made, so the
 * vaults are not read a second time.
 */
async function claimCreatorFees(deps, pending) {
    const { devKeypair } = deps;
    const { bcVault, ammVaultAuth, ammVaultAta } = pump.getCreatorFeeVaults(devKeypair.publicKey);

    if (!pending) pending = await readPendingFees(deps);

    const tx = new Transaction();
    solana.addPriorityFee(tx);

    let claimedSomething = false;
    let totalClaimed = 0;

    // Claim Bonding Curve Fees
    try {
        if (pending.bcLamports > 0) {
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
            totalClaimed += pending.bcLamports;
        }
    } catch (e) {
        logger.debug('Failed to claim BC fees', { error: e.message });
    }

    // Claim AMM Fees
    try {
        const myWsolAta = await getAssociatedTokenAddress(TOKENS.WSOL, devKeypair.publicKey);
        const ammVaultAtaKey = await ammVaultAta;

        if (pending.ammLamports > 0) {
            // Idempotent create replaces a getAccount read: it is a no-op if the ATA already exists.
            tx.add(createAssociatedTokenAccountIdempotentInstruction(
                devKeypair.publicKey, myWsolAta, devKeypair.publicKey, TOKENS.WSOL
            ));

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
            totalClaimed += pending.ammLamports;
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
 * Process airdrop distribution
 * Updated with "King of the Hill" (KOTH) Logic and Dynamic Cost Check
 */
async function processAirdrop(deps, knownSolBalance = null) {
    const { connection, devKeypair, db, globalState } = deps;

    const runToken = airdropGuard.tryAcquire();
    if (!runToken) return;

    try {
        // Basic Threshold Check on the cached reading (refreshed by the holder scanner)
        if ((globalState.devPumpHoldings || 0) <= 50000) return;

        // Re-read the real PUMP balance: the cached number predates this cycle's buyback and
        // any previous airdrop, and distributing a stale amount fails every batch.
        const devPumpAta = await getAssociatedTokenAddress(
            TOKENS.PUMP, devKeypair.publicKey, false, PROGRAMS.TOKEN_2022
        );
        let balance = 0;
        try {
            const tokenBal = await connection.getTokenAccountBalance(devPumpAta);
            balance = tokenBal.value.uiAmount || 0;
        } catch (e) {
            logger.warn(`Airdrop Skipped: could not read PUMP balance (${e.message})`);
            return;
        }
        globalState.devPumpHoldings = balance;
        if (balance <= 50000) return;

        // --- FINAL SAFETY CHECK ---
        // The SOL balance read by runPurchaseAndFees is reused unless it spent SOL since.
        const solBalance = knownSolBalance !== null
            ? knownSolBalance
            : await connection.getBalance(devKeypair.publicKey);
        // Use the cached calculation from flywheel if available, otherwise safe fallback
        const cachedCost = globalState.conservationStatus?.estimatedCost || (0.05 * LAMPORTS_PER_SOL);
        
        if (solBalance < cachedCost) {
            logger.warn(`Airdrop Skipped: Insufficient SOL (Final Check). Need ${(cachedCost/LAMPORTS_PER_SOL).toFixed(4)}, Have ${(solBalance/LAMPORTS_PER_SOL).toFixed(4)}`);
            return;
        }
        // --------------------------------

        logger.info(`AIRDROP TRIGGERED: Balance ${balance} PUMP > 50,000`);

        // Total Amount to be distributed (99% of holdings)
        const totalDistributable = balance * 0.99;
        let kothAmount = 0;
        let communityAmount = totalDistributable;
        let kothTxSignature = null;

        // 1. Identify King of the Hill (Highest MCAP). Same rule as /koth and the holder
        //    scanner: with no market data there is no king, rather than an arbitrary row.
        const kothToken = await db.get('SELECT userPubkey, ticker, mint FROM tokens WHERE marketCap > 0 ORDER BY marketCap DESC LIMIT 1');

        // 2. Process KOTH Payout (10%)
        if (kothToken && kothToken.userPubkey) {
            kothAmount = totalDistributable * 0.10;
            communityAmount = totalDistributable * 0.90;

            logger.info(`👑 King of the Hill found: ${kothToken.ticker} ($${kothAmount.toFixed(2)} PUMP prize)`);

            try {
                // Send specific transaction for KOTH
                const kothBatch = [{ user: new PublicKey(kothToken.userPubkey), amount: new BN(kothAmount * 1000000) }];
                kothTxSignature = await sendAirdropBatch(kothBatch, devPumpAta, deps);
                
                if (kothTxSignature) {
                    logger.info(`✅ KOTH Payout Sent: ${kothTxSignature}`);
                } else {
                    logger.error("❌ KOTH Payout Failed - returning funds to community pool");
                    // If fails, put money back in community pot
                    communityAmount += kothAmount;
                    kothAmount = 0;
                }
            } catch (e) {
                logger.error(`KOTH Logic Error: ${e.message}`);
                communityAmount += kothAmount;
                kothAmount = 0;
            }
        }

        // 3. Process Community Distribution (Remaining 90%)
        const communityAmountInt = new BN(communityAmount * 1000000); // 6 decimals
        const userPoints = Array.from(globalState.userPointsMap.entries())
            .map(([pubkey, points]) => ({ pubkey: new PublicKey(pubkey), points }))
            .filter(user => user.points > 0);

        if (globalState.totalPoints === 0 || userPoints.length === 0) return;

        logger.info(`Distributing ${communityAmount} PUMP to ${userPoints.length} users (Community Pool)`);

        const BATCH_SIZE = 8;
        let currentBatch = [];
        let allSignatures = [];
        
        // Add KOTH sig if it exists
        if (kothTxSignature) allSignatures.push(`KOTH:${kothTxSignature}`);

        let successfulBatches = 0;
        let failedBatches = 0;

        for (const user of userPoints) {
            const share = communityAmountInt.mul(new BN(user.points)).div(new BN(globalState.totalPoints));
            if (share.eqn(0)) continue;

            currentBatch.push({ user: user.pubkey, amount: share });

            if (currentBatch.length >= BATCH_SIZE) {
                const sig = await sendAirdropBatch(currentBatch, devPumpAta, deps);
                if (sig) {
                    allSignatures.push(sig);
                    successfulBatches++;
                } else {
                    failedBatches++;
                }
                currentBatch = [];
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (currentBatch.length > 0) {
            const sig = await sendAirdropBatch(currentBatch, devPumpAta, deps);
            if (sig) {
                allSignatures.push(sig);
                successfulBatches++;
            } else {
                failedBatches++;
            }
        }

        logger.info(`Airdrop Complete. Success: ${successfulBatches}, Failed: ${failedBatches}`);

        const details = JSON.stringify({ success: successfulBatches, failed: failedBatches, kothWinner: kothToken?.ticker || 'None', kothAmount: kothAmount });
        await db.run(
            'INSERT INTO airdrop_logs (amount, recipients, totalPoints, signatures, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
            [totalDistributable, userPoints.length + (kothAmount > 0 ? 1 : 0), globalState.totalPoints, allSignatures.join(','), details, new Date().toISOString()]
        );
        
        // Clear status after run and refresh the cached PUMP holdings for /health
        globalState.conservationStatus = null;
        globalState.ataScan = null;
        try {
            const after = await connection.getTokenAccountBalance(devPumpAta);
            globalState.devPumpHoldings = after.value.uiAmount || 0;
        } catch (e) {
            globalState.devPumpHoldings = 0;
        }
        
    } catch (e) {
        logger.error("Airdrop Failed", { error: e.message });
    } finally {
        airdropGuard.release(runToken);
    }
}

/**
 * Send a batch of airdrop transfers
 * Enhanced: Skips invalid ATAs instead of failing the whole batch
 */
async function sendAirdropBatch(batch, sourceAta, deps) {
    const { connection, devKeypair, globalState } = deps;

    try {
        const tx = new Transaction();
        // 8 transfers plus up to 8 Token-2022 ATA creations can exceed 300k CU
        solana.addPriorityFee(tx, 400000);

        // 1. Resolve ATAs safely
        const validItems = [];
        const atas = [];

        for (const item of batch) {
            try {
                // Safely derive ATA. If pubkey is somehow invalid, this might throw.
                const ata = await getAssociatedTokenAddress(TOKENS.PUMP, item.user, false, PROGRAMS.TOKEN_2022);
                validItems.push(item);
                atas.push(ata);
            } catch (err) {
                logger.warn(`Skipping invalid user in airdrop batch: ${item.user.toString()}`);
            }
        }

        if (validItems.length === 0) return null;

        // 2. Find out which ATAs exist. The conservation check in runPurchaseAndFees already
        //    fetched this for every eligible user, so only fetch what that cache lacks.
        const ataExists = globalState.ataScan?.exists || new Map();
        const unknown = atas.filter(a => !ataExists.has(a.toBase58()));

        if (unknown.length > 0) {
            let retries = 3;
            while (retries > 0) {
                try {
                    const infos = await connection.getMultipleAccountsInfo(unknown);
                    unknown.forEach((a, idx) => ataExists.set(a.toBase58(), !!infos[idx]));
                    break;
                } catch (err) {
                    retries--;
                    if (retries === 0) throw new Error(`Failed to fetch account infos`);
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        }

        // 3. Build TX with valid items only
        validItems.forEach((item, idx) => {
            const ata = atas[idx];
            // If the account doesn't exist -> Create it (Idempotent)
            if (!ataExists.get(ata.toBase58())) {
                tx.add(createAssociatedTokenAccountIdempotentInstruction(
                    devKeypair.publicKey, ata, item.user, TOKENS.PUMP, PROGRAMS.TOKEN_2022
                ));
            }
            tx.add(createTransferCheckedInstruction(
                sourceAta, TOKENS.PUMP, ata, devKeypair.publicKey,
                BigInt(item.amount.toString()), 6, [], PROGRAMS.TOKEN_2022
            ));
        });

        const sig = await solana.sendTxWithRetry(tx, [devKeypair]);
        // Every ATA in a landed batch now exists
        atas.forEach(a => ataExists.set(a.toBase58(), true));
        return sig;
    } catch (e) {
        logger.error(`Airdrop batch failed`, { error: e.message });
        // A cached "exists" may have gone stale (closed account); force a fresh scan next cycle.
        globalState.ataScan = null;
        return null;
    }
}

/**
 * Run the main flywheel cycle
 */
async function runPurchaseAndFees(deps) {
    const { connection, devKeypair, db, globalState, recordClaim, updateNextCheckTime, logPurchase } = deps;

    const runToken = cycleGuard.tryAcquire();
    if (!runToken) return;

    let logData = {
        status: 'SKIPPED',
        reason: 'Unknown',
        feesCollected: 0,
        solSpent: 0,
        tokensBought: 0,
        transfer9_5: 0,
        transfer0_5: 0,
        pumpBuySig: null
    };

    try {
        // One read of the fee vaults per cycle; the result feeds the claim and the /health cache.
        const pending = await readPendingFees(deps);
        const totalPendingFees = new BN(pending.bcLamports + pending.ammLamports);
        globalState.pendingFeesLamports = totalPendingFees.toNumber();

        logData.feesCollected = totalPendingFees.toNumber() / LAMPORTS_PER_SOL;

        const threshold = new BN(config.FEE_THRESHOLD_SOL * LAMPORTS_PER_SOL);
        let claimedAmount = 0;

        if (totalPendingFees.gte(threshold)) {
            logger.info("Claiming fees...");
            claimedAmount = await claimCreatorFees(deps, pending);

            if (claimedAmount > 0) {
                await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [claimedAmount, 'lifetimeCreatorFeesLamports']);
                await recordClaim(claimedAmount);
                globalState.pendingFeesLamports = 0;
            }
            await new Promise(r => setTimeout(r, 2000));
        } else {
            logData.reason = `Threshold not met`;
        }

        const realBalance = await connection.getBalance(devKeypair.publicKey);
        globalState.devSolBalanceLamports = realBalance;
        globalState.walletStateUpdatedAt = Date.now();
        let solSpentThisCycle = false;
        // Default buffer for normal operations
        let dynamicSafetyBuffer = 0.05 * LAMPORTS_PER_SOL; 

        // --- CONSERVATION & EXCESS LOGIC ---
        const pumpBalance = globalState.devPumpHoldings || 0;
        const AIRDROP_THRESHOLD = 50000;
        const ATA_RENT_COST = 0.00203928 * LAMPORTS_PER_SOL; // Precise rent cost
        
        let proceedWithBuyback = true;
        let conservationStatus = null;

        if (pumpBalance > AIRDROP_THRESHOLD) {
            logger.info("Flywheel: PUMP Threshold met. Calculating precise airdrop costs...");
            
            const eligibleUsers = Array.from(globalState.userPointsMap.keys());
            let missingAtaCount = 0;

            // The eligible set only changes when the holder scanner runs, and ATAs are only ever
            // created, so reuse the last scan while the set is unchanged and the scan is recent.
            const scanKey = eligibleUsers.slice().sort().join(',');
            const cachedScan = globalState.ataScan;
            const scanIsFresh = cachedScan
                && cachedScan.key === scanKey
                && (Date.now() - cachedScan.at) < ATA_SCAN_MAX_AGE_MS;

            if (scanIsFresh) {
                missingAtaCount = cachedScan.missingAtaCount;
                logger.debug(`Conservation Check: reusing ATA scan (${missingAtaCount} missing)`);
            } else if (eligibleUsers.length > 0) {
                const exists = new Map();

                // Batch check ATAs to be precise
                const BATCH_SIZE = 100;
                for (let i = 0; i < eligibleUsers.length; i += BATCH_SIZE) {
                    const batch = eligibleUsers.slice(i, i + BATCH_SIZE);
                    const validAtas = [];

                    // Step 1: Derive ATAs safely (don't fail batch on one bad key)
                    for (const u of batch) {
                        try {
                            const pk = new PublicKey(u);
                            const ata = await getAssociatedTokenAddress(TOKENS.PUMP, pk, false, PROGRAMS.TOKEN_2022);
                            validAtas.push(ata);
                        } catch (e) {
                            // Invalid Pubkey? Just ignore it for calculation purposes.
                            // If it's invalid, we can't airdrop to it anyway.
                            logger.warn(`Conservation Check: Invalid pubkey found: ${u}`);
                        }
                    }

                    if (validAtas.length === 0) continue;

                    // Step 2: Check on-chain, remembering the answer for sendAirdropBatch
                    try {
                        const infos = await connection.getMultipleAccountsInfo(validAtas);
                        validAtas.forEach((ata, idx) => exists.set(ata.toBase58(), !!infos[idx]));
                        // Count null accounts (they need creation)
                        missingAtaCount += infos.filter(info => !info).length;
                    } catch (err) {
                        logger.error("Error checking ATAs batch", {error: err.message});
                        // Fallback: assume all valid in this batch are missing (safety)
                        missingAtaCount += validAtas.length;
                    }
                }

                globalState.ataScan = { key: scanKey, at: Date.now(), missingAtaCount, exists };
            }
            
            // Base Cost = Rent for new accounts + standard transaction fee buffer
            const estimatedAirdropCost = (missingAtaCount * ATA_RENT_COST) + (0.05 * LAMPORTS_PER_SOL);
            
            // Excess logic: Maintain 1 SOL buffer ON TOP of estimated costs
            const ONE_SOL = 1 * LAMPORTS_PER_SOL;
            const requiredReserve = estimatedAirdropCost + ONE_SOL;

            conservationStatus = {
                eligibleCount: eligibleUsers.length,
                missingAtas: missingAtaCount,
                estimatedCost: estimatedAirdropCost / LAMPORTS_PER_SOL,
                currentSol: realBalance / LAMPORTS_PER_SOL,
                pumpBalance: pumpBalance,
                isConserving: realBalance < estimatedAirdropCost // Only "conserving" if we can't afford the airdrop
            };
            
            globalState.conservationStatus = conservationStatus;

            if (realBalance < estimatedAirdropCost) {
                // CASE 1: NOT ENOUGH FOR AIRDROP -> Stop Buyback, Conserve SOL
                logger.info(`Flywheel: Conserving SOL. Need ${conservationStatus.estimatedCost.toFixed(4)}, Have ${conservationStatus.currentSol.toFixed(4)}.`);
                logData.status = 'CONSERVING_SOL';
                logData.reason = `Saving for Airdrop (${missingAtaCount} new wallets)`;
                proceedWithBuyback = false;
            } else if (realBalance > requiredReserve) {
                // CASE 2: EXCESS FUNDS -> Enable Buyback with EXCESS only
                // We set the safety buffer to the required reserve so we don't dip below it
                logger.info(`Flywheel: Excess SOL detected (${conservationStatus.currentSol.toFixed(4)}). Buying PUMP with excess (Reserve: ${(requiredReserve/LAMPORTS_PER_SOL).toFixed(4)}).`);
                dynamicSafetyBuffer = requiredReserve;
                logData.reason = 'Excess SOL Buyback';
                proceedWithBuyback = true;
            } else {
                // CASE 3: ENOUGH FOR AIRDROP, BUT NO EXCESS -> Skip Buyback, Trigger Airdrop
                logger.info(`Flywheel: Ready for Airdrop. Triggering distribution.`);
                logData.reason = 'Ready for Airdrop';
                proceedWithBuyback = false; 
            }
        } else {
            // Clear status if under threshold
            globalState.conservationStatus = null;
        }
        // --------------------------

        if (proceedWithBuyback) {
            // Check against dynamic buffer
            if (realBalance < dynamicSafetyBuffer) {
                logData.reason = 'LOW BALANCE (Below Buffer)';
                logData.status = 'LOW_BALANCE_SKIP';
            } else if (claimedAmount > 0 || (pumpBalance > AIRDROP_THRESHOLD)) {
                
                // Determine spendable amount
                let spendable = Math.min(claimedAmount, realBalance - dynamicSafetyBuffer);
                
                // If in "Excess Mode", allow spending more of the excess
                if (pumpBalance > AIRDROP_THRESHOLD) {
                    spendable = realBalance - dynamicSafetyBuffer;
                    // Cap single buy size to 5 SOL for safety/slippage
                    if (spendable > 5 * LAMPORTS_PER_SOL) spendable = 5 * LAMPORTS_PER_SOL;
                }

                const MIN_SPEND = 0.05 * LAMPORTS_PER_SOL;

                if (spendable > MIN_SPEND) {
                    // Distribution: 95% Buyback, 4.5% ASDF Fee, 0.5% Upkeep
                    const transfer9_5 = Math.floor(spendable * 0.045);
                    const transfer0_5 = Math.floor(spendable * 0.005);
                    const solBuyAmount = Math.floor(spendable * 0.95);

                    logData.solSpent = (solBuyAmount + transfer9_5 + transfer0_5) / LAMPORTS_PER_SOL;
                    logData.transfer9_5 = transfer9_5 / LAMPORTS_PER_SOL;
                    logData.transfer0_5 = transfer0_5 / LAMPORTS_PER_SOL;

                    // Fee distribution: two system transfers need a few hundred CU, not 300k
                    const feeTx = new Transaction();
                    solana.addPriorityFee(feeTx, 20000);
                    feeTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_95, lamports: transfer9_5 }));
                    feeTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_05, lamports: transfer0_5 }));
                    await solana.sendTxWithRetry(feeTx, [devKeypair]);
                    solSpentThisCycle = true;
                    logger.info("Fees Distributed");

                    // DIRECT BUY: Swap SOL -> PUMP using Jupiter
                    const swapResult = await jupiter.swapSolToToken(solBuyAmount, TOKENS.PUMP, devKeypair, connection);
                    
                    if (swapResult && swapResult.signature) {
                        logData.pumpBuySig = swapResult.signature;
                        logData.tokensBought = swapResult.outAmount;
                        logData.status = 'SUCCESS';
                        logData.reason = pumpBalance > AIRDROP_THRESHOLD ? 'Excess SOL Buyback' : 'Flywheel Complete';
                        
                        // Update Stats
                        await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [solBuyAmount, 'totalPumpBoughtLamports']);
                        
                        // Convert raw units to float (Assuming 6 decimals for PUMP/Token-2022)
                        const tokensBoughtVal = parseFloat(swapResult.outAmount) / 1000000;
                        await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [tokensBoughtVal, 'totalPumpTokensBought']);
                    } else {
                        logData.status = 'BUY_FAIL';
                    }
                } else {
                    logData.status = 'LOW_SPEND_SKIP';
                }
            }
        }

        // Try to airdrop (internally checks balance & threshold).
        // Reuse this cycle's SOL reading unless a transfer or swap changed it.
        await processAirdrop(deps, solSpentThisCycle ? null : realBalance);
        await logPurchase('FLYWHEEL_CYCLE', logData);

    } catch (e) {
        logData.status = 'CRITICAL_ERROR';
        logData.reason = e.message;
        await logPurchase('FLYWHEEL_CYCLE', logData);
        logger.error("CRITICAL FLYWHEEL ERROR", { message: e.message });
    } finally {
        cycleGuard.release(runToken);
        await updateNextCheckTime();
    }
}

/**
 * Start the flywheel interval
 */
function start(deps) {
    // Prime the wallet readings for /health once at startup; the cycle keeps them fresh after that.
    setTimeout(() => refreshWalletState(deps).catch(e => logger.debug('Initial wallet read failed', { error: e.message })), 3000);
    setInterval(() => runPurchaseAndFees(deps), FLYWHEEL_INTERVAL_MS);
    logger.info("Flywheel started (5 min interval)");
}

module.exports = { claimCreatorFees, processAirdrop, runPurchaseAndFees, readPendingFees, refreshWalletState, start };
