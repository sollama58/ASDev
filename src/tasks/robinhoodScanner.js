/**
 * Robinhood Scanner Task
 * Detects external PumpFun tokens that share creator fees with our wallet
 * and tracks their holders for airdrop eligibility
 *
 * v12.0 - New feature for fee sharing partnerships
 */
const { PublicKey } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const config = require('../config/env');
const { PROGRAMS } = require('../config/constants');
const { logger, pump } = require('../services');

// Scanner state
let isScanning = false;
let websocketSubscription = null;

/**
 * Fee Sharing Config account structure (simplified)
 * The actual structure from PumpFun contains:
 * - creator: Pubkey (32 bytes)
 * - shareholders: Vec<Shareholder> where Shareholder is { pubkey: Pubkey, share_bps: u16 }
 */

/**
 * Parse fee sharing config account data
 * @param {Buffer} data - Raw account data
 * @returns {Object|null} Parsed config or null if invalid
 */
function parseFeeSharingConfig(data) {
    try {
        // Skip 8-byte discriminator
        if (data.length < 42) return null; // Minimum: 8 + 32 + 2 bytes

        const creator = new PublicKey(data.slice(8, 40));

        // Number of shareholders (4 bytes, little-endian)
        const shareholderCount = data.readUInt32LE(40);

        const shareholders = [];
        let offset = 44;

        for (let i = 0; i < shareholderCount && offset + 34 <= data.length; i++) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            const shareBps = data.readUInt16LE(offset + 32);
            shareholders.push({ pubkey, shareBps });
            offset += 34;
        }

        return { creator, shareholders };
    } catch (e) {
        logger.debug('Failed to parse fee sharing config', { error: e.message });
        return null;
    }
}

/**
 * Check if our wallet is a shareholder in a fee sharing config
 * @param {Object} config - Parsed fee sharing config
 * @param {PublicKey} ourWallet - Our dev wallet public key
 * @returns {Object|null} Shareholder info if we're included, null otherwise
 */
function findOurShare(config, ourWallet) {
    if (!config || !config.shareholders) return null;

    const ourWalletStr = ourWallet.toString();
    for (const sh of config.shareholders) {
        if (sh.pubkey.toString() === ourWalletStr) {
            return {
                shareBps: sh.shareBps,
                sharePercent: sh.shareBps / 100 // Convert basis points to percent
            };
        }
    }
    return null;
}

/**
 * Fetch token metadata from a mint address
 * Uses the bonding curve or pool to get basic info
 */
async function fetchTokenMetadata(connection, mint) {
    try {
        const mintPubkey = new PublicKey(mint);
        const pdas = pump.getPumpPDAs(mintPubkey);

        // Try to fetch bonding curve data
        const bcData = await connection.getAccountInfo(pdas.bondingCurve);
        if (!bcData) return null;

        // Parse basic bonding curve info (simplified)
        // Real structure has more fields, but we mainly need to confirm it exists
        const data = bcData.data;
        if (data.length < 72) return null;

        // Get creator from bonding curve (offset varies by program version)
        // For now we'll fetch metadata separately
        return {
            mint: mint,
            bondingCurve: pdas.bondingCurve.toString(),
            exists: true
        };
    } catch (e) {
        logger.debug(`Failed to fetch metadata for ${mint}`, { error: e.message });
        return null;
    }
}

/**
 * Scan for existing fee sharing configs that include our wallet
 * This runs periodically to catch any configs we might have missed
 */
async function scanForFeeSharingConfigs(deps) {
    const { connection, devKeypair, db } = deps;

    if (isScanning) return;
    isScanning = true;

    try {
        logger.info('[Robinhood] Scanning for fee sharing configs...');

        // Get all fee sharing config accounts from the Pump program
        // Filter by accounts that might contain our wallet
        const accounts = await connection.getProgramAccounts(PROGRAMS.PUMP, {
            filters: [
                // Fee sharing config discriminator (first 8 bytes)
                // This is an approximation - actual discriminator needs verification
                { dataSize: 200 }, // Approximate size for config with a few shareholders
            ]
        }).catch(() => []);

        // Also try larger accounts (more shareholders)
        const largerAccounts = await connection.getProgramAccounts(PROGRAMS.PUMP, {
            filters: [
                { dataSize: 300 },
            ]
        }).catch(() => []);

        const allAccounts = [...accounts, ...largerAccounts];
        let newTokensFound = 0;

        for (const account of allAccounts) {
            try {
                const config = parseFeeSharingConfig(account.account.data);
                if (!config) continue;

                const ourShare = findOurShare(config, devKeypair.publicKey);
                if (!ourShare) continue;

                // We found a config where we're a shareholder!
                const creatorStr = config.creator.toString();

                // Check if we already have this token
                const existing = await db.get(
                    'SELECT id FROM robinhood_tokens WHERE "creatorPubkey" = $1',
                    [creatorStr]
                );

                if (!existing) {
                    logger.info(`[Robinhood] Found new fee sharing: Creator ${creatorStr.slice(0, 8)}... | Our share: ${ourShare.sharePercent}%`);

                    // Insert new Robinhood token
                    await db.run(`
                        INSERT INTO robinhood_tokens ("creatorPubkey", "feeShareBps", "discoveredAt", "isActive")
                        VALUES ($1, $2, $3, 1)
                    `, [creatorStr, ourShare.shareBps, Date.now()]);

                    newTokensFound++;
                }
            } catch (e) {
                // Skip invalid accounts
            }
        }

        if (newTokensFound > 0) {
            logger.info(`[Robinhood] Discovered ${newTokensFound} new fee sharing partnerships`);
        }

        // Update metadata for existing Robinhood tokens
        await updateRobinhoodTokenMetadata(deps);

    } catch (e) {
        logger.error('[Robinhood] Scan error', { error: e.message });
    } finally {
        isScanning = false;
    }
}

