/**
 * Platform wallet signer
 * v30.4 - The one place that touches the platform wallet's private key.
 *
 * Before this module the decoded Keypair sat on `config.devKeypair` and on the `deps` bag that
 * is handed to every route and task. A Keypair serialises its secret key as plain numbers, so a
 * single `logger.info('...', { deps })` or `res.json(config)` anywhere in the codebase -- or in
 * a dependency -- would have printed the key. Nothing does today; the point is that nothing can.
 *
 * A signer exposes the public key and three signing methods and nothing else. The secret lives
 * in a closure: it is not a property, it is not enumerable, and `JSON.stringify` / `util.inspect`
 * of a signer print only the public key. Everything that used to call `tx.sign(devKeypair)` now
 * asks the signer for a detached signature over the message bytes and attaches it with
 * `addSignature`, which is byte-for-byte what `Transaction.sign()` produces (verified in the test
 * harness) but works identically whether the key is in this process or behind a remote API.
 *
 * Backends (WALLET_SIGNER):
 *
 *   local  (default) The key is in this process. Read from DEV_WALLET_KEY_FILE (a Render Secret
 *          File, or any path) if set, else from DEV_WALLET_PRIVATE_KEY. Either may hold the key
 *          in the clear (base58, or the JSON byte array solana-keygen writes) or as an encrypted
 *          envelope produced by `node scripts/wallet-key.js encrypt`, unlocked with
 *          DEV_WALLET_KEY_PASSPHRASE. With the envelope, the file/env var alone and the
 *          passphrase alone are each useless: an operator who can read the dashboard needs the
 *          secret file too, and vice versa.
 *
 *   vault  The key never enters this process. Signing is delegated to a HashiCorp Vault Transit
 *          ed25519 key (VAULT_ADDR, VAULT_TOKEN, VAULT_TRANSIT_KEY, optional VAULT_TRANSIT_MOUNT
 *          and VAULT_NAMESPACE). Vault can be self-hosted or HCP Vault Dedicated; the key is
 *          non-exportable, every signature is audit-logged, and revoking the token stops the
 *          platform from signing without touching the key.
 *
 * Adding another remote signer (Turnkey, Fireblocks, a KMS with Ed25519) means implementing one
 * function: bytes in, 64-byte signature out. See makeSigner().
 */
const crypto = require('crypto');
const fs = require('fs');
const util = require('util');
const nacl = require('tweetnacl');
const bs58lib = require('bs58');
const { PublicKey } = require('@solana/web3.js');
const logger = require('./logger');

const bs58 = bs58lib.default || bs58lib;

const ENVELOPE_VERSION = 1;
// scrypt parameters: ~100ms on a laptop core, 64MB of memory. Deliberately expensive: an
// attacker with the envelope must pay this per passphrase guess.
const SCRYPT = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

// The env vars that hold key material or unlock it. Deleted from process.env once the signer
// exists (see scrubSecretsFromEnv), so no later code path, dependency or child process can
// read them back. They are only ever needed once, at boot.
const SECRET_ENV_KEYS = ['DEV_WALLET_PRIVATE_KEY', 'DEV_WALLET_KEY_PASSPHRASE', 'VAULT_TOKEN', 'DEV_WALLET_KEY_FILE_EPHEMERAL'];

/* ────────────────────────────────────────────────────────────────────────────
   Key material parsing
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Turn a 32-byte seed or a 64-byte secret key into a 64-byte secret key.
 * Returns a fresh buffer; the caller owns (and should zero) the input.
 */
function toSecretKey(bytes, what) {
    if (bytes.length === 64) return Uint8Array.from(bytes);
    if (bytes.length === 32) return nacl.sign.keyPair.fromSeed(Uint8Array.from(bytes)).secretKey;
    throw new Error(`${what}: expected 32 or 64 bytes of key material, got ${bytes.length}`);
}

/**
 * Parse whatever a key file or env var contains into a 64-byte secret key.
 *
 * Accepted: base58 (Phantom/solana-keygen export), a JSON array of bytes (solana-keygen's
 * id.json), or an encrypted envelope (JSON object with "v" and "ct"), which is unlocked with the
 * passphrase and then parsed again.
 */
