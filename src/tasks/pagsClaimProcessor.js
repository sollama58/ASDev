/**
 * PAGS Claim Processor
 * Background task for processing pending PAGS claims
 *
 * Processes claims from the pags_claims table and executes SOL transfers
 * from PAGS_WALLET to user wallets.
 *
 * v25.47 SECURITY: Added distributed locking via Redis
 * v25.47 STABILITY: Added per-claim error handling to prevent queue blocking
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

// v25.47: Distributed lock settings
const LOCK_KEY = 'pags:claim:processor:lock';
const LOCK_TTL_SECONDS = 120; // 2 minute lock TTL (covers processing time)

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
 * v25.47: Acquire distributed lock using Redis
 * Prevents multiple instances from processing claims simultaneously
 */
async function acquireDistributedLock() {
    if (!redis) {
        // No Redis, use local flag only (not safe for multi-instance)
        if (isRunning) return false;
        isRunning = true;
        return true;
    }

    try {
        const client = redis.getConnection();
        if (!client) {
            // Redis not connected, fall back to local flag
            if (isRunning) return false;
            isRunning = true;
            return true;
        }

        // SET NX with TTL - atomic operation
        const lockValue = `${process.pid}-${Date.now()}`;
        const result = await client.set(LOCK_KEY, lockValue, {
            NX: true,
            EX: LOCK_TTL_SECONDS
        });

        if (result === 'OK') {
            isRunning = true;
            return true;
        }
        return false;
    } catch (e) {
        logger.debug('[PAGS Claim Processor] Lock acquisition error, using local flag', { error: e.message });
        if (isRunning) return false;
        isRunning = true;
        return true;
    }
}

/**
 * v25.47: Release distributed lock
 */
async function releaseDistributedLock() {
    isRunning = false;

    if (!redis) return;

    try {
        const client = redis.getConnection();
        if (client) {
            await client.del(LOCK_KEY);
        }
    } catch (e) {
        // Ignore release errors - TTL will handle cleanup
    }
}

/**
 * Process all pending claims
 * v25.47: Uses distributed locking and per-claim error handling
 */
async function processPendingClaims() {
    // v25.47: Acquire distributed lock
    const lockAcquired = await acquireDistributedLock();
    if (!lockAcquired) {
        logger.debug('[PAGS Claim Processor] Could not acquire lock, skipping cycle');
        return;
    }

    if (!pagsKeypair) {
        // No keypair configured, skip processing
        await releaseDistributedLock();
        return;
    }

    try {
        // Get pending claims
        const pendingClaims = await db.all(`
            SELECT * FROM pags_claims
            WHERE status = 'pending'
            ORDER BY "createdAt" ASC
            LIMIT $1
        `, [MAX_CLAIMS_PER_CYCLE]);

        if (pendingClaims.length === 0) {
            await releaseDistributedLock();
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
                    // v25.47: Per-claim try-catch prevents one failure from blocking others
                    try {
                        await processOneClaim(claim);
                        availableBalance -= claim.amount;
                    } catch (e) {
                        logger.error('[PAGS Claim Processor] Claim failed, continuing to next', {
                            claimId: claim.id,
                            error: e.message
                        });
                        // Continue processing other claims
                    }
                } else {
                    logger.info('[PAGS Claim Processor] Skipping claim due to insufficient balance', {
                        claimId: claim.id,
                        needed: claim.amount,
                        available: availableBalance
                    });
                }
            }
        } else {
            // Process all claims with per-claim error handling
            for (const claim of pendingClaims) {
                // v25.47: Per-claim try-catch prevents one failure from blocking others
                try {
                    await processOneClaim(claim);
                } catch (e) {
                    logger.error('[PAGS Claim Processor] Claim failed, continuing to next', {
                        claimId: claim.id,
                        error: e.message
                    });
                    // Continue processing other claims
                }
            }
        }

    } catch (e) {
        logger.error('[PAGS Claim Processor] Error processing claims', { error: e.message });
    } finally {
        await releaseDistributedLock();
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

        // Update beneficiary claimed amounts - per token, not total
        // Get all beneficiaries for this user and update each one's claimed amount
        const beneficiaries = await db.all(`
            SELECT id, mint, "totalFeesAccumulated", "totalFeesClaimed"
            FROM pags_beneficiaries
            WHERE "twitterUsername" = $1 AND "isActive" = 1
        `, [claim.twitterUsername]);

        for (const b of beneficiaries) {
            const pendingForToken = (b.totalFeesAccumulated || 0) - (b.totalFeesClaimed || 0);
            if (pendingForToken > 0) {
                await db.run(`
                    UPDATE pags_beneficiaries
                    SET "totalFeesClaimed" = "totalFeesClaimed" + $1
                    WHERE id = $2
                `, [pendingForToken, b.id]);

                // BUGFIX: Also update pags_beneficiary_shares.totalFeesClaimed
                // This ensures getPendingRewardsByUsername returns correct amounts after claim
                // Critical for Robinhood tokens and multi-beneficiary scenarios
                const shares = await db.all(`
                    SELECT id, "totalFeesAccumulated", "totalFeesClaimed"
                    FROM pags_beneficiary_shares
                    WHERE "beneficiaryId" = $1 AND LOWER("twitterUsername") = LOWER($2)
                `, [b.id, claim.twitterUsername]);

                for (const share of shares) {
                    const sharePending = (share.totalFeesAccumulated || 0) - (share.totalFeesClaimed || 0);
                    if (sharePending > 0) {
                        await db.run(`
                            UPDATE pags_beneficiary_shares
                            SET "totalFeesClaimed" = "totalFeesClaimed" + $1
                            WHERE id = $2
                        `, [sharePending, share.id]);

                        logger.debug('[PAGS Claim Processor] Updated claimed amount for share', {
                            shareId: share.id,
                            beneficiaryId: b.id,
                            mint: b.mint,
                            claimedAmount: sharePending
                        });
                    }
                }

                logger.debug('[PAGS Claim Processor] Updated claimed amount for beneficiary', {
                    beneficiaryId: b.id,
                    mint: b.mint,
                    claimedAmount: pendingForToken
                });
            }
        }

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
