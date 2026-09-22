/**
 * Metadata Updater Task
 * Updates token prices/market data from multiple sources
 *
 * v19.0 - Enhanced debugging and improved DexScreener integration
 * v20.0 - Added GeckoTerminal as fallback for images
 * v25.13 - Tiered updates: Top 10 every 1 min, all tokens every 5 min
 *        - Images/metadata only fetched on token creation or admin request
 * v25.22 - SECURITY: Added price bounds validation to prevent oracle manipulation
 * v25.46 - Added periodic image updates for ALL token types:
 *        - Platform tokens (tokens table)
 *        - Runs every 10 minutes to fill missing images
 */
const axios = require('axios');
const config = require('../config/env');
const { logger, imageUtils } = require('../services');

// Delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Debug mode - set to true for verbose logging
const DEBUG_METADATA = false;

// v25.22 SECURITY: Price sanity bounds - prevent oracle manipulation attacks
const MAX_PRICE_USD = 1000000; // $1M per token max
const MAX_MARKET_CAP_USD = 100000000000; // $100B max market cap
const MAX_VOLUME_USD = 10000000000; // $10B max 24h volume

// Throttle Helius fallback for tokens that chronically miss DexScreener (dead/delisted).
// After CHRONIC_MISS_THRESHOLD consecutive misses, only retry Helius once per hour.
const dexMissCount = new Map(); // mint -> consecutive miss count
const lastHeliusFallbackAt = new Map(); // mint -> timestamp
const CHRONIC_MISS_THRESHOLD = 3;
const CHRONIC_MISS_RECHECK_MS = 60 * 60 * 1000; // 1 hour

// Prune stale miss-tracking entries for tokens that haven't been seen in 24h
setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [mint, ts] of lastHeliusFallbackAt) {
        if (ts < cutoff) {
            dexMissCount.delete(mint);
            lastHeliusFallbackAt.delete(mint);
        }
    }
}, 6 * 60 * 60 * 1000);

/**
 * v25.22 SECURITY: Validate and sanitize price/market data
 * Returns 0 for invalid values (NaN, Infinity, negative, or exceeds bounds)
 */
function validateNumericValue(value, maxBound, fieldName = 'value') {
    const num = parseFloat(value) || 0;
    if (!Number.isFinite(num) || num < 0 || num > maxBound) {
        if (num !== 0) {
            logger.debug(`[MetadataUpdater] Invalid ${fieldName} rejected: ${value}`);
        }
        return 0;
    }
    return num;
}

/**
 * Batch fetch market data from Helius DAS API (fallback when DexScreener has no data)
 * Uses getAssetBatch to fetch up to 1000 assets in a single call
 * @param {string[]} mints - Array of mint addresses
 * @returns {Map<string, {marketCap: number, image: string}>} Map of mint -> market data
 */
async function fetchHeliusMarketDataBatch(mints) {
    const results = new Map();
    if (!config.HELIUS_API_KEY || mints.length === 0) {
        if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] Helius: No API key or empty mints`);
        return results;
    }
    try {
        if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] Helius: Fetching ${mints.length} assets...`);

        // v25.14 SECURITY: Move API key from URL to header
        const response = await axios.post(
            'https://mainnet.helius-rpc.com/',
            {
                jsonrpc: '2.0',
                id: '1',
                method: 'getAssetBatch',
                params: {
                    ids: mints,
                    displayOptions: { showFungible: true }
                }
            },
            {
                timeout: 10000,
                headers: { 'Authorization': `Bearer ${config.HELIUS_API_KEY}` }
            }
        );
        const assets = response.data?.result || [];

        if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] Helius: Got ${assets.length} assets`);

        for (const asset of assets) {
            if (asset?.id) {
                const data = {
                    marketCap: asset?.token_info?.price_info?.total_price || 0,
                    image: imageUtils.extractHeliusBatchImage(asset),
                    name: asset?.content?.metadata?.name || null,
                    ticker: asset?.content?.metadata?.symbol || null
                };

                if (data.marketCap > 0 || data.image) {
                    results.set(asset.id, data);
                    if (DEBUG_METADATA && data.image) {
                        logger.debug(`[MetadataUpdater] Helius found image for ${asset.id.slice(0,8)}...`);
                    }
                }
            }
        }

        if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] Helius: ${results.size} tokens with usable data`);
    } catch (e) {
        logger.warn(`[MetadataUpdater] Helius batch error: ${e.message}`);
    }
    return results;
}

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

// v27.5 EFFICIENCY: updateAllMissingImages runs the
// per-table image passes back to back, so if an earlier pass in this same cycle (or a previous
// cycle) already resolved an image for a mint, later passes can copy it straight from the DB
// instead of independently re-querying DexScreener/GeckoTerminal/Helius for the same mint.
const IMAGE_SOURCE_TABLES = ['tokens'];

