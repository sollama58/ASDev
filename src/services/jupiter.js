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

    try {
        const response = await axios.get(url);
        return response.data;
    } catch (e) {
        logger.error("Jupiter Quote API Error", { error: e.message });
        return null;
    }
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
 * Swap SOL to a specific Token
 */
async function swapSolToToken(amountLamports, outputMint, wallet, connection) {
    try {
        // 1. Get Quote (SOL -> Token)
        // Input is always WSOL for SOL swaps
        const quoteResponse = await getQuote(
            'So11111111111111111111111111111111111111112', // WSOL Mint
            outputMint.toString(),
            amountLamports
        );

        if (!quoteResponse) throw new Error("Failed to get Jupiter quote");

        // 2. Get Transaction
        const swapTransactionBase64 = await getSwapTransaction(
            quoteResponse,
            wallet.publicKey
        );

        // 3. Sign and Send
        const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        const sig = await connection.sendTransaction(transaction, {
            skipPreflight: true,
            maxRetries: 2
        });

        await connection.confirmTransaction(sig, 'confirmed');
        
        logger.info(`Jupiter swap completed: SOL -> ${outputMint.toString().slice(0, 5)}...`, { signature: sig, outAmount: quoteResponse.outAmount });
        
        return { signature: sig, outAmount: quoteResponse.outAmount };
    } catch (e) {
        logger.error("Jupiter Swap Error", { error: e.message });
        return null;
    }
}

/**
 * Legacy wrapper for backward compatibility if needed
 */
async function swapSolToUsdc(amountLamports, wallet, connection) {
    return swapSolToToken(amountLamports, TOKENS.USDC, wallet, connection);
}

module.exports = {
    getQuote,
    getSwapTransaction,
    swapSolToToken,
    swapSolToUsdc
};
