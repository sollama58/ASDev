/**
 * Token Routes
 * Token listing, leaderboard, and holder endpoints
 * v13.0 - Updated for PostgreSQL
 * v14.0 - Updated for proportional point system (Top 250 holders)
 * v18.0 - Changed from top 10 to volume threshold eligibility
 * v25.36 - User holdings now uses supply-based point calculation (1B total supply)
 * v25.37 - Added token-lookup and token-lookup-batch endpoints for external integrations
 * v25.64 - Added token-metadata endpoint for fetching on-chain metadata
 * v29.0 - ShitPad: platform-launched tokens only
 */
const express = require('express');
const axios = require('axios');
const { isValidPubkey } = require('./solana');
const { redis, logger, circuitBreaker, imageUtils } = require('../services');
const { safeBalance } = require('../utils');
const crypto = require('crypto');
const config = require('../config/env');
const router = express.Router();

// Hash a pubkey to a safe Redis key component (prevents key injection)
function hashPubkey(pubkey) {
    return crypto.createHash('sha256').update(pubkey).digest('hex').slice(0, 16);
}

// v18.0: Minimum 24hr volume for airdrop eligibility
const MIN_VOLUME_USD = config.AIRDROP_MIN_VOLUME_USD || 100;

// Admin auth middleware for sensitive endpoints
const adminAuth = require('./adminAuth'); // v28.6: shared middleware

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { db, globalState, devKeypair } = deps;

    // Bust the listing caches after any write that changes what tokens appear
    async function bustListingCaches() {
        try {
            await Promise.all([
                redis.invalidateCache('leaderboard_platform_data'),
                // Bust first two pages of all-launches (covers the common case)
                redis.invalidateCache('all_launches_v2600_50_0'),
                redis.invalidateCache('all_launches_v2600_100_0'),
            ]);
        } catch (e) {
            logger.debug('[Cache] Failed to bust listing caches', { error: e.message });
        }
    }

    // Get all launches - SCALABILITY FIX: Added pagination
    // v18.0: Added eligibility status based on volume threshold
    // Cached for 15 seconds per page
    // v22.0: Added input validation for pagination parameters
    router.get('/all-launches', async (req, res) => {
        try {
            // Validate and sanitize pagination params (prevent negative values and enforce limits)
            const rawLimit = parseInt(req.query.limit) || 50;
            const rawOffset = parseInt(req.query.offset) || 0;
            const limit = Math.min(Math.max(1, rawLimit), 100); // Min 1, Max 100
            const offset = Math.min(Math.max(0, rawOffset), 50000); // Min 0, Max 50000

            // Cache per page (limit + offset combo)
            // v30.1: bumped for the added quote_mint field -- a cached page from the old
            // shape would render every coin as SOL-quoted until the TTL expired.
            const cacheKey = `all_launches_v3010_${limit}_${offset}`;
            const { rows, total } = await redis.smartCache(cacheKey, 15, async () => {
                // v27.1: Include pending_airdrop_lamports for threshold display
                const combinedQuery = `
                    SELECT mint, "userPubkey", name, ticker, image, "metadataUri", "marketCap", volume24h, complete,
                           'platform' as source, 1 as "isActive", quote_mint,
                           COALESCE(pending_airdrop_lamports, 0) as pending_airdrop_lamports
                    FROM tokens
                    ORDER BY volume24h DESC
                    LIMIT $1 OFFSET $2
                `;
                const rows = await db.all(combinedQuery, [limit, offset]);

                const totalRow = await db.get(`SELECT COUNT(DISTINCT mint) as count FROM tokens`);
                const total = parseInt(totalRow?.count || 0);

                // M-2 FIX: Fetch fallback images INSIDE the cache so N+1 HTTP calls happen at most once per TTL,
                // not on every request. Results with resolved images are cached together with token rows.
                const processedRows = await Promise.all(rows.map(async (r) => {
                    let image = r.image;
                    if ((!image || image === '' || image === 'null') && r.metadataUri) {
                        try {
                            const fallbackImage = await imageUtils.fetchImageFromMetadataUri(r.metadataUri, 2000);
                            if (fallbackImage) {
                                image = fallbackImage;
                                // Persist to DB so future queries return it directly
                                db.run('UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = \'\' OR image = \'null\')',
                                    [fallbackImage, r.mint]).catch(() => {});
                            }
                        } catch (e) {
                            // Silently fail - use whatever we have
                        }
                    }
                    return { ...r, image };
                }));

                return { rows: processedRows, total };
            });

            // v25.4: Images already resolved inside cache — map directly
            const allLaunches = rows.map((r) => ({
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
                isEligible: (r.volume24h || 0) >= MIN_VOLUME_USD,
                // v25.0: Include source to differentiate token types
                source: r.source || 'platform',
                // v25.89: Whether token is active (fee sharing confirmed on-chain)
                isActive: r.isActive !== 0,
                // v27.1: Individual token pending pool
                pendingAirdropSol: ((r.pending_airdrop_lamports || 0) / 1e9).toFixed(6),
                // v30.1: null means SOL-quoted, which is every coin launched before Custom
                // Pairs. The frontend resolves the mint to a symbol from /api/quote-assets.
                quoteMint: r.quote_mint || null
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

                const kothMint = aiSelection?.mint;
                let koth = null;
                let source = 'platform';

                if (kothMint) {
                    // First check platform tokens
                    koth = await db.get(`
                        SELECT mint, "userPubkey", name, ticker, image, "metadataUri", "marketCap", volume24h, "holderCount"
                        FROM tokens WHERE mint = $1
                    `, [kothMint]);
                }

                // Fallback: highest mcap platform token
                if (!koth) {
                    koth = await db.get(`
                        SELECT mint, "userPubkey", name, ticker, image, "metadataUri", "marketCap", volume24h, "holderCount"
                        FROM tokens WHERE "marketCap" > 0
                        ORDER BY "marketCap" DESC LIMIT 1
                    `);
                    source = 'platform';
                }

                if (koth) {
                    // v25.4: Fetch image from metadataUri if missing
                    let image = koth.image;
                    if ((!image || image === '' || image === 'null') && koth.metadataUri) {
                        try {
                            const fallbackImage = await imageUtils.fetchImageFromMetadataUri(koth.metadataUri, 2000);
                            if (fallbackImage) {
                                image = fallbackImage;
                                db.run(`UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = '' OR image = 'null')`,
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
                            holderCount: koth.holderCount || 0,
                            source: source
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
                            runnerUpReason: aiSelection.runnerUpReason || null,
                            source: aiSelection.source || source
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
    router.get('/pump-proxy/:mint', adminAuth, async (req, res) => {
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
            if (!isValidPubkey(mint)) return res.status(400).json({ error: "Invalid mint address" });
            // M-2: Cache per-token holder list for 30s
            const holders = await redis.smartCache(`token_holders_${mint}`, 30, async () => {
                return await db.all(
                    'SELECT rank, "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC LIMIT 250',
                    [mint]
                );
            });
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
                basePoints: 0,
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
                    multiplier,
                    total_points,
                    expected_airdrop_sol,
                    COALESCE(central_pool_expected_sol, 0) as central_pool_expected_sol,
                    positions_count,
                    is_asdf_holder
                FROM user_points
                WHERE pubkey = $1
            `, [userPubkey]);

            // If user not found in user_points, check if they have any holdings
            if (!userPoints) {
                // M-6: Cache the "unknown user" response for 5s to avoid repeated DB scans
                const unknownCacheKey = `check_holder_unknown_${hashPubkey(userPubkey)}`;
                const holdingsCount = await redis.smartCache(unknownCacheKey, 5, async () => {
                    const row = await db.get(
                        'SELECT COUNT(*) as count FROM token_holders WHERE "holderPubkey" = $1',
                        [userPubkey]
                    );
                    return row?.count || 0;
                });

                return res.json({
                    isHolder: (holdingsCount || 0) > 0,
                    isAsdfTop50: false,
                    points: 0,
                    multiplier: 1,
                    heldPositionsCount: holdingsCount || 0,
                    basePoints: 0,
                    expectedAirdrop: 0,
                    expectedAirdropCurrency: 'SOL'
                });
            }

            // Return data from user_points table
            const expectedAirdrop = userPoints.expected_airdrop_sol || 0;
            const centralPoolExpected = userPoints.central_pool_expected_sol || 0;
            const perTokenExpected = Math.max(0, expectedAirdrop - centralPoolExpected);
            const MIN_AIRDROP_SOL = 0.01;
            res.json({
                isHolder: true,
                isAsdfTop50: userPoints.is_asdf_holder || false,
                points: Math.round((userPoints.total_points || 0) * 100) / 100,
                multiplier: userPoints.multiplier || 1,
                heldPositionsCount: userPoints.positions_count || 0,
                basePoints: Math.round((userPoints.base_points || 0) * 100) / 100,
                expectedAirdrop,
                // v27.0: Breakdown of expected airdrop by pool type
                perTokenExpectedAirdrop: perTokenExpected,
                centralPoolExpectedAirdrop: centralPoolExpected,
                expectedAirdropCurrency: 'SOL',
                minimumAirdropSol: MIN_AIRDROP_SOL,
                belowMinimum: expectedAirdrop > 0 && expectedAirdrop < MIN_AIRDROP_SOL
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
            return res.json({ holdings: [], eligibilityThreshold: MIN_VOLUME_USD });
        }
        if (!isValidPubkey(userPubkey)) {
            return res.status(400).json({ error: "Invalid Solana address" });
        }

        try {
            // Get ASDF status + multiplier from user_points (needed for airdrop weight in cache key)
            const userPointsData = await db.get(`
                SELECT multiplier, is_asdf_holder, COALESCE(central_pool_expected_sol, 0) as central_pool_expected_sol
                FROM user_points WHERE pubkey = $1
            `, [userPubkey]);

            const isAsdfHolder = !!(userPointsData?.is_asdf_holder);

            // Per-token expected airdrop uses simple balance/totalTracked (unweighted).
            // We can't compute a correct ASDF-weighted denominator here without fetching all
            // holders per token. The accurate ASDF-adjusted aggregate is in user_points.
            const cacheKey = `user_holdings_detail_v4_${hashPubkey(userPubkey)}`;
            const holdingsData = await redis.smartCache(cacheKey, 60, async () => { // H-4: 60s TTL
                const holdings = [];

                // v24.0: Single optimized query with JOINs for launched tokens
                const launchedHoldings = await db.all(`
                    SELECT
                        t.mint,
                        t.ticker,
                        t.name,
                        t.image,
                        t."userPubkey" as creator,
                        t.volume24h,
                        t."marketCap",
                        COALESCE(t.pending_airdrop_lamports, 0) as pending_airdrop_lamports,
                        th.balance,
                        th.rank
                    FROM token_holders th
                    INNER JOIN tokens t ON t.mint = th.mint
                    WHERE th."holderPubkey" = $1 AND CAST(COALESCE(NULLIF(th.balance, ''), '0') AS BIGINT) > 0
                    ORDER BY t.volume24h DESC
                `, [userPubkey]);

                // Batch-query total tracked balances for platform tokens (excludes LP/burnt supply)
                const launchedMints = launchedHoldings.map(r => r.mint);
                const platformTotalBalMap = new Map();
                if (launchedMints.length > 0) {
                    const totals = await db.all(
                        `SELECT mint, SUM(CAST(COALESCE(NULLIF(balance, ''), '0') AS BIGINT)) as total_bal FROM token_holders WHERE mint = ANY($1) GROUP BY mint`,
                        [launchedMints]
                    );
                    for (const r of totals) platformTotalBalMap.set(r.mint, BigInt(r.total_bal || '0'));
                }

                for (const row of launchedHoldings) {
                    const userBalance = safeBalance(row.balance);
                    if (userBalance === 0n) continue;

                    const isEligible = (row.volume24h || 0) >= MIN_VOLUME_USD;
                    const pendingLamports = BigInt(row.pending_airdrop_lamports || 0);
                    const totalTracked = platformTotalBalMap.get(row.mint) || 0n;

                    // Use tracked holder total as denominator — excludes LP and burnt tokens
                    const ownershipPct = totalTracked > 0n
                        ? Math.round(Number(userBalance * 1000000n / totalTracked)) / 10000
                        : 0;
                    const expectedLamports = (pendingLamports > 0n && totalTracked > 0n)
                        ? Number(pendingLamports * 99n / 100n * userBalance / totalTracked)
                        : 0;

                    holdings.push({
                        mint: row.mint,
                        ticker: row.ticker,
                        name: row.name,
                        image: row.image,
                        volume24h: row.volume24h || 0,
                        marketCap: row.marketCap || 0,
                        rank: row.rank,
                        isEligible,
                        ownershipPct,
                        pendingAirdropSol: (Number(pendingLamports) / 1e9).toFixed(6),
                        expectedAirdropSol: (expectedLamports / 1e9).toFixed(6),
                        source: 'launched'
                    });
                }

                // M-9: Sort by expected airdrop SOL descending (already computed — stable JS sort)
                holdings.sort((a, b) => parseFloat(b.expectedAirdropSol) - parseFloat(a.expectedAirdropSol));
                return holdings;
            });

            // v27.0: Attach central pool expected from user_points for frontend breakdown
            const centralPoolExpectedSol = parseFloat(userPointsData?.central_pool_expected_sol || 0);

            res.json({
                holdings: holdingsData,
                multiplier: userPointsData?.multiplier || 1,
                isAsdfHolder: !!(userPointsData?.is_asdf_holder),
                eligibilityThreshold: MIN_VOLUME_USD,
                centralPoolExpectedSol
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
            const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
            const offset = Math.min(Math.max(parseInt(req.query.offset) || 0, 0), 100000);

            // C-4: Cache per pagination page for 30s to avoid repeated full-table scans
            const cacheKey = `all_eligible_users_${limit}_${offset}`;
            const result = await redis.smartCache(cacheKey, 30, async () => {
                const users = await db.all(`
                    SELECT
                        pubkey,
                        multiplier,
                        expected_airdrop_sol,
                        positions_count,
                        is_asdf_holder
                    FROM user_points
                    WHERE expected_airdrop_sol > 0 AND pubkey != $1
                    ORDER BY expected_airdrop_sol DESC
                    LIMIT $2 OFFSET $3
                `, [devPubkey, limit, offset]);

                const globalTotalRow = await db.get(
                    'SELECT COUNT(*) as count, SUM(expected_airdrop_sol) as total_sol FROM user_points WHERE expected_airdrop_sol > 0 AND pubkey != $1',
                    [devPubkey]
                );
                const globalTotalSol = Math.round((parseFloat(globalTotalRow?.total_sol) || 0) * 10000) / 10000;

                return {
                    users: users.map(user => ({
                        pubkey: user.pubkey,
                        positions: user.positions_count || 0,
                        isAsdfTop50: user.is_asdf_holder || false,
                        expectedAirdrop: user.expected_airdrop_sol || 0,
                        expectedAirdropCurrency: 'SOL'
                    })),
                    totalPendingSol: globalTotalSol
                };
            });

            res.json({
                users: result.users,
                totalPendingSol: result.totalPendingSol,
                currency: 'SOL',
                eligibilityThreshold: MIN_VOLUME_USD,
                pagination: { limit, offset }
            });
        } catch (e) {
            logger.error('[all-eligible-users] Error', { error: e.message });
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Airdrop logs
    router.get('/airdrop-logs', async (req, res) => {
        try {
            // M-4: Cache airdrop logs for 10s — they change infrequently
            const logs = await redis.smartCache('airdrop_logs_recent', 10, async () => {
                return await db.all('SELECT * FROM airdrop_logs ORDER BY timestamp DESC LIMIT 20');
            });
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

            // C-4: Cache per-user stats for 30s — ranking queries are expensive
            const cached = await redis.smartCache(`user_airdrop_stats_${hashPubkey(pubkey)}`, 30, async () => {

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

            return {
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
            };
            }); // end smartCache

            res.json(cached);
        } catch (e) {
            logger.error('[user-airdrop-stats] Error', { error: e.message, pubkey: req.params.pubkey });
            res.status(500).json({ error: "Failed to fetch airdrop stats" });
        }
    });

    /**
     * GET /token-lookup/:mint
     * v25.37: Comprehensive token lookup for external integrations (DexScreener, etc.)
     *
     * Checks if a token was launched on this platform and returns:
     * - Whether the token is registered
     * - Token metadata and market data
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

            // M-8: Cache token lookup for 60s per mint
            const lookupResult = await redis.smartCache(`token_lookup_${mint}`, 60, async () => {
            // Check the tokens table (IGNITION-launched tokens)
            const ignitionToken = await db.get(`
                SELECT mint, ticker, name, image, "metadataUri", "userPubkey", "marketCap", volume24h, timestamp
                FROM tokens WHERE mint = $1
            `, [mint]);

            if (ignitionToken) {
                let image = ignitionToken.image;
                if ((!image || image === '' || image === 'null') && ignitionToken.metadataUri) {
                    try {
                        const fallbackImage = await imageUtils.fetchImageFromMetadataUri(ignitionToken.metadataUri, 3000);
                        if (fallbackImage) {
                            image = fallbackImage;
                            db.run('UPDATE tokens SET image = $1 WHERE mint = $2', [fallbackImage, mint]).catch(() => {});
                        }
                    } catch (e) { /* silent fail */ }
                }
                return {
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
                };
            }

            return {
                registered: false,
                type: null,
                mint: mint
            };
            }); // end smartCache

            return res.json(lookupResult);
        } catch (e) {
            logger.error('[TokenLookup] Error', { mint: req.params.mint, error: e.message });
            res.status(500).json({
                registered: false,
                error: 'Database error'
            });
        }
    });

    /**
     * GET /token-metadata/:mint
     * v25.64: Fetch token metadata directly from on-chain via Helius DAS API
     *
     * Used by the frontend to extract an image from on-chain metadata
     * without relying on external APIs like DexScreener or Pump.fun
     *
     * Returns:
     * - success: boolean
     * - metadata: { name, symbol, image, description }
     * - metadataUri: The raw metadata URI from on-chain
     */
    router.get('/token-metadata/:mint', adminAuth, async (req, res) => {
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
                error: 'Failed to fetch token metadata'
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
    router.post('/refresh-metadata/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;

            if (!isValidPubkey(mint)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid mint address'
                });
            }

            const regularToken = await db.get('SELECT * FROM tokens WHERE mint = $1', [mint]);

            if (!regularToken) {
                return res.status(404).json({
                    success: false,
                    error: 'Token not found.'
                });
            }

            // Fetch fresh metadata from all sources
            logger.info(`[MetadataRefresh] Refreshing metadata for ${mint}`);

            const validTokens = [...(await require('../tasks/metadataUpdater').fetchFreshMarketData([mint])).values()];

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

            // FIX: Use NULLIF to convert empty string to NULL, so COALESCE preserves existing image
            {
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
            const updatedToken = await db.get('SELECT * FROM tokens WHERE mint = $1', [mint]);

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
    router.post('/refresh-all-metadata', adminAuth, async (req, res) => {
        // C-5: Respond immediately with 202 and run the heavy work asynchronously
        res.status(202).json({ success: true, message: 'Metadata refresh started. Check logs for progress.' });

        (async () => {
        try {
            // v25.5: Find all tokens with missing metadata (including 'null' string)
            const regularTokens = await db.all(`
                SELECT * FROM tokens
                WHERE image IS NULL OR image = '' OR image = 'null' OR ticker = 'UNKNOWN' OR name = 'Unknown'
            `);

            const totalTokens = regularTokens.length;
            logger.info(`[BatchMetadataRefresh] Found ${totalTokens} tokens with missing metadata`);

            // The 202 has already been sent, so there is nothing to respond with here.
            if (totalTokens === 0) {
                logger.info('[BatchMetadataRefresh] All tokens already have metadata');
                return;
            }

            let updated = 0;
            let failed = 0;

            // Process tokens
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
                    const validTokens = [...(await require('../tasks/metadataUpdater').fetchFreshMarketData([token.mint])).values()];
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

            logger.info(`[BatchMetadataRefresh] Complete: ${updated} updated, ${failed} failed out of ${totalTokens}`);
        } catch (e) {
            logger.error('[BatchMetadataRefresh] Error', { error: e.message });
        }
        })();
    });

    /**
     * POST /refresh-token-image
     * v25.6: Refresh a single token's image from its metadataUri
     * Admin endpoint for fixing individual tokens
     */
    router.post('/refresh-token-image', adminAuth, async (req, res) => {
        const { mint } = req.body;

        if (!mint || !isValidPubkey(mint)) {
            return res.status(400).json({ error: 'Invalid mint address' });
        }

        try {
            const token = await db.get('SELECT * FROM tokens WHERE mint = $1', [mint]);

            if (!token) {
                return res.status(404).json({ error: 'Token not found' });
            }

            logger.info(`[RefreshTokenImage] Processing ${mint}`, {
                currentImage: token.image ? token.image.substring(0, 50) : 'NULL',
                metadataUri: token.metadataUri ? token.metadataUri.substring(0, 60) : 'NULL'
            });

            let newImage = null;

            // Try metadataUri first (most reliable for our launched tokens)
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
                const validTokens = [...(await require('../tasks/metadataUpdater').fetchFreshMarketData([mint])).values()];
                if (validTokens.length > 0 && validTokens[0].image) {
                    newImage = validTokens[0].image;
                    logger.info(`[RefreshTokenImage] Got image from external API: ${newImage.substring(0, 60)}`);
                }
            }

            if (newImage) {
                await db.run('UPDATE tokens SET image = $1 WHERE mint = $2', [newImage, mint]);
                logger.info(`[RefreshTokenImage] Updated image for ${mint}`);
                return res.json({
                    success: true,
                    message: 'Image updated',
                    image: newImage,
                    source: token.metadataUri ? 'metadataUri' : 'external'
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

    // ========== DIAGNOSTIC ENDPOINTS ==========

    // v19.0: Debug endpoint for expected airdrop calculation
    router.get('/debug/airdrop-calculation', adminAuth, async (req, res) => {
        const { userPubkey } = req.query;

        try {
            // v26.0: Per-token pool system
            const totalPoints = await redis.getTotalPoints();
            // v30.2: from the database; globalState is not written in the API process.
            const pendingRow = await db.get('SELECT COALESCE(SUM(pending_airdrop_lamports), 0) AS total FROM tokens');
            const totalPendingSol = Number(pendingRow?.total || 0) / 1e9; // sum of all token pending pools

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
                    formattedSOL: expectedAirdrop.toFixed(6)
                };
            }

            res.json({
                globalState: {
                    totalPoints,
                    // v26.0: total pending across all per-token pools
                    totalPendingAirdropSOL: Math.round(totalPendingSol * 10000) / 10000,
                    formattedPending: totalPendingSol.toFixed(4) + ' SOL'
                },
                topExpectedAirdrops: topAirdrops,
                totalUsersWithAirdrop: allAirdrops.size,
                userInfo,
                calculationFormula: 'v26.3: expectedAirdrop = SUM over held tokens of (pending * 99% * holderBalance / totalTrackedHolderBalances). ASDF Top 100 get 2× weight.',
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
    router.get('/debug/db-status', adminAuth, async (req, res) => {
        try {
            const tokenCount = await db.get('SELECT COUNT(*) as count FROM tokens');
            const holderCount = await db.get('SELECT COUNT(*) as count FROM token_holders');
            const recentTokens = await db.all('SELECT mint, ticker, name, timestamp FROM tokens ORDER BY timestamp DESC LIMIT 5');
            const lastBackendUpdate = await redis.getLastBackendUpdate();

            res.json({
                status: 'connected',
                tables: {
                    tokens: parseInt(tokenCount?.count) || 0,
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

    // v19.0: Metadata status debug endpoint
    // Shows which tokens have missing metadata (images, price, volume)
    router.get('/debug/metadata-status', adminAuth, async (req, res) => {
        try {
            // Get all tokens with their metadata status
            const tokens = await db.all(`
                SELECT mint, ticker, name, image, "priceUsd", volume24h, "marketCap", "lastUpdated"
                FROM tokens
                ORDER BY volume24h DESC
                LIMIT 100
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

            // Summary stats
            const tokenSummary = {
                total: tokens.length,
                withImage: tokensAnalysis.filter(t => t.hasImage).length,
                withPrice: tokensAnalysis.filter(t => t.hasPrice).length,
                withVolume: tokensAnalysis.filter(t => t.hasVolume).length,
                withMarketCap: tokensAnalysis.filter(t => t.hasMarketCap).length,
                complete: tokensAnalysis.filter(t => t.hasImage && t.hasPrice && t.hasVolume && t.hasMarketCap).length
            };

            res.json({
                tokens: {
                    summary: tokenSummary,
                    // Show tokens missing any metadata
                    missingMetadata: tokensAnalysis.filter(t => !t.hasImage || !t.hasPrice || !t.hasVolume),
                    // Show tokens with complete metadata
                    complete: tokensAnalysis.filter(t => t.hasImage && t.hasPrice && t.hasVolume && t.hasMarketCap).slice(0, 10)
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
    router.get('/debug/test-dexscreener/:mint', adminAuth, async (req, res) => {
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
