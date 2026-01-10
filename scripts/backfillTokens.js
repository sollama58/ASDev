#!/usr/bin/env node
/**
 * Token Backfill Script (v3.0 - Vault Transaction Analysis)
 *
 * Efficiently discovers tokens where we receive fees by analyzing
 * transactions to our creator fee vault. This method:
 * 1. Analyzes all transactions to our creator vault to find token mints
 * 2. Tracks progress via last processed signature (survives restarts)
 * 3. Only processes each transaction once
 *
 * Also scans for fee-sharing partnerships (Robinhood tokens) via memcmp filters.
 *
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
const pump = require('../src/services/pump');

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
            const heliusMeta = await fetchHeliusMetadata(mintStr);
            const dexMeta = await fetchDexScreenerMetadata(mintStr);

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
            const heliusMeta = await fetchHeliusMetadata(token.mint);
            const dexMeta = await fetchDexScreenerMetadata(token.mint);

            const metadata = {
                name: heliusMeta?.name || dexMeta?.name || 'Unknown Token',
                ticker: heliusMeta?.ticker || dexMeta?.ticker || 'UNKNOWN',
                image: heliusMeta?.image || dexMeta?.image || null,
                marketCap: dexMeta?.marketCap || heliusMeta?.marketCap || 0,
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
 * Stats key for tracking scan progress
 */
const VAULT_SCAN_PROGRESS_KEY = 'vaultScanLastSignature';

/**
 * Get the last processed signature from the database
 */
async function getLastProcessedSignature(db) {
    const row = await db.get('SELECT value FROM stats WHERE key = $1', [VAULT_SCAN_PROGRESS_KEY]);
    // value is stored as TEXT in our case, but stats table uses REAL - we'll store signature as text in a comment field
    // Actually, let's use a different approach - check if we have a text-based storage
    return null; // Start fresh for now, we'll implement proper persistence below
}

/**
 * Save the last processed signature to the database
 */
