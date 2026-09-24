/**
 * Signing policy
 * v30.4 - What the platform key will sign, decided at the signer boundary.
 *
 * With the key in this process, anything that can run code here can ask the signer to sign.
 * The signer therefore refuses everything the platform never does, and rate-limits the one
 * thing it does that an attacker would want: moving SOL out. Every message goes through
 * check() before a signature is produced -- whether it arrives via signTransaction, via
 * signVersionedTransaction, or as raw bytes through signMessage -- so there is no path around it.
 *
 * Rules:
 *   - The message must parse as a Solana transaction message (legacy or v0). Raw bytes that
 *     are not a transaction are refused: the platform key signs transactions and nothing else.
 *   - The platform must be the fee payer (it is the only role the platform ever signs in).
 *   - Every top-level instruction must target an allowed program: System, ComputeBudget,
 *     Token, Token-2022, Associated Token, Pump, Pump AMM, Jupiter v6, Memo, plus anything in
 *     SIGNING_EXTRA_PROGRAMS. Program ids must be static keys (a v0 message that names its
 *     program through a lookup table is refused).
 *   - System: only CreateAccount(+WithSeed) and Transfer(+WithSeed). Assign, Allocate and the
 *     nonce instructions are refused -- Assign on the wallet would hand its account to a
 *     program, and the platform never uses any of them.
 *   - Token / Token-2022: only account setup, CloseAccount, SyncNative and Revoke. Transfer,
 *     Approve, SetAuthority, Burn and the rest are refused: the platform moves tokens only
 *     through Pump sells and Jupiter swaps, never with a bare token instruction.
 *   - Pump / Pump AMM buys: the maximum spend encoded in the instruction is capped
 *     (SIGNING_MAX_BUY_SOL; the seed buy is 0.01 SOL) and counted as outflow.
 *   - SOL outflow -- transfers and account funding from the platform to anything but the
 *     treasury and the fee wallets, plus buy spends -- is capped per transaction
 *     (SIGNING_MAX_OUTFLOW_SOL_PER_TX) and per rolling hour (SIGNING_MAX_OUTFLOW_SOL_PER_HOUR).
 *     Transfers to the treasury and the fee wallets are unlimited: those are where surplus is
 *     meant to go, and their addresses are fixed in configuration.
 *
 * A refusal throws; the calling job fails, logs the reason, and retries on its next cycle.
 * SIGNING_POLICY=warn logs violations and signs anyway (for tuning the caps against real
 * traffic); SIGNING_POLICY=off disables the policy.
 *
 * The hourly budget is per process (the API and the worker each keep their own). The token
 * and vanity-mint keypairs never go through this module: they are ephemeral and sign only as
 * extra signers on a transaction the platform has already approved.
 */
