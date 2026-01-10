/**
 * Robinhood Scanner Task
 * Detects external PumpFun tokens that share creator fees with our wallet
 * and tracks their holders for airdrop eligibility
 *
 * v12.0 - New feature for fee sharing partnerships
 * v13.0 - Fixed to properly discover mints and scan creator vaults
 * v14.0 - Added vault transaction scanning for complete token discovery
 */
const { PublicKey } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const axios = require('axios');
const config = require('../config/env');
const { PROGRAMS, TOKENS } = require('../config/constants');
const { logger, pump, mutex, mintExtractor } = require('../services');

// RACE CONDITION FIX: Use mutex instead of boolean flag
const scannerMutex = mutex.getMutex('robinhood_scanner');
let websocketSubscription = null;

// Known fee sharing config discriminator (first 8 bytes)
// This identifies fee_sharing_config accounts in the Pump program
const FEE_SHARING_DISCRIMINATOR = Buffer.from([0x87, 0xc8, 0x18, 0x7b, 0x9b, 0x8a, 0x13, 0x05]);

/**
 * Parse fee sharing config account data
 * Structure:
 * - 8 bytes: discriminator
 * - 32 bytes: creator (original token creator)
 * - 32 bytes: mint (token mint address)
 * - 4 bytes: shareholder count
 * - N * 34 bytes: shareholders (32 byte pubkey + 2 byte bps)
 *
 * @param {Buffer} data - Raw account data
 * @returns {Object|null} Parsed config or null if invalid
 */
function parseFeeSharingConfig(data) {
    try {
        if (data.length < 76) return null; // Minimum: 8 + 32 + 32 + 4 bytes

        // Check discriminator
        const discriminator = data.slice(0, 8);
        // Skip discriminator check for now - we'll validate by structure

        const creator = new PublicKey(data.slice(8, 40));
        const mint = new PublicKey(data.slice(40, 72));

        // Number of shareholders (4 bytes, little-endian)
        const shareholderCount = data.readUInt32LE(72);

        // Sanity check - shouldn't have more than 10 shareholders
        if (shareholderCount > 10 || shareholderCount < 1) return null;

        const shareholders = [];
        let offset = 76;

        for (let i = 0; i < shareholderCount && offset + 34 <= data.length; i++) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            const shareBps = data.readUInt16LE(offset + 32);
            shareholders.push({ pubkey, shareBps });
            offset += 34;
        }

        return { creator, mint, shareholders };
    } catch (e) {
        return null;
    }
}

/**
 * Alternative parsing for fee sharing configs without mint in account
 * In this case, mint is derived from the PDA seed
 */
function parseFeeSharingConfigAlt(data, accountPubkey) {
    try {
        if (data.length < 44) return null;

        const creator = new PublicKey(data.slice(8, 40));
        const shareholderCount = data.readUInt32LE(40);

        if (shareholderCount > 10 || shareholderCount < 1) return null;

        const shareholders = [];
        let offset = 44;

        for (let i = 0; i < shareholderCount && offset + 34 <= data.length; i++) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            const shareBps = data.readUInt16LE(offset + 32);
            shareholders.push({ pubkey, shareBps });
            offset += 34;
        }

        return { creator, mint: null, shareholders, configPubkey: accountPubkey };
    } catch (e) {
        return null;
    }
}

/**
 * Check if our wallet is a shareholder in a fee sharing config
 */
function findOurShare(config, ourWallet) {
    if (!config || !config.shareholders) return null;

    const ourWalletStr = ourWallet.toString();
    for (const sh of config.shareholders) {
        if (sh.pubkey.toString() === ourWalletStr) {
            return {
                shareBps: sh.shareBps,
                sharePercent: sh.shareBps / 100  // BUG FIX: This is BPS so /100 gives percent (1000 bps = 10%)
            };
        }
    }
    return null;
}

/**
 * Fetch token metadata from Helius DAS API
 */
