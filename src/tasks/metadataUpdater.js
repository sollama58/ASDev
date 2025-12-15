/**
 * Metadata Updater Task
 * Updates token metadata from DexScreener and Pump.fun
 */
const axios = require('axios');
const config = require('../config/env');
const { logger } = require('../services');

/**
 * Update metadata for all tokens
 */
async function updateMetadata(deps) {
    const { db, globalState } = deps;

    const tokens = await db.all('SELECT mint FROM tokens');

    for (const t of tokens) {
        try {
            // Try DexScreener first
            const dexRes = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${t.mint}`,
                { timeout: 3000 }
            );

            let mcap = 0;
            let vol = 0;

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

            if (mcap > 0) {
                await db.run(
                    'UPDATE tokens SET volume24h = ?, marketCap = ?, lastUpdated = ? WHERE mint = ?',
                    [vol, mcap, Date.now(), t.mint]
                );
            }
        } catch (e) {}

        await new Promise(r => setTimeout(r, 500));
    }

    globalState.lastBackendUpdate = Date.now();
}

/**
 * Start the metadata updater interval
 */
function start(deps) {
    setInterval(() => updateMetadata(deps), config.METADATA_UPDATE_INTERVAL);
    logger.info("Metadata updater started");
}

module.exports = { updateMetadata, start };
