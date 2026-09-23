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
        const response = await axios.get(url, { timeout: 15000 }); // v28.2: no more open-ended hangs
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
    }, { timeout: 15000 }); // v28.2

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

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * What `amount` base units of `inputMint` are worth in lamports, without swapping.
 *
 * v30.1: needed because Custom Pairs let a coin be quoted in a tokenised asset, so creator
 * fees accrue in that asset rather than in SOL. The fee-collection threshold, the airdrop
 * pools and the 50/25/24.5/0.5 split are all lamport-denominated, so a token balance has to
 * be priced before it can be compared against any of them.
 *
 * Returns lamports as a Number, or null when no route exists (an illiquid quote asset is a
 * real possibility) — callers must treat null as "unknown", not as zero.
 */
async function quoteTokenToSol(inputMint, amount, slippageBps = 100) {
    const amt = typeof amount === 'string' ? amount : String(amount);
    if (!amt || amt === '0') return 0;

    const quote = await getQuote(inputMint.toString(), WSOL_MINT, amt, slippageBps);
    if (!quote || !quote.outAmount) return null;
    return Number(quote.outAmount);
}

/**
 * Swap a token balance back to native SOL.
 *
 * The mirror of swapSolToToken, and the second half of multi-quote fee collection: fees are
 * claimed into our quote ATAs, then converted here so everything downstream stays in
 * lamports. `wrapAndUnwrapSol` closes the intermediate WSOL account, so the proceeds land as
 * native SOL in the wallet rather than as a token balance.
 *
 * Returns `{ signature, outAmount }` with outAmount in lamports, or null on any failure. A
 * failure leaves the tokens untouched in the ATA, which is the safe direction: nothing is
 * credited that was not received.
 *
 * outAmount is the route's `otherAmountThreshold` — the slippage-guaranteed minimum — not its
 * optimistic `outAmount`. The caller credits holder pools from this figure and cannot measure
 * the real proceeds from a wallet balance delta (in `full` mode the deploy worker spends from
 * the same wallet concurrently), so it must not be an estimate that can come in high: the
 * platform under-crediting itself is recoverable, promising holders SOL it never received is
 * not.
 */
async function swapTokenToSol(amountBaseUnits, inputMint, wallet, connection, slippageBps = 100) {
    try {
        const amt = typeof amountBaseUnits === 'string' ? amountBaseUnits : String(amountBaseUnits);
        if (!amt || amt === '0') return null;

        const quoteResponse = await getQuote(inputMint.toString(), WSOL_MINT, amt, slippageBps);
        if (!quoteResponse) throw new Error('Failed to get Jupiter quote');

        const swapTransactionBase64 = await getSwapTransaction(quoteResponse, wallet.publicKey, true);

        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransactionBase64, 'base64'));
        transaction.sign([wallet]);

        const sig = await connection.sendTransaction(transaction, {
            skipPreflight: true,
            maxRetries: 2
        });

        await connection.confirmTransaction(sig, 'confirmed');

        const guaranteed = Number(quoteResponse.otherAmountThreshold ?? quoteResponse.outAmount);

        logger.info(`Jupiter swap completed: ${inputMint.toString().slice(0, 5)}... -> SOL`, {
            signature: sig, inAmount: amt, outAmount: quoteResponse.outAmount, credited: guaranteed
        });

        return { signature: sig, outAmount: guaranteed };
    } catch (e) {
        logger.error('Jupiter Swap Error (token -> SOL)', { error: e.message, inputMint: inputMint.toString() });
        return null;
    }
}

module.exports = {
    getQuote,
    getSwapTransaction,
    swapSolToToken,
    swapSolToUsdc,
    swapTokenToSol,
    quoteTokenToSol,
    WSOL_MINT
};
