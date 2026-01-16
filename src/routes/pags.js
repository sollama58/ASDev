/**
 * PAGS Routes
 * API endpoints for Pay-to-Twitter/X fee sharing
 *
 * Developer endpoints: Register tokens, check status
 * User endpoints: OAuth login, link wallet, view rewards, claim
 * Public endpoints: Lookup username rewards, stats
 *
 * Security features:
 * - Session tokens delivered via httpOnly cookies (not URL)
 * - Timing-safe admin key comparison
 * - Username verification blocks claims on failure
 * - Input sanitization on all endpoints
 * - Consistent error handling (no internal details leaked)
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const logger = require('../services/logger');
const config = require('../config/env');
const pags = require('../services/pags');
const pagsTwitterAuth = require('../services/pagsTwitterAuth');
const signatureVerifier = require('../services/signatureVerifier');

/**
 * Timing-safe comparison for admin keys
 * Prevents timing attacks on authentication
 */
function timingSafeEqual(a, b) {
    if (!a || !b) return false;

    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    // Must be same length for timing-safe comparison
    if (bufA.length !== bufB.length) {
        // Still do a comparison to maintain constant time
        crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
        return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Sanitize string input - remove control characters, limit length
 */
function sanitizeString(str, maxLength = 255) {
    if (!str || typeof str !== 'string') return '';
    // Remove control characters except newlines/tabs
    return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLength).trim();
}

/**
 * Sanitize Twitter username
 */
function sanitizeUsername(username) {
    if (!username || typeof username !== 'string') return '';
    // Twitter usernames: alphanumeric and underscores, 1-15 chars
    return username.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 15);
}

/**
 * Generic error response - doesn't leak internal details
 */
function errorResponse(res, statusCode, message, code = null) {
    const response = { success: false, error: message };
    if (code) response.code = code;
    return res.status(statusCode).json(response);
}

/**
 * Initialize PAGS routes
 */
