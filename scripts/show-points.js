/**
 * Show Points Script
 * v25.26 - Display current point distribution and eligibility
 *
 * This script shows:
 * - All users with points and their breakdown
 * - Platform vs Robinhood token contributions
 * - Expected airdrop amounts
 * - KOTH status
 *
 * Usage:
 *   node scripts/show-points.js
 *   node scripts/show-points.js --verbose    # Show all users (not just top 50)
 *   node scripts/show-points.js --user <pubkey>  # Show specific user details
 */

require('dotenv').config();

const VERBOSE = process.argv.includes('--verbose');
const USER_FLAG_INDEX = process.argv.indexOf('--user');
const SPECIFIC_USER = USER_FLAG_INDEX > -1 ? process.argv[USER_FLAG_INDEX + 1] : null;

console.log('='.repeat(70));
console.log('POINT DISTRIBUTION VIEWER');
console.log('='.repeat(70));
console.log('');

async function main() {
    const config = require('../src/config/env');
    const { database, redis } = require('../src/services');

    // Initialize
    console.log('Initializing connections...');
    await redis.init();
    await database.initDB();
    const db = database.getDB();
    console.log('Connected.\n');

    // Fetch global stats
    const totalPoints = await redis.getTotalPoints() || 0;
    const userPointsMap = await redis.getAllUserPoints();
    const userExpectedAirdrops = await redis.getAllUserExpectedAirdrops();
    const asdfTop100 = await redis.getAsdfTop100Holders();

    console.log('='.repeat(70));
    console.log('GLOBAL STATISTICS');
    console.log('='.repeat(70));
    console.log(`Total Points in System: ${totalPoints.toFixed(2)}`);
    console.log(`Users with Points: ${userPointsMap.size}`);
    console.log(`Users with Expected Airdrops: ${userExpectedAirdrops.size}`);
    console.log(`ASDF Top 100 Holders (2x multiplier): ${asdfTop100.size}`);

    // Get token counts
    const platformTokens = await db.all(
        'SELECT COUNT(*) as count FROM tokens WHERE volume24h >= 100'
    );
    const robinhoodTokens = await db.all(
        'SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1'
    );
    const platformHolders = await db.all(
        'SELECT COUNT(DISTINCT "holderPubkey") as count FROM token_holders'
    );
    const robinhoodHolders = await db.all(
        'SELECT COUNT(DISTINCT "holderPubkey") as count FROM robinhood_token_holders'
    );

    console.log('');
    console.log('Token Eligibility:');
    console.log(`  Platform Tokens (>$100 vol): ${platformTokens[0]?.count || 0}`);
    console.log(`  Robinhood Tokens (active): ${robinhoodTokens[0]?.count || 0}`);
    console.log(`  Unique Platform Holders: ${platformHolders[0]?.count || 0}`);
    console.log(`  Unique Robinhood Holders: ${robinhoodHolders[0]?.count || 0}`);

    // KOTH info
    const kothToken = await db.get(
        'SELECT mint, ticker, "marketCap", "userPubkey" FROM tokens ORDER BY "marketCap" DESC LIMIT 1'
    );

    console.log('');
    console.log('King of the Hill (KOTH):');
    if (kothToken) {
        const kothHolderCount = await db.get(
            'SELECT COUNT(*) as count FROM token_holders WHERE mint = $1',
            [kothToken.mint]
        );
        console.log(`  Token: ${kothToken.ticker || 'Unknown'} (${kothToken.mint?.slice(0, 8)}...)`);
        console.log(`  Market Cap: $${kothToken.marketCap?.toFixed(2) || 0}`);
        console.log(`  Creator: ${kothToken.userPubkey?.slice(0, 8)}...`);
        console.log(`  Holder Count: ${kothHolderCount?.count || 0}`);
    } else {
        console.log('  No qualifying KOTH token found');
    }

    // Specific user lookup
    if (SPECIFIC_USER) {
        console.log('');
        console.log('='.repeat(70));
        console.log(`USER DETAILS: ${SPECIFIC_USER}`);
        console.log('='.repeat(70));

        const userPoints = userPointsMap.get(SPECIFIC_USER) || 0;
        const userExpected = userExpectedAirdrops.get(SPECIFIC_USER) || 0;
        const isAsdfHolder = asdfTop100.has(SPECIFIC_USER);

        console.log(`Total Points: ${userPoints.toFixed(2)}`);
        console.log(`Expected Airdrop: ${userExpected.toFixed(6)} SOL`);
        console.log(`ASDF Top 100 (2x): ${isAsdfHolder ? 'YES' : 'No'}`);

        // Get their token holdings
        const platformHoldings = await db.all(
            `SELECT th.mint, th.balance, th.rank, t.ticker, t.volume24h
             FROM token_holders th
             JOIN tokens t ON th.mint = t.mint
             WHERE th."holderPubkey" = $1 AND t.volume24h >= 100
             ORDER BY t.volume24h DESC`,
            [SPECIFIC_USER]
        );

        const robinhoodHoldings = await db.all(
            `SELECT rth.mint, rth.balance, rth.rank, rt.ticker, rt.volume24h, rt."feeShareBps"
             FROM robinhood_token_holders rth
             JOIN robinhood_tokens rt ON rth.mint = rt.mint
             WHERE rth."holderPubkey" = $1 AND rt."isActive" = 1
             ORDER BY rt.volume24h DESC`,
            [SPECIFIC_USER]
        );

        console.log('');
        console.log(`Platform Token Holdings: ${platformHoldings.length}`);
        if (platformHoldings.length > 0) {
            platformHoldings.slice(0, 10).forEach(h => {
                console.log(`  - ${h.ticker || h.mint.slice(0, 8)} | Rank #${h.rank} | Vol: $${h.volume24h?.toFixed(0) || 0}`);
            });
            if (platformHoldings.length > 10) {
                console.log(`  ... and ${platformHoldings.length - 10} more`);
            }
        }

        console.log('');
        console.log(`Robinhood Token Holdings: ${robinhoodHoldings.length}`);
        if (robinhoodHoldings.length > 0) {
            robinhoodHoldings.slice(0, 10).forEach(h => {
                console.log(`  - ${h.ticker || h.mint.slice(0, 8)} | Rank #${h.rank} | Vol: $${h.volume24h?.toFixed(0) || 0} | Fee: ${(h.feeShareBps / 100).toFixed(1)}%`);
            });
            if (robinhoodHoldings.length > 10) {
                console.log(`  ... and ${robinhoodHoldings.length - 10} more`);
            }
        }

        // Check if KOTH holder
        if (kothToken) {
            const kothHolding = await db.get(
                'SELECT balance, rank FROM token_holders WHERE mint = $1 AND "holderPubkey" = $2',
                [kothToken.mint, SPECIFIC_USER]
            );
            console.log('');
            console.log(`KOTH Holder: ${kothHolding ? `YES (Rank #${kothHolding.rank})` : 'No'}`);
        }

    } else {
        // Show all users with points
        console.log('');
        console.log('='.repeat(70));
        console.log('USER POINT RANKINGS');
        console.log('='.repeat(70));

        // Convert to array and sort
        const userList = [];
        for (const [pubkey, points] of userPointsMap.entries()) {
            const expected = userExpectedAirdrops.get(pubkey) || 0;
            const isAsdf = asdfTop100.has(pubkey);
            userList.push({ pubkey, points, expected, isAsdf });
        }
        userList.sort((a, b) => b.points - a.points);

        const displayList = VERBOSE ? userList : userList.slice(0, 50);

        console.log('');
        console.log(`Showing ${displayList.length} of ${userList.length} users${!VERBOSE ? ' (use --verbose for all)' : ''}`);
        console.log('');
        console.log('-'.repeat(95));
        console.log('| Rank | Wallet                                     | Points       | Expected SOL | ASDF 2x |');
        console.log('-'.repeat(95));

        displayList.forEach((u, i) => {
            const rank = (i + 1).toString().padStart(4);
            const wallet = u.pubkey.slice(0, 8) + '...' + u.pubkey.slice(-4);
            const points = u.points.toFixed(2).padStart(12);
            const expected = u.expected.toFixed(6).padStart(12);
            const asdf = u.isAsdf ? '  YES  ' : '   -   ';
            console.log(`| ${rank} | ${wallet.padEnd(42)} | ${points} | ${expected} | ${asdf} |`);
        });
        console.log('-'.repeat(95));

        // Summary
        const totalExpected = userList.reduce((sum, u) => sum + u.expected, 0);
        const asdfCount = userList.filter(u => u.isAsdf).length;

        console.log('');
        console.log('Summary:');
        console.log(`  Total users: ${userList.length}`);
        console.log(`  Total points: ${totalPoints.toFixed(2)}`);
        console.log(`  Total expected airdrops: ${totalExpected.toFixed(6)} SOL`);
        console.log(`  Users with ASDF 2x: ${asdfCount}`);
    }

    // Cleanup
    console.log('');
    redis.getConnection()?.disconnect();
    await db.close();
    process.exit(0);
}

main().catch(err => {
    console.error('ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
});
