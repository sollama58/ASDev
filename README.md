# ASDev (Ignition)

A Solana token launcher built around Pump.fun, wrapped in a self-sustaining
fee-sharing ecosystem: every registered token routes a share of its trading
fees back to a platform pool, which is redistributed as SOL airdrops to that
token's holders on a fixed schedule — no claiming, no staking, just holding.

Beyond launching tokens, the platform runs three fee-sharing programs on top
of the same holder-tracking/airdrop engine:

- **Robinhood** — external Pump.fun tokens that opt into fee sharing without
  being launched here. Verified entirely on-chain at registration time.
- **PAGS** ("Pay-to-Twitter/X") — token creators split fees with Twitter/X
  accounts, who link a wallet via OAuth and claim their share.
- **Community Chest** — a standalone airdrop-pool sub-site/brand (own static
  page and admin panel) built on the same backend.

Two tracked tokens (`ASDF`, `ANSEM`) give their top holders a 2× multiplier
on airdrop weight, stacking to 4× if you hold both.

> Note: the vanity address grinder (mint addresses ending in `ASDF`) referenced
> in older docs has been decommissioned — `services/vanity.js` now just
> generates a random keypair. Mints are no longer vanity-ground.

## Architecture

```
src/
├── index.js            # Main entry point — Express API + WebSocket + background tasks
├── worker.js            # Same background tasks, no HTTP server (SERVER_MODE=worker)
├── config/
│   ├── env.js            # All environment variables / config, validated on boot
│   └── constants.js       # Program IDs, wallet addresses, token mints (incl. ASDF/ANSEM)
├── services/             # Integrations & shared logic used by routes and tasks
│   ├── postgres.js         # The only live database (services/database.js is dead SQLite code)
│   ├── redis.js            # Caching, BullMQ queues, cross-process state, distributed locks
│   ├── solana.js / pump.js / mintExtractor.js   # RPC, Pump.fun program calls, fee-vault discovery
│   ├── pags.js / pagsTwitterAuth.js             # PAGS Twitter fee-sharing subsystem
│   ├── twitter.js, pinata.js, imageUtils.js, moderation.js, claudeKoth.js, ...
│   └── mutex.js, circuitBreaker.js, sanitizer.js, signatureVerifier.js, logger.js
├── routes/               # Express API (mounted under /api — see API section below)
│   ├── tokens.js           # Listing, leaderboard, registration, holder lookups, token admin
│   ├── health.js           # /api/health + a large set of admin debug/diagnostic endpoints
│   ├── pags.js             # PAGS OAuth, registration, claims, admin
│   ├── deploy.js            # Token deployment queue
│   └── solana.js            # Address validation, blockhash, balance
├── tasks/                # Background jobs, orchestrated by tasks/index.js
│   ├── holderScanner.js     # Core points/airdrop-eligibility engine (on-chain holder scans)
│   ├── flywheel.js          # Fee collection + SOL airdrop distribution (central + per-token pools)
│   ├── robinhoodScanner.js  # Partner-token discovery, verification, holder tracking
│   ├── metadataUpdater.js   # Price/image refresh (DexScreener → GeckoTerminal → Helius)
│   ├── asdfSync.js          # Top 100 ASDF holder sync (2× multiplier)
│   ├── pagsFeeScanner.js    # PAGS on-chain fee scanning
│   ├── pagsClaimProcessor.js# PAGS claim processing (currently disabled in tasks/index.js)
│   └── workers.js           # BullMQ worker wrappers around the above
└── utils/                # Small shared helpers (bigint math, etc.)

scripts/                 # One-off/maintenance scripts (see Scripts section)

# Frontend — static HTML, no build step, each file is self-contained
asdev_frontend.html       # Main platform UI (launches, leaderboard, Robinhood, PAGS, wallet connect)
admin_panel.html          # Main platform admin console
community-chest/          # Standalone airdrop-pool sub-site (own render.yaml Blueprint)
├── index.html
├── admin/index.html
└── render.yaml
asdev_intro_modal.html    # Small promo modal snippet, meant to be pasted into other pages
```

All frontend pages talk to the backend via a hardcoded `BACKEND_URL` constant
near the top of each file's `<script>` — update that if you point them at a
different deployment.

## Data & background jobs

- **PostgreSQL** is the system of record (tokens, holders, points, PAGS
  data, logs). `DATABASE_URL` is required — the server will not start
  without it.
- **Redis** backs BullMQ job queues, response caching, distributed mutexes,
  and cross-process global state (so the API process and worker process(es)
  agree on the same numbers).
- Background tasks run on independent intervals — holder scans and price
  updates every few minutes, fee collection every 2.5 minutes, airdrop
  distribution every 15 minutes, Robinhood/metadata sweeps every 10 minutes.
  They run inline in `index.js` (default) or can be split onto a dedicated
  process via `src/worker.js` (`SERVER_MODE=worker`) so heavy scanning
  doesn't compete with API traffic.

## Requirements

- Node.js 18+
- PostgreSQL (a `DATABASE_URL` connection string)
- Redis
- A funded Solana wallet (base58 private key) for the platform/deployment wallet

## Setup

```bash
git clone <this-repo>
cd ASDev

npm install
cp .env.example .env
# edit .env — at minimum set DEV_WALLET_PRIVATE_KEY, DATABASE_URL, REDIS_URL

npm start
```

## Configuration

See `.env.example` for the full list with comments. The essentials:

