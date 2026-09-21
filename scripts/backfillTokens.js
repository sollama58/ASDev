#!/usr/bin/env node
/**
 * Token Backfill Script (v4.0 - Unified Vault Transaction Analysis)
 *
 * Efficiently discovers tokens where we receive fees by analyzing
 * transactions to BOTH creator fee vaults:
 * 1. Bonding Curve vault - fees from pre-graduation trades
 * 2. AMM vault - fees from post-graduation pool trades
 *
 * Features:
 * - Scans both BC and AMM vaults for complete coverage
 * - Uses shared mintExtractor module for consistency with main app
 * - Tracks progress via database (survives restarts)
 * - Deduplicates transactions across vaults
 * - Batched mint validation for efficiency
 *
 *
 * Requires HELIUS_API_KEY environment variable.
 *
 * Usage: node scripts/backfillTokens.js [--dry-run] [--reset] [--wipe] [--update]
 *   --dry-run  Preview changes without modifying the database
 *   --reset    Force full rescan (ignore saved progress)
 *   --wipe     Clear all existing tokens before backfilling (DESTRUCTIVE)
 *   --update   Update existing tokens with fresh metadata and market data
 */
require('dotenv').config();

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');

const config = require('../src/config/env');
const { PROGRAMS } = require('../src/config/constants');
const database = require('../src/services/postgres');
const pump = require('../src/services/pump');
const mintExtractor = require('../src/services/mintExtractor');

// Parse command line args
const DRY_RUN = process.argv.includes('--dry-run');
const RESET_PROGRESS = process.argv.includes('--reset');
const WIPE_TOKENS = process.argv.includes('--wipe');
const UPDATE_EXISTING = process.argv.includes('--update');

/**
 * Fetch token metadata from Helius DAS API
 */
async function fetchHeliusMetadata(mint) {
    if (!config.HELIUS_API_KEY) {
        return null;
    }
    try {
        const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
            {
                jsonrpc: '2.0',
                id: '1',
                method: 'getAsset',
                params: { id: mint }
            },
            { timeout: 5000 }
        );
        const asset = response.data?.result;
        if (asset) {
            const metadata = asset.content?.metadata || {};
            const files = asset.content?.files || [];
            const imageFile = files.find(f => f.mime?.startsWith('image/')) || files[0];
            return {
                name: metadata.name || 'Unknown',
                ticker: metadata.symbol || 'UNKNOWN',
                description: metadata.description || '',
                image: imageFile?.cdn_uri || imageFile?.uri || asset.content?.links?.image || null,
                metadataUri: asset.content?.json_uri || null,
                twitter: asset.content?.links?.twitter || null,
                website: asset.content?.links?.external_url || null,
                marketCap: 0, // Helius doesn't provide market cap, will be fetched from DexScreener
                creator: asset.creators?.[0]?.address || null,
                complete: false
            };
        }
    } catch (e) {
        // Silent fail - will try DexScreener
    }
    return null;
}

/**
 * Fetch token metadata from DexScreener
 */
async function fetchDexScreenerMetadata(mint) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
            timeout: 5000
        });
        const pairs = response.data?.pairs || [];
        if (pairs.length > 0) {
            const pair = pairs[0];
            return {
                name: pair.baseToken?.name || 'Unknown',
                ticker: pair.baseToken?.symbol || 'UNKNOWN',
                image: pair.info?.imageUrl || null,
                marketCap: pair.fdv || pair.marketCap || 0,
                volume24h: pair.volume?.h24 || 0,
                priceUsd: parseFloat(pair.priceUsd) || 0
            };
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}


/**
 * Insert or update tokens in the database
 */