/**
 * Look up already-resolved images for a set of mints from the OTHER token tables.
 * @param {Object} db - database instance
 * @param {string[]} mints - candidate mints missing an image in the caller's own table
 * @param {string} excludeTable - the caller's own table, skipped in the search
 * @returns {Promise<Map<string, {image: string, name: string|null, ticker: string|null}>>}
 */
async function findCrossTableImages(db, mints, excludeTable) {
    const results = new Map();
    if (mints.length === 0) return results;

    for (const table of IMAGE_SOURCE_TABLES) {
        if (table === excludeTable) continue;
        try {
            const rows = await db.all(
                `SELECT mint, image, name, ticker FROM ${table}
                 WHERE mint = ANY($1) AND image IS NOT NULL AND image != '' AND image != 'null'`,
                [mints]
            );
            for (const row of rows) {
                if (!results.has(row.mint)) {
                    results.set(row.mint, { image: row.image, name: row.name || null, ticker: row.ticker || null });
                }
            }
        } catch (e) {
            logger.debug(`[MetadataUpdater] Cross-table image lookup failed for ${table}: ${e.message}`);
        }
    }
    return results;
}

/**
 * Fetch token metadata from GeckoTerminal API
 * Free API with 30 requests/minute rate limit
 * Good for images when DexScreener doesn't have them
 * @param {string} mint - Token mint address
 * @returns {Object|null} Token metadata or null
 */
async function fetchGeckoTerminalMetadata(mint) {
    try {
        const response = await axios.get(
            `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`,
            {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
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
    }
    return null;
}

/**
 * Batch fetch GeckoTerminal data for tokens missing images
 * Note: GeckoTerminal doesn't support batch API, so we do individual calls with rate limiting
 * @param {string[]} mints - Array of mint addresses
 * @returns {Map<string, Object>} Map of mint -> metadata
 */
async function fetchGeckoTerminalBatch(mints) {
    const results = new Map();
    if (mints.length === 0) return results;

    if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] GeckoTerminal: Fetching ${mints.length} tokens...`);

    // GeckoTerminal has 30 req/min limit, so we limit to 25 per batch with delay
    const limitedMints = mints.slice(0, 25);
    let foundImages = 0;

    for (const mint of limitedMints) {
        try {
            const data = await fetchGeckoTerminalMetadata(mint);
            if (data && (data.image || data.marketCap > 0)) {
                results.set(mint, data);
                if (data.image) foundImages++;
            }
            // Rate limit: ~2 requests per second to stay under 30/min
            await delay(500);
        } catch (e) {
            // Continue on individual failures
        }
    }

    if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] GeckoTerminal: Found ${results.size} tokens with data, ${foundImages} with images`);
    return results;
}

/**
 * v30.2: Market data from the pairs where OUR creator fee is actually charged.
 *
 * A coin's 24h volume decides what share of ALL platform creator fees its holders receive, so
 * it must measure trading that generated those fees. DexScreener lists every pool for a
 * token, and we used to take whichever pair had the most liquidity. Anyone can open their own
 * low-fee pool for a ShitPad coin (Meteora, Raydium), out-fund the pump curve's liquidity and
 * wash-trade in it -- collecting most of the swap fees back as that pool's LP -- to inflate
 * the coin's "volume" and pull a large slice of every other coin's fees to its holders.
 * Volume on those pools pays us nothing, so it now counts for nothing.
 *
 * Only pairs whose dexId is in FEE_BEARING_DEX_IDS (default: the pump.fun bonding curve and
 * PumpSwap) contribute. Their volume is summed; price, market cap and liquidity come from
 * the deepest of them. A token whose only pairs are elsewhere is reported in `foreignOnly` and
 * treated by callers as a miss, so a rename of DexScreener's dexIds degrades slowly (via the
 * miss threshold) and loudly (via the warning) rather than zeroing everything at once.
 *
 * `imageUrl` may come from any pair: an image is cosmetic and carries no money.
 */
