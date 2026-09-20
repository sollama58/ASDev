/**
 * ASDF Token Holder Sync
 * Updates the list of Top 100 ASDF holders for the 2x Multiplier
 */
const { PublicKey } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, WALLETS } = require('../config/constants');
const { logger } = require('../services');

let isSyncing = false;

// SPL token account layout: mint(0-32) owner(32-64) amount(64-72). Only owner and amount are
// used, so ask the RPC for just those 40 bytes instead of the whole 165-byte account.
const HOLDER_DATA_SLICE = { offset: 32, length: 40 };

/**
 * Fetch and update Top 100 ASDF Holders
 */
async function updateAsdfHolders(deps) {
    const { connection, globalState } = deps;

    if (isSyncing) {
        logger.warn("ASDF Sync: previous run still in progress, skipping this tick");
        return;
    }
    isSyncing = true;

    try {
        if (!TOKENS.ASDF) {
            logger.warn("ASDF Token address not configured in constants.");
            return;
        }

        // We use getProgramAccounts to bypass the 20-account limit of getTokenLargestAccounts
        // Assuming ASDF is a standard SPL Token (TOKEN_PROGRAM_ID)
        // If ASDF is Token-2022, switch programId to PROGRAMS.TOKEN_2022
        const programId = TOKEN_PROGRAM_ID; 
        const mintPubkey = new PublicKey(TOKENS.ASDF);

        const accounts = await connection.getProgramAccounts(programId, {
            filters: [
                { dataSize: 165 }, // Standard SPL Token Account size
                { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } }
            ],
            dataSlice: HOLDER_DATA_SLICE,
            encoding: 'base64'
        });

        const parsedAccounts = accounts.map(acc => {
            const data = Buffer.from(acc.account.data);
            if (data.length < HOLDER_DATA_SLICE.length) return null;
            // Sliced layout: Owner(0-32), Amount(32-40)
            const owner = new PublicKey(data.slice(0, 32)).toString();
            const amount = new BN(data.slice(32, 40), 'le');
            return { owner, amount };
        })
        .filter(a => a !== null)
        .sort((a, b) => b.amount.cmp(a.amount)); // Descending sort

        // Extract Top 100
        const top100 = [];
        for (const acc of parsedAccounts) {
            if (top100.length >= 100) break;
            
            // Exclude LP pools or specific ignored wallets if necessary
            // (e.g. if Raydium pool holds tokens, we might want to skip it, 
            // but for now we count all non-zero holders)
            if (acc.amount.gt(new BN(0))) {
                top100.push(acc.owner);
            }
        }

        // Update Global State
        // We keep the property name 'asdfTop50Holders' to maintain compatibility 
        // with other modules, but it now contains 100 items.
        globalState.asdfTop50Holders = new Set(top100);

        logger.info(`ASDF Sync: Updated Top 100 Holders. Found ${accounts.length} total, tracking top ${top100.length}.`);

    } catch (e) {
        logger.error("ASDF Sync Failed", { error: e.message });
    } finally {
        isSyncing = false;
    }
}

/**
 * Start the ASDF sync loop.
 * Runs immediately, then re-arms after each run using ASDF_UPDATE_INTERVAL.
 */
function start(deps) {
    const loop = async () => {
        await updateAsdfHolders(deps);
        setTimeout(loop, config.ASDF_UPDATE_INTERVAL);
    };
    loop();
    logger.info(`ASDF Sync started (${config.ASDF_UPDATE_INTERVAL / 1000}s interval)`);
}

module.exports = { updateAsdfHolders, start };
