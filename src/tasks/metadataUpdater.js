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
 * Update metadata for all tokens
 */
async function updateMetadata(deps) {
    const { db, globalState } = deps;

    // Fetch tokens, including metadataUri and current image state
    const tokens = await db.all('SELECT mint, metadataUri, image FROM tokens');
    
    // Shuffle tokens to avoid hitting the same ones first every time if process restarts
    // This helps distribution of API calls
    const shuffledTokens = tokens.sort(() => Math.random() - 0.5);

    let requestCount = 0;

    for (const t of shuffledTokens) {
        let mcap = 0;
        let vol = 0;
        let finalImageUrl = t.image; // Keep existing image if it's already set
        let updatesMade = false;

        // --- 1. RESOLVE IMAGE URL FROM METADATA URI (Gentle Fetch) ---
        if (t.metadataUri && !finalImageUrl) {
            try {
                // If we've made 50 requests in this batch, pause for 2 seconds to be safe
                if (requestCount > 0 && requestCount % 50 === 0) {
                    await delay(2000);
                }
                
                // Use a longer timeout for IPFS
                const metadataRes = await axios.get(t.metadataUri, { timeout: 8000 });
                requestCount++;

                if (metadataRes.data && metadataRes.data.image) {
                    finalImageUrl = metadataRes.data.image;
                    logger.debug(`Resolved image for ${t.mint}: ${finalImageUrl}`);
                    updatesMade = true;
                }
            } catch (e) {
                // 429 Handling: If we hit a rate limit, pause significantly
                if (e.response && e.response.status === 429) {
                    logger.warn(`Metadata Rate Limit (429) on ${t.mint}. Pausing for 5 seconds...`);
                    await delay(5000); 
                } else {
                    // logger.warn(`Failed to resolve metadata for ${t.mint}: ${e.message}`);
                }
            }
        }
        
        // --- 2. FETCH MARKET DATA (DexScreener/Pump) ---
        try {
            // Try DexScreener first
            const dexRes = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${t.mint}`,
                { timeout: 5000 }
            );
            requestCount++;

            if (dexRes.data?.pairs?.length > 0) {
                const pair = dexRes.data.pairs[0];
                mcap = pair.fdv || pair.marketCap || 0;
                vol = pair.volume?.h24 || 0;
            } else {
                // Fallback to Pump API
                const pumpRes = await axios.get(
                    `https://frontend-api.pump.fun/coins/${t.mint}`,
                    { timeout: 5000 }
                );
                requestCount++;
                if (pumpRes.data) {
                    mcap = pumpRes.data.usd_market_cap || 0;
                }
            }

            // --- 3. SAVE ALL UPDATES ---
            // Only update DB if we have new meaningful data or resolved an image
            if (mcap > 0 || updatesMade) {
                await db.run(
                    `UPDATE tokens 
                     SET volume24h = ?, marketCap = ?, lastUpdated = ?, image = ? 
                     WHERE mint = ?`,
                    [vol, mcap, Date.now(), finalImageUrl, t.mint]
                );
            }

        } catch (e) {
             if (e.response && e.response.status === 429) {
                logger.warn(`Market Data Rate Limit (429). Pausing...`);
                await delay(5000);
             }
        }

        // Base delay between every token to be gentle
        await delay(1000); 
    }

    globalState.lastBackendUpdate = Date.now();
    logger.info(`Metadata update cycle complete. Last update: ${new Date(globalState.lastBackendUpdate).toLocaleTimeString()}`);
}

/**
 * Start the metadata updater interval
 */
function start(deps) {
    // Run immediately on start (with slight delay to let DB init)
    setTimeout(() => updateMetadata(deps), 5000);
    
    // Then run on interval
    setInterval(() => updateMetadata(deps), config.METADATA_UPDATE_INTERVAL);
    logger.info("Metadata updater started");
}

module.exports = { updateMetadata, start };
