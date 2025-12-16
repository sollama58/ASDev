/**
 * Flywheel Task
 * Fee collection, buyback, and airdrop distribution
 */
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const {
    getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
    createCloseAccountInstruction, TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, PROGRAMS, WALLETS } = require('../config/constants');
const { logger, pump, solana, jupiter } = require('../services');

let isBuybackRunning = false;
let isAirdropping = false;

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
 * Process airdrop distribution
 * Updated with "King of the Hill" (KOTH) Logic
 */
async function processAirdrop(deps) {
    const { connection, devKeypair, db, globalState } = deps;

    if (isAirdropping) return;
    isAirdropping = true;

    try {
        const solBalance = await connection.getBalance(devKeypair.publicKey);
        if (solBalance < 0.25 * LAMPORTS_PER_SOL) {
            logger.warn(`Airdrop Skipped: Low SOL Balance`);
            return;
        }

        const balance = globalState.devPumpHoldings;
        if (balance <= 50000) return;

        logger.info(`AIRDROP TRIGGERED: Balance ${balance} PUMP > 50,000`);

        // Total Amount to be distributed (99% of holdings)
        const totalDistributable = balance * 0.99;
        let kothAmount = 0;
        let communityAmount = totalDistributable;
        let kothTxSignature = null;

        // 1. Identify King of the Hill (Highest MCAP)
        const kothToken = await db.get('SELECT userPubkey, ticker, mint FROM tokens ORDER BY marketCap DESC LIMIT 1');
        
        const devPumpAta = await getAssociatedTokenAddress(
            TOKENS.PUMP, devKeypair.publicKey, false, PROGRAMS.TOKEN_2022
        );

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

        if (globalState.totalPoints === 0 || userPoints.length === 0) {
             isAirdropping = false;
             return;
        }

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
    } catch (e) {
        logger.error("Airdrop Failed", { error: e.message });
    } finally {
        isAirdropping = false;
    }
}

/**
 * Send a batch of airdrop transfers
 */
async function sendAirdropBatch(batch, sourceAta, deps) {
    const { connection, devKeypair } = deps;

    try {
        const tx = new Transaction();
        solana.addPriorityFee(tx);

        const atas = await Promise.all(batch.map(i =>
            getAssociatedTokenAddress(TOKENS.PUMP, i.user, false, PROGRAMS.TOKEN_2022)
        ));

        let infos = null;
        let retries = 3;
        while (retries > 0) {
            try {
                infos = await connection.getMultipleAccountsInfo(atas);
                break;
            } catch (err) {
                retries--;
                if (retries === 0) throw new Error(`Failed to fetch account infos`);
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        batch.forEach((item, idx) => {
            const ata = atas[idx];
            if (!infos[idx]) {
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
        return sig;
    } catch (e) {
        logger.error(`Airdrop batch failed`, { error: e.message });
        return null;
    }
}

/**
 * Run the main flywheel cycle
 */
async function runPurchaseAndFees(deps) {
    const { connection, devKeypair, db, globalState, recordClaim, updateNextCheckTime, logPurchase } = deps;

    if (isBuybackRunning) return;
    isBuybackRunning = true;

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
                await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [claimedAmount, 'lifetimeCreatorFeesLamports']);
                await recordClaim(claimedAmount);
            }
            await new Promise(r => setTimeout(r, 2000));
        } else {
            logData.reason = `Threshold not met`;
        }

        const realBalance = await connection.getBalance(devKeypair.publicKey);
        const SAFETY_BUFFER = 50000000;

        if (realBalance < SAFETY_BUFFER) {
            logData.reason = 'LOW BALANCE';
            logData.status = 'LOW_BALANCE_SKIP';
        } else if (claimedAmount > 0) {
            let spendable = Math.min(claimedAmount, realBalance - SAFETY_BUFFER);
            const MIN_SPEND = 0.05 * LAMPORTS_PER_SOL;

            if (spendable > MIN_SPEND) {
                // Distribution: 95% Buyback, 4.5% ASDF Fee, 0.5% Upkeep
                const transfer9_5 = Math.floor(spendable * 0.045);
                const transfer0_5 = Math.floor(spendable * 0.005);
                const solBuyAmount = Math.floor(spendable * 0.95);

                logData.solSpent = (solBuyAmount + transfer9_5 + transfer0_5) / LAMPORTS_PER_SOL;
                logData.transfer9_5 = transfer9_5 / LAMPORTS_PER_SOL;
                logData.transfer0_5 = transfer0_5 / LAMPORTS_PER_SOL;

                // Fee distribution
                const feeTx = new Transaction();
                solana.addPriorityFee(feeTx);
                feeTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_95, lamports: transfer9_5 }));
                feeTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLETS.FEE_05, lamports: transfer0_5 }));
                await solana.sendTxWithRetry(feeTx, [devKeypair]);
                logger.info("Fees Distributed");

                // DIRECT BUY: Swap SOL -> PUMP using Jupiter
                const swapResult = await jupiter.swapSolToToken(solBuyAmount, TOKENS.PUMP, devKeypair, connection);
                
                if (swapResult && swapResult.signature) {
                    logData.pumpBuySig = swapResult.signature;
                    logData.tokensBought = swapResult.outAmount;
                    logData.status = 'SUCCESS';
                    logData.reason = 'Flywheel Complete';
                    
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

        await processAirdrop(deps);
        await logPurchase('FLYWHEEL_CYCLE', logData);

    } catch (e) {
        logData.status = 'CRITICAL_ERROR';
        logData.reason = e.message;
        await logPurchase('FLYWHEEL_CYCLE', logData);
        logger.error("CRITICAL FLYWHEEL ERROR", { message: e.message });
    } finally {
        isBuybackRunning = false;
        await updateNextCheckTime();
    }
}

/**
 * Start the flywheel interval
 */
function start(deps) {
    setInterval(() => runPurchaseAndFees(deps), 5 * 60 * 1000);
    logger.info("Flywheel started (5 min interval)");
}

module.exports = { claimCreatorFees, processAirdrop, runPurchaseAndFees, start };
