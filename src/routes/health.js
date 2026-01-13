/**
 * Health & Status Routes
 * Server health, stats, and debugging endpoints
 * v23.0 - Added Robinhood pending fees to health endpoint
 * v24.0 - Parallelized Robinhood fee calculation, added circuit breaker
 */
const express = require('express');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, PROGRAMS } = require('../config/constants');
const { pump, logger, imageUtils, circuitBreaker, redis, claudeKoth } = require('../services');

const router = express.Router();

// v24.0 SECURITY FIX: Rate limiter using Redis for multi-instance support
// Fallback to in-memory Map if Redis unavailable
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_RATE_LIMIT_KEY_PREFIX = 'admin_rate_limit:';

// In-memory fallback for when Redis is unavailable
const adminLoginAttemptsFallback = new Map();

async function checkAdminRateLimit(ip) {
    const now = Date.now();
    const redisConn = redis.getConnection?.();

    // v24.0: Try Redis first for distributed rate limiting
    if (redisConn && redis.isRedisConnected()) {
        try {
            const key = `${ADMIN_RATE_LIMIT_KEY_PREFIX}${ip}`;
            const data = await redisConn.get(key);

            if (!data) {
                return { allowed: true, remaining: ADMIN_LOGIN_MAX_ATTEMPTS, resetAt: now + ADMIN_LOGIN_WINDOW_MS };
            }

            const attempts = JSON.parse(data);
            if (now > attempts.resetAt) {
                // Window expired, reset
                await redisConn.del(key);
                return { allowed: true, remaining: ADMIN_LOGIN_MAX_ATTEMPTS, resetAt: now + ADMIN_LOGIN_WINDOW_MS };
            }

            return {
                allowed: attempts.count < ADMIN_LOGIN_MAX_ATTEMPTS,
                remaining: Math.max(0, ADMIN_LOGIN_MAX_ATTEMPTS - attempts.count),
                resetAt: attempts.resetAt
            };
        } catch (e) {
            logger.debug('[AdminRateLimit] Redis check failed, using fallback', { error: e.message });
        }
    }

    // Fallback to in-memory
    const attempts = adminLoginAttemptsFallback.get(ip) || { count: 0, resetAt: now + ADMIN_LOGIN_WINDOW_MS };
    if (now > attempts.resetAt) {
        attempts.count = 0;
        attempts.resetAt = now + ADMIN_LOGIN_WINDOW_MS;
    }

    return {
        allowed: attempts.count < ADMIN_LOGIN_MAX_ATTEMPTS,
        remaining: Math.max(0, ADMIN_LOGIN_MAX_ATTEMPTS - attempts.count),
        resetAt: attempts.resetAt
    };
}

async function recordAdminLoginAttempt(ip, success) {
    const now = Date.now();
    const redisConn = redis.getConnection?.();

    // v24.0: Try Redis first for distributed rate limiting
    if (redisConn && redis.isRedisConnected()) {
        try {
            const key = `${ADMIN_RATE_LIMIT_KEY_PREFIX}${ip}`;
            const data = await redisConn.get(key);

            let attempts = data ? JSON.parse(data) : { count: 0, resetAt: now + ADMIN_LOGIN_WINDOW_MS };

            if (now > attempts.resetAt) {
                attempts = { count: 0, resetAt: now + ADMIN_LOGIN_WINDOW_MS };
            }

            if (!success) {
                attempts.count++;
            } else {
                attempts.count = 0;
            }

            // Set with TTL matching the window
            const ttlSeconds = Math.ceil((attempts.resetAt - now) / 1000);
            await redisConn.set(key, JSON.stringify(attempts), 'EX', Math.max(1, ttlSeconds));
            return;
        } catch (e) {
            logger.debug('[AdminRateLimit] Redis record failed, using fallback', { error: e.message });
        }
    }

    // Fallback to in-memory
    let attempts = adminLoginAttemptsFallback.get(ip) || { count: 0, resetAt: now + ADMIN_LOGIN_WINDOW_MS };

    if (now > attempts.resetAt) {
        attempts.count = 0;
        attempts.resetAt = now + ADMIN_LOGIN_WINDOW_MS;
    }

    if (!success) {
        attempts.count++;
    } else {
        attempts.count = 0;
    }

    adminLoginAttemptsFallback.set(ip, attempts);

    // Cleanup old entries periodically
    if (adminLoginAttemptsFallback.size > 1000) {
        for (const [key, val] of adminLoginAttemptsFallback) {
            if (now > val.resetAt) adminLoginAttemptsFallback.delete(key);
        }
    }
}