async function backfillTokens(db, tokens, devPubkey) {
    console.log('\n💾 Backfilling tokens into database...');

    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const token of tokens) {
        try {
            const mintStr = token.mint.toString ? token.mint.toString() : token.mint;

            // Check if already exists
            const existing = await db.get('SELECT id, "marketCap", volume24h, ticker, name, image FROM tokens WHERE mint = $1', [mintStr]);

            if (existing && !UPDATE_EXISTING) {
                console.log(`   ⏭️  Skipping ${mintStr.slice(0, 8)}... (already exists, use --update to refresh)`);
                skippedCount++;
                continue;
            }

            // Fetch metadata
            console.log(`   📥 Fetching metadata for ${mintStr.slice(0, 8)}...`);
            const heliusMeta = await fetchHeliusMetadata(mintStr);
            const dexMeta = await fetchDexScreenerMetadata(mintStr);

            // Prioritize DexScreener for market data, Helius for metadata
            const metadata = {
                name: heliusMeta?.name || dexMeta?.name || 'Unknown Token',
                ticker: heliusMeta?.ticker || dexMeta?.ticker || 'UNKNOWN',
                description: heliusMeta?.description || '',
                image: heliusMeta?.image || dexMeta?.image || '',
                metadataUri: heliusMeta?.metadataUri || '',
                twitter: heliusMeta?.twitter || '',
                website: heliusMeta?.website || '',
                marketCap: dexMeta?.marketCap || heliusMeta?.marketCap || 0,
                volume24h: dexMeta?.volume24h || 0,
                priceUsd: dexMeta?.priceUsd || 0,
                complete: heliusMeta?.complete ? 1 : 0
            };

            if (DRY_RUN) {
                if (existing) {
                    console.log(`   [DRY RUN] Would update: ${metadata.ticker} (${mintStr.slice(0, 8)}...) MC: $${metadata.marketCap.toLocaleString()}`);
                    updatedCount++;
                } else {
                    console.log(`   [DRY RUN] Would insert: ${metadata.ticker} (${mintStr.slice(0, 8)}...)`);
                    insertedCount++;
                }
                continue;
            }

            if (existing) {
                // Update existing token
                await db.run(`
                    UPDATE tokens SET
                        ticker = COALESCE(NULLIF($1, 'UNKNOWN'), ticker),
                        name = COALESCE(NULLIF($2, 'Unknown Token'), name),
                        description = COALESCE(NULLIF($3, ''), description),
                        twitter = COALESCE(NULLIF($4, ''), twitter),
                        website = COALESCE(NULLIF($5, ''), website),
                        "metadataUri" = COALESCE(NULLIF($6, ''), "metadataUri"),
                        image = COALESCE(NULLIF($7, ''), image),
                        volume24h = CASE WHEN $8 > 0 THEN $8 ELSE volume24h END,
                        "priceUsd" = CASE WHEN $9 > 0 THEN $9 ELSE "priceUsd" END,
                        "marketCap" = CASE WHEN $10 > 0 THEN $10 ELSE "marketCap" END
                    WHERE mint = $11
                `, [
                    metadata.ticker,
                    metadata.name,
                    metadata.description,
                    metadata.twitter,
                    metadata.website,
                    metadata.metadataUri,
                    metadata.image,
                    metadata.volume24h,
                    metadata.priceUsd,
                    metadata.marketCap,
                    mintStr
                ]);

                console.log(`   🔄 Updated: ${metadata.ticker} (${mintStr.slice(0, 8)}...) MC: $${metadata.marketCap.toLocaleString()}`);
                updatedCount++;
            } else {
                // Insert new token
                await db.run(`
                    INSERT INTO tokens ("userPubkey", mint, ticker, name, description, twitter, website, "metadataUri", image, "isMayhemMode", timestamp, volume24h, "priceUsd", "marketCap", complete)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                `, [
                    devPubkey,
                    mintStr,
                    metadata.ticker,
                    metadata.name,
                    metadata.description,
                    metadata.twitter,
                    metadata.website,
                    metadata.metadataUri,
                    metadata.image,
                    0,
                    Date.now(),
                    metadata.volume24h,
                    metadata.priceUsd,
                    metadata.marketCap,
                    metadata.complete
                ]);

                console.log(`   ✅ Inserted: ${metadata.ticker} (${mintStr.slice(0, 8)}...)`);
                insertedCount++;
            }

            // Rate limit
            await new Promise(r => setTimeout(r, 500));

        } catch (e) {
            console.log(`   ❌ Error: ${e.message}`);
            errorCount++;
        }
    }

    return { insertedCount, updatedCount, skippedCount, errorCount };
}

