/**
 * ASDev Worker Server
 * v25.26 - Dedicated worker process for background tasks
 *
 * This file runs ONLY the background tasks (holders, metadata, flywheel, etc.)
 * without starting the Express HTTP server. Use this on a second Render instance
 * to offload background processing from the main API server.
 *
 * Environment Variables:
 *   SERVER_MODE=worker    - Required to start in worker mode
 *   WORKER_TASKS          - Comma-separated list of tasks to run (optional, defaults to all)
 *                           Options: holders,metadata,asdf,flywheel
 *
 * Usage:
 *   SERVER_MODE=worker node src/worker.js
 *   SERVER_MODE=worker WORKER_TASKS=holders,metadata,deploy node src/worker.js
 */

// v25.26: Immediate stdout write to verify process starts (before any imports)
process.stdout.write(`[${new Date().toISOString()}] [INFO] ASDev Worker process starting...\n`);

require('dotenv').config();

const { Connection } = require('@solana/web3.js');

// Internal imports
const config = require('./config/env');
const { WALLETS } = require('./config/constants');
const { logger, database, redis, twitter, solana, claudeKoth } = require('./services');
const signerService = require('./services/signer');
const tasks = require('./tasks');

// Check if running in worker mode
if (process.env.SERVER_MODE !== 'worker') {
    console.error('ERROR: Worker mode requires SERVER_MODE=worker environment variable');
    console.error('Usage: SERVER_MODE=worker node src/worker.js');
    process.exit(1);
}

// Parse which tasks to run (defaults to all)
// v30.4: 'deploy' runs the launch queue here so the API service can run without the wallet
// key. Harmless alongside an API that still holds one: BullMQ hands each job to one consumer.
const TASK_OPTIONS = ['holders', 'metadata', 'asdf', 'flywheel', 'deploy'];
const enabledTasks = process.env.WORKER_TASKS
    ? process.env.WORKER_TASKS.split(',').map(t => t.trim().toLowerCase())
    : TASK_OPTIONS;

// Validate task names
const invalidTasks = enabledTasks.filter(t => !TASK_OPTIONS.includes(t));
if (invalidTasks.length > 0) {
    console.error(`ERROR: Invalid task names: ${invalidTasks.join(', ')}`);
    console.error(`Valid options: ${TASK_OPTIONS.join(', ')}`);
    process.exit(1);
}

// Global state proxy (same as main server)
const globalState = {
    get lastBackendUpdate() { return this._lastBackendUpdate || Date.now(); },
    set lastBackendUpdate(val) {
        this._lastBackendUpdate = val;
        redis.setLastBackendUpdate(val).catch(e => logger.debug('Redis setLastBackendUpdate failed', { error: e.message }));
    },

    get asdfTopHolders() { return this._asdfTopHolders || new Set(); },
    set asdfTopHolders(val) {
        this._asdfTopHolders = val;
        redis.setAsdfTopHolders([...val]).catch(e => logger.debug('Redis setAsdfTopHolders failed', { error: e.message }));
    },

    get totalPoints() { return this._totalPoints || 0; },
    set totalPoints(val) {
        this._totalPoints = val;
        redis.setTotalPoints(val).catch(e => logger.debug('Redis setTotalPoints failed', { error: e.message }));
    },

    get devPumpHoldings() { return this._devPumpHoldings || 0; },
    set devPumpHoldings(val) {
        this._devPumpHoldings = val;
        redis.setDevPumpHoldings(val).catch(e => logger.debug('Redis setDevPumpHoldings failed', { error: e.message }));
    },

    get userExpectedAirdrops() { return this._userExpectedAirdrops || new Map(); },
    set userExpectedAirdrops(val) {
        this._userExpectedAirdrops = val;
        redis.setAllUserExpectedAirdrops(val).catch(e => logger.debug('Redis setAllUserExpectedAirdrops failed', { error: e.message }));
    },

    get userPointsMap() { return this._userPointsMap || new Map(); },
    set userPointsMap(val) {
        this._userPointsMap = val;
        redis.setAllUserPoints(val).catch(e => logger.debug('Redis setAllUserPoints failed', { error: e.message }));
    },

    _lastBackendUpdate: Date.now(),
    _asdfTopHolders: new Set(),
    _totalPoints: 0,
    _devPumpHoldings: 0,
    _userExpectedAirdrops: new Map(),
    _userPointsMap: new Map(),
};

