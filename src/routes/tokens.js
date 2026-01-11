/**
 * Token Routes
 * Token listing, leaderboard, and holder endpoints
 * v13.0 - Updated for PostgreSQL
 * v14.0 - Updated for proportional point system (Top 250 holders)
 * v15.0 - Added developer token registration endpoint
 * v18.0 - Changed from top 10 to volume threshold eligibility
 */
const express = require('express');
const axios = require('axios');
const { isValidPubkey } = require('./solana');
const { redis, mintExtractor, logger } = require('../services');
const config = require('../config/env');

const router = express.Router();

// v18.0: Minimum 24hr volume for airdrop eligibility
const MIN_VOLUME_USD = config.AIRDROP_MIN_VOLUME_USD || 100;

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { db, globalState, devKeypair, connection } = deps;

    // Get all launches - SCALABILITY FIX: Added pagination
    // v18.0: Added eligibility status based on volume threshold
    router.get('/all-launches', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100
            const offset = parseInt(req.query.offset) || 0;

            const rows = await db.all('SELECT * FROM tokens ORDER BY volume24h DESC LIMIT $1 OFFSET $2', [limit, offset]);
            const total = await db.get('SELECT COUNT(*) as count FROM tokens');
            const allLaunches = rows.map(r => ({
                mint: r.mint,
                userPubkey: r.userPubkey,
                name: r.name,
                ticker: r.ticker,
                image: r.image,
                metadataUri: r.metadataUri,
                marketCap: r.marketCap || 0,
                volume: r.volume24h,
                complete: !!r.complete,
                // v18.0: Eligibility based on volume threshold
                isEligible: (r.volume24h || 0) >= MIN_VOLUME_USD
            }));
            res.json({
                tokens: allLaunches,
                lastUpdate: globalState.lastBackendUpdate,
                pagination: { limit, offset, total: parseInt(total?.count) || 0 },
                eligibilityThreshold: MIN_VOLUME_USD // v18.0: Include threshold for frontend
            });
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
    // v18.0: Now includes eligibility status based on volume threshold
    router.get('/leaderboard', async (req, res) => {
        const { userPubkey } = req.query;
        // Validate userPubkey if provided
        if (userPubkey && !isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }
        try {
            // Combine launched tokens and active robinhood tokens
            // Use UNION ALL to merge both sources, preserving creator info
            // v18.0: Removed LIMIT 10 to show all tokens, eligibility determined by volume threshold
            const rows = await db.all(`
                SELECT mint, "userPubkey" as creator, name, ticker, image, "metadataUri", "marketCap", volume24h, complete, 'launched' as source
                FROM tokens
                UNION ALL
                SELECT mint, "creatorPubkey" as creator, name, ticker, image, NULL as "metadataUri", "marketCap", volume24h, "isGraduated" as complete, 'robinhood' as source
                FROM robinhood_tokens
                WHERE "isActive" = 1
                ORDER BY volume24h DESC
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
                isRobinhood: r.source === 'robinhood',
                // v18.0: Eligibility based on volume threshold ($100 minimum)
                isEligible: (r.volume24h || 0) >= MIN_VOLUME_USD
            }));
            res.json({
                tokens: leaderboard,
                lastUpdate: globalState.lastBackendUpdate,
                eligibilityThreshold: MIN_VOLUME_USD // v18.0: Include threshold for frontend display
            });
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
    // v14.0: Now returns top 250 holders with balance info
    router.get('/token-holders/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            const holders = await db.all(
                'SELECT rank, "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC LIMIT 250',
                [mint]
            );
            res.json(holders);
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Check holder status
    // v11.0: Now returns expected SOL airdrop amount instead of PUMP
    // v14.0: Updated for proportional point system (Top 250 holders)
    // v18.0: Changed from top 10 to all tokens with >$100 volume
    router.get('/check-holder', async (req, res) => {
        const { userPubkey } = req.query;
        if (!userPubkey) {
            return res.json({
                isHolder: false, isAsdfTop50: false, points: 0,
                multiplier: 1, heldPositionsCount: 0, createdPositionsCount: 0,
                basePoints: 0, creatorBonus: 0, robinhoodPoints: 0,
                expectedAirdrop: 0, expectedAirdropCurrency: 'SOL'
            });
        }
        if (!isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }

        try {
            // v18.0: Get all tokens with >$100 24hr volume (no limit)
            const eligibleTokens = await db.all(
                'SELECT mint, "userPubkey" FROM tokens WHERE volume24h >= $1 ORDER BY volume24h DESC',
                [MIN_VOLUME_USD]
            );
            const eligibleMints = eligibleTokens.map(t => t.mint);

            let heldPositionsCount = 0;
            let createdPositionsCount = 0;
            let basePoints = 0;
            let creatorBonus = 0;
            let robinhoodPoints = 0;

            const POINTS_PER_TOKEN = 1000;

            if (eligibleMints.length > 0) {
                // v18.0: Calculate proportional points for all eligible tokens (>$100 volume)
                for (const token of eligibleTokens) {
                    if (!token.mint) continue;

                    // Check if user holds this token
                    const userHolding = await db.get(
                        'SELECT balance FROM token_holders WHERE mint = $1 AND "holderPubkey" = $2',
                        [token.mint, userPubkey]
                    );

                    if (userHolding && userHolding.balance) {
                        heldPositionsCount++;

                        // Get total balance of all top 250 holders for this token
                        const totalResult = await db.get(
                            'SELECT SUM(CAST(balance AS BIGINT)) as total FROM token_holders WHERE mint = $1',
                            [token.mint]
                        );
                        const totalBalance = BigInt(totalResult?.total || '1');
                        const userBalance = BigInt(userHolding.balance);

                        // Calculate proportional points
                        const proportionalPts = Number((userBalance * BigInt(POINTS_PER_TOKEN * 1000)) / totalBalance) / 1000;
                        basePoints += proportionalPts;

                        // Check if user is creator (2x bonus)
                        if (token.userPubkey === userPubkey) {
                            createdPositionsCount++;
                            creatorBonus += proportionalPts; // Add bonus (already got base, so this doubles it)
                        }
                    } else if (token.userPubkey === userPubkey) {
                        // Creator but not holder
                        createdPositionsCount++;
                    }
                }

                // v14.0: Include Robinhood token holdings
                // v16.0: Scale points by fee share percentage
                // v18.0: All robinhood tokens with >$100 volume
                const robinhoodTokens = await db.all(
                    'SELECT mint, "feeShareBps" FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL AND volume24h >= $1',
                    [MIN_VOLUME_USD]
                );
                for (const rhToken of robinhoodTokens) {
                    if (!rhToken.mint) continue;

                    const userHolding = await db.get(
                        'SELECT balance FROM robinhood_token_holders WHERE mint = $1 AND "holderPubkey" = $2',
                        [rhToken.mint, userPubkey]
                    );

                    if (userHolding && userHolding.balance) {
                        const totalResult = await db.get(
                            'SELECT SUM(CAST(balance AS BIGINT)) as total FROM robinhood_token_holders WHERE mint = $1',
                            [rhToken.mint]
                        );
                        const totalBalance = BigInt(totalResult?.total || '1');
                        const userBalance = BigInt(userHolding.balance);

                        // Calculate base proportional points
                        const baseProportionalPts = Number((userBalance * BigInt(POINTS_PER_TOKEN * 1000)) / totalBalance) / 1000;
                        // Scale by fee share percentage (100% = 10000 bps = 1.0 multiplier)
                        const feeShareBps = rhToken.feeShareBps || 10000;
                        const feeShareMultiplier = feeShareBps / 10000;
                        const scaledPts = baseProportionalPts * feeShareMultiplier;

                        robinhoodPoints += scaledPts;
                    }
                }
            }

            // v13.0: Fetch from Redis for cross-process consistency
            const isAsdfTop50 = await redis.isAsdfTop100Holder(userPubkey);
            const multiplier = isAsdfTop50 ? 2 : 1;
            const totalBasePoints = basePoints + creatorBonus + robinhoodPoints;
            const points = totalBasePoints * multiplier;
            const expectedAirdrop = await redis.getUserExpectedAirdrop(userPubkey);

            res.json({
                isHolder: heldPositionsCount > 0,
                isAsdfTop50,
                points: Math.round(points * 100) / 100, // Round to 2 decimal places
                multiplier,
                heldPositionsCount,
                createdPositionsCount,
                basePoints: Math.round(basePoints * 100) / 100,
                creatorBonus: Math.round(creatorBonus * 100) / 100,
                robinhoodPoints: Math.round(robinhoodPoints * 100) / 100,
                expectedAirdrop,
                expectedAirdropCurrency: 'SOL' // v11.0: Now in SOL
            });
        } catch (e) {
            res.status(500).json({ error: "DB Error", expectedAirdrop: 0 });
        }
    });

    // v18.0: Get detailed holdings breakdown for a user
    // Returns each token the user holds, eligibility status, and points earned
    router.get('/user-holdings', async (req, res) => {
        const { userPubkey } = req.query;
        if (!userPubkey) {
            return res.json({ holdings: [], totalPoints: 0, eligibilityThreshold: MIN_VOLUME_USD });
        }
        if (!isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }

        try {
            const POINTS_PER_TOKEN = 1000;
            const holdings = [];

            // Get all tokens (both eligible and non-eligible) where user is a holder
            const allTokens = await db.all(
                'SELECT t.mint, t.ticker, t.name, t.image, t."userPubkey" as creator, t.volume24h, t."marketCap" FROM tokens t ORDER BY t.volume24h DESC'
            );

            for (const token of allTokens) {
                if (!token.mint) continue;

                // Check if user holds this token
                const userHolding = await db.get(
                    'SELECT balance, rank FROM token_holders WHERE mint = $1 AND "holderPubkey" = $2',
                    [token.mint, userPubkey]
                );

                if (!userHolding) continue;

                // Get total balance for proportional calculation
                const totalResult = await db.get(
                    'SELECT SUM(CAST(balance AS BIGINT)) as total FROM token_holders WHERE mint = $1',
                    [token.mint]
                );
                const totalBalance = BigInt(totalResult?.total || '1');
                const userBalance = BigInt(userHolding.balance);

                // Calculate proportional points
                const proportionalPts = Number((userBalance * BigInt(POINTS_PER_TOKEN * 1000)) / totalBalance) / 1000;

                // Check if user is creator
                const isCreator = token.creator === userPubkey;
                const creatorBonus = isCreator ? proportionalPts : 0;

                // Check eligibility based on volume threshold
                const isEligible = (token.volume24h || 0) >= MIN_VOLUME_USD;

                holdings.push({
                    mint: token.mint,
                    ticker: token.ticker,
                    name: token.name,
                    image: token.image,
                    volume24h: token.volume24h || 0,
                    marketCap: token.marketCap || 0,
                    rank: userHolding.rank,
                    isEligible,
                    isCreator,
                    basePoints: isEligible ? Math.round(proportionalPts * 100) / 100 : 0,
                    creatorBonus: isEligible ? Math.round(creatorBonus * 100) / 100 : 0,
                    totalPoints: isEligible ? Math.round((proportionalPts + creatorBonus) * 100) / 100 : 0,
                    source: 'launched'
                });
            }

            // Also check Robinhood tokens
            const allRobinhoodTokens = await db.all(
                'SELECT mint, ticker, name, image, "feeShareBps", volume24h, "marketCap" FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL ORDER BY volume24h DESC'
            );

            for (const rhToken of allRobinhoodTokens) {
                if (!rhToken.mint) continue;

                const userHolding = await db.get(
                    'SELECT balance, rank FROM robinhood_token_holders WHERE mint = $1 AND "holderPubkey" = $2',
                    [rhToken.mint, userPubkey]
                );

                if (!userHolding) continue;

                const totalResult = await db.get(
                    'SELECT SUM(CAST(balance AS BIGINT)) as total FROM robinhood_token_holders WHERE mint = $1',
                    [rhToken.mint]
                );
                const totalBalance = BigInt(totalResult?.total || '1');
                const userBalance = BigInt(userHolding.balance);

                // Calculate proportional points scaled by fee share
                const baseProportionalPts = Number((userBalance * BigInt(POINTS_PER_TOKEN * 1000)) / totalBalance) / 1000;
                const feeShareBps = rhToken.feeShareBps || 10000;
                const feeShareMultiplier = feeShareBps / 10000;
                const scaledPts = baseProportionalPts * feeShareMultiplier;

                const isEligible = (rhToken.volume24h || 0) >= MIN_VOLUME_USD;

                holdings.push({
                    mint: rhToken.mint,
                    ticker: rhToken.ticker,
                    name: rhToken.name,
                    image: rhToken.image,
                    volume24h: rhToken.volume24h || 0,
                    marketCap: rhToken.marketCap || 0,
                    rank: userHolding.rank,
                    isEligible,
                    isCreator: false,
                    feeSharePercent: (feeShareBps / 100),
                    basePoints: isEligible ? Math.round(scaledPts * 100) / 100 : 0,
                    creatorBonus: 0,
                    totalPoints: isEligible ? Math.round(scaledPts * 100) / 100 : 0,
                    source: 'robinhood'
                });
            }

            // Calculate total points
            const totalPoints = holdings.reduce((sum, h) => sum + h.totalPoints, 0);

            res.json({
                holdings: holdings.sort((a, b) => b.totalPoints - a.totalPoints),
                totalPoints: Math.round(totalPoints * 100) / 100,
                eligibilityThreshold: MIN_VOLUME_USD
            });
        } catch (e) {
            logger.error('User holdings error', { error: e.message });
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Eligible users for airdrop
    // v11.0: Now returns expected SOL airdrop amounts
    // v14.0: Updated for proportional point system (Top 250 holders)
    // v18.0: Changed from top 10 to all tokens with >$100 volume
    router.get('/all-eligible-users', async (req, res) => {
        try {
            // v18.0: Get all tokens with >$100 24hr volume (no limit)
            const eligibleTokens = await db.all(
                'SELECT mint, "userPubkey" FROM tokens WHERE volume24h >= $1 ORDER BY volume24h DESC',
                [MIN_VOLUME_USD]
            );
            const eligibleMints = eligibleTokens.map(t => t.mint);

            if (eligibleMints.length === 0) {
                return res.json({ users: [], totalPoints: 0, currency: 'SOL', eligibilityThreshold: MIN_VOLUME_USD });
            }

            const POINTS_PER_TOKEN = 1000;
            let userPointsMap = new Map(); // pubkey -> { basePoints, creatorBonus, robinhoodPoints, positions, created }

            // v18.0: Calculate proportional points for all eligible tokens (>$100 volume)
            for (const token of eligibleTokens) {
                if (!token.mint) continue;

                // Get all holders with balances
                const holders = await db.all(
                    'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1',
                    [token.mint]
                );

                if (holders.length === 0) continue;

                // Calculate total balance
                let totalBalance = BigInt(0);
                for (const h of holders) {
                    totalBalance += BigInt(h.balance || '0');
                }

                if (totalBalance === BigInt(0)) continue;

                // Distribute points proportionally
                for (const holder of holders) {
                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance === BigInt(0)) continue;

                    const proportionalPts = Number((holderBalance * BigInt(POINTS_PER_TOKEN * 1000)) / totalBalance) / 1000;

                    const user = userPointsMap.get(holder.holderPubkey) || {
                        pubkey: holder.holderPubkey,
                        basePoints: 0,
                        creatorBonus: 0,
                        robinhoodPoints: 0,
                        positions: 0,
                        created: 0
                    };

                    user.basePoints += proportionalPts;
                    user.positions++;

                    // Check if creator
                    if (holder.holderPubkey === token.userPubkey) {
                        user.creatorBonus += proportionalPts; // 2x bonus
                        user.created++;
                    }

                    userPointsMap.set(holder.holderPubkey, user);
                }

                // Handle creators who don't hold their own token
                if (token.userPubkey && !userPointsMap.has(token.userPubkey)) {
                    userPointsMap.set(token.userPubkey, {
                        pubkey: token.userPubkey,
                        basePoints: 0,
                        creatorBonus: 0,
                        robinhoodPoints: 0,
                        positions: 0,
                        created: 1
                    });
                } else if (token.userPubkey) {
                    const existing = userPointsMap.get(token.userPubkey);
                    if (existing && !holders.find(h => h.holderPubkey === token.userPubkey)) {
                        existing.created++;
                    }
                }
            }

            // v14.0: Include Robinhood token holdings
            // v16.0: Scale points by fee share percentage
            // v18.0: All robinhood tokens with >$100 volume
            const robinhoodTokens = await db.all(
                'SELECT mint, "feeShareBps" FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL AND volume24h >= $1',
                [MIN_VOLUME_USD]
            );
            for (const rhToken of robinhoodTokens) {
                if (!rhToken.mint) continue;

                // Get fee share multiplier (100% = 10000 bps = 1.0 multiplier)
                const feeShareBps = rhToken.feeShareBps || 10000;
                const feeShareMultiplier = feeShareBps / 10000;

                const holders = await db.all(
                    'SELECT "holderPubkey", balance FROM robinhood_token_holders WHERE mint = $1',
                    [rhToken.mint]
                );

                if (holders.length === 0) continue;

                let totalBalance = BigInt(0);
                for (const h of holders) {
                    totalBalance += BigInt(h.balance || '0');
                }

                if (totalBalance === BigInt(0)) continue;

                for (const holder of holders) {
                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance === BigInt(0)) continue;

                    // Calculate base proportional points and scale by fee share
                    const baseProportionalPts = Number((holderBalance * BigInt(POINTS_PER_TOKEN * 1000)) / totalBalance) / 1000;
                    const scaledPts = baseProportionalPts * feeShareMultiplier;

                    const user = userPointsMap.get(holder.holderPubkey) || {
                        pubkey: holder.holderPubkey,
                        basePoints: 0,
                        creatorBonus: 0,
                        robinhoodPoints: 0,
                        positions: 0,
                        created: 0
                    };

                    user.robinhoodPoints += scaledPts;
                    userPointsMap.set(holder.holderPubkey, user);
                }
            }

            // v13.0: Fetch from Redis for cross-process consistency
            const asdfTop100Holders = await redis.getAsdfTop100Holders();
            const allUserExpectedAirdrops = await redis.getAllUserExpectedAirdrops();

            const eligibleUsers = [];
            let calculatedTotalPoints = 0;

            for (const user of userPointsMap.values()) {
                if (user.pubkey === devKeypair.publicKey.toString()) continue;

                const isAsdfTop50 = asdfTop100Holders.has(user.pubkey);
                const multiplier = isAsdfTop50 ? 2 : 1;
                const totalBasePoints = user.basePoints + user.creatorBonus + user.robinhoodPoints;
                const points = totalBasePoints * multiplier;
                const expectedAirdrop = allUserExpectedAirdrops.get(user.pubkey) || 0;

                if (points > 0) {
                    eligibleUsers.push({
                        pubkey: user.pubkey,
                        points: Math.round(points * 100) / 100,
                        positions: user.positions,
                        created: user.created,
                        isAsdfTop50,
                        expectedAirdrop,
                        expectedAirdropCurrency: 'SOL' // v11.0: Now in SOL
                    });
                    calculatedTotalPoints += points;
                }
            }

            res.json({
                users: eligibleUsers,
                totalPoints: Math.round(calculatedTotalPoints * 100) / 100,
                currency: 'SOL',
                eligibilityThreshold: MIN_VOLUME_USD // v18.0: Include threshold for frontend display
            });
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

    // ========== TOKEN REGISTRATION ENDPOINT (v16.0) ==========
    // Allows anyone to register tokens that share fees with our platform wallet
    // Verifies our central wallet is listed as a fee recipient on-chain

    /**
     * POST /register-token
     * Register a token for the platform
     *
     * Required:
     * - mint: Token mint address
     *
     * Optional:
     * - submitterPubkey: Wallet of the person submitting (for tracking)
     *
     * The endpoint verifies that our platform wallet (devKeypair) is a fee
     * recipient for the token by checking on-chain bonding curve and AMM pool data.
     * This ensures only tokens that share fees with us can be registered.
     */
    router.post('/register-token', async (req, res) => {
        try {
            const { mint, submitterPubkey } = req.body;

            // Validate inputs
            if (!mint) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required field: mint'
                });
            }

            if (!isValidPubkey(mint)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid mint address'
                });
            }

            // Check if token is already registered in either tokens or robinhood_tokens table
            const existingToken = await db.get('SELECT id, mint FROM tokens WHERE mint = $1', [mint]);
            const existingRobinhoodToken = await db.get('SELECT id, mint FROM robinhood_tokens WHERE mint = $1', [mint]);

            if (existingToken || existingRobinhoodToken) {
                return res.status(409).json({
                    success: false,
                    error: 'Token already registered',
                    mint
                });
            }

            // Get our platform wallet address
            const platformWallet = devKeypair.publicKey.toString();

            // Verify that our platform wallet is a fee recipient on-chain
            // This checks bonding curve, AMM pool, AND fee sharing configs
            logger.info(`[TokenRegistration] Verifying platform wallet is fee recipient for ${mint.slice(0, 8)}...`);

            const verification = await mintExtractor.verifyFeeRecipient(
                mint,
                platformWallet,
                connection
            );

            if (!verification.isRecipient) {
                logger.warn(`[TokenRegistration] Rejected: Platform wallet is not fee recipient for ${mint.slice(0, 8)}...`);
                return res.status(403).json({
                    success: false,
                    error: 'Verification failed: This token does not share fees with the IGNITION platform. The token creator must add our wallet as a fee recipient on Pump.fun.',
                    mint,
                    platformWallet
                });
            }

            // Log the fee share details
            logger.info(`[TokenRegistration] Verified: Platform wallet is fee recipient via ${verification.source} (${verification.feeSharePercent}% share, ${verification.feeShareBps} bps)`);

            // Fetch token metadata
            const validTokens = await mintExtractor.validateMintsBatch([mint], { fetchMarketData: true });

            if (validTokens.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Could not fetch token metadata. Ensure this is a valid Pump.fun token.',
                    mint
                });
            }

            const token = validTokens[0];

            // Determine where to insert based on fee share source
            // If we're a direct creator (100% share), insert into tokens table
            // If we're a shareholder (< 100% share), insert into robinhood_tokens table
            const isDirectCreator = verification.source === 'bonding_curve' || verification.source === 'amm_pool';

            if (isDirectCreator) {
                // Direct creator - insert into tokens table
                const registeredBy = submitterPubkey && isValidPubkey(submitterPubkey)
                    ? submitterPubkey
                    : 'platform_registered';

                await db.run(`
                    INSERT INTO tokens ("userPubkey", mint, ticker, name, description, twitter, website, "metadataUri", image, "isMayhemMode", timestamp, volume24h, "priceUsd", "marketCap", complete)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                `, [
                    registeredBy,
                    token.mint,
                    token.ticker,
                    token.name,
                    token.description || '',
                    token.twitter || '',
                    token.website || '',
                    token.metadataUri || '',
                    token.image || '',
                    0,
                    Date.now(),
                    token.volume24h || 0,
                    token.priceUsd || 0,
                    token.marketCap || 0,
                    0
                ]);

                logger.info(`[TokenRegistration] Registered as DIRECT CREATOR: ${token.ticker} (${mint.slice(0, 8)}...) - 100% fee share`);
            } else {
                // Fee shareholder - insert into robinhood_tokens table
                const creatorPubkey = submitterPubkey && isValidPubkey(submitterPubkey)
                    ? submitterPubkey
                    : 'unknown_creator';

                await db.run(`
                    INSERT INTO robinhood_tokens (mint, ticker, name, image, "creatorPubkey", "feeShareBps", "discoveredAt", "marketCap", volume24h, "isActive")
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
                `, [
                    token.mint,
                    token.ticker,
                    token.name,
                    token.image || '',
                    creatorPubkey,
                    verification.feeShareBps,
                    Date.now(),
                    token.marketCap || 0,
                    token.volume24h || 0
                ]);

                logger.info(`[TokenRegistration] Registered as FEE SHAREHOLDER: ${token.ticker} (${mint.slice(0, 8)}...) - ${verification.feeSharePercent}% fee share (${verification.feeShareBps} bps)`);
            }

            res.json({
                success: true,
                message: 'Token registered successfully! Fee sharing verified.',
                token: {
                    mint: token.mint,
                    ticker: token.ticker,
                    name: token.name,
                    image: token.image,
                    marketCap: token.marketCap,
                    volume24h: token.volume24h,
                    verifiedVia: verification.source,
                    feeSharePercent: verification.feeSharePercent,
                    feeShareBps: verification.feeShareBps,
                    isDirectCreator
                }
            });

        } catch (e) {
            logger.error('[TokenRegistration] Error', { error: e.message, stack: e.stack });
            res.status(500).json({
                success: false,
                error: 'Internal server error during registration'
            });
        }
    });

    /**
     * GET /check-registration/:mint
     * Check if a token is registered and get its status
     */
    router.get('/check-registration/:mint', async (req, res) => {
        try {
            const { mint } = req.params;

            if (!isValidPubkey(mint)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid mint address'
                });
            }

            const token = await db.get(
                'SELECT mint, ticker, name, image, "userPubkey", "marketCap", volume24h, timestamp FROM tokens WHERE mint = $1',
                [mint]
            );

            if (token) {
                res.json({
                    registered: true,
                    token: {
                        mint: token.mint,
                        ticker: token.ticker,
                        name: token.name,
                        image: token.image,
                        creator: token.userPubkey,
                        marketCap: token.marketCap,
                        volume24h: token.volume24h,
                        registeredAt: token.timestamp
                    }
                });
            } else {
                res.json({
                    registered: false,
                    mint
                });
            }
        } catch (e) {
            res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }
    });

    /**
     * POST /verify-token
     * Pre-check if our platform wallet is a fee recipient for a token (without registering)
     * Useful for frontend validation before attempting registration
     */
    router.post('/verify-token', async (req, res) => {
        try {
            const { mint } = req.body;

            if (!mint) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required field: mint'
                });
            }

            if (!isValidPubkey(mint)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid mint address'
                });
            }

            // Get our platform wallet address
            const platformWallet = devKeypair.publicKey.toString();

            // Check if already registered in either table
            const existingToken = await db.get('SELECT mint, ticker, name FROM tokens WHERE mint = $1', [mint]);
            const existingRobinhoodToken = await db.get('SELECT mint, ticker, name FROM robinhood_tokens WHERE mint = $1', [mint]);

            if (existingToken || existingRobinhoodToken) {
                return res.json({
                    success: true,
                    isEligible: false,
                    alreadyRegistered: true,
                    token: existingToken || existingRobinhoodToken,
                    mint
                });
            }

            // Verify platform wallet is fee recipient
            const verification = await mintExtractor.verifyFeeRecipient(
                mint,
                platformWallet,
                connection
            );

            // Also fetch token metadata for preview
            let tokenPreview = null;
            if (verification.isRecipient) {
                try {
                    const validTokens = await mintExtractor.validateMintsBatch([mint], { fetchMarketData: true });
                    if (validTokens.length > 0) {
                        tokenPreview = {
                            ticker: validTokens[0].ticker,
                            name: validTokens[0].name,
                            image: validTokens[0].image,
                            marketCap: validTokens[0].marketCap,
                            volume24h: validTokens[0].volume24h
                        };
                    }
                } catch (e) {
                    // Metadata fetch failed, but verification still valid
                }
            }

            res.json({
                success: true,
                isEligible: verification.isRecipient,
                alreadyRegistered: false,
                source: verification.source,
                feeSharePercent: verification.feeSharePercent,
                feeShareBps: verification.feeShareBps,
                isDirectCreator: verification.source === 'bonding_curve' || verification.source === 'amm_pool',
                mint,
                platformWallet,
                tokenPreview
            });

        } catch (e) {
            res.status(500).json({
                success: false,
                error: 'Verification error'
            });
        }
    });

    // ========== DIAGNOSTIC ENDPOINT ==========
    // Provides database health check and token count information
    router.get('/debug/db-status', async (req, res) => {
        try {
            const tokenCount = await db.get('SELECT COUNT(*) as count FROM tokens');
            const robinhoodCount = await db.get('SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1');
            const holderCount = await db.get('SELECT COUNT(*) as count FROM token_holders');
            const recentTokens = await db.all('SELECT mint, ticker, name, timestamp FROM tokens ORDER BY timestamp DESC LIMIT 5');
            const lastBackendUpdate = await redis.getLastBackendUpdate();

            res.json({
                status: 'connected',
                tables: {
                    tokens: parseInt(tokenCount?.count) || 0,
                    robinhood_tokens: parseInt(robinhoodCount?.count) || 0,
                    token_holders: parseInt(holderCount?.count) || 0
                },
                recentTokens: recentTokens.map(t => ({
                    mint: t.mint,
                    ticker: t.ticker,
                    name: t.name,
                    createdAt: t.timestamp ? new Date(t.timestamp).toISOString() : null
                })),
                lastBackendUpdate: lastBackendUpdate ? new Date(lastBackendUpdate).toISOString() : null,
                serverTime: new Date().toISOString()
            });
        } catch (e) {
            res.status(500).json({
                status: 'error',
                error: e.message,
                serverTime: new Date().toISOString()
            });
        }
    });

    return router;
}

module.exports = { init };
