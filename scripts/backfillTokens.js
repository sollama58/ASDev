#!/usr/bin/env node
/**
 * Token Backfill Script (v2.1 - Helius DAS)
 *
 * Efficiently discovers tokens where we receive fees:
 * 1. Tokens created by our dev wallet (via Helius DAS API)
 * 2. Fee-sharing partnerships (via on-chain memcmp filters - efficient)
 *
 * Uses Helius getAssetsByCreator for creator token discovery.
 * Requires HELIUS_API_KEY environment variable.
 *
 * Usage: node scripts/backfillTokens.js [--dry-run]
 */
require('dotenv').config();

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');

const config = require('../src/config/env');
const { PROGRAMS } = require('../src/config/constants');
const database = require('../src/services/postgres');

// Parse command line args
const DRY_RUN = process.argv.includes('--dry-run');

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
 * Scan for fee-sharing configs (Robinhood tokens)
 * Uses efficient getProgramAccounts with memcmp filters
 * Total RPC calls: ~10 (2 positions x 5 sizes)
 */
async function scanForRobinhoodTokens(connection, devKeypair) {
    console.log('\n📡 Scanning for fee-sharing partnerships (Robinhood tokens)...');
    console.log('   Using efficient memcmp filters (minimal RPC calls)');

    const foundTokens = [];
    const seenMints = new Set(); // Dedupe across positions
    const sizes = [110, 144, 178, 212, 246]; // Different shareholder counts (1-5 shareholders)

    // Build all queries upfront for parallel execution
    const queries = [];
    for (const dataSize of sizes) {
        // Check first shareholder position (offset 76)
        queries.push({ dataSize, offset: 76 });
        // Check second shareholder position (offset 110)
        queries.push({ dataSize, offset: 110 });
    }

    console.log(`   Running ${queries.length} filtered queries...`);

    // Execute queries with controlled concurrency
    for (const { dataSize, offset } of queries) {
        try {
            const accounts = await connection.getProgramAccounts(PROGRAMS.PUMP, {
                filters: [
                    { dataSize },
                    { memcmp: { offset, bytes: devKeypair.publicKey.toBase58() } }
                ]
            }).catch(() => []);

            for (const account of accounts) {
                try {
                    const data = account.account.data;
                    if (data.length < 76) continue;

                    // Parse the config
                    const creator = new PublicKey(data.slice(8, 40));
                    const mint = new PublicKey(data.slice(40, 72));
                    const mintStr = mint.toString();

                    // Skip if we've already seen this mint
                    if (seenMints.has(mintStr)) continue;
                    seenMints.add(mintStr);

                    const shareholderCount = data.readUInt32LE(72);
                    if (shareholderCount < 1 || shareholderCount > 10) continue;

                    // Find our share
                    let ourShareBps = 0;
                    let parseOffset = 76;
                    for (let i = 0; i < shareholderCount && parseOffset + 34 <= data.length; i++) {
                        const pubkey = new PublicKey(data.slice(parseOffset, parseOffset + 32));
                        const shareBps = data.readUInt16LE(parseOffset + 32);
                        if (pubkey.equals(devKeypair.publicKey)) {
                            ourShareBps = shareBps;
                            break;
                        }
                        parseOffset += 34;
                    }

                    if (ourShareBps > 0) {
                        foundTokens.push({
                            mint: mintStr,
                            creator: creator.toString(),
                            shareBps: ourShareBps,
                            sharePercent: ourShareBps / 100,
                            type: 'robinhood'
                        });
                        console.log(`   Found: ${mintStr.slice(0, 8)}... (${ourShareBps / 100}% share)`);
                    }
                } catch (e) {
                    // Skip invalid accounts
                }
            }
        } catch (e) {
            console.log(`   ⚠️  Error scanning size ${dataSize} offset ${offset}: ${e.message}`);
        }
    }

    console.log(`   Total: ${foundTokens.length} Robinhood partnerships found`);
    return foundTokens;
}

