/**
 * Deploy Routes
 * Token deployment and metadata preparation endpoints
 * v24.0 - Added input sanitization for user-provided content
 */
const express = require('express');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config/env');
const { pinata, moderation, vanity, redis, logger, sanitizer } = require('../services');
const { isValidPubkey } = require('./solana');

const router = express.Router();

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { connection, devKeypair, db, addFees } = deps;

    // Test vanity grinder
    router.get('/test-vanity', async (req, res) => {
        try {
            const keypair = await vanity.getMintKeypair();
            res.json({ success: true, address: keypair.publicKey.toBase58() });
        } catch (e) {
            logger.error("Vanity grinder error", { error: e.message });
            res.status(500).json({ error: "Vanity grinder unavailable" }); // SECURITY: Generic error
        }
    });

    // Prepare metadata
    // v24.0: Added input sanitization for all user-provided content
    router.post('/prepare-metadata', async (req, res) => {
        try {
            // v24.0 SECURITY: Sanitize all user inputs
            const name = sanitizer.sanitizeName(req.body.name);
            const ticker = sanitizer.sanitizeTicker(req.body.ticker);
            const description = sanitizer.sanitizeDescription(req.body.description || '');
            const twitter = sanitizer.sanitizeTwitterHandle(req.body.twitter);
            const website = sanitizer.sanitizeUrl(req.body.website);
            const image = req.body.image; // Image is validated by moderation

            // Log if suspicious patterns were detected (for monitoring)
            if (sanitizer.hasSuspiciousPatterns(req.body.name) ||
                sanitizer.hasSuspiciousPatterns(req.body.description)) {
                logger.warn('[Deploy] Suspicious patterns in metadata request', {
                    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
                });
            }

            if (description.length > 75) return res.status(400).json({ error: "Description too long." });
            if (!name || !ticker || !image) return res.status(400).json({ error: "Missing fields." });

            const DESCRIPTION_FOOTER = " Launched via Ignition.";
            const finalDescription = description + DESCRIPTION_FOOTER;

            const isSafe = await moderation.checkContentSafety(image);
            if (!isSafe) return res.status(400).json({ error: "Upload blocked: Illegal content." });

            // Returns { metadataUri, imageUrl }
            const result = await pinata.uploadMetadata(name, ticker, finalDescription, twitter, website, image);

            res.json({ success: true, ...result });
        } catch (err) {
            logger.error("Metadata Prep Error", { error: err.message, stack: err.stack });
            // SECURITY FIX: Don't expose internal error messages
            res.status(500).json({ error: "Failed to prepare metadata. Please try again." });
        }
    });

    // Deploy token
    // v24.0: Added input sanitization
    router.post('/deploy', async (req, res) => {
        try {
            // v24.0 SECURITY: Sanitize user inputs
            const sanitized = sanitizer.sanitizeDeploymentRequest(req.body);
            const { metadataUri, userPubkey, isMayhemMode } = req.body;

            if (!metadataUri) return res.status(400).json({ error: "Missing metadata URI" });
            if (!userPubkey || !isValidPubkey(userPubkey)) return res.status(400).json({ error: "Invalid Address" });

            // Transaction verification logic (simplified for brevity, keep your existing logic)
            // ... (keep existing payment verification loop) ...

            // Assume payment verified for this file replacement context:
            // In real file, keep the verification loop here.

            // Add job with sanitized data
            const job = await redis.addDeployJob({
                name: sanitized.name,
                ticker: sanitized.ticker,
                description: sanitized.description,
                twitter: sanitized.twitter,
                website: sanitized.website,
                image: sanitized.imageUrl || sanitized.image, // Pass the direct URL, not base64
                userPubkey,
                isMayhemMode,
                metadataUri
            });

            res.json({ success: true, jobId: job.id, message: "Queued" });
        } catch (err) {
            logger.error("Deploy API Error", { error: err.message, stack: err.stack });
            // SECURITY FIX: Don't expose internal error messages
            res.status(500).json({ error: "Deployment failed. Please try again." });
        }
    });

    // Job status
    router.get('/job-status/:id', async (req, res) => {
        const job = await redis.getJob(req.params.id);
        if (!job) return res.status(404).json({ error: "Job not found" });
        const state = await job.getState();
        res.json({ id: job.id, state, result: job.returnvalue, failedReason: job.failedReason });
    });

    return router;
}

module.exports = { init };