const FEE_BEARING_DEX_IDS = new Set(
    (process.env.FEE_BEARING_DEX_IDS || 'pumpfun,pumpswap').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

function extractMarketData(pairs) {
    const updates = new Map();
    const imageByMint = new Map();
    const foreignDexIds = new Map(); // mint -> Set(dexId) for pairs not in the allowlist

    for (const pair of pairs || []) {
        const mint = pair.baseToken?.address;
        if (!mint) continue;

        const img = pair.info?.imageUrl || pair.info?.header || pair.baseToken?.info?.imageUrl || null;
        if (img && !imageByMint.has(mint)) imageByMint.set(mint, img);

        const dexId = String(pair.dexId || '').toLowerCase();
        if (!FEE_BEARING_DEX_IDS.has(dexId)) {
            if (!foreignDexIds.has(mint)) foreignDexIds.set(mint, new Set());
            foreignDexIds.get(mint).add(dexId);
            continue;
        }

        const liquidity = validateNumericValue(pair.liquidity?.usd, MAX_MARKET_CAP_USD, 'liquidity');
        const volume = validateNumericValue(pair.volume?.h24, MAX_VOLUME_USD, 'volume24h');
        const existing = updates.get(mint);
        if (!existing) {
            updates.set(mint, {
                marketCap: validateNumericValue(pair.fdv || pair.marketCap, MAX_MARKET_CAP_USD, 'marketCap'),
                volume24h: volume,
                priceUsd: validateNumericValue(pair.priceUsd, MAX_PRICE_USD, 'priceUsd'),
                liquidity,
                name: pair.baseToken?.name || null,
                ticker: pair.baseToken?.symbol || null,
            });
        } else {
            existing.volume24h = Math.min(MAX_VOLUME_USD, existing.volume24h + volume);
            if (liquidity > existing.liquidity) {
                existing.marketCap = validateNumericValue(pair.fdv || pair.marketCap, MAX_MARKET_CAP_USD, 'marketCap');
                existing.priceUsd = validateNumericValue(pair.priceUsd, MAX_PRICE_USD, 'priceUsd');
                existing.liquidity = liquidity;
            }
        }
    }

    const foreignOnly = new Set();
    for (const [mint, ids] of foreignDexIds) {
        if (!updates.has(mint)) {
            foreignOnly.add(mint);
            logger.warn('[MetadataUpdater] Token has pairs but none where our creator fee is charged; volume not counted', {
                mint: mint.slice(0, 8), dexIds: [...ids].join(',')
            });
        }
    }
    for (const [mint, data] of updates) data.imageUrl = imageByMint.get(mint) || null;
    return { updates, foreignOnly };
}

/**
 * v30.2: one DexScreener miss no longer zeroes a coin's volume. A transient empty or partial
 * response used to drop the coin out of the very next fee split (volume 0 is below the
 * eligibility floor), handing its holders' share to other coins. Volume is zeroed only after
 * this many consecutive misses; until then the last good figure stands.
 */
const ZERO_VOLUME_AFTER_MISSES = 3;

function recordMiss(mint) {
    const n = (dexMissCount.get(mint) || 0) + 1;
    dexMissCount.set(mint, n);
    return n >= ZERO_VOLUME_AFTER_MISSES;
}

/**
 * v25.13: Update prices for specific tokens (no image/metadata updates)
 *         Also sets volume to 0 for tokens without data from DexScreener
 * Used for frequent top token updates
 * @param {Object} deps - Dependencies
 * @param {Array} tokens - Array of token objects with mint field and optional table_name
 */
async function updatePricesOnly(deps, tokens) {
    const { db } = deps;

    if (tokens.length === 0) return;

    const mints = tokens.map(t => t.mint).join(',');
    let updated = 0;

    try {
        const dexRes = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
            { timeout: 8000 }
        );

        const { updates } = extractMarketData(dexRes.data?.pairs);

        // v25.65: Update tokens with proper table reference
        for (const t of tokens) {
            const data = updates.get(t.mint);
            const table = t.table_name || 'tokens'; // Default to 'tokens' for backwards compatibility

            if (data) {
                dexMissCount.delete(t.mint);
                await db.run(
                    `UPDATE ${table} SET volume24h = $1, "marketCap" = $2, "priceUsd" = $3, "lastUpdated" = $4 WHERE mint = $5`,
                    [data.volume24h, data.marketCap, data.priceUsd, Date.now(), t.mint]
                );
                updated++;
            } else if (recordMiss(t.mint)) {
                await db.run(
                    `UPDATE ${table} SET volume24h = 0, "lastUpdated" = $1 WHERE mint = $2`,
                    [Date.now(), t.mint]
                );
                updated++;
            }
        }
    } catch (e) {
        if (e.response && e.response.status === 429) {
            logger.warn(`[MetadataUpdater] DexScreener Rate Limit (429)`);
        } else {
            logger.debug(`[MetadataUpdater] Price update error: ${e.message}`);
        }
    }

    return updated;
}

/**
 * v25.13: Update prices for top 10 leaderboard tokens + King of the Hill
 * Runs every 1 minute
 */
