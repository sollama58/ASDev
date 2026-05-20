/**
 * PAGS Service
 * Core business logic for Pay-to-Twitter/X fee sharing
 * v25.47 - Initial implementation
 * v25.48 - Security hardening: race condition fix, input validation, retry logic
 *
 * Allows token developers to share fees with Twitter/X users.
 * Twitter users can verify their identity via OAuth and claim accumulated rewards.
 */
const { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const logger = require('./logger');
const config = require('../config/env');
const { PAGS } = require('../config/constants');
const pump = require('./pump');

// Dependencies injected at init
let db = null;
let connection = null;
let pagsKeypair = null;
let redis = null;

// Claim lock timeout (120 seconds — covers vault claim + transfer + DB writes under slow RPC)
const CLAIM_LOCK_TIMEOUT_MS = 120000;

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
        const result = await redis.getConnection().set(lockKey, Date.now().toString(), 'PX', CLAIM_LOCK_TIMEOUT_MS, 'NX');
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
        await redis.getConnection().del(lockKey);
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
 * Register a token with one or more Twitter usernames as fee beneficiaries
 * v25.48: Now supports multiple beneficiaries with percentage splits
 *
 * @param {Object} params
 * @param {string} params.mint - Token mint address
 * @param {string} params.creatorPubkey - Creator's public key
 * @param {string} params.twitterUsername - Primary Twitter username (for single beneficiary mode)
 * @param {number} params.feeShareBps - Total fee share in basis points (from on-chain)
 * @param {Array} params.beneficiaries - Optional array of {twitterUsername, shareBps} for multi-beneficiary mode
 *                                        shareBps must sum to 10000 (100%)
 */
async function registerBeneficiary({ mint, creatorPubkey, twitterUsername, feeShareBps = 10000, beneficiaries = null }) {
    if (!db) throw new Error('PAGS service not initialized');

    // Validate inputs
    if (!mint) throw new Error('mint is required');

    // Validate mint is a valid public key
    if (!isValidPublicKey(mint)) {
        throw new Error('Invalid mint address format');
    }

    // creatorPubkey is optional - may be 'unknown' if not available from on-chain
    const finalCreatorPubkey = creatorPubkey && creatorPubkey !== 'unknown' && isValidPublicKey(creatorPubkey)
        ? creatorPubkey
        : null;

    // Validate fee share (0-10000 basis points = 0-100%)
    if (typeof feeShareBps !== 'number' || isNaN(feeShareBps) || feeShareBps < 0 || feeShareBps > 10000) {
        throw new Error('feeShareBps must be a number between 0 and 10000');
    }

    // v25.48: Handle multi-beneficiary mode
    let normalizedBeneficiaries = [];
    let primaryUsername = null;

    if (beneficiaries && Array.isArray(beneficiaries) && beneficiaries.length > 0) {
        // Multi-beneficiary mode
        if (beneficiaries.length > 4) {
            throw new Error('Maximum 4 beneficiaries allowed');
        }

        let totalShareBps = 0;
        for (const b of beneficiaries) {
            if (!b.twitterUsername) {
                throw new Error('Each beneficiary must have a twitterUsername');
            }
            const normalizedName = normalizeUsername(b.twitterUsername);
            if (!isValidTwitterUsername(normalizedName)) {
                throw new Error(`Invalid Twitter username format: ${b.twitterUsername}`);
            }
            const shareBps = parseInt(b.shareBps) || 0;
            if (shareBps <= 0 || shareBps > 10000) {
                throw new Error(`Invalid share percentage for ${normalizedName}: must be between 1 and 10000 basis points`);
            }
            totalShareBps += shareBps;
            normalizedBeneficiaries.push({
                twitterUsername: normalizedName,
                shareBps: shareBps
            });
        }

        // Verify shares sum to 100%
        if (totalShareBps !== 10000) {
            throw new Error(`Beneficiary shares must sum to 100% (10000 bps), got ${totalShareBps / 100}%`);
        }

        // Primary username is the first beneficiary (for backwards compatibility)
        primaryUsername = normalizedBeneficiaries[0].twitterUsername;
    } else {
        // Single beneficiary mode (backwards compatible)
        if (!twitterUsername) {
            throw new Error('twitterUsername is required');
        }
        primaryUsername = normalizeUsername(twitterUsername);
        if (!isValidTwitterUsername(primaryUsername)) {
            throw new Error('Invalid Twitter username format');
        }
        normalizedBeneficiaries = [{ twitterUsername: primaryUsername, shareBps: 10000 }];
    }

    try {
        // Check if already registered
        const existing = await db.get(
            'SELECT * FROM pags_beneficiaries WHERE mint = $1',
            [mint]
        );

        let beneficiaryId;

        if (existing) {
            // Update existing registration
            await db.run(`
                UPDATE pags_beneficiaries
                SET "twitterUsername" = $1, "feeShareBps" = $2, "isActive" = 1, "lastFeeUpdate" = $3
                WHERE mint = $4
            `, [primaryUsername, feeShareBps, Date.now(), mint]);

            beneficiaryId = existing.id;

            // v25.48: Clear existing shares and re-create
            await db.run('DELETE FROM pags_beneficiary_shares WHERE "beneficiaryId" = $1', [beneficiaryId]);

            logger.info('[PAGS] Beneficiary updated', { mint, twitterUsername: primaryUsername, beneficiaryCount: normalizedBeneficiaries.length });
        } else {
            // Insert new registration
            const creatorValue = finalCreatorPubkey || 'unknown';
            const timestamp = Date.now();

            logger.info('[PAGS] Attempting to insert beneficiary', {
                mint,
                creatorPubkey: creatorValue,
                twitterUsername: primaryUsername,
                feeShareBps,
                beneficiaryCount: normalizedBeneficiaries.length,
                timestamp
            });

            const result = await db.run(`
                INSERT INTO pags_beneficiaries (mint, "creatorPubkey", "twitterUsername", "feeShareBps", "createdAt", "isActive")
                VALUES ($1, $2, $3, $4, $5, 1)
                RETURNING id
            `, [mint, creatorValue, primaryUsername, feeShareBps, timestamp]);

            beneficiaryId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;

            if (!beneficiaryId) {
                throw new Error('Insert failed: could not retrieve beneficiary ID after INSERT');
            }
        }

        // v25.48: Insert beneficiary shares
        const timestamp = Date.now();
        for (const b of normalizedBeneficiaries) {
            await db.run(`
                INSERT INTO pags_beneficiary_shares ("beneficiaryId", "twitterUsername", "shareBps", "createdAt")
                VALUES ($1, $2, $3, $4)
                ON CONFLICT ("beneficiaryId", "twitterUsername") DO UPDATE SET "shareBps" = $3
            `, [beneficiaryId, b.twitterUsername, b.shareBps, timestamp]);
        }

        // Verify the insert succeeded by reading it back
        const verification = await db.get('SELECT * FROM pags_beneficiaries WHERE mint = $1', [mint]);
        const shares = await db.all('SELECT * FROM pags_beneficiary_shares WHERE "beneficiaryId" = $1', [beneficiaryId]);

        logger.info('[PAGS] Beneficiary registered', {
            mint,
            twitterUsername: primaryUsername,
            feeShareBps,
            beneficiaryCount: normalizedBeneficiaries.length,
            shares: shares.map(s => ({ username: s.twitterUsername, shareBps: s.shareBps })),
            verified: !!verification
        });

        return {
            id: beneficiaryId,
            mint,
            twitterUsername: primaryUsername,
            feeShareBps,
            feeSharePercent: feeShareBps / 100,
            updated: !!existing,
            // v25.48: Return all beneficiaries with their shares
            beneficiaries: normalizedBeneficiaries.map(b => ({
                twitterUsername: b.twitterUsername,
                shareBps: b.shareBps,
                sharePercent: b.shareBps / 100
            })),
            isMultiBeneficiary: normalizedBeneficiaries.length > 1
        };
    } catch (e) {
        logger.error('[PAGS] Register beneficiary error', { error: e.message, mint });
        throw e;
    }
}

/**
 * Get beneficiary info by mint
 * v25.48: Now includes shares data for multi-beneficiary tokens
 */
async function getBeneficiaryByMint(mint) {
    if (!db) throw new Error('PAGS service not initialized');

    // Validate mint format
    if (!isValidPublicKey(mint)) {
        logger.debug('[PAGS] getBeneficiaryByMint: invalid mint format', { mint });
        return null;
    }

    const result = await db.get(
        'SELECT * FROM pags_beneficiaries WHERE mint = $1',
        [mint]
    );

    if (!result) {
        logger.debug('[PAGS] getBeneficiaryByMint: not found', { mint });
        return null;
    }

    // v25.48: Get beneficiary shares
    const shares = await db.all(
        'SELECT * FROM pags_beneficiary_shares WHERE "beneficiaryId" = $1 ORDER BY "shareBps" DESC',
        [result.id]
    );

    // Attach shares to result
    result.shares = shares.length > 0 ? shares : [
        // Fallback for legacy single-beneficiary registrations
        { twitterUsername: result.twitterUsername, shareBps: 10000, totalFeesAccumulated: result.totalFeesAccumulated, totalFeesClaimed: result.totalFeesClaimed }
    ];
    result.isMultiBeneficiary = shares.length > 1;

    logger.debug('[PAGS] getBeneficiaryByMint result', {
        mint,
        found: true,
        data: { id: result.id, username: result.twitterUsername, isActive: result.isActive, shareCount: result.shares.length }
    });

    return result;
}

/**
 * Get all pending rewards for a Twitter username
 * v25.48: Now queries from pags_beneficiary_shares for multi-beneficiary support
 * Includes fee share percentage for transparency when there are multiple recipients
 */
async function getPendingRewardsByUsername(twitterUsername) {
    if (!db) throw new Error('PAGS service not initialized');

    const normalizedUsername = normalizeUsername(twitterUsername);

    // v25.48: Query from shares table to support multi-beneficiary tokens
    // Join with beneficiaries to get token metadata and on-chain fee share
    let shares, legacyBeneficiaries;
    try {
        shares = await db.all(`
            SELECT s.*, b.mint, b."creatorPubkey", b."feeShareBps" as "onChainFeeShareBps",
                   b.ticker, b.name, b.image, b."isActive"
            FROM pags_beneficiary_shares s
            INNER JOIN pags_beneficiaries b ON s."beneficiaryId" = b.id
            WHERE LOWER(s."twitterUsername") = LOWER($1) AND b."isActive" = 1
        `, [normalizedUsername]);

        // Also check legacy registrations (beneficiaries without shares entries)
        legacyBeneficiaries = await db.all(`
            SELECT b.*, b."feeShareBps" as "onChainFeeShareBps"
            FROM pags_beneficiaries b
            LEFT JOIN pags_beneficiary_shares s ON s."beneficiaryId" = b.id
            WHERE LOWER(b."twitterUsername") = LOWER($1) AND b."isActive" = 1 AND s.id IS NULL
        `, [normalizedUsername]);
    } catch (e) {
        logger.error('[PAGS] Database error in getPendingRewardsByUsername', { error: e.message, username: normalizedUsername });
        return { twitterUsername: normalizedUsername, totalPending: 0, totalClaimed: 0, breakdown: [], beneficiaryCount: 0 };
    }

    // Combine and dedupe by mint
    const beneficiaryMap = new Map();
    for (const s of shares) {
        beneficiaryMap.set(s.mint, {
            ...s,
            shareBps: s.shareBps,
            totalFeesAccumulated: s.totalFeesAccumulated || 0,
            totalFeesClaimed: s.totalFeesClaimed || 0
        });
    }
    for (const b of legacyBeneficiaries) {
        if (!beneficiaryMap.has(b.mint)) {
            beneficiaryMap.set(b.mint, {
                ...b,
                shareBps: 10000, // Legacy = 100% share
                totalFeesAccumulated: b.totalFeesAccumulated || 0,
                totalFeesClaimed: b.totalFeesClaimed || 0
            });
        }
    }

    const beneficiaries = Array.from(beneficiaryMap.values());

    // Calculate total pending (DB + on-chain vaults)
    let totalPending = 0;
    let totalClaimed = 0;
    const breakdown = [];

    for (const b of beneficiaries) {
        const dbPending = (b.totalFeesAccumulated || 0) - (b.totalFeesClaimed || 0);
        // v25.48: onChainFeeShareBps is the total PAGS share from pump.fun, shareBps is this user's share of that
        const onChainFeeShareBps = b.onChainFeeShareBps || 10000;
        const userShareBps = b.shareBps || 10000;

        // Check on-chain vault balances if we have a valid creatorPubkey
        let onChainPending = 0;
        let vaultInfo = null;

        if (connection && b.creatorPubkey && b.creatorPubkey !== 'unknown') {
            try {
                const creatorPubkey = new PublicKey(b.creatorPubkey);
                const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(creatorPubkey);

                // Check BC vault (native SOL)
                let bcFeesLamports = 0;
                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo && bcInfo.lamports > 5000) {
                        bcFeesLamports = bcInfo.lamports - 5000; // Subtract rent-exempt minimum
                    }
                } catch (e) {
                    // Vault doesn't exist or error - that's ok
                }

                // Check AMM vault (wSOL)
                let ammFeesLamports = 0;
                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const bal = await connection.getTokenAccountBalance(ammVaultAtaKey)
                        .catch(() => ({ value: { amount: "0" } }));
                    ammFeesLamports = parseInt(bal.value.amount) || 0;
                } catch (e) {
                    // Vault doesn't exist or error - that's ok
                }

                const totalVaultLamports = bcFeesLamports + ammFeesLamports;
                // v25.48: Apply both on-chain fee share AND this user's share of that
                // Example: 50% on-chain fee share * 25% user share = 12.5% of total vault fees
                const pagsShareLamports = Math.floor(totalVaultLamports * (onChainFeeShareBps / 10000));
                const ourShareLamports = Math.floor(pagsShareLamports * (userShareBps / 10000));
                onChainPending = ourShareLamports / LAMPORTS_PER_SOL;

                if (totalVaultLamports > 0) {
                    vaultInfo = {
                        bcVault: bcVault.toString(),
                        bcFeesLamports,
                        ammFeesLamports,
                        totalVaultLamports,
                        ourShareLamports,
                        onChainPendingSol: onChainPending
                    };
                }
            } catch (e) {
                logger.debug('[PAGS] Failed to check vault for beneficiary', {
                    mint: b.mint,
                    error: e.message
                });
            }
        }

        const combinedPending = dbPending + onChainPending;
        totalClaimed += b.totalFeesClaimed || 0;

        if (combinedPending > 0) {
            totalPending += combinedPending;
            breakdown.push({
                mint: b.mint,
                ticker: b.ticker,
                name: b.name,
                image: b.image,
                pendingAmount: combinedPending,
                dbPending,
                onChainPending,
                vaultInfo,
                totalAccumulated: b.totalFeesAccumulated || 0,
                totalClaimed: b.totalFeesClaimed || 0,
                // v25.48: Include both on-chain fee share and user's share of that
                onChainFeeShareBps,
                onChainFeeSharePercent: onChainFeeShareBps / 100,
                userShareBps,
                userSharePercent: userShareBps / 100,
                // Combined effective share (on-chain * user share)
                effectiveShareBps: Math.floor((onChainFeeShareBps * userShareBps) / 10000),
                effectiveSharePercent: (onChainFeeShareBps * userShareBps) / 1000000,
                hasMultipleRecipients: onChainFeeShareBps < 10000 || userShareBps < 10000,
                creatorPubkey: b.creatorPubkey
            });
        }
    }

    return {
        twitterUsername: normalizedUsername,
        totalPending,
        totalClaimed,
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
            RETURNING id
        `, [twitterId, user.twitterUsername, claimInfo.linkedWallet, claimInfo.claimable, Date.now()]);

        const claimId = claimResult.rows && claimResult.rows[0] ? claimResult.rows[0].id : claimResult.lastID;

        logger.info('[PAGS] Claim created', {
            claimId,
            twitterUsername: user.twitterUsername,
            amount: claimInfo.claimable,
            wallet: claimInfo.linkedWallet ? claimInfo.linkedWallet.slice(0, 8) + '...' : 'none'
        });

        // If we should execute the transfer immediately
        if (executeTransfer && pagsKeypair && connection) {
            try {
                // Step 1: Claim fees from Pump.fun vaults first (if any)
                let vaultClaimResult = null;
                if (claimInfo.breakdown && claimInfo.breakdown.length > 0) {
                    const hasVaultFees = claimInfo.breakdown.some(b => b.vaultInfo && b.vaultInfo.ourShareLamports > 0);
                    if (hasVaultFees) {
                        logger.info('[PAGS] Claiming from vaults before transfer', {
                            claimId,
                            twitterUsername: user.twitterUsername
                        });
                        vaultClaimResult = await claimFromVaults(user.twitterUsername, claimInfo.breakdown);
                        logger.info('[PAGS] Vault claim complete', {
                            claimId,
                            claimedFromVaults: vaultClaimResult.claimed,
                            claimCount: vaultClaimResult.claimResults.length
                        });
                    }
                }

                // Step 2: Re-fetch claimable amount (now includes newly claimed vault fees in DB)
                const updatedClaimInfo = await getClaimableAmount(twitterId);
                const transferAmount = updatedClaimInfo.claimable;

                if (transferAmount < config.PAGS_MIN_CLAIM_SOL) {
                    // Update the claim record with the actual amount if vault claim succeeded but total is still low
                    if (vaultClaimResult && vaultClaimResult.claimed > 0) {
                        await db.run(`
                            UPDATE pags_claims SET amount = $1 WHERE id = $2
                        `, [transferAmount, claimId]);
                    }
                    throw new Error(`Minimum claim amount is ${config.PAGS_MIN_CLAIM_SOL} SOL`);
                }

                // Update claim record with potentially updated amount
                await db.run(`
                    UPDATE pags_claims SET amount = $1 WHERE id = $2
                `, [transferAmount, claimId]);

                // Step 3: Execute the transfer to user's wallet
                const signature = await executeClaimTransfer(claimId, claimInfo.linkedWallet, transferAmount);
                return {
                    success: true,
                    claimId,
                    amount: transferAmount,
                    signature,
                    status: 'completed',
                    vaultsClaimed: vaultClaimResult ? vaultClaimResult.claimResults.length : 0,
                    vaultsClaimedAmount: vaultClaimResult ? vaultClaimResult.claimed : 0
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
 * v25.69 SECURITY: Added claim amount bounds validation
 */
async function executeClaimTransfer(claimId, recipientWallet, amount) {
    if (!pagsKeypair || !connection) {
        throw new Error('PAGS wallet not configured for transfers');
    }

    // Validate recipient
    if (!isValidPublicKey(recipientWallet)) {
        throw new Error('Invalid recipient wallet address');
    }

    // v25.69 SECURITY: Validate claim amount to prevent overflow and excessive transfers
    // Max single claim: 1000 SOL (reasonable limit, prevents draining wallet on manipulation)
    const MAX_CLAIM_SOL = 1000;
    if (typeof amount !== 'number' || isNaN(amount) || !Number.isFinite(amount)) {
        throw new Error('Invalid claim amount');
    }
    if (amount <= 0) {
        throw new Error('Claim amount must be positive');
    }
    if (amount > MAX_CLAIM_SOL) {
        logger.error('[PAGS] Claim amount exceeds maximum', { claimId, amount, maxAllowed: MAX_CLAIM_SOL });
        throw new Error(`Claim amount exceeds maximum allowed (${MAX_CLAIM_SOL} SOL)`);
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

            // Update beneficiary claimed amounts - per token, not total
            // Get the claim record to find the username
            const claim = await db.get('SELECT * FROM pags_claims WHERE id = $1', [claimId]);
            if (claim) {
                // Get all beneficiaries for this user and calculate what was claimed from each
                const beneficiaries = await db.all(`
                    SELECT id, mint, "totalFeesAccumulated", "totalFeesClaimed"
                    FROM pags_beneficiaries
                    WHERE "twitterUsername" = $1 AND "isActive" = 1
                `, [claim.twitterUsername]);

                // Update each beneficiary's totalFeesClaimed based on its individual pending amount
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

                                logger.debug('[PAGS] Updated claimed amount for share', {
                                    shareId: share.id,
                                    beneficiaryId: b.id,
                                    mint: b.mint,
                                    claimedAmount: sharePending
                                });
                            }
                        }

                        logger.debug('[PAGS] Updated claimed amount for beneficiary', {
                            beneficiaryId: b.id,
                            mint: b.mint,
                            claimedAmount: pendingForToken
                        });
                    }
                }
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
 * Claim fees from Pump.fun vaults for all beneficiaries of a user
 * This should be called before executing a user's claim transfer
 *
 * @param {string} twitterUsername - The Twitter username to claim for
 * @param {Array} breakdown - The breakdown of pending rewards (from getClaimableAmount)
 * @returns {Object} Result with claimed amounts and signatures
 */
async function claimFromVaults(twitterUsername, breakdown) {
    if (!pagsKeypair || !connection) {
        logger.debug('[PAGS] Vault claiming skipped - no keypair/connection');
        return { claimed: 0, claimResults: [] };
    }

    const { TransactionInstruction } = require('@solana/web3.js');
    const { PROGRAMS } = require('../config/constants');

    let totalClaimedSol = 0;
    const claimResults = [];

    for (const item of breakdown) {
        // Skip if no on-chain pending fees
        if (!item.vaultInfo || item.vaultInfo.ourShareLamports <= 0) {
            continue;
        }

        // Skip if no valid creatorPubkey
        if (!item.creatorPubkey || item.creatorPubkey === 'unknown') {
            continue;
        }

        // Only claim if there's a meaningful amount (> 0.001 SOL = 1M lamports)
        if (item.vaultInfo.ourShareLamports < 1000000) {
            continue;
        }

        try {
            const creatorPubkey = new PublicKey(item.creatorPubkey);
            const pagsWalletStr = pagsKeypair.publicKey.toString();
            const isDirectCreator = creatorPubkey.toString() === pagsWalletStr;

            const { bcVault } = pump.getCreatorFeeVaults(creatorPubkey);

            // Only process BC vault for now (AMM vault requires different handling)
            if (item.vaultInfo.bcFeesLamports <= 0) {
                continue;
            }

            const tx = new Transaction();

            const [eventAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("__event_authority")],
                PROGRAMS.PUMP
            );

            if (isDirectCreator) {
                // Direct creator - claim_creator_fees
                const claimDiscriminator = pump.buildClaimFeesData();

                const claimKeys = [
                    { pubkey: pagsKeypair.publicKey, isSigner: false, isWritable: true },
                    { pubkey: bcVault, isSigner: false, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: eventAuthority, isSigner: false, isWritable: false },
                    { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false }
                ];

                tx.add(new TransactionInstruction({
                    keys: claimKeys,
                    programId: PROGRAMS.PUMP,
                    data: claimDiscriminator
                }));

                logger.info('[PAGS] Claiming from vault as direct creator', {
                    mint: item.mint,
                    bcFeesLamports: item.vaultInfo.bcFeesLamports
                });

            } else {
                // Shareholder - need distribute_creator_fees
                // This requires fetching the fee_sharing_config which has all shareholders
                const mintExtractor = require('./mintExtractor');

                const verifyResult = await mintExtractor.verifyFeeRecipient(
                    item.mint,
                    pagsWalletStr,
                    connection
                );

                if (!verifyResult.isRecipient || !verifyResult.allShareholders) {
                    logger.warn('[PAGS] Cannot claim from vault - not a verified recipient', {
                        mint: item.mint
                    });
                    continue;
                }

                const configData = {
                    shareholders: verifyResult.allShareholders.map(s => ({
                        pubkey: new PublicKey(s.pubkey),
                        shareBps: s.bps
                    }))
                };

                const { sharingConfigPDA } = pump.getShareholderFeeVaults(creatorPubkey);
                const distributeDiscriminator = pump.buildDistributeFeesData();

                const distributeKeys = [
                    { pubkey: sharingConfigPDA, isSigner: false, isWritable: true },
                    { pubkey: bcVault, isSigner: false, isWritable: true },
                ];

                // Add ALL shareholders as writable accounts
                for (const shareholder of configData.shareholders) {
                    distributeKeys.push({
                        pubkey: shareholder.pubkey,
                        isSigner: false,
                        isWritable: true
                    });
                }

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

                logger.info('[PAGS] Distributing from vault as shareholder', {
                    mint: item.mint,
                    totalFees: item.vaultInfo.bcFeesLamports,
                    ourShare: item.vaultInfo.ourShareLamports,
                    shareholderCount: configData.shareholders.length
                });
            }

            // Execute the transaction
            tx.feePayer = pagsKeypair.publicKey;
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.sign(pagsKeypair);

            const signature = await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            });

            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, 'confirmed');

            const claimedSol = item.vaultInfo.ourShareLamports / LAMPORTS_PER_SOL;
            totalClaimedSol += claimedSol;

            claimResults.push({
                mint: item.mint,
                claimedSol,
                signature,
                isDirectCreator
            });

            // Record the claimed fee to the database
            await recordFeeCollection(
                item.mint,
                claimedSol,
                'vault_claim',
                signature,
                false // Don't apply fee share - ourShareLamports is already the correct amount
            );

            logger.info('[PAGS] Successfully claimed from vault', {
                mint: item.mint,
                twitterUsername,
                claimedSol: claimedSol.toFixed(6),
                signature
            });

        } catch (e) {
            logger.warn('[PAGS] Failed to claim from vault', {
                mint: item.mint,
                error: e.message
            });
            // Continue with other vaults even if one fails
        }
    }

    return {
        claimed: totalClaimedSol,
        claimResults
    };
}

/**
 * Record fee collection for a beneficiary
 * v25.48: Now distributes fees among multiple beneficiary shares
 *
 * IMPORTANT: Fee share percentage handling
 * - If applyFeeShare=true (default), the amount is the TOTAL fee and will be
 *   multiplied by the beneficiary's feeShareBps percentage before recording
 * - If applyFeeShare=false, the amount is already the PAGS share
 *   (e.g., when recording from vault claims that are already calculated)
 *
 * Example with multiple beneficiaries:
 * - Total PAGS fee: 1.0 SOL (after on-chain split applied)
 * - 2 beneficiaries: @user1 (60%), @user2 (40%)
 * - @user1 receives: 0.6 SOL, @user2 receives: 0.4 SOL
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

    // v25.69 SECURITY: Amount bounds validation to prevent overflow/manipulation
    // Max reasonable fee: 10,000 SOL per transaction (prevents integer overflow)
    const MAX_FEE_SOL = 10000;
    if (!Number.isFinite(amount) || amount > MAX_FEE_SOL) {
        logger.warn('[PAGS] Fee amount exceeds maximum allowed', { mint, amount, maxAllowed: MAX_FEE_SOL });
        throw new Error(`Fee amount exceeds maximum allowed (${MAX_FEE_SOL} SOL)`);
    }

    // Get beneficiary with shares
    const beneficiary = await getBeneficiaryByMint(mint);
    if (!beneficiary) {
        throw new Error('Beneficiary not found for mint');
    }

    // Calculate the actual PAGS fee amount based on on-chain share percentage
    let pagsAmount = amount;
    if (applyFeeShare && beneficiary.feeShareBps && beneficiary.feeShareBps < 10000) {
        pagsAmount = amount * (beneficiary.feeShareBps / 10000);
        logger.info('[PAGS] Applying on-chain fee share percentage', {
            mint,
            totalFee: amount,
            feeShareBps: beneficiary.feeShareBps,
            feeSharePercent: beneficiary.feeShareBps / 100,
            pagsAmount
        });
    }

    // v25.48: Distribute among beneficiary shares
    const shares = beneficiary.shares || [{ twitterUsername: beneficiary.twitterUsername, shareBps: 10000 }];
    const distributions = [];

    try {
        for (const share of shares) {
            const userAmount = pagsAmount * (share.shareBps / 10000);

            // Update the share's accumulated fees
            if (share.id) {
                // Real share record exists
                await db.run(`
                    UPDATE pags_beneficiary_shares
                    SET "totalFeesAccumulated" = "totalFeesAccumulated" + $1
                    WHERE id = $2
                `, [userAmount, share.id]);
            }

            distributions.push({
                twitterUsername: share.twitterUsername,
                shareBps: share.shareBps,
                sharePercent: share.shareBps / 100,
                amount: userAmount
            });

            logger.debug('[PAGS] Fee distributed to share', {
                mint,
                twitterUsername: share.twitterUsername,
                shareBps: share.shareBps,
                amount: userAmount
            });
        }

        // Update the main beneficiary total (for backwards compatibility)
        await db.run(`
            UPDATE pags_beneficiaries
            SET "totalFeesAccumulated" = "totalFeesAccumulated" + $1, "lastFeeUpdate" = $2
            WHERE id = $3
        `, [pagsAmount, Date.now(), beneficiary.id]);
    } catch (e) {
        logger.error('[PAGS] Fee distribution DB error — partial update may have occurred', {
            mint,
            beneficiaryId: beneficiary.id,
            pagsAmount,
            error: e.message
        });
        throw e;
    }

    // Log the fee collection
    await db.run(`
        INSERT INTO pags_fee_logs ("beneficiaryId", amount, source, "txSignature", "collectedAt")
        VALUES ($1, $2, $3, $4, $5)
    `, [beneficiary.id, pagsAmount, source, txSignature, Date.now()]);

    logger.info('[PAGS] Fee recorded and distributed', {
        mint,
        beneficiaryId: beneficiary.id,
        primaryUsername: beneficiary.twitterUsername,
        totalFeeInput: amount,
        pagsAmountRecorded: pagsAmount,
        feeShareBps: beneficiary.feeShareBps,
        distributions: distributions.map(d => ({ user: d.twitterUsername, amount: d.amount.toFixed(6) })),
        source
    });

    return {
        beneficiaryId: beneficiary.id,
        twitterUsername: beneficiary.twitterUsername,
        feeShareBps: beneficiary.feeShareBps,
        feeSharePercent: beneficiary.feeShareBps / 100,
        totalFeeInput: amount,
        actualAmountRecorded: pagsAmount,
        newTotal: (beneficiary.totalFeesAccumulated || 0) + pagsAmount,
        // v25.48: Return distribution breakdown
        distributions,
        isMultiBeneficiary: distributions.length > 1
    };
}

/**
 * Fully delete PAGS registration for a token
 * v25.68: Changed from deactivation to full deletion
 */
async function deactivateBeneficiary(mint) {
    if (!db) throw new Error('PAGS service not initialized');

    // Validate mint
    if (!isValidPublicKey(mint)) {
        throw new Error('Invalid mint address');
    }

    // First get the beneficiary ID
    const beneficiary = await db.get(`
        SELECT id FROM pags_beneficiaries WHERE mint = $1
    `, [mint]);

    if (!beneficiary) {
        logger.warn('[PAGS] Beneficiary not found for deletion', { mint });
        return { success: true, message: 'Token was not registered' };
    }

    // Delete from child table first (beneficiary shares)
    await db.run(`
        DELETE FROM pags_beneficiary_shares WHERE "beneficiaryId" = $1
    `, [beneficiary.id]);

    // Delete from main table
    await db.run(`
        DELETE FROM pags_beneficiaries WHERE mint = $1
    `, [mint]);

    logger.info('[PAGS] Beneficiary fully deleted', { mint, beneficiaryId: beneficiary.id });

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
        'SELECT "linkedWallet" FROM pags_twitter_users WHERE LOWER("twitterUsername") = LOWER($1) AND "isActive" = 1',
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
    claimFromVaults,
    recordFeeCollection,
    deactivateBeneficiary,
    getStats,
    lookupUsername
};
