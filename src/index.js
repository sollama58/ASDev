/**
 * ASDev
 * Main Entry Point
 * v13.0 - PostgreSQL + Redis globalState
 * v22.0 - Added API-only mode support for worker server architecture
 * v24.0 - Redis connection validation on startup
 * v25.4 - WebSocket support for real-time updates, relaxed rate limits
 * v25.26 - Fixed logging for Render visibility
 *
 * Environment Variables:
 *   SERVER_MODE=api-only   - Start without background tasks (use with separate worker server)
 *   SERVER_MODE=full       - Default: Start with both API and background tasks
 */

// v25.26: Immediate stdout write to verify process starts (before any imports)
process.stdout.write(`[${new Date().toISOString()}] [INFO] ASDev Server process starting...\n`);

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// Internal imports
const config = require('./config/env');
const { WALLETS } = require('./config/constants');
const { logger, database, redis, twitter, solana, websocket, claudeKoth } = require('./services');
const routes = require('./routes');
const tasks = require('./tasks');

// v13.0: Global state is now stored in Redis for cross-process sharing
// This local object serves as a proxy/fallback for compatibility
// BUG FIX: Added proper error logging instead of silent catch blocks
const globalState = {
    // These are now backed by Redis - use redis.getXxx() for actual values
    get lastBackendUpdate() { return this._lastBackendUpdate || Date.now(); },
    set lastBackendUpdate(val) {
        this._lastBackendUpdate = val;
        redis.setLastBackendUpdate(val).catch(e => logger.debug('Redis setLastBackendUpdate failed', { error: e.message }));
    },

    get asdfTop50Holders() { return this._asdfTop50Holders || new Set(); },
    set asdfTop50Holders(val) {
        this._asdfTop50Holders = val;
        redis.setAsdfTop100Holders([...val]).catch(e => logger.debug('Redis setAsdfTop100Holders failed', { error: e.message }));
    },

    get totalPoints() { return this._totalPoints || 0; },
    set totalPoints(val) {
        this._totalPoints = val;
        redis.setTotalPoints(val).catch(e => logger.debug('Redis setTotalPoints failed', { error: e.message }));
    },

    get devPumpHoldings() { return this._devPumpHoldings || 0; },
    set devPumpHoldings(val) {
        this._devPumpHoldings = val;
        redis.setDevPumpHoldings(val).catch(e => logger.debug('Redis setDevPumpHoldings failed', { error: e.message }));
    },

    get userExpectedAirdrops() { return this._userExpectedAirdrops || new Map(); },
    set userExpectedAirdrops(val) {
        this._userExpectedAirdrops = val;
        redis.setAllUserExpectedAirdrops(val).catch(e => logger.debug('Redis setAllUserExpectedAirdrops failed', { error: e.message }));
    },

    get userPointsMap() { return this._userPointsMap || new Map(); },
    set userPointsMap(val) {
        this._userPointsMap = val;
        redis.setAllUserPoints(val).catch(e => logger.debug('Redis setAllUserPoints failed', { error: e.message }));
    },

    // Internal storage
    _lastBackendUpdate: Date.now(),
    _asdfTop50Holders: new Set(),
    _totalPoints: 0,
    _devPumpHoldings: 0,
    _userExpectedAirdrops: new Map(),
    _userPointsMap: new Map(),
};

/**
 * Main initialization function
 */