/**
 * Discover tokens by analyzing transactions to BOTH creator fee vaults.
 * Uses the shared mintExtractor module for consistency with the main application.
 *
 * This finds all tokens where we earn creator fees from:
 * 1. Bonding curve trades (bcVault) - before token graduates
 * 2. AMM/Pool trades (ammVault) - after token graduates to Raydium
 *
 * @param {Object} db - Database instance
 * @param {string} devPubkey - Developer wallet public key
 * @param {Object} connection - Solana connection for on-chain verification
 * @returns {Array} - Array of validated token objects
 */
async function scanVaultTransactionsForTokens(db, devPubkey, connection) {
    console.log('\n📡 Scanning creator fee vaults for token discovery...');
    console.log('   (Using shared mintExtractor - scans both BC and AMM vaults)');

    if (!config.HELIUS_API_KEY) {
        console.log('   ⚠️  HELIUS_API_KEY not configured - skipping vault scan');
        return [];
    }

    // Use the shared mintExtractor module
    // Force reset progress if wipe was requested (we need to rescan everything)
    const { foundMints, bcStats, ammStats } = await mintExtractor.scanCreatorVaultsForMints({
        creatorPubkey: new PublicKey(devPubkey),
        db,
        getCreatorFeeVaults: pump.getCreatorFeeVaults,
        saveProgress: !DRY_RUN,
        resetProgress: RESET_PROGRESS || WIPE_TOKENS,
    });

    // Summary
    const totalTx = bcStats.txProcessed + ammStats.txProcessed;
    console.log(`\n   Total: ${totalTx} transactions processed, ${foundMints.size} unique mints found`);
    console.log(`   - BC: ${bcStats.txProcessed} txs, ${bcStats.mintsFound} mints`);
    console.log(`   - AMM: ${ammStats.txProcessed} txs, ${ammStats.mintsFound} mints`);

    if (foundMints.size === 0) {
        console.log('   No new mints to validate');
        return [];
    }

    // VALIDATION: Verify we are actually a fee recipient for each discovered mint
    // This double-checks on-chain data to prevent false positives
    console.log('\n   🔍 Verifying fee recipient status on-chain...');
    const verifiedMints = await mintExtractor.filterMintsWeAreRecipientFor(
        Array.from(foundMints),
        devPubkey,
        connection
    );
    console.log(`   ✓ Verified ${verifiedMints.length}/${foundMints.size} mints as fee recipients`);

    if (verifiedMints.length === 0) {
        console.log('   No mints verified as fee recipients');
        return [];
    }

    // Validate verified mints using the shared module
    console.log('\n   Validating verified mints...');
    const validTokens = await mintExtractor.validateMintsBatch(verifiedMints.map(v => v.mint));

    // Add additional fields expected by the backfill script
    const enrichedTokens = validTokens.map(token => ({
        ...token,
        marketCap: 0,
        complete: false,
        discoveredFrom: 'vault_scan'
    }));

    console.log(`   ✓ Validated ${enrichedTokens.length} tokens from ${foundMints.size} discovered mints`);
    return enrichedTokens;
}

/**
 * Wipe all tokens from the database
 */
async function wipeTokens(db) {
    console.log('\n🗑️  Wiping all tokens from database...');

    // Clear tokens table
    const tokenResult = await db.run('DELETE FROM tokens');
    console.log(`   Deleted ${tokenResult.changes || 0} tokens`);

    // Clear vault scan progress logs so we do a full rescan
    // Progress is stored in the 'logs' table with type like 'vault_scan_%'
    const progressResult = await db.run("DELETE FROM logs WHERE type LIKE $1", ['vault_scan_%']);
    console.log(`   Cleared ${progressResult.changes || 0} vault scan progress entries`);

    console.log('   ✅ Wipe complete');
}

/**
 * Verify database schema is properly set up
 */
