/**
 * Solana Routes
 * Balance and blockhash endpoints
 */
const express = require('express');
const { PublicKey } = require('@solana/web3.js');

const router = express.Router();

// v27.6 RPC COST: both endpoints are unauthenticated by necessity -- the frontend needs them
// before a wallet is connected -- so each one used to turn a single HTTP request into a
// billable Helius call with nothing but the global rate limiter in between. Anyone could
// amplify our RPC spend by polling them. Short-TTL caching removes the amplification without
// changing behaviour: a blockhash stays valid for ~60-90s, so serving a 5s-old one is
// indistinguishable to callers, and a 10s-old balance is well inside what the UI already
// tolerates between its own refreshes.
const BALANCE_CACHE_TTL_MS = 10000;
const BLOCKHASH_CACHE_TTL_MS = 5000;
const MAX_BALANCE_CACHE_ENTRIES = 5000;

const balanceCache = new Map(); // pubkey -> { value, expiresAt }
let blockhashCache = null;      // { value, expiresAt }

function readCache(cache, key) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    if (hit) cache.delete(key);
    return null;
}

function writeCache(cache, key, value, ttlMs) {
    // Bounded so a flood of distinct pubkeys cannot grow this without limit. Map preserves
    // insertion order, so the first key is the oldest.
    if (cache.size >= MAX_BALANCE_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Validate Solana public key format
const isValidPubkey = (pubkey) => {
    if (!pubkey || typeof pubkey !== 'string') return false;
    try {
        new PublicKey(pubkey);
        return true;
    } catch {
        return false;
    }
};

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { connection } = deps;

    // Get balance
    router.get('/balance', async (req, res) => {
        try {
            const { pubkey } = req.query;
            if (!pubkey) {
                return res.status(400).json({ error: "Missing pubkey" });
            }
            if (!isValidPubkey(pubkey)) {
                return res.status(400).json({ error: "Invalid Solana address format" });
            }
            const cached = readCache(balanceCache, pubkey);
            if (cached !== null) {
                return res.json({ balance: cached, cached: true });
            }
            const balance = await connection.getBalance(new PublicKey(pubkey));
            writeCache(balanceCache, pubkey, balance, BALANCE_CACHE_TTL_MS);
            res.json({ balance });
        } catch (err) {
            // SECURITY: Don't expose internal error details
            res.status(500).json({ error: 'Failed to fetch balance' });
        }
    });

    // Get blockhash
    router.get('/blockhash', async (req, res) => {
        try {
            if (blockhashCache && blockhashCache.expiresAt > Date.now()) {
                return res.json({ ...blockhashCache.value, cached: true });
            }
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
            blockhashCache = {
                value: { blockhash, lastValidBlockHeight },
                expiresAt: Date.now() + BLOCKHASH_CACHE_TTL_MS
            };
            res.json({ blockhash, lastValidBlockHeight });
        } catch (err) {
            res.status(500).json({ error: "Failed to get blockhash" });
        }
    });

    return router;
}

module.exports = { init, isValidPubkey };
