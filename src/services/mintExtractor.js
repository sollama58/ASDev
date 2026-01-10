/**
 * Mint Extractor Service
 * Shared utility for extracting token mints from Pump.fun transactions
 *
 * Handles both:
 * - Bonding Curve transactions (pre-graduation)
 * - AMM/Pool transactions (post-graduation)
 *
 * v14.0 - Centralized mint extraction for all scanners
 */
const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { PROGRAMS } = require('../config/constants');
const config = require('../config/env');
const logger = require('./logger');

/**
 * Known program IDs to skip when looking for mints
 */
const KNOWN_PROGRAMS = new Set([
    '11111111111111111111111111111111', // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
    'ComputeBudget111111111111111111111111111111', // Compute Budget
    'SysvarRent111111111111111111111111111111111', // Rent Sysvar
    'SysvarC1ock11111111111111111111111111111111', // Clock Sysvar
    'So11111111111111111111111111111111111111112', // WSOL
    PROGRAMS.PUMP.toString(),
    PROGRAMS.PUMP_AMM.toString(),
    PROGRAMS.FEE.toString(),
    PROGRAMS.METADATA.toString(),
]);

/**
 * Instruction discriminators for Pump.fun programs
 */
const DISCRIMINATORS = {
    // Pump Bonding Curve
    PUMP_BUY: [102, 6, 61, 18, 1, 218, 235, 234],
    PUMP_SELL: [51, 230, 133, 164, 1, 127, 131, 173],
    // Pump AMM (pool) - buy/sell swap instructions
    AMM_BUY: [102, 6, 61, 18, 1, 218, 235, 234],
    AMM_SELL: [51, 230, 133, 164, 1, 127, 131, 173],
    // AMM swap discriminators
    AMM_SWAP_BASE_IN: [143, 190, 90, 218, 196, 30, 51, 222],
    AMM_SWAP_BASE_OUT: [55, 217, 98, 86, 163, 74, 180, 173],
};

/**
 * Check if instruction data matches a discriminator
 */
function matchesDiscriminator(data, discriminator) {
    if (data.length < 8) return false;
    return discriminator.every((b, i) => data[i] === b);
}

/**
 * Extract mint address from a Pump.fun bonding curve buy/sell transaction.
 *
 * In Pump buy/sell instructions, the account layout is:
 * - Index 0: global
 * - Index 1: fee_recipient
 * - Index 2: mint  <-- THIS IS WHAT WE WANT
 * - Index 3: bonding_curve
 * - Index 4: associated_bonding_curve
 *
 * @param {Object} tx - Transaction object from Helius
 * @param {string} pumpProgramId - Pump program ID string
 * @returns {string|null} - Mint address or null if not found
 */
function extractMintFromPumpTransaction(tx, pumpProgramId) {
    const message = tx.transaction?.message;
    if (!message) return null;

    const accountKeys = message.accountKeys || [];
    const instructions = message.instructions || [];

    for (const ix of instructions) {
        const programIdIndex = ix.programIdIndex;
        const programId = accountKeys[programIdIndex];
        const programIdStr = typeof programId === 'string' ? programId : programId?.pubkey;

        if (programIdStr !== pumpProgramId) continue;

        let data;
        try {
            data = Buffer.from(ix.data, 'base64');
        } catch {
            continue;
        }

        const isBuy = matchesDiscriminator(data, DISCRIMINATORS.PUMP_BUY);
        const isSell = matchesDiscriminator(data, DISCRIMINATORS.PUMP_SELL);

        if (!isBuy && !isSell) continue;

        const ixAccounts = ix.accounts || [];
        if (ixAccounts.length < 3) continue;

        const mintIndex = ixAccounts[2];
        const mintAccount = accountKeys[mintIndex];
        const mint = typeof mintAccount === 'string' ? mintAccount : mintAccount?.pubkey;

        if (mint && !KNOWN_PROGRAMS.has(mint)) {
            return mint;
        }
    }

    return null;
}

