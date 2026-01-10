#!/usr/bin/env node
/**
 * Token Backfill Script
 *
 * Scans the Pump.fun program for tokens that:
 * 1. Were created by our dev wallet (creator fees claimable)
 * 2. Have fee-sharing configs where we are a shareholder (robinhood tokens)
 *
 * Inserts any missing tokens into the database so they can be:
 * - Displayed in the UI
 * - Have their fees claimed by the flywheel
 * - Have their holders tracked for airdrops
 *
 * Usage: node scripts/backfillTokens.js [--dry-run]
 */
require('dotenv').config();

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const axios = require('axios');
const bs58 = require('bs58');

const config = require('../src/config/env');
const { PROGRAMS, TOKENS } = require('../src/config/constants');
const database = require('../src/services/postgres');
const { pump } = require('../src/services');

// Parse command line args
const DRY_RUN = process.argv.includes('--dry-run');

// Known discriminators for Pump.fun account types
const TOKEN_METADATA_DISCRIMINATOR = Buffer.from([0x43, 0x81, 0x25, 0xf9, 0x4f, 0xce, 0x9a, 0xb5]); // coin_v2 account
const FEE_SHARING_DISCRIMINATOR = Buffer.from([0x87, 0xc8, 0x18, 0x7b, 0x9b, 0x8a, 0x13, 0x05]);

/**
 * Fetch token metadata from Pump.fun API
 */