// Admin auth middleware for sensitive endpoints
// SECURITY FIX: Always require admin key in all environments
const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-admin-key'];
    const expectedKey = process.env.ADMIN_API_KEY;

    // SECURITY: Always require admin key - no environment exceptions
    if (!expectedKey) {
        logger.warn('Admin endpoint accessed but ADMIN_API_KEY not configured');
        return res.status(403).json({ error: 'Admin endpoints not configured' });
    }

    // Use timing-safe comparison to prevent timing attacks
    const crypto = require('crypto');
    if (!apiKey || apiKey.length !== expectedKey.length ||
        !crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(expectedKey))) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
};

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { connection, devKeypair, db, redis, getStats, getTotalLaunches, globalState } = deps;

    // Version endpoint
    router.get('/version', (req, res) => {
        res.json({ version: config.VERSION });
    });

    // Health check
    router.get('/health', async (req, res) => {
        try {
            const cachedHealth = await redis.smartCache('health_data', 10, async () => {
                const stats = await getStats();
                const launches = await getTotalLaunches();
                // v25.12: Added try-catch for logs query to prevent health endpoint failure
                let logs = [];
                try {
                    logs = await db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 50') || [];
                } catch (e) {
                    logger.debug('[Health] Failed to fetch logs', { error: e.message });
                }

                const volRes = await db.get('SELECT SUM(volume24h) as total FROM tokens');
                const totalVolume = volRes?.total || 0;

                // Get total airdropped (v11.0: Now can be SOL or PUMP, check details for currency)
                const airdropRes = await db.get('SELECT SUM(CAST(amount AS REAL)) as total FROM airdrop_logs');
                const totalAirdropped = airdropRes?.total || 0;

                // Get SOL-specific airdrops (v11.0)
                const solAirdropRes = await db.get(`SELECT SUM(CAST(amount AS REAL)) as total FROM airdrop_logs WHERE details LIKE '%"currency":"SOL"%'`);
                const totalSolAirdropped = solAirdropRes?.total || 0;

                const currentBalance = await connection.getBalance(devKeypair.publicKey);

                const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(devKeypair.publicKey);
                let totalPendingFees = 0;

                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo) totalPendingFees += bcInfo.lamports;
                } catch (e) {
                    logger.debug('Failed to fetch bonding curve info', { error: e.message });
                }

                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const wsolBal = await connection.getTokenAccountBalance(ammVaultAtaKey);
                    if (wsolBal.value.amount) totalPendingFees += Number(wsolBal.value.amount);
                } catch (e) {
                    logger.debug('Failed to fetch AMM vault balance', { error: e.message });
                }

                let pumpHoldings = 0;
                try {
                    const devPumpAta = await getAssociatedTokenAddress(
                        TOKENS.PUMP, devKeypair.publicKey, false, PROGRAMS.TOKEN_2022
                    );
                    const tokenBal = await connection.getTokenAccountBalance(devPumpAta);
                    if (tokenBal.value.uiAmount) pumpHoldings = tokenBal.value.uiAmount;
                } catch (e) {
                    logger.debug('Failed to fetch PUMP holdings', { error: e.message });
                }

                // v12.0: Robinhood stats (v13.0: PostgreSQL syntax)
                const robinhoodTokenCount = await db.get('SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1');
                const robinhoodTotalFees = await db.get('SELECT SUM("totalFeesCollected") as total FROM robinhood_tokens');

                // v24.0: Calculate pending fees from Robinhood tokens (parallelized with circuit breaker)
                let robinhoodPendingFees = 0;
                let robinhoodPendingDetails = [];
                try {
                    // v25.14 SCALABILITY: Limit to 200 tokens for health check to avoid timeout
                    const robinhoodTokens = await db.all('SELECT mint, ticker, "creatorPubkey", "feeShareBps" FROM robinhood_tokens WHERE "isActive" = 1 LIMIT 200');

                    // v24.0: Process tokens in parallel batches for better responsiveness
                    const BATCH_SIZE = 10;
                    const batches = [];
                    for (let i = 0; i < robinhoodTokens.length; i += BATCH_SIZE) {
                        batches.push(robinhoodTokens.slice(i, i + BATCH_SIZE));
                    }

                    for (const batch of batches) {
                        const batchResults = await Promise.all(batch.map(async (token) => {
                            try {
                                const creatorPubkey = new PublicKey(token.creatorPubkey);
                                const { bcVault, ammVaultAta } = pump.getShareholderFeeVaults(creatorPubkey);

                                // v24.0: Use circuit breaker for RPC calls
                                const [bcLamports, ammBalance] = await Promise.all([
                                    circuitBreaker.execute(
                                        'solana-rpc-health',
                                        async () => {
                                            const bcInfo = await connection.getAccountInfo(bcVault);
                                            return bcInfo?.lamports || 0;
                                        },
                                        0,
                                        { failureThreshold: 10, timeout: 60000 }
                                    ),
                                    circuitBreaker.execute(
                                        'solana-rpc-health',
                                        async () => {
                                            const ammVaultAtaKey = await ammVaultAta;
                                            const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                                            return parseInt(bal.value.amount) || 0;
                                        },
                                        0,
                                        { failureThreshold: 10, timeout: 60000 }
                                    )
                                ]);

                                let tokenPendingFees = 0;
                                if (bcLamports > 5000) {
                                    tokenPendingFees += Math.floor((bcLamports - 5000) * (token.feeShareBps / 10000));
                                }
                                if (ammBalance > 0) {
                                    tokenPendingFees += Math.floor(ammBalance * (token.feeShareBps / 10000));
                                }

                                if (tokenPendingFees > 0) {
                                    return {
                                        mint: token.mint,
                                        ticker: token.ticker,
                                        pendingLamports: tokenPendingFees,
                                        feeShareBps: token.feeShareBps
                                    };
                                }
                                return null;
                            } catch (e) {
                                logger.debug(`[Health] Robinhood pending fee check error for ${token.mint}`, { error: e.message });
                                return null;
                            }
                        }));

                        // Aggregate batch results
                        for (const result of batchResults) {
                            if (result) {
                                robinhoodPendingFees += result.pendingLamports;
                                robinhoodPendingDetails.push(result);
                            }
                        }
                    }
                } catch (e) {
                    logger.debug('[Health] Robinhood pending fees error', { error: e.message });
                }

                return {
                    stats, launches, logs, currentBalance, pumpHoldings, totalPendingFees, totalVolume, totalAirdropped, totalSolAirdropped,
                    robinhoodTokenCount: robinhoodTokenCount?.count || 0,
                    robinhoodTotalFees: robinhoodTotalFees?.total || 0,
                    robinhoodPendingFees,
                    robinhoodPendingDetails
                };
            });

            const totalFeesLamports = (cachedHealth.stats.lifetimeFeesLamports || 0) +
                                     (cachedHealth.stats.lifetimeCreatorFeesLamports || 0);

            res.json({
                status: "online",
                wallet: devKeypair.publicKey.toString(),
                lifetimeFees: (totalFeesLamports / LAMPORTS_PER_SOL).toFixed(4),
                totalPumpBought: (cachedHealth.stats.totalPumpBoughtLamports / LAMPORTS_PER_SOL).toFixed(4),
                totalPumpTokensBought: (cachedHealth.stats.totalPumpTokensBought || 0).toLocaleString('en-US', {maximumFractionDigits: 0}),
                pumpHoldings: cachedHealth.pumpHoldings,
                totalPoints: globalState.totalPoints,
                totalLaunches: cachedHealth.launches,
                recentLogs: (cachedHealth.logs || []).map(l => {
                    try {
                        const parsed = typeof l.data === 'string' ? JSON.parse(l.data) : (l.data || {});
                        return { ...parsed, type: l.type, timestamp: l.timestamp };
                    } catch (e) {
                        // Log data is not valid JSON - return raw
                        return { raw: l.data, type: l.type, timestamp: l.timestamp };
                    }
                }),
                headerImageUrl: config.HEADER_IMAGE_URL,
                // v23.0: Combined pending fees from both platform tokens and Robinhood tokens
                currentFeeBalance: ((cachedHealth.totalPendingFees + (cachedHealth.robinhoodPendingFees || 0)) / LAMPORTS_PER_SOL).toFixed(4),
                // v23.0: Separate pending fee breakdown
                platformPendingFees: (cachedHealth.totalPendingFees / LAMPORTS_PER_SOL).toFixed(4),
                robinhoodPendingFees: ((cachedHealth.robinhoodPendingFees || 0) / LAMPORTS_PER_SOL).toFixed(4),
                lastClaimTime: cachedHealth.stats.lastClaimTimestamp || 0,
                lastClaimAmount: (cachedHealth.stats.lastClaimAmountLamports / LAMPORTS_PER_SOL).toFixed(4),
                nextCheckTime: cachedHealth.stats.nextCheckTimestamp || (Date.now() + 1*60*1000),
                // v25.7: Next airdrop timestamp for frontend countdown synchronization
                nextAirdropTime: cachedHealth.stats.nextAirdropTimestamp || (Date.now() + (config.AIRDROP_INTERVAL || 900000)),
                airdropIntervalMs: config.AIRDROP_INTERVAL || 900000,
                totalVolume: cachedHealth.totalVolume,
                // v11.0: Legacy PUMP airdrop total (for backwards compatibility)
                totalAirdropped: cachedHealth.totalAirdropped,
                // v11.0: SOL airdrop total (new)
                totalSolAirdropped: cachedHealth.totalSolAirdropped || 0,
                // v14.0: Raw SOL balance (actual wallet balance)
                solBalance: (cachedHealth.currentBalance / LAMPORTS_PER_SOL).toFixed(4),
                solBalanceLamports: cachedHealth.currentBalance,
                // v11.0: Current airdrop pool available (SOL balance minus 0.5 SOL reserve)
                airdropPoolSol: Math.max(0, (cachedHealth.currentBalance / LAMPORTS_PER_SOL) - 0.5).toFixed(4),
                airdropCurrency: 'SOL', // v11.0: Indicates current airdrop currency
                // Pass dynamic conservation status to frontend
                conservationStatus: globalState.conservationStatus || null,
                // v12.0: Robinhood Bot stats (v23.0: Added pending fees)
                robinhood: {
                    activeTokens: cachedHealth.robinhoodTokenCount || 0,
                    totalFeesCollectedSol: cachedHealth.robinhoodTotalFees || 0,
                    lifetimeFeesLamports: cachedHealth.stats.lifetimeRobinhoodFeesLamports || 0,
                    pendingFeesLamports: cachedHealth.robinhoodPendingFees || 0,
                    pendingFeesSol: ((cachedHealth.robinhoodPendingFees || 0) / LAMPORTS_PER_SOL).toFixed(4),
                    pendingDetails: cachedHealth.robinhoodPendingDetails || []
                }
            });
        } catch (e) {
            logger.error('[Health] Endpoint error', { error: e.message, stack: e.stack });
            // v22.0: Don't expose internal error details to clients
            res.status(500).json({ error: "Health check failed" });
        }
    });

    // Services status check
    router.get('/services-status', async (req, res) => {
        const services = {
            database: { status: 'unknown', latency: null },
            redis: { status: 'unknown', latency: null },
            solana_rpc: { status: 'unknown', latency: null },
            vanity_grinder: { status: 'disabled', latency: null }
        };

        // Check Database
        try {
            const start = Date.now();
            await db.get('SELECT 1');
            services.database = { status: 'online', latency: Date.now() - start };
        } catch (e) {
            services.database = { status: 'offline', error: e.message };
        }

        // Check Redis
        try {
            const start = Date.now();
            const redisConn = redis.getConnection?.();
            if (redisConn) {
                await redisConn.ping();
                services.redis = { status: 'online', latency: Date.now() - start };
            } else {
                services.redis = { status: 'not_configured' };
            }
        } catch (e) {
            services.redis = { status: 'offline', error: e.message };
        }

        // Check Solana RPC
        try {
            const start = Date.now();
            await connection.getLatestBlockhash('finalized');
            services.solana_rpc = { status: 'online', latency: Date.now() - start };
        } catch (e) {
            services.solana_rpc = { status: 'offline', error: e.message };
        }

        // Check Vanity Grinder (if enabled)
        if (config.VANITY_GRINDER_ENABLED && config.VANITY_GRINDER_URL) {
            try {
                const axios = require('axios');
                const start = Date.now();
                const response = await axios.get(`${config.VANITY_GRINDER_URL}/health`, { timeout: 5000 });
                services.vanity_grinder = {
                    status: response.data?.status === 'ok' ? 'online' : 'degraded',
                    latency: Date.now() - start,
                    poolSize: response.data?.poolSize
                };
            } catch (e) {
                services.vanity_grinder = { status: 'offline', error: e.message };
            }
        }

        const allOnline = Object.values(services).every(s => s.status === 'online' || s.status === 'disabled' || s.status === 'not_configured');
        res.json({
            overall: allOnline ? 'healthy' : 'degraded',
            services,
            timestamp: new Date().toISOString()
        });
    });

    // Debug logs (protected endpoint)
    router.get('/debug/logs', adminAuth, (req, res) => {
        const fs = require('fs');
        const path = require('path');

        // Validate and sanitize path
        const logPath = path.resolve(config.DISK_ROOT, 'server_debug.log');
        const expectedBase = path.resolve(config.DISK_ROOT);

        if (!logPath.startsWith(expectedBase)) {
            logger.warn('Path traversal attempt detected');
            return res.status(403).json({ error: 'Invalid path' });
        }

        if (fs.existsSync(logPath)) {
            const stats = fs.statSync(logPath);
            const stream = fs.createReadStream(logPath, { start: Math.max(0, stats.size - 50000) });
            stream.on('error', (err) => {
                logger.error('Error reading log file', { error: err.message });
                res.status(500).send('Error reading log file');
            });
            stream.pipe(res);
        } else {
            res.send("No logs yet.");
        }
    });

    // v13.0: Import token by mint address (admin only)
    // Fetches metadata from Helius/DexScreener and adds to tokens table
    router.post('/admin/import-token', adminAuth, async (req, res) => {
        const axios = require('axios');
        const { PublicKey } = require('@solana/web3.js');

        try {
            const { mint, isRobinhood } = req.body;

            if (!mint) {
                return res.status(400).json({ error: 'Missing mint address' });
            }

            // Validate mint is a valid pubkey
            try {
                new PublicKey(mint);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid mint address' });
            }

            // Fetch metadata from Helius DAS API
            let heliusMeta = null;
            if (config.HELIUS_API_KEY) {
                try {
                    // v25.14 SECURITY: Move API key from URL to header
                    const heliusRes = await axios.post(
                        'https://mainnet.helius-rpc.com/',
                        {
                            jsonrpc: '2.0',
                            id: '1',
                            method: 'getAsset',
                            params: { id: mint, displayOptions: { showFungible: true } }
                        },
                        {
                            timeout: 5000,
                            headers: { 'Authorization': `Bearer ${config.HELIUS_API_KEY}` }
                        }
                    );
                    const asset = heliusRes.data?.result;
                    if (asset) {
                        const metadata = asset.content?.metadata || {};
                        heliusMeta = {
                            name: metadata.name || 'Unknown',
                            ticker: metadata.symbol || 'UNKNOWN',
                            image: imageUtils.extractHeliusImage(asset),
                            description: metadata.description || '',
                            twitter: asset.content?.links?.twitter || null,
                            website: asset.content?.links?.external_url || null,
                            creator: asset.creators?.[0]?.address || null,
                            marketCap: asset.token_info?.price_info?.total_price || 0,
                            complete: false
                        };
                    }
                } catch (e) {
                    logger.debug('Helius metadata fetch failed', { error: e.message });
                }
            }

            // Fetch from DexScreener for additional data
            let dexMeta = null;
            try {
                const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
                const pairs = dexRes.data?.pairs || [];
                if (pairs.length > 0) {
                    const pair = pairs[0];
                    dexMeta = {
                        name: pair.baseToken?.name,
                        ticker: pair.baseToken?.symbol,
                        image: pair.info?.imageUrl,
                        marketCap: pair.fdv || pair.marketCap || 0,
                        volume24h: pair.volume?.h24 || 0
                    };
                }
            } catch (e) {
                logger.debug('DexScreener metadata fetch failed', { error: e.message });
            }

            if (!heliusMeta && !dexMeta) {
                return res.status(404).json({ error: 'Token not found on Helius or DexScreener' });
            }

            const metadata = {
                name: heliusMeta?.name || dexMeta?.name || 'Unknown Token',
                ticker: heliusMeta?.ticker || dexMeta?.ticker || 'UNKNOWN',
                image: heliusMeta?.image || dexMeta?.image || null,
                description: heliusMeta?.description || '',
                twitter: heliusMeta?.twitter || null,
                website: heliusMeta?.website || null,
                creator: heliusMeta?.creator || null,
                marketCap: dexMeta?.marketCap || heliusMeta?.marketCap || 0,
                volume24h: dexMeta?.volume24h || 0,
                complete: heliusMeta?.complete || false
            };

            // Determine which table to insert into
            if (isRobinhood) {
                // Insert into robinhood_tokens
                await db.run(`
                    INSERT INTO robinhood_tokens (mint, ticker, name, image, "creatorPubkey", "feeShareBps", "discoveredAt", "marketCap", volume24h, "isActive", "isGraduated")
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10)
                    ON CONFLICT (mint) DO UPDATE SET
                        ticker = EXCLUDED.ticker,
                        name = EXCLUDED.name,
                        image = COALESCE(EXCLUDED.image, robinhood_tokens.image),
                        "marketCap" = EXCLUDED."marketCap",
                        volume24h = EXCLUDED.volume24h
                `, [mint, metadata.ticker, metadata.name, metadata.image, metadata.creator || devKeypair.publicKey.toString(), 10000, Date.now(), metadata.marketCap, metadata.volume24h, metadata.complete ? 1 : 0]);

                logger.info(`[Admin] Imported Robinhood token: ${metadata.ticker} (${mint})`);
            } else {
                // Insert into tokens table
                await db.run(`
                    INSERT INTO tokens ("userPubkey", mint, ticker, name, description, twitter, website, image, "marketCap", volume24h, timestamp, complete)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT (mint) DO UPDATE SET
                        ticker = EXCLUDED.ticker,
                        name = EXCLUDED.name,
                        image = COALESCE(EXCLUDED.image, tokens.image),
                        "marketCap" = EXCLUDED."marketCap",
                        volume24h = EXCLUDED.volume24h
                `, [metadata.creator || devKeypair.publicKey.toString(), mint, metadata.ticker, metadata.name, metadata.description, metadata.twitter, metadata.website, metadata.image, metadata.marketCap, metadata.volume24h, Date.now(), metadata.complete ? 1 : 0]);

                logger.info(`[Admin] Imported launched token: ${metadata.ticker} (${mint})`);
            }

            res.json({
                success: true,
                token: {
                    mint,
                    ticker: metadata.ticker,
                    name: metadata.name,
                    marketCap: metadata.marketCap,
                    isRobinhood: !!isRobinhood
                }
            });

        } catch (e) {
            logger.error('[Admin] Token import error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Import failed' });
        }
    });

    // v13.0: Bulk import tokens (admin only)
    router.post('/admin/import-tokens-bulk', adminAuth, async (req, res) => {
        try {
            const { mints, isRobinhood } = req.body;

            if (!mints || !Array.isArray(mints) || mints.length === 0) {
                return res.status(400).json({ error: 'Missing or invalid mints array' });
            }

            if (mints.length > 50) {
                return res.status(400).json({ error: 'Maximum 50 tokens per request' });
            }

            const results = { success: [], failed: [] };

            for (const mint of mints) {
                try {
                    // Make internal request to single import
                    const axios = require('axios');
                    const internalRes = await axios.post(
                        `http://localhost:${config.PORT}/api/admin/import-token`,
                        { mint, isRobinhood },
                        { headers: { 'x-admin-key': req.headers['x-admin-key'] }, timeout: 10000 }
                    );
                    results.success.push({ mint, ticker: internalRes.data.token?.ticker });
                } catch (e) {
                    results.failed.push({ mint, error: e.response?.data?.error || e.message });
                }

                // Rate limit
                await new Promise(r => setTimeout(r, 500));
            }

            res.json({
                success: true,
                imported: results.success.length,
                failed: results.failed.length,
                results
            });

        } catch (e) {
            logger.error('[Admin] Bulk import error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Bulk import failed' });
        }
    });

    // ===== ADMIN ACTION ENDPOINTS =====
    // These endpoints allow triggering background tasks manually from the admin panel

    /**
     * POST /admin/trigger-metadata-update
     * Force an immediate metadata update cycle for all tokens
     */
    router.post('/admin/trigger-metadata-update', adminAuth, async (req, res) => {
        try {
            const metadataUpdater = require('../tasks/metadataUpdater');

            logger.info('[Admin] Triggering manual metadata update...');

            // Run the update (async, don't wait for completion)
            metadataUpdater.updateMetadata(deps).then(() => {
                logger.info('[Admin] Manual metadata update completed');
            }).catch(e => {
                logger.error('[Admin] Manual metadata update failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'Metadata update triggered. Check logs for progress.'
            });
        } catch (e) {
            logger.error('[Admin] Trigger metadata update error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Failed to trigger metadata update' });
        }
    });

    /**
     * POST /admin/trigger-holder-scan
     * Force an immediate holder scan and points recalculation
     */
    router.post('/admin/trigger-holder-scan', adminAuth, async (req, res) => {
        try {
            const holderScanner = require('../tasks/holderScanner');

            logger.info('[Admin] Triggering manual holder scan...');

            // Run the update (async, don't wait for completion)
            holderScanner.updateGlobalState(deps).then(() => {
                logger.info('[Admin] Manual holder scan completed');
            }).catch(e => {
                logger.error('[Admin] Manual holder scan failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'Holder scan triggered. Check logs for progress.'
            });
        } catch (e) {
            logger.error('[Admin] Trigger holder scan error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Failed to trigger holder scan' });
        }
    });

    /**
     * POST /admin/trigger-fee-claim
     * Force an immediate fee collection from creator vaults and Robinhood tokens
     */
    router.post('/admin/trigger-fee-claim', adminAuth, async (req, res) => {
        try {
            const flywheel = require('../tasks/flywheel');

            logger.info('[Admin] Triggering manual fee claim...');

            // Run the fee collection (async, don't wait for completion)
            flywheel.runFeeCollection(deps).then(() => {
                logger.info('[Admin] Manual fee claim completed');
            }).catch(e => {
                logger.error('[Admin] Manual fee claim failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'Fee claim triggered. Check logs for progress.'
            });
        } catch (e) {
            logger.error('[Admin] Trigger fee claim error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Failed to trigger fee claim' });
        }
    });

    /**
     * POST /admin/trigger-airdrop
     * Force an immediate SOL airdrop distribution (if balance threshold is met)
     */
    router.post('/admin/trigger-airdrop', adminAuth, async (req, res) => {
        try {
            const flywheel = require('../tasks/flywheel');

            // Check current balance first
            const currentBalance = await connection.getBalance(devKeypair.publicKey);
            const SAFETY_RESERVE = 0.5 * LAMPORTS_PER_SOL;
            const MIN_AIRDROP_POOL = (config.AIRDROP_THRESHOLD_SOL || 1.0) * LAMPORTS_PER_SOL;
            const availableForAirdrop = currentBalance - SAFETY_RESERVE;

            if (availableForAirdrop < MIN_AIRDROP_POOL) {
                return res.json({
                    success: false,
                    message: `Insufficient balance for airdrop. Available: ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL, Required: ${config.AIRDROP_THRESHOLD_SOL || 1.0} SOL`
                });
            }

            logger.info('[Admin] Triggering manual airdrop...');

            // Run the airdrop (async, don't wait for completion)
            flywheel.processAirdrop(deps).then(() => {
                logger.info('[Admin] Manual airdrop completed');
            }).catch(e => {
                logger.error('[Admin] Manual airdrop failed', { error: e.message });
            });

            res.json({
                success: true,
                message: `Airdrop triggered with ${(availableForAirdrop / LAMPORTS_PER_SOL).toFixed(4)} SOL available. Check logs for progress.`
            });
        } catch (e) {
            logger.error('[Admin] Trigger airdrop error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Failed to trigger airdrop' });
        }
    });

    /**
     * POST /admin/trigger-robinhood-scan
     * Force an immediate Robinhood token scan and verification
     */
    router.post('/admin/trigger-robinhood-scan', adminAuth, async (req, res) => {
        try {
            const robinhoodScanner = require('../tasks/robinhoodScanner');

            logger.info('[Admin] Triggering manual Robinhood scan...');

            // Run the scan (async, don't wait for completion)
            robinhoodScanner.reverifyRobinhoodTokens(deps).then(() => {
                logger.info('[Admin] Manual Robinhood scan completed');
            }).catch(e => {
                logger.error('[Admin] Manual Robinhood scan failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'Robinhood scan triggered. Check logs for progress.'
            });
        } catch (e) {
            logger.error('[Admin] Trigger Robinhood scan error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Failed to trigger Robinhood scan' });
        }
    });

    /**
     * POST /admin/reset-points
     * v25.25: Reset all point calculations and recalculate from scratch
     *
     * This endpoint:
     * 1. Clears all cached user points from Redis
     * 2. Clears all expected airdrop amounts from Redis
     * 3. Clears API-level point caches
     * 4. Triggers a fresh holder scan to recalculate everything
     * 5. Refreshes materialized views for accurate totals
     *
     * Use this when:
     * - Point calculation logic has been updated
     * - Database holder data has been manually corrected
     * - Inconsistencies are detected between displayed and actual points
     */
    router.post('/admin/reset-points', adminAuth, async (req, res) => {
        try {
            const holderScanner = require('../tasks/holderScanner');
            const postgres = require('../services/postgres');

            logger.info('[Admin] Starting full point reset...');

            // Step 1: Clear Redis point caches
            logger.info('[Admin] Clearing Redis point caches...');
            await redis.clearUserPoints();
            await redis.clearUserExpectedAirdrops();

            // Step 2: Clear globalState in-memory caches
            if (globalState) {
                globalState.userPointsMap.clear();
                globalState.userExpectedAirdrops.clear();
                globalState.totalPoints = 0;
            }

            // Step 3: Clear API-level caches (smart cache uses Redis, clear by pattern)
            // These are the cache keys used by /check-holder and /user-holdings
            const cachePatterns = [
                'check_holder_*',
                'check_holder_v2_*',
                'check_holder_rh_*',
                'check_holder_rh_v2_*',
                'user_holdings_detail_*',
                'user_holdings_detail_v2_*',
                'platform_volume_range',
                'robinhood_volume_range',
                'all_eligible_users'
            ];

            let clearedKeys = 0;
            for (const pattern of cachePatterns) {
                try {
                    const keys = await redis.getConnection().keys(`cache:${pattern}`);
                    if (keys.length > 0) {
                        await redis.getConnection().del(...keys);
                        clearedKeys += keys.length;
                    }
                } catch (e) {
                    logger.debug(`[Admin] Cache clear pattern ${pattern} skipped`, { error: e.message });
                }
            }
            logger.info(`[Admin] Cleared ${clearedKeys} API cache keys`);

            // Step 4: Refresh materialized views for accurate balance totals
            logger.info('[Admin] Refreshing materialized views...');
            try {
                await postgres.refreshMaterializedViews();
                logger.info('[Admin] Materialized views refreshed');
            } catch (e) {
                logger.warn('[Admin] Materialized view refresh failed (non-fatal)', { error: e.message });
            }

            // Step 5: Trigger full holder scan to recalculate points
            logger.info('[Admin] Triggering holder scan for point recalculation...');

            // Run async - don't wait for completion
            holderScanner.updateGlobalState(deps).then(() => {
                logger.info('[Admin] Point recalculation completed successfully');
            }).catch(e => {
                logger.error('[Admin] Point recalculation failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'Point reset initiated. All caches cleared and recalculation started.',
                details: {
                    redisPointsCleared: true,
                    redisAirdropsCleared: true,
                    globalStateCachesCleared: true,
                    apiCacheKeysCleared: clearedKeys,
                    materializedViewsRefreshed: true,
                    holderScanTriggered: true
                },
                note: 'Recalculation runs in background. Check /debug/stats in ~1-2 minutes to verify new totals.'
            });

        } catch (e) {
            logger.error('[Admin] Point reset error', { error: e.message });
            res.status(500).json({ error: 'Failed to reset points', details: e.message });
        }
    });

    // ===== KOTH AI ADMIN ENDPOINTS (v25.40) =====

    /**
     * GET /admin/koth-logs
     * v25.40: Get AI KOTH evaluation logs for debugging
     */
    router.get('/admin/koth-logs', adminAuth, async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 50, 100);
            const logs = await claudeKoth.getEvaluationLogs(limit);
            const status = claudeKoth.getStatus();
            const current = await claudeKoth.getCurrentKoth();

            res.json({
                success: true,
                status,
                current: current ? {
                    ticker: current.token?.ticker,
                    mint: current.token?.mint,
                    confidence: current.score,
                    reasoning: current.reasoning,
                    runnerUp: current.runnerUp,
                    model: current.model,
                    updatedAt: current.updatedAt,
                    updatedAtISO: current.updatedAtISO
                } : null,
                logs,
                logCount: logs.length,
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            logger.error('[Admin] KOTH logs error', { error: e.message });
            res.status(500).json({ error: 'Failed to retrieve KOTH logs' });
        }
    });

    /**
     * GET /admin/koth-status
     * v25.40: Get current KOTH AI status and configuration
     */
    router.get('/admin/koth-status', adminAuth, async (req, res) => {
        try {
            const status = claudeKoth.getStatus();
            const current = await claudeKoth.getCurrentKoth();

            // Get recent success/error counts from logs
            const recentLogs = await claudeKoth.getEvaluationLogs(20);
            const successCount = recentLogs.filter(l => l.type === 'SELECTION_SUCCESS').length;
            const errorCount = recentLogs.filter(l => l.type === 'API_ERROR' || l.type === 'PARSE_ERROR' || l.type === 'ERROR').length;
            const fallbackCount = recentLogs.filter(l => l.type === 'FALLBACK_TO_ALGORITHM' || l.type === 'LAST_RESORT_SELECTION').length;

            res.json({
                success: true,
                status,
                current: current ? {
                    ticker: current.token?.ticker,
                    mint: current.token?.mint,
                    confidence: current.score,
                    reasoning: current.reasoning,
                    model: current.model,
                    isAI: current.isAI,
                    updatedAt: current.updatedAt,
                    updatedAtISO: current.updatedAtISO,
                    ageMinutes: current.updatedAt ? Math.round((Date.now() - current.updatedAt) / 60000) : null
                } : null,
                recentActivity: {
                    total: recentLogs.length,
                    successes: successCount,
                    errors: errorCount,
                    fallbacks: fallbackCount
                },
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            logger.error('[Admin] KOTH status error', { error: e.message });
            res.status(500).json({ error: 'Failed to get KOTH status' });
        }
    });

    /**
     * POST /admin/trigger-koth-refresh
     * v25.40: Force a new KOTH AI evaluation (clears cache and triggers refresh)
     */
    router.post('/admin/trigger-koth-refresh', adminAuth, async (req, res) => {
        try {
            logger.info('[Admin] Triggering manual KOTH AI refresh...');

            const flywheel = require('../tasks/flywheel');

            // Clear both caches - Redis (ClaudeKOTH) and in-memory (Flywheel)
            const redisCacheCleared = await claudeKoth.clearCurrentKoth();
            flywheel.resetKothCache();

            // Log the manual trigger
            await claudeKoth.logEvaluation({
                type: 'ADMIN_REFRESH_TRIGGERED',
                triggeredBy: 'admin',
                redisCacheCleared,
                flywheelCacheReset: true
            });

            // Trigger a new KOTH selection via the flywheel
            // Run async - don't wait for completion
            flywheel.getAiSelectedKoth(db).then(result => {
                logger.info('[Admin] Manual KOTH refresh completed', {
                    selectedTicker: result?.token?.ticker,
                    isAI: result?.isAI
                });
            }).catch(e => {
                logger.error('[Admin] Manual KOTH refresh failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'KOTH refresh triggered. Both caches cleared and new evaluation started.',
                redisCacheCleared,
                flywheelCacheReset: true,
                note: 'Check /admin/koth-status in a few seconds for results.'
            });

        } catch (e) {
            logger.error('[Admin] KOTH refresh error', { error: e.message });
            res.status(500).json({ error: 'Failed to trigger KOTH refresh' });
        }
    });

    /**
     * POST /admin/clear-koth-cache
     * v25.40: Clear the KOTH cache without triggering a new evaluation
     */
    router.post('/admin/clear-koth-cache', adminAuth, async (req, res) => {
        try {
            const cleared = await claudeKoth.clearCurrentKoth();

            await claudeKoth.logEvaluation({
                type: 'ADMIN_CACHE_CLEARED',
                triggeredBy: 'admin'
            });

            logger.info('[Admin] KOTH cache cleared manually');

            res.json({
                success: true,
                cleared,
                message: cleared ? 'KOTH cache cleared successfully' : 'Cache was already empty or clear failed'
            });
        } catch (e) {
            logger.error('[Admin] Clear KOTH cache error', { error: e.message });
            res.status(500).json({ error: 'Failed to clear KOTH cache' });
        }
    });

    /**
     * GET /admin/point-stats
     * v25.25: Get current point calculation statistics for verification
     */
    router.get('/admin/point-stats', adminAuth, async (req, res) => {
        try {
            // Get counts from Redis
            const userPointsMap = await redis.getAllUserPoints();
            const userExpectedAirdrops = await redis.getAllUserExpectedAirdrops();

            // Calculate totals
            let totalPoints = 0;
            let totalExpectedAirdrop = 0;
            let usersWithPoints = 0;
            let usersWithAirdrops = 0;

            for (const [pubkey, points] of userPointsMap.entries()) {
                if (points > 0) {
                    totalPoints += points;
                    usersWithPoints++;
                }
            }

            for (const [pubkey, amount] of userExpectedAirdrops.entries()) {
                if (amount > 0) {
                    totalExpectedAirdrop += amount;
                    usersWithAirdrops++;
                }
            }

            // Get token counts
            const platformTokenCount = await db.get('SELECT COUNT(*) as count FROM tokens WHERE volume24h >= $1', [100]);
            const robinhoodTokenCount = await db.get('SELECT COUNT(*) as count FROM robinhood_tokens WHERE "isActive" = 1 AND volume24h >= $1', [100]);
            const platformHolderCount = await db.get('SELECT COUNT(DISTINCT "holderPubkey") as count FROM token_holders');
            const robinhoodHolderCount = await db.get('SELECT COUNT(DISTINCT "holderPubkey") as count FROM robinhood_token_holders');

            // Get globalState values
            const globalTotalPoints = globalState?.totalPoints || 0;
            const availableSol = globalState?.availableSolForAirdrop || 0;
            const communityPot = globalState?.communityPot || 0;
            const kothPot = globalState?.kothPot || 0;

            res.json({
                success: true,
                stats: {
                    redis: {
                        usersWithPoints,
                        totalPoints: Math.round(totalPoints * 100) / 100,
                        usersWithAirdrops,
                        totalExpectedAirdropSol: Math.round(totalExpectedAirdrop * 10000) / 10000
                    },
                    globalState: {
                        totalPoints: Math.round(globalTotalPoints * 100) / 100,
                        availableSolForAirdrop: Math.round(availableSol * 10000) / 10000,
                        communityPot: Math.round(communityPot * 10000) / 10000,
                        kothPot: Math.round(kothPot * 10000) / 10000
                    },
                    tokens: {
                        eligiblePlatformTokens: parseInt(platformTokenCount?.count) || 0,
                        eligibleRobinhoodTokens: parseInt(robinhoodTokenCount?.count) || 0,
                        uniquePlatformHolders: parseInt(platformHolderCount?.count) || 0,
                        uniqueRobinhoodHolders: parseInt(robinhoodHolderCount?.count) || 0
                    }
                },
                timestamp: new Date().toISOString()
            });

        } catch (e) {
            logger.error('[Admin] Point stats error', { error: e.message });
            res.status(500).json({ error: 'Failed to get point stats' });
        }
    });

    // Admin panel password verification
    // Uses ADMIN_API_KEY environment variable as the password
    // v24.0: Updated to async for Redis-based rate limiting
    router.post('/admin/verify', async (req, res) => {
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
        const { password } = req.body;
        const expectedKey = config.ADMIN_API_KEY;

        // Check rate limit before processing (v24.0: now async for Redis support)
        const rateLimit = await checkAdminRateLimit(clientIp);
        if (!rateLimit.allowed) {
            logger.warn('Admin login rate limited', { ip: clientIp });
            return res.status(429).json({
                valid: false,
                error: 'Too many login attempts. Try again later.',
                retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000)
            });
        }

        if (!expectedKey) {
            logger.warn('Admin verification attempted but ADMIN_API_KEY not configured');
            return res.status(503).json({ valid: false, error: 'Admin access not configured' });
        }

        if (!password) {
            await recordAdminLoginAttempt(clientIp, false);
            return res.status(400).json({ valid: false, error: 'Password required' });
        }

        // Use timing-safe comparison to prevent timing attacks
        const crypto = require('crypto');
        try {
            if (password.length !== expectedKey.length ||
                !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expectedKey))) {
                await recordAdminLoginAttempt(clientIp, false);
                logger.warn('Failed admin panel login attempt', { ip: clientIp, remaining: rateLimit.remaining - 1 });
                return res.json({ valid: false });
            }
        } catch (e) {
            await recordAdminLoginAttempt(clientIp, false);
            logger.warn('Failed admin panel login attempt (comparison error)', { ip: clientIp });
            return res.json({ valid: false });
        }

        await recordAdminLoginAttempt(clientIp, true);
        logger.info('Admin panel authenticated successfully', { ip: clientIp });
        res.json({ valid: true });
    });

    return router;
}

module.exports = { init };
