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
const redis = require('./redis');

let wss = null;
let broadcastInterval = null;
let lastAirdropLogId = null; // v30.3: last airdrop_logs id announced over the socket
let lastBroadcastData = null;

// Track connected clients
const clients = new Set();

// v29.4: the only inbound message is a ping, so anything larger is either a mistake or an
// attempt to make the server allocate memory on demand.
const MAX_INBOUND_FRAME_BYTES = 4 * 1024;

// v29.4: a ceiling on concurrent sockets. Each one costs a file descriptor and a slot in
// every broadcast, and nothing else bounded them. Refused connections are closed immediately
// with a policy-violation code rather than left hanging.
const MAX_CLIENTS = parseInt(process.env.WS_MAX_CLIENTS, 10) || 1000;

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
        clientTracking: true,
        // v29.4: cap inbound frames. The default is 100MB, and every frame is stringified and
        // JSON.parsed below, so without this any client could make the server allocate and
        // parse 100MB at will, repeatedly and from many sockets. The only message this server
        // understands is {"type":"ping"}, so a small ceiling costs nothing. ws rejects an
        // oversized frame and closes that connection without invoking the message handler.
        maxPayload: MAX_INBOUND_FRAME_BYTES
    });

    wss.on('connection', (ws, req) => {
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

        if (wss.clients.size > MAX_CLIENTS) {
            logger.warn('[WebSocket] Connection refused, client limit reached', {
                ip: clientIp, limit: MAX_CLIENTS
            });
            // 1013 "try again later" tells a well-behaved client to back off and retry.
            try { ws.close(1013, 'Server busy'); } catch (e) { ws.terminate(); }
            return;
        }

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
    const { db, globalState, connection, signer } = deps;

    const doBroadcast = async () => {
        try {
            // H-1: Skip expensive DB queries when nobody is connected
            if (wss && wss.clients.size === 0) return;

            // H-1: Use cached payload if fresh (avoid redundant DB queries within 15s)
            const redisConn = redis?.getConnection?.();
            if (redisConn) {
                try {
                    const cached = await redisConn.get('ws_broadcast_cache');
                    if (cached) {
                        broadcast('update', JSON.parse(cached));
                        return;
                    }
                } catch (_) { /* skip cache on error */ }
            }

            // Gather all data the frontend needs
            const [
                stats,
                leaderboard,
                recentLaunches
            ] = await Promise.all([
                db.get('SELECT COUNT(*) as total FROM tokens'),
                // v29.0: leaderboard is platform-launched tokens, ranked by 24h volume
                db.all(`
                    SELECT mint, name, ticker, image, "userPubkey" as creator,
                           volume24h, "marketCap", complete,
                           COALESCE(pending_airdrop_lamports, 0) as pending_airdrop_lamports
                    FROM tokens
                    ORDER BY volume24h DESC NULLS LAST
                    LIMIT 20
                `),
                db.all(`
                    SELECT mint, name, ticker, image, "metadataUri", "userPubkey", timestamp
                    FROM tokens
                    ORDER BY timestamp DESC
                    LIMIT 10
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
                isEligible: (t.volume24h || 0) >= (config.AIRDROP_MIN_VOLUME_USD || 250),
                pendingAirdropSol: ((t.pending_airdrop_lamports || 0) / 1e9).toFixed(6),
                marketCap: t.marketCap || 0,
                volume: t.volume24h
            }));

            const resolvedRecentLaunches = await resolveImages(recentLaunches || []);

            // Get total pending airdrop pool (sum of all token pools) and central pool
            let airdropPoolSol = 0;
            let tokenPoolsSol = 0;
            let centralPoolSol = 0;
            try {
                const poolSum = await db.get(
                    'SELECT COALESCE(SUM(pending_airdrop_lamports), 0) as total FROM tokens WHERE pending_airdrop_lamports > 0'
                );
                tokenPoolsSol = parseInt(poolSum?.total || 0) / 1e9;
                airdropPoolSol = tokenPoolsSol; // backwards-compat
            } catch (e) { /* use 0 */ }
            try {
                const cpRow = await db.get("SELECT value FROM stats WHERE key = 'centralPoolLamports'");
                centralPoolSol = parseInt(cpRow?.value || 0) / 1e9;
            } catch (e) { /* use 0 */ }

            const payload = {
                // Stats
                totalTokens: stats?.total || 0,
                airdropPoolSol,
                tokenPoolsSol,
                centralPoolSol,
                // v30.2: from Redis -- in the API process globalState is never written.
                totalPoints: await redis.getTotalPoints().catch(() => 0),

                // Leaderboard — platform-launched tokens by 24h volume
                leaderboard: resolvedLeaderboard,

                // Recent launches (with resolved images)
                recentLaunches: resolvedRecentLaunches,

                // Timestamp for frontend sync
                serverTime: Date.now()
            };

            // v30.3: announce new payouts. The distributor runs in the worker process and cannot
            // reach this server's sockets, so broadcastAirdrop() was never called and the page's
            // "Airdrop!" toast never fired. Detect a new airdrop_logs row here instead.
            try {
                const latest = await db.get(`
                    SELECT a.id, a.amount, a.recipients, a.timestamp, a.token_source, a.details, t.ticker
                      FROM airdrop_logs a LEFT JOIN tokens t ON t.mint = a.mint
                     ORDER BY a.id DESC LIMIT 1`);
                if (latest) {
                    if (lastAirdropLogId === null) {
                        lastAirdropLogId = latest.id; // first pass: learn the current id, announce nothing
                    } else if (latest.id > lastAirdropLogId) {
                        lastAirdropLogId = latest.id;
                        let details = {};
                        try { details = latest.details ? JSON.parse(latest.details) : {}; } catch (e) { /* legacy */ }
                        broadcastAirdrop({
                            amount: parseFloat(latest.amount) || 0,
                            recipients: latest.recipients || 0,
                            ticker: latest.ticker || details.ticker || null,
                            source: latest.token_source === 'central_pool' || details.source === 'central_pool' ? 'central_pool' : 'token',
                            timestamp: Date.now(),
                        });
                    }
                }
            } catch (e) {
                logger.debug('[WebSocket] Airdrop announce check failed', { error: e.message });
            }

            // H-1: Cache payload in Redis for 15s so rapid reconnects reuse it
            if (redisConn) {
                try {
                    await redisConn.set('ws_broadcast_cache', JSON.stringify(payload), 'EX', 15);
                } catch (_) { /* non-fatal */ }
            }

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
        ticker: airdrop.ticker || null,
        source: airdrop.source || 'token',
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
