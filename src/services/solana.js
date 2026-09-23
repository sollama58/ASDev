/**
 * Solana Service
 * Connection, transaction helpers, and wallet management
 */
const { Connection, ComputeBudgetProgram, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const config = require('../config/env');
const logger = require('./logger');

// Initialize connection with timeout
// v25.47 STABILITY: Added timeout to prevent hanging RPC calls
const connection = new Connection(config.RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: config.RPC_TIMEOUT_MS,
    // v30.2: web3.js otherwise retries every 429 itself (up to 5 times), silently multiplying
    // request volume exactly when the provider is asking us to slow down. Callers here already
    // treat a failed read as "try next cycle".
    disableRetryOnRateLimit: true,
    fetch: (url, options) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.RPC_TIMEOUT_MS);
        return fetch(url, { ...options, signal: controller.signal })
            .finally(() => clearTimeout(timeout));
    }
});

// Dev wallet keypair is decoded once in config/env.js and redacted there
const devKeypair = config.devKeypair;
const wallet = devKeypair ? new Wallet(devKeypair) : null;
if (devKeypair) {
    logger.info(`RPC: ${config.HELIUS_API_KEY ? 'Helius' : 'Public'}`);
}

/**
 * Add priority fee instructions to a transaction
 */
/**
 * Add the compute-budget instructions.
 *
 * v30.0: the unit limit is a parameter. A transaction may carry only ONE SetComputeUnitLimit
 * instruction -- a second is rejected outright -- so a caller that needs a different budget
 * has to say so here rather than adding its own alongside this one. Token-quoted launches
 * need roughly 500k against the 300k that suits everything else.
 */
function addPriorityFee(tx, { units = 300000 } = {}) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICRO_LAMPORTS }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    return tx;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// How often we re-broadcast the same signed transaction while waiting for it to confirm.
const REBROADCAST_INTERVAL_MS = 2500;
// Re-broadcasting is free of correctness risk but not of RPC cost, so the authoritative
// "has this blockhash expired yet" check runs once every Nth poll rather than every poll.
const HEIGHT_CHECK_EVERY = 4;

/**
 * Status of a transaction whose blockhash has already expired: 'landed', or 'absent'. Throws
 * if it landed but failed, matching confirmOrExpire. searchTransactionHistory covers the case
 * where the transaction has already aged out of the recent status cache. If the lookup itself
 * keeps failing, we cannot prove absence, so we refuse to report it as absent: throwing makes
 * the caller stop rather than re-send.
 */
