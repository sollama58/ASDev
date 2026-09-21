/**
 * Vanity Grinder
 * v28.1 - Keeps a pool of pre-ground mint keypairs topped up.
 *
 * Runs as its own Render service (src/grinder.js) so that a CPU-bound search cannot contend
 * with the API or the background workers. Nothing here is imported by the web process; the
 * API only ever *reads* from the pool, via services/vanity.js.
 *
 * Shape of the thing: N worker threads grind continuously while the pool is below target and
 * park themselves once it is full, waking again when the pool drops to the low-water mark.
 * The pool lives in Postgres, so the grinder and the API need no direct connection to each
 * other -- they only share a database and an encryption key.
 */
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const logger = require('./logger');
const config = require('../config/env');
const vanitySecret = require('./vanitySecret');
const vanity = require('./vanity');

let workers = [];
let db = null;
let running = false;
let paused = false;
let pollTimer = null;

const stats = {
    startedAt: null,
    attempts: 0,
    hits: 0,
    rejected: 0,
    poolSize: 0,
    lastHitAt: null
};

/** Current number of unclaimed addresses in the pool. */
async function getPoolSize() {
    const row = await db.get("SELECT COUNT(*) AS c FROM vanity_mints WHERE status = 'available'");
    return parseInt(row?.c ?? 0, 10) || 0;
}

/**
 * Persist a hit.
 *
 * The worker only proves the *residue* matched, so the address is re-derived and the suffix
 * re-checked against the real base58 encoding here before anything is stored. That closes the
 * gap between the fast arithmetic test and the actual address a user will see, and it also
 * verifies the seed round-trips to the public key the worker reported.
 */
async function storeHit({ pub, seed, matchedSuffix }) {
    let keypair;
    try {
        keypair = Keypair.fromSeed(Uint8Array.from(seed));
    } catch (e) {
        stats.rejected++;
        logger.warn('[Grinder] Discarded hit: seed did not produce a keypair', { error: e.message });
        return false;
    }

    const address = keypair.publicKey.toBase58();

    // The seed must reproduce exactly the public key the worker matched on.
    if (Buffer.compare(Buffer.from(keypair.publicKey.toBytes()), Buffer.from(pub)) !== 0) {
        stats.rejected++;
        logger.warn('[Grinder] Discarded hit: seed does not reproduce the reported public key', { address });
        return false;
    }

    // And the real encoding must actually end with the suffix we think it does.
    if (!address.endsWith(matchedSuffix)) {
        stats.rejected++;
        logger.warn('[Grinder] Discarded hit: address does not end with the matched suffix', { address, matchedSuffix });
        return false;
    }

    try {
        await db.run(
            `INSERT INTO vanity_mints (mint_address, encrypted_seed, suffix, status, created_at)
             VALUES ($1, $2, $3, 'available', $4)
             ON CONFLICT (mint_address) DO NOTHING`,
            [address, vanitySecret.encryptSeed(seed), matchedSuffix, Date.now()]
        );
        stats.hits++;
        stats.lastHitAt = Date.now();
        logger.info(`[Grinder] Found ${address} (…${matchedSuffix})`);
        return true;
    } catch (e) {
        logger.error('[Grinder] Failed to store hit', { address, error: e.message });
        return false;
    }
}

function pauseWorkers() {
    if (paused) return;
    paused = true;
    workers.forEach(w => w.postMessage('pause'));
    logger.info(`[Grinder] Pool full (${stats.poolSize}/${config.VANITY_POOL_TARGET}) — workers parked`);
}

function resumeWorkers() {
    if (!paused) return;
    paused = false;
    workers.forEach(w => w.postMessage('resume'));
    logger.info(`[Grinder] Pool below low-water mark (${stats.poolSize}/${config.VANITY_POOL_TARGET}) — grinding resumed`);
}

/**
 * Keep the workers' run state in step with the pool depth.
 *
 * Hysteresis (stop at target, restart at the low-water mark) stops the workers flapping
 * between paused and running every time a single address is consumed.
 */
