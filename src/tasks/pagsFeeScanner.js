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
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { BN } = require('@coral-xyz/anchor');
const logger = require('../services/logger');
const config = require('../config/env');
const pump = require('../services/pump');
const mintExtractor = require('../services/mintExtractor');
const { PROGRAMS, TOKENS } = require('../config/constants');

// Dependencies injected at init
let db = null;
let connection = null;
let pagsKeypair = null;
let devKeypair = null;
let solana = null;
let pags = null;

// Cache for fee sharing configs (10 minute TTL)
const configCache = new Map();
const CONFIG_CACHE_TTL = 10 * 60 * 1000;

// v25.45: Cache for last known vault balances (to detect external claims)
// Key: mint address, Value: { bcBalance, ammBalance, timestamp }
const lastVaultBalances = new Map();
const VAULT_BALANCE_TTL = 30 * 60 * 1000; // 30 min TTL

// Minimum rent-exempt balance to leave in vaults
const RENT_EXEMPT_MIN = 5000; // lamports

// v25.116: Transaction-based external claim detection
// Tracks last processed tx signature per mint for incremental scanning
const lastProcessedSigs = new Map();

/**
 * v25.113: Persist vault balance to database for cross-restart detection
 */
function persistVaultBalance(mint, totalBalance) {
    if (!db) return;
    db.run(`
        UPDATE pags_beneficiaries
        SET "lastKnownVaultBalance" = $1, "lastVaultCheckAt" = $2
        WHERE mint = $3
    `, [totalBalance, Date.now(), mint]).catch(e => {
        logger.debug('[PAGS Fee Scanner] Failed to persist vault balance', { mint, error: e.message });
    });
}

/**
 * v25.113: Update vault balance cache (in-memory + DB)
 * Used by external callers (e.g. flywheel Robinhood cross-recording) to prevent double-count
 */
function updateVaultBalanceCache(mint, bcBalance, ammBalance) {
    lastVaultBalances.set(mint, {
        bcBalance,
        ammBalance,
        timestamp: Date.now()
    });
    persistVaultBalance(mint, bcBalance + ammBalance);
}

/**
 * Initialize the fee scanner
 * v25.113: Now async to hydrate vault balance cache from database
 */
