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
let socialQueue = null;

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
        socialQueue = new Queue('socialQueue', { connection: redisConnection });

        deployQueue.resume();
        socialQueue.resume();

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
};
