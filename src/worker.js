/**
 * ASDev Worker Server
 * v25.26 - Dedicated worker process for background tasks
 *
 * This file runs ONLY the background tasks (holders, metadata, robinhood, flywheel, etc.)
 * without starting the Express HTTP server. Use this on a second Render instance
 * to offload background processing from the main API server.
 *
 * Environment Variables:
 *   SERVER_MODE=worker    - Required to start in worker mode
 *   WORKER_TASKS          - Comma-separated list of tasks to run (optional, defaults to all)
 *                           Options: holders,metadata,robinhood,asdf,flywheel,vanity
 *
 * Usage:
 *   SERVER_MODE=worker node src/worker.js
 *   SERVER_MODE=worker WORKER_TASKS=holders,metadata node src/worker.js
 */

// v25.26: Immediate stdout write to verify process starts (before any imports)
process.stdout.write(`[${new Date().toISOString()}] [INFO] ASDev Worker process starting...\n`);

require('dotenv').config();

const { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const bs58 = require('bs58');

// Internal imports
const config = require('./config/env');
const { WALLETS } = require('./config/constants');
const { logger, database, redis, twitter, solana } = require('./services');
const tasks = require('./tasks');

// Check if running in worker mode
if (process.env.SERVER_MODE !== 'worker') {
    console.error('ERROR: Worker mode requires SERVER_MODE=worker environment variable');
    console.error('Usage: SERVER_MODE=worker node src/worker.js');
    process.exit(1);
}

// Parse which tasks to run (defaults to all)
const TASK_OPTIONS = ['holders', 'metadata', 'robinhood', 'asdf', 'flywheel', 'vanity'];
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

    get asdfTop50Holders() { return this._asdfTop50Holders || new Set(); },
    set asdfTop50Holders(val) {
        this._asdfTop50Holders = val;
        redis.setAsdfTop100Holders([...val]).catch(e => logger.debug('Redis setAsdfTop100Holders failed', { error: e.message }));
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
    _asdfTop50Holders: new Set(),
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

    // Initialize PostgreSQL database
    await database.initDB();
    const db = database.getDB();
    logger.info('[Worker] PostgreSQL initialized with connection pooling');

    // Initialize Twitter (needed for social worker)
    // v25.22: Now async to fetch username for proper tweet URLs
    if (enabledTasks.includes('social')) {
        await twitter.init();
    }

    // Initialize Solana connection
    const connection = new Connection(config.RPC_URL, "confirmed");
    const devKeypair = Keypair.fromSecretKey(bs58.decode(config.DEV_WALLET_PRIVATE_KEY));
    const wallet = new Wallet(devKeypair);

    // Validate wallet
    const actualWallet = devKeypair.publicKey.toString();
    const expectedWallet = WALLETS.PLATFORM_DEV.toString();
    if (actualWallet !== expectedWallet) {
        logger.error(`CRITICAL: Wallet mismatch! Expected: ${expectedWallet}, Got: ${actualWallet}`);
    } else {
        logger.info(`Wallet verified: ${actualWallet}`);
    }

    logger.info(`Network: ${config.SOLANA_NETWORK.toUpperCase()} | RPC: ${config.RPC_URL.includes('devnet') ? 'Devnet' : (config.HELIUS_API_KEY ? 'Helius' : 'Public Mainnet')}`);

    const refundUser = async (userPubkeyStr, reason) => {
        try {
            const { PublicKey } = require('@solana/web3.js');
            const userPubkey = new PublicKey(userPubkeyStr);
            const tx = new Transaction();
            solana.addPriorityFee(tx);
            tx.add(SystemProgram.transfer({
                fromPubkey: devKeypair.publicKey,
                toPubkey: userPubkey,
                lamports: (config.DEPLOYMENT_FEE_SOL - 0.001) * LAMPORTS_PER_SOL
            }));
            const sig = await solana.sendTxWithRetry(tx, [devKeypair]);
            logger.info(`REFUNDED ${userPubkeyStr}: ${sig} (Reason: ${reason})`);
            return sig;
        } catch (e) {
            logger.error(`REFUND FAILED: ${e.message}`);
            return null;
        }
    };

    // Dependencies object for modules
    const deps = {
        connection,
        devKeypair,
        wallet,
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
    const { vanity } = require('./services');
    const workers = tasks.workers;

    if (enabledTasks.includes('holders')) {
        workers.initHolderScannerWorker(deps);
        logger.info('[Worker] Holder scanner started');
    }

    if (enabledTasks.includes('metadata')) {
        workers.initMetadataUpdaterWorker(deps);
        logger.info('[Worker] Metadata updater started');
    }

    if (enabledTasks.includes('robinhood')) {
        workers.initRobinhoodScannerWorker(deps);
        logger.info('[Worker] Robinhood scanner started');
    }

    if (enabledTasks.includes('asdf')) {
        workers.initAsdfSyncWorker(deps);
        logger.info('[Worker] ASDF sync started');
    }

    if (enabledTasks.includes('flywheel')) {
        tasks.flywheel.start(deps);
        logger.info('[Worker] Flywheel started');
    }

    if (enabledTasks.includes('vanity') && config.VANITY_GRINDER_ENABLED && config.VANITY_GRINDER_URL) {
        vanity.startAutoRefill();
        logger.info('[Worker] Vanity pool auto-refill started');
    }

    logger.info(`Worker ${config.VERSION} running with ${enabledTasks.length} tasks`);

    // v25.25: Periodic memory monitoring to detect leaks before OOM
    const MEMORY_CHECK_INTERVAL = 60000; // Check every 60 seconds
    const MEMORY_WARNING_THRESHOLD_MB = 400; // Warn if heap exceeds 400MB

    setInterval(() => {
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
const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down worker gracefully...`);
    try {
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
