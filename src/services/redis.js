/**
 * Redis Service
 * Redis connection, queue management, and globalState
 * v13.0 - Added globalState for cross-process sharing
 * v24.0 - Added connection validation and health checking
 * v25.23 - Improved reconnection handling for long-running deployments
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

// v25.28: Reduced TTLs to save Redis memory
// These are refreshed by holder scanner jobs, so short TTLs are fine
const GLOBAL_STATE_TTL = {
    LAST_BACKEND_UPDATE: 180,       // 3 minutes - refreshed frequently
    ASDF_TOP100_HOLDERS: 300,       // 5 minutes - updated every 2 mins
    TOTAL_POINTS: 300,              // 5 minutes
    DEV_PUMP_HOLDINGS: 300,         // 5 minutes
    USER_EXPECTED_AIRDROPS: 300,    // 5 minutes - critical for airdrop display
    USER_POINTS_MAP: 300,           // 5 minutes - critical for points display
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
            // v25.23: Improved retry strategy for long-running deployments
            // Never give up - keep retrying with exponential backoff up to 30 seconds
            retryStrategy: (times) => {
                // Exponential backoff: 200ms, 400ms, 800ms, ... up to 30 seconds max
                const delay = Math.min(times * 200, 30000);

                // Log every 10 attempts to avoid log spam
                if (times % 10 === 1 || times <= 3) {
                    logger.warn(`Redis: Reconnecting in ${delay}ms (attempt ${times})`);
                }

                // After 50 attempts (~5 minutes of trying), log as error but keep trying
                if (times === 50) {
                    logger.error('Redis: Extended reconnection attempts - check Redis server status');
                }

                return delay; // Always return delay to keep retrying
            },
            // v25.23: Connection settings for stability
            connectTimeout: 10000,        // 10 second connection timeout
            keepAlive: 30000,             // Send keepalive every 30 seconds
            lazyConnect: false,           // Connect immediately
            reconnectOnError: (err) => {
                // Reconnect on connection reset errors
                const targetErrors = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'];
                return targetErrors.some(e => err.message.includes(e));
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

        // v25.23: Handle complete disconnection (retry strategy returned null or max retries)
        redisConnection.on('end', () => {
            isConnected = false;
            logger.error('Redis: Connection ended - will attempt to reconnect');
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
 * v25.27: Check if Redis has available memory
 * Returns true if memory usage is below 90% of maxmemory
 */
async function hasAvailableMemory() {
    if (!redisConnection) return false;
    try {
        const info = await redisConnection.info('memory');
        const usedMatch = info.match(/used_memory:(\d+)/);
        const maxMatch = info.match(/maxmemory:(\d+)/);

        if (usedMatch && maxMatch) {
            const used = parseInt(usedMatch[1]);
            const max = parseInt(maxMatch[1]);
            // If maxmemory is 0, it means no limit - assume we have space
            if (max === 0) return true;
            // Return true if using less than 90% of memory
            return used < (max * 0.9);
        }
        return true; // Assume we have space if can't determine
    } catch (e) {
        return true; // Assume we have space if check fails
    }
}

/**
 * v25.27: Get Redis memory stats
 */
async function getMemoryStats() {
    if (!redisConnection) return null;
    try {
        const info = await redisConnection.info('memory');
        const usedMatch = info.match(/used_memory:(\d+)/);
        const maxMatch = info.match(/maxmemory:(\d+)/);
        const peakMatch = info.match(/used_memory_peak:(\d+)/);

        return {
            usedBytes: usedMatch ? parseInt(usedMatch[1]) : 0,
            maxBytes: maxMatch ? parseInt(maxMatch[1]) : 0,
            peakBytes: peakMatch ? parseInt(peakMatch[1]) : 0,
            usedMB: usedMatch ? Math.round(parseInt(usedMatch[1]) / 1024 / 1024) : 0,
            maxMB: maxMatch ? Math.round(parseInt(maxMatch[1]) / 1024 / 1024) : 0,
        };
    } catch (e) {
        logger.debug('Failed to get Redis memory stats', { error: e.message });
        return null;
    }
}

/**
 * Smart cache with Redis
 * v25.27: Added OOM protection - skips cache write if memory is near limit
 */
