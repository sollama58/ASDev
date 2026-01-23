/**
 * Token Routes
 * Token listing, leaderboard, and holder endpoints
 * v13.0 - Updated for PostgreSQL
 * v14.0 - Updated for proportional point system (Top 250 holders)
 * v15.0 - Added developer token registration endpoint
 * v18.0 - Changed from top 10 to volume threshold eligibility
 * v24.0 - Added rate limiting for token registration, input sanitization
 * v25.22 - SECURITY: Added signature verification for token registration
 * v25.36 - User holdings now uses supply-based point calculation (1B total supply)
 * v25.37 - Added token-lookup and token-lookup-batch endpoints for external integrations
 * v25.64 - Added token-metadata endpoint for fetching on-chain metadata (PAGS preview)
 */
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { PublicKey } = require('@solana/web3.js');
const { isValidPubkey } = require('./solana');
const { redis, mintExtractor, logger, circuitBreaker, imageUtils, signatureVerifier, twitter } = require('../services');
const { safeBalance, safeTotalBalance } = require('../utils');
const config = require('../config/env');

const router = express.Router();

// v18.0: Minimum 24hr volume for airdrop eligibility
const MIN_VOLUME_USD = config.AIRDROP_MIN_VOLUME_USD || 100;

// v25.25: Volume weight range for point calculation (must match holderScanner.js)
const VOLUME_WEIGHT_MIN = 0.5;  // Lowest volume token gets 0.5x base points
const VOLUME_WEIGHT_MAX = 2.0;  // Highest volume token gets 2.0x base points

// v25.36: Pump.fun standard total supply (1 billion tokens with 6 decimals)
// All pump.fun tokens have fixed 1B supply - use this for accurate % of supply calculation
const PUMP_FUN_TOTAL_SUPPLY = BigInt('1000000000000000'); // 1B tokens * 10^6 decimals

/**
 * v25.25: Calculate dynamic volume weight for a token
 * Uses logarithmic scaling relative to the volume range of all eligible tokens
 * This MUST match the calculation in holderScanner.js for consistent point display
 */
function calculateVolumeWeight(tokenVolume, minVolume, maxVolume) {
    if (maxVolume <= minVolume || minVolume <= 0) {
        return 1.0;
    }
    const logMin = Math.log10(minVolume);
    const logMax = Math.log10(maxVolume);
    const logVolume = Math.log10(Math.max(tokenVolume, minVolume));
    const normalized = (logVolume - logMin) / (logMax - logMin);
    const weight = VOLUME_WEIGHT_MIN + (normalized * (VOLUME_WEIGHT_MAX - VOLUME_WEIGHT_MIN));
    return Math.max(VOLUME_WEIGHT_MIN, Math.min(VOLUME_WEIGHT_MAX, weight));
}

