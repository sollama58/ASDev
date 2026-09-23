/**
 * Pump.fun launch service
 * v30.0 - Builds create/buy/fee-collection instructions through the official SDK.
 *
 * WHY THIS EXISTS
 *
 * The instruction layouts in services/pump.js were hand-written, and they drifted. The
 * create instruction this platform sends is `create_v2`, whose argument list pump.fun has
 * extended twice: it now takes `is_cashback_enabled`, `creator_fee_bps` and
 * `is_holder_reward` after `is_mayhem_mode`. Our builder still stopped at `is_mayhem_mode`,
 * so it emitted a 93-byte payload where the official client emits 103. Custom Pairs raises
 * the stakes further: a token-quoted launch adds four positional remaining accounts, and
 * `buy_v2` carries 27 accounts against `buy`'s 16.
 *
 * Hand-maintaining that is how the drift happened, so this module delegates to
 * @pump-fun/pump-sdk instead. The SDK derives every PDA, orders the remaining accounts and
 * encodes the arguments, and it moves when the program moves.
 *
 * PLATFORM FEE POLICY
 *
 * Every coin launched here must keep the platform wallet as its on-chain creator, because
 * that is what makes 100% of creator fees accrue to us for the 50/25/24.5/0.5 split in
 * tasks/flywheel.js. Two SDK options would break that and are therefore forced off and never
 * exposed as parameters:
 *
 *   holderReward — reassigns the creator to the coin's holder-rewards PDA. Every creator fee
 *                  would then accrue to that PDA and be paid out by pump.fun directly,
 *                  bypassing our split entirely. Permanent, and uncorrectable after launch.
 *   cashback     — deprecated upstream; `create_v2` rejects it outright with error 6082.
 */