async function saveLastProcessedSignature(db, signature) {
    await db.run(
        'INSERT INTO stats (key, value) VALUES ($1, 0) ON CONFLICT (key) DO UPDATE SET value = 0',
        [VAULT_SCAN_PROGRESS_KEY]
    );
    // Store signature in logs table for persistence (stats.value is REAL, can't store strings)
    await db.run(
        `INSERT INTO logs (type, data, timestamp) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        ['vault_scan_progress', signature, new Date().toISOString()]
    );
}

/**
 * Get last saved signature from logs
 */
async function getLastSignatureFromLogs(db) {
    const row = await db.get(
        'SELECT data FROM logs WHERE type = $1 ORDER BY id DESC LIMIT 1',
        ['vault_scan_progress']
    );
    return row?.data || null;
}

/**
 * Known program IDs to skip when looking for mints
 */
const KNOWN_PROGRAMS = new Set([
    '11111111111111111111111111111111', // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
    'ComputeBudget111111111111111111111111111111', // Compute Budget
    'SysvarRent111111111111111111111111111111111', // Rent Sysvar
    'SysvarC1ock11111111111111111111111111111111', // Clock Sysvar
    PROGRAMS.PUMP.toString(),
    PROGRAMS.PUMP_AMM.toString(),
    PROGRAMS.FEE.toString(),
    PROGRAMS.METADATA.toString(),
]);

/**
 * Extract mint address from a Pump.fun buy/sell transaction.
 *
 * In Pump buy/sell instructions, the account layout is:
 * - Index 0: global
 * - Index 1: fee_recipient
 * - Index 2: mint  <-- THIS IS WHAT WE WANT
 * - Index 3: bonding_curve
 * - Index 4: associated_bonding_curve
 * - ...
 *
 * We identify Pump instructions by:
 * 1. The program ID is the Pump program
 * 2. The instruction has the buy (66,6,61,18,1,218,235,234) or sell (51,230,133,164,1,127,131,173) discriminator
 *
 * @param {Object} tx - Transaction object from Helius
 * @param {string} pumpProgramId - Pump program ID string
 * @returns {string|null} - Mint address or null if not found
 */
function extractMintFromPumpTransaction(tx, pumpProgramId) {
    const message = tx.transaction?.message;
    if (!message) return null;

    const accountKeys = message.accountKeys || [];
    const instructions = message.instructions || [];

    // Buy discriminator: [102, 6, 61, 18, 1, 218, 235, 234]
    // Sell discriminator: [51, 230, 133, 164, 1, 127, 131, 173]
    const BUY_DISC = [102, 6, 61, 18, 1, 218, 235, 234];
    const SELL_DISC = [51, 230, 133, 164, 1, 127, 131, 173];

    for (const ix of instructions) {
        // Get program ID for this instruction
        const programIdIndex = ix.programIdIndex;
        const programId = accountKeys[programIdIndex];
        const programIdStr = typeof programId === 'string' ? programId : programId?.pubkey;

        if (programIdStr !== pumpProgramId) continue;

        // Decode instruction data
        let data;
        try {
            data = Buffer.from(ix.data, 'base64');
        } catch {
            continue;
        }

        // Check if this is a buy or sell instruction
        const isBuy = data.length >= 8 && BUY_DISC.every((b, i) => data[i] === b);
        const isSell = data.length >= 8 && SELL_DISC.every((b, i) => data[i] === b);

        if (!isBuy && !isSell) continue;

        // The mint is at index 2 in the instruction's accounts
        const ixAccounts = ix.accounts || [];
        if (ixAccounts.length < 3) continue;

        const mintIndex = ixAccounts[2];
        const mintAccount = accountKeys[mintIndex];
        const mint = typeof mintAccount === 'string' ? mintAccount : mintAccount?.pubkey;

        if (mint && !KNOWN_PROGRAMS.has(mint)) {
            return mint;
        }
    }

    return null;
}

/**
 * Discover tokens by analyzing transactions to our creator fee vault.
 * This finds all tokens where we earn creator fees by looking at
 * Pump.fun buy/sell transactions that deposited fees to our vault.
 *
 * The approach:
 * 1. Fetch transactions involving our creator vault
 * 2. Parse each transaction to find Pump buy/sell instructions
 * 3. Extract the mint address from the instruction's account list (index 2)
 * 4. Validate discovered mints via Helius getAsset
 *
 * Progress is tracked via the last processed signature to enable incremental scans.
 */
async function scanVaultTransactionsForTokens(db, devPubkey) {
    console.log('\n📡 Scanning creator vault transactions for token discovery...');

    if (!config.HELIUS_API_KEY) {
        console.log('   ⚠️  HELIUS_API_KEY not configured - skipping vault scan');
        return [];
    }

    // Get our creator vault address
    const { bcVault } = pump.getCreatorFeeVaults(new PublicKey(devPubkey));
    const pumpProgramId = PROGRAMS.PUMP.toString();
    console.log(`   Vault address: ${bcVault.toString()}`);

    // Get last processed signature for incremental scanning
    const lastSignature = await getLastSignatureFromLogs(db);
    if (lastSignature) {
        console.log(`   Resuming from signature: ${lastSignature.slice(0, 20)}...`);
    } else {
        console.log('   Starting fresh scan (no previous progress found)');
    }

    const foundMints = new Set();
    let paginationToken = null;
    let totalTxProcessed = 0;
    let newestSignature = null;

    try {
        // Use Helius getTransactionsForAddress for efficient scanning
        do {
            const params = {
                limit: 100,
                sortOrder: 'desc', // Newest first
                transactionDetails: 'full', // Need full tx to parse instructions
            };

            if (paginationToken) {
                params.paginationToken = paginationToken;
            }

            const response = await axios.post(
                `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                {
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'getTransactionsForAddress',
                    params: [bcVault.toString(), params]
                },
                { timeout: 30000 }
            );

            const result = response.data?.result;
            if (!result || !result.data || result.data.length === 0) {
                break;
            }

            for (const tx of result.data) {
                // Save the newest signature for progress tracking
                if (!newestSignature && tx.signature) {
                    newestSignature = tx.signature;
                }

                // Stop if we've reached the last processed signature
                if (lastSignature && tx.signature === lastSignature) {
                    console.log(`   Reached previously processed signature, stopping`);
                    paginationToken = null; // Exit the loop
                    break;
                }

                totalTxProcessed++;

                // Extract mint from Pump buy/sell instruction
                const mint = extractMintFromPumpTransaction(tx, pumpProgramId);
                if (mint) {
                    foundMints.add(mint);
                }
            }

            paginationToken = result.paginationToken;

            // Progress update
            if (totalTxProcessed % 500 === 0) {
                console.log(`   Processed ${totalTxProcessed} transactions, found ${foundMints.size} unique mints...`);
            }

            // Rate limit protection
            await new Promise(r => setTimeout(r, 100));

        } while (paginationToken);

        // Save progress
        if (newestSignature && !DRY_RUN) {
            await saveLastProcessedSignature(db, newestSignature);
            console.log(`   Saved progress: ${newestSignature.slice(0, 20)}...`);
        }

        console.log(`   Processed ${totalTxProcessed} transactions, found ${foundMints.size} unique token mints`);

    } catch (e) {
        console.log(`   ⚠️  Vault scan error: ${e.message}`);
        if (e.response?.data) {
            console.log(`   Response: ${JSON.stringify(e.response.data).slice(0, 200)}`);
        }
    }

    // Validate mints in batches using getAssetBatch for efficiency
    console.log('\n   Validating discovered mints...');
    const validTokens = [];
    const mintArray = Array.from(foundMints);

    // Process in batches of 100 for getAssetBatch
    for (let i = 0; i < mintArray.length; i += 100) {
        const batch = mintArray.slice(i, i + 100);

        try {
            const batchResponse = await axios.post(
                `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                {
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'getAssetBatch',
                    params: { ids: batch }
                },
                { timeout: 15000 }
            );

            const assets = batchResponse.data?.result || [];
            for (const asset of assets) {
                if (asset && (asset.interface === 'FungibleToken' || asset.interface === 'FungibleAsset')) {
                    const metadata = asset.content?.metadata || {};
                    const files = asset.content?.files || [];
                    const imageFile = files.find(f => f.mime?.startsWith('image/')) || files[0];

                    validTokens.push({
                        mint: asset.id,
                        name: metadata.name || 'Unknown',
                        ticker: metadata.symbol || 'UNKNOWN',
                        description: metadata.description || '',
                        image: imageFile?.cdn_uri || imageFile?.uri || asset.content?.links?.image || null,
                        metadataUri: asset.content?.json_uri || null,
                        twitter: asset.content?.links?.twitter || '',
                        website: asset.content?.links?.external_url || '',
                        marketCap: 0,
                        complete: false,
                        discoveredFrom: 'vault_scan'
                    });
                    console.log(`   ✓ Valid token: ${metadata.symbol || 'UNKNOWN'} (${asset.id.slice(0, 8)}...)`);
                }
            }

            // Rate limit between batches
            await new Promise(r => setTimeout(r, 200));

        } catch (e) {
            console.log(`   ⚠️  Batch validation error: ${e.message}`);
        }
    }

    console.log(`   Found ${validTokens.length} valid tokens from vault transactions`);
    return validTokens;
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

    // 1. Scan vault transactions for tokens we earn fees on
    const vaultTokens = await scanVaultTransactionsForTokens(db, devKeypair.publicKey.toString());
    allTokens.push(...vaultTokens);

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
    console.log('\n📊 Discovery Method:');
    console.log('   - Vault transaction analysis: finds tokens by fee deposits');
    console.log('   - Progress tracked: incremental scans on restart');
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