/**
 * Extract mint address from a Pump AMM (pool) swap transaction.
 *
 * In Pump AMM swap instructions, the account layout varies by instruction type:
 *
 * For swap_base_input / swap_base_output:
 * - Index 0: pool
 * - Index 1: pool_authority
 * - Index 2: pool_base_token_account
 * - Index 3: pool_quote_token_account
 * - Index 4: user_base_token_account
 * - Index 5: user_quote_token_account
 * - Index 6: user
 * - Index 7: base_token_mint  <-- THIS IS WHAT WE WANT
 * - Index 8: quote_token_mint (WSOL)
 *
 * @param {Object} tx - Transaction object from Helius
 * @param {string} ammProgramId - Pump AMM program ID string
 * @returns {string|null} - Mint address or null if not found
 */
function extractMintFromAmmTransaction(tx, ammProgramId) {
    const message = tx.transaction?.message;
    if (!message) return null;

    const accountKeys = message.accountKeys || [];
    const instructions = message.instructions || [];

    for (const ix of instructions) {
        const programIdIndex = ix.programIdIndex;
        const programId = accountKeys[programIdIndex];
        const programIdStr = typeof programId === 'string' ? programId : programId?.pubkey;

        if (programIdStr !== ammProgramId) continue;

        let data;
        try {
            data = Buffer.from(ix.data, 'base64');
        } catch {
            continue;
        }

        const isSwapBaseIn = matchesDiscriminator(data, DISCRIMINATORS.AMM_SWAP_BASE_IN);
        const isSwapBaseOut = matchesDiscriminator(data, DISCRIMINATORS.AMM_SWAP_BASE_OUT);
        const isBuy = matchesDiscriminator(data, DISCRIMINATORS.AMM_BUY);
        const isSell = matchesDiscriminator(data, DISCRIMINATORS.AMM_SELL);

        if (!isSwapBaseIn && !isSwapBaseOut && !isBuy && !isSell) continue;

        const ixAccounts = ix.accounts || [];

        // The base_token_mint is at index 7 for swap instructions
        if (ixAccounts.length >= 8) {
            const mintIndex = ixAccounts[7];
            const mintAccount = accountKeys[mintIndex];
            const mint = typeof mintAccount === 'string' ? mintAccount : mintAccount?.pubkey;

            if (mint && !KNOWN_PROGRAMS.has(mint)) {
                return mint;
            }
        }

        // Fallback: check index 2 for some instruction variants
        if (ixAccounts.length >= 3) {
            const mintIndex = ixAccounts[2];
            const mintAccount = accountKeys[mintIndex];
            const mint = typeof mintAccount === 'string' ? mintAccount : mintAccount?.pubkey;

            if (mint && !KNOWN_PROGRAMS.has(mint)) {
                return mint;
            }
        }
    }

    // Fallback: Check inner instructions for Token-2022 transfers
    const innerInstructions = tx.meta?.innerInstructions || [];
    for (const innerGroup of innerInstructions) {
        for (const inner of innerGroup.instructions || []) {
            const programIdIndex = inner.programIdIndex;
            const programId = accountKeys[programIdIndex];
            const programIdStr = typeof programId === 'string' ? programId : programId?.pubkey;

            if (programIdStr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
                const ixAccounts = inner.accounts || [];
                for (const accIdx of ixAccounts) {
                    const acc = accountKeys[accIdx];
                    const accStr = typeof acc === 'string' ? acc : acc?.pubkey;
                    if (accStr && !KNOWN_PROGRAMS.has(accStr) && accStr.length >= 32) {
                        return accStr;
                    }
                }
            }
        }
    }

    return null;
}

/**
 * Extract mint from any transaction (tries both Pump BC and AMM)
 *
 * @param {Object} tx - Transaction object from Helius
 * @returns {string|null} - Mint address or null if not found
 */
function extractMintFromTransaction(tx) {
    const pumpProgramId = PROGRAMS.PUMP.toString();
    const ammProgramId = PROGRAMS.PUMP_AMM.toString();

    // Try bonding curve first (more common for new tokens)
    let mint = extractMintFromPumpTransaction(tx, pumpProgramId);
    if (mint) return mint;

    // Try AMM (for graduated tokens)
    mint = extractMintFromAmmTransaction(tx, ammProgramId);
    if (mint) return mint;

    return null;
}