/**
 * Insert tokens into the database
 */
async function backfillTokens(db, tokens, devPubkey) {
    console.log('\n💾 Backfilling tokens into database...');

    let insertedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const token of tokens) {
        try {
            const mintStr = token.mint.toString ? token.mint.toString() : token.mint;

            // Check if already exists
            const existing = await db.get('SELECT id FROM tokens WHERE mint = $1', [mintStr]);

            if (existing) {
                console.log(`   ⏭️  Skipping ${mintStr.slice(0, 8)}... (already exists)`);
                skippedCount++;
                continue;
            }

            // Fetch metadata
            console.log(`   📥 Fetching metadata for ${mintStr.slice(0, 8)}...`);
            const pumpMeta = await fetchPumpMetadata(mintStr);
            const dexMeta = await fetchDexScreenerMetadata(mintStr);

            const metadata = {
                name: pumpMeta?.name || dexMeta?.name || 'Unknown Token',
                ticker: pumpMeta?.ticker || dexMeta?.ticker || 'UNKNOWN',
                description: pumpMeta?.description || '',
                image: pumpMeta?.image || dexMeta?.image || '',
                metadataUri: pumpMeta?.metadataUri || '',
                twitter: pumpMeta?.twitter || '',
                website: pumpMeta?.website || '',
                marketCap: dexMeta?.marketCap || pumpMeta?.marketCap || 0,
                volume24h: dexMeta?.volume24h || 0,
                priceUsd: dexMeta?.priceUsd || 0,
                complete: pumpMeta?.complete ? 1 : 0
            };

            if (DRY_RUN) {
                console.log(`   [DRY RUN] Would insert: ${metadata.ticker} (${mintStr.slice(0, 8)}...)`);
                insertedCount++;
                continue;
            }

            // Insert into database
            await db.run(`
                INSERT INTO tokens ("userPubkey", mint, ticker, name, description, twitter, website, "metadataUri", image, "isMayhemMode", timestamp, volume24h, "priceUsd", "marketCap", complete)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                ON CONFLICT (mint) DO UPDATE SET
                    ticker = EXCLUDED.ticker,
                    name = EXCLUDED.name,
                    description = EXCLUDED.description,
                    image = COALESCE(EXCLUDED.image, tokens.image),
                    volume24h = EXCLUDED.volume24h,
                    "priceUsd" = EXCLUDED."priceUsd",
                    "marketCap" = EXCLUDED."marketCap",
                    complete = EXCLUDED.complete
            `, [
                devPubkey, // userPubkey - dev wallet is the creator
                mintStr,
                metadata.ticker,
                metadata.name,
                metadata.description,
                metadata.twitter,
                metadata.website,
                metadata.metadataUri,
                metadata.image,
                0, // isMayhemMode - default false for backfilled tokens
                Date.now(),
                metadata.volume24h,
                metadata.priceUsd,
                metadata.marketCap,
                metadata.complete
            ]);

            console.log(`   ✅ Inserted: ${metadata.ticker} (${mintStr.slice(0, 8)}...)`);
            insertedCount++;

            // Rate limit
            await new Promise(r => setTimeout(r, 500));

        } catch (e) {
            console.log(`   ❌ Error: ${e.message}`);
            errorCount++;
        }
    }

    return { insertedCount, skippedCount, errorCount };
}

/**
 * Insert Robinhood tokens into the database
 */
