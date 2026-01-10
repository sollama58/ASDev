/**
 * Health & Status Routes
 * Server health, stats, and debugging endpoints
 */
const express = require('express');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, PROGRAMS } = require('../config/constants');
const { pump, logger } = require('../services');

const router = express.Router();

// Admin auth middleware for sensitive endpoints
const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-admin-key'];
    const expectedKey = process.env.ADMIN_API_KEY;

    // If no admin key configured, block access in production
    if (!expectedKey && process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Debug endpoint disabled in production' });
    }

    // If admin key configured, require it
    if (expectedKey && apiKey !== expectedKey) {
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
                const logs = await db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 50');

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

                return {
                    stats, launches, logs, currentBalance, pumpHoldings, totalPendingFees, totalVolume, totalAirdropped, totalSolAirdropped,
                    robinhoodTokenCount: robinhoodTokenCount?.count || 0,
                    robinhoodTotalFees: robinhoodTotalFees?.total || 0
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
                recentLogs: cachedHealth.logs.map(l => ({ ...JSON.parse(l.data), type: l.type, timestamp: l.timestamp })),
                headerImageUrl: config.HEADER_IMAGE_URL,
                currentFeeBalance: (cachedHealth.totalPendingFees / LAMPORTS_PER_SOL).toFixed(4),
                lastClaimTime: cachedHealth.stats.lastClaimTimestamp || 0,
                lastClaimAmount: (cachedHealth.stats.lastClaimAmountLamports / LAMPORTS_PER_SOL).toFixed(4),
                nextCheckTime: cachedHealth.stats.nextCheckTimestamp || (Date.now() + 5*60*1000),
                totalVolume: cachedHealth.totalVolume,
                // v11.0: Legacy PUMP airdrop total (for backwards compatibility)
                totalAirdropped: cachedHealth.totalAirdropped,
                // v11.0: SOL airdrop total (new)
                totalSolAirdropped: cachedHealth.totalSolAirdropped || 0,
                // v11.0: Current airdrop pool available (SOL balance minus reserve)
                airdropPoolSol: Math.max(0, (cachedHealth.currentBalance / LAMPORTS_PER_SOL) - 0.5).toFixed(4),
                airdropCurrency: 'SOL', // v11.0: Indicates current airdrop currency
                // Pass dynamic conservation status to frontend
                conservationStatus: globalState.conservationStatus || null,
                // v12.0: Robinhood Bot stats
                robinhood: {
                    activeTokens: cachedHealth.robinhoodTokenCount || 0,
                    totalFeesCollectedSol: cachedHealth.robinhoodTotalFees || 0,
                    lifetimeFeesLamports: cachedHealth.stats.lifetimeRobinhoodFeesLamports || 0
                }
            });
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
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
    // Fetches metadata from Pump.fun/DexScreener and adds to tokens table
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

            // Fetch metadata from Pump.fun
            let pumpMeta = null;
            try {
                const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, { timeout: 5000 });
                if (pumpRes.data) {
                    pumpMeta = {
                        name: pumpRes.data.name || 'Unknown',
                        ticker: pumpRes.data.symbol || 'UNKNOWN',
                        image: pumpRes.data.image_uri || null,
                        description: pumpRes.data.description || '',
                        twitter: pumpRes.data.twitter || null,
                        website: pumpRes.data.website || null,
                        creator: pumpRes.data.creator || null,
                        marketCap: pumpRes.data.usd_market_cap || 0,
                        complete: pumpRes.data.complete || false
                    };
                }
            } catch (e) {
                logger.debug('Pump.fun metadata fetch failed', { error: e.message });
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

            if (!pumpMeta && !dexMeta) {
                return res.status(404).json({ error: 'Token not found on Pump.fun or DexScreener' });
            }

            const metadata = {
                name: pumpMeta?.name || dexMeta?.name || 'Unknown Token',
                ticker: pumpMeta?.ticker || dexMeta?.ticker || 'UNKNOWN',
                image: pumpMeta?.image || dexMeta?.image || null,
                description: pumpMeta?.description || '',
                twitter: pumpMeta?.twitter || null,
                website: pumpMeta?.website || null,
                creator: pumpMeta?.creator || null,
                marketCap: dexMeta?.marketCap || pumpMeta?.marketCap || 0,
                volume24h: dexMeta?.volume24h || 0,
                complete: pumpMeta?.complete || false
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
            res.status(500).json({ error: 'Import failed: ' + e.message });
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
            res.status(500).json({ error: 'Bulk import failed: ' + e.message });
        }
    });

    return router;
}

module.exports = { init };
