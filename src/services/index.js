/**
 * Services Index
 * Central export for all services
 * v13.0 - PostgreSQL + Redis globalState
 * v14.0 - Added mintExtractor for unified mint discovery
 * v24.0 - Added circuitBreaker for external API resilience
 * v25.1 - Removed cloudflareImages (using Imgur for user uploads)
 * v25.4 - Added websocket for real-time frontend updates
 * v25.22 - Added signatureVerifier for cryptographic request authentication
 * v25.38 - Added claudeKoth for AI-based KOTH selection
 * v25.47 - Added PAGS (Pay-to-Twitter/X) services
 */
const logger = require('./logger');
const postgres = require('./postgres');
const solana = require('./solana');
const pinata = require('./pinata');
const redis = require('./redis');
const pump = require('./pump');
const twitter = require('./twitter');
const moderation = require('./moderation');
const jupiter = require('./jupiter');
const mutex = require('./mutex');
const mintExtractor = require('./mintExtractor');
const imageUtils = require('./imageUtils');
const circuitBreaker = require('./circuitBreaker');
const sanitizer = require('./sanitizer');
const websocket = require('./websocket');
const signatureVerifier = require('./signatureVerifier');
const claudeKoth = require('./claudeKoth');
const pags = require('./pags');
const pagsTwitterAuth = require('./pagsTwitterAuth');
const heliusDAS = require('./heliusDAS');

// v13.0: Use PostgreSQL as the database layer
const database = postgres;

module.exports = {
    logger,
    database,
    postgres,
    solana,
    pinata,
    redis,
    pump,
    twitter,
    moderation,
    jupiter,
    mutex,
    mintExtractor,
    imageUtils,
    circuitBreaker,
    sanitizer,
    websocket,
    signatureVerifier,
    claudeKoth,
    pags,
    pagsTwitterAuth,
    heliusDAS,
};
