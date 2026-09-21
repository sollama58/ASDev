/**
 * Logger Service
 * Centralized logging with file and console output
 */
const fs = require('fs');
const path = require('path');
const config = require('../config/env');

// Ensure data directory exists
const DISK_ROOT = config.DISK_ROOT;
if (!fs.existsSync(DISK_ROOT)) {
    fs.mkdirSync(DISK_ROOT, { recursive: true });
}

const DEBUG_LOG_FILE = path.join(DISK_ROOT, 'server_debug.log');

// The file is appended to forever otherwise. Once it passes this size it is moved to
// `server_debug.log.1` (replacing the previous backup) and a fresh file is started.
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const ROTATION_CHECK_EVERY = 500; // writes

let logStream = fs.createWriteStream(DEBUG_LOG_FILE, { flags: 'a' });
let writesSinceCheck = 0;

function rotateIfNeeded() {
    writesSinceCheck = 0;
    try {
        if (!fs.existsSync(DEBUG_LOG_FILE) || fs.statSync(DEBUG_LOG_FILE).size < MAX_LOG_BYTES) return;
        logStream.end();
        fs.renameSync(DEBUG_LOG_FILE, `${DEBUG_LOG_FILE}.1`);
        logStream = fs.createWriteStream(DEBUG_LOG_FILE, { flags: 'a' });
    } catch (e) {
        console.error(`[ERROR] Log rotation failed: ${e.message}`);
    }
}
rotateIfNeeded();

function log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';

    // Write to file
    logStream.write(`[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`);
    if (++writesSinceCheck >= ROTATION_CHECK_EVERY) rotateIfNeeded();

    // Write to console
    const consoleMethod = level === 'error' ? console.error : console.log;
    consoleMethod(`[${level.toUpperCase()}] ${message}`, Object.keys(meta).length > 0 ? meta : '');
}

const logger = {
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
    debug: (message, meta) => {
        if (config.NODE_ENV === 'development') {
            log('debug', message, meta);
        }
    },
};

module.exports = logger;
