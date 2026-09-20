/**
 * Redis Service
 * Redis connection and queue management
 */
const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const config = require('../config/env');
const logger = require('./logger');

let redisConnection = null;
let deployQueue = null;

/**
 * Initialize Redis connection and queues
 */
function init() {
    try {
        redisConnection = new IORedis(config.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false
        });

        deployQueue = new Queue('deployQueue', { connection: redisConnection });

        deployQueue.resume();

        logger.info("Redis Queues Initialized");
        return true;
    } catch (e) {
        logger.error("Redis Init Fail", { error: e.message });
        return false;
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
 */
function createWorker(queueName, processor, options = {}) {
    if (!redisConnection) {
        logger.error("Cannot create worker: Redis not initialized");
        return null;
    }

    return new Worker(queueName, processor, {
        connection: redisConnection,
        ...options
    });
}

/**
 * Add job to deploy queue
 */
async function addDeployJob(data) {
    if (!deployQueue) {
        throw new Error("Deploy queue not initialized");
    }
    // Finished jobs are kept long enough for the frontend's status polling (up to five
    // minutes) and a bit of debugging, then dropped so Redis does not grow forever.
    return deployQueue.add('deployToken', data, {
        removeOnComplete: { age: 60 * 60, count: 500 },
        removeOnFail: { age: 24 * 60 * 60, count: 500 },
    });
}

const PREPARED_METADATA_TTL_SECONDS = 60 * 60;

/**
 * Remember a metadata URI produced by /prepare-metadata so /deploy can require it.
 * Without this, a caller could skip the moderation check by supplying their own URI.
 */
async function rememberPreparedMetadata(metadataUri, data) {
    if (!redisConnection) throw new Error("Redis not initialized");
    await redisConnection.set(`prepared:${metadataUri}`, JSON.stringify(data), 'EX', PREPARED_METADATA_TTL_SECONDS);
}

/**
 * Returns what /prepare-metadata stored for this URI, or null if it was never prepared
 * (or has expired).
 */
async function getPreparedMetadata(metadataUri) {
    if (!redisConnection) return null;
    const raw = await redisConnection.get(`prepared:${metadataUri}`);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Get job by ID
 */
async function getJob(jobId) {
    if (!deployQueue) return null;
    return deployQueue.getJob(jobId);
}

module.exports = {
    init,
    smartCache,
    createWorker,
    addDeployJob,
    getJob,
    rememberPreparedMetadata,
    getPreparedMetadata,
    getConnection: () => redisConnection,
    getDeployQueue: () => deployQueue,
};
