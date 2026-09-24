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
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { Connection } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

// Internal imports
const config = require('./config/env');
const { WALLETS } = require('./config/constants');
const { logger, database, redis, twitter, solana, websocket, claudeKoth } = require('./services');
const signerService = require('./services/signer');
const routes = require('./routes');
const tasks = require('./tasks');

// v27.6: the HTTP server, assigned in main() and read by shutdown() so the process can stop
// accepting connections and drain in-flight requests before tearing down its dependencies.
let server = null;

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

    get asdfTopHolders() { return this._asdfTopHolders || new Set(); },
    set asdfTopHolders(val) {
        this._asdfTopHolders = val;
        redis.setAsdfTopHolders([...val]).catch(e => logger.debug('Redis setAsdfTopHolders failed', { error: e.message }));
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
    _asdfTopHolders: new Set(),
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

    // v30.4: the platform signer replaces the raw Keypair that used to travel on `deps`. Built
    // first, before anything can fail: the key material (or the Vault token) is consumed here
    // and scrubbed from the environment -- and the ephemeral key file scripts/boot.sh may have
    // parked is deleted -- before Redis or Postgres get a chance to abort the boot.
    //
    // An API-only process with no key configured runs on a public-only signer: it verifies
    // launch payments and reports the wallet address, and the worker service -- which has no
    // inbound network -- does every signing job. The process facing the internet then has
    // nothing to steal.
    let signer;
    if (signerService.hasKeyConfigured()) {
        signer = await signerService.createSignerFromEnv();
        signerService.scrubSecretsFromEnv();
        signerService.verifyPlatformWallet(signer, WALLETS.PLATFORM_DEV, config);
    } else {
        signer = signerService.createPublicOnlySigner(WALLETS.PLATFORM_DEV);
        logger.info(`[Signer] No wallet key in this process; launches and refunds run in the worker service (wallet ${signer.publicKey.toBase58()})`);
    }
    solana.setSigner(signer);

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

    // v29.1: recover any vanity addresses left in the 'claimed' state by a process that died
    // mid-launch. This is the main source of the leak, so sweeping once on boot covers it even
    // in deployments that run no separate grinder service.
    await require('./services/vanity').reapStrandedClaims(db).catch(() => {});

    // Initialize Twitter (v25.22: Now async to fetch username)
    await twitter.init();

    // Initialize Solana connection with timeout
    // v25.47 STABILITY: Added httpAgent with timeout to prevent hanging RPC calls
    const connection = new Connection(config.RPC_URL, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: config.RPC_TIMEOUT_MS,
        // v30.2: web3.js otherwise retries every 429 itself (up to 5 times), silently multiplying
        // request volume exactly when the provider is asking us to slow down. Callers here already
        // treat a failed read as "try next cycle".
        disableRetryOnRateLimit: true,
        fetch: (url, options) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), config.RPC_TIMEOUT_MS);
            return fetch(url, { ...options, signal: controller.signal })
                .finally(() => clearTimeout(timeout));
        }
    });

    logger.info(`Network: ${config.SOLANA_NETWORK.toUpperCase()} | RPC: ${config.RPC_URL.includes('devnet') ? 'Devnet' : (config.HELIUS_API_KEY ? 'Helius' : 'Public Mainnet')}`);

    // Create Express app
    const app = express();

    // v28.2 SECURITY: trust exactly one proxy hop (Render's edge). Without this, req.ip is
    // the proxy's address for every client, so the default-keyed rate limiters (apiLimiter,
    // deployLimiter) put ALL users in one 120/min bucket and one 5/min deploy bucket — one
    // busy client 429s everyone. The custom keyGenerators that worked around that took the
    // LEFTMOST X-Forwarded-For entry, which is the one the client writes, so every limiter
    // using them (health, token registration, admin login brute-force) could be bypassed by
    // sending a random X-Forwarded-For per request. With trust proxy set, Express derives
    // req.ip from the rightmost untrusted hop — the address Render actually saw — and the
    // library's default key generator handles IPv6 subnetting on top of it.
    app.set('trust proxy', 1);

    // Security middleware - SECURITY FIX: Re-enable CSP with reasonable defaults
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // v30.2: the page loads web3.js from jsdelivr (pinned by SRI hash in the page);
                // without this the API-served copy of the launcher could not launch at all.
                scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
                // v30.3: helmet's default script-src-attr 'none' silently disabled every
                // onclick= in the admin console when the API serves it at /admin. The launcher
                // page itself carries no inline handlers and does not need this.
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https:"], // Allow external images
                connectSrc: ["'self'", "https://api.dexscreener.com", "https://mainnet.helius-rpc.com"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: []
            }
        },
        crossOriginEmbedderPolicy: false // Keep disabled for cross-origin resources
    }));

    // v24.0 SECURITY FIX: Stricter CORS configuration
    // In production, reject wildcard CORS and require explicit origins
    // v25.49: Auto-include FRONTEND_URL in allowed origins for cross-origin setups
    let corsOrigins;
    if (config.NODE_ENV === 'production') {
        if (config.CORS_ORIGINS.includes('*') || !config.CORS_ORIGINS || config.CORS_ORIGINS.length === 0) {
            // Check if FRONTEND_URL is configured (cross-origin setup)
            if (config.FRONTEND_URL && config.FRONTEND_URL.startsWith('http')) {
                const frontendOrigin = new URL(config.FRONTEND_URL).origin;
                corsOrigins = [frontendOrigin];
                logger.info(`CORS: Auto-allowing frontend origin from FRONTEND_URL: ${frontendOrigin}`);
            } else {
                // Default to same-origin only in production if not configured
                logger.warn('SECURITY: CORS wildcard rejected in production. Using same-origin policy.');
                logger.warn('Set CORS_ORIGINS or FRONTEND_URL environment variable to allow specific origins.');
                corsOrigins = false; // Disables CORS (same-origin only)
            }
        } else {
            corsOrigins = config.CORS_ORIGINS;
            // Also include FRONTEND_URL origin if not already in the list
            if (config.FRONTEND_URL && config.FRONTEND_URL.startsWith('http')) {
                const frontendOrigin = new URL(config.FRONTEND_URL).origin;
                if (!corsOrigins.includes(frontendOrigin)) {
                    corsOrigins = [...corsOrigins, frontendOrigin];
                    logger.info(`CORS: Added frontend origin from FRONTEND_URL: ${frontendOrigin}`);
                }
            }
        }
    } else {
        // In development, allow wildcard for convenience
        corsOrigins = config.CORS_ORIGINS.includes('*') ? '*' : config.CORS_ORIGINS;
    }

    // Log CORS configuration for debugging
    logger.info('[CORS] Configuration', {
        corsOrigins: Array.isArray(corsOrigins) ? corsOrigins : corsOrigins,
        nodeEnv: config.NODE_ENV,
        frontendUrl: config.FRONTEND_URL
    });

    // credentials:true is incompatible with wildcard origin (browsers reject it).
    // Only enable credentials when we have explicit allowed origins.
    const corsOptions = {
        origin: corsOrigins,
        optionsSuccessStatus: 200,
        credentials: corsOrigins !== '*' && corsOrigins !== false,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'X-Requested-With']
    };
    app.use(cors(corsOptions));

    app.use(cookieParser());
    // v28.2: 1mb. Images go to Imgur client-side; the largest JSON body this API accepts is
    // launch metadata (a few hundred bytes). 10mb was a memory-amplification surface for no
    // legitimate request.
    app.use(express.json({ limit: '1mb' }));

    // v25.4: Rate limiting - More permissive for frontend polling, strict for deployments
    // With WebSocket, polling should be reduced but we still allow reasonable API access
    const apiLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute window
        max: 120, // 120 requests per minute (2 per second)
        message: { error: 'Too many requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false,
        // v30.2: the old `skip` list compared req.path against '/api/health' etc., but under
        // app.use('/api/', ...) req.path is mount-relative ('/health'), so it never matched.
        // Only the static version probe is exempt; /health has its own limiter as well.
        skip: (req) => req.path === '/version'
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

    // Serve the ShitPad frontend.
    //
    // The static site is normally deployed on its own (see shitpad/render.yaml), so this
    // route exists for single-service deployments and as a sane landing page on the API
    // host itself. The `/` handler sends the page; `/admin` sends the admin console.
    const SHITPAD_DIR = path.join(__dirname, '..', 'shitpad');
    // v30.2: served with the backend meta tag blanked, so this copy talks to the API that
    // served it (same origin) rather than to whatever host the static build points at --
    // which the Content-Security-Policy above would block anyway.
    const sameOriginPage = (file) => {
        let cached = null;
        return (req, res) => {
            try {
                if (!cached) {
                    cached = fs.readFileSync(file, 'utf8')
                        .replace(/(<meta name="shitpad-backend" content=")[^"]*(")/, '$1$2');
                }
                res.type('html').send(cached);
            } catch (e) {
                res.status(500).send('Page unavailable');
            }
        };
    };
    app.get('/', sameOriginPage(path.join(SHITPAD_DIR, 'index.html')));
    app.get('/admin', sameOriginPage(path.join(SHITPAD_DIR, 'admin', 'index.html')));


    // v29.2: delegate to the one implementation in services/solana.js. This was a local copy
    // here and a byte-identical one in the other entrypoint, alongside a third, divergent copy
    // in that service, so a change to refund behaviour had to be made in three places.
    const refundUser = solana.refundUser;


    // Dependencies object for modules
    const deps = {
        connection,
        signer,
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
        // v30.2: registered so shutdown() closes them, which waits for an in-flight launch to
        // finish instead of killing it mid-send (a killed launch used to be re-run by BullMQ).
        // v30.4: only when this process holds the key. Without one, the worker service's
        // `deploy` task consumes the same queue.
        if (signer.kind === 'public-only') {
            logger.info('[Server] Deploy worker not started here (no wallet key); the worker service processes launches');
        } else {
            tasks.registerWorker(tasks.workers.initDeployWorker(deps));
        }
        tasks.registerWorker(tasks.workers.initSocialWorker(deps));
        logger.info('[Server] Social worker initialized for API-only mode');
    } else {
        // Start background tasks
        tasks.startAll(deps);
    }

    // v25.4: Create HTTP server for WebSocket support
    // v27.6: assigned to the module-scoped `server` so shutdown() can close it.
    server = http.createServer(app);

    // Initialize WebSocket server
    websocket.init(server);

    // v30.2: broadcast in every mode. The broadcast reads only the database, so it works in
    // the API process, and api-only is how production runs -- where it used to be switched
    // off, leaving every connected page showing "Live" while receiving nothing.
    websocket.startBroadcasting(deps);

    // Start server
    server.listen(config.PORT, () => {
        logger.info(`Server ${config.VERSION} running on port ${config.PORT}`);
        logger.info(`[WebSocket] Available at ws://localhost:${config.PORT}/ws`);
    });
}

// v25.14 ROBUSTNESS: Graceful shutdown with task cleanup
// v25.20: Added WebSocket cleanup
// v27.6: how long cleanup gets before we exit anyway. Render sends SIGKILL after its own
// grace period, so a shutdown that hangs on a stuck query must not eat the whole window.
// v30.2: long enough for an in-flight launch (decoys + confirmation) to finish. Pair with
// maxShutdownDelaySeconds on the Render service, which must be at least this long.
const SHUTDOWN_TIMEOUT_MS = 170000;

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully...`);

    const forceExit = setTimeout(() => {
        logger.error(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
        // v30.2: WebSockets first -- an open WS keeps server.close() waiting indefinitely.
        try {
            websocket.close();
        } catch (wsErr) {
            logger.debug('WebSocket cleanup error', { error: wsErr.message });
        }

        // v27.6: stop accepting new connections and let in-flight requests finish before
        // anything they depend on is torn down.
        if (server) {
            await new Promise((resolve) => {
                server.close(() => resolve());
                if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
            });
        }

        // Stop background tasks. This waits for an in-flight launch job to finish, while the
        // database and Redis are still up for it.
        await tasks.stopAll();

        // Close database connection
        const db = database.getDB();
        if (db) await db.close();

        // Disconnect Redis
        redis.getConnection()?.disconnect();

        logger.info('Cleanup complete, exiting');
    } catch (e) {
        logger.error('Shutdown error', { error: e.message });
    }
    clearTimeout(forceExit);
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// v27.6: the API process had neither of these while worker.js had both, so an unhandled
// rejection anywhere in a route or a background timer killed the web service on Node 18+
// with no log line explaining why.
process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION - API server crashing', {
        error: err.message,
        stack: err.stack
    });
    const mem = process.memoryUsage();
    logger.error(`Memory at crash: RSS=${Math.round(mem.rss / 1024 / 1024)}MB, Heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED REJECTION - Potential crash', {
        reason: reason?.message || String(reason),
        stack: reason?.stack
    });
});

// Run main
main().catch(err => {
    logger.error("Fatal error", { error: err.message, stack: err.stack });
    process.exit(1);
});
