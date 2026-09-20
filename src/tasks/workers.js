/**
 * Workers Module
 * Deploy queue worker
 */
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const { createCloseAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const config = require('../config/env');
const { PROGRAMS, WALLETS } = require('../config/constants');
const { logger, redis, pump, vanity, solana } = require('../services');

const SELL_DELAY_MS = 1500;
const SELL_ATTEMPTS = 3;
const SELL_RETRY_DELAY_MS = 3000;

/**
 * Sell whatever the dev wallet holds of a freshly launched token and close the account.
 * Up to SELL_ATTEMPTS tries; the balance is re-read each time so a sell that landed
 * without a confirmation is not repeated.
 */
async function sellLaunchTokens(ctx) {
    const { connection, devKeypair, mint, ticker, associatedUser, bondingCurve, associatedBondingCurve,
            feeRecipient, creatorVault, global, eventAuthority, feeConfig } = ctx;
    const creator = devKeypair.publicKey;

    for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt++) {
        try {
            const bal = await connection.getTokenAccountBalance(associatedUser);
            if (!(bal.value?.uiAmount > 0)) {
                if (attempt > 1) logger.info(`Launch tokens for ${ticker} already sold`);
                return;
            }
            const sellData = pump.buildSellInstructionData(new BN(bal.value.amount));
            const sellKeys = [
                { pubkey: global, isSigner: false, isWritable: false },
                { pubkey: feeRecipient, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: bondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedUser, isSigner: false, isWritable: true },
                { pubkey: creator, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: creatorVault, isSigner: false, isWritable: true },
                { pubkey: PROGRAMS.TOKEN_2022, isSigner: false, isWritable: false },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false },
                { pubkey: feeConfig, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.FEE, isSigner: false, isWritable: false }
            ];
            const sellIx = new TransactionInstruction({ keys: sellKeys, programId: PROGRAMS.PUMP, data: sellData });
            const closeIx = createCloseAccountInstruction(associatedUser, creator, creator, [], PROGRAMS.TOKEN_2022);
            const sellTx = new Transaction();
            solana.addPriorityFee(sellTx);
            sellTx.add(sellIx).add(closeIx);
            sellTx.feePayer = creator;
            await solana.sendTxWithRetry(sellTx, [devKeypair]);
            logger.info(`Sold & Closed Account for ${ticker}`);
            return;
        } catch (e) {
            if (attempt < SELL_ATTEMPTS) {
                logger.warn(`Sell attempt ${attempt}/${SELL_ATTEMPTS} failed for ${ticker}, retrying`, { error: e.message });
                await new Promise(r => setTimeout(r, SELL_RETRY_DELAY_MS));
            } else {
                logger.error(`Sell failed for ${ticker}; launch tokens remain in the dev wallet`, { mint: mint.toString(), error: e.message });
            }
        }
    }
}

/**
 * Initialize deploy worker
 */