function parseKeyMaterial(text, passphrase, depth = 0) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('wallet key is empty');
    if (depth > 1) throw new Error('wallet key envelope is nested');

    if (trimmed[0] === '{') {
        let env;
        try { env = JSON.parse(trimmed); } catch (e) { throw new Error('wallet key envelope is not valid JSON'); }
        if (!passphrase) {
            throw new Error('wallet key is encrypted but DEV_WALLET_KEY_PASSPHRASE is not set');
        }
        const inner = decryptEnvelope(env, passphrase);
        try {
            return parseKeyMaterial(inner.toString('utf8'), null, depth + 1);
        } finally {
            inner.fill(0);
        }
    }

    if (trimmed[0] === '[') {
        let arr;
        try { arr = JSON.parse(trimmed); } catch (e) { throw new Error('wallet key byte array is not valid JSON'); }
        if (!Array.isArray(arr) || !arr.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
            throw new Error('wallet key byte array must contain integers 0-255');
        }
        return toSecretKey(Uint8Array.from(arr), 'wallet key byte array');
    }

    let decoded;
    try { decoded = bs58.decode(trimmed); } catch (e) { throw new Error('wallet key is not valid base58'); }
    return toSecretKey(decoded, 'wallet key');
}

/* ────────────────────────────────────────────────────────────────────────────
   Encrypted envelope (AES-256-GCM, scrypt-derived key)
   ──────────────────────────────────────────────────────────────────────────── */

function deriveKey(passphrase, salt) {
    return crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, 32, SCRYPT);
}

/**
 * Encrypt key material (any of the clear-text forms above) under a passphrase.
 * @returns {string} a JSON envelope safe to store in a file or env var
 */
function encryptEnvelope(plaintext, passphrase) {
    if (!passphrase || String(passphrase).length < 12) {
        throw new Error('passphrase must be at least 12 characters');
    }
    // Validate before encrypting so a typo is caught now, not at the next deploy.
    parseKeyMaterial(plaintext, null).fill(0);

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext).trim(), 'utf8')), cipher.final()]);
    key.fill(0);
    return JSON.stringify({
        v: ENVELOPE_VERSION,
        kdf: 'scrypt',
        N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ct.toString('base64'),
    });
}

function decryptEnvelope(env, passphrase) {
    if (env.v !== ENVELOPE_VERSION || env.kdf !== 'scrypt') {
        throw new Error(`unsupported wallet key envelope (v=${env.v}, kdf=${env.kdf})`);
    }
    const params = { N: env.N || SCRYPT.N, r: env.r || SCRYPT.r, p: env.p || SCRYPT.p, maxmem: SCRYPT.maxmem };
    const key = crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), Buffer.from(env.salt, 'base64'), 32, params);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
    } catch (e) {
        // GCM authentication failure: wrong passphrase or a tampered envelope. Same message
        // for both on purpose.
        throw new Error('wallet key envelope could not be decrypted (wrong passphrase?)');
    } finally {
        key.fill(0);
    }
}

/* ────────────────────────────────────────────────────────────────────────────
   Signer objects
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Wrap a raw "sign these bytes" function in the signer interface.
 *
 * The returned object is frozen and carries nothing but the public key, so it is safe to put
 * on `deps`, to log, and to serialise.
 */
function makeSigner(kind, publicKey, signBytes, extra = {}) {
    const pubkeyStr = publicKey.toBase58();
    const { policy = null, ...rest } = extra;
    const signer = {
        kind,
        publicKey,
        policyMode: policy ? policy.mode : 'off',
        ...rest,

        /**
         * Detached ed25519 signature over a transaction message. With a policy attached
         * (services/signingPolicy.js) the bytes must be a transaction the policy accepts;
         * there is no way to sign around it.
         */
        async signMessage(bytes) {
            if (policy) policy.check(bytes, publicKey);
            const sig = await signBytes(Uint8Array.from(bytes));
            if (!(sig instanceof Uint8Array) || sig.length !== 64) {
                throw new Error(`${kind} signer returned a ${sig?.length}-byte signature, expected 64`);
            }
            return sig;
        },

        /**
         * Sign a legacy Transaction as fee payer, after any extra keypairs (the mint on a
         * launch) have co-signed. Safe to call again on the same transaction after its
         * blockhash changes: every signature is replaced.
         */
        async signTransaction(tx, extraSigners = []) {
            if (!tx.feePayer) tx.feePayer = publicKey;
            for (const kp of extraSigners) tx.partialSign(kp);
            const sig = await signer.signMessage(tx.serializeMessage());
            tx.addSignature(publicKey, Buffer.from(sig));
            return tx;
        },

        /** Sign a VersionedTransaction (Jupiter swaps) as its fee payer. */
        async signVersionedTransaction(vtx) {
            const sig = await signer.signMessage(vtx.message.serialize());
            vtx.addSignature(publicKey, sig);
            return vtx;
        },

        toJSON() { return { kind, publicKey: pubkeyStr }; },
        [util.inspect.custom]() { return `Signer<${kind} ${pubkeyStr}>`; },
        toString() { return `Signer<${kind} ${pubkeyStr}>`; },
    };
    return Object.freeze(signer);
}

