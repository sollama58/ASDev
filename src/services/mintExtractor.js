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
                for (const asset of assets) {
                    if (asset && asset.id && (asset.interface === 'FungibleToken' || asset.interface === 'FungibleAsset')) {
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
                            await new Promise(r => setTimeout(r, 150));
                        }

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
    // still add them with minimal data so they're tracked
    const stillMissing = mintArray.filter(m => !processedMints.has(m));
    if (stillMissing.length > 0) {
        logger.debug(`[MintExtractor] ${stillMissing.length} mints not found in any source, adding with minimal data`);

        for (const mint of stillMissing) {
            // Only add if it looks like a valid Pump.fun token (ends in "pump")
            if (mint.toLowerCase().endsWith('pump')) {
                validTokens.push({
                    mint,
                    name: 'Unknown Token',
                    ticker: 'UNKNOWN',
                    description: '',
                    image: null,
                    metadataUri: null,
                    twitter: '',
                    website: '',
                    creator: null,
                    marketCap: 0,
                    volume24h: 0,
                    priceUsd: 0,
                });
            }
        }
    }

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
 * Check if coin_creator is a fee_sharing_config and if wallet is a shareholder
 *
 * When fee sharing is enabled via create_fee_sharing_config, the coin_creator field
 * in BC/AMM is set to the fee_sharing_config PDA itself.
 *
 * @param {PublicKey} coinCreator - The coin_creator from BC/AMM
 * @param {PublicKey} walletKey - Wallet to check for
 * @param {string} mint - Mint address (for logging)
 * @param {Object} connection - Solana connection
 * @returns {Promise<Object|null>} Fee recipient info or null
 */
async function checkFeeSharingConfig(coinCreator, walletKey, mint, connection) {
    try {
        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Checking if coin_creator ${coinCreator.toString().slice(0, 8)}... is a fee_sharing_config`);

        const accountInfo = await connection.getAccountInfo(coinCreator);

        if (!accountInfo) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator account doesn't exist on-chain`);
            return null;
        }

        const owner = accountInfo.owner.toString();
        const dataLen = accountInfo.data.length;
        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator account: owner=${owner}, dataLen=${dataLen}`);

        // Case 1: coin_creator is owned by PUMP program - it IS the fee_sharing_config PDA
        if (accountInfo.owner.equals(PROGRAMS.PUMP)) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator is owned by PUMP, checking if it's a fee_sharing_config...`);
            return await parseAndCheckFeeSharingConfig(accountInfo.data, walletKey, mint, null);
        }

        // Case 2: coin_creator is owned by FEE program (pfee...) - it's a creator_vault account
        // We need to extract the original creator and derive the fee_sharing_config PDA from it
        if (accountInfo.owner.equals(PROGRAMS.FEE)) {
            logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator is owned by FEE program, extracting original creator...`);

            // FEE program account structure (creator_vault):
            // - 8 bytes: discriminator
            // - 1 byte: bump
            // - 2 bytes: flags or padding
            // - 32 bytes: original creator pubkey (at offset 11)
            if (dataLen >= 43) {
                const originalCreator = new PublicKey(accountInfo.data.slice(11, 43));
                logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Original creator from FEE account: ${originalCreator.toString()}`);

                // Derive the fee_sharing_config PDA from the original creator
                const [feeSharingConfigPDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("fee_sharing_config"), originalCreator.toBuffer()],
                    PROGRAMS.PUMP
                );
                logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Derived fee_sharing_config PDA: ${feeSharingConfigPDA.toString()}`);

                // Fetch the fee_sharing_config
                const configAccountInfo = await connection.getAccountInfo(feeSharingConfigPDA);

                if (!configAccountInfo) {
                    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - fee_sharing_config PDA does not exist`);
                    return null;
                }

                if (!configAccountInfo.owner.equals(PROGRAMS.PUMP)) {
                    logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - fee_sharing_config PDA not owned by PUMP: ${configAccountInfo.owner.toString()}`);
                    return null;
                }

                logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - Found fee_sharing_config, parsing...`);
                return await parseAndCheckFeeSharingConfig(configAccountInfo.data, walletKey, mint, originalCreator.toString());
            } else {
                logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - FEE account data too short: ${dataLen} < 43`);
            }
        }

        // Case 3: coin_creator is owned by something else (e.g., System Program = regular wallet)
        logger.info(`[MintExtractor] ${mint.slice(0, 8)}... - coin_creator not owned by PUMP or FEE program. Owner: ${owner}`);
        return null;

    } catch (e) {
        logger.error(`[MintExtractor] checkFeeSharingConfig error: ${e.message}`, { stack: e.stack });
        return null;
    }
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

    // Fee sharing config parsing
    parseFeeSharingConfig,

    // Constants (for external use if needed)
    DISCRIMINATORS,
    KNOWN_PROGRAMS,
};