async function reconcilePoolState() {
    try {
        // v29.1: recover addresses stranded in 'claimed' by a crashed launch before measuring
        // depth, so the pool size reflects what is genuinely spendable and the workers are not
        // parked while leaked addresses make the pool look fuller than it is.
        await vanity.reapStrandedClaims(db);
        stats.poolSize = await getPoolSize();
    } catch (e) {
        logger.warn('[Grinder] Pool size check failed', { error: e.message });
        return;
    }
    if (stats.poolSize >= config.VANITY_POOL_TARGET) pauseWorkers();
    else if (stats.poolSize <= config.VANITY_POOL_LOW_WATER) resumeWorkers();
}

function spawnWorker(index) {
    const worker = new Worker(path.join(__dirname, 'vanityWorker.js'), {
        workerData: {
            suffix: config.VANITY_SUFFIX,
            caseInsensitive: config.VANITY_CASE_INSENSITIVE,
            reportEvery: 2000,
            dutyCycle: config.VANITY_DUTY_CYCLE
        }
    });

    worker.on('message', async (msg) => {
        if (msg.type === 'progress') {
            stats.attempts += msg.attempts;
        } else if (msg.type === 'hit') {
            const stored = await storeHit(msg);
            if (stored) await reconcilePoolState();
        } else if (msg.type === 'error') {
            logger.error(`[Grinder] Worker ${index} error`, { error: msg.error });
        }
    });

    worker.on('error', (err) => {
        logger.error(`[Grinder] Worker ${index} crashed`, { error: err.message });
        if (running) {
            logger.info(`[Grinder] Restarting worker ${index}`);
            workers[index] = spawnWorker(index);
            if (paused) workers[index].postMessage('pause');
        }
    });

    worker.on('exit', (code) => {
        if (running && code !== 0) {
            logger.warn(`[Grinder] Worker ${index} exited with code ${code}`);
        }
    });

    return worker;
}

/**
 * Start grinding. Returns false (without starting) if the grinder cannot work safely.
 */
async function start(deps) {
    db = deps.db;

    if (!config.VANITY_GRINDER_ENABLED) {
        logger.info('[Grinder] Disabled (VANITY_GRINDER_ENABLED is not true)');
        return false;
    }

    // Without a stable key, everything produced here would be unreadable after a restart.
    // Refuse rather than burn CPU on keypairs nobody can use.
    if (!vanitySecret.isConfigured()) {
        logger.error('[Grinder] VANITY_ENCRYPTION_KEY is not set — refusing to grind, since stored seeds could never be decrypted. Set the same value on the API service.');
        return false;
    }

    const threads = Math.max(1, Math.min(config.VANITY_GRINDER_THREADS || 1, os.cpus().length));
    running = true;
    stats.startedAt = Date.now();

    workers = [];
    for (let i = 0; i < threads; i++) workers.push(spawnWorker(i));

    await reconcilePoolState();

    // Poll so the grinder notices addresses being consumed by the API service, which shares
    // only the database with this process and cannot signal it directly.
    pollTimer = setInterval(reconcilePoolState, config.VANITY_POOL_CHECK_INTERVAL);

    logger.info('[Grinder] Started', {
        suffix: config.VANITY_SUFFIX,
        caseInsensitive: config.VANITY_CASE_INSENSITIVE,
        threads,
        target: config.VANITY_POOL_TARGET,
        lowWater: config.VANITY_POOL_LOW_WATER,
        dutyCycle: config.VANITY_DUTY_CYCLE,
        poolSize: stats.poolSize
    });
    return true;
}

async function stop() {
    running = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    for (const w of workers) {
        try { w.postMessage('stop'); await w.terminate(); } catch (_) { /* already gone */ }
    }
    workers = [];
    logger.info('[Grinder] Stopped');
}

function getStats() {
    const elapsedSec = stats.startedAt ? (Date.now() - stats.startedAt) / 1000 : 0;
    return {
        ...stats,
        running,
        paused,
        threads: workers.length,
        target: config.VANITY_POOL_TARGET,
        suffix: config.VANITY_SUFFIX,
        attemptsPerSec: elapsedSec > 0 ? Math.round(stats.attempts / elapsedSec) : 0
    };
}

module.exports = { start, stop, getStats, getPoolSize, storeHit };