/**
 * Update metadata for Robinhood tokens (ticker, name, market data)
 */
async function updateRobinhoodTokenMetadata(deps) {
    const { connection, db } = deps;

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1');

        for (const token of tokens) {
            try {
                // Skip if we don't have the mint yet
                if (!token.mint) continue;

                const mintPubkey = new PublicKey(token.mint);

                // Fetch market data from an external API if available
                // For now, just update timestamps
                await db.run(
                    'UPDATE robinhood_tokens SET volume24h = $1, "marketCap" = $2 WHERE id = $3',
                    [token.volume24h || 0, token.marketCap || 0, token.id]
                );
            } catch (e) {
                logger.debug(`[Robinhood] Failed to update metadata for ${token.mint || token.creatorPubkey}`, { error: e.message });
            }
        }
    } catch (e) {
        logger.error('[Robinhood] Metadata update error', { error: e.message });
    }
}

/**
 * Update holders for all active Robinhood tokens
 * Same logic as regular holder scanner but stores in robinhood_token_holders table
 */
async function updateRobinhoodHolders(deps) {
    const { connection, db, globalState } = deps;

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL');

        for (const token of tokens) {
            try {
                if (!token.mint) continue;

                const tokenMintPublicKey = new PublicKey(token.mint);
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
                    PROGRAMS.PUMP
                );

                const holdersToInsert = [];

                // Fetch token accounts
                const accounts = await connection.getProgramAccounts(PROGRAMS.TOKEN_2022, {
                    filters: [
                        { memcmp: { offset: 0, bytes: token.mint } }
                    ],
                    encoding: 'base64'
                }).catch(() => []);

                const parsedAccounts = accounts.map(acc => {
                    const data = Buffer.from(acc.account.data);
                    if (data.length < 72) return null;

                    const owner = new PublicKey(data.slice(32, 64)).toString();
                    const amount = new BN(data.slice(64, 72), 'le');
                    return { owner, amount };
                })
                    .filter(a => a !== null)
                    .sort((a, b) => b.amount.cmp(a.amount));

                const bondingCurvePDAStr = bondingCurvePDA.toString();
                const threshold = new BN(1000000);

                for (const acc of parsedAccounts) {
                    if (holdersToInsert.length >= 100) break;
                    if (acc.amount.lte(threshold)) continue;

                    // Skip bonding curve and known liquidity addresses
                    if (acc.owner !== bondingCurvePDAStr) {
                        holdersToInsert.push({ mint: token.mint, owner: acc.owner });
                    }
                }

                // Update database
                // v13.0: PostgreSQL doesn't use explicit transactions the same way
                try {
                    await db.run('DELETE FROM robinhood_token_holders WHERE mint = $1', [token.mint]);

                    if (holdersToInsert.length > 0) {
                        let rank = 1;
                        for (const h of holdersToInsert) {
                            await db.run(
                                'INSERT INTO robinhood_token_holders (mint, "holderPubkey", rank, "updatedAt") VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                                [h.mint, h.owner, rank, Date.now()]
                            );
                            rank++;
                        }
                    }
                } catch (err) {
                    throw err;
                }

                await new Promise(r => setTimeout(r, 1000)); // Rate limiting
            } catch (e) {
                logger.error(`[Robinhood] Holder scan error for ${token.mint}`, { error: e.message });
            }
        }
    } catch (e) {
        logger.error('[Robinhood] Holder update error', { error: e.message });
    }
}

/**
 * Subscribe to program account changes via WebSocket
 * This allows real-time detection of new fee sharing configs
 */
