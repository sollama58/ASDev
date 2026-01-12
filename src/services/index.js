/**
 * Services Index
 * Central export for all services
 * v13.0 - PostgreSQL + Redis globalState
 * v14.0 - Added mintExtractor for unified mint discovery
 * v24.0 - Added circuitBreaker for external API resilience
 * v25.1 - Removed cloudflareImages (using Imgur for user uploads)
 * v25.4 - Added websocket for real-time frontend updates
 */
const logger = require('./logger');
const postgres = require('./postgres');
const solana = require('./solana');
const vanity = require('./vanity');
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

// v13.0: Use PostgreSQL as the database layer
const database = postgres;

module.exports = {
    logger,
    database,
    postgres,
    solana,
    vanity,
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
};
