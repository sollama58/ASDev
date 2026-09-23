/**
 * Admin API-key middleware
 * v28.6 - The one copy. health.js and tokens.js each carried an identical implementation.
 * v29.4 - Compare byte lengths, and never let the comparison throw.
 *
 * Timing-safe comparison against ADMIN_API_KEY. Lengths are compared first because
 * timingSafeEqual throws on unequal lengths; that comparison leaks only the key's length,
 * which is not secret.
 */
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const logger = require('../services/logger');

/**
 * v30.2: failed-attempt limiter for every admin route. The lockout used to exist only on
 * /admin/verify, the login form; the X-Admin-Key header on any other admin endpoint could be
 * guessed at the general API rate limit. Only failed attempts count (skipSuccessfulRequests),
 * so an operator using the console is never throttled.
 */
const adminFailureLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many failed admin attempts. Try again later.' },
});

function checkAdminKey(req, res, next) {
    const apiKey = req.headers['x-admin-key'];
    const expectedKey = process.env.ADMIN_API_KEY;

    // SECURITY: Always require admin key - no environment exceptions
    if (!expectedKey) {
        logger.warn('Admin endpoint accessed but ADMIN_API_KEY not configured');
        return res.status(403).json({ error: 'Admin endpoints not configured' });
    }

    // v29.4: the previous guard compared String.length, which counts UTF-16 code units, then
    // handed the values to timingSafeEqual, which compares BYTES. A header of the same
    // character length but a different byte length -- any multi-byte character will do --
    // passed the guard and made timingSafeEqual throw, turning a wrong key into a 500 from
    // the error handler instead of a clean 401. Not an auth bypass, but it let an
    // unauthenticated caller provoke an exception on every admin route.
    //
    // Duplicate x-admin-key headers arrive joined into one string, so this is always a
    // string; the typeof guard covers the malformed-request case regardless.
    if (typeof apiKey !== 'string') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const supplied = Buffer.from(apiKey, 'utf8');
    const expected = Buffer.from(expectedKey, 'utf8');

    let match = false;
    try {
        match = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    } catch (e) {
        // Defensive: the length check above already rules out the documented throw.
        match = false;
    }

    if (!match) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// Used as route middleware: router.get(path, adminAuth, handler). Express accepts an array.
const adminAuth = [adminFailureLimiter, checkAdminKey];

module.exports = adminAuth;
module.exports.checkAdminKey = checkAdminKey;