const { PublicKey, ComputeBudgetProgram, Transaction } = require('@solana/web3.js');
const { NATIVE_MINT, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const BN = require('bn.js');
const {
    PumpSdk,
    OnlinePumpSdk,
    isSolLikeQuoteMint,
    normalizeQuoteMint,
    getBuyTokenAmountFromSolAmount,
    UnsupportedQuoteMintError,
    creatorVaultPda,
    ammCreatorVaultPda,
    quoteAta,
} = require('@pump-fun/pump-sdk');
const logger = require('./logger');
const tokenMeta = require('./tokenMeta');
const config = require('../config/env');

// Instruction building is offline; only account reads need a connection.
const sdk = new PumpSdk();

/**
 * Compute budgets.
 *
 * The SDK documents a token-quoted create as 200-240k CU and a first `buy_v2` on a
 * Token-2022 quote as 200-220k, and recommends ~500k for create+buy with a token quote. The
 * launch path previously requested 300k from solana.addPriorityFee plus a 200k limit set in
 * the deploy worker, which is under what a token-quoted launch needs -- the transaction would
 * exhaust its budget rather than fail cleanly.
 */
const CU_LIMIT_SOL_LAUNCH = 300_000;
const CU_LIMIT_TOKEN_LAUNCH = 500_000;

// Global and the supported-quote list change rarely and cost an RPC round-trip each.
let globalCache = { value: null, at: 0 };
let quoteMintCache = { value: null, at: 0 };
const GLOBAL_TTL_MS = 60_000;
const QUOTE_TTL_MS = 5 * 60_000;

function online(connection) {
    return new OnlinePumpSdk(connection);
}

async function fetchGlobal(connection) {
    if (globalCache.value && Date.now() - globalCache.at < GLOBAL_TTL_MS) {
        return globalCache.value;
    }
    const value = await online(connection).fetchGlobal();
    globalCache = { value, at: Date.now() };
    return value;
}

/**
 * Every quote mint `create_v2` accepts right now: SOL, the Global whitelist, and the
 * QuoteControl entries. One RPC round-trip, cached.
 *
 * Returns a plain, serialisable shape so routes can hand it straight to the frontend.
 */
let quoteMintInflight = null;

async function getSupportedQuoteMints(connection, { force = false } = {}) {
    if (!force && quoteMintCache.value && Date.now() - quoteMintCache.at < QUOTE_TTL_MS) {
        return quoteMintCache.value;
    }
    // v30.2: single-flight. Every page load asks for this list, so when the cache expires under
    // traffic each concurrent request used to start its own full refresh.
    if (quoteMintInflight) return quoteMintInflight;
    quoteMintInflight = refreshSupportedQuoteMints(connection)
        .finally(() => { quoteMintInflight = null; });
    return quoteMintInflight;
}

async function refreshSupportedQuoteMints(connection) {
    const mints = await online(connection).fetchSupportedQuoteMints();

    // The SDK returns addresses only. A picker of ~90 base58 blobs is unusable, so decorate
    // each one with its on-chain symbol. Cosmetic, hence best-effort: a failure here must
    // still leave a working (if unlabelled) list rather than break the launcher.
    let symbols = new Map();
    try {
        symbols = await tokenMeta.resolveSymbols(connection, mints.map(m => m.mint));
    } catch (e) {
        logger.debug('[PumpLaunch] Quote asset labels unavailable', { error: e.message });
    }

    const value = mints.map(m => {
        const mint = m.mint.toBase58();
        const isSol = isSolLikeQuoteMint(m.mint);
        const meta = symbols.get(mint);
        return {
            mint,
            source: String(m.source),
            isSol,
            // SOL is reported as the wrapped-SOL mint, whose on-chain symbol is "SOL"
            // already, but it is the default and must be labelled even if the read failed.
            symbol: isSol ? 'SOL' : (meta?.symbol || ''),
            name: isSol ? 'Solana' : (meta?.name || ''),
        };
    });
    quoteMintCache = { value, at: Date.now() };
    logger.info('[PumpLaunch] Supported quote mints refreshed', {
        count: value.length,
        labelled: value.filter(v => v.symbol).length,
    });
    return value;
}

/**
 * Resolve a caller-supplied quote mint to what the builders need, or throw a message fit to
 * show a user. `undefined`/null/SOL all resolve to the SOL entry.
 */
const resolvedQuoteCache = new Map(); // base58 -> { value, at }

async function resolveQuote(connection, quoteMint) {
    if (!quoteMint) return null; // SOL path

    // v30.2: answered from cache where possible. /api/deploy validates the quote before it
    // verifies payment, so an uncached lookup here let unpaid requests drive RPC calls. A mint
    // not on the (cached) supported list is rejected without touching the chain at all.
    try {
        new PublicKey(quoteMint);
    } catch (e) {
        const err = new Error('That quote asset is not a valid address.');
        err.userFacing = true;
        throw err;
    }
    if (isSolLikeQuoteMint(new PublicKey(quoteMint))) return null;

    const cached = resolvedQuoteCache.get(String(quoteMint));
    if (cached && Date.now() - cached.at < QUOTE_TTL_MS) return cached.value;
    if (quoteMintCache.value && !quoteMintCache.value.some(q => q.mint === String(quoteMint))) {
        const err = new Error('That quote asset is not currently accepted by Pump.fun.');
        err.userFacing = true;
        throw err;
    }

    const value = await resolveQuoteUncached(connection, quoteMint);
    resolvedQuoteCache.set(String(quoteMint), { value, at: Date.now() });
    return value;
}

async function resolveQuoteUncached(connection, quoteMint) {
    let key;
    try {
        key = new PublicKey(quoteMint);
    } catch (e) {
        const err = new Error('That quote asset is not a valid address.');
        err.userFacing = true;
        throw err;
    }
    if (isSolLikeQuoteMint(key)) return null;

    try {
        const resolved = await online(connection).resolveQuoteMint(key);
        return {
            mint: normalizeQuoteMint(resolved.mint),
            quoteTokenProgram: resolved.quoteTokenProgram,
            decimals: resolved.decimals,
        };
    } catch (e) {
        if (e instanceof UnsupportedQuoteMintError) {
            const err = new Error('That quote asset is not currently accepted by Pump.fun.');
            err.userFacing = true;
            throw err;
        }
        throw e;
    }
}

/**
 * Build the instructions for one launch: create the coin and make the platform's first buy,
 * quoted in SOL or in a supported token.
 *
 * @returns {Promise<{instructions: TransactionInstruction[], computeUnitLimit: number,
 *                    quoteMint: string|null, isTokenQuoted: boolean}>}
 */
async function buildLaunchInstructions({
    connection,
    mint,            // PublicKey of the new mint (its keypair co-signs)
    name,
    symbol,
    uri,
    creator,         // platform wallet: keeps 100% of creator fees with us
    user,            // payer/signer, normally the same platform wallet
    quoteAmount,     // BN, in the quote asset's base units (lamports for SOL)
    mayhemMode = false,
    quoteMint = null,
    creatorFeeBps = null,
    // v30.2: false builds the create alone. Token-quoted launches use this: a seed buy would
    // spend a fixed number of base units of whatever the quote asset is (10 USDC, or a tenth
    // of a share of a stock token) out of inventory the platform wallet would have to hold
    // in every one of ~90 assets.
    seedBuy = true,
}) {
    const global = await fetchGlobal(connection);
    const quote = await resolveQuote(connection, quoteMint);
    const isTokenQuoted = !!quote;

    // 6071: the program refuses mayhem mode on a mint admitted only through QuoteControl.
    // Caught here so the launch fails with an explanation rather than an opaque program error.
    if (isTokenQuoted && mayhemMode) {
        const err = new Error('Mayhem mode cannot be combined with a token quote asset.');
        err.userFacing = true;
        throw err;
    }

    const common = {
        global,
        mint,
        name,
        symbol,
        uri,
        creator,
        user,
        mayhemMode,
        // See PLATFORM FEE POLICY above. Never parameterised.
        holderReward: false,
        cashback: false,
    };

    if (creatorFeeBps != null) {
        common.creatorFeeBps = BN.isBN(creatorFeeBps) ? creatorFeeBps : new BN(creatorFeeBps);
    }

    if (!seedBuy) {
        const createIx = await sdk.createV2Instruction({
            ...common,
            ...(isTokenQuoted ? { quoteMint: quote.mint, quoteTokenProgram: quote.quoteTokenProgram } : {}),
        });
        const computeUnitLimit = isTokenQuoted ? CU_LIMIT_TOKEN_LAUNCH : CU_LIMIT_SOL_LAUNCH;
        return {
            instructions: [createIx],
            transactions: planLaunchTransactions([createIx], user, computeUnitLimit),
            computeUnitLimit,
            quoteMint: quote ? quote.mint.toBase58() : null,
            isTokenQuoted,
            seedBuy: false,
        };
    }

    // How many tokens the first buy receives for `quoteAmount`. The curve does not exist
    // yet, so this is priced off Global's initial virtual reserves -- which for a
    // quote-control mint are seeded from the QuoteControl PDA, hence fetching it here. It
    // must be quoted at the same creator fee rate the create stores, or the buy pays less
    // than the program charges and fails.
    const quoteControl = isTokenQuoted ? await online(connection).fetchQuoteControl() : null;
    const amount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig: null,
        mintSupply: null,
        bondingCurve: null,
        amount: quoteAmount,
        quoteMint: isTokenQuoted ? quote.mint : NATIVE_MINT,
        quoteControl,
        ...(common.creatorFeeBps ? { creatorFeeBps: common.creatorFeeBps } : {}),
    });

    if (!amount || amount.isZero()) {
        const err = new Error('That launch amount is too small to buy any tokens.');
        err.userFacing = true;
        throw err;
    }

    let instructions;
    if (isTokenQuoted) {
        instructions = await sdk.createV2AndBuyV2Instructions({
            ...common,
            amount,
            quoteAmount,
            quoteMint: quote.mint,
            quoteTokenProgram: quote.quoteTokenProgram,
        });
    } else {
        instructions = await sdk.createV2AndBuyInstructions({
            ...common,
            amount,
            solAmount: quoteAmount,
        });
    }

    const computeUnitLimit = isTokenQuoted ? CU_LIMIT_TOKEN_LAUNCH : CU_LIMIT_SOL_LAUNCH;

    return {
        instructions,
        transactions: planLaunchTransactions(instructions, user, computeUnitLimit),
        computeUnitLimit,
        quoteMint: quote ? quote.mint.toBase58() : null,
        isTokenQuoted,
        seedBuy: true,
    };
}