```env
# Required
DEV_WALLET_PRIVATE_KEY=your-base58-private-key   # Platform wallet
DATABASE_URL=postgres://user:pass@host:5432/db    # PostgreSQL connection string
REDIS_URL=redis://127.0.0.1:6379

# Solana RPC (mainnet by default; set HELIUS_API_KEY to route through Helius)
SOLANA_NETWORK=mainnet
HELIUS_API_KEY=your-helius-api-key
# Or override the RPC endpoint entirely:
# RPC_URL=https://your-custom-rpc.com

# Security
CORS_ORIGINS=*                # Comma-separated allowed origins
ADMIN_API_KEY=your-admin-key  # Required to use any /api/admin/* or /api/debug/* endpoint

# IPFS metadata storage
PINATA_JWT=your-pinata-jwt

# Optional feature areas — see .env.example for the full set
# Twitter posting: TWITTER_API_KEY / TWITTER_API_SECRET / TWITTER_ACCESS_TOKEN / TWITTER_ACCESS_SECRET
# PAGS (Twitter fee-sharing): PAGS_WALLET, PAGS_WALLET_PRIVATE_KEY, TWITTER_OAUTH2_CLIENT_ID/SECRET, PAGS_SESSION_SECRET
# Content moderation: CLARIFAI_API_KEY
# AI-selected "King of the Hill": ANTHROPIC_API_KEY
```

## Running

```bash
npm start              # API server + WebSocket + background tasks in one process
npm run dev             # Same, with --watch for local development

# Split background tasks onto a separate process (e.g. a second Render service)
SERVER_MODE=worker node src/worker.js
SERVER_MODE=worker WORKER_TASKS=holders,metadata node src/worker.js   # subset of tasks
```

## Scripts

| Script | What it does |
|---|---|
| `npm run migrate` | One-time SQLite → PostgreSQL data migration |
| `npm run backfill` | Discover tokens the platform receives fees from, by scanning on-chain vault transaction history (`--dry-run` supported) |
| `node scripts/show-points.js` | Dump current point distribution and eligibility |
| `node scripts/test-airdrop.js` | Simulate/test the point → airdrop distribution flow |
| `node scripts/debugVaultScan.js` | Diagnostic: inspect raw vault transactions and mint extraction |

## API

The full API lives under `/api` (see `src/routes/*.js`) — there are 100+
endpoints in total, including a large admin/debug surface gated behind
`ADMIN_API_KEY`. Highlights:

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Wallet balance, pending fees, pool sizes, lifetime stats |
| `GET /api/version` | Server version string |
| `GET /api/services-status` | Live check of DB / Redis / Solana RPC |
| `GET /api/all-launches` | All launched tokens (paginated) |
| `GET /api/leaderboard` | Registered/Robinhood token leaderboard |
| `GET /api/recent-launches` | Recent-launches ticker feed |
| `GET /api/token-holders/:mint` | Top holders for a token |
| `GET /api/check-holder?userPubkey=…` | A wallet's points + expected airdrop |
| `GET /api/user-holdings?userPubkey=…` | Per-token holdings breakdown for a wallet |
| `GET /api/all-eligible-users` | All wallets with a pending airdrop |
| `POST /api/prepare-metadata` | Upload token metadata/image to IPFS |
| `POST /api/deploy` | Queue a token deployment |
| `GET /api/job-status/:id` | Poll a deployment job |
| `POST /api/register-token` / `POST /api/reregister-token` | Register a Robinhood partner token (verified on-chain) |
| `GET /api/robinhood/*` | Robinhood token/holder endpoints |
| `POST /api/pags/register`, `GET /api/pags/lookup/:username`, `POST /api/pags/claim` | PAGS registration, lookup, claiming |
| `GET /api/auth/twitter`, `GET /api/auth/twitter/callback` | PAGS Twitter OAuth |
| `GET /api/admin/*`, `GET /api/debug/*` | Operational/admin endpoints (trigger scans, view logs, manage tokens/announcements, simulate airdrops, etc.) — requires `x-admin-key` header |

## Security

- Rate limiting: 120 req/min globally on `/api`, 5/min on `/api/deploy`
- `helmet` security headers + configurable CORS allowlist (`CORS_ORIGINS`)
- All admin/debug endpoints require a timing-safe-compared `ADMIN_API_KEY`
  (disabled entirely — returns 403 — if the key isn't set)
- Solana address validation on all pubkey inputs; signature verification on
  wallet-authenticated actions (PAGS link/claim, Robinhood re-registration)
- Frontend output escaping (`esc()`/`escAttr()` helpers and/or DOMPurify,
  depending on the page) on any field that originates from user-settable
  token metadata (ticker, name), to prevent stored XSS

## Deployment

Runs on Render.com as multiple services from this one repo:
- The API/worker process (`src/index.js` / `src/worker.js`)
- Separate static-site Blueprints for the frontends — see
  `community-chest/render.yaml` for that sub-site's Blueprint

## Troubleshooting

**Server won't start?**
- Check `DATABASE_URL` — the server exits immediately without a working Postgres connection
- Check `DEV_WALLET_PRIVATE_KEY` is set and valid base58
- Check Redis is reachable: `redis-cli -u "$REDIS_URL" ping`
- Check the port isn't already in use

**Admin endpoints all return 403/401?**
- `ADMIN_API_KEY` isn't set, or the `x-admin-key` header doesn't match it

**Background tasks not running / stale data?**
- Confirm you're not running with `SERVER_MODE=worker` on the API instance
  (and vice versa) without a worker instance actually running the tasks

## License

Do whatever you want with it.
