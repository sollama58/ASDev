# Platform wallet key management

The platform wallet is a **hot wallet**. It signs, unattended and around the clock:

- every token launch (it is the on-chain creator and the fee recipient),
- every creator-fee claim,
- every holder payout, refund and treasury transfer,
- the seed buy and sell around each launch.

Whoever holds its private key can do all of that too, and can empty the wallet. This document
is the threat model, what the code does to contain that key, and how to deploy it somewhere
better than a plain environment variable.

---

## 1. What the code guarantees

Since v30.4 the key is handled by one module, `src/services/signer.js`. Everything else in the
codebase sees a *signer* — an object with a public key and three signing methods — and never
the key.

| Property | How |
|---|---|
| The key is never on `config` or `deps` | `createSignerFromEnv()` returns a frozen object whose only data is the public key. The secret lives in a closure. `JSON.stringify`, `util.inspect`, `String()` and `Object.keys` of a signer show the public key and nothing else, so a log line, a debug endpoint or a crash report that dumps `deps` cannot leak it. (The old `config.devKeypair` was a `Keypair`, which serialises its secret key as an array of numbers.) |
| The key is gone from the environment as soon as it is read | `DEV_WALLET_PRIVATE_KEY`, `DEV_WALLET_KEY_PASSPHRASE` and `VAULT_TOKEN` are deleted from `process.env` right after the signer is built. Every other API secret (`ADMIN_API_KEY`, `PINATA_JWT`, `HELIUS_API_KEY`, `ANTHROPIC_API_KEY`, the Twitter tokens, `VANITY_ENCRYPTION_KEY`) is copied onto `config` and deleted from `process.env` when `src/config/env.js` loads. A dependency that reads the environment, a child process, or an endpoint that printed `process.env` would get none of them. |
| Signing is the only operation | `signer.signMessage(bytes)`, `signTransaction(tx, extraSigners)`, `signVersionedTransaction(vtx)`. There is no `secretKey` getter and no export. The mint keypair a launch needs co-signs as an *extra* signer; it never touches the platform key. |
| The wrong key cannot run production | If the signer's public key is not `WALLETS.PLATFORM_DEV`, the process exits in production (`ALLOW_WALLET_MISMATCH=true` overrides this, for a deliberate rotation only). |
| The key can live outside the process | `WALLET_SIGNER=vault` delegates signing to a HashiCorp Vault Transit key; the key never enters the container (§3). Any other remote signer is one function to add (§4). |
| The key can be split across two secrets | The encrypted envelope (§2) makes the key file and the passphrase each useless on their own. |
| Build steps do not see secrets they cannot use | `render.yaml` installs with `--ignore-scripts`, so no dependency's `postinstall` runs with the platform's environment. (Render exposes env vars at build time as well as at runtime.) |
| Operators can check without looking | `node scripts/wallet-key.js verify` builds the signer exactly as the server does, signs a test message and confirms which wallet it controls. Nothing in that script prints key material. |
| What is at stake is capped | With `TREASURY_WALLET` set, the flywheel sweeps anything the hot wallet holds beyond its obligations (the holder pools, the accrued platform cut) plus `HOT_WALLET_FLOAT_SOL` to a treasury address every fee-collection cycle (§5). |