/**
 * A compute-unit limit instruction sized for this launch. Kept here so callers cannot forget
 * it: a token-quoted launch that runs on the default budget fails partway through.
 */
function computeBudgetInstruction(units) {
    return ComputeBudgetProgram.setComputeUnitLimit({ units });
}

// A legacy transaction may not exceed 1232 serialized bytes. The margin absorbs the
// difference between a placeholder blockhash and a real one, and rounding in the
// compact-array length prefixes.
const MAX_TX_BYTES = 1232;
const TX_SIZE_MARGIN = 24;

/**
 * Serialized size of a transaction carrying these instructions, measured rather than
 * estimated. `requireAllSignatures: false` still reserves space for every required signer,
 * so this is the real wire size.
 */
function measureTxBytes(instructions, feePayer, computeUnitLimit) {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICRO_LAMPORTS }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
    for (const ix of instructions) tx.add(ix);
    tx.feePayer = feePayer;
    tx.recentBlockhash = '11111111111111111111111111111111';
    try {
        return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    } catch (e) {
        return Infinity; // already over the limit
    }
}

/**
 * Split a launch into as few transactions as will actually fit.
 *
 * A launch is create + the user's base ATA + the seed buy. That combination does not reliably
 * fit in one legacy transaction, and the failure is silent until a launch is attempted with
 * real-world inputs: a token-quoted create carries 34 distinct accounts, and even the SOL
 * path overflows once the metadata URI is a real 80-character gateway URL and the name
 * approaches its 32-character maximum. Measured, not assumed, because the size depends on
 * the name, symbol and URI the user chose.
 *
 * The create must lead and is the only instruction the mint keypair signs, so the split point
 * is after it. Group two is best-effort: if it fails the coin still exists and trades, it
 * simply has no seed position.
 */
