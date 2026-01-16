/**
 * PostgreSQL Database Service
 * v13.0 - Production-ready PostgreSQL with connection pooling
 * v24.0 - Improved SSL configuration with certificate validation options
 *
 * Replaces SQLite for:
 * - Better concurrent write handling
 * - Connection pooling for scalability
 * - Horizontal scaling support
 * - Render.com managed database compatibility
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const logger = require('./logger');
const imageUtils = require('./imageUtils');

// Connection pool instance
let pool = null;

// Smart cache (same as before, for backwards compatibility)
const cache = new Map();

async function smartCache(key, ttlSeconds, fetchFunction) {
    const now = Date.now();
    const cached = cache.get(key);

    if (cached && (now - cached.timestamp) < ttlSeconds * 1000) {
        return cached.value;
    }

    try {
        const value = await fetchFunction();
        if (value !== undefined && value !== null) {
            cache.set(key, { value, timestamp: now });
        }
        return value;
    } catch (e) {
        if (cached) return cached.value;
        throw e;
    }
}

/**
 * v24.0: Build SSL configuration based on environment
 * v25.22 SECURITY: Default to certificate verification in production when CA cert available
 * Supports: disabled, require (no verify), verify-ca, verify-full
 */
function buildSslConfig() {
    // In development, disable SSL unless explicitly enabled
    if (config.NODE_ENV !== 'production') {
        return config.DB_SSL_ENABLED ? { rejectUnauthorized: false } : false;
    }

    // v25.22: In production, default to verify-full if CA cert is available, otherwise require
    let sslMode = config.DB_SSL_MODE || 'require';

    // v25.22 SECURITY: Auto-upgrade to verify-full if CA certificate is available
    if (sslMode === 'require' && (config.DB_SSL_CA || config.DB_SSL_CA_PATH)) {
        logger.info('[PostgreSQL] CA certificate available - upgrading to verify-full mode');
        sslMode = 'verify-full';
    }

    switch (sslMode) {
        case 'disable':
            logger.warn('[PostgreSQL] SSL disabled - NOT RECOMMENDED for production');
            return false;

        case 'require':
            // SSL required but no certificate verification (common for managed DBs like Render)
            // v25.22: Log warning about MITM vulnerability
            logger.warn('[PostgreSQL] SSL mode: require (no cert verification) - vulnerable to MITM attacks. Set DB_SSL_CA or DB_SSL_CA_PATH for full security.');
            return { rejectUnauthorized: false };

        case 'verify-ca':
        case 'verify-full':
            // Full certificate verification
            const sslConfig = { rejectUnauthorized: true };

            // Load CA certificate if provided
            if (config.DB_SSL_CA_PATH) {
                try {
                    sslConfig.ca = fs.readFileSync(path.resolve(config.DB_SSL_CA_PATH), 'utf8');
                    logger.info('[PostgreSQL] SSL mode: verify-full (CA cert loaded from file)');
                } catch (e) {
                    logger.error('[PostgreSQL] Failed to load CA certificate', { error: e.message });
                    throw new Error('SSL CA certificate required but could not be loaded');
                }
            } else if (config.DB_SSL_CA) {
                // CA certificate provided as environment variable
                sslConfig.ca = config.DB_SSL_CA;
                logger.info('[PostgreSQL] SSL mode: verify-full (CA cert from env)');
            } else {
                // v25.22: In production verify mode without CA, use system CA store
                logger.info('[PostgreSQL] SSL mode: verify-full (using system CA store)');
            }

            return sslConfig;

        default:
            logger.warn('[PostgreSQL] SSL mode: require (default) - vulnerable to MITM attacks');
            return { rejectUnauthorized: false };
    }
}

/**
 * Initialize PostgreSQL connection pool and create schema
 */
