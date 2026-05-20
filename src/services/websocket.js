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
                recentLaunches,
                robinhoodStats
            ] = await Promise.all([
                db.get('SELECT COUNT(*) as total FROM tokens'),
                // v26.1: Leaderboard shows only active Robinhood partner tokens with pool data
                db.all(`
                    SELECT mint, name, ticker, image, "creatorPubkey" as creator,
                           volume24h, "marketCap", "isGraduated" as complete,
                           COALESCE(pending_airdrop_lamports, 0) as pending_airdrop_lamports
                    FROM robinhood_tokens
                    WHERE "isActive" = 1
                    ORDER BY volume24h DESC
                    LIMIT 20
                `),
                db.all(`
                    SELECT mint, name, ticker, image, "metadataUri", "userPubkey", timestamp
                    FROM tokens
                    ORDER BY timestamp DESC
                    LIMIT 10
                `),
                db.get(`
                    SELECT
                        COUNT(*) as count,
                        COALESCE(SUM("pendingFees"), 0) as pendingFees,
                        COALESCE(SUM("totalFeesCollected"), 0) as collectedFees
                    FROM robinhood_tokens
                    WHERE "isActive" = 1
                `)
            ]);

            // Resolve metadataUri fallback images for recent launches only
            const resolveImages = async (tokens) => {
                if (!tokens || !Array.isArray(tokens)) return tokens;
                return Promise.all(tokens.map(async (token) => {
                    if (!token.image || token.image === '' || token.image === 'null') {
                        if (token.metadataUri) {
                            try {
                                const metadataImage = await imageUtils.fetchImageFromMetadataUri(token.metadataUri, 3000);
                                if (metadataImage) {
                                    token.image = metadataImage;
                                    db.run('UPDATE tokens SET image = $1 WHERE mint = $2 AND (image IS NULL OR image = \'\' OR image = \'null\')',
                                        [metadataImage, token.mint]).catch(() => {});
                                }
                            } catch (e) { /* silently fail */ }
                        }
                    }
                    const { metadataUri, ...rest } = token;
                    return rest;
                }));
            };

            // Add computed fields for leaderboard tokens
            const resolvedLeaderboard = (leaderboard || []).map(t => ({
                ...t,
                isRobinhood: true,
                isEligible: (t.volume24h || 0) >= 100,
                pendingAirdropSol: ((t.pending_airdrop_lamports || 0) / 1e9).toFixed(6),
                marketCap: t.marketCap || 0,
                volume: t.volume24h
            }));

            const resolvedRecentLaunches = await resolveImages(recentLaunches || []);

            // Get total pending airdrop pool (sum of all token pools)
            let airdropPoolSol = 0;
            try {
                const poolSum = await db.get(`
                    SELECT COALESCE(SUM(p), 0) as total FROM (
                        SELECT pending_airdrop_lamports as p FROM tokens WHERE pending_airdrop_lamports > 0
                        UNION ALL
                        SELECT pending_airdrop_lamports as p FROM robinhood_tokens WHERE pending_airdrop_lamports > 0
                    ) combined
                `);
                airdropPoolSol = parseInt(poolSum?.total || 0) / 1e9;
            } catch (e) { /* use 0 */ }

            const payload = {
                // Stats
                totalTokens: stats?.total || 0,
                airdropPoolSol,
                totalPoints: globalState.totalPoints || 0,

                // Leaderboard — robinhood partner tokens only
                leaderboard: resolvedLeaderboard,

                // Recent launches (with resolved images)
                recentLaunches: resolvedRecentLaunches,

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
