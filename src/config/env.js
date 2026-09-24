/**
 * Environment Configuration
 * Loads and validates environment variables
 */
const fs = require('fs');
require('dotenv').config();

// v30.4: a .env file in a production checkout means secrets were committed or copied into the
// deployed image. dotenv never overrides real environment variables, so it changes nothing
// here -- but it should not exist, and the operator should know.
if (process.env.NODE_ENV === 'production' && fs.existsSync('.env')) {
    console.warn('[Security] A .env file is present in a production deployment. Secrets belong in the platform\'s secret store, not on disk in the image.');
}

// Environment validation
//
// v28.1: the grinder service signs nothing and touches no wallet — it only reads and writes
// the vanity mint pool in Postgres. Requiring the platform's hot wallet key there would mean
// copying it onto an extra always-on instance purely to satisfy a startup check, widening
// the blast radius of that key for no benefit. So the grinder is exempt.
//
// v30.4: the wallet can come from an env var, a key file or a remote signer (services/signer.js
// builds it). Check here only that one of them is configured, so a bad deploy dies at boot with
// a message instead of at the first payout.
const IS_GRINDER = process.env.SERVER_MODE === 'grinder';
// v30.4: the API process may run with no key at all (it then verifies payments and reports the
// wallet address from constants, while the worker service does every signing job). Whether it
// does is decided in src/index.js by whether a key is configured; here it just is not an error.
const IS_API_ONLY = process.env.SERVER_MODE === 'api-only';
const WALLET_SIGNER = String(process.env.WALLET_SIGNER || 'local').toLowerCase();
// WALLET_CHECK=skip is set by scripts/wallet-key.js, which explains a missing key itself.
if (!IS_GRINDER && process.env.WALLET_CHECK !== 'skip') {
    let problem = null;
    if (WALLET_SIGNER === 'vault') {
        const missing = ['VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_TRANSIT_KEY']
            .filter(v => !process.env[v] && !process.env[`${v}_FILE`]);
        if (missing.length) problem = `WALLET_SIGNER=vault needs ${missing.join(', ')}`;
    } else if (WALLET_SIGNER === 'local') {
        if (!process.env.DEV_WALLET_KEY_FILE && !process.env.DEV_WALLET_PRIVATE_KEY && !IS_API_ONLY) {
            problem = 'set DEV_WALLET_KEY_FILE (a secret file) or DEV_WALLET_PRIVATE_KEY, or WALLET_SIGNER=vault';
        }
    } else {
        problem = `WALLET_SIGNER="${process.env.WALLET_SIGNER}" is not supported (local, vault)`;
    }
    if (problem) {
        console.error(`FATAL: No platform wallet configured: ${problem}. See docs/KEY-MANAGEMENT.md.`);
        process.exit(1);
    }
}

