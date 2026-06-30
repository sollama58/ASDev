/**
 * Tasks Index
 * Central export for all background tasks
 * v13.0 - Worker-based architecture with Redis queues
 * v25.14 - Added graceful shutdown with interval cleanup
 * v25.47 - Added PAGS claim processor
 * v25.67 - Fixed Helius DAS API response parsing for holder scanning
 * v25.68 - Admin trigger-robinhood-scan now includes holder updates
 * v25.69 - Enhanced KOTH logging for Robinhood token eligibility
 * v25.70 - Claude KOTH now includes Robinhood tokens in candidates
 * v25.71 - Fixed /koth endpoint and Redis storage to handle Robinhood tokens
 * v25.72 - Added Robinhood vault debugging and admin fix endpoints for creatorPubkey
 * v25.73 - CRITICAL FIX: feeVaultAddress for fee sharing tokens - coinCreator IS the vault
 */
const holderScanner = require('./holderScanner');
const metadataUpdater = require('./metadataUpdater');
const asdfSync = require('./asdfSync');
const flywheel = require('./flywheel');
const robinhoodScanner = require('./robinhoodScanner');
// const pagsClaimProcessor = require('./pagsClaimProcessor'); // PAGS disabled
const workers = require('./workers');
const { logger } = require('../services');
const config = require('../config/env');

// v25.14 ROBUSTNESS: Track intervals for graceful shutdown
const activeIntervals = [];
const activeWorkers = [];

/**
 * Start all background tasks
 * v13.0: Uses worker queues for heavy tasks
 * v25.14: Track intervals for graceful shutdown
 * v25.27: Added Redis memory cleanup interval
 */
function startAll(deps) {
    const { redis } = require('../services');

    // v13.0: Use worker-based architecture for heavy tasks
    // These run as BullMQ workers with Redis-backed queues
    const holderWorker = workers.initHolderScannerWorker(deps);
    const metadataWorker = workers.initMetadataUpdaterWorker(deps);
    const robinhoodWorker = workers.initRobinhoodScannerWorker(deps);
    workers.initAsdfSyncWorker(deps);
    workers.initAnsemSyncWorker(deps);

    // Track workers for graceful shutdown
    if (holderWorker) activeWorkers.push(holderWorker);
    if (metadataWorker) activeWorkers.push(metadataWorker);
    if (robinhoodWorker) activeWorkers.push(robinhoodWorker);

    // Start flywheel (still runs in main process - timing critical)
    flywheel.start(deps);

    // v25.45: Start tiered metadata updater for frequent price updates
    // Top 10 tokens update every 1 minute, all tokens every 5 minutes
    metadataUpdater.start(deps);

    // Initialize deploy and social workers
    const deployWorker = workers.initDeployWorker(deps);
    const socialWorker = workers.initSocialWorker(deps);
    if (deployWorker) activeWorkers.push(deployWorker);
    if (socialWorker) activeWorkers.push(socialWorker);

    // v25.27: Redis memory cleanup every 10 minutes
    const redisCleanupInterval = setInterval(async () => {
        try {
            const stats = await redis.getMemoryStats();
            if (stats && stats.maxBytes > 0) {
                const usagePercent = (stats.usedBytes / stats.maxBytes) * 100;
                if (usagePercent > 80) {
                    logger.warn(`[Tasks] Redis memory at ${usagePercent.toFixed(1)}% - running cleanup`);
                    await redis.performMemoryCleanup();
                } else {
                    // Just clean old jobs even if memory is OK
                    await redis.cleanupOldJobs();
                }
            } else {
                // No memory limit, just clean old jobs
                await redis.cleanupOldJobs();
            }
        } catch (e) {
            logger.debug('[Tasks] Redis cleanup error', { error: e.message });
        }
    }, 600000); // 10 minutes
    registerInterval(redisCleanupInterval);

    // PAGS claim processor disabled

    logger.info("All background tasks started (v25.73 - feeVaultAddress fix for fee sharing tokens)");
}

/**
 * v25.14 ROBUSTNESS: Graceful shutdown - clear all intervals and close workers
 */
async function stopAll() {
    logger.info('[Tasks] Stopping all background tasks...');

    // Clear all intervals
    for (const intervalId of activeIntervals) {
        try {
            clearInterval(intervalId);
        } catch (e) {
            logger.debug('[Tasks] Error clearing interval', { error: e.message });
        }
    }
    activeIntervals.length = 0;

    // Close all workers gracefully
    const closePromises = activeWorkers.map(async (worker) => {
        try {
            if (worker && typeof worker.close === 'function') {
                await worker.close();
            }
        } catch (e) {
            logger.debug('[Tasks] Error closing worker', { error: e.message });
        }
    });

    await Promise.allSettled(closePromises);
    activeWorkers.length = 0;

    logger.info('[Tasks] All background tasks stopped');
}

/**
 * v25.14: Register an interval for tracking (used by task modules)
 */
function registerInterval(intervalId) {
    activeIntervals.push(intervalId);
    return intervalId;
}

module.exports = {
    holderScanner,
    metadataUpdater,
    asdfSync,
    flywheel,
    robinhoodScanner,
    // pagsClaimProcessor, // PAGS disabled
    workers,
    startAll,
    stopAll,
    registerInterval,
};
