/**
 * Logger Service
 * v25.25 - Centralized logging with file and console output
 *
 * Log Levels:
 * - error: Always shown (errors)
 * - warn: Always shown (warnings)
 * - info: Always shown (important operational info)
 * - debug: Only in development OR when DEBUG_LOGS=true
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
let logStream;
try {
    logStream = fs.createWriteStream(DEBUG_LOG_FILE, { flags: 'a' });
} catch (e) {
    // If we can't write to file (e.g., Render ephemeral filesystem), just log to console
    logStream = null;
    console.warn('[Logger] Could not create log file, using console only');
}

// Enable debug logs in dev mode or when DEBUG_LOGS env var is set
const DEBUG_ENABLED = config.NODE_ENV === 'development' || process.env.DEBUG_LOGS === 'true';

function log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;

    // Write to file if available
    if (logStream) {
        logStream.write(logLine + '\n');
    }

    // Write to console - always output for production visibility
    const consoleMethod = level === 'error' ? console.error : console.log;
    consoleMethod(`[${level.toUpperCase()}] ${message}`, Object.keys(meta).length > 0 ? meta : '');
}

const logger = {
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
    debug: (message, meta) => {
        // Debug logs only in development or when explicitly enabled
        if (DEBUG_ENABLED) {
            log('debug', message, meta);
        }
    },
    // v25.25: New method for logs that should always appear in production
    // Use this for important operational events that aren't errors/warnings
    verbose: (message, meta) => log('info', message, meta),
};

module.exports = logger;
