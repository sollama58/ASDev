/**
 * ShitPad Vanity Grinder Service
 * v28.1 - Dedicated process that keeps the vanity mint pool topped up.
 *
 * Deliberately a separate Render service rather than another background task. Grinding is
 * CPU-bound and sustained; running it beside the API or the worker would contend for cores
 * with request handling and the fee/airdrop jobs. Here it can use its whole instance and
 * still be scaled, restarted or switched off without touching anything else.
 *
 * It shares only two things with the rest of the platform: the Postgres database (where the
 * pool lives) and VANITY_ENCRYPTION_KEY (so the API can decrypt what this process writes).
 * It needs no RPC access, no Redis and no wallet key.
 *
 * Environment:
 *   SERVER_MODE=grinder          - Required to start in grinder mode
 *   VANITY_GRINDER_ENABLED=true  - Master switch
 *   VANITY_ENCRYPTION_KEY        - Must match the API service
 *   VANITY_GRINDER_THREADS       - Worker threads (default: all cores on this instance)
 *
 * Usage:
 *   SERVER_MODE=grinder node src/grinder.js
 */
process.stdout.write(`[${new Date().toISOString()}] [INFO] ShitPad grinder process starting...\n`);

require('dotenv').config();

const config = require('./config/env');
const logger = require('./services/logger');
const database = require('./services/postgres');
const grinder = require('./services/vanityGrinder');

if (process.env.SERVER_MODE !== 'grinder') {
    console.error('ERROR: Grinder mode requires SERVER_MODE=grinder environment variable');
    console.error('Usage: SERVER_MODE=grinder node src/grinder.js');
    process.exit(1);
}

let shuttingDown = false;

async function main() {
    logger.info('=================================');
    logger.info(`ShitPad Grinder ${config.VERSION}`);
    logger.info('=================================');

    await database.initDB();
    const db = database.getDB();

    const started = await grinder.start({ db });
    if (!started) {
        // start() has already logged why. Exit non-zero so the platform surfaces it as a
        // failed service rather than a healthy one silently doing nothing.
        logger.error('[Grinder] Did not start — exiting');
        process.exit(1);
    }

    // Periodic heartbeat so the service's logs show it is alive and making progress.
    setInterval(() => {
        const s = grinder.getStats();
        logger.info('[Grinder] Status', {
            pool: `${s.poolSize}/${s.target}`,
            state: s.paused ? 'parked (pool full)' : 'grinding',
            threads: s.threads,
            hits: s.hits,
            attemptsPerSec: s.attemptsPerSec
        });
    }, config.VANITY_GRINDER_LOG_INTERVAL);
}

const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down grinder...`);
    const forceExit = setTimeout(() => {
        logger.error('Grinder shutdown timed out, forcing exit');
        process.exit(1);
    }, 15000);
    forceExit.unref();
    try {
        await grinder.stop();
        const db = database.getDB();
        if (db) await db.close();
    } catch (e) {
        logger.error('Grinder shutdown error', { error: e.message });
    }
    clearTimeout(forceExit);
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION - Grinder crashing', { error: err.message, stack: err.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED REJECTION in grinder', {
        reason: reason?.message || String(reason),
        stack: reason?.stack
    });
});

main().catch(err => {
    logger.error('Grinder fatal error', { error: err.message, stack: err.stack });
    process.exit(1);
});
