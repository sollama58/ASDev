/**
 * Metadata Updater Task
 * Updates token metadata (market data) from DexScreener and Pump.fun
 * NO IPFS SCRAPING - Prevents Rate Limits
 */
const axios = require('axios');
const config = require('../config/env');
const { logger } = require('../services');

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
                    // DexScreener miss -> Pump.fun Fallback (Market Data Only)
                    try {
                        await delay(300); 
                        const pumpRes = await axios.get(
                            `https://frontend-api.pump.fun/coins/${t.mint}`,
                            { timeout: 3000 }
                        );
                        if (pumpRes.data) {
                            const mcap = pumpRes.data.usd_market_cap || 0;
                            // Do NOT scrape image from Pump here, just mcap
                            await db.run(
                                `UPDATE tokens SET marketCap = ?, lastUpdated = ? WHERE mint = ?`,
                                [mcap, Date.now(), t.mint]
                            );
                        }
                    } catch (pumpErr) { /* Silent fail */ }
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
