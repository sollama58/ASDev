/**
 * Test Airdrop Script
 * v25.26 - Testing script for point distribution and airdrop process
 *
 * This script:
 * 1. Shows current point distribution across all users
 * 2. Runs a test airdrop with EXACTLY 0.10 SOL (hardwired)
 * 3. Validates the distribution logic without risking large amounts
 *
 * IMPORTANT: This script ignores actual wallet balance and only considers
 * 0.10 SOL as the airdrop pool for testing purposes.
 *
 * Usage:
 *   node scripts/test-airdrop.js              # Show distribution only (dry run)
 *   node scripts/test-airdrop.js --execute    # Actually execute the test airdrop
 */

require('dotenv').config();

const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');

// Config - HARDWIRED TEST AMOUNT
const TEST_AIRDROP_AMOUNT_SOL = 0.10; // HARDWIRED: Always use exactly 0.10 SOL for testing
const KOTH_PERCENT = 0.10; // 10% to KOTH holders
const COMMUNITY_PERCENT = 0.90; // 90% to community

// Check for execute flag
const EXECUTE_MODE = process.argv.includes('--execute');

console.log('='.repeat(60));
console.log('AIRDROP TEST SCRIPT (HARDWIRED 0.10 SOL)');
console.log('='.repeat(60));
console.log(`Mode: ${EXECUTE_MODE ? 'EXECUTE (will send real SOL!)' : 'DRY RUN (simulation only)'}`);
console.log(`Test Amount: ${TEST_AIRDROP_AMOUNT_SOL} SOL (HARDWIRED - ignores wallet balance)`);
console.log('='.repeat(60));
console.log('');

