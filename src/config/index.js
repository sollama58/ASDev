/**
 * Configuration Index
 * Central export for all configuration
 */
const env = require('./env');
const constants = require('./constants');

module.exports = {
    ...env,
    ...constants,
};
