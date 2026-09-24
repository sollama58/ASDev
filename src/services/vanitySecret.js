/**
 * Vanity Mint Secret Box
 * v28.1 - Encryption for pre-ground mint seeds at rest
 *
 * A ground mint seed is a live secret right up until the token is created: anyone holding it
 * can create that mint themselves and front-run the launch. It is therefore never written to
 * the database in the clear.
 *
 * This lives in its own module because the grinder runs as a *separate service* from the API.
 * Both processes must derive an identical key from VANITY_ENCRYPTION_KEY, which is why that
 * variable has no default: falling back to an ephemeral random value would make every stored
 * seed undecryptable after a restart, throwing away hours of grinding with no error until a
 * launch tried to use one. isConfigured() below is what keeps the grinder from persisting
 * anything it could not read back.
 */
const crypto = require('crypto');
const logger = require('./logger');
const config = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard nonce length

/**
 * Whether a stable encryption key is configured.
 *
 * The grinder refuses to persist anything without one, rather than burning CPU producing
 * keypairs nobody will be able to read back.
 */
function isConfigured() {
    return !!(config.VANITY_ENCRYPTION_KEY && config.VANITY_ENCRYPTION_KEY.length >= 16);
}

function getKey() {
    if (!isConfigured()) {
        throw new Error('VANITY_ENCRYPTION_KEY is not set (or is shorter than 16 characters)');
    }
    return crypto.createHash('sha256').update(config.VANITY_ENCRYPTION_KEY).digest();
}

/**
 * Encrypt a 32-byte mint seed.
 * @param {Buffer|Uint8Array} seed
 * @returns {string} "iv:authTag:ciphertext", all hex
 */
function encryptSeed(seed) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(seed)), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a stored seed.
 * @returns {Buffer|null} the 32-byte seed, or null if it cannot be read
 */
function decryptSeed(ciphertext) {
    if (!ciphertext) return null;
    try {
        const parts = String(ciphertext).split(':');
        if (parts.length !== 3) return null;
        const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(parts[0], 'hex'));
        decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
        return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]);
    } catch (e) {
        // A wrong key, a truncated row or a tampered ciphertext all land here. The caller
        // falls back to a random mint rather than failing the launch.
        logger.error('[Vanity] Could not decrypt mint seed — is VANITY_ENCRYPTION_KEY the same value the grinder used?', {
            error: e.message
        });
        return null;
    }
}

module.exports = { isConfigured, encryptSeed, decryptSeed };
