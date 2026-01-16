/**
 * Signature Verifier Service
 * v25.22 SECURITY: Provides cryptographic signature verification for API endpoints
 *
 * Uses Ed25519 signatures to verify that requests are made by the wallet owner.
 * The client signs a message containing the action + timestamp + nonce, and
 * the server verifies the signature matches the claimed public key.
 */
const { PublicKey } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const logger = require('./logger');

// Signature validity window (5 minutes) - prevents replay attacks
const SIGNATURE_VALIDITY_MS = 300000;

// Nonce cache to prevent replay attacks within validity window
// Map<nonce, timestamp>
const usedNonces = new Map();

// Clean up old nonces every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [nonce, timestamp] of usedNonces.entries()) {
        if (now - timestamp > SIGNATURE_VALIDITY_MS * 2) {
            usedNonces.delete(nonce);
        }
    }
}, SIGNATURE_VALIDITY_MS);

/**
 * Verify a signed message from a Solana wallet
 *
 * Expected signature format from client:
 * - message: `${action}:${timestamp}:${nonce}` (e.g., "register-token:1705123456789:abc123")
 * - signature: base58 encoded Ed25519 signature
 * - publicKey: base58 encoded Solana public key
 *
 * @param {Object} params
 * @param {string} params.message - The message that was signed
 * @param {string} params.signature - Base58 encoded signature
 * @param {string} params.publicKey - Base58 encoded public key
 * @param {string} params.expectedAction - The action that should be in the message
 * @returns {Object} { valid: boolean, error?: string }
 */
function verifySignature({ message, signature, publicKey, expectedAction }) {
    try {
        // Validate inputs
        if (!message || !signature || !publicKey) {
            return { valid: false, error: 'Missing required signature fields' };
        }

        // Parse message format: action:timestamp:nonce
        const parts = message.split(':');
        if (parts.length !== 3) {
            return { valid: false, error: 'Invalid message format' };
        }

        const [action, timestampStr, nonce] = parts;
        const timestamp = parseInt(timestampStr, 10);

        // Validate action matches expected
        if (action !== expectedAction) {
            return { valid: false, error: `Invalid action. Expected ${expectedAction}, got ${action}` };
        }

        // Validate timestamp is within validity window
        const now = Date.now();
        if (isNaN(timestamp) || Math.abs(now - timestamp) > SIGNATURE_VALIDITY_MS) {
            return { valid: false, error: 'Signature expired or invalid timestamp' };
        }

        // Check for replay attack (nonce reuse)
        if (usedNonces.has(nonce)) {
            logger.warn('[SignatureVerifier] Replay attack detected', { nonce, publicKey: publicKey.slice(0, 8) });
            return { valid: false, error: 'Nonce already used (replay attack prevention)' };
        }

        // Validate public key format
        let pubkeyBytes;
        try {
            const pubkeyObj = new PublicKey(publicKey);
            pubkeyBytes = pubkeyObj.toBytes();
        } catch (e) {
            return { valid: false, error: 'Invalid public key format' };
        }

        // Decode signature from base58
        let signatureBytes;
        try {
            signatureBytes = bs58.decode(signature);
        } catch (e) {
            return { valid: false, error: 'Invalid signature format (not valid base58)' };
        }

        // Verify signature length (Ed25519 signatures are 64 bytes)
        if (signatureBytes.length !== 64) {
            return { valid: false, error: 'Invalid signature length' };
        }

        // Convert message to bytes
        const messageBytes = new TextEncoder().encode(message);

        // Verify the Ed25519 signature
        const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);

        if (!isValid) {
            return { valid: false, error: 'Signature verification failed' };
        }

        // Mark nonce as used (prevent replay)
        usedNonces.set(nonce, now);

        logger.debug('[SignatureVerifier] Signature verified', {
            publicKey: publicKey.slice(0, 8),
            action
        });

        return { valid: true };

    } catch (e) {
        logger.error('[SignatureVerifier] Unexpected error', { error: e.message });
        return { valid: false, error: 'Signature verification error' };
    }
}

/**
 * Express middleware to require signature verification
 *
 * Expects request body to contain:
 * - signedMessage: The message that was signed
 * - signature: Base58 encoded signature
 * - signerPubkey: The public key that signed (must match submitterPubkey or relevant field)
 *
 * @param {string} action - The expected action in the signed message
 * @returns Express middleware function
 */
function requireSignature(action) {
    return (req, res, next) => {
        const { signedMessage, signature, signerPubkey } = req.body;

        // Allow bypassing signature check in development (for testing)
        // SECURITY: This is BLOCKED in production regardless of env var
        if (process.env.NODE_ENV === 'development' && process.env.SKIP_SIGNATURE_VERIFICATION === 'true') {
            logger.warn('[SignatureVerifier] DEVELOPMENT MODE: Signature verification bypassed');
            return next();
        }

        // SECURITY: Double-check production mode never bypasses signature verification
        if (process.env.NODE_ENV === 'production' && !signedMessage) {
            logger.warn('[SignatureVerifier] Production mode - signature required');
            return res.status(401).json({
                success: false,
                error: 'Signature verification required',
                code: 'SIGNATURE_REQUIRED'
            });
        }

        const result = verifySignature({
            message: signedMessage,
            signature,
            publicKey: signerPubkey,
            expectedAction: action
        });

        if (!result.valid) {
            logger.warn('[SignatureVerifier] Request rejected', {
                action,
                error: result.error,
                ip: req.ip,
                pubkey: signerPubkey?.slice(0, 8)
            });
            return res.status(401).json({
                success: false,
                error: `Signature verification failed: ${result.error}`,
                code: 'SIGNATURE_INVALID'
            });
        }

        // Attach verified pubkey to request for downstream use
        req.verifiedPubkey = signerPubkey;
        next();
    };
}

/**
 * Generate a message for the client to sign
 * Client-side helper (can be used to document expected format)
 *
 * @param {string} action - The action being performed
 * @returns {Object} { message, timestamp, nonce }
 */
function generateSigningMessage(action) {
    const timestamp = Date.now();
    const nonce = Math.random().toString(36).substring(2, 15);
    const message = `${action}:${timestamp}:${nonce}`;
    return { message, timestamp, nonce };
}

module.exports = {
    verifySignature,
    requireSignature,
    generateSigningMessage,
    SIGNATURE_VALIDITY_MS
};
