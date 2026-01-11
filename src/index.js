/**
 * ASDev
 * Main Entry Point
 * v13.0 - PostgreSQL + Redis globalState
 */
require('dotenv').config();

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
const { logger, database, redis, twitter, solana } = require('./services');
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

    // Initialize Redis first (needed for globalState)
    redis.init();

    // v13.0: Initialize PostgreSQL database
    await database.initDB();
    const db = database.getDB();
    logger.info('[Database] PostgreSQL initialized with connection pooling');

    // Initialize Twitter
    twitter.init();

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

    // CORS configuration - SECURITY FIX: Warn if using wildcard in production
    if (config.CORS_ORIGINS.includes('*') && config.NODE_ENV === 'production') {
        logger.warn('SECURITY WARNING: CORS is configured with wildcard (*) in production. Consider restricting to specific origins.');
    }
    const corsOptions = {
        origin: config.CORS_ORIGINS.includes('*') ? '*' : config.CORS_ORIGINS,
        optionsSuccessStatus: 200
    };
    app.use(cors(corsOptions));
    app.use(express.json({ limit: '10mb' })); // SECURITY FIX: Reduced from 50mb to 10mb

    // Rate limiting - SECURITY FIX: Reduced to more reasonable limits
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 300, // SECURITY FIX: Reduced from 2000 to 300 (20 req/min average)
        message: { error: 'Too many requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => {
            // Skip rate limiting for health checks
            return req.path === '/api/health' || req.path === '/api/version';
        }
    });

    const deployLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 3, // SECURITY FIX: Reduced from 10 to 3 deployments per minute
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

    // Dependencies object for modules
    const deps = {
        connection,
        devKeypair,
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

    // Start background tasks
    tasks.startAll(deps);

    // Start server
    app.listen(config.PORT, () => {
        logger.info(`Server ${config.VERSION} running on port ${config.PORT}`);
    });
}

// Graceful shutdown
const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down gracefully...`);
    try {
        const db = database.getDB();
        if (db) await db.close();
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
