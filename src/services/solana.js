/**
 * Solana Service
 * Connection, transaction helpers, and wallet management
 */
const { Connection, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const config = require('../config/env');
const logger = require('./logger');

// Initialize connection with timeout
// v25.47 STABILITY: Added timeout to prevent hanging RPC calls
const connection = new Connection(config.RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: config.RPC_TIMEOUT_MS,
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
function addPriorityFee(tx) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICRO_LAMPORTS }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
    return tx;
}

/**
 * Send transaction with retry logic
 */
async function sendTxWithRetry(tx, signers, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            const sig = await sendAndConfirmTransaction(connection, tx, signers, {
                commitment: 'confirmed',
                skipPreflight: true
            });
            return sig;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

/**
 * Refund user on error
 */
async function refundUser(userPubkeyStr, reason) {
    try {
        const userPubkey = new PublicKey(userPubkeyStr);
        const refundAmount = config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL;
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: devKeypair.publicKey,
                toPubkey: userPubkey,
                lamports: refundAmount
            })
        );
        addPriorityFee(tx);
        await sendTxWithRetry(tx, [devKeypair]);
        logger.info(`Refunded ${config.DEPLOYMENT_FEE_SOL} SOL to ${userPubkeyStr}`, { reason });
    } catch (e) {
        logger.error('Refund failed', { error: e.message, user: userPubkeyStr });
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

module.exports = {
    connection,
    devKeypair,
    wallet,
    addPriorityFee,
    sendTxWithRetry,
    refundUser,
    getBalance,
    getLatestBlockhash,
};
