/**
 * PAGS Service
 * Core business logic for Pay-to-Twitter/X fee sharing
 * v25.47 - Initial implementation
 * v25.48 - Security hardening: race condition fix, input validation, retry logic
 *
 * Allows token developers to share fees with Twitter/X users.
 * Twitter users can verify their identity via OAuth and claim accumulated rewards.
 */
const { PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const logger = require('./logger');
const config = require('../config/env');
const { PAGS } = require('../config/constants');

// Dependencies injected at init
let db = null;
let connection = null;
let pagsKeypair = null;
let redis = null;

// Claim lock timeout (30 seconds)
const CLAIM_LOCK_TIMEOUT_MS = 30000;

// Retry configuration for blockchain operations
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Initialize PAGS service with dependencies
 */
function init(deps) {
    db = deps.db;
    connection = deps.connection;
    pagsKeypair = deps.pagsKeypair || null;
    redis = deps.redis || null;

    if (!config.PAGS_WALLET) {
        logger.warn('[PAGS] PAGS_WALLET not configured - claims will be disabled');
    }

    logger.info('[PAGS] Service initialized', {
        enabled: config.PAGS_ENABLED,
        walletConfigured: !!config.PAGS_WALLET,
        minClaimSol: config.PAGS_MIN_CLAIM_SOL,
        redisConfigured: !!redis
    });
}

/**
 * Normalize Twitter username (lowercase, remove @)
 */
function normalizeUsername(username) {
    if (!username) return null;
    return username.toLowerCase().replace(/^@/, '').trim();
}

/**
 * Validate Twitter username format
 * Twitter allows 1-15 chars for legacy accounts, alphanumeric and underscores
 */
function isValidTwitterUsername(username) {
    if (!username) return false;
    const normalized = normalizeUsername(username);
    // Twitter usernames: 1-15 chars, alphanumeric and underscores
    // Relaxed from 4-15 to support legacy short usernames
    return /^[a-z0-9_]{1,15}$/i.test(normalized);
}

/**
 * Validate Solana public key format
 */
function isValidPublicKey(pubkeyStr) {
    if (!pubkeyStr || typeof pubkeyStr !== 'string') return false;
    try {
        new PublicKey(pubkeyStr);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Acquire a distributed lock for claim processing (prevents double-spend)
 */
async function acquireClaimLock(twitterId) {
    if (!redis) {
        // Fallback to database-level check if Redis not available
        logger.warn('[PAGS] Redis not available for distributed lock');
        return true;
    }

    const lockKey = `pags:claim:lock:${twitterId}`;
    try {
        // SET NX with expiration (atomic operation)
        const result = await redis.getClient().set(lockKey, Date.now().toString(), 'PX', CLAIM_LOCK_TIMEOUT_MS, 'NX');
        return result === 'OK';
    } catch (e) {
        logger.error('[PAGS] Failed to acquire claim lock', { error: e.message, twitterId });
        return false;
    }
}

/**
 * Release a distributed lock
 */
async function releaseClaimLock(twitterId) {
    if (!redis) return;

    const lockKey = `pags:claim:lock:${twitterId}`;
    try {
        await redis.getClient().del(lockKey);
    } catch (e) {
        logger.error('[PAGS] Failed to release claim lock', { error: e.message, twitterId });
    }
}

/**
 * Sleep utility for retry logic
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Register a token with a Twitter username as fee beneficiary
 */
async function registerBeneficiary({ mint, creatorPubkey, twitterUsername, feeShareBps = 10000 }) {
    if (!db) throw new Error('PAGS service not initialized');

    // Validate inputs
    if (!mint) throw new Error('mint is required');
    if (!creatorPubkey) throw new Error('creatorPubkey is required');
    if (!twitterUsername) throw new Error('twitterUsername is required');

    // Validate mint is a valid public key
    if (!isValidPublicKey(mint)) {
        throw new Error('Invalid mint address format');
    }

    // Validate creator pubkey
    if (!isValidPublicKey(creatorPubkey)) {
        throw new Error('Invalid creator public key format');
    }

    const normalizedUsername = normalizeUsername(twitterUsername);
    if (!isValidTwitterUsername(normalizedUsername)) {
        throw new Error('Invalid Twitter username format');
    }

    // Validate fee share (0-10000 basis points = 0-100%)
    // Type check to prevent string comparison issues
    if (typeof feeShareBps !== 'number' || isNaN(feeShareBps) || feeShareBps < 0 || feeShareBps > 10000) {
        throw new Error('feeShareBps must be a number between 0 and 10000');
    }

    try {
        // Check if already registered
        const existing = await db.get(
            'SELECT * FROM pags_beneficiaries WHERE mint = $1',
            [mint]
        );

        if (existing) {
            // Update existing registration
            await db.run(`
                UPDATE pags_beneficiaries
                SET "twitterUsername" = $1, "feeShareBps" = $2, "isActive" = 1, "lastFeeUpdate" = $3
                WHERE mint = $4
            `, [normalizedUsername, feeShareBps, Date.now(), mint]);

            logger.info('[PAGS] Beneficiary updated', { mint, twitterUsername: normalizedUsername });

            return {
                id: existing.id,
                mint,
                twitterUsername: normalizedUsername,
                feeShareBps,
                feeSharePercent: feeShareBps / 100,
                updated: true
            };
        }

        // Insert new registration
        const result = await db.run(`
            INSERT INTO pags_beneficiaries (mint, "creatorPubkey", "twitterUsername", "feeShareBps", "createdAt")
            VALUES ($1, $2, $3, $4, $5)
        `, [mint, creatorPubkey, normalizedUsername, feeShareBps, Date.now()]);

        logger.info('[PAGS] Beneficiary registered', { mint, twitterUsername: normalizedUsername, feeShareBps });

        return {
            id: result.lastID,
            mint,
            twitterUsername: normalizedUsername,
            feeShareBps,
            feeSharePercent: feeShareBps / 100,
            updated: false
        };
    } catch (e) {
        logger.error('[PAGS] Register beneficiary error', { error: e.message, mint });
        throw e;
    }
}

/**
 * Get beneficiary info by mint
 */
async function getBeneficiaryByMint(mint) {
    if (!db) throw new Error('PAGS service not initialized');

    // Validate mint format
    if (!isValidPublicKey(mint)) {
        return null;
    }

    const result = await db.get(
        'SELECT * FROM pags_beneficiaries WHERE mint = $1',
        [mint]
    );

    return result;
}

/**
 * Get all pending rewards for a Twitter username
 * Includes fee share percentage for transparency when there are multiple recipients
 */
async function getPendingRewardsByUsername(twitterUsername) {
    if (!db) throw new Error('PAGS service not initialized');

    const normalizedUsername = normalizeUsername(twitterUsername);

    // Get all active beneficiaries for this username
    const beneficiaries = await db.all(`
        SELECT b.*, t.ticker, t.name, t.image
        FROM pags_beneficiaries b
        LEFT JOIN tokens t ON t.mint = b.mint
        WHERE b."twitterUsername" = $1 AND b."isActive" = 1
    `, [normalizedUsername]);

    // Calculate total pending
    let totalPending = 0;
    const breakdown = [];

    for (const b of beneficiaries) {
        const pending = (b.totalFeesAccumulated || 0) - (b.totalFeesClaimed || 0);
        if (pending > 0) {
            totalPending += pending;
            breakdown.push({
                mint: b.mint,
                ticker: b.ticker,
                name: b.name,
                image: b.image,
                pendingAmount: pending,
                totalAccumulated: b.totalFeesAccumulated || 0,
                totalClaimed: b.totalFeesClaimed || 0,
                // Include fee share info for transparency
                feeShareBps: b.feeShareBps || 10000,
                feeSharePercent: (b.feeShareBps || 10000) / 100,
                hasMultipleRecipients: b.feeShareBps && b.feeShareBps < 10000
            });
        }
    }

    return {
        twitterUsername: normalizedUsername,
        totalPending,
        breakdown,
        beneficiaryCount: beneficiaries.length
    };
}

/**
 * Get claimable amount for a verified Twitter user (by twitterId)
 */
async function getClaimableAmount(twitterId) {
    if (!db) throw new Error('PAGS service not initialized');

    // Get the user's current username
    const user = await db.get(
        'SELECT * FROM pags_twitter_users WHERE "twitterId" = $1 AND "isActive" = 1',
        [twitterId]
    );

    if (!user) {
        return { claimable: 0, linkedWallet: null, error: 'User not found or inactive' };
    }

    if (!user.linkedWallet) {
        return { claimable: 0, linkedWallet: null, error: 'No wallet linked' };
    }

    const rewards = await getPendingRewardsByUsername(user.twitterUsername);

    return {
        claimable: rewards.totalPending,
        linkedWallet: user.linkedWallet,
        twitterUsername: user.twitterUsername,
        breakdown: rewards.breakdown
    };
}

/**
 * Link a Solana wallet to a verified Twitter account
 */
async function linkWallet(twitterId, walletPubkey) {
    if (!db) throw new Error('PAGS service not initialized');

    // Validate wallet address
    if (!isValidPublicKey(walletPubkey)) {
        throw new Error('Invalid wallet address');
    }

    // Check if user exists
    const user = await db.get(
        'SELECT * FROM pags_twitter_users WHERE "twitterId" = $1',
        [twitterId]
    );

    if (!user) {
        throw new Error('User not found - complete Twitter OAuth first');
    }

    // Update wallet link
    await db.run(`
        UPDATE pags_twitter_users
        SET "linkedWallet" = $1, "walletLinkedAt" = $2
        WHERE "twitterId" = $3
    `, [walletPubkey, Date.now(), twitterId]);

    logger.info('[PAGS] Wallet linked', {
        twitterId,
        twitterUsername: user.twitterUsername,
        wallet: walletPubkey.slice(0, 8) + '...'
    });

    return {
        success: true,
        linkedWallet: walletPubkey,
        twitterUsername: user.twitterUsername
    };
}

/**
 * Process a claim for a verified Twitter user
 * Creates a pending claim record and optionally processes the transfer
 * Uses distributed locking to prevent race conditions
 */
async function processClaim(twitterId, executeTransfer = false) {
    if (!db) throw new Error('PAGS service not initialized');

    // Acquire distributed lock to prevent double-spend
    const lockAcquired = await acquireClaimLock(twitterId);
    if (!lockAcquired) {
        throw new Error('Another claim is being processed. Please wait and try again.');
    }

    try {
        // Get claimable amount
        const claimInfo = await getClaimableAmount(twitterId);

        if (claimInfo.error) {
            throw new Error(claimInfo.error);
        }

        if (claimInfo.claimable < config.PAGS_MIN_CLAIM_SOL) {
            throw new Error(`Minimum claim amount is ${config.PAGS_MIN_CLAIM_SOL} SOL`);
        }

        // Double-check for pending claims within the lock
        const pendingClaim = await db.get(`
            SELECT * FROM pags_claims
            WHERE "twitterId" = $1 AND status = 'pending'
        `, [twitterId]);

        if (pendingClaim) {
            throw new Error('You have a pending claim being processed');
        }

        // Get user info
        const user = await db.get(
            'SELECT * FROM pags_twitter_users WHERE "twitterId" = $1',
            [twitterId]
        );

        // Create claim record
        const claimResult = await db.run(`
            INSERT INTO pags_claims ("twitterId", "twitterUsername", "recipientWallet", amount, status, "createdAt")
            VALUES ($1, $2, $3, $4, 'pending', $5)
        `, [twitterId, user.twitterUsername, claimInfo.linkedWallet, claimInfo.claimable, Date.now()]);

        const claimId = claimResult.lastID;

        logger.info('[PAGS] Claim created', {
            claimId,
            twitterUsername: user.twitterUsername,
            amount: claimInfo.claimable,
            wallet: claimInfo.linkedWallet.slice(0, 8) + '...'
        });

        // If we should execute the transfer immediately
        if (executeTransfer && pagsKeypair && connection) {
            try {
                const signature = await executeClaimTransfer(claimId, claimInfo.linkedWallet, claimInfo.claimable);
                return {
                    success: true,
                    claimId,
                    amount: claimInfo.claimable,
                    signature,
                    status: 'completed'
                };
            } catch (e) {
                // Mark claim as failed
                await db.run(`
                    UPDATE pags_claims SET status = 'failed', "failReason" = $1 WHERE id = $2
                `, [e.message, claimId]);
                throw e;
            }
        }

        return {
            success: true,
            claimId,
            amount: claimInfo.claimable,
            status: 'pending'
        };
    } finally {
        // Always release the lock
        await releaseClaimLock(twitterId);
    }
}

/**
 * Execute the actual SOL transfer for a claim with retry logic
 */
async function executeClaimTransfer(claimId, recipientWallet, amount) {
    if (!pagsKeypair || !connection) {
        throw new Error('PAGS wallet not configured for transfers');
    }

    // Validate recipient
    if (!isValidPublicKey(recipientWallet)) {
        throw new Error('Invalid recipient wallet address');
    }

    const recipientPubkey = new PublicKey(recipientWallet);
    const lamports = Math.floor(amount * 1e9);

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Create transfer transaction
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: pagsKeypair.publicKey,
                    toPubkey: recipientPubkey,
                    lamports
                })
            );

            // Get recent blockhash with lastValidBlockHeight for proper confirmation
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = pagsKeypair.publicKey;

            // Sign and send
            tx.sign(pagsKeypair);
            const signature = await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            });

            // Wait for confirmation with proper parameters
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, 'confirmed');

            // Update claim record
            await db.run(`
                UPDATE pags_claims
                SET status = 'completed', signature = $1, "completedAt" = $2
                WHERE id = $3
            `, [signature, Date.now(), claimId]);

            // Update beneficiary claimed amounts
            const claim = await db.get('SELECT * FROM pags_claims WHERE id = $1', [claimId]);
            if (claim) {
                await db.run(`
                    UPDATE pags_beneficiaries
                    SET "totalFeesClaimed" = "totalFeesClaimed" + $1
                    WHERE "twitterUsername" = $2
                `, [amount, claim.twitterUsername]);
            }

            logger.info('[PAGS] Claim transfer completed', {
                claimId,
                signature,
                amount,
                attempt
            });

            return signature;

        } catch (e) {
            lastError = e;
            logger.warn('[PAGS] Claim transfer attempt failed', {
                claimId,
                attempt,
                maxRetries: MAX_RETRIES,
                error: e.message
            });

            if (attempt < MAX_RETRIES) {
                await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
            }
        }
    }

    throw new Error(`Transfer failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Record fee collection for a beneficiary
 *
 * IMPORTANT: Fee share percentage handling
 * - If applyFeeShare=true (default), the amount is the TOTAL fee and will be
 *   multiplied by the beneficiary's feeShareBps percentage before recording
 * - If applyFeeShare=false, the amount is already the beneficiary's share
 *   (e.g., when recording manual admin entries that are already calculated)
 *
 * Example with multiple Pump.fun recipients:
 * - Token has 2 recipients: Creator (70%) and PAGS beneficiary (30%)
 * - Total fee collected: 1.0 SOL
 * - If applyFeeShare=true: Records 1.0 * (3000/10000) = 0.3 SOL
 * - If applyFeeShare=false: Records 1.0 SOL as-is (caller already calculated)
 */
async function recordFeeCollection(mint, amount, source = 'manual', txSignature = null, applyFeeShare = true) {
    if (!db) throw new Error('PAGS service not initialized');

    // Validate mint
    if (!isValidPublicKey(mint)) {
        throw new Error('Invalid mint address');
    }

    // Validate amount is a positive number
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
        throw new Error('Amount must be a positive number');
    }

    // Get beneficiary
    const beneficiary = await getBeneficiaryByMint(mint);
    if (!beneficiary) {
        throw new Error('Beneficiary not found for mint');
    }

    // Calculate the actual fee amount based on beneficiary's share percentage
    // feeShareBps is in basis points (10000 = 100%)
    let actualAmount = amount;
    if (applyFeeShare && beneficiary.feeShareBps && beneficiary.feeShareBps < 10000) {
        actualAmount = amount * (beneficiary.feeShareBps / 10000);
        logger.info('[PAGS] Applying fee share percentage', {
            mint,
            totalFee: amount,
            feeShareBps: beneficiary.feeShareBps,
            feeSharePercent: beneficiary.feeShareBps / 100,
            actualAmount
        });
    }

    // Update accumulated fees with the beneficiary's share
    await db.run(`
        UPDATE pags_beneficiaries
        SET "totalFeesAccumulated" = "totalFeesAccumulated" + $1, "lastFeeUpdate" = $2
        WHERE id = $3
    `, [actualAmount, Date.now(), beneficiary.id]);

    // Log the fee collection (log both total and actual for transparency)
    await db.run(`
        INSERT INTO pags_fee_logs ("beneficiaryId", amount, source, "txSignature", "collectedAt")
        VALUES ($1, $2, $3, $4, $5)
    `, [beneficiary.id, actualAmount, source, txSignature, Date.now()]);

    logger.info('[PAGS] Fee recorded', {
        mint,
        beneficiaryId: beneficiary.id,
        twitterUsername: beneficiary.twitterUsername,
        totalFeeInput: amount,
        actualAmountRecorded: actualAmount,
        feeShareBps: beneficiary.feeShareBps,
        source
    });

    return {
        beneficiaryId: beneficiary.id,
        twitterUsername: beneficiary.twitterUsername,
        feeShareBps: beneficiary.feeShareBps,
        feeSharePercent: beneficiary.feeShareBps / 100,
        totalFeeInput: amount,
        actualAmountRecorded: actualAmount,
        newTotal: (beneficiary.totalFeesAccumulated || 0) + actualAmount
    };
}

/**
 * Deactivate PAGS for a token
 */
async function deactivateBeneficiary(mint) {
    if (!db) throw new Error('PAGS service not initialized');

    // Validate mint
    if (!isValidPublicKey(mint)) {
        throw new Error('Invalid mint address');
    }

    await db.run(`
        UPDATE pags_beneficiaries SET "isActive" = 0 WHERE mint = $1
    `, [mint]);

    logger.info('[PAGS] Beneficiary deactivated', { mint });

    return { success: true };
}

/**
 * Get PAGS global statistics
 */
async function getStats() {
    if (!db) throw new Error('PAGS service not initialized');

    const stats = await db.get(`
        SELECT
            COUNT(*) as totalBeneficiaries,
            SUM("totalFeesAccumulated") as totalFeesAccumulated,
            SUM("totalFeesClaimed") as totalFeesClaimed,
            COUNT(CASE WHEN "isActive" = 1 THEN 1 END) as activeBeneficiaries
        FROM pags_beneficiaries
    `);

    const userStats = await db.get(`
        SELECT
            COUNT(*) as totalUsers,
            COUNT(CASE WHEN "linkedWallet" IS NOT NULL THEN 1 END) as usersWithWallet
        FROM pags_twitter_users WHERE "isActive" = 1
    `);

    const claimStats = await db.get(`
        SELECT
            COUNT(*) as totalClaims,
            SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as totalClaimedSol,
            COUNT(CASE WHEN status = 'completed' THEN 1 END) as completedClaims
        FROM pags_claims
    `);

    return {
        // Include PAGS wallet address for frontend display
        pagsWallet: config.PAGS_WALLET || null,
        beneficiaries: {
            total: stats?.totalBeneficiaries || 0,
            active: stats?.activeBeneficiaries || 0
        },
        fees: {
            totalAccumulated: stats?.totalFeesAccumulated || 0,
            totalClaimed: stats?.totalFeesClaimed || 0,
            pending: (stats?.totalFeesAccumulated || 0) - (stats?.totalFeesClaimed || 0)
        },
        users: {
            total: userStats?.totalUsers || 0,
            withWallet: userStats?.usersWithWallet || 0
        },
        claims: {
            total: claimStats?.totalClaims || 0,
            completed: claimStats?.completedClaims || 0,
            totalSolClaimed: claimStats?.totalClaimedSol || 0
        }
    };
}

/**
 * Lookup rewards for any Twitter username (public endpoint)
 */
async function lookupUsername(twitterUsername) {
    if (!db) throw new Error('PAGS service not initialized');

    const normalizedUsername = normalizeUsername(twitterUsername);
    if (!isValidTwitterUsername(normalizedUsername)) {
        return { found: false, error: 'Invalid username format' };
    }

    const rewards = await getPendingRewardsByUsername(normalizedUsername);

    // Check if user has already claimed/linked
    const user = await db.get(
        'SELECT "linkedWallet" FROM pags_twitter_users WHERE "twitterUsername" = $1 AND "isActive" = 1',
        [normalizedUsername]
    );

    return {
        found: rewards.beneficiaryCount > 0,
        twitterUsername: normalizedUsername,
        hasPendingRewards: rewards.totalPending > 0,
        pendingAmount: rewards.totalPending,
        tokenCount: rewards.breakdown.length,
        isLinked: !!user?.linkedWallet
    };
}

module.exports = {
    init,
    normalizeUsername,
    isValidTwitterUsername,
    isValidPublicKey,
    registerBeneficiary,
    getBeneficiaryByMint,
    getPendingRewardsByUsername,
    getClaimableAmount,
    linkWallet,
    processClaim,
    executeClaimTransfer,
    recordFeeCollection,
    deactivateBeneficiary,
    getStats,
    lookupUsername
};
