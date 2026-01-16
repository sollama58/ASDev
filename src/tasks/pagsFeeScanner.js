/**
 * PAGS Fee Scanner
 * Automatically detects and claims fees from Pump.fun vaults for PAGS-registered tokens
 *
 * Handles two fee collection scenarios:
 *
 * 1. DIRECT CREATOR (100% fee share):
 *    - PAGS wallet IS the original token creator
 *    - Fees accumulate in PAGS wallet's own creator vault
 *    - Uses claim_creator_fees instruction to claim directly
 *
 * 2. FEE SHAREHOLDER (<100% fee share):
 *    - PAGS wallet is listed in another creator's fee_sharing_config
 *    - Fees accumulate in original creator's vault
 *    - Uses distribute_creator_fees to distribute to all shareholders
 *
 * Flow:
 * 1. For each PAGS beneficiary, check if creatorPubkey matches PAGS wallet
 * 2. If direct creator: check PAGS wallet's own vault and claim directly
 * 3. If shareholder: check original creator's vault and distribute
 * 4. Record claimed fees in database for Twitter users to claim
 *
 * v25.53 - Added direct creator support (100% share scenario)
 */
const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { BN } = require('@coral-xyz/anchor');
const logger = require('../services/logger');
const config = require('../config/env');
const pump = require('../services/pump');
const { PROGRAMS, TOKENS } = require('../config/constants');

// Dependencies injected at init
let db = null;
let connection = null;
let pagsKeypair = null;
let solana = null;
let pags = null;

// Cache for fee sharing configs (10 minute TTL)
const configCache = new Map();
const CONFIG_CACHE_TTL = 10 * 60 * 1000;

// Minimum rent-exempt balance to leave in vaults
const RENT_EXEMPT_MIN = 5000; // lamports

/**
 * Initialize the fee scanner
 */
function init(deps) {
    db = deps.db;
    connection = deps.connection;
    pagsKeypair = deps.pagsKeypair || deps.devKeypair;
    solana = deps.solana;
    pags = deps.pags;

    if (!config.PAGS_ENABLED) {
        logger.info('[PAGS Fee Scanner] PAGS is disabled');
        return false;
    }

    if (!pagsKeypair) {
        logger.warn('[PAGS Fee Scanner] No keypair configured - fee collection disabled');
        return false;
    }

    logger.info('[PAGS Fee Scanner] Initialized', {
        pagsWallet: pagsKeypair.publicKey.toString().slice(0, 8) + '...'
    });

    return true;
}

/**
 * Parse fee sharing config account data
 * Same format as robinhoodScanner.js
 */
function parseFeeSharingConfig(data, accountPubkey = null) {
    try {
        if (!data || data.length < 44) return null;

        const creator = new PublicKey(data.slice(8, 40));
        const shareholderCount = data.readUInt32LE(40);

        if (shareholderCount > 10 || shareholderCount < 1) return null;

        const expectedMinSize = 44 + (shareholderCount * 34);
        if (data.length < expectedMinSize) return null;

        const shareholders = [];
        let offset = 44;

        for (let i = 0; i < shareholderCount && offset + 34 <= data.length; i++) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            const shareBps = data.readUInt16LE(offset + 32);

            if (shareBps > 10000) return null;

            shareholders.push({ pubkey, shareBps });
            offset += 34;
        }

        return { creator, shareholders, configPubkey: accountPubkey };
    } catch (e) {
        return null;
    }
}

/**
 * Get fee sharing config with caching
 */
async function getCachedFeeSharingConfig(creatorPubkey) {
    const cacheKey = creatorPubkey.toString();
    const now = Date.now();

    const cached = configCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < CONFIG_CACHE_TTL) {
        return cached.data;
    }

    try {
        const sharingConfigPDA = pump.getFeeSharingConfigPDA(creatorPubkey);
        const configInfo = await connection.getAccountInfo(sharingConfigPDA);

        if (!configInfo) {
            configCache.set(cacheKey, { data: null, timestamp: now });
            return null;
        }

        const config = parseFeeSharingConfig(configInfo.data, sharingConfigPDA);
        configCache.set(cacheKey, { data: config, timestamp: now });
        return config;
    } catch (e) {
        logger.debug('[PAGS Fee Scanner] Error fetching config', { creator: cacheKey, error: e.message });
        return null;
    }
}

/**
 * Find PAGS wallet's share in a fee sharing config
 */
