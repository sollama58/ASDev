/**
 * Metadata Updater Task
 * Updates token metadata (market data) from DexScreener and Pump.fun
 * Includes gentle metadata resolution to avoid rate limits.
 */
const axios = require('axios');
const config = require('../config/env');
const { logger } = require('../services');

// Helper for delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Batch tokens for DexScreener (max 30 per request)
 */
function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

/**
 * Update metadata for all tokens
 */
async function updateMetadata(deps) {
    const { db, globalState } = deps;

    // Fetch tokens
    const tokens = await db.all('SELECT mint, metadataUri, image FROM tokens');
    
    // 1. RESOLVE MISSING IMAGES (Gentle, one by one)
    // Only process tokens that don't have an image yet to save requests
    const tokensMissingImage = tokens.filter(t => t.metadataUri && !t.image);
    
    if (tokensMissingImage.length > 0) {
        logger.info(`Resolving images for ${tokensMissingImage.length} tokens...`);
        for (const t of tokensMissingImage) {
            try {
                // Fetch metadata from IPFS/URI
                const metadataRes = await axios.get(t.metadataUri, { timeout: 5000 });
                if (metadataRes.data && metadataRes.data.image) {
                    const finalImageUrl = metadataRes.data.image;
                    await db.run('UPDATE tokens SET image = ? WHERE mint = ?', [finalImageUrl, t.mint]);
                    logger.debug(`Resolved image for ${t.mint}`);
                }
            } catch (e) {
                if (e.response && e.response.status === 429) {
                    logger.warn(`IPFS/Metadata Rate Limit (429). Pausing 10s...`);
                    await delay(10000);
                }
            }
            await delay(2000); // 2s delay between image resolutions to be safe
        }
    }

    // 2. BATCH FETCH MARKET DATA (DexScreener)
    // DexScreener allows up to 30 addresses per call
    const chunks = chunkArray(tokens, 30);
    
    for (const chunk of chunks) {
        const mints = chunk.map(t => t.mint).join(',');
        
        try {
            const dexRes = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
                { timeout: 8000 }
            );

            const pairs = dexRes.data?.pairs || [];
            
            // Map results by mint for easy lookup
            const updates = new Map();
            
            // DexScreener might return multiple pairs per token, take the best one (usually highest liquidity/volume)
            for (const pair of pairs) {
                const mint = pair.baseToken.address;
                const existing = updates.get(mint);
                
                // If we haven't seen this mint or this pair has higher liquidity, use it
                if (!existing || (pair.liquidity?.usd > existing.liquidity)) {
                    updates.set(mint, {
                        marketCap: pair.fdv || pair.marketCap || 0,
                        volume24h: pair.volume?.h24 || 0,
                        priceUsd: pair.priceUsd || 0,
                        liquidity: pair.liquidity?.usd || 0
                    });
                }
            }

            // Process updates
            for (const t of chunk) {
                const data = updates.get(t.mint);
                
                if (data) {
                    // We got data from DexScreener
                    await db.run(
                        `UPDATE tokens 
                         SET volume24h = ?, marketCap = ?, priceUsd = ?, lastUpdated = ? 
                         WHERE mint = ?`,
                        [data.volume24h, data.marketCap, data.priceUsd, Date.now(), t.mint]
                    );
                } else {
                    // Token not found on DexScreener yet (might be very new), try Pump.fun fallback
                    // ONLY do this if we didn't get data from DexScreener to save limits
                    try {
                        await delay(250); // Small delay to prevent hammering Pump API
                        const pumpRes = await axios.get(
                            `https://frontend-api.pump.fun/coins/${t.mint}`,
                            { timeout: 3000 }
                        );
                        if (pumpRes.data) {
                            const mcap = pumpRes.data.usd_market_cap || 0;
                            await db.run(
                                `UPDATE tokens SET marketCap = ?, lastUpdated = ? WHERE mint = ?`,
                                [mcap, Date.now(), t.mint]
                            );
                        }
                    } catch (pumpErr) {
                         // Ignore pump 404s/errors silently
                    }
                }
            }
            
            // Delay between chunks to be nice to DexScreener
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

/**
 * Start the metadata updater interval
 */
function start(deps) {
    // Run immediately on start (with slight delay)
    setTimeout(() => updateMetadata(deps), 5000);
    
    // Then run on interval
    setInterval(() => updateMetadata(deps), config.METADATA_UPDATE_INTERVAL);
    logger.info("Metadata updater started");
}

module.exports = { updateMetadata, start };
