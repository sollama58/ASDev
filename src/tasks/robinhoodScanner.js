/**
 * Robinhood Scanner Task
 * Tracks external PumpFun tokens that share creator fees with our wallet
 * and updates their holders for airdrop eligibility
 *
 * v16.0 - Simplified: Tokens are registered via API with on-chain verification
 *         This scanner only handles: metadata updates, holder tracking
 *         Fee verification happens at registration time via mintExtractor.verifyFeeRecipient()
 */
const { PublicKey } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const axios = require('axios');
const config = require('../config/env');
const { PROGRAMS } = require('../config/constants');
const { logger, pump, mutex, mintExtractor } = require('../services');

// RACE CONDITION FIX: Use mutex instead of boolean flag
const scannerMutex = mutex.getMutex('robinhood_scanner');
let websocketSubscription = null;

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
 * NOTE: The fee_sharing_config does NOT store the mint.
 * When fee sharing is enabled, the coin_creator field in BC/AMM
 * IS set to the fee_sharing_config PDA itself.
 *
 * @param {Buffer} data - Raw account data
 * @param {PublicKey} [accountPubkey] - Optional: The account's public key
 * @returns {Object|null} Parsed config or null if invalid
 */
function parseFeeSharingConfig(data, accountPubkey = null) {
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
 * Re-verify fee share status for all active Robinhood tokens
 * This catches cases where fee sharing config has been updated on-chain
 */
async function reverifyRobinhoodTokens(deps) {
    const { connection, devKeypair, db } = deps;

    // RACE CONDITION FIX: Use mutex for atomic locking
    const release = await scannerMutex.tryAcquire();
    if (!release) {
        logger.debug('[Robinhood] Skipping reverify - already in progress');
        return;
    }

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL');

        if (tokens.length === 0) {
            return;
        }

        logger.info(`[Robinhood] Re-verifying ${tokens.length} tokens...`);

        for (const token of tokens) {
            try {
                // Re-verify on-chain fee recipient status
                const result = await mintExtractor.verifyFeeRecipient(
                    token.mint,
                    devKeypair.publicKey.toString(),
                    connection
                );

                if (!result.isRecipient) {
                    // We're no longer a fee recipient - deactivate token
                    logger.warn(`[Robinhood] ${token.ticker} (${token.mint.slice(0, 8)}...) - No longer a fee recipient, deactivating`);
                    await db.run('UPDATE robinhood_tokens SET "isActive" = 0 WHERE id = $1', [token.id]);
                } else if (result.feeShareBps !== token.feeShareBps) {
                    // Fee share changed - update it
                    logger.info(`[Robinhood] ${token.ticker} - Fee share changed: ${token.feeShareBps} -> ${result.feeShareBps} bps`);
                    await db.run('UPDATE robinhood_tokens SET "feeShareBps" = $1 WHERE id = $2', [result.feeShareBps, token.id]);
                }

                // Rate limit
                await new Promise(r => setTimeout(r, 100));

            } catch (e) {
                logger.debug(`[Robinhood] Reverify error for ${token.mint}`, { error: e.message });
            }
        }

        // Update metadata for active tokens
        await updateRobinhoodTokenMetadata(deps);

    } catch (e) {
        logger.error('[Robinhood] Reverify error', { error: e.message });
    } finally {
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

                // Fetch token accounts from both Token Program and Token-2022
                // Most Pump.fun tokens use regular Token Program, but some may use Token-2022
                const [tokenAccounts, token2022Accounts] = await Promise.all([
                    connection.getProgramAccounts(PROGRAMS.TOKEN, {
                        filters: [{ memcmp: { offset: 0, bytes: token.mint } }],
                        encoding: 'base64'
                    }).catch(() => []),
                    connection.getProgramAccounts(PROGRAMS.TOKEN_2022, {
                        filters: [{ memcmp: { offset: 0, bytes: token.mint } }],
                        encoding: 'base64'
                    }).catch(() => [])
                ]);

                const accounts = [...tokenAccounts, ...token2022Accounts];

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
    const { connection, db } = deps;

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
 * Update market data for all registered tokens
 * v15.0 - Fetches fresh market data from DexScreener for existing tokens
 */
async function updateRegisteredTokensMarketData(deps) {
    const { db } = deps;

    try {
        // Get all registered tokens
        const tokens = await db.all('SELECT mint, ticker FROM tokens WHERE mint IS NOT NULL');

        if (tokens.length === 0) return;

        let tokensUpdated = 0;
        for (const token of tokens) {
            try {
                const dexMeta = await fetchDexScreenerMetadata(token.mint);
                if (dexMeta && (dexMeta.marketCap > 0 || dexMeta.volume24h > 0)) {
                    await db.run(`
                        UPDATE tokens SET
                            ticker = COALESCE(NULLIF($1, 'UNKNOWN'), ticker),
                            name = COALESCE(NULLIF($2, 'Unknown'), name),
                            image = COALESCE(NULLIF($3, ''), image),
                            volume24h = CASE WHEN $4 > 0 THEN $4 ELSE volume24h END,
                            "marketCap" = CASE WHEN $5 > 0 THEN $5 ELSE "marketCap" END
                        WHERE mint = $6
                    `, [
                        dexMeta.ticker || 'UNKNOWN',
                        dexMeta.name || 'Unknown',
                        dexMeta.image || '',
                        dexMeta.volume24h || 0,
                        dexMeta.marketCap || 0,
                        token.mint
                    ]);
                    tokensUpdated++;
                }

                // Rate limit API calls
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                logger.debug(`[Robinhood] Failed to update market data for ${token.mint}`, { error: e.message });
            }
        }

        if (tokensUpdated > 0) {
            logger.debug(`[Robinhood] Updated market data for ${tokensUpdated} registered tokens`);
        }
    } catch (e) {
        logger.error('[Robinhood] Market data update error', { error: e.message });
    }
}

/**
 * Main update function - runs periodically
 * v16.0: Tokens are registered via API with on-chain verification
 *        Scanner only handles: re-verification, metadata updates, holder tracking
 */
async function updateRobinhoodState(deps) {
    try {
        // Update market data for registered tokens (main tokens table)
        await updateRegisteredTokensMarketData(deps);

        // Re-verify fee share status and update metadata for Robinhood tokens
        // This catches on-chain changes to fee sharing configs
        await reverifyRobinhoodTokens(deps);

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
    updateRegisteredTokensMarketData,
    getRobinhoodPendingFees,
    reverifyRobinhoodTokens,
    parseFeeSharingConfig,
    findOurShare,
    fetchHeliusMetadata,
    fetchDexScreenerMetadata,
};
