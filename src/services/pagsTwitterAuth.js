/**
 * PAGS Twitter OAuth Service
 * Handles Twitter OAuth 2.0 authentication for PAGS user login
 *
 * Uses OAuth 2.0 with PKCE for secure user authentication.
 * Reuses existing Twitter API credentials (TWITTER_APP_KEY/SECRET).
 *
 * Security features:
 * - OAuth tokens encrypted at rest (AES-256-GCM)
 * - Redis-based state storage for multi-instance support
 * - Session tokens via secure cookies (not URL parameters)
 */
const { TwitterApi } = require('twitter-api-v2');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('./logger');
const config = require('../config/env');

// Dependencies injected at init
let db = null;
let redis = null;

// Encryption key for OAuth tokens (derived from session secret)
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// OAuth state TTL (10 minutes)
const OAUTH_STATE_TTL_SECONDS = 600;

// In-memory fallback for OAuth state (only used if Redis unavailable)
const oauthStatesFallback = new Map();

// Clean up old OAuth states every 5 minutes (fallback only)
setInterval(() => {
    const now = Date.now();
    for (const [state, data] of oauthStatesFallback.entries()) {
        if (now - data.createdAt > 600000) {
            oauthStatesFallback.delete(state);
        }
    }
}, 300000);

/**
 * Derive encryption key from session secret
 */
function getEncryptionKey() {
    return crypto
        .createHash('sha256')
        .update(config.PAGS_SESSION_SECRET)
        .digest();
}

/**
 * Encrypt a string value
 */