/**
 * Scan a vault address for transactions and extract mints
 *
 * @param {Object} options - Scan options
 * @param {string} options.vaultAddress - Vault address to scan
 * @param {string} options.vaultType - 'bc' or 'amm' for logging
 * @param {string|null} options.lastSignature - Last processed signature (for resuming)
 * @param {Set} options.foundMints - Set to add discovered mints to
 * @param {Set} options.processedSignatures - Set of already processed tx signatures
 * @param {Function} options.onProgress - Optional progress callback
 * @returns {Object} - Scan statistics { txProcessed, mintsFound, newestSignature }
 */
async function scanVaultForMints(options) {
    const {
        vaultAddress,
        vaultType = 'unknown',
        lastSignature = null,
        foundMints = new Set(),
        processedSignatures = new Set(),
        onProgress = null,
    } = options;

    if (!config.HELIUS_API_KEY) {
        logger.warn(`[MintExtractor] HELIUS_API_KEY not configured - skipping ${vaultType} vault scan`);
        return { txProcessed: 0, mintsFound: 0, newestSignature: null };
    }

    let paginationToken = null;
    let txProcessed = 0;
    let mintsFound = 0;
    let newestSignature = null;
    let reachedLastProcessed = false;

    try {
        do {
            const params = {
                limit: 100,
                sortOrder: 'desc',
                transactionDetails: 'full',
            };

            if (paginationToken) {
                params.paginationToken = paginationToken;
            }

            const response = await axios.post(
                `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                {
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'getTransactionsForAddress',
                    params: [vaultAddress, params]
                },
                { timeout: 30000 }
            );

            const result = response.data?.result;
            if (!result || !result.data || result.data.length === 0) {
                break;
            }

            for (const tx of result.data) {
                // Track newest signature for progress
                if (!newestSignature && tx.signature) {
                    newestSignature = tx.signature;
                }

                // Stop if we've reached previously processed signature
                if (lastSignature && tx.signature === lastSignature) {
                    reachedLastProcessed = true;
                    paginationToken = null;
                    break;
                }

                // Skip if already processed (deduplication)
                if (processedSignatures.has(tx.signature)) {
                    continue;
                }
                processedSignatures.add(tx.signature);

                txProcessed++;

                // Extract mint using unified extractor
                const mint = extractMintFromTransaction(tx);
                if (mint && !foundMints.has(mint)) {
                    foundMints.add(mint);
                    mintsFound++;
                }
            }

            paginationToken = result.paginationToken;

            // Progress callback
            if (onProgress && txProcessed > 0 && txProcessed % 500 === 0) {
                onProgress({ vaultType, txProcessed, mintsFound });
            }

            // Rate limit protection
            await new Promise(r => setTimeout(r, 100));

        } while (paginationToken && !reachedLastProcessed);

    } catch (e) {
        logger.error(`[MintExtractor] Vault scan error for ${vaultType}`, { error: e.message });
    }

    return { txProcessed, mintsFound, newestSignature };
}

/**
 * Reset vault scan progress for a creator (forces full rescan)
 *
 * @param {Object} options - Reset options
 * @param {PublicKey|string} options.creatorPubkey - Creator wallet public key
 * @param {Object} options.db - Database instance
 * @returns {boolean} - Whether reset was successful
 */
async function resetVaultScanProgress(options) {
    const { creatorPubkey, db } = options;

    if (!db) return false;

    const pubkeyStr = typeof creatorPubkey === 'string' ? creatorPubkey : creatorPubkey.toString();
    const bcProgressKey = `vault_scan_bc_${pubkeyStr.slice(0, 8)}`;
    const ammProgressKey = `vault_scan_amm_${pubkeyStr.slice(0, 8)}`;

    try {
        await db.run('DELETE FROM logs WHERE type = $1', [bcProgressKey]);
        await db.run('DELETE FROM logs WHERE type = $1', [ammProgressKey]);
        logger.info(`[MintExtractor] Reset vault scan progress for ${pubkeyStr.slice(0, 8)}...`);
        return true;
    } catch (e) {
        logger.warn('[MintExtractor] Failed to reset progress', { error: e.message });
        return false;
    }
}

/**
 * Scan both bonding curve and AMM vaults for a creator
 *
 * @param {Object} options - Scan options
 * @param {PublicKey} options.creatorPubkey - Creator wallet public key
 * @param {Object} options.db - Database instance for progress tracking
 * @param {Function} options.getCreatorFeeVaults - Function to get vault addresses
 * @param {boolean} options.saveProgress - Whether to save progress to database
 * @param {boolean} options.resetProgress - Force full rescan by ignoring saved progress
 * @returns {Object} - { foundMints: Set, bcStats, ammStats }
 */
async function scanCreatorVaultsForMints(options) {
    const {
        creatorPubkey,
        db,
        getCreatorFeeVaults,
        saveProgress = true,
        resetProgress = false,
    } = options;

    const { bcVault, ammVaultAuth } = getCreatorFeeVaults(creatorPubkey);

    const foundMints = new Set();
    const processedSignatures = new Set();

    // Get progress from database (unless resetProgress is true)
    const bcProgressKey = `vault_scan_bc_${creatorPubkey.toString().slice(0, 8)}`;
    const ammProgressKey = `vault_scan_amm_${creatorPubkey.toString().slice(0, 8)}`;

    let bcLastSig = null;
    let ammLastSig = null;

    if (db && !resetProgress) {
        try {
            const bcRow = await db.get('SELECT data FROM logs WHERE type = $1 ORDER BY id DESC LIMIT 1', [bcProgressKey]);
            bcLastSig = bcRow?.data || null;

            const ammRow = await db.get('SELECT data FROM logs WHERE type = $1 ORDER BY id DESC LIMIT 1', [ammProgressKey]);
            ammLastSig = ammRow?.data || null;
        } catch (e) {
            // Progress fetch failed, start fresh
        }
    }

    if (resetProgress) {
        logger.info('[MintExtractor] Reset requested - performing full vault scan');
    }

    // Scan bonding curve vault
    const bcStats = await scanVaultForMints({
        vaultAddress: bcVault.toString(),
        vaultType: 'bc',
        lastSignature: bcLastSig,
        foundMints,
        processedSignatures,
        onProgress: ({ vaultType, txProcessed, mintsFound }) => {
            logger.debug(`[MintExtractor] [${vaultType.toUpperCase()}] Processed ${txProcessed} txs, found ${mintsFound} mints`);
        },
    });

    // Scan AMM vault
    const ammStats = await scanVaultForMints({
        vaultAddress: ammVaultAuth.toString(),
        vaultType: 'amm',
        lastSignature: ammLastSig,
        foundMints,
        processedSignatures,
        onProgress: ({ vaultType, txProcessed, mintsFound }) => {
            logger.debug(`[MintExtractor] [${vaultType.toUpperCase()}] Processed ${txProcessed} txs, found ${mintsFound} mints`);
        },
    });

    // Save progress to database
    if (db && saveProgress) {
        try {
            if (bcStats.newestSignature) {
                await db.run(
                    'INSERT INTO logs (type, data, timestamp) VALUES ($1, $2, $3)',
                    [bcProgressKey, bcStats.newestSignature, new Date().toISOString()]
                );
            }
            if (ammStats.newestSignature) {
                await db.run(
                    'INSERT INTO logs (type, data, timestamp) VALUES ($1, $2, $3)',
                    [ammProgressKey, ammStats.newestSignature, new Date().toISOString()]
                );
            }
        } catch (e) {
            logger.warn('[MintExtractor] Failed to save scan progress', { error: e.message });
        }
    }

    return { foundMints, bcStats, ammStats };
}

/**
 * Fetch token market data from DexScreener
 * @param {string} mint - Token mint address
 * @returns {Object|null} - Market data or null
 */
async function fetchDexScreenerData(mint) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
            timeout: 5000
        });
        const pairs = response.data?.pairs || [];
        if (pairs.length > 0) {
            const pair = pairs[0];
            return {
                marketCap: pair.fdv || pair.marketCap || 0,
                volume24h: pair.volume?.h24 || 0,
                priceUsd: parseFloat(pair.priceUsd) || 0,
                // Also get name/ticker from DexScreener as backup
                dexName: pair.baseToken?.name || null,
                dexTicker: pair.baseToken?.symbol || null,
                dexImage: pair.info?.imageUrl || null,
            };
        }
    } catch (e) {
        // Silent fail - market data is optional
    }
    return null;
}

/**
 * Validate mints in batches using Helius getAssetBatch + DexScreener for market data
 *
 * @param {Array<string>} mints - Array of mint addresses to validate
 * @param {Object} options - Options
 * @param {boolean} options.fetchMarketData - Whether to fetch market data from DexScreener (default: true)
 * @returns {Array<Object>} - Array of validated token metadata objects
 */
async function validateMintsBatch(mints, options = {}) {
    const { fetchMarketData = true } = options;

    if (!config.HELIUS_API_KEY) {
        logger.warn('[MintExtractor] HELIUS_API_KEY not configured - skipping validation');
        return [];
    }

    const validTokens = [];
    const mintArray = Array.isArray(mints) ? mints : Array.from(mints);

    // Process in batches of 100 (Helius limit)
    for (let i = 0; i < mintArray.length; i += 100) {
        const batch = mintArray.slice(i, i + 100);

        try {
            const batchResponse = await axios.post(
                `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                {
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'getAssetBatch',
                    params: { ids: batch }
                },
                { timeout: 15000 }
            );

            const assets = batchResponse.data?.result || [];
            for (const asset of assets) {
                if (asset && (asset.interface === 'FungibleToken' || asset.interface === 'FungibleAsset')) {
                    const metadata = asset.content?.metadata || {};
                    const files = asset.content?.files || [];
                    const imageFile = files.find(f => f.mime?.startsWith('image/')) || files[0];

                    const tokenData = {
                        mint: asset.id,
                        name: metadata.name || 'Unknown',
                        ticker: metadata.symbol || 'UNKNOWN',
                        description: metadata.description || '',
                        image: imageFile?.cdn_uri || imageFile?.uri || asset.content?.links?.image || null,
                        metadataUri: asset.content?.json_uri || null,
                        twitter: asset.content?.links?.twitter || '',
                        website: asset.content?.links?.external_url || '',
                        creator: asset.creators?.[0]?.address || null,
                        // Market data defaults (will be populated below)
                        marketCap: 0,
                        volume24h: 0,
                        priceUsd: 0,
                    };

                    // Fetch market data from DexScreener
                    if (fetchMarketData) {
                        const dexData = await fetchDexScreenerData(asset.id);
                        if (dexData) {
                            tokenData.marketCap = dexData.marketCap;
                            tokenData.volume24h = dexData.volume24h;
                            tokenData.priceUsd = dexData.priceUsd;
                            // Use DexScreener data as fallback for missing metadata
                            if (tokenData.name === 'Unknown' && dexData.dexName) {
                                tokenData.name = dexData.dexName;
                            }
                            if (tokenData.ticker === 'UNKNOWN' && dexData.dexTicker) {
                                tokenData.ticker = dexData.dexTicker;
                            }
                            if (!tokenData.image && dexData.dexImage) {
                                tokenData.image = dexData.dexImage;
                            }
                        }
                        // Small delay between DexScreener calls to avoid rate limiting
                        await new Promise(r => setTimeout(r, 150));
                    }

                    validTokens.push(tokenData);
                }
            }

            // Rate limit between batches
            await new Promise(r => setTimeout(r, 200));

        } catch (e) {
            logger.warn(`[MintExtractor] Batch validation error`, { error: e.message });
        }
    }

    return validTokens;
}

module.exports = {
    // Core extraction functions
    extractMintFromTransaction,
    extractMintFromPumpTransaction,
    extractMintFromAmmTransaction,
    matchesDiscriminator,

    // Vault scanning
    scanVaultForMints,
    scanCreatorVaultsForMints,
    resetVaultScanProgress,

    // Validation & Market Data
    validateMintsBatch,
    fetchDexScreenerData,

    // Constants (for external use if needed)
    DISCRIMINATORS,
    KNOWN_PROGRAMS,
};
