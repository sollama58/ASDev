/**
 * Token Routes
 * Token listing, leaderboard, and holder endpoints
 * v13.0 - Updated for PostgreSQL
 */
const express = require('express');
const axios = require('axios');
const { isValidPubkey } = require('./solana');
const { redis } = require('../services');

const router = express.Router();

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { db, globalState, devKeypair } = deps;

    // Get all launches
    router.get('/all-launches', async (req, res) => {
        try {
            const rows = await db.all('SELECT * FROM tokens ORDER BY volume24h DESC');
            const allLaunches = rows.map(r => ({
                mint: r.mint,
                userPubkey: r.userPubkey,
                name: r.name,
                ticker: r.ticker,
                image: r.image,
                metadataUri: r.metadataUri,
                marketCap: r.marketCap || 0,
                volume: r.volume24h,
                complete: !!r.complete
            }));
            res.json({ tokens: allLaunches, lastUpdate: globalState.lastBackendUpdate });
        } catch (e) {
            res.status(500).json({ tokens: [], lastUpdate: Date.now() });
        }
    });

    // King of the Pill (KOTH) Endpoint
    router.get('/koth', async (req, res) => {
        try {
            // Select token with highest market cap
            // Ensure we only select valid tokens (non-null marketCap)
            const koth = await db.get(`
                SELECT mint, "userPubkey", name, ticker, image, "marketCap", volume24h
                FROM tokens
                WHERE "marketCap" > 0
                ORDER BY "marketCap" DESC
                LIMIT 1
            `);
            
            if (koth) {
                res.json({ 
                    found: true,
                    token: {
                        mint: koth.mint,
                        creator: koth.userPubkey,
                        name: koth.name,
                        ticker: koth.ticker,
                        image: koth.image,
                        marketCap: koth.marketCap,
                        volume: koth.volume24h
                    }
                });
            } else {
                res.json({ found: false });
            }
        } catch (e) {
            console.error("KOTH Endpoint Error:", e);
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Leaderboard - Shows all tokens where dev wallet receives fees (launched + robinhood)
    router.get('/leaderboard', async (req, res) => {
        const { userPubkey } = req.query;
        // Validate userPubkey if provided
        if (userPubkey && !isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }
        try {
            // Combine launched tokens and active robinhood tokens
            // Use UNION ALL to merge both sources, preserving creator info
            const rows = await db.all(`
                SELECT mint, "userPubkey" as creator, name, ticker, image, "metadataUri", "marketCap", volume24h, complete, 'launched' as source
                FROM tokens
                UNION ALL
                SELECT mint, "creatorPubkey" as creator, name, ticker, image, NULL as "metadataUri", "marketCap", volume24h, "isGraduated" as complete, 'robinhood' as source
                FROM robinhood_tokens
                WHERE "isActive" = 1
                ORDER BY volume24h DESC
                LIMIT 10
            `);

            // Batch query for user holder status (check both holder tables)
            let userHoldings = new Set();
            if (userPubkey && rows.length > 0) {
                const mints = rows.map(r => r.mint);
                const placeholders = mints.map((_, i) => `$${i + 2}`).join(',');

                // Check token_holders (launched tokens)
                const launchedHoldings = await db.all(
                    `SELECT mint FROM token_holders WHERE "holderPubkey" = $1 AND mint IN (${placeholders})`,
                    [userPubkey, ...mints]
                );

                // Check robinhood_token_holders (robinhood tokens)
                const robinhoodHoldings = await db.all(
                    `SELECT mint FROM robinhood_token_holders WHERE "holderPubkey" = $1 AND mint IN (${placeholders})`,
                    [userPubkey, ...mints]
                );

                userHoldings = new Set([
                    ...launchedHoldings.map(h => h.mint),
                    ...robinhoodHoldings.map(h => h.mint)
                ]);
            }

            const leaderboard = rows.map(r => ({
                mint: r.mint,
                creator: r.creator,
                name: r.name,
                ticker: r.ticker,
                image: r.image,
                metadataUri: r.metadataUri,
                price: ((r.marketCap || 0) / 1000000000).toFixed(6),
                marketCap: r.marketCap || 0,
                volume: r.volume24h,
                isUserTopHolder: userHoldings.has(r.mint),
                complete: !!r.complete,
                isRobinhood: r.source === 'robinhood'
            }));
            res.json({ tokens: leaderboard, lastUpdate: globalState.lastBackendUpdate });
        } catch (e) {
            console.error("Leaderboard Error:", e);
            res.status(500).json({ tokens: [], lastUpdate: Date.now() });
        }
    });

    // Recent launches
    router.get('/recent-launches', async (req, res) => {
        try {
            const rows = await db.all('SELECT "userPubkey", ticker, mint, timestamp FROM tokens ORDER BY timestamp DESC LIMIT 10');
            res.json(rows.map(r => ({
                userSnippet: r.userPubkey.slice(0, 5),
                ticker: r.ticker,
                mint: r.mint
            })));
        } catch (e) {
            res.status(500).json([]);
        }
    });

    // Get single token
    router.get('/token/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            const token = await db.get('SELECT "tweetUrl" FROM tokens WHERE mint = $1', [mint]);
            res.json(token || {});
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Proxy for token price data (uses DexScreener API)
    router.get('/pump-proxy/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            if (!isValidPubkey(mint)) {
                return res.status(400).json({ error: "Invalid mint address" });
            }
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                timeout: 5000
            });
            const pairs = response.data?.pairs || [];
            if (pairs.length > 0) {
                const pair = pairs[0];
                res.json({
                    priceUsd: parseFloat(pair.priceUsd) || 0,
                    priceNative: parseFloat(pair.priceNative) || 0
                });
            } else {
                res.json({ priceUsd: 0, priceNative: 0 });
            }
        } catch (e) {
            res.status(500).json({ error: "Failed to fetch price data" });
        }
    });

    // Token holders
    router.get('/token-holders/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            const holders = await db.all(
                'SELECT rank, "holderPubkey" FROM token_holders WHERE mint = $1 ORDER BY rank ASC LIMIT 50',
                [mint]
            );
            res.json(holders);
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Check holder status
    // v11.0: Now returns expected SOL airdrop amount instead of PUMP
    router.get('/check-holder', async (req, res) => {
        const { userPubkey } = req.query;
        if (!userPubkey) {
            return res.json({
                isHolder: false, isAsdfTop50: false, points: 0,
                multiplier: 1, heldPositionsCount: 0, createdPositionsCount: 0,
                expectedAirdrop: 0, expectedAirdropCurrency: 'SOL'
            });
        }
        if (!isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }

        try {
            const top10 = await db.all('SELECT mint FROM tokens ORDER BY volume24h DESC LIMIT 10');
            const top10Mints = top10.map(t => t.mint);

            let heldPositionsCount = 0;
            let createdPositionsCount = 0;

            if (top10Mints.length > 0) {
                const placeholders = top10Mints.map((_, i) => `$${i + 2}`).join(',');

                const query = `SELECT COUNT(*) as count FROM token_holders WHERE "holderPubkey" = $1 AND mint IN (${placeholders})`;
                const result = await db.get(query, [userPubkey, ...top10Mints]);
                heldPositionsCount = parseInt(result?.count) || 0;

                const creatorQuery = `SELECT COUNT(*) as count FROM tokens WHERE "userPubkey" = $1 AND mint IN (${placeholders})`;
                const creatorRes = await db.get(creatorQuery, [userPubkey, ...top10Mints]);
                createdPositionsCount = parseInt(creatorRes?.count) || 0;
            }

            // v13.0: Fetch from Redis for cross-process consistency
            const isAsdfTop50 = await redis.isAsdfTop100Holder(userPubkey);
            const totalBase = heldPositionsCount + (createdPositionsCount * 2);
            const multiplier = isAsdfTop50 ? 2 : 1;
            const points = totalBase * multiplier;
            const expectedAirdrop = await redis.getUserExpectedAirdrop(userPubkey);

            res.json({
                isHolder: heldPositionsCount > 0,
                isAsdfTop50,
                points,
                multiplier,
                heldPositionsCount,
                createdPositionsCount,
                expectedAirdrop,
                expectedAirdropCurrency: 'SOL' // v11.0: Now in SOL
            });
        } catch (e) {
            res.status(500).json({ error: "DB Error", expectedAirdrop: 0 });
        }
    });

    // Eligible users for airdrop
    // v11.0: Now returns expected SOL airdrop amounts
    router.get('/all-eligible-users', async (req, res) => {
        try {
            const top10 = await db.all('SELECT mint, "userPubkey" FROM tokens ORDER BY volume24h DESC LIMIT 10');
            const top10Mints = top10.map(t => t.mint);

            if (top10Mints.length === 0) {
                return res.json({ users: [], totalPoints: 0, currency: 'SOL' });
            }

            const placeholders = top10Mints.map((_, i) => `$${i + 1}`).join(',');
            const rows = await db.all(`
                SELECT "holderPubkey", COUNT(*) as "positionCount"
                FROM token_holders
                WHERE mint IN (${placeholders})
                GROUP BY "holderPubkey"
            `, top10Mints);

            let userPointsMap = new Map();

            rows.forEach(row => {
                userPointsMap.set(row.holderPubkey, {
                    pubkey: row.holderPubkey,
                    holderPositions: parseInt(row.positionCount),
                    createdPositions: 0
                });
            });

            top10.forEach(token => {
                if (token.userPubkey) {
                    const user = userPointsMap.get(token.userPubkey) || {
                        pubkey: token.userPubkey,
                        holderPositions: 0,
                        createdPositions: 0
                    };
                    user.createdPositions += 1;
                    userPointsMap.set(token.userPubkey, user);
                }
            });

            // v13.0: Fetch from Redis for cross-process consistency
            const asdfTop100Holders = await redis.getAsdfTop100Holders();
            const allUserExpectedAirdrops = await redis.getAllUserExpectedAirdrops();

            const eligibleUsers = [];
            let calculatedTotalPoints = 0;

            for (const user of userPointsMap.values()) {
                if (user.pubkey === devKeypair.publicKey.toString()) continue;

                const isAsdfTop50 = asdfTop100Holders.has(user.pubkey);
                const multiplier = isAsdfTop50 ? 2 : 1;
                const totalBasePoints = user.holderPositions + (user.createdPositions * 2);
                const points = totalBasePoints * multiplier;
                const expectedAirdrop = allUserExpectedAirdrops.get(user.pubkey) || 0;

                if (points > 0) {
                    eligibleUsers.push({
                        pubkey: user.pubkey,
                        points,
                        positions: user.holderPositions,
                        created: user.createdPositions,
                        isAsdfTop50,
                        expectedAirdrop,
                        expectedAirdropCurrency: 'SOL' // v11.0: Now in SOL
                    });
                    calculatedTotalPoints += points;
                }
            }

            res.json({ users: eligibleUsers, totalPoints: calculatedTotalPoints, currency: 'SOL' });
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Airdrop logs
    router.get('/airdrop-logs', async (req, res) => {
        try {
            const logs = await db.all('SELECT * FROM airdrop_logs ORDER BY timestamp DESC LIMIT 20');
            res.json(logs);
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // ========== ROBINHOOD BOT ENDPOINTS (v12.0) ==========

    // Get all Robinhood tokens (external tokens sharing fees with us)
    router.get('/robinhood/tokens', async (req, res) => {
        try {
            const tokens = await db.all(`
                SELECT mint, ticker, name, image, "creatorPubkey", "feeShareBps",
                       "isGraduated", "discoveredAt", "totalFeesCollected", volume24h, "marketCap", "isActive"
                FROM robinhood_tokens
                WHERE "isActive" = 1
                ORDER BY "totalFeesCollected" DESC
            `);

            const formattedTokens = tokens.map(t => ({
                mint: t.mint,
                ticker: t.ticker || 'Unknown',
                name: t.name || 'Robinhood Token',
                image: t.image,
                creator: t.creatorPubkey,
                feeSharePercent: t.feeShareBps / 100,
                isGraduated: !!t.isGraduated,
                discoveredAt: t.discoveredAt,
                totalFeesCollected: t.totalFeesCollected || 0,
                volume24h: t.volume24h || 0,
                marketCap: t.marketCap || 0
            }));

            res.json({
                tokens: formattedTokens,
                count: tokens.length,
                lastUpdate: globalState.lastBackendUpdate
            });
        } catch (e) {
            res.status(500).json({ error: "DB Error", tokens: [] });
        }
    });

    // Get holders for a specific Robinhood token
    router.get('/robinhood/holders/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            const holders = await db.all(
                'SELECT rank, "holderPubkey" FROM robinhood_token_holders WHERE mint = $1 ORDER BY rank ASC LIMIT 50',
                [mint]
            );
            res.json(holders);
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Get Robinhood stats summary
    router.get('/robinhood/stats', async (req, res) => {
        try {
            const tokenCount = await db.get('SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1');
            const totalFees = await db.get('SELECT SUM("totalFeesCollected") as total FROM robinhood_tokens');
            const holderCount = await db.get('SELECT COUNT(DISTINCT "holderPubkey") as count FROM robinhood_token_holders');
            const stats = await db.get('SELECT value FROM stats WHERE key = $1', ['lifetimeRobinhoodFeesLamports']);

            res.json({
                activeTokens: parseInt(tokenCount?.count) || 0,
                totalFeesCollectedSol: totalFees?.total || 0,
                uniqueHolders: parseInt(holderCount?.count) || 0,
                lifetimeFeesLamports: stats?.value || 0
            });
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Check if a user holds any Robinhood tokens
    router.get('/robinhood/check-holder', async (req, res) => {
        const { userPubkey } = req.query;
        if (!userPubkey) {
            return res.json({ isRobinhoodHolder: false, positions: 0 });
        }
        if (!isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }

        try {
            const result = await db.get(
                'SELECT COUNT(*) as count FROM robinhood_token_holders WHERE "holderPubkey" = $1',
                [userPubkey]
            );

            res.json({
                isRobinhoodHolder: (parseInt(result?.count) || 0) > 0,
                positions: parseInt(result?.count) || 0
            });
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    return router;
}

module.exports = { init };
