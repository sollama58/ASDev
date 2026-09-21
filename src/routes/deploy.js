/**
 * Deploy Routes
 * Token deployment and metadata preparation endpoints
 */
const express = require('express');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const config = require('../config/env');
const { pinata, moderation, vanity, redis, logger } = require('../services');
const { isValidPubkey } = require('./solana');

const router = express.Router();

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const PAYMENT_POLL_ATTEMPTS = 15;
const PAYMENT_POLL_DELAY_MS = 2000;

// On-chain limits of the pump.fun create instruction (Metaplex token metadata).
// Anything longer fails on chain after the vanity keypair and the fee are spent.
const MAX_NAME_BYTES = 32;
const MAX_SYMBOL_BYTES = 10;
const MAX_URI_BYTES = 200;
const MAX_DESCRIPTION_CHARS = 75;
const MAX_LINK_CHARS = 200;
const PINATA_GATEWAY_PREFIX = 'https://gateway.pinata.cloud/ipfs/';

const byteLength = (str) => Buffer.byteLength(String(str), 'utf8');

/**
 * Validate the name and ticker shared by /prepare-metadata and /deploy.
 * Returns an error message, or null when they are acceptable.
 */
function validateNameAndTicker(name, ticker) {
    if (typeof name !== 'string' || name.trim().length === 0) return "Missing token name.";
    if (typeof ticker !== 'string' || ticker.trim().length === 0) return "Missing ticker.";
    if (byteLength(name) > MAX_NAME_BYTES) return `Name must be at most ${MAX_NAME_BYTES} bytes.`;
    if (byteLength(ticker) > MAX_SYMBOL_BYTES) return `Ticker must be at most ${MAX_SYMBOL_BYTES} bytes.`;
    return null;
}

/**
 * Validate the optional free-text fields that end up in the metadata JSON.
 */
function validateOptionalFields({ description, twitter, website }) {
    if (description && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_CHARS)) {
        return "Description too long.";
    }
    for (const [label, value] of [['Twitter', twitter], ['Website', website]]) {
        if (value && (typeof value !== 'string' || value.length > MAX_LINK_CHARS)) return `${label} too long.`;
    }
    return null;
}

/**
 * The metadata URI must be one this server produced. Its shape is checked here;
 * /deploy additionally checks that /prepare-metadata actually issued it.
 */
function isServerMetadataUri(uri) {
    return typeof uri === 'string'
        && uri.startsWith(PINATA_GATEWAY_PREFIX)
        && uri.length > PINATA_GATEWAY_PREFIX.length
        && byteLength(uri) <= MAX_URI_BYTES;
}

/**
 * A transaction signature is 64 bytes, base58 encoded.
 */
function isValidSignature(sig) {
    if (typeof sig !== 'string' || sig.length < 80 || sig.length > 90) return false;
    try {
        return bs58.decode(sig).length === 64;
    } catch {
        return false;
    }
}

/**
 * True when the parsed transaction succeeded on-chain and contains a
 * System Program transfer from `payer` to `recipient` of at least `minLamports`.
 */