async function finalStatus(signature) {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
        try {
            const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
            const st = value?.[0];
            if (!st) return 'absent';
            if (st.err) throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(st.err)}`);
            return 'landed';
        } catch (e) {
            if (e.message && e.message.includes('failed on-chain')) throw e;
            lastErr = e;
            await sleep(1000);
        }
    }
    throw new Error(`Could not determine whether ${signature} landed (${lastErr?.message}); not re-sending`);
}

/**
 * Wait for a specific, already-signed transaction to either confirm or provably expire.
 *
 * Returns the signature once confirmed, or null once the blockhash has expired -- and null
 * is a *guarantee* that the transaction did not land and never can, because a transaction is
 * only valid while its recent blockhash is within the last 150 blocks. Throws if the
 * transaction landed but failed on-chain, since re-sending that is pointless.
 *
 * Re-broadcasting the identical serialized transaction is safe: the cluster de-duplicates by
 * signature, so a transaction that already landed is simply rejected as a duplicate.
 */
async function confirmOrExpire(signature, rawTx, lastValidBlockHeight) {
    for (let poll = 0; ; poll++) {
        let status = null;
        try {
            status = (await connection.getSignatureStatus(signature)).value;
        } catch (e) {
            // A failed status lookup tells us nothing either way -- keep waiting.
            logger.debug('Signature status lookup failed', { signature, error: e.message });
        }

        if (status) {
            if (status.err) {
                throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
            }
            if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                return signature;
            }
        }

        if (poll > 0 && poll % HEIGHT_CHECK_EVERY === 0) {
            let expired = false;
            try {
                const height = await connection.getBlockHeight('confirmed');
                expired = height > lastValidBlockHeight;
            } catch (e) {
                logger.debug('Block height check failed', { error: e.message });
            }
            if (expired) {
                // v30.2: one last look before declaring the transaction dead. The status check
                // at the top of this iteration ran BEFORE the height check, so a transaction
                // that landed in one of the final valid blocks in between would otherwise be
                // reported as expired -- and the caller would re-sign and send it again, which
                // on an airdrop or refund is a second real payment. Once the height is past
                // lastValidBlockHeight nothing new can land, so this answer is final.
                const final = await finalStatus(signature);
                if (final === 'landed') return signature;
                return null;
            }
        }

        await sleep(REBROADCAST_INTERVAL_MS);

        try {
            // maxRetries: 0 because this loop owns re-broadcasting.
            await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
        } catch (e) {
            // Duplicate-signature rejections and transient send failures are both expected here.
            logger.debug('Re-broadcast failed', { signature, error: e.message });
        }
    }
}

/**
 * Send a transaction, retrying until it lands.
 *
 * v27.6 CORRECTNESS: the previous implementation fetched a *fresh blockhash inside every retry
 * iteration*, so each retry produced a different transaction with a different signature, and it
 * caught every error -- including confirmation timeouts. A transaction that had actually landed
 * but timed out waiting for 'confirmed' was therefore re-signed and re-sent as an independently
 * valid transaction, up to 5 times. On the airdrop and fee-claim paths that is a real duplicate
 * transfer of real SOL.
 *
 * Now: sign once per blockhash, then re-broadcast that *same* signed transaction until it either
 * confirms or its blockhash provably expires. Only an expired blockhash -- which guarantees the
 * signed transaction can never land -- permits re-signing with a new one.
 */
async function sendTxWithRetry(tx, signers, retries = 5) {
    let lastErr = null;

    for (let attempt = 0; attempt < retries; attempt++) {
        // 'confirmed', not 'finalized': a finalized blockhash is already ~32 slots old, which
        // throws away a fifth of the ~150-block validity window for no safety benefit here.
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        if (!tx.feePayer) tx.feePayer = signers[0].publicKey;

        // Transaction.sign() rebuilds the signature list from scratch, so this is safe to
        // call again on a transaction that was signed under a previous (now expired) blockhash.
        tx.sign(...signers);

        const rawTx = tx.serialize();
        const signature = bs58.encode(tx.signature);

        try {
            await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
        } catch (e) {
            // The send itself failing does not mean the transaction cannot land -- another
            // broadcast may already have reached a leader. Fall through to confirmOrExpire,
            // which decides based on chain state rather than on this RPC call's outcome.
            logger.debug('Initial broadcast failed, falling back to confirmation polling', {
                signature, error: e.message
            });
        }

        try {
            const confirmed = await confirmOrExpire(signature, rawTx, lastValidBlockHeight);
            if (confirmed) return confirmed;
            // null => blockhash expired, transaction definitively did not land. Safe to re-sign.
            lastErr = new Error(`Transaction ${signature} expired without landing`);
            logger.warn('Transaction expired without landing, retrying with a new blockhash', {
                signature, attempt: attempt + 1, retries
            });
        } catch (e) {
            // Landed and failed on-chain: deterministic, so retrying just burns fees.
            throw e;
        }
    }

    throw lastErr || new Error('sendTxWithRetry exhausted all attempts');
}

/**
 * Refund a user whose launch failed.
 *
 * v29.2: the single implementation (index.js and worker.js delegate here).
 * The 0.001 SOL held back covers the network cost of the refund transfer itself, so a failed
 * launch does not also cost the platform the fee to undo it.
 *
 * v30.2: idempotent. When the payment signature is known, the refund is first CLAIMED on that
 * payment's row in `transactions` with a conditional UPDATE; only the caller that wins the
 * claim sends. A launch job that is retried, reconciled after a stall, or failed twice by
 * different code paths can therefore refund at most once. A refund whose send fails releases
 * the claim so it can be retried. Callers without a payment signature (none in the launch
 * path) keep the old unguarded behaviour.
 *
 * @param {string} userPubkeyStr
 * @param {string} reason
 * @param {string|null} [paymentSig] - the user's launch-fee transaction signature
 * @returns {Promise<string|null>} the refund signature, 'already-refunded', or null on failure
 */
async function refundUser(userPubkeyStr, reason, paymentSig = null) {
    const pg = require('./postgres');
    const db = pg.getDB && pg.getDB();

    if (paymentSig && db) {
        const claim = await db.run(
            `UPDATE transactions SET refund_sig = 'pending', refunded_at = $2
              WHERE signature = $1 AND refund_sig IS NULL`,
            [paymentSig, Date.now()]
        ).catch(e => ({ changes: 0, error: e }));
        if (!claim.changes) {
            logger.warn('Refund skipped: already refunded or payment unknown', {
                user: userPubkeyStr, payment: String(paymentSig).slice(0, 16), error: claim.error?.message
            });
            return 'already-refunded';
        }
    }

    try {
        const userPubkey = new PublicKey(userPubkeyStr);
        const tx = new Transaction();
        addPriorityFee(tx, { units: 10_000 });
        tx.add(SystemProgram.transfer({
            fromPubkey: devKeypair.publicKey,
            toPubkey: userPubkey,
            lamports: Math.floor((config.DEPLOYMENT_FEE_SOL - 0.001) * LAMPORTS_PER_SOL)
        }));
        const sig = await sendTxWithRetry(tx, [devKeypair]);

        if (paymentSig && db) {
            await db.run('UPDATE transactions SET refund_sig = $2 WHERE signature = $1', [paymentSig, sig]).catch(() => {});
        }

        // v29.1: reverse the fee in the lifetime counters -- only on a confirmed refund.
        await pg.subtractFees(config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL)
            .catch(e => logger.warn('Refund sent but fee counters not reversed', { error: e.message }));

        logger.info(`REFUNDED ${userPubkeyStr}: ${sig} (Reason: ${reason})`);
        return sig;
    } catch (e) {
        logger.error(`REFUND FAILED: ${e.message}`, { user: userPubkeyStr, reason });
        if (paymentSig && db) {
            // Release the claim so the refund can be retried. If the failure was ambiguous
            // (sendTxWithRetry could not tell whether it landed) keep the claim: an operator
            // must check the chain rather than risk paying twice.
            const ambiguous = /Could not determine/.test(e.message || '');
            if (!ambiguous) {
                await db.run(`UPDATE transactions SET refund_sig = NULL, refunded_at = NULL
                               WHERE signature = $1 AND refund_sig = 'pending'`, [paymentSig]).catch(() => {});
            }
        }
        return null;
    }
}

/**
 * Get wallet balance
 */
async function getBalance(pubkey) {
    return connection.getBalance(typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey);
}

/**
 * Get latest blockhash
 */
async function getLatestBlockhash() {
    return connection.getLatestBlockhash('finalized');
}

// Rent-exempt minimums are a function of account data length only, and change no more often
// than a cluster rent-parameter change, so one lookup per distinct size lasts the process.
const rentExemptCache = new Map(); // dataLength -> lamports

/**
 * Minimum lamports an account of `dataLength` bytes must hold to stay rent-exempt.
 *
 * v27.6: the fee scanners each hardcoded a 5000-lamport "buffer matching health.js" as the
 * floor below which a pump creator vault holds no claimable fees. That number was a guess,
 * and if the real floor is higher -- a 0-data system account needs 890,880 -- then every
 * vault permanently reported the difference as phantom pending fees, so the scanners built a
 * claim transaction on every pass that moved nothing and credited users for SOL that was
 * never claimable. Asking the cluster for the true figure, keyed on the vault's own data
 * length, is correct whichever way that question resolves, and self-corrects if pump ever
 * changes the account layout.
 *
 * Falls back to the old constant if the lookup fails, so an RPC blip degrades to today's
 * behaviour rather than blocking fee collection entirely.
 */
async function getRentExemptMinimum(dataLength = 0, fallbackLamports = 5000) {
    if (rentExemptCache.has(dataLength)) return rentExemptCache.get(dataLength);
    try {
        const lamports = await connection.getMinimumBalanceForRentExemption(dataLength);
        rentExemptCache.set(dataLength, lamports);
        logger.info('Resolved rent-exempt minimum from cluster', { dataLength, lamports });
        return lamports;
    } catch (e) {
        logger.warn('Rent-exempt minimum lookup failed, using fallback', {
            dataLength, fallbackLamports, error: e.message
        });
        return fallbackLamports;
    }
}

module.exports = {
    connection,
    devKeypair,
    wallet,
    addPriorityFee,
    sendTxWithRetry,
    refundUser,
    getBalance,
    getLatestBlockhash,
    getRentExemptMinimum,
};