async function updateTopTokenPrices(deps) {
    const { db, globalState } = deps;

    try {
        const topTokens = await db.all(`
            SELECT mint, ticker, 'platform' as table_name, "marketCap" FROM tokens
            WHERE "marketCap" > 0
            ORDER BY "marketCap" DESC
            LIMIT 10
        `);

        // Also get King of the Hill token if different
        const kothMint = globalState?.kothMint;
        let tokens = [...topTokens];

        if (kothMint && !tokens.find(t => t.mint === kothMint)) {
            const kothToken = await db.get('SELECT mint, ticker, "platform" as table_name FROM tokens WHERE mint = $1', [kothMint]);
            if (kothToken) {
                tokens.push(kothToken);
            }
        }

        if (tokens.length === 0) {
            return;
        }

        const updated = await updatePricesOnly(deps, tokens);
        if (DEBUG_METADATA) {
            logger.debug(`[MetadataUpdater] Top tokens: ${updated}/${tokens.length} prices updated`);
        }
    } catch (e) {
        logger.debug(`[MetadataUpdater] Top token price update error: ${e.message}`);
    }
}

/**
 * v25.13: Full price update for all tokens (no metadata/images)
 *         Also ensures 0 volume is properly reflected (was holding old data)
 * Runs every 5 minutes
 */
async function updateAllTokenPrices(deps) {
    const { db, globalState } = deps;

    const platformTokens = await db.all('SELECT mint, ticker FROM tokens');

    // Every row lives in the same table; kept as a field so the update loop below stays generic.
    const allTokens = platformTokens.map(t => ({ ...t, table: 'tokens' }));

    if (allTokens.length === 0) {
        return;
    }

    logger.info(`[MetadataUpdater] Full price update: ${allTokens.length} platform tokens`);

    const chunks = chunkArray(allTokens, 30);
    let totalUpdated = 0;
    let totalWithZeroVolume = 0;

    // v27.5 EFFICIENCY: Collect DexScreener misses across ALL chunks and resolve them with a
    // single Helius getAssetBatch call at the end, instead of one Helius HTTP call per 30-mint
    // DexScreener chunk. getAssetBatch accepts up to 1000 ids, so for the typical token count
    // this turns what was previously ceil(allTokens.length / 30) Helius calls every 5 minutes
    // into a small, bounded number (1 per 1000 misses) — the same batching pattern already used
    // elsewhere in this file (updateAllMissingImages etc.).
    const missTable = new Map(); // mint -> table, so results can be applied after the loop
    const allMisses = [];

    for (const chunk of chunks) {
        const mints = chunk.map(t => t.mint).join(',');

        try {
            const dexRes = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
                { timeout: 8000 }
            );

            const { updates } = extractMarketData(dexRes.data?.pairs);

            // IMPORTANT: Also update tokens with 0 volume (not just those with data)
            for (const t of chunk) {
                const data = updates.get(t.mint);
                const table = t.table;

                if (data) {
                    // Token has DexScreener data — reset chronic-miss counter
                    dexMissCount.delete(t.mint);
                    await db.run(
                        `UPDATE ${table} SET volume24h = $1, "marketCap" = $2, "priceUsd" = $3, "lastUpdated" = $4 WHERE mint = $5`,
                        [data.volume24h, data.marketCap, data.priceUsd, Date.now(), t.mint]
                    );
                    totalUpdated++;
                } else {
                    // No fee-bearing data this time. Zeroed only after repeated misses.
                    if (recordMiss(t.mint)) {
                        await db.run(
                            `UPDATE ${table} SET volume24h = 0, "lastUpdated" = $1 WHERE mint = $2`,
                            [Date.now(), t.mint]
                        );
                        totalUpdated++;
                        totalWithZeroVolume++;
                    }
                    missTable.set(t.mint, table);
                    allMisses.push(t.mint);
                }
            }

            await delay(1500);

        } catch (e) {
            if (e.response && e.response.status === 429) {
                logger.warn(`[MetadataUpdater] DexScreener Rate Limit (429). Pausing 30 seconds...`);
                await delay(30000);
            } else {
                logger.warn(`[MetadataUpdater] DexScreener Batch Error: ${e.message}`);
            }
        }
    }

    // Fallback to Helius for all DexScreener misses across the whole run — throttle chronic
    // misses (dead/delisted tokens) to avoid burning Helius credits every 5 min for tokens that
    // will never have DexScreener data.
    if (allMisses.length > 0) {
        const fallbackNow = Date.now();
        const freshMisses = allMisses.filter(mint => {
            const missCount = dexMissCount.get(mint) || 0;
            if (missCount > CHRONIC_MISS_THRESHOLD) {
                const lastCall = lastHeliusFallbackAt.get(mint) || 0;
                return (fallbackNow - lastCall) > CHRONIC_MISS_RECHECK_MS;
            }
            return true;
        });

        if (freshMisses.length > 0) {
            // getAssetBatch caps at 1000 ids per call
            const heliusChunks = chunkArray(freshMisses, 1000);
            for (const heliusChunk of heliusChunks) {
                const heliusData = await fetchHeliusMarketDataBatch(heliusChunk);
                for (const mint of heliusChunk) {
                    lastHeliusFallbackAt.set(mint, fallbackNow);
                    const data = heliusData.get(mint);
                    if (data) {
                        if (data.marketCap > 0) {
                            await db.run(
                                `UPDATE ${missTable.get(mint)} SET "marketCap" = $1, "lastUpdated" = $2 WHERE mint = $3`,
                                [data.marketCap, Date.now(), mint]
                            );
                        }
                        // Helius has data — reset miss count so token gets normal treatment
                        if (data.marketCap > 0 || data.image) {
                            dexMissCount.delete(mint);
                        }
                    }
                }
                if (heliusChunks.length > 1) await delay(200);
            }
        }
    }

    globalState.lastBackendUpdate = Date.now();
    logger.info(`[MetadataUpdater] Full price update complete: ${totalUpdated}/${allTokens.length} tokens (${totalWithZeroVolume} set to 0 volume)`);
}