async function initDB() {
    if (!config.DATABASE_URL) {
        throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
    }

    try {
        // v24.0: Build SSL config with better security options
        const sslConfig = buildSslConfig();

        // Create connection pool
        pool = new Pool({
            connectionString: config.DATABASE_URL,
            min: config.DB_POOL_MIN,
            max: config.DB_POOL_MAX,
            idleTimeoutMillis: config.DB_IDLE_TIMEOUT,
            connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT,
            ssl: sslConfig
        });

        // Test connection
        const client = await pool.connect();
        logger.info('[PostgreSQL] Connection established');
        client.release();

        // Create schema
        await createSchema();

        logger.info(`[PostgreSQL] Database initialized (Pool: ${config.DB_POOL_MIN}-${config.DB_POOL_MAX} connections)`);
    } catch (e) {
        logger.error('[PostgreSQL] Initialization failed', { error: e.message });
        throw e;
    }
}

/**
 * Create database schema (PostgreSQL syntax)
 */
async function createSchema() {
    // Tokens table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tokens (
            id SERIAL PRIMARY KEY,
            "userPubkey" TEXT,
            mint TEXT UNIQUE,
            ticker TEXT,
            name TEXT,
            description TEXT,
            twitter TEXT,
            website TEXT,
            "metadataUri" TEXT,
            image TEXT,
            "isMayhemMode" INTEGER DEFAULT 0,
            signature TEXT,
            timestamp BIGINT,
            volume24h REAL DEFAULT 0,
            "priceUsd" REAL DEFAULT 0,
            "marketCap" REAL DEFAULT 0,
            "holderCount" INTEGER DEFAULT 0,
            "tweetUrl" TEXT,
            complete INTEGER DEFAULT 0,
            "lastUpdated" BIGINT
        )
    `);

    // Migration: Add lastUpdated column if it doesn't exist (for existing databases)
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tokens' AND column_name = 'lastUpdated') THEN
                ALTER TABLE tokens ADD COLUMN "lastUpdated" BIGINT;
            END IF;
        END $$;
    `);

    // Token holders table with index
    await pool.query(`
        CREATE TABLE IF NOT EXISTS token_holders (
            id SERIAL PRIMARY KEY,
            mint TEXT,
            "holderPubkey" TEXT,
            balance TEXT,
            rank INTEGER,
            "updatedAt" BIGINT,
            "lastUpdated" BIGINT,
            UNIQUE(mint, "holderPubkey")
        )
    `);

    // Create indexes for token_holders
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_holders_mint ON token_holders(mint)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_holders_pubkey ON token_holders("holderPubkey")`);

    // Stats table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS stats (
            key TEXT PRIMARY KEY,
            value REAL DEFAULT 0
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
        'nextCheckTimestamp',
        'nextAirdropTimestamp', // v25.7: Track next airdrop time for frontend countdown
        'lifetimeCreatorFeesLamports',
        'lifetimeRobinhoodFeesLamports',
        'pendingAmmFeesLamports' // v25.23: Track pending AMM fees that can't be claimed yet
    ];

    for (const key of statsKeys) {
        await pool.query(
            'INSERT INTO stats (key, value) VALUES ($1, 0) ON CONFLICT (key) DO NOTHING',
            [key]
        );
    }

    // Logs table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS logs (
            id SERIAL PRIMARY KEY,
            type TEXT,
            data TEXT,
            timestamp TEXT
        )
    `);

    // Flywheel logs table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS flywheel_logs (
            id SERIAL PRIMARY KEY,
            timestamp BIGINT,
            status TEXT,
            "feesCollected" REAL,
            "solSpent" REAL,
            "tokensBought" TEXT,
            "pumpBuySig" TEXT,
            "transfer9_5" REAL,
            "transfer0_5" REAL,
            reason TEXT
        )
    `);

    // Airdrop logs table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS airdrop_logs (
            id SERIAL PRIMARY KEY,
            amount TEXT,
            recipients INTEGER,
            "totalPoints" REAL,
            signatures TEXT,
            details TEXT,
            timestamp TEXT
        )
    `);

    // v25.18: User airdrop history table for tracking individual user distributions
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_airdrop_history (
            id SERIAL PRIMARY KEY,
            "userPubkey" TEXT NOT NULL,
            "airdropId" TEXT,
            amount REAL NOT NULL,
            points REAL DEFAULT 0,
            timestamp BIGINT NOT NULL
        )
    `);

    // Index for fast user lookups
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_airdrop_history_pubkey ON user_airdrop_history("userPubkey")`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_airdrop_history_timestamp ON user_airdrop_history(timestamp DESC)`);

    // ASDF holders table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS asdf_holders (
            id SERIAL PRIMARY KEY,
            "holderPubkey" TEXT UNIQUE,
            balance TEXT,
            rank INTEGER,
            percentage REAL,
            "updatedAt" BIGINT
        )
    `);

    // Robinhood tokens table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS robinhood_tokens (
            id SERIAL PRIMARY KEY,
            mint TEXT UNIQUE,
            ticker TEXT,
            name TEXT,
            image TEXT,
            "creatorPubkey" TEXT,
            "feeShareBps" INTEGER DEFAULT 0,
            "isGraduated" INTEGER DEFAULT 0,
            "discoveredAt" BIGINT,
            "lastFeesClaimed" BIGINT,
            "totalFeesCollected" REAL DEFAULT 0,
            volume24h REAL DEFAULT 0,
            "marketCap" REAL DEFAULT 0,
            "isActive" INTEGER DEFAULT 1
        )
    `);

    // Robinhood token holders table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS robinhood_token_holders (
            id SERIAL PRIMARY KEY,
            mint TEXT,
            "holderPubkey" TEXT,
            balance TEXT,
            rank INTEGER,
            "updatedAt" BIGINT,
            UNIQUE(mint, "holderPubkey")
        )
    `);

    // v25.23: Migration - Add pendingAmmFees column for AMM fee monitoring
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'robinhood_tokens' AND column_name = 'pendingAmmFees') THEN
                ALTER TABLE robinhood_tokens ADD COLUMN "pendingAmmFees" REAL DEFAULT 0;
            END IF;
        END $$;
    `);

    // v25.24: Migration - Fix null balance values that cause BigInt conversion errors
    // Set default for balance column and fix any existing null values
    await pool.query(`
        UPDATE token_holders SET balance = '0' WHERE balance IS NULL;
    `);
    await pool.query(`
        UPDATE robinhood_token_holders SET balance = '0' WHERE balance IS NULL;
    `);
    await pool.query(`
        ALTER TABLE token_holders ALTER COLUMN balance SET DEFAULT '0';
    `);
    await pool.query(`
        ALTER TABLE robinhood_token_holders ALTER COLUMN balance SET DEFAULT '0';
    `);

    // Create indexes for robinhood tables
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_robinhood_tokens_active ON robinhood_tokens("isActive")`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_robinhood_holders_mint ON robinhood_token_holders(mint)`);

    // Transactions table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            signature TEXT UNIQUE,
            "userPubkey" TEXT,
            type TEXT DEFAULT 'deployment',
            amount REAL,
            timestamp BIGINT
        )
    `);

    // Create additional performance indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_volume ON tokens(volume24h DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_marketcap ON tokens("marketCap" DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_timestamp ON tokens(timestamp DESC)`);

    // v22.0: SCALABILITY FIX - Add composite indexes for optimized JOIN queries
    // These indexes dramatically improve /check-holder, /user-holdings, and /all-eligible-users endpoints
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_holders_pubkey_mint ON token_holders("holderPubkey", mint)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_robinhood_holders_pubkey_mint ON robinhood_token_holders("holderPubkey", mint)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_volume_eligible ON tokens(volume24h DESC) WHERE volume24h >= 100`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_robinhood_tokens_volume_active ON robinhood_tokens(volume24h DESC) WHERE "isActive" = 1`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens("userPubkey")`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_flywheel_logs_timestamp ON flywheel_logs(timestamp DESC)`);

    // v25.22 SCALABILITY: Materialized views for pre-computed aggregations
    // This eliminates expensive GROUP BY subqueries in /check-holder and /all-eligible-users
    await pool.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS token_total_balances AS
        SELECT mint, SUM(CAST(balance AS BIGINT)) as total_balance, COUNT(*) as holder_count
        FROM token_holders
        GROUP BY mint
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_token_total_balances_mint ON token_total_balances(mint)`);

    await pool.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS robinhood_token_total_balances AS
        SELECT mint, SUM(CAST(balance AS BIGINT)) as total_balance, COUNT(*) as holder_count
        FROM robinhood_token_holders
        GROUP BY mint
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_robinhood_total_balances_mint ON robinhood_token_total_balances(mint)`);

    // v25.22: Index for faster mint lookups in GROUP BY queries
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_holders_mint_only ON token_holders(mint)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_robinhood_holders_mint_only ON robinhood_token_holders(mint)`);

    // v25.33: User points table - single source of truth for all point displays
    // Worker calculates points once, all endpoints read from this table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_points (
            pubkey TEXT PRIMARY KEY,
            base_points REAL DEFAULT 0,
            robinhood_points REAL DEFAULT 0,
            multiplier INTEGER DEFAULT 1,
            total_points REAL DEFAULT 0,
            expected_airdrop_sol REAL DEFAULT 0,
            positions_count INTEGER DEFAULT 0,
            is_asdf_holder BOOLEAN DEFAULT FALSE,
            updated_at BIGINT
        )
    `);

    // Indexes for fast lookups and sorting
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_points_total ON user_points(total_points DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_points_updated ON user_points(updated_at DESC)`);

    // ===========================================
    // PAGS (Pay-to-Twitter/X) Tables
    // ===========================================

    // PAGS beneficiaries - Token-to-Twitter username mapping
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pags_beneficiaries (
            id SERIAL PRIMARY KEY,
            mint TEXT NOT NULL UNIQUE,
            "creatorPubkey" TEXT NOT NULL,
            "twitterUsername" TEXT NOT NULL,
            "feeShareBps" INTEGER NOT NULL DEFAULT 10000,
            "totalFeesAccumulated" REAL DEFAULT 0,
            "totalFeesClaimed" REAL DEFAULT 0,
            "isActive" INTEGER DEFAULT 1,
            "createdAt" BIGINT NOT NULL,
            "lastFeeUpdate" BIGINT
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pags_beneficiaries_twitter ON pags_beneficiaries("twitterUsername")`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pags_beneficiaries_active ON pags_beneficiaries("isActive") WHERE "isActive" = 1`);

    // PAGS Twitter users - Verified Twitter users who can claim rewards
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pags_twitter_users (
            id SERIAL PRIMARY KEY,
            "twitterId" TEXT UNIQUE NOT NULL,
            "twitterUsername" TEXT NOT NULL,
            "displayName" TEXT,
            "profileImageUrl" TEXT,
            "linkedWallet" TEXT,
            "walletLinkedAt" BIGINT,
            "accessToken" TEXT,
            "refreshToken" TEXT,
            "tokenExpiresAt" BIGINT,
            "lastVerified" BIGINT,
            "createdAt" BIGINT NOT NULL,
            "isActive" INTEGER DEFAULT 1
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pags_users_username ON pags_twitter_users("twitterUsername")`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pags_users_wallet ON pags_twitter_users("linkedWallet")`);

    // PAGS claims - Claim history and pending claims
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pags_claims (
            id SERIAL PRIMARY KEY,
            "twitterId" TEXT NOT NULL,
            "twitterUsername" TEXT NOT NULL,
            "recipientWallet" TEXT NOT NULL,
            amount REAL NOT NULL,
            signature TEXT UNIQUE,
            status TEXT DEFAULT 'pending',
            "createdAt" BIGINT NOT NULL,
            "completedAt" BIGINT,
            "failReason" TEXT
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pags_claims_twitter ON pags_claims("twitterId")`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pags_claims_status ON pags_claims(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pags_claims_created ON pags_claims("createdAt" DESC)`);

    // PAGS fee logs - Fee collection history per beneficiary
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pags_fee_logs (
            id SERIAL PRIMARY KEY,
            "beneficiaryId" INTEGER REFERENCES pags_beneficiaries(id),
            amount REAL NOT NULL,
            source TEXT,
            "txSignature" TEXT,
            "collectedAt" BIGINT NOT NULL
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pags_fee_logs_beneficiary ON pags_fee_logs("beneficiaryId")`);

    logger.info('[PostgreSQL] Schema created successfully');
}

