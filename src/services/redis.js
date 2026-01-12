/**
 * Redis Service
 * Redis connection, queue management, and globalState
 * v13.0 - Added globalState for cross-process sharing
 * v24.0 - Added connection validation and health checking
 */
const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const config = require('../config/env');
const logger = require('./logger');

let redisConnection = null;
let deployQueue = null;
let socialQueue = null;
let holderScannerQueue = null;
let metadataUpdaterQueue = null;
let robinhoodScannerQueue = null;
let isConnected = false;

// Redis keys for globalState
const GLOBAL_STATE_KEYS = {
    LAST_BACKEND_UPDATE: 'globalState:lastBackendUpdate',
    ASDF_TOP100_HOLDERS: 'globalState:asdfTop100Holders',
    TOTAL_POINTS: 'globalState:totalPoints',
    DEV_PUMP_HOLDINGS: 'globalState:devPumpHoldings',
    USER_EXPECTED_AIRDROPS: 'globalState:userExpectedAirdrops',
    USER_POINTS_MAP: 'globalState:userPointsMap',
};

// SCALABILITY FIX: TTLs for global state keys (in seconds)
const GLOBAL_STATE_TTL = {
    LAST_BACKEND_UPDATE: 300,       // 5 minutes - refreshed frequently
    ASDF_TOP100_HOLDERS: 600,       // 10 minutes - updated every 2 mins
    TOTAL_POINTS: 600,              // 10 minutes
    DEV_PUMP_HOLDINGS: 600,         // 10 minutes
    USER_EXPECTED_AIRDROPS: 600,    // 10 minutes
    USER_POINTS_MAP: 600,           // 10 minutes
};

/**
 * Initialize Redis connection and queues
 * v24.0: Added async initialization with connection validation
 */
async function init() {
    try {
        redisConnection = new IORedis(config.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: true,  // v24.0: Enable ready check for connection validation
            retryStrategy: (times) => {
                if (times > 10) {
                    logger.error('Redis: Max reconnection attempts reached');
                    return null; // Stop retrying
                }
                const delay = Math.min(times * 200, 5000);
                logger.warn(`Redis: Reconnecting in ${delay}ms (attempt ${times})`);
                return delay;
            }
        });

        // v24.0: Connection event handlers for better observability
        redisConnection.on('connect', () => {
            logger.info('Redis: Connection established');
        });

        redisConnection.on('ready', () => {
            isConnected = true;
            logger.info('Redis: Ready to accept commands');
        });

        redisConnection.on('error', (err) => {
            isConnected = false;
            logger.error('Redis: Connection error', { error: err.message });
        });

        redisConnection.on('close', () => {
            isConnected = false;
            logger.warn('Redis: Connection closed');
        });

        redisConnection.on('reconnecting', () => {
            logger.info('Redis: Attempting to reconnect...');
        });

        // v24.0: Validate connection with ping before proceeding
        await validateConnection();

        // Existing queues
        deployQueue = new Queue('deployQueue', { connection: redisConnection });
        socialQueue = new Queue('socialQueue', { connection: redisConnection });

        // v13.0: New worker queues for background tasks
        holderScannerQueue = new Queue('holderScannerQueue', { connection: redisConnection });
        metadataUpdaterQueue = new Queue('metadataUpdaterQueue', { connection: redisConnection });
        robinhoodScannerQueue = new Queue('robinhoodScannerQueue', { connection: redisConnection });

        deployQueue.resume();
        socialQueue.resume();
        holderScannerQueue.resume();
        metadataUpdaterQueue.resume();
        robinhoodScannerQueue.resume();

        logger.info("Redis Queues Initialized (v24.0 - with connection validation)");
        return true;
    } catch (e) {
        logger.error("Redis Init Fail", { error: e.message });
        isConnected = false;
        return false;
    }
}

/**
 * v24.0: Validate Redis connection with ping
 * Throws error if connection fails within timeout
 */
async function validateConnection(timeoutMs = 5000) {
    if (!redisConnection) {
        throw new Error('Redis connection not initialized');
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Redis connection validation timeout'));
        }, timeoutMs);

        redisConnection.ping()
            .then((result) => {
                clearTimeout(timeout);
                if (result === 'PONG') {
                    isConnected = true;
                    logger.info('Redis: Connection validated (PONG received)');
                    resolve(true);
                } else {
                    reject(new Error(`Unexpected ping response: ${result}`));
                }
            })
            .catch((err) => {
                clearTimeout(timeout);
                reject(err);
            });
    });
}