/**
 * LEGACY: Full metadata update (images + prices)
 * Only used by admin panel "Trigger Metadata Update" button
 * @param {Object} deps - Dependencies
 */
async function updateMetadata(deps) {
    const { db, globalState } = deps;

    // 1. Fetch tokens (need mint and current image status)
    const tokens = await db.all('SELECT mint, ticker, image FROM tokens');

    if (DEBUG_METADATA) {
        const noImage = tokens.filter(t => !t.image || t.image === '').length;
        logger.info(`[MetadataUpdater] Starting update: ${tokens.length} tokens (${noImage} missing images)`);
    }

    // 2. BATCH FETCH MARKET DATA (DexScreener)
    const chunks = chunkArray(tokens, 30);
    let totalUpdated = 0;
    let imagesUpdated = 0;

    for (const chunk of chunks) {
        const mints = chunk.map(t => t.mint).join(',');

        try {
            if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] DexScreener: Fetching ${chunk.length} tokens...`);

            const dexRes = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
                { timeout: 8000 }
            );

            const pairs = dexRes.data?.pairs || [];

            if (DEBUG_METADATA) {
                logger.debug(`[MetadataUpdater] DexScreener: Got ${pairs.length} pairs for ${chunk.length} tokens`);
            }

            const { updates } = extractMarketData(pairs);

            if (DEBUG_METADATA) {
                const withData = updates.size;
                const withImages = Array.from(updates.values()).filter(d => d.imageUrl).length;
                logger.debug(`[MetadataUpdater] DexScreener: ${withData} tokens have data, ${withImages} have images`);
            }

            // Update tokens that DexScreener has data for
            const misses = [];
            for (const t of chunk) {
                const data = updates.get(t.mint);

                if (data) {
                    // Update market data
                    const shouldUpdateImage = data.imageUrl && (!t.image || t.image === '' || t.image === 'null');
                    if (shouldUpdateImage) {
                        await db.run(
                            `UPDATE tokens SET volume24h = $1, "marketCap" = $2, "priceUsd" = $3, "lastUpdated" = $4, image = $5 WHERE mint = $6`,
                            [data.volume24h, data.marketCap, data.priceUsd, Date.now(), data.imageUrl, t.mint]
                        );
                        imagesUpdated++;
                    } else {
                        await db.run(
                            `UPDATE tokens SET volume24h = $1, "marketCap" = $2, "priceUsd" = $3, "lastUpdated" = $4 WHERE mint = $5`,
                            [data.volume24h, data.marketCap, data.priceUsd, Date.now(), t.mint]
                        );
                    }
                    totalUpdated++;
                } else {
                    misses.push(t.mint);
                }
            }

            // Batch fetch Helius data for all DexScreener misses
            const stillMissingImages = [];
            if (misses.length > 0) {
                if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] ${misses.length} tokens missed DexScreener, trying Helius...`);

                const heliusData = await fetchHeliusMarketDataBatch(misses);
                for (const mint of misses) {
                    const data = heliusData.get(mint);
                    const token = chunk.find(t => t.mint === mint);
                    const tokenHasImage = token && token.image && token.image !== '' && token.image !== 'null';

                    if (data) {
                        if (data.image && data.marketCap > 0 && !tokenHasImage) {
                            await db.run(
                                `UPDATE tokens SET "marketCap" = $1, image = $2, "lastUpdated" = $3 WHERE mint = $4`,
                                [data.marketCap, data.image, Date.now(), mint]
                            );
                            imagesUpdated++;
                        } else if (data.marketCap > 0) {
                            await db.run(
                                `UPDATE tokens SET "marketCap" = $1, "lastUpdated" = $2 WHERE mint = $3`,
                                [data.marketCap, Date.now(), mint]
                            );
                            if (!tokenHasImage) {
                                stillMissingImages.push(mint);
                            }
                        } else if (data.image && !tokenHasImage) {
                            await db.run(
                                `UPDATE tokens SET image = $1, "lastUpdated" = $2 WHERE mint = $3`,
                                [data.image, Date.now(), mint]
                            );
                            imagesUpdated++;
                        }
                        totalUpdated++;
                    } else {
                        if (!tokenHasImage) {
                            stillMissingImages.push(mint);
                        }
                    }
                }
            }

            // Try GeckoTerminal for tokens still missing images
            if (stillMissingImages.length > 0) {
                if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] ${stillMissingImages.length} tokens still missing images, trying GeckoTerminal...`);

                const geckoData = await fetchGeckoTerminalBatch(stillMissingImages);
                for (const [mint, data] of geckoData.entries()) {
                    if (data.image) {
                        await db.run(
                            `UPDATE tokens SET image = COALESCE(NULLIF($1, ''), image), "lastUpdated" = $2 WHERE mint = $3`,
                            [data.image, Date.now(), mint]
                        );
                        imagesUpdated++;
                        if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] GeckoTerminal found image for ${mint.slice(0, 8)}...`);
                    }
                }
            }

            await delay(1500);

        } catch (e) {
            if (e.response && e.response.status === 429) {
                logger.warn(`[MetadataUpdater] DexScreener Rate Limit (429). Pausing 30 seconds...`);
                await delay(30000);
            } else {
                logger.warn(`[MetadataUpdater] DexScreener Batch Error: ${e.message}`);
                if (DEBUG_METADATA && e.response) {
                    logger.debug(`[MetadataUpdater] Response status: ${e.response.status}, data: ${JSON.stringify(e.response.data).slice(0, 200)}`);
                }
            }
        }
    }

    globalState.lastBackendUpdate = Date.now();
    logger.info(`[MetadataUpdater] Complete: ${totalUpdated}/${tokens.length} tokens updated, ${imagesUpdated} images fetched`);
}