async function init(deps) {
    db = deps.db;
    connection = deps.connection;
    pagsKeypair = deps.pagsKeypair || deps.devKeypair;
    devKeypair = deps.devKeypair; // v25.116: Track for tx-based external claim filtering
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

    // v25.113: Hydrate vault balance cache from database on startup
    try {
        const rows = await db.all(`
            SELECT mint, "lastKnownVaultBalance", "lastVaultCheckAt"
            FROM pags_beneficiaries
            WHERE "isActive" = 1
              AND "lastKnownVaultBalance" > 0
              AND "lastVaultCheckAt" IS NOT NULL
        `);
        for (const row of rows) {
            const age = Date.now() - (row.lastVaultCheckAt || 0);
            if (age < VAULT_BALANCE_TTL) {
                lastVaultBalances.set(row.mint, {
                    bcBalance: Number(row.lastKnownVaultBalance),
                    ammBalance: 0,
                    timestamp: row.lastVaultCheckAt
                });
            }
        }
        logger.info('[PAGS Fee Scanner] Hydrated vault balance cache from DB', {
            loaded: lastVaultBalances.size,
            totalRows: rows.length
        });
    } catch (e) {
        logger.warn('[PAGS Fee Scanner] Failed to hydrate vault balance cache', { error: e.message });
    }

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
 * v25.45: Re-verify fee share percentage on-chain
 * Fee shares can change at any time on Pump.fun, so we verify before claiming
 *
 * @param {string} mint - Token mint address
 * @param {string} creatorPubkey - Stored creator pubkey
 * @param {number} storedFeeShareBps - Fee share stored in database
 * @returns {Promise<{verified: boolean, currentFeeShareBps: number, changed: boolean, allShareholders?: Array}>}
 */
async function verifyCurrentFeeShare(mint, creatorPubkey, storedFeeShareBps) {
    try {
        const mintExtractor = require('../services/mintExtractor');
        const pagsWalletStr = pagsKeypair ? pagsKeypair.publicKey.toString() : null;

        if (!pagsWalletStr) {
            return { verified: false, currentFeeShareBps: storedFeeShareBps, changed: false };
        }

        const result = await mintExtractor.verifyFeeRecipient(mint, pagsWalletStr, connection);

        if (result.error) {
            // RPC error - don't change anything, use stored value
            logger.debug('[PAGS Fee Scanner] Fee share verification RPC error, using stored value', {
                mint,
                storedFeeShareBps,
                error: result.error
            });
            return { verified: false, currentFeeShareBps: storedFeeShareBps, changed: false };
        }

        if (!result.isRecipient) {
            // We're no longer a fee recipient! This is important to detect
            logger.warn('[PAGS Fee Scanner] No longer a fee recipient for token', {
                mint,
                storedFeeShareBps,
                note: 'Fee share may have been removed or changed on Pump.fun'
            });
            return { verified: true, currentFeeShareBps: 0, changed: true, removed: true };
        }

        const currentFeeShareBps = result.feeShareBps || 0;
        const changed = currentFeeShareBps !== storedFeeShareBps;

        if (changed) {
            logger.info('[PAGS Fee Scanner] Fee share changed on-chain', {
                mint,
                storedFeeShareBps,
                currentFeeShareBps,
                delta: currentFeeShareBps - storedFeeShareBps
            });
        }

        return {
            verified: true,
            currentFeeShareBps,
            changed,
            allShareholders: result.allShareholders
        };

    } catch (e) {
        logger.warn('[PAGS Fee Scanner] Error verifying fee share', { mint, error: e.message });
        return { verified: false, currentFeeShareBps: storedFeeShareBps, changed: false };
    }
}

/**
 * v25.45: Update fee share in database if it changed
 */
async function updateFeeShareIfChanged(mint, newFeeShareBps) {
    try {
        await db.run(`
            UPDATE pags_beneficiaries
            SET "feeShareBps" = $1, "lastFeeUpdate" = $2
            WHERE mint = $3
        `, [newFeeShareBps, Date.now(), mint]);

        logger.info('[PAGS Fee Scanner] Updated fee share in database', {
            mint,
            newFeeShareBps
        });
    } catch (e) {
        logger.error('[PAGS Fee Scanner] Failed to update fee share', { mint, error: e.message });
    }
}

/**
 * Check pending fees for a single PAGS beneficiary
 *
 * v25.45: Now re-verifies fee share on-chain before calculating pending fees
 * Fee shares can change at any time on Pump.fun dashboard
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
 * - feeShareBps is now RE-VERIFIED on each check (can change on Pump.fun)
 */
async function checkPendingFeesForBeneficiary(beneficiary, options = {}) {
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

        // v25.45: Re-verify fee share on-chain (can change at any time on Pump.fun)
        const storedFeeShareBps = beneficiary.feeShareBps || 10000;
        let currentFeeShareBps = storedFeeShareBps;
        let allShareholders = null;

        // Only verify if requested (to save RPC calls during quick checks)
        // Full verification happens during claim operations
        if (options.verifyFeeShare !== false) {
            const verification = await verifyCurrentFeeShare(
                beneficiary.mint,
                beneficiary.creatorPubkey,
                storedFeeShareBps
            );

            if (verification.verified) {
                currentFeeShareBps = verification.currentFeeShareBps;
                allShareholders = verification.allShareholders;

                // Update DB if fee share changed
                if (verification.changed && currentFeeShareBps !== storedFeeShareBps) {
                    await updateFeeShareIfChanged(beneficiary.mint, currentFeeShareBps);

                    // If removed from fee sharing, return early
                    if (verification.removed) {
                        logger.warn('[PAGS Fee Scanner] Fee recipient removed - deactivating', {
                            mint: beneficiary.mint
                        });
                        return {
                            mint: beneficiary.mint,
                            creatorPubkey: beneficiary.creatorPubkey,
                            twitterUsername: beneficiary.twitterUsername,
                            isDirectCreator: false,
                            isShareHolder: false,
                            feeShareRemoved: true,
                            bcFeesLamports: 0,
                            ammFeesLamports: 0,
                            totalFeesLamports: 0,
                            ourShareLamports: 0,
                            shareBps: 0,
                            sharePercent: 0
                        };
                    }
                }
            }
        }

        // Derive vaults from the original creator's pubkey
        // Fees ALWAYS accumulate in the original creator's vault
        const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(creatorPubkey);

        logger.debug('[PAGS Fee Scanner] Checking vaults for beneficiary', {
            mint: beneficiary.mint,
            creatorPubkey: beneficiary.creatorPubkey.slice(0, 8) + '...',
            isDirectCreator,
            storedFeeShareBps,
            currentFeeShareBps,
            feeShareChanged: currentFeeShareBps !== storedFeeShareBps,
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

        // v25.45: Calculate our share based on CURRENT (re-verified) feeShareBps
        const ourShareLamports = Math.floor(totalFeesLamports * (currentFeeShareBps / 10000));

        logger.debug('[PAGS Fee Scanner] Fee calculation', {
            mint: beneficiary.mint,
            totalFeesLamports,
            storedFeeShareBps,
            currentFeeShareBps,
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
                isShareHolder: currentFeeShareBps > 0,
                bcFeesLamports: 0,
                ammFeesLamports: 0,
                totalFeesLamports: 0,
                ourShareLamports: 0,
                shareBps: currentFeeShareBps,
                sharePercent: currentFeeShareBps / 100,
                bcVault,
                allShareholders // v25.45: Include for claim operations
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
            shareBps: currentFeeShareBps,
            sharePercent: currentFeeShareBps / 100,
            bcVault,
            ammVaultAta,
            allShareholders // v25.45: Include for claim operations
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

    // v25.105: Now handles both BC and AMM fees
    // AMM fees are transferred to BC vault first via TransferCreatorFeesToPump
    const totalFeesLamports = (pendingInfo.bcFeesLamports || 0) + (pendingInfo.ammFeesLamports || 0);
    if (totalFeesLamports <= 0) {
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

            const mintPubkey = new PublicKey(pendingInfo.mint);

            // v25.109: For graduated tokens with AMM fees, AMM pool's coin_creator is authoritative
            // Both TransferCreatorFeesToPump and DistributeCreatorFees must use the SAME coin_creator
            // Reference tx: 2cGnFzu4w12n995MxTHo8BKFbb2V5FHJ4aeCQh69mxhkmhuyrnBH9zMSMwQ2tt9GhoZMardqgSXDPjm4SAA3i8AV
            const { pool } = pump.getPumpAmmPDAs(mintPubkey);
            let coinCreator = null;
            let bcVault = null;
            let sharingConfigPDA = null;

            // v25.109: For tokens with AMM fees, read coin_creator from AMM pool (authoritative for graduated tokens)
            if (pendingInfo.ammFeesLamports > 0) {
                const poolAccountInfo = await connection.getAccountInfo(pool);
                if (poolAccountInfo && poolAccountInfo.data.length >= 43) {
                    // AMM Pool layout: coin_creator at offset 11 (32 bytes)
                    coinCreator = new PublicKey(poolAccountInfo.data.slice(11, 43));
                    logger.info('[PAGS Fee Scanner] Using AMM pool coin_creator (graduated token)', {
                        mint: pendingInfo.mint,
                        coinCreator: coinCreator.toString()
                    });
                }
            }

            // Fallback to getCoinCreator if AMM pool not available
            if (!coinCreator) {
                const coinCreatorResult = await mintExtractor.getCoinCreator(mintPubkey, connection);
                if (!coinCreatorResult) {
                    logger.warn('[PAGS Fee Scanner] Could not get coin_creator from on-chain - cannot claim', {
                        mint: pendingInfo.mint
                    });
                    return null;
                }
                coinCreator = coinCreatorResult.coinCreator;
                logger.info('[PAGS Fee Scanner] Using coin_creator from getCoinCreator', {
                    mint: pendingInfo.mint,
                    coinCreator: coinCreator.toString(),
                    source: coinCreatorResult.source
                });
            }

            // v25.109: Derive ALL vaults from the same coin_creator for consistency
            const vaults = pump.getShareholderFeeVaults(coinCreator);
            bcVault = vaults.bcVault;
            sharingConfigPDA = vaults.sharingConfigPDA;

            logger.info('[PAGS Fee Scanner] Derived vaults from coin_creator', {
                mint: pendingInfo.mint,
                coinCreator: coinCreator.toString(),
                bcVault: bcVault.toString(),
                sharingConfigPDA: sharingConfigPDA.toString()
            });

            // v25.105: If there are AMM fees, transfer them to BC vault first
            if (pendingInfo.ammFeesLamports > 0) {
                const transferDiscriminator = pump.buildTransferFeesToPumpData();

                // Derive AMM vault accounts from the same coin_creator
                const [ammVaultAuth] = PublicKey.findProgramAddressSync(
                    [Buffer.from("creator_vault"), coinCreator.toBuffer()],
                    PROGRAMS.PUMP_AMM
                );
                const ammVaultAta = await getAssociatedTokenAddress(TOKENS.WSOL, ammVaultAuth, true);

                // v25.113: BUGFIX - Account 8 must be event_authority, NOT pool
                // Reference: successful tx 2cGnFzu4w12n995MxTHo8BKFbb2V5FHJ4aeCQh69mxhkmhuyrnBH9zMSMwQ2tt9GhoZMardqgSXDPjm4SAA3i8AV
                const [ammEventAuthority] = PublicKey.findProgramAddressSync(
                    [Buffer.from("__event_authority")], PROGRAMS.PUMP_AMM
                );

                // TransferCreatorFeesToPump accounts from reference tx
                const transferKeys = [
                    { pubkey: TOKENS.WSOL, isSigner: false, isWritable: false },           // 0: wsol_mint
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // 1: token_program
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 2: system_program
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 3: ata_program
                    { pubkey: coinCreator, isSigner: false, isWritable: false },           // 4: coin_creator
                    { pubkey: ammVaultAuth, isSigner: false, isWritable: true },           // 5: amm_vault_auth
                    { pubkey: ammVaultAta, isSigner: false, isWritable: true },            // 6: amm_vault_ata (wSOL)
                    { pubkey: bcVault, isSigner: false, isWritable: true },                // 7: bc_vault (destination)
                    { pubkey: ammEventAuthority, isSigner: false, isWritable: false },     // 8: event_authority (NOT pool!)
                    { pubkey: PROGRAMS.PUMP_AMM, isSigner: false, isWritable: false },     // 9: pump_amm_program
                ];

                tx.add(new TransactionInstruction({
                    keys: transferKeys,
                    programId: PROGRAMS.PUMP_AMM,
                    data: transferDiscriminator
                }));

                logger.info('[PAGS Fee Scanner] Adding TransferCreatorFeesToPump instruction', {
                    mint: pendingInfo.mint,
                    ammFeesLamports: pendingInfo.ammFeesLamports,
                    coinCreator: coinCreator.toString(),
                    ammVaultAuth: ammVaultAuth.toString()
                });
            }

            const distributeDiscriminator = pump.buildDistributeFeesData();

            // v25.109: Use the same coin_creator for DistributeCreatorFees
            // DistributeCreatorFees accounts: mint, fee_sharing_config, coin_creator, creator_vault, system, event_auth, program, ...shareholders
            const distributeKeys = [
                { pubkey: mintPubkey, isSigner: false, isWritable: false },           // 0: mint
                { pubkey: sharingConfigPDA, isSigner: false, isWritable: true },      // 1: fee_sharing_config
                { pubkey: coinCreator, isSigner: false, isWritable: true },           // 2: coin_creator
                { pubkey: bcVault, isSigner: false, isWritable: true },               // 3: creator_vault
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 4: system_program
                { pubkey: eventAuthority, isSigner: false, isWritable: false },       // 5: event_authority
                { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false },        // 6: pump program
            ];

            // Add ALL shareholders as writable accounts
            for (const shareholder of configData.shareholders) {
                distributeKeys.push({
                    pubkey: shareholder.pubkey,
                    isSigner: false,
                    isWritable: true
                });
            }

            tx.add(new TransactionInstruction({
                keys: distributeKeys,
                programId: PROGRAMS.PUMP,
                data: distributeDiscriminator
            }));

            // v25.105: Calculate our share of combined BC + AMM fees
            const totalVaultFees = (pendingInfo.bcFeesLamports || 0) + (pendingInfo.ammFeesLamports || 0);
            claimedLamports = Math.floor(totalVaultFees * (pendingInfo.shareBps / 10000));

            logger.info('[PAGS Fee Scanner] Distributing as shareholder', {
                mint: pendingInfo.mint,
                bcFees: pendingInfo.bcFeesLamports,
                ammFees: pendingInfo.ammFeesLamports,
                totalFees: totalVaultFees,
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
 * v25.45: Detect if fees were claimed externally (by Robinhood, manual dashboard, etc.)
 *
 * This is important because:
 * 1. Robinhood might claim fees for a token that's also registered in PAGS
 * 2. Creator might manually claim via Pump.fun dashboard
 * 3. Another shareholder might trigger distribute_creator_fees
 *
 * When external claims happen, the vault balance decreases without us claiming.
 * We track this to avoid recording fees that were never actually received.
 *
 * @param {string} mint - Token mint
 * @param {number} currentBcBalance - Current BC vault balance (lamports)
 * @param {number} currentAmmBalance - Current AMM vault balance (lamports)
 * @returns {{externalClaim: boolean, bcClaimedExternally: number, ammClaimedExternally: number}}
 */
function detectExternalClaim(mint, currentBcBalance, currentAmmBalance) {
    const lastBalance = lastVaultBalances.get(mint);

    if (!lastBalance) {
        // First time seeing this token, no external claim detection possible
        lastVaultBalances.set(mint, {
            bcBalance: currentBcBalance,
            ammBalance: currentAmmBalance,
            timestamp: Date.now()
        });
        // v25.113: Persist baseline to DB
        persistVaultBalance(mint, currentBcBalance + currentAmmBalance);
        return { externalClaim: false, bcClaimedExternally: 0, ammClaimedExternally: 0 };
    }

    // Check if cache is stale
    if (Date.now() - lastBalance.timestamp > VAULT_BALANCE_TTL) {
        // Cache expired, refresh it
        lastVaultBalances.set(mint, {
            bcBalance: currentBcBalance,
            ammBalance: currentAmmBalance,
            timestamp: Date.now()
        });
        // v25.113: Persist refreshed baseline to DB
        persistVaultBalance(mint, currentBcBalance + currentAmmBalance);
        return { externalClaim: false, bcClaimedExternally: 0, ammClaimedExternally: 0 };
    }

    // Detect if balance decreased (external claim happened)
    const bcDecrease = Math.max(0, lastBalance.bcBalance - currentBcBalance);
    const ammDecrease = Math.max(0, lastBalance.ammBalance - currentAmmBalance);

    const externalClaim = bcDecrease > 0 || ammDecrease > 0;

    if (externalClaim) {
        logger.info('[PAGS Fee Scanner] External claim detected', {
            mint,
            bcDecrease: bcDecrease / 1e9,
            ammDecrease: ammDecrease / 1e9,
            previousBc: lastBalance.bcBalance / 1e9,
            currentBc: currentBcBalance / 1e9,
            previousAmm: lastBalance.ammBalance / 1e9,
            currentAmm: currentAmmBalance / 1e9,
            note: 'Fees claimed by Robinhood, dashboard, or another mechanism'
        });
    }

    // Update cached balance
    lastVaultBalances.set(mint, {
        bcBalance: currentBcBalance,
        ammBalance: currentAmmBalance,
        timestamp: Date.now()
    });
    // v25.113: Persist updated balance to DB
    persistVaultBalance(mint, currentBcBalance + currentAmmBalance);

    return {
        externalClaim,
        bcClaimedExternally: bcDecrease,
        ammClaimedExternally: ammDecrease
    };
}

/**
 * v25.45: Update vault balance cache after successful claim
 * v25.113: Also persists to database for cross-restart detection
 */
function updateVaultBalanceAfterClaim(mint, newBcBalance, newAmmBalance) {
    lastVaultBalances.set(mint, {
        bcBalance: newBcBalance,
        ammBalance: newAmmBalance,
        timestamp: Date.now()
    });
    persistVaultBalance(mint, newBcBalance + newAmmBalance);
}

/**
 * v25.116: Transaction-based external claim detection
 *
 * Checks BC vault transaction history for distribute/claim transactions
 * NOT signed by our wallets (PAGS or dev keypair). For each external tx,
 * parses PAGS wallet's balance change to determine the exact SOL received.
 *
 * This catches external claims that balance-based detection misses:
 * e.g. when fees accumulate AND are claimed between polls, returning
 * the vault to the same rent-exempt level as our cached baseline.
 *
 * @param {string} mint - Token mint address
 * @param {PublicKey} bcVaultKey - BC vault public key
 * @param {Object} beneficiary - DB beneficiary row
 * @returns {Promise<Array<{signature, receivedLamports, receivedSol, blockTime, feePayer}>>}
 */
async function detectExternalClaimsByTx(mint, bcVaultKey, beneficiary) {
    const pagsWalletStr = pagsKeypair ? pagsKeypair.publicKey.toString() : null;
    if (!pagsWalletStr || !connection) return [];

    // Build set of "our" wallet addresses to filter out
    const ourWallets = new Set();
    ourWallets.add(pagsWalletStr);
    if (devKeypair) ourWallets.add(devKeypair.publicKey.toString());

    try {
        // On first run for this mint, just establish the baseline signature
        if (!lastProcessedSigs.has(mint)) {
            const initSigs = await connection.getSignaturesForAddress(bcVaultKey, {
                limit: 1, commitment: 'confirmed'
            });
            if (initSigs.length > 0) {
                lastProcessedSigs.set(mint, initSigs[0].signature);
            } else {
                lastProcessedSigs.set(mint, 'none');
            }
            return []; // Skip detection on first run (baseline established)
        }

        const lastSig = lastProcessedSigs.get(mint);
        const opts = { limit: 10, commitment: 'confirmed' };
        if (lastSig && lastSig !== 'none') opts.until = lastSig;

        const sigs = await connection.getSignaturesForAddress(bcVaultKey, opts);

        if (sigs.length === 0) return [];

        // Update to newest signature for next incremental scan
        lastProcessedSigs.set(mint, sigs[0].signature);

        const claims = [];

        for (const sig of sigs) {
            if (sig.err) continue; // Skip failed transactions

            try {
                // Dedup: check if this signature was already recorded in fee logs
                const existing = await db.get(
                    'SELECT id FROM pags_fee_logs WHERE "txSignature" = $1',
                    [sig.signature]
                );
                if (existing) continue;

                // Parse the transaction
                const tx = await connection.getParsedTransaction(sig.signature, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0
                });

                if (!tx || !tx.meta) continue;

                // Check if fee payer is one of our wallets
                const accountKeys = tx.transaction.message.accountKeys;
                const feePayer = accountKeys[0].pubkey
                    ? accountKeys[0].pubkey.toString()
                    : accountKeys[0].toString();

                if (ourWallets.has(feePayer)) continue; // Our own transaction

                // Find PAGS wallet's balance change in this transaction
                const pagsIdx = accountKeys.findIndex(k => {
                    const key = k.pubkey ? k.pubkey.toString() : k.toString();
                    return key === pagsWalletStr;
                });

                if (pagsIdx === -1) continue; // PAGS wallet not involved in this tx

                const preBal = tx.meta.preBalances[pagsIdx];
                const postBal = tx.meta.postBalances[pagsIdx];
                const receivedLamports = postBal - preBal;

                if (receivedLamports > 0) {
                    claims.push({
                        signature: sig.signature,
                        receivedLamports,
                        receivedSol: receivedLamports / 1e9,
                        blockTime: sig.blockTime,
                        feePayer
                    });
                }
            } catch (e) {
                logger.debug('[PAGS Fee Scanner] Failed to parse vault tx', {
                    mint, signature: sig.signature, error: e.message
                });
            }

            // Small delay to avoid RPC rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return claims;
    } catch (e) {
        logger.debug('[PAGS Fee Scanner] Tx-based detection failed', {
            mint, error: e.message
        });
        return [];
    }
}

/**
 * v25.113: Detect and record externally-claimed fees for ALL active beneficiaries
 *
 * This runs independently because collectAllFees() only processes beneficiaries
 * with ourShareLamports > 0, missing fully-drained vaults (the most common
 * external claim scenario from Robinhood, dashboard, or other shareholders).
 */
async function detectAndRecordExternalClaims() {
    if (!config.PAGS_ENABLED || !pagsKeypair || !db || !connection) {
        return { detected: 0, recorded: 0, totalRecordedSol: 0 };
    }

    try {
        const beneficiaries = await db.all(`
            SELECT * FROM pags_beneficiaries
            WHERE "isActive" = 1
              AND "creatorPubkey" IS NOT NULL
              AND "creatorPubkey" != 'unknown'
            LIMIT 100
        `);

        let detected = 0;
        let recorded = 0;
        let totalRecordedSol = 0;

        for (const b of beneficiaries) {
            try {
                const creatorPubkey = new PublicKey(b.creatorPubkey);
                const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(creatorPubkey);

                // Check current vault balances (still needed for cache updates)
                let currentBcBalance = 0;
                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo) currentBcBalance = bcInfo.lamports;
                } catch (e) { /* vault may not exist */ }

                let currentAmmBalance = 0;
                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const bal = await connection.getTokenAccountBalance(ammVaultAtaKey)
                        .catch(() => ({ value: { amount: '0' } }));
                    currentAmmBalance = parseInt(bal.value.amount) || 0;
                } catch (e) { /* vault may not exist */ }

                // Phase 1: Balance-based detection (fast, catches obvious vault decreases)
                const externalCheck = detectExternalClaim(b.mint, currentBcBalance, currentAmmBalance);

                if (externalCheck.externalClaim) {
                    detected++;

                    const totalDecrease = externalCheck.bcClaimedExternally + externalCheck.ammClaimedExternally;

                    const verification = await verifyCurrentFeeShare(
                        b.mint, b.creatorPubkey, b.feeShareBps || 10000
                    );
                    const feeShareBps = verification.verified
                        ? verification.currentFeeShareBps
                        : (b.feeShareBps || 10000);

                    if (verification.removed) {
                        logger.info('[PAGS Fee Scanner] Skipping external claim - fee share removed', { mint: b.mint });
                        continue;
                    }

                    const ourShareLamports = Math.floor(totalDecrease * (feeShareBps / 10000));
                    const ourShareSol = ourShareLamports / 1e9;

                    if (ourShareSol > 0.000001 && pags && pags.recordFeeCollection) {
                        try {
                            await pags.recordFeeCollection(
                                b.mint,
                                ourShareSol,
                                'external_claim',
                                null,
                                false
                            );
                            recorded++;
                            totalRecordedSol += ourShareSol;

                            logger.info('[PAGS Fee Scanner] Recorded external claim (balance-based)', {
                                mint: b.mint,
                                twitterUsername: b.twitterUsername,
                                totalDecreaseLamports: totalDecrease,
                                ourShareSol: ourShareSol.toFixed(6),
                                feeShareBps,
                                verifiedOnChain: verification.verified
                            });
                        } catch (e) {
                            logger.warn('[PAGS Fee Scanner] Failed to record external claim', {
                                mint: b.mint,
                                error: e.message
                            });
                        }
                    }

                    // v25.116: Advance tx-based baseline so we don't re-detect this claim
                    try {
                        const advanceSigs = await connection.getSignaturesForAddress(bcVault, {
                            limit: 1, commitment: 'confirmed'
                        });
                        if (advanceSigs.length > 0) {
                            lastProcessedSigs.set(b.mint, advanceSigs[0].signature);
                        }
                    } catch (e) { /* non-critical */ }
                } else {
                    // Phase 2: Transaction-based detection (catches claims missed by balance comparison)
                    // This handles the case where fees accumulated AND were claimed between polls,
                    // returning the vault to the same rent-exempt level as our cached baseline.
                    try {
                        const txClaims = await detectExternalClaimsByTx(b.mint, bcVault, b);

                        for (const claim of txClaims) {
                            detected++;

                            if (claim.receivedSol > 0.000001 && pags && pags.recordFeeCollection) {
                                try {
                                    await pags.recordFeeCollection(
                                        b.mint,
                                        claim.receivedSol,
                                        'external_claim',
                                        claim.signature,
                                        false
                                    );
                                    recorded++;
                                    totalRecordedSol += claim.receivedSol;

                                    logger.info('[PAGS Fee Scanner] Recorded external claim (tx-based)', {
                                        mint: b.mint,
                                        twitterUsername: b.twitterUsername,
                                        receivedSol: claim.receivedSol.toFixed(6),
                                        signature: claim.signature,
                                        feePayer: claim.feePayer
                                    });
                                } catch (e) {
                                    logger.warn('[PAGS Fee Scanner] Failed to record tx-based external claim', {
                                        mint: b.mint,
                                        error: e.message
                                    });
                                }
                            }
                        }
                    } catch (txErr) {
                        logger.debug('[PAGS Fee Scanner] Tx-based detection error', {
                            mint: b.mint,
                            error: txErr.message
                        });
                    }
                }

                // Small delay to avoid RPC rate limiting
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (e) {
                logger.debug('[PAGS Fee Scanner] Error checking beneficiary for external claims', {
                    mint: b.mint,
                    error: e.message
                });
            }
        }

        if (detected > 0) {
            logger.info('[PAGS Fee Scanner] External claim detection complete', {
                checked: beneficiaries.length,
                detected,
                recorded,
                totalRecordedSol: totalRecordedSol.toFixed(6)
            });
        }

        return { detected, recorded, totalRecordedSol };
    } catch (e) {
        logger.error('[PAGS Fee Scanner] External claim detection failed', { error: e.message });
        return { detected: 0, recorded: 0, totalRecordedSol: 0 };
    }
}

/**
 * Run full fee collection cycle for all PAGS beneficiaries
 * This should be called periodically (e.g., every 5 minutes)
 *
 * v25.45: Now detects external claims and re-verifies fee shares
 * v25.113: External claim detection runs first for ALL beneficiaries
 */
async function collectAllFees() {
    if (!config.PAGS_ENABLED || !pagsKeypair || !db || !connection) {
        return { totalClaimed: 0, claimedCount: 0, claims: [] };
    }

    logger.info('[PAGS Fee Scanner] Starting fee collection cycle');

    try {
        // v25.113: Detect and record external claims FIRST (checks ALL beneficiaries)
        let externalResult = { detected: 0, recorded: 0, totalRecordedSol: 0 };
        try {
            externalResult = await detectAndRecordExternalClaims();
        } catch (e) {
            logger.warn('[PAGS Fee Scanner] External claim detection error', { error: e.message });
        }

        const pending = await getAllPendingFees();

        if (pending.beneficiaries.length === 0) {
            logger.debug('[PAGS Fee Scanner] No pending fees to claim');
            return {
                totalClaimed: 0, claimedCount: 0, claims: [],
                externalClaimsDetected: externalResult.detected,
                externalClaimsRecorded: externalResult.recorded
            };
        }

        logger.info('[PAGS Fee Scanner] Found pending fees', {
            beneficiaryCount: pending.beneficiaryCount,
            totalPendingSol: pending.totalPendingSol.toFixed(6)
        });

        const claims = [];
        let totalClaimedSol = 0;

        for (const beneficiary of pending.beneficiaries) {
            // v25.45: Skip if fee sharing was removed
            if (beneficiary.feeShareRemoved) {
                logger.info('[PAGS Fee Scanner] Skipping - fee share removed', {
                    mint: beneficiary.mint
                });
                continue;
            }

            // Only claim if there's a meaningful amount (> 0.001 SOL)
            if (beneficiary.ourShareLamports < 1000000) {
                continue;
            }

            const result = await claimFeesForBeneficiary(beneficiary);

            if (result) {
                claims.push(result);
                totalClaimedSol += result.claimedSol;

                // v25.45: Update vault balance cache after successful claim
                // Vault should now be near-empty (just rent-exempt minimum)
                updateVaultBalanceAfterClaim(beneficiary.mint, RENT_EXEMPT_MIN, 0);

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
            totalClaimedSol: totalClaimedSol.toFixed(6),
            externalClaimsDetected: externalResult.detected,
            externalClaimsRecorded: externalResult.recorded
        });

        return {
            totalClaimed: totalClaimedSol,
            claimedCount: claims.length,
            claims,
            externalClaimsDetected: externalResult.detected,
            externalClaimsRecorded: externalResult.recorded,
            externalClaimsSol: externalResult.totalRecordedSol
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
        configCacheSize: configCache.size,
        vaultBalanceCacheSize: lastVaultBalances.size,
        txBaselinesCached: lastProcessedSigs.size
    };
}

/**
 * v25.45: Clear caches (for testing or reset)
 */
function clearCaches() {
    configCache.clear();
    lastVaultBalances.clear();
    lastProcessedSigs.clear();
    logger.info('[PAGS Fee Scanner] Caches cleared');
}

module.exports = {
    init,
    checkPendingFeesForBeneficiary,
    getAllPendingFees,
    claimFeesForBeneficiary,
    collectAllFees,
    getStatus,
    parseFeeSharingConfig,
    findPagsShare,
    // v25.45: New exports
    verifyCurrentFeeShare,
    detectExternalClaim,
    clearCaches,
    // v25.113: External claim detection and vault balance management
    detectAndRecordExternalClaims,
    updateVaultBalanceCache,
    // v25.116: Transaction-based external claim detection
    detectExternalClaimsByTx
};
