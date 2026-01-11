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
 * Known program IDs and tokens to skip when looking for mints
 * Includes system programs, wrapped tokens, and stablecoins
 */
const KNOWN_PROGRAMS = new Set([
    // System Programs
    '11111111111111111111111111111111', // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
    'ComputeBudget111111111111111111111111111111', // Compute Budget
    'SysvarRent111111111111111111111111111111111', // Rent Sysvar
    'SysvarC1ock11111111111111111111111111111111', // Clock Sysvar

    // Wrapped SOL (quote token for Pump.fun)
    'So11111111111111111111111111111111111111112', // WSOL

    // Stablecoins - NOT our tokens, skip these
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',  // USDH
    'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',  // USDS
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF (not stablecoin but wrapped)
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK (skip large popular tokens)

    // Pump.fun programs
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

    // Fallback: Try to find mint from enhanced transaction data (Helius parsed format)
    mint = extractMintFromEnhancedTx(tx);
    if (mint) return mint;

    return null;
}

/**
 * Extract mint from Helius enhanced/parsed transaction format
 * Helius can return transactions in an enhanced format with tokenTransfers, etc.
 *
 * @param {Object} tx - Transaction object from Helius
 * @returns {string|null} - Mint address or null if not found
 */
function extractMintFromEnhancedTx(tx) {
    // Check for Helius enhanced transaction format
    // This format includes parsed tokenTransfers array
    const tokenTransfers = tx.tokenTransfers || [];
    for (const transfer of tokenTransfers) {
        const mint = transfer.mint;
        if (mint && !KNOWN_PROGRAMS.has(mint)) {
            return mint;
        }
    }

    // Check accountData for token accounts
    const accountData = tx.accountData || [];
    for (const acc of accountData) {
        if (acc.tokenBalanceChanges) {
            for (const change of acc.tokenBalanceChanges) {
                const mint = change.mint;
                if (mint && !KNOWN_PROGRAMS.has(mint)) {
                    return mint;
                }
            }
        }
    }

    // Check events for token info
    const events = tx.events || {};
    if (events.swap) {
        const tokenInputs = events.swap.tokenInputs || [];
        const tokenOutputs = events.swap.tokenOutputs || [];
        for (const tok of [...tokenInputs, ...tokenOutputs]) {
            const mint = tok.mint || tok.tokenMint;
            if (mint && !KNOWN_PROGRAMS.has(mint)) {
                return mint;
            }
        }
    }

    // Check instructions for program interactions
    const instructions = tx.instructions || [];
    for (const ix of instructions) {
        // Check if this is a Pump.fun instruction with accounts
        if (ix.programId === PROGRAMS.PUMP.toString() || ix.programId === PROGRAMS.PUMP_AMM.toString()) {
            const accounts = ix.accounts || [];
            // For Pump.fun, mint is typically one of the first few accounts
            for (let i = 0; i < Math.min(accounts.length, 10); i++) {
                const acc = accounts[i];
                const accStr = typeof acc === 'string' ? acc : acc?.pubkey;
                if (accStr && !KNOWN_PROGRAMS.has(accStr) && accStr.length >= 32) {
                    // Quick validation: Pump mints typically end in "pump"
                    if (accStr.endsWith('pump') || accStr.endsWith('Pump')) {
                        return accStr;
                    }
                }
            }
        }

        // Check inner instructions
        const innerIxs = ix.innerInstructions || [];
        for (const inner of innerIxs) {
            if (inner.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ||
                inner.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                const accounts = inner.accounts || [];
                for (const acc of accounts) {
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
 * Extract the source address (bonding curve or pool) from a vault transaction.
 * This is the address that sent SOL to our vault.
 *
 * @param {Object} tx - Transaction object from Helius
 * @param {string} vaultAddress - Our vault address
 * @returns {string|null} - Source address or null
 */
function extractSourceAddress(tx, vaultAddress) {
    // Check native transfers (enhanced format)
    const nativeTransfers = tx.nativeTransfers || [];
    for (const transfer of nativeTransfers) {
        if (transfer.toUserAccount === vaultAddress && transfer.fromUserAccount) {
            return transfer.fromUserAccount;
        }
    }

    // Check account keys for the sender (RPC format)
    // In a fee transfer, the source is typically one of the first writable accounts
    const message = tx.transaction?.message;
    if (message) {
        const accountKeys = message.accountKeys || [];
        // The fee source is usually the account that had SOL debited
        // Look for accounts that aren't our vault or system programs
        for (const key of accountKeys) {
            const keyStr = typeof key === 'string' ? key : key?.pubkey;
            if (keyStr && keyStr !== vaultAddress && !KNOWN_PROGRAMS.has(keyStr)) {
                // Return the first non-program, non-vault account as potential source
                return keyStr;
            }
        }
    }

    return null;
}

/**
 * Scan a vault address for transactions and extract mints
 *
 * Deduplication strategy:
 * - Each bonding curve/pool has a unique address
 * - We track which source addresses we've seen
 * - Once we see a source, we've found that token - skip future txs from same source
 *
 * @param {Object} options - Scan options
 * @param {string} options.vaultAddress - Vault address to scan
 * @param {string} options.vaultType - 'bc' or 'amm' for logging
 * @param {string|null} options.lastSignature - Last processed signature (for resuming)
 * @param {Set} options.foundMints - Set to add discovered mints to
 * @param {Set} options.processedSources - Set of already processed source addresses (BC/pools)
 * @param {Function} options.onProgress - Optional progress callback
 * @returns {Object} - Scan statistics { txProcessed, mintsFound, newestSignature }
 */
async function scanVaultForMints(options) {
    const {
        vaultAddress,
        vaultType = 'unknown',
        lastSignature = null,
        foundMints = new Set(),
        processedSources = new Set(),
        onProgress = null,
    } = options;

    if (!config.HELIUS_API_KEY) {
        logger.warn(`[MintExtractor] HELIUS_API_KEY not configured - skipping ${vaultType} vault scan`);
        return { txProcessed: 0, mintsFound: 0, newestSignature: null };
    }

    let paginationToken = null;
    let txProcessed = 0;
    let mintsFound = 0;
    let sourcesSkipped = 0;
    let newestSignature = null;
    let reachedLastProcessed = false;

    try {
        do {
            // Use Helius Enhanced Transactions API for parsed data
            // This gives us tokenTransfers, accountData with balance changes, etc.
            const params = {
                limit: 100,
                sortOrder: 'desc',
                transactionDetails: 'full',
                // Request enhanced/parsed format
                commitment: 'confirmed',
            };

            if (paginationToken) {
                params.paginationToken = paginationToken;
            }

            // First try the enhanced API endpoint
            let response;
            try {
                response = await axios.get(
                    `https://api.helius.xyz/v0/addresses/${vaultAddress}/transactions?api-key=${config.HELIUS_API_KEY}&limit=${params.limit}${paginationToken ? `&before=${paginationToken}` : ''}`,
                    { timeout: 30000 }
                );
                // Enhanced API returns array directly
                if (Array.isArray(response.data)) {
                    response = { data: { result: { data: response.data } } };
                }
            } catch (enhancedErr) {
                // Fallback to standard RPC
                logger.debug(`[MintExtractor] Enhanced API failed, using standard RPC: ${enhancedErr.message}`);
                response = await axios.post(
                    `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                    {
                        jsonrpc: '2.0',
                        id: '1',
                        method: 'getTransactionsForAddress',
                        params: [vaultAddress, params]
                    },
                    { timeout: 30000 }
                );
            }

            // Handle both enhanced API (array) and standard RPC (result.data)
            let txData;
            let nextPaginationToken = null;

            if (Array.isArray(response.data)) {
                // Enhanced API returns array directly
                txData = response.data;
                // For enhanced API, use last signature for pagination
                if (txData.length > 0) {
                    nextPaginationToken = txData[txData.length - 1].signature;
                }
            } else {
                // Standard RPC format
                const result = response.data?.result;
                txData = result?.data || [];
                nextPaginationToken = result?.paginationToken;
            }

            if (!txData || txData.length === 0) {
                break;
            }

            for (const tx of txData) {
                // Track newest signature for progress
                if (!newestSignature && tx.signature) {
                    newestSignature = tx.signature;
                }

                // Stop if we've reached previously processed signature
                if (lastSignature && tx.signature === lastSignature) {
                    reachedLastProcessed = true;
                    nextPaginationToken = null;
                    break;
                }

                txProcessed++;

                // Extract the source address (bonding curve or pool that sent fees)
                const sourceAddress = extractSourceAddress(tx, vaultAddress);

                // Skip if we've already processed this source (same BC/pool)
                // Each BC/pool corresponds to one token, so we only need to process once
                if (sourceAddress && processedSources.has(sourceAddress)) {
                    sourcesSkipped++;
                    continue;
                }

                // Extract mint using unified extractor
                const mint = extractMintFromTransaction(tx);
                if (mint && !foundMints.has(mint)) {
                    foundMints.add(mint);
                    mintsFound++;
                    logger.debug(`[MintExtractor] Found mint: ${mint.slice(0, 8)}... from source ${sourceAddress?.slice(0, 8) || 'unknown'}...`);

                    // Mark this source as processed so we skip future txs from it
                    if (sourceAddress) {
                        processedSources.add(sourceAddress);
                    }
                } else if (sourceAddress) {
                    // Even if we didn't find a mint, mark the source as seen
                    // to avoid re-processing transactions from the same BC/pool
                    processedSources.add(sourceAddress);
                }
            }

            paginationToken = nextPaginationToken;

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

    logger.debug(`[MintExtractor] ${vaultType.toUpperCase()} scan: ${txProcessed} txs, ${mintsFound} mints, ${sourcesSkipped} duplicate sources skipped`);
    return { txProcessed, mintsFound, sourcesSkipped, newestSignature };
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
    const processedSources = new Set(); // Track unique source addresses (BC/pools)

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
        processedSources,
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
        processedSources,
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
 * For old tokens that Helius doesn't have, falls back to DexScreener as primary source.
 * This ensures we don't lose tokens just because they're not in Helius's index.
 *
 * @param {Array<string>} mints - Array of mint addresses to validate
 * @param {Object} options - Options
 * @param {boolean} options.fetchMarketData - Whether to fetch market data from DexScreener (default: true)
 * @returns {Array<Object>} - Array of validated token metadata objects
 */
async function validateMintsBatch(mints, options = {}) {
    const { fetchMarketData = true } = options;

    const validTokens = [];
    const mintArray = Array.isArray(mints) ? mints : Array.from(mints);
    const processedMints = new Set();

    logger.info(`[MintExtractor] validateMintsBatch called for ${mintArray.length} mints`);

    // Phase 1: Try Helius first for tokens that have metadata indexed
    if (config.HELIUS_API_KEY) {
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
                logger.info(`[MintExtractor] Helius returned ${assets.length} assets`);
                for (const asset of assets) {
                    // Accept FungibleToken, FungibleAsset, or any asset with metadata
                    // Some new tokens might have different interface types
                    const hasMetadata = asset?.content?.metadata?.name || asset?.content?.metadata?.symbol;
                    const isFungible = asset?.interface === 'FungibleToken' || asset?.interface === 'FungibleAsset';

                    if (asset && asset.id && (isFungible || hasMetadata)) {
                        logger.info(`[MintExtractor] Processing asset ${asset.id.slice(0, 8)}... interface=${asset.interface}, hasMetadata=${hasMetadata}`);
                        const metadata = asset.content?.metadata || {};
                        const files = asset.content?.files || [];
                        const imageFile = files.find(f => f.mime?.startsWith('image/')) || files[0];

                        // Try multiple image sources
                        const heliusImage = imageFile?.cdn_uri || imageFile?.uri || asset.content?.links?.image || null;

                        logger.info(`[MintExtractor] Helius asset ${asset.id.slice(0, 8)}...: name=${metadata.name}, symbol=${metadata.symbol}, image=${heliusImage ? 'YES' : 'NO'}, files=${files.length}`);

                        const tokenData = {
                            mint: asset.id,
                            name: metadata.name || 'Unknown',
                            ticker: metadata.symbol || 'UNKNOWN',
                            description: metadata.description || '',
                            image: heliusImage,
                            metadataUri: asset.content?.json_uri || null,
                            twitter: asset.content?.links?.twitter || '',
                            website: asset.content?.links?.external_url || '',
                            creator: asset.creators?.[0]?.address || null,
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
                                    logger.info(`[MintExtractor] Using DexScreener image for ${asset.id.slice(0, 8)}...`);
                                }
                            }
                            await new Promise(r => setTimeout(r, 150));
                        }

                        logger.info(`[MintExtractor] Final token data for ${asset.id.slice(0, 8)}...: ticker=${tokenData.ticker}, image=${tokenData.image ? tokenData.image.slice(0, 50) + '...' : 'NULL'}`);
                        validTokens.push(tokenData);
                        processedMints.add(asset.id);
                    }
                }

                await new Promise(r => setTimeout(r, 200));

            } catch (e) {
                logger.warn(`[MintExtractor] Helius batch validation error`, { error: e.message });
            }
        }
    }

    // Phase 2: For mints not found in Helius, try DexScreener as primary source
    // This catches old tokens, dead tokens, or tokens not yet indexed by Helius
    const missingMints = mintArray.filter(m => !processedMints.has(m));

    if (missingMints.length > 0) {
        logger.debug(`[MintExtractor] ${missingMints.length} mints not in Helius, trying DexScreener...`);

        for (const mint of missingMints) {
            try {
                const dexData = await fetchDexScreenerData(mint);
                if (dexData && (dexData.dexName || dexData.dexTicker)) {
                    // DexScreener has this token - it's valid
                    const tokenData = {
                        mint,
                        name: dexData.dexName || 'Unknown',
                        ticker: dexData.dexTicker || 'UNKNOWN',
                        description: '',
                        image: dexData.dexImage || null,
                        metadataUri: null,
                        twitter: '',
                        website: '',
                        creator: null,
                        marketCap: dexData.marketCap || 0,
                        volume24h: dexData.volume24h || 0,
                        priceUsd: dexData.priceUsd || 0,
                    };

                    validTokens.push(tokenData);
                    processedMints.add(mint);
                    logger.debug(`[MintExtractor] Found ${tokenData.ticker} via DexScreener (not in Helius)`);
                }

                await new Promise(r => setTimeout(r, 150));
            } catch (e) {
                // Silent fail - mint is likely dead/invalid
            }
        }
    }

    // Phase 3: For any remaining mints (not in Helius or DexScreener),
    // try to fetch metadata directly from Pump.fun API
    const stillMissing = mintArray.filter(m => !processedMints.has(m));
    if (stillMissing.length > 0) {
        logger.info(`[MintExtractor] ${stillMissing.length} mints not found in Helius/DexScreener, trying pump.fun API...`);

        for (const mint of stillMissing) {
            try {
                const pumpMetaUrl = `https://frontend-api.pump.fun/coins/${mint}`;

                // Try pump.fun API (reliable for all Pump.fun tokens, new and old)
                try {
                    const pumpResponse = await axios.get(pumpMetaUrl, { timeout: 5000 });
                    if (pumpResponse.data) {
                        const pumpData = pumpResponse.data;
                        logger.info(`[MintExtractor] Found ${mint.slice(0, 8)}... via pump.fun API: name=${pumpData.name}, symbol=${pumpData.symbol}, image=${pumpData.image_uri ? 'YES' : 'NO'}`);
                        validTokens.push({
                            mint,
                            name: pumpData.name || 'Unknown Token',
                            ticker: pumpData.symbol || 'UNKNOWN',
                            description: pumpData.description || '',
                            image: pumpData.image_uri || pumpData.image || null,
                            metadataUri: pumpData.metadata_uri || null,
                            twitter: pumpData.twitter || '',
                            website: pumpData.website || '',
                            creator: pumpData.creator || null,
                            marketCap: pumpData.usd_market_cap || 0,
                            volume24h: 0,
                            priceUsd: 0,
                        });
                        processedMints.add(mint);
                        continue;
                    }
                } catch (e) {
                    logger.debug(`[MintExtractor] pump.fun API failed for ${mint.slice(0, 8)}...: ${e.message}`);
                }

                // Don't add minimal fallback data - if we can't find metadata, skip the token
                // This prevents blank tokens from being added
                logger.warn(`[MintExtractor] Could not find metadata for ${mint.slice(0, 8)}... - token skipped`);
            } catch (e) {
                logger.debug(`[MintExtractor] Failed to fetch metadata for ${mint}`, { error: e.message });
            }
        }
    }

    logger.info(`[MintExtractor] validateMintsBatch complete: ${validTokens.length} tokens returned`);
    return validTokens;
}

/**
 * Parse fee sharing config account data
 *
 * The ACTUAL Pump.fun fee_sharing_config structure is:
 * - 8 bytes: discriminator (anchor account discriminator)
 * - 32 bytes: creator (the original token creator's pubkey)
 * - 4 bytes: shareholder_count (u32, little-endian)
 * - N * 34 bytes: shareholders (32 byte pubkey + 2 byte bps each)
 *
 * Total sizes: 44 base + 34 per shareholder
 * - 1 shareholder: 78 bytes
 * - 2 shareholders: 112 bytes
 * - 3 shareholders: 146 bytes
 * - 4 shareholders: 180 bytes
 * - 5 shareholders: 214 bytes
 *
 * @param {Buffer} data - Raw account data
 * @returns {Object|null} Parsed config or null if invalid
 */
function parseFeeSharingConfig(data) {
    try {
        if (data.length < 44) return null; // Minimum: 8 (discriminator) + 32 (creator) + 4 (count)

        const creator = new PublicKey(data.slice(8, 40));

        // Number of shareholders (4 bytes, little-endian) at offset 40
        const shareholderCount = data.readUInt32LE(40);

        // Sanity check - shouldn't have more than 10 shareholders, and must have at least 1
        if (shareholderCount > 10 || shareholderCount < 1) return null;

        // Expected size: 44 base + 34 per shareholder
        const expectedMinSize = 44 + (shareholderCount * 34);
        if (data.length < expectedMinSize) return null;

        const shareholders = [];
        let offset = 44;

        for (let i = 0; i < shareholderCount && offset + 34 <= data.length; i++) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            const shareBps = data.readUInt16LE(offset + 32);

            // Sanity check - bps should be 0-10000
            if (shareBps > 10000) return null;

            shareholders.push({ pubkey, shareBps });
            offset += 34;
        }

        // Verify we got all expected shareholders
        if (shareholders.length !== shareholderCount) return null;

        return { creator, mint: null, shareholders, format: 'standard' };
    } catch (e) {
        return null;
    }
}

/**
 * Parse fee sharing config - alias for backward compatibility
 * The "alt" format was a misunderstanding - there's only one format
 *
 * @param {Buffer} data - Raw account data
 * @returns {Object|null} Parsed config or null if invalid
 */
function parseFeeSharingConfigAlt(data) {
    return parseFeeSharingConfig(data);
}

/**
 * Try parsing fee sharing config
 * Uses the standard format (no mint stored in config)
 *
 * @param {Buffer} data - Raw account data
 * @returns {Object|null} Parsed config or null if invalid
 */
function parseFeeSharingConfigAny(data) {
    return parseFeeSharingConfig(data);
}

/**
 * Verify that a wallet is a fee recipient for a given token mint
 *
 * Based on Pump.fun fee distribution:
 * 1. Fees accumulate in creator_vault during buy/sell
 * 2. Creator enables sharing by calling create_fee_sharing_config
 *    - This changes the coin_creator field to the fee_sharing_config PDA
 * 3. Creator configures shareholders via update_fee_shares (total must = 10000 bps)
 * 4. Fees distributed via distribute_creator_fees based on share percentages
 *
 * Verification Flow:
 * 1. Read coin_creator from bonding curve (pre-graduation) or AMM pool (post-graduation)
 * 2. If coin_creator === our wallet -> Direct creator (100% share)
 * 3. If coin_creator is a fee_sharing_config PDA (owned by PUMP) -> Parse shareholders, find our BPS
 * 4. Otherwise -> Not a fee recipient
 *
 * @param {string} mint - Token mint address
 * @param {string} walletToVerify - Wallet public key to verify as fee recipient
 * @param {Object} connection - Solana connection object
 * @returns {Promise<{isRecipient: boolean, source: string|null, feeShareBps: number, feeSharePercent: number, originalCreator?: string}>}
 */
async function verifyFeeRecipient(mint, walletToVerify, connection) {
    try {
        const mintPubkey = new PublicKey(mint);
        const walletKey = new PublicKey(walletToVerify);

        // Step 1: Get coin_creator from bonding curve or AMM pool
        const coinCreatorResult = await getCoinCreator(mintPubkey, connection);

        if (!coinCreatorResult) {
            logger.debug(`[MintExtractor] ${mint.slice(0, 8)}... - No coin_creator found`);
            return { isRecipient: false, source: null, feeShareBps: 0, feeSharePercent: 0 };
        }

        const { coinCreator, source } = coinCreatorResult;

        // Step 2: Check if we ARE the direct creator (100% share)
        if (coinCreator.equals(walletKey)) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Direct creator via ${source} (100% fee share)`);
            return { isRecipient: true, source, feeShareBps: 10000, feeSharePercent: 100 };
        }

        // Step 3: coin_creator is not us - check if it's a fee_sharing_config PDA
        // When fee sharing is enabled, coin_creator IS the fee_sharing_config PDA
        const feeSharingResult = await checkFeeSharingConfig(coinCreator, walletKey, mint, connection);

        if (feeSharingResult) {
            return feeSharingResult;
        }

        // Not a fee recipient
        logger.debug(`[MintExtractor] ${mint.slice(0, 8)}... - Not a fee recipient`);
        return { isRecipient: false, source: null, feeShareBps: 0, feeSharePercent: 0 };

    } catch (e) {
        logger.warn(`[MintExtractor] Fee recipient verification failed for ${mint}`, { error: e.message });
        return { isRecipient: false, source: null, feeShareBps: 0, feeSharePercent: 0 };
    }
}

/**
 * Get the original token creator from Metaplex metadata
 *
 * For Pump.fun tokens, the first verified creator in the metadata is the original creator.
 * This is set when the token is created and doesn't change when fee sharing is enabled.
 *
 * @param {PublicKey} mintPubkey - Token mint public key
 * @param {Object} connection - Solana connection
 * @returns {Promise<PublicKey|null>} Original creator pubkey or null
 */
async function getOriginalCreatorFromMetadata(mintPubkey, connection) {
    try {
        // Derive the Metaplex metadata PDA
        const [metadataPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("metadata"), PROGRAMS.METADATA.toBuffer(), mintPubkey.toBuffer()],
            PROGRAMS.METADATA
        );

        logger.info(`[MintExtractor] Fetching metadata PDA: ${metadataPDA.toString()}`);

        const metadataAccount = await connection.getAccountInfo(metadataPDA);
        if (!metadataAccount) {
            logger.info(`[MintExtractor] Metadata account not found`);
            return null;
        }

        const data = metadataAccount.data;
        logger.info(`[MintExtractor] Metadata account data length: ${data.length}`);

        // Ensure we have enough data for the basic fields
        if (data.length < 65) {
            logger.info(`[MintExtractor] Metadata data too short: ${data.length}`);
            return null;
        }

        // For Pump.fun tokens, the update_authority is set to the original creator
        // This is at offset 1-33 in the metadata account
        // Structure: 1 byte key + 32 bytes update_authority + 32 bytes mint + ...
        const updateAuthority = new PublicKey(data.slice(1, 33));
        logger.info(`[MintExtractor] Update authority from metadata: ${updateAuthority.toString()}`);

        // Try to parse creators array but don't fail if we can't
        try {
            // Skip key (1) + update_authority (32) + mint (32) = offset 65
            let offset = 65;

            // Skip name (4 byte length prefix + chars)
            if (offset + 4 > data.length) {
                logger.info(`[MintExtractor] Not enough data for name length at offset ${offset}`);
                return updateAuthority;
            }
            const nameLen = data.readUInt32LE(offset);
            offset += 4 + nameLen;

            // Skip symbol (4 byte length prefix + chars)
            if (offset + 4 > data.length) {
                logger.info(`[MintExtractor] Not enough data for symbol length at offset ${offset}`);
                return updateAuthority;
            }
            const symbolLen = data.readUInt32LE(offset);
            offset += 4 + symbolLen;

            // Skip uri (4 byte length prefix + chars)
            if (offset + 4 > data.length) {
                logger.info(`[MintExtractor] Not enough data for uri length at offset ${offset}`);
                return updateAuthority;
            }
            const uriLen = data.readUInt32LE(offset);
            offset += 4 + uriLen;

            // Skip seller fee basis points (2 bytes)
            offset += 2;

            // Check if has creators (Option<Vec<Creator>>)
            if (offset >= data.length) {
                logger.info(`[MintExtractor] Not enough data for creators option at offset ${offset}`);
                return updateAuthority;
            }
            const hasCreatorsOption = data[offset];
            offset += 1;

            if (hasCreatorsOption === 1) {
                if (offset + 4 > data.length) {
                    logger.info(`[MintExtractor] Not enough data for creator count`);
                    return updateAuthority;
                }
                const creatorCount = data.readUInt32LE(offset);
                offset += 4;

                logger.info(`[MintExtractor] Found ${creatorCount} creator(s) in metadata creators array`);

                if (creatorCount > 0 && creatorCount < 10 && offset + 34 <= data.length) {
                    const creatorAddress = new PublicKey(data.slice(offset, offset + 32));
                    const verified = data[offset + 32] === 1;
                    const share = data[offset + 33];

                    logger.info(`[MintExtractor] First creator: ${creatorAddress.toString()}, verified: ${verified}, share: ${share}`);

                    if (verified) {
                        return creatorAddress;
                    }
                }
            } else {
                logger.info(`[MintExtractor] Metadata has no creators array (hasCreatorsOption=${hasCreatorsOption})`);
            }
        } catch (parseError) {
            logger.info(`[MintExtractor] Error parsing creators array, using update_authority: ${parseError.message}`);
        }

        // Return update_authority as the original creator
        logger.info(`[MintExtractor] Using update_authority as original creator: ${updateAuthority.toString()}`);
        return updateAuthority;

    } catch (e) {
        logger.error(`[MintExtractor] Error getting creator from metadata: ${e.message}`, { stack: e.stack });
        return null;
    }
}

/**
 * Get coin_creator from bonding curve or AMM pool
 *
 * @param {PublicKey} mintPubkey - Token mint public key
 * @param {Object} connection - Solana connection
 * @returns {Promise<{coinCreator: PublicKey, source: string}|null>}
 */
async function getCoinCreator(mintPubkey, connection) {
    const mintStr = mintPubkey.toString();
    logger.info(`[MintExtractor] Getting coin_creator for mint: ${mintStr.slice(0, 8)}...`);

    // Try bonding curve first (pre-graduation)
    const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
        PROGRAMS.PUMP
    );
    logger.info(`[MintExtractor] Derived BC PDA: ${bondingCurve.toString()}`);

    try {
        const bcAccountInfo = await connection.getAccountInfo(bondingCurve);
        if (bcAccountInfo) {
            logger.info(`[MintExtractor] BC account exists: dataLen=${bcAccountInfo.data.length}, lamports=${bcAccountInfo.lamports}`);
            if (bcAccountInfo.data.length >= 81) {
                // Bonding curve layout: coin_creator at offset 49 (32 bytes)
                const coinCreator = new PublicKey(bcAccountInfo.data.slice(49, 81));
                logger.info(`[MintExtractor] Got coin_creator from BC: ${coinCreator.toString()}`);
                return { coinCreator, source: 'bonding_curve' };
            } else {
                logger.info(`[MintExtractor] BC data too short: ${bcAccountInfo.data.length} < 81`);
            }
        } else {
            logger.info(`[MintExtractor] BC account does not exist (token may be graduated)`);
        }
    } catch (e) {
        logger.info(`[MintExtractor] BC fetch error: ${e.message}`);
    }

    // Try AMM pool (post-graduation)
    const [poolAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool-authority"), mintPubkey.toBuffer()],
        PROGRAMS.PUMP_AMM
    );

    const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
    const [pool] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), poolAuthority.toBuffer(), mintPubkey.toBuffer(), WSOL.toBuffer()],
        PROGRAMS.PUMP_AMM
    );
    logger.info(`[MintExtractor] Derived AMM pool PDA: ${pool.toString()}`);

    try {
        const poolAccountInfo = await connection.getAccountInfo(pool);
        if (poolAccountInfo) {
            logger.info(`[MintExtractor] AMM pool exists: dataLen=${poolAccountInfo.data.length}, lamports=${poolAccountInfo.lamports}`);
            if (poolAccountInfo.data.length >= 43) {
                // AMM Pool layout: coin_creator at offset 11 (32 bytes)
                const coinCreator = new PublicKey(poolAccountInfo.data.slice(11, 43));
                logger.info(`[MintExtractor] Got coin_creator from AMM: ${coinCreator.toString()}`);
                return { coinCreator, source: 'amm_pool' };
            } else {
                logger.info(`[MintExtractor] AMM pool data too short: ${poolAccountInfo.data.length} < 43`);
            }
        } else {
            logger.info(`[MintExtractor] AMM pool does not exist`);
        }
    } catch (e) {
        logger.info(`[MintExtractor] AMM fetch error: ${e.message}`);
    }

    logger.info(`[MintExtractor] ${mintStr.slice(0, 8)}... - No coin_creator found in BC or AMM`);
    return null;
}

/**
 * Check if coin_creator has fee sharing configured and if wallet is a shareholder
 *
 * When fee sharing is enabled on Pump.fun:
 * - The coin_creator field in bonding curve points to a FEE program account
 * - This FEE program account contains the SharingConfig with shareholders embedded in its data
 * - We need to parse the account data to find the shareholders array
 *
 * @param {PublicKey} coinCreator - The coin_creator from BC/AMM (could be original creator or FEE program account)
 * @param {PublicKey} walletKey - Wallet to check for in shareholders
 * @param {string} mint - Mint address (for logging)
 * @param {Object} connection - Solana connection
 * @returns {Promise<Object|null>} Fee recipient info or null
 */
async function checkFeeSharingConfig(coinCreator, walletKey, mint, connection) {
    try {
        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Checking fee sharing for coin_creator ${coinCreator.toString().slice(0, 8)}...`);

        // Fetch the coin_creator account to check what type it is
        const accountInfo = await connection.getAccountInfo(coinCreator);

        if (!accountInfo) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator account doesn't exist`);
            return null;
        }

        const owner = accountInfo.owner.toString();
        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator owner: ${owner}, dataLen: ${accountInfo.data.length}`);

        // Check if coin_creator is owned by FEE program - this means it's a creator_vault with SharingConfig
        if (accountInfo.owner.equals(PROGRAMS.FEE)) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator is a FEE program account, parsing SharingConfig...`);

            // Parse the FEE program account to find shareholders
            // The SharingConfig is embedded in the account data
            return parseFeeAccountSharingConfig(accountInfo.data, walletKey, mint);
        }

        // If coin_creator is owned by PUMP program, it might be a fee_sharing_config PDA directly
        if (accountInfo.owner.equals(PROGRAMS.PUMP)) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator is owned by PUMP, parsing as fee_sharing_config...`);
            return await parseAndCheckFeeSharingConfig(accountInfo.data, walletKey, mint, null);
        }

        // If coin_creator is owned by System Program, it's a regular wallet (no fee sharing)
        if (owner === '11111111111111111111111111111111') {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator is a regular wallet, no fee sharing`);
            return null;
        }

        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator owned by unknown program: ${owner}`);
        return null;

    } catch (e) {
        logger.error(`[MintExtractor] checkFeeSharingConfig error: ${e.message}`, { stack: e.stack });
        return null;
    }
}

/**
 * Parse FEE program account data to find SharingConfig shareholders
 *
 * The FEE program account (creator_vault) contains a SharingConfig with shareholders.
 * Based on Solscan data analysis, the structure appears to be:
 * - Account has a "sharingConfig" field containing:
 *   - creator: pubkey of original creator
 *   - shareholders: array of { pubkey, share_bps }
 *
 * We'll scan the account data for the shareholders structure.
 *
 * @param {Buffer} data - FEE program account data
 * @param {PublicKey} walletKey - Wallet to check for
 * @param {string} mint - Mint address (for logging)
 * @returns {Object|null} Fee recipient info or null
 */
function parseFeeAccountSharingConfig(data, walletKey, mint) {
    const walletBytes = walletKey.toBuffer();
    const dataLen = data.length;

    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Parsing FEE account SharingConfig (${dataLen} bytes)...`);

    // Log hex dump of first 120 bytes and key areas for debugging
    const hexDump = (offset, len) => {
        const slice = data.slice(offset, Math.min(offset + len, dataLen));
        return slice.toString('hex');
    };

    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Hex[0-8] discriminator: ${hexDump(0, 8)}`);
    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Hex[8-40] field1 (32b): ${hexDump(8, 32)}`);
    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Hex[72-80]: ${hexDump(72, 8)}`);
    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - u32 at offset 76: ${dataLen >= 80 ? data.readUInt32LE(76) : 'N/A'}`);

    // Check various u32 values at key offsets
    const checkOffsets = [76, 40, 41, 43, 44, 45, 73, 75, 77, 107, 109, 111];
    for (const off of checkOffsets) {
        if (off + 4 <= dataLen) {
            const val = data.readUInt32LE(off);
            if (val >= 1 && val <= 10) {
                logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Potential array length ${val} at offset ${off}`);
            }
        }
    }

    // FEE program creator_vault account structure (based on Anchor/Borsh):
    // - 8 bytes: discriminator
    // - 32 bytes: creator (original creator pubkey)
    // - 1 byte: bump
    // - 4 bytes: shareholders array length (u32 LE)
    // - N * 34 bytes: shareholders array entries
    //   Each entry: pubkey (32 bytes) + share_bps (2 bytes, u16 LE)

    // Try to find shareholders array by scanning for valid array length values
    // The array starts with a u32 length, then pubkey+bps entries

    // First, let's scan the data to find potential shareholders arrays
    // A valid shareholders array would have:
    // - A reasonable length (1-10 shareholders)
    // - Valid pubkeys and bps values

    // Common offsets where shareholders array might start:
    // FEE creator_vault structure (discovered from actual data):
    // - 8 bytes: discriminator
    // - 32 bytes: mint pubkey (8-40)
    // - 3 bytes: bump + padding (40-43)
    // - 32 bytes: original creator pubkey (43-75)
    // - 1 byte: unknown (75)
    // - 4 bytes: shareholders array length (at offset 76) <- CONFIRMED WORKING
    // - N * 34 bytes: shareholders entries (pubkey 32 + bps 2)
    //
    // Array at offset 76 confirmed to work for test token

    // Try to extract the original creator (at offset 43)
    let originalCreator = null;
    if (dataLen >= 75) {
        try {
            originalCreator = new PublicKey(data.slice(43, 75)).toString();
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Original creator from FEE account: ${originalCreator.slice(0, 8)}...`);
        } catch (e) {
            logger.debug(`[MintExtractor] ${mint.slice(0, 8)}... - Could not parse original creator at offset 43`);
        }
    }

    const shareholdersArrayOffsets = [76, 77, 75, 73, 45, 44, 43, 41, 40, 109, 107, 111];

    for (const arrayStartOffset of shareholdersArrayOffsets) {
        if (arrayStartOffset + 4 > dataLen) continue;

        const arrayLen = data.readUInt32LE(arrayStartOffset);

        // Valid shareholder counts are typically 1-10
        if (arrayLen < 1 || arrayLen > 10) continue;

        const entrySize = 34; // 32 bytes pubkey + 2 bytes bps
        const totalArrayDataSize = arrayLen * entrySize;

        // Check if array fits in remaining data
        if (arrayStartOffset + 4 + totalArrayDataSize > dataLen) continue;

        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Checking shareholders array at offset ${arrayStartOffset}, length ${arrayLen}`);

        // Parse each shareholder entry
        let foundOurWallet = false;
        let ourBps = 0;
        const shareholders = [];

        for (let i = 0; i < arrayLen; i++) {
            const entryOffset = arrayStartOffset + 4 + (i * entrySize);
            const pubkeyBytes = data.slice(entryOffset, entryOffset + 32);
            const bps = data.readUInt16LE(entryOffset + 32);

            // Validate bps is reasonable (0-10000)
            if (bps > 10000) {
                // Invalid array, break and try next offset
                break;
            }

            const pubkeyStr = new PublicKey(pubkeyBytes).toString();
            shareholders.push({ pubkey: pubkeyStr, bps });

            // Check if this is our wallet
            if (pubkeyBytes.equals(walletBytes)) {
                foundOurWallet = true;
                ourBps = bps;
                logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Found our wallet at shareholder index ${i} with ${bps} bps (${bps/100}%)`);
            }
        }

        // If we parsed all entries and total bps is valid (should sum to ~10000 or less)
        const totalBps = shareholders.reduce((sum, s) => sum + s.bps, 0);
        if (shareholders.length === arrayLen && totalBps > 0 && totalBps <= 10000) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Valid shareholders array found: ${shareholders.length} entries, total ${totalBps} bps`);

            if (foundOurWallet) {
                return {
                    isRecipient: true,
                    source: 'fee_sharing_config',
                    feeShareBps: ourBps,
                    feeSharePercent: ourBps / 100,
                    originalCreator: originalCreator,
                    allShareholders: shareholders
                };
            }
        }
    }

    // Fallback: scan all occurrences of our wallet in the data
    // Our wallet might appear multiple times (as creator and/or as shareholder)
    let searchOffset = 0;
    const walletOccurrences = [];

    while (searchOffset < dataLen - 32) {
        const idx = data.indexOf(walletBytes, searchOffset);
        if (idx === -1) break;
        walletOccurrences.push(idx);
        searchOffset = idx + 1;
    }

    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Found wallet at ${walletOccurrences.length} offsets: ${walletOccurrences.join(', ')}`);

    // For each occurrence, check if there's a valid bps value after it
    for (const offset of walletOccurrences) {
        if (offset + 34 <= dataLen) {
            const bps = data.readUInt16LE(offset + 32);
            if (bps > 0 && bps <= 10000) {
                logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Found valid BPS ${bps} (${bps/100}%) after wallet at offset ${offset}`);
                return {
                    isRecipient: true,
                    source: 'fee_sharing_config',
                    feeShareBps: bps,
                    feeSharePercent: bps / 100,
                    originalCreator: originalCreator
                };
            }
        }
    }

    // Scan the entire data for 9000 (0x2328) which is the expected 90% value
    // This helps us find where the shareholders data actually is
    for (let i = 0; i < dataLen - 2; i++) {
        const val = data.readUInt16LE(i);
        if (val === 9000) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Found 9000 bps at offset ${i}`);
            // Check if there's a pubkey before this
            if (i >= 32) {
                const pubkeyBytes = data.slice(i - 32, i);
                try {
                    const pubkey = new PublicKey(pubkeyBytes);
                    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Pubkey before 9000: ${pubkey.toString().slice(0, 8)}...`);
                    if (pubkeyBytes.equals(walletBytes)) {
                        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - This is our wallet with 9000 bps!`);
                        return {
                            isRecipient: true,
                            source: 'fee_sharing_config',
                            feeShareBps: 9000,
                            feeSharePercent: 90,
                            originalCreator: originalCreator
                        };
                    }
                } catch (e) {
                    // Not a valid pubkey
                }
            }
        }
    }

    // If wallet was found anywhere in the data but we couldn't parse bps, still mark as recipient
    if (walletOccurrences.length > 0) {
        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Wallet found in FEE account but couldn't parse BPS`);
        return {
            isRecipient: true,
            source: 'fee_sharing_config',
            feeShareBps: 0,
            feeSharePercent: 0,
            originalCreator: originalCreator
        };
    }

    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Our wallet not found in FEE account data`);
    return null;
}

/**
 * Parse fee_sharing_config data and check if wallet is a shareholder
 *
 * @param {Buffer} data - Account data
 * @param {PublicKey} walletKey - Wallet to check for
 * @param {string} mint - Mint address (for logging)
 * @param {string|null} originalCreator - Original creator if known
 * @returns {Object|null} Fee recipient info or null
 */
async function parseAndCheckFeeSharingConfig(data, walletKey, mint, originalCreator) {
    const dataLen = data.length;

    // Valid fee_sharing_config sizes: 78, 112, 146, 180, 214 (44 base + 34 per shareholder, 1-5 shareholders)
    if (dataLen < 78 || dataLen > 214) {
        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Invalid fee_sharing_config size: ${dataLen} (expected 78-214)`);
        return null;
    }

    // Parse the fee_sharing_config
    const config = parseFeeSharingConfig(data);

    if (!config || !config.shareholders || config.shareholders.length === 0) {
        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Failed to parse fee_sharing_config. Raw data (first 100 bytes): ${data.slice(0, 100).toString('hex')}`);
        return null;
    }

    // Log all shareholders found
    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Parsed fee_sharing_config successfully:`);
    logger.info(`[MintExtractor]   Creator: ${config.creator.toString()}`);
    logger.info(`[MintExtractor]   Shareholders (${config.shareholders.length}):`);
    for (const sh of config.shareholders) {
        logger.info(`[MintExtractor]     - ${sh.pubkey.toString()}: ${sh.shareBps} bps (${sh.shareBps / 100}%)`);
    }

    // Check if our wallet is in the shareholders list
    const walletStr = walletKey.toString();
    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Looking for our wallet: ${walletStr}`);

    for (const shareholder of config.shareholders) {
        if (shareholder.pubkey.toString() === walletStr) {
            const sharePercent = shareholder.shareBps / 100;
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - MATCH! We are a fee shareholder (${sharePercent}% = ${shareholder.shareBps} bps)`);
            return {
                isRecipient: true,
                source: 'fee_sharing_config',
                feeShareBps: shareholder.shareBps,
                feeSharePercent: sharePercent,
                originalCreator: originalCreator || config.creator?.toString() || null
            };
        }
    }

    // Config exists but we're not in shareholders
    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - fee_sharing_config found but our wallet is NOT in shareholders list`);
    return null;
}

/**
 * Filter an array of mints to only those where we are a fee recipient
 *
 * @param {Array<string>} mints - Array of mint addresses
 * @param {string} creatorPubkey - Creator wallet to verify
 * @param {Object} connection - Solana connection
 * @returns {Promise<Array<{mint: string, source: string}>>} - Filtered mints with source info
 */
async function filterMintsWeAreRecipientFor(mints, creatorPubkey, connection) {
    const verified = [];

    for (const mint of mints) {
        const result = await verifyFeeRecipient(mint, creatorPubkey, connection);
        if (result.isRecipient) {
            verified.push({ mint, source: result.source });
            logger.debug(`[MintExtractor] Verified ${mint.slice(0, 8)}... as fee recipient (${result.source})`);
        } else {
            logger.debug(`[MintExtractor] Rejected ${mint.slice(0, 8)}... - not a fee recipient`);
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 50));
    }

    logger.info(`[MintExtractor] Fee recipient verification: ${verified.length}/${mints.length} mints verified`);
    return verified;
}

module.exports = {
    // Core extraction functions
    extractMintFromTransaction,
    extractMintFromPumpTransaction,
    extractMintFromAmmTransaction,
    extractMintFromEnhancedTx,
    extractSourceAddress,
    matchesDiscriminator,

    // Vault scanning
    scanVaultForMints,
    scanCreatorVaultsForMints,
    resetVaultScanProgress,

    // Validation & Market Data
    validateMintsBatch,
    fetchDexScreenerData,

    // Fee recipient verification
    verifyFeeRecipient,
    filterMintsWeAreRecipientFor,
    getCoinCreator,
    checkFeeSharingConfig,
    getOriginalCreatorFromMetadata,

    // Fee sharing config parsing
    parseFeeSharingConfig,

    // Constants (for external use if needed)
    DISCRIMINATORS,
    KNOWN_PROGRAMS,
};
