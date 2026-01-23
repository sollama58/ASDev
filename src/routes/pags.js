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
const mintExtractor = require('../services/mintExtractor');
const twitter = require('../services/twitter'); // v25.70: For PAGS registration announcements

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
    const { db, connection, devKeypair, pagsKeypair, redis } = deps;
    const router = express.Router();

    // Use dedicated PAGS keypair if available, otherwise fall back to devKeypair
    const effectivePagsKeypair = pagsKeypair || devKeypair;

    if (!pagsKeypair && config.PAGS_ENABLED) {
        logger.warn('[PAGS Routes] No dedicated PAGS keypair - using devKeypair as fallback');
    }

    // Initialize services with Redis
    pags.init({ db, connection, pagsKeypair: effectivePagsKeypair, redis });
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
     * GET /api/pags/pending-onchain
     * Get on-chain pending fees from Pump.fun vaults for all PAGS tokens
     * This shows fees that are waiting in vaults but not yet claimed
     */
    router.get('/pags/pending-onchain', lookupLimiter, async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            // Import and use the fee scanner
            const pagsFeeScanner = require('../tasks/pagsFeeScanner');
            const pending = await pagsFeeScanner.getAllPendingFees();

            res.json({
                success: true,
                onChainPending: {
                    totalPendingSol: pending.totalPendingSol || 0,
                    beneficiaryCount: pending.beneficiaryCount || 0,
                    tokens: (pending.beneficiaries || []).map(b => ({
                        mint: b.mint,
                        twitterUsername: b.twitterUsername,
                        pendingSol: b.ourShareLamports / 1e9,
                        shareBps: b.shareBps,
                        sharePercent: b.sharePercent,
                        bcFeesSol: b.bcFeesLamports / 1e9,
                        ammFeesSol: b.ammFeesLamports / 1e9
                    }))
                }
            });
        } catch (e) {
            logger.error('[PAGS API] Pending on-chain error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch on-chain pending fees');
        }
    });

    /**
     * GET /api/pags/leaderboard
     * Get PAGS leaderboard data for public display
     * Returns top tokens and users by fees accumulated
     *
     * v25.59: Enhanced to include on-chain pending fees in totals
     */
    router.get('/pags/leaderboard', lookupLimiter, async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            // v25.44: Get metadata directly from pags_beneficiaries (not tokens table)
            const tokens = await db.all(`
                SELECT b.*
                FROM pags_beneficiaries b
                WHERE b."isActive" = 1
                ORDER BY b."totalFeesAccumulated" DESC
                LIMIT 50
            `);

            // Get on-chain pending fees for all tokens
            let onChainPendingByMint = {};
            let totalOnChainPending = 0;
            try {
                const pagsFeeScanner = require('../tasks/pagsFeeScanner');
                const allPending = await pagsFeeScanner.getAllPendingFees();
                totalOnChainPending = allPending.totalPendingSol || 0;

                for (const b of (allPending.beneficiaries || [])) {
                    onChainPendingByMint[b.mint] = b.ourShareLamports / 1e9;
                }
            } catch (e) {
                logger.warn('[PAGS API] Could not fetch on-chain pending for leaderboard', { error: e.message });
            }

            // Process tokens to add pending calculation and multi-beneficiary info
            const processedTokens = [];
            for (const t of tokens) {
                const claimable = (t.totalFeesAccumulated || 0) - (t.totalFeesClaimed || 0);
                const onChainPending = onChainPendingByMint[t.mint] || 0;

                // v25.68: Get beneficiary shares for multi-beneficiary support
                const shares = await db.all(`
                    SELECT * FROM pags_beneficiary_shares
                    WHERE "beneficiaryId" = $1
                    ORDER BY "shareBps" DESC
                `, [t.id]);

                const beneficiaries = shares.length > 0 ? shares.map(s => ({
                    twitterUsername: s.twitterUsername,
                    shareBps: s.shareBps,
                    sharePercent: s.shareBps / 100
                })) : [{
                    twitterUsername: t.twitterUsername,
                    shareBps: 10000,
                    sharePercent: 100
                }];

                processedTokens.push({
                    mint: t.mint,
                    ticker: t.ticker || null,
                    name: t.name || null,
                    image: t.image || null,
                    twitterUsername: t.twitterUsername,
                    feeShareBps: t.feeShareBps || 10000,
                    totalFeesAccumulated: t.totalFeesAccumulated || 0,
                    totalFeesClaimed: t.totalFeesClaimed || 0,
                    claimable,
                    onChainPending,
                    pending: claimable + onChainPending,
                    // v25.68: Multi-beneficiary support
                    beneficiaries,
                    isMultiBeneficiary: beneficiaries.length > 1
                });
            }

            // Aggregate by Twitter username for user leaderboard
            const userMap = new Map();
            for (const token of processedTokens) {
                const username = token.twitterUsername;
                if (!userMap.has(username)) {
                    userMap.set(username, {
                        twitterUsername: username,
                        tokenCount: 0,
                        totalAccumulated: 0,
                        totalClaimed: 0,
                        totalClaimable: 0,
                        totalOnChainPending: 0,
                        totalPending: 0
                    });
                }
                const user = userMap.get(username);
                user.tokenCount++;
                user.totalAccumulated += (token.totalFeesAccumulated || 0);
                user.totalClaimed += (token.totalFeesClaimed || 0);
                user.totalClaimable += token.claimable;
                user.totalOnChainPending += token.onChainPending;
                user.totalPending += token.pending;
            }

            const users = Array.from(userMap.values())
                .sort((a, b) => b.totalPending - a.totalPending) // Sort by total pending (most relevant)
                .slice(0, 50);

            // Get overall stats
            const stats = await db.get(`
                SELECT
                    COUNT(*) as totalTokens,
                    COUNT(CASE WHEN "isActive" = 1 THEN 1 END) as activeBeneficiaries,
                    COALESCE(SUM("totalFeesAccumulated"), 0) as totalAccumulated,
                    COALESCE(SUM("totalFeesClaimed"), 0) as totalClaimed
                FROM pags_beneficiaries
            `);

            const dbClaimable = (stats?.totalAccumulated || 0) - (stats?.totalClaimed || 0);

            res.json({
                success: true,
                stats: {
                    totalTokens: stats?.totalTokens || 0,
                    activeBeneficiaries: stats?.activeBeneficiaries || 0,
                    totalAccumulated: stats?.totalAccumulated || 0,
                    totalClaimed: stats?.totalClaimed || 0,
                    // v25.59: Enhanced pending breakdown
                    claimable: dbClaimable,           // Ready to withdraw
                    onChainPending: totalOnChainPending, // Still in vaults
                    totalPending: dbClaimable + totalOnChainPending // Combined
                },
                tokens: processedTokens,
                users
            });
        } catch (e) {
            logger.error('[PAGS API] Leaderboard error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch leaderboard');
        }
    });

    /**
     * GET /api/pags/lookup/:username
     * Lookup rewards for a Twitter username (public)
     * Also returns token details for the My Tokens section
     *
     * v25.59: Enhanced to include on-chain pending fees (fees in vault not yet claimed by scanner)
     * This gives users a complete picture of their rewards:
     * - onChainPending: Fees sitting in Pump.fun vaults (waiting for scanner to claim)
     * - claimable: Fees claimed by scanner and ready for user to withdraw
     * - totalPending: Sum of both (what user will eventually receive)
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

            logger.info('[PAGS API] Username lookup', { username, lowered: username.toLowerCase() });

            // v25.44: Get metadata directly from pags_beneficiaries (not tokens table)
            const tokens = await db.all(`
                SELECT b.*
                FROM pags_beneficiaries b
                WHERE LOWER(b."twitterUsername") = LOWER($1)
                  AND b."isActive" = 1
                ORDER BY b."totalFeesAccumulated" DESC
            `, [username]);

            logger.info('[PAGS API] Lookup results', {
                username,
                tokensFound: tokens.length,
                tokens: tokens.map(t => ({ mint: t.mint, user: t.twitterUsername, isActive: t.isActive }))
            });

            // Get on-chain pending fees for this user's tokens
            let onChainPendingByMint = {};
            try {
                const pagsFeeScanner = require('../tasks/pagsFeeScanner');
                const allPending = await pagsFeeScanner.getAllPendingFees();

                // Filter to only this user's tokens and create mint->pending map
                for (const b of (allPending.beneficiaries || [])) {
                    if (b.twitterUsername && b.twitterUsername.toLowerCase() === username.toLowerCase()) {
                        onChainPendingByMint[b.mint] = {
                            pendingSol: b.ourShareLamports / 1e9,
                            bcFeesSol: b.bcFeesLamports / 1e9,
                            ammFeesSol: b.ammFeesLamports / 1e9,
                            shareBps: b.shareBps,
                            isDirectCreator: b.isDirectCreator
                        };
                    }
                }
            } catch (e) {
                logger.warn('[PAGS API] Could not fetch on-chain pending', { error: e.message });
            }

            // Calculate totals
            let totalClaimable = 0;      // Ready to withdraw (in PAGS wallet)
            let totalOnChainPending = 0; // Still in vaults (not yet claimed by scanner)
            let totalAccumulated = 0;
            let totalClaimed = 0;

            // v25.68: Build breakdown with multi-beneficiary support
            const breakdown = [];
            for (const t of tokens) {
                const claimable = (t.totalFeesAccumulated || 0) - (t.totalFeesClaimed || 0);
                const onChainInfo = onChainPendingByMint[t.mint] || { pendingSol: 0 };
                const onChainPending = onChainInfo.pendingSol || 0;

                totalClaimable += claimable;
                totalOnChainPending += onChainPending;
                totalAccumulated += (t.totalFeesAccumulated || 0);
                totalClaimed += (t.totalFeesClaimed || 0);

                // v25.68: Get all beneficiaries for this token
                const shares = await db.all(`
                    SELECT * FROM pags_beneficiary_shares
                    WHERE "beneficiaryId" = $1
                    ORDER BY "shareBps" DESC
                `, [t.id]);

                const beneficiaries = shares.length > 0 ? shares.map(s => ({
                    twitterUsername: s.twitterUsername,
                    shareBps: s.shareBps,
                    sharePercent: s.shareBps / 100
                })) : [{
                    twitterUsername: t.twitterUsername,
                    shareBps: 10000,
                    sharePercent: 100
                }];

                breakdown.push({
                    mint: t.mint,
                    ticker: t.ticker || null,
                    name: t.name || null,
                    image: t.image || null,
                    feeShareBps: t.feeShareBps || 10000,
                    totalFeesAccumulated: t.totalFeesAccumulated || 0,
                    totalFeesClaimed: t.totalFeesClaimed || 0,
                    // v25.59: Enhanced pending info
                    claimable,           // Ready to withdraw now
                    onChainPending,      // Still in vault
                    pending: claimable + onChainPending, // Total expected
                    // v25.68: Multi-beneficiary support
                    beneficiaries,
                    isMultiBeneficiary: beneficiaries.length > 1,
                    // Additional on-chain details if available
                    ...(onChainInfo.pendingSol > 0 ? {
                        bcFeesSol: onChainInfo.bcFeesSol,
                        ammFeesSol: onChainInfo.ammFeesSol,
                        isDirectCreator: onChainInfo.isDirectCreator
                    } : {})
                });
            }

            res.json({
                success: true,
                twitterUsername: username,
                // v25.59: More detailed pending breakdown
                totalPending: totalClaimable + totalOnChainPending, // Combined total
                claimable: totalClaimable,          // Ready to withdraw
                onChainPending: totalOnChainPending, // Still in vaults
                totalAccumulated,
                totalClaimed,
                tokenCount: tokens.length,
                breakdown
            });
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
     * Register a token with one or more Twitter usernames as beneficiaries
     *
     * v25.60: SECURITY - Requires wallet signature to verify caller is the token creator
     * v25.48: Multi-beneficiary support - up to 4 Twitter users can share fees
     *
     * Required fields:
     * - mint: Token mint address
     * - signedMessage: Message signed by wallet (format: "pags-register:timestamp:nonce")
     * - signature: Base58 encoded Ed25519 signature
     * - signerPubkey: Public key of the signer (must be token creator)
     *
     * For single beneficiary (backwards compatible):
     * - twitterUsername: Twitter username to receive fees
     *
     * For multiple beneficiaries:
     * - beneficiaries: Array of {twitterUsername, shareBps} where shareBps must sum to 10000
     *   Example: [{"twitterUsername": "user1", "shareBps": 6000}, {"twitterUsername": "user2", "shareBps": 4000}]
     *
     * IMPORTANT: Fee share percentage is AUTO-DETECTED from on-chain Pump.fun
     * fee sharing configuration. Users cannot set this manually.
     *
     * The token MUST have PAGS_WALLET configured as a fee recipient on-chain.
     */
    router.post('/pags/register', registrationLimiter, async (req, res) => {
        try {
            if (!config.PAGS_ENABLED) {
                return errorResponse(res, 503, 'PAGS is not enabled');
            }

            if (!config.PAGS_WALLET) {
                return errorResponse(res, 503, 'PAGS wallet not configured');
            }

            const { mint, twitterUsername, beneficiaries, signedMessage, signature, signerPubkey } = req.body;

            // Sanitize inputs
            const sanitizedMint = sanitizeString(mint, 64);
            const sanitizedUsername = twitterUsername ? sanitizeUsername(twitterUsername) : null;

            // v25.48: Validate and sanitize beneficiaries array if provided
            let sanitizedBeneficiaries = null;
            if (beneficiaries && Array.isArray(beneficiaries) && beneficiaries.length > 0) {
                if (beneficiaries.length > 4) {
                    return errorResponse(res, 400, 'Maximum 4 beneficiaries allowed');
                }
                sanitizedBeneficiaries = beneficiaries.map(b => ({
                    twitterUsername: sanitizeUsername(b.twitterUsername || ''),
                    shareBps: parseInt(b.shareBps) || 0
                }));
                // Validate all usernames are present
                for (const b of sanitizedBeneficiaries) {
                    if (!b.twitterUsername) {
                        return errorResponse(res, 400, 'Each beneficiary must have a valid twitterUsername');
                    }
                }
                // Validate shares sum to 100%
                const totalBps = sanitizedBeneficiaries.reduce((sum, b) => sum + b.shareBps, 0);
                if (totalBps !== 10000) {
                    return errorResponse(res, 400, `Beneficiary shares must sum to 100% (10000 bps), got ${totalBps / 100}%`);
                }
            }

            // Validate required fields - either single username or beneficiaries array
            if (!sanitizedMint) {
                return errorResponse(res, 400, 'Missing required field: mint');
            }
            if (!sanitizedUsername && !sanitizedBeneficiaries) {
                return errorResponse(res, 400, 'Missing required field: twitterUsername or beneficiaries');
            }

            // v25.60: Verify wallet signature
            if (!signedMessage || !signature || !signerPubkey) {
                return errorResponse(
                    res, 401,
                    'Wallet signature required. Please connect your wallet and sign the registration request.',
                    'SIGNATURE_REQUIRED'
                );
            }

            const sigResult = signatureVerifier.verifySignature({
                message: signedMessage,
                signature,
                publicKey: signerPubkey,
                expectedAction: 'pags-register'
            });

            if (!sigResult.valid) {
                logger.warn('[PAGS API] Signature verification failed', {
                    mint: sanitizedMint,
                    error: sigResult.error,
                    signerPubkey: signerPubkey?.slice(0, 8)
                });
                return errorResponse(res, 401, `Signature verification failed: ${sigResult.error}`, 'SIGNATURE_INVALID');
            }

            // AUTO-DETECT fee share from on-chain Pump.fun fee sharing configuration
            // This verifies that PAGS_WALLET is actually configured as a fee recipient
            logger.info('[PAGS API] Verifying fee recipient on-chain', {
                mint: sanitizedMint,
                pagsWallet: config.PAGS_WALLET.slice(0, 8) + '...',
                signerPubkey: signerPubkey.slice(0, 8) + '...'
            });

            const feeRecipientResult = await mintExtractor.verifyFeeRecipient(
                sanitizedMint,
                config.PAGS_WALLET,
                connection
            );

            // Check for RPC errors (don't reject on temporary failures)
            if (feeRecipientResult.error) {
                logger.warn('[PAGS API] Fee recipient verification had RPC error', {
                    mint: sanitizedMint,
                    error: feeRecipientResult.error
                });
                return errorResponse(
                    res, 503,
                    'Could not verify fee recipient status. Please try again later.',
                    'VERIFICATION_FAILED'
                );
            }

            // Token must have PAGS wallet configured as a fee recipient on-chain
            if (!feeRecipientResult.isRecipient) {
                logger.warn('[PAGS API] PAGS wallet is not a fee recipient for token', {
                    mint: sanitizedMint,
                    pagsWallet: config.PAGS_WALLET
                });
                return errorResponse(
                    res, 400,
                    'PAGS wallet is not configured as a fee recipient for this token. ' +
                    'Please add the PAGS wallet as a fee sharing recipient on Pump.fun first.',
                    'NOT_FEE_RECIPIENT'
                );
            }

            // v25.60: SECURITY - Verify signer is the original token creator
            const originalCreator = feeRecipientResult.originalCreator;
            if (!originalCreator) {
                logger.warn('[PAGS API] Could not determine original creator', {
                    mint: sanitizedMint
                });
                return errorResponse(
                    res, 400,
                    'Could not determine the original token creator from on-chain data.',
                    'CREATOR_NOT_FOUND'
                );
            }

            if (signerPubkey !== originalCreator) {
                logger.warn('[PAGS API] Signer is not the token creator', {
                    mint: sanitizedMint,
                    signerPubkey: signerPubkey.slice(0, 8) + '...',
                    originalCreator: originalCreator.slice(0, 8) + '...'
                });
                return errorResponse(
                    res, 403,
                    'Only the original token creator can register a token for PAGS. ' +
                    'Please connect the wallet that created this token.',
                    'NOT_TOKEN_CREATOR'
                );
            }

            // Use the on-chain detected fee share percentage
            const detectedFeeShareBps = feeRecipientResult.feeShareBps || 10000;

            logger.info('[PAGS API] Fee share auto-detected from on-chain', {
                mint: sanitizedMint,
                feeShareBps: detectedFeeShareBps,
                feeSharePercent: detectedFeeShareBps / 100,
                source: feeRecipientResult.source,
                originalCreator: originalCreator,
                verifiedCreator: true
            });

            // Register beneficiary with auto-detected fee share
            // creatorPubkey is verified to be the signer
            // v25.48: Pass beneficiaries array if provided for multi-beneficiary mode
            const result = await pags.registerBeneficiary({
                mint: sanitizedMint,
                creatorPubkey: originalCreator,
                twitterUsername: sanitizedUsername,
                feeShareBps: detectedFeeShareBps,
                beneficiaries: sanitizedBeneficiaries
            });

            // v25.44: Fetch and store token metadata to pags_beneficiaries (NOT tokens table)
            // This keeps PAGS tokens SEPARATE from the main leaderboard
            let tokenMetadata = null;
            try {
                tokenMetadata = await mintExtractor.fetchPumpFunTokenMetadata(sanitizedMint);
                if (tokenMetadata && tokenMetadata.ticker && tokenMetadata.name) {
                    const postgres = require('../services/postgres');
                    // Save to pags_beneficiaries table, NOT tokens table
                    await postgres.savePagsBeneficiaryMetadata(sanitizedMint, {
                        ticker: tokenMetadata.ticker,
                        name: tokenMetadata.name,
                        image: tokenMetadata.image || ''
                    });
                    logger.info('[PAGS API] Token metadata saved to pags_beneficiaries', {
                        mint: sanitizedMint,
                        ticker: tokenMetadata.ticker,
                        hasImage: !!tokenMetadata.image
                    });
                }
            } catch (metaError) {
                // Don't fail registration if metadata fetch fails
                logger.warn('[PAGS API] Could not fetch/save token metadata', {
                    mint: sanitizedMint,
                    error: metaError.message
                });
            }

            // v25.70: Post Twitter announcement for new PAGS registration
            // Non-blocking - don't fail registration if tweet fails
            let tweetUrl = null;
            try {
                const ticker = tokenMetadata?.ticker || sanitizedMint.slice(0, 8);
                const name = tokenMetadata?.name || 'New Token';
                tweetUrl = await twitter.postPagsRegistrationTweet(
                    ticker,
                    name,
                    sanitizedMint,
                    sanitizedUsername,
                    sanitizedBeneficiaries
                );
                if (tweetUrl) {
                    logger.info('[PAGS API] Registration announced on Twitter', {
                        mint: sanitizedMint,
                        ticker,
                        tweetUrl
                    });
                }
            } catch (tweetErr) {
                logger.warn('[PAGS API] Twitter announcement failed', { error: tweetErr.message });
            }

            res.json({
                success: true,
                beneficiary: result,
                // v25.48: Include beneficiaries info if multi-beneficiary
                beneficiaries: result.beneficiaries || [{
                    twitterUsername: result.twitterUsername,
                    shareBps: 10000,
                    sharePercent: 100
                }],
                isMultiBeneficiary: result.isMultiBeneficiary || false,
                tokenMetadata: tokenMetadata ? {
                    ticker: tokenMetadata.ticker,
                    name: tokenMetadata.name,
                    image: tokenMetadata.image
                } : null,
                onChainVerification: {
                    verified: true,
                    source: feeRecipientResult.source,
                    feeShareBps: detectedFeeShareBps,
                    feeSharePercent: detectedFeeShareBps / 100,
                    isDirectCreator: detectedFeeShareBps === 10000,
                    originalCreator: originalCreator,
                    creatorVerified: true
                },
                // v25.70: Include tweet URL if announcement was posted
                tweetUrl
            });
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

            // Determine if this beneficiary has multiple fee recipients
            const feeShareBps = beneficiary.feeShareBps || 10000;
            const hasMultipleOnChainRecipients = feeShareBps < 10000;
            // v25.48: Check for multiple beneficiary shares
            const isMultiBeneficiary = beneficiary.isMultiBeneficiary || false;
            const shares = beneficiary.shares || [];

            // v25.68: Build beneficiaries array for frontend compatibility
            const beneficiariesArray = shares.map(s => ({
                twitterUsername: s.twitterUsername,
                shareBps: s.shareBps,
                sharePercent: s.shareBps / 100,
                totalFeesAccumulated: s.totalFeesAccumulated || 0,
                totalFeesClaimed: s.totalFeesClaimed || 0,
                pendingFees: (s.totalFeesAccumulated || 0) - (s.totalFeesClaimed || 0)
            }));

            res.json({
                success: true,
                isRegistered: true,
                // v25.68: Include both legacy beneficiary object and new beneficiaries array
                beneficiary: {
                    mint: beneficiary.mint,
                    twitterUsername: beneficiary.twitterUsername,
                    feeShareBps: feeShareBps,
                    feeSharePercent: feeShareBps / 100,
                    // Clearly indicate if this is a partial share
                    hasMultipleOnChainRecipients,
                    isMultiBeneficiary,
                    feeShareDescription: hasMultipleOnChainRecipients
                        ? `Receives ${feeShareBps / 100}% of token fees (multiple recipients configured)`
                        : 'Receives 100% of token fees',
                    totalFeesAccumulated: beneficiary.totalFeesAccumulated || 0,
                    totalFeesClaimed: beneficiary.totalFeesClaimed || 0,
                    pendingFees: (beneficiary.totalFeesAccumulated || 0) - (beneficiary.totalFeesClaimed || 0),
                    isActive: beneficiary.isActive === 1,
                    createdAt: beneficiary.createdAt,
                    // v25.48: Include all beneficiary shares
                    shares: beneficiariesArray
                },
                // v25.68: New beneficiaries array for frontend
                beneficiaries: beneficiariesArray,
                isMultiBeneficiary,
                // Aggregate stats
                totalFeesAccumulated: beneficiary.totalFeesAccumulated || 0,
                pendingFees: (beneficiary.totalFeesAccumulated || 0) - (beneficiary.totalFeesClaimed || 0),
                feeSharePercent: feeShareBps / 100,
                isActive: beneficiary.isActive === 1
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
        // Default redirect path for errors (use FRONTEND_URL for cross-origin support)
        const errorRedirectBase = config.FRONTEND_URL || config.FRONTEND_PATH || '/';

        try {
            const { code, state, error, error_description } = req.query;

            if (error) {
                logger.warn('[PAGS API] OAuth error from Twitter', { error, error_description });
                return res.redirect(`${errorRedirectBase}${errorRedirectBase.includes('?') ? '&' : '?'}auth_error=${encodeURIComponent('Twitter authentication was denied')}`);
            }

            const result = await pagsTwitterAuth.handleCallback(code, state);

            // For cross-origin setups, we can't use httpOnly cookies
            // Instead, pass the session token via URL parameter (will be stored in localStorage by frontend)
            let redirectUrl = result.redirectAfterAuth || config.FRONTEND_URL || config.FRONTEND_PATH || '/';

            // If redirectUrl is a relative path and FRONTEND_URL is set to a full URL, use FRONTEND_URL directly
            // (FRONTEND_URL already contains the complete path like https://alonisthe.dev/ignition)
            if (!redirectUrl.startsWith('http') && config.FRONTEND_URL && config.FRONTEND_URL.startsWith('http')) {
                redirectUrl = config.FRONTEND_URL;
            }

            logger.info('[PAGS API] OAuth callback redirect calculation', {
                resultRedirectAfterAuth: result.redirectAfterAuth,
                configFrontendUrl: config.FRONTEND_URL,
                configFrontendPath: config.FRONTEND_PATH,
                finalRedirectUrl: redirectUrl
            });

            const separator = redirectUrl.includes('?') ? '&' : '?';

            // Check if this is a cross-origin redirect
            const isCrossOrigin = redirectUrl.startsWith('http') &&
                !redirectUrl.startsWith(config.BASE_URL);

            if (isCrossOrigin) {
                // Cross-origin: pass token in URL (frontend will store in localStorage)
                logger.info('[PAGS API] Cross-origin OAuth redirect', {
                    redirectUrl: redirectUrl.slice(0, 50) + '...'
                });
                res.redirect(`${redirectUrl}${separator}auth_success=true&pags_token=${encodeURIComponent(result.sessionToken)}`);
            } else {
                // Same-origin: use httpOnly cookie (more secure)
                pagsTwitterAuth.setSessionCookie(res, result.sessionToken);
                res.redirect(`${redirectUrl}${separator}auth_success=true`);
            }
        } catch (e) {
            logger.error('[PAGS API] OAuth callback error', { error: e.message });
            res.redirect(`${errorRedirectBase}${errorRedirectBase.includes('?') ? '&' : '?'}auth_error=${encodeURIComponent('Authentication failed')}`);
        }
    });

    /**
     * POST /api/auth/twitter/logout
     * Clear session cookie and revoke token
     * v25.69 SECURITY: Now revokes the session token to prevent reuse
     */
    router.post('/auth/twitter/logout', pagsTwitterAuth.requireSession, async (req, res) => {
        // v25.69 SECURITY: Revoke the token so it can't be reused
        if (req.pagsSession && req.pagsSession.token) {
            await pagsTwitterAuth.revokeSessionToken(req.pagsSession.token);
        }
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
                logger.info('[PAGS API] Verifying wallet signature', {
                    walletPubkey: sanitizedWalletPubkey,
                    hasSignedMessage: !!signedMessage,
                    messageLength: signedMessage ? signedMessage.length : 0,
                    hasSignature: !!signature,
                    signatureLength: signature ? signature.length : 0
                });

                const sigResult = signatureVerifier.verifySignature({
                    message: signedMessage,
                    signature,
                    publicKey: sanitizedWalletPubkey,
                    expectedAction: 'pags-link-wallet'
                });

                if (!sigResult.valid) {
                    logger.warn('[PAGS API] Wallet signature verification failed', {
                        error: sigResult.error,
                        walletPubkey: sanitizedWalletPubkey
                    });
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
     *
     * Body params:
     * - mint: Token mint address (required)
     * - amount: Fee amount in SOL (required)
     * - source: Source of the fee (optional, defaults to 'admin')
     * - txSignature: Transaction signature (optional)
     * - applyFeeShare: If true (default), amount is total fee and will be multiplied
     *                  by beneficiary's feeShareBps percentage. If false, amount is
     *                  already the beneficiary's share.
     *
     * Example with multiple Pump.fun recipients:
     * - If token has 30% fee share for PAGS beneficiary
     * - Total fee = 1.0 SOL, applyFeeShare=true → Records 0.3 SOL
     * - Already calculated = 0.3 SOL, applyFeeShare=false → Records 0.3 SOL
     */
    router.post('/admin/pags/record-fee', adminLimiter, async (req, res) => {
        try {
            // Check admin key with timing-safe comparison
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            const { mint, amount, source, txSignature, applyFeeShare } = req.body;

            const sanitizedMint = sanitizeString(mint, 64);
            const sanitizedSource = sanitizeString(source, 64);
            const sanitizedTxSignature = sanitizeString(txSignature, 128);
            // Default to true if not specified (apply fee share percentage)
            const shouldApplyFeeShare = applyFeeShare !== false;

            if (!sanitizedMint || amount === undefined) {
                return errorResponse(res, 400, 'mint and amount are required');
            }

            // Validate amount is a number
            const numAmount = parseFloat(amount);
            if (isNaN(numAmount) || numAmount <= 0) {
                return errorResponse(res, 400, 'amount must be a positive number');
            }

            const result = await pags.recordFeeCollection(
                sanitizedMint,
                numAmount,
                sanitizedSource || 'admin',
                sanitizedTxSignature,
                shouldApplyFeeShare
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

    /**
     * GET /api/admin/pags/beneficiaries
     * Get all beneficiaries with their fee share info (admin only)
     * v25.68: Now includes all beneficiary shares for multi-beneficiary tokens
     */
    router.get('/admin/pags/beneficiaries', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            // Pagination
            const limit = Math.min(parseInt(req.query.limit) || 50, 100);
            const offset = Math.max(parseInt(req.query.offset) || 0, 0);

            // v25.44: Get metadata directly from pags_beneficiaries (not tokens table)
            const beneficiaries = await db.all(`
                SELECT b.*
                FROM pags_beneficiaries b
                ORDER BY b."createdAt" DESC
                LIMIT $1 OFFSET $2
            `, [limit, offset]);

            const totalCount = await db.get('SELECT COUNT(*) as count FROM pags_beneficiaries');

            // v25.68: Get all beneficiary shares for each token
            const enhancedBeneficiaries = [];
            for (const b of beneficiaries) {
                // Get shares for this beneficiary
                const shares = await db.all(`
                    SELECT * FROM pags_beneficiary_shares
                    WHERE "beneficiaryId" = $1
                    ORDER BY "shareBps" DESC
                `, [b.id]);

                const isMultiBeneficiary = shares.length > 1;

                enhancedBeneficiaries.push({
                    ...b,
                    feeSharePercent: (b.feeShareBps || 10000) / 100,
                    hasMultipleRecipients: b.feeShareBps && b.feeShareBps < 10000,
                    pendingFees: (b.totalFeesAccumulated || 0) - (b.totalFeesClaimed || 0),
                    // v25.68: Include all beneficiary shares
                    isMultiBeneficiary,
                    shares: shares.length > 0 ? shares.map(s => ({
                        twitterUsername: s.twitterUsername,
                        shareBps: s.shareBps,
                        sharePercent: s.shareBps / 100,
                        totalFeesAccumulated: s.totalFeesAccumulated || 0,
                        totalFeesClaimed: s.totalFeesClaimed || 0
                    })) : [{
                        // Legacy single beneficiary fallback
                        twitterUsername: b.twitterUsername,
                        shareBps: 10000,
                        sharePercent: 100,
                        totalFeesAccumulated: b.totalFeesAccumulated || 0,
                        totalFeesClaimed: b.totalFeesClaimed || 0
                    }]
                });
            }

            res.json({
                success: true,
                beneficiaries: enhancedBeneficiaries,
                pagination: { limit, offset, total: totalCount?.count || 0 }
            });
        } catch (e) {
            logger.error('[PAGS API] Get beneficiaries error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch beneficiaries');
        }
    });

    /**
     * GET /api/admin/pags/users
     * Get all verified Twitter users (admin only)
     */
    router.get('/admin/pags/users', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            // Pagination
            const limit = Math.min(parseInt(req.query.limit) || 50, 100);
            const offset = Math.max(parseInt(req.query.offset) || 0, 0);

            const users = await db.all(`
                SELECT "twitterId", "twitterUsername", "displayName", "profileImageUrl",
                       "linkedWallet", "walletLinkedAt", "lastVerified", "createdAt", "isActive"
                FROM pags_twitter_users
                ORDER BY "createdAt" DESC
                LIMIT $1 OFFSET $2
            `, [limit, offset]);

            const totalCount = await db.get('SELECT COUNT(*) as count FROM pags_twitter_users');

            res.json({
                success: true,
                users,
                pagination: { limit, offset, total: totalCount?.count || 0 }
            });
        } catch (e) {
            logger.error('[PAGS API] Get users error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch users');
        }
    });

    /**
     * GET /api/admin/pags/claims
     * Get all claims with optional status filter (admin only)
     */
    router.get('/admin/pags/claims', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            // Pagination and filter
            const limit = Math.min(parseInt(req.query.limit) || 50, 100);
            const offset = Math.max(parseInt(req.query.offset) || 0, 0);
            const status = req.query.status;

            let query, params;
            if (status && ['pending', 'completed', 'failed'].includes(status)) {
                query = `
                    SELECT * FROM pags_claims
                    WHERE status = $1
                    ORDER BY "createdAt" DESC
                    LIMIT $2 OFFSET $3
                `;
                params = [status, limit, offset];
            } else {
                query = `
                    SELECT * FROM pags_claims
                    ORDER BY "createdAt" DESC
                    LIMIT $1 OFFSET $2
                `;
                params = [limit, offset];
            }

            const claims = await db.all(query, params);

            // v25.47 SECURITY: Use parameterized query to prevent SQL injection
            let totalCount;
            if (status && ['pending', 'completed', 'failed'].includes(status)) {
                totalCount = await db.get('SELECT COUNT(*) as count FROM pags_claims WHERE status = $1', [status]);
            } else {
                totalCount = await db.get('SELECT COUNT(*) as count FROM pags_claims');
            }

            res.json({
                success: true,
                claims,
                pagination: { limit, offset, total: totalCount?.count || 0 }
            });
        } catch (e) {
            logger.error('[PAGS API] Get claims error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch claims');
        }
    });

    /**
     * GET /api/admin/pags/wallet
     * Get PAGS wallet balance and status (admin only)
     */
    router.get('/admin/pags/wallet', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            // Get PAGS wallet address
            const pagsWalletAddress = config.PAGS_WALLET;
            if (!pagsWalletAddress) {
                return res.json({
                    success: true,
                    wallet: {
                        address: null,
                        balance: 0,
                        pendingClaims: 0,
                        configured: false
                    }
                });
            }

            // Get wallet balance
            let balance = 0;
            try {
                const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
                const pubkey = new PublicKey(pagsWalletAddress);
                const lamports = await connection.getBalance(pubkey);
                balance = lamports / LAMPORTS_PER_SOL;
            } catch (e) {
                logger.warn('[PAGS API] Could not fetch wallet balance', { error: e.message });
            }

            // Get total pending claims amount
            const pendingResult = await db.get(`
                SELECT COALESCE(SUM(amount), 0) as total
                FROM pags_claims
                WHERE status = 'pending'
            `);

            res.json({
                success: true,
                wallet: {
                    address: pagsWalletAddress,
                    balance,
                    pendingClaims: pendingResult?.total || 0,
                    configured: true
                }
            });
        } catch (e) {
            logger.error('[PAGS API] Get wallet error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fetch wallet info');
        }
    });

    /**
     * POST /api/admin/pags/deactivate/:mint
     * Admin override to deactivate PAGS for a token without creator signature
     */
    router.post('/admin/pags/deactivate/:mint', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            const mint = sanitizeString(req.params.mint, 64);
            if (!mint) {
                return errorResponse(res, 400, 'Invalid mint address');
            }

            // Check if beneficiary exists
            const beneficiary = await pags.getBeneficiaryByMint(mint);
            if (!beneficiary) {
                return errorResponse(res, 404, 'Beneficiary not found');
            }

            await pags.deactivateBeneficiary(mint);
            logger.info('[PAGS API] Admin deactivated beneficiary', { mint });

            res.json({ success: true, message: 'PAGS deactivated for this token' });
        } catch (e) {
            logger.error('[PAGS API] Admin deactivate error', { error: e.message });
            return errorResponse(res, 500, 'Failed to deactivate');
        }
    });

    /**
     * POST /api/admin/pags/backfill-metadata
     * Backfill token metadata for PAGS tokens that don't have it in the tokens table
     * This is useful for tokens registered before v25.53 when metadata storage was added
     */
    router.post('/admin/pags/backfill-metadata', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            // v25.44: Find PAGS beneficiaries without metadata in pags_beneficiaries table
            const beneficiariesWithoutMetadata = await db.all(`
                SELECT b.mint, b."creatorPubkey"
                FROM pags_beneficiaries b
                WHERE b."isActive" = 1 AND (b.ticker IS NULL OR b.ticker = '')
                LIMIT 50
            `);

            if (beneficiariesWithoutMetadata.length === 0) {
                return res.json({
                    success: true,
                    message: 'All PAGS tokens already have metadata',
                    processed: 0
                });
            }

            logger.info('[PAGS API] Backfilling metadata for tokens', {
                count: beneficiariesWithoutMetadata.length
            });

            // v25.44: Save to pags_beneficiaries table, NOT tokens table
            const postgres = require('../services/postgres');
            const results = { success: 0, failed: 0, details: [] };

            for (const b of beneficiariesWithoutMetadata) {
                try {
                    const metadata = await mintExtractor.fetchPumpFunTokenMetadata(b.mint);
                    if (metadata && metadata.ticker && metadata.name) {
                        // Save to pags_beneficiaries, NOT tokens table
                        await postgres.savePagsBeneficiaryMetadata(b.mint, {
                            ticker: metadata.ticker,
                            name: metadata.name,
                            image: metadata.image || ''
                        });
                        results.success++;
                        results.details.push({
                            mint: b.mint,
                            ticker: metadata.ticker,
                            status: 'success'
                        });
                    } else {
                        results.failed++;
                        results.details.push({
                            mint: b.mint,
                            status: 'no_metadata'
                        });
                    }
                } catch (e) {
                    results.failed++;
                    results.details.push({
                        mint: b.mint,
                        status: 'error',
                        error: e.message
                    });
                }

                // Rate limit API calls
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            logger.info('[PAGS API] Metadata backfill complete (saved to pags_beneficiaries)', {
                success: results.success,
                failed: results.failed
            });

            res.json({
                success: true,
                processed: beneficiariesWithoutMetadata.length,
                results
            });
        } catch (e) {
            logger.error('[PAGS API] Backfill metadata error', { error: e.message });
            return errorResponse(res, 500, 'Failed to backfill metadata');
        }
    });

    /**
     * POST /api/admin/pags/fix-creator-pubkeys
     * Re-verify and fix PAGS beneficiaries that have 'unknown' as creatorPubkey
     * This is needed for tokens registered before v25.54 when originalCreator wasn't
     * being returned for direct creators
     */
    router.post('/admin/pags/fix-creator-pubkeys', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            // Find PAGS beneficiaries with unknown creatorPubkey
            const beneficiariesWithUnknown = await db.all(`
                SELECT mint, "twitterUsername", "feeShareBps"
                FROM pags_beneficiaries
                WHERE "isActive" = 1 AND ("creatorPubkey" IS NULL OR "creatorPubkey" = 'unknown')
                LIMIT 50
            `);

            if (beneficiariesWithUnknown.length === 0) {
                return res.json({
                    success: true,
                    message: 'All PAGS tokens already have valid creatorPubkey',
                    processed: 0
                });
            }

            logger.info('[PAGS API] Fixing creatorPubkeys for beneficiaries', {
                count: beneficiariesWithUnknown.length
            });

            const results = { success: 0, failed: 0, details: [] };

            for (const b of beneficiariesWithUnknown) {
                try {
                    // Re-verify fee recipient to get the correct originalCreator
                    const feeRecipientResult = await mintExtractor.verifyFeeRecipient(
                        b.mint,
                        config.PAGS_WALLET,
                        connection
                    );

                    if (feeRecipientResult.isRecipient && feeRecipientResult.originalCreator) {
                        // Update the beneficiary with correct creatorPubkey
                        await db.run(
                            'UPDATE pags_beneficiaries SET "creatorPubkey" = $1, "feeShareBps" = $2 WHERE mint = $3',
                            [feeRecipientResult.originalCreator, feeRecipientResult.feeShareBps, b.mint]
                        );

                        results.success++;
                        results.details.push({
                            mint: b.mint,
                            creatorPubkey: feeRecipientResult.originalCreator,
                            feeShareBps: feeRecipientResult.feeShareBps,
                            status: 'fixed'
                        });

                        logger.info('[PAGS API] Fixed creatorPubkey', {
                            mint: b.mint,
                            creatorPubkey: feeRecipientResult.originalCreator.slice(0, 8) + '...',
                            feeShareBps: feeRecipientResult.feeShareBps
                        });
                    } else {
                        results.failed++;
                        results.details.push({
                            mint: b.mint,
                            status: 'not_recipient',
                            error: feeRecipientResult.error || 'Not a fee recipient'
                        });
                    }
                } catch (e) {
                    results.failed++;
                    results.details.push({
                        mint: b.mint,
                        status: 'error',
                        error: e.message
                    });
                }

                // Rate limit RPC calls
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            logger.info('[PAGS API] CreatorPubkey fix complete', {
                success: results.success,
                failed: results.failed
            });

            res.json({
                success: true,
                processed: beneficiariesWithUnknown.length,
                results
            });
        } catch (e) {
            logger.error('[PAGS API] Fix creatorPubkeys error', { error: e.message });
            return errorResponse(res, 500, 'Failed to fix creatorPubkeys');
        }
    });

    /**
     * POST /api/admin/pags/repair-all
     * Run all repair operations: fix creator pubkeys, backfill metadata
     * This is a combined endpoint for the admin panel
     */
    router.post('/admin/pags/repair-all', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            logger.info('[PAGS API] Starting full repair operation');

            const results = {
                creatorPubkeys: { success: 0, failed: 0, processed: 0 },
                metadata: { success: 0, failed: 0, processed: 0 },
                details: []
            };

            // Step 1: Fix creator pubkeys
            const beneficiariesWithUnknown = await db.all(`
                SELECT mint, "twitterUsername", "feeShareBps"
                FROM pags_beneficiaries
                WHERE "isActive" = 1 AND ("creatorPubkey" IS NULL OR "creatorPubkey" = 'unknown')
                LIMIT 100
            `);

            results.creatorPubkeys.processed = beneficiariesWithUnknown.length;

            for (const b of beneficiariesWithUnknown) {
                try {
                    const feeRecipientResult = await mintExtractor.verifyFeeRecipient(
                        b.mint,
                        config.PAGS_WALLET,
                        connection
                    );

                    if (feeRecipientResult.isRecipient && feeRecipientResult.originalCreator) {
                        await db.run(
                            'UPDATE pags_beneficiaries SET "creatorPubkey" = $1, "feeShareBps" = $2 WHERE mint = $3',
                            [feeRecipientResult.originalCreator, feeRecipientResult.feeShareBps, b.mint]
                        );
                        results.creatorPubkeys.success++;
                        results.details.push({ mint: b.mint, type: 'creatorPubkey', status: 'fixed' });
                    } else {
                        results.creatorPubkeys.failed++;
                        results.details.push({ mint: b.mint, type: 'creatorPubkey', status: 'failed' });
                    }
                } catch (e) {
                    results.creatorPubkeys.failed++;
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            // Step 2: Backfill metadata
            const postgres = require('../services/postgres');
            const beneficiariesWithoutMetadata = await db.all(`
                SELECT b.mint, b."creatorPubkey"
                FROM pags_beneficiaries b
                WHERE b."isActive" = 1 AND (b.ticker IS NULL OR b.ticker = '')
                LIMIT 100
            `);

            results.metadata.processed = beneficiariesWithoutMetadata.length;

            // v25.44: Save to pags_beneficiaries table, NOT tokens table
            for (const b of beneficiariesWithoutMetadata) {
                try {
                    const metadata = await mintExtractor.fetchPumpFunTokenMetadata(b.mint);
                    if (metadata && metadata.ticker && metadata.name) {
                        // Save to pags_beneficiaries, NOT tokens table
                        await postgres.savePagsBeneficiaryMetadata(b.mint, {
                            ticker: metadata.ticker,
                            name: metadata.name,
                            image: metadata.image || ''
                        });
                        results.metadata.success++;
                        results.details.push({ mint: b.mint, type: 'metadata', status: 'fixed', ticker: metadata.ticker });
                    } else {
                        results.metadata.failed++;
                    }
                } catch (e) {
                    results.metadata.failed++;
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            logger.info('[PAGS API] Full repair complete (metadata saved to pags_beneficiaries)', results);

            res.json({
                success: true,
                message: 'Repair operations completed',
                results
            });
        } catch (e) {
            logger.error('[PAGS API] Repair all error', { error: e.message });
            return errorResponse(res, 500, 'Failed to run repair operations');
        }
    });

    /**
     * POST /api/admin/pags/wipe
     * Wipe all PAGS data from the database (beneficiaries, users, claims)
     * DANGEROUS: This is irreversible!
     */
    router.post('/admin/pags/wipe', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            const { confirm } = req.body;
            if (confirm !== 'WIPE_ALL_PAGS_DATA') {
                return errorResponse(res, 400, 'Confirmation required. Send { "confirm": "WIPE_ALL_PAGS_DATA" }');
            }

            logger.warn('[PAGS API] !!! WIPING ALL PAGS DATA !!!');

            // Get counts before wiping
            const beforeStats = {
                beneficiaries: (await db.get('SELECT COUNT(*) as count FROM pags_beneficiaries'))?.count || 0,
                users: (await db.get('SELECT COUNT(*) as count FROM pags_twitter_users'))?.count || 0,
                claims: (await db.get('SELECT COUNT(*) as count FROM pags_claims'))?.count || 0,
                feeLogs: (await db.get('SELECT COUNT(*) as count FROM pags_fee_logs'))?.count || 0
            };

            // Wipe all PAGS tables (in correct order due to foreign key constraints)
            // v25.69 SECURITY: Must delete pags_beneficiary_shares before pags_beneficiaries
            await db.run('DELETE FROM pags_fee_logs');
            await db.run('DELETE FROM pags_claims');
            await db.run('DELETE FROM pags_twitter_users');
            await db.run('DELETE FROM pags_beneficiary_shares'); // Must come before beneficiaries (FK constraint)
            await db.run('DELETE FROM pags_beneficiaries');

            logger.warn('[PAGS API] PAGS data wiped', beforeStats);

            res.json({
                success: true,
                message: 'All PAGS data has been wiped',
                wiped: beforeStats
            });
        } catch (e) {
            logger.error('[PAGS API] Wipe error', { error: e.message });
            return errorResponse(res, 500, 'Failed to wipe PAGS data');
        }
    });

    /**
     * GET /api/admin/pags/health
     * Get PAGS system health and repair status
     */
    router.get('/admin/pags/health', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            // Get counts of issues
            const unknownCreatorCount = (await db.get(`
                SELECT COUNT(*) as count FROM pags_beneficiaries
                WHERE "isActive" = 1 AND ("creatorPubkey" IS NULL OR "creatorPubkey" = 'unknown')
            `))?.count || 0;

            // v25.44: Check metadata in pags_beneficiaries, not tokens table
            const missingMetadataCount = (await db.get(`
                SELECT COUNT(*) as count FROM pags_beneficiaries b
                WHERE b."isActive" = 1 AND (b.ticker IS NULL OR b.ticker = '')
            `))?.count || 0;

            const totalBeneficiaries = (await db.get('SELECT COUNT(*) as count FROM pags_beneficiaries WHERE "isActive" = 1'))?.count || 0;
            const totalUsers = (await db.get('SELECT COUNT(*) as count FROM pags_twitter_users'))?.count || 0;
            const pendingClaims = (await db.get('SELECT COUNT(*) as count FROM pags_claims WHERE status = $1', ['pending']))?.count || 0;

            res.json({
                success: true,
                health: {
                    totalBeneficiaries,
                    totalUsers,
                    pendingClaims,
                    issues: {
                        unknownCreatorPubkeys: unknownCreatorCount,
                        missingMetadata: missingMetadataCount
                    },
                    needsRepair: unknownCreatorCount > 0 || missingMetadataCount > 0
                }
            });
        } catch (e) {
            logger.error('[PAGS API] Health check error', { error: e.message });
            return errorResponse(res, 500, 'Failed to get health status');
        }
    });

    /**
     * GET /api/admin/pags/debug-vault/:mint
     * Debug reward vault detection for a specific token
     * Shows how the vault addresses are derived and their current balances
     */
    router.get('/admin/pags/debug-vault/:mint', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            const mint = sanitizeString(req.params.mint, 64);
            if (!mint) {
                return errorResponse(res, 400, 'Invalid mint address');
            }

            const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
            const pump = require('../services/pump');
            const pagsFeeScanner = require('../tasks/pagsFeeScanner');

            // Get beneficiary info from database
            const beneficiary = await db.get(
                'SELECT * FROM pags_beneficiaries WHERE mint = $1',
                [mint]
            );

            if (!beneficiary) {
                return res.json({
                    success: true,
                    debug: {
                        error: 'Beneficiary not found in database',
                        mint,
                        registered: false
                    }
                });
            }

            const debug = {
                mint,
                registered: true,
                database: {
                    twitterUsername: beneficiary.twitterUsername,
                    creatorPubkey: beneficiary.creatorPubkey,
                    feeShareBps: beneficiary.feeShareBps,
                    feeSharePercent: (beneficiary.feeShareBps || 10000) / 100,
                    totalFeesAccumulated: beneficiary.totalFeesAccumulated || 0,
                    totalFeesClaimed: beneficiary.totalFeesClaimed || 0,
                    dbPending: (beneficiary.totalFeesAccumulated || 0) - (beneficiary.totalFeesClaimed || 0),
                    isActive: beneficiary.isActive === 1,
                    createdAt: beneficiary.createdAt
                },
                vaultDerivation: null,
                onChainBalances: null,
                issues: []
            };

            // Check if creatorPubkey is valid
            if (!beneficiary.creatorPubkey || beneficiary.creatorPubkey === 'unknown') {
                debug.issues.push('creatorPubkey is missing or unknown - cannot derive vault addresses');
                return res.json({ success: true, debug });
            }

            try {
                const creatorPubkey = new PublicKey(beneficiary.creatorPubkey);
                const pagsWallet = config.PAGS_WALLET ? new PublicKey(config.PAGS_WALLET) : null;

                // Derive vault addresses
                const { bcVault, ammVaultAuth, ammVaultAta } = pump.getCreatorFeeVaults(creatorPubkey);
                const ammVaultAtaResolved = await ammVaultAta;

                debug.vaultDerivation = {
                    creatorPubkey: beneficiary.creatorPubkey,
                    pagsWallet: config.PAGS_WALLET || 'NOT CONFIGURED',
                    isDirectCreator: pagsWallet ? creatorPubkey.equals(pagsWallet) : false,
                    bcVault: bcVault.toString(),
                    ammVaultAuth: ammVaultAuth.toString(),
                    ammVaultAta: ammVaultAtaResolved.toString(),
                    derivationNote: 'Vaults are derived from creatorPubkey using PDA seeds "creator-vault" (BC) and "creator_vault" (AMM)'
                };

                // Fetch on-chain balances
                debug.onChainBalances = {
                    bcVault: { address: bcVault.toString(), balance: 0, balanceSol: 0, exists: false },
                    ammVault: { address: ammVaultAtaResolved.toString(), balance: 0, balanceSol: 0, exists: false }
                };

                // Check BC vault balance (native SOL)
                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo) {
                        debug.onChainBalances.bcVault.exists = true;
                        debug.onChainBalances.bcVault.balance = bcInfo.lamports;
                        debug.onChainBalances.bcVault.balanceSol = bcInfo.lamports / LAMPORTS_PER_SOL;
                        debug.onChainBalances.bcVault.rentExemptMin = 5000;
                        debug.onChainBalances.bcVault.claimableBalance = Math.max(0, bcInfo.lamports - 5000);
                        debug.onChainBalances.bcVault.claimableSol = Math.max(0, bcInfo.lamports - 5000) / LAMPORTS_PER_SOL;
                    }
                } catch (e) {
                    debug.onChainBalances.bcVault.error = e.message;
                }

                // Check AMM vault balance (wSOL token account)
                try {
                    const ammBalance = await connection.getTokenAccountBalance(ammVaultAtaResolved)
                        .catch(() => ({ value: { amount: "0" } }));
                    const ammLamports = parseInt(ammBalance.value.amount) || 0;
                    debug.onChainBalances.ammVault.exists = ammLamports > 0;
                    debug.onChainBalances.ammVault.balance = ammLamports;
                    debug.onChainBalances.ammVault.balanceSol = ammLamports / LAMPORTS_PER_SOL;
                } catch (e) {
                    debug.onChainBalances.ammVault.error = e.message;
                }

                // Calculate totals
                const bcClaimable = debug.onChainBalances.bcVault.claimableBalance || 0;
                const ammClaimable = debug.onChainBalances.ammVault.balance || 0;
                const totalOnChainLamports = bcClaimable + ammClaimable;
                const feeShareBps = beneficiary.feeShareBps || 10000;
                const ourShareLamports = Math.floor(totalOnChainLamports * (feeShareBps / 10000));

                debug.summary = {
                    totalOnChainLamports,
                    totalOnChainSol: totalOnChainLamports / LAMPORTS_PER_SOL,
                    feeShareBps,
                    ourShareLamports,
                    ourShareSol: ourShareLamports / LAMPORTS_PER_SOL,
                    dbPendingSol: debug.database.dbPending,
                    combinedPendingSol: (ourShareLamports / LAMPORTS_PER_SOL) + debug.database.dbPending
                };

                // Check for issues
                if (totalOnChainLamports === 0 && debug.database.dbPending === 0) {
                    debug.issues.push('Both on-chain vaults and database show 0 pending fees');
                }
                if (!debug.onChainBalances.bcVault.exists && !debug.onChainBalances.ammVault.exists) {
                    debug.issues.push('Neither vault account exists on-chain yet (no fees accumulated)');
                }
                if (debug.vaultDerivation.isDirectCreator && feeShareBps !== 10000) {
                    debug.issues.push('Mismatch: isDirectCreator but feeShareBps is not 10000');
                }

            } catch (e) {
                debug.issues.push(`Vault derivation error: ${e.message}`);
            }

            res.json({ success: true, debug });

        } catch (e) {
            logger.error('[PAGS API] Debug vault error', { error: e.message });
            return errorResponse(res, 500, 'Failed to debug vault');
        }
    });

    /**
     * POST /api/admin/pags/cleanup-tokens-table
     * v25.44: Remove PAGS-only tokens from the main tokens table
     * This fixes the bug where PAGS tokens were incorrectly appearing in the leaderboard
     * Only removes tokens that exist in pags_beneficiaries but NOT in robinhood_tokens
     */
    router.post('/admin/pags/cleanup-tokens-table', adminLimiter, async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-key'];
            if (!config.ADMIN_API_KEY || !timingSafeEqual(adminKey, config.ADMIN_API_KEY)) {
                return errorResponse(res, 401, 'Unauthorized');
            }

            const { confirm, dryRun } = req.body;
            const isDryRun = dryRun !== false; // Default to dry run for safety

            // Find tokens that are ONLY in PAGS (not in robinhood_tokens)
            const pagsOnlyTokens = await db.all(`
                SELECT t.mint, t.ticker, t.name, pb."twitterUsername"
                FROM tokens t
                INNER JOIN pags_beneficiaries pb ON t.mint = pb.mint
                LEFT JOIN robinhood_tokens rt ON t.mint = rt.mint
                WHERE rt.mint IS NULL
            `);

            if (pagsOnlyTokens.length === 0) {
                return res.json({
                    success: true,
                    message: 'No PAGS-only tokens found in the tokens table',
                    dryRun: isDryRun,
                    tokensFound: 0
                });
            }

            logger.info('[PAGS API] Found PAGS-only tokens in tokens table', {
                count: pagsOnlyTokens.length,
                tokens: pagsOnlyTokens.map(t => ({ mint: t.mint.slice(0, 8), ticker: t.ticker })),
                dryRun: isDryRun
            });

            if (isDryRun) {
                return res.json({
                    success: true,
                    message: 'Dry run - no changes made. Set dryRun: false to actually delete.',
                    dryRun: true,
                    tokensFound: pagsOnlyTokens.length,
                    tokensToRemove: pagsOnlyTokens.map(t => ({
                        mint: t.mint,
                        ticker: t.ticker,
                        name: t.name,
                        pagsUser: t.twitterUsername
                    }))
                });
            }

            if (confirm !== 'CLEANUP_PAGS_TOKENS') {
                return errorResponse(res, 400, 'Confirmation required. Send { "confirm": "CLEANUP_PAGS_TOKENS", "dryRun": false }');
            }

            // Delete the PAGS-only tokens from the tokens table
            const mintList = pagsOnlyTokens.map(t => t.mint);
            let deleted = 0;

            for (const mint of mintList) {
                try {
                    await db.run('DELETE FROM tokens WHERE mint = $1', [mint]);
                    deleted++;
                    logger.info('[PAGS API] Removed PAGS-only token from tokens table', { mint: mint.slice(0, 12) });
                } catch (e) {
                    logger.error('[PAGS API] Error removing token', { mint: mint.slice(0, 12), error: e.message });
                }
            }

            // Also delete any token_holders entries for these tokens
            for (const mint of mintList) {
                try {
                    await db.run('DELETE FROM token_holders WHERE mint = $1', [mint]);
                } catch (e) {
                    // Ignore errors for token_holders cleanup
                }
            }

            logger.warn('[PAGS API] Cleaned up PAGS-only tokens from tokens table', {
                deleted,
                total: mintList.length
            });

            res.json({
                success: true,
                message: `Removed ${deleted} PAGS-only tokens from the tokens table`,
                dryRun: false,
                deleted,
                removedTokens: pagsOnlyTokens.map(t => ({
                    mint: t.mint,
                    ticker: t.ticker,
                    pagsUser: t.twitterUsername
                }))
            });

        } catch (e) {
            logger.error('[PAGS API] Cleanup tokens table error', { error: e.message });
            return errorResponse(res, 500, 'Failed to cleanup tokens table');
        }
    });

    return router;
}

module.exports = { init };