function initDeployWorker(deps) {
    const { connection, devKeypair, db, saveTokenData, refundUser } = deps;

    const worker = redis.createWorker('deployQueue', async (job) => {
        logger.info(`STARTING JOB ${job.id}: ${job.data.ticker}`);
        
        // Image here is now the URL passed from deploy route, NOT base64
        const { name, ticker, description, twitter: twitterHandle, website, image, userPubkey, userTx, isMayhemMode, metadataUri } = job.data;

        try {
            if (!metadataUri) throw new Error("Metadata URI missing");
            const mintKeypair = await vanity.getMintKeypair();
            const mint = mintKeypair.publicKey;
            const creator = devKeypair.publicKey;

            // ... (Keep existing PDA derivation and Transaction Construction logic) ...
            const { global, bondingCurve, associatedBondingCurve, eventAuthority, feeConfig, globalVolumeAccumulator } = pump.getPumpPDAs(mint);
            const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PROGRAMS.PUMP);
            const [metadata] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), PROGRAMS.METADATA.toBuffer(), mint.toBuffer()], PROGRAMS.METADATA);
            const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PROGRAMS.PUMP);
            const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), creator.toBuffer()], PROGRAMS.PUMP);
            const [mayhemState] = PublicKey.findProgramAddressSync([Buffer.from("mayhem-state"), mint.toBuffer()], PROGRAMS.MAYHEM);
            const mayhemTokenVault = pump.getATA(mint, WALLETS.SOL_VAULT, PROGRAMS.TOKEN_2022);

            const createData = pump.buildCreateInstructionData(name, ticker, metadataUri, creator, isMayhemMode);
            // ... (Keep keys array) ...
            const createKeys = [
                { pubkey: mint, isSigner: true, isWritable: true },
                { pubkey: mintAuthority, isSigner: false, isWritable: false },
                { pubkey: bondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                { pubkey: global, isSigner: false, isWritable: false },
                { pubkey: creator, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.TOKEN_2022, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.MAYHEM, isSigner: false, isWritable: true },
                { pubkey: WALLETS.GLOBAL_PARAMS, isSigner: false, isWritable: false },
                { pubkey: WALLETS.SOL_VAULT, isSigner: false, isWritable: true },
                { pubkey: mayhemState, isSigner: false, isWritable: true },
                { pubkey: mayhemTokenVault, isSigner: false, isWritable: true },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false }
            ];
            const createIx = new TransactionInstruction({ keys: createKeys, programId: PROGRAMS.PUMP, data: createData });

            const feeRecipient = isMayhemMode ? WALLETS.MAYHEM_FEE : WALLETS.FEE_STANDARD;
            const associatedUser = pump.getATA(mint, creator, PROGRAMS.TOKEN_2022);
            const solBuyAmount = Math.floor(0.01 * LAMPORTS_PER_SOL);
            const tokenBuyAmount = pump.calculateTokensForSol(solBuyAmount);
            const buyData = pump.buildBuyInstructionData(tokenBuyAmount, new BN(Math.floor(solBuyAmount * 1.05)));
            // ... (Keep buy keys) ...
            const buyKeys = [
                { pubkey: global, isSigner: false, isWritable: false },
                { pubkey: feeRecipient, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: bondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedUser, isSigner: false, isWritable: true },
                { pubkey: creator, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.TOKEN_2022, isSigner: false, isWritable: false },
                { pubkey: creatorVault, isSigner: false, isWritable: true },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.PUMP, isSigner: false, isWritable: false },
                { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
                { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
                { pubkey: feeConfig, isSigner: false, isWritable: false },
                { pubkey: PROGRAMS.FEE, isSigner: false, isWritable: false }
            ];
            const buyIx = new TransactionInstruction({ keys: buyKeys, programId: PROGRAMS.PUMP, data: buyData });

            const createATAIx = new TransactionInstruction({
                keys: [
                    { pubkey: creator, isSigner: true, isWritable: true },
                    { pubkey: associatedUser, isSigner: false, isWritable: true },
                    { pubkey: creator, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: PROGRAMS.TOKEN_2022, isSigner: false, isWritable: false },
                ],
                programId: ASSOCIATED_TOKEN_PROGRAM_ID,
                data: Buffer.alloc(0),
            });

            const tx = new Transaction();
            solana.addPriorityFee(tx);
            tx.add(createIx).add(createATAIx).add(buyIx);
            tx.feePayer = creator;

            logger.info(`Sending Transaction...`);
            // Preflight is skipped here only: the create must land fast and a failed simulation costs a retry cycle
            const sig = await solana.sendTxWithRetry(tx, [devKeypair, mintKeypair], 5, { skipPreflight: true });
            logger.info(`Transaction Confirmed: ${sig}`);

            // CRITICAL: Save data with the explicit Image URL we got from Pinata
            await saveTokenData(userPubkey, mint.toString(), { 
                name, ticker, description, twitter: twitterHandle, 
                website, image, // <-- This is now the URL
                isMayhemMode, metadataUri 
            });

            // Sell the initial buy back once the create has settled. Retried, because a
            // failed sell would otherwise leave the tokens (and the SOL in them) in the
            // dev wallet with nothing to try again.
            setTimeout(() => sellLaunchTokens({
                connection, devKeypair, mint, ticker, associatedUser, bondingCurve,
                associatedBondingCurve, feeRecipient, creatorVault, global, eventAuthority, feeConfig
            }), SELL_DELAY_MS);

            return { mint: mint.toString(), signature: sig };

        } catch (jobError) {
            logger.error(`Job Failed: ${jobError.message}`);
            // Refund only the wallet that the deploy route verified as the payer of
            // this signature. Never trust job.data.userPubkey on its own.
            const payment = userTx && db
                ? await db.get('SELECT userPubkey FROM transactions WHERE signature = ? AND type = ?', [userTx, 'deployment'])
                : null;
            if (payment?.userPubkey) {
                await refundUser(payment.userPubkey, "Deployment Failed: " + jobError.message);
            } else {
                logger.warn(`No verified payment for job ${job.id}; skipping refund`, { userTx, userPubkey });
            }
            throw jobError;
        }
    }, { concurrency: 1 });

    logger.info("Deploy worker initialized");
    return worker;
}

module.exports = { initDeployWorker, sellLaunchTokens };
