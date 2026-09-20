/**
 * Run Guard
 * Overlap guard for the background loops.
 *
 * A plain boolean flag has one failure mode: if a run never returns (a hung RPC or
 * HTTP call), the flag stays set and every later tick is skipped until the process
 * restarts. This guard records when the run started and lets a new run through once
 * the previous one has been going for longer than `maxRunMs`, logging loudly so the
 * hang is visible.
 */
const logger = require('../services/logger');

function createRunGuard(name, maxRunMs) {
    let runningSince = 0;
    let currentRun = 0; // token of the run that holds the guard
    let nextRun = 0;

    return {
        /**
         * Returns a token when the caller may run, or null when a run is in progress.
         */
        tryAcquire() {
            if (runningSince) {
                const ageMs = Date.now() - runningSince;
                if (ageMs < maxRunMs) {
                    logger.warn(`${name}: previous run still in progress (${Math.round(ageMs / 1000)}s), skipping this tick`);
                    return null;
                }
                logger.error(`${name}: previous run has been stuck for ${Math.round(ageMs / 1000)}s; starting a new run anyway`);
            }
            runningSince = Date.now();
            currentRun = ++nextRun;
            return currentRun;
        },

        /**
         * Clears the guard, but only for the run that holds it. A stuck run that
         * finally returns after a replacement started must not clear the replacement.
         */
        release(token) {
            if (token === currentRun) {
                runningSince = 0;
                currentRun = 0;
            }
        },

        isRunning() {
            return runningSince !== 0;
        },
    };
}

/**
 * Loops run at `intervalMs`; a run is considered stuck after three intervals,
 * but never sooner than ten minutes so a legitimately slow run is not doubled up.
 */
function maxRunAge(intervalMs) {
    return Math.max(3 * intervalMs, 10 * 60 * 1000);
}

module.exports = { createRunGuard, maxRunAge };
