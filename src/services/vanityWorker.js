/**
 * Vanity Grinder Worker Thread
 * v28.1 - The hot loop. Runs inside a worker_thread, never on the main thread.
 *
 * Keypair generation is synchronous and CPU-bound; running it on the main thread would stall
 * the event loop for the entire grind. Each instance of this file is one worker_thread.
 *
 * Two things make this fast enough to be practical:
 *
 * 1. Node's built-in crypto.generateKeyPairSync('ed25519') delegates to OpenSSL and measures
 *    ~10,500 keys/sec/core. The pure-JS tweetnacl equivalent manages ~61/sec -- 172x slower.
 *
 * 2. The suffix test never base58-encodes anything. In base58 the trailing characters are the
 *    least-significant digits, so the last N characters are determined entirely by
 *    (pubkey as a big-endian integer) mod 58^N. That reduces the check to a 32-step integer
 *    loop and a comparison against a precomputed set.
 *    (Leading zero bytes affect only the '1' characters at the *start* of the encoding, so
 *    they cannot disturb the suffix.)
 *
 *    N is the configured suffix's own length. The modulus must stay inside float64's
 *    exact-integer range or the arithmetic below silently stops being exact: 58^8 is
 *    ~1.28e14 and safe, 58^9 is ~1.07e16 and is not, so suffixes longer than 8 characters
 *    are rejected outright rather than matched incorrectly. (A 9-character suffix would
 *    need ~1e16 attempts anyway, so nothing practical is lost.)
 */
const crypto = require('crypto');
const { parentPort, workerData } = require('worker_threads');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAX_SUFFIX_LEN = 8; // 58^8 is the largest power of 58 below Number.MAX_SAFE_INTEGER

/**
 * Every case variant of `word` that base58 can actually represent, as integer residues.
 * base58 omits uppercase I and lowercase l, so e.g. "SHIT" is unrepresentable and simply
 * never enters the target set.
 */
function buildTargets(word, caseInsensitive) {
    const perPosition = [...word].map(ch => {
        const forms = caseInsensitive
            ? [...new Set([ch.toLowerCase(), ch.toUpperCase()])]
            : [ch];
        return forms.filter(c => BASE58.includes(c));
    });
    if (perPosition.some(f => f.length === 0)) {
        throw new Error(`suffix "${word}" contains a character with no base58 representation`);
    }

    let combos = [''];
    for (const forms of perPosition) {
        const next = [];
        for (const prefix of combos) for (const f of forms) next.push(prefix + f);
        combos = next;
    }

    const targets = new Map(); // residue -> the literal suffix string it represents
    for (const combo of combos) {
        let value = 0;
        for (const ch of combo) value = value * 58 + BASE58.indexOf(ch);
        targets.set(value, combo);
    }
    return targets;
}

const { suffix, caseInsensitive, reportEvery, dutyCycle } = workerData;

if (!suffix || suffix.length === 0) {
    throw new Error('VANITY_SUFFIX is empty — nothing to grind for');
}
if (suffix.length > MAX_SUFFIX_LEN) {
    throw new Error(`suffix "${suffix}" is ${suffix.length} characters; the residue test is only exact up to ${MAX_SUFFIX_LEN}`);
}

// Derived from the configured suffix, not hardcoded: a mismatch between the modulus here and
// the width buildTargets() encodes would mean every residue comparison fails and the grinder
// would burn CPU forever without ever reporting a hit.
const MODULUS = 58 ** suffix.length;
const TARGETS = buildTargets(suffix, caseInsensitive);

/** Raw 32-byte ed25519 keypair via OpenSSL. DER wraps both; the raw bytes are the last 32. */
function generateRaw() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' });
    const sec = privateKey.export({ type: 'pkcs8', format: 'der' });
    return { pub: pub.subarray(pub.length - 32), seed: sec.subarray(sec.length - 32) };
}

function suffixResidue(pub) {
    let r = 0;
    for (let i = 0; i < 32; i++) r = (r * 256 + pub[i]) % MODULUS;
    return r;
}

let attempts = 0;
let running = true;
let paused = false;

parentPort.on('message', (msg) => {
    if (msg === 'stop') { running = false; }
    else if (msg === 'pause') { paused = true; }
    else if (msg === 'resume') { paused = false; }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    while (running) {
        if (paused) { await sleep(500); continue; }

        // Grind in bounded bursts. Yielding between bursts keeps this worker responsive to
        // pause/stop messages, and -- when a duty cycle is configured -- lets the instance
        // stay below a target CPU share instead of pinning a core flat out.
        const burstStart = Date.now();
        for (let i = 0; i < reportEvery; i++) {
            const { pub, seed } = generateRaw();
            attempts++;
            const matched = TARGETS.get(suffixResidue(pub));
            if (matched !== undefined) {
                parentPort.postMessage({
                    type: 'hit',
                    // Buffers transfer structured-clone cleanly; the parent re-wraps them.
                    pub: Buffer.from(pub),
                    seed: Buffer.from(seed),
                    matchedSuffix: matched,
                    attempts
                });
                attempts = 0;
            }
        }
        parentPort.postMessage({ type: 'progress', attempts: reportEvery });

        const elapsed = Date.now() - burstStart;
        if (dutyCycle > 0 && dutyCycle < 1) {
            // Work for `dutyCycle` of the time, idle for the rest.
            await sleep(Math.round(elapsed * (1 - dutyCycle) / dutyCycle));
        } else {
            await sleep(0); // yield to the message queue
        }
    }
    parentPort.postMessage({ type: 'stopped' });
})().catch(err => {
    parentPort.postMessage({ type: 'error', error: err.message });
});
