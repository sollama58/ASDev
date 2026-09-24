/**
 * Deploy Routes
 * Token deployment and metadata preparation endpoints
 * v24.0 - Added input sanitization for user-provided content
 * v25.1 - Imgur URL support (user uploads to Imgur, provides URL)
 * v25.4 - Restored payment verification logic
 * v29.1 - Payment is bound to the payer and to a time window; the metadata URI is validated
 *         against an allowlist instead of being written to the chain verbatim.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config/env');
const { redis, logger, sanitizer, imageUtils } = require('../services');
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
 * v30.2: a transaction signature is 64 bytes, base58-encoded (87-88 chars). Checked before any
 * RPC call so a junk value cannot buy fifteen status polls.
 */
function isValidSignature(sig) {
    if (typeof sig !== 'string' || sig.length < 80 || sig.length > 90) return false;
    try {
        const bs58lib = require('bs58');
        const bs58 = bs58lib.default || bs58lib;
        return bs58.decode(sig).length === 64;
    } catch (e) {
        return false;
    }
}

/**
 * v30.2: the image checks shared by /prepare-metadata (the pre-payment preview) and /deploy
 * (which cannot trust that the client called the preview first).
 * @returns {Promise<{ok: true, url: string, contentType, bytes}|{ok: false, error: string}>}
 */
async function checkImage(imageUrl) {
    if (!isValidImageUrl(imageUrl)) {
        return { ok: false, error: "Invalid image URL. Please use Imgur (i.imgur.com)." };
    }
    const normalized = imageUtils.normalizeImageUrl(imageUrl) || imageUrl;
    const check = await imageUtils.verifyImageUrl(normalized, {
        maxBytes: config.IMAGE_MAX_BYTES,
        timeoutMs: config.IMAGE_FETCH_TIMEOUT_MS
    });
    if (!check.ok) return { ok: false, error: check.reason };
    return { ok: true, url: normalized, contentType: check.contentType, bytes: check.bytes };
}

