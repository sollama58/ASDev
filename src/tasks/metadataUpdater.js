/**
 * Metadata Updater Task
 * Updates token metadata (market data) from DexScreener and Pump.fun
 * CRITICAL ADDITION: Resolves final image URL from metadataUri and saves it to the 'image' column.
 */
const axios = require('axios');
const config = require('../config/env');
const { logger } = require('../services');

/**
 * Update metadata for all tokens
 */
async function updateMetadata(deps) {
    const { db, globalState } = deps;

    // Fetch tokens, including metadataUri and current image state
    const tokens = await db.all('SELECT mint, metadataUri, image FROM tokens');

    for (const t of tokens) {
        let mcap = 0;
        let vol = 0;
        let finalImageUrl = t.image; // Keep existing image if it's already set

        // --- 1. RESOLVE IMAGE URL FROM METADATA URI ---
        if (t.metadataUri && !finalImageUrl) {
            try {
                const metadataRes = await axios.get(t.metadataUri, { timeout: 3000 });
                if (metadataRes.data && metadataRes.data.image) {
                    finalImageUrl = metadataRes.data.image;
                    logger.debug(`Resolved image for ${t.mint}: ${finalImageUrl}`);
                }
            } catch (e) {
                logger.warn(`Failed to resolve metadata for ${t.mint}: ${e.message}`);
            }
        }
        
        // --- 2. FETCH MARKET DATA (existing logic) ---
        try {
            // Try DexScreener first
            const dexRes = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${t.mint}`,
                { timeout: 3000 }
            );

            if (dexRes.data?.pairs?.length > 0) {
                const pair = dexRes.data.pairs[0];
                mcap = pair.fdv || pair.marketCap || 0;
                vol = pair.volume?.h24 || 0;
            } else {
                // Fallback to Pump API
                const pumpRes = await axios.get(
                    `https://frontend-api.pump.fun/coins/${t.mint}`,
                    { timeout: 3000 }
                );
                if (pumpRes.data) {
                    mcap = pumpRes.data.usd_market_cap || 0;
                }
            }

            // --- 3. SAVE ALL UPDATES ---
            if (mcap > 0 || finalImageUrl !== t.image) {
                await db.run(
                    `UPDATE tokens 
                     SET volume24h = ?, marketCap = ?, lastUpdated = ?, image = ? 
                     WHERE mint = ?`,
                    [vol, mcap, Date.now(), finalImageUrl, t.mint]
                );
            }

        } catch (e) {
            // Only log errors if the DEX/Pump API call fails, not the metadata resolution
            // logger.warn(`Market Data Sync Fail for ${t.mint}: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 500));
    }

    globalState.lastBackendUpdate = Date.now();
    logger.info(`Metadata update cycle complete. Last update: ${new Date(globalState.lastBackendUpdate).toLocaleTimeString()}`);
}

/**
 * Start the metadata updater interval
 */
function start(deps) {
    setInterval(() => updateMetadata(deps), config.METADATA_UPDATE_INTERVAL);
    logger.info("Metadata updater started");
}

module.exports = { updateMetadata, start };
