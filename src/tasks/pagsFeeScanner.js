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
 * 1. For each PAGS beneficiary, check creatorPubkey stored in database
 * 2. Derive vaults from creatorPubkey (fees ALWAYS in original creator's vault)
 * 3. Use feeShareBps from database (verified at registration) to calculate our share
 * 4. Record claimed fees in database for Twitter users to claim
 *
 * v25.53 - Added direct creator support (100% share scenario)
 * v25.62 - BUGFIX: Simplified vault detection to use creatorPubkey directly
 *          instead of re-fetching fee_sharing_config on-chain
 *          (fixes "0 pending" issue when config PDA derivation didn't match)
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
 * v25.62 FIX: Simplified to use the feeShareBps stored in the database
 * (which was verified during registration) rather than re-fetching the
 * fee_sharing_config on-chain. This fixes the issue where the PDA derivation
 * didn't match the actual FEE program account structure.
 *
 * Handles two scenarios:
 * 1. Direct Creator (100% share): PAGS wallet IS the original creator
 *    - Fees accumulate in PAGS wallet's own creator vault
 *    - Use claim_creator_fees to claim directly
 * 2. Fee Shareholder (<100% share): PAGS wallet is in another creator's fee_sharing_config
 *    - Fees accumulate in original creator's vault
 *    - Use distribute_creator_fees to distribute to all shareholders
 *
 * For PAGS, the key insight is:
 * - creatorPubkey stored is the ORIGINAL token creator
 * - Fees accumulate in the original creator's vault (derived from their pubkey)
 * - feeShareBps stored tells us our percentage (already verified at registration)
 */
async function checkPendingFeesForBeneficiary(beneficiary) {
    if (!beneficiary.creatorPubkey || beneficiary.creatorPubkey === 'unknown') {
        logger.debug('[PAGS Fee Scanner] Skipping beneficiary with unknown creatorPubkey', {
            mint: beneficiary.mint
        });
        return null;
    }

    try {
        const creatorPubkey = new PublicKey(beneficiary.creatorPubkey);
        const pagsWalletStr = pagsKeypair ? pagsKeypair.publicKey.toString() : null;

        // Check if PAGS wallet IS the direct creator (100% fee share scenario)
        // This happens when creatorPubkey stored equals PAGS wallet
        const isDirectCreator = pagsWalletStr && creatorPubkey.toString() === pagsWalletStr;

        // v25.62: Use feeShareBps from database (verified at registration)
        // If not stored, default to 10000 (100%)
        const storedFeeShareBps = beneficiary.feeShareBps || 10000;

        // Derive vaults from the original creator's pubkey
        // Fees ALWAYS accumulate in the original creator's vault
        const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(creatorPubkey);

        logger.debug('[PAGS Fee Scanner] Checking vaults for beneficiary', {
            mint: beneficiary.mint,
            creatorPubkey: beneficiary.creatorPubkey.slice(0, 8) + '...',
            isDirectCreator,
            storedFeeShareBps,
            bcVault: bcVault.toString().slice(0, 8) + '...'
        });

        // Check Bonding Curve vault balance (native SOL)
        let bcFeesLamports = 0;
        try {
            const bcInfo = await connection.getAccountInfo(bcVault);
            if (bcInfo && bcInfo.lamports > RENT_EXEMPT_MIN) {
                bcFeesLamports = bcInfo.lamports - RENT_EXEMPT_MIN;
            }
            logger.debug('[PAGS Fee Scanner] BC vault balance', {
                mint: beneficiary.mint,
                bcVault: bcVault.toString().slice(0, 8) + '...',
                lamports: bcInfo?.lamports || 0,
                feesAfterRent: bcFeesLamports
            });
        } catch (e) {
            logger.debug('[PAGS Fee Scanner] BC vault check error', {
                mint: beneficiary.mint,
                error: e.message
            });
        }

        // Check AMM vault balance (wSOL token account)
        let ammFeesLamports = 0;
        try {
            const ammVaultAtaKey = await ammVaultAta;
            const bal = await connection.getTokenAccountBalance(ammVaultAtaKey)
                .catch(() => ({ value: { amount: "0" } }));
            ammFeesLamports = parseInt(bal.value.amount) || 0;
            logger.debug('[PAGS Fee Scanner] AMM vault balance', {
                mint: beneficiary.mint,
                ammVaultAta: ammVaultAtaKey.toString().slice(0, 8) + '...',
                lamports: ammFeesLamports
            });
        } catch (e) {
            logger.debug('[PAGS Fee Scanner] AMM vault check error', {
                mint: beneficiary.mint,
                error: e.message
            });
        }

        const totalFeesLamports = bcFeesLamports + ammFeesLamports;

        // Calculate our share based on stored feeShareBps
        const ourShareLamports = Math.floor(totalFeesLamports * (storedFeeShareBps / 10000));

        logger.debug('[PAGS Fee Scanner] Fee calculation', {
            mint: beneficiary.mint,
            totalFeesLamports,
            storedFeeShareBps,
            ourShareLamports,
            isDirectCreator
        });

        // If no fees, return early with zero values
        if (totalFeesLamports === 0) {
            return {
                mint: beneficiary.mint,
                creatorPubkey: beneficiary.creatorPubkey,
                twitterUsername: beneficiary.twitterUsername,
                isDirectCreator,
                isShareHolder: storedFeeShareBps > 0,
                bcFeesLamports: 0,
                ammFeesLamports: 0,
                totalFeesLamports: 0,
                ourShareLamports: 0,
                shareBps: storedFeeShareBps,
                sharePercent: storedFeeShareBps / 100,
                bcVault
            };
        }

        return {
            mint: beneficiary.mint,
            creatorPubkey: beneficiary.creatorPubkey,
            twitterUsername: beneficiary.twitterUsername,
            isDirectCreator,
            isShareHolder: true,
            bcFeesLamports,
            ammFeesLamports,
            totalFeesLamports,
            ourShareLamports,
            shareBps: storedFeeShareBps,
            sharePercent: storedFeeShareBps / 100,
            bcVault,
            ammVaultAta
        };
    } catch (e) {
        logger.warn('[PAGS Fee Scanner] Error checking fees for beneficiary', {
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
            //
            // v25.62: For claiming, we need to fetch the fee_sharing_config to get all shareholders
            // The config is stored in the coin_creator field of the bonding curve/AMM pool
            // We need to look it up by first getting the coin_creator, then parsing it

            const creatorPubkey = new PublicKey(pendingInfo.creatorPubkey);

            // Fetch the config data if not provided
            // We need to get coin_creator from BC/AMM and then parse the FEE account
            let configData = pendingInfo.configData;
            if (!configData) {
                try {
                    // Get the coin_creator from the bonding curve (which points to FEE account)
                    const mintExtractor = require('../services/mintExtractor');

                    // Re-verify and get full config data
                    const pagsWalletStr = pagsKeypair ? pagsKeypair.publicKey.toString() : null;
                    if (pagsWalletStr) {
                        const verifyResult = await mintExtractor.verifyFeeRecipient(
                            pendingInfo.mint,
                            pagsWalletStr,
                            connection
                        );

                        if (verifyResult.isRecipient && verifyResult.allShareholders) {
                            // Build configData from verification result
                            configData = {
                                shareholders: verifyResult.allShareholders.map(s => ({
                                    pubkey: new PublicKey(s.pubkey),
                                    shareBps: s.bps
                                }))
                            };
                            logger.info('[PAGS Fee Scanner] Fetched config data for claim', {
                                mint: pendingInfo.mint,
                                shareholderCount: configData.shareholders.length
                            });
                        }
                    }
                } catch (e) {
                    logger.warn('[PAGS Fee Scanner] Could not fetch config data for claim', {
                        mint: pendingInfo.mint,
                        error: e.message
                    });
                }
            }

            if (!configData || !configData.shareholders || configData.shareholders.length === 0) {
                // v25.62: For now, skip claiming for shareholders without config data
                // The fee scanner detects pending fees correctly, but claiming requires
                // the distribute_creator_fees instruction which needs all shareholders
                logger.warn('[PAGS Fee Scanner] No config data for shareholder claim - skipping claim', {
                    mint: pendingInfo.mint,
                    note: 'Pending fees detected but cannot claim without shareholder list'
                });
                return null;
            }

            const { bcVault, sharingConfigPDA } = pump.getShareholderFeeVaults(creatorPubkey);

            const distributeDiscriminator = pump.buildDistributeFeesData();

            // Build account keys: sharing_config, creator_vault, [all shareholders...], system_program, event_authority, program
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
                shareBps: pendingInfo.shareBps,
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
