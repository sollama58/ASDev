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
const { PublicKey } = require('@solana/web3.js');
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

                if (!userHolding || !userHolding.balance) continue;

                // Get total balance for proportional calculation
                const totalResult = await db.get(
                    'SELECT SUM(CAST(balance AS BIGINT)) as total FROM token_holders WHERE mint = $1',
                    [token.mint]
                );
                const totalBalance = BigInt(totalResult?.total || '1');
                const userBalance = BigInt(userHolding.balance || '0');
                if (userBalance === BigInt(0)) continue;

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

                if (!userHolding || !userHolding.balance) continue;

                const totalResult = await db.get(
                    'SELECT SUM(CAST(balance AS BIGINT)) as total FROM robinhood_token_holders WHERE mint = $1',
                    [rhToken.mint]
                );
                const totalBalance = BigInt(totalResult?.total || '1');
                const userBalance = BigInt(userHolding.balance || '0');
                if (userBalance === BigInt(0)) continue;

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
     * - originalCreator: Original creator wallet (REQUIRED for fee-shared tokens where
     *   the coin_creator has been changed to a fee_sharing_config PDA. This allows
     *   direct PDA lookup instead of scanning millions of accounts)
     *
     * The endpoint verifies that our platform wallet (devKeypair) is a fee
     * recipient for the token by checking on-chain bonding curve and AMM pool data.
     * This ensures only tokens that share fees with us can be registered.
     */
    router.post('/register-token', async (req, res) => {
        try {
            const { mint, submitterPubkey, originalCreator } = req.body;

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

            // Validate originalCreator if provided (required for fee-shared tokens)
            if (originalCreator && !isValidPubkey(originalCreator)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid originalCreator address'
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
            // coin_creator field IS the fee_sharing_config PDA when fee sharing is enabled
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
     *
     * Required:
     * - mint: Token mint address
     *
     * Optional:
     * - originalCreator: Original creator wallet (REQUIRED for fee-shared tokens)
     */
    router.post('/verify-token', async (req, res) => {
        try {
            const { mint, originalCreator } = req.body;

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

            // Validate originalCreator if provided
            if (originalCreator && !isValidPubkey(originalCreator)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid originalCreator address'
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
            // coin_creator field IS the fee_sharing_config PDA when fee sharing is enabled
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

    // ========== DIAGNOSTIC ENDPOINTS ==========

    // v19.0: Debug endpoint for expected airdrop calculation
    router.get('/debug/airdrop-calculation', async (req, res) => {
        const { userPubkey } = req.query;

        try {
            // Get global state values
            const totalPoints = await redis.getTotalPoints();
            const availableSol = globalState.availableSolForAirdrop || 0;
            const communityPot = globalState.communityPot || 0;
            const kothPot = globalState.kothPot || 0;

            // Get top 10 expected airdrops for verification
            const allAirdrops = await redis.getAllUserExpectedAirdrops();
            const topAirdrops = Array.from(allAirdrops.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([pubkey, amount]) => ({
                    pubkey: pubkey.slice(0, 8) + '...',
                    expectedAirdropSOL: amount,
                    formattedSOL: amount.toFixed(6)
                }));

            // Get user-specific info if provided
            let userInfo = null;
            if (userPubkey && isValidPubkey(userPubkey)) {
                const expectedAirdrop = await redis.getUserExpectedAirdrop(userPubkey);
                const userPoints = await redis.getUserPoints(userPubkey);

                userInfo = {
                    pubkey: userPubkey,
                    points: userPoints,
                    expectedAirdropSOL: expectedAirdrop,
                    formattedSOL: expectedAirdrop.toFixed(6),
                    shareOfPool: totalPoints > 0 ? ((userPoints / totalPoints) * 100).toFixed(4) + '%' : '0%'
                };
            }

            res.json({
                globalState: {
                    totalPoints,
                    availableSolForAirdrop: availableSol,
                    communityPotSOL: communityPot,
                    kothPotSOL: kothPot,
                    formattedAvailable: availableSol.toFixed(4) + ' SOL',
                    formattedCommunityPot: communityPot.toFixed(4) + ' SOL',
                    formattedKothPot: kothPot.toFixed(4) + ' SOL'
                },
                topExpectedAirdrops: topAirdrops,
                totalUsersWithAirdrop: allAirdrops.size,
                userInfo,
                calculationFormula: 'expectedAirdrop = (userPoints / totalPoints) * communityPot + kothBonus',
                currency: 'SOL',
                serverTime: new Date().toISOString()
            });
        } catch (e) {
            res.status(500).json({
                error: e.message,
                serverTime: new Date().toISOString()
            });
        }
    });

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

    // v19.0: Debug endpoint for fee sharing verification
    // Helps troubleshoot why a token registration might be failing
    router.get('/debug/verify-fee-sharing/:mint', async (req, res) => {
        try {
            const { mint } = req.params;

            if (!isValidPubkey(mint)) {
                return res.status(400).json({ error: 'Invalid mint address' });
            }

            const platformWallet = devKeypair.publicKey.toString();
            const mintPubkey = new PublicKey(mint);

            // Check bonding curve
            const [bondingCurve] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
                new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
            );

            let bcData = null;
            try {
                const bcAccountInfo = await connection.getAccountInfo(bondingCurve);
                if (bcAccountInfo) {
                    bcData = {
                        exists: true,
                        dataLength: bcAccountInfo.data.length,
                        lamports: bcAccountInfo.lamports
                    };
                    // Try to parse creator at offset 49
                    if (bcAccountInfo.data.length >= 81) {
                        const storedCreator = new PublicKey(bcAccountInfo.data.slice(49, 81));
                        bcData.creator = storedCreator.toString();
                        bcData.isWeCreator = storedCreator.toString() === platformWallet;
                    }
                }
            } catch (e) {
                bcData = { exists: false, error: e.message };
            }

            // Check AMM pool
            const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
            const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

            const [poolAuthority] = PublicKey.findProgramAddressSync(
                [Buffer.from("pool-authority"), mintPubkey.toBuffer()],
                PUMP_AMM
            );
            const [pool] = PublicKey.findProgramAddressSync(
                [Buffer.from("pool"), poolAuthority.toBuffer(), mintPubkey.toBuffer(), WSOL.toBuffer()],
                PUMP_AMM
            );

            let ammData = null;
            try {
                const poolAccountInfo = await connection.getAccountInfo(pool);
                if (poolAccountInfo) {
                    ammData = {
                        exists: true,
                        dataLength: poolAccountInfo.data.length,
                        lamports: poolAccountInfo.lamports
                    };
                    // Try to parse creator at offset 11
                    if (poolAccountInfo.data.length >= 43) {
                        const storedCreator = new PublicKey(poolAccountInfo.data.slice(11, 43));
                        ammData.creator = storedCreator.toString();
                        ammData.isWeCreator = storedCreator.toString() === platformWallet;
                    }
                }
            } catch (e) {
                ammData = { exists: false, error: e.message };
            }

            // Scan for fee sharing configs with this mint
            const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

            // Helper to parse fee sharing config
            // ACTUAL Pump.fun fee_sharing_config structure:
            // - 8 bytes: discriminator
            // - 32 bytes: creator (original creator's pubkey)
            // - 4 bytes: shareholder_count (u32)
            // - N * 34 bytes: shareholders (32 byte pubkey + 2 byte bps)
            // NOTE: There is NO mint field in the fee_sharing_config!
            function parseFeeSharingConfigDebug(data, configAddress) {
                try {
                    if (data.length < 44) return null;

                    const creator = new PublicKey(data.slice(8, 40));
                    const shareholderCount = data.readUInt32LE(40);

                    if (shareholderCount < 1 || shareholderCount > 10) return null;

                    const expectedSize = 44 + (shareholderCount * 34);
                    if (data.length < expectedSize) return null;

                    const shareholders = [];
                    let offset = 44;
                    for (let i = 0; i < shareholderCount && offset + 34 <= data.length; i++) {
                        const pubkey = new PublicKey(data.slice(offset, offset + 32));
                        const shareBps = data.readUInt16LE(offset + 32);
                        if (shareBps > 10000) return null; // Invalid bps
                        shareholders.push({
                            pubkey: pubkey.toString(),
                            shareBps,
                            sharePercent: shareBps / 100,
                            isUs: pubkey.toString() === platformWallet
                        });
                        offset += 34;
                    }

                    if (shareholders.length !== shareholderCount) return null;

                    return {
                        configAddress,
                        creator: creator.toString(),
                        shareholderCount,
                        shareholders,
                        dataLength: data.length,
                        weAreShareHolder: shareholders.some(s => s.isUs)
                    };
                } catch (e) {
                    return null;
                }
            }

            // Check if the coin_creator IS a fee sharing config (direct lookup)
            // When fee sharing is enabled, coin_creator is set to the fee_sharing_config PDA
            let directConfigLookup = null;
            let pdaConfigLookup = null;
            const tokenCreator = bcData?.creator ? new PublicKey(bcData.creator) :
                                 (ammData?.creator ? new PublicKey(ammData.creator) : null);

            if (tokenCreator) {
                // Method 1: Check if tokenCreator IS the fee sharing config directly
                try {
                    const directConfigInfo = await connection.getAccountInfo(tokenCreator);
                    if (directConfigInfo) {
                        const isOwnedByPump = directConfigInfo.owner.equals(PUMP);

                        if (isOwnedByPump && directConfigInfo.data.length >= 44) {
                            const parsed = parseFeeSharingConfigDebug(directConfigInfo.data, tokenCreator.toString());
                            if (parsed) {
                                directConfigLookup = {
                                    ...parsed,
                                    method: 'coin_creator_is_config',
                                    owner: directConfigInfo.owner.toString()
                                };
                            }
                        }

                        if (!directConfigLookup) {
                            // Not a valid fee sharing config, log raw data for debugging
                            directConfigLookup = {
                                configAddress: tokenCreator.toString(),
                                owner: directConfigInfo.owner.toString(),
                                isOwnedByPump,
                                dataLength: directConfigInfo.data.length,
                                error: 'Failed to parse as fee_sharing_config',
                                rawDataHex: directConfigInfo.data.slice(0, 100).toString('hex')
                            };
                        }
                    }
                } catch (e) {
                    directConfigLookup = { error: e.message };
                }

                // Method 2: Derive PDA from tokenCreator (in case tokenCreator is original creator, not the config)
                try {
                    const [feeSharingConfigPDA] = PublicKey.findProgramAddressSync(
                        [Buffer.from("fee_sharing_config"), tokenCreator.toBuffer()],
                        PUMP
                    );

                    const pdaAccountInfo = await connection.getAccountInfo(feeSharingConfigPDA);
                    if (pdaAccountInfo) {
                        const isOwnedByPump = pdaAccountInfo.owner.equals(PUMP);

                        if (isOwnedByPump && pdaAccountInfo.data.length >= 44) {
                            const parsed = parseFeeSharingConfigDebug(pdaAccountInfo.data, feeSharingConfigPDA.toString());
                            if (parsed) {
                                pdaConfigLookup = {
                                    ...parsed,
                                    method: 'derived_pda_from_creator',
                                    derivedFrom: tokenCreator.toString(),
                                    owner: pdaAccountInfo.owner.toString()
                                };
                            }
                        }
                    } else {
                        pdaConfigLookup = {
                            pdaAddress: feeSharingConfigPDA.toString(),
                            derivedFrom: tokenCreator.toString(),
                            exists: false
                        };
                    }
                } catch (e) {
                    pdaConfigLookup = { error: e.message };
                }
            }

            // Scan for fee_sharing_configs where platform wallet is a shareholder
            let shareholderConfigs = [];
            let scanDebug = { sizesChecked: [], errors: [], totalAccountsFound: 0 };
            const configSizes = [78, 112, 146, 180, 214]; // 44 base + 34 per shareholder

            for (const dataSize of configSizes) {
                const maxShareholders = Math.floor((dataSize - 44) / 34);
                for (let shIdx = 0; shIdx < maxShareholders; shIdx++) {
                    const offset = 44 + (shIdx * 34);
                    try {
                        scanDebug.sizesChecked.push({ dataSize, shIdx, offset });

                        const accounts = await connection.getProgramAccounts(PUMP, {
                            filters: [
                                { dataSize },
                                { memcmp: { offset, bytes: platformWallet } }
                            ]
                        });

                        scanDebug.totalAccountsFound += accounts.length;

                        for (const acc of accounts) {
                            const parsed = parseFeeSharingConfigDebug(acc.account.data, acc.pubkey.toString());
                            if (parsed) {
                                // Derive expected PDA to verify
                                const creatorPubkey = new PublicKey(parsed.creator);
                                const [expectedPDA] = PublicKey.findProgramAddressSync(
                                    [Buffer.from("fee_sharing_config"), creatorPubkey.toBuffer()],
                                    PUMP
                                );

                                // Derive the creator_vault from this config
                                const [creatorVault] = PublicKey.findProgramAddressSync(
                                    [Buffer.from("creator-vault"), expectedPDA.toBuffer()],
                                    PUMP
                                );

                                shareholderConfigs.push({
                                    ...parsed,
                                    isValidPDA: expectedPDA.toString() === acc.pubkey.toString(),
                                    expectedPDA: expectedPDA.toString(),
                                    derivedCreatorVault: creatorVault.toString(),
                                    tokenCreatorMatches: tokenCreator ? tokenCreator.toString() === creatorVault.toString() : null,
                                    shareholderPosition: shIdx
                                });
                            }
                        }
                    } catch (e) {
                        scanDebug.errors.push({ dataSize, shIdx, error: e.message });
                    }
                }
            }

            // Also try to decode the raw FEE program account data to understand its structure
            let feeAccountAnalysis = null;
            if (directConfigLookup && directConfigLookup.rawDataHex) {
                try {
                    const rawData = Buffer.from(directConfigLookup.rawDataHex, 'hex');
                    // Try to find any pubkeys in the data that might be the original creator
                    const potentialPubkeys = [];
                    for (let i = 0; i <= rawData.length - 32; i++) {
                        try {
                            const pk = new PublicKey(rawData.slice(i, i + 32));
                            // Check if it's a valid pubkey (not all zeros, not all ones)
                            const pkStr = pk.toString();
                            if (pkStr !== '11111111111111111111111111111111' &&
                                !pkStr.startsWith('1111111111')) {
                                potentialPubkeys.push({ offset: i, pubkey: pkStr });
                            }
                        } catch (e) {
                            // Not a valid pubkey at this offset
                        }
                    }
                    feeAccountAnalysis = {
                        dataLength: rawData.length,
                        potentialPubkeys: potentialPubkeys.slice(0, 10) // First 10
                    };
                } catch (e) {
                    feeAccountAnalysis = { error: e.message };
                }
            }

            // Check the known original creator if provided in query string
            let originalCreatorConfig = null;
            const knownOriginalCreator = req.query.originalCreator;
            const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

            if (knownOriginalCreator) {
                try {
                    const originalCreatorPubkey = new PublicKey(knownOriginalCreator);

                    // Try both FEE program and PUMP program for fee_sharing_config PDA
                    const [feeSharingConfigPDA_FEE] = PublicKey.findProgramAddressSync(
                        [Buffer.from("fee_sharing_config"), originalCreatorPubkey.toBuffer()],
                        FEE_PROGRAM
                    );

                    const [feeSharingConfigPDA_PUMP] = PublicKey.findProgramAddressSync(
                        [Buffer.from("fee_sharing_config"), originalCreatorPubkey.toBuffer()],
                        PUMP
                    );

                    // Check FEE program first
                    let configInfo = await connection.getAccountInfo(feeSharingConfigPDA_FEE);
                    let usedPDA = feeSharingConfigPDA_FEE;
                    let programUsed = 'FEE';

                    if (!configInfo) {
                        // Try PUMP program
                        configInfo = await connection.getAccountInfo(feeSharingConfigPDA_PUMP);
                        usedPDA = feeSharingConfigPDA_PUMP;
                        programUsed = 'PUMP';
                    }

                    if (configInfo) {
                        const parsed = parseFeeSharingConfigDebug(configInfo.data, usedPDA.toString());

                        // The coin_creator should be set to the fee_sharing_config PDA itself
                        // when fee sharing is enabled
                        originalCreatorConfig = {
                            originalCreator: knownOriginalCreator,
                            feeSharingConfigPDA_FEE: feeSharingConfigPDA_FEE.toString(),
                            feeSharingConfigPDA_PUMP: feeSharingConfigPDA_PUMP.toString(),
                            foundAt: usedPDA.toString(),
                            programUsed,
                            configExists: true,
                            configOwner: configInfo.owner.toString(),
                            configDataLength: configInfo.data.length,
                            parsed,
                            // Check if tokenCreator matches the fee_sharing_config PDA
                            tokenCreatorMatchesConfigPDA: tokenCreator ? tokenCreator.toString() === usedPDA.toString() : null,
                            rawDataHex: configInfo.data.slice(0, 150).toString('hex')
                        };
                    } else {
                        originalCreatorConfig = {
                            originalCreator: knownOriginalCreator,
                            feeSharingConfigPDA_FEE: feeSharingConfigPDA_FEE.toString(),
                            feeSharingConfigPDA_PUMP: feeSharingConfigPDA_PUMP.toString(),
                            configExists: false
                        };
                    }
                } catch (e) {
                    originalCreatorConfig = { error: e.message };
                }
            }

            // Run the actual verification (pass originalCreator if provided for direct PDA lookup)
            const verification = await mintExtractor.verifyFeeRecipient(mint, platformWallet, connection, knownOriginalCreator);

            res.json({
                mint,
                platformWallet,
                bondingCurve: {
                    address: bondingCurve.toString(),
                    ...bcData
                },
                ammPool: {
                    address: pool.toString(),
                    ...ammData
                },
                directConfigLookup, // coin_creator IS the fee sharing config
                pdaConfigLookup, // Derived PDA lookup result
                shareholderConfigs, // Configs where we're a shareholder
                scanDebug, // Debug info about the scan
                feeAccountAnalysis, // Analysis of the FEE program account
                originalCreatorConfig, // Config lookup using known original creator
                verificationResult: verification,
                timestamp: new Date().toISOString()
            });

        } catch (e) {
            res.status(500).json({
                error: e.message,
                stack: e.stack
            });
        }
    });

    // v19.0: Metadata status debug endpoint
    // Shows which tokens have missing metadata (images, price, volume)
    router.get('/debug/metadata-status', async (req, res) => {
        try {
            // Get all tokens with their metadata status
            const tokens = await db.all(`
                SELECT mint, ticker, name, image, "priceUsd", volume24h, "marketCap", "lastUpdated"
                FROM tokens
                ORDER BY volume24h DESC
                LIMIT 100
            `);

            const robinhoodTokens = await db.all(`
                SELECT mint, ticker, name, image, volume24h, "marketCap"
                FROM robinhood_tokens
                WHERE "isActive" = 1
                LIMIT 50
            `);

            // Analyze metadata completeness
            const tokensAnalysis = tokens.map(t => ({
                mint: t.mint,
                ticker: t.ticker,
                name: t.name,
                hasImage: !!(t.image && t.image !== ''),
                imageUrl: t.image || null,
                hasPrice: (t.priceUsd || 0) > 0,
                hasVolume: (t.volume24h || 0) > 0,
                hasMarketCap: (t.marketCap || 0) > 0,
                priceUsd: t.priceUsd || 0,
                volume24h: t.volume24h || 0,
                marketCap: t.marketCap || 0,
                lastUpdated: t.lastUpdated ? new Date(t.lastUpdated).toISOString() : null
            }));

            const robinhoodAnalysis = robinhoodTokens.map(t => ({
                mint: t.mint,
                ticker: t.ticker,
                name: t.name,
                hasImage: !!(t.image && t.image !== ''),
                imageUrl: t.image || null,
                hasVolume: (t.volume24h || 0) > 0,
                hasMarketCap: (t.marketCap || 0) > 0
            }));

            // Summary stats
            const tokenSummary = {
                total: tokens.length,
                withImage: tokensAnalysis.filter(t => t.hasImage).length,
                withPrice: tokensAnalysis.filter(t => t.hasPrice).length,
                withVolume: tokensAnalysis.filter(t => t.hasVolume).length,
                withMarketCap: tokensAnalysis.filter(t => t.hasMarketCap).length,
                complete: tokensAnalysis.filter(t => t.hasImage && t.hasPrice && t.hasVolume && t.hasMarketCap).length
            };

            const robinhoodSummary = {
                total: robinhoodTokens.length,
                withImage: robinhoodAnalysis.filter(t => t.hasImage).length,
                withVolume: robinhoodAnalysis.filter(t => t.hasVolume).length,
                withMarketCap: robinhoodAnalysis.filter(t => t.hasMarketCap).length
            };

            res.json({
                tokens: {
                    summary: tokenSummary,
                    // Show tokens missing any metadata
                    missingMetadata: tokensAnalysis.filter(t => !t.hasImage || !t.hasPrice || !t.hasVolume),
                    // Show tokens with complete metadata
                    complete: tokensAnalysis.filter(t => t.hasImage && t.hasPrice && t.hasVolume && t.hasMarketCap).slice(0, 10)
                },
                robinhoodTokens: {
                    summary: robinhoodSummary,
                    missingMetadata: robinhoodAnalysis.filter(t => !t.hasImage || !t.hasVolume)
                },
                lastBackendUpdate: globalState.lastBackendUpdate ? new Date(globalState.lastBackendUpdate).toISOString() : null,
                serverTime: new Date().toISOString()
            });
        } catch (e) {
            res.status(500).json({
                status: 'error',
                error: e.message
            });
        }
    });

    // v19.0: Test DexScreener fetch for a specific token
    router.get('/debug/test-dexscreener/:mint', async (req, res) => {
        try {
            const { mint } = req.params;

            if (!isValidPubkey(mint)) {
                return res.status(400).json({ error: 'Invalid mint address' });
            }

            // Direct fetch from DexScreener
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
                { timeout: 10000 }
            );

            const pairs = response.data?.pairs || [];

            if (pairs.length === 0) {
                return res.json({
                    success: false,
                    message: 'Token not found on DexScreener',
                    mint,
                    rawResponse: response.data
                });
            }

            // Return the best pair (highest liquidity)
            const bestPair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

            res.json({
                success: true,
                mint,
                pairCount: pairs.length,
                bestPair: {
                    dexId: bestPair.dexId,
                    pairAddress: bestPair.pairAddress,
                    baseToken: bestPair.baseToken,
                    priceUsd: bestPair.priceUsd,
                    volume24h: bestPair.volume?.h24,
                    marketCap: bestPair.fdv || bestPair.marketCap,
                    liquidity: bestPair.liquidity?.usd,
                    imageUrl: bestPair.info?.imageUrl || null,
                    headerUrl: bestPair.info?.header || null,
                    // Show full info object for debugging
                    infoObject: bestPair.info
                },
                rawResponse: response.data
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e.message,
                response: e.response?.data
            });
        }
    });

    return router;
}

module.exports = { init };
