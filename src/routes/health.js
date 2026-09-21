/**
 * Health & Status Routes
 * Server health, stats, and debugging endpoints
 * v29.0 - ShitPad: platform-launched tokens only
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, PROGRAMS } = require('../config/constants');
const { pump, logger, imageUtils, circuitBreaker, redis, claudeKoth } = require('../services');

const router = express.Router();

// L-1: Dedicated rate limit for health endpoint to prevent polling abuse
const healthRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests/min per IP
    standardHeaders: true,
    legacyHeaders: false
    // v28.2 SECURITY: custom keyGenerator removed. It keyed on the leftmost X-Forwarded-For
    // entry — the client-controlled one — so any caller could dodge this limiter with a
    // random header value per request. index.js now sets trust proxy, so the library's
    // default (req.ip, IPv6-subnet-aware) is both correct and unspoofable.
});

// v24.0 SECURITY FIX: Rate limiter using Redis for multi-instance support
// Fallback to in-memory Map if Redis unavailable
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_RATE_LIMIT_KEY_PREFIX = 'admin_rate_limit:';

// In-memory fallback for when Redis is unavailable
const adminLoginAttemptsFallback = new Map();
// H-8: Periodic cleanup to prevent unbounded Map growth
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of adminLoginAttemptsFallback) {
        if (now > val.resetAt) adminLoginAttemptsFallback.delete(key);
    }
}, ADMIN_LOGIN_WINDOW_MS);

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
const adminAuth = require('./adminAuth'); // v28.6: shared middleware

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
    router.get('/health', healthRateLimiter, async (req, res) => {
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

                // v26.0: Sum of all per-token pending airdrop lamports (replaces balance-based pool calc)
                let totalPendingAirdropLamports = 0;
                let centralPoolLamports = 0;
                try {
                    const pendingSum = await db.get(
                        'SELECT COALESCE(SUM(pending_airdrop_lamports), 0) as total FROM tokens WHERE pending_airdrop_lamports > 0'
                    );
                    totalPendingAirdropLamports = parseInt(pendingSum?.total || 0);
                } catch (e) {
                    // Ignore - column may not exist until migration runs
                }
                try {
                    const cpRow = await db.get("SELECT value FROM stats WHERE key = 'centralPoolLamports'");
                    centralPoolLamports = parseInt(cpRow?.value || 0);
                } catch (e) { /* ignore */ }

                // v28.1: vanity mint pool depth. The grinder runs as a separate service with
                // no channel back to the API, so this is how an operator sees whether it is
                // keeping up. `available` falling to zero is not an outage — launches just
                // fall back to random mints — but it means the grinder needs attention.
                let vanityPool = null;
                try {
                    vanityPool = await require('../services/vanity').getPoolStats(db);
                } catch (e) { /* ignore — table may not exist until migration runs */ }

                return {
                    stats, launches, logs, currentBalance, pumpHoldings, totalPendingFees, totalVolume, totalAirdropped, totalSolAirdropped,
                    totalPendingAirdropLamports,
                    centralPoolLamports,
                    vanityPool
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
                currentFeeBalance: (cachedHealth.totalPendingFees / LAMPORTS_PER_SOL).toFixed(4),
                platformPendingFees: (cachedHealth.totalPendingFees / LAMPORTS_PER_SOL).toFixed(4),
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
                // v26.0: Total pending airdrop pool across all tokens (per-token pooling system)
                airdropPoolSol: ((cachedHealth.totalPendingAirdropLamports || 0) / LAMPORTS_PER_SOL).toFixed(4),
                // v27.0: Per-token pools total and central pool separately
                tokenPoolsSol: ((cachedHealth.totalPendingAirdropLamports || 0) / LAMPORTS_PER_SOL).toFixed(4),
                centralPoolSol: ((cachedHealth.centralPoolLamports || 0) / LAMPORTS_PER_SOL).toFixed(4),
                // v27.1: Thresholds for UI display (central pool fixed 5 SOL; token pool from config)
                centralPoolThresholdSol: 5.0,
                tokenPoolThresholdSol: config.TOKEN_AIRDROP_THRESHOLD_SOL,
                airdropCurrency: 'SOL', // v11.0: Indicates current airdrop currency
                // v28.1: vanity mint pool. `available` is how many branded contract addresses
                // are ready; at zero, launches fall back to random mints rather than failing.
                vanityPool: cachedHealth.vanityPool
                    ? {
                        ...cachedHealth.vanityPool,
                        target: config.VANITY_POOL_TARGET,
                        suffix: config.VANITY_SUFFIX
                    }
                    : null,
                // M-8 FIX: Expose deployment fee so frontend stays in sync with backend config
                deploymentFee: config.DEPLOYMENT_FEE_SOL,
                // Pass dynamic conservation status to frontend
                conservationStatus: globalState.conservationStatus || null
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
            solana_rpc: { status: 'unknown', latency: null }
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

    // ===== ADMIN ACTION ENDPOINTS =====
    // These endpoints allow triggering background tasks manually from the admin panel

    /**
     * POST /admin/trigger-metadata-update
     * Force an immediate metadata update cycle for all tokens
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

            // Run image updates for all platform tokens
            metadataUpdater.updateAllMissingImages(deps).then(() => {
                logger.info('[Admin] All token types image update completed');
            }).catch(e => {
                logger.error('[Admin] All token types image update failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'Metadata update triggered for all tokens. Check logs for progress.'
            });
        } catch (e) {
            logger.error('[Admin] Trigger metadata update error', { error: e.message });
            // v22.0: Don't expose internal error details
            res.status(500).json({ error: 'Failed to trigger metadata update' });
        }
    });

    /**
     * POST /admin/refresh-all-volumes
     * v25.65: Force immediate price/volume update for ALL tokens
     * Updates market cap, volume, and price from DexScreener
     * Ensures 0 volume is properly reflected (doesn't hold stale data)
     */
    router.post('/admin/refresh-all-volumes', adminAuth, async (req, res) => {
        try {
            const metadataUpdater = require('../tasks/metadataUpdater');

            logger.info('[Admin] Triggering manual refresh of ALL token volumes and market caps...');

            // Run the full price/volume update for all tokens
            metadataUpdater.updateAllTokenPrices(deps).then(() => {
                logger.info('[Admin] Full token volume/market cap update completed');
            }).catch(e => {
                logger.error('[Admin] Full token volume/market cap update failed', { error: e.message });
            });

            res.json({
                success: true,
                message: 'Volume and market cap refresh triggered for all tokens. Updates include 0 volume where applicable. Check logs for progress.'
            });
        } catch (e) {
            logger.error('[Admin] Refresh all volumes error', { error: e.message });
            res.status(500).json({ error: 'Failed to trigger volume refresh' });
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
     * Force an immediate fee collection from creator vaults
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
     * GET /admin/airdrop-logs
     * v25.113: Detailed airdrop history with parsed event timeline
     * Returns recent airdrop logs with full details for admin review
     */
    router.get('/admin/airdrop-logs', adminAuth, async (req, res) => {
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);

            const logs = await db.all(
                'SELECT * FROM airdrop_logs ORDER BY timestamp DESC LIMIT $1',
                [limit]
            );

            const parsed = logs.map(log => {
                let details = null;
                try {
                    details = log.details ? JSON.parse(log.details) : null;
                } catch (e) {
                    details = { raw: log.details };
                }
                return {
                    id: log.id,
                    amount: parseFloat(log.amount) || 0,
                    recipients: log.recipients,
                    totalPoints: log.totalPoints,
                    signatures: log.signatures ? log.signatures.split(',').length : 0,
                    timestamp: log.timestamp,
                    details
                };
            });

            res.json({ success: true, logs: parsed });
        } catch (e) {
            logger.error('[Admin] Airdrop logs error', { error: e.message });
            res.status(500).json({ error: 'Failed to fetch airdrop logs' });
        }
    });

    /**
     * GET /admin/fee-claim-logs
     * v25.115: Fee collection history showing claims, threshold checks, and pending amounts
     */
    router.get('/admin/fee-claim-logs', adminAuth, async (req, res) => {
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);

            const logs = await db.all(
                `SELECT * FROM logs WHERE type IN ('FEE_CLAIM', 'FEE_CHECK') ORDER BY timestamp DESC LIMIT $1`,
                [limit]
            );

            const parsed = logs.map(log => {
                let data = null;
                try {
                    data = log.data ? JSON.parse(log.data) : null;
                } catch (e) {
                    data = { raw: log.data };
                }
                return {
                    id: log.id,
                    type: log.type,
                    timestamp: log.timestamp,
                    data
                };
            });

            res.json({ success: true, logs: parsed });
        } catch (e) {
            logger.error('[Admin] Fee claim logs error', { error: e.message });
            res.status(500).json({ error: 'Failed to fetch fee claim logs' });
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
                    }))
                },
                summary: {
                    totalPlatformEligible: platformCandidates.length
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
            const platformHolderCount = await db.get('SELECT COUNT(DISTINCT "holderPubkey") as count FROM token_holders');

            // Get globalState values
            const globalTotalPoints = globalState?.totalPoints || 0;
            // v26.0: availableSolForAirdrop now = sum of all per-token pending_airdrop_lamports
            const totalPendingSol = globalState?.availableSolForAirdrop || 0;

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
                        // v26.0: per-token pool system — no single global pot
                        totalPendingAirdropSol: Math.round(totalPendingSol * 10000) / 10000,
                        note: 'v26.0: Per-token pool system. Each token has its own pending_airdrop_lamports.'
                    },
                    tokens: {
                        eligiblePlatformTokens: parseInt(platformTokenCount?.count) || 0,
                        uniquePlatformHolders: parseInt(platformHolderCount?.count) || 0
                    }
                },
                timestamp: new Date().toISOString()
            });

        } catch (e) {
            logger.error('[Admin] Point stats error', { error: e.message });
            res.status(500).json({ error: 'Failed to get point stats' });
        }
    });

    /**
     * GET /admin/eligible-tokens
     * Returns all eligible tokens with holder counts and point stats
     */
    router.get('/admin/eligible-tokens', adminAuth, async (req, res) => {
        try {
            const MIN_VOL = config.AIRDROP_MIN_VOLUME_USD || 100;
            const BASE_PTS = 1000;
            const TOTAL_SUPPLY = BigInt('1000000000000000');

            // Get platform eligible tokens
            const platformTokens = await db.all(
                'SELECT mint, ticker, volume24h, "marketCap" FROM tokens WHERE volume24h >= $1 ORDER BY volume24h DESC',
                [MIN_VOL]
            );

            // Platform holder counts (batch query)
            const platformMints = platformTokens.map(t => t.mint);
            let platformHolderCounts = {};
            let platformTotalBalances = {};
            if (platformMints.length > 0) {
                const phRows = await db.all(
                    `SELECT mint, COUNT(*) as count, SUM(CAST(balance AS BIGINT)) as total_bal FROM token_holders WHERE mint = ANY($1) GROUP BY mint`,
                    [platformMints]
                );
                for (const row of phRows) {
                    platformHolderCounts[row.mint] = parseInt(row.count) || 0;
                    platformTotalBalances[row.mint] = row.total_bal || '0';
                }
            }

            const platformResults = platformTokens.map(token => {
                const totalBal = BigInt(platformTotalBalances[token.mint] || '0');
                const totalDistributed = Number((totalBal * BigInt(BASE_PTS * 1000)) / TOTAL_SUPPLY) / 1000;

                return {
                    mint: token.mint,
                    ticker: token.ticker,
                    source: 'platform',
                    volume24h: parseFloat(token.volume24h) || 0,
                    holderCount: platformHolderCounts[token.mint] || 0,
                    basePoints: BASE_PTS,
                    totalPointsDistributed: Math.round(totalDistributed * 100) / 100,
                    feeSharePercent: 100
                };
            });

            const allTokens = platformResults;

            res.json({
                success: true,
                tokens: allTokens,
                summary: {
                    platformCount: platformResults.length,
                    totalHolders: allTokens.reduce((s, t) => s + t.holderCount, 0),
                    totalPointsDistributed: Math.round(allTokens.reduce((s, t) => s + t.totalPointsDistributed, 0) * 100) / 100
                }
            });
        } catch (e) {
            logger.error('[Admin] Eligible tokens error', { error: e.message });
            res.status(500).json({ success: false, error: 'Failed to get eligible tokens' });
        }
    });

    /**
     * GET /admin/token-holders-points/:mint
     * Returns holders of a specific token with their per-token points
     */
    router.get('/admin/token-holders-points/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;
            const BASE_PTS = 1000;
            const TOTAL_SUPPLY = BigInt('1000000000000000');

            const token = await db.get('SELECT mint, ticker, volume24h FROM tokens WHERE mint = $1', [mint]);

            if (token) {
                const holders = await db.all(
                    'SELECT rank, "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC',
                    [mint]
                );

                return res.json({
                    success: true,
                    token: {
                        mint: token.mint, ticker: token.ticker, source: 'platform',
                        volume24h: parseFloat(token.volume24h) || 0,
                        basePoints: BASE_PTS,
                        feeSharePercent: 100
                    },
                    holders: holders.map(h => {
                        const balance = BigInt(h.balance || '0');
                        const pts = Number((balance * BigInt(BASE_PTS * 1000)) / TOTAL_SUPPLY) / 1000;
                        return { rank: h.rank, holderPubkey: h.holderPubkey, balance: h.balance, points: Math.round(pts * 1000) / 1000 };
                    })
                });
            }

            res.status(404).json({ success: false, error: 'Token not found' });
        } catch (e) {
            logger.error('[Admin] Token holder points error', { error: e.message });
            res.status(500).json({ success: false, error: 'Failed to get token holder points' });
        }
    });

    // Admin panel password verification
    // Uses ADMIN_API_KEY environment variable as the password
    // v24.0: Updated to async for Redis-based rate limiting
    router.post('/admin/verify', async (req, res) => {
        // v28.2 SECURITY: req.ip, not the client-writable leftmost X-Forwarded-For entry.
        // This is the brute-force limiter's key; keyed the old way it was defeated by
        // sending a different header value with each guess.
        const clientIp = req.ip || 'unknown';
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
     * List all tokens
     */
    router.get('/admin/tokens', adminAuth, async (req, res) => {
        try {
            const platformTokens = await db.all(`
                SELECT mint, ticker, name, image, "marketCap", volume24h, "holderCount", timestamp as "createdAt", 'platform' as source
                FROM tokens
                ORDER BY volume24h DESC
                LIMIT 100
            `);

            res.json({
                success: true,
                platformTokens: platformTokens || [],
                totalPlatform: platformTokens?.length || 0
            });
        } catch (e) {
            logger.error('[Admin] List tokens error', { error: e.message });
            res.status(500).json({ error: 'Failed to list tokens' });
        }
    });

    /**
     * DELETE /admin/tokens/:mint
     * Remove a token from the database
     */
    router.delete('/admin/tokens/:mint', adminAuth, async (req, res) => {
        try {
            const { mint } = req.params;
            const { confirm } = req.query;

            if (confirm !== 'true') {
                return res.status(400).json({
                    error: 'Confirmation required. Add ?confirm=true to the request.',
                    hint: 'This action cannot be undone.'
                });
            }

            if (!mint || mint.length < 32) {
                return res.status(400).json({ error: 'Invalid mint address' });
            }

            let deleted = { platform: 0, holders: 0 };

            const platformToken = await db.get('SELECT mint, ticker FROM tokens WHERE mint = $1', [mint]);

            if (!platformToken) {
                return res.status(404).json({
                    error: 'Token not found in database',
                    mint
                });
            }

            // Delete holders first
            const holderResult = await db.run('DELETE FROM token_holders WHERE mint = $1', [mint]);
            deleted.holders += holderResult.changes || 0;

            const tokenResult = await db.run('DELETE FROM tokens WHERE mint = $1', [mint]);
            deleted.platform = tokenResult.changes || 0;

            logger.info('[Admin] Deleted platform token', { mint, ticker: platformToken.ticker });

            res.json({
                success: true,
                message: 'Token deleted successfully',
                mint,
                ticker: platformToken.ticker,
                deleted
            });
        } catch (e) {
            logger.error('[Admin] Delete token error', { error: e.message });
            res.status(500).json({ error: 'Failed to delete token' });
        }
    });

    /**
     * GET /admin/simulate-airdrop
     * v25.114: Simulate airdrop distribution without executing transactions
     * Shows expected values for each wallet before actual distribution
     */
    router.get('/admin/simulate-airdrop', adminAuth, async (req, res) => {
        try {
            const holderScanner = require('../tasks/holderScanner');
            const flywheel = require('../tasks/flywheel');

            // v26.0: Per-token simulation — each token has its own pending_airdrop_lamports pool
            const TOKEN_THRESHOLD_LAMPORTS = Math.round(config.TOKEN_AIRDROP_THRESHOLD_SOL * LAMPORTS_PER_SOL);

            // Get KOTH info (informational only in v26.0 — no fee allocation)
            const kothResult = await flywheel.getAiSelectedKoth(db);

            // v27.4 BUGFIX: This simulation previously divided each holder's share by the fixed
            // 1B-token PUMP_FUN_TOTAL_SUPPLY, while the real distributor (flywheel.js
            // processTokenAirdrops) divides by the sum of *tracked* holder balances (99% of pool,
            // weighted 2x for ASDF Top 100 / ANSEM Top 1000 holders). Since tracked holder supply
            // is almost always far less than the full 1B supply, this made every simulated payout
            // look much smaller than what actually gets sent, and never reflected the bonus
            // weighting at all — defeating the endpoint's purpose of previewing real payouts.
            // Mirror the real formula here instead.
            const [asdfTop100Sim, ansemTop1000Sim] = await Promise.all([
                redis.getAsdfTop100Holders().catch(() => new Set()),
                redis.getAnsemTop1000Holders().catch(() => new Set()),
            ]);

            // Query all tokens with pending airdrop pools
            const pendingRows = await db.all(`
                SELECT mint, ticker, name, pending_airdrop_lamports, 'platform' as source FROM tokens WHERE pending_airdrop_lamports > 0
                ORDER BY pending_airdrop_lamports DESC
            `);

            let totalPendingLamports = 0;
            let tokensAboveThreshold = 0;
            const maxDetailedRecipients = parseInt(req.query.limit) || 50;
            const tokenSimulations = [];

            for (const row of pendingRows) {
                const pendingLamports = parseInt(row.pending_airdrop_lamports || 0);
                totalPendingLamports += pendingLamports;
                const wouldTrigger = pendingLamports >= TOKEN_THRESHOLD_LAMPORTS;
                if (wouldTrigger) tokensAboveThreshold++;

                const holders = await db.all(
                    `SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC`,
                    [row.mint]
                );

                // Match flywheel.js processTokenAirdrops: 99% distributed (1% dust buffer),
                // weighted by effective balance (2x for ASDF Top 100 / ANSEM Top 1000, stacking to 4x)
                const distributableBig = BigInt(Math.floor(pendingLamports * 0.99));
                const weightedHolders = holders.map(h => {
                    const bal = BigInt(h.balance || '0');
                    const asdfMult = asdfTop100Sim.has(h.holderPubkey) ? BigInt(2) : BigInt(1);
                    const ansemMult = ansemTop1000Sim.has(h.holderPubkey) ? BigInt(2) : BigInt(1);
                    return { holderPubkey: h.holderPubkey, balance: bal, effectiveBal: bal * asdfMult * ansemMult };
                });
                const totalEffectiveBal = weightedHolders.reduce((sum, h) => sum + h.effectiveBal, BigInt(0));

                const distribution = [];
                if (totalEffectiveBal > BigInt(0)) {
                    for (const h of weightedHolders) {
                        if (h.balance === BigInt(0)) continue;
                        const shareBig = distributableBig * h.effectiveBal / totalEffectiveBal;
                        const share = Number(shareBig);
                        if (share > 0) {
                            distribution.push({
                                wallet: h.holderPubkey,
                                walletShort: h.holderPubkey.slice(0, 8) + '...',
                                amountLamports: share,
                                amountSOL: (share / LAMPORTS_PER_SOL).toFixed(6),
                                bonusWeighted: h.effectiveBal !== h.balance,
                                supplyPercent: (Number(h.effectiveBal * BigInt(10000) / totalEffectiveBal) / 100).toFixed(4) + '%'
                            });
                        }
                    }
                }
                distribution.sort((a, b) => b.amountLamports - a.amountLamports);

                tokenSimulations.push({
                    mint: row.mint,
                    ticker: row.ticker,
                    name: row.name,
                    source: row.source,
                    pendingSOL: (pendingLamports / LAMPORTS_PER_SOL).toFixed(6),
                    pendingLamports,
                    wouldTrigger,
                    thresholdSOL: (TOKEN_THRESHOLD_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3),
                    holderCount: holders.length,
                    recipientCount: distribution.length,
                    topRecipients: distribution.slice(0, maxDetailedRecipients),
                    hasMore: distribution.length > maxDetailedRecipients
                });
            }

            const summary = {
                model: 'v26.0 per-token',
                totalTokensWithPendingPools: pendingRows.length,
                tokensAboveThreshold,
                thresholdSOL: (TOKEN_THRESHOLD_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3),
                totalPendingSOL: (totalPendingLamports / LAMPORTS_PER_SOL).toFixed(4),
                koth: kothResult?.token ? {
                    ticker: kothResult.token.ticker,
                    mint: kothResult.token.mint,
                    note: 'KOTH is informational only — no fee allocation in v26.0'
                } : null
            };

            res.json({
                success: true,
                simulation: true,
                timestamp: new Date().toISOString(),
                summary,
                tokens: tokenSimulations,
                warnings: tokensAboveThreshold === 0 ? [
                    `No tokens have pending pools >= ${(TOKEN_THRESHOLD_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} SOL threshold`
                ] : [],
                note: 'SIMULATION only. No transactions executed. v26.0: per-token independent pools.'
            });
        } catch (e) {
            logger.error('[Admin] Simulate airdrop error', { error: e.message, stack: e.stack });
            res.status(500).json({ error: 'Failed to simulate airdrop', details: e.message });
        }
    });

    return router;
}

module.exports = { init };