function init(deps) {
    const { db, connection, devKeypair, redis } = deps;
    const router = express.Router();

    // Initialize services with Redis
    pags.init({ db, connection, pagsKeypair: devKeypair, redis });
    pagsTwitterAuth.init({ db, redis });

    // Rate limiters
    const registrationLimiter = rateLimit({
        windowMs: 60 * 60 * 1000, // 1 hour
        max: 20,
        message: { success: false, error: 'Too many registration attempts, please try again later' }
    });

    const oauthLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 10,
        message: { success: false, error: 'Too many auth attempts, please try again later' }
    });

    const claimLimiter = rateLimit({
        windowMs: 60 * 60 * 1000, // 1 hour
        max: 5,
        message: { success: false, error: 'Too many claim attempts, please try again later' }
    });

    const lookupLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 60,
        message: { success: false, error: 'Too many requests, please slow down' }
    });

    // SECURITY: Rate limiter for admin endpoints to prevent brute force attacks
    const adminLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 30, // 30 attempts per 15 minutes
        message: { success: false, error: 'Too many admin requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true // Only count failed attempts
    });

    // ===========================================
    // Public Endpoints
    // ===========================================

    /**
     * GET /api/pags/stats
     * Get global PAGS statistics
     */
    router.get('/pags/stats', async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            const stats = await pags.getStats();
            res.json({ success: true, stats });
        } catch (e) {
            logger.error('[PAGS API] Stats error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch stats');
        }
    });

    /**
     * GET /api/pags/lookup/:username
     * Lookup rewards for a Twitter username (public)
     */
    router.get('/pags/lookup/:username', lookupLimiter, async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            const username = sanitizeUsername(req.params.username);
            if (!username) {
                return errorResponse(res, 400, 'Invalid username');
            }

            const result = await pags.lookupUsername(username);

            res.json({ success: true, ...result });
        } catch (e) {
            logger.error('[PAGS API] Lookup error', { error: e.message });
            return errorResponse(res, 500, 'Failed to lookup username');
        }
    });

    // ===========================================
    // Developer Endpoints
    // ===========================================

    /**
     * POST /api/pags/register
     * Register a token with a Twitter username as beneficiary
     */
    router.post('/pags/register', registrationLimiter, async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            const { mint, twitterUsername, feeShareBps, signedMessage, signature, signerPubkey } = req.body;

            // Sanitize inputs
            const sanitizedMint = sanitizeString(mint, 64);
            const sanitizedUsername = sanitizeUsername(twitterUsername);
            const sanitizedSignerPubkey = sanitizeString(signerPubkey, 64);

            // Validate required fields
            if (!sanitizedMint || !sanitizedUsername || !sanitizedSignerPubkey) {
                return errorResponse(res, 400, 'Missing required fields: mint, twitterUsername, signerPubkey');
            }

            // Verify signature (optional in development)
            if (config.NODE_ENV === 'production' || process.env.SKIP_SIGNATURE_VERIFICATION !== 'true') {
                const sigResult = signatureVerifier.verifySignature({
                    message: signedMessage,
                    signature,
                    publicKey: sanitizedSignerPubkey,
                    expectedAction: 'pags-register'
                });

                if (!sigResult.valid) {
                    return errorResponse(res, 401, 'Signature verification failed', 'SIGNATURE_INVALID');
                }
            }

            // Register beneficiary
            const result = await pags.registerBeneficiary({
                mint: sanitizedMint,
                creatorPubkey: sanitizedSignerPubkey,
                twitterUsername: sanitizedUsername,
                feeShareBps: feeShareBps || 10000
            });

            res.json({ success: true, beneficiary: result });
        } catch (e) {
            logger.error('[PAGS API] Register error', { error: e.message });
            // Return the error message for business logic errors
            return errorResponse(res, 400, e.message);
        }
    });

    /**
     * GET /api/pags/status/:mint
     * Check PAGS status for a token
     */
    router.get('/pags/status/:mint', async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            const mint = sanitizeString(req.params.mint, 64);
            if (!mint) {
                return errorResponse(res, 400, 'Invalid mint address');
            }

            const beneficiary = await pags.getBeneficiaryByMint(mint);

            if (!beneficiary) {
                return res.json({
                    success: true,
                    isRegistered: false,
                    beneficiary: null
                });
            }

            res.json({
                success: true,
                isRegistered: true,
                beneficiary: {
                    mint: beneficiary.mint,
                    twitterUsername: beneficiary.twitterUsername,
                    feeShareBps: beneficiary.feeShareBps,
                    feeSharePercent: beneficiary.feeShareBps / 100,
                    totalFeesAccumulated: beneficiary.totalFeesAccumulated || 0,
                    totalFeesClaimed: beneficiary.totalFeesClaimed || 0,
                    pendingFees: (beneficiary.totalFeesAccumulated || 0) - (beneficiary.totalFeesClaimed || 0),
                    isActive: beneficiary.isActive === 1,
                    createdAt: beneficiary.createdAt
                }
            });
        } catch (e) {
            logger.error('[PAGS API] Status error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch status');
        }
    });

    /**
     * DELETE /api/pags/deactivate/:mint
     * Deactivate PAGS for a token (requires signature from creator)
     */
    router.delete('/pags/deactivate/:mint', async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            const mint = sanitizeString(req.params.mint, 64);
            if (!mint) {
                return errorResponse(res, 400, 'Invalid mint address');
            }

            const { signedMessage, signature, signerPubkey } = req.body;
            const sanitizedSignerPubkey = sanitizeString(signerPubkey, 64);

            // Get current beneficiary
            const beneficiary = await pags.getBeneficiaryByMint(mint);
            if (!beneficiary) {
                return errorResponse(res, 404, 'Beneficiary not found');
            }

            // Verify signature is from creator
            if (config.NODE_ENV === 'production' || process.env.SKIP_SIGNATURE_VERIFICATION !== 'true') {
                if (sanitizedSignerPubkey !== beneficiary.creatorPubkey) {
                    return errorResponse(res, 403, 'Only the creator can deactivate PAGS');
                }

                const sigResult = signatureVerifier.verifySignature({
                    message: signedMessage,
                    signature,
                    publicKey: sanitizedSignerPubkey,
                    expectedAction: 'pags-deactivate'
                });

                if (!sigResult.valid) {
                    return errorResponse(res, 401, 'Signature verification failed', 'SIGNATURE_INVALID');
                }
            }

            await pags.deactivateBeneficiary(mint);
            res.json({ success: true, message: 'PAGS deactivated for this token' });
        } catch (e) {
            logger.error('[PAGS API] Deactivate error', { error: e.message });
            return errorResponse(res, 500, 'Failed to deactivate');
        }
    });

    // ===========================================
    // Twitter OAuth Endpoints
    // ===========================================

    /**
     * GET /api/auth/twitter
     * Initiate Twitter OAuth login
     */
    router.get('/auth/twitter', oauthLimiter, async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            const { redirect } = req.query;
            // Redirect URL is validated inside getAuthorizationUrl
            const { url } = await pagsTwitterAuth.getAuthorizationUrl(redirect || '/');

            // Redirect to Twitter
            res.redirect(url);
        } catch (e) {
            logger.error('[PAGS API] OAuth init error', { error: e.message });
            return errorResponse(res, 500, 'Failed to initiate Twitter login');
        }
    });

    /**
     * GET /api/auth/twitter/callback
     * Twitter OAuth callback handler
     * Sets session token via httpOnly cookie instead of URL parameter
     */
    router.get('/auth/twitter/callback', async (req, res) => {
        try {
            const { code, state, error, error_description } = req.query;

            if (error) {
                logger.warn('[PAGS API] OAuth error from Twitter', { error, error_description });
                return res.redirect(`/?auth_error=${encodeURIComponent('Twitter authentication was denied')}`);
            }

            const result = await pagsTwitterAuth.handleCallback(code, state);

            // Set session token as httpOnly cookie instead of URL parameter
            pagsTwitterAuth.setSessionCookie(res, result.sessionToken);

            // Redirect to frontend without session token in URL
            const redirectUrl = result.redirectAfterAuth || '/';
            res.redirect(`${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}auth_success=true`);
        } catch (e) {
            logger.error('[PAGS API] OAuth callback error', { error: e.message });
            res.redirect(`/?auth_error=${encodeURIComponent('Authentication failed')}`);
        }
    });

    /**
     * POST /api/auth/twitter/logout
     * Clear session cookie
     */
    router.post('/auth/twitter/logout', pagsTwitterAuth.requireSession, (req, res) => {
        pagsTwitterAuth.clearSessionCookie(res);
        res.json({ success: true, message: 'Logged out' });
    });

    // ===========================================
    // User Endpoints (require session)
    // ===========================================

    /**
     * GET /api/pags/me
     * Get authenticated user's profile and PAGS status
     */
    router.get('/pags/me', pagsTwitterAuth.requireSession, async (req, res) => {
        try {
            const { twitterId, username } = req.pagsSession;

            // Get user from database
            const user = await pagsTwitterAuth.getUserFromSession(
                req.headers.authorization ? req.headers.authorization.substring(7) : req.cookies?.pags_session
            );

            if (user.error) {
                return errorResponse(res, 401, user.error);
            }

            // Get rewards info
            const rewards = await pags.getPendingRewardsByUsername(user.username);

            res.json({
                success: true,
                user: {
                    ...user,
                    pendingRewards: rewards.totalPending,
                    rewardBreakdown: rewards.breakdown
                }
            });
        } catch (e) {
            logger.error('[PAGS API] Get me error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch user data');
        }
    });

    /**
     * POST /api/pags/link-wallet
     * Link a Solana wallet to the authenticated user
     */
    router.post('/pags/link-wallet', pagsTwitterAuth.requireSession, async (req, res) => {
        try {
            const { twitterId } = req.pagsSession;
            const { walletPubkey, signedMessage, signature } = req.body;

            const sanitizedWalletPubkey = sanitizeString(walletPubkey, 64);
            if (!sanitizedWalletPubkey) {
                return errorResponse(res, 400, 'walletPubkey is required');
            }

            // Verify wallet ownership via signature
            if (config.NODE_ENV === 'production' || process.env.SKIP_SIGNATURE_VERIFICATION !== 'true') {
                const sigResult = signatureVerifier.verifySignature({
                    message: signedMessage,
                    signature,
                    publicKey: sanitizedWalletPubkey,
                    expectedAction: 'pags-link-wallet'
                });

                if (!sigResult.valid) {
                    return errorResponse(res, 401, 'Wallet signature verification failed', 'SIGNATURE_INVALID');
                }
            }

            const result = await pags.linkWallet(twitterId, sanitizedWalletPubkey);
            res.json({ success: true, ...result });
        } catch (e) {
            logger.error('[PAGS API] Link wallet error', { error: e.message });
            return errorResponse(res, 400, e.message);
        }
    });

    /**
     * GET /api/pags/rewards
     * Get pending rewards for the authenticated user
     */
    router.get('/pags/rewards', pagsTwitterAuth.requireSession, async (req, res) => {
        try {
            const { twitterId, username } = req.pagsSession;

            const claimInfo = await pags.getClaimableAmount(twitterId);

            res.json({
                success: true,
                twitterUsername: username,
                claimable: claimInfo.claimable || 0,
                linkedWallet: claimInfo.linkedWallet,
                breakdown: claimInfo.breakdown || [],
                minClaimAmount: config.PAGS_MIN_CLAIM_SOL,
                canClaim: (claimInfo.claimable || 0) >= config.PAGS_MIN_CLAIM_SOL && !!claimInfo.linkedWallet
            });
        } catch (e) {
            logger.error('[PAGS API] Get rewards error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch rewards');
        }
    });

    /**
     * POST /api/pags/claim
     * Claim pending rewards
     */
    router.post('/pags/claim', pagsTwitterAuth.requireSession, claimLimiter, async (req, res) => {
        try {
            const { twitterId, username } = req.pagsSession;
            const { signedMessage, signature } = req.body;

            // Get user's wallet
            const user = await pagsTwitterAuth.getUserFromSession(
                req.headers.authorization ? req.headers.authorization.substring(7) : req.cookies?.pags_session
            );

            if (!user.linkedWallet) {
                return errorResponse(res, 400, 'No wallet linked. Please link a wallet first.', 'NO_WALLET');
            }

            // Verify claim signature
            if (config.NODE_ENV === 'production' || process.env.SKIP_SIGNATURE_VERIFICATION !== 'true') {
                const sigResult = signatureVerifier.verifySignature({
                    message: signedMessage,
                    signature,
                    publicKey: user.linkedWallet,
                    expectedAction: 'pags-claim'
                });

                if (!sigResult.valid) {
                    return errorResponse(res, 401, 'Claim signature verification failed', 'SIGNATURE_INVALID');
                }
            }

            // Re-verify Twitter username before claiming - BLOCK if verification fails
            const verifyResult = await pagsTwitterAuth.verifyUsername(twitterId);
            if (!verifyResult.verified) {
                logger.warn('[PAGS API] Username verification failed during claim - BLOCKING', {
                    twitterId,
                    error: verifyResult.error
                });

                // SECURITY: Block the claim if we can't verify the user
                return errorResponse(
                    res,
                    403,
                    'Could not verify your Twitter account. Please re-authenticate.',
                    'VERIFICATION_FAILED'
                );
            }

            // Process claim (creates pending claim record)
            // Set executeTransfer to true to immediately transfer SOL
            const executeTransfer = !!config.PAGS_WALLET && !!deps.devKeypair;
            const result = await pags.processClaim(twitterId, executeTransfer);

            res.json({ success: true, claim: result });
        } catch (e) {
            logger.error('[PAGS API] Claim error', { error: e.message });
            return errorResponse(res, 400, e.message);
        }
    });

    // ===========================================
    // Admin Endpoints
    // ===========================================

    /**
     * POST /api/admin/pags/record-fee
     * Manually record a fee collection (admin only)
     */
    router.post('/admin/pags/record-fee', adminLimiter, async (req, res) => {
        try {
            // Check admin key with timing-safe comparison
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            const { mint, amount, source, txSignature } = req.body;

            const sanitizedMint = sanitizeString(mint, 64);
            const sanitizedSource = sanitizeString(source, 64);
            const sanitizedTxSignature = sanitizeString(txSignature, 128);

            if (!sanitizedMint || amount === undefined) {
                return errorResponse(res, 400, 'mint and amount are required');
            }

            const result = await pags.recordFeeCollection(
                sanitizedMint,
                amount,
                sanitizedSource || 'admin',
                sanitizedTxSignature
            );
            res.json({ success: true, ...result });
        } catch (e) {
            logger.error('[PAGS API] Record fee error', { error: e.message });
            return errorResponse(res, 400, e.message);
        }
    });

    /**
     * GET /api/admin/pags/pending-claims
     * Get all pending claims (admin only)
     * SECURITY: Added pagination limit to prevent unbounded responses
     */
    router.get('/admin/pags/pending-claims', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                // SECURITY: Don't reveal whether admin key is configured
                return errorResponse(res, 401, 'Unauthorized');
            }

            // SECURITY: Add pagination to prevent unbounded result sets
            const limit = Math.min(parseInt(req.query.limit) || 50, 100);
            const offset = Math.max(parseInt(req.query.offset) || 0, 0);

            const claims = await db.all(`
                SELECT * FROM pags_claims WHERE status = 'pending' ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2
            `, [limit, offset]);

            const totalCount = await db.get('SELECT COUNT(*) as count FROM pags_claims WHERE status = \'pending\'');

            res.json({
                success: true,
                claims,
                pagination: { limit, offset, total: totalCount?.count || 0 }
            });
        } catch (e) {
            logger.error('[PAGS API] Get pending claims error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch claims');
        }
    });

    /**
     * POST /api/admin/pags/process-claim/:claimId
     * Manually process a pending claim (admin only)
     */
    router.post('/admin/pags/process-claim/:claimId', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            const claimId = parseInt(req.params.claimId, 10);
            if (isNaN(claimId) || claimId <= 0) {
                return errorResponse(res, 400, 'Invalid claim ID');
            }

            const claim = await db.get('SELECT * FROM pags_claims WHERE id = $1', [claimId]);
            if (!claim) {
                return errorResponse(res, 404, 'Claim not found');
            }

            if (claim.status !== 'pending') {
                return errorResponse(res, 400, `Claim is not pending (status: ${claim.status})`);
            }

            const signature = await pags.executeClaimTransfer(
                claim.id,
                claim.recipientWallet,
                claim.amount
            );

            res.json({ success: true, signature, claim });
        } catch (e) {
            logger.error('[PAGS API] Process claim error', { error: e.message });
            return errorResponse(res, 500, 'Failed to process claim');
        }
    });

    return router;
}

module.exports = { init };