function findPagsShare(configData) {
    if (!configData || !configData.shareholders || !pagsKeypair) return null;

    const pagsWalletStr = pagsKeypair.publicKey.toString();

    for (const sh of configData.shareholders) {
        if (sh.pubkey.toString() === pagsWalletStr) {
            return {
                shareBps: sh.shareBps,
                sharePercent: sh.shareBps / 100
            };
        }
    }
    return null;
}

/**
 * Check pending fees for a single PAGS beneficiary
 *
 * Handles two scenarios:
 * 1. Direct Creator (100% share): PAGS wallet IS the original creator
 *    - Fees accumulate in PAGS wallet's own creator vault
 *    - Use claim_creator_fees to claim directly
 * 2. Fee Shareholder (<100% share): PAGS wallet is in another creator's fee_sharing_config
 *    - Fees accumulate in original creator's vault
 *    - Use distribute_creator_fees to distribute to all shareholders
 */
async function checkPendingFeesForBeneficiary(beneficiary) {
    if (!beneficiary.creatorPubkey || beneficiary.creatorPubkey === 'unknown') {
        return null;
    }

    try {
        const creatorPubkey = new PublicKey(beneficiary.creatorPubkey);
        const pagsWalletStr = pagsKeypair ? pagsKeypair.publicKey.toString() : null;

        // Check if PAGS wallet IS the direct creator (100% fee share scenario)
        const isDirectCreator = pagsWalletStr && creatorPubkey.toString() === pagsWalletStr;

        if (isDirectCreator) {
            // Scenario 1: PAGS wallet is the direct creator
            // Fees are in PAGS wallet's own creator vault
            const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(pagsKeypair.publicKey);

            // Check Bonding Curve vault balance
            let bcFeesLamports = 0;
            try {
                const bcInfo = await connection.getAccountInfo(bcVault);
                if (bcInfo && bcInfo.lamports > RENT_EXEMPT_MIN) {
                    bcFeesLamports = bcInfo.lamports - RENT_EXEMPT_MIN;
                }
            } catch (e) { /* Silent */ }

            // Check AMM vault balance
            let ammFeesLamports = 0;
            try {
                const ammVaultAtaKey = await ammVaultAta;
                const bal = await connection.getTokenAccountBalance(ammVaultAtaKey)
                    .catch(() => ({ value: { amount: "0" } }));
                ammFeesLamports = parseInt(bal.value.amount) || 0;
            } catch (e) { /* Silent */ }

            const totalFees = bcFeesLamports + ammFeesLamports;

            logger.debug('[PAGS Fee Scanner] Direct creator check', {
                mint: beneficiary.mint,
                bcFeesLamports,
                ammFeesLamports,
                totalFees
            });

            return {
                mint: beneficiary.mint,
                creatorPubkey: beneficiary.creatorPubkey,
                twitterUsername: beneficiary.twitterUsername,
                isDirectCreator: true,
                isShareHolder: true, // We are the 100% owner
                bcFeesLamports,
                ammFeesLamports,
                totalFeesLamports: totalFees,
                ourShareLamports: totalFees, // 100% for direct creator
                shareBps: 10000, // 100%
                sharePercent: 100,
                bcVault, // For direct claim
                ammVaultAta,
                configData: null // No fee sharing config for direct creators
            };
        }

        // Scenario 2: PAGS wallet might be a fee shareholder in another creator's config
        const { bcVault, ammVaultAta, sharingConfigPDA } = pump.getShareholderFeeVaults(creatorPubkey);

        // Get fee sharing config to see if PAGS wallet is a shareholder
        const configData = await getCachedFeeSharingConfig(creatorPubkey);
        const pagsShare = findPagsShare(configData);

        if (!pagsShare) {
            // PAGS wallet is not a shareholder for this token
            logger.debug('[PAGS Fee Scanner] Not a shareholder', {
                mint: beneficiary.mint,
                creatorPubkey: beneficiary.creatorPubkey,
                hasConfig: !!configData
            });
            return {
                mint: beneficiary.mint,
                isDirectCreator: false,
                isShareHolder: false,
                bcFeesLamports: 0,
                ammFeesLamports: 0,
                ourShareLamports: 0,
                shareBps: 0
            };
        }

        // Check Bonding Curve vault balance
        let bcFeesLamports = 0;
        try {
            const bcInfo = await connection.getAccountInfo(bcVault);
            if (bcInfo && bcInfo.lamports > RENT_EXEMPT_MIN) {
                bcFeesLamports = bcInfo.lamports - RENT_EXEMPT_MIN;
            }
        } catch (e) { /* Silent */ }

        // Check AMM vault balance
        let ammFeesLamports = 0;
        try {
            const ammVaultAtaKey = await ammVaultAta;
            const bal = await connection.getTokenAccountBalance(ammVaultAtaKey)
                .catch(() => ({ value: { amount: "0" } }));
            ammFeesLamports = parseInt(bal.value.amount) || 0;
        } catch (e) { /* Silent */ }

        const totalFees = bcFeesLamports + ammFeesLamports;
        const ourShareLamports = Math.floor(totalFees * (pagsShare.shareBps / 10000));

        return {
            mint: beneficiary.mint,
            creatorPubkey: beneficiary.creatorPubkey,
            twitterUsername: beneficiary.twitterUsername,
            isDirectCreator: false,
            isShareHolder: true,
            bcFeesLamports,
            ammFeesLamports,
            totalFeesLamports: totalFees,
            ourShareLamports,
            shareBps: pagsShare.shareBps,
            sharePercent: pagsShare.sharePercent,
            sharingConfigPDA,
            configData
        };
    } catch (e) {
        logger.debug('[PAGS Fee Scanner] Error checking fees', {
            mint: beneficiary.mint,
            error: e.message
        });
        return null;
    }
}