/**
 * v25.22 SCALABILITY: Refresh materialized views
 * Should be called after holder scanner updates
 */
async function refreshMaterializedViews() {
    if (!pool) return;
    try {
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY token_total_balances');
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY robinhood_token_total_balances');
        logger.debug('[PostgreSQL] Materialized views refreshed');
    } catch (e) {
        // CONCURRENTLY requires unique index - fall back to regular refresh
        try {
            await pool.query('REFRESH MATERIALIZED VIEW token_total_balances');
            await pool.query('REFRESH MATERIALIZED VIEW robinhood_token_total_balances');
            logger.debug('[PostgreSQL] Materialized views refreshed (non-concurrent)');
        } catch (err) {
            logger.debug('[PostgreSQL] Materialized view refresh error', { error: err.message });
        }
    }
}

// ===========================================
// SQLite-compatible query wrappers
// ===========================================

/**
 * Get database instance (returns pool for compatibility)
 */
function getDB() {
    return {
        // Single row query
        async get(sql, params = []) {
            const pgSql = convertSqliteToPostgres(sql);
            const result = await pool.query(pgSql, params);
            return result.rows[0] || null;
        },

        // Multiple rows query
        async all(sql, params = []) {
            const pgSql = convertSqliteToPostgres(sql);
            const result = await pool.query(pgSql, params);
            return result.rows;
        },

        // Execute statement (INSERT, UPDATE, DELETE)
        async run(sql, params = []) {
            const pgSql = convertSqliteToPostgres(sql);
            const result = await pool.query(pgSql, params);
            return {
                changes: result.rowCount,
                lastID: result.rows?.[0]?.id
            };
        },

        // Execute raw SQL (for schema changes)
        async exec(sql) {
            await pool.query(sql);
        },

        // Close connection
        async close() {
            if (pool) {
                await pool.end();
                pool = null;
            }
        }
    };
}

