/**
 * Solana Service
 * Connection, transaction helpers, and wallet management
 */
const { Connection, Keypair, ComputeBudgetProgram, PublicKey } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const config = require('../config/env');
const logger = require('./logger');

// Every RPC request gets a hard timeout. web3.js has none by default, and a request that
// never returns would otherwise leave a background loop's overlap guard set forever.
const fetchWithTimeout = (url, options = {}) =>
    fetch(url, { ...options, signal: AbortSignal.timeout(config.RPC_TIMEOUT_MS) });

// The single RPC connection shared by the routes, tasks and this module's helpers.
const connection = new Connection(config.RPC_URL, {
    commitment: 'confirmed',
    fetch: fetchWithTimeout,
});

// Initialize dev wallet
let devKeypair = null;
let wallet = null;

if (config.DEV_WALLET_PRIVATE_KEY) {
    try {
        devKeypair = Keypair.fromSecretKey(bs58.decode(config.DEV_WALLET_PRIVATE_KEY));
        wallet = new Wallet(devKeypair);
        logger.info(`RPC: ${config.HELIUS_API_KEY ? 'Helius' : 'Public'}`);
    } catch (e) {
        logger.error('Failed to initialize dev wallet', { error: e.message });
    }
}

/**
 * Add priority fee instructions to a transaction.
 * `units` is the compute-unit limit; the priority fee is charged on the requested
 * limit, so callers with small transactions should pass a smaller number.
 */
function addPriorityFee(tx, units = 300000) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICRO_LAMPORTS }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    return tx;
}

// Errors that will not go away by re-sending the same instructions.
const PERMANENT_ERROR_PATTERNS = [
    /InstructionError/i,
    /custom program error/i,
    /Simulation failed/i,
    /insufficient (funds|lamports)/i,
    /Attempt to debit an account but found no record of a prior credit/i,
    /already in use/i,
    /AccountNotFound/i,
    /invalid account data/i,
    /failed on chain/i,
];

function isPermanentError(err) {
    if (!err) return false;
    if (err.permanent) return true;
    const msg = String(err.message || err);
    return PERMANENT_ERROR_PATTERNS.some(re => re.test(msg));
}

/**
 * Look up whether a signature already landed. Returns 'confirmed', 'failed', or 'unknown'.
 * Used before re-sending so a transaction whose confirmation merely timed out is not
 * executed a second time.
 */
async function getLandedStatus(sig) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
            const status = res?.value?.[0];
            if (!status) return 'unknown';
            if (status.err) return 'failed';
            if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return 'confirmed';
            return 'unknown';
        } catch (e) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }
    return 'unknown';
}

/**
 * Send transaction with retry logic.
 *
 * - Blockhash is fetched at `confirmed` so the transaction has its full validity window.
 * - Preflight simulation is on by default; pass { skipPreflight: true } only for
 *   latency-sensitive sends where a failed simulation is cheaper than the delay.
 * - Errors that cannot succeed on retry (program errors, insufficient funds) throw immediately.
 * - Before any re-send the original signature is checked on chain; if it landed, it is
 *   returned instead of executing the same instructions again.
 */
async function sendTxWithRetry(tx, signers, retries = 5, options = {}) {
    const { skipPreflight = false } = options;
    let lastErr = null;

    for (let i = 0; i < retries; i++) {
        let sig = null;
        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            tx.sign(...signers);
            sig = bs58.encode(tx.signature);

            await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight,
                preflightCommitment: 'confirmed',
                maxRetries: 3,
            });

            const conf = await connection.confirmTransaction(
                { signature: sig, blockhash, lastValidBlockHeight },
                'confirmed'
            );
            if (conf.value.err) {
                const err = new Error(`Transaction ${sig} failed on chain: ${JSON.stringify(conf.value.err)}`);
                err.permanent = true;
                throw err;
            }
            return sig;
        } catch (err) {
            lastErr = err;
            if (isPermanentError(err)) throw err;

            // The send may have landed even though we did not see the confirmation.
            if (sig) {
                const landed = await getLandedStatus(sig);
                if (landed === 'confirmed') {
                    logger.warn(`Transaction ${sig} landed despite confirmation error; not re-sending`, { error: err.message });
                    return sig;
                }
                if (landed === 'failed') {
                    const failed = new Error(`Transaction ${sig} failed on chain`);
                    failed.permanent = true;
                    throw failed;
                }
            }

            if (i === retries - 1) break;
            logger.warn(`Transaction attempt ${i + 1}/${retries} failed, retrying`, { error: err.message });
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw lastErr;
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

module.exports = {
    connection,
    devKeypair,
    wallet,
    addPriorityFee,
    sendTxWithRetry,
    isPermanentError,
    getBalance,
    getLatestBlockhash,
};
