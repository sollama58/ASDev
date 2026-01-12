/**
 * Deploy Routes
 * Token deployment and metadata preparation endpoints
 * v24.0 - Added input sanitization for user-provided content
 * v25.1 - Imgur URL support (user uploads to Imgur, provides URL)
 * v25.4 - Restored payment verification logic
 */
const express = require('express');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config/env');
const { pinata, vanity, redis, logger, sanitizer } = require('../services');
const { isValidPubkey } = require('./solana');

const router = express.Router();

// v25.1: Allowed image hosting domains
const ALLOWED_IMAGE_DOMAINS = [
    'i.imgur.com',           // Imgur direct image links
    'imgur.com',             // Imgur
    'imagedelivery.net',     // Cloudflare Images (legacy support)
    'cloudflare.com',        // Cloudflare (legacy support)
];

/**
 * v25.1: Validate image URL is from an allowed domain
 */
function isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;

    try {
        const parsed = new URL(url);

        // Must be HTTPS
        if (parsed.protocol !== 'https:') return false;

        // Check against allowed domains
        const hostname = parsed.hostname.toLowerCase();
        return ALLOWED_IMAGE_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
    } catch (e) {
        return false;
    }
}

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
    // v25.1: Now accepts imageUrl from Imgur (user uploads there first)
    router.post('/prepare-metadata', async (req, res) => {
        try {
            // v24.0 SECURITY: Sanitize all user inputs
            const name = sanitizer.sanitizeName(req.body.name);
            const ticker = sanitizer.sanitizeTicker(req.body.ticker);
            const description = sanitizer.sanitizeDescription(req.body.description || '');
            const twitter = sanitizer.sanitizeTwitterHandle(req.body.twitter);
            const website = sanitizer.sanitizeUrl(req.body.website);

            // v25.1: Accept imageUrl from Imgur
            // User uploads to Imgur themselves - Imgur handles content moderation
            const imageUrl = req.body.imageUrl;

            // Log if suspicious patterns were detected (for monitoring)
            if (sanitizer.hasSuspiciousPatterns(req.body.name) ||
                sanitizer.hasSuspiciousPatterns(req.body.description)) {
                logger.warn('[Deploy] Suspicious patterns in metadata request', {
                    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
                });
            }

            if (description.length > 75) return res.status(400).json({ error: "Description too long." });
            if (!name || !ticker || !imageUrl) return res.status(400).json({ error: "Missing fields." });

            // v25.1: Validate imageUrl is from allowed domain (Imgur, etc.)
            if (!isValidImageUrl(imageUrl)) {
                logger.warn('[Deploy] Invalid image URL rejected', { imageUrl: imageUrl.substring(0, 50) });
                return res.status(400).json({ error: "Invalid image URL. Please use Imgur (i.imgur.com)." });
            }

            const DESCRIPTION_FOOTER = " Launched via Ignition.";
            const finalDescription = description + DESCRIPTION_FOOTER;

            // v25.1: No server-side moderation - Imgur handles it
            // Just upload metadata with the Imgur image URL
            const result = await pinata.uploadMetadata(name, ticker, finalDescription, twitter, website, imageUrl);

            logger.info('[Deploy] Metadata prepared', { name, ticker, imageUrl: imageUrl.substring(0, 50) });

            res.json({ success: true, ...result });
        } catch (err) {
            logger.error("Metadata Prep Error", { error: err.message, stack: err.stack });
            // SECURITY FIX: Don't expose internal error messages
            res.status(500).json({ error: "Failed to prepare metadata. Please try again." });
        }
    });

    // Deploy token
    // v24.0: Added input sanitization
    // v25.4: Restored payment verification logic
    router.post('/deploy', async (req, res) => {
        try {
            // v24.0 SECURITY: Sanitize user inputs
            const sanitized = sanitizer.sanitizeDeploymentRequest(req.body);
            const { metadataUri, userTx, userPubkey, isMayhemMode } = req.body;

            if (!metadataUri) return res.status(400).json({ error: "Missing metadata URI" });
            if (!userPubkey || !isValidPubkey(userPubkey)) return res.status(400).json({ error: "Invalid Address" });
            if (!userTx || typeof userTx !== 'string') return res.status(400).json({ error: "Invalid transaction signature" });

            // v25.4: Check for duplicate transaction
            try {
                await db.run('INSERT INTO transactions (signature, "userPubkey") VALUES ($1, $2)', [userTx, userPubkey]);
            } catch (dbErr) {
                if (dbErr.message.includes('UNIQUE') || dbErr.message.includes('duplicate')) {
                    return res.status(400).json({ error: "Transaction already used." });
                }
                throw dbErr;
            }

            // v25.4: Payment verification loop
            let validPayment = false;
            for (let i = 0; i < 15; i++) {
                try {
                    const txInfo = await connection.getParsedTransaction(userTx, {
                        commitment: "confirmed",
                        maxSupportedTransactionVersion: 0
                    });

                    if (txInfo) {
                        validPayment = txInfo.transaction.message.instructions.some(ix => {
                            if (ix.programId.toString() !== '11111111111111111111111111111111') return false;
                            if (!ix.parsed || ix.parsed.type !== 'transfer') return false;
                            return ix.parsed.info.destination === devKeypair.publicKey.toString() &&
                                   ix.parsed.info.lamports >= config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL;
                        });
                        if (validPayment) break;
                    }
                } catch (txErr) {
                    logger.debug('[Deploy] TX fetch attempt failed', { attempt: i, error: txErr.message });
                }
                await new Promise(r => setTimeout(r, 2000));
            }

            if (!validPayment) {
                // Remove the transaction record since payment failed
                await db.run('DELETE FROM transactions WHERE signature = $1', [userTx]);
                logger.warn('[Deploy] Payment verification failed', { userPubkey, userTx: userTx.substring(0, 20) });
                return res.status(400).json({ error: "Payment verification failed or timed out." });
            }

            // Record the fee
            await addFees(config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL);

            // v25.4: Debug logging for image URL tracking
            const imageToSend = sanitized.imageUrl || sanitized.image;
            logger.info('[Deploy] Image URL debug', {
                rawImageUrl: req.body.imageUrl ? req.body.imageUrl.substring(0, 80) : 'NULL',
                sanitizedImageUrl: sanitized.imageUrl ? sanitized.imageUrl.substring(0, 80) : 'NULL',
                sanitizedImage: sanitized.image ? String(sanitized.image).substring(0, 80) : 'NULL',
                imageToSend: imageToSend ? imageToSend.substring(0, 80) : 'NULL'
            });

            // Add job with sanitized data
            const job = await redis.addDeployJob({
                name: sanitized.name,
                ticker: sanitized.ticker,
                description: sanitized.description,
                twitter: sanitized.twitter,
                website: sanitized.website,
                image: imageToSend, // Pass the direct URL
                userPubkey,
                isMayhemMode,
                metadataUri
            });

            logger.info('[Deploy] Job queued', { jobId: job.id, userPubkey, name: sanitized.name, hasImage: !!imageToSend });
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