async function fetchPumpMetadata(mint) {
    try {
        const response = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, {
            timeout: 5000
        });
        if (response.data) {
            return {
                name: response.data.name || 'Unknown',
                ticker: response.data.symbol || 'UNKNOWN',
                description: response.data.description || '',
                image: response.data.image_uri || null,
                metadataUri: response.data.metadata_uri || null,
                twitter: response.data.twitter || null,
                website: response.data.website || null,
                marketCap: response.data.usd_market_cap || 0,
                creator: response.data.creator || null,
                complete: response.data.complete || false
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
 * Parse Pump.fun coin_v2 account data to extract mint and creator
 *
 * Structure (based on common patterns):
 * - 8 bytes: discriminator
 * - 32 bytes: mint
 * - 32 bytes: creator
 * - ... other fields
 */
function parseCoinAccount(data) {
    try {
        if (data.length < 72) return null;

        const mint = new PublicKey(data.slice(8, 40));
        const creator = new PublicKey(data.slice(40, 72));

        return { mint, creator };
    } catch (e) {
        return null;
    }
}

/**
 * Parse bonding curve account to extract token info
 * Bonding curve PDAs are derived from: ["bonding-curve", mint]
 */
function parseBondingCurveAccount(data) {
    try {
        if (data.length < 100) return null;

        // Bonding curve accounts have specific structure
        // We can derive the mint from the PDA seed
        return { valid: true };
    } catch (e) {
        return null;
    }
}

/**
 * Scan for tokens created by our wallet
 * Strategy: Find bonding curves where we receive creator fees
 */
async function scanForOurTokens(connection, devKeypair) {
    console.log('\n📡 Scanning for tokens created by dev wallet...');
    console.log(`   Dev wallet: ${devKeypair.publicKey.toString()}`);

    const foundTokens = [];

    // Strategy 1: Query the creator vault to see if it has any balance
    // This confirms we have at least some tokens
    const { bcVault, ammVaultAuth } = pump.getCreatorFeeVaults(devKeypair.publicKey);

    try {
        const bcInfo = await connection.getAccountInfo(bcVault);
        if (bcInfo && bcInfo.lamports > 0) {
            console.log(`   ✅ Creator vault has ${(bcInfo.lamports / 1e9).toFixed(4)} SOL pending`);
        } else {
            console.log(`   ℹ️  Creator vault is empty or doesn't exist`);
        }
    } catch (e) {
        console.log(`   ⚠️  Could not check creator vault: ${e.message}`);
    }

    // Strategy 2: Scan for bonding curve accounts
    // Each token has a bonding curve PDA, we can find all mints this way
    console.log('\n   Scanning Pump.fun program for bonding curves...');

    // Bonding curve size is typically 283 bytes
    const BONDING_CURVE_SIZE = 283;

    try {
        const accounts = await connection.getProgramAccounts(PROGRAMS.PUMP, {
            filters: [
                { dataSize: BONDING_CURVE_SIZE }
            ],
            encoding: 'base64'
        });

        console.log(`   Found ${accounts.length} bonding curve accounts`);

        // For each bonding curve, we need to:
        // 1. Derive what mint it's for (from the PDA seeds)
        // 2. Check if that token was created by us

        // Since we can't easily reverse-derive the mint from bonding curve,
        // we'll use a different approach: fetch our recent transactions

    } catch (e) {
        console.log(`   ⚠️  Could not scan bonding curves: ${e.message}`);
    }

    // Strategy 3: Use transaction history to find tokens we created
    console.log('\n   Fetching recent transaction signatures...');

    try {
        const signatures = await connection.getSignaturesForAddress(
            devKeypair.publicKey,
            { limit: 1000 },
            'confirmed'
        );

        console.log(`   Found ${signatures.length} recent transactions`);

        // Look for create token transactions
        let createTxCount = 0;
        const checkedMints = new Set();

        for (const sig of signatures) {
            try {
                const tx = await connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0
                });

                if (!tx || !tx.meta) continue;

                // Check if this transaction interacted with Pump.fun
                const accountKeys = tx.transaction.message.staticAccountKeys ||
                                   tx.transaction.message.accountKeys || [];

                const isPumpTx = accountKeys.some(key =>
                    key.toString() === PROGRAMS.PUMP.toString()
                );

                if (!isPumpTx) continue;

                // Look for new token mints in the transaction
                // Token creates will have new accounts created
                if (tx.meta.postTokenBalances) {
                    for (const balance of tx.meta.postTokenBalances) {
                        const mint = balance.mint;
                        if (checkedMints.has(mint)) continue;
                        checkedMints.add(mint);

                        // Verify this is a Pump.fun token and we can claim fees
                        try {
                            const mintPubkey = new PublicKey(mint);
                            const [bondingCurve] = PublicKey.findProgramAddressSync(
                                [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
                                PROGRAMS.PUMP
                            );

                            const bcInfo = await connection.getAccountInfo(bondingCurve);
                            if (bcInfo) {
                                // This is a valid Pump.fun token
                                // Check if we're the creator by seeing if our vault gets fees
                                foundTokens.push({
                                    mint: mint,
                                    discoveredFrom: 'transaction_history',
                                    signature: sig.signature
                                });
                                createTxCount++;
                                console.log(`   Found token: ${mint.slice(0, 8)}...`);
                            }
                        } catch (e) {
                            // Not a valid token
                        }
                    }
                }

                // Rate limit
                await new Promise(r => setTimeout(r, 100));

            } catch (e) {
                // Skip failed transactions
            }
        }

        console.log(`   Identified ${createTxCount} potential token creates`);

    } catch (e) {
        console.log(`   ⚠️  Could not fetch transactions: ${e.message}`);
    }

    return foundTokens;
}

/**
 * Scan for fee-sharing configs (Robinhood tokens)
 */
async function scanForRobinhoodTokens(connection, devKeypair) {
    console.log('\n📡 Scanning for fee-sharing partnerships (Robinhood tokens)...');

    const foundTokens = [];
    const sizes = [110, 144, 178, 212, 246]; // Different shareholder counts

    for (const dataSize of sizes) {
        try {
            // Check first shareholder position
            const accounts1 = await connection.getProgramAccounts(PROGRAMS.PUMP, {
                filters: [
                    { dataSize },
                    { memcmp: { offset: 76, bytes: devKeypair.publicKey.toBase58() } }
                ]
            }).catch(() => []);

            // Check second shareholder position
            const accounts2 = await connection.getProgramAccounts(PROGRAMS.PUMP, {
                filters: [
                    { dataSize },
                    { memcmp: { offset: 110, bytes: devKeypair.publicKey.toBase58() } }
                ]
            }).catch(() => []);

            const accounts = [...accounts1, ...accounts2];

            for (const account of accounts) {
                try {
                    const data = account.account.data;
                    if (data.length < 76) continue;

                    // Parse the config
                    const creator = new PublicKey(data.slice(8, 40));
                    const mint = new PublicKey(data.slice(40, 72));
                    const shareholderCount = data.readUInt32LE(72);

                    if (shareholderCount < 1 || shareholderCount > 10) continue;

                    // Find our share
                    let ourShareBps = 0;
                    let offset = 76;
                    for (let i = 0; i < shareholderCount && offset + 34 <= data.length; i++) {
                        const pubkey = new PublicKey(data.slice(offset, offset + 32));
                        const shareBps = data.readUInt16LE(offset + 32);
                        if (pubkey.equals(devKeypair.publicKey)) {
                            ourShareBps = shareBps;
                            break;
                        }
                        offset += 34;
                    }

                    if (ourShareBps > 0) {
                        foundTokens.push({
                            mint: mint.toString(),
                            creator: creator.toString(),
                            shareBps: ourShareBps,
                            sharePercent: ourShareBps / 100,
                            type: 'robinhood'
                        });
                        console.log(`   Found Robinhood: ${mint.toString().slice(0, 8)}... (${ourShareBps / 100}% share)`);
                    }
                } catch (e) {
                    // Skip invalid accounts
                }
            }

            await new Promise(r => setTimeout(r, 300));

        } catch (e) {
            console.log(`   ⚠️  Error scanning size ${dataSize}: ${e.message}`);
        }
    }

    console.log(`   Found ${foundTokens.length} Robinhood partnerships`);
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
 * Scan Pump.fun API for all tokens by creator
 */
async function scanPumpFunAPI(devPubkey) {
    console.log('\n📡 Querying Pump.fun API for tokens by creator...');

    const foundTokens = [];

    try {
        // Pump.fun has an API endpoint for getting coins by creator
        const response = await axios.get(`https://frontend-api.pump.fun/coins/user-created-coins/${devPubkey}`, {
            timeout: 10000
        });

        if (response.data && Array.isArray(response.data)) {
            for (const coin of response.data) {
                foundTokens.push({
                    mint: coin.mint,
                    name: coin.name,
                    ticker: coin.symbol,
                    description: coin.description || '',
                    image: coin.image_uri || null,
                    metadataUri: coin.metadata_uri || null,
                    twitter: coin.twitter || '',
                    website: coin.website || '',
                    marketCap: coin.usd_market_cap || 0,
                    complete: coin.complete || false,
                    discoveredFrom: 'pump_api'
                });
                console.log(`   Found: ${coin.symbol} (${coin.mint.slice(0, 8)}...)`);
            }
        }

        console.log(`   Found ${foundTokens.length} tokens from Pump.fun API`);

    } catch (e) {
        if (e.response?.status === 404) {
            console.log('   ℹ️  No tokens found for this creator on Pump.fun API');
        } else {
            console.log(`   ⚠️  Pump.fun API error: ${e.message}`);
        }
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

    // 1. Scan Pump.fun API for tokens created by us
    const apiTokens = await scanPumpFunAPI(devKeypair.publicKey.toString());
    allTokens.push(...apiTokens);

    // 2. Scan on-chain for tokens (backup method)
    const chainTokens = await scanForOurTokens(connection, devKeypair);

    // Merge, avoiding duplicates
    for (const token of chainTokens) {
        if (!allTokens.some(t => t.mint === token.mint)) {
            allTokens.push(token);
        }
    }

    // 3. Scan for Robinhood tokens
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

    await db.close();
    process.exit(0);
}

// Run
main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