/**
 * Fill in missing images from metadataUri
 * This is a fallback mechanism for tokens that don't have images from DexScreener/Helius
 * Only runs on admin request via updateMetadata
 */
async function fillMissingImagesFromMetadata(deps) {
    const { db } = deps;

    try {
        // Get tokens with missing images but have metadataUri
        const tokensWithMissingImages = await db.all(`
            SELECT mint, "metadataUri" FROM tokens
            WHERE (image IS NULL OR image = '' OR image = 'null')
            AND "metadataUri" IS NOT NULL AND "metadataUri" != ''
            LIMIT 20
        `);

        if (tokensWithMissingImages.length === 0) {
            return;
        }

        logger.info(`[MetadataUpdater] Fetching images from metadataUri for ${tokensWithMissingImages.length} tokens...`);

        let imagesUpdated = 0;
        for (const token of tokensWithMissingImages) {
            try {
                const image = await imageUtils.fetchImageFromMetadataUri(token.metadataUri, 3000);
                if (image) {
                    await db.run(
                        'UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = \'\' OR image = \'null\')',
                        [image, token.mint]
                    );
                    imagesUpdated++;
                    if (DEBUG_METADATA) {
                        logger.debug(`[MetadataUpdater] Fetched image from metadataUri for ${token.mint.slice(0, 8)}...`);
                    }
                }
            } catch (e) {
                // Silently fail for individual tokens
            }

            // Small delay to avoid hammering IPFS gateways
            await delay(500);
        }

        if (imagesUpdated > 0) {
            logger.info(`[MetadataUpdater] Fetched ${imagesUpdated} images from metadataUri`);
        }
    } catch (e) {
        logger.warn(`[MetadataUpdater] Error filling missing images: ${e.message}`);
    }
}

/**
 * v25.46: Update metadata for platform tokens missing images (tokens table)
 * Specifically targets tokens that have metadataUri but no image
 * v27.3: DexScreener and Helius lookups are now batched (30 mints/request and one
 * getAssetBatch call respectively) instead of one HTTP request per token.
 */
