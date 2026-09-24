# ShitPad

A Solana token launcher built around Pump.fun, wrapped in a self-sustaining
fee-sharing ecosystem: every token launched here routes a share of its trading
fees back to the platform, which is redistributed as SOL airdrops to that
token's holders on a fixed schedule — no claiming, no staking, just holding.
Tagline: "Token launchpads are shit."

Each time fees are claimed they split four ways:

| Share | Destination |
|-------|-------------|
| 50%   | that token's own holders |
| 25%   | the central pool, shared across every ShitPad token's holders |
| 24.5% | buyback & burn |
| 0.5%  | upkeep |

Tokens are minted with ShitPad already wired in as a fee recipient, so a
creator never configures fee sharing by hand. Where the grinder has one ready,
the contract address ends in `shit`.

The top 250 holders of `ASDF` receive a 2× multiplier on their airdrop weight
in every pool (`ASDF_BONUS_TOP_N` to change the cut-off).

> Note: the old vanity grinder (mint addresses ending in `ASDF`) was an external
> HTTP service and was decommissioned. It has been replaced by an in-repo
> grinder producing addresses ending in `shit` — see
> [Vanity mint grinder](#vanity-mint-grinder).

## Architecture

```
src/
├── index.js            # Main entry point — Express API + WebSocket + background tasks
├── worker.js            # Same background tasks, no HTTP server (SERVER_MODE=worker)
├── config/
│   ├── env.js            # All environment variables / config, validated on boot
│   └── constants.js       # Program IDs, wallet addresses, token mints (incl. ASDF)
├── services/             # Integrations & shared logic used by routes and tasks
│   ├── postgres.js         # The only database layer (PostgreSQL)
│   ├── redis.js            # Caching, BullMQ queues, cross-process state, distributed locks
│   ├── solana.js / pump.js / mintExtractor.js   # RPC, Pump.fun program calls, fee-vault discovery
│   ├── vanity.js / vanityGrinder.js / vanityWorker.js / vanitySecret.js  # Pre-ground mint pool
│   ├── twitter.js, pinata.js, imageUtils.js, moderation.js, claudeKoth.js, ...
│   └── mutex.js, circuitBreaker.js, sanitizer.js, signatureVerifier.js, logger.js
├── routes/               # Express API (mounted under /api — see API section below)
│   ├── tokens.js           # Listing, holder lookups, token admin
│   ├── health.js           # /api/health + a large set of admin debug/diagnostic endpoints
│   ├── deploy.js            # Token deployment queue
│   └── solana.js            # Address validation, blockhash, balance
├── tasks/                # Background jobs, orchestrated by tasks/index.js
│   ├── holderScanner.js     # Core points/airdrop-eligibility engine (on-chain holder scans)
│   ├── flywheel.js          # Fee collection + SOL airdrop distribution (central + per-token pools)
│   ├── metadataUpdater.js   # Price/image refresh (DexScreener → GeckoTerminal → Helius)
│   └── workers.js           # BullMQ worker wrappers around the above
└── utils/                # Small shared helpers (bigint math, etc.)

grinder.js               # Vanity mint grinder service entrypoint (SERVER_MODE=grinder)

scripts/                 # One-off/maintenance scripts (see Scripts section)

# Frontend — static HTML, no build step, each file is self-contained
shitpad/                  # The ShitPad site (own render.yaml Blueprint)
├── index.html            # Launcher, pool stats, token list, wallet lookup
├── admin/index.html      # Admin console
└── render.yaml
```

Each page reads its API origin from a single `<meta name="shitpad-backend">`
tag near the top of the file — change that one line to point the site at a
different deployment. The API also serves `shitpad/index.html` at `/` and the
admin console at `/admin`, for single-service deployments.

## Data & background jobs

- **PostgreSQL** is the system of record (tokens, holders, points,
  reservations, logs). `DATABASE_URL` is required — the server will not start
  without it.
- **Redis** backs BullMQ job queues, response caching, distributed mutexes,
  and cross-process global state (so the API process and worker process(es)
  agree on the same numbers).
- Background tasks run on independent intervals — holder scans and price
  updates every few minutes, fee collection every 2.5 minutes, airdrop
  distribution every 15 minutes, metadata sweeps every 10 minutes.
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
# edit .env — at minimum set the wallet key (see "The platform wallet key"), DATABASE_URL, REDIS_URL

npm start
```

## Configuration

See `.env.example` for the full list with comments. The essentials:

```env
# Required
DEV_WALLET_PRIVATE_KEY=your-base58-private-key   # Platform wallet -- or DEV_WALLET_KEY_FILE / WALLET_SIGNER=vault, see below
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
| `node scripts/show-points.js` | Dump current point distribution and eligibility |
| `node scripts/test-airdrop.js` | Simulate/test the point → airdrop distribution flow |
| `node scripts/wallet-key.js encrypt\|pubkey\|verify` | Encrypt the wallet key for a secret file; show or verify the configured signer's wallet |

## API

The full API lives under `/api` (see `src/routes/*.js`) — there are 100+
endpoints in total, including a large admin/debug surface gated behind
`ADMIN_API_KEY`. Highlights:

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Wallet balance, pending fees, pool sizes, lifetime stats |
| `GET /api/version` | Server version string |
| `GET /api/services-status` | Live check of DB / Redis / Solana RPC (admin) |
| `GET /api/all-launches` | All launched tokens (paginated) |
| `GET /api/recent-launches` | Recent-launches ticker feed |
| `GET /api/token-holders/:mint` | Top holders for a token |
| `GET /api/check-holder?userPubkey=…` | A wallet's expected airdrop, split by pool, and whether the ASDF bonus applies |
| `GET /api/user-airdrop-stats/:pubkey` | What a wallet has received so far, with its rank |
| `GET /api/airdrop-logs` | The 30 most recent payouts (amount, wallets, pool, tx) |
| `GET /api/user-holdings?userPubkey=…` | Per-token holdings breakdown for a wallet |
| `GET /api/all-eligible-users` | All wallets with a pending airdrop |
| `POST /api/prepare-metadata` | Validate a launch (image reachable and an image) before the user pays; pins nothing |
| `POST /api/deploy` | Verify the fee payment and queue a launch; the launch job pins the metadata |
| `GET /api/job-status/:id` | Poll a deployment job |
| `GET /api/admin/*`, `GET /api/debug/*` | Operational/admin endpoints (trigger scans, view logs, manage tokens/announcements, simulate airdrops, etc.) — requires `x-admin-key` header |

## The platform wallet key

The platform wallet signs launches, fee claims and payouts unattended, so its key is the
most sensitive thing in the deployment. `src/services/signer.js` is the only code that
touches it; the rest of the codebase gets a *signer* that can sign and reveal its public key
and nothing else. The key (and every other API secret) is deleted from `process.env` at
boot, a wrong key refuses to start in production, and builds run with npm lifecycle scripts
disabled.

Where to keep it, weakest to strongest — details, setup steps and the rotation procedure in
[docs/KEY-MANAGEMENT.md](docs/KEY-MANAGEMENT.md):

| Option | Env | What a dashboard reader gets |
|---|---|---|
| Env var | `DEV_WALLET_PRIVATE_KEY` | the key |
| Secret File holding a passphrase-encrypted envelope | `DEV_WALLET_KEY_FILE` + `DEV_WALLET_KEY_PASSPHRASE` | the passphrase, not the key |
| Remote signer (HashiCorp Vault Transit) | `WALLET_SIGNER=vault` + `VAULT_*` | a revocable token; the key never leaves Vault |

`node scripts/wallet-key.js encrypt` makes the envelope; `node scripts/wallet-key.js verify`
proves the configured signer controls the expected wallet without printing anything secret.
Set `TREASURY_WALLET` (a multisig or hardware wallet) and the flywheel keeps only
`HOT_WALLET_FLOAT_SOL` plus the holder pools in the hot wallet, sweeping the rest.

## Security

- Rate limiting: 120 req/min globally on `/api`, 5/min on `/api/deploy`, 10/min on
  `/api/prepare-metadata`, and 20 failed admin-key attempts per 15 min per IP
- `helmet` security headers + configurable CORS allowlist (`CORS_ORIGINS`)
- All admin/debug endpoints require a timing-safe-compared `ADMIN_API_KEY`
  (disabled entirely — returns 403 — if the key isn't set)
- Solana address and transaction-signature validation on all inputs, before any RPC call
- Launch metadata is built and pinned server-side after payment; clients cannot supply a
  metadata URI
- The launcher's web3.js bundle is pinned with a Subresource Integrity hash
- Endpoints that proxy to paid APIs (`/balance`, `/token-metadata`, `/pump-proxy`,
  `/services-status`) are admin-only
- Frontend output escaping (`esc()`/`escAttr()` helpers and/or DOMPurify,
  depending on the page) on any field that originates from user-settable
  token metadata (ticker, name), to prevent stored XSS

## Deployment

Runs on Render.com as multiple services from this one repo:
- The API/worker process (`src/index.js` / `src/worker.js`)
- The vanity mint grinder (`src/grinder.js`) — its own service, see `render.yaml`
- Separate static-site Blueprints for the frontends — see
  `shitpad/render.yaml` for that sub-site's Blueprint

### Vanity mint grinder

Launched tokens get a contract address ending in `shit`. Addresses are ground
ahead of time into a pool of 50 so a launch never waits on the search.

The grinder is a **separate service** on purpose. Grinding is sustained
CPU-bound work, and sharing an instance with the API would put request latency
in competition with a hot loop. `src/services/vanityGrinder.js` and
`vanityWorker.js` are reachable only from `src/grinder.js` — neither
`src/index.js` nor `src/worker.js` imports them, so the API process cannot
grind even by accident. Those processes only *claim* from the pool.

How it performs, measured at ~10,500 keys/sec/core (Node's OpenSSL-backed
ed25519 — the pure-JS tweetnacl equivalent manages ~61/sec):

| match | expected attempts | per address/core | pool of 50, 4 cores |
|---|---|---|---|
| any case (8 forms) | ~1.41M | ~2.2 min | ~50 min |
| exact lowercase | 58⁴ = 11.3M | ~18 min | ~7 hours |

Only 8 of the 16 capitalisations of "shit" are reachable, because base58 has no
uppercase `I` and no lowercase `l`. The suffix test never base58-encodes
anything: in base58 the trailing characters are the least-significant digits,
so the last four are fully determined by `pubkey mod 58⁴`.

Operationally:
- The pool lives in Postgres (`vanity_mints`), so the grinder and API share only
  a database — no direct connection between the services.
- Mint seeds are **encrypted at rest**. Until a token is created, whoever holds
  a ground seed can create that mint themselves and front-run the launch.
- `VANITY_ENCRYPTION_KEY` must be the **same value on both services**. If they
  differ the API cannot read the pool, and every launch quietly falls back to a
  random mint. The grinder refuses to start without it rather than producing
  keypairs nobody can decrypt.
- Grinding stops at `VANITY_POOL_TARGET` and restarts at `VANITY_POOL_LOW_WATER`.
- Anti-bundling dud tokens deliberately use random mints — they never consume a
  ground address.
- Pool depth is exposed on `/api/health` as `vanityPool`.

**If the pool is empty, launches fall back to a random mint.** That is the
designed behaviour, not a failure: the grinder being down, misconfigured or
still warming up never blocks a launch.

## Troubleshooting

**Server won't start?**
- Check `DATABASE_URL` — the server exits immediately without a working Postgres connection
- Check the wallet key: `node scripts/wallet-key.js verify` says which signer is configured and whether it works
- Check Redis is reachable: `redis-cli -u "$REDIS_URL" ping`
- Check the port isn't already in use

**Admin endpoints all return 403/401?**
- `ADMIN_API_KEY` isn't set, or the `x-admin-key` header doesn't match it

**Background tasks not running / stale data?**
- Confirm you're not running with `SERVER_MODE=worker` on the API instance
  (and vice versa) without a worker instance actually running the tasks

## License

Do whatever you want with it.