/**
 * v24.0: Check if Redis is currently connected
 */
function isRedisConnected() {
    return isConnected && redisConnection && redisConnection.status === 'ready';
}

/**
 * v24.0: Health check for Redis connection
 * Returns latency in ms or -1 if unhealthy
 */
async function healthCheck() {
    if (!redisConnection) {
        return { healthy: false, latency: -1, error: 'Not initialized' };
    }

    try {
        const start = Date.now();
        await redisConnection.ping();
        const latency = Date.now() - start;
        return { healthy: true, latency, status: redisConnection.status };
    } catch (e) {
        return { healthy: false, latency: -1, error: e.message };
    }
}

/**
 * Smart cache with Redis
 */
async function smartCache(key, ttlSeconds, fetchFunction) {
    if (!redisConnection) {
        return await fetchFunction();
    }

    try {
        const cached = await redisConnection.get(key);
        if (cached) {
            return JSON.parse(cached);
        }

        const data = await fetchFunction();
        if (data !== undefined && data !== null) {
            await redisConnection.set(key, JSON.stringify(data), 'EX', ttlSeconds);
        }
        return data;
    } catch (e) {
        logger.error(`Cache Error [${key}]`, { error: e.message });
        return await fetchFunction();
    }
}

/**
 * Create a worker for a queue
 * v25.4: Added better error handling and connection logging
 * BullMQ requires workers to use a duplicate connection (not shared with queues)
 */
function createWorker(queueName, processor, options = {}) {
    if (!redisConnection) {
        logger.error(`Cannot create worker for ${queueName}: Redis not initialized`);
        return null;
    }

    if (!isConnected) {
        logger.warn(`Creating worker for ${queueName} but Redis connection status is not confirmed`);
    }

    try {
        // v25.4: BullMQ workers should use a duplicate connection
        // This is required because workers block connections
        const workerConnection = redisConnection.duplicate();

        const worker = new Worker(queueName, processor, {
            connection: workerConnection,
            ...options
        });

        // Add stalled job check handler
        worker.on('stalled', (jobId) => {
            logger.warn(`[${queueName}] Job ${jobId} has stalled`);
        });

        logger.info(`[Redis] Worker created for queue: ${queueName} (using duplicate connection)`);
        return worker;
    } catch (e) {
        logger.error(`[Redis] Failed to create worker for ${queueName}`, { error: e.message });
        return null;
    }
}

/**
 * Add job to deploy queue
 */
async function addDeployJob(data) {
    if (!deployQueue) {
        throw new Error("Deploy queue not initialized");
    }
    return deployQueue.add('deployToken', data);
}

/**
 * Add job to social queue
 */
async function addSocialJob(data, options = {}) {
    if (!socialQueue) {
        throw new Error("Social queue not initialized");
    }
    return socialQueue.add('postTweet', data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10000 },
        ...options
    });
}

/**
 * Get job by ID
 */
async function getJob(jobId) {
    if (!deployQueue) return null;
    return deployQueue.getJob(jobId);
}

// ===========================================
// v13.0: GlobalState Redis Operations
// ===========================================

/**
 * Update last backend update timestamp
 */
async function setLastBackendUpdate(timestamp) {
    if (!redisConnection) return;
    // SCALABILITY FIX: Add TTL to prevent stale data
    await redisConnection.set(GLOBAL_STATE_KEYS.LAST_BACKEND_UPDATE, timestamp.toString(), 'EX', GLOBAL_STATE_TTL.LAST_BACKEND_UPDATE);
}

async function getLastBackendUpdate() {
    if (!redisConnection) return Date.now();
    const val = await redisConnection.get(GLOBAL_STATE_KEYS.LAST_BACKEND_UPDATE);
    return val ? parseInt(val) : Date.now();
}

/**
 * ASDF Top 100 Holders (Set operations)
 */
async function setAsdfTop100Holders(holders) {
    if (!redisConnection) return;
    await redisConnection.del(GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS);
    if (holders.length > 0) {
        // SCALABILITY FIX: Chunk large arrays to prevent memory issues
        const CHUNK_SIZE = 100;
        for (let i = 0; i < holders.length; i += CHUNK_SIZE) {
            const chunk = holders.slice(i, i + CHUNK_SIZE);
            await redisConnection.sadd(GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS, ...chunk);
        }
        // SCALABILITY FIX: Add TTL
        await redisConnection.expire(GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS, GLOBAL_STATE_TTL.ASDF_TOP100_HOLDERS);
    }
}

