/**
 * WebSocket Service
 * Real-time data push to frontend clients
 * v25.4 - Initial implementation to reduce polling load
 * v25.6 - Added metadataUri fallback for images
 * v25.64 - Made broadcast interval configurable via WS_BROADCAST_INTERVAL
 */
const WebSocket = require('ws');
const logger = require('./logger');
const imageUtils = require('./imageUtils');
const config = require('../config/env');

let wss = null;
let broadcastInterval = null;
let lastBroadcastData = null;

// Track connected clients
const clients = new Set();

/**
 * Initialize WebSocket server attached to HTTP server
 * @param {http.Server} server - HTTP server instance
 */
function init(server) {
    wss = new WebSocket.Server({
        server,
        path: '/ws',
        // Permissive settings for reliability
        perMessageDeflate: false, // Disable compression for lower latency
        clientTracking: true
    });

    wss.on('connection', (ws, req) => {
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
        logger.debug('[WebSocket] Client connected', { ip: clientIp, totalClients: wss.clients.size });

        clients.add(ws);

        // Send initial data immediately on connection
        if (lastBroadcastData) {
            try {
                ws.send(JSON.stringify({ type: 'initial', data: lastBroadcastData }));
            } catch (e) {
                logger.debug('[WebSocket] Failed to send initial data', { error: e.message });
            }
        }

        // Handle client messages (ping/pong, subscriptions, etc.)
        ws.on('message', (message) => {
            try {
                const msg = JSON.parse(message.toString());
                if (msg.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                }
                // Future: handle subscription requests for specific data
            } catch (e) {
                // Ignore invalid messages
            }
        });

        ws.on('close', () => {
            clients.delete(ws);
            logger.debug('[WebSocket] Client disconnected', { totalClients: wss.clients.size });
        });

        ws.on('error', (error) => {
            logger.debug('[WebSocket] Client error', { error: error.message });
            clients.delete(ws);
        });

        // Keep-alive ping every 30 seconds
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
    });

    // Heartbeat to detect dead connections
    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                clients.delete(ws);
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('close', () => {
        clearInterval(heartbeatInterval);
        if (broadcastInterval) clearInterval(broadcastInterval);
    });

    logger.info('[WebSocket] Server initialized on /ws');
    return wss;
}

/**
 * Broadcast data to all connected clients
 * @param {string} type - Message type (e.g., 'update', 'leaderboard', 'launch')
 * @param {object} data - Data payload
 */
function broadcast(type, data) {
    if (!wss) return;

    const message = JSON.stringify({ type, data, timestamp: Date.now() });

    // Cache for new connections
    if (type === 'update') {
        lastBroadcastData = data;
    }

    let sentCount = 0;
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
                sentCount++;
            } catch (e) {
                logger.debug('[WebSocket] Broadcast send error', { error: e.message });
            }
        }
    });

    if (sentCount > 0) {
        logger.debug(`[WebSocket] Broadcast '${type}' to ${sentCount} clients`);
    }
}

/**
 * Start periodic broadcasts of global state
 * @param {object} deps - Dependencies containing globalState, db, etc.
 * @param {number} intervalMs - Broadcast interval in milliseconds (default from config)
 */