function setupWebSocketListener(deps) {
    const { connection, devKeypair, db } = deps;

    try {
        // Subscribe to Pump program account changes
        // Filter for fee sharing config accounts
        websocketSubscription = connection.onProgramAccountChange(
            PROGRAMS.PUMP,
            async (accountInfo, context) => {
                try {
                    const config = parseFeeSharingConfig(accountInfo.accountInfo.data);
                    if (!config) return;

                    const ourShare = findOurShare(config, devKeypair.publicKey);
                    if (!ourShare) return;

                    const creatorStr = config.creator.toString();

                    // Check if this is a new token
                    const existing = await db.get(
                        'SELECT id FROM robinhood_tokens WHERE "creatorPubkey" = $1',
                        [creatorStr]
                    );

                    if (!existing) {
                        logger.info(`[Robinhood] WebSocket: New fee sharing detected! Creator: ${creatorStr.slice(0, 8)}... | Share: ${ourShare.sharePercent}%`);

                        await db.run(`
                            INSERT INTO robinhood_tokens ("creatorPubkey", "feeShareBps", "discoveredAt", "isActive")
                            VALUES ($1, $2, $3, 1)
                        `, [creatorStr, ourShare.shareBps, Date.now()]);
                    }
                } catch (e) {
                    // Silent fail for invalid data
                }
            },
            'confirmed'
        );

        logger.info('[Robinhood] WebSocket listener active');
    } catch (e) {
        logger.error('[Robinhood] WebSocket setup failed', { error: e.message });
    }
}

/**
 * Get pending fees for all Robinhood tokens
 * Returns total fees across all tokens where we're a shareholder
 */
async function getRobinhoodPendingFees(deps) {
    const { connection, db, devKeypair } = deps;

    let totalPendingFees = new BN(0);
    const tokenFees = [];

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1');

        for (const token of tokens) {
            try {
                const creatorPubkey = new PublicKey(token.creatorPubkey);
                const { bcVault, ammVaultAta } = pump.getShareholderFeeVaults(creatorPubkey);

                let tokenFeeAmount = new BN(0);

                // Check BC vault
                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo && bcInfo.lamports > 0) {
                        // Our share of the fees
                        const ourShare = Math.floor(bcInfo.lamports * (token.feeShareBps / 10000));
                        tokenFeeAmount = tokenFeeAmount.add(new BN(ourShare));
                    }
                } catch (e) {
                    // Silent
                }

                // Check AMM vault
                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                    if (bal.value.amount && parseInt(bal.value.amount) > 0) {
                        const ourShare = Math.floor(parseInt(bal.value.amount) * (token.feeShareBps / 10000));
                        tokenFeeAmount = tokenFeeAmount.add(new BN(ourShare));
                    }
                } catch (e) {
                    // Silent
                }

                if (tokenFeeAmount.gt(new BN(0))) {
                    tokenFees.push({
                        mint: token.mint,
                        creator: token.creatorPubkey,
                        ticker: token.ticker,
                        pendingFees: tokenFeeAmount.toNumber(),
                        shareBps: token.feeShareBps
                    });
                    totalPendingFees = totalPendingFees.add(tokenFeeAmount);
                }
            } catch (e) {
                logger.debug(`[Robinhood] Fee check error for ${token.creatorPubkey}`, { error: e.message });
            }
        }
    } catch (e) {
        logger.error('[Robinhood] Get pending fees error', { error: e.message });
    }

    return { totalPendingFees, tokenFees };
}

/**
 * Main update function - runs periodically
 */
async function updateRobinhoodState(deps) {
    try {
        // Scan for new fee sharing configs
        await scanForFeeSharingConfigs(deps);

        // Update holders for existing Robinhood tokens
        await updateRobinhoodHolders(deps);

    } catch (e) {
        logger.error('[Robinhood] Update state error', { error: e.message });
    }
}

/**
 * Start the Robinhood scanner
 */
function start(deps) {
    // Initial scan after 10 seconds
    setTimeout(() => updateRobinhoodState(deps), 10000);

    // Run every 10 minutes (less frequent than main holder scanner)
    setInterval(() => updateRobinhoodState(deps), 10 * 60 * 1000);

    // Setup WebSocket listener for real-time detection
    setupWebSocketListener(deps);

    logger.info('[Robinhood] Scanner started');
}

/**
 * Stop the scanner and cleanup
 */
function stop(deps) {
    const { connection } = deps;

    if (websocketSubscription !== null) {
        connection.removeProgramAccountChangeListener(websocketSubscription);
        websocketSubscription = null;
    }

    logger.info('[Robinhood] Scanner stopped');
}

module.exports = {
    start,
    stop,
    updateRobinhoodState,
    updateRobinhoodHolders,
    getRobinhoodPendingFees,
    scanForFeeSharingConfigs,
    parseFeeSharingConfig,
    findOurShare,
};
