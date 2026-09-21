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

// v25.47 STABILITY: LRU cache with max size to prevent memory leaks
const MAX_CACHE_SIZE = 1000;
const cache = new Map();

/**
 * v26.1: Evict oldest entries when cache is at capacity.
 * O(n) two-pass scan — no full sort needed.
 */
function evictOldestCacheEntries() {
    const EVICT_COUNT = Math.max(100, cache.size - MAX_CACHE_SIZE + 100);
    // First pass: find the timestamp threshold for the EVICT_COUNT oldest entries
    let oldest = Infinity;
    const timestamps = [];
    for (const entry of cache.values()) timestamps.push(entry.timestamp);
    timestamps.sort((a, b) => a - b); // Only sort the timestamps, not the entries
    const threshold = timestamps[EVICT_COUNT - 1] ?? Infinity;

    // Second pass: delete entries at or below the threshold
    let deleted = 0;
    for (const [key, entry] of cache.entries()) {
        if (deleted >= EVICT_COUNT) break;
        if (entry.timestamp <= threshold) {
            cache.delete(key);
            deleted++;
        }
    }
}

async function smartCache(key, ttlSeconds, fetchFunction) {
    const now = Date.now();
    const cached = cache.get(key);

    if (cached && (now - cached.timestamp) < ttlSeconds * 1000) {
        return cached.value;
    }

    try {
        const value = await fetchFunction();
        if (value !== undefined && value !== null) {
            // v26.1: Evict BEFORE inserting a new key to avoid exceeding limit
            if (cache.size >= MAX_CACHE_SIZE && !cache.has(key)) {
                evictOldestCacheEntries();
            }
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
            volume24h DOUBLE PRECISION DEFAULT 0,
            "priceUsd" DOUBLE PRECISION DEFAULT 0,
            "marketCap" DOUBLE PRECISION DEFAULT 0,
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
            value DOUBLE PRECISION DEFAULT 0
        )
    `);

    // v27.6 CORRECTNESS: stats.value was REAL (float4, 24-bit mantissa). Every key in this
    // table holds either a lamport amount or a millisecond timestamp, both of which exceed
    // float4's exact-integer range (16,777,216). A 5 SOL central pool quantises to 512-lamport
    // steps, so `value = value + <small amount>` silently dropped deposits below that step and
    // rounded larger ones up, inventing lamports the wallet never held. Millisecond timestamps
    // landed ~23 seconds off, which is why airdrop countdowns drifted.
    //
    // DOUBLE PRECISION (float8) has a 53-bit mantissa, so it represents every integer up to
    // 9,007,199,254,740,992 exactly -- i.e. every lamport value below ~9 million SOL and every
    // millisecond timestamp. It is also the widest type node-postgres still returns as a JS
    // number, so existing readers (Number(), parseInt(), and the raw pass-throughs in
    // getStats()) keep the type they have today. BIGINT or NUMERIC
    // would be returned as strings and would change those API payloads.
    //
    // Every other float4 column in this schema holds money, a USD figure, or points, and has
    // the same defect, so the migration below widens all of them in one pass. real -> float8
    // is a lossless widening and cannot corrupt an existing row. It cannot recover precision
    // already lost to float4 either -- values written before this migration keep the value
    // they were rounded to -- it only stops the loss from continuing.
    await pool.query(`
        DO $$
        DECLARE
            col RECORD;
        BEGIN
            FOR col IN
                SELECT table_name, column_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND data_type = 'real'
            LOOP
                EXECUTE format(
                    'ALTER TABLE %I ALTER COLUMN %I TYPE DOUBLE PRECISION',
                    col.table_name, col.column_name
                );
                RAISE NOTICE 'Widened %.% from real to double precision', col.table_name, col.column_name;
            END LOOP;
        END $$;
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
        'pendingAmmFeesLamports', // v25.23: Track pending AMM fees that can't be claimed yet
        // v28.0: the platform's 25% cut accrues here between on-chain sweeps, so the amount
        // owed to the buyback/burn and upkeep wallets is auditable rather than implicit in
        // the dev wallet's balance.
        'pendingBuybackBurnLamports',
        'pendingUpkeepLamports',
        'lifetimeBuybackBurnLamports',
        'lifetimeUpkeepLamports'
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
            "feesCollected" DOUBLE PRECISION,
            "solSpent" DOUBLE PRECISION,
            "tokensBought" TEXT,
            "pumpBuySig" TEXT,
            "transfer9_5" DOUBLE PRECISION,
            "transfer0_5" DOUBLE PRECISION,
            reason TEXT
        )
    `);

    // Airdrop logs table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS airdrop_logs (
            id SERIAL PRIMARY KEY,
            amount TEXT,
            recipients INTEGER,
            "totalPoints" DOUBLE PRECISION,
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
            amount DOUBLE PRECISION NOT NULL,
            points DOUBLE PRECISION DEFAULT 0,
            timestamp BIGINT NOT NULL
        )
    `);

    // Index for fast user lookups
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_airdrop_history_pubkey ON user_airdrop_history("userPubkey")`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_airdrop_history_timestamp ON user_airdrop_history(timestamp DESC)`);
    // H-5: Composite index speeds up rank queries that filter by pubkey and sort/sum by amount
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_airdrop_history_pubkey_amount ON user_airdrop_history("userPubkey", amount)`);

    // ASDF holders table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS asdf_holders (
            id SERIAL PRIMARY KEY,
            "holderPubkey" TEXT UNIQUE,
            balance TEXT,
            rank INTEGER,
            percentage DOUBLE PRECISION,
            "updatedAt" BIGINT
        )
    `);

    // v26.0: Migration - Per-token airdrop pools
    // pending_airdrop_lamports: fees credited to this token, pending distribution to holders
    // lifetime_airdrop_lamports: cumulative lamports ever airdropped from this token's pool
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tokens' AND column_name = 'pending_airdrop_lamports') THEN
                ALTER TABLE tokens ADD COLUMN pending_airdrop_lamports BIGINT DEFAULT 0;
            END IF;
        END $$;
    `);
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tokens' AND column_name = 'lifetime_airdrop_lamports') THEN
                ALTER TABLE tokens ADD COLUMN lifetime_airdrop_lamports BIGINT DEFAULT 0;
            END IF;
        END $$;
    `);
    // v26.0: Migration - Track mint in airdrop_logs and user_airdrop_history for per-token accountability
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'airdrop_logs' AND column_name = 'mint') THEN
                ALTER TABLE airdrop_logs ADD COLUMN mint TEXT;
            END IF;
        END $$;
    `);
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'airdrop_logs' AND column_name = 'token_source') THEN
                ALTER TABLE airdrop_logs ADD COLUMN token_source TEXT DEFAULT 'platform';
            END IF;
        END $$;
    `);
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_airdrop_history' AND column_name = 'mint') THEN
                ALTER TABLE user_airdrop_history ADD COLUMN mint TEXT;
            END IF;
        END $$;
    `);
    // v27.6 CRASH SAFETY: reservation ledger for in-flight airdrops.
    //
    // Distribution used to send every SOL batch first and decrement pending_airdrop_lamports
    // only afterwards, so a crash, restart or deploy between the last send and that UPDATE
    // replayed the entire pool on the next run -- paying every holder twice. Each distribution
    // now reserves its planned amount out of the pool *before* sending, in the same transaction
    // that opens a row here, and settles the row when the sends finish.
    //
    // The failure mode is deliberately asymmetric: a crash mid-send leaves the pool short by
    // the unsent remainder, which the next fee inflow restores, rather than paying twice, which
    // is unrecoverable. Rows left in 'sending' are surfaced at startup for manual reconciliation
    // because nothing off-chain can tell whether an unconfirmed batch landed.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS airdrop_reservations (
            id SERIAL PRIMARY KEY,
            airdrop_id TEXT UNIQUE NOT NULL,
            -- Nullable: central-pool distributions span every eligible token, so they have
            -- no single mint. token_source is 'central_pool' for those rows.
            mint TEXT,
            token_source TEXT NOT NULL,
            planned_lamports BIGINT NOT NULL,
            sent_lamports BIGINT DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'sending',
            created_at BIGINT,
            updated_at BIGINT
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_airdrop_reservations_status ON airdrop_reservations(status) WHERE status = 'sending'`);
    // Drop the NOT NULL if an earlier build of this table created it with one -- CREATE TABLE
    // IF NOT EXISTS will not revise an existing definition, and central-pool rows need NULL.
    await pool.query(`ALTER TABLE airdrop_reservations ALTER COLUMN mint DROP NOT NULL`);

    // Surface reservations that never settled. Nothing off-chain can decide whether their
    // last batch landed, so these are reported rather than auto-refunded -- auto-refunding an
    // airdrop that did land would recreate the double-pay this table exists to prevent.
    try {
        const stranded = await pool.query(
            `SELECT airdrop_id, mint, token_source, planned_lamports, sent_lamports, created_at
             FROM airdrop_reservations WHERE status = 'sending' ORDER BY created_at DESC LIMIT 20`
        );
        if (stranded.rows.length > 0) {
            logger.warn(
                `[DB] ${stranded.rows.length} airdrop reservation(s) left in flight by a previous run — reconcile against chain before trusting pool balances`,
                {
                    reservations: stranded.rows.map(r => ({
                        airdropId: r.airdrop_id,
                        mint: r.mint,
                        source: r.token_source,
                        plannedSol: Number(r.planned_lamports) / 1e9,
                        sentSol: Number(r.sent_lamports) / 1e9,
                        startedAt: r.created_at ? new Date(Number(r.created_at)).toISOString() : null
                    }))
                }
            );
        }
    } catch (e) {
        logger.debug('[DB] Could not check for stranded airdrop reservations', { error: e.message });
    }

    // v28.1: Pre-ground vanity mint keypairs whose addresses end in the configured suffix.
    //
    // The seed is stored encrypted: until the token is actually created, whoever holds this
    // seed can create the mint themselves, so a database leak would let someone front-run a
    // launch. After creation the keypair is spent and the row is only of historical interest.
    //
    // status: 'available' -> 'claimed' (handed to an in-flight launch) -> 'used' (minted).
    // A launch that fails before broadcasting releases its row back to 'available'.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS vanity_mints (
            id SERIAL PRIMARY KEY,
            mint_address TEXT UNIQUE NOT NULL,
            encrypted_seed TEXT NOT NULL,
            suffix TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'available',
            created_at BIGINT,
            claimed_at BIGINT,
            used_at BIGINT
        )
    `);
    // Partial index: claims only ever scan the available rows, and this keeps that lookup
    // O(1)-ish as used rows accumulate.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vanity_mints_available ON vanity_mints(id) WHERE status = 'available'`);

    // Indexes for per-token pool queries
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_pending_airdrop ON tokens(pending_airdrop_lamports DESC) WHERE pending_airdrop_lamports > 0`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_airdrop_logs_mint ON airdrop_logs(mint)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_airdrop_history_mint ON user_airdrop_history(mint)`);

    // v27.0: Central pool — accumulates 50% of all token creator rewards for cross-token distribution
    await pool.query(`
        INSERT INTO stats (key, value) VALUES ('centralPoolLamports', 0) ON CONFLICT (key) DO NOTHING;
    `);
    await pool.query(`
        INSERT INTO stats (key, value) VALUES ('lifetimeCentralPoolLamports', 0) ON CONFLICT (key) DO NOTHING;
    `);

    // v25.24: Migration - Fix null balance values that cause BigInt conversion errors
    // Set default for balance column and fix any existing null values
    await pool.query(`
        UPDATE token_holders SET balance = '0' WHERE balance IS NULL;
    `);
    await pool.query(`
        ALTER TABLE token_holders ALTER COLUMN balance SET DEFAULT '0';
    `);

    // Transactions table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            signature TEXT UNIQUE,
            "userPubkey" TEXT,
            type TEXT DEFAULT 'deployment',
            amount DOUBLE PRECISION,
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_volume_eligible ON tokens(volume24h DESC) WHERE volume24h >= 100`);
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

    // v25.22: Index for faster mint lookups in GROUP BY queries
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_holders_mint_only ON token_holders(mint)`);

    // v25.33: User points table - single source of truth for all point displays
    // Worker calculates points once, all endpoints read from this table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_points (
            pubkey TEXT PRIMARY KEY,
            base_points DOUBLE PRECISION DEFAULT 0,
            multiplier INTEGER DEFAULT 1,
            total_points DOUBLE PRECISION DEFAULT 0,
            expected_airdrop_sol DOUBLE PRECISION DEFAULT 0,
            positions_count INTEGER DEFAULT 0,
            is_asdf_holder BOOLEAN DEFAULT FALSE,
            updated_at BIGINT
        )
    `);

    // Indexes for fast lookups and sorting
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_points_total ON user_points(total_points DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_points_updated ON user_points(updated_at DESC)`);
    // v26.1: ASDF holder filter index for fast airdrop queries
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_points_asdf ON user_points(is_asdf_holder) WHERE is_asdf_holder = TRUE`);

    // v27.0: Track central pool expected airdrop separately per user for frontend breakdown
    // v27.4 BUGFIX: This migration must run AFTER user_points is created above — it previously
    // ran before the CREATE TABLE, so on a brand-new database (table doesn't exist yet) the
    // ALTER TABLE would fail with "relation \"user_points\" does not exist" and crash server
    // startup entirely (initDB() rethrows, main()/startWorker() has no catch, process.exit(1)).
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_points' AND column_name = 'central_pool_expected_sol') THEN
                ALTER TABLE user_points ADD COLUMN central_pool_expected_sol DOUBLE PRECISION DEFAULT 0;
            END IF;
        END $$;
    `);

    // v26.1: Missing performance indexes
    // Composite (mint, timestamp) for per-token airdrop history queries
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_airdrop_logs_mint_ts ON airdrop_logs(mint, timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_airdrop_history_mint_ts ON user_airdrop_history(mint, timestamp DESC)`);
    // Token mint lookup (userPubkey already indexed; add mint→timestamp for recent launches)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_mint ON tokens(mint)`);

    // ===========================================
    // Announcements Table    // ===========================================
    // Announcements Table
    // ===========================================

    // Admin announcements - displayed to all frontend users
    await pool.query(`
        CREATE TABLE IF NOT EXISTS announcements (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            type TEXT DEFAULT 'info',
            "isActive" INTEGER DEFAULT 1,
            "expiresAt" BIGINT,
            "createdAt" BIGINT NOT NULL,
            "createdBy" TEXT
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements("isActive") WHERE "isActive" = 1`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements("createdAt" DESC)`);

    logger.info('[PostgreSQL] Schema created successfully');
}

/**
 * v25.22 SCALABILITY: Refresh the materialized view
 * Should be called after holder scanner updates
 */
async function refreshMaterializedViews() {
    if (!pool) return;
    try {
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY token_total_balances');
        logger.debug('[PostgreSQL] Materialized view refreshed');
    } catch (e) {
        // CONCURRENTLY requires unique index - fall back to regular refresh
        try {
            await pool.query('REFRESH MATERIALIZED VIEW token_total_balances');
            logger.debug('[PostgreSQL] Materialized view refreshed (non-concurrent)');
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
        },

        // H-7 FIX: Run a function inside a single DB transaction (BEGIN/COMMIT/ROLLBACK).
        // Usage: await db.transaction(async (tx) => { await tx.run(...); await tx.run(...); })
        async transaction(fn) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const tx = {
                    async run(sql, params = []) {
                        const pgSql = convertSqliteToPostgres(sql);
                        const result = await client.query(pgSql, params);
                        return { changes: result.rowCount, lastID: result.rows?.[0]?.id };
                    },
                    async get(sql, params = []) {
                        const pgSql = convertSqliteToPostgres(sql);
                        const result = await client.query(pgSql, params);
                        return result.rows[0] || null;
                    },
                    async all(sql, params = []) {
                        const pgSql = convertSqliteToPostgres(sql);
                        const result = await client.query(pgSql, params);
                        return result.rows;
                    }
                };
                const result = await fn(tx);
                await client.query('COMMIT');
                return result;
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
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

    // Handle INSERT OR REPLACE - convert to upsert
    // Extracts table name and column list to build ON CONFLICT DO UPDATE
    // H-6 FIX: Find the LAST closing paren of the VALUES clause(s) to handle multi-row inserts
    const insertOrReplaceMatch = pgSql.match(/INSERT OR REPLACE INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (insertOrReplaceMatch) {
        const tableName = insertOrReplaceMatch[1];
        const columns = insertOrReplaceMatch[2].split(',').map(c => c.trim());
        // Use first UNIQUE column as conflict target (mint for tokens)
        const conflictCol = columns.includes('mint') ? 'mint' : columns[0];
        const updateCols = columns.filter(c => c !== conflictCol)
            .map(c => `${c} = EXCLUDED.${c}`).join(', ');
        pgSql = pgSql.replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO');
        // Append ON CONFLICT after the entire VALUES block (handles single and multi-row)
        const valuesEnd = pgSql.lastIndexOf(')');
        if (valuesEnd !== -1) {
            pgSql = pgSql.substring(0, valuesEnd + 1) + ` ON CONFLICT (${conflictCol}) DO UPDATE SET ${updateCols}` + pgSql.substring(valuesEnd + 1);
        }
    }

    // Handle INSERT OR IGNORE
    pgSql = pgSql.replace(/INSERT OR IGNORE INTO (\w+)/gi, 'INSERT INTO $1');
    if (sql.includes('INSERT OR IGNORE')) {
        // H-6 FIX: Append ON CONFLICT after the entire VALUES block
        const valuesEnd = pgSql.lastIndexOf(')');
        if (valuesEnd !== -1) {
            pgSql = pgSql.substring(0, valuesEnd + 1) + ' ON CONFLICT DO NOTHING' + pgSql.substring(valuesEnd + 1);
        }
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