async function backfillRobinhoodTokens(db, tokens) {
    console.log('\n💾 Backfilling Robinhood tokens into database...');

    let insertedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const token of tokens) {
        try {
            // Check if already exists
            const existing = await db.get('SELECT id FROM robinhood_tokens WHERE mint = $1', [token.mint]);

            if (existing) {
                console.log(`   ⏭️  Skipping ${token.mint.slice(0, 8)}... (already exists)`);
                skippedCount++;
                continue;
            }

            // Fetch metadata
            console.log(`   📥 Fetching metadata for ${token.mint.slice(0, 8)}...`);
            const pumpMeta = await fetchPumpMetadata(token.mint);
            const dexMeta = await fetchDexScreenerMetadata(token.mint);

            const metadata = {
                name: pumpMeta?.name || dexMeta?.name || 'Unknown Token',
                ticker: pumpMeta?.ticker || dexMeta?.ticker || 'UNKNOWN',
                image: pumpMeta?.image || dexMeta?.image || null,
                marketCap: dexMeta?.marketCap || pumpMeta?.marketCap || 0,
                volume24h: dexMeta?.volume24h || 0
            };

            if (DRY_RUN) {
                console.log(`   [DRY RUN] Would insert Robinhood: ${metadata.ticker} (${token.mint.slice(0, 8)}...) - ${token.sharePercent}% share`);
                insertedCount++;
                continue;
            }

            // Insert into database
            await db.run(`
                INSERT INTO robinhood_tokens (mint, ticker, name, image, "creatorPubkey", "feeShareBps", "discoveredAt", "marketCap", volume24h, "isActive")
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
                ON CONFLICT (mint) DO UPDATE SET
                    ticker = EXCLUDED.ticker,
                    name = EXCLUDED.name,
                    image = COALESCE(EXCLUDED.image, robinhood_tokens.image),
                    "feeShareBps" = EXCLUDED."feeShareBps",
                    "marketCap" = EXCLUDED."marketCap",
                    volume24h = EXCLUDED.volume24h
            `, [
                token.mint,
                metadata.ticker,
                metadata.name,
                metadata.image,
                token.creator,
                token.shareBps,
                Date.now(),
                metadata.marketCap,
                metadata.volume24h
            ]);

            console.log(`   ✅ Inserted Robinhood: ${metadata.ticker} (${token.mint.slice(0, 8)}...) - ${token.sharePercent}% share`);
            insertedCount++;

            // Rate limit
            await new Promise(r => setTimeout(r, 500));

        } catch (e) {
            console.log(`   ❌ Error: ${e.message}`);
            errorCount++;
        }
    }

    return { insertedCount, skippedCount, errorCount };
}

/**
 * Scan Helius DAS API for all tokens by creator
 */