function encrypt(plaintext) {
    if (!plaintext) return null;

    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getEncryptionKey();
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string value
 */
function decrypt(ciphertext) {
    if (!ciphertext) return null;

    try {
        const parts = ciphertext.split(':');
        if (parts.length !== 3) return null;

        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encrypted = parts[2];

        const key = getEncryptionKey();
        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (e) {
        logger.error('[PAGS Twitter Auth] Decryption failed', { error: e.message });
        return null;
    }
}

/**
 * Store OAuth state in Redis (or fallback to in-memory)
 */
async function storeOAuthState(state, data) {
    const stateData = {
        ...data,
        createdAt: Date.now()
    };

    if (redis) {
        try {
            // Use getConnection() which returns the IORedis client directly
            const client = redis.getConnection();
            if (client) {
                await client.set(
                    `pags:oauth:state:${state}`,
                    JSON.stringify(stateData),
                    'EX',
                    OAUTH_STATE_TTL_SECONDS
                );
                logger.debug('[PAGS Twitter Auth] State stored in Redis', {
                    state: state.slice(0, 8) + '...'
                });
                return 'redis';
            }
        } catch (e) {
            logger.warn('[PAGS Twitter Auth] Redis store failed, using fallback', { error: e.message });
        }
    }

    // Fallback to in-memory
    oauthStatesFallback.set(state, stateData);
    logger.debug('[PAGS Twitter Auth] State stored in memory fallback', {
        state: state.slice(0, 8) + '...'
    });
    return 'memory';
}

/**
 * Retrieve and delete OAuth state from Redis (or fallback)
 */
async function retrieveOAuthState(state) {
    if (redis) {
        try {
            // Use getConnection() which returns the IORedis client directly
            const client = redis.getConnection();
            if (client) {
                const data = await client.get(`pags:oauth:state:${state}`);
                if (data) {
                    // Delete after retrieval (one-time use)
                    await client.del(`pags:oauth:state:${state}`);
                    logger.debug('[PAGS Twitter Auth] State retrieved from Redis', {
                        state: state.slice(0, 8) + '...'
                    });
                    return JSON.parse(data);
                }
                logger.debug('[PAGS Twitter Auth] State not found in Redis, trying fallback', {
                    state: state.slice(0, 8) + '...'
                });
            }
        } catch (e) {
            logger.warn('[PAGS Twitter Auth] Redis retrieve failed, trying fallback', { error: e.message });
        }
    }

    // Fallback to in-memory
    const data = oauthStatesFallback.get(state);
    if (data) {
        oauthStatesFallback.delete(state);
        logger.debug('[PAGS Twitter Auth] State retrieved from memory fallback', {
            state: state.slice(0, 8) + '...'
        });
        return data;
    }

    logger.warn('[PAGS Twitter Auth] State not found anywhere', {
        state: state.slice(0, 8) + '...'
    });
    return null;
}

/**
 * Initialize the Twitter OAuth service
 */
function init(deps) {
    db = deps.db;
    redis = deps.redis || null;

    const hasCredentials = !!(config.TWITTER_OAUTH2_CLIENT_ID && config.TWITTER_OAUTH2_CLIENT_SECRET);

    logger.info('[PAGS Twitter Auth] Service initialized', {
        credentialsConfigured: hasCredentials,
        clientIdConfigured: !!config.TWITTER_OAUTH2_CLIENT_ID,
        callbackUrl: config.TWITTER_OAUTH_CALLBACK_URL,
        redisAvailable: !!redis,
        encryptionEnabled: true
    });

    return hasCredentials;
}

/**
 * Generate a random state parameter for OAuth
 */
function generateState() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

    return { codeVerifier, codeChallenge };
}

/**
 * Validate redirect URL to prevent open redirect attacks
 * Allows relative paths, same-origin URLs, or the configured FRONTEND_URL
 *
 * For cross-origin setups: Uses FRONTEND_URL directly as the redirect destination
 */
function validateRedirectUrl(url, baseUrl) {
    // Default to FRONTEND_URL if no URL provided or if it's just a relative path
    const defaultRedirect = config.FRONTEND_URL || config.FRONTEND_PATH || '/';

    // If no URL provided, use the default
    if (!url) return defaultRedirect;

    // Handle relative paths starting with /
    if (url.startsWith('/') && !url.startsWith('//')) {
        // Block any URL encoding tricks
        const decoded = decodeURIComponent(url);
        if (decoded.startsWith('/') && !decoded.startsWith('//') && !decoded.includes('://')) {
            // For cross-origin setups with FRONTEND_URL configured as full URL,
            // just use FRONTEND_URL directly (it already contains the path)
            if (config.FRONTEND_URL && config.FRONTEND_URL.startsWith('http')) {
                // FRONTEND_URL is already the complete frontend URL (e.g., https://alonisthe.dev/ignition)
                // Don't append the relative path again
                return config.FRONTEND_URL;
            }
            // For same-origin, keep as relative
            return url;
        }
    }

    // If it's an absolute URL, verify it's allowed
    try {
        const redirectUrl = new URL(url);
        const base = new URL(baseUrl || config.BASE_URL || 'http://localhost:3000');

        // Allow same origin as backend
        if (redirectUrl.origin === base.origin) {
            return url;
        }

        // Also allow the configured FRONTEND_URL origin (for cross-origin setups)
        if (config.FRONTEND_URL && config.FRONTEND_URL.startsWith('http')) {
            const frontendUrl = new URL(config.FRONTEND_URL);
            if (redirectUrl.origin === frontendUrl.origin) {
                return url;
            }
        }
    } catch (e) {
        // Invalid URL, fall through to default
    }

    logger.warn('[PAGS Twitter Auth] Invalid redirect URL blocked', { url: url.slice(0, 100) });
    return defaultRedirect;
}

/**
 * Get the Twitter OAuth 2.0 authorization URL
 */
async function getAuthorizationUrl(redirectAfterAuth = '/') {
    if (!config.TWITTER_OAUTH2_CLIENT_ID || !config.TWITTER_OAUTH2_CLIENT_SECRET) {
        throw new Error('Twitter OAuth 2.0 credentials not configured. Set TWITTER_OAUTH2_CLIENT_ID and TWITTER_OAUTH2_CLIENT_SECRET, or TWITTER_APP_KEY/SECRET.');
    }

    // Create OAuth 2.0 client
    const client = new TwitterApi({
        clientId: config.TWITTER_OAUTH2_CLIENT_ID,
        clientSecret: config.TWITTER_OAUTH2_CLIENT_SECRET,
    });

    // Build callback URL using config.BASE_URL
    const callbackUrl = config.TWITTER_OAUTH_CALLBACK_URL.startsWith('http')
        ? config.TWITTER_OAUTH_CALLBACK_URL
        : `${config.BASE_URL}${config.TWITTER_OAUTH_CALLBACK_URL}`;

    // Validate redirect URL - default to FRONTEND_URL if not specified
    const defaultRedirect = config.FRONTEND_URL || config.FRONTEND_PATH || '/';
    const safeRedirect = validateRedirectUrl(redirectAfterAuth || defaultRedirect, config.BASE_URL);

    // Generate auth link with OAuth 2.0
    // IMPORTANT: The library generates PKCE (codeVerifier) internally - we must use its returned value
    const { url, codeVerifier, state } = client.generateOAuth2AuthLink(
        callbackUrl,
        {
            scope: ['tweet.read', 'users.read', 'offline.access']
        }
    );

    // Store state and verifier in Redis
    // The codeVerifier is generated by the library as part of PKCE
    const storeResult = await storeOAuthState(state, {
        codeVerifier,
        redirectAfterAuth: safeRedirect
    });

    logger.info('[PAGS Twitter Auth] Auth URL generated', {
        state: state.slice(0, 8) + '...',
        callbackUrl,
        baseUrl: config.BASE_URL,
        codeVerifierLength: codeVerifier.length,
        codeVerifierPrefix: codeVerifier.slice(0, 8) + '...',
        storedToRedis: storeResult
    });

    return { url, state };
}

/**
 * Handle OAuth callback and exchange code for tokens
 */
async function handleCallback(code, state) {
    if (!code || !state) {
        throw new Error('Missing code or state parameter');
    }

    // Retrieve stored state data from Redis
    const stateData = await retrieveOAuthState(state);
    if (!stateData) {
        throw new Error('Invalid or expired OAuth state');
    }

    logger.info('[PAGS Twitter Auth] State retrieved for callback', {
        state: state.slice(0, 8) + '...',
        codeVerifierLength: stateData.codeVerifier?.length,
        codeVerifierPrefix: stateData.codeVerifier?.slice(0, 8) + '...',
        hasRedirectAfterAuth: !!stateData.redirectAfterAuth
    });

    // Create client for token exchange
    const client = new TwitterApi({
        clientId: config.TWITTER_OAUTH2_CLIENT_ID,
        clientSecret: config.TWITTER_OAUTH2_CLIENT_SECRET,
    });

    // Build callback URL using config.BASE_URL
    const callbackUrl = config.TWITTER_OAUTH_CALLBACK_URL.startsWith('http')
        ? config.TWITTER_OAUTH_CALLBACK_URL
        : `${config.BASE_URL}${config.TWITTER_OAUTH_CALLBACK_URL}`;

    try {
        // Exchange code for tokens
        const { accessToken, refreshToken, expiresIn } = await client.loginWithOAuth2({
            code,
            codeVerifier: stateData.codeVerifier,
            redirectUri: callbackUrl,
        });

        // Get user info
        const userClient = new TwitterApi(accessToken);
        const { data: userData } = await userClient.v2.me({
            'user.fields': ['profile_image_url', 'name', 'username']
        });

        // Calculate token expiration
        const tokenExpiresAt = Date.now() + (expiresIn * 1000);

        // Encrypt tokens before storing
        const encryptedAccessToken = encrypt(accessToken);
        const encryptedRefreshToken = encrypt(refreshToken);

        // Store or update user in database
        const existingUser = await db.get(
            'SELECT * FROM pags_twitter_users WHERE "twitterId" = $1',
            [userData.id]
        );

        if (existingUser) {
            // Update existing user
            await db.run(`
                UPDATE pags_twitter_users
                SET "twitterUsername" = $1, "displayName" = $2, "profileImageUrl" = $3,
                    "accessToken" = $4, "refreshToken" = $5, "tokenExpiresAt" = $6,
                    "lastVerified" = $7, "isActive" = 1
                WHERE "twitterId" = $8
            `, [
                userData.username,
                userData.name,
                userData.profile_image_url,
                encryptedAccessToken,
                encryptedRefreshToken,
                tokenExpiresAt,
                Date.now(),
                userData.id
            ]);
        } else {
            // Create new user
            await db.run(`
                INSERT INTO pags_twitter_users
                ("twitterId", "twitterUsername", "displayName", "profileImageUrl",
                 "accessToken", "refreshToken", "tokenExpiresAt", "lastVerified", "createdAt")
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [
                userData.id,
                userData.username,
                userData.name,
                userData.profile_image_url,
                encryptedAccessToken,
                encryptedRefreshToken,
                tokenExpiresAt,
                Date.now(),
                Date.now()
            ]);
        }

        // Generate session token (JWT)
        const sessionToken = generateSessionToken(userData.id, userData.username);

        logger.info('[PAGS Twitter Auth] User authenticated', {
            twitterId: userData.id,
            username: userData.username
        });

        return {
            success: true,
            sessionToken,
            user: {
                twitterId: userData.id,
                username: userData.username,
                displayName: userData.name,
                profileImageUrl: userData.profile_image_url
            },
            redirectAfterAuth: stateData.redirectAfterAuth
        };
    } catch (e) {
        // Log detailed error for debugging
        logger.error('[PAGS Twitter Auth] Callback error', {
            error: e.message,
            code: e.code,
            data: e.data,
            callbackUrl,
            hasCodeVerifier: !!stateData.codeVerifier
        });
        throw new Error('Failed to complete Twitter authentication');
    }
}

/**
 * Generate a session JWT token
 * SECURITY: Include jti (JWT ID) for potential token revocation
 */
function generateSessionToken(twitterId, username) {
    return jwt.sign(
        {
            twitterId,
            username,
            type: 'pags_session',
            jti: crypto.randomBytes(16).toString('hex'), // Unique token ID
            iat: Math.floor(Date.now() / 1000)
        },
        config.PAGS_SESSION_SECRET,
        {
            expiresIn: '24h',
            algorithm: 'HS256'
        }
    );
}

/**
 * Verify and decode a session token
 * SECURITY: Explicitly specify allowed algorithms to prevent algorithm confusion attacks
 */
function verifySessionToken(token) {
    try {
        const decoded = jwt.verify(token, config.PAGS_SESSION_SECRET, {
            algorithms: ['HS256'], // SECURITY: Only allow expected algorithm
            complete: false
        });

        if (decoded.type !== 'pags_session') {
            logger.warn('[PAGS Session] Token type mismatch', { type: decoded.type });
            return { valid: false, error: 'Invalid token type' };
        }

        // SECURITY: Validate required claims
        if (!decoded.twitterId || !decoded.jti) {
            logger.warn('[PAGS Session] Token missing required claims', {
                hasTwitterId: !!decoded.twitterId,
                hasJti: !!decoded.jti
            });
            return { valid: false, error: 'Invalid token structure' };
        }

        logger.info('[PAGS Session] Token verified successfully', {
            twitterId: decoded.twitterId,
            username: decoded.username
        });

        return {
            valid: true,
            twitterId: decoded.twitterId,
            username: decoded.username,
            jti: decoded.jti
        };
    } catch (e) {
        logger.warn('[PAGS Session] JWT verification error', {
            errorName: e.name,
            errorMessage: e.message,
            secretConfigured: !!config.PAGS_SESSION_SECRET,
            secretLength: config.PAGS_SESSION_SECRET ? config.PAGS_SESSION_SECRET.length : 0
        });
        if (e.name === 'TokenExpiredError') {
            return { valid: false, error: 'Session expired' };
        }
        if (e.name === 'JsonWebTokenError') {
            return { valid: false, error: 'Invalid session token' };
        }
        return { valid: false, error: 'Token verification failed' };
    }
}

/**
 * Get user info from session token
 */
async function getUserFromSession(sessionToken) {
    const decoded = verifySessionToken(sessionToken);

    if (!decoded.valid) {
        return { error: decoded.error };
    }

    // Get full user info from database
    const user = await db.get(
        'SELECT * FROM pags_twitter_users WHERE "twitterId" = $1 AND "isActive" = 1',
        [decoded.twitterId]
    );

    if (!user) {
        return { error: 'User not found' };
    }

    return {
        twitterId: user.twitterId,
        username: user.twitterUsername,
        displayName: user.displayName,
        profileImageUrl: user.profileImageUrl,
        linkedWallet: user.linkedWallet,
        walletLinkedAt: user.walletLinkedAt,
        createdAt: user.createdAt
    };
}

/**
 * Refresh access token if needed
 */
async function refreshTokenIfNeeded(twitterId) {
    const user = await db.get(
        'SELECT * FROM pags_twitter_users WHERE "twitterId" = $1',
        [twitterId]
    );

    if (!user || !user.refreshToken) {
        return null;
    }

    // Decrypt the refresh token
    const decryptedRefreshToken = decrypt(user.refreshToken);
    if (!decryptedRefreshToken) {
        logger.error('[PAGS Twitter Auth] Failed to decrypt refresh token', { twitterId });
        return null;
    }

    // Check if token is expired or about to expire (within 5 minutes)
    if (user.tokenExpiresAt && user.tokenExpiresAt > Date.now() + 300000) {
        // Token still valid - decrypt and return
        const decryptedAccessToken = decrypt(user.accessToken);
        return decryptedAccessToken;
    }

    try {
        const client = new TwitterApi({
            clientId: config.TWITTER_OAUTH2_CLIENT_ID,
            clientSecret: config.TWITTER_OAUTH2_CLIENT_SECRET,
        });

        const { accessToken, refreshToken, expiresIn } = await client.refreshOAuth2Token(decryptedRefreshToken);

        const tokenExpiresAt = Date.now() + (expiresIn * 1000);

        // Encrypt new tokens
        const encryptedAccessToken = encrypt(accessToken);
        const encryptedRefreshToken = encrypt(refreshToken);

        // Update tokens in database
        await db.run(`
            UPDATE pags_twitter_users
            SET "accessToken" = $1, "refreshToken" = $2, "tokenExpiresAt" = $3
            WHERE "twitterId" = $4
        `, [encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt, twitterId]);

        logger.info('[PAGS Twitter Auth] Token refreshed', { twitterId });

        return accessToken;
    } catch (e) {
        logger.error('[PAGS Twitter Auth] Token refresh failed', { error: e.message, twitterId });
        return null;
    }
}

/**
 * Verify that a user still owns their claimed username
 * (Usernames can change on Twitter)
 * Returns verification result - callers should handle failure appropriately
 */
async function verifyUsername(twitterId) {
    const accessToken = await refreshTokenIfNeeded(twitterId);

    if (!accessToken) {
        return { verified: false, error: 'Could not refresh access token', shouldBlock: true };
    }

    try {
        const client = new TwitterApi(accessToken);
        const { data: userData } = await client.v2.me();

        // Update username if changed
        await db.run(`
            UPDATE pags_twitter_users
            SET "twitterUsername" = $1, "lastVerified" = $2
            WHERE "twitterId" = $3
        `, [userData.username, Date.now(), twitterId]);

        return {
            verified: true,
            currentUsername: userData.username,
            shouldBlock: false
        };
    } catch (e) {
        logger.error('[PAGS Twitter Auth] Username verification failed', { error: e.message, twitterId });
        return { verified: false, error: 'Failed to verify username', shouldBlock: true };
    }
}

/**
 * Express middleware to require PAGS session
 * Supports both Authorization header and cookies
 * v25.69 SECURITY: Now checks for revoked tokens
 */
async function requireSession(req, res, next) {
    let token = null;

    // Try Authorization header first
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }

    // Fall back to cookie
    if (!token && req.cookies && req.cookies.pags_session) {
        token = req.cookies.pags_session;
    }

    // Log session check (use info level to ensure it appears in production logs)
    logger.info('[PAGS Session] requireSession check', {
        path: req.path,
        hasAuthHeader: !!authHeader,
        authHeaderPrefix: authHeader ? authHeader.substring(0, 15) + '...' : null,
        hasCookie: !!(req.cookies && req.cookies.pags_session),
        tokenFound: !!token,
        tokenLength: token ? token.length : 0,
        origin: req.headers.origin
    });

    if (!token) {
        logger.warn('[PAGS Session] No token found', {
            path: req.path,
            origin: req.headers.origin,
            hasAuthHeader: !!authHeader,
            hasCookies: !!req.cookies
        });
        return res.status(401).json({
            success: false,
            error: 'Authorization required',
            code: 'NO_SESSION'
        });
    }

    const decoded = verifySessionToken(token);

    if (!decoded.valid) {
        logger.warn('[PAGS Session] Token validation failed', {
            path: req.path,
            error: decoded.error,
            tokenLength: token.length
        });
        return res.status(401).json({
            success: false,
            error: decoded.error,
            code: 'INVALID_SESSION'
        });
    }

    // v25.69 SECURITY: Check if token has been revoked
    if (decoded.jti && await isTokenRevoked(decoded.jti)) {
        logger.warn('[PAGS Session] Revoked token rejected', {
            path: req.path,
            jti: decoded.jti.slice(0, 8) + '...'
        });
        return res.status(401).json({
            success: false,
            error: 'Session has been revoked',
            code: 'SESSION_REVOKED'
        });
    }

    // Attach session info to request
    req.pagsSession = {
        twitterId: decoded.twitterId,
        username: decoded.username,
        jti: decoded.jti,
        token: token // v25.69: Store token for revocation on logout
    };

    next();
}

/**
 * Set session cookie on response
 */
function setSessionCookie(res, sessionToken) {
    res.cookie('pags_session', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        path: '/'
    });
}

/**
 * Clear session cookie
 */
function clearSessionCookie(res) {
    res.clearCookie('pags_session', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
    });
}

/**
 * v25.69 SECURITY: Revoke a session token by adding its jti to blacklist
 * Tokens are stored in Redis with TTL matching token expiry
 */
async function revokeSessionToken(token) {
    const decoded = verifySessionToken(token);
    if (!decoded.valid || !decoded.jti) {
        return { success: false, error: 'Invalid token' };
    }

    if (redis) {
        try {
            const client = redis.getConnection();
            if (client) {
                // Store revoked jti in Redis with 24h TTL (matches token expiry)
                await client.set(`pags:revoked:${decoded.jti}`, '1', 'EX', 86400);
                logger.info('[PAGS Twitter Auth] Session token revoked', {
                    twitterId: decoded.twitterId,
                    jti: decoded.jti.slice(0, 8) + '...'
                });
                return { success: true };
            }
        } catch (e) {
            logger.error('[PAGS Twitter Auth] Failed to revoke token in Redis', { error: e.message });
        }
    }

    // If Redis unavailable, we can't reliably revoke - log warning
    logger.warn('[PAGS Twitter Auth] Cannot revoke token - Redis unavailable');
    return { success: false, error: 'Token revocation unavailable' };
}

/**
 * v25.69 SECURITY: Check if a session token has been revoked
 */
async function isTokenRevoked(jti) {
    if (!redis || !jti) return false;

    try {
        const client = redis.getConnection();
        if (client) {
            const revoked = await client.get(`pags:revoked:${jti}`);
            return revoked === '1';
        }
    } catch (e) {
        logger.debug('[PAGS Twitter Auth] Error checking revoked token', { error: e.message });
    }

    return false;
}

module.exports = {
    init,
    getAuthorizationUrl,
    handleCallback,
    generateSessionToken,
    verifySessionToken,
    getUserFromSession,
    refreshTokenIfNeeded,
    verifyUsername,
    requireSession,
    setSessionCookie,
    clearSessionCookie,
    validateRedirectUrl,
    revokeSessionToken,
    isTokenRevoked
};
