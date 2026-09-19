/**
 * ASDF Token Holder Sync
 * Updates the list of Top 100 ASDF holders for the 2x Multiplier
 */
const { PublicKey } = require('@solana/web3.js');
const { fetchTopHoldersByBalance } = require('../services/heliusDAS');
const config = require('../config/env');
const { TOKENS, WALLETS, PROGRAMS } = require('../config/constants');
const ASDF_SYNC_INTERVAL = config.ASDF_UPDATE_INTERVAL || 5 * 60 * 1000;
const { logger, pump } = require('../services');

// Pre-compute LP exclusion addresses for ASDF (fixed mint, compute once at module load)
const [_asdfBondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), TOKENS.ASDF.toBuffer()],
    PROGRAMS.PUMP
);
const ASDF_BONDING_CURVE_STR = _asdfBondingCurve.toString();
const ASDF_AMM_POOL_STR = pump.getPumpAmmPDAs(TOKENS.ASDF).pool.toString();

/**
 * Fetch and update Top 100 ASDF Holders
 */
async function updateAsdfHolders(deps) {
    const { connection, globalState } = deps;

    try {
        if (!TOKENS.ASDF) {
            logger.warn("ASDF Token address not configured in constants.");
            return;
        }

        // v27.6: use the shared, program-agnostic holder scan. This previously queried
        // TOKEN_PROGRAM_ID only, with an unresolved "if ASDF is Token-2022, switch programId"
        // caveat -- meaning that if ASDF is Token-2022 the 2x multiplier applied to nobody.
        const top100 = await fetchTopHoldersByBalance(TOKENS.ASDF.toBase58(), {
            topN: 100,
            exclude: [WALLETS.PUMP_LIQUIDITY, ASDF_BONDING_CURVE_STR, ASDF_AMM_POOL_STR],
            caller: 'ASDF Sync',
            connection
        });

        // v27.6: never overwrite a good list with a bad scan. Previously a failed or
        // zero-result scan still wrote its empty array, wiping the multiplier for everyone
        // until the next successful run.
        if (top100 === null) {
            logger.warn('ASDF Sync: holder scan failed, keeping previous Top 100 list');
            return;
        }
        if (top100.length === 0) {
            logger.warn('ASDF Sync: holder scan returned no holders, keeping previous Top 100 list');
            return;
        }

        // Update Global State
        // We keep the property name 'asdfTop50Holders' to maintain compatibility
        // with other modules, but it now contains 100 items.
        globalState.asdfTop50Holders = new Set(top100);

        logger.info(`ASDF Sync: Updated Top 100 Holders. Tracking ${top100.length}.`);

    } catch (e) {
        logger.error("ASDF Sync Failed", { error: e.message });
    }
}

/**
 * Start the ASDF sync interval
 */
function start(deps) {
    // Run immediately
    updateAsdfHolders(deps);

    setInterval(() => updateAsdfHolders(deps), ASDF_SYNC_INTERVAL);
    logger.info(`ASDF Sync started (${ASDF_SYNC_INTERVAL / 1000}s interval)`);
}

module.exports = { updateAsdfHolders, start };
