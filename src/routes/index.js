/**
 * Routes Index
 * Central route registration
 */
const healthRoutes = require('./health');
const tokenRoutes = require('./tokens');
const deployRoutes = require('./deploy');
const solanaRoutes = require('./solana');

/**
 * Register all routes on the Express app
 */
function register(app, deps) {
    app.use('/api', healthRoutes.init(deps));
    app.use('/api', tokenRoutes.init(deps));
    app.use('/api', deployRoutes.init(deps));
    app.use('/api', solanaRoutes.init(deps));
}

module.exports = { register };
