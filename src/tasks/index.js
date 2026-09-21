/**
 * Tasks Index
 * Central export for all background tasks
 */
const holderScanner = require('./holderScanner');
const metadataUpdater = require('./metadataUpdater');
const asdfSync = require('./asdfSync');
const flywheel = require('./flywheel');
const workers = require('./workers');
const { vanity, logger, database } = require('../services');
const config = require('../config/env');

/**
 * Start all background tasks
 */
function startAll(deps) {
    // Start holder scanner
    holderScanner.start(deps);

    // Start metadata updater
    metadataUpdater.start(deps);

    // Start ASDF sync
    asdfSync.start(deps);

    // Start flywheel
    flywheel.start(deps);

    // Start vanity pool auto-refill
    if (config.VANITY_GRINDER_ENABLED && config.VANITY_GRINDER_URL) {
        vanity.startAutoRefill();
    }

    // Initialize workers
    workers.initDeployWorker(deps);

    // Keep the logs table bounded (it also gets pruned at startup)
    setInterval(() => database.pruneLogs(), 6 * 60 * 60 * 1000);

    logger.info("All background tasks started");
}

module.exports = {
    holderScanner,
    metadataUpdater,
    asdfSync,
    flywheel,
    workers,
    startAll,
};
