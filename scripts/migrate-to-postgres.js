/**
 * SQLite to PostgreSQL Migration Script
 * v13.0 - Migrates all data from SQLite to PostgreSQL
 *
 * Usage: npm run migrate
 *
 * Prerequisites:
 * 1. Set DATABASE_URL environment variable to your PostgreSQL connection string
 * 2. Ensure the SQLite database exists at the expected location
 * 3. Run: npm install (to ensure pg is installed)
 */
require('dotenv').config();

const { Pool } = require('pg');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

// Configuration
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'asdev.db');
const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 100;

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
}

// PostgreSQL pool
const pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

/**
 * Create PostgreSQL schema
 */
async function createPostgresSchema() {
    console.log('[Migration] Creating PostgreSQL schema...');

    // Tokens table
    await pgPool.query(`
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
            complete INTEGER DEFAULT 0
        )
    `);

    // Token holders table
    await pgPool.query(`
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

    // Stats table
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS stats (
            key TEXT PRIMARY KEY,
            value REAL DEFAULT 0
        )
    `);

    // Logs table
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS logs (
            id SERIAL PRIMARY KEY,
            type TEXT,
            data TEXT,
            timestamp TEXT
        )
    `);

    // Flywheel logs table
    await pgPool.query(`
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
    await pgPool.query(`
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

    // ASDF holders table
    await pgPool.query(`
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
    await pgPool.query(`
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
    await pgPool.query(`
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

    // Transactions table
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            signature TEXT UNIQUE,
            "userPubkey" TEXT,
            type TEXT DEFAULT 'deployment',
            amount REAL,
            timestamp BIGINT
        )
    `);

    // Create indexes
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_token_holders_mint ON token_holders(mint)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_token_holders_pubkey ON token_holders("holderPubkey")`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_robinhood_tokens_active ON robinhood_tokens("isActive")`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_robinhood_holders_mint ON robinhood_token_holders(mint)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_volume ON tokens(volume24h DESC)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_marketcap ON tokens("marketCap" DESC)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_timestamp ON tokens(timestamp DESC)`);

    console.log('[Migration] PostgreSQL schema created successfully');
}

/**
 * Migrate a table from SQLite to PostgreSQL
 */
async function migrateTable(sqliteDb, tableName, columnMap = null) {
    console.log(`[Migration] Migrating table: ${tableName}...`);

    try {
        // Check if table exists in SQLite
        const tableExists = await sqliteDb.get(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
            [tableName]
        );

        if (!tableExists) {
            console.log(`[Migration] Table ${tableName} does not exist in SQLite, skipping...`);
            return 0;
        }

        // Get all rows from SQLite
        const rows = await sqliteDb.all(`SELECT * FROM ${tableName}`);

        if (rows.length === 0) {
            console.log(`[Migration] Table ${tableName} is empty, skipping...`);
            return 0;
        }

        // Get column names
        const columns = Object.keys(rows[0]).filter(col => col !== 'id');

        // Build PostgreSQL column names (with quotes for camelCase)
        const pgColumns = columns.map(col => {
            // Check if column needs quoting (has uppercase letters)
            if (/[A-Z]/.test(col)) {
                return `"${col}"`;
            }
            return col;
        });

        // Process in batches
        let migratedCount = 0;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);

            for (const row of batch) {
                const values = columns.map(col => row[col]);
                const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');

                const query = `
                    INSERT INTO ${tableName} (${pgColumns.join(', ')})
                    VALUES (${placeholders})
                    ON CONFLICT DO NOTHING
                `;

                try {
                    await pgPool.query(query, values);
                    migratedCount++;
                } catch (err) {
                    console.error(`[Migration] Error inserting row into ${tableName}:`, err.message);
                }
            }

            console.log(`[Migration] ${tableName}: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} rows processed`);
        }

        console.log(`[Migration] Table ${tableName}: ${migratedCount} rows migrated successfully`);
        return migratedCount;
    } catch (err) {
        console.error(`[Migration] Error migrating table ${tableName}:`, err.message);
        return 0;
    }
}

/**
 * Main migration function
 */
async function migrate() {
    console.log('='.repeat(60));
    console.log('SQLite to PostgreSQL Migration');
    console.log('v13.0 - ASDev Database Migration');
    console.log('='.repeat(60));
    console.log('');

    // Check if SQLite database exists
    if (!fs.existsSync(SQLITE_PATH)) {
        console.log(`[Migration] SQLite database not found at: ${SQLITE_PATH}`);
        console.log('[Migration] Checking alternative locations...');

        // Try alternative paths
        const alternatives = [
            path.join(__dirname, '..', 'asdev.db'),
            '/var/data/asdev.db',
            './data/asdev.db',
            './asdev.db'
        ];

        let found = false;
        for (const altPath of alternatives) {
            if (fs.existsSync(altPath)) {
                console.log(`[Migration] Found SQLite database at: ${altPath}`);
                found = true;
                break;
            }
        }

        if (!found) {
            console.log('[Migration] No SQLite database found. Creating fresh PostgreSQL schema only.');
            await createPostgresSchema();

            // Initialize stats
            const statsKeys = [
                'accumulatedFeesLamports',
                'lifetimeFeesLamports',
                'totalPumpBoughtLamports',
                'totalPumpTokensBought',
                'lastClaimTimestamp',
                'lastClaimAmountLamports',
                'nextCheckTimestamp',
                'lifetimeCreatorFeesLamports',
                'lifetimeRobinhoodFeesLamports'
            ];

            for (const key of statsKeys) {
                await pgPool.query(
                    'INSERT INTO stats (key, value) VALUES ($1, 0) ON CONFLICT (key) DO NOTHING',
                    [key]
                );
            }

            console.log('[Migration] Initialized default stats');
            await pgPool.end();
            console.log('[Migration] Migration complete (fresh install)');
            return;
        }
    }

    // Open SQLite database
    console.log(`[Migration] Opening SQLite database: ${SQLITE_PATH}`);
    const sqliteDb = await open({
        filename: SQLITE_PATH,
        driver: sqlite3.Database
    });

    // Create PostgreSQL schema
    await createPostgresSchema();

    // Tables to migrate (in order due to potential dependencies)
    const tables = [
        'tokens',
        'token_holders',
        'stats',
        'logs',
        'flywheel_logs',
        'airdrop_logs',
        'asdf_holders',
        'robinhood_tokens',
        'robinhood_token_holders',
        'transactions'
    ];

    const results = {};
    for (const table of tables) {
        results[table] = await migrateTable(sqliteDb, table);
    }

    // Close connections
    await sqliteDb.close();
    await pgPool.end();

    // Print summary
    console.log('');
    console.log('='.repeat(60));
    console.log('Migration Summary');
    console.log('='.repeat(60));
    for (const [table, count] of Object.entries(results)) {
        console.log(`  ${table}: ${count} rows`);
    }
    console.log('='.repeat(60));
    console.log('');
    console.log('[Migration] Migration complete!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Verify data in PostgreSQL');
    console.log('2. Update .env with DATABASE_URL');
    console.log('3. Restart the application');
}

// Run migration
migrate().catch(err => {
    console.error('[Migration] Fatal error:', err);
    process.exit(1);
});
