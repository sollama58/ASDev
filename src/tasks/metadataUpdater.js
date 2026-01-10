/**
 * Metadata Updater Task
 * Updates token metadata (market data) from DexScreener
 * NO IPFS SCRAPING - Prevents Rate Limits
 */
const axios = require('axios');
const config = require('../config/env');
const { logger } = require('../services');

/**
 * Batch fetch market data from Helius DAS API (fallback when DexScreener has no data)
 * Uses getAssetBatch to fetch up to 1000 assets in a single call
 * @param {string[]} mints - Array of mint addresses
 * @returns {Map<string, {marketCap: number}>} Map of mint -> market data
 */
async function fetchHeliusMarketDataBatch(mints) {
    const results = new Map();
    if (!config.HELIUS_API_KEY || mints.length === 0) {
        return results;
    }
    try {
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
        for (const asset of assets) {
            if (asset?.id && asset?.token_info?.price_info?.total_price) {
                results.set(asset.id, {
                    marketCap: asset.token_info.price_info.total_price
                });
            }
        }
    } catch (e) {
        // Silent fail
    }
    return results;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

async function updateMetadata(deps) {
    const { db, globalState } = deps;

    // 1. Fetch tokens (just mints needed now)
    const tokens = await db.all('SELECT mint FROM tokens');
    
    // 2. BATCH FETCH MARKET DATA (DexScreener)
    const chunks = chunkArray(tokens, 30);
    
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
                const mint = pair.baseToken.address;
                const existing = updates.get(mint);
                
                // Logic: Keep best pair
                if (!existing || (pair.liquidity?.usd > existing.liquidity)) {
                    updates.set(mint, {
                        marketCap: pair.fdv || pair.marketCap || 0,
                        volume24h: pair.volume?.h24 || 0,
                        priceUsd: pair.priceUsd || 0,
                        liquidity: pair.liquidity?.usd || 0,
                        // OPPORTUNISTIC IMAGE UPDATE
                        // If DexScreener has an image, and we might need it, take it.
                        imageUrl: pair.info?.imageUrl
                    });
                }
            }

            // Update tokens that DexScreener has data for
            const misses = [];
            for (const t of chunk) {
                const data = updates.get(t.mint);

                if (data) {
                    // Update market data. If DexScreener has an image, use it to ensure we have *something*
                    if (data.imageUrl) {
                        await db.run(
                            `UPDATE tokens SET volume24h = ?, marketCap = ?, priceUsd = ?, lastUpdated = ?, image = ? WHERE mint = ?`,
                            [data.volume24h, data.marketCap, data.priceUsd, Date.now(), data.imageUrl, t.mint]
                        );
                    } else {
                        await db.run(
                            `UPDATE tokens SET volume24h = ?, marketCap = ?, priceUsd = ?, lastUpdated = ? WHERE mint = ?`,
                            [data.volume24h, data.marketCap, data.priceUsd, Date.now(), t.mint]
                        );
                    }
                } else {
                    misses.push(t.mint);
                }
            }

            // Batch fetch Helius data for all DexScreener misses (1 call instead of N)
            if (misses.length > 0) {
                const heliusData = await fetchHeliusMarketDataBatch(misses);
                for (const mint of misses) {
                    const data = heliusData.get(mint);
                    if (data?.marketCap) {
                        await db.run(
                            `UPDATE tokens SET marketCap = ?, lastUpdated = ? WHERE mint = ?`,
                            [data.marketCap, Date.now(), mint]
                        );
                    }
                }
            }
            await delay(1500);

        } catch (e) {
            if (e.response && e.response.status === 429) {
                logger.warn(`DexScreener Rate Limit (429). Pausing 30 seconds...`);
                await delay(30000);
            } else {
                logger.warn(`DexScreener Batch Error: ${e.message}`);
            }
        }
    }

    globalState.lastBackendUpdate = Date.now();
    logger.info(`Metadata update complete. Tokens scanned: ${tokens.length}`);
}

function start(deps) {
    setTimeout(() => updateMetadata(deps), 5000);
    setInterval(() => updateMetadata(deps), config.METADATA_UPDATE_INTERVAL);
    logger.info("Metadata updater started (No IPFS)");
}

module.exports = { updateMetadata, start };
