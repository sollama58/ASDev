/**
 * Solana Routes
 * Balance and blockhash endpoints
 */
const express = require('express');
const { PublicKey } = require('@solana/web3.js');

const router = express.Router();

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
            const balance = await connection.getBalance(new PublicKey(pubkey));
            res.json({ balance });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get blockhash
    router.get('/blockhash', async (req, res) => {
        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
            res.json({ blockhash, lastValidBlockHeight });
        } catch (err) {
            res.status(500).json({ error: "Failed to get blockhash" });
        }
    });

    return router;
}

module.exports = { init, isValidPubkey };
