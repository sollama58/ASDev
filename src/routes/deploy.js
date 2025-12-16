/**
 * Deploy Routes
 * Token deployment and metadata preparation endpoints
 */
const express = require('express');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config/env');
const { pinata, moderation, vanity, redis, logger } = require('../services');
const { isValidPubkey } = require('./solana');

const router = express.Router();

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

            const descInput = description || "";
            if (descInput.length > 75) return res.status(400).json({ error: "Description too long." });
            if (!name || !ticker || !image) return res.status(400).json({ error: "Missing fields." });

            const DESCRIPTION_FOOTER = " Launched via Ignition.";
            const finalDescription = descInput + DESCRIPTION_FOOTER;

            const isSafe = await moderation.checkContentSafety(image);
            if (!isSafe) return res.status(400).json({ error: "Upload blocked: Illegal content." });

            // Returns { metadataUri, imageUrl }
            const result = await pinata.uploadMetadata(name, ticker, finalDescription, twitter, website, image);
            
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
            const { name, ticker, description, twitter, website, metadataUri, imageUrl, userTx, userPubkey, isMayhemMode } = req.body;

            if (!metadataUri) return res.status(400).json({ error: "Missing metadata URI" });
            if (!userPubkey || !isValidPubkey(userPubkey)) return res.status(400).json({ error: "Invalid Address" });
            
            // Transaction verification logic (simplified for brevity, keep your existing logic)
            // ... (keep existing payment verification loop) ...
            
            // Assume payment verified for this file replacement context:
            // In real file, keep the verification loop here.
            
            // Add job with explicit imageUrl
            const job = await redis.addDeployJob({
                name, ticker, description, twitter, website, 
                image: imageUrl, // Pass the direct URL, not base64
                userPubkey, isMayhemMode, metadataUri
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

module.exports = { init };