async function fetchHeliusMetadata(mint) {
    if (!config.HELIUS_API_KEY) {
        return null;
    }
    try {
        const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
            {
                jsonrpc: '2.0',
                id: '1',
                method: 'getAsset',
                params: { id: mint }
            },
            { timeout: 5000 }
        );
        const asset = response.data?.result;
        if (asset) {
            const metadata = asset.content?.metadata || {};
            const files = asset.content?.files || [];
            const imageFile = files.find(f => f.mime?.startsWith('image/')) || files[0];
            return {
                name: metadata.name || 'Unknown',
                ticker: metadata.symbol || 'UNKNOWN',
                image: imageFile?.cdn_uri || imageFile?.uri || asset.content?.links?.image || null,
                marketCap: 0, // Will be fetched from DexScreener
                creator: asset.creators?.[0]?.address || null
            };
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

/**
 * Fetch token metadata from DexScreener
 */
async function fetchDexScreenerMetadata(mint) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
            timeout: 5000
        });
        const pairs = response.data?.pairs || [];
        if (pairs.length > 0) {
            const pair = pairs[0];
            return {
                name: pair.baseToken?.name || 'Unknown',
                ticker: pair.baseToken?.symbol || 'UNKNOWN',
                image: pair.info?.imageUrl || null,
                marketCap: pair.fdv || pair.marketCap || 0,
                volume24h: pair.volume?.h24 || 0
            };
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

/**
 * Scan for tokens created by our wallet by checking vault transactions
 * This finds ALL tokens where we receive creator fees (both BC and AMM)
 *
 * v14.0 - Now properly scans vault transactions to discover mints
 * v14.1 - Uses market data from validateMintsBatch, updates existing tokens
 */
async function scanForOurCreatedTokens(deps) {
    const { connection, devKeypair, db } = deps;

    try {
        logger.info('[Robinhood] Scanning vault transactions for token discovery...');

        // Scan both bonding curve and AMM vaults
        const { foundMints, bcStats, ammStats } = await mintExtractor.scanCreatorVaultsForMints({
            creatorPubkey: devKeypair.publicKey,
            db,
            getCreatorFeeVaults: pump.getCreatorFeeVaults,
            saveProgress: true,
        });

        const totalTx = bcStats.txProcessed + ammStats.txProcessed;
        logger.info(`[Robinhood] Vault scan complete: ${totalTx} txs, ${foundMints.size} unique mints`);
        logger.debug(`[Robinhood] BC: ${bcStats.txProcessed} txs, ${bcStats.mintsFound} mints | AMM: ${ammStats.txProcessed} txs, ${ammStats.mintsFound} mints`);

        if (foundMints.size === 0) {
            return;
        }

        // Validate mints and get metadata + market data (DexScreener included)
        const validTokens = await mintExtractor.validateMintsBatch(Array.from(foundMints), { fetchMarketData: true });
        logger.info(`[Robinhood] Validated ${validTokens.length} tokens from vault transactions`);

        // Insert/update discovered tokens in database
        let newTokensInserted = 0;
        let tokensUpdated = 0;
        for (const token of validTokens) {
            try {
                // Check if already exists in tokens table
                const existingToken = await db.get('SELECT id, "marketCap", volume24h FROM tokens WHERE mint = $1', [token.mint]);

                if (!existingToken) {
                    // Insert new token with all metadata including market data
                    await db.run(`
                        INSERT INTO tokens ("userPubkey", mint, ticker, name, description, twitter, website, "metadataUri", image, "isMayhemMode", timestamp, volume24h, "priceUsd", "marketCap", complete)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    `, [
                        devKeypair.publicKey.toString(),
                        token.mint,
                        token.ticker,
                        token.name,
                        token.description || '',
                        token.twitter || '',
                        token.website || '',
                        token.metadataUri || '',
                        token.image || '',
                        0,
                        Date.now(),
                        token.volume24h || 0,
                        token.priceUsd || 0,
                        token.marketCap || 0,
                        0
                    ]);

                    newTokensInserted++;
                    logger.info(`[Robinhood] Discovered token: ${token.ticker} (${token.mint.slice(0, 8)}...) | MC: $${(token.marketCap || 0).toLocaleString()}`);
                } else {
                    // Update existing token with fresh market data if we have better data
                    const hasNewMarketData = (token.marketCap > 0 || token.volume24h > 0);
                    const existingHasNoData = (!existingToken.marketCap || existingToken.marketCap === 0) && (!existingToken.volume24h || existingToken.volume24h === 0);

                    if (hasNewMarketData || existingHasNoData) {
                        await db.run(`
                            UPDATE tokens SET
                                ticker = COALESCE(NULLIF($1, 'UNKNOWN'), ticker),
                                name = COALESCE(NULLIF($2, 'Unknown'), name),
                                image = COALESCE(NULLIF($3, ''), image),
                                volume24h = CASE WHEN $4 > 0 THEN $4 ELSE volume24h END,
                                "priceUsd" = CASE WHEN $5 > 0 THEN $5 ELSE "priceUsd" END,
                                "marketCap" = CASE WHEN $6 > 0 THEN $6 ELSE "marketCap" END
                            WHERE mint = $7
                        `, [
                            token.ticker,
                            token.name,
                            token.image || '',
                            token.volume24h || 0,
                            token.priceUsd || 0,
                            token.marketCap || 0,
                            token.mint
                        ]);
                        tokensUpdated++;
                    }
                }

            } catch (e) {
                logger.debug(`[Robinhood] Failed to process token ${token.mint}`, { error: e.message });
            }
        }

        if (newTokensInserted > 0) {
            logger.info(`[Robinhood] Inserted ${newTokensInserted} new tokens from vault scan`);
        }
        if (tokensUpdated > 0) {
            logger.info(`[Robinhood] Updated market data for ${tokensUpdated} existing tokens`);
        }

    } catch (e) {
        logger.error('[Robinhood] Error scanning vault transactions', { error: e.message });
    }
}

/**
 * Scan for fee sharing configs where our wallet is a shareholder
 * Uses getProgramAccounts with memcmp filter for our wallet
 */
async function scanForFeeSharingConfigs(deps) {
    const { connection, devKeypair, db } = deps;

    // RACE CONDITION FIX: Use mutex for atomic locking
    const release = await scannerMutex.tryAcquire();
    if (!release) {
        logger.debug('[Robinhood] Skipping scan - already in progress');
        return;
    }

    try {
        logger.info('[Robinhood] Scanning for fee sharing configs...');

        const ourWalletBytes = devKeypair.publicKey.toBuffer();
        let newTokensFound = 0;

        // Scan for accounts where we might be a shareholder
        // Fee sharing configs have variable sizes based on number of shareholders
        // We'll scan a range of sizes
        const sizes = [110, 144, 178, 212, 246]; // 76 base + 34 per shareholder (1-5 shareholders)

        for (const dataSize of sizes) {
            try {
                const accounts = await connection.getProgramAccounts(PROGRAMS.PUMP, {
                    filters: [
                        { dataSize },
                        // Filter for accounts containing our wallet pubkey
                        // This will catch us whether we're a shareholder or creator
                        { memcmp: { offset: 76, bytes: devKeypair.publicKey.toBase58() } }
                    ]
                }).catch(() => []);

                // Also try offset 110 (second shareholder position)
                const accounts2 = await connection.getProgramAccounts(PROGRAMS.PUMP, {
                    filters: [
                        { dataSize },
                        { memcmp: { offset: 110, bytes: devKeypair.publicKey.toBase58() } }
                    ]
                }).catch(() => []);

                const allAccounts = [...accounts, ...accounts2];

                for (const account of allAccounts) {
                    try {
                        // Try parsing with mint included
                        let config = parseFeeSharingConfig(account.account.data);

                        // If that fails, try alternative parsing
                        if (!config) {
                            config = parseFeeSharingConfigAlt(account.account.data, account.pubkey);
                        }

                        if (!config) continue;

                        const ourShare = findOurShare(config, devKeypair.publicKey);
                        if (!ourShare) continue;

                        const mintStr = config.mint ? config.mint.toString() : null;
                        const creatorStr = config.creator.toString();

                        // Skip if no mint found
                        if (!mintStr) {
                            logger.debug(`[Robinhood] Found config without mint for creator ${creatorStr.slice(0, 8)}...`);
                            continue;
                        }

                        // Check if we already have this token
                        const existing = await db.get(
                            'SELECT id FROM robinhood_tokens WHERE mint = $1',
                            [mintStr]
                        );

                        if (!existing) {
                            // Fetch metadata
                            const pumpMeta = await fetchHeliusMetadata(mintStr);
                            const dexMeta = await fetchDexScreenerMetadata(mintStr);

                            const metadata = {
                                name: pumpMeta?.name || dexMeta?.name || 'Unknown Token',
                                ticker: pumpMeta?.ticker || dexMeta?.ticker || 'UNKNOWN',
                                image: pumpMeta?.image || dexMeta?.image || null,
                                marketCap: dexMeta?.marketCap || pumpMeta?.marketCap || 0,
                                volume24h: dexMeta?.volume24h || 0
                            };

                            logger.info(`[Robinhood] Found new fee sharing: ${metadata.ticker} (${mintStr.slice(0, 8)}...) | Our share: ${ourShare.sharePercent}%`);

                            await db.run(`
                                INSERT INTO robinhood_tokens (mint, ticker, name, image, "creatorPubkey", "feeShareBps", "discoveredAt", "marketCap", volume24h, "isActive")
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
                                ON CONFLICT (mint) DO UPDATE SET
                                    ticker = EXCLUDED.ticker,
                                    name = EXCLUDED.name,
                                    image = COALESCE(EXCLUDED.image, robinhood_tokens.image),
                                    "feeShareBps" = EXCLUDED."feeShareBps"
                            `, [mintStr, metadata.ticker, metadata.name, metadata.image, creatorStr, ourShare.shareBps, Date.now(), metadata.marketCap, metadata.volume24h]);

                            newTokensFound++;
                        }
                    } catch (e) {
                        // Skip invalid accounts
                    }
                }

                // Small delay between size queries
                await new Promise(r => setTimeout(r, 500));

            } catch (e) {
                logger.debug(`[Robinhood] Error scanning size ${dataSize}`, { error: e.message });
            }
        }

        if (newTokensFound > 0) {
            logger.info(`[Robinhood] Discovered ${newTokensFound} new fee sharing partnerships`);
        } else {
            logger.debug('[Robinhood] No new fee sharing configs found');
        }

        // Update metadata for existing Robinhood tokens
        await updateRobinhoodTokenMetadata(deps);

    } catch (e) {
        logger.error('[Robinhood] Scan error', { error: e.message });
    } finally {
        // RACE CONDITION FIX: Release mutex
        await release();
    }
}

/**
 * Update metadata for Robinhood tokens (ticker, name, market data)
 */
async function updateRobinhoodTokenMetadata(deps) {
    const { db } = deps;

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL');

        for (const token of tokens) {
            try {
                // Fetch updated metadata
                const dexMeta = await fetchDexScreenerMetadata(token.mint);
                const pumpMeta = !dexMeta ? await fetchHeliusMetadata(token.mint) : null;

                const updates = {
                    volume24h: dexMeta?.volume24h || token.volume24h || 0,
                    marketCap: dexMeta?.marketCap || pumpMeta?.marketCap || token.marketCap || 0,
                    ticker: token.ticker || dexMeta?.ticker || pumpMeta?.ticker || 'UNKNOWN',
                    name: token.name || dexMeta?.name || pumpMeta?.name || 'Unknown Token',
                    image: token.image || dexMeta?.image || pumpMeta?.image || null
                };

                await db.run(
                    'UPDATE robinhood_tokens SET volume24h = $1, "marketCap" = $2, ticker = $3, name = $4, image = COALESCE($5, image) WHERE id = $6',
                    [updates.volume24h, updates.marketCap, updates.ticker, updates.name, updates.image, token.id]
                );

                // Rate limit API calls
                await new Promise(r => setTimeout(r, 300));

            } catch (e) {
                logger.debug(`[Robinhood] Failed to update metadata for ${token.mint}`, { error: e.message });
            }
        }
    } catch (e) {
        logger.error('[Robinhood] Metadata update error', { error: e.message });
    }
}

