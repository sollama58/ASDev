/**
 * Metadata Updater Task
 * Updates token metadata (market data) from DexScreener and Pump.fun
 * NO IPFS SCRAPING - Prevents Rate Limits
 *
 * Refresh is tiered so the loop does not scale with every token ever launched:
 *  - "hot" tokens (launched recently, or on the volume leaderboard) refresh every run
 *  - everything else refreshes once it is older than METADATA_SLOW_REFRESH_INTERVAL,
 *    stalest first, capped per run so a backlog spreads over several runs
 */
const axios = require('axios');
const config = require('../config/env');
const { logger } = require('../services');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const DEXSCREENER_BATCH = 30;
const HOT_WINDOW_MS = 24 * 60 * 60 * 1000;   // tokens launched in the last 24h
const HOT_TOP_N = 10;                        // plus the volume leaderboard the scanner uses
const MAX_SLOW_PER_RUN = 3 * DEXSCREENER_BATCH;

let isUpdating = false;

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

/**
 * Decide which tokens are due for a refresh this run.
 */
function selectDueTokens(tokens, now) {
    const slowInterval = config.METADATA_SLOW_REFRESH_INTERVAL;
    const due = new Map();

    // Hot: recently launched
    for (const t of tokens) {
        if (t.timestamp && now - t.timestamp < HOT_WINDOW_MS) due.set(t.mint, t);
    }

    // Hot: current volume leaderboard
    [...tokens]
        .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
        .slice(0, HOT_TOP_N)
        .forEach(t => due.set(t.mint, t));

    // Slow tier: stalest first, capped
    const stale = tokens
        .filter(t => !due.has(t.mint) && (!t.lastUpdated || now - t.lastUpdated >= slowInterval))
        .sort((a, b) => (a.lastUpdated || 0) - (b.lastUpdated || 0))
        .slice(0, MAX_SLOW_PER_RUN);
    stale.forEach(t => due.set(t.mint, t));

    return { due: Array.from(due.values()), staleCount: stale.length };
}

async function updateMetadata(deps) {
    const { db, globalState } = deps;

    if (isUpdating) {
        logger.warn("Metadata updater: previous run still in progress, skipping this tick");
        return;
    }
    isUpdating = true;

    try {
        const now = Date.now();

        // 1. Fetch tokens and pick the ones due this run
        const tokens = await db.all('SELECT mint, timestamp, volume24h, lastUpdated FROM tokens');
        const { due, staleCount } = selectDueTokens(tokens, now);

        if (due.length === 0) {
            globalState.lastBackendUpdate = Date.now();
            return;
        }

        // 2. BATCH FETCH MARKET DATA (DexScreener)
        const chunks = chunkArray(due, DEXSCREENER_BATCH);

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
                            // A pair on any DEX other than the pump.fun bonding curve means the
                            // token has graduated. Once set, `complete` is never cleared.
                            complete: pair.dexId && pair.dexId !== 'pumpfun' ? 1 : 0,
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
                                `UPDATE tokens SET volume24h = ?, marketCap = ?, priceUsd = ?, complete = MAX(COALESCE(complete, 0), ?), lastUpdated = ?, image = ? WHERE mint = ?`,
                                [data.volume24h, data.marketCap, data.priceUsd, data.complete, Date.now(), data.imageUrl, t.mint]
                            );
                        } else {
                            await db.run(
                                `UPDATE tokens SET volume24h = ?, marketCap = ?, priceUsd = ?, complete = MAX(COALESCE(complete, 0), ?), lastUpdated = ? WHERE mint = ?`,
                                [data.volume24h, data.marketCap, data.priceUsd, data.complete, Date.now(), t.mint]
                            );
                        }
                    } else {
                        // DexScreener miss -> Pump.fun Fallback (Market Data Only)
                        // Stamp lastUpdated either way so a token DexScreener never indexes
                        // drops into the slow tier instead of being retried every run.
                        let mcap = null;
                        let complete = 0;
                        try {
                            await delay(300);
                            const pumpRes = await axios.get(
                                `https://frontend-api.pump.fun/coins/${t.mint}`,
                                { timeout: 3000 }
                            );
                            if (pumpRes.data) {
                                mcap = pumpRes.data.usd_market_cap || 0;
                                complete = pumpRes.data.complete ? 1 : 0;
                            }
                        } catch (pumpErr) { /* Silent fail */ }

                        if (mcap !== null) {
                            await db.run(
                                `UPDATE tokens SET marketCap = ?, complete = MAX(COALESCE(complete, 0), ?), lastUpdated = ? WHERE mint = ?`,
                                [mcap, complete, Date.now(), t.mint]
                            );
                        } else {
                            await db.run(`UPDATE tokens SET lastUpdated = ? WHERE mint = ?`, [Date.now(), t.mint]);
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
        logger.info(`Metadata update complete. Refreshed ${due.length} of ${tokens.length} tokens (${due.length - staleCount} hot, ${staleCount} slow-tier)`);
    } catch (e) {
        logger.error("Metadata updater error", { error: e.message });
    } finally {
        isUpdating = false;
    }
}

/**
 * Start the metadata updater loop.
 * The next run is scheduled after the current one finishes, so a slow run
 * (for example after a DexScreener 429 pause) never overlaps the next.
 */
function start(deps) {
    const loop = async () => {
        await updateMetadata(deps);
        setTimeout(loop, config.METADATA_UPDATE_INTERVAL);
    };
    setTimeout(loop, 5000);
    logger.info(`Metadata updater started (No IPFS, ${config.METADATA_UPDATE_INTERVAL / 1000}s hot / ${config.METADATA_SLOW_REFRESH_INTERVAL / 1000}s slow tier)`);
}

module.exports = { updateMetadata, selectDueTokens, start };