// v24.0 SECURITY: Rate limiter for token registration (expensive on-chain operations)
const tokenRegistrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 registrations per hour per IP
    message: { error: 'Too many token registration attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Use IP + optional submitter pubkey for more precise limiting
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
        const pubkey = req.body?.submitterPubkey || '';
        return `${ip}:${pubkey.slice(0, 10)}`;
    }
});

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { db, globalState, devKeypair, connection } = deps;

    // Get all launches - SCALABILITY FIX: Added pagination
    // v18.0: Added eligibility status based on volume threshold
    // Cached for 15 seconds per page
    // v22.0: Added input validation for pagination parameters
    // v25.0: Combined tokens + robinhood_tokens to show all tokens in database
    router.get('/all-launches', async (req, res) => {
        try {
            // Validate and sanitize pagination params (prevent negative values and enforce limits)
            const rawLimit = parseInt(req.query.limit) || 50;
            const rawOffset = parseInt(req.query.offset) || 0;
            const limit = Math.min(Math.max(1, rawLimit), 100); // Min 1, Max 100
            const offset = Math.max(0, rawOffset); // Min 0 (no negative offsets)

            // Cache per page (limit + offset combo)
            const cacheKey = `all_launches_v25_${limit}_${offset}`;
            const { rows, total } = await redis.smartCache(cacheKey, 15, async () => {
                // v25.0: UNION query to get both platform tokens and robinhood tokens
                const combinedQuery = `
                    SELECT mint, "userPubkey", name, ticker, image, "metadataUri", "marketCap", volume24h, complete, 'platform' as source
                    FROM tokens
                    UNION ALL
                    SELECT mint, "creatorPubkey" as "userPubkey", name, ticker, image, NULL as "metadataUri", "marketCap", volume24h, "isGraduated" as complete, 'robinhood' as source
                    FROM robinhood_tokens
                    WHERE "isActive" = 1
                    ORDER BY volume24h DESC
                    LIMIT $1 OFFSET $2
                `;
                const rows = await db.all(combinedQuery, [limit, offset]);

                // Get total count from both tables
                const platformCount = await db.get('SELECT COUNT(*) as count FROM tokens');
                const robinhoodCount = await db.get('SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1');
                const total = parseInt(platformCount?.count || 0) + parseInt(robinhoodCount?.count || 0);

                return { rows, total };
            });

            // v25.4: Process tokens and fetch fallback images for those missing images
            const allLaunches = await Promise.all(rows.map(async (r) => {
                // Check if image is missing/null and try to fetch from metadataUri
                let image = r.image;
                if ((!image || image === '' || image === 'null') && r.metadataUri) {
                    try {
                        const fallbackImage = await imageUtils.fetchImageFromMetadataUri(r.metadataUri, 2000);
                        if (fallbackImage) {
                            image = fallbackImage;
                            // Update the database with the fetched image (async, don't wait)
                            db.run('UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = \'\' OR image = \'null\')',
                                [fallbackImage, r.mint]).catch(() => {});
                        }
                    } catch (e) {
                        // Silently fail - use whatever we have
                    }
                }

                return {
                    mint: r.mint,
                    userPubkey: r.userPubkey,
                    name: r.name,
                    ticker: r.ticker,
                    image: image,
                    metadataUri: r.metadataUri,
                    marketCap: r.marketCap || 0,
                    volume: r.volume24h,
                    complete: !!r.complete,
                    // v18.0: Eligibility based on volume threshold
                    isEligible: (r.volume24h || 0) >= MIN_VOLUME_USD,
                    // v25.0: Include source to differentiate token types
                    source: r.source || 'platform'
                };
            }));
            res.json({
                tokens: allLaunches,
                lastUpdate: globalState.lastBackendUpdate,
                pagination: { limit, offset, total },
                eligibilityThreshold: MIN_VOLUME_USD // v18.0: Include threshold for frontend
            });
        } catch (e) {
            logger.error('[All Launches] Error fetching combined tokens', { error: e.message });
            res.status(500).json({ tokens: [], lastUpdate: Date.now() });
        }
    });

    // King of the Pill (KOTH) Endpoint - Cached for 15 seconds
    // v25.38: Now uses AI-based selection from Redis cache (set by flywheel)
    router.get('/koth', async (req, res) => {
        try {
            const result = await redis.smartCache('koth_data', 15, async () => {
                // v25.38: First try to get AI-selected KOTH from Redis
                let aiSelection = null;
                try {
                    const aiData = await redis.get('koth_ai_selection');
                    if (aiData) {
                        aiSelection = JSON.parse(aiData);
                    }
                } catch (e) {
                    // Fallback to market cap if AI selection unavailable
                }

                // Get the KOTH token (AI-selected mint or fallback to highest mcap)
                const kothMint = aiSelection?.mint;
                const koth = kothMint
                    ? await db.get(`
                        SELECT mint, "userPubkey", name, ticker, image, "metadataUri", "marketCap", volume24h, "holderCount"
                        FROM tokens WHERE mint = $1
                    `, [kothMint])
                    : await db.get(`
                        SELECT mint, "userPubkey", name, ticker, image, "metadataUri", "marketCap", volume24h, "holderCount"
                        FROM tokens WHERE "marketCap" > 0
                        ORDER BY "marketCap" DESC LIMIT 1
                    `);

                if (koth) {
                    // v25.4: Fetch image from metadataUri if missing
                    let image = koth.image;
                    if ((!image || image === '' || image === 'null') && koth.metadataUri) {
                        try {
                            const fallbackImage = await imageUtils.fetchImageFromMetadataUri(koth.metadataUri, 2000);
                            if (fallbackImage) {
                                image = fallbackImage;
                                db.run('UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = \'\' OR image = \'null\')',
                                    [fallbackImage, koth.mint]).catch(() => {});
                            }
                        } catch (e) { /* silent fail */ }
                    }

                    return {
                        found: true,
                        token: {
                            mint: koth.mint,
                            creator: koth.userPubkey,
                            name: koth.name,
                            ticker: koth.ticker,
                            image: image,
                            marketCap: koth.marketCap,
                            volume24h: koth.volume24h,  // v25.42: Fixed field name (was 'volume')
                            holderCount: koth.holderCount || 0
                        },
                        // v25.38: Include AI selection details
                        ai: aiSelection ? {
                            score: aiSelection.score,
                            reasoning: aiSelection.reasoning,
                            breakdown: aiSelection.breakdown,
                            evaluatedAt: aiSelection.evaluatedAt,
                            candidates: aiSelection.candidates,
                            isAI: aiSelection.isAI || false,
                            model: aiSelection.model || null,
                            runnerUp: aiSelection.runnerUp || null,
                            runnerUpReason: aiSelection.runnerUpReason || null
                        } : null
                    };
                } else {
                    return { found: false };
                }
            });
            res.json(result);
        } catch (e) {
            console.error("KOTH Endpoint Error:", e);
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Leaderboard - Shows all tokens where dev wallet receives fees (launched + robinhood)
    // v18.0: Now includes eligibility status based on volume threshold
    // Cached for 15 seconds (base data), user-specific holdings checked separately
    router.get('/leaderboard', async (req, res) => {
        const { userPubkey } = req.query;
        // Validate userPubkey if provided
        if (userPubkey && !isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }
        try {
            // Cache the base leaderboard data (15 seconds)
            // v24.0: Added LIMIT 500 to prevent unbounded result sets on large datasets
            const rows = await redis.smartCache('leaderboard_data', 15, async () => {
                // Combine launched tokens and active robinhood tokens
                // Use UNION ALL to merge both sources, preserving creator info
                // v18.0: Removed LIMIT 10 to show all tokens, eligibility determined by volume threshold
                // v24.0: Added LIMIT 500 for scalability (prevents unbounded queries)
                // v25.63: Tokens can be registered for both platform AND PAGS (fee splitting)
                // Only tokens in tokens/robinhood_tokens tables appear here - PAGS-only tokens won't
                return await db.all(`
                    SELECT mint, "userPubkey" as creator, name, ticker, image, "metadataUri", "marketCap", volume24h, complete, 'launched' as source
                    FROM tokens
                    UNION ALL
                    SELECT mint, "creatorPubkey" as creator, name, ticker, image, NULL as "metadataUri", "marketCap", volume24h, "isGraduated" as complete, 'robinhood' as source
                    FROM robinhood_tokens
                    WHERE "isActive" = 1
                    ORDER BY volume24h DESC
                    LIMIT 500
                `);
            });

            // Batch query for user holder status (check both holder tables)
            // This is user-specific so we cache it separately with shorter TTL
            // v25.28: Reduced TTL from 30s to 15s to save Redis memory
            let userHoldings = new Set();
            if (userPubkey && rows.length > 0) {
                const userCacheKey = `user_holdings_${userPubkey}`;
                const cachedHoldings = await redis.smartCache(userCacheKey, 15, async () => {
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

                    return [
                        ...launchedHoldings.map(h => h.mint),
                        ...robinhoodHoldings.map(h => h.mint)
                    ];
                });

                userHoldings = new Set(cachedHoldings);
            }

            // v25.4: Process tokens and fetch fallback images for those missing images
            const leaderboard = await Promise.all(rows.map(async (r) => {
                // Check if image is missing/null and try to fetch from metadataUri
                let image = r.image;
                if ((!image || image === '' || image === 'null') && r.metadataUri) {
                    try {
                        const fallbackImage = await imageUtils.fetchImageFromMetadataUri(r.metadataUri, 2000);
                        if (fallbackImage) {
                            image = fallbackImage;
                            // Update the database with the fetched image (async, don't wait)
                            db.run('UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = \'\' OR image = \'null\')',
                                [fallbackImage, r.mint]).catch(() => {});
                        }
                    } catch (e) {
                        // Silently fail - use whatever we have
                    }
                }

                return {
                    mint: r.mint,
                    creator: r.creator,
                    name: r.name,
                    ticker: r.ticker,
                    image: image,
                    metadataUri: r.metadataUri,
                    price: ((r.marketCap || 0) / 1000000000).toFixed(6),
                    marketCap: r.marketCap || 0,
                    volume: r.volume24h,
                    isUserTopHolder: userHoldings.has(r.mint),
                    complete: !!r.complete,
                    isRobinhood: r.source === 'robinhood',
                    // v18.0: Eligibility based on volume threshold ($100 minimum)
                    isEligible: (r.volume24h || 0) >= MIN_VOLUME_USD
                };
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

    // Recent launches - v25.35: Enhanced with images, prices, and timestamps
    // Cached for 30 seconds
    router.get('/recent-launches', async (req, res) => {
        try {
            const result = await redis.smartCache('recent_launches', 30, async () => {
                const rows = await db.all(`
                    SELECT "userPubkey", ticker, name, mint, image, "marketCap", timestamp
                    FROM tokens
                    ORDER BY timestamp DESC
                    LIMIT 15
                `);
                return rows.map(r => ({
                    userSnippet: r.userPubkey?.slice(0, 5) || '?????',
                    ticker: r.ticker || 'UNKNOWN',
                    name: r.name || '',
                    mint: r.mint,
                    image: r.image || null,
                    marketCap: r.marketCap || 0,
                    timestamp: r.timestamp || Date.now()
                }));
            });
            res.json(result);
        } catch (e) {
            logger.error('[API] Recent launches error', { error: e.message });
            res.status(500).json([]);
        }
    });

    // Get single token - v24.0: Added caching (30s TTL)
    router.get('/token/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            if (!isValidPubkey(mint)) {
                return res.status(400).json({ error: "Invalid mint address" });
            }
            const cacheKey = `token_detail_${mint}`;
            const token = await redis.smartCache(cacheKey, 30, async () => {
                return await db.get('SELECT "tweetUrl" FROM tokens WHERE mint = $1', [mint]);
            });
            res.json(token || {});
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Proxy for token price data (uses DexScreener API)
    // v24.0: Added caching (10s TTL) and circuit breaker for external API resilience
    // v25.22 SECURITY: Added price bounds validation to prevent oracle manipulation
    router.get('/pump-proxy/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            if (!isValidPubkey(mint)) {
                return res.status(400).json({ error: "Invalid mint address" });
            }

            // v25.22 SECURITY: Price sanity bounds - reject obviously invalid values
            // Max reasonable price for a Pump.fun token (prevents overflow/manipulation)
            const MAX_PRICE_USD = 1000000; // $1M per token max
            const MAX_PRICE_NATIVE = 100000; // 100K SOL per token max

            // v24.0: Cache price data for 10 seconds to reduce external API calls
            const cacheKey = `pump_proxy_${mint}`;
            const priceData = await redis.smartCache(cacheKey, 10, async () => {
                // Use circuit breaker to handle DexScreener API failures gracefully
                return await circuitBreaker.execute(
                    'dexscreener-api',
                    async () => {
                        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                            timeout: 5000
                        });
                        const pairs = response.data?.pairs || [];
                        if (pairs.length > 0) {
                            const pair = pairs[0];
                            let priceUsd = parseFloat(pair.priceUsd) || 0;
                            let priceNative = parseFloat(pair.priceNative) || 0;

                            // v25.22 SECURITY: Validate price bounds
                            // Reject NaN, Infinity, negative values, and suspiciously high values
                            if (!Number.isFinite(priceUsd) || priceUsd < 0 || priceUsd > MAX_PRICE_USD) {
                                logger.warn('[pump-proxy] Invalid priceUsd rejected', { mint: mint.slice(0, 8), priceUsd });
                                priceUsd = 0;
                            }
                            if (!Number.isFinite(priceNative) || priceNative < 0 || priceNative > MAX_PRICE_NATIVE) {
                                logger.warn('[pump-proxy] Invalid priceNative rejected', { mint: mint.slice(0, 8), priceNative });
                                priceNative = 0;
                            }

                            return {
                                priceUsd,
                                priceNative,
                                cached: false
                            };
                        }
                        return { priceUsd: 0, priceNative: 0, cached: false };
                    },
                    { priceUsd: 0, priceNative: 0, cached: false, circuitOpen: true },
                    { failureThreshold: 5, timeout: 30000 }
                );
            });

            res.json(priceData);
        } catch (e) {
            logger.debug('[pump-proxy] Error fetching price data', { mint, error: e.message });
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
    // v22.0: SCALABILITY FIX - Refactored N+1 queries to use JOINs (2 queries instead of 2000+)
    // v23.0: Removed creator bonus
    // v25.25: Added volume weighting to match holderScanner point calculation
    // v25.33: Refactored to read from user_points table (single source of truth)
    // Points are calculated by the worker and stored in the database
    router.get('/check-holder', async (req, res) => {
        const { userPubkey } = req.query;
        if (!userPubkey) {
            return res.json({
                isHolder: false, isAsdfTop50: false, points: 0,
                multiplier: 1, heldPositionsCount: 0,
                basePoints: 0, robinhoodPoints: 0,
                expectedAirdrop: 0, expectedAirdropCurrency: 'SOL'
            });
        }
        if (!isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }

        try {
            // v25.33: Read from user_points table (single source of truth)
            const userPoints = await db.get(`
                SELECT
                    pubkey,
                    base_points,
                    robinhood_points,
                    multiplier,
                    total_points,
                    expected_airdrop_sol,
                    positions_count,
                    is_asdf_holder
                FROM user_points
                WHERE pubkey = $1
            `, [userPubkey]);

            // If user not found in user_points, check if they have any holdings
            if (!userPoints) {
                // Quick check for any holdings (for isHolder flag)
                const holdingsCount = await db.get(`
                    SELECT COUNT(*) as count FROM token_holders
                    WHERE "holderPubkey" = $1
                `, [userPubkey]);

                return res.json({
                    isHolder: (holdingsCount?.count || 0) > 0,
                    isAsdfTop50: false,
                    points: 0,
                    multiplier: 1,
                    heldPositionsCount: holdingsCount?.count || 0,
                    basePoints: 0,
                    robinhoodPoints: 0,
                    expectedAirdrop: 0,
                    expectedAirdropCurrency: 'SOL'
                });
            }

            // Return data from user_points table
            res.json({
                isHolder: true,
                isAsdfTop50: userPoints.is_asdf_holder || false,
                points: Math.round((userPoints.total_points || 0) * 100) / 100,
                multiplier: userPoints.multiplier || 1,
                heldPositionsCount: userPoints.positions_count || 0,
                basePoints: Math.round((userPoints.base_points || 0) * 100) / 100,
                robinhoodPoints: Math.round((userPoints.robinhood_points || 0) * 100) / 100,
                expectedAirdrop: userPoints.expected_airdrop_sol || 0,
                expectedAirdropCurrency: 'SOL'
            });
        } catch (e) {
            logger.error('[check-holder] Error', { error: e.message, userPubkey });
            res.status(500).json({ error: "DB Error", expectedAirdrop: 0 });
        }
    });

    // v18.0: Get detailed holdings breakdown for a user
    // Returns each token the user holds, eligibility status, and points earned
    // v24.0: SCALABILITY FIX - Refactored N+1 queries to use JOINs (2 queries instead of 100s)
    // v25.33: Now uses user_points table for authoritative totals, but still shows per-token breakdown
    router.get('/user-holdings', async (req, res) => {
        const { userPubkey } = req.query;
        if (!userPubkey) {
            return res.json({ holdings: [], totalPoints: 0, eligibilityThreshold: MIN_VOLUME_USD });
        }
        if (!isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }

        try {
            // v25.33: Get authoritative totals from user_points table
            const userPointsData = await db.get(`
                SELECT base_points, robinhood_points, multiplier, total_points
                FROM user_points WHERE pubkey = $1
            `, [userPubkey]);

            // v25.28: Reduced TTL from 30s to 15s to save Redis memory
            const cacheKey = `user_holdings_detail_v3_${userPubkey}`;
            const holdingsData = await redis.smartCache(cacheKey, 15, async () => {
                const POINTS_PER_TOKEN = 1000;
                const holdings = [];

                // v25.25: Get volume ranges for weighting calculation
                const platformVolumeRange = await db.get(`
                    SELECT MIN(volume24h) as min_vol, MAX(volume24h) as max_vol
                    FROM tokens WHERE volume24h >= $1
                `, [MIN_VOLUME_USD]);
                const platformMinVol = parseFloat(platformVolumeRange?.min_vol) || MIN_VOLUME_USD;
                const platformMaxVol = parseFloat(platformVolumeRange?.max_vol) || MIN_VOLUME_USD;

                // v24.0: Single optimized query with JOINs for launched tokens
                // v25.36: Removed total_balance subquery - no longer needed (using fixed 1B supply)
                const launchedHoldings = await db.all(`
                    SELECT
                        t.mint,
                        t.ticker,
                        t.name,
                        t.image,
                        t."userPubkey" as creator,
                        t.volume24h,
                        t."marketCap",
                        th.balance,
                        th.rank
                    FROM token_holders th
                    INNER JOIN tokens t ON t.mint = th.mint
                    WHERE th."holderPubkey" = $1 AND CAST(th.balance AS BIGINT) > 0
                    ORDER BY t.volume24h DESC
                `, [userPubkey]);

                for (const row of launchedHoldings) {
                    const userBalance = safeBalance(row.balance);
                    if (userBalance === 0n) continue;

                    const tokenVolume = parseFloat(row.volume24h) || MIN_VOLUME_USD;
                    const volumeWeight = calculateVolumeWeight(tokenVolume, platformMinVol, platformMaxVol);
                    const weightedPoints = POINTS_PER_TOKEN * volumeWeight;
                    // v25.36: Calculate points based on % of TOTAL SUPPLY (1B tokens), not tracked holders
                    const proportionalPts = Number((userBalance * BigInt(Math.round(weightedPoints * 1000))) / PUMP_FUN_TOTAL_SUPPLY) / 1000;
                    const isEligible = (row.volume24h || 0) >= MIN_VOLUME_USD;

                    holdings.push({
                        mint: row.mint,
                        ticker: row.ticker,
                        name: row.name,
                        image: row.image,
                        volume24h: row.volume24h || 0,
                        marketCap: row.marketCap || 0,
                        rank: row.rank,
                        isEligible,
                        volumeWeight: Math.round(volumeWeight * 100) / 100,
                        basePoints: isEligible ? Math.round(proportionalPts * 100) / 100 : 0,
                        totalPoints: isEligible ? Math.round(proportionalPts * 100) / 100 : 0,
                        source: 'launched'
                    });
                }

                // v25.25: Get volume range for robinhood tokens
                const robinhoodVolumeRange = await db.get(`
                    SELECT MIN(volume24h) as min_vol, MAX(volume24h) as max_vol
                    FROM robinhood_tokens WHERE "isActive" = 1 AND volume24h >= $1
                `, [MIN_VOLUME_USD]);
                const rhMinVol = parseFloat(robinhoodVolumeRange?.min_vol) || MIN_VOLUME_USD;
                const rhMaxVol = parseFloat(robinhoodVolumeRange?.max_vol) || MIN_VOLUME_USD;

                // v24.0: Single optimized query with JOINs for Robinhood tokens
                // v25.36: Removed total_balance subquery - no longer needed (using fixed 1B supply)
                const robinhoodHoldings = await db.all(`
                    SELECT
                        rt.mint,
                        rt.ticker,
                        rt.name,
                        rt.image,
                        rt."feeShareBps",
                        rt.volume24h,
                        rt."marketCap",
                        rth.balance,
                        rth.rank
                    FROM robinhood_token_holders rth
                    INNER JOIN robinhood_tokens rt ON rt.mint = rth.mint AND rt."isActive" = 1
                    WHERE rth."holderPubkey" = $1 AND CAST(rth.balance AS BIGINT) > 0
                    ORDER BY rt.volume24h DESC
                `, [userPubkey]);

                for (const row of robinhoodHoldings) {
                    const userBalance = safeBalance(row.balance);
                    if (userBalance === 0n) continue;

                    const tokenVolume = parseFloat(row.volume24h) || MIN_VOLUME_USD;
                    const volumeWeight = calculateVolumeWeight(tokenVolume, rhMinVol, rhMaxVol);
                    const weightedPoints = POINTS_PER_TOKEN * volumeWeight;
                    // v25.36: Calculate points based on % of TOTAL SUPPLY (1B tokens), not tracked holders
                    const baseProportionalPts = Number((userBalance * BigInt(Math.round(weightedPoints * 1000))) / PUMP_FUN_TOTAL_SUPPLY) / 1000;
                    const feeShareBps = row.feeShareBps || 10000;
                    const feeShareMultiplier = feeShareBps / 10000;
                    const scaledPts = baseProportionalPts * feeShareMultiplier;
                    const isEligible = (row.volume24h || 0) >= MIN_VOLUME_USD;

                    holdings.push({
                        mint: row.mint,
                        ticker: row.ticker,
                        name: row.name,
                        image: row.image,
                        volume24h: row.volume24h || 0,
                        marketCap: row.marketCap || 0,
                        rank: row.rank,
                        isEligible,
                        feeSharePercent: (feeShareBps / 100),
                        volumeWeight: Math.round(volumeWeight * 100) / 100,
                        basePoints: isEligible ? Math.round(scaledPts * 100) / 100 : 0,
                        totalPoints: isEligible ? Math.round(scaledPts * 100) / 100 : 0,
                        source: 'robinhood'
                    });
                }

                return holdings.sort((a, b) => b.totalPoints - a.totalPoints);
            });

            // v25.33: Use authoritative total from user_points table if available
            // Per-token breakdown is for display only; worker calculates the real total
            const totalPoints = userPointsData
                ? Math.round((userPointsData.total_points || 0) * 100) / 100
                : Math.round(holdingsData.reduce((sum, h) => sum + h.totalPoints, 0) * 100) / 100;

            res.json({
                holdings: holdingsData,
                totalPoints,
                // v25.33: Include breakdown from user_points table for transparency
                basePoints: userPointsData ? Math.round((userPointsData.base_points || 0) * 100) / 100 : undefined,
                robinhoodPoints: userPointsData ? Math.round((userPointsData.robinhood_points || 0) * 100) / 100 : undefined,
                multiplier: userPointsData?.multiplier || 1,
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
    // v25.33: Refactored to read from user_points table (single source of truth)
    // Now a simple SELECT instead of complex aggregation - much faster and consistent
    router.get('/all-eligible-users', async (req, res) => {
        try {
            const devPubkey = devKeypair.publicKey.toString();

            // v25.33: Simple query from user_points table
            const users = await db.all(`
                SELECT
                    pubkey,
                    base_points,
                    robinhood_points,
                    multiplier,
                    total_points,
                    expected_airdrop_sol,
                    positions_count,
                    is_asdf_holder
                FROM user_points
                WHERE total_points > 0 AND pubkey != $1
                ORDER BY total_points DESC
            `, [devPubkey]);

            // Calculate total points
            let totalPoints = 0;
            const eligibleUsers = users.map(user => {
                totalPoints += user.total_points || 0;
                return {
                    pubkey: user.pubkey,
                    points: Math.round((user.total_points || 0) * 100) / 100,
                    positions: user.positions_count || 0,
                    isAsdfTop50: user.is_asdf_holder || false,
                    expectedAirdrop: user.expected_airdrop_sol || 0,
                    expectedAirdropCurrency: 'SOL'
                };
            });

            res.json({
                users: eligibleUsers,
                totalPoints: Math.round(totalPoints * 100) / 100,
                currency: 'SOL',
                eligibilityThreshold: MIN_VOLUME_USD
            });
        } catch (e) {
            logger.error('[all-eligible-users] Error', { error: e.message });
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

    // v25.18: Get user's lifetime airdrop stats for shareable graphic
    router.get('/user-airdrop-stats/:pubkey', async (req, res) => {
        try {
            const { pubkey } = req.params;

            // Validate pubkey
            if (!isValidPubkey(pubkey)) {
                return res.status(400).json({ error: "Invalid wallet address" });
            }

            // Get lifetime stats
            const statsQuery = await db.get(`
                SELECT
                    COUNT(*) as "airdropCount",
                    COALESCE(SUM(amount), 0) as "totalSolReceived",
                    MIN(timestamp) as "firstAirdrop",
                    MAX(timestamp) as "lastAirdrop"
                FROM user_airdrop_history
                WHERE "userPubkey" = $1
            `, [pubkey]);

            // Get recent airdrops (last 5)
            const recentAirdrops = await db.all(`
                SELECT amount, points, timestamp, "airdropId"
                FROM user_airdrop_history
                WHERE "userPubkey" = $1
                ORDER BY timestamp DESC
                LIMIT 5
            `, [pubkey]);

            // Get global ranking (by total SOL received)
            const rankQuery = await db.get(`
                SELECT COUNT(*) + 1 as rank
                FROM (
                    SELECT "userPubkey", SUM(amount) as total
                    FROM user_airdrop_history
                    GROUP BY "userPubkey"
                    HAVING SUM(amount) > (
                        SELECT COALESCE(SUM(amount), 0)
                        FROM user_airdrop_history
                        WHERE "userPubkey" = $1
                    )
                ) as higher_earners
            `, [pubkey]);

            // Get total unique participants for ranking context
            const totalParticipants = await db.get(`
                SELECT COUNT(DISTINCT "userPubkey") as count FROM user_airdrop_history
            `);

            res.json({
                wallet: pubkey.substring(0, 4) + '...' + pubkey.substring(pubkey.length - 4),
                walletFull: pubkey,
                totalSolReceived: parseFloat(statsQuery?.totalSolReceived || 0).toFixed(6),
                airdropCount: parseInt(statsQuery?.airdropCount || 0),
                firstAirdrop: statsQuery?.firstAirdrop || null,
                lastAirdrop: statsQuery?.lastAirdrop || null,
                rank: parseInt(rankQuery?.rank || 0),
                totalParticipants: parseInt(totalParticipants?.count || 0),
                recentAirdrops: recentAirdrops.map(a => ({
                    amount: parseFloat(a.amount).toFixed(6),
                    points: a.points,
                    timestamp: a.timestamp,
                    airdropId: a.airdropId
                }))
            });
        } catch (e) {
            logger.error('[user-airdrop-stats] Error', { error: e.message, pubkey: req.params.pubkey });
            res.status(500).json({ error: "Failed to fetch airdrop stats" });
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
     * - originalCreator: Legacy parameter, no longer needed (auto-detected from on-chain data)
     *
     * The endpoint verifies that our platform wallet (devKeypair) is a fee
     * recipient for the token by checking on-chain bonding curve, AMM pool,
     * and fee sharing config data. This ensures only tokens that share fees
     * with us can be registered.
     *
     * v24.0: Added rate limiting (10 registrations per hour per IP)
     * v25.22 SECURITY: Added signature verification - submitter must prove wallet ownership
     *
     * v25.29: Removed signature requirement - anyone can register tokens that share fees with platform
     * The on-chain verification (verifyFeeRecipient) is sufficient security since only tokens
     * that share fees with our platform wallet can be registered.
     */
    router.post('/register-token', tokenRegistrationLimiter, async (req, res) => {
        try {
            const { mint, submitterPubkey, originalCreator } = req.body;

            // v25.29: No signature verification needed - on-chain fee sharing is the gate
            const verifiedSubmitter = submitterPubkey;

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

            // v25.63: Note - tokens CAN be registered for both PAGS and platform
            // This allows creators to split fees (e.g., 50% to Robinhood holders, 50% to Twitter via PAGS)
            // However, if a token is ALSO registered for PAGS, it will be excluded from
            // leaderboard/KOTH/airdrop points to keep the reward systems separate

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
                // v25.22: Use verified submitter from signature verification
                const registeredBy = verifiedSubmitter && isValidPubkey(verifiedSubmitter)
                    ? verifiedSubmitter
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
                // Use the original creator from verification (needed for fee vault derivation)
                // v25.22: Fall back to verified submitter if originalCreator not available
                const creatorPubkey = verification.originalCreator
                    || (verifiedSubmitter && isValidPubkey(verifiedSubmitter) ? verifiedSubmitter : null)
                    || 'unknown_creator';

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

                logger.info(`[TokenRegistration] Registered as FEE SHAREHOLDER: ${token.ticker} (${mint.slice(0, 8)}...) - ${verification.feeSharePercent}% fee share (${verification.feeShareBps} bps), originalCreator: ${creatorPubkey.slice(0, 8)}...`);
            }

            // v25.70: Post Twitter announcement for new Robinhood registration
            // Non-blocking - don't fail registration if tweet fails
            let tweetUrl = null;
            try {
                tweetUrl = await twitter.postRobinhoodRegistrationTweet(
                    token.ticker,
                    token.name,
                    token.mint,
                    verification.feeSharePercent
                );
                if (tweetUrl) {
                    logger.info('[TokenRegistration] Registration announced on Twitter', {
                        mint: token.mint,
                        ticker: token.ticker,
                        tweetUrl
                    });
                }
            } catch (tweetErr) {
                logger.warn('[TokenRegistration] Twitter announcement failed', { error: tweetErr.message });
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
                },
                // v25.70: Include tweet URL if announcement was posted
                tweetUrl
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
                'SELECT mint, ticker, name, image, metadataUri, "userPubkey", "marketCap", volume24h, timestamp FROM tokens WHERE mint = $1',
                [mint]
            );

            if (token) {
                // v25.6: Apply metadataUri fallback for missing images
                let image = token.image;
                if ((!image || image === '' || image === 'null') && token.metadataUri) {
                    try {
                        const fallbackImage = await imageUtils.fetchImageFromMetadataUri(token.metadataUri, 3000);
                        if (fallbackImage) {
                            image = fallbackImage;
                            // Update database async
                            db.run('UPDATE tokens SET image = $1 WHERE mint = $2', [fallbackImage, mint]).catch(() => {});
                        }
                    } catch (e) {
                        // Silently fail
                    }
                }

                res.json({
                    registered: true,
                    token: {
                        mint: token.mint,
                        ticker: token.ticker,
                        name: token.name,
                        image: image,
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
     * GET /token-lookup/:mint
     * v25.37: Comprehensive token lookup for external integrations (DexScreener, etc.)
     *
     * Checks if a token is registered in the IGNITION ecosystem and returns:
     * - Whether the token is registered
     * - Token type: 'ignition' (launched via IGNITION) or 'robinhood' (fee-sharing partner)
     * - Token metadata, market data, and fee share info (for robinhood tokens)
     *
     * This endpoint is designed for cross-platform queries from external applications.
     */
    router.get('/token-lookup/:mint', async (req, res) => {
        try {
            const { mint } = req.params;

            if (!isValidPubkey(mint)) {
                return res.status(400).json({
                    registered: false,
                    error: 'Invalid mint address'
                });
            }

            // Check the tokens table (IGNITION-launched tokens)
            const ignitionToken = await db.get(`
                SELECT mint, ticker, name, image, "metadataUri", "userPubkey", "marketCap", volume24h, timestamp
                FROM tokens WHERE mint = $1
            `, [mint]);

            if (ignitionToken) {
                // Token was launched via IGNITION platform
                let image = ignitionToken.image;

                // Apply metadataUri fallback for missing images
                if ((!image || image === '' || image === 'null') && ignitionToken.metadataUri) {
                    try {
                        const fallbackImage = await imageUtils.fetchImageFromMetadataUri(ignitionToken.metadataUri, 3000);
                        if (fallbackImage) {
                            image = fallbackImage;
                            db.run('UPDATE tokens SET image = $1 WHERE mint = $2', [fallbackImage, mint]).catch(() => {});
                        }
                    } catch (e) { /* silent fail */ }
                }

                return res.json({
                    registered: true,
                    type: 'ignition',
                    token: {
                        mint: ignitionToken.mint,
                        ticker: ignitionToken.ticker,
                        name: ignitionToken.name,
                        image: image,
                        creator: ignitionToken.userPubkey,
                        marketCap: ignitionToken.marketCap || 0,
                        volume24h: ignitionToken.volume24h || 0,
                        registeredAt: ignitionToken.timestamp
                    }
                });
            }

            // Check the robinhood_tokens table (fee-sharing partner tokens)
            const robinhoodToken = await db.get(`
                SELECT mint, ticker, name, image, "creatorPubkey", "feeShareBps", "marketCap", volume24h, "isActive", "discoveredAt"
                FROM robinhood_tokens WHERE mint = $1
            `, [mint]);

            if (robinhoodToken) {
                // Token is a Robinhood fee-sharing partner
                return res.json({
                    registered: true,
                    type: 'robinhood',
                    active: robinhoodToken.isActive === 1,
                    token: {
                        mint: robinhoodToken.mint,
                        ticker: robinhoodToken.ticker,
                        name: robinhoodToken.name,
                        image: robinhoodToken.image,
                        creator: robinhoodToken.creatorPubkey,
                        feeShareBps: robinhoodToken.feeShareBps,
                        feeSharePercent: (robinhoodToken.feeShareBps / 100).toFixed(1),
                        marketCap: robinhoodToken.marketCap || 0,
                        volume24h: robinhoodToken.volume24h || 0,
                        registeredAt: robinhoodToken.discoveredAt
                    }
                });
            }

            // Token not found in either table
            return res.json({
                registered: false,
                type: null,
                mint: mint
            });

        } catch (e) {
            logger.error('[TokenLookup] Error', { mint: req.params.mint, error: e.message, stack: e.stack });
            res.status(500).json({
                registered: false,
                error: 'Database error',
                details: e.message
            });
        }
    });

    /**
     * GET /token-metadata/:mint
     * v25.64: Fetch token metadata directly from on-chain via Helius DAS API
     *
     * Used by frontend for PAGS registration preview to extract image from metadata
     * without relying on external APIs like DexScreener or Pump.fun
     *
     * Returns:
     * - success: boolean
     * - metadata: { name, symbol, image, description }
     * - metadataUri: The raw metadata URI from on-chain
     */
    router.get('/token-metadata/:mint', async (req, res) => {
        try {
            const { mint } = req.params;

            if (!isValidPubkey(mint)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid mint address'
                });
            }

            // Check if Helius API key is configured
            if (!config.HELIUS_API_KEY) {
                return res.status(503).json({
                    success: false,
                    error: 'Metadata service not configured'
                });
            }

            // Fetch from Helius DAS API
            const heliusRes = await axios.post(
                'https://mainnet.helius-rpc.com/',
                {
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'getAsset',
                    params: { id: mint, displayOptions: { showFungible: true } }
                },
                {
                    timeout: 8000,
                    headers: { 'Authorization': `Bearer ${config.HELIUS_API_KEY}` }
                }
            );

            const asset = heliusRes.data?.result;
            if (!asset) {
                return res.status(404).json({
                    success: false,
                    error: 'Token not found on-chain'
                });
            }

            const onChainMetadata = asset.content?.metadata || {};
            const metadataUri = asset.content?.json_uri || null;

            // Extract image using existing utility
            let image = imageUtils.extractHeliusImage(asset);

            // If no image from Helius response, try fetching from metadataUri
            if (!image && metadataUri) {
                try {
                    image = await imageUtils.fetchImageFromMetadataUri(metadataUri, 5000);
                } catch (e) {
                    // Silent fail, proceed without image
                }
            }

            // Normalize the image URL if we have one
            if (image) {
                image = imageUtils.normalizeImageUrl(image);
            }

            return res.json({
                success: true,
                metadata: {
                    name: onChainMetadata.name || 'Unknown',
                    symbol: onChainMetadata.symbol || 'UNKNOWN',
                    image: image,
                    description: onChainMetadata.description || ''
                },
                metadataUri: metadataUri
            });

        } catch (e) {
            logger.error('[TokenMetadata] Error', { mint: req.params.mint, error: e.message });
            res.status(500).json({
                success: false,
                error: 'Failed to fetch token metadata',
                details: e.message
            });
        }
    });

    /**
     * GET /token-lookup-batch
     * v25.37: Batch token lookup for external integrations
     *
     * Query parameters:
     * - mints: Comma-separated list of mint addresses (max 50)
     *
     * Returns an object with each mint as a key and its registration status as value.
     */
    router.get('/token-lookup-batch', async (req, res) => {
        try {
            const { mints } = req.query;

            if (!mints || typeof mints !== 'string') {
                return res.status(400).json({
                    error: 'Missing or invalid mints parameter. Provide comma-separated mint addresses.'
                });
            }

            const mintList = mints.split(',').map(m => m.trim()).filter(m => m.length > 0);

            if (mintList.length === 0) {
                return res.status(400).json({ error: 'No valid mint addresses provided' });
            }

            if (mintList.length > 50) {
                return res.status(400).json({ error: 'Maximum 50 mints per request' });
            }

            // Validate all mints
            const validMints = mintList.filter(m => isValidPubkey(m));
            if (validMints.length === 0) {
                return res.status(400).json({ error: 'No valid Solana addresses provided' });
            }

            const results = {};

            // Initialize all requested mints as not registered
            for (const mint of validMints) {
                results[mint] = { registered: false, type: null };
            }

            // Query ignition tokens
            if (validMints.length > 0) {
                const placeholders = validMints.map((_, i) => `$${i + 1}`).join(',');
                const ignitionTokens = await db.all(`
                    SELECT mint, ticker, name, "marketCap", volume24h
                    FROM tokens WHERE mint IN (${placeholders})
                `, validMints);

                for (const token of ignitionTokens) {
                    results[token.mint] = {
                        registered: true,
                        type: 'ignition',
                        ticker: token.ticker,
                        name: token.name,
                        marketCap: token.marketCap || 0,
                        volume24h: token.volume24h || 0
                    };
                }

                // Query robinhood tokens (only for mints not found in ignition)
                const remainingMints = validMints.filter(m => !results[m].registered);
                if (remainingMints.length > 0) {
                    const rhPlaceholders = remainingMints.map((_, i) => `$${i + 1}`).join(',');
                    const robinhoodTokens = await db.all(`
                        SELECT mint, ticker, name, "feeShareBps", "marketCap", volume24h, "isActive"
                        FROM robinhood_tokens WHERE mint IN (${rhPlaceholders})
                    `, remainingMints);

                    for (const token of robinhoodTokens) {
                        results[token.mint] = {
                            registered: true,
                            type: 'robinhood',
                            active: token.isActive === 1,
                            ticker: token.ticker,
                            name: token.name,
                            feeSharePercent: (token.feeShareBps / 100).toFixed(1),
                            marketCap: token.marketCap || 0,
                            volume24h: token.volume24h || 0
                        };
                    }
                }
            }

            res.json({
                total: validMints.length,
                registered: Object.values(results).filter(r => r.registered).length,
                results
            });

        } catch (e) {
            logger.error('[TokenLookupBatch] Error', { error: e.message });
            res.status(500).json({ error: 'Database error' });
        }
    });

    /**
     * POST /refresh-metadata/:mint
     * Force refresh metadata for a registered token
     * Fetches fresh data from DexScreener, Helius, and Pump.fun API
     */
    router.post('/refresh-metadata/:mint', async (req, res) => {
        try {
            const { mint } = req.params;

            if (!isValidPubkey(mint)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid mint address'
                });
            }

            // Check both tables for the token
            const regularToken = await db.get('SELECT * FROM tokens WHERE mint = $1', [mint]);
            const robinhoodToken = await db.get('SELECT * FROM robinhood_tokens WHERE mint = $1', [mint]);

            if (!regularToken && !robinhoodToken) {
                return res.status(404).json({
                    success: false,
                    error: 'Token not found. Please register the token first.'
                });
            }

            // Fetch fresh metadata from all sources
            logger.info(`[MetadataRefresh] Refreshing metadata for ${mint}`);

            const validTokens = await mintExtractor.validateMintsBatch([mint], { fetchMarketData: true });

            // Start with external API data or empty object
            const freshData = validTokens.length > 0 ? validTokens[0] : {};

            // v25.6: If no image from external APIs, try metadataUri fallback
            // This is critical for tokens launched via our platform
            if (!freshData.image && regularToken && regularToken.metadataUri) {
                logger.info(`[MetadataRefresh] No image from external APIs, trying metadataUri...`);
                try {
                    const metadataImage = await imageUtils.fetchImageFromMetadataUri(regularToken.metadataUri, 5000);
                    if (metadataImage) {
                        freshData.image = metadataImage;
                        logger.info(`[MetadataRefresh] Got image from metadataUri: ${metadataImage.substring(0, 60)}`);
                    }
                } catch (e) {
                    logger.warn(`[MetadataRefresh] metadataUri fetch failed: ${e.message}`);
                }
            }

            // If we still have no data at all, return error
            if (!freshData.ticker && !freshData.name && !freshData.image) {
                return res.status(400).json({
                    success: false,
                    error: 'Could not fetch metadata from any source',
                    metadataUri: regularToken?.metadataUri || null
                });
            }

            logger.info(`[MetadataRefresh] Got fresh data: ticker=${freshData.ticker}, name=${freshData.name}, image=${freshData.image ? 'YES' : 'NO'}`);

            // Update the appropriate table
            // FIX: Use NULLIF to convert empty string to NULL, so COALESCE preserves existing image
            if (robinhoodToken) {
                await db.run(`
                    UPDATE robinhood_tokens
                    SET ticker = $1, name = $2, image = COALESCE(NULLIF($3, ''), image),
                        "marketCap" = $4, volume24h = $5
                    WHERE mint = $6
                `, [
                    freshData.ticker || robinhoodToken.ticker,
                    freshData.name || robinhoodToken.name,
                    freshData.image || null,
                    freshData.marketCap || 0,
                    freshData.volume24h || 0,
                    mint
                ]);
            } else if (regularToken) {
                await db.run(`
                    UPDATE tokens
                    SET ticker = $1, name = $2, image = COALESCE(NULLIF($3, ''), image),
                        "marketCap" = $4, volume24h = $5, description = $6
                    WHERE mint = $7
                `, [
                    freshData.ticker || regularToken.ticker,
                    freshData.name || regularToken.name,
                    freshData.image || null,
                    freshData.marketCap || 0,
                    freshData.volume24h || 0,
                    freshData.description || regularToken.description || '',
                    mint
                ]);
            }

            // v25.6: Re-fetch the token to show the final state after update
            const updatedToken = robinhoodToken
                ? await db.get('SELECT * FROM robinhood_tokens WHERE mint = $1', [mint])
                : await db.get('SELECT * FROM tokens WHERE mint = $1', [mint]);

            res.json({
                success: true,
                message: 'Metadata refreshed successfully',
                token: {
                    mint,
                    ticker: freshData.ticker || updatedToken?.ticker,
                    name: freshData.name || updatedToken?.name,
                    image: updatedToken?.image || freshData.image, // Show final DB value
                    marketCap: freshData.marketCap || updatedToken?.marketCap,
                    volume24h: freshData.volume24h || updatedToken?.volume24h,
                    metadataUri: updatedToken?.metadataUri || null
                }
            });

        } catch (e) {
            logger.error('[MetadataRefresh] Error', { error: e.message, stack: e.stack });
            res.status(500).json({
                success: false,
                error: 'Failed to refresh metadata'
            });
        }
    });

    /**
     * POST /refresh-all-metadata
     * Batch refresh metadata for all tokens with missing images or Unknown tickers
     * Admin endpoint for fixing tokens that were registered without metadata
     * v25.5: Also handles 'null' string values and tries metadataUri fallback
     */
    router.post('/refresh-all-metadata', async (req, res) => {
        try {
            // v25.5: Find all robinhood tokens with missing metadata (including 'null' string)
            const robinhoodTokens = await db.all(`
                SELECT * FROM robinhood_tokens
                WHERE "isActive" = 1
                AND (image IS NULL OR image = '' OR image = 'null' OR ticker = 'UNKNOWN' OR name = 'Unknown Token')
            `);

            // v25.5: Find all regular tokens with missing metadata (including 'null' string)
            const regularTokens = await db.all(`
                SELECT * FROM tokens
                WHERE image IS NULL OR image = '' OR image = 'null' OR ticker = 'UNKNOWN' OR name = 'Unknown'
            `);

            const totalTokens = robinhoodTokens.length + regularTokens.length;
            logger.info(`[BatchMetadataRefresh] Found ${totalTokens} tokens with missing metadata (${robinhoodTokens.length} robinhood, ${regularTokens.length} regular)`);

            if (totalTokens === 0) {
                return res.json({
                    success: true,
                    message: 'All tokens already have metadata',
                    updated: 0
                });
            }

            let updated = 0;
            let failed = 0;

            // Process robinhood tokens
            for (const token of robinhoodTokens) {
                try {
                    const validTokens = await mintExtractor.validateMintsBatch([token.mint], { fetchMarketData: true });
                    if (validTokens.length > 0) {
                        const freshData = validTokens[0];
                        if (freshData.image || freshData.ticker !== 'UNKNOWN') {
                            // FIX: Use NULLIF to convert empty string to NULL, so COALESCE preserves existing image
                            await db.run(`
                                UPDATE robinhood_tokens
                                SET ticker = $1, name = $2, image = COALESCE(NULLIF($3, ''), image),
                                    "marketCap" = $4, volume24h = $5
                                WHERE mint = $6
                            `, [
                                freshData.ticker || token.ticker,
                                freshData.name || token.name,
                                freshData.image || null,
                                freshData.marketCap || 0,
                                freshData.volume24h || 0,
                                token.mint
                            ]);
                            updated++;
                            logger.info(`[BatchMetadataRefresh] Updated ${token.mint.slice(0, 8)}...: ${freshData.ticker}, image=${freshData.image ? 'YES' : 'NO'}`);
                        }
                    }
                    await new Promise(r => setTimeout(r, 200)); // Rate limit
                } catch (e) {
                    failed++;
                    logger.debug(`[BatchMetadataRefresh] Failed for ${token.mint}`, { error: e.message });
                }
            }

            // Process regular tokens
            for (const token of regularTokens) {
                try {
                    let imageToUse = null;
                    let tickerToUse = token.ticker;
                    let nameToUse = token.name;
                    let marketCapToUse = token.marketCap || 0;
                    let volumeToUse = token.volume24h || 0;

                    // v25.6: Log current state for debugging
                    logger.info(`[BatchMetadataRefresh] Processing ${token.mint.slice(0, 12)}...`, {
                        currentImage: token.image ? token.image.substring(0, 40) : 'NULL',
                        hasMetadataUri: !!token.metadataUri,
                        metadataUri: token.metadataUri ? token.metadataUri.substring(0, 50) : 'NULL'
                    });

                    // v25.5: First try to fetch from external APIs (DexScreener, Helius)
                    const validTokens = await mintExtractor.validateMintsBatch([token.mint], { fetchMarketData: true });
                    if (validTokens.length > 0) {
                        const freshData = validTokens[0];
                        if (freshData.image) imageToUse = freshData.image;
                        if (freshData.ticker && freshData.ticker !== 'UNKNOWN') tickerToUse = freshData.ticker;
                        if (freshData.name && freshData.name !== 'Unknown') nameToUse = freshData.name;
                        if (freshData.marketCap) marketCapToUse = freshData.marketCap;
                        if (freshData.volume24h) volumeToUse = freshData.volume24h;
                        logger.debug(`[BatchMetadataRefresh] External API result for ${token.mint.slice(0, 8)}`, {
                            gotImage: !!freshData.image,
                            ticker: freshData.ticker,
                            name: freshData.name
                        });
                    }

                    // v25.6: ALWAYS try metadataUri if we don't have an image yet
                    // This is the primary fallback for tokens launched via our platform
                    if (!imageToUse && token.metadataUri) {
                        logger.info(`[BatchMetadataRefresh] Trying metadataUri fallback for ${token.mint.slice(0, 8)}...`);
                        try {
                            const metadataImage = await imageUtils.fetchImageFromMetadataUri(token.metadataUri, 5000);
                            if (metadataImage) {
                                imageToUse = metadataImage;
                                logger.info(`[BatchMetadataRefresh] SUCCESS: Got image from metadataUri for ${token.mint.slice(0, 8)}`, {
                                    image: metadataImage.substring(0, 60)
                                });
                            } else {
                                logger.warn(`[BatchMetadataRefresh] metadataUri returned no image for ${token.mint.slice(0, 8)}`);
                            }
                        } catch (e) {
                            logger.warn(`[BatchMetadataRefresh] metadataUri fetch failed for ${token.mint.slice(0, 8)}`, { error: e.message });
                        }
                    }

                    // Update if we have any new data (including new image)
                    if (imageToUse || tickerToUse !== token.ticker || nameToUse !== token.name) {
                        await db.run(`
                            UPDATE tokens
                            SET ticker = $1, name = $2, image = COALESCE(NULLIF($3, ''), image),
                                "marketCap" = $4, volume24h = $5
                            WHERE mint = $6
                        `, [
                            tickerToUse,
                            nameToUse,
                            imageToUse || null,
                            marketCapToUse,
                            volumeToUse,
                            token.mint
                        ]);
                        updated++;
                        logger.info(`[BatchMetadataRefresh] Updated ${token.mint.slice(0, 8)}...: ${tickerToUse}, image=${imageToUse ? 'YES' : 'NO'}`);
                    }

                    await new Promise(r => setTimeout(r, 200)); // Rate limit
                } catch (e) {
                    failed++;
                    logger.debug(`[BatchMetadataRefresh] Failed for ${token.mint}`, { error: e.message });
                }
            }

            res.json({
                success: true,
                message: `Metadata refresh complete`,
                total: totalTokens,
                updated,
                failed
            });

        } catch (e) {
            logger.error('[BatchMetadataRefresh] Error', { error: e.message, stack: e.stack });
            res.status(500).json({
                success: false,
                error: 'Failed to refresh metadata'
            });
        }
    });

    /**
     * POST /refresh-token-image
     * v25.6: Refresh a single token's image from its metadataUri
     * Admin endpoint for fixing individual tokens
     */
    router.post('/refresh-token-image', async (req, res) => {
        const { mint } = req.body;

        if (!mint || !isValidPubkey(mint)) {
            return res.status(400).json({ error: 'Invalid mint address' });
        }

        try {
            // Get token from database (check both tables)
            const regularToken = await db.get('SELECT * FROM tokens WHERE mint = $1', [mint]);
            const robinhoodToken = await db.get('SELECT * FROM robinhood_tokens WHERE mint = $1', [mint]);
            const token = regularToken || robinhoodToken;
            const isRobinhood = !regularToken && !!robinhoodToken;

            if (!token) {
                return res.status(404).json({ error: 'Token not found in either table' });
            }

            logger.info(`[RefreshTokenImage] Processing ${mint}`, {
                currentImage: token.image ? token.image.substring(0, 50) : 'NULL',
                metadataUri: token.metadataUri ? token.metadataUri.substring(0, 60) : 'NULL',
                table: isRobinhood ? 'robinhood_tokens' : 'tokens'
            });

            let newImage = null;

            // Try metadataUri first (most reliable for our launched tokens)
            // Note: robinhood_tokens don't have metadataUri, so this only works for tokens table
            if (token.metadataUri) {
                logger.info(`[RefreshTokenImage] Fetching from metadataUri...`);
                try {
                    newImage = await imageUtils.fetchImageFromMetadataUri(token.metadataUri, 5000);
                    if (newImage) {
                        logger.info(`[RefreshTokenImage] Got image from metadataUri: ${newImage.substring(0, 60)}`);
                    }
                } catch (e) {
                    logger.warn(`[RefreshTokenImage] metadataUri fetch failed: ${e.message}`);
                }
            }

            // Fallback to external APIs
            if (!newImage) {
                logger.info(`[RefreshTokenImage] Trying external APIs...`);
                const validTokens = await mintExtractor.validateMintsBatch([mint], { fetchMarketData: true });
                if (validTokens.length > 0 && validTokens[0].image) {
                    newImage = validTokens[0].image;
                    logger.info(`[RefreshTokenImage] Got image from external API: ${newImage.substring(0, 60)}`);
                }
            }

            if (newImage) {
                // Update the correct table
                if (isRobinhood) {
                    await db.run('UPDATE robinhood_tokens SET image = $1 WHERE mint = $2', [newImage, mint]);
                } else {
                    await db.run('UPDATE tokens SET image = $1 WHERE mint = $2', [newImage, mint]);
                }
                logger.info(`[RefreshTokenImage] Updated image for ${mint} in ${isRobinhood ? 'robinhood_tokens' : 'tokens'}`);
                return res.json({
                    success: true,
                    message: 'Image updated',
                    image: newImage,
                    source: token.metadataUri ? 'metadataUri' : 'external',
                    table: isRobinhood ? 'robinhood_tokens' : 'tokens'
                });
            } else {
                return res.json({
                    success: false,
                    message: 'Could not find image from any source',
                    metadataUri: token.metadataUri || null
                });
            }
        } catch (e) {
            logger.error(`[RefreshTokenImage] Error: ${e.message}`);
            res.status(500).json({ error: 'Failed to refresh image' });
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
     * - originalCreator: Legacy parameter, no longer needed (auto-detected from on-chain data)
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
                            const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
                            const isOwnedByFee = directConfigInfo.owner.equals(FEE_PROGRAM);

                            // If owned by FEE program, scan for platform wallet in the data
                            let feeAccountWalletScan = null;
                            if (isOwnedByFee) {
                                const platformWalletBytes = devKeypair.publicKey.toBuffer();
                                const foundOffset = directConfigInfo.data.indexOf(platformWalletBytes);

                                if (foundOffset !== -1) {
                                    // Look for valid bps values in nearby bytes
                                    const nearbyBpsValues = [];

                                    // Check various offsets relative to wallet position
                                    const offsetsToCheck = [
                                        { name: 'after+0 (LE)', offset: foundOffset + 32, fn: (d, o) => d.readUInt16LE(o) },
                                        { name: 'after+0 (BE)', offset: foundOffset + 32, fn: (d, o) => d.readUInt16BE(o) },
                                        { name: 'before-2 (LE)', offset: foundOffset - 2, fn: (d, o) => d.readUInt16LE(o) },
                                        { name: 'before-2 (BE)', offset: foundOffset - 2, fn: (d, o) => d.readUInt16BE(o) },
                                        { name: 'after+2 (LE)', offset: foundOffset + 34, fn: (d, o) => d.readUInt16LE(o) },
                                        { name: 'after+4 (LE)', offset: foundOffset + 36, fn: (d, o) => d.readUInt16LE(o) },
                                    ];

                                    for (const check of offsetsToCheck) {
                                        if (check.offset >= 0 && check.offset + 2 <= directConfigInfo.data.length) {
                                            try {
                                                const value = check.fn(directConfigInfo.data, check.offset);
                                                nearbyBpsValues.push({
                                                    location: check.name,
                                                    offset: check.offset,
                                                    value,
                                                    percent: value / 100,
                                                    isValidBps: value > 0 && value <= 10000
                                                });
                                            } catch (e) {}
                                        }
                                    }

                                    // Also scan the ENTIRE account for 9000 (0x2328) to find where 90% bps is stored
                                    const target9000LE = Buffer.from([0x28, 0x23]); // 9000 in little-endian
                                    const target9000BE = Buffer.from([0x23, 0x28]); // 9000 in big-endian
                                    const found9000 = [];

                                    for (let i = 0; i < directConfigInfo.data.length - 1; i++) {
                                        if (directConfigInfo.data[i] === 0x28 && directConfigInfo.data[i+1] === 0x23) {
                                            found9000.push({ offset: i, endian: 'LE', value: 9000 });
                                        }
                                        if (directConfigInfo.data[i] === 0x23 && directConfigInfo.data[i+1] === 0x28) {
                                            found9000.push({ offset: i, endian: 'BE', value: 9000 });
                                        }
                                    }

                                    // Try to find the original creator by checking pubkeys at various offsets
                                    // and seeing if their fee_sharing_config PDA exists
                                    const potentialOriginalCreators = [];
                                    const offsetsToTry = [8, 11, 43, 75, 107];

                                    for (const off of offsetsToTry) {
                                        if (off + 32 <= directConfigInfo.data.length) {
                                            try {
                                                const potentialCreator = new PublicKey(directConfigInfo.data.slice(off, off + 32));
                                                const [feeSharingPDA] = PublicKey.findProgramAddressSync(
                                                    [Buffer.from("fee_sharing_config"), potentialCreator.toBuffer()],
                                                    PUMP
                                                );

                                                // Check if this PDA exists
                                                const pdaInfo = await connection.getAccountInfo(feeSharingPDA);

                                                potentialOriginalCreators.push({
                                                    offset: off,
                                                    pubkey: potentialCreator.toString(),
                                                    derivedFeeSharingPDA: feeSharingPDA.toString(),
                                                    pdaExists: !!pdaInfo,
                                                    pdaOwner: pdaInfo?.owner?.toString() || null,
                                                    pdaDataLength: pdaInfo?.data?.length || 0
                                                });
                                            } catch (e) {}
                                        }
                                    }

                                    feeAccountWalletScan = {
                                        walletFoundAtOffset: foundOffset,
                                        bytesAroundWallet: {
                                            before: directConfigInfo.data.slice(Math.max(0, foundOffset - 10), foundOffset).toString('hex'),
                                            wallet: directConfigInfo.data.slice(foundOffset, foundOffset + 32).toString('hex').slice(0, 20) + '...',
                                            after: directConfigInfo.data.slice(foundOffset + 32, Math.min(foundOffset + 50, directConfigInfo.data.length)).toString('hex')
                                        },
                                        nearbyBpsValues,
                                        found9000Locations: found9000,
                                        potentialOriginalCreators,
                                        accountSize: directConfigInfo.data.length
                                    };
                                } else {
                                    feeAccountWalletScan = {
                                        walletFound: false,
                                        platformWalletBytes: platformWalletBytes.toString('hex').slice(0, 32) + '...'
                                    };
                                }
                            }

                            directConfigLookup = {
                                configAddress: tokenCreator.toString(),
                                owner: directConfigInfo.owner.toString(),
                                isOwnedByPump,
                                isOwnedByFee,
                                dataLength: directConfigInfo.data.length,
                                error: 'Failed to parse as fee_sharing_config',
                                rawDataHex: directConfigInfo.data.slice(0, 100).toString('hex'),
                                feeAccountWalletScan
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

            // Try to get original creator from token metadata (the new method)
            let metadataCreatorLookup = null;
            const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
            try {
                // Derive metadata PDA for debugging
                const [metadataPDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mintPubkey.toBuffer()],
                    METADATA_PROGRAM
                );

                // Fetch metadata account to see what's there
                const metadataAccountInfo = await connection.getAccountInfo(metadataPDA);

                metadataCreatorLookup = {
                    metadataPDA: metadataPDA.toString(),
                    metadataExists: !!metadataAccountInfo,
                    metadataOwner: metadataAccountInfo?.owner.toString() || null,
                    metadataDataLength: metadataAccountInfo?.data.length || 0
                };

                if (metadataAccountInfo) {
                    const data = metadataAccountInfo.data;
                    // Extract update authority (offset 1-33)
                    const updateAuthority = new PublicKey(data.slice(1, 33));
                    metadataCreatorLookup.updateAuthority = updateAuthority.toString();

                    // Extract mint (offset 33-65)
                    const mintFromMetadata = new PublicKey(data.slice(33, 65));
                    metadataCreatorLookup.mintFromMetadata = mintFromMetadata.toString();

                    // Raw first 100 bytes for debugging
                    metadataCreatorLookup.rawDataHex = data.slice(0, 100).toString('hex');
                }

                const originalCreatorFromMetadata = await mintExtractor.getOriginalCreatorFromMetadata(mintPubkey, connection);
                if (originalCreatorFromMetadata) {
                    metadataCreatorLookup.originalCreatorFromMetadata = originalCreatorFromMetadata.toString();

                    // If we found the creator from metadata, try to derive and lookup fee_sharing_config
                    const [feeSharingConfigPDA] = PublicKey.findProgramAddressSync(
                        [Buffer.from("fee_sharing_config"), originalCreatorFromMetadata.toBuffer()],
                        PUMP
                    );
                    const configInfo = await connection.getAccountInfo(feeSharingConfigPDA);

                    metadataCreatorLookup.derivedFeeSharingConfigPDA = feeSharingConfigPDA.toString();
                    metadataCreatorLookup.configExists = !!configInfo;
                    metadataCreatorLookup.configOwner = configInfo?.owner.toString() || null;
                    metadataCreatorLookup.configDataLength = configInfo?.data.length || 0;

                    if (configInfo && configInfo.owner.equals(PUMP)) {
                        const parsed = parseFeeSharingConfigDebug(configInfo.data, feeSharingConfigPDA.toString());
                        metadataCreatorLookup.parsedConfig = parsed;
                    }
                } else {
                    metadataCreatorLookup.creatorLookupError = 'getOriginalCreatorFromMetadata returned null';

                    // If metadata doesn't have creator, try extracting from FEE account (creator_vault)
                    // Also try to verify by deriving the creator_vault PDA from potential creators
                    if (directConfigLookup && directConfigLookup.rawDataHex) {
                        try {
                            const feeData = Buffer.from(directConfigLookup.rawDataHex, 'hex');
                            const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

                            metadataCreatorLookup.creatorVaultAnalysis = {
                                rawDataLength: feeData.length,
                                coinCreator: tokenCreator?.toString()
                            };

                            // Try multiple offsets to find the original creator
                            // FEE account structure: 8 discriminator + 1 bump + 2 flags + 32 mint (offset 11) + 32 creator (offset 43)
                            const offsetsToTry = [43, 8, 9, 10, 11, 12, 44, 45, 75, 76, 77];
                            const potentialCreators = [];

                            for (const offset of offsetsToTry) {
                                if (feeData.length >= offset + 32) {
                                    try {
                                        const potentialCreator = new PublicKey(feeData.slice(offset, offset + 32));

                                        // Derive creator_vault PDAs to verify
                                        const [expectedVaultBC] = PublicKey.findProgramAddressSync(
                                            [Buffer.from("creator-vault"), potentialCreator.toBuffer()],
                                            PUMP
                                        );
                                        const [expectedVaultAMM] = PublicKey.findProgramAddressSync(
                                            [Buffer.from("creator_vault"), potentialCreator.toBuffer()],
                                            PUMP_AMM
                                        );

                                        const matchesBC = tokenCreator && expectedVaultBC.toString() === tokenCreator.toString();
                                        const matchesAMM = tokenCreator && expectedVaultAMM.toString() === tokenCreator.toString();

                                        potentialCreators.push({
                                            offset,
                                            pubkey: potentialCreator.toString(),
                                            derivedVaultBC: expectedVaultBC.toString(),
                                            derivedVaultAMM: expectedVaultAMM.toString(),
                                            matchesBC,
                                            matchesAMM
                                        });

                                        // If we found a match, derive the fee_sharing_config
                                        if (matchesBC || matchesAMM) {
                                            const [feeSharingConfigPDA] = PublicKey.findProgramAddressSync(
                                                [Buffer.from("fee_sharing_config"), potentialCreator.toBuffer()],
                                                PUMP
                                            );
                                            metadataCreatorLookup.matchedOriginalCreator = potentialCreator.toString();
                                            metadataCreatorLookup.matchedAtOffset = offset;
                                            metadataCreatorLookup.matchType = matchesBC ? 'BC' : 'AMM';
                                            metadataCreatorLookup.derivedFeeSharingConfigPDA = feeSharingConfigPDA.toString();

                                            const configInfo = await connection.getAccountInfo(feeSharingConfigPDA);
                                            metadataCreatorLookup.configExists = !!configInfo;
                                            metadataCreatorLookup.configOwner = configInfo?.owner.toString() || null;

                                            if (configInfo && configInfo.owner.equals(PUMP)) {
                                                const parsed = parseFeeSharingConfigDebug(configInfo.data, feeSharingConfigPDA.toString());
                                                metadataCreatorLookup.parsedConfig = parsed;
                                            }
                                        }
                                    } catch (e) {
                                        // Invalid pubkey at this offset
                                    }
                                }
                            }

                            metadataCreatorLookup.creatorVaultAnalysis.potentialCreators = potentialCreators;
                        } catch (fallbackError) {
                            metadataCreatorLookup.creatorVaultAnalysisError = fallbackError.message;
                        }
                    }
                }
            } catch (e) {
                metadataCreatorLookup = { error: e.message, stack: e.stack };
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

            // Run the actual verification
            const verification = await mintExtractor.verifyFeeRecipient(mint, platformWallet, connection);

            // Build a step-by-step trace for debugging - using the CORRECT approach
            const coinCreatorAddr = bcData?.creator || ammData?.creator || null;
            let step3Result = null;

            if (coinCreatorAddr) {
                // Step 3: Check if coin_creator is a FEE program account (creator_vault)
                // If so, parse the shareholders directly from that account
                const coinCreatorPubkey = new PublicKey(coinCreatorAddr);
                const coinCreatorAccountInfo = await connection.getAccountInfo(coinCreatorPubkey);
                const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
                const walletBytes = new PublicKey(platformWallet).toBuffer();

                if (coinCreatorAccountInfo?.owner.equals(FEE_PROGRAM)) {
                    // coin_creator is a creator_vault owned by FEE program
                    // Parse shareholders directly from this account data
                    const data = coinCreatorAccountInfo.data;
                    const dataLen = data.length;

                    // Parse the FEE account structure to find shareholders
                    // Structure: discriminator (8) + creator (32) + bump (1) + shareholders array
                    const shareholders = [];
                    let foundOurWallet = false;
                    let ourBps = 0;

                    // Try to find shareholders array at various offsets
                    // FEE creator_vault structure possibilities:
                    // 1. discriminator(8) + mint(32) + bump(1) + sharingConfig.creator(32) + arrayLen(4) = 77
                    // 2. Other variations
                    const shareholdersArrayOffsets = [76, 77, 75, 73, 45, 44, 43, 41, 40, 109, 107, 111];
                    let bestParse = null;

                    for (const arrayStartOffset of shareholdersArrayOffsets) {
                        if (arrayStartOffset + 4 > dataLen) continue;

                        const arrayLen = data.readUInt32LE(arrayStartOffset);
                        if (arrayLen < 1 || arrayLen > 10) continue;

                        const entrySize = 34;
                        const totalArrayDataSize = arrayLen * entrySize;
                        if (arrayStartOffset + 4 + totalArrayDataSize > dataLen) continue;

                        const parsedShareholders = [];
                        let valid = true;

                        for (let i = 0; i < arrayLen; i++) {
                            const entryOffset = arrayStartOffset + 4 + (i * entrySize);
                            const pubkeyBytes = data.slice(entryOffset, entryOffset + 32);
                            const bps = data.readUInt16LE(entryOffset + 32);

                            if (bps > 10000) {
                                valid = false;
                                break;
                            }

                            try {
                                const pubkeyStr = new PublicKey(pubkeyBytes).toString();
                                const isUs = pubkeyBytes.equals(walletBytes);
                                parsedShareholders.push({
                                    pubkey: pubkeyStr,
                                    bps,
                                    percent: bps / 100,
                                    isUs
                                });
                                if (isUs) {
                                    foundOurWallet = true;
                                    ourBps = bps;
                                }
                            } catch (e) {
                                valid = false;
                                break;
                            }
                        }

                        const totalBps = parsedShareholders.reduce((sum, s) => sum + s.bps, 0);
                        if (valid && parsedShareholders.length === arrayLen && totalBps > 0 && totalBps <= 10000) {
                            bestParse = {
                                offset: arrayStartOffset,
                                shareholders: parsedShareholders,
                                totalBps
                            };
                            break;
                        }
                    }

                    // Also scan for 9000 bps value directly
                    let bps9000Offset = null;
                    for (let i = 0; i < dataLen - 2; i++) {
                        if (data.readUInt16LE(i) === 9000) {
                            bps9000Offset = i;
                            break;
                        }
                    }

                    // Find all wallet occurrences
                    const walletOffsets = [];
                    let searchOffset = 0;
                    while (searchOffset < dataLen - 32) {
                        const idx = data.indexOf(walletBytes, searchOffset);
                        if (idx === -1) break;
                        walletOffsets.push(idx);
                        searchOffset = idx + 1;
                    }

                    step3Result = {
                        coinCreatorIsFeeAccount: true,
                        coinCreatorOwner: FEE_PROGRAM.toString(),
                        coinCreatorDataLength: dataLen,
                        walletFoundAtOffsets: walletOffsets,
                        bps9000FoundAtOffset: bps9000Offset,
                        shareholdersArrayParse: bestParse ? {
                            arrayOffset: bestParse.offset,
                            totalBps: bestParse.totalBps,
                            shareholders: bestParse.shareholders
                        } : null,
                        weAreShareHolder: foundOurWallet || walletOffsets.length > 0,
                        ourShareBps: ourBps || (walletOffsets.length > 0 && bps9000Offset ? 9000 : 0),
                        note: 'Parsed FEE account directly for shareholders'
                    };
                } else {
                    // coin_creator is NOT a FEE account, try the old PDA approach
                    const [feeSharingConfigPDA] = PublicKey.findProgramAddressSync(
                        [Buffer.from("fee_sharing_config"), coinCreatorPubkey.toBuffer()],
                        PUMP
                    );

                    const configAccountInfo = await connection.getAccountInfo(feeSharingConfigPDA);

                    if (configAccountInfo && configAccountInfo.owner.equals(PUMP)) {
                        const parsed = parseFeeSharingConfigDebug(configAccountInfo.data, feeSharingConfigPDA.toString());

                        step3Result = {
                            feeSharingConfigPDA: feeSharingConfigPDA.toString(),
                            derivedFrom: coinCreatorAddr,
                            exists: true,
                            owner: configAccountInfo.owner.toString(),
                            dataLength: configAccountInfo.data.length,
                            parsed,
                            shareholderCount: parsed?.shareholderCount || 0,
                            shareholders: parsed?.shareholders?.map(s => ({
                                pubkey: s.pubkey,
                                bps: s.shareBps,
                                percent: s.sharePercent,
                                isUs: s.isUs
                            })) || [],
                            weAreShareHolder: parsed?.weAreShareHolder || false,
                            ourShareBps: parsed?.shareholders?.find(s => s.isUs)?.shareBps || 0
                        };
                    } else {
                        step3Result = {
                            coinCreatorIsFeeAccount: false,
                            coinCreatorOwner: coinCreatorAccountInfo?.owner.toString() || 'unknown',
                            feeSharingConfigPDA: feeSharingConfigPDA.toString(),
                            exists: false,
                            note: 'coin_creator is not a FEE account and no fee_sharing_config PDA exists'
                        };
                    }
                }
            }

            const debugTrace = {
                step1_getCoinCreator: {
                    bcAddress: bondingCurve.toString(),
                    bcExists: !!bcData?.exists,
                    bcCreator: bcData?.creator || null,
                    ammAddress: pool.toString(),
                    ammExists: !!ammData?.exists,
                    ammCreator: ammData?.creator || null,
                    coinCreatorFound: coinCreatorAddr,
                    source: bcData?.exists ? 'bonding_curve' : (ammData?.exists ? 'amm_pool' : 'none')
                },
                step2_directCreatorCheck: {
                    coinCreator: coinCreatorAddr,
                    platformWallet: platformWallet,
                    isDirectCreator: (bcData?.creator === platformWallet) || (ammData?.creator === platformWallet)
                },
                step3_feeSharingConfigCheck: step3Result || { error: 'No coin_creator found' }
            };

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
                debugTrace, // Step-by-step verification trace
                directConfigLookup, // coin_creator IS the fee sharing config
                pdaConfigLookup, // Derived PDA lookup result
                shareholderConfigs, // Configs where we're a shareholder
                scanDebug, // Debug info about the scan
                feeAccountAnalysis, // Analysis of the FEE program account
                metadataCreatorLookup, // NEW: Original creator from token metadata
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

    // ========== FEE SHARE MANAGEMENT ENDPOINTS (v23.0) ==========

    /**
     * POST /refresh-fee-share/:mint
     * Refresh the fee share BPS for a Robinhood token from on-chain data
     * This allows users to update their token's reward distribution if it changed on Pump.fun
     */
    router.post('/refresh-fee-share/:mint', async (req, res) => {
        try {
            const { mint } = req.params;

            if (!isValidPubkey(mint)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid mint address'
                });
            }

            // Check if token exists in robinhood_tokens
            const robinhoodToken = await db.get(
                'SELECT * FROM robinhood_tokens WHERE mint = $1',
                [mint]
            );

            if (!robinhoodToken) {
                return res.status(404).json({
                    success: false,
                    error: 'Token not found in Robinhood tokens. Use /register-token to register it first.',
                    mint
                });
            }

            // Get our platform wallet address
            const platformWallet = devKeypair.publicKey.toString();

            // Verify current on-chain fee share
            logger.info(`[FeeShareRefresh] Refreshing fee share for ${mint.slice(0, 8)}...`);

            const verification = await mintExtractor.verifyFeeRecipient(
                mint,
                platformWallet,
                connection
            );

            if (!verification.isRecipient) {
                // We're no longer a fee recipient - deactivate the token
                await db.run(
                    'UPDATE robinhood_tokens SET "isActive" = 0 WHERE mint = $1',
                    [mint]
                );

                logger.warn(`[FeeShareRefresh] ${mint.slice(0, 8)}... - No longer a fee recipient, deactivated`);

                return res.json({
                    success: true,
                    changed: true,
                    deactivated: true,
                    message: 'Token is no longer sharing fees with our platform. Token has been deactivated.',
                    previousBps: robinhoodToken.feeShareBps,
                    currentBps: 0
                });
            }

            const previousBps = robinhoodToken.feeShareBps;
            const currentBps = verification.feeShareBps;
            const changed = previousBps !== currentBps;

            if (changed) {
                // Update the fee share BPS in the database
                await db.run(
                    'UPDATE robinhood_tokens SET "feeShareBps" = $1 WHERE mint = $2',
                    [currentBps, mint]
                );

                logger.info(`[FeeShareRefresh] ${robinhoodToken.ticker} (${mint.slice(0, 8)}...) - Fee share updated: ${previousBps} -> ${currentBps} bps`);
            }

            res.json({
                success: true,
                changed,
                deactivated: false,
                message: changed
                    ? `Fee share updated from ${previousBps / 100}% to ${currentBps / 100}%`
                    : 'Fee share is already up to date',
                previousBps,
                currentBps,
                previousPercent: previousBps / 100,
                currentPercent: currentBps / 100,
                source: verification.source
            });

        } catch (e) {
            logger.error('[FeeShareRefresh] Error', { error: e.message, stack: e.stack });
            res.status(500).json({
                success: false,
                error: 'Failed to refresh fee share'
            });
        }
    });

    /**
     * POST /reregister-token
     * Re-register a token that was previously registered but had its fee share changed
     * This allows the token to be updated with the new fee share percentage
     *
     * Required:
     * - mint: Token mint address
     *
     * This endpoint will:
     * 1. Verify the token is currently registered
     * 2. Re-verify on-chain fee share configuration
     * 3. Update the fee share BPS if changed
     * 4. Reactivate if previously deactivated
     *
     * v24.0: Added rate limiting (same as register-token)
     */
    router.post('/reregister-token', tokenRegistrationLimiter, async (req, res) => {
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

            // Check both tables for existing registration
            const existingToken = await db.get('SELECT * FROM tokens WHERE mint = $1', [mint]);
            const existingRobinhoodToken = await db.get('SELECT * FROM robinhood_tokens WHERE mint = $1', [mint]);

            if (!existingToken && !existingRobinhoodToken) {
                return res.status(404).json({
                    success: false,
                    error: 'Token not registered. Use /register-token to register it first.',
                    mint
                });
            }

            // Get our platform wallet address
            const platformWallet = devKeypair.publicKey.toString();

            // Re-verify on-chain fee share
            logger.info(`[TokenReregister] Re-verifying fee share for ${mint.slice(0, 8)}...`);

            const verification = await mintExtractor.verifyFeeRecipient(
                mint,
                platformWallet,
                connection
            );

            if (!verification.isRecipient) {
                return res.status(403).json({
                    success: false,
                    error: 'Verification failed: This token does not share fees with the IGNITION platform. The token creator must add our wallet as a fee recipient on Pump.fun.',
                    mint,
                    platformWallet
                });
            }

            const isDirectCreator = verification.source === 'bonding_curve' || verification.source === 'amm_pool';

            // Determine what changed and update accordingly
            if (existingRobinhoodToken) {
                const previousBps = existingRobinhoodToken.feeShareBps;
                const currentBps = verification.feeShareBps;
                const wasInactive = !existingRobinhoodToken.isActive;

                // Update the robinhood token with new fee share and reactivate if needed
                await db.run(`
                    UPDATE robinhood_tokens
                    SET "feeShareBps" = $1, "isActive" = 1
                    WHERE mint = $2
                `, [currentBps, mint]);

                logger.info(`[TokenReregister] ${existingRobinhoodToken.ticker} (${mint.slice(0, 8)}...) - Re-registered with ${currentBps} bps (was ${previousBps} bps)`);

                res.json({
                    success: true,
                    message: 'Token re-registered successfully',
                    token: {
                        mint,
                        ticker: existingRobinhoodToken.ticker,
                        name: existingRobinhoodToken.name,
                        previousFeeShareBps: previousBps,
                        currentFeeShareBps: currentBps,
                        previousFeeSharePercent: previousBps / 100,
                        currentFeeSharePercent: currentBps / 100,
                        wasReactivated: wasInactive,
                        source: verification.source
                    }
                });

            } else if (existingToken) {
                // Token was registered as direct creator
                // If now a fee shareholder (not direct creator), migrate to robinhood_tokens
                if (!isDirectCreator) {
                    // Fetch fresh metadata
                    const validTokens = await mintExtractor.validateMintsBatch([mint], { fetchMarketData: true });
                    const token = validTokens.length > 0 ? validTokens[0] : null;

                    // Insert into robinhood_tokens
                    await db.run(`
                        INSERT INTO robinhood_tokens (mint, ticker, name, image, "creatorPubkey", "feeShareBps", "discoveredAt", "marketCap", volume24h, "isActive")
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
                        ON CONFLICT (mint) DO UPDATE SET
                            "feeShareBps" = EXCLUDED."feeShareBps",
                            "isActive" = 1
                    `, [
                        mint,
                        token?.ticker || existingToken.ticker || 'UNKNOWN',
                        token?.name || existingToken.name || 'Unknown Token',
                        token?.image || existingToken.image || '',
                        verification.originalCreator || existingToken.userPubkey || 'unknown_creator',
                        verification.feeShareBps,
                        Date.now(),
                        token?.marketCap || existingToken.marketCap || 0,
                        token?.volume24h || existingToken.volume24h || 0
                    ]);

                    // Remove from tokens table
                    await db.run('DELETE FROM tokens WHERE mint = $1', [mint]);

                    logger.info(`[TokenReregister] ${existingToken.ticker} (${mint.slice(0, 8)}...) - Migrated from direct creator to fee shareholder (${verification.feeShareBps} bps)`);

                    res.json({
                        success: true,
                        message: 'Token re-registered as fee shareholder (migrated from direct creator)',
                        token: {
                            mint,
                            ticker: existingToken.ticker,
                            name: existingToken.name,
                            currentFeeShareBps: verification.feeShareBps,
                            currentFeeSharePercent: verification.feeSharePercent,
                            migrated: true,
                            source: verification.source
                        }
                    });
                } else {
                    // Still a direct creator, just confirm
                    res.json({
                        success: true,
                        message: 'Token is still registered as direct creator (100% fee share)',
                        token: {
                            mint,
                            ticker: existingToken.ticker,
                            name: existingToken.name,
                            currentFeeShareBps: 10000,
                            currentFeeSharePercent: 100,
                            source: verification.source
                        }
                    });
                }
            }

        } catch (e) {
            logger.error('[TokenReregister] Error', { error: e.message, stack: e.stack });
            res.status(500).json({
                success: false,
                error: 'Internal server error during re-registration'
            });
        }
    });

    /**
     * POST /refresh-all-fee-shares
     * Admin endpoint to refresh fee shares for all active Robinhood tokens
     * Useful for syncing after Pump.fun allows users to change reward distributions
     */
    router.post('/refresh-all-fee-shares', async (req, res) => {
        try {
            // Get all active robinhood tokens
            const tokens = await db.all(
                'SELECT * FROM robinhood_tokens WHERE "isActive" = 1'
            );

            if (tokens.length === 0) {
                return res.json({
                    success: true,
                    message: 'No active Robinhood tokens to refresh',
                    updated: 0,
                    deactivated: 0
                });
            }

            logger.info(`[BulkFeeShareRefresh] Refreshing fee shares for ${tokens.length} tokens...`);

            const platformWallet = devKeypair.publicKey.toString();
            let updated = 0;
            let deactivated = 0;
            let unchanged = 0;
            const results = [];

            for (const token of tokens) {
                try {
                    const verification = await mintExtractor.verifyFeeRecipient(
                        token.mint,
                        platformWallet,
                        connection
                    );

                    if (!verification.isRecipient) {
                        // No longer a fee recipient - deactivate
                        await db.run(
                            'UPDATE robinhood_tokens SET "isActive" = 0 WHERE mint = $1',
                            [token.mint]
                        );
                        deactivated++;
                        results.push({
                            mint: token.mint,
                            ticker: token.ticker,
                            action: 'deactivated',
                            previousBps: token.feeShareBps,
                            currentBps: 0
                        });
                    } else if (verification.feeShareBps !== token.feeShareBps) {
                        // Fee share changed - update
                        await db.run(
                            'UPDATE robinhood_tokens SET "feeShareBps" = $1 WHERE mint = $2',
                            [verification.feeShareBps, token.mint]
                        );
                        updated++;
                        results.push({
                            mint: token.mint,
                            ticker: token.ticker,
                            action: 'updated',
                            previousBps: token.feeShareBps,
                            currentBps: verification.feeShareBps
                        });
                    } else {
                        unchanged++;
                    }

                    // Rate limit
                    await new Promise(r => setTimeout(r, 100));

                } catch (e) {
                    logger.debug(`[BulkFeeShareRefresh] Error for ${token.mint}`, { error: e.message });
                    results.push({
                        mint: token.mint,
                        ticker: token.ticker,
                        action: 'error',
                        error: e.message
                    });
                }
            }

            logger.info(`[BulkFeeShareRefresh] Complete: ${updated} updated, ${deactivated} deactivated, ${unchanged} unchanged`);

            res.json({
                success: true,
                message: 'Fee share refresh complete',
                total: tokens.length,
                updated,
                deactivated,
                unchanged,
                results: results.filter(r => r.action !== 'unchanged') // Only show changed/errored tokens
            });

        } catch (e) {
            logger.error('[BulkFeeShareRefresh] Error', { error: e.message, stack: e.stack });
            res.status(500).json({
                success: false,
                error: 'Failed to refresh fee shares'
            });
        }
    });

    return router;
}

module.exports = { init };