| The key is only ever in memory | `scripts/boot.sh` (the blueprint's start command) parks `DEV_WALLET_PRIVATE_KEY` — and `DEV_WALLET_KEY_PASSPHRASE` and `VAULT_TOKEN` when set — in private tmpfs files, drops the variables and `exec`s node; the signer reads and deletes the files as its first act. Deleting a variable from `process.env` does *not* remove it from `/proc/<pid>/environ`, which any code running as the same user can read for the life of the process — `exec` is what clears it. |
| The internet-facing process has no key | `SERVER_MODE=api-only` with no key configured runs on a *public-only* signer: it verifies launch payments and reports the address, and the worker's `deploy` task (no inbound network) runs every launch and refund. A remote-code-execution bug in the API finds nothing to sign with (§2.5). |
| The key only signs what the platform does | `src/services/signingPolicy.js` checks every message before a signature is produced — including raw bytes handed to `signMessage`. Unknown programs, `Assign`, nonce and token `Approve`/`Transfer`/`SetAuthority` instructions are refused; Pump buys are capped; SOL leaving the wallet for anything but the treasury and fee wallets is capped per transaction and per rolling hour (§2.6). |

What the code **cannot** do: keep the key out of this process's memory when the `local` backend
is used. A process that can be debugged, core-dumped or read by another process on the same host
can be read for the key. That is what the remote-signer backend is for.

---

## 2. Where to keep the key

Ranked from weakest to strongest. Each step is a strict improvement on the previous one and
they compose.

### 2.1 Render environment variable (`DEV_WALLET_PRIVATE_KEY`) — the baseline

What is true of a Render env var:

- It is encrypted at rest by Render and injected into the container at boot. Render staff do not
  see it in the normal course of business.
- **Anyone with access to the service in the Render dashboard can read it** in full, with one
  click. There is no "write-only" mode. Team membership is the access control, so enforce 2FA and
  keep the team small.
- It is present during the **build** (`npm ci`) as well as at runtime, so every dependency's
  install hook runs with it in the environment. The blueprint now disables those hooks.
- It is visible in the dashboard's Shell tab (`env`), in any `console.log(process.env)`, and in a
  crash reporter that captures the environment — until the code deletes it, which it now does
  within milliseconds of boot.

Acceptable for a small wallet. Not what you want in front of months of accumulated fees.

### 2.2 Render Secret File + encrypted envelope — two secrets, two places

The key is stored as a passphrase-encrypted envelope in a **Secret File**, and the passphrase in an
environment variable. Reading the dashboard's environment page yields the passphrase but not the
key; reading the file (shell access) yields the envelope but not the passphrase. Both are needed.

```bash
# On your own machine, never on the server:
node scripts/wallet-key.js encrypt            # paste the key, choose a passphrase (12+ chars)
# -> prints a one-line JSON envelope and the public key it holds
```

In Render, for the API and worker services:

1. **Secret Files → Add**: filename `wallet.enc.json`, contents = the envelope. Mount at
   `/etc/secrets/wallet.enc.json`.
2. **Environment**: `DEV_WALLET_KEY_FILE=/etc/secrets/wallet.enc.json`,
   `DEV_WALLET_KEY_PASSPHRASE=<the passphrase>`. Delete `DEV_WALLET_PRIVATE_KEY`.
3. Deploy. The log shows `[Signer] Using local signer {"source":"file+passphrase", ...}`.

The envelope is AES-256-GCM with a key derived by scrypt (N=2¹⁶, r=8, p=1). Every passphrase guess
costs ~100 ms and 64 MB, so a leaked envelope with a strong passphrase is not practically
crackable. The same envelope also works in `DEV_WALLET_PRIVATE_KEY` if you would rather not use a
secret file; then the dashboard shows the envelope and the passphrase side by side, which is only
marginally better than the clear key. Use the file.

Store the passphrase in a password manager; if it is lost the envelope is unrecoverable, and if
the wallet key itself is lost so are the creator-fee streams of every token launched under it
(see §6).

### 2.3 Remote signer: HashiCorp Vault Transit — the key never enters the container

Vault's Transit engine holds an Ed25519 key that is **non-exportable**: it can sign, and that is
all. The platform sends message bytes, Vault returns a signature, and an audit log records every
call. Revoking the platform's Vault token stops all signing without touching the key.

Runs on [HCP Vault Dedicated](https://developer.hashicorp.com/hcp/docs/vault) (managed) or any
Vault you host. Setup:

```bash
vault secrets enable transit
vault write -f transit/keys/shitpad type=ed25519 exportable=false
vault read -field=public_key transit/keys/shitpad     # base64 -> the wallet's public key

# A policy that can sign with this key and read its public key, and nothing else
vault policy write shitpad-signer - <<'HCL'
path "transit/sign/shitpad"  { capabilities = ["update"] }
path "transit/keys/shitpad"  { capabilities = ["read"] }
HCL
# A renewable token for the platform; rotate it on a schedule
vault token create -policy=shitpad-signer -period=720h -orphan
```

Fund the wallet whose public key Vault reports (base64 → base58 with
`node -e "console.log(require('bs58').encode(Buffer.from(process.argv[1],'base64')))" <b64>`), set
`WALLETS.PLATFORM_DEV` in `src/config/constants.js` to it, and in Render:

```
WALLET_SIGNER=vault
VAULT_ADDR=https://<your-vault>:8200
VAULT_TOKEN=<the token>            # deleted from the environment at boot
VAULT_TRANSIT_KEY=shitpad
VAULT_TRANSIT_MOUNT=transit        # optional
VAULT_NAMESPACE=admin              # HCP only
```

`node scripts/wallet-key.js verify` confirms the round trip. Latency is one HTTPS request per
signature (~20–60 ms), which is negligible against Solana confirmation times. If Vault is
unreachable the affected job fails and retries on its next cycle; nothing is lost.

Migrating an existing wallet into Vault is not possible (Transit keys are generated inside Vault
and cannot be imported without `exportable` semantics); this is a **new wallet**, so read §6 first.

### 2.4 Managed signing services

The same shape as Vault — bytes in, signature out, key in someone else's enclave — with a policy
engine on top (e.g. "only sign transactions whose instructions target these programs", spend
limits, approval flows). Purpose-built for exactly this workload:

- **Turnkey** — non-custodial, Solana-native, generous free tier, policies on the transaction
  contents. Its `@turnkey/sdk-server` + `@turnkey/solana` packages give a `signTransaction`.
- **Fireblocks** — enterprise MPC, approval quorums, Solana support.
- **Privy / Crossmint server wallets** — simpler, API-key gated.

None is wired in, because each needs its own SDK and account. Adding one is a single function:
implement `signBytes(bytes) -> Promise<Uint8Array(64)>` with the vendor SDK and wrap it with
`makeSigner('turnkey', publicKey, signBytes)` in `src/services/signer.js`; add a
`WALLET_SIGNER=turnkey` branch in `createSignerFromEnv`. The rest of the codebase does not change.

### 2.5 Keep the key out of the API process (env var, hardened)

Two Render services already exist: the API (HTTP + WebSocket) and the worker. Only the worker
needs to sign — launches, refunds, fee claims, payouts and sweeps are all queue or timer driven.
The API needs the wallet's *address* to verify that a launch payment went to it, and nothing
more. So the blueprint now puts `DEV_WALLET_PRIVATE_KEY` on **the worker only**:

- The API boots with `[Signer] No wallet key in this process` and does not start the deploy
  worker; `/api/deploy` verifies the payment against `WALLETS.PLATFORM_DEV` and queues the job.
- The worker runs the `deploy` task (on by default) and consumes that queue with the key.
- The API keeps the social (tweet) worker; it needs Twitter credentials, not the wallet.

The attack surface that matters most — code reachable from the internet — no longer has a key
to steal. Running launches in the API is still supported: set `DEV_WALLET_PRIVATE_KEY` on the
API service and it starts the deploy worker itself, as before.

Both services start through `scripts/boot.sh`, which keeps the key (and the passphrase or
Vault token, whichever you use) out of the process's `/proc/<pid>/environ` (see §1). With that,
a shell in the running container shows no key in `env`, none in `/proc`, none on disk.

Admin "run now" buttons (fee claim, airdrop, holder scan) queue work for the worker rather
than running in the API, so nothing in the API process ever needs to sign.

### 2.6 Let the key sign only what the platform does

Everything the platform signs is one of a short list of shapes, and the signer refuses the rest
(`src/services/signingPolicy.js`). What that buys: an attacker who gets code execution *inside*
the worker can call the signer, but cannot use it to sign a drain — not a transfer of the whole
balance, not a token-account `Approve` to themselves, not an `Assign` of the wallet to a program,
not a swap through an unknown program. They are limited to what the platform itself would do, at
the rate the platform itself would do it. Combined with the treasury sweep (§5), the worst case
is the float plus the pools of the moment, paid out only as fast as the hourly cap allows.

```
SIGNING_POLICY=enforce                 # enforce | warn (log only, for tuning) | off
SIGNING_MAX_OUTFLOW_SOL_PER_TX=20      # SOL to non-exempt destinations in one transaction
SIGNING_MAX_OUTFLOW_SOL_PER_HOUR=60    # …and per rolling hour, per process
SIGNING_MAX_BUY_SOL=0.5                # max spend encoded in a Pump / Pump AMM buy
SIGNING_EXTRA_PROGRAMS=                # comma-separated program ids to allow beyond the built-in list
SIGNING_EXEMPT_DESTINATIONS=           # addresses transfers to which are uncapped, beyond treasury + fee wallets
```

Built-in allowed programs: System, ComputeBudget, Token, Token-2022, Associated Token, Pump,
Pump AMM, Jupiter v6, Memo. Exempt destinations: `TREASURY_WALLET`, `BUYBACK_BURN_WALLET`, the
upkeep wallet.

Sizing: a refused payout batch fails, is credited back to its pool, and retries next cycle, so
set the hourly cap at roughly twice the busiest hour of payouts you expect and watch for
`[SigningPolicy] REFUSED` in the worker log. Run a week on `SIGNING_POLICY=warn` first if you
are unsure; it logs what it *would* refuse and signs anyway. `off` disables the policy.

### 2.7 Multisig for the treasury (not for the hot wallet)

The hot wallet must sign unattended, so it cannot be a multisig. The **treasury** can and should
be: a [Squads](https://squads.so) vault, or a hardware wallet that never touches a server. Set it as
`TREASURY_WALLET` (§5) and the hot wallet only ever holds operating float plus the pools of the
moment. The buyback/burn and upkeep destinations (`BUYBACK_BURN_WALLET`, `WALLETS.FEE_05`) should
be cold for the same reason.

---

## 3. Recommended production layout

For this platform, in order of effort:

1. **Today, ten minutes:** `TREASURY_WALLET` = a Squads vault or hardware wallet;
   `HOT_WALLET_FLOAT_SOL=1`. The hot wallet's contents stop growing.
2. **With the env var (the blueprint's default):** the key on the worker service only, the API
   key-free, both started through `scripts/boot.sh`, signing policy on `enforce` (§2.5, §2.6).
   This is what `render.yaml` describes.
3. **Optional:** move the key into a Secret File as an encrypted envelope (§2.2), so a dashboard
   reader gets the passphrase but not the key.
4. **When the wallet is worth it:** a fresh wallet in Vault Transit (§2.3) or Turnkey (§2.4),
   deployed with a wallet rotation (§6).

Whichever layout: 2FA on the Render team, the smallest possible team, and no key in any chat,
ticket, screenshot or `.env` file that leaves your machine.

---

## 4. Adding a signer backend

```js
// src/services/signer.js
async function createTurnkeySigner(env) {
    const client = new Turnkey({ ... });                    // vendor SDK
    const publicKey = new PublicKey(env.TURNKEY_WALLET_PUBKEY);
    return makeSigner('turnkey', publicKey, async (bytes) => {
        const { r, s } = await client.signRawPayload({ ... }); // 32 + 32 bytes for ed25519
        return Uint8Array.from(Buffer.concat([Buffer.from(r, 'hex'), Buffer.from(s, 'hex')]));
    }, { source: 'turnkey' });
}
```

The contract: `signBytes` receives the exact bytes to sign (a serialised transaction message)
and returns the 64-byte Ed25519 signature. The signer test suite
(`signertest.js` in the session scratchpad) checks a backend end to end against a fake server;
copy its Vault section for a new one.

---

## 5. Limiting what the key can lose

```
TREASURY_WALLET=<system-owned address: a Squads vault, a hardware wallet>
HOT_WALLET_FLOAT_SOL=1.0          # operating float kept in the hot wallet (default 1.0)
HOT_WALLET_SWEEP_MIN_SOL=0.25     # do not bother sweeping less than this (default 0.25)
```

After every fee-collection cycle the flywheel computes

    surplus = balance − (pending token pools + central pool + accrued platform cut) − float

and, if it is at least `HOT_WALLET_SWEEP_MIN_SOL`, transfers it to the treasury. The holder pools
are never touched: they are obligations. The sweep takes the airdrop mutex so it cannot race a
distribution that has reserved a pool but not yet sent it, and it refuses any treasury that is
not a plain system-owned account (a token account or program would swallow the transfer). The
lifetime total is `stats.lifetimeTreasurySweptLamports`.

Size the float for the wallet's own spending between sweeps: each launch spends 0.01 SOL on the
seed buy plus fees, each refund 0.019 SOL, each payout batch a few thousand lamports. 1 SOL covers
a busy day. If the wallet cannot pay a job, the job logs and waits; nothing breaks.

---

## 6. Rotating the wallet

Rotation is **not routine** on this platform, for one reason: pump.fun pays creator fees to the
wallet that created the token, and only that wallet can claim them. Every token launched under the
old key keeps paying into a vault only the old key can open. Rotating therefore means one of:

- keep the old key alive somewhere to claim its tokens' fees (a second, claim-only signer — not
  implemented; the old key would then need protecting too), or
- accept that those streams are abandoned.

(pump.fun keeps a per-creator fee-sharing config, which this code reads to find fee recipients.
If the current program lets the creator name a different recipient wallet, the old key can
re-point its tokens' fees to the new wallet once, before retiring. Verify that against the live
program before relying on it; it is not automated here.)

So protect the key well rather than plan to rotate it often. When you do rotate — a leak, or a
move to Vault/Turnkey:

1. Create the new wallet in the target backend. Note its public key.
2. Fund it with `HOT_WALLET_FLOAT_SOL` plus whatever pools are pending.
3. In one deploy: set `WALLETS.PLATFORM_DEV` in `src/config/constants.js` to the new key and
   switch the signer configuration. The mismatch check makes a half-done change fatal, which is
   what you want.
4. Move the old wallet's balance to the treasury. Its pools are already accounted for in the
   database and will be paid from the new wallet.
5. If the old key leaked, do steps 3–4 first and fund the new wallet afterwards; every minute
   the old key is the live signer is a minute it can be drained.

---

## 7. If the key leaks

1. Sweep the hot wallet to the treasury immediately (any wallet software; the sweep in §5 only
   runs on the flywheel's schedule).
2. `WALLET_SIGNER=vault`: revoke the token (`vault token revoke`); signing stops. Local key: there
   is nothing to revoke — rotate (§6).
3. Rotate every other secret the same environment held: `ADMIN_API_KEY`, `PINATA_JWT`,
   `HELIUS_API_KEY`, the Twitter tokens, `VANITY_ENCRYPTION_KEY` (then regrind the vanity pool).
4. Review the Render team, the audit log, and where the key had ever been pasted.