/**
 * A signer holding the secret key in this process.
 * @param {Uint8Array} secretKey 64 bytes; zeroed by this function once copied
 */
function createLocalSigner(secretKey, source = 'memory', policy = null) {
    const kp = nacl.sign.keyPair.fromSecretKey(Uint8Array.from(secretKey));
    secretKey.fill(0);
    const sk = kp.secretKey; // the only reference; captured by the closure below
    const publicKey = new PublicKey(kp.publicKey);
    return makeSigner('local', publicKey, async (bytes) => nacl.sign.detached(bytes, sk), { source, policy });
}

/**
 * A signer that knows the platform's address and cannot sign. The API process runs on this
 * when it holds no key (SERVER_MODE=api-only with nothing configured): it needs the address
 * to verify launch payments and to report it, and nothing more. Launches, refunds and payouts
 * all happen in the worker.
 */
function createPublicOnlySigner(publicKey) {
    return makeSigner('public-only', publicKey, async () => {
        throw new Error('this process holds no wallet key (public-only signer)');
    }, { source: 'constants' });
}

/** Whether the environment names a key at all (as opposed to relying on the public-only signer). */
function hasKeyConfigured(env = process.env) {
    return String(env.WALLET_SIGNER || 'local').toLowerCase() === 'vault'
        || !!env.DEV_WALLET_KEY_FILE || !!env.DEV_WALLET_PRIVATE_KEY;
}

/**
 * A signer that delegates to a HashiCorp Vault Transit ed25519 key.
 *
 * The token is captured here and deleted from the environment by the caller; it is never
 * attached to the signer object or included in an error message.
 */