/**
 * Update holders for all active Robinhood tokens
 */
async function updateRobinhoodHolders(deps) {
    const { connection, db } = deps;

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
                    return { owner, amount, balance: amount.toString() };
                })
                    .filter(a => a !== null)
                    .sort((a, b) => b.amount.cmp(a.amount));

                const bondingCurvePDAStr = bondingCurvePDA.toString();
                const threshold = new BN(1000000);

                for (const acc of parsedAccounts) {
                    if (holdersToInsert.length >= 100) break;
                    if (acc.amount.lte(threshold)) continue;

                    if (acc.owner !== bondingCurvePDAStr) {
                        holdersToInsert.push({ mint: token.mint, owner: acc.owner, balance: acc.balance });
                    }
                }

                // Update database
                await db.run('DELETE FROM robinhood_token_holders WHERE mint = $1', [token.mint]);

                if (holdersToInsert.length > 0) {
                    let rank = 1;
                    for (const h of holdersToInsert) {
                        await db.run(
                            'INSERT INTO robinhood_token_holders (mint, "holderPubkey", balance, rank, "updatedAt") VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
                            [h.mint, h.owner, h.balance, rank, Date.now()]
                        );
                        rank++;
                    }
                }

                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                logger.error(`[Robinhood] Holder scan error for ${token.mint}`, { error: e.message });
            }
        }
    } catch (e) {
        logger.error('[Robinhood] Holder update error', { error: e.message });
    }
}

/**
 * Get pending fees for all Robinhood tokens
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

                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo && bcInfo.lamports > 0) {
                        const ourShare = Math.floor(bcInfo.lamports * (token.feeShareBps / 10000));
                        tokenFeeAmount = tokenFeeAmount.add(new BN(ourShare));
                    }
                } catch (e) { /* Silent */ }

                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                    if (bal.value.amount && parseInt(bal.value.amount) > 0) {
                        const ourShare = Math.floor(parseInt(bal.value.amount) * (token.feeShareBps / 10000));
                        tokenFeeAmount = tokenFeeAmount.add(new BN(ourShare));
                    }
                } catch (e) { /* Silent */ }

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
        // v14.0: Scan vault transactions for token discovery
        // This finds ALL tokens where we receive fees (from both BC and AMM)
        await scanForOurCreatedTokens(deps);

        // Scan for new fee sharing configs (Robinhood partnerships)
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

    // Run every 10 minutes
    setInterval(() => updateRobinhoodState(deps), 10 * 60 * 1000);

    logger.info('[Robinhood] Scanner started');
}

/**
 * Stop the scanner
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
    fetchHeliusMetadata,
    fetchDexScreenerMetadata,
};
