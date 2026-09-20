/**
 * Environment Configuration
 * Loads and validates environment variables
 */
require('dotenv').config();

// Environment validation
const requiredEnvVars = ['DEV_WALLET_PRIVATE_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
}

const config = {
    // Server
    VERSION: "v10.26.37-AIRDROP-METRIC",
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',

    // Solana RPC
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    SOLANA_NETWORK: process.env.SOLANA_NETWORK || 'mainnet',
    get RPC_URL() {
        if (process.env.RPC_URL) return process.env.RPC_URL;
        if (this.SOLANA_NETWORK === 'devnet') return "https://api.devnet.solana.com";
        return this.HELIUS_API_KEY
            ? `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`
            : "https://api.mainnet-beta.solana.com";
    },

    // Hard timeout for every RPC request (ms); a hung request must not stall a background loop
    RPC_TIMEOUT_MS: parseInt(process.env.RPC_TIMEOUT_MS) || 60000,

    // Wallet
    DEV_WALLET_PRIVATE_KEY: process.env.DEV_WALLET_PRIVATE_KEY,

    // Fees & Transactions
    PRIORITY_FEE_MICRO_LAMPORTS: 100000,
    DEPLOYMENT_FEE_SOL: 0.02,
    FEE_THRESHOLD_SOL: 0.20,

    // Update Intervals (ms)
    HOLDER_UPDATE_INTERVAL: parseInt(process.env.HOLDER_UPDATE_INTERVAL) || 120000,
    METADATA_UPDATE_INTERVAL: parseInt(process.env.METADATA_UPDATE_INTERVAL) || 60000,
    // Tokens that are neither recently launched nor on the leaderboard refresh at this slower cadence
    METADATA_SLOW_REFRESH_INTERVAL: parseInt(process.env.METADATA_SLOW_REFRESH_INTERVAL) || 600000,
    ASDF_UPDATE_INTERVAL: parseInt(process.env.ASDF_UPDATE_INTERVAL) || 300000,

    // Pinata (IPFS)
    PINATA_JWT: process.env.PINATA_JWT?.trim() || null,
    PINATA_API_KEY: process.env.API_KEY?.trim() || null,
    PINATA_SECRET_KEY: process.env.SECRET_KEY?.trim() || null,

    // Redis
    REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

    // Clarifai (Content Safety)
    CLARIFAI_API_KEY: process.env.CLARIFAI_API_KEY,

    // Vanity Grinder
    VANITY_GRINDER_ENABLED: process.env.VANITY_GRINDER_ENABLED === 'true',
    VANITY_GRINDER_URL: process.env.VANITY_GRINDER_URL,
    VANITY_GRINDER_API_KEY: process.env.VANITY_GRINDER_API_KEY,
    VANITY_POOL_MIN_SIZE: 10,
    VANITY_POOL_REFILL_COUNT: 20,
    VANITY_POOL_CHECK_INTERVAL: 30000,

    // UI
    HEADER_IMAGE_URL: process.env.HEADER_IMAGE_URL || "https://placehold.co/60x60/d97706/ffffff?text=LOGO",

    // Security
    CORS_ORIGINS: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) || ['*'],
    // Reverse-proxy hops in front of the app (Render = 1). Used for req.ip and rate limiting.
    TRUST_PROXY_HOPS: parseInt(process.env.TRUST_PROXY_HOPS) || 1,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,

    // Data Storage
    get DISK_ROOT() {
        const fs = require('fs');
        return process.env.DISK_ROOT || (fs.existsSync('/var/data') ? '/var/data' : './data');
    }
};

module.exports = config;