async function updatePlatformTokenImages(deps) {
    const { db } = deps;

    try {
        // Get platform tokens missing images
        const tokens = await db.all(`
            SELECT mint, ticker, image, "metadataUri" FROM tokens
            WHERE (image IS NULL OR image = '' OR image = 'null')
            LIMIT 50
        `);

        if (tokens.length === 0) {
            if (DEBUG_METADATA) logger.debug(`[MetadataUpdater] Platform: All tokens have images`);
            return;
        }

        logger.info(`[MetadataUpdater] Platform: ${tokens.length} tokens missing images`);

        let imagesUpdated = 0;

        // Phase 0: Copy an image already resolved for the same mint in another table, if any —
        // no external API call needed.
        const crossTableImages = await findCrossTableImages(db, tokens.map(t => t.mint), 'tokens');
        const needsExternalLookup = [];
        for (const token of tokens) {
            const cross = crossTableImages.get(token.mint);
            if (cross) {
                const normalizedImage = imageUtils.normalizeImageUrl(cross.image) || cross.image;
                await db.run(
                    `UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = '' OR image = 'null')`,
                    [normalizedImage, token.mint]
                );
                imagesUpdated++;
                if (DEBUG_METADATA) {
                    logger.debug(`[MetadataUpdater] Platform: Found image for ${token.ticker || token.mint.slice(0, 8)} via another table`);
                }
            } else {
                needsExternalLookup.push(token);
            }
        }

        // Phase 1: DexScreener, batched 30 mints/request instead of one request per token
        const dexImages = new Map(); // mint -> { liquidity, imageUrl }
        const dexChunks = chunkArray(needsExternalLookup, 30);
        for (const chunk of dexChunks) {
            try {
                const mints = chunk.map(t => t.mint).join(',');
                const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 8000 });
                const pairs = dexRes.data?.pairs || [];
                for (const pair of pairs) {
                    const mint = pair.baseToken?.address;
                    if (!mint || !pair.info?.imageUrl) continue;
                    const liquidity = pair.liquidity?.usd || 0;
                    const existing = dexImages.get(mint);
                    if (!existing || liquidity > existing.liquidity) {
                        dexImages.set(mint, { liquidity, imageUrl: pair.info.imageUrl });
                    }
                }
            } catch (e) {
                logger.debug(`[MetadataUpdater] Platform: DexScreener batch error: ${e.message}`);
            }
            if (dexChunks.length > 1) await delay(300);
        }

        const stillMissing = [];
        for (const token of needsExternalLookup) {
            const imageUrl = dexImages.get(token.mint)?.imageUrl || null;
            if (imageUrl) {
                const normalizedImage = imageUtils.normalizeImageUrl(imageUrl) || imageUrl;
                await db.run(
                    `UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = '' OR image = 'null')`,
                    [normalizedImage, token.mint]
                );
                imagesUpdated++;
                if (DEBUG_METADATA) {
                    logger.debug(`[MetadataUpdater] Platform: Found image for ${token.ticker || token.mint.slice(0, 8)}`);
                }
            } else {
                stillMissing.push(token);
            }
        }

        // Phase 2: metadataUri — inherently per-token (each token has its own IPFS/HTTP URI)
        const stillMissingAfterMetadataUri = [];
        for (const token of stillMissing) {
            let imageUrl = null;
            if (token.metadataUri) {
                try {
                    imageUrl = await imageUtils.fetchImageFromMetadataUri(token.metadataUri, 5000);
                } catch (e) { /* Silent */ }
            }
            if (imageUrl) {
                const normalizedImage = imageUtils.normalizeImageUrl(imageUrl) || imageUrl;
                await db.run(
                    `UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = '' OR image = 'null')`,
                    [normalizedImage, token.mint]
                );
                imagesUpdated++;
                if (DEBUG_METADATA) {
                    logger.debug(`[MetadataUpdater] Platform: Found image for ${token.ticker || token.mint.slice(0, 8)} via metadataUri`);
                }
            } else {
                stillMissingAfterMetadataUri.push(token);
            }
        }

        // Phase 3: GeckoTerminal — rate-limited API, fetchGeckoTerminalBatch already batches
        // with an internal 500ms delay and a 25-item cap per run.
        const geckoResults = stillMissingAfterMetadataUri.length > 0
            ? await fetchGeckoTerminalBatch(stillMissingAfterMetadataUri.map(t => t.mint))
            : new Map();

        const stillMissingAfterGecko = [];
        for (const token of stillMissingAfterMetadataUri) {
            const geckoData = geckoResults.get(token.mint);
            if (geckoData?.image) {
                const normalizedImage = imageUtils.normalizeImageUrl(geckoData.image) || geckoData.image;
                await db.run(
                    `UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = '' OR image = 'null')`,
                    [normalizedImage, token.mint]
                );
                imagesUpdated++;
                if (DEBUG_METADATA) {
                    logger.debug(`[MetadataUpdater] Platform: Found image for ${token.ticker || token.mint.slice(0, 8)} via GeckoTerminal`);
                }
            } else {
                stillMissingAfterGecko.push(token);
            }
        }

        // Phase 4: Helius, batched into a single getAssetBatch call instead of one
        // single-mint call per token.
        if (stillMissingAfterGecko.length > 0 && config.HELIUS_API_KEY) {
            const heliusResults = await fetchHeliusMarketDataBatch(stillMissingAfterGecko.map(t => t.mint));
            for (const token of stillMissingAfterGecko) {
                const data = heliusResults.get(token.mint);
                if (data?.image) {
                    const normalizedImage = imageUtils.normalizeImageUrl(data.image) || data.image;
                    await db.run(
                        `UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = '' OR image = 'null')`,
                        [normalizedImage, token.mint]
                    );
                    imagesUpdated++;
                    if (DEBUG_METADATA) {
                        logger.debug(`[MetadataUpdater] Platform: Found image for ${token.ticker || token.mint.slice(0, 8)} via Helius`);
                    }
                }
            }
        }

        if (imagesUpdated > 0) {
            logger.info(`[MetadataUpdater] Platform: Updated ${imagesUpdated} token images`);
        }
    } catch (e) {
        logger.warn(`[MetadataUpdater] Platform image update error: ${e.message}`);
    }
}

