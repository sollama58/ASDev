/**
 * Logger Service
 * v25.26 - Centralized logging with proper stdout/stderr output for Render
 *
 * Log Levels:
 * - error: Always shown (errors) -> stderr
 * - warn: Always shown (warnings) -> stdout
 * - info: Always shown (important operational info) -> stdout
 * - debug: Only in development OR when DEBUG_LOGS=true -> stdout
 *
 * IMPORTANT: Render captures stdout/stderr directly. We write to process.stdout
 * and process.stderr to ensure logs appear in Render's log viewer.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config/env');

// Ensure data directory exists
const DISK_ROOT = config.DISK_ROOT;
try {
    if (!fs.existsSync(DISK_ROOT)) {
        fs.mkdirSync(DISK_ROOT, { recursive: true });
    }
} catch (e) {
    // Ignore - might not have filesystem access on Render
}

const DEBUG_LOG_FILE = path.join(DISK_ROOT, 'server_debug.log');
let logStream = null;
try {
    logStream = fs.createWriteStream(DEBUG_LOG_FILE, { flags: 'a' });
} catch (e) {
    // If we can't write to file (e.g., Render ephemeral filesystem), just log to console
    logStream = null;
}

// Enable debug logs in dev mode or when DEBUG_LOGS env var is set
const DEBUG_ENABLED = config.NODE_ENV === 'development' || process.env.DEBUG_LOGS === 'true';

function log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;

    // Write to file if available
    if (logStream) {
        try {
            logStream.write(logLine);
        } catch (e) {
            // Ignore file write errors
        }
    }

    // v25.26: Write directly to stdout/stderr for Render compatibility
    // Render captures these streams directly - console.log may be buffered
    if (level === 'error') {
        process.stderr.write(logLine);
    } else {
        process.stdout.write(logLine);
    }
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
