/**
 * Database Service
 * SQLite database initialization and helper functions
 */
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const config = require('../config/env');
const logger = require('./logger');

// Paths
const DISK_ROOT = config.DISK_ROOT;
const DATA_DIR = path.join(DISK_ROOT, 'tokens');
const DB_PATH = path.join(DISK_ROOT, 'launcher.db');

// Ensure directories exist
const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};
ensureDir(DISK_ROOT);
ensureDir(DATA_DIR);

// Database instance
let db = null;

// Cache
const cache = new Map();

async function smartCache(key, ttlSeconds, fetchFunction) {
    const now = Date.now();
    const cached = cache.get(key);

    if (cached && (now - cached.timestamp) < ttlSeconds * 1000) {
        return cached.value;
    }

    try {
        const value = await fetchFunction();
        cache.set(key, { value, timestamp: now });
        return value;
    } catch (e) {
        if (cached) return cached.value;
        throw e;
    }
}

async function initDB() {
    try {
        db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });

        // Create tables
        await db.exec(`
            CREATE TABLE IF NOT EXISTS tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userPubkey TEXT,
                mint TEXT UNIQUE,
                ticker TEXT,
                name TEXT,
                description TEXT,
                twitter TEXT,
                website TEXT,
                metadataUri TEXT,
                image TEXT,
                isMayhemMode INTEGER DEFAULT 0,
                signature TEXT,
                timestamp INTEGER,
                volume24h REAL DEFAULT 0,
                priceUsd REAL DEFAULT 0,
                marketCap REAL DEFAULT 0,
                holderCount INTEGER DEFAULT 0
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS token_holders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mint TEXT,
                holderPubkey TEXT,
                balance TEXT,
                rank INTEGER,
                updatedAt INTEGER,
                UNIQUE(mint, holderPubkey)
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS stats (
                key TEXT PRIMARY KEY,
                value REAL DEFAULT 0
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT,
                data TEXT,
                timestamp TEXT
            )
        `);

        // Initialize stats
        const statsKeys = [
            'accumulatedFeesLamports',
            'lifetimeFeesLamports',
            'totalPumpBoughtLamports',
            'totalPumpTokensBought',
            'lastClaimTimestamp',
            'lastClaimAmountLamports',
            'nextCheckTimestamp'
        ];

        for (const key of statsKeys) {
            await db.run(
                'INSERT OR IGNORE INTO stats (key, value) VALUES (?, 0)',
                [key]
            );
        }

        await db.exec(`
            CREATE TABLE IF NOT EXISTS flywheel_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER,
                status TEXT,
                feesCollected REAL,
                solSpent REAL,
                tokensBought TEXT,
                pumpBuySig TEXT,
                transfer9_5 REAL,
                transfer0_5 REAL,
                reason TEXT
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS airdrop_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                amount TEXT,
                recipients INTEGER,
                totalPoints REAL,
                signatures TEXT,
                details TEXT,
                timestamp TEXT
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS asdf_holders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                holderPubkey TEXT UNIQUE,
                balance TEXT,
                rank INTEGER,
                percentage REAL,
                updatedAt INTEGER
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                signature TEXT UNIQUE,
                userPubkey TEXT,
                type TEXT DEFAULT 'deployment',
                amount REAL,
                timestamp INTEGER
            )
        `);

        logger.info(`DB Initialized at ${DB_PATH}`);
    } catch (e) {
        logger.error('Database initialization failed', { error: e.message });
        throw e;
    }
}

// Stats helpers
async function addFees(amount) {
    if (!db) return;
    await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amount, 'accumulatedFeesLamports']);
    await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amount, 'lifetimeFeesLamports']);
}

async function addPumpBought(amount) {
    if (!db) return;
    await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amount, 'totalPumpBoughtLamports']);
}

async function getTotalLaunches() {
    if (!db) return 0;
    const res = await db.get('SELECT COUNT(*) as count FROM tokens');
    return res ? res.count : 0;
}

async function getStats() {
    if (!db) return {};
    const rows = await db.all('SELECT key, value FROM stats');
    return rows.reduce((acc, r) => ({ ...acc, [r.key]: r.value }), {});
}

async function resetAccumulatedFees(used) {
    if (!db) return;
    await db.run('UPDATE stats SET value = value - ? WHERE key = ?', [used, 'accumulatedFeesLamports']);
}

async function recordClaim(amount) {
    if (!db) return;
    await db.run('UPDATE stats SET value = ? WHERE key = ?', [Date.now(), 'lastClaimTimestamp']);
    await db.run('UPDATE stats SET value = ? WHERE key = ?', [amount, 'lastClaimAmountLamports']);
}

async function updateNextCheckTime() {
    if (!db) return;
    const nextCheck = Date.now() + (5 * 60 * 1000); // 5 minutes
    await db.run('UPDATE stats SET value = ? WHERE key = ?', [nextCheck, 'nextCheckTimestamp']);
    return nextCheck;
}

// Log to flywheel_logs table with structured columns
async function logFlywheelCycle(data) {
    if (!db) return;
    await db.run(`
        INSERT INTO flywheel_logs (timestamp, status, feesCollected, solSpent, tokensBought, pumpBuySig, transfer9_5, transfer0_5, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [Date.now(), data.status, data.feesCollected || 0, data.solSpent || 0, data.tokensBought || '0', data.pumpBuySig || null, data.transfer9_5 || 0, data.transfer0_5 || 0, data.reason || null]);
}

// Generic logging to logs table
async function logPurchase(type, data) {
    if (!db) return;
    try {
        await db.run(
            'INSERT INTO logs (type, data, timestamp) VALUES (?, ?, ?)',
            [type, JSON.stringify(data), new Date().toISOString()]
        );
    } catch (e) {
        logger.error("Log error", { error: e.message });
    }
}

async function saveTokenData(pubkey, mint, metadata) {
    if (!db) return;
    const fs = require('fs');
    const path = require('path');

    try {
        await db.run(`
            INSERT OR REPLACE INTO tokens (userPubkey, mint, ticker, name, description, twitter, website, metadataUri, image, isMayhemMode, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [pubkey, mint, metadata.ticker, metadata.name, metadata.description,
            metadata.twitter, metadata.website, metadata.metadataUri,
            metadata.image, metadata.isMayhemMode ? 1 : 0, Date.now()]);

        // Save to file system for backup
        const shard = pubkey.slice(0, 2).toLowerCase();
        const dir = path.join(DATA_DIR, shard);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, `${mint}.json`),
            JSON.stringify({ userPubkey: pubkey, mint, metadata, timestamp: new Date().toISOString() }, null, 2)
        );
    } catch (e) {
        logger.error("Save Token Error", { error: e.message });
    }
}

module.exports = {
    initDB,
    getDB: () => db,
    smartCache,
    addFees,
    addPumpBought,
    getTotalLaunches,
    getStats,
    resetAccumulatedFees,
    recordClaim,
    updateNextCheckTime,
    logFlywheelCycle,
    logPurchase,
    saveTokenData,
    DATA_DIR,
    DB_PATH,
};
