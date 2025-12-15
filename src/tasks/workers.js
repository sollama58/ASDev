/**
 * Workers Module
 * Deploy and social queue workers
 */
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const {
    getAssociatedTokenAddress, createCloseAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const config = require('../config/env');
const { PROGRAMS, WALLETS } = require('../config/constants');
const { logger, redis, pump, vanity, solana, twitter } = require('../services');

/**
 * Initialize deploy worker
 */
function initDeployWorker(deps) {
    const { connection, devKeypair, db, saveTokenData, addFees, refundUser, globalState } = deps;

    const worker = redis.createWorker('deployQueue', async (job) => {
        logger.info(`STARTING JOB ${job.id}: ${job.data.ticker}`);
        const { name, ticker, description, twitter: twitterHandle, website, image, userPubkey, isMayhemMode, metadataUri } = job.data;

        try {
            if (!metadataUri) throw new Error("Metadata URI missing");
            const mintKeypair = await vanity.getMintKeypair();
            const mint = mintKeypair.publicKey;
            const creator = devKeypair.publicKey;

            // PDAs
            const { global, bondingCurve, associatedBondingCurve, eventAuthority, feeConfig, globalVolumeAccumulator } = pump.getPumpPDAs(mint);
            const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PROGRAMS.PUMP);
            const [metadata] = PublicKey.findProgramAddressSync(
                [Buffer.from("metadata"), PROGRAMS.METADATA.toBuffer(), mint.toBuffer()],
                PROGRAMS.METADATA
            );
            const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PROGRAMS.PUMP);
            const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), creator.toBuffer()], PROGRAMS.PUMP);

            // Mayhem PDAs
            const [mayhemState] = PublicKey.findProgramAddressSync([Buffer.from("mayhem-state"), mint.toBuffer()], PROGRAMS.MAYHEM);
            const mayhemTokenVault = pump.getATA(mint, WALLETS.SOL_VAULT, PROGRAMS.TOKEN_2022);

            // Create instruction
            const createData = pump.buildCreateInstructionData(name, ticker, metadataUri, creator, isMayhemMode);
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

            // Buy instruction
            const feeRecipient = isMayhemMode ? WALLETS.MAYHEM_FEE : WALLETS.FEE_STANDARD;
            const associatedUser = pump.getATA(mint, creator, PROGRAMS.TOKEN_2022);

            const solBuyAmount = Math.floor(0.01 * LAMPORTS_PER_SOL);
            const tokenBuyAmount = pump.calculateTokensForSol(solBuyAmount);
            const buyData = pump.buildBuyInstructionData(tokenBuyAmount, new BN(Math.floor(solBuyAmount * 1.05)));

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

            // Create ATA instruction
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

            logger.info(`Sending Transaction... Buy Amount: ${tokenBuyAmount.toString()} tokens.`);
            const sig = await solana.sendTxWithRetry(tx, [devKeypair, mintKeypair]);
            logger.info(`Transaction Confirmed: ${sig}`);

            await saveTokenData(userPubkey, mint.toString(), { name, ticker, description, twitter: twitterHandle, website, image, isMayhemMode, metadataUri });

            // Queue social post
            await redis.addSocialJob({ name, ticker, mint: mint.toString() });

            // Sell tokens after delay
            setTimeout(async () => {
                try {
                    const bal = await connection.getTokenAccountBalance(associatedUser);
                    if (bal.value?.uiAmount > 0) {
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
                        await solana.sendTxWithRetry(sellTx, [devKeypair]);
                        logger.info(`Sold & Closed Account for ${ticker}`);
                    }
                } catch (e) {
                    logger.error("Sell error", { msg: e.message });
                }
            }, 1500);

            return { mint: mint.toString(), signature: sig };

        } catch (jobError) {
            logger.error(`Job Failed: ${jobError.message}`);
            if (userPubkey) await refundUser(userPubkey, "Deployment Failed: " + jobError.message);
            throw jobError;
        }
    }, { concurrency: 1 });

    logger.info("Deploy worker initialized");
    return worker;
}

/**
 * Initialize social worker
 */
function initSocialWorker(deps) {
    const { db } = deps;

    const worker = redis.createWorker('socialQueue', async (job) => {
        const { name, ticker, mint } = job.data;

        const tweetUrl = await twitter.postLaunchTweet(name, ticker, mint);

        if (tweetUrl && db) {
            await db.run('UPDATE tokens SET tweetUrl = ? WHERE mint = ?', [tweetUrl, mint]);
        }

        return tweetUrl;
    });

    logger.info("Social worker initialized");
    return worker;
}

module.exports = { initDeployWorker, initSocialWorker };