/**
 * Start worker with selected tasks
 */
async function startWorker() {
    logger.info(`Starting ASDev Worker ${config.VERSION}...`);

    // v30.4: see src/index.js -- same signer, same checks, and first for the same reason. The worker always holds the key.
    const signer = await signerService.createSignerFromEnv();
    signerService.scrubSecretsFromEnv();
    solana.setSigner(signer);
    signerService.verifyPlatformWallet(signer, WALLETS.PLATFORM_DEV, config);
    logger.info(`Enabled tasks: ${enabledTasks.join(', ')}`);

    // v25.25: Log memory usage at startup for debugging OOM issues
    const memUsage = process.memoryUsage();
    logger.info(`[Worker] Memory at startup: RSS=${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap=${Math.round(memUsage.heapUsed / 1024 / 1024)}/${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);

    // Initialize Redis first (needed for globalState and BullMQ)
    // v25.25: FIX - await the Redis init to prevent race conditions
    const redisInitSuccess = await redis.init();
    if (!redisInitSuccess) {
        logger.error('FATAL: Redis initialization failed - BullMQ job queues require Redis');
        logger.error('Check REDIS_URL environment variable and Redis server availability');
        process.exit(1);
    }

    // v25.40: Initialize Claude KOTH with Redis client for log storage
    const redisConnection = redis.getConnection();
    if (redisConnection) {
        claudeKoth.setRedisClient(redisConnection);
        logger.info('[ClaudeKOTH] Redis client initialized for evaluation logging');
    }

    // Initialize PostgreSQL database
    await database.initDB();
    const db = database.getDB();
    logger.info('[Worker] PostgreSQL initialized with connection pooling');

    // v29.1: recover any vanity addresses left in the 'claimed' state by a process that died
    // mid-launch. This is the main source of the leak, so sweeping once on boot covers it even
    // in deployments that run no separate grinder service.
    await require('./services/vanity').reapStrandedClaims(db).catch(() => {});

    // Initialize Twitter (needed for social worker)
    // v25.22: Now async to fetch username for proper tweet URLs
    // v30.2: the flywheel posts the KOTH tweet from this process. This used to test for a
    // 'social' task that is not a valid WORKER_TASKS option, so Twitter was never initialised
    // here and the KOTH tweet silently never went out.
    if (enabledTasks.includes('flywheel')) {
        await twitter.init();
    }

    // Initialize Solana connection with timeout
    // v25.47 STABILITY: Added timeout to prevent hanging RPC calls
    const connection = new Connection(config.RPC_URL, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: config.RPC_TIMEOUT_MS,
        // v30.2: web3.js otherwise retries every 429 itself (up to 5 times), silently multiplying
        // request volume exactly when the provider is asking us to slow down. Callers here already
        // treat a failed read as "try next cycle".
        disableRetryOnRateLimit: true,
        fetch: (url, options) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), config.RPC_TIMEOUT_MS);
            return fetch(url, { ...options, signal: controller.signal })
                .finally(() => clearTimeout(timeout));
        }
    });

    logger.info(`Network: ${config.SOLANA_NETWORK.toUpperCase()} | RPC: ${config.RPC_URL.includes('devnet') ? 'Devnet' : (config.HELIUS_API_KEY ? 'Helius' : 'Public Mainnet')}`);

    // v29.2: delegate to the one implementation in services/solana.js. This was a local copy
    // here and a byte-identical one in the other entrypoint, alongside a third, divergent copy
    // in that service, so a change to refund behaviour had to be made in three places.
    const refundUser = solana.refundUser;

    // Dependencies object for modules
    const deps = {
        connection,
        signer,
        db,
        redis,
        globalState,
        addFees: database.addFees,
        getStats: database.getStats,
        getTotalLaunches: database.getTotalLaunches,
        recordClaim: database.recordClaim,
        updateNextCheckTime: database.updateNextCheckTime,
        logPurchase: database.logPurchase,
        saveTokenData: database.saveTokenData,
        refundUser,
    };

    // Start selected background tasks
    const workers = tasks.workers;

    if (enabledTasks.includes('holders')) {
        tasks.registerWorker(workers.initHolderScannerWorker(deps));
        logger.info('[Worker] Holder scanner started');
    }

    if (enabledTasks.includes('metadata')) {
        tasks.registerWorker(workers.initMetadataUpdaterWorker(deps));
        // v30.2: the minute-by-minute top-token prices and the missing-image backfill only ran
        // in single-process mode; the split deployment never started them.
        tasks.metadataUpdater.start(deps);
        logger.info('[Worker] Metadata updater started');
    }

    if (enabledTasks.includes('asdf')) {
        workers.initAsdfSyncWorker(deps);
        logger.info('[Worker] ASDF sync started');
    }

    if (enabledTasks.includes('flywheel')) {
        tasks.flywheel.start(deps)
            .then(control => tasks.registerWorker(control))
            .catch(e => logger.error('[Worker] Flywheel failed to start', { error: e.message }));
        logger.info('[Worker] Flywheel started');
    }

    if (enabledTasks.includes('deploy')) {
        tasks.registerWorker(workers.initDeployWorker(deps));
        logger.info('[Worker] Deploy worker started (launches, refunds)');
    } else {
        logger.warn('[Worker] WORKER_TASKS excludes "deploy": launches are only processed if the API service holds the wallet key');
    }

    logger.info(`Worker ${config.VERSION} running with ${enabledTasks.length} tasks`);

    // v25.25: Periodic memory monitoring to detect leaks before OOM
    const MEMORY_CHECK_INTERVAL = 60000; // Check every 60 seconds
    const MEMORY_WARNING_THRESHOLD_MB = 400; // Warn if heap exceeds 400MB

    memoryMonitorInterval = setInterval(() => {
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        const rssMB = Math.round(mem.rss / 1024 / 1024);

        if (heapMB > MEMORY_WARNING_THRESHOLD_MB) {
            logger.warn(`[Worker] HIGH MEMORY: Heap=${heapMB}MB, RSS=${rssMB}MB - consider restarting`);

            // Force garbage collection if available (requires --expose-gc flag)
            if (global.gc) {
                logger.info('[Worker] Forcing garbage collection...');
                global.gc();
            }
        } else {
            logger.info(`[Worker] Memory: Heap=${heapMB}MB, RSS=${rssMB}MB`);
        }
    }, MEMORY_CHECK_INTERVAL);

    // Keep process alive
    process.stdin.resume();
}

// Graceful shutdown
let memoryMonitorInterval = null; // Tracked for cleanup in shutdown

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down worker gracefully...`);
    const forceExit = setTimeout(() => process.exit(1), 170000);
    forceExit.unref();
    try {
        if (memoryMonitorInterval) clearInterval(memoryMonitorInterval);
        // v30.2: let an airdrop or fee sweep that is mid-flight finish before the database
        // goes away -- previously the pool was closed under it, between sends and bookkeeping.
        const drained = await tasks.flywheel.drain(160000);
        if (!drained) logger.error('[Worker] Flywheel still busy at shutdown deadline');
        await tasks.stopAll();
        const db = database.getDB();
        if (db) await db.close();
        redis.getConnection()?.disconnect();
        logger.info('Worker cleanup complete, exiting');
    } catch (e) {
        logger.error('Worker shutdown error', { error: e.message });
    }
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// v25.25: Handle uncaught errors to prevent silent crashes (status 134)
process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION - Worker crashing', {
        error: err.message,
        stack: err.stack
    });
    // Log memory state at crash time
    const mem = process.memoryUsage();
    logger.error(`Memory at crash: RSS=${Math.round(mem.rss / 1024 / 1024)}MB, Heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED REJECTION - Potential crash', {
        reason: reason?.message || String(reason),
        stack: reason?.stack
    });
});

// Run worker
startWorker().catch(err => {
    logger.error("Worker fatal error", { error: err.message, stack: err.stack });
    process.exit(1);
});
