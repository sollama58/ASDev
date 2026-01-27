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
                    // v25.74: Include feeVaultAddress for fee sharing tokens
                    const robinhoodTokens = await db.all('SELECT mint, ticker, "creatorPubkey", "feeShareBps", "feeVaultAddress" FROM robinhood_tokens WHERE "isActive" = 1 LIMIT 200');

                    // v24.0: Process tokens in parallel batches for better responsiveness
                    const BATCH_SIZE = 10;
                    const batches = [];
                    for (let i = 0; i < robinhoodTokens.length; i += BATCH_SIZE) {
                        batches.push(robinhoodTokens.slice(i, i + BATCH_SIZE));
                    }

                    for (const batch of batches) {
                        const batchResults = await Promise.all(batch.map(async (token) => {
                            try {
                                // v25.79: CRITICAL FIX - For fee sharing tokens, BOTH BC and AMM vaults
                                // are derived from feeVaultAddress (coinCreator), NOT creatorPubkey.
                                // The AMM pool stores coinCreator as the creator, not originalCreator.
                                let bcVault;
                                let ammVaultAta;

                                if (token.feeVaultAddress) {
                                    // v25.91: FEE program token - use feeVaultAddress directly for BC vault
                                    // This is where fees actually accumulate (consistent with scanner and admin refresh)
                                    const feeVaultPubkey = new PublicKey(token.feeVaultAddress);
                                    bcVault = feeVaultPubkey;
                                    const feeVaults = pump.getShareholderFeeVaults(feeVaultPubkey);
                                    ammVaultAta = feeVaults.ammVaultAta;
                                } else {
                                    // PUMP program token - derive from creatorPubkey
                                    const creatorPubkey = new PublicKey(token.creatorPubkey);
                                    const vaults = pump.getShareholderFeeVaults(creatorPubkey);
                                    bcVault = vaults.bcVault;
                                    ammVaultAta = vaults.ammVaultAta;
                                }

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
                // v25.78: Current airdrop pool available (SOL balance minus 0.1 SOL reserve)
                airdropPoolSol: Math.max(0, (cachedHealth.currentBalance / LAMPORTS_PER_SOL) - 0.1).toFixed(4),
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
     * v25.46: Also triggers image updates for robinhood_tokens and pags_beneficiaries
     */
    router.post('/admin/trigger-metadata-update', adminAuth, async (req, res) => {
        try {
            const metadataUpdater = require('../tasks/metadataUpdater');

            logger.info('[Admin] Triggering manual metadata update for all token types...');

            // v25.46: Run both metadata and image updates for all token types
            // Run the platform token metadata update
            metadataUpdater.updateMetadata(deps).then(() => {
                logger.info('[Admin] Platform token metadata update completed');
            }).catch(e => {
                logger.error('[Admin] Platform token metadata update failed', { error: e.message });
            });

            // Run image updates for all token types (platform, robinhood, pags)
            metadataUpdater.updateAllMissingImages(deps).then(() => {
                logger.info('[Admin] All token types image update completed');
            }).catch(e => {
                logger.error('[Admin] All token types image update failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'Metadata update triggered for all token types (platform, robinhood, pags). Check logs for progress.'
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
            // v25.78: Safety reserve is 0.1 SOL for operations
            const SAFETY_RESERVE = 0.1 * LAMPORTS_PER_SOL;
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
     * v25.68: Now also scans holders, not just verification
     */
    router.post('/admin/trigger-robinhood-scan', adminAuth, async (req, res) => {
        try {
            const robinhoodScanner = require('../tasks/robinhoodScanner');

            logger.info('[Admin] Triggering manual Robinhood scan (verify + holders)...');

            // v25.68: Run both verification AND holder scan
            (async () => {
                try {
                    await robinhoodScanner.reverifyRobinhoodTokens(deps);
                    logger.info('[Admin] Robinhood verification completed, starting holder scan...');
                    await robinhoodScanner.updateRobinhoodHolders(deps);
                    logger.info('[Admin] Manual Robinhood scan completed (verify + holders)');
                } catch (e) {
                    logger.error('[Admin] Manual Robinhood scan failed', { error: e.message });
                }
            })();

            res.json({
                success: true,
                message: 'Robinhood scan triggered (verify + holders). Check logs for progress.'
            });
        } catch (e) {
            logger.error('[Admin] Trigger Robinhood scan error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Failed to trigger Robinhood scan' });
        }
    });

    /**
     * POST /admin/refresh-robinhood-pending-fees
     * v25.90: Immediately refresh pending fees from on-chain and return per-token breakdown
     */
    router.post('/admin/refresh-robinhood-pending-fees', adminAuth, async (req, res) => {
        try {
            const { PublicKey } = require('@solana/web3.js');
            const pump = require('../services/pump');
            const LAMPORTS_PER_SOL = 1000000000;

            logger.info('[Admin] Refreshing Robinhood pending fees...');

            // Get all active Robinhood tokens
            const tokens = await db.all('SELECT id, mint, ticker, name, "creatorPubkey", "feeShareBps", "feeVaultAddress", "totalFeesCollected" FROM robinhood_tokens WHERE "isActive" = 1 ORDER BY "totalFeesCollected" DESC LIMIT 500');

            const tokenFees = [];
            let totalPendingLamports = 0;

            for (const token of tokens) {
                try {
                    let bcVault, ammVaultAta;
                    if (token.feeVaultAddress) {
                        bcVault = new PublicKey(token.feeVaultAddress);
                        const feeVaultPubkey = new PublicKey(token.feeVaultAddress);
                        const vaults = pump.getShareholderFeeVaults(feeVaultPubkey);
                        ammVaultAta = vaults.ammVaultAta;
                    } else {
                        const creatorPubkey = new PublicKey(token.creatorPubkey);
                        const vaults = pump.getShareholderFeeVaults(creatorPubkey);
                        bcVault = vaults.bcVault;
                        ammVaultAta = vaults.ammVaultAta;
                    }

                    let bcPending = 0, ammPending = 0;

                    // Check BC vault
                    try {
                        const bcInfo = await connection.getAccountInfo(bcVault);
                        if (bcInfo && bcInfo.lamports > 5000) {
                            bcPending = Math.floor((bcInfo.lamports - 5000) * (token.feeShareBps / 10000));
                        }
                    } catch (e) { /* Silent */ }

                    // Check AMM vault
                    try {
                        const ammVaultAtaKey = await ammVaultAta;
                        const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                        if (bal.value.amount && parseInt(bal.value.amount) > 0) {
                            ammPending = Math.floor(parseInt(bal.value.amount) * (token.feeShareBps / 10000));
                        }
                    } catch (e) { /* Silent */ }

                    const totalPending = bcPending + ammPending;
                    const pendingFeesSol = totalPending / LAMPORTS_PER_SOL;

                    // Update database
                    await db.run('UPDATE robinhood_tokens SET "pendingFees" = $1 WHERE id = $2', [pendingFeesSol, token.id]);

                    totalPendingLamports += totalPending;

                    // Only include tokens with pending fees in the response
                    if (totalPending > 0) {
                        tokenFees.push({
                            mint: token.mint,
                            ticker: token.ticker || token.name || token.mint.slice(0, 8),
                            feeShareBps: token.feeShareBps,
                            feeSharePct: (token.feeShareBps / 100).toFixed(1) + '%',
                            bcPendingSol: (bcPending / LAMPORTS_PER_SOL).toFixed(6),
                            ammPendingSol: (ammPending / LAMPORTS_PER_SOL).toFixed(6),
                            totalPendingSol: pendingFeesSol.toFixed(6),
                            totalCollectedSol: (token.totalFeesCollected || 0).toFixed(4)
                        });
                    }
                } catch (e) {
                    logger.debug(`[Admin] Pending fee check error for ${token.ticker}`, { error: e.message });
                }
            }

            // Sort by pending fees descending
            tokenFees.sort((a, b) => parseFloat(b.totalPendingSol) - parseFloat(a.totalPendingSol));

            const totalPendingSol = totalPendingLamports / LAMPORTS_PER_SOL;

            logger.info(`[Admin] Refreshed pending fees: ${totalPendingSol.toFixed(4)} SOL across ${tokenFees.length} tokens with pending`);

            res.json({
                success: true,
                totalPendingSol: totalPendingSol.toFixed(6),
                totalTokensChecked: tokens.length,
                tokensWithPending: tokenFees.length,
                tokenFees
            });
        } catch (e) {
            logger.error('[Admin] Refresh Robinhood pending fees error', { error: e.message });
            res.status(500).json({ error: 'Failed to refresh pending fees' });
        }
    });

    /**
     * GET /admin/token-fee-status/:mint
     * v25.91: View fee status for a specific Robinhood token without claiming
     */
    router.get('/admin/token-fee-status/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;

            const token = await db.get(
                'SELECT * FROM robinhood_tokens WHERE mint = $1',
                [mint]
            );

            if (!token) {
                return res.status(404).json({ error: 'Token not found in Robinhood tokens' });
            }

            const pump = require('../services/pump');
            const { PublicKey } = require('@solana/web3.js');
            const LAMPORTS_PER_SOL = 1000000000;

            const creatorPubkey = new PublicKey(token.creatorPubkey);
            const isFeeProgram = !!token.feeVaultAddress;

            let bcVault, ammVaultAuth, ammVaultAta, sharingConfigPDA;

            if (isFeeProgram) {
                const feeVaultPubkey = new PublicKey(token.feeVaultAddress);
                bcVault = feeVaultPubkey;
                const creatorVaults = pump.getShareholderFeeVaults(creatorPubkey);
                sharingConfigPDA = creatorVaults.sharingConfigPDA;
                const feeVaults = pump.getShareholderFeeVaults(feeVaultPubkey);
                ammVaultAuth = feeVaults.ammVaultAuth;
                ammVaultAta = feeVaults.ammVaultAta;
            } else {
                const vaults = pump.getShareholderFeeVaults(creatorPubkey);
                bcVault = vaults.bcVault;
                ammVaultAuth = vaults.ammVaultAuth;
                ammVaultAta = vaults.ammVaultAta;
                sharingConfigPDA = vaults.sharingConfigPDA;
            }

            const ammVaultAtaKey = await ammVaultAta;

            // Check balances
            const [bcInfo, ammBal, configInfo] = await Promise.all([
                connection.getAccountInfo(bcVault).catch(() => null),
                connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } })),
                connection.getAccountInfo(sharingConfigPDA).catch(() => null)
            ]);

            const bcBalance = bcInfo?.lamports || 0;
            const bcPending = Math.max(0, bcBalance - 5000);
            const ammBalance = parseInt(ammBal.value.amount) || 0;

            // v25.91: Try multiple PDA derivations to find the actual sharing config
            const { PROGRAMS } = require('../config/constants');
            const configSearchResults = [];

            // Helper to derive and check a config PDA
            const checkConfigPDA = async (seed, creator, program, label) => {
                try {
                    const [pda] = PublicKey.findProgramAddressSync(
                        [Buffer.from(seed), creator.toBuffer()],
                        program
                    );
                    const info = await connection.getAccountInfo(pda).catch(() => null);
                    return {
                        label,
                        seed,
                        creator: creator.toString(),
                        program: program.toString(),
                        pda: pda.toString(),
                        found: !!info,
                        dataSize: info?.data?.length || 0,
                        owner: info?.owner?.toString() || null
                    };
                } catch (e) {
                    return { label, error: e.message };
                }
            };

            // Try all possible derivations
            const derivationsToTry = [
                ['fee_sharing_config', creatorPubkey, PROGRAMS.PUMP, 'PUMP from creatorPubkey'],
                ['fee_sharing_config', creatorPubkey, PROGRAMS.PUMP_AMM, 'PUMP_AMM from creatorPubkey'],
            ];

            if (isFeeProgram) {
                const feeVaultPubkey = new PublicKey(token.feeVaultAddress);
                derivationsToTry.push(
                    ['fee_sharing_config', feeVaultPubkey, PROGRAMS.PUMP, 'PUMP from feeVaultAddress'],
                    ['fee_sharing_config', feeVaultPubkey, PROGRAMS.PUMP_AMM, 'PUMP_AMM from feeVaultAddress'],
                    ['fee_sharing_config', feeVaultPubkey, PROGRAMS.FEE, 'FEE from feeVaultAddress'],
                    ['fee_sharing_config', creatorPubkey, PROGRAMS.FEE, 'FEE from creatorPubkey']
                );
            }

            for (const [seed, creator, program, label] of derivationsToTry) {
                const result = await checkConfigPDA(seed, creator, program, label);
                configSearchResults.push(result);
            }

            // Also check the BC vault and AMM vault owners
            const bcVaultOwner = bcInfo?.owner?.toString() || null;

            // Parse sharing config - different approach for FEE program vs PUMP program tokens
            let shareholders = [];
            let originalCreator = null;
            let configFound = false;
            let configSource = null;
            const mintExtractor = require('../services/mintExtractor');

            if (isFeeProgram && bcInfo && bcInfo.owner.equals(PROGRAMS.FEE)) {
                // v25.91: For FEE program tokens, the sharing config is EMBEDDED in the feeVaultAddress account
                // The feeVaultAddress IS the vault AND contains the sharing config
                configSource = 'FEE program account (feeVaultAddress)';

                // Parse FEE account structure to find shareholders
                // Structure: 8 discriminator + 32 mint + 3 bump/padding + 32 creator + 1 unknown + 4 array_len + shareholders
                const data = bcInfo.data;
                if (data.length >= 80) {
                    // Original creator is at offset 43 (after 8 disc + 32 mint + 3 bump)
                    try {
                        originalCreator = new PublicKey(data.slice(43, 75)).toString();
                    } catch (e) {}

                    // Shareholders array length at offset 76
                    const numShareholders = data.readUInt32LE(76);
                    let offset = 80; // Start of shareholders array

                    if (numShareholders >= 1 && numShareholders <= 10) {
                        configFound = true;
                        for (let i = 0; i < numShareholders && offset + 34 <= data.length; i++) {
                            const pubkey = new PublicKey(data.slice(offset, offset + 32));
                            offset += 32;
                            const bps = data.readUInt16LE(offset);
                            offset += 2;
                            shareholders.push({
                                pubkey: pubkey.toString(),
                                bps,
                                percent: bps / 100
                            });
                        }
                    }
                }
            } else {
                // For PUMP program tokens, try separate fee_sharing_config PDA
                let foundConfigInfo = configInfo;

                // If primary config not found, try to use any found config from search
                if (!configInfo) {
                    const foundResult = configSearchResults.find(r => r.found && r.dataSize > 44);
                    if (foundResult) {
                        foundConfigInfo = await connection.getAccountInfo(new PublicKey(foundResult.pda)).catch(() => null);
                        configSource = foundResult.label;
                    }
                } else {
                    configSource = 'Primary PDA (PUMP from creatorPubkey)';
                }

                configFound = !!foundConfigInfo;

                if (foundConfigInfo && foundConfigInfo.data && foundConfigInfo.data.length > 44) {
                    const data = foundConfigInfo.data;
                    let offset = 8;
                    originalCreator = new PublicKey(data.slice(offset, offset + 32)).toString();
                    offset += 32;
                    const numShareholders = data.readUInt32LE(offset);
                    offset += 4;

                    for (let i = 0; i < numShareholders && offset + 34 <= data.length; i++) {
                        const pubkey = new PublicKey(data.slice(offset, offset + 32));
                        offset += 32;
                        const bps = data.readUInt16LE(offset);
                        offset += 2;
                        shareholders.push({
                            pubkey: pubkey.toString(),
                            bps,
                            percent: bps / 100
                        });
                    }
                }
            }

            res.json({
                token: {
                    mint: token.mint,
                    ticker: token.ticker,
                    name: token.name,
                    creatorPubkey: token.creatorPubkey,
                    feeVaultAddress: token.feeVaultAddress,
                    feeShareBps: token.feeShareBps,
                    feeSharePercent: token.feeShareBps / 100,
                    totalFeesCollected: token.totalFeesCollected,
                    lastFeesClaimed: token.lastFeesClaimed,
                    isActive: token.isActive
                },
                vaults: {
                    bcVault: bcVault.toString(),
                    ammVaultAta: ammVaultAtaKey.toString(),
                    sharingConfigPDA: sharingConfigPDA.toString(),
                    isFeeProgram
                },
                balances: {
                    bc: {
                        balance: bcBalance,
                        pendingLamports: bcPending,
                        pendingSol: bcPending / LAMPORTS_PER_SOL,
                        ourShareSol: (bcPending / LAMPORTS_PER_SOL) * (token.feeShareBps / 10000)
                    },
                    amm: {
                        balance: ammBalance,
                        pendingLamports: ammBalance,
                        pendingSol: ammBalance / LAMPORTS_PER_SOL,
                        ourShareSol: (ammBalance / LAMPORTS_PER_SOL) * (token.feeShareBps / 10000)
                    },
                    totalPendingSol: (bcPending + ammBalance) / LAMPORTS_PER_SOL,
                    totalOurShareSol: ((bcPending + ammBalance) / LAMPORTS_PER_SOL) * (token.feeShareBps / 10000)
                },
                sharingConfig: {
                    found: configFound,
                    source: configSource,
                    dataSize: isFeeProgram ? bcInfo?.data?.length : (configInfo?.data?.length || 0),
                    originalCreator,
                    shareholders,
                    primaryPDA: sharingConfigPDA.toString(),
                    primaryFound: !!configInfo,
                    isFeeProgram,
                    feeVaultOwner: bcVaultOwner
                },
                configSearch: {
                    bcVaultOwner,
                    derivations: configSearchResults
                }
            });
        } catch (e) {
            logger.error('[Admin] Token fee status error', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * POST /admin/claim-token-fees/:mint
     * v25.91: Manually trigger fee claim for a specific Robinhood token
     * Useful for testing and debugging fee distribution
     */
    router.post('/admin/claim-token-fees/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;
            const { claimType = 'both' } = req.body; // 'bc', 'amm', or 'both'

            logger.info(`[Admin] Manual fee claim requested for ${mint}, type: ${claimType}`);

            // Get token from database
            const token = await db.get(
                'SELECT * FROM robinhood_tokens WHERE mint = $1',
                [mint]
            );

            if (!token) {
                return res.status(404).json({ error: 'Token not found in Robinhood tokens' });
            }

            const pump = require('../services/pump');
            const solana = require('../services/solana');
            const { PublicKey, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
            const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction, createCloseAccountInstruction } = require('@solana/spl-token');
            const { PROGRAMS, TOKENS } = require('../config/constants');
            const LAMPORTS_PER_SOL = 1000000000;

            const creatorPubkey = new PublicKey(token.creatorPubkey);
            const results = {
                token: {
                    mint: token.mint,
                    ticker: token.ticker,
                    creatorPubkey: token.creatorPubkey,
                    feeVaultAddress: token.feeVaultAddress,
                    feeShareBps: token.feeShareBps
                },
                bc: null,
                amm: null
            };

            // Determine vault addresses
            let bcVault, ammVaultAuth, ammVaultAta, sharingConfigPDA;
            const isFeeProgram = !!token.feeVaultAddress;

            if (isFeeProgram) {
                const feeVaultPubkey = new PublicKey(token.feeVaultAddress);
                bcVault = feeVaultPubkey;
                const creatorVaults = pump.getShareholderFeeVaults(creatorPubkey);
                sharingConfigPDA = creatorVaults.sharingConfigPDA;
                const feeVaults = pump.getShareholderFeeVaults(feeVaultPubkey);
                ammVaultAuth = feeVaults.ammVaultAuth;
                ammVaultAta = feeVaults.ammVaultAta;
            } else {
                const vaults = pump.getShareholderFeeVaults(creatorPubkey);
                bcVault = vaults.bcVault;
                ammVaultAuth = vaults.ammVaultAuth;
                ammVaultAta = vaults.ammVaultAta;
                sharingConfigPDA = vaults.sharingConfigPDA;
            }

            results.vaults = {
                bcVault: bcVault.toString(),
                ammVaultAta: (await ammVaultAta).toString(),
                sharingConfigPDA: sharingConfigPDA.toString(),
                isFeeProgram
            };

            // Check BC vault balance
            if (claimType === 'bc' || claimType === 'both') {
                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    const bcBalance = bcInfo?.lamports || 0;
                    const bcPending = Math.max(0, bcBalance - 5000);

                    results.bc = {
                        vaultBalance: bcBalance,
                        pendingLamports: bcPending,
                        pendingSol: bcPending / LAMPORTS_PER_SOL,
                        ourShare: (bcPending / LAMPORTS_PER_SOL) * (token.feeShareBps / 10000),
                        isFeeProgram
                    };

                    if (bcPending > 0) {
                        // v25.96: Use different instructions based on program type
                        // - FEE program: distribute_creator_fees (collect not supported)
                        // - PUMP program: collect_creator_fee
                        results.bc.program = isFeeProgram ? 'FEE' : 'PUMP';
                        results.bc.instruction = isFeeProgram ? 'distribute' : 'collect';

                        try {
                            const tx = new Transaction();
                            solana.addPriorityFee(tx);

                            if (isFeeProgram) {
                                // FEE program: use distribute_creator_fees
                                // Parse shareholders from FEE account
                                let shareholders = [];
                                if (bcInfo && bcInfo.data && bcInfo.data.length >= 80) {
                                    const data = bcInfo.data;
                                    const numShareholders = data.readUInt32LE(76);
                                    let offset = 80;
                                    if (numShareholders >= 1 && numShareholders <= 10) {
                                        for (let i = 0; i < numShareholders && offset + 34 <= data.length; i++) {
                                            const pubkey = new PublicKey(data.slice(offset, offset + 32));
                                            offset += 32;
                                            const bps = data.readUInt16LE(offset);
                                            offset += 2;
                                            shareholders.push({ pubkey, bps });
                                        }
                                    }
                                    results.bc.numShareholders = numShareholders;
                                }

                                results.bc.shareholders = shareholders.map(s => ({
                                    pubkey: s.pubkey.toString(),
                                    bps: s.bps
                                }));

                                if (shareholders.length > 0) {
                                    const distributeDiscriminator = pump.buildDistributeFeesData();
                                    const [eventAuthority] = PublicKey.findProgramAddressSync(
                                        [Buffer.from("__event_authority")], PROGRAMS.FEE
                                    );

                                    const distributeKeys = [
                                        { pubkey: bcVault, isSigner: false, isWritable: true },
                                    ];
                                    for (const sh of shareholders) {
                                        distributeKeys.push({ pubkey: sh.pubkey, isSigner: false, isWritable: true });
                                    }
                                    distributeKeys.push(
                                        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                                        { pubkey: eventAuthority, isSigner: false, isWritable: false },
                                        { pubkey: PROGRAMS.FEE, isSigner: false, isWritable: false }
                                    );

                                    tx.add(new TransactionInstruction({
                                        keys: distributeKeys,
                                        programId: PROGRAMS.FEE,
                                        data: distributeDiscriminator
                                    }));
                                } else {
                                    results.bc.error = 'No shareholders found in FEE account';
                                }
                            } else {
                                // PUMP program: use collect_creator_fee
                                const claimDiscriminator = pump.buildClaimFeesData();
                                const [eventAuthority] = PublicKey.findProgramAddressSync(
                                    [Buffer.from("__event_authority")], PROGRAMS.PUMP
                                );

                                const claimKeys = [
                                    { pubkey: devKeypair.publicKey, isSigner: false, isWritable: true },
                                    { pubkey: bcVault, isSigner: false, isWritable: true },
                                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                                    { pubkey: eventAuthority, isSigner: false, isWritable: false },
                                    { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false }
                                ];

                                tx.add(new TransactionInstruction({
                                    keys: claimKeys,
                                    programId: PROGRAMS.PUMP,
                                    data: claimDiscriminator
                                }));
                            }

                            if (tx.instructions.length > 0) {
                                tx.feePayer = devKeypair.publicKey;
                                const sig = await solana.sendTxWithRetry(tx, [devKeypair]);

                                results.bc.claimed = true;
                                results.bc.signature = sig;
                                results.bc.claimedSol = bcPending / LAMPORTS_PER_SOL;

                                const ourShare = Math.floor(bcPending * (token.feeShareBps / 10000));
                                await db.run(
                                    'UPDATE robinhood_tokens SET "lastFeesClaimed" = $1, "totalFeesCollected" = "totalFeesCollected" + $2, "pendingFees" = 0 WHERE id = $3',
                                    [Date.now(), ourShare / LAMPORTS_PER_SOL, token.id]
                                );

                                logger.info(`[Admin] BC fees claimed for ${token.ticker}: ${bcPending / LAMPORTS_PER_SOL} SOL`);
                            }
                        } catch (txErr) {
                            results.bc.claimed = false;
                            results.bc.error = txErr.message;
                            logger.error(`[Admin] BC claim failed for ${token.ticker}`, { error: txErr.message });
                        }
                    }
                } catch (e) {
                    results.bc = { error: e.message };
                }
            }

            // Check AMM vault balance
            if (claimType === 'amm' || claimType === 'both') {
                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                    const ammBalance = parseInt(bal.value.amount) || 0;

                    results.amm = {
                        vaultBalance: ammBalance,
                        pendingLamports: ammBalance,
                        pendingSol: ammBalance / LAMPORTS_PER_SOL,
                        ourShare: (ammBalance / LAMPORTS_PER_SOL) * (token.feeShareBps / 10000)
                    };

                    if (ammBalance > 0) {
                        // v25.93: Use same collect_creator_fee pattern as platform tokens
                        try {
                            const ammTx = new Transaction();
                            solana.addPriorityFee(ammTx);

                            // Create our wSOL ATA if needed
                            const myWsolAta = await getAssociatedTokenAddress(TOKENS.WSOL, devKeypair.publicKey);
                            try {
                                await getAccount(connection, myWsolAta);
                            } catch {
                                ammTx.add(createAssociatedTokenAccountInstruction(
                                    devKeypair.publicKey, myWsolAta, devKeypair.publicKey, TOKENS.WSOL
                                ));
                            }

                            // Same discriminator as platform AMM collect
                            const ammClaimDiscriminator = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);
                            const [ammEventAuthority] = PublicKey.findProgramAddressSync(
                                [Buffer.from("__event_authority")], PROGRAMS.PUMP_AMM
                            );

                            // Same account structure as platform tokens
                            const ammClaimKeys = [
                                { pubkey: TOKENS.WSOL, isSigner: false, isWritable: false },
                                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                                { pubkey: devKeypair.publicKey, isSigner: true, isWritable: false },
                                { pubkey: ammVaultAuth, isSigner: false, isWritable: false },
                                { pubkey: ammVaultAtaKey, isSigner: false, isWritable: true },
                                { pubkey: myWsolAta, isSigner: false, isWritable: true },
                                { pubkey: ammEventAuthority, isSigner: false, isWritable: false },
                                { pubkey: PROGRAMS.PUMP_AMM, isSigner: false, isWritable: false }
                            ];

                            ammTx.add(new TransactionInstruction({
                                keys: ammClaimKeys,
                                programId: PROGRAMS.PUMP_AMM,
                                data: ammClaimDiscriminator
                            }));

                            // Close wSOL ATA to get native SOL
                            ammTx.add(createCloseAccountInstruction(myWsolAta, devKeypair.publicKey, devKeypair.publicKey));

                            ammTx.feePayer = devKeypair.publicKey;
                            const sig = await solana.sendTxWithRetry(ammTx, [devKeypair]);

                            results.amm.claimed = true;
                            results.amm.signature = sig;
                            results.amm.claimedSol = ammBalance / LAMPORTS_PER_SOL;

                            logger.info(`[Admin] AMM fees collected for ${token.ticker}: ${ammBalance / LAMPORTS_PER_SOL} SOL`);
                        } catch (txErr) {
                            results.amm.claimed = false;
                            results.amm.error = txErr.message;
                            logger.error(`[Admin] AMM collect failed for ${token.ticker}`, { error: txErr.message });
                        }
                    }
                } catch (e) {
                    results.amm = { error: e.message };
                }
            }

            res.json({
                success: true,
                results
            });
        } catch (e) {
            logger.error('[Admin] Claim token fees error', { error: e.message });
            res.status(500).json({ error: e.message });
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

            // Clear all KOTH-related caches:
            // 1. ClaudeKOTH Redis cache (koth_ai_current)
            // 2. Flywheel in-memory cache
            // 3. API smartCache (koth_data) - v25.42: Added to ensure frontend gets fresh data
            const redisCacheCleared = await claudeKoth.clearCurrentKoth();
            flywheel.resetKothCache();
            await redis.invalidateCache('koth_data');

            // Log the manual trigger
            await claudeKoth.logEvaluation({
                type: 'ADMIN_REFRESH_TRIGGERED',
                triggeredBy: 'admin',
                redisCacheCleared,
                flywheelCacheReset: true,
                apiCacheInvalidated: true
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
                message: 'KOTH refresh triggered. All caches cleared and new evaluation started.',
                redisCacheCleared,
                flywheelCacheReset: true,
                apiCacheInvalidated: true,
                note: 'Frontend will show new selection within seconds.'
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
     * GET /admin/koth-candidates
     * v25.69: Debug endpoint to check KOTH candidate eligibility
     * Shows all potential candidates and why tokens don't qualify
     */
    router.get('/admin/koth-candidates', adminAuth, async (req, res) => {
        try {
            const KOTH_MIN_HOLDERS = 10;
            const KOTH_MIN_MARKET_CAP = 1000;
            const KOTH_MIN_VOLUME = 100;

            // Get eligible platform candidates
            const platformCandidates = await db.all(`
                SELECT
                    t.mint, t.ticker, t.name, t."marketCap", t.volume24h,
                    COUNT(th."holderPubkey") as holderCount,
                    'platform' as source
                FROM tokens t
                LEFT JOIN token_holders th ON th.mint = t.mint
                WHERE t."marketCap" >= $1 AND t.volume24h >= $2
                GROUP BY t.mint, t.ticker, t.name, t."marketCap", t.volume24h
                HAVING COUNT(th."holderPubkey") >= $3
                ORDER BY t."marketCap" DESC
                LIMIT 10
            `, [KOTH_MIN_MARKET_CAP, KOTH_MIN_VOLUME, KOTH_MIN_HOLDERS]);

            // Get eligible robinhood candidates
            const robinhoodCandidates = await db.all(`
                SELECT
                    rt.mint, rt.ticker, rt.name, rt."marketCap", rt.volume24h,
                    COUNT(rth."holderPubkey") as holderCount,
                    'robinhood' as source
                FROM robinhood_tokens rt
                LEFT JOIN robinhood_token_holders rth ON rth.mint = rt.mint
                WHERE rt."isActive" = 1 AND rt."marketCap" >= $1 AND rt.volume24h >= $2
                GROUP BY rt.mint, rt.ticker, rt.name, rt."marketCap", rt.volume24h
                HAVING COUNT(rth."holderPubkey") >= $3
                ORDER BY rt."marketCap" DESC
                LIMIT 10
            `, [KOTH_MIN_MARKET_CAP, KOTH_MIN_VOLUME, KOTH_MIN_HOLDERS]);

            // Get all robinhood tokens with their status (to show why they don't qualify)
            const allRobinhoodTokens = await db.all(`
                SELECT
                    rt.mint, rt.ticker, rt.name, rt."marketCap", rt.volume24h, rt."isActive",
                    COUNT(rth."holderPubkey") as holderCount
                FROM robinhood_tokens rt
                LEFT JOIN robinhood_token_holders rth ON rth.mint = rt.mint
                GROUP BY rt.mint, rt.ticker, rt.name, rt."marketCap", rt.volume24h, rt."isActive"
                ORDER BY rt.volume24h DESC
                LIMIT 20
            `);

            // Analyze why robinhood tokens don't qualify
            const robinhoodAnalysis = allRobinhoodTokens.map(token => {
                const issues = [];
                if (!token.isActive) issues.push('inactive');
                if ((token.marketCap || 0) < KOTH_MIN_MARKET_CAP) issues.push(`mcap $${token.marketCap || 0} < $${KOTH_MIN_MARKET_CAP}`);
                if ((token.volume24h || 0) < KOTH_MIN_VOLUME) issues.push(`vol $${token.volume24h || 0} < $${KOTH_MIN_VOLUME}`);
                if ((token.holderCount || 0) < KOTH_MIN_HOLDERS) issues.push(`holders ${token.holderCount} < ${KOTH_MIN_HOLDERS}`);

                return {
                    ticker: token.ticker,
                    mint: token.mint?.slice(0, 8) + '...',
                    isActive: !!token.isActive,
                    marketCap: token.marketCap || 0,
                    volume24h: token.volume24h || 0,
                    holderCount: token.holderCount || 0,
                    isEligible: issues.length === 0,
                    issues: issues.length > 0 ? issues : ['✓ Eligible']
                };
            });

            res.json({
                success: true,
                requirements: {
                    minMarketCap: KOTH_MIN_MARKET_CAP,
                    minVolume: KOTH_MIN_VOLUME,
                    minHolders: KOTH_MIN_HOLDERS
                },
                eligibleCandidates: {
                    platform: platformCandidates.map(c => ({
                        ticker: c.ticker,
                        mint: c.mint?.slice(0, 8) + '...',
                        marketCap: c.marketCap,
                        volume24h: c.volume24h,
                        holderCount: c.holderCount
                    })),
                    robinhood: robinhoodCandidates.map(c => ({
                        ticker: c.ticker,
                        mint: c.mint?.slice(0, 8) + '...',
                        marketCap: c.marketCap,
                        volume24h: c.volume24h,
                        holderCount: c.holderCount
                    }))
                },
                robinhoodTokenAnalysis: robinhoodAnalysis,
                summary: {
                    totalPlatformEligible: platformCandidates.length,
                    totalRobinhoodEligible: robinhoodCandidates.length,
                    totalRobinhoodTokens: allRobinhoodTokens.length
                }
            });
        } catch (e) {
            logger.error('[Admin] KOTH candidates error', { error: e.message });
            res.status(500).json({ error: 'Failed to get KOTH candidates' });
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

    // ===== ANNOUNCEMENT ENDPOINTS =====

    /**
     * GET /announcements
     * Public endpoint to get active announcements for the frontend
     */
    router.get('/announcements', async (req, res) => {
        try {
            const now = Date.now();
            const announcements = await db.all(`
                SELECT id, title, message, type, "expiresAt", "createdAt"
                FROM announcements
                WHERE "isActive" = 1 AND ("expiresAt" IS NULL OR "expiresAt" > $1)
                ORDER BY "createdAt" DESC
                LIMIT 10
            `, [now]);

            res.json({
                success: true,
                announcements: announcements || []
            });
        } catch (e) {
            logger.error('[Announcements] Fetch error', { error: e.message });
            res.status(500).json({ error: 'Failed to fetch announcements' });
        }
    });

    /**
     * GET /admin/announcements
     * Admin endpoint to get all announcements (including inactive)
     */
    router.get('/admin/announcements', adminAuth, async (req, res) => {
        try {
            const announcements = await db.all(`
                SELECT id, title, message, type, "isActive", "expiresAt", "createdAt", "createdBy"
                FROM announcements
                ORDER BY "createdAt" DESC
                LIMIT 50
            `);

            res.json({
                success: true,
                announcements: announcements || [],
                count: announcements?.length || 0
            });
        } catch (e) {
            logger.error('[Admin] Announcements fetch error', { error: e.message });
            res.status(500).json({ error: 'Failed to fetch announcements' });
        }
    });

    /**
     * POST /admin/announcements
     * Create a new announcement and broadcast to all connected clients
     */
    router.post('/admin/announcements', adminAuth, async (req, res) => {
        const websocket = require('../services/websocket');

        try {
            const { title, message, type, expiresAt, broadcast: shouldBroadcast } = req.body;

            if (!title || !message) {
                return res.status(400).json({ error: 'Title and message are required' });
            }

            // Validate type
            const validTypes = ['info', 'warning', 'success', 'error', 'announcement'];
            const announcementType = validTypes.includes(type) ? type : 'info';

            // Validate expiresAt if provided
            let expiresAtTimestamp = null;
            if (expiresAt) {
                expiresAtTimestamp = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
                if (isNaN(expiresAtTimestamp)) {
                    return res.status(400).json({ error: 'Invalid expiresAt format' });
                }
            }

            const createdAt = Date.now();

            // Insert announcement
            const result = await db.run(`
                INSERT INTO announcements (title, message, type, "expiresAt", "createdAt", "createdBy", "isActive")
                VALUES ($1, $2, $3, $4, $5, $6, 1)
                RETURNING id
            `, [title, message, announcementType, expiresAtTimestamp, createdAt, 'admin']);

            const announcementId = result.lastID;

            const announcement = {
                id: announcementId,
                title,
                message,
                type: announcementType,
                expiresAt: expiresAtTimestamp,
                createdAt
            };

            // Broadcast to all connected WebSocket clients
            if (shouldBroadcast !== false) {
                websocket.broadcastAnnouncement(announcement);
                logger.info('[Admin] Announcement created and broadcast', { id: announcementId, title });
            } else {
                logger.info('[Admin] Announcement created (no broadcast)', { id: announcementId, title });
            }

            res.json({
                success: true,
                announcement,
                broadcast: shouldBroadcast !== false
            });
        } catch (e) {
            logger.error('[Admin] Create announcement error', { error: e.message });
            res.status(500).json({ error: 'Failed to create announcement' });
        }
    });

    /**
     * PUT /admin/announcements/:id
     * Update an existing announcement
     */
    router.put('/admin/announcements/:id', adminAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { title, message, type, isActive, expiresAt } = req.body;

            // Build update query dynamically based on provided fields
            const updates = [];
            const params = [];
            let paramIndex = 1;

            if (title !== undefined) {
                updates.push(`title = $${paramIndex++}`);
                params.push(title);
            }
            if (message !== undefined) {
                updates.push(`message = $${paramIndex++}`);
                params.push(message);
            }
            if (type !== undefined) {
                const validTypes = ['info', 'warning', 'success', 'error', 'announcement'];
                updates.push(`type = $${paramIndex++}`);
                params.push(validTypes.includes(type) ? type : 'info');
            }
            if (isActive !== undefined) {
                updates.push(`"isActive" = $${paramIndex++}`);
                params.push(isActive ? 1 : 0);
            }
            if (expiresAt !== undefined) {
                updates.push(`"expiresAt" = $${paramIndex++}`);
                params.push(expiresAt ? (typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime()) : null);
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            params.push(id);
            const result = await db.run(`
                UPDATE announcements
                SET ${updates.join(', ')}
                WHERE id = $${paramIndex}
            `, params);

            if (result.changes === 0) {
                return res.status(404).json({ error: 'Announcement not found' });
            }

            logger.info('[Admin] Announcement updated', { id });
            res.json({ success: true, updated: result.changes });
        } catch (e) {
            logger.error('[Admin] Update announcement error', { error: e.message });
            res.status(500).json({ error: 'Failed to update announcement' });
        }
    });

    /**
     * DELETE /admin/announcements/:id
     * Delete an announcement
     */
    router.delete('/admin/announcements/:id', adminAuth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await db.run('DELETE FROM announcements WHERE id = $1', [id]);

            if (result.changes === 0) {
                return res.status(404).json({ error: 'Announcement not found' });
            }

            logger.info('[Admin] Announcement deleted', { id });
            res.json({ success: true, deleted: result.changes });
        } catch (e) {
            logger.error('[Admin] Delete announcement error', { error: e.message });
            res.status(500).json({ error: 'Failed to delete announcement' });
        }
    });

    /**
     * POST /admin/announcements/:id/broadcast
     * Re-broadcast an existing announcement to all connected clients
     */
    router.post('/admin/announcements/:id/broadcast', adminAuth, async (req, res) => {
        const websocket = require('../services/websocket');

        try {
            const { id } = req.params;

            const announcement = await db.get(`
                SELECT id, title, message, type, "expiresAt", "createdAt"
                FROM announcements
                WHERE id = $1
            `, [id]);

            if (!announcement) {
                return res.status(404).json({ error: 'Announcement not found' });
            }

            websocket.broadcastAnnouncement(announcement);
            logger.info('[Admin] Announcement re-broadcast', { id, title: announcement.title });

            res.json({
                success: true,
                message: 'Announcement broadcast to all connected clients',
                announcement
            });
        } catch (e) {
            logger.error('[Admin] Broadcast announcement error', { error: e.message });
            res.status(500).json({ error: 'Failed to broadcast announcement' });
        }
    });

    // ===== TOKEN MANAGEMENT ENDPOINTS =====

    /**
     * GET /admin/tokens
     * List all tokens from both tokens and robinhood_tokens tables
     */
    router.get('/admin/tokens', adminAuth, async (req, res) => {
        try {
            const platformTokens = await db.all(`
                SELECT mint, ticker, name, image, "marketCap", volume24h, "holderCount", timestamp as "createdAt", 'platform' as source
                FROM tokens
                ORDER BY volume24h DESC
                LIMIT 100
            `);

            const robinhoodTokens = await db.all(`
                SELECT mint, ticker, name, image, "marketCap", volume24h, "holderCount", "discoveredAt" as "createdAt", 'robinhood' as source, "feeShareBps"
                FROM robinhood_tokens
                WHERE "isActive" = 1
                ORDER BY volume24h DESC
                LIMIT 100
            `);

            res.json({
                success: true,
                platformTokens: platformTokens || [],
                robinhoodTokens: robinhoodTokens || [],
                totalPlatform: platformTokens?.length || 0,
                totalRobinhood: robinhoodTokens?.length || 0
            });
        } catch (e) {
            logger.error('[Admin] List tokens error', { error: e.message });
            res.status(500).json({ error: 'Failed to list tokens' });
        }
    });

    /**
     * DELETE /admin/tokens/:mint
     * Remove a token from the database (platform or robinhood)
     */
    router.delete('/admin/tokens/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;
            const { source, confirm } = req.query;

            if (confirm !== 'true') {
                return res.status(400).json({
                    error: 'Confirmation required. Add ?confirm=true to the request.',
                    hint: 'This action cannot be undone.'
                });
            }

            if (!mint || mint.length < 32) {
                return res.status(400).json({ error: 'Invalid mint address' });
            }

            let deleted = { platform: 0, robinhood: 0, holders: 0 };

            // Check which tables the token exists in
            const platformToken = await db.get('SELECT mint, ticker FROM tokens WHERE mint = $1', [mint]);
            const robinhoodToken = await db.get('SELECT mint, ticker FROM robinhood_tokens WHERE mint = $1', [mint]);

            if (!platformToken && !robinhoodToken) {
                return res.status(404).json({
                    error: 'Token not found in database',
                    mint
                });
            }

            // Delete based on source or both if not specified
            if (!source || source === 'platform') {
                if (platformToken) {
                    // Delete holders first
                    const holderResult = await db.run('DELETE FROM token_holders WHERE mint = $1', [mint]);
                    deleted.holders += holderResult.changes || 0;

                    // Delete token
                    const tokenResult = await db.run('DELETE FROM tokens WHERE mint = $1', [mint]);
                    deleted.platform = tokenResult.changes || 0;

                    logger.info('[Admin] Deleted platform token', { mint, ticker: platformToken.ticker });
                }
            }

            if (!source || source === 'robinhood') {
                if (robinhoodToken) {
                    // Delete holders first
                    const holderResult = await db.run('DELETE FROM robinhood_token_holders WHERE mint = $1', [mint]);
                    deleted.holders += holderResult.changes || 0;

                    // Delete token
                    const tokenResult = await db.run('DELETE FROM robinhood_tokens WHERE mint = $1', [mint]);
                    deleted.robinhood = tokenResult.changes || 0;

                    logger.info('[Admin] Deleted robinhood token', { mint, ticker: robinhoodToken.ticker });
                }
            }

            res.json({
                success: true,
                message: 'Token deleted successfully',
                mint,
                ticker: platformToken?.ticker || robinhoodToken?.ticker,
                deleted
            });
        } catch (e) {
            logger.error('[Admin] Delete token error', { error: e.message });
            res.status(500).json({ error: 'Failed to delete token' });
        }
    });

    /**
     * POST /admin/tokens/:mint/deactivate
     * Soft-deactivate a robinhood token (keeps data but marks as inactive)
     */
    router.post('/admin/tokens/:mint/deactivate', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;

            const robinhoodToken = await db.get('SELECT mint, ticker, "isActive" FROM robinhood_tokens WHERE mint = $1', [mint]);

            if (!robinhoodToken) {
                return res.status(404).json({
                    error: 'Token not found in robinhood_tokens table',
                    mint
                });
            }

            if (!robinhoodToken.isActive) {
                return res.json({
                    success: true,
                    message: 'Token was already deactivated',
                    mint,
                    ticker: robinhoodToken.ticker
                });
            }

            await db.run('UPDATE robinhood_tokens SET "isActive" = 0 WHERE mint = $1', [mint]);

            logger.info('[Admin] Deactivated robinhood token', { mint, ticker: robinhoodToken.ticker });

            res.json({
                success: true,
                message: 'Token deactivated successfully',
                mint,
                ticker: robinhoodToken.ticker
            });
        } catch (e) {
            logger.error('[Admin] Deactivate token error', { error: e.message });
            res.status(500).json({ error: 'Failed to deactivate token' });
        }
    });

    /**
     * POST /admin/tokens/:mint/reactivate
     * Re-activate a deactivated robinhood token
     */
    router.post('/admin/tokens/:mint/reactivate', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;

            const robinhoodToken = await db.get('SELECT mint, ticker, "isActive" FROM robinhood_tokens WHERE mint = $1', [mint]);

            if (!robinhoodToken) {
                return res.status(404).json({
                    error: 'Token not found in robinhood_tokens table',
                    mint
                });
            }

            if (robinhoodToken.isActive) {
                return res.json({
                    success: true,
                    message: 'Token is already active',
                    mint,
                    ticker: robinhoodToken.ticker
                });
            }

            await db.run('UPDATE robinhood_tokens SET "isActive" = 1 WHERE mint = $1', [mint]);

            logger.info('[Admin] Reactivated robinhood token', { mint, ticker: robinhoodToken.ticker });

            res.json({
                success: true,
                message: 'Token reactivated successfully',
                mint,
                ticker: robinhoodToken.ticker
            });
        } catch (e) {
            logger.error('[Admin] Reactivate token error', { error: e.message });
            res.status(500).json({ error: 'Failed to reactivate token' });
        }
    });

    /**
     * GET /debug/robinhood-token/:mint
     * v25.68: Debug endpoint to check Robinhood token status and holders
     * Helps diagnose why holdings might not be showing up
     */
    router.get('/debug/robinhood-token/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;
            const { PublicKey } = require('@solana/web3.js');

            // Validate mint
            try {
                new PublicKey(mint);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid mint address' });
            }

            // Get token info
            const token = await db.get(
                'SELECT * FROM robinhood_tokens WHERE mint = $1',
                [mint]
            );

            if (!token) {
                return res.json({
                    found: false,
                    error: 'Token not found in robinhood_tokens table',
                    hint: 'Token may not be registered or may be in the regular tokens table'
                });
            }

            // Get holder count and sample
            const holderCount = await db.get(
                'SELECT COUNT(*) as count FROM robinhood_token_holders WHERE mint = $1',
                [mint]
            );

            const topHolders = await db.all(
                'SELECT "holderPubkey", balance, rank FROM robinhood_token_holders WHERE mint = $1 ORDER BY rank ASC LIMIT 10',
                [mint]
            );

            // Check if volume meets threshold
            const MIN_VOLUME_USD = config.AIRDROP_MIN_VOLUME_USD || 100;
            const isEligible = (parseFloat(token.volume24h) || 0) >= MIN_VOLUME_USD;

            // v25.72: Add vault debugging info
            // v25.73: CRITICAL FIX - Use feeVaultAddress if available (for fee sharing tokens)
            // For fee sharing tokens, the vault is the coinCreator FEE program account,
            // NOT a PDA derived from originalCreator
            let vaultInfo = null;
            let vaultBalances = null;
            const creatorPubkey = token.creatorPubkey;
            const storedFeeVaultAddress = token.feeVaultAddress; // v25.73: Direct vault address from DB

            if (storedFeeVaultAddress || (creatorPubkey && creatorPubkey !== 'unknown' && creatorPubkey !== 'unknown_creator')) {
                try {
                    let bcVault;
                    let ammVaultAtaResolved;
                    let vaultSource;

                    if (storedFeeVaultAddress) {
                        // v25.73: Use stored feeVaultAddress directly (for fee sharing tokens)
                        bcVault = new PublicKey(storedFeeVaultAddress);
                        vaultSource = 'feeVaultAddress (direct)';
                        logger.info(`[Debug] Using stored feeVaultAddress for ${token.ticker}: ${storedFeeVaultAddress.slice(0, 8)}...`);

                        // v25.74: For fee sharing tokens, AMM vault is ALSO derived from feeVaultAddress (coinCreator)
                        // The AMM pool stores coinCreator (FEE program account) as the creator, not originalCreator
                        const feeVaultPubkey = new PublicKey(storedFeeVaultAddress);
                        const { ammVaultAta } = pump.getShareholderFeeVaults(feeVaultPubkey);
                        ammVaultAtaResolved = await ammVaultAta;
                    } else {
                        // Derive vault from creatorPubkey (legacy path for tokens without feeVaultAddress)
                        const creatorPubkeyObj = new PublicKey(creatorPubkey);
                        const { bcVault: derivedBcVault, ammVaultAta } = pump.getShareholderFeeVaults(creatorPubkeyObj);
                        bcVault = derivedBcVault;
                        ammVaultAtaResolved = await ammVaultAta;
                        vaultSource = 'derived from creatorPubkey';
                    }

                    vaultInfo = {
                        creatorPubkey: creatorPubkey,
                        feeVaultAddress: storedFeeVaultAddress || null,
                        bcVault: bcVault.toString(),
                        ammVaultAta: ammVaultAtaResolved?.toString() || null,
                        vaultSource: vaultSource
                    };

                    // Check on-chain balances
                    let bcBalance = 0;
                    let ammBalance = 0;

                    try {
                        const bcInfo = await connection.getAccountInfo(bcVault);
                        bcBalance = bcInfo?.lamports || 0;
                    } catch (e) { /* silent */ }

                    if (ammVaultAtaResolved) {
                        try {
                            const ammBal = await connection.getTokenAccountBalance(ammVaultAtaResolved).catch(() => ({ value: { amount: "0" } }));
                            ammBalance = parseInt(ammBal.value.amount) || 0;
                        } catch (e) { /* silent */ }
                    }

                    const feeShareBps = token.feeShareBps || 10000;
                    const bcClaimable = Math.max(0, bcBalance - 5000);
                    const ourBcShare = Math.floor(bcClaimable * (feeShareBps / 10000));
                    const ourAmmShare = Math.floor(ammBalance * (feeShareBps / 10000));

                    vaultBalances = {
                        bcVault: {
                            totalLamports: bcBalance,
                            totalSol: (bcBalance / LAMPORTS_PER_SOL).toFixed(6),
                            claimableLamports: bcClaimable,
                            ourShareLamports: ourBcShare,
                            ourShareSol: (ourBcShare / LAMPORTS_PER_SOL).toFixed(6)
                        },
                        ammVault: {
                            totalLamports: ammBalance,
                            totalSol: (ammBalance / LAMPORTS_PER_SOL).toFixed(6),
                            ourShareLamports: ourAmmShare,
                            ourShareSol: (ourAmmShare / LAMPORTS_PER_SOL).toFixed(6)
                        },
                        combined: {
                            totalPendingLamports: ourBcShare + ourAmmShare,
                            totalPendingSol: ((ourBcShare + ourAmmShare) / LAMPORTS_PER_SOL).toFixed(6)
                        }
                    };
                } catch (e) {
                    vaultInfo = { error: e.message, creatorPubkey, feeVaultAddress: storedFeeVaultAddress };
                }
            } else {
                vaultInfo = {
                    error: 'Invalid or missing creatorPubkey/feeVaultAddress',
                    creatorPubkey,
                    feeVaultAddress: storedFeeVaultAddress,
                    hint: 'The token was registered without a valid original creator or vault address. Try re-registering or using the fix-robinhood-creator endpoint.'
                };
            }

            res.json({
                found: true,
                token: {
                    mint: token.mint,
                    ticker: token.ticker,
                    name: token.name,
                    creatorPubkey: token.creatorPubkey,
                    isActive: token.isActive === 1,
                    volume24h: token.volume24h,
                    marketCap: token.marketCap,
                    feeShareBps: token.feeShareBps,
                    createdAt: token.createdAt,
                    updatedAt: token.updatedAt
                },
                vaultInfo,
                vaultBalances,
                eligibility: {
                    isEligible,
                    volumeThreshold: MIN_VOLUME_USD,
                    currentVolume: parseFloat(token.volume24h) || 0,
                    reason: !token.isActive ? 'Token is not active' :
                            !isEligible ? `Volume ${token.volume24h || 0} below threshold ${MIN_VOLUME_USD}` :
                            'Token is eligible'
                },
                holders: {
                    totalCount: holderCount?.count || 0,
                    sampleTop10: topHolders.map(h => ({
                        wallet: h.holderPubkey.slice(0, 8) + '...',
                        balance: h.balance,
                        rank: h.rank
                    }))
                },
                hints: [
                    ...(holderCount?.count || 0) === 0 ? [
                        'No holders in database - the holder scan may not have run yet',
                        'Try POST /admin/trigger-robinhood-scan to force a scan'
                    ] : [],
                    ...(!creatorPubkey || creatorPubkey === 'unknown' || creatorPubkey === 'unknown_creator') ? [
                        'CRITICAL: creatorPubkey is invalid - vault addresses cannot be derived',
                        'Re-verify and re-register the token to fix this'
                    ] : [],
                    ...(vaultBalances?.combined?.totalPendingLamports === 0) ? [
                        'No pending fees in vaults - token may not have generated any fees yet'
                    ] : []
                ]
            });
        } catch (e) {
            logger.error('[Debug] Robinhood token lookup error', { error: e.message });
            res.status(500).json({ error: 'Failed to lookup token' });
        }
    });

    /**
     * POST /admin/trigger-robinhood-holder-scan/:mint
     * v25.68: Force an immediate holder scan for a specific Robinhood token
     */
    router.post('/admin/trigger-robinhood-holder-scan/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;
            const { PublicKey } = require('@solana/web3.js');
            const robinhoodScanner = require('../tasks/robinhoodScanner');

            // Validate mint
            try {
                new PublicKey(mint);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid mint address' });
            }

            // Check if token exists
            const token = await db.get(
                'SELECT ticker FROM robinhood_tokens WHERE mint = $1',
                [mint]
            );

            if (!token) {
                return res.status(404).json({
                    error: 'Token not found in robinhood_tokens table'
                });
            }

            logger.info(`[Admin] Triggering immediate holder scan for ${token.ticker || mint.slice(0, 8)}...`);

            // Run the scan (async, don't wait for completion)
            robinhoodScanner.scanSingleTokenHolders(deps, mint, token.ticker)
                .then(() => {
                    logger.info(`[Admin] Holder scan completed for ${token.ticker || mint.slice(0, 8)}`);
                })
                .catch(e => {
                    logger.error(`[Admin] Holder scan failed for ${token.ticker || mint.slice(0, 8)}`, { error: e.message });
                });

            res.json({
                success: true,
                message: `Holder scan triggered for ${token.ticker || mint.slice(0, 8)}. Check logs for progress.`
            });
        } catch (e) {
            logger.error('[Admin] Trigger holder scan error', { error: e.message });
            res.status(500).json({ error: 'Failed to trigger holder scan' });
        }
    });

    /**
     * POST /admin/fix-robinhood-creator/:mint
     * v25.72: Re-verify and fix the creatorPubkey for a Robinhood token
     * v25.73: Also updates feeVaultAddress for fee sharing tokens
     * This is needed when tokens were registered with incorrect/missing creatorPubkey/feeVaultAddress
     */
    router.post('/admin/fix-robinhood-creator/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;
            const { PublicKey } = require('@solana/web3.js');
            const mintExtractor = require('../services/mintExtractor');

            // Validate mint
            try {
                new PublicKey(mint);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid mint address' });
            }

            // Check if token exists
            const token = await db.get(
                'SELECT * FROM robinhood_tokens WHERE mint = $1',
                [mint]
            );

            if (!token) {
                return res.status(404).json({
                    error: 'Token not found in robinhood_tokens table'
                });
            }

            const oldCreator = token.creatorPubkey;
            const oldFeeVaultAddress = token.feeVaultAddress;
            logger.info(`[Admin] Re-verifying creatorPubkey for ${token.ticker}. Current: ${oldCreator?.slice(0, 8) || 'NONE'}...`);

            // Re-verify fee recipient
            // v25.73: Use devKeypair.publicKey instead of undefined config.PLATFORM_WALLET
            const verification = await mintExtractor.verifyFeeRecipient(
                mint,
                devKeypair.publicKey.toString(),
                connection
            );

            if (!verification.isRecipient) {
                return res.status(400).json({
                    error: 'Platform wallet is not a fee recipient for this token',
                    verification
                });
            }

            const newCreator = verification.originalCreator;
            if (!newCreator || newCreator === 'unknown' || newCreator === 'unknown_creator') {
                return res.status(400).json({
                    error: 'Could not determine original creator from on-chain data',
                    verification,
                    hint: 'The token may have a non-standard fee sharing setup'
                });
            }

            // v25.73: Get feeVaultAddress for fee sharing tokens
            const newFeeVaultAddress = verification.feeVaultAddress || null;

            // Update the creatorPubkey AND feeVaultAddress
            await db.run(
                'UPDATE robinhood_tokens SET "creatorPubkey" = $1, "feeShareBps" = $2, "feeVaultAddress" = $3 WHERE mint = $4',
                [newCreator, verification.feeShareBps, newFeeVaultAddress, mint]
            );

            // v25.73: Use feeVaultAddress directly if available, otherwise derive from creatorPubkey
            let bcVault;
            let ammVaultAtaResolved;
            let vaultSource;

            if (newFeeVaultAddress) {
                bcVault = new PublicKey(newFeeVaultAddress);
                vaultSource = 'feeVaultAddress (direct)';

                // v25.74: For fee sharing tokens, AMM vault is also derived from feeVaultAddress (coinCreator)
                const feeVaultPubkey = new PublicKey(newFeeVaultAddress);
                const { ammVaultAta } = pump.getShareholderFeeVaults(feeVaultPubkey);
                ammVaultAtaResolved = await ammVaultAta;
            } else {
                const creatorPubkeyObj = new PublicKey(newCreator);
                const { bcVault: derivedBcVault, ammVaultAta } = pump.getShareholderFeeVaults(creatorPubkeyObj);
                bcVault = derivedBcVault;
                ammVaultAtaResolved = await ammVaultAta;
                vaultSource = 'derived from creatorPubkey';
            }

            // Check vault balances
            let bcBalance = 0;
            let ammBalance = 0;

            try {
                const bcInfo = await connection.getAccountInfo(bcVault);
                bcBalance = bcInfo?.lamports || 0;
            } catch (e) { /* silent */ }

            try {
                const ammBal = await connection.getTokenAccountBalance(ammVaultAtaResolved).catch(() => ({ value: { amount: "0" } }));
                ammBalance = parseInt(ammBal.value.amount) || 0;
            } catch (e) { /* silent */ }

            logger.info(`[Admin] Fixed creatorPubkey for ${token.ticker}: ${oldCreator?.slice(0, 8) || 'NONE'} -> ${newCreator.slice(0, 8)}${newFeeVaultAddress ? `, vault: ${newFeeVaultAddress.slice(0, 8)}...` : ''}`);

            res.json({
                success: true,
                token: token.ticker,
                mint: mint,
                oldCreator: oldCreator,
                newCreator: newCreator,
                oldFeeVaultAddress: oldFeeVaultAddress,
                newFeeVaultAddress: newFeeVaultAddress,
                feeShareBps: verification.feeShareBps,
                feeSharePercent: verification.feeSharePercent,
                vaults: {
                    bcVault: bcVault.toString(),
                    ammVaultAta: ammVaultAtaResolved.toString(),
                    bcBalanceSol: (bcBalance / LAMPORTS_PER_SOL).toFixed(6),
                    ammBalanceSol: (ammBalance / LAMPORTS_PER_SOL).toFixed(6),
                    vaultSource: vaultSource
                }
            });
        } catch (e) {
            logger.error('[Admin] Fix Robinhood creator error', { error: e.message });
            res.status(500).json({ error: 'Failed to fix creator', details: e.message });
        }
    });

    /**
     * POST /admin/fix-all-robinhood-creators
     * v25.72: Re-verify and fix creatorPubkey for all Robinhood tokens with missing/invalid creators
     * v25.73: Also fixes tokens with missing feeVaultAddress (needed for fee sharing tokens)
     */
    router.post('/admin/fix-all-robinhood-creators', adminAuth, async (req, res) => {
        try {
            const mintExtractor = require('../services/mintExtractor');
            const { PublicKey } = require('@solana/web3.js');

            // v25.73: Find tokens with missing/invalid creatorPubkey OR missing feeVaultAddress
            const tokensToFix = await db.all(`
                SELECT * FROM robinhood_tokens
                WHERE "isActive" = 1
                AND (
                    "creatorPubkey" IS NULL OR "creatorPubkey" = 'unknown' OR "creatorPubkey" = 'unknown_creator' OR "creatorPubkey" = ''
                    OR "feeVaultAddress" IS NULL
                )
            `);

            logger.info(`[Admin] Fixing ${tokensToFix.length} Robinhood tokens with invalid creatorPubkey or missing feeVaultAddress`);

            const results = {
                total: tokensToFix.length,
                fixed: 0,
                failed: 0,
                details: []
            };

            for (const token of tokensToFix) {
                try {
                    // v25.73: Use devKeypair.publicKey instead of undefined config.PLATFORM_WALLET
                    const verification = await mintExtractor.verifyFeeRecipient(
                        token.mint,
                        devKeypair.publicKey.toString(),
                        connection
                    );

                    if (verification.isRecipient && verification.originalCreator &&
                        verification.originalCreator !== 'unknown' && verification.originalCreator !== 'unknown_creator') {

                        // v25.73: Update both creatorPubkey AND feeVaultAddress
                        const newFeeVaultAddress = verification.feeVaultAddress || null;

                        await db.run(
                            'UPDATE robinhood_tokens SET "creatorPubkey" = $1, "feeShareBps" = $2, "feeVaultAddress" = $3 WHERE mint = $4',
                            [verification.originalCreator, verification.feeShareBps, newFeeVaultAddress, token.mint]
                        );

                        results.fixed++;
                        results.details.push({
                            mint: token.mint,
                            ticker: token.ticker,
                            status: 'fixed',
                            newCreator: verification.originalCreator.slice(0, 8) + '...',
                            newFeeVaultAddress: newFeeVaultAddress ? newFeeVaultAddress.slice(0, 8) + '...' : null
                        });
                    } else {
                        results.failed++;
                        results.details.push({
                            mint: token.mint,
                            ticker: token.ticker,
                            status: 'failed',
                            reason: !verification.isRecipient ? 'Not a fee recipient' : 'Could not determine original creator'
                        });
                    }
                } catch (e) {
                    results.failed++;
                    results.details.push({
                        mint: token.mint,
                        ticker: token.ticker,
                        status: 'error',
                        reason: e.message
                    });
                }

                // Add delay between tokens to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            logger.info(`[Admin] Robinhood creator/vault fix complete: ${results.fixed} fixed, ${results.failed} failed`);

            res.json({
                success: true,
                ...results
            });
        } catch (e) {
            logger.error('[Admin] Fix all Robinhood creators error', { error: e.message });
            res.status(500).json({ error: 'Failed to fix creators', details: e.message });
        }
    });

    return router;
}

module.exports = { init };