/**
 * Get all pending fees across all PAGS beneficiaries
 * Returns on-chain pending fees (not database recorded amounts)
 */
async function getAllPendingFees() {
    if (!db || !connection) {
        return { totalPending: 0, beneficiaries: [] };
    }

    try {
        const beneficiaries = await db.all(`
            SELECT * FROM pags_beneficiaries
            WHERE "isActive" = 1 AND "creatorPubkey" IS NOT NULL AND "creatorPubkey" != 'unknown'
            LIMIT 100
        `);

        const results = [];
        let totalPendingLamports = 0;

        for (const b of beneficiaries) {
            const pending = await checkPendingFeesForBeneficiary(b);
            if (pending && pending.isShareHolder && pending.ourShareLamports > 0) {
                results.push(pending);
                totalPendingLamports += pending.ourShareLamports;
            }
        }

        return {
            totalPendingLamports,
            totalPendingSol: totalPendingLamports / 1e9,
            beneficiaryCount: results.length,
            beneficiaries: results
        };
    } catch (e) {
        logger.error('[PAGS Fee Scanner] Error getting pending fees', { error: e.message });
        return { totalPendingLamports: 0, totalPendingSol: 0, beneficiaries: [] };
    }
}

/**
 * Claim fees for a single beneficiary
 *
 * For direct creators (100% share): Uses claim_creator_fees
 * For fee shareholders (<100%): Uses distribute_creator_fees
 */
