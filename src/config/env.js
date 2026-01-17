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
    VERSION: "v25.63-PAGS-SEPARATION",
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    // v25.49: Base URL where the BACKEND API is hosted (for OAuth callbacks)
    // Example: https://your-app.onrender.com (without trailing slash)
    BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
    // v25.49: Full URL where the FRONTEND is hosted (for redirects after OAuth)
    // Can be a full URL (https://alonisthe.dev/ignition) or a relative path (/ignition)
    // If on a different domain than BASE_URL, use full URL
    FRONTEND_URL: process.env.FRONTEND_URL || process.env.FRONTEND_PATH || '/',
    // Legacy alias for backwards compatibility
    FRONTEND_PATH: process.env.FRONTEND_PATH || '/',

    // Solana RPC
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    SOLANA_NETWORK: process.env.SOLANA_NETWORK || 'mainnet',
    // v25.47 STABILITY: RPC timeout to prevent hanging requests
    RPC_TIMEOUT_MS: parseInt(process.env.RPC_TIMEOUT_MS) || 30000,
    get RPC_URL() {
        if (process.env.RPC_URL) return process.env.RPC_URL;
        if (this.SOLANA_NETWORK === 'devnet') return "https://api.devnet.solana.com";
        return this.HELIUS_API_KEY
            ? `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`
            : "https://api.mainnet-beta.solana.com";
    },

    // Wallet
    DEV_WALLET_PRIVATE_KEY: process.env.DEV_WALLET_PRIVATE_KEY,

    // Fees & Transactions
    PRIORITY_FEE_MICRO_LAMPORTS: 100000,
    DEPLOYMENT_FEE_SOL: 0.02,
    FEE_THRESHOLD_SOL: 0.05,  // v17.0: Lowered to 0.05 SOL for fee collection
    AIRDROP_THRESHOLD_SOL: 1.0, // v17.0: Minimum 1 SOL to trigger airdrop distribution
    AIRDROP_MIN_VOLUME_USD: 100, // v18.0: Minimum 24hr volume for airdrop eligibility

    // Update Intervals (ms)
    FEE_COLLECTION_INTERVAL: 150000, // v25.13: Rewards claim every 2.5 minutes
    AIRDROP_INTERVAL: 900000, // v25.13: Airdrop processing every 15 minutes
    HOLDER_UPDATE_INTERVAL: parseInt(process.env.HOLDER_UPDATE_INTERVAL) || 300000, // v25.13: 5 minutes
    METADATA_PRICE_INTERVAL: 60000, // v25.13: Price updates for top tokens every 1 minute
    METADATA_FULL_INTERVAL: 300000, // v25.13: Full price updates for all tokens every 5 minutes
    ASDF_UPDATE_INTERVAL: 300000, // v25.13: 5 minutes

    // Pinata (IPFS)
    PINATA_JWT: process.env.PINATA_JWT?.trim() || null,
    PINATA_API_KEY: process.env.API_KEY?.trim() || null,
    PINATA_SECRET_KEY: process.env.SECRET_KEY?.trim() || null,

    // Redis
    REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

    // PostgreSQL (v13.0 - Render Database)
    // SCALABILITY FIX: Increased default pool size for better concurrency
    DATABASE_URL: process.env.DATABASE_URL || null,
    DB_POOL_MIN: parseInt(process.env.DB_POOL_MIN) || 5,   // Increased from 2
    DB_POOL_MAX: parseInt(process.env.DB_POOL_MAX) || 25,  // Increased from 10
    DB_IDLE_TIMEOUT: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
    DB_CONNECTION_TIMEOUT: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 10000, // Increased from 5000
    // v24.0: SSL configuration options
    // DB_SSL_MODE: 'disable', 'require', 'verify-ca', 'verify-full'
    DB_SSL_MODE: process.env.DB_SSL_MODE || 'require',
    DB_SSL_ENABLED: process.env.DB_SSL_ENABLED === 'true',
    DB_SSL_CA_PATH: process.env.DB_SSL_CA_PATH || null,
    DB_SSL_CA: process.env.DB_SSL_CA || null, // CA certificate as env var

    // Clarifai (Content Safety) - DEPRECATED in v25.0, replaced by Cloudflare Images
    CLARIFAI_API_KEY: process.env.CLARIFAI_API_KEY,

    // v25.0: Cloudflare Images (Content-Moderated Image Hosting)
    // Images are uploaded directly to Cloudflare, which handles moderation
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_ACCOUNT_HASH: process.env.CLOUDFLARE_ACCOUNT_HASH, // For imagedelivery.net URLs
    CLOUDFLARE_IMAGES_TOKEN: process.env.CLOUDFLARE_IMAGES_TOKEN,

    // Vanity Grinder
    VANITY_GRINDER_ENABLED: process.env.VANITY_GRINDER_ENABLED === 'true',
    VANITY_GRINDER_URL: process.env.VANITY_GRINDER_URL,
    VANITY_GRINDER_API_KEY: process.env.VANITY_GRINDER_API_KEY,
    VANITY_POOL_MIN_SIZE: 10,
    VANITY_POOL_REFILL_COUNT: 20,
    VANITY_POOL_CHECK_INTERVAL: 30000,

    // Twitter OAuth 1.0a (for bot posting)
    TWITTER_API_KEY: process.env.TWITTER_API_KEY,
    TWITTER_API_SECRET: process.env.TWITTER_API_SECRET,
    TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
    TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET,
    TWITTER_USERNAME: process.env.TWITTER_USERNAME, // v25.22: Fallback for tweet URLs
    // v25.47: Twitter OAuth 2.0 (for PAGS user authentication)
    // Get these from Twitter Developer Portal > Your App > Keys and tokens > OAuth 2.0 Client ID and Client Secret
    // If not set, falls back to TWITTER_API_KEY/SECRET (works if app has OAuth 2.0 enabled with same credentials)
    TWITTER_OAUTH2_CLIENT_ID: process.env.TWITTER_OAUTH2_CLIENT_ID || process.env.TWITTER_APP_KEY || process.env.TWITTER_API_KEY,
    TWITTER_OAUTH2_CLIENT_SECRET: process.env.TWITTER_OAUTH2_CLIENT_SECRET || process.env.TWITTER_APP_SECRET || process.env.TWITTER_API_SECRET,

    // v25.38: Claude AI for KOTH Selection
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    KOTH_AI_ENABLED: process.env.KOTH_AI_ENABLED !== 'false', // Enabled by default if API key exists

    // PAGS (Pay-to-Twitter/X) Configuration
    PAGS_ENABLED: process.env.PAGS_ENABLED !== 'false', // Enabled by default
    PAGS_WALLET: process.env.PAGS_WALLET, // Public key of wallet that holds PAGS fees before claims
    PAGS_WALLET_PRIVATE_KEY: process.env.PAGS_WALLET_PRIVATE_KEY, // Base58 private key for signing claim transactions
    PAGS_MIN_CLAIM_SOL: parseFloat(process.env.PAGS_MIN_CLAIM_SOL) || 0.01, // Minimum claim amount
    // SECURITY: Session secret MUST be set in production
    PAGS_SESSION_SECRET: (() => {
        const secret = process.env.PAGS_SESSION_SECRET;
        if (!secret && process.env.NODE_ENV === 'production') {
            console.error('FATAL: PAGS_SESSION_SECRET must be set in production');
            process.exit(1);
        }
        return secret || 'pags-session-secret-dev-only';
    })(),
    TWITTER_OAUTH_CALLBACK_URL: process.env.TWITTER_OAUTH_CALLBACK_URL || '/api/auth/twitter/callback',

    // UI
    HEADER_IMAGE_URL: process.env.HEADER_IMAGE_URL || "https://placehold.co/60x60/d97706/ffffff?text=LOGO",

    // Security
    CORS_ORIGINS: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) || ['*'],
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,

    // Data Storage
    get DISK_ROOT() {
        const fs = require('fs');
        return process.env.DISK_ROOT || (fs.existsSync('/var/data') ? '/var/data' : './data');
    }
};

module.exports = config;