async function getAsdfTop100Holders() {
    if (!redisConnection) return new Set();
    const members = await redisConnection.smembers(GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS);
    return new Set(members);
}

async function isAsdfTop100Holder(pubkey) {
    if (!redisConnection) return false;
    return await redisConnection.sismember(GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS, pubkey);
}

/**
 * Total Points
 */
async function setTotalPoints(points) {
    if (!redisConnection) return;
    // SCALABILITY FIX: Add TTL
    await redisConnection.set(GLOBAL_STATE_KEYS.TOTAL_POINTS, points.toString(), 'EX', GLOBAL_STATE_TTL.TOTAL_POINTS);
}

async function getTotalPoints() {
    if (!redisConnection) return 0;
    const val = await redisConnection.get(GLOBAL_STATE_KEYS.TOTAL_POINTS);
    return val ? parseFloat(val) : 0;
}

/**
 * Dev PUMP Holdings
 */
async function setDevPumpHoldings(holdings) {
    if (!redisConnection) return;
    // SCALABILITY FIX: Add TTL
    await redisConnection.set(GLOBAL_STATE_KEYS.DEV_PUMP_HOLDINGS, holdings.toString(), 'EX', GLOBAL_STATE_TTL.DEV_PUMP_HOLDINGS);
}

async function getDevPumpHoldings() {
    if (!redisConnection) return 0;
    const val = await redisConnection.get(GLOBAL_STATE_KEYS.DEV_PUMP_HOLDINGS);
    return val ? parseFloat(val) : 0;
}

/**
 * User Expected Airdrops (Hash operations for Map-like storage)
 */
async function setUserExpectedAirdrop(pubkey, amount) {
    if (!redisConnection) return;
    await redisConnection.hset(GLOBAL_STATE_KEYS.USER_EXPECTED_AIRDROPS, pubkey, amount.toString());
}

async function getUserExpectedAirdrop(pubkey) {
    if (!redisConnection) return 0;
    const val = await redisConnection.hget(GLOBAL_STATE_KEYS.USER_EXPECTED_AIRDROPS, pubkey);
    return val ? parseFloat(val) : 0;
}

async function getAllUserExpectedAirdrops() {
    if (!redisConnection) return new Map();
    const hash = await redisConnection.hgetall(GLOBAL_STATE_KEYS.USER_EXPECTED_AIRDROPS);
    const map = new Map();
    for (const [key, val] of Object.entries(hash)) {
        map.set(key, parseFloat(val));
    }
    return map;
}

async function clearUserExpectedAirdrops() {
    if (!redisConnection) return;
    await redisConnection.del(GLOBAL_STATE_KEYS.USER_EXPECTED_AIRDROPS);
}

async function setAllUserExpectedAirdrops(map) {
    if (!redisConnection) return;
    await redisConnection.del(GLOBAL_STATE_KEYS.USER_EXPECTED_AIRDROPS);
    if (map.size > 0) {
        // SCALABILITY FIX: Chunk pipeline operations to prevent memory issues
        const CHUNK_SIZE = 1000;
        const entries = Array.from(map.entries());
        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
            const chunk = entries.slice(i, i + CHUNK_SIZE);
            const pipeline = redisConnection.pipeline();
            for (const [key, val] of chunk) {
                pipeline.hset(GLOBAL_STATE_KEYS.USER_EXPECTED_AIRDROPS, key, val.toString());
            }
            await pipeline.exec();
        }
        // SCALABILITY FIX: Add TTL
        await redisConnection.expire(GLOBAL_STATE_KEYS.USER_EXPECTED_AIRDROPS, GLOBAL_STATE_TTL.USER_EXPECTED_AIRDROPS);
    }
}

/**
 * User Points Map (Hash operations)
 */
async function setUserPoints(pubkey, points) {
    if (!redisConnection) return;
    await redisConnection.hset(GLOBAL_STATE_KEYS.USER_POINTS_MAP, pubkey, points.toString());
}

async function getUserPoints(pubkey) {
    if (!redisConnection) return 0;
    const val = await redisConnection.hget(GLOBAL_STATE_KEYS.USER_POINTS_MAP, pubkey);
    return val ? parseFloat(val) : 0;
}