function planLaunchTransactions(instructions, feePayer, computeUnitLimit) {
    const whole = measureTxBytes(instructions, feePayer, computeUnitLimit);
    if (whole + TX_SIZE_MARGIN <= MAX_TX_BYTES) {
        return [{ instructions, needsMintSignature: true, critical: true, bytes: whole }];
    }

    const [create, ...rest] = instructions;
    const head = [create];
    const headBytes = measureTxBytes(head, feePayer, computeUnitLimit);
    const tailBytes = rest.length ? measureTxBytes(rest, feePayer, computeUnitLimit) : 0;

    if (headBytes + TX_SIZE_MARGIN > MAX_TX_BYTES) {
        // Nothing can be done by splitting: the create alone is too big. Surface it as a
        // user-facing error naming the cause rather than letting the send fail opaquely.
        const err = new Error('That name, ticker or image URL is too long for a single transaction. Try a shorter name.');
        err.userFacing = true;
        throw err;
    }

    logger.info('[PumpLaunch] Splitting launch across two transactions', {
        combinedBytes: whole === Infinity ? 'over limit' : whole,
        createBytes: headBytes,
        buyBytes: tailBytes,
    });

    return [
        { instructions: head, needsMintSignature: true, critical: true, bytes: headBytes },
        { instructions: rest, needsMintSignature: false, critical: false, bytes: tailBytes },
    ];
}

/**
 * Sell back the seed position the launch bought, whatever the coin is quoted in.
 *
 * The launch buys a small amount of its own coin to seed the curve; this returns it. The
 * previous implementation hand-assembled a SOL-only `sell`, so a token-quoted coin would have
 * left the position stranded. `fetchSellState` reads the curve and tells us its normalized
 * quote, so the right builder is chosen from what is actually on chain rather than from what
 * the caller believed it launched.
 *
 * @returns {Promise<{instructions: TransactionInstruction[], isTokenQuoted: boolean,
 *                    amount: BN}|null>} null when there is nothing to sell
 */
