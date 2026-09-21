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
const { pinata, redis, logger, sanitizer, imageUtils } = require('../services');
const { isValidPubkey } = require('./solana');

const router = express.Router();

// v25.1: Allowed image hosting domains
const ALLOWED_IMAGE_DOMAINS = [
    'i.imgur.com',           // Imgur direct image links only (not gallery pages)
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
                    ip: req.ip
                });
            }

            if (description.length > 75) return res.status(400).json({ error: "Description too long." });
            if (!name || !ticker || !imageUrl) return res.status(400).json({ error: "Missing fields." });

            // v25.1: Validate imageUrl is from allowed domain (Imgur, etc.)
            if (!isValidImageUrl(imageUrl)) {
                logger.warn('[Deploy] Invalid image URL rejected', { imageUrl: typeof imageUrl === 'string' ? imageUrl.substring(0, 50) : String(imageUrl) });
                return res.status(400).json({ error: "Invalid image URL. Please use Imgur (i.imgur.com)." });
            }

            // v25.15: Normalize image URL before storing in metadata
            // This converts imgur.com/xxx -> i.imgur.com/xxx.png
            const normalizedImageUrl = imageUtils.normalizeImageUrl(imageUrl) || imageUrl;

            const DESCRIPTION_FOOTER = " Launched via ShitPad.";
            const finalDescription = description + DESCRIPTION_FOOTER;

            // v25.1: No server-side moderation - Imgur handles it
            // Just upload metadata with the normalized Imgur image URL
            const result = await pinata.uploadMetadata(name, ticker, finalDescription, twitter, website, normalizedImageUrl);

            logger.info('[Deploy] Metadata prepared', {
                name,
                ticker,
                originalImage: imageUrl.substring(0, 50),
                normalizedImage: normalizedImageUrl.substring(0, 50)
            });

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
            const { metadataUri, userTx, userPubkey, isMayhemMode } = sanitized;

            if (!metadataUri) return res.status(400).json({ error: "Missing metadata URI" });
            if (!userPubkey || !isValidPubkey(userPubkey)) return res.status(400).json({ error: "Invalid Address" });
            if (!userTx || typeof userTx !== 'string') return res.status(400).json({ error: "Invalid transaction signature" });

            // v25.4: Payment verification loop (runs BEFORE inserting transaction record)
            // H-2 FIX: Insert only after confirmed payment to prevent orphaned records on crash
            //
            // v28.2 RPC COST: wait for confirmation with getSignatureStatuses — a cheap status
            // lookup — and fetch the full parsed transaction exactly once, after it lands.
            // Previously every 2s poll was a getParsedTransaction, up to 15 heavyweight calls
            // per deploy while the user's payment was still propagating.
            let validPayment = false;
            let landed = false;
            for (let i = 0; i < 15 && !landed; i++) {
                try {
                    const { value } = await connection.getSignatureStatuses([userTx]);
                    const status = value?.[0];
                    if (status) {
                        // H-1 FIX: a transaction can be confirmed yet reverted on-chain
                        if (status.err) {
                            logger.warn('[Deploy] TX found but has on-chain error', { userTx: userTx.substring(0, 20), err: JSON.stringify(status.err) });
                            break;
                        }
                        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                            landed = true;
                            break;
                        }
                    }
                } catch (txErr) {
                    logger.debug('[Deploy] TX status attempt failed', { attempt: i, error: txErr.message });
                }
                await new Promise(r => setTimeout(r, 2000));
            }

            if (landed) {
                try {
                    const txInfo = await connection.getParsedTransaction(userTx, {
                        commitment: "confirmed",
                        maxSupportedTransactionVersion: 0
                    });
                    if (txInfo && !txInfo.meta?.err) {
                        validPayment = txInfo.transaction.message.instructions.some(ix => {
                            if (ix.programId.toString() !== '11111111111111111111111111111111') return false;
                            if (!ix.parsed || ix.parsed.type !== 'transfer') return false;
                            return ix.parsed.info.destination === devKeypair.publicKey.toString() &&
                                   ix.parsed.info.lamports >= config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL;
                        });
                    }
                } catch (txErr) {
                    logger.debug('[Deploy] TX parse failed', { error: txErr.message });
                }
            }

            if (!validPayment) {
                logger.warn('[Deploy] Payment verification failed', { userPubkey, userTx: userTx.substring(0, 20) });
                return res.status(400).json({ error: "Payment verification failed or timed out." });
            }

            // C-2 FIX: Insert transaction record AFTER verification — no orphaned records, no DELETE on failure
            // If the same signature is submitted twice after a successful verification, the UNIQUE constraint blocks it
            try {
                await db.run('INSERT INTO transactions (signature, "userPubkey") VALUES ($1, $2)', [userTx, userPubkey]);
            } catch (dbErr) {
                if (dbErr.message.includes('UNIQUE') || dbErr.message.includes('duplicate')) {
                    return res.status(400).json({ error: "Transaction already used." });
                }
                throw dbErr;
            }

            // v25.15: Normalize image URL before passing to worker
            // This handles imgur.com/xxx -> i.imgur.com/xxx.png conversion
            const rawImageUrl = sanitized.imageUrl || sanitized.image;
            const imageToSend = rawImageUrl ? (imageUtils.normalizeImageUrl(rawImageUrl) || rawImageUrl) : null;

            logger.info('[Deploy] Image URL debug', {
                rawImageUrl: req.body.imageUrl ? req.body.imageUrl.substring(0, 80) : 'NULL',
                sanitizedImageUrl: sanitized.imageUrl ? sanitized.imageUrl.substring(0, 80) : 'NULL',
                normalizedImage: imageToSend ? imageToSend.substring(0, 80) : 'NULL',
                wasNormalized: rawImageUrl !== imageToSend
            });

            // Add job with sanitized data
            //
            // v28.2 MONEY: if enqueueing fails (Redis blip, queue not initialised), the user
            // has already paid and their signature has already been recorded as used — so
            // without this they would lose the fee AND be unable to resubmit. Nothing has
            // been launched at this point, so releasing the signature is safe: they simply
            // retry with the same payment. The fee is recorded only once the job is queued,
            // so a failed enqueue leaves no phantom revenue in the stats either.
            let job;
            try {
                job = await redis.addDeployJob({
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
            } catch (queueErr) {
                await db.run('DELETE FROM transactions WHERE signature = $1', [userTx]).catch(() => {});
                logger.error('[Deploy] Could not queue launch after verified payment — signature released for retry', {
                    userPubkey, userTx: userTx.substring(0, 20), error: queueErr.message
                });
                return res.status(503).json({ error: "Launch queue unavailable. Your payment was verified — please retry with the same transaction." });
            }

            // Record the fee
            await addFees(config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL);

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
        try {
            const job = await redis.getJob(req.params.id);
            if (!job) return res.status(404).json({ error: "Job not found" });
            const state = await job.getState();
            res.json({ id: job.id, state, progress: job.progress, result: job.returnvalue, failedReason: job.failedReason });
        } catch (err) {
            logger.error('[Deploy] Job status error', { error: err.message, jobId: req.params.id });
            res.status(500).json({ error: "Failed to fetch job status" });
        }
    });

    return router;
}

module.exports = { init };