async function verifyDatabaseSchema(db) {
    console.log('\n🔍 Verifying database schema...');

    // 'logs' is the correct table name (not 'system_log')
    const requiredTables = ['tokens', 'logs'];
    const missingTables = [];

    for (const table of requiredTables) {
        try {
            // Simple check: try to select from table (will fail if table doesn't exist)
            await db.get(`SELECT 1 FROM ${table} LIMIT 1`);
        } catch (e) {
            missingTables.push(table);
        }
    }

    if (missingTables.length > 0) {
        console.log(`   ⚠️  Missing tables: ${missingTables.join(', ')}`);
        console.log('   Database initialization should have created these.');
        return false;
    }

    console.log('   ✅ All required tables exist');
    return true;
}

/**
 * Main function
 */
async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                     TOKEN BACKFILL SCRIPT                      ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes will be made)' : '⚡ LIVE (will insert tokens)'}`);
    if (RESET_PROGRESS) {
        console.log('🔄 RESET MODE: Will perform full vault scan (ignoring saved progress)');
    }
    if (WIPE_TOKENS) {
        console.log('🗑️  WIPE MODE: Will delete all existing tokens before backfilling');
    }
    if (UPDATE_EXISTING) {
        console.log('🔄 UPDATE MODE: Will refresh metadata and prices for existing tokens');
    }
    console.log('');

    // Initialize connection
    const connection = new Connection(config.RPC_URL, 'confirmed');
    const devKeypair = config.devKeypair;

    console.log(`🔗 RPC: ${config.RPC_URL.includes('devnet') ? 'Devnet' : 'Mainnet'}`);
    console.log(`👛 Dev Wallet: ${devKeypair.publicKey.toString()}`);

    // Initialize database (this creates tables if they don't exist)
    console.log('\n📦 Initializing database...');
    await database.initDB();
    const db = database.getDB();
    console.log('✅ Database connected');

    // Verify schema is properly set up
    await verifyDatabaseSchema(db);

    // Wipe tokens if requested
    if (WIPE_TOKENS && !DRY_RUN) {
        await wipeTokens(db);
    } else if (WIPE_TOKENS && DRY_RUN) {
        console.log('\n🗑️  [DRY RUN] Would wipe all tokens from database');
    }

    // Get current counts
    const tokenCount = await db.get('SELECT COUNT(*) as count FROM tokens');
    console.log(`\n📊 Current database state:`);
    console.log(`   - Tokens: ${tokenCount?.count || 0}`);

    // Collect all tokens to backfill
    const allTokens = [];
    const existingMints = new Set();

    // 1. Scan vault transactions for tokens we earn fees on
    const vaultTokens = await scanVaultTransactionsForTokens(db, devKeypair.publicKey.toString(), connection);
    for (const token of vaultTokens) {
        allTokens.push(token);
        existingMints.add(token.mint);
    }

    // 2. If UPDATE mode is enabled, also include ALL existing tokens from the database
    // This ensures we refresh metadata for tokens we already have
    if (UPDATE_EXISTING) {
        console.log('\n📥 Fetching all existing tokens for update...');
        const existingTokens = await db.all('SELECT mint FROM tokens');
        for (const row of existingTokens) {
            if (!existingMints.has(row.mint)) {
                allTokens.push({ mint: row.mint });
                existingMints.add(row.mint);
            }
        }
        console.log(`   Found ${existingTokens.length} existing tokens to update`);
    }

    // Summary before insertion
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                         SUMMARY                                ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   Tokens to process: ${allTokens.length}`);

    if (allTokens.length === 0) {
        console.log('\n   ℹ️  No new tokens found to backfill');
        await db.close();
        process.exit(0);
    }

    // Backfill tokens
    if (allTokens.length > 0) {
        const result = await backfillTokens(db, allTokens, devKeypair.publicKey.toString());
        console.log(`\n   Tokens: ${result.insertedCount} inserted, ${result.updatedCount} updated, ${result.skippedCount} skipped, ${result.errorCount} errors`);
    }

    // Final counts
    const finalTokenCount = await db.get('SELECT COUNT(*) as count FROM tokens');
    console.log(`\n📊 Final database state:`);
    console.log(`   - Tokens: ${finalTokenCount?.count || 0}`);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                       BACKFILL COMPLETE                        ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n📊 Discovery Method:');
    console.log('   - Vault transaction analysis: finds tokens by fee deposits');
    console.log('   - Progress tracked: incremental scans on restart');

    await db.close();
    process.exit(0);
}

// Run
main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
