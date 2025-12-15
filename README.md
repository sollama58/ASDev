# ASDev

Token launcher for Solana. Ships tokens that end with `ASDF`. That's it.

## Quick Start (for the impatient)

```bash
# Clone
git clone https://github.com/zeyxx/ASDev.git
cd ASDev

# Install Node stuff
npm install

# Install Rust (say yes to everything, it's fine)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

# Clone and build the vanity grinder
git clone https://github.com/zeyxx/asdf-vanity-grinder.git
cd asdf-vanity-grinder
cargo build --release
cd ..

# Configure (edit .env with your keys)
cp .env.example .env

# Run
npm start
```

That's it. You're done. Go touch grass.

## Requirements

- Node.js 18+
- Redis
- A Solana wallet with some SOL
- Coffee (optional but recommended)

## Installation

```bash
# Clone the thing
git clone https://github.com/zeyxx/ASDev.git
cd ASDev

# Install dependencies
npm install

# Copy the env file and fill it in
cp .env.example .env
```

## Configuration

Create a `.env` file (see `.env.example` for all options):

```env
# Required
DEV_WALLET_PRIVATE_KEY=your_base58_private_key

# Network (mainnet or devnet)
SOLANA_NETWORK=mainnet
# Or use a custom RPC URL:
# RPC_URL=https://api.mainnet-beta.solana.com

# Optional but nice to have
HELIUS_API_KEY=your_helius_key
PORT=3000

# Security
CORS_ORIGINS=*                    # Comma-separated origins
ADMIN_API_KEY=your_admin_key      # For debug endpoints

# Vanity grinder (for ASDF addresses)
VANITY_GRINDER_ENABLED=true
VANITY_GRINDER_URL=http://localhost:8080
VANITY_GRINDER_API_KEY=your_api_key

# IPFS (Pinata)
PINATA_JWT=your_jwt

# Twitter (if you want social features)
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_SECRET=...
```

## Security Features

- **Rate limiting**: 100 requests/15min on API routes, 3/min on deploy
- **Helmet**: Security headers enabled
- **CORS**: Configurable allowed origins
- **XSS Protection**: DOMPurify sanitization on frontend
- **Input validation**: Solana address validation on all pubkey inputs
- **Admin auth**: Debug endpoints require API key in production

## Running

### The easy way

```bash
npm start
```

### The fancy way (with vanity grinder)

```bash
# Start Redis first
redis-server --daemonize yes

# Start the vanity grinder (in asdf-vanity-grinder folder)
cd asdf-vanity-grinder
./target/release/asdf-vanity-grinder pool \
  --file vanity_pool.json \
  --port 8080 \
  --api-key your_api_key \
  --min-pool 10 \
  --threads 2

# Back to main folder, start the server
cd ..
VANITY_GRINDER_ENABLED=true npm start
```

### The lazy way

```bash
# Start the grinder first (in background)
cd asdf-vanity-grinder && ./start_grinder.sh &
cd ..

# Then start the server
VANITY_GRINDER_ENABLED=true npm start
```

## API Endpoints

| Endpoint | What it does |
|----------|--------------|
| `GET /api/health` | Is it alive? |
| `GET /api/version` | What version? |
| `GET /api/services-status` | Check all external services (DB, Redis, RPC, Vanity) |
| `GET /api/blockhash` | Fresh blockhash |
| `GET /api/balance?pubkey=...` | Get wallet balance |
| `GET /api/leaderboard` | Top 10 tokens by volume |
| `GET /api/all-launches` | All launched tokens |
| `GET /api/recent-launches` | Ticker feed |
| `GET /api/token-holders/:mint` | Top 50 holders for a token |
| `GET /api/check-holder?userPubkey=...` | Check airdrop eligibility |
| `GET /api/all-eligible-users` | All users eligible for airdrop |
| `POST /api/prepare-metadata` | Upload metadata to IPFS |
| `POST /api/deploy` | Queue token deployment |
| `GET /api/job-status/:id` | Check deployment job status |
| `GET /api/debug/logs` | Debug logs (requires admin key) |

## Project Structure

```
src/
├── index.js          # Entry point
├── config/           # Configuration
├── services/         # Core services (solana, redis, etc.)
├── routes/           # API endpoints
└── tasks/            # Background jobs
```

## Vanity Grinder

The Rust vanity grinder generates Solana keypairs ending with `ASDF`. It runs separately and the Node.js server fetches keypairs from it via HTTP.

### Installing Rust

If you don't have Rust installed:

```bash
# Install Rust (just say yes to everything)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Reload your shell
source ~/.cargo/env

# Verify it works
rustc --version
```

### Building the grinder

```bash
cd asdf-vanity-grinder

# Build in release mode (important for performance)
cargo build --release

# Binary will be at ./target/release/asdf-vanity-grinder
```

### Running the grinder

```bash
# Basic usage - starts HTTP server with keypair pool
./target/release/asdf-vanity-grinder pool \
  --file vanity_pool.json \
  --port 8080 \
  --api-key your_secret_key \
  --min-pool 10 \
  --threads 2

# Low priority mode (recommended for production)
nice -n 19 ionice -c 3 ./target/release/asdf-vanity-grinder pool \
  --file vanity_pool.json \
  --port 8080 \
  --api-key your_secret_key \
  --min-pool 10 \
  --threads 1
```

### Grinder options

| Option | Description |
|--------|-------------|
| `--file` | JSON file to store the keypair pool |
| `--port` | HTTP server port (default: 8080) |
| `--api-key` | API key for authentication |
| `--min-pool` | Minimum pool size before warning |
| `--threads` | Number of grinding threads |

### Grinder endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (no auth) |
| `GET /stats` | Pool statistics |
| `GET /mint` | Get next available keypair |
| `POST /refill?count=N` | Generate N new keypairs |

### Pre-generating keypairs

If you want to pre-generate some keypairs before starting:

```bash
# Generate 50 keypairs and save to pool file
./target/release/asdf-vanity-grinder pool \
  --file vanity_pool.json \
  --min-pool 50 \
  --threads 4

# Then start the server with the pre-filled pool
./target/release/asdf-vanity-grinder pool \
  --file vanity_pool.json \
  --port 8080 \
  --api-key your_secret_key
```

## Troubleshooting

**Server won't start?**
- Check if Redis is running: `redis-cli ping`
- Check your `.env` file
- Check if port 3000 is free

**Vanity grinder not working?**
- Is it running? `pgrep -f asdf-vanity-grinder`
- Is the API key correct?
- Check `http://localhost:8080/health`

**Everything is on fire?**
- This is fine.

## License

Do whatever you want with it.