async function main() {
    // Initialize services
    const config = require('../src/config/env');
    const { database, redis } = require('../src/services');
    const { WALLETS } = require('../src/config/constants');

    // Initialize Redis
    console.log('[1/6] Initializing Redis...');
    const redisOk = await redis.init();
    if (!redisOk) {
        console.error('ERROR: Redis initialization failed');
        process.exit(1);
    }
    console.log('      Redis connected');

    // Initialize Database
    console.log('[2/6] Initializing PostgreSQL...');
    await database.initDB();
    const db = database.getDB();
    console.log('      PostgreSQL connected');

    // Initialize Solana connection
    console.log('[3/6] Connecting to Solana...');
    const connection = new Connection(config.RPC_URL, 'confirmed');
    const devKeypair = Keypair.fromSecretKey(bs58.decode(config.DEV_WALLET_PRIVATE_KEY));
    console.log(`      Wallet: ${devKeypair.publicKey.toString()}`);

    // Check wallet balance (for info only - we use hardwired 0.10 SOL for test)
    const balance = await connection.getBalance(devKeypair.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;
    console.log(`      Actual Balance: ${balanceSol.toFixed(4)} SOL`);
    console.log(`      TEST POOL (hardwired): ${TEST_AIRDROP_AMOUNT_SOL} SOL`);

    if (EXECUTE_MODE && balanceSol < TEST_AIRDROP_AMOUNT_SOL + 0.01) {
        console.error(`ERROR: Insufficient balance. Need at least ${TEST_AIRDROP_AMOUNT_SOL + 0.01} SOL to run test`);
        process.exit(1);
    }

    // IMPORTANT: We ignore actual balance and use hardwired 0.10 SOL for distribution calculation
    console.log(`      NOTE: Distribution calculated using HARDWIRED ${TEST_AIRDROP_AMOUNT_SOL} SOL (not actual balance)`);

    // Fetch point distribution
    console.log('\n[4/6] Fetching point distribution from Redis...');
    const userPointsMap = await redis.getAllUserPoints();
    const userExpectedAirdrops = await redis.getAllUserExpectedAirdrops();
    const totalPoints = await redis.getTotalPoints();

    console.log(`      Total Points: ${totalPoints?.toFixed(2) || 0}`);
    console.log(`      Users with points: ${userPointsMap.size}`);
    console.log(`      Users with expected airdrops: ${userExpectedAirdrops.size}`);

    // Get KOTH token info
    console.log('\n[5/6] Fetching KOTH (King of the Hill) info...');
    const kothToken = await db.get('SELECT mint, ticker, "marketCap", "userPubkey" FROM tokens ORDER BY "marketCap" DESC LIMIT 1');

    if (kothToken) {
        console.log(`      KOTH Token: ${kothToken.ticker || 'Unknown'}`);
        console.log(`      KOTH Market Cap: $${kothToken.marketCap?.toFixed(2) || 0}`);
        console.log(`      KOTH Creator: ${kothToken.userPubkey?.slice(0, 8)}...`);

        // Get KOTH holders
        const kothHolders = await db.all(
            'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC LIMIT 10',
            [kothToken.mint]
        );
        console.log(`      KOTH Holders (top 10): ${kothHolders.length}`);
    } else {
        console.log('      No KOTH token found');
    }

    // Calculate test distribution using HARDWIRED 0.10 SOL
    console.log('\n[6/6] Calculating test distribution (HARDWIRED 0.10 SOL)...');

    // HARDWIRED: Always use exactly 0.10 SOL regardless of actual wallet balance
    const testAmountLamports = Math.floor(TEST_AIRDROP_AMOUNT_SOL * LAMPORTS_PER_SOL); // 0.10 SOL = 100,000,000 lamports
    const kothAmountLamports = Math.floor(testAmountLamports * KOTH_PERCENT);  // 0.01 SOL to KOTH
    const communityAmountLamports = testAmountLamports - kothAmountLamports;   // 0.09 SOL to community

    console.log(`      HARDWIRED Test Pool: ${TEST_AIRDROP_AMOUNT_SOL} SOL (${testAmountLamports} lamports)`);
    console.log(`      KOTH Pool (10%): ${(kothAmountLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (0.01 SOL)`);
    console.log(`      Community Pool (90%): ${(communityAmountLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (0.09 SOL)`);

    // Build distribution list
    const distributions = [];
    const devPubkeyStr = devKeypair.publicKey.toString();

    // Community distribution (based on points)
    if (totalPoints > 0) {
        for (const [pubkey, points] of userPointsMap.entries()) {
            if (pubkey === devPubkeyStr) continue; // Skip dev wallet
            if (points <= 0) continue;

            const share = points / totalPoints;
            const amountLamports = Math.floor(communityAmountLamports * share);

            if (amountLamports > 0) {
                distributions.push({
                    pubkey,
                    points,
                    share: (share * 100).toFixed(4),
                    amountLamports,
                    amountSol: amountLamports / LAMPORTS_PER_SOL,
                    type: 'community'
                });
            }
        }
    }

    // KOTH distribution (if applicable)
    if (kothToken && kothToken.mint) {
        const kothHolders = await db.all(
            'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1',
            [kothToken.mint]
        );

        if (kothHolders.length > 0) {
            // Calculate total balance for proportional distribution
            let totalBalance = BigInt(0);
            for (const h of kothHolders) {
                totalBalance += BigInt(h.balance || '0');
            }

            if (totalBalance > BigInt(0)) {
                for (const holder of kothHolders) {
                    if (holder.holderPubkey === devPubkeyStr) continue;

                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance <= BigInt(0)) continue;

                    const share = Number((holderBalance * BigInt(10000)) / totalBalance) / 10000;
                    const amountLamports = Math.floor(kothAmountLamports * share);

                    if (amountLamports > 0) {
                        // Check if already in distributions (add to existing)
                        const existing = distributions.find(d => d.pubkey === holder.holderPubkey);
                        if (existing) {
                            existing.amountLamports += amountLamports;
                            existing.amountSol = existing.amountLamports / LAMPORTS_PER_SOL;
                            existing.type = 'community+koth';
                            existing.kothShare = (share * 100).toFixed(4);
                        } else {
                            distributions.push({
                                pubkey: holder.holderPubkey,
                                points: 0,
                                share: '0',
                                kothShare: (share * 100).toFixed(4),
                                amountLamports,
                                amountSol: amountLamports / LAMPORTS_PER_SOL,
                                type: 'koth'
                            });
                        }
                    }
                }
            }
        }
    }

    // Sort by amount (highest first)
    distributions.sort((a, b) => b.amountLamports - a.amountLamports);

    // Display distribution
    console.log('\n' + '='.repeat(60));
    console.log('POINT DISTRIBUTION BREAKDOWN');
    console.log('='.repeat(60));
    console.log('');
    console.log(`Total Recipients: ${distributions.length}`);
    console.log('');

    // Show top 20 recipients
    console.log('Top 20 Recipients:');
    console.log('-'.repeat(90));
    console.log('| # | Wallet                                     | Points    | Share %  | Amount SOL | Type         |');
    console.log('-'.repeat(90));

    const top20 = distributions.slice(0, 20);
    top20.forEach((d, i) => {
        const walletShort = d.pubkey.slice(0, 8) + '...' + d.pubkey.slice(-4);
        const pointsStr = d.points.toFixed(0).padStart(9);
        const shareStr = (d.share + '%').padStart(8);
        const amountStr = d.amountSol.toFixed(6).padStart(10);
        const typeStr = d.type.padEnd(12);
        console.log(`| ${(i + 1).toString().padStart(2)} | ${walletShort.padEnd(42)} | ${pointsStr} | ${shareStr} | ${amountStr} | ${typeStr} |`);
    });
    console.log('-'.repeat(90));

    // Summary stats
    const totalDistributed = distributions.reduce((sum, d) => sum + d.amountLamports, 0);
    const avgAmount = distributions.length > 0 ? totalDistributed / distributions.length : 0;

    console.log('');
    console.log('Distribution Summary:');
    console.log(`  Total to distribute: ${(totalDistributed / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`  Number of recipients: ${distributions.length}`);
    console.log(`  Average per recipient: ${(avgAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`  Minimum amount: ${distributions.length > 0 ? (distributions[distributions.length - 1].amountSol).toFixed(6) : 0} SOL`);
    console.log(`  Maximum amount: ${distributions.length > 0 ? distributions[0].amountSol.toFixed(6) : 0} SOL`);

    // Point source breakdown
    console.log('');
    console.log('Point Sources:');

    // Get platform token count
    const platformTokens = await db.all('SELECT COUNT(*) as count FROM tokens WHERE volume24h >= 100');
    const robinhoodTokens = await db.all('SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1');

    console.log(`  Platform tokens (>$100 vol): ${platformTokens[0]?.count || 0}`);
    console.log(`  Robinhood tokens (active): ${robinhoodTokens[0]?.count || 0}`);

    // Execute mode
    if (EXECUTE_MODE) {
        console.log('');
        console.log('='.repeat(60));
        console.log('EXECUTING TEST AIRDROP (HARDWIRED 0.10 SOL)');
        console.log('='.repeat(60));

        if (distributions.length === 0) {
            console.log('ERROR: No recipients to distribute to');
            process.exit(1);
        }

        // Confirm
        console.log('');
        console.log('*'.repeat(60));
        console.log(`WARNING: This will send EXACTLY ${TEST_AIRDROP_AMOUNT_SOL} SOL (HARDWIRED)`);
        console.log(`         to ${distributions.length} recipients!`);
        console.log('*'.repeat(60));
        console.log('');
        console.log('Press Ctrl+C within 5 seconds to cancel...');
        await new Promise(r => setTimeout(r, 5000));

        console.log('');
        console.log('Executing transfers...');

        // Batch transfers (max 20 per transaction for safety)
        const BATCH_SIZE = 20;
        let successCount = 0;
        let failCount = 0;
        let totalSent = 0;

        for (let i = 0; i < distributions.length; i += BATCH_SIZE) {
            const batch = distributions.slice(i, i + BATCH_SIZE);

            try {
                const tx = new Transaction();

                // Add priority fee
                const { ComputeBudgetProgram } = require('@solana/web3.js');
                tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));

                for (const d of batch) {
                    tx.add(SystemProgram.transfer({
                        fromPubkey: devKeypair.publicKey,
                        toPubkey: new PublicKey(d.pubkey),
                        lamports: d.amountLamports
                    }));
                }

                tx.feePayer = devKeypair.publicKey;
                tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

                const sig = await connection.sendTransaction(tx, [devKeypair], {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed'
                });

                await connection.confirmTransaction(sig, 'confirmed');

                successCount += batch.length;
                totalSent += batch.reduce((sum, d) => sum + d.amountLamports, 0);
                console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} transfers - TX: ${sig.slice(0, 20)}...`);

            } catch (e) {
                failCount += batch.length;
                console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: FAILED - ${e.message}`);
            }

            // Small delay between batches
            if (i + BATCH_SIZE < distributions.length) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        console.log('');
        console.log('='.repeat(60));
        console.log('TEST AIRDROP COMPLETE');
        console.log('='.repeat(60));
        console.log(`  Successful transfers: ${successCount}`);
        console.log(`  Failed transfers: ${failCount}`);
        console.log(`  Total SOL sent: ${(totalSent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

    } else {
        console.log('');
        console.log('='.repeat(60));
        console.log('DRY RUN COMPLETE');
        console.log('='.repeat(60));
        console.log('To execute the test airdrop, run:');
        console.log('  node scripts/test-airdrop.js --execute');
    }

    // Cleanup
    console.log('');
    console.log('Cleaning up...');
    redis.getConnection()?.disconnect();
    await db.close();
    console.log('Done.');
    process.exit(0);
}

main().catch(err => {
    console.error('FATAL ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
});