const crypto = require('crypto');
const { Message, VersionedMessage, PublicKey, SystemProgram, ComputeBudgetProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { PROGRAMS, WALLETS } = require('../config/constants');
const logger = require('./logger');

const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const SYSTEM_IX = { CreateAccount: 0, Assign: 1, Transfer: 2, CreateAccountWithSeed: 3, Allocate: 8, AllocateWithSeed: 9, AssignWithSeed: 10, TransferWithSeed: 11 };
// SPL Token instruction tags the platform's transactions legitimately carry at the top level.
const TOKEN_ALLOWED = new Set([
    1,  // InitializeAccount
    5,  // Revoke
    9,  // CloseAccount (Jupiter cleanup of a wrapped-SOL account)
    16, // InitializeAccount2
    17, // SyncNative (wrapping SOL for a swap)
    18, // InitializeAccount3
    22, // InitializeImmutableOwner
]);

// Anchor discriminators: sha256("global:<name>")[0..8]. The Pump and Pump AMM programs share
// the scheme, so `buy` matches on both. spendOffset is where the u64 maximum spend sits in the
// instruction data.
const disc = (name) => Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
const BUY_SHAPES = [
    { name: 'buy', d: disc('buy'), spendOffset: 16 },                             // amount, max_sol_cost
    { name: 'buy_v2', d: disc('buy_v2'), spendOffset: 16 },
    { name: 'buy_exact_sol_in', d: disc('buy_exact_sol_in'), spendOffset: 8 },    // spendable_sol_in
    { name: 'buy_exact_quote_in', d: disc('buy_exact_quote_in'), spendOffset: 8 },
    { name: 'buy_exact_quote_in_v2', d: disc('buy_exact_quote_in_v2'), spendOffset: 8 },
];

const HOUR_MS = 60 * 60 * 1000;

function parseMessage(bytes) {
    if (bytes[0] & 0x80) {
        const m = VersionedMessage.deserialize(bytes);
        return { version: m.version, staticKeys: m.staticAccountKeys, ixs: m.compiledInstructions };
    }
    const m = Message.from(bytes);
    return { version: 'legacy', staticKeys: m.staticAccountKeys, ixs: m.compiledInstructions };
}

function u64At(data, offset) {
    if (data.length < offset + 8) return null;
    return Buffer.from(data.buffer, data.byteOffset, data.length).readBigUInt64LE(offset);
}

/**
 * @param {object} opts
 * @param {'enforce'|'warn'|'off'} opts.mode
 * @param {number} opts.maxOutflowPerTxSol
 * @param {number} opts.maxOutflowPerHourSol
 * @param {number} opts.maxBuySol
 * @param {PublicKey[]} opts.extraPrograms
 * @param {PublicKey[]} opts.exemptDestinations  transfers here are unlimited and uncounted
 * @param {() => number} [opts.now]               injectable clock (tests)
 */
function createPolicy(opts) {
    const mode = opts.mode || 'enforce';
    const allowedPrograms = new Set([
        SystemProgram.programId, ComputeBudgetProgram.programId,
        PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022, PROGRAMS.ASSOCIATED_TOKEN,
        PROGRAMS.PUMP, PROGRAMS.PUMP_AMM, JUPITER_V6, MEMO,
        ...(opts.extraPrograms || []),
    ].map(p => p.toBase58()));
    const exempt = new Set((opts.exemptDestinations || []).map(p => p.toBase58()));
    const maxPerTx = BigInt(Math.round((opts.maxOutflowPerTxSol ?? 20) * LAMPORTS_PER_SOL));
    const maxPerHour = BigInt(Math.round((opts.maxOutflowPerHourSol ?? 60) * LAMPORTS_PER_SOL));
    const maxBuy = BigInt(Math.round((opts.maxBuySol ?? 0.5) * LAMPORTS_PER_SOL));
    const now = opts.now || Date.now;
    const window = []; // { t, lamports } signed in the last hour

    function windowTotal() {
        const cutoff = now() - HOUR_MS;
        while (window.length && window[0].t < cutoff) window.shift();
        return window.reduce((s, e) => s + e.lamports, 0n);
    }

    /** Pure: describe what the message does and every rule it breaks. */
    function evaluate(bytes, platformPubkey) {
        const violations = [];
        let parsed;
        try {
            parsed = parseMessage(Uint8Array.from(bytes));
        } catch (e) {
            return { violations: ['not a transaction message'], outflow: 0n, programs: [] };
        }
        const { staticKeys, ixs } = parsed;
        const platform = platformPubkey.toBase58();
        const keyStr = (i) => (i < staticKeys.length ? staticKeys[i].toBase58() : null);
        if (!staticKeys.length || keyStr(0) !== platform) violations.push('platform wallet is not the fee payer');

        let outflow = 0n;
        const programs = new Set();
        for (const ix of ixs) {
            const program = keyStr(ix.programIdIndex);
            if (!program) { violations.push('program id loaded from a lookup table'); continue; }
            programs.add(program);
            if (!allowedPrograms.has(program)) { violations.push(`program ${program} is not allowed`); continue; }
            const data = ix.data;
            const acct = (n) => keyStr(ix.accountKeyIndexes[n]);

            if (program === SystemProgram.programId.toBase58()) {
                const type = data.length >= 4 ? Buffer.from(data.buffer, data.byteOffset, data.length).readUInt32LE(0) : -1;
                if (type === SYSTEM_IX.Transfer || type === SYSTEM_IX.TransferWithSeed) {
                    const lamports = u64At(data, 4) ?? 0n;
                    const dest = type === SYSTEM_IX.Transfer ? acct(1) : acct(2);
                    if (acct(0) === platform && !exempt.has(dest)) outflow += lamports;
                } else if (type === SYSTEM_IX.CreateAccount || type === SYSTEM_IX.CreateAccountWithSeed) {
                    if (acct(1) === platform) violations.push('system CreateAccount targets the platform wallet');
                    if (acct(0) === platform) outflow += u64At(data, 4) ?? 0n;
                } else {
                    violations.push(`system instruction ${type} is not allowed`);
                }
            } else if (program === PROGRAMS.TOKEN.toBase58() || program === PROGRAMS.TOKEN_2022.toBase58()) {
                const tag = data.length ? data[0] : -1;
                if (!TOKEN_ALLOWED.has(tag)) violations.push(`token instruction ${tag} is not allowed`);
            } else if (program === PROGRAMS.PUMP.toBase58() || program === PROGRAMS.PUMP_AMM.toBase58()) {
                if (data.length >= 8) {
                    const head = Buffer.from(data.buffer, data.byteOffset, 8);
                    const shape = BUY_SHAPES.find(s => s.d.equals(head));
                    if (shape) {
                        const spend = u64At(data, shape.spendOffset);
                        if (spend === null) violations.push(`${shape.name} is truncated`);
                        else {
                            if (spend > maxBuy) violations.push(`${shape.name} spend ${(Number(spend) / LAMPORTS_PER_SOL).toFixed(4)} exceeds SIGNING_MAX_BUY_SOL`);
                            outflow += spend;
                        }
                    }
                }
            }
            // ComputeBudget, Associated Token, Jupiter, Memo and extra programs: allowed as-is.
        }

        if (maxPerTx > 0n && outflow > maxPerTx) {
            violations.push(`outflow ${(Number(outflow) / LAMPORTS_PER_SOL).toFixed(4)} SOL exceeds SIGNING_MAX_OUTFLOW_SOL_PER_TX`);
        }
        if (maxPerHour > 0n && windowTotal() + outflow > maxPerHour) {
            violations.push(`outflow would exceed SIGNING_MAX_OUTFLOW_SOL_PER_HOUR (${(Number(windowTotal() + outflow) / LAMPORTS_PER_SOL).toFixed(4)} SOL in the last hour)`);
        }
        return { violations, outflow, programs: [...programs] };
    }

    /**
     * Gate a signature. Throws under 'enforce'; logs under 'warn'; records the outflow of
     * every message that goes on to be signed.
     */
    function check(bytes, platformPubkey) {
        if (mode === 'off') return;
        const { violations, outflow, programs } = evaluate(bytes, platformPubkey);
        if (violations.length) {
            const detail = { violations, outflowSol: Number(outflow) / LAMPORTS_PER_SOL, programs };
            if (mode === 'enforce') {
                logger.error('[SigningPolicy] REFUSED to sign', detail);
                throw new Error(`signing policy refused the transaction: ${violations.join('; ')}`);
            }
            logger.warn('[SigningPolicy] would refuse (SIGNING_POLICY=warn)', detail);
        }
        if (outflow > 0n) window.push({ t: now(), lamports: outflow });
    }

    return { mode, check, evaluate, windowTotal };
}

/** Build the production policy from config. */
function fromConfig(config) {
    const parseList = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
        try { return new PublicKey(x); } catch (e) { logger.warn('[SigningPolicy] Ignoring invalid address in policy config', { value: x }); return null; }
    }).filter(Boolean);
    const exempt = [WALLETS.BUYBACK_BURN, WALLETS.FEE_05, WALLETS.FEE_95, ...parseList(config.SIGNING_EXEMPT_DESTINATIONS)];
    if (config.TREASURY_WALLET) {
        try { exempt.push(new PublicKey(config.TREASURY_WALLET)); } catch (e) { /* the sweep reports it */ }
    }
    return createPolicy({
        mode: config.SIGNING_POLICY,
        maxOutflowPerTxSol: config.SIGNING_MAX_OUTFLOW_SOL_PER_TX,
        maxOutflowPerHourSol: config.SIGNING_MAX_OUTFLOW_SOL_PER_HOUR,
        maxBuySol: config.SIGNING_MAX_BUY_SOL,
        extraPrograms: parseList(config.SIGNING_EXTRA_PROGRAMS),
        exemptDestinations: exempt,
    });
}

module.exports = { createPolicy, fromConfig, BUY_SHAPES, TOKEN_ALLOWED, JUPITER_V6, MEMO };