async function claimFeesForBeneficiary(pendingInfo) {
    if (!pendingInfo || !pendingInfo.isShareHolder) {
        return null;
    }

    // Only claim from BC vault if there are fees (AMM vault needs separate handling)
    if (pendingInfo.bcFeesLamports <= 0) {
        return null;
    }

    try {
        const tx = new Transaction();

        // Add priority fee if solana service is available
        if (solana && solana.addPriorityFee) {
            solana.addPriorityFee(tx);
        }

        const [eventAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("__event_authority")],
            PROGRAMS.PUMP
        );

        let claimedLamports;

        if (pendingInfo.isDirectCreator) {
            // Scenario 1: Direct Creator - use claim_creator_fees
            // This claims fees directly from PAGS wallet's own vault
            const claimDiscriminator = pump.buildClaimFeesData();

            const claimKeys = [
                { pubkey: pagsKeypair.publicKey, isSigner: false, isWritable: true },
                { pubkey: pendingInfo.bcVault, isSigner: false, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false }
            ];

            tx.add(new TransactionInstruction({
                keys: claimKeys,
                programId: PROGRAMS.PUMP,
                data: claimDiscriminator
            }));

            claimedLamports = pendingInfo.bcFeesLamports; // 100% for direct creator

            logger.info('[PAGS Fee Scanner] Claiming as direct creator', {
                mint: pendingInfo.mint,
                bcFeesLamports: pendingInfo.bcFeesLamports
            });

        } else {
            // Scenario 2: Fee Shareholder - use distribute_creator_fees
            // This distributes fees from original creator's vault to all shareholders
            if (!pendingInfo.configData) {
                logger.warn('[PAGS Fee Scanner] No config data for shareholder claim', {
                    mint: pendingInfo.mint
                });
                return null;
            }

            const creatorPubkey = new PublicKey(pendingInfo.creatorPubkey);
            const { bcVault, sharingConfigPDA } = pump.getShareholderFeeVaults(creatorPubkey);

            const distributeDiscriminator = pump.buildDistributeFeesData();

            // Build account keys: sharing_config, creator_vault, [all shareholders...], system_program, event_authority, program
            const distributeKeys = [
                { pubkey: sharingConfigPDA, isSigner: false, isWritable: true },
                { pubkey: bcVault, isSigner: false, isWritable: true },
            ];

            // Add ALL shareholders as writable accounts
            for (const shareholder of pendingInfo.configData.shareholders) {
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

            // Calculate our share of the vault
            claimedLamports = Math.floor(pendingInfo.bcFeesLamports * (pendingInfo.shareBps / 10000));

            logger.info('[PAGS Fee Scanner] Distributing as shareholder', {
                mint: pendingInfo.mint,
                totalFees: pendingInfo.bcFeesLamports,
                ourShare: claimedLamports,
                shareBps: pendingInfo.shareBps
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

        const claimedSol = claimedLamports / 1e9;

        logger.info('[PAGS Fee Scanner] Claimed fees', {
            mint: pendingInfo.mint,
            twitterUsername: pendingInfo.twitterUsername,
            claimedSol: claimedSol.toFixed(6),
            isDirectCreator: pendingInfo.isDirectCreator,
            signature
        });

        return {
            mint: pendingInfo.mint,
            twitterUsername: pendingInfo.twitterUsername,
            claimedLamports,
            claimedSol,
            signature
        };

    } catch (e) {
        logger.warn('[PAGS Fee Scanner] Failed to claim fees', {
            mint: pendingInfo.mint,
            isDirectCreator: pendingInfo.isDirectCreator,
            error: e.message
        });
        return null;
    }
}

/**
 * Run full fee collection cycle for all PAGS beneficiaries
 * This should be called periodically (e.g., every 5 minutes)
 */
async function collectAllFees() {
    if (!config.PAGS_ENABLED || !pagsKeypair || !db || !connection) {
        return { totalClaimed: 0, claimedCount: 0, claims: [] };
    }

    logger.info('[PAGS Fee Scanner] Starting fee collection cycle');

    try {
        const pending = await getAllPendingFees();

        if (pending.beneficiaries.length === 0) {
            logger.debug('[PAGS Fee Scanner] No pending fees to claim');
            return { totalClaimed: 0, claimedCount: 0, claims: [] };
        }

        logger.info('[PAGS Fee Scanner] Found pending fees', {
            beneficiaryCount: pending.beneficiaryCount,
            totalPendingSol: pending.totalPendingSol.toFixed(6)
        });

        const claims = [];
        let totalClaimedSol = 0;

        for (const beneficiary of pending.beneficiaries) {
            // Only claim if there's a meaningful amount (> 0.001 SOL)
            if (beneficiary.ourShareLamports < 1000000) {
                continue;
            }

            const result = await claimFeesForBeneficiary(beneficiary);

            if (result) {
                claims.push(result);
                totalClaimedSol += result.claimedSol;

                // Record the fee collection in the database
                if (pags && pags.recordFeeCollection) {
                    try {
                        await pags.recordFeeCollection(
                            result.mint,
                            result.claimedSol,
                            'auto-scan',
                            result.signature,
                            false // amount is already our share, don't apply feeShareBps again
                        );
                    } catch (e) {
                        logger.warn('[PAGS Fee Scanner] Failed to record fee', { error: e.message });
                    }
                }
            }

            // Small delay between claims to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        logger.info('[PAGS Fee Scanner] Collection cycle complete', {
            claimedCount: claims.length,
            totalClaimedSol: totalClaimedSol.toFixed(6)
        });

        return {
            totalClaimed: totalClaimedSol,
            claimedCount: claims.length,
            claims
        };

    } catch (e) {
        logger.error('[PAGS Fee Scanner] Collection cycle failed', { error: e.message });
        return { totalClaimed: 0, claimedCount: 0, claims: [], error: e.message };
    }
}

/**
 * Get status of fee scanner
 */
function getStatus() {
    return {
        enabled: config.PAGS_ENABLED,
        walletConfigured: !!pagsKeypair,
        pagsWallet: pagsKeypair ? pagsKeypair.publicKey.toString() : null,
        cacheSize: configCache.size
    };
}

module.exports = {
    init,
    checkPendingFeesForBeneficiary,
    getAllPendingFees,
    claimFeesForBeneficiary,
    collectAllFees,
    getStatus,
    parseFeeSharingConfig,
    findPagsShare
};
