/**
 * Admin API-key middleware
 * v28.6 - The one copy. health.js and tokens.js each carried an identical implementation.
 *
 * Timing-safe comparison against ADMIN_API_KEY. Length is checked first because
 * timingSafeEqual throws on unequal lengths; the early length-compare leaks only the key's
 * length, which is not secret.
 */
const crypto = require('crypto');
const logger = require('../services/logger');

function adminAuth(req, res, next) {
    const apiKey = req.headers['x-admin-key'];
    const expectedKey = process.env.ADMIN_API_KEY;

    // SECURITY: Always require admin key - no environment exceptions
    if (!expectedKey) {
        logger.warn('Admin endpoint accessed but ADMIN_API_KEY not configured');
        return res.status(403).json({ error: 'Admin endpoints not configured' });
    }

    if (!apiKey || apiKey.length !== expectedKey.length ||
        !crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(expectedKey))) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

module.exports = adminAuth;