async function scanHeliusForCreatorTokens(devPubkey) {
    console.log('\n📡 Querying Helius DAS API for tokens by creator...');

    if (!config.HELIUS_API_KEY) {
        console.log('   ⚠️  HELIUS_API_KEY not configured - skipping creator token scan');
        return [];
    }

    const foundTokens = [];
    let page = 1;
    const limit = 1000;

    try {
        while (true) {
            const response = await axios.post(
                `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                {
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'getAssetsByCreator',
                    params: {
                        creatorAddress: devPubkey,
                        page: page,
                        limit: limit
                    }
                },
                { timeout: 15000 }
            );

            const result = response.data?.result;
            if (!result || !result.items || result.items.length === 0) {
                break;
            }

            for (const asset of result.items) {
                // Only include fungible tokens (not NFTs)
                if (asset.interface === 'FungibleToken' || asset.interface === 'FungibleAsset') {
                    const metadata = asset.content?.metadata || {};
                    const files = asset.content?.files || [];
                    const imageFile = files.find(f => f.mime?.startsWith('image/')) || files[0];

                    foundTokens.push({
                        mint: asset.id,
                        name: metadata.name || 'Unknown',
                        ticker: metadata.symbol || 'UNKNOWN',
                        description: metadata.description || '',
                        image: imageFile?.cdn_uri || imageFile?.uri || asset.content?.links?.image || null,
                        metadataUri: asset.content?.json_uri || null,
                        twitter: asset.content?.links?.twitter || '',
                        website: asset.content?.links?.external_url || '',
                        marketCap: 0, // Will be fetched from DexScreener
                        complete: false,
                        discoveredFrom: 'helius_api'
                    });
                    console.log(`   Found: ${metadata.symbol || 'UNKNOWN'} (${asset.id.slice(0, 8)}...)`);
                }
            }

            // Check if there are more pages
            if (result.items.length < limit) {
                break;
            }
            page++;
            await new Promise(r => setTimeout(r, 300)); // Rate limit protection
        }

        console.log(`   Found ${foundTokens.length} fungible tokens from Helius API`);

    } catch (e) {
        console.log(`   ⚠️  Helius API error: ${e.message}`);
    }

    return foundTokens;
}

/**
 * Main function
 */
async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                     TOKEN BACKFILL SCRIPT                      ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes will be made)' : '⚡ LIVE (will insert tokens)'}`);
    console.log('');

    // Initialize connection
    const connection = new Connection(config.RPC_URL, 'confirmed');
    const devKeypair = Keypair.fromSecretKey(bs58.decode(config.DEV_WALLET_PRIVATE_KEY));

    console.log(`🔗 RPC: ${config.RPC_URL.includes('devnet') ? 'Devnet' : 'Mainnet'}`);
    console.log(`👛 Dev Wallet: ${devKeypair.publicKey.toString()}`);

    // Initialize database
    await database.initDB();
    const db = database.getDB();
    console.log('✅ Database connected');

    // Get current counts
    const tokenCount = await db.get('SELECT COUNT(*) as count FROM tokens');
    const robinhoodCount = await db.get('SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1');
    console.log(`\n📊 Current database state:`);
    console.log(`   - Tokens: ${tokenCount?.count || 0}`);
    console.log(`   - Robinhood tokens: ${robinhoodCount?.count || 0}`);

    // Collect all tokens to backfill
    const allTokens = [];
    const allRobinhoodTokens = [];

    // 1. Scan Helius DAS API for tokens created by us
    const apiTokens = await scanHeliusForCreatorTokens(devKeypair.publicKey.toString());
    allTokens.push(...apiTokens);

    // 2. Scan for Robinhood fee-sharing partnerships (uses memcmp filters - efficient)
    const robinhoodTokens = await scanForRobinhoodTokens(connection, devKeypair);
    allRobinhoodTokens.push(...robinhoodTokens);

    // Summary before insertion
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                         SUMMARY                                ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   Tokens to process: ${allTokens.length}`);
    console.log(`   Robinhood tokens to process: ${allRobinhoodTokens.length}`);

    if (allTokens.length === 0 && allRobinhoodTokens.length === 0) {
        console.log('\n   ℹ️  No new tokens found to backfill');
        await db.close();
        process.exit(0);
    }

    // Backfill tokens
    if (allTokens.length > 0) {
        const result = await backfillTokens(db, allTokens, devKeypair.publicKey.toString());
        console.log(`\n   Tokens: ${result.insertedCount} inserted, ${result.skippedCount} skipped, ${result.errorCount} errors`);
    }

    // Backfill Robinhood tokens
    if (allRobinhoodTokens.length > 0) {
        const result = await backfillRobinhoodTokens(db, allRobinhoodTokens);
        console.log(`   Robinhood: ${result.insertedCount} inserted, ${result.skippedCount} skipped, ${result.errorCount} errors`);
    }

    // Final counts
    const finalTokenCount = await db.get('SELECT COUNT(*) as count FROM tokens');
    const finalRobinhoodCount = await db.get('SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1');
    console.log(`\n📊 Final database state:`);
    console.log(`   - Tokens: ${finalTokenCount?.count || 0}`);
    console.log(`   - Robinhood tokens: ${finalRobinhoodCount?.count || 0}`);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                       BACKFILL COMPLETE                        ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n📊 RPC Efficiency:');
    console.log('   - Helius DAS API: paginated calls (tokens we created)');
    console.log('   - Robinhood scan: ~10 calls (memcmp filtered)');

    await db.close();
    process.exit(0);
}

// Run
main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
