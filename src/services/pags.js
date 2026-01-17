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
    if (!twitterUsername) throw new Error('twitterUsername is required');

    // Validate mint is a valid public key
    if (!isValidPublicKey(mint)) {
        throw new Error('Invalid mint address format');
    }

    // creatorPubkey is optional - may be 'unknown' if not available from on-chain
    // Only validate if it looks like a pubkey (not 'unknown')
    const finalCreatorPubkey = creatorPubkey && creatorPubkey !== 'unknown' && isValidPublicKey(creatorPubkey)
        ? creatorPubkey
        : null;

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
        // v25.63: Note - tokens CAN be registered for both PAGS and platform (Robinhood)
        // This allows creators to split fees (e.g., 50% to Robinhood holders, 50% to Twitter via PAGS)
        // The exclusion logic in leaderboard/KOTH/airdrop ensures no double-dipping

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
        // Use 'unknown' as placeholder if creatorPubkey is null (column is NOT NULL in legacy schema)
        const creatorValue = finalCreatorPubkey || 'unknown';
        const timestamp = Date.now();

        logger.info('[PAGS] Attempting to insert beneficiary', {
            mint,
            creatorPubkey: creatorValue,
            twitterUsername: normalizedUsername,
            feeShareBps,
            timestamp
        });

        const result = await db.run(`
            INSERT INTO pags_beneficiaries (mint, "creatorPubkey", "twitterUsername", "feeShareBps", "createdAt", "isActive")
            VALUES ($1, $2, $3, $4, $5, 1)
        `, [mint, creatorValue, normalizedUsername, feeShareBps, timestamp]);

        // Verify the insert succeeded by reading it back
        const verification = await db.get('SELECT * FROM pags_beneficiaries WHERE mint = $1', [mint]);

        logger.info('[PAGS] Beneficiary registered', {
            mint,
            twitterUsername: normalizedUsername,
            feeShareBps,
            insertResult: result,
            verified: !!verification,
            verifiedData: verification ? {
                id: verification.id,
                isActive: verification.isActive,
                username: verification.twitterUsername
            } : null
        });

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
        logger.debug('[PAGS] getBeneficiaryByMint: invalid mint format', { mint });
        return null;
    }

    const result = await db.get(
        'SELECT * FROM pags_beneficiaries WHERE mint = $1',
        [mint]
    );

    logger.debug('[PAGS] getBeneficiaryByMint result', {
        mint,
        found: !!result,
        data: result ? { id: result.id, username: result.twitterUsername, isActive: result.isActive } : null
    });

    return result;
}

/**
 * Get all pending rewards for a Twitter username
 * Includes fee share percentage for transparency when there are multiple recipients
 */
async function getPendingRewardsByUsername(twitterUsername) {
    if (!db) throw new Error('PAGS service not initialized');

    const normalizedUsername = normalizeUsername(twitterUsername);

    // v25.44: Get metadata directly from pags_beneficiaries (not tokens table)
    // This keeps PAGS tokens SEPARATE from platform/robinhood tokens
    const beneficiaries = await db.all(`
        SELECT b.*
        FROM pags_beneficiaries b
        WHERE b."twitterUsername" = $1 AND b."isActive" = 1
    `, [normalizedUsername]);

    // Calculate total pending (DB + on-chain vaults)
    let totalPending = 0;
    const breakdown = [];

    for (const b of beneficiaries) {
        const dbPending = (b.totalFeesAccumulated || 0) - (b.totalFeesClaimed || 0);
        const feeShareBps = b.feeShareBps || 10000;

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
                const ourShareLamports = Math.floor(totalVaultLamports * (feeShareBps / 10000));
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
                // Include fee share info for transparency
                feeShareBps,
                feeSharePercent: feeShareBps / 100,
                hasMultipleRecipients: feeShareBps < 10000,
                creatorPubkey: b.creatorPubkey
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
    claimFromVaults,
    recordFeeCollection,
    deactivateBeneficiary,
    getStats,
    lookupUsername
};