async function buildSeedSellInstructions({ connection, mint, user, tokenProgram, slippage = 500 }) {
    const o = online(connection);
    const state = await o.fetchSellState(mint, user, tokenProgram);
    const global = await fetchGlobal(connection);

    // How much of the coin the platform actually holds right now.
    const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
    const baseProgram = tokenProgram || require('@solana/spl-token').TOKEN_2022_PROGRAM_ID;
    const ata = getAssociatedTokenAddressSync(mint, user, false, baseProgram);

    let amount;
    try {
        const bal = await connection.getTokenAccountBalance(ata);
        amount = new BN(bal?.value?.amount || '0');
    } catch (e) {
        return null; // no token account: nothing was received, nothing to sell
    }
    if (amount.isZero()) return null;

    const isTokenQuoted = !isSolLikeQuoteMint(state.quoteMint);

    const instructions = isTokenQuoted
        ? await sdk.sellV2Instructions({
            global,
            bondingCurveAccountInfo: state.bondingCurveAccountInfo,
            bondingCurve: state.bondingCurve,
            mint,
            user,
            amount,
            // 0 asks the builder for whatever the curve pays; slippage bounds the shortfall.
            quoteAmount: new BN(0),
            slippage,
            tokenProgram: baseProgram,
            quoteTokenProgram: state.quoteTokenProgram,
        })
        : await sdk.sellInstructions({
            global,
            bondingCurveAccountInfo: state.bondingCurveAccountInfo,
            bondingCurve: state.bondingCurve,
            mint,
            user,
            amount,
            solAmount: new BN(0),
            slippage,
            tokenProgram: baseProgram,
            mayhemMode: !!state.bondingCurve.isMayhemMode,
        });

    return { instructions, isTokenQuoted, amount };
}

/**
 * Collect the platform's creator fees across SOL and every supported quote mint, from both
 * the pump creator vault and the pump-amm coin creator vault.
 *
 * This replaces the hand-rolled two-leg claim, which only ever knew about SOL. With Custom
 * Pairs a coin quoted in a token accrues its creator fees in that token, so a SOL-only claim
 * would silently leave them stranded in vault ATAs forever.
 *
 * `extraQuoteMints` matters for correctness over time: de-listing a mint from QuoteControl
 * stops new creates but existing curves keep trading and accruing in it, and the SDK's
 * listed-mint sweep would no longer see them. Callers should pass the distinct
 * `quote_mint` values of our own launched tokens.
 */
async function buildCollectAllFeesInstructions({ connection, creator, feePayer, extraQuoteMints = [] }) {
    const extras = extraQuoteMints
        .filter(Boolean)
        .map(m => { try { return new PublicKey(m); } catch (e) { return null; } })
        .filter(Boolean);

    return online(connection).collectCoinCreatorFeeAllQuotesInstructions(
        creator,
        feePayer || creator,
        extras
    );
}

// A mint's owning token program never changes, so it is looked up once per process.
const mintProgramCache = new Map(); // base58 -> PublicKey

/**
 * What is waiting to be collected, per quote mint, as
 * `[{ mint, isSol, quoteTokenProgram, total: BN }]` with `total` in the mint's base units.
 * Entries with nothing waiting are omitted.
 *
 * v30.2 RPC: reads only the vaults fees can actually be in. The platform is the creator of
 * every coin it launches, so it can only hold creator fees in SOL and in the quote assets of
 * coins it launched -- `quoteMints`, the distinct `quote_mint` values in our tokens table.
 * The SDK's getCreatorVaultQuoteBalances instead walks every quote asset pump.fun lists (~90),
 * costing ~4-5 RPC round-trips on every survey; this is one getMultipleAccountsInfo (plus a
 * one-off lookup of each new quote mint's token program).
 *
 * SOL: the pump creator vault's lamports above its rent-exempt minimum, plus the PumpSwap
 * creator vault's WSOL ATA. Token quote Q: the Q ATAs of both vaults.
 */
