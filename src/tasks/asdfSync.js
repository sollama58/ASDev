/**
 * ASDF Token Sync Task
 * Updates the top 50 ASDF token holders
 */
const { PublicKey } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS } = require('../config/constants');
const { logger, redis } = require('../services');

/**
 * Sync ASDF top 50 holders
 */
async function syncAsdfHolders(deps) {
    const { connection, globalState } = deps;

    try {
        const fetchAsdfHolders = async () => {
            const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: TOKENS.ASDF.toBase58() } }
                ],
                encoding: 'base64'
            });

            const holders = accounts.map(acc => {
                const data = Buffer.from(acc.account.data);
                const amount = new BN(data.slice(64, 72), 'le');
                const owner = new PublicKey(data.slice(32, 64)).toString();
                return { owner, amount };
            })
            // Filter: must hold > 1.0 token (6 decimals = 1,000,000)
            .filter(h => h.amount.gt(new BN(1000000)))
            .sort((a, b) => b.amount.cmp(a.amount));

            return holders.slice(0, 50).map(h => h.owner);
        };

        // Cache for 5 minutes
        const top50 = await redis.smartCache('asdf_top_50', 300, fetchAsdfHolders);
        globalState.asdfTop50Holders = new Set(top50);

        logger.info(`Updated ASDF Top 50 Holders. Count: ${globalState.asdfTop50Holders.size}`);
    } catch (e) {
        logger.error(`ASDF Sync Failed: ${e.message}`);
    }
}

/**
 * Start the ASDF sync interval
 */
function start(deps) {
    setInterval(() => syncAsdfHolders(deps), config.ASDF_UPDATE_INTERVAL);
    setTimeout(() => syncAsdfHolders(deps), 5000);
    logger.info("ASDF sync started");
}

module.exports = { syncAsdfHolders, start };
