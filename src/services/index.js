/**
 * Services Index
 * Central export for all services
 * v13.0 - PostgreSQL + Redis globalState
 * v14.0 - Added mintExtractor for unified mint discovery
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
};