async function smartCache(key, ttlSeconds, fetchFunction) {
    if (!redisConnection) {
        return await fetchFunction();
    }

    let fetchedData = undefined;
    try {
        const cached = await redisConnection.get(key);
        if (cached) {
            return JSON.parse(cached);
        }

        fetchedData = await fetchFunction();
        if (fetchedData !== undefined && fetchedData !== null) {
            // v25.27: Check memory before writing to cache
            const hasMemory = await hasAvailableMemory();
            if (hasMemory) {
                await redisConnection.set(key, JSON.stringify(fetchedData), 'EX', ttlSeconds);
            } else {
                logger.warn(`[Redis] Skipping cache write for ${key} - memory near limit`);
            }
        }
        return fetchedData;
    } catch (e) {
        // v25.27: Handle OOM errors gracefully
        if (e.message && e.message.includes('OOM')) {
            logger.warn(`[Redis] OOM error on cache [${key}] - returning fresh data`);
        } else {
            logger.error(`Cache Error [${key}]`, { error: e.message });
        }
        // Return already-fetched data if available, otherwise fetch fresh
        if (fetchedData !== undefined) return fetchedData;
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
    if (holders.length > 0) {
        // Atomic swap: write to temp key then rename to avoid empty-set window for readers
        const tempKey = GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS + ':tmp';
        await redisConnection.del(tempKey);
        const CHUNK_SIZE = 100;
        for (let i = 0; i < holders.length; i += CHUNK_SIZE) {
            const chunk = holders.slice(i, i + CHUNK_SIZE);
            await redisConnection.sadd(tempKey, ...chunk);
        }
        await redisConnection.rename(tempKey, GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS);
        await redisConnection.expire(GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS, GLOBAL_STATE_TTL.ASDF_TOP100_HOLDERS);
    } else {
        await redisConnection.del(GLOBAL_STATE_KEYS.ASDF_TOP100_HOLDERS);
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
    // H-3 FIX: Write to a temp key first, then atomically RENAME to live key.
    // This eliminates the DEL→populate window where readers see an empty hash.
    const liveKey = GLOBAL_STATE_KEYS.USER_EXPECTED_AIRDROPS;
    const tempKey = liveKey + ':tmp';
    await redisConnection.del(tempKey);
    if (map.size > 0) {
        const CHUNK_SIZE = 1000;
        const entries = Array.from(map.entries());
        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
            const chunk = entries.slice(i, i + CHUNK_SIZE);
            const pipeline = redisConnection.pipeline();
            for (const [key, val] of chunk) {
                pipeline.hset(tempKey, key, val.toString());
            }
            await pipeline.exec();
        }
        await redisConnection.rename(tempKey, liveKey);
        await redisConnection.expire(liveKey, GLOBAL_STATE_TTL.USER_EXPECTED_AIRDROPS);
    } else {
        await redisConnection.del(liveKey);
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
    // H-3 FIX: Write to a temp key first, then atomically RENAME to live key.
    // This eliminates the DEL→populate window where readers see an empty hash,
    // which previously caused processAirdrop to abort with "No eligible users found".
    const liveKey = GLOBAL_STATE_KEYS.USER_POINTS_MAP;
    const tempKey = liveKey + ':tmp';
    await redisConnection.del(tempKey);
    if (map.size > 0) {
        const CHUNK_SIZE = 1000;
        const entries = Array.from(map.entries());
        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
            const chunk = entries.slice(i, i + CHUNK_SIZE);
            const pipeline = redisConnection.pipeline();
            for (const [key, val] of chunk) {
                pipeline.hset(tempKey, key, val.toString());
            }
            await pipeline.exec();
        }
        await redisConnection.rename(tempKey, liveKey);
        await redisConnection.expire(liveKey, GLOBAL_STATE_TTL.USER_POINTS_MAP);
    } else {
        await redisConnection.del(liveKey);
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
 * v25.28: Reduced job retention from 100/50 to 5/3 to save Redis memory
 */
async function addHolderScannerJob(data = {}) {
    if (!holderScannerQueue) {
        throw new Error("Holder scanner queue not initialized");
    }
    return holderScannerQueue.add('scanHolders', data, {
        removeOnComplete: 5,
        removeOnFail: 3,
    });
}

/**
 * Add job to metadata updater queue
 * v25.28: Reduced job retention from 100/50 to 5/3 to save Redis memory
 */
async function addMetadataUpdaterJob(data = {}) {
    if (!metadataUpdaterQueue) {
        throw new Error("Metadata updater queue not initialized");
    }
    return metadataUpdaterQueue.add('updateMetadata', data, {
        removeOnComplete: 5,
        removeOnFail: 3,
    });
}

/**
 * Add job to Robinhood scanner queue
 * v25.28: Reduced job retention from 100/50 to 5/3 to save Redis memory
 */
async function addRobinhoodScannerJob(data = {}) {
    if (!robinhoodScannerQueue) {
        throw new Error("Robinhood scanner queue not initialized");
    }
    return robinhoodScannerQueue.add('scanRobinhood', data, {
        removeOnComplete: 5,
        removeOnFail: 3,
    });
}

/**
 * v25.27: Clean up old completed and failed jobs from all queues
 * v25.28: More aggressive cleanup - 10 min for completed, 1 hour for failed
 * This helps prevent Redis memory buildup from BullMQ job history
 */
async function cleanupOldJobs() {
    const queues = [deployQueue, socialQueue, holderScannerQueue, metadataUpdaterQueue, robinhoodScannerQueue];
    let totalCleaned = 0;

    for (const queue of queues) {
        if (!queue) continue;
        try {
            // v25.28: More aggressive - remove completed jobs older than 10 minutes
            const completedCleaned = await queue.clean(600000, 1000, 'completed');
            // v25.28: More aggressive - remove failed jobs older than 1 hour
            const failedCleaned = await queue.clean(3600000, 500, 'failed');
            totalCleaned += (completedCleaned?.length || 0) + (failedCleaned?.length || 0);
        } catch (e) {
            logger.debug(`[Redis] Queue cleanup error for ${queue.name}`, { error: e.message });
        }
    }

    if (totalCleaned > 0) {
        logger.info(`[Redis] Cleaned ${totalCleaned} old jobs from queues`);
    }
    return totalCleaned;
}

/**
 * v25.27: Full memory cleanup routine
 * Run this periodically or when memory is getting tight
 */
async function performMemoryCleanup() {
    logger.info('[Redis] Starting memory cleanup...');

    // 1. Clean old queue jobs
    await cleanupOldJobs();

    // 2. Clear expired cache keys (Redis does this automatically, but we can force it)
    // The scan command is safe even with large keyspaces
    if (redisConnection) {
        try {
            // Just touch some keys to trigger TTL cleanup
            await redisConnection.dbsize();
        } catch (e) {
            logger.debug('[Redis] Memory cleanup dbsize check failed', { error: e.message });
        }
    }

    // 3. Log current memory stats
    const stats = await getMemoryStats();
    if (stats) {
        logger.info(`[Redis] Memory after cleanup: ${stats.usedMB}MB / ${stats.maxMB || 'unlimited'}MB`);
    }

    return stats;
}

/**
 * v25.42: Invalidate a smart cache entry
 * Used to force refresh of cached data (e.g., after admin triggers KOTH refresh)
 */
async function invalidateCache(key) {
    if (!redisConnection) return false;
    try {
        await redisConnection.del(key);
        logger.debug(`[Redis] Cache invalidated: ${key}`);
        return true;
    } catch (e) {
        logger.error(`[Redis] Failed to invalidate cache [${key}]`, { error: e.message });
        return false;
    }
}

/**
 * v25.42: Simple get wrapper for Redis
 * Returns null if Redis unavailable or key doesn't exist
 */
async function get(key) {
    if (!redisConnection) return null;
    try {
        return await redisConnection.get(key);
    } catch (e) {
        logger.error(`[Redis] Get failed [${key}]`, { error: e.message });
        return null;
    }
}

module.exports = {
    init,
    smartCache,
    invalidateCache,
    get,
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

    // v25.27: Memory management
    hasAvailableMemory,
    getMemoryStats,
    cleanupOldJobs,
    performMemoryCleanup,

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
