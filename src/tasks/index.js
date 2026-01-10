/**
 * Tasks Index
 * Central export for all background tasks
 * v13.0 - Worker-based architecture with Redis queues
 */
const holderScanner = require('./holderScanner');
const metadataUpdater = require('./metadataUpdater');
const asdfSync = require('./asdfSync');
const flywheel = require('./flywheel');
const robinhoodScanner = require('./robinhoodScanner');
const workers = require('./workers');
const { vanity, logger } = require('../services');
const config = require('../config/env');

/**
 * Start all background tasks
 * v13.0: Uses worker queues for heavy tasks
 */
function startAll(deps) {
    // v13.0: Use worker-based architecture for heavy tasks
    // These run as BullMQ workers with Redis-backed queues
    workers.initHolderScannerWorker(deps);
    workers.initMetadataUpdaterWorker(deps);
    workers.initRobinhoodScannerWorker(deps);
    workers.initAsdfSyncWorker(deps);

    // Start flywheel (still runs in main process - timing critical)
    flywheel.start(deps);

    // Start vanity pool auto-refill
    if (config.VANITY_GRINDER_ENABLED && config.VANITY_GRINDER_URL) {
        vanity.startAutoRefill();
    }

    // Initialize deploy and social workers
    workers.initDeployWorker(deps);
    workers.initSocialWorker(deps);

    logger.info("All background tasks started (v13.0 - Worker Architecture)");
}

module.exports = {
    holderScanner,
    metadataUpdater,
    asdfSync,
    flywheel,
    robinhoodScanner,
    workers,
    startAll,
};
