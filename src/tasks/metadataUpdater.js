/**
 * Metadata Updater Task
 * Updates token prices/market data from multiple sources
 *
 * v19.0 - Enhanced debugging and improved DexScreener integration
 * v20.0 - Added GeckoTerminal as fallback for images
 * v25.13 - Tiered updates: Top 10 every 1 min, all tokens every 5 min
 *        - Images/metadata only fetched on token creation or admin request
 */
const axios = require('axios');
const config = require('../config/env');
const { logger, imageUtils } = require('../services');

// Delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Debug mode - set to true for verbose logging
const DEBUG_METADATA = false;

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

        const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
            {
                jsonrpc: '2.0',
                id: '1',
                method: 'getAssetBatch',
                params: {
                    ids: mints,
                    displayOptions: { showFungible: true }
                }
            },
            { timeout: 10000 }
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
 * v25.13: Update prices for specific tokens (no image/metadata updates)
 * Used for frequent top token updates
 * @param {Object} deps - Dependencies
 * @param {Array} tokens - Array of token objects with mint field
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

        const pairs = dexRes.data?.pairs || [];
        const updates = new Map();

        for (const pair of pairs) {
            const mint = pair.baseToken?.address;
            if (!mint) continue;

            const existing = updates.get(mint);
            if (!existing || (pair.liquidity?.usd > existing.liquidity)) {
                updates.set(mint, {
                    marketCap: pair.fdv || pair.marketCap || 0,
                    volume24h: pair.volume?.h24 || 0,
                    priceUsd: parseFloat(pair.priceUsd) || 0,
                    liquidity: pair.liquidity?.usd || 0
                });
            }
        }

        for (const t of tokens) {
            const data = updates.get(t.mint);
            if (data) {
                await db.run(
                    `UPDATE tokens SET volume24h = $1, "marketCap" = $2, "priceUsd" = $3, "lastUpdated" = $4 WHERE mint = $5`,
                    [data.volume24h, data.marketCap, data.priceUsd, Date.now(), t.mint]
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
        // Get top 10 tokens by market cap (leaderboard)
        const topTokens = await db.all(`
            SELECT mint, ticker FROM tokens
            WHERE "marketCap" > 0
            ORDER BY "marketCap" DESC
            LIMIT 10
        `);

        // Also get King of the Hill token if different
        const kothMint = globalState?.kothMint;
        let tokens = [...topTokens];

        if (kothMint && !tokens.find(t => t.mint === kothMint)) {
            const kothToken = await db.get('SELECT mint, ticker FROM tokens WHERE mint = $1', [kothMint]);
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
 * Runs every 5 minutes
 */
async function updateAllTokenPrices(deps) {
    const { db, globalState } = deps;

    const tokens = await db.all('SELECT mint, ticker FROM tokens');

    if (tokens.length === 0) {
        return;
    }

    logger.info(`[MetadataUpdater] Full price update: ${tokens.length} tokens`);

    const chunks = chunkArray(tokens, 30);
    let totalUpdated = 0;

    for (const chunk of chunks) {
        const mints = chunk.map(t => t.mint).join(',');

        try {
            const dexRes = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
                { timeout: 8000 }
            );

            const pairs = dexRes.data?.pairs || [];
            const updates = new Map();

            for (const pair of pairs) {
                const mint = pair.baseToken?.address;
                if (!mint) continue;

                const existing = updates.get(mint);
                if (!existing || (pair.liquidity?.usd > existing.liquidity)) {
                    updates.set(mint, {
                        marketCap: pair.fdv || pair.marketCap || 0,
                        volume24h: pair.volume?.h24 || 0,
                        priceUsd: parseFloat(pair.priceUsd) || 0,
                        liquidity: pair.liquidity?.usd || 0
                    });
                }
            }

            // Update tokens from DexScreener
            const misses = [];
            for (const t of chunk) {
                const data = updates.get(t.mint);
                if (data) {
                    await db.run(
                        `UPDATE tokens SET volume24h = $1, "marketCap" = $2, "priceUsd" = $3, "lastUpdated" = $4 WHERE mint = $5`,
                        [data.volume24h, data.marketCap, data.priceUsd, Date.now(), t.mint]
                    );
                    totalUpdated++;
                } else {
                    misses.push(t.mint);
                }
            }

            // Fallback to Helius for DexScreener misses
            if (misses.length > 0) {
                const heliusData = await fetchHeliusMarketDataBatch(misses);
                for (const mint of misses) {
                    const data = heliusData.get(mint);
                    if (data && data.marketCap > 0) {
                        await db.run(
                            `UPDATE tokens SET "marketCap" = $1, "lastUpdated" = $2 WHERE mint = $3`,
                            [data.marketCap, Date.now(), mint]
                        );
                        totalUpdated++;
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
            }
        }
    }

    globalState.lastBackendUpdate = Date.now();
    logger.info(`[MetadataUpdater] Full price update complete: ${totalUpdated}/${tokens.length} tokens`);
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

            const updates = new Map();

            for (const pair of pairs) {
                const mint = pair.baseToken?.address;
                if (!mint) continue;

                const existing = updates.get(mint);

                // Logic: Keep best pair (highest liquidity)
                if (!existing || (pair.liquidity?.usd > existing.liquidity)) {
                    const imageUrl = pair.info?.imageUrl ||
                                    pair.info?.header ||
                                    pair.baseToken?.info?.imageUrl ||
                                    null;

                    updates.set(mint, {
                        marketCap: pair.fdv || pair.marketCap || 0,
                        volume24h: pair.volume?.h24 || 0,
                        priceUsd: parseFloat(pair.priceUsd) || 0,
                        liquidity: pair.liquidity?.usd || 0,
                        imageUrl: imageUrl,
                        name: pair.baseToken?.name || null,
                        ticker: pair.baseToken?.symbol || null
                    });

                    if (DEBUG_METADATA && imageUrl) {
                        logger.debug(`[MetadataUpdater] DexScreener found image for ${mint.slice(0,8)}...`);
                    }
                }
            }

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
 * v25.13: Start the tiered metadata updater
 * - Top 10 + KOTH prices: every 1 minute
 * - All token prices: every 5 minutes
 * - Images/metadata: only on token creation or admin request
 */
function start(deps) {
    const priceInterval = config.METADATA_PRICE_INTERVAL || 60000; // 1 minute
    const fullInterval = config.METADATA_FULL_INTERVAL || 300000; // 5 minutes

    // Initial runs with staggered delays
    setTimeout(() => updateTopTokenPrices(deps), 5000);
    setTimeout(() => updateAllTokenPrices(deps), 15000);

    // Set up intervals
    setInterval(() => updateTopTokenPrices(deps), priceInterval);
    setInterval(() => updateAllTokenPrices(deps), fullInterval);

    logger.info(`[MetadataUpdater] Started - Top tokens: ${priceInterval/1000}s, All tokens: ${fullInterval/1000}s`);
}

module.exports = {
    updateMetadata,
    updateTopTokenPrices,
    updateAllTokenPrices,
    updatePricesOnly,
    start,
    fetchGeckoTerminalMetadata,
    fetchGeckoTerminalBatch,
    fetchHeliusMarketDataBatch,
    fillMissingImagesFromMetadata
};