/**
 * v25.46: Combined image update for all token types
 * Runs periodically to fill in missing images across all tables
 */
async function updateAllMissingImages(deps) {
    logger.info(`[MetadataUpdater] Starting missing images update for all token types...`);

    await updatePlatformTokenImages(deps);

    logger.info(`[MetadataUpdater] Missing images update complete`);
}

/**
 * v25.13: Start the tiered metadata updater
 * - Top 10 + KOTH prices: every 1 minute
 * - All token prices: every 5 minutes
 * - v25.46: Missing images for all token types: every 10 minutes
 * v25.64: Improved staggering to avoid RPC/API spikes at startup
 */
function start(deps) {
    const priceInterval = config.METADATA_PRICE_INTERVAL || 60000; // 1 minute
    const fullInterval = config.METADATA_FULL_INTERVAL || 300000; // 5 minutes
    const imageInterval = config.METADATA_IMAGE_INTERVAL || 600000; // 10 minutes

    // v25.64: Better staggered initial runs to avoid API rate limits and RPC spikes
    // Top token prices: 10s (lightweight, only 10 tokens)
    // All token prices: handled by worker at 45s
    // Images: 90s (can be slow, runs after other tasks stabilize)
    setTimeout(() => updateTopTokenPrices(deps), 10000);
    setTimeout(() => updateAllMissingImages(deps), 90000);

    // Set up intervals. v30.2: the full-price pass is NOT scheduled here -- the BullMQ metadata
    // worker (workers.initMetadataUpdaterWorker) already runs it every METADATA_FULL_INTERVAL,
    // and in full mode both were scheduled, so every token was priced twice every 5 minutes.
    setInterval(() => updateTopTokenPrices(deps), priceInterval);
    setInterval(() => updateAllMissingImages(deps), imageInterval); // v25.46: Periodic image updates

    logger.info(`[MetadataUpdater] Started - Top tokens: ${priceInterval/1000}s, Images: ${imageInterval/1000}s (full pass: metadata worker, ${fullInterval/1000}s)`);
}

/**
 * v30.2: fresh market data for a few mints, for the admin refresh routes. Replaces their use
 * of the 1,800-line mintExtractor service, whose own DexScreener lookup took volume from any
 * pair -- the same attribution hole extractMarketData closes. DexScreener first (fee-bearing
 * pairs only), Helius getAssetBatch for anything it misses.
 *
 * @returns {Promise<Map<string, {name, ticker, image, marketCap, volume24h}>>}
 */
async function fetchFreshMarketData(mints) {
    const out = new Map();
    for (const chunk of chunkArray(mints, 30)) {
        try {
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { timeout: 8000 });
            const { updates } = extractMarketData(dexRes.data?.pairs);
            for (const [mint, d] of updates) {
                out.set(mint, { name: d.name, ticker: d.ticker, image: d.imageUrl, marketCap: d.marketCap, volume24h: d.volume24h });
            }
        } catch (e) {
            logger.debug(`[MetadataUpdater] fetchFreshMarketData DexScreener error: ${e.message}`);
        }
    }
    const misses = mints.filter(m => !out.has(m));
    if (misses.length) {
        const helius = await fetchHeliusMarketDataBatch(misses);
        for (const m of misses) {
            const d = helius.get(m);
            if (d) out.set(m, { name: null, ticker: null, image: d.image || null, marketCap: d.marketCap || 0, volume24h: 0 });
        }
    }
    return out;
}

module.exports = {
    fetchFreshMarketData,
    extractMarketData,
    updateMetadata,
    updateTopTokenPrices,
    updateAllTokenPrices,
    updatePricesOnly,
    start,
    fetchGeckoTerminalMetadata,
    fetchGeckoTerminalBatch,
    fetchHeliusMarketDataBatch,
    fillMissingImagesFromMetadata,
    // v25.46: New functions for all token type image updates
    updatePlatformTokenImages,
    updateAllMissingImages
};