const config = {
    // Server
    VERSION: "v29.0-SHITPAD",
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    // v25.49: Base URL where the BACKEND API is hosted (for OAuth callbacks)
    // Example: https://your-app.onrender.com (without trailing slash)
    BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
    // v25.49: Full URL where the FRONTEND is hosted (for redirects after OAuth)
    // Can be a full URL (https://shitpad.example) or a relative path (/)
    // If on a different domain than BASE_URL, use full URL
    FRONTEND_URL: process.env.FRONTEND_URL || process.env.FRONTEND_PATH || '/',
    // Legacy alias for backwards compatibility
    FRONTEND_PATH: process.env.FRONTEND_PATH || '/',

    // Solana RPC
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    SOLANA_NETWORK: process.env.SOLANA_NETWORK || 'mainnet',
    // v25.47 STABILITY: RPC timeout to prevent hanging requests
    RPC_TIMEOUT_MS: parseInt(process.env.RPC_TIMEOUT_MS) || 30000,
    // v30.4: captured once; a custom RPC URL usually embeds an API key, so it is scrubbed below.
    RPC_URL_OVERRIDE: process.env.RPC_URL || null,
    get RPC_URL() {
        if (this.RPC_URL_OVERRIDE) return this.RPC_URL_OVERRIDE;
        if (this.SOLANA_NETWORK === 'devnet') return "https://api.devnet.solana.com";
        return this.HELIUS_API_KEY
            ? `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`
            : "https://api.mainnet-beta.solana.com";
    },

    // Wallet. The key itself is never on this object: services/signer.js builds the signer at
    // boot and the entrypoints hand it around as `deps.signer`.
    WALLET_SIGNER,
    // v30.4: refuse to start in production when the signer's public key is not the platform
    // wallet in constants.js. Set to 'true' only while deliberately rotating to a new wallet.
    ALLOW_WALLET_MISMATCH: process.env.ALLOW_WALLET_MISMATCH === 'true',

    // v30.4: hot-wallet exposure cap. When TREASURY_WALLET is set, the flywheel moves anything
    // the hot wallet holds beyond its obligations (the holder pools, the accrued platform cut)
    // plus HOT_WALLET_FLOAT_SOL of operating float to that address, so a leaked key can only
    // ever take the float and the pools of the moment, never months of accumulated fees.
    // Unset = never sweep (today's behaviour).
    TREASURY_WALLET: process.env.TREASURY_WALLET?.trim() || null,
    HOT_WALLET_FLOAT_SOL: Math.max(0.1, parseFloat(process.env.HOT_WALLET_FLOAT_SOL) || 1.0),
    HOT_WALLET_SWEEP_MIN_SOL: Math.max(0.01, parseFloat(process.env.HOT_WALLET_SWEEP_MIN_SOL) || 0.25),

    // v30.4: signing policy (services/signingPolicy.js). enforce | warn | off. Outflow caps
    // apply to SOL leaving the wallet for anything but the treasury and fee wallets; a
    // refused payout batch fails and retries next cycle, so size the hourly cap at roughly
    // twice the busiest hour of payouts you expect.
    SIGNING_POLICY: ['enforce', 'warn', 'off'].includes(String(process.env.SIGNING_POLICY || '').toLowerCase())
        ? String(process.env.SIGNING_POLICY).toLowerCase() : 'enforce',
    SIGNING_MAX_OUTFLOW_SOL_PER_TX: parseFloat(process.env.SIGNING_MAX_OUTFLOW_SOL_PER_TX) >= 0 ? parseFloat(process.env.SIGNING_MAX_OUTFLOW_SOL_PER_TX) : 20,
    SIGNING_MAX_OUTFLOW_SOL_PER_HOUR: parseFloat(process.env.SIGNING_MAX_OUTFLOW_SOL_PER_HOUR) >= 0 ? parseFloat(process.env.SIGNING_MAX_OUTFLOW_SOL_PER_HOUR) : 60,
    SIGNING_MAX_BUY_SOL: parseFloat(process.env.SIGNING_MAX_BUY_SOL) >= 0 ? parseFloat(process.env.SIGNING_MAX_BUY_SOL) : 0.5,
    SIGNING_EXTRA_PROGRAMS: process.env.SIGNING_EXTRA_PROGRAMS || '',
    SIGNING_EXEMPT_DESTINATIONS: process.env.SIGNING_EXEMPT_DESTINATIONS || '',

    // Fees & Transactions
    PRIORITY_FEE_MICRO_LAMPORTS: 100000,
    DEPLOYMENT_FEE_SOL: 0.02,
    FEE_THRESHOLD_SOL: 0.05,  // v17.0: Lowered to 0.05 SOL for fee collection
    AIRDROP_THRESHOLD_SOL: 1.0, // v17.0: Minimum 1 SOL to trigger airdrop distribution
    AIRDROP_MIN_VOLUME_USD: 250, // v18.0: Minimum 24hr volume for airdrop eligibility (v27.5: raised from 100 to shrink the RPC-scanned token set)

    // v29.1: The single definition of the per-token airdrop threshold. This used to be read
    // straight from process.env at four separate call sites with three different fallbacks
    // (1.0 in the distributor, 0.05 in the admin simulator and in the startup log), so the
    // simulator reported tokens as "would trigger" at twenty times below the amount the
    // distributor actually requires. Everything now reads this one value.
    TOKEN_AIRDROP_THRESHOLD_SOL: parseFloat(process.env.TOKEN_AIRDROP_THRESHOLD_SOL) || 1.0,

    // v29.1: Anti-bundling decoy launches, fired before each real launch to obscure it.
    // Each decoy is a full create plus buy, and the account rent a create allocates is NOT
    // recovered by the sell-and-close that follows, so this is a real per-launch cost set
    // against a DEPLOYMENT_FEE_SOL of 0.02. It was previously a hardcoded random 1 to 5,
    // which made that cost invisible and unbounded. Set ANTI_BUNDLE_MAX to 0 to disable.
    // v30.2: default 0-1 decoys (was 1-5). Each costs non-recoverable create rent against a
    // 0.02 SOL fee, so five decoys could cost several times what the launch earned.
    ANTI_BUNDLE_MIN: Math.max(0, parseInt(process.env.ANTI_BUNDLE_MIN ?? '0', 10) || 0),
    ANTI_BUNDLE_MAX: Math.max(0, parseInt(process.env.ANTI_BUNDLE_MAX ?? '1', 10) || 0),

    // v30.3: The ASDF holder bonus. Wallets ranked in the top ASDF_BONUS_TOP_N ASDF holders
    // have their effective balance multiplied by ASDF_BONUS_MULTIPLIER in every airdrop
    // (per-token pools and the central pool). It is the only bonus: the ANSEM bonus that
    // used to sit beside it, stacking to 4x, was removed.
    ASDF_BONUS_TOP_N: Math.max(1, parseInt(process.env.ASDF_BONUS_TOP_N, 10) || 250),
    ASDF_BONUS_MULTIPLIER: 2,

    // v29.1: A payment older than this cannot be redeemed for a launch. Without a bound,
    // any historical transfer to the platform wallet of at least the fee could be handed
    // to /api/deploy once for a free launch.
    PAYMENT_MAX_AGE_SECONDS: parseInt(process.env.PAYMENT_MAX_AGE_SECONDS, 10) || 3600,

    // v29.3: /api/prepare-metadata fetches the supplied image once to confirm it exists and is
    // really an image, before any token is minted against it. Metadata is immutable, so a dead
    // or mistyped link caught here is the difference between a clear error and a token with a
    // permanently broken image that the creator has already paid for.
    IMAGE_MAX_BYTES: parseInt(process.env.IMAGE_MAX_BYTES, 10) || 10 * 1024 * 1024,
    IMAGE_FETCH_TIMEOUT_MS: parseInt(process.env.IMAGE_FETCH_TIMEOUT_MS, 10) || 8000,

    // =====================================================
    // VANITY MINT GRINDER (v28.1)
    // =====================================================
    // Pre-grinds mint keypairs whose addresses end in VANITY_SUFFIX, so launched tokens carry
    // a branded contract address. Runs only in the dedicated grinder service
    // (SERVER_MODE=grinder); the API and worker processes never grind, they only consume the
    // pool, and fall back to a random mint whenever it is empty.
    //
    // Cost, measured at ~10,500 keys/sec/core (Node's OpenSSL-backed ed25519):
    //   exact-case "shit"   58^4 = 11,316,496 expected attempts  ~18 min/address/core
    //   any case (8 forms)   ~1,414,562 expected attempts          ~2.2 min/address/core
    // base58 has no uppercase I and no lowercase l, so only 8 of the 16 case permutations of
    // "shit" can exist in an address at all.
    VANITY_GRINDER_ENABLED: process.env.VANITY_GRINDER_ENABLED === 'true',
    VANITY_SUFFIX: process.env.VANITY_SUFFIX || 'shit',
    // Accept any representable capitalisation. Exact lowercase is 8x the work per address.
    VANITY_CASE_INSENSITIVE: process.env.VANITY_CASE_INSENSITIVE !== 'false',
    VANITY_POOL_TARGET: parseInt(process.env.VANITY_POOL_TARGET) || 50,
    // Grinding restarts once the pool falls to this depth. The gap between this and the
    // target is what stops the workers flapping on every single launch.
    VANITY_POOL_LOW_WATER: parseInt(process.env.VANITY_POOL_LOW_WATER) || 40,
    // Defaults to the instance's cores, capped at 4. Inside a container os.cpus() reports the
    // HOST's cores, not the container's allotment — on a 0.5-CPU Render plan it can say 32 —
    // and spawning that many threads would just thrash. Set the env var explicitly to go
    // higher on a plan that really has the cores.
    VANITY_GRINDER_THREADS: parseInt(process.env.VANITY_GRINDER_THREADS) || Math.min(require('os').cpus().length, 4),
    // Fraction of wall-clock each worker spends grinding; 1 = flat out. Lower it only if the
    // grinder shares an instance with something latency-sensitive.
    VANITY_DUTY_CYCLE: parseFloat(process.env.VANITY_DUTY_CYCLE) || 1,
    // How often the grinder re-reads pool depth. It shares no channel with the API, so this
    // poll is how it notices addresses being consumed.
    VANITY_POOL_CHECK_INTERVAL: parseInt(process.env.VANITY_POOL_CHECK_INTERVAL) || 30000,

    // v29.1: How long an address may sit in the 'claimed' state before it is treated as
    // stranded and returned to the pool. A launch claims an address, then marks it used or
    // releases it; a crash in between left it claimed forever, slowly leaking ground
    // addresses. Comfortably longer than any real launch, so a live launch is never reaped.
    VANITY_CLAIM_TIMEOUT_MS: parseInt(process.env.VANITY_CLAIM_TIMEOUT_MS) || 15 * 60 * 1000,
    VANITY_GRINDER_LOG_INTERVAL: parseInt(process.env.VANITY_GRINDER_LOG_INTERVAL) || 60000,

    // =====================================================
    // UPDATE INTERVALS (ms) - v25.64: Timing Reference
    // =====================================================
    // Task                     | Interval   | Initial Delay | Notes
    // -------------------------|------------|---------------|------------------------
    // WebSocket Broadcast      | 30s        | 2s            | Frontend state updates
    // Top Token Prices         | 60s        | 10s           | Top 10 by market cap
    // Fee Collection           | 2.5min     | 30s           | Creator reward claims
    // ASDF Top 100 Sync        | 2min       | 0s            | 2x multiplier holders
    // Holder Scanner           | 5min       | 20s           | Points recalculation
    // All Token Prices         | 5min       | 45s           | Full metadata update
    // Missing Images           | 10min      | 90s           | Fill missing images
    // Redis Cleanup            | 10min      | immediate     | Memory management
    // Airdrop Distribution     | 15min      | 2min          | SOL distribution
    // KOTH Evaluation          | 30min      | varies        | King selection
    // =====================================================
    // v30.2: 10 minutes (was 2.5). Fees only need collecting once they pass FEE_THRESHOLD_SOL;
    // surveying four times as often just spent RPC calls.
    FEE_COLLECTION_INTERVAL: parseInt(process.env.FEE_COLLECTION_INTERVAL) || 600000,
    AIRDROP_INTERVAL: 900000, // v25.13: Airdrop processing every 15 minutes
    // v30.2: 10 minutes (was 5). Tokens near a payout are still rescanned every run, and every
    // airdrop force-rescans the tokens it pays; the rest only feed UI estimates.
    HOLDER_UPDATE_INTERVAL: parseInt(process.env.HOLDER_UPDATE_INTERVAL) || 600000,
    METADATA_PRICE_INTERVAL: 60000, // v25.13: Price updates for top tokens every 1 minute
    METADATA_FULL_INTERVAL: 300000, // v25.13: Full price updates for all tokens every 5 minutes
    ASDF_UPDATE_INTERVAL: 300000, // v25.13: 5 minutes
    // v25.64: WebSocket broadcast interval (how often frontend receives updates)
    // Lower = more responsive but more DB queries, Higher = less load but slower updates
    WS_BROADCAST_INTERVAL: parseInt(process.env.WS_BROADCAST_INTERVAL) || 30000, // 30 seconds default (was 10s)

    // Pinata (IPFS)
    PINATA_JWT: process.env.PINATA_JWT?.trim() || null,

    // Redis
    REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

    // PostgreSQL (v13.0 - Render Database)
    // SCALABILITY FIX: Increased default pool size for better concurrency
    DATABASE_URL: process.env.DATABASE_URL || null,
    // v30.2: 1-10 per process (was 5-50). Three services share one Postgres; at 50 each they
    // could together exceed the database's connection limit, and the work here is a handful
    // of concurrent queries, not hundreds. Raise per service with DB_POOL_MAX if needed.
    DB_POOL_MIN: parseInt(process.env.DB_POOL_MIN) || 1,
    DB_POOL_MAX: parseInt(process.env.DB_POOL_MAX) || 10,
    DB_IDLE_TIMEOUT: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
    DB_CONNECTION_TIMEOUT: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 10000, // Increased from 5000
    // v24.0: SSL configuration options
    // DB_SSL_MODE: 'disable', 'require', 'verify-ca', 'verify-full'
    DB_SSL_MODE: process.env.DB_SSL_MODE || 'require',
    DB_SSL_ENABLED: process.env.DB_SSL_ENABLED === 'true',
    DB_SSL_CA_PATH: process.env.DB_SSL_CA_PATH || null,
    DB_SSL_CA: process.env.DB_SSL_CA || null, // CA certificate as env var

    // Twitter OAuth 1.0a (for bot posting)
    TWITTER_APP_KEY: process.env.TWITTER_APP_KEY,
    TWITTER_APP_SECRET: process.env.TWITTER_APP_SECRET,
    TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
    TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET,
    TWITTER_USERNAME: process.env.TWITTER_USERNAME, // v25.22: Fallback for tweet URLs
    // v25.38: Claude AI for KOTH Selection
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    KOTH_AI_ENABLED: process.env.KOTH_AI_ENABLED !== 'false', // Enabled by default if API key exists

    // UI
    HEADER_IMAGE_URL: process.env.HEADER_IMAGE_URL || "https://placehold.co/60x60/d97706/ffffff?text=LOGO",

    // Security
    CORS_ORIGINS: process.env.CORS_ORIGINS?.split(',').map(s => s.trim().replace(/\/+$/, '')) || ['*'],
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
    // v30.4: read here, not in services/vanitySecret.js, so it can be scrubbed below.
    VANITY_ENCRYPTION_KEY: process.env.VANITY_ENCRYPTION_KEY || null,

    // Data Storage
    get DISK_ROOT() {
        const fs = require('fs');
        return process.env.DISK_ROOT || (fs.existsSync('/var/data') ? '/var/data' : './data');
    }
};

// v30.4: every API secret is now on `config`, so remove it from the environment. After this
// line no route, task, dependency or child process can read a secret back out of process.env
// -- a debug endpoint that dumped the environment, or a compromised package that posted it
// home, would get nothing. The wallet key and its passphrase are scrubbed the same way by the
// entrypoint once services/signer.js has consumed them.
for (const k of [
    'ADMIN_API_KEY', 'PINATA_JWT', 'HELIUS_API_KEY', 'ANTHROPIC_API_KEY', 'VANITY_ENCRYPTION_KEY',
    'TWITTER_APP_KEY', 'TWITTER_APP_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET',
    'DATABASE_URL', 'REDIS_URL', 'RPC_URL', // connection strings carry credentials too
]) {
    delete process.env[k];
}
// Node's diagnostic reports (--report-on-fatalerror and friends) include the environment
// unless told otherwise. Nothing secret is left in it by now, but there is no reason to
// write it to disk either.
if (process.report && 'excludeEnv' in process.report) process.report.excludeEnv = true;

// Warn at startup if admin key not configured
if (!config.ADMIN_API_KEY) {
    console.warn('[Security] ADMIN_API_KEY not set — all admin endpoints will return 403. Set this env var to enable admin access.');
}

module.exports = config;