function hasFeePayment(txInfo, payer, recipient, minLamports) {
    if (!txInfo || !txInfo.meta || txInfo.meta.err) return false;
    const instructions = txInfo.transaction?.message?.instructions || [];
    return instructions.some(ix => {
        if (ix.programId?.toString() !== SYSTEM_PROGRAM_ID) return false;
        if (!ix.parsed || ix.parsed.type !== 'transfer') return false;
        const info = ix.parsed.info || {};
        return info.source === payer &&
               info.destination === recipient &&
               Number(info.lamports) >= minLamports;
    });
}

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { connection, devKeypair, db, addFees } = deps;

    // Test vanity grinder
    router.get('/test-vanity', async (req, res) => {
        // ... (existing code, unchanged)
        try {
            const keypair = await vanity.getMintKeypair();
            res.json({ success: true, address: keypair.publicKey.toBase58() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Prepare metadata
    router.post('/prepare-metadata', async (req, res) => {
        try {
            let { name, ticker, description, twitter, website, image } = req.body;

            const fieldError = validateNameAndTicker(name, ticker) || validateOptionalFields({ description, twitter, website });
            if (fieldError) return res.status(400).json({ error: fieldError });
            if (!image || typeof image !== 'string') return res.status(400).json({ error: "Missing fields." });

            const descInput = description || "";
            const DESCRIPTION_FOOTER = " Launched via Ignition.";
            const finalDescription = descInput + DESCRIPTION_FOOTER;

            const isSafe = await moderation.checkContentSafety(image);
            if (!isSafe) return res.status(400).json({ error: "Upload blocked: Illegal content." });

            // Returns { metadataUri, imageUrl }
            const result = await pinata.uploadMetadata(name, ticker, finalDescription, twitter, website, image);

            // Record that this URI passed moderation here, so /deploy can refuse any other.
            await redis.rememberPreparedMetadata(result.metadataUri, { imageUrl: result.imageUrl });

            res.json({ success: true, ...result });
        } catch (err) {
            logger.error("Metadata Prep Error", { error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // Deploy token
    router.post('/deploy', async (req, res) => {
        try {
            // ACCEPT imageUrl explicitly
            const { name, ticker, description, twitter, website, metadataUri, userTx, userPubkey, isMayhemMode } = req.body;

            if (!metadataUri) return res.status(400).json({ error: "Missing metadata URI" });
            if (!isServerMetadataUri(metadataUri)) return res.status(400).json({ error: "Invalid metadata URI" });
            const fieldError = validateNameAndTicker(name, ticker) || validateOptionalFields({ description, twitter, website });
            if (fieldError) return res.status(400).json({ error: fieldError });
            if (!userPubkey || !isValidPubkey(userPubkey)) return res.status(400).json({ error: "Invalid Address" });
            if (!isValidSignature(userTx)) return res.status(400).json({ error: "Invalid transaction signature" });

            // Only metadata this server uploaded (and moderated) may be launched. The image
            // URL comes from that record too, never from the request body.
            const prepared = await redis.getPreparedMetadata(metadataUri);
            if (!prepared) return res.status(400).json({ error: "Metadata was not prepared by this server or has expired. Please start the launch again." });
            const imageUrl = prepared.imageUrl;

            const feeLamports = Math.round(config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL);
            const devWallet = devKeypair.publicKey.toString();

            // Reserve the signature first so the same payment cannot be submitted twice,
            // even by concurrent requests. UNIQUE(signature) rejects the second insert.
            try {
                await db.run(
                    'INSERT INTO transactions (signature, userPubkey, type, amount, timestamp) VALUES (?, ?, ?, ?, ?)',
                    [userTx, userPubkey, 'deployment', feeLamports, Date.now()]
                );
            } catch (dbErr) {
                if (dbErr.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: "Tx already used." });
                }
                throw dbErr;
            }

            // Wait for the payment to confirm, then check that it is a successful
            // System transfer FROM userPubkey TO the dev wallet for at least the fee.
            let validPayment = false;
            for (let i = 0; i < PAYMENT_POLL_ATTEMPTS; i++) {
                const txInfo = await connection.getParsedTransaction(userTx, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0
                });
                if (txInfo) {
                    validPayment = hasFeePayment(txInfo, userPubkey, devWallet, feeLamports);
                    break;
                }
                await new Promise(r => setTimeout(r, PAYMENT_POLL_DELAY_MS));
            }

            if (!validPayment) {
                // Release the reservation so a not-yet-confirmed payment can be retried.
                await db.run('DELETE FROM transactions WHERE signature = ?', [userTx]);
                return res.status(400).json({ error: "Payment verification failed or timed out." });
            }

            await addFees(feeLamports);

            // Add job with explicit imageUrl. userTx travels with the job so the
            // worker can refund only the verified payer if the launch fails.
            const job = await redis.addDeployJob({
                name, ticker, description, twitter, website, 
                image: imageUrl, // Pass the direct URL, not base64
                userPubkey, userTx, isMayhemMode: !!isMayhemMode, metadataUri
            });

            res.json({ success: true, jobId: job.id, message: "Queued" });
        } catch (err) {
            logger.error("Deploy API Error", { error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // Job status (unchanged)
    router.get('/job-status/:id', async (req, res) => {
        const job = await redis.getJob(req.params.id);
        if (!job) return res.status(404).json({ error: "Job not found" });
        const state = await job.getState();
        res.json({ id: job.id, state, result: job.returnvalue, failedReason: job.failedReason });
    });

    return router;
}

module.exports = { init, validateNameAndTicker, validateOptionalFields, isServerMetadataUri };