async function main() {
    logger.info(`Starting ASDev ${config.VERSION}...`);

    // v24.0: Initialize Redis first (needed for globalState) with connection validation
    // v25.20: CRITICAL - Redis is required for BullMQ job queues. Fail startup if unavailable.
    const redisInitSuccess = await redis.init();
    if (!redisInitSuccess) {
        logger.error('FATAL: Redis initialization failed - BullMQ job queues require Redis');
        logger.error('Check REDIS_URL environment variable and Redis server availability');
        process.exit(1);
    }

    // v25.40: Initialize Claude KOTH with Redis client for log storage
    const redisConnection = redis.getConnection();
    if (redisConnection) {
        claudeKoth.setRedisClient(redisConnection);
        logger.info('[ClaudeKOTH] Redis client initialized for evaluation logging');
    }

    // v13.0: Initialize PostgreSQL database
    await database.initDB();
    const db = database.getDB();
    logger.info('[Database] PostgreSQL initialized with connection pooling');

    // Initialize Twitter (v25.22: Now async to fetch username)
    await twitter.init();

    // Initialize Solana connection
    const connection = new Connection(config.RPC_URL, "confirmed");
    const devKeypair = Keypair.fromSecretKey(bs58.decode(config.DEV_WALLET_PRIVATE_KEY));
    const wallet = new Wallet(devKeypair);

    // Validate wallet matches expected platform dev wallet
    const actualWallet = devKeypair.publicKey.toString();
    const expectedWallet = WALLETS.PLATFORM_DEV.toString();
    if (actualWallet !== expectedWallet) {
        logger.error(`CRITICAL: Wallet mismatch! Expected: ${expectedWallet}, Got: ${actualWallet}`);
        logger.error('Check DEV_WALLET_PRIVATE_KEY environment variable. Server will continue but functionality may be impaired.');
    } else {
        logger.info(`Wallet verified: ${actualWallet}`);
    }

    logger.info(`Network: ${config.SOLANA_NETWORK.toUpperCase()} | RPC: ${config.RPC_URL.includes('devnet') ? 'Devnet' : (config.HELIUS_API_KEY ? 'Helius' : 'Public Mainnet')}`);

    // Create Express app
    const app = express();

    // Security middleware - SECURITY FIX: Re-enable CSP with reasonable defaults
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline for frontend
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https:"], // Allow external images
                connectSrc: ["'self'", "https://api.dexscreener.com", "https://mainnet.helius-rpc.com", "https://api.clarifai.com"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: []
            }
        },
        crossOriginEmbedderPolicy: false // Keep disabled for cross-origin resources
    }));

    // v24.0 SECURITY FIX: Stricter CORS configuration
    // In production, reject wildcard CORS and require explicit origins
    let corsOrigins;
    if (config.NODE_ENV === 'production') {
        if (config.CORS_ORIGINS.includes('*') || !config.CORS_ORIGINS || config.CORS_ORIGINS.length === 0) {
            // Default to same-origin only in production if not configured
            logger.warn('SECURITY: CORS wildcard rejected in production. Using same-origin policy.');
            logger.warn('Set CORS_ORIGINS environment variable to allow specific origins.');
            corsOrigins = false; // Disables CORS (same-origin only)
        } else {
            corsOrigins = config.CORS_ORIGINS;
        }
    } else {
        // In development, allow wildcard for convenience
        corsOrigins = config.CORS_ORIGINS.includes('*') ? '*' : config.CORS_ORIGINS;
    }

    const corsOptions = {
        origin: corsOrigins,
        optionsSuccessStatus: 200,
        credentials: true, // v24.0: Allow credentials for authenticated requests
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'X-Requested-With']
    };
    app.use(cors(corsOptions));
    app.use(express.json({ limit: '10mb' })); // SECURITY FIX: Reduced from 50mb to 10mb

    // v25.4: Rate limiting - More permissive for frontend polling, strict for deployments
    // With WebSocket, polling should be reduced but we still allow reasonable API access
    const apiLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute window
        max: 120, // 120 requests per minute (2 per second)
        message: { error: 'Too many requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => {
            // Skip rate limiting for health checks and static data
            return req.path === '/api/health' ||
                   req.path === '/api/version' ||
                   req.path === '/api/stats';
        }
    });

    const deployLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 5, // 5 deployments per minute (relaxed from 3)
        message: { error: 'Too many deployment requests, please wait' },
        standardHeaders: true,
        legacyHeaders: false
    });

    app.use('/api/', apiLimiter);
    app.use('/api/deploy', deployLimiter);

    // Serve frontend
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'asdev_frontend.html'));
    });


    const refundUser = async (userPubkeyStr, reason) => {
        try {
            const { PublicKey } = require('@solana/web3.js');
            const userPubkey = new PublicKey(userPubkeyStr);
            const tx = new Transaction();
            solana.addPriorityFee(tx);
            tx.add(SystemProgram.transfer({
                fromPubkey: devKeypair.publicKey,
                toPubkey: userPubkey,
                lamports: (config.DEPLOYMENT_FEE_SOL - 0.001) * LAMPORTS_PER_SOL
            }));
            const sig = await solana.sendTxWithRetry(tx, [devKeypair]);
            logger.info(`REFUNDED ${userPubkeyStr}: ${sig} (Reason: ${reason})`);
            return sig;
        } catch (e) {
            logger.error(`REFUND FAILED: ${e.message}`);
            return null;
        }
    };

    // PAGS: Initialize dedicated PAGS wallet keypair if configured
    // This wallet holds fees and signs claim transactions
    let pagsKeypair = null;
    if (config.PAGS_ENABLED && config.PAGS_WALLET_PRIVATE_KEY) {
        try {
            pagsKeypair = Keypair.fromSecretKey(bs58.decode(config.PAGS_WALLET_PRIVATE_KEY));
            const pagsWalletPubkey = pagsKeypair.publicKey.toString();

            // Verify the keypair matches the configured PAGS_WALLET public key
            if (config.PAGS_WALLET && pagsWalletPubkey !== config.PAGS_WALLET) {
                logger.error(`[PAGS] CRITICAL: Wallet mismatch! PAGS_WALLET=${config.PAGS_WALLET}, derived=${pagsWalletPubkey}`);
                logger.error('[PAGS] Check PAGS_WALLET_PRIVATE_KEY - keypair does not match PAGS_WALLET public key');
                pagsKeypair = null; // Disable to prevent issues
            } else {
                logger.info(`[PAGS] Wallet initialized: ${pagsWalletPubkey}`);
            }
        } catch (e) {
            logger.error(`[PAGS] Failed to initialize wallet keypair: ${e.message}`);
            logger.error('[PAGS] Claims will not be processed - check PAGS_WALLET_PRIVATE_KEY format (should be base58)');
            pagsKeypair = null;
        }
    } else if (config.PAGS_ENABLED && !config.PAGS_WALLET_PRIVATE_KEY) {
        logger.warn('[PAGS] PAGS_WALLET_PRIVATE_KEY not configured - falling back to devKeypair for claims');
        logger.warn('[PAGS] For production, configure a dedicated PAGS wallet for security');
        pagsKeypair = devKeypair; // Fallback to dev wallet
    }

    // Dependencies object for modules
    const deps = {
        connection,
        devKeypair,
        pagsKeypair, // Dedicated PAGS wallet (or null/devKeypair fallback)
        wallet,
        db,
        redis,
        globalState,
        addFees: database.addFees,
        getStats: database.getStats,
        getTotalLaunches: database.getTotalLaunches,
        recordClaim: database.recordClaim,
        updateNextCheckTime: database.updateNextCheckTime,
        logPurchase: database.logPurchase,
        saveTokenData: database.saveTokenData,
        refundUser,
    };

    // Register routes
    routes.register(app, deps);

    // v22.0: Check server mode - skip background tasks if running API-only
    const serverMode = process.env.SERVER_MODE || 'full';
    if (serverMode === 'api-only') {
        logger.info('[Server] Running in API-only mode - background tasks disabled');
        logger.info('[Server] Use a separate worker server (SERVER_MODE=worker node src/worker.js) for background tasks');
        // v25.4: Still initialize deploy and social workers in API-only mode
        // These are essential for processing deployment requests
        tasks.workers.initDeployWorker(deps);
        tasks.workers.initSocialWorker(deps);
        logger.info('[Server] Deploy and social workers initialized for API-only mode');
    } else {
        // Start background tasks
        tasks.startAll(deps);
    }

    // v25.4: Create HTTP server for WebSocket support
    const server = http.createServer(app);

    // Initialize WebSocket server
    websocket.init(server);

    // Start periodic WebSocket broadcasts (only if not API-only mode)
    if (serverMode !== 'api-only') {
        websocket.startBroadcasting(deps);
    }

    // Start server
    server.listen(config.PORT, () => {
        logger.info(`Server ${config.VERSION} running on port ${config.PORT}`);
        logger.info(`[WebSocket] Available at ws://localhost:${config.PORT}/ws`);
    });
}

// v25.14 ROBUSTNESS: Graceful shutdown with task cleanup
// v25.20: Added WebSocket cleanup
const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down gracefully...`);
    try {
        // Stop all background tasks first
        await tasks.stopAll();

        // v25.20: Close WebSocket connections
        try {
            websocket.close();
        } catch (wsErr) {
            logger.debug('WebSocket cleanup error', { error: wsErr.message });
        }

        // Close database connection
        const db = database.getDB();
        if (db) await db.close();

        // Disconnect Redis
        redis.getConnection()?.disconnect();

        logger.info('Cleanup complete, exiting');
    } catch (e) {
        logger.error('Shutdown error', { error: e.message });
    }
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Run main
main().catch(err => {
    logger.error("Fatal error", { error: err.message, stack: err.stack });
    process.exit(1);
});
