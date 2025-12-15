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
const logStream = fs.createWriteStream(DEBUG_LOG_FILE, { flags: 'a' });

function log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';

    // Write to file
    logStream.write(`[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`);

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
