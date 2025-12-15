/**
 * Jupiter Aggregator Service
 * DEX aggregation for token swaps
 */
const axios = require('axios');
const { VersionedTransaction } = require('@solana/web3.js');
const { TOKENS } = require('../config/constants');
const logger = require('./logger');

/**
 * Get quote for token swap
 * Updated: Using new Jupiter lite-api endpoint (Dec 2025)
 */
async function getQuote(inputMint, outputMint, amountIn, slippageBps = 100) {
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountIn}&slippageBps=${slippageBps}`;

    const response = await axios.get(url);
    return response.data;
}

/**
 * Get swap transaction
 * Updated: Using new Jupiter lite-api endpoint (Dec 2025)
 */
async function getSwapTransaction(quoteResponse, userPublicKey, wrapAndUnwrapSol = true) {
    const response = await axios.post('https://lite-api.jup.ag/swap/v1/swap', {
        quoteResponse,
        userPublicKey: userPublicKey.toString(),
        wrapAndUnwrapSol
    });

    return response.data.swapTransaction;
}

/**
 * Swap SOL to USDC
 */
async function swapSolToUsdc(amountLamports, wallet, connection) {
    try {
        const quoteResponse = await getQuote(
            'So11111111111111111111111111111111111111112',
            TOKENS.USDC.toString(),
            amountLamports
        );

        const swapTransactionBase64 = await getSwapTransaction(
            quoteResponse,
            wallet.publicKey
        );

        const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        const sig = await connection.sendTransaction(transaction, {
            skipPreflight: true,
            maxRetries: 2
        });

        await connection.confirmTransaction(sig, 'confirmed');
        logger.info("Jupiter swap completed", { signature: sig });
        return sig;
    } catch (e) {
        logger.error("Jupiter Swap Error", { error: e.message });
        return null;
    }
}

module.exports = {
    getQuote,
    getSwapTransaction,
    swapSolToUsdc,
};