/**
 * Convert SQLite-style SQL to PostgreSQL
 * Handles common differences:
 * - ? placeholders to $1, $2, etc.
 * - INTEGER PRIMARY KEY AUTOINCREMENT to SERIAL PRIMARY KEY
 * - INSERT OR REPLACE to INSERT ... ON CONFLICT
 * - INSERT OR IGNORE to INSERT ... ON CONFLICT DO NOTHING
 */
function convertSqliteToPostgres(sql) {
    let pgSql = sql;
    let paramIndex = 1;

    // Replace ? with $1, $2, etc.
    pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);

    // Handle INSERT OR REPLACE (basic conversion)
    pgSql = pgSql.replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO');

    // Handle INSERT OR IGNORE
    pgSql = pgSql.replace(/INSERT OR IGNORE INTO (\w+)/gi, 'INSERT INTO $1');
    if (sql.includes('INSERT OR IGNORE')) {
        pgSql = pgSql.replace(/VALUES\s*\([^)]+\)/gi, match => match + ' ON CONFLICT DO NOTHING');
    }

    return pgSql;
}

// ===========================================
// Stats helpers (same API as SQLite version)
// ===========================================

async function addFees(amount) {
    const db = getDB();
    await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [amount, 'accumulatedFeesLamports']);
    await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [amount, 'lifetimeFeesLamports']);
}