function startBroadcasting(deps, intervalMs = config.WS_BROADCAST_INTERVAL || 30000) {
    const { db, globalState, connection, devKeypair } = deps;

    const doBroadcast = async () => {
        try {
            // Gather all data the frontend needs
            const [
                stats,
                leaderboard,
                kothToken,
                recentLaunches,
                robinhoodStats
            // v25.63: Tokens can be in both platform AND PAGS (fee splitting allowed)
            ] = await Promise.all([
                db.get('SELECT COUNT(*) as total FROM tokens'),
                db.all(`
                    SELECT mint, name, ticker, image, metadataUri, volume24h, "marketCap", price, "isBonded"
                    FROM tokens
                    ORDER BY volume24h DESC
                    LIMIT 20
                `),
                db.get('SELECT mint, name, ticker, image, metadataUri, "marketCap" FROM tokens ORDER BY "marketCap" DESC LIMIT 1'),
                db.all(`
                    SELECT mint, name, ticker, image, metadataUri, "userPubkey", "createdAt"
                    FROM tokens
                    ORDER BY "createdAt" DESC
                    LIMIT 10
                `),
                db.get(`
                    SELECT
                        COUNT(*) as count,
                        COALESCE(SUM("pendingFees"), 0) as pendingFees,
                        COALESCE(SUM("collectedFees"), 0) as collectedFees
                    FROM robinhood_tokens
                    WHERE "isActive" = 1
                `)
            ]);

            // v25.6: Apply metadataUri fallback for tokens with missing images
            const resolveImages = async (tokens) => {
                if (!tokens || !Array.isArray(tokens)) return tokens;
                return Promise.all(tokens.map(async (token) => {
                    // If image is missing/null, try metadataUri fallback
                    if (!token.image || token.image === '' || token.image === 'null') {
                        if (token.metadataUri) {
                            try {
                                const metadataImage = await imageUtils.fetchImageFromMetadataUri(token.metadataUri, 3000);
                                if (metadataImage) {
                                    token.image = metadataImage;
                                    // Update database so we don't fetch again
                                    db.run('UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = \'\' OR image = \'null\')',
                                        [metadataImage, token.mint]).catch(() => {});
                                }
                            } catch (e) {
                                // Silently fail - fallback mechanism
                            }
                        }
                    }
                    // Remove metadataUri from response (not needed by frontend)
                    const { metadataUri, ...rest } = token;
                    return rest;
                }));
            };

            // Resolve images for all token lists
            const [resolvedLeaderboard, resolvedKoth, resolvedRecentLaunches] = await Promise.all([
                resolveImages(leaderboard || []),
                kothToken ? resolveImages([kothToken]).then(arr => arr[0]) : null,
                resolveImages(recentLaunches || [])
            ]);

            // Get airdrop pool balance
            let airdropPoolSol = 0;
            let solBalance = 0;
            try {
                const balance = await connection.getBalance(devKeypair.publicKey);
                solBalance = balance / 1e9;
                airdropPoolSol = Math.max(0, solBalance - 0.5); // Reserve 0.5 SOL
            } catch (e) {
                // Use cached value if RPC fails
            }

            const payload = {
                // Stats
                totalTokens: stats?.total || 0,
                airdropPoolSol,
                solBalance,
                totalPoints: globalState.totalPoints || 0,

                // Leaderboard (with resolved images)
                leaderboard: resolvedLeaderboard || [],

                // KOTH (with resolved image)
                koth: resolvedKoth || null,

                // Recent launches (with resolved images)
                recentLaunches: resolvedRecentLaunches || [],

                // Robinhood
                robinhood: {
                    count: robinhoodStats?.count || 0,
                    pendingFees: parseFloat(robinhoodStats?.pendingFees || 0),
                    collectedFees: parseFloat(robinhoodStats?.collectedFees || 0)
                },

                // Timestamp for frontend sync
                serverTime: Date.now()
            };

            broadcast('update', payload);
        } catch (e) {
            logger.error('[WebSocket] Broadcast data gather error', { error: e.message });
        }
    };

    // Initial broadcast after short delay
    setTimeout(doBroadcast, 2000);

    // Periodic broadcasts
    broadcastInterval = setInterval(doBroadcast, intervalMs);
    logger.info(`[WebSocket] Broadcasting every ${intervalMs / 1000}s`);
}

/**
 * Broadcast a new token launch event
 * @param {object} token - Token data
 */
function broadcastLaunch(token) {
    broadcast('launch', {
        mint: token.mint,
        name: token.name,
        ticker: token.ticker,
        image: token.image,
        userPubkey: token.userPubkey,
        createdAt: token.createdAt || Date.now()
    });
}

/**
 * Broadcast an airdrop distribution event
 * @param {object} airdrop - Airdrop data
 */
function broadcastAirdrop(airdrop) {
    broadcast('airdrop', {
        amount: airdrop.amount,
        recipients: airdrop.recipients,
        timestamp: airdrop.timestamp || Date.now()
    });
}

/**
 * Broadcast an announcement to all connected clients
 * @param {object} announcement - Announcement data
 */
function broadcastAnnouncement(announcement) {
    broadcast('announcement', {
        id: announcement.id,
        title: announcement.title,
        message: announcement.message,
        type: announcement.type || 'info',
        expiresAt: announcement.expiresAt,
        createdAt: announcement.createdAt || Date.now()
    });
}

/**
 * Get connected client count
 */
function getClientCount() {
    return wss ? wss.clients.size : 0;
}

/**
 * v25.20: Close WebSocket server gracefully
 */
function close() {
    if (broadcastInterval) {
        clearInterval(broadcastInterval);
        broadcastInterval = null;
    }

    if (wss) {
        // Close all client connections
        wss.clients.forEach(client => {
            try {
                client.close(1000, 'Server shutting down');
            } catch (e) {
                // Ignore close errors
            }
        });

        wss.close();
        wss = null;
        logger.info('[WebSocket] Server closed');
    }
}

module.exports = {
    init,
    broadcast,
    startBroadcasting,
    broadcastLaunch,
    broadcastAirdrop,
    broadcastAnnouncement,
    getClientCount,
    close
};