async function createVaultSigner({ addr, token, key, mount = 'transit', namespace = null, timeoutMs = 10000, policy = null }) {
    if (!addr || !token || !key) throw new Error('vault signer needs VAULT_ADDR, VAULT_TOKEN and VAULT_TRANSIT_KEY');
    const base = String(addr).replace(/\/+$/, '');
    const headers = { 'X-Vault-Token': token, 'Content-Type': 'application/json' };
    if (namespace) headers['X-Vault-Namespace'] = namespace;

    async function call(method, path, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetch(`${base}/v1/${mount}/${path}`, {
                method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
            });
        } catch (e) {
            throw new Error(`vault ${method} ${path}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            // Vault's error bodies name the policy or path, never the token; still, keep it short.
            const text = (await res.text().catch(() => '')).slice(0, 200);
            throw new Error(`vault ${method} ${path}: HTTP ${res.status} ${text}`);
        }
        return res.json();
    }

    const info = await call('GET', `keys/${encodeURIComponent(key)}`);
    if (info?.data?.type !== 'ed25519') {
        throw new Error(`vault transit key "${key}" is type ${info?.data?.type || 'unknown'}, need ed25519`);
    }
    const latest = String(info.data.latest_version || Object.keys(info.data.keys || {}).pop());
    const pubB64 = info.data.keys?.[latest]?.public_key;
    if (!pubB64) throw new Error(`vault transit key "${key}" has no public key`);
    const publicKey = new PublicKey(Buffer.from(pubB64, 'base64'));

    return makeSigner('vault', publicKey, async (bytes) => {
        const out = await call('POST', `sign/${encodeURIComponent(key)}`, {
            input: Buffer.from(bytes).toString('base64'),
            key_version: Number(latest),
        });
        const sigStr = out?.data?.signature || '';
        const m = /^vault:v\d+:(.+)$/.exec(sigStr);
        if (!m) throw new Error('vault returned no signature');
        return Uint8Array.from(Buffer.from(m[1], 'base64'));
    }, { source: `${base} ${mount}/${key}`, policy });
}

/* ────────────────────────────────────────────────────────────────────────────
   Boot
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Warn when a key file is readable by other users. Render mounts secret files with
 * restrictive permissions; a hand-copied file on a VPS often is not.
 */
function checkKeyFilePermissions(file) {
    try {
        const mode = fs.statSync(file).mode & 0o777;
        if (mode & 0o077) {
            logger.warn('[Signer] Wallet key file is readable by other users', {
                file, mode: '0' + mode.toString(8), fix: `chmod 600 ${file}`,
            });
        }
    } catch (e) { /* stat failed; the read below will report it */ }
}

/**
 * Build the platform signer from the environment. Throws with a specific message when the
 * configuration is incomplete, so a bad deploy fails at boot rather than at the first payout.
 */
async function createSignerFromEnv(env = process.env, policy = undefined) {
    const backend = String(env.WALLET_SIGNER || 'local').toLowerCase();
    if (policy === undefined) {
        // The production policy. Required lazily: config loads the logger, which this module
        // also loads, and neither needs the policy until a signer exists.
        policy = require('./signingPolicy').fromConfig(require('../config/env'));
    }

    if (backend === 'vault') {
        const signer = await createVaultSigner({
            addr: env.VAULT_ADDR,
            token: env.VAULT_TOKEN,
            key: env.VAULT_TRANSIT_KEY,
            mount: env.VAULT_TRANSIT_MOUNT || 'transit',
            namespace: env.VAULT_NAMESPACE || null,
            policy,
        });
        logger.info('[Signer] Using Vault Transit remote signer', { key: env.VAULT_TRANSIT_KEY, wallet: signer.publicKey.toBase58() });
        return signer;
    }

    if (backend !== 'local') {
        throw new Error(`WALLET_SIGNER="${env.WALLET_SIGNER}" is not supported (local, vault)`);
    }

    let text, source;
    if (env.DEV_WALLET_KEY_FILE) {
        checkKeyFilePermissions(env.DEV_WALLET_KEY_FILE);
        try {
            text = fs.readFileSync(env.DEV_WALLET_KEY_FILE, 'utf8');
        } catch (e) {
            throw new Error(`could not read DEV_WALLET_KEY_FILE (${env.DEV_WALLET_KEY_FILE}): ${e.code || e.message}`);
        }
        source = 'file';
        if (env.DEV_WALLET_KEY_FILE_EPHEMERAL === '1') {
            // scripts/boot.sh parked the key here for the boot second, so that the running
            // process has it neither in its environment nor on disk. Overwrite, then remove.
            try {
                fs.writeFileSync(env.DEV_WALLET_KEY_FILE, Buffer.alloc(Buffer.byteLength(text)));
                fs.unlinkSync(env.DEV_WALLET_KEY_FILE);
            } catch (e) {
                logger.warn('[Signer] Could not remove the ephemeral key file', { error: e.code || e.message });
            }
            source = 'boot-file';
        }
    } else if (env.DEV_WALLET_PRIVATE_KEY) {
        text = env.DEV_WALLET_PRIVATE_KEY;
        source = 'env';
    } else {
        throw new Error('no wallet key configured: set DEV_WALLET_KEY_FILE or DEV_WALLET_PRIVATE_KEY, or WALLET_SIGNER=vault');
    }

    const encrypted = text.trim()[0] === '{';
    const secretKey = parseKeyMaterial(text, env.DEV_WALLET_KEY_PASSPHRASE);
    const signer = createLocalSigner(secretKey, encrypted ? `${source}+passphrase` : source, policy);
    logger.info('[Signer] Using local signer', { source: signer.source, wallet: signer.publicKey.toBase58(), policy: signer.policyMode });
    if (!encrypted && env.NODE_ENV === 'production') {
        logger.warn('[Signer] The wallet key is stored in the clear. See docs/KEY-MANAGEMENT.md for the encrypted envelope and remote-signer options.');
    }
    return signer;
}

/**
 * Confirm the signer controls the platform wallet named in constants.js.
 *
 * Before v30.4 a mismatch was logged and the server carried on: every launch would then name
 * the wrong creator and every payout would come from the wrong wallet. In production that is
 * fatal unless ALLOW_WALLET_MISMATCH=true, which exists only for a deliberate rotation.
 */
function verifyPlatformWallet(signer, expectedPubkey, config) {
    const actual = signer.publicKey.toBase58();
    const expected = expectedPubkey.toBase58();
    if (actual === expected) {
        logger.info(`Wallet verified: ${actual}`);
        return true;
    }
    logger.error(`CRITICAL: Wallet mismatch! Expected: ${expected}, Got: ${actual}`);
    if (config.NODE_ENV === 'production' && !config.ALLOW_WALLET_MISMATCH) {
        logger.error('Refusing to start with the wrong platform wallet. Fix the signer configuration, or set ALLOW_WALLET_MISMATCH=true if the wallet is being rotated on purpose.');
        process.exit(1);
    }
    logger.error('Continuing with the wrong wallet (non-production or ALLOW_WALLET_MISMATCH=true).');
    return false;
}

/** Delete the key-material variables from the environment. Call once the signer exists. */
function scrubSecretsFromEnv(env = process.env) {
    for (const k of SECRET_ENV_KEYS) {
        if (k in env) delete env[k];
    }
}

module.exports = {
    createSignerFromEnv,
    createLocalSigner,
    createVaultSigner,
    createPublicOnlySigner,
    hasKeyConfigured,
    makeSigner,
    parseKeyMaterial,
    encryptEnvelope,
    decryptEnvelope,
    scrubSecretsFromEnv,
    verifyPlatformWallet,
    SECRET_ENV_KEYS,
};