async function addPumpBought(amount) {
    const db = getDB();
    await db.run('UPDATE stats SET value = value + $1 WHERE key = $2', [amount, 'totalPumpBoughtLamports']);
}

async function getTotalLaunches() {
    const db = getDB();
    const res = await db.get('SELECT COUNT(*) as count FROM tokens');
    return res ? res.count : 0;
}

async function getStats() {
    const db = getDB();
    const rows = await db.all('SELECT key, value FROM stats');
    return rows.reduce((acc, r) => ({ ...acc, [r.key]: r.value }), {});
}

async function resetAccumulatedFees(used) {
    const db = getDB();
    await db.run('UPDATE stats SET value = value - $1 WHERE key = $2', [used, 'accumulatedFeesLamports']);
}

async function recordClaim(amount) {
    const db = getDB();
    await db.run('UPDATE stats SET value = $1 WHERE key = $2', [Date.now(), 'lastClaimTimestamp']);
    await db.run('UPDATE stats SET value = $1 WHERE key = $2', [amount, 'lastClaimAmountLamports']);
}

async function updateNextCheckTime() {
    const db = getDB();
    // v25.4: Updated to 1 minute to match FEE_COLLECTION_INTERVAL
    const nextCheck = Date.now() + (1 * 60 * 1000);
    await db.run('UPDATE stats SET value = $1 WHERE key = $2', [nextCheck, 'nextCheckTimestamp']);
    return nextCheck;
}

