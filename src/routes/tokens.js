/**
 * Token Routes
 * Token listing, leaderboard, and holder endpoints
 */
const express = require('express');
const { isValidPubkey } = require('./solana');

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
                SELECT mint, userPubkey, name, ticker, image, marketCap, volume24h 
                FROM tokens 
                WHERE marketCap > 0 
                ORDER BY marketCap DESC 
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

    // Leaderboard
    router.get('/leaderboard', async (req, res) => {
        const { userPubkey } = req.query;
        // Validate userPubkey if provided
        if (userPubkey && !isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }
        try {
            const rows = await db.all('SELECT * FROM tokens ORDER BY volume24h DESC LIMIT 10');

            // Batch query for user holder status (avoid N+1)
            let userHoldings = new Set();
            if (userPubkey && rows.length > 0) {
                const mints = rows.map(r => r.mint);
                const placeholders = mints.map(() => '?').join(',');
                const holdings = await db.all(
                    `SELECT mint FROM token_holders WHERE holderPubkey = ? AND mint IN (${placeholders})`,
                    [userPubkey, ...mints]
                );
                userHoldings = new Set(holdings.map(h => h.mint));
            }

            const leaderboard = rows.map(r => ({
                mint: r.mint,
                creator: r.userPubkey,
                name: r.name,
                ticker: r.ticker,
                image: r.image,
                metadataUri: r.metadataUri,
                price: (r.marketCap / 1000000000).toFixed(6),
                marketCap: r.marketCap || 0,
                volume: r.volume24h,
                isUserTopHolder: userHoldings.has(r.mint),
                complete: !!r.complete
            }));
            res.json({ tokens: leaderboard, lastUpdate: globalState.lastBackendUpdate });
        } catch (e) {
            res.status(500).json({ tokens: [], lastUpdate: Date.now() });
        }
    });

    // Recent launches
    router.get('/recent-launches', async (req, res) => {
        try {
            const rows = await db.all('SELECT userPubkey, ticker, mint, timestamp FROM tokens ORDER BY timestamp DESC LIMIT 10');
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
            const token = await db.get('SELECT tweetUrl FROM tokens WHERE mint = ?', [mint]);
            res.json(token || {});
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Token holders
    router.get('/token-holders/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            const holders = await db.all(
                'SELECT rank, holderPubkey FROM token_holders WHERE mint = ? ORDER BY rank ASC LIMIT 50',
                [mint]
            );
            res.json(holders);
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Check holder status
    router.get('/check-holder', async (req, res) => {
        const { userPubkey } = req.query;
        if (!userPubkey) {
            return res.json({
                isHolder: false, isAsdfTop50: false, points: 0,
                multiplier: 1, heldPositionsCount: 0, createdPositionsCount: 0, expectedAirdrop: 0
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
                const placeholders = top10Mints.map(() => '?').join(',');

                const query = `SELECT COUNT(*) as count FROM token_holders WHERE holderPubkey = ? AND mint IN (${placeholders})`;
                const result = await db.get(query, [userPubkey, ...top10Mints]);
                heldPositionsCount = result?.count || 0;

                const creatorQuery = `SELECT COUNT(*) as count FROM tokens WHERE userPubkey = ? AND mint IN (${placeholders})`;
                const creatorRes = await db.get(creatorQuery, [userPubkey, ...top10Mints]);
                createdPositionsCount = creatorRes?.count || 0;
            }

            const isAsdfTop50 = globalState.asdfTop50Holders.has(userPubkey);
            const totalBase = heldPositionsCount + (createdPositionsCount * 2);
            const multiplier = isAsdfTop50 ? 2 : 1;
            const points = totalBase * multiplier;
            const expectedAirdrop = globalState.userExpectedAirdrops.get(userPubkey) || 0;

            res.json({
                isHolder: heldPositionsCount > 0,
                isAsdfTop50,
                points,
                multiplier,
                heldPositionsCount,
                createdPositionsCount,
                expectedAirdrop
            });
        } catch (e) {
            res.status(500).json({ error: "DB Error", expectedAirdrop: 0 });
        }
    });

    // Eligible users for airdrop
    router.get('/all-eligible-users', async (req, res) => {
        try {
            const top10 = await db.all('SELECT mint, userPubkey FROM tokens ORDER BY volume24h DESC LIMIT 10');
            const top10Mints = top10.map(t => t.mint);

            if (top10Mints.length === 0) {
                return res.json({ users: [], totalPoints: 0 });
            }

            const placeholders = top10Mints.map(() => '?').join(',');
            const rows = await db.all(`
                SELECT holderPubkey, COUNT(*) as positionCount
                FROM token_holders
                WHERE mint IN (${placeholders})
                GROUP BY holderPubkey
            `, top10Mints);

            let userPointsMap = new Map();

            rows.forEach(row => {
                userPointsMap.set(row.holderPubkey, {
                    pubkey: row.holderPubkey,
                    holderPositions: row.positionCount,
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

            const eligibleUsers = [];
            let calculatedTotalPoints = 0;

            for (const user of userPointsMap.values()) {
                if (user.pubkey === devKeypair.publicKey.toString()) continue;

                const isAsdfTop50 = globalState.asdfTop50Holders.has(user.pubkey);
                const multiplier = isAsdfTop50 ? 2 : 1;
                const totalBasePoints = user.holderPositions + (user.createdPositions * 2);
                const points = totalBasePoints * multiplier;
                const expectedAirdrop = globalState.userExpectedAirdrops.get(user.pubkey) || 0;

                if (points > 0) {
                    eligibleUsers.push({
                        pubkey: user.pubkey,
                        points,
                        positions: user.holderPositions,
                        created: user.createdPositions,
                        isAsdfTop50,
                        expectedAirdrop
                    });
                    calculatedTotalPoints += points;
                }
            }

            res.json({ users: eligibleUsers, totalPoints: calculatedTotalPoints });
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

    return router;
}

module.exports = { init };