async function getAllUserPoints() {
    if (!redisConnection) return new Map();
    const hash = await redisConnection.hgetall(GLOBAL_STATE_KEYS.USER_POINTS_MAP);
    const map = new Map();
    for (const [key, val] of Object.entries(hash)) {
        map.set(key, parseFloat(val));
    }
    return map;
}

async function clearUserPoints() {
    if (!redisConnection) return;
    await redisConnection.del(GLOBAL_STATE_KEYS.USER_POINTS_MAP);
}

async function setAllUserPoints(map) {
    if (!redisConnection) return;
    await redisConnection.del(GLOBAL_STATE_KEYS.USER_POINTS_MAP);
    if (map.size > 0) {
        // SCALABILITY FIX: Chunk pipeline operations to prevent memory issues
        const CHUNK_SIZE = 1000;
        const entries = Array.from(map.entries());
        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
            const chunk = entries.slice(i, i + CHUNK_SIZE);
            const pipeline = redisConnection.pipeline();
            for (const [key, val] of chunk) {
                pipeline.hset(GLOBAL_STATE_KEYS.USER_POINTS_MAP, key, val.toString());
            }
            await pipeline.exec();
        }
        // SCALABILITY FIX: Add TTL
        await redisConnection.expire(GLOBAL_STATE_KEYS.USER_POINTS_MAP, GLOBAL_STATE_TTL.USER_POINTS_MAP);
    }
}

/**
 * Get full globalState snapshot (for API responses)
 */
async function getGlobalStateSnapshot() {
    return {
        lastBackendUpdate: await getLastBackendUpdate(),
        asdfTop100Holders: await getAsdfTop100Holders(),
        totalPoints: await getTotalPoints(),
        devPumpHoldings: await getDevPumpHoldings(),
        userExpectedAirdrops: await getAllUserExpectedAirdrops(),
        userPointsMap: await getAllUserPoints(),
    };
}

// ===========================================
// v13.0: Worker Queue Job Functions
// ===========================================

/**
 * Add job to holder scanner queue
 */
async function addHolderScannerJob(data = {}) {
    if (!holderScannerQueue) {
        throw new Error("Holder scanner queue not initialized");
    }
    return holderScannerQueue.add('scanHolders', data, {
        removeOnComplete: 100,
        removeOnFail: 50,
    });
}

/**
 * Add job to metadata updater queue
 */
async function addMetadataUpdaterJob(data = {}) {
    if (!metadataUpdaterQueue) {
        throw new Error("Metadata updater queue not initialized");
    }
    return metadataUpdaterQueue.add('updateMetadata', data, {
        removeOnComplete: 100,
        removeOnFail: 50,
    });
}

/**
 * Add job to Robinhood scanner queue
 */
async function addRobinhoodScannerJob(data = {}) {
    if (!robinhoodScannerQueue) {
        throw new Error("Robinhood scanner queue not initialized");
    }
    return robinhoodScannerQueue.add('scanRobinhood', data, {
        removeOnComplete: 100,
        removeOnFail: 50,
    });
}

module.exports = {
    init,
    smartCache,
    createWorker,
    addDeployJob,
    addSocialJob,
    getJob,
    getConnection: () => redisConnection,
    getDeployQueue: () => deployQueue,
    getSocialQueue: () => socialQueue,

    // v24.0: Connection health utilities
    isRedisConnected,
    healthCheck,
    validateConnection,

    // v13.0: New worker queues
    getHolderScannerQueue: () => holderScannerQueue,
    getMetadataUpdaterQueue: () => metadataUpdaterQueue,
    getRobinhoodScannerQueue: () => robinhoodScannerQueue,
    addHolderScannerJob,
    addMetadataUpdaterJob,
    addRobinhoodScannerJob,

    // v13.0: GlobalState operations
    GLOBAL_STATE_KEYS,
    setLastBackendUpdate,
    getLastBackendUpdate,
    setAsdfTop100Holders,
    getAsdfTop100Holders,
    isAsdfTop100Holder,
    setTotalPoints,
    getTotalPoints,
    setDevPumpHoldings,
    getDevPumpHoldings,
    setUserExpectedAirdrop,
    getUserExpectedAirdrop,
    getAllUserExpectedAirdrops,
    clearUserExpectedAirdrops,
    setAllUserExpectedAirdrops,
    setUserPoints,
    getUserPoints,
    getAllUserPoints,
    clearUserPoints,
    setAllUserPoints,
    getGlobalStateSnapshot,
};