// ===========================================
// Logging helpers
// ===========================================

async function logFlywheelCycle(data) {
    const db = getDB();
    await db.run(`
        INSERT INTO flywheel_logs (timestamp, status, "feesCollected", "solSpent", "tokensBought", "pumpBuySig", "transfer9_5", "transfer0_5", reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [Date.now(), data.status, data.feesCollected || 0, data.solSpent || 0, data.tokensBought || '0', data.pumpBuySig || null, data.transfer9_5 || 0, data.transfer0_5 || 0, data.reason || null]);
}

async function logPurchase(type, data) {
    const db = getDB();
    try {
        await db.run(
            'INSERT INTO logs (type, data, timestamp) VALUES ($1, $2, $3)',
            [type, JSON.stringify(data), new Date().toISOString()]
        );
    } catch (e) {
        logger.error("[PostgreSQL] Log error", { error: e.message });
    }
}

async function saveTokenData(pubkey, mint, metadata) {
    const db = getDB();

    // Validate required fields
    if (!mint) {
        logger.error("[PostgreSQL] Save Token Error: mint address is required");
        throw new Error("mint address is required");
    }
    if (!metadata || !metadata.ticker || !metadata.name) {
        logger.error("[PostgreSQL] Save Token Error: metadata.ticker and metadata.name are required", { mint, metadata });
        throw new Error("metadata.ticker and metadata.name are required");
    }

    // v25.15: Normalize image URL before saving (handles Imgur, IPFS, etc.)
    const rawImage = metadata.image || '';
    const imageValue = rawImage ? (imageUtils.normalizeImageUrl(rawImage) || rawImage) : '';

    logger.info("[PostgreSQL] saveTokenData image debug", {
        mint: mint.substring(0, 12),
        ticker: metadata.ticker,
        imageProvided: !!metadata.image,
        rawImage: rawImage ? rawImage.substring(0, 80) : 'EMPTY_STRING',
        normalizedImage: imageValue ? imageValue.substring(0, 80) : 'EMPTY_STRING',
        wasNormalized: rawImage !== imageValue
    });

    try {
        const result = await db.run(`
            INSERT INTO tokens ("userPubkey", mint, ticker, name, description, twitter, website, "metadataUri", image, "isMayhemMode", timestamp)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (mint) DO UPDATE SET
                ticker = EXCLUDED.ticker,
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                twitter = EXCLUDED.twitter,
                website = EXCLUDED.website,
                "metadataUri" = EXCLUDED."metadataUri",
                image = EXCLUDED.image,
                "isMayhemMode" = EXCLUDED."isMayhemMode"
        `, [pubkey, mint, metadata.ticker, metadata.name, metadata.description || '',
            metadata.twitter || '', metadata.website || '', metadata.metadataUri || '',
            imageValue, metadata.isMayhemMode ? 1 : 0, Date.now()]);

        logger.info("[PostgreSQL] Token saved successfully", { mint, ticker: metadata.ticker, hasImage: !!imageValue, changes: result.changes });
        return result;
    } catch (e) {
        logger.error("[PostgreSQL] Save Token Error", { error: e.message, mint, ticker: metadata?.ticker });
        throw e; // Re-throw so caller knows the save failed
    }
}

// ===========================================
// Health check
// ===========================================

async function healthCheck() {
    try {
        const result = await pool.query('SELECT 1');
        return { status: 'online', latency: 0 };
    } catch (e) {
        return { status: 'offline', error: e.message };
    }
}

module.exports = {
    initDB,
    getDB,
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
    healthCheck,
    refreshMaterializedViews, // v25.22 SCALABILITY
    // For backwards compatibility
    DATA_DIR: config.DISK_ROOT || './data',
    DB_PATH: 'PostgreSQL (Render)',
};
