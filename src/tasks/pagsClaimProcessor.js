/**
 * PAGS Claim Processor
 * Background task for processing pending PAGS claims
 *
 * Processes claims from the pags_claims table and executes SOL transfers
 * from PAGS_WALLET to user wallets.
 */
const { PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const logger = require('../services/logger');
const config = require('../config/env');
const { PAGS } = require('../config/constants');

// Dependencies injected at start
let db = null;
let connection = null;
let pagsKeypair = null;
let redis = null;
let isRunning = false;
let processInterval = null;

// Process pending claims every 30 seconds
const CLAIM_PROCESS_INTERVAL = 30000;

// Maximum claims to process per cycle
const MAX_CLAIMS_PER_CYCLE = 10;

/**
 * Start the claim processor
 */
function start(deps) {
    db = deps.db;
    connection = deps.connection;
    // Use dedicated pagsKeypair if available, fall back to devKeypair
    pagsKeypair = deps.pagsKeypair || deps.devKeypair;
    redis = deps.redis;

    if (!config.PAGS_ENABLED) {
        logger.info('[PAGS Claim Processor] PAGS is disabled, skipping start');
        return null;
    }

    // Validate keypair is available for claim processing
    if (!pagsKeypair) {
        logger.error('[PAGS Claim Processor] No keypair available for signing claim transactions');
        logger.error('[PAGS Claim Processor] Configure PAGS_WALLET_PRIVATE_KEY or DEV_WALLET_PRIVATE_KEY');
        return null;
    }

    // Log which wallet is being used
    const walletPubkey = pagsKeypair.publicKey.toString();
    if (config.PAGS_WALLET && walletPubkey !== config.PAGS_WALLET) {
        logger.warn('[PAGS Claim Processor] Keypair does not match PAGS_WALLET - using derived address');
    }

    logger.info('[PAGS Claim Processor] Starting claim processor', {
        interval: CLAIM_PROCESS_INTERVAL,
        maxPerCycle: MAX_CLAIMS_PER_CYCLE,
        walletPubkey: walletPubkey.slice(0, 8) + '...'
    });

    // Start processing interval
    processInterval = setInterval(processPendingClaims, CLAIM_PROCESS_INTERVAL);

    // Run immediately on start
    processPendingClaims();

    return processInterval;
}

/**
 * Stop the claim processor
 */
function stop() {
    if (processInterval) {
        clearInterval(processInterval);
        processInterval = null;
    }
    logger.info('[PAGS Claim Processor] Stopped');
}

/**
 * Process all pending claims
 */
async function processPendingClaims() {
    if (isRunning) {
        logger.debug('[PAGS Claim Processor] Already processing, skipping cycle');
        return;
    }

    if (!pagsKeypair) {
        // No keypair configured, skip processing
        return;
    }

    isRunning = true;

    try {
        // Get pending claims
        const pendingClaims = await db.all(`
            SELECT * FROM pags_claims
            WHERE status = 'pending'
            ORDER BY "createdAt" ASC
            LIMIT $1
        `, [MAX_CLAIMS_PER_CYCLE]);

        if (pendingClaims.length === 0) {
            isRunning = false;
            return;
        }

        logger.info('[PAGS Claim Processor] Processing claims', { count: pendingClaims.length });

        // Check PAGS wallet balance - use the keypair's public key (authoritative source)
        const pagsWalletPubkey = pagsKeypair.publicKey;
        const balance = await connection.getBalance(pagsWalletPubkey);
        const balanceSol = balance / 1e9;

        // Calculate total needed
        const totalNeeded = pendingClaims.reduce((sum, c) => sum + c.amount, 0);

        if (balanceSol < totalNeeded + 0.01) { // Keep 0.01 SOL for fees
            logger.warn('[PAGS Claim Processor] Insufficient balance in PAGS wallet', {
                balance: balanceSol,
                needed: totalNeeded
            });

            // Process what we can
            let availableBalance = balanceSol - 0.01;
            for (const claim of pendingClaims) {
                if (availableBalance >= claim.amount) {
                    await processOneClaim(claim);
                    availableBalance -= claim.amount;
                } else {
                    logger.info('[PAGS Claim Processor] Skipping claim due to insufficient balance', {
                        claimId: claim.id,
                        needed: claim.amount,
                        available: availableBalance
                    });
                }
            }
        } else {
            // Process all claims
            for (const claim of pendingClaims) {
                await processOneClaim(claim);
            }
        }

    } catch (e) {
        logger.error('[PAGS Claim Processor] Error processing claims', { error: e.message });
    } finally {
        isRunning = false;
    }
}

/**
 * Process a single claim
 * SECURITY: Validates claim data before processing
 */
async function processOneClaim(claim) {
    try {
        // SECURITY: Validate claim data
        if (!claim || !claim.id || !claim.recipientWallet || !claim.amount) {
            logger.error('[PAGS Claim Processor] Invalid claim data', { claim });
            return;
        }

        // SECURITY: Validate amount is positive and reasonable
        if (typeof claim.amount !== 'number' || claim.amount <= 0 || claim.amount > 1000) {
            await markClaimFailed(claim.id, 'Invalid claim amount');
            return;
        }

        // SECURITY: Validate wallet address format
        try {
            new PublicKey(claim.recipientWallet);
        } catch (e) {
            await markClaimFailed(claim.id, 'Invalid recipient wallet address');
            return;
        }

        logger.info('[PAGS Claim Processor] Processing claim', {
            claimId: claim.id,
            twitterUsername: claim.twitterUsername,
            amount: claim.amount,
            wallet: claim.recipientWallet.slice(0, 8) + '...'
        });

        // Verify the user still exists and wallet is still linked
        const user = await db.get(
            'SELECT * FROM pags_twitter_users WHERE "twitterId" = $1 AND "isActive" = 1',
            [claim.twitterId]
        );

        if (!user) {
            await markClaimFailed(claim.id, 'User no longer active');
            return;
        }

        if (user.linkedWallet !== claim.recipientWallet) {
            await markClaimFailed(claim.id, 'Wallet changed since claim was created');
            return;
        }

        // Execute the transfer
        const signature = await executeTransfer(claim.recipientWallet, claim.amount);

        // Mark claim as completed
        await db.run(`
            UPDATE pags_claims
            SET status = 'completed', signature = $1, "completedAt" = $2
            WHERE id = $3
        `, [signature, Date.now(), claim.id]);

        // Update beneficiary claimed amounts
        await db.run(`
            UPDATE pags_beneficiaries
            SET "totalFeesClaimed" = "totalFeesClaimed" + $1
            WHERE "twitterUsername" = $2 AND "isActive" = 1
        `, [claim.amount, claim.twitterUsername]);

        logger.info('[PAGS Claim Processor] Claim completed', {
            claimId: claim.id,
            signature,
            amount: claim.amount
        });

    } catch (e) {
        logger.error('[PAGS Claim Processor] Failed to process claim', {
            claimId: claim.id,
            error: e.message
        });

        await markClaimFailed(claim.id, e.message);
    }
}

/**
 * Execute a SOL transfer
 */
async function executeTransfer(recipientWallet, amountSol) {
    const recipientPubkey = new PublicKey(recipientWallet);
    const lamports = Math.floor(amountSol * 1e9);

    // Create transfer transaction
    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: pagsKeypair.publicKey,
            toPubkey: recipientPubkey,
            lamports
        })
    );

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = pagsKeypair.publicKey;

    // Sign and send
    tx.sign(pagsKeypair);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
    });

    // Wait for confirmation
    await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
    }, 'confirmed');

    return signature;
}

/**
 * Mark a claim as failed
 */
async function markClaimFailed(claimId, reason) {
    await db.run(`
        UPDATE pags_claims
        SET status = 'failed', "failReason" = $1, "completedAt" = $2
        WHERE id = $3
    `, [reason, Date.now(), claimId]);

    logger.warn('[PAGS Claim Processor] Claim marked as failed', { claimId, reason });
}

/**
 * Get processor status
 */
function getStatus() {
    return {
        running: !!processInterval,
        processing: isRunning,
        enabled: config.PAGS_ENABLED,
        walletConfigured: !!config.PAGS_WALLET
    };
}

/**
 * Manually trigger claim processing (for admin use)
 */
async function triggerProcessing() {
    if (isRunning) {
        return { success: false, error: 'Already processing' };
    }

    await processPendingClaims();
    return { success: true };
}

module.exports = {
    start,
    stop,
    getStatus,
    triggerProcessing,
    processOneClaim
};