// v30.2: /prepare-metadata fetches an image from Imgur on every call. It no longer pins
// anything, but it is still unauthenticated outbound work, so it gets its own tight limit.
const prepareLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many requests, please wait a moment' },
    standardHeaders: true,
    legacyHeaders: false
});

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { connection, signer, db, addFees } = deps;

    // Prepare metadata
    // v24.0: Added input sanitization for all user-provided content
    // v25.1: Now accepts imageUrl from Imgur (user uploads there first)
    /**
     * Validate a launch before the user pays.
     *
     * v30.2: this no longer pins anything. It used to upload the metadata JSON to our Pinata
     * account for anyone who asked, paid or not, and hand back a URI that /deploy then trusted
     * -- and /deploy accepted ANY IPFS URI on an allowed gateway, so a paying user could launch
     * a ShitPad coin whose metadata (and image) was any document they had pinned themselves,
     * sidestepping the Imgur-only rule. The metadata is now built and pinned by the launch job,
     * after payment, from the same sanitised fields. This endpoint just runs the checks, so a
     * bad image is still caught before the user pays.
     */
    router.post('/prepare-metadata', prepareLimiter, async (req, res) => {
        try {
            const name = sanitizer.sanitizeName(req.body.name);
            const ticker = sanitizer.sanitizeTicker(req.body.ticker);
            const description = sanitizer.sanitizeDescription(req.body.description || '');
            const imageUrl = req.body.imageUrl;

            if (description.length > 75) return res.status(400).json({ error: "Description too long." });
            if (!name || !ticker || !imageUrl) return res.status(400).json({ error: "Missing fields." });

            const image = await checkImage(imageUrl);
            if (!image.ok) {
                logger.warn('[Deploy] Image rejected before payment', { ip: req.ip, reason: image.error });
                return res.status(400).json({ error: image.error });
            }

            res.json({ success: true, validated: true, imageUrl: image.url });
        } catch (err) {
            logger.error("Metadata Prep Error", { error: err.message });
            res.status(500).json({ error: "Failed to validate the launch. Please try again." });
        }
    });

    // Deploy token
    // v24.0: Added input sanitization
    // v25.4: Restored payment verification logic
    router.post('/deploy', async (req, res) => {
        try {
            // v24.0 SECURITY: Sanitize user inputs
            const sanitized = sanitizer.sanitizeDeploymentRequest(req.body);
            const { userTx, userPubkey } = sanitized;

            if (!userPubkey || !isValidPubkey(userPubkey)) return res.status(400).json({ error: "Invalid Address" });
            if (!isValidSignature(userTx)) return res.status(400).json({ error: "Invalid transaction signature" });

            // v29.1: /api/prepare-metadata rejected a blank name or ticker, but this route did
            // not, and this route is what sets the on-chain name. A token could therefore be
            // minted with empty strings for both.
            if (!sanitized.name) return res.status(400).json({ error: "Token name is required." });
            if (!sanitized.ticker) return res.status(400).json({ error: "Ticker is required." });
            if ((sanitized.description || '').length > 75) return res.status(400).json({ error: "Description too long." });

            // v30.2: the image is re-checked here -- the launch job builds the metadata from it,
            // and a client need not have called /prepare-metadata at all.
            const image = await checkImage(sanitized.imageUrl || sanitized.image);
            if (!image.ok) return res.status(400).json({ error: image.error });

            // v30.0: Custom Pairs. Validated here, before the payment is verified, so an
            // unsupported quote costs the user nothing. Absent or SOL takes the SOL path.
            const requestedQuote = typeof req.body.quoteMint === 'string' ? req.body.quoteMint.trim() : null;
            let resolvedQuoteMint = null;
            if (requestedQuote) {
                try {
                    const pumpLaunch = require('../services/pumpLaunch');
                    const quote = await pumpLaunch.resolveQuote(connection, requestedQuote);
                    resolvedQuoteMint = quote ? quote.mint.toBase58() : null;
                } catch (quoteErr) {
                    if (quoteErr.userFacing) {
                        return res.status(400).json({ error: quoteErr.message });
                    }
                    logger.error('[Deploy] Quote asset check failed', { error: quoteErr.message });
                    return res.status(503).json({ error: "Could not check that quote asset. Please try again." });
                }
            }

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
                        // v29.1: bound the payment's age. Without this, any historical transfer
                        // to the platform wallet of at least the fee could be handed in once
                        // for a free launch, since the only other protection is the UNIQUE
                        // constraint on the signature.
                        const ageSeconds = txInfo.blockTime
                            ? Math.floor(Date.now() / 1000) - txInfo.blockTime
                            : null;
                        if (ageSeconds !== null && ageSeconds > config.PAYMENT_MAX_AGE_SECONDS) {
                            logger.warn('[Deploy] Payment rejected as too old', {
                                userPubkey, userTx: userTx.substring(0, 20), ageSeconds
                            });
                        } else {
                            const minLamports = Math.floor(config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL);
                            validPayment = txInfo.transaction.message.instructions.some(ix => {
                                if (ix.programId.toString() !== '11111111111111111111111111111111') return false;
                                if (!ix.parsed || ix.parsed.type !== 'transfer') return false;
                                // v29.1: the payer must be the wallet the launch is credited to.
                                // Only the destination and amount were checked before, so anyone
                                // watching the chain could take a launch someone else had paid for.
                                return ix.parsed.info.source === userPubkey &&
                                       ix.parsed.info.destination === signer.publicKey.toString() &&
                                       ix.parsed.info.lamports >= minLamports;
                            });
                        }
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
                    image: image.url,
                    userPubkey,
                    // v30.2: the payment signature travels with the job so a refund can be
                    // claimed against it exactly once.
                    userTx,
                    quoteMint: resolvedQuoteMint,
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

            logger.info('[Deploy] Job queued', { jobId: job.id, userPubkey, name: sanitized.name });
            res.json({ success: true, jobId: job.id, message: "Queued" });
        } catch (err) {
            logger.error("Deploy API Error", { error: err.message, stack: err.stack });
            // SECURITY FIX: Don't expose internal error messages
            res.status(500).json({ error: "Deployment failed. Please try again." });
        }
    });

    /**
     * v30.0: the quote assets a launch may be priced in right now.
     *
     * Read live from Global and the QuoteControl PDA rather than hardcoded, because pump.fun
     * adds and removes them: a stale list would offer a quote the program then rejects, after
     * the user had already paid.
     */
    router.get('/quote-assets', async (req, res) => {
        try {
            const pumpLaunch = require('../services/pumpLaunch');
            const assets = await pumpLaunch.getSupportedQuoteMints(connection);
            res.json({ assets, count: assets.length });
        } catch (e) {
            logger.warn('[Deploy] Could not list quote assets', { error: e.message });
            // A launch can still proceed in SOL, so degrade rather than fail.
            res.json({ assets: [], count: 0, unavailable: true });
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
