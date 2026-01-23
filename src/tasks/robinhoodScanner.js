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
const { logger, pump, mutex, mintExtractor, imageUtils } = require('../services');

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
            return {
                name: metadata.name || 'Unknown',
                ticker: metadata.symbol || 'UNKNOWN',
                image: imageUtils.extractHeliusImage(asset),
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
 * Fetch token metadata from GeckoTerminal API
 * Free API with 30 requests/minute rate limit
 * Good for images when DexScreener doesn't have them
 */
async function fetchGeckoTerminalMetadata(mint) {
    try {
        // GeckoTerminal uses "solana" as the network identifier
        const response = await axios.get(
            `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`,
            {
                timeout: 5000,
                headers: {
                    'Accept': 'application/json'
                }
            }
        );

        const tokenData = response.data?.data?.attributes;
        if (tokenData) {
            return {
                name: tokenData.name || null,
                ticker: tokenData.symbol || null,
                image: tokenData.image_url || null,
                marketCap: parseFloat(tokenData.fdv_usd) || 0,
                volume24h: parseFloat(tokenData.volume_usd?.h24) || 0,
                priceUsd: parseFloat(tokenData.price_usd) || 0
            };
        }
    } catch (e) {
        // Silent fail - GeckoTerminal may not have all tokens
        logger.debug(`[GeckoTerminal] Failed to fetch ${mint?.slice(0, 8)}...`, { error: e.message });
    }
    return null;
}

/**
 * Fetch token info (including image) from GeckoTerminal's /info endpoint
 * This endpoint specifically returns token metadata like images, descriptions, and socials
 */
async function fetchGeckoTerminalTokenInfo(mint) {
    try {
        const response = await axios.get(
            `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/info`,
            {
                timeout: 5000,
                headers: {
                    'Accept': 'application/json'
                }
            }
        );

        const tokenData = response.data?.data?.attributes;
        if (tokenData) {
            return {
                name: tokenData.name || null,
                ticker: tokenData.symbol || null,
                image: tokenData.image_url || null,
                description: tokenData.description || null,
                websites: tokenData.websites || [],
                twitter: tokenData.twitter_handle || null,
                telegram: tokenData.telegram_handle || null,
                discord: tokenData.discord_url || null
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
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL LIMIT 500');

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
 * Fetch token metadata from Pump.fun API
 */
async function fetchPumpFunMetadata(mint) {
    try {
        const response = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, {
            timeout: 5000
        });
        if (response.data) {
            const data = response.data;
            return {
                name: data.name || null,
                ticker: data.symbol || null,
                image: data.image_uri || data.image || null,
                marketCap: data.usd_market_cap || 0,
                creator: data.creator || null
            };
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

/**
 * Update metadata for Robinhood tokens (ticker, name, market data)
 * Fetches from multiple sources with fallback chain:
 * DexScreener -> GeckoTerminal -> Helius -> Pump.fun API
 * v25.64: Added better logging for debugging, always fetch market data
 */
async function updateRobinhoodTokenMetadata(deps) {
    const { db } = deps;

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL LIMIT 500');

        if (tokens.length === 0) {
            logger.debug('[Robinhood] No active tokens to update metadata for');
            return;
        }

        logger.info(`[Robinhood] Updating metadata for ${tokens.length} tokens...`);
        let tokensWithVolume = 0;
        let tokensUpdated = 0;

        for (const token of tokens) {
            try {
                // v25.64: ALWAYS fetch DexScreener data for market stats (volume, marketcap)
                // This is critical for points eligibility (requires volume24h >= $100)
                const dexMeta = await fetchDexScreenerMetadata(token.mint);

                // If token is missing metadata (image/name/ticker), try other sources
                // Note: Check for both null/undefined AND empty string for image
                const needsMetadata = !token.image || token.image === '' || token.ticker === 'UNKNOWN' || token.name === 'Unknown Token';
                const needsImage = !token.image || token.image === '' || !dexMeta?.image;

                let geckoMeta = null;
                let heliusMeta = null;
                let pumpMeta = null;

                // Try GeckoTerminal if we need an image or DexScreener failed
                if (needsImage) {
                    geckoMeta = await fetchGeckoTerminalMetadata(token.mint);
                    // If GeckoTerminal doesn't have the image, try the /info endpoint
                    if (!geckoMeta?.image) {
                        const geckoInfo = await fetchGeckoTerminalTokenInfo(token.mint);
                        if (geckoInfo?.image) {
                            geckoMeta = geckoMeta || {};
                            geckoMeta.image = geckoInfo.image;
                        }
                    }
                }

                // Try Helius and Pump.fun if we still need metadata
                if (needsMetadata && !geckoMeta?.image) {
                    heliusMeta = await fetchHeliusMetadata(token.mint);
                    if (!heliusMeta?.image) {
                        pumpMeta = await fetchPumpFunMetadata(token.mint);
                    }
                }

                // Build updates with best available data
                // For market data: prefer DexScreener (most accurate for trading)
                // For metadata (name/ticker/image): use first non-null source
                const updates = {
                    volume24h: dexMeta?.volume24h || geckoMeta?.volume24h || token.volume24h || 0,
                    marketCap: dexMeta?.marketCap || geckoMeta?.marketCap || pumpMeta?.marketCap || heliusMeta?.marketCap || token.marketCap || 0,
                    ticker: dexMeta?.ticker || geckoMeta?.ticker || heliusMeta?.ticker || pumpMeta?.ticker || token.ticker || 'UNKNOWN',
                    name: dexMeta?.name || geckoMeta?.name || heliusMeta?.name || pumpMeta?.name || token.name || 'Unknown Token',
                    image: dexMeta?.image || geckoMeta?.image || heliusMeta?.image || pumpMeta?.image || token.image || null
                };

                // Track volume stats
                if (updates.volume24h >= 100) {
                    tokensWithVolume++;
                }

                // v25.64: Always update if we have new volume/marketcap data, even if same value
                // This ensures the data is always fresh from the source
                const hasNewMarketData = dexMeta?.volume24h !== undefined || dexMeta?.marketCap !== undefined;
                const hasChanges = hasNewMarketData ||
                                   updates.volume24h !== token.volume24h ||
                                   updates.marketCap !== token.marketCap ||
                                   updates.ticker !== token.ticker ||
                                   updates.name !== token.name ||
                                   (updates.image && updates.image !== token.image);

                if (hasChanges) {
                    // FIX: Use NULLIF to convert empty string to NULL, so COALESCE preserves existing image
                    // This prevents empty strings from APIs overwriting valid images
                    await db.run(
                        'UPDATE robinhood_tokens SET volume24h = $1, "marketCap" = $2, ticker = $3, name = $4, image = COALESCE(NULLIF($5, \'\'), image) WHERE id = $6',
                        [updates.volume24h, updates.marketCap, updates.ticker, updates.name, updates.image, token.id]
                    );
                    tokensUpdated++;

                    if (updates.image && !token.image) {
                        const source = dexMeta?.image ? 'DexScreener' :
                                      geckoMeta?.image ? 'GeckoTerminal' :
                                      heliusMeta?.image ? 'Helius' :
                                      pumpMeta?.image ? 'Pump.fun' : 'unknown';
                        logger.info(`[Robinhood] Updated image for ${token.ticker || token.mint.slice(0, 8)} from ${source}`);
                    }
                }

                // Rate limit API calls (slightly increased due to more API calls)
                await new Promise(r => setTimeout(r, 350));

            } catch (e) {
                logger.debug(`[Robinhood] Failed to update metadata for ${token.mint}`, { error: e.message });
            }
        }

        logger.info(`[Robinhood] Metadata update complete: ${tokensUpdated} updated, ${tokensWithVolume} have volume >= $100`);
    } catch (e) {
        logger.error('[Robinhood] Metadata update error', { error: e.message });
    }
}

/**
 * Update holders for all active Robinhood tokens
 * v25.64: Fixed to track 250 holders (matching platform tokens) and use batch inserts
 * v25.65: Critical bugfix - don't delete holders on RPC failure, better error handling
 */
async function updateRobinhoodHolders(deps) {
    const { connection, db } = deps;
    const TOP_HOLDERS_LIMIT = 250; // v25.64: Match platform token holder limit

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL LIMIT 500');

        if (tokens.length === 0) {
            logger.debug('[Robinhood] No active tokens to scan for holders');
            return;
        }

        logger.info(`[Robinhood] Scanning holders for ${tokens.length} active tokens...`);
        let totalHoldersUpdated = 0;
        let tokensWithHolders = 0;
        let tokensSkippedRpcFail = 0;

        for (const token of tokens) {
            try {
                if (!token.mint) continue;

                const tokenMintPublicKey = new PublicKey(token.mint);
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
                    PROGRAMS.PUMP
                );

                const holdersToInsert = [];

                // v25.65: Track RPC failures separately from empty results
                let rpcFailed = false;
                let tokenAccounts = [];
                let token2022Accounts = [];

                // Fetch token accounts from both Token Program and Token-2022
                // Most Pump.fun tokens use regular Token Program, but some may use Token-2022
                try {
                    [tokenAccounts, token2022Accounts] = await Promise.all([
                        connection.getProgramAccounts(PROGRAMS.TOKEN, {
                            filters: [{ memcmp: { offset: 0, bytes: token.mint } }],
                            encoding: 'base64'
                        }),
                        connection.getProgramAccounts(PROGRAMS.TOKEN_2022, {
                            filters: [{ memcmp: { offset: 0, bytes: token.mint } }],
                            encoding: 'base64'
                        })
                    ]);
                } catch (rpcError) {
                    // v25.65: Log RPC failures and skip this token (preserve existing holders)
                    logger.warn(`[Robinhood] RPC failed for ${token.ticker || token.mint.slice(0, 8)}: ${rpcError.message}`);
                    rpcFailed = true;
                    tokensSkippedRpcFail++;
                }

                // v25.65: Skip this token if RPC failed - don't delete existing holders
                if (rpcFailed) {
                    await new Promise(r => setTimeout(r, 500)); // Shorter delay before retry
                    continue;
                }

                const accounts = [...tokenAccounts, ...token2022Accounts];

                // v25.65: Handle both Buffer and base64 array tuple formats from RPC
                const parsedAccounts = accounts.map(acc => {
                    try {
                        // Handle both formats: direct Buffer or [base64String, 'base64'] tuple
                        const data = Array.isArray(acc.account.data)
                            ? Buffer.from(acc.account.data[0], 'base64')
                            : Buffer.from(acc.account.data);

                        if (data.length < 72) return null;

                        const owner = new PublicKey(data.slice(32, 64)).toString();
                        const amount = new BN(data.slice(64, 72), 'le');
                        return { owner, amount, balance: amount.toString() };
                    } catch (parseErr) {
                        return null;
                    }
                })
                    .filter(a => a !== null)
                    .sort((a, b) => b.amount.cmp(a.amount));

                const bondingCurvePDAStr = bondingCurvePDA.toString();
                const threshold = new BN(1000000);

                for (const acc of parsedAccounts) {
                    // v25.64: Track up to 250 holders (was 100)
                    if (holdersToInsert.length >= TOP_HOLDERS_LIMIT) break;
                    if (acc.amount.lte(threshold)) continue;

                    if (acc.owner !== bondingCurvePDAStr) {
                        holdersToInsert.push({ mint: token.mint, owner: acc.owner, balance: acc.balance });
                    }
                }

                // v25.65: Only update database if we got holders OR this is a known empty token
                // Don't delete existing holders if RPC returned 0 results (could be indexing delay)
                const existingHolders = await db.get(
                    'SELECT COUNT(*) as count FROM robinhood_token_holders WHERE mint = $1',
                    [token.mint]
                );
                const hadExistingHolders = (existingHolders?.count || 0) > 0;

                // If we got holders from RPC, update the database
                if (holdersToInsert.length > 0) {
                    // DELETE then batch INSERT
                    await db.run('DELETE FROM robinhood_token_holders WHERE mint = $1', [token.mint]);

                    const BATCH_SIZE = 50;
                    const now = Date.now();

                    for (let i = 0; i < holdersToInsert.length; i += BATCH_SIZE) {
                        const batch = holdersToInsert.slice(i, i + BATCH_SIZE);
                        const placeholders = batch.map((_, idx) => {
                            const baseIdx = idx * 5;
                            return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5})`;
                        }).join(', ');

                        const params = batch.flatMap((h, idx) => [
                            h.mint,
                            h.owner,
                            h.balance,
                            i + idx + 1,  // rank
                            now
                        ]);

                        await db.run(`
                            INSERT INTO robinhood_token_holders (mint, "holderPubkey", balance, rank, "updatedAt")
                            VALUES ${placeholders}
                            ON CONFLICT (mint, "holderPubkey") DO UPDATE SET
                                balance = EXCLUDED.balance,
                                rank = EXCLUDED.rank,
                                "updatedAt" = EXCLUDED."updatedAt"
                        `, params);
                    }

                    totalHoldersUpdated += holdersToInsert.length;
                    tokensWithHolders++;
                } else if (!hadExistingHolders) {
                    // v25.65: New token with no holders yet - this is normal, log for visibility
                    logger.debug(`[Robinhood] ${token.ticker || token.mint.slice(0, 8)} has no holders yet (new token or not indexed)`);
                } else {
                    // v25.65: Token had holders but RPC returned 0 - preserve existing, log warning
                    logger.warn(`[Robinhood] ${token.ticker || token.mint.slice(0, 8)} RPC returned 0 holders but had ${existingHolders.count} - preserving existing`);
                }

                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                logger.error(`[Robinhood] Holder scan error for ${token.mint}`, { error: e.message });
            }
        }

        logger.info(`[Robinhood] Holder scan complete: ${totalHoldersUpdated} holders across ${tokensWithHolders}/${tokens.length} tokens (${tokensSkippedRpcFail} skipped due to RPC failure)`);
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
        // v25.14 SCALABILITY: Limit to 500 tokens
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 LIMIT 500');

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
                        dexMeta.image || null,  // FIX: Pass null instead of empty string to let NULLIF work correctly
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

/**
 * v25.65: Scan holders for a single token immediately
 * Called after new Robinhood token registration to populate holder data right away
 * instead of waiting for the next scheduled scan (up to 10 minutes)
 *
 * @param {Object} deps - Dependencies (connection, db)
 * @param {string} mint - Token mint address
 * @param {string} [ticker] - Optional ticker for logging
 * @returns {Promise<{success: boolean, holdersCount: number}>}
 */
async function scanSingleTokenHolders(deps, mint, ticker = null) {
    const { connection, db } = deps;
    const TOP_HOLDERS_LIMIT = 250;

    try {
        if (!mint) {
            return { success: false, holdersCount: 0, error: 'No mint provided' };
        }

        const tokenMintPublicKey = new PublicKey(mint);
        const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
            PROGRAMS.PUMP
        );

        const holdersToInsert = [];
        let tokenAccounts = [];
        let token2022Accounts = [];

        // Fetch token accounts from both Token Program and Token-2022
        try {
            [tokenAccounts, token2022Accounts] = await Promise.all([
                connection.getProgramAccounts(PROGRAMS.TOKEN, {
                    filters: [{ memcmp: { offset: 0, bytes: mint } }],
                    encoding: 'base64'
                }),
                connection.getProgramAccounts(PROGRAMS.TOKEN_2022, {
                    filters: [{ memcmp: { offset: 0, bytes: mint } }],
                    encoding: 'base64'
                })
            ]);
        } catch (rpcError) {
            logger.warn(`[Robinhood] Immediate scan RPC failed for ${ticker || mint.slice(0, 8)}: ${rpcError.message}`);
            return { success: false, holdersCount: 0, error: rpcError.message };
        }

        const accounts = [...tokenAccounts, ...token2022Accounts];

        const parsedAccounts = accounts.map(acc => {
            try {
                const data = Array.isArray(acc.account.data)
                    ? Buffer.from(acc.account.data[0], 'base64')
                    : Buffer.from(acc.account.data);

                if (data.length < 72) return null;

                const owner = new PublicKey(data.slice(32, 64)).toString();
                const amount = new BN(data.slice(64, 72), 'le');
                return { owner, amount, balance: amount.toString() };
            } catch (parseErr) {
                return null;
            }
        })
            .filter(a => a !== null)
            .sort((a, b) => b.amount.cmp(a.amount));

        const bondingCurvePDAStr = bondingCurvePDA.toString();
        const threshold = new BN(1000000);

        for (const acc of parsedAccounts) {
            if (holdersToInsert.length >= TOP_HOLDERS_LIMIT) break;
            if (acc.amount.lte(threshold)) continue;

            if (acc.owner !== bondingCurvePDAStr) {
                holdersToInsert.push({ mint, owner: acc.owner, balance: acc.balance });
            }
        }

        if (holdersToInsert.length > 0) {
            // Clear any existing holders (shouldn't be any for new tokens, but just in case)
            await db.run('DELETE FROM robinhood_token_holders WHERE mint = $1', [mint]);

            const BATCH_SIZE = 50;
            const now = Date.now();

            for (let i = 0; i < holdersToInsert.length; i += BATCH_SIZE) {
                const batch = holdersToInsert.slice(i, i + BATCH_SIZE);
                const placeholders = batch.map((_, idx) => {
                    const baseIdx = idx * 5;
                    return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5})`;
                }).join(', ');

                const params = batch.flatMap((h, idx) => [
                    h.mint,
                    h.owner,
                    h.balance,
                    i + idx + 1,
                    now
                ]);

                await db.run(`
                    INSERT INTO robinhood_token_holders (mint, "holderPubkey", balance, rank, "updatedAt")
                    VALUES ${placeholders}
                    ON CONFLICT (mint, "holderPubkey") DO UPDATE SET
                        balance = EXCLUDED.balance,
                        rank = EXCLUDED.rank,
                        "updatedAt" = EXCLUDED."updatedAt"
                `, params);
            }

            logger.info(`[Robinhood] Immediate scan for ${ticker || mint.slice(0, 8)}: found ${holdersToInsert.length} holders`);
        } else {
            logger.debug(`[Robinhood] Immediate scan for ${ticker || mint.slice(0, 8)}: no holders found yet (token may be very new)`);
        }

        return { success: true, holdersCount: holdersToInsert.length };

    } catch (e) {
        logger.error(`[Robinhood] Immediate scan error for ${mint}`, { error: e.message });
        return { success: false, holdersCount: 0, error: e.message };
    }
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
    fetchGeckoTerminalMetadata,
    fetchGeckoTerminalTokenInfo,
    fetchPumpFunMetadata,
    scanSingleTokenHolders, // v25.65: Immediate scan for new tokens
};
