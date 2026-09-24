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

/**
 * Fetch the top N holders of a mint, ranked by balance.
 *
 * v27.6: replaces the hand-rolled getProgramAccounts scans that asdfSync.js and
 * workers.js#initAsdfSyncWorker each carried their own slightly-different copy of. Those
 * queried TOKEN_PROGRAM_ID only, while every other holder scan in this codebase
 * (holderScanner) queries TOKEN *and* TOKEN_2022 -- so a Token-2022 mint
 * silently produced an empty holder list, and the multiplier it fed applied to nobody.
 *
 * DAS getTokenAccounts is program-agnostic, so it is the primary path. It also does not
 * return accounts in balance order, which is why this helper scans up to `maxScan` accounts
 * and sorts them itself rather than trusting the first page -- an earlier version took
 * whatever arbitrary accounts DAS happened to return first and called them the top N.
 *
 * @param {string} mint - Token mint address
 * @param {object} opts
 * @param {number} opts.topN - How many owners to return
 * @param {string[]} [opts.exclude] - Owner addresses to drop (LP, bonding curve, AMM pool)
 * @param {string} [opts.caller] - Label for log messages
 * @param {object} [opts.connection] - web3 Connection, enabling the RPC fallback
 * @param {number} [opts.maxScan] - Cap on accounts scanned before sorting
 * @returns {Promise<string[]|null>} Ranked owner addresses, or null if the lookup failed.
 *                                   An empty array means "scanned successfully, no holders".
 */
async function fetchTopHoldersByBalance(mint, opts = {}) {
    const {
        topN,
        exclude = [],
        caller = 'DAS',
        connection = null,
        maxScan = 20000
    } = opts;

    const excludeSet = new Set(exclude.filter(Boolean));
    let accounts = await fetchTokenAccountsHeliusDAS(mint, maxScan, caller);

    // null means the DAS call itself failed (or no API key). Fall back to RPC so a Helius
    // outage degrades rather than silently blanking the list.
    if (accounts === null && connection) {
        accounts = await fetchTokenAccountsViaRpc(mint, connection, caller);
    }

    if (accounts === null) return null;

    if (accounts.length >= maxScan) {
        logger.warn(`[${caller}] Holder scan hit the ${maxScan} account cap for ${mint.slice(0, 8)}; ranking may be incomplete`);
    }

    return accounts
        .filter(a => a.owner && !excludeSet.has(a.owner) && BigInt(a.balance || '0') > 0n)
        .sort((a, b) => {
            const diff = BigInt(b.balance || '0') - BigInt(a.balance || '0');
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        })
        .slice(0, topN)
        .map(a => a.owner);
}

/**
 * RPC fallback for fetchTopHoldersByBalance: query both token programs, exactly as
 * holderScanner does, and merge whichever succeed.
 */
async function fetchTokenAccountsViaRpc(mint, connection, caller) {
    const { PublicKey } = require('@solana/web3.js');
    const { PROGRAMS } = require('../config/constants');
    const mintPubkey = new PublicKey(mint);

    const query = async (programId, label) => {
        // Token-2022 accounts carry extensions, so they are >= 165 bytes rather than exactly
        // 165. memcmp on the mint at offset 0 is what actually scopes the query.
        const filters = [{ memcmp: { offset: 0, bytes: mintPubkey.toBase58() } }];
        if (label === 'TOKEN') filters.unshift({ dataSize: 165 });
        const res = await connection.getProgramAccounts(programId, { filters, encoding: 'base64' });
        return res.map(acc => {
            const data = Array.isArray(acc.account.data)
                ? Buffer.from(acc.account.data[0], 'base64')
                : Buffer.from(acc.account.data);
            if (data.length < 72) return null;
            // SPL layout: mint(0..32), owner(32..64), amount(64..72) little-endian u64
            return {
                owner: new PublicKey(data.slice(32, 64)).toString(),
                balance: data.readBigUInt64LE(64).toString()
            };
        }).filter(Boolean);
    };

    const results = await Promise.allSettled([
        query(PROGRAMS.TOKEN, 'TOKEN'),
        query(PROGRAMS.TOKEN_2022, 'TOKEN_2022')
    ]);

    if (results.every(r => r.status === 'rejected')) {
        logger.warn(`[${caller}] RPC holder fallback failed for both token programs`, {
            token: results[0].reason?.message,
            token2022: results[1].reason?.message
        });
        return null;
    }

    const merged = [];
    for (const r of results) {
        if (r.status === 'fulfilled') merged.push(...r.value);
    }
    logger.debug(`[${caller}] RPC holder fallback found ${merged.length} accounts for ${mint.slice(0, 8)}`);
    return merged;
}

module.exports = { fetchTokenAccountsHeliusDAS, fetchTopHoldersByBalance };