async function fetchCollectableFees({ connection, creator, extraQuoteMints = [] }) {
    const { getRentExemptMinimum } = require('./solana');
    const pumpVault = creatorVaultPda(creator);
    const ammVault = ammCreatorVaultPda(creator);

    const quotes = [...new Set(extraQuoteMints.filter(Boolean).map(String))]
        .map(m => { try { return new PublicKey(m); } catch (e) { return null; } })
        .filter(k => k && !isSolLikeQuoteMint(k));

    // Token programs for any quote mint not seen before.
    const unknown = quotes.filter(q => !mintProgramCache.has(q.toBase58()));
    if (unknown.length) {
        const infos = await connection.getMultipleAccountsInfo(unknown);
        unknown.forEach((q, i) => {
            if (infos[i]) mintProgramCache.set(q.toBase58(), infos[i].owner);
        });
    }
    const known = quotes.filter(q => mintProgramCache.has(q.toBase58()));

    // One batch: [pump SOL vault, AMM WSOL ATA, then (pump ATA, AMM ATA) per token quote].
    const keys = [pumpVault, quoteAta(ammVault, NATIVE_MINT, TOKEN_PROGRAM_ID)];
    for (const q of known) {
        const prog = mintProgramCache.get(q.toBase58());
        keys.push(quoteAta(pumpVault, q, prog), quoteAta(ammVault, q, prog));
    }
    const infos = [];
    for (let i = 0; i < keys.length; i += 100) {
        infos.push(...await connection.getMultipleAccountsInfo(keys.slice(i, i + 100)));
    }

    // A token account's `amount` is a u64 at offset 64. Anything else counts as zero.
    const tokenAmount = (info, program) =>
        (info && info.owner.equals(program) && info.data.length >= 72)
            ? new BN(info.data.slice(64, 72), 'le')
            : new BN(0);

    const out = [];

    let solTotal = new BN(0);
    const pumpInfo = infos[0];
    if (pumpInfo) {
        const rent = await getRentExemptMinimum(pumpInfo.data?.length || 0);
        solTotal = solTotal.add(new BN(Math.max(0, pumpInfo.lamports - rent)));
    }
    solTotal = solTotal.add(tokenAmount(infos[1], TOKEN_PROGRAM_ID));
    if (solTotal.gtn(0)) {
        out.push({ mint: NATIVE_MINT.toBase58(), isSol: true, quoteTokenProgram: TOKEN_PROGRAM_ID, total: solTotal });
    }

    known.forEach((q, i) => {
        const prog = mintProgramCache.get(q.toBase58());
        const total = tokenAmount(infos[2 + i * 2], prog).add(tokenAmount(infos[3 + i * 2], prog));
        if (total.gtn(0)) out.push({ mint: q.toBase58(), isSol: false, quoteTokenProgram: prog, total });
    });

    return out;
}

/**
 * Pack fee-collection instructions into as few transactions as will fit.
 *
 * A sweep across every supported quote runs to hundreds of instructions — far past one
 * legacy transaction — so it has to be split, and the split has to be measured rather than
 * guessed at because each quote contributes a different number of accounts.
 *
 * Order is preserved, which is what keeps a split safe: the SDK emits each quote's
 * instructions contiguously as [create-ATA-if-missing, pump leg, AMM leg], and an ATA
 * creation landing one transaction ahead of the collect that needs it is fine as long as the
 * transactions are sent in order. Callers must stop on the first failure for that reason.
 */
function planFeeTransactions(instructions, feePayer, computeUnitLimit) {
    const fits = (group) =>
        measureTxBytes(group, feePayer, computeUnitLimit) + TX_SIZE_MARGIN <= MAX_TX_BYTES;

    const groups = [];
    let current = [];

    for (const ix of instructions) {
        if (current.length) {
            const candidate = [...current, ix];
            if (fits(candidate)) {
                current = candidate;
                continue;
            }
            groups.push(current);
            current = [];
        }
        if (!fits([ix])) {
            // One instruction alone overflows, so there is no split that helps. Skipping it
            // leaves the rest of the sweep working, which beats failing the whole cycle.
            logger.warn('[PumpLaunch] Skipping an oversized fee instruction', {
                programId: ix.programId.toBase58(), accounts: ix.keys.length,
            });
            continue;
        }
        current = [ix];
    }
    if (current.length) groups.push(current);

    return groups;
}

function resetCaches() {
    globalCache = { value: null, at: 0 };
    quoteMintCache = { value: null, at: 0 };
    resolvedQuoteCache.clear();
}

module.exports = {
    buildLaunchInstructions,
    planLaunchTransactions,
    measureTxBytes,
    buildSeedSellInstructions,
    buildCollectAllFeesInstructions,
    fetchCollectableFees,
    planFeeTransactions,
    getSupportedQuoteMints,
    resolveQuote,
    computeBudgetInstruction,
    fetchGlobal,
    resetCaches,
    CU_LIMIT_SOL_LAUNCH,
    CU_LIMIT_TOKEN_LAUNCH,
};
