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
            encoding: 'base64'
        });

        const parsedAccounts = accounts.map(acc => {
            try {
                // Handle base64 array tuple format from encoding: 'base64'
                // acc.account.data is ['base64string', 'base64'], not a raw Buffer
                const data = Array.isArray(acc.account.data)
                    ? Buffer.from(acc.account.data[0], 'base64')
                    : Buffer.from(acc.account.data);
                if (data.length < 72) {
                    logger.debug('ASDF Sync: Skipping malformed account data', { length: data.length });
                    return null;
                }
                // SPL Layout: Mint(0-32), Owner(32-64), Amount(64-72)
                const owner = new PublicKey(data.slice(32, 64)).toString();
                const amount = new BN(data.slice(64, 72), 'le');
                return { owner, amount };
            } catch (e) {
                logger.debug('ASDF Sync: Failed to parse account', { error: e.message });
                return null;
            }
        })
        .filter(acc => acc !== null) // BUG FIX: Filter out failed parses
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
    }
}

/**
 * Start the ASDF sync interval
 */
function start(deps) {
    // Run immediately
    updateAsdfHolders(deps);
    
    // Then run every 2 minutes
    setInterval(() => updateAsdfHolders(deps), 2 * 60 * 1000);
    logger.info("ASDF Sync started (2 min interval)");
}

module.exports = { updateAsdfHolders, start };
