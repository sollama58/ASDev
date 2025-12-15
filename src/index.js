/**
 * ASDev
 * Main Entry Point
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
const { logger, database, redis, twitter, solana } = require('./services');
const routes = require('./routes');
const tasks = require('./tasks');

// Global state (shared across modules)
const globalState = {
    lastBackendUpdate: Date.now(),
    asdfTop50Holders: new Set(),
    totalPoints: 0,
    devPumpHoldings: 0,
    userExpectedAirdrops: new Map(),
    userPointsMap: new Map(),
};

/**
 * Main initialization function
 */
async function main() {
    logger.info(`Starting ASDev ${config.VERSION}...`);

    // Initialize database
    await database.initDB();
    const db = database.getDB();

    // Initialize Redis
    redis.init();

    // Initialize Twitter
    twitter.init();

    // Initialize Solana connection
    const connection = new Connection(config.RPC_URL, "confirmed");
    const devKeypair = Keypair.fromSecretKey(bs58.decode(config.DEV_WALLET_PRIVATE_KEY));
    const wallet = new Wallet(devKeypair);

    logger.info(`Network: ${config.SOLANA_NETWORK.toUpperCase()} | RPC: ${config.RPC_URL.includes('devnet') ? 'Devnet' : (config.HELIUS_API_KEY ? 'Helius' : 'Public Mainnet')}`);
    logger.info(`Wallet: ${devKeypair.publicKey.toString()}`);

    // Create Express app
    const app = express();

    // Security middleware
    app.use(helmet({
        contentSecurityPolicy: false, // Disable CSP for frontend flexibility
        crossOriginEmbedderPolicy: false
    }));

    // CORS configuration
    // DIAGNOSIS FIX: Use '*' explicitly if wildcard is detected, rather than reflection (true)
    // This is more robust for public frontends (like Squarespace) interacting with Render
    const corsOptions = {
        origin: config.CORS_ORIGINS.includes('*') ? '*' : config.CORS_ORIGINS,
        optionsSuccessStatus: 200,
        credentials: true
    };
    app.use(cors(corsOptions));
    app.use(express.json({ limit: '50mb' }));

    // Rate limiting
    // DIAGNOSIS FIX: Increased max requests from 100 to 2000 per 15 minutes.
    // The frontend polls ~6 endpoints every minute. 100 was too low and caused false "Offline" states.
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 2000, // Increased to accommodate frontend polling
        message: { error: 'Too many requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false
    });

    const deployLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 10, // Increased slightly to prevent accidental blocks during launch parties
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
