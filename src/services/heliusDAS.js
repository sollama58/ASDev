/**
 * Helius DAS API helpers
 * Shared utilities for the Helius Digital Asset Standard API
 */
const axios = require('axios');
const config = require('../config/env');
const logger = require('./logger');

/**
 * Fetch token accounts using Helius DAS getTokenAccounts with pagination.
 * Handles tokens with many holders that exceed getProgramAccounts limits.
 *
 * @param {string} mint - Token mint address
 * @param {number} limit - Max accounts to fetch (default 250)
 * @param {string} [caller] - Label for log messages
 * @returns {Promise<Array<{owner: string, balance: string}>|null>} null on failure
 */
async function fetchTokenAccountsHeliusDAS(mint, limit = 250, caller = 'DAS') {
    if (!config.HELIUS_API_KEY) {
        logger.warn(`[${caller}] No HELIUS_API_KEY configured, cannot use DAS API`);
        return null;
    }

    const accounts = [];
    let page = 1;
    // Helius DAS supports up to 1000 per page — fetch in one request when possible
    const pageSize = 1000;

    try {
        while (accounts.length < limit) {
            const response = await axios.post(
                `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                {
                    jsonrpc: '2.0',
                    id: 'token-accounts',
                    method: 'getTokenAccounts',
                    params: {
                        mint,
                        page,
                        limit: pageSize,
                        options: { showZeroBalance: false }
                    }
                },
                { timeout: 15000 }
            );

            // Handle both wrapped (jsonrpc result) and direct response formats
            const result = response.data?.result || response.data;
            const tokenAccounts = result?.token_accounts || [];

            if (tokenAccounts.length === 0) {
                if (page === 1) {
                    logger.debug(`[${caller}] Helius DAS returned 0 accounts for ${mint.slice(0, 8)} (page 1)`, {
                        hasResult: !!response.data?.result,
                        directData: !!response.data?.token_accounts,
                        responseKeys: Object.keys(response.data || {}).slice(0, 5)
                    });
                }
                break;
            }

            for (const acc of tokenAccounts) {
                if (accounts.length >= limit) break;
                const owner = acc.owner;
                const amount = acc.amount ?? acc.tokenAmount?.amount ?? acc.balance;
                if (owner && amount !== undefined && amount !== null && amount !== 0 && amount !== '0') {
                    accounts.push({ owner, balance: amount.toString() });
                }
            }

            if (tokenAccounts.length < pageSize) break;

            page++;
            await new Promise(r => setTimeout(r, 100));
        }

        if (accounts.length > 0) {
            logger.debug(`[${caller}] Helius DAS found ${accounts.length} accounts for ${mint.slice(0, 8)}`);
        }

        return accounts;
    } catch (e) {
        logger.warn(`[${caller}] Helius DAS API failed for ${mint.slice(0, 8)}: ${e.message}`);
        return null;
    }
}

module.exports = { fetchTokenAccountsHeliusDAS };
