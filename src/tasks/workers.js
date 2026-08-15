/**
 * Workers Module
 * Deploy, social, and background task workers
 * v13.0 - Added holder scanner, metadata updater, and Robinhood scanner workers
 * v25.4 - Added worker event handlers for debugging job processing issues
 */
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const { createCloseAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const axios = require('axios');
const config = require('../config/env');
const { PROGRAMS, WALLETS, TOKENS } = require('../config/constants');
const { logger, redis, pump, solana, twitter, imageUtils, pinata } = require('../services');

/**
 * Initialize deploy worker
 */
function initDeployWorker(deps) {
    const { connection, devKeypair, db, saveTokenData, refundUser } = deps;

    // Anti-bundling dud token constants
    const DUD_NAME = 'ASDFGHJKL';
    const DUD_TICKER = 'ASDFGHJKL';
    const DUD_IMAGE = 'https://i.imgur.com/dBRNdzu.png';
    const DUD_DESCRIPTION = '';

    /**
     * Build and send a token create+buy transaction on-chain
     * Reusable for both real tokens and anti-bundling duds
     */
    async function launchTokenOnChain({ tokenName, tokenTicker, tokenMetadataUri, useMayhemMode, isDud = false }) {
        const { Keypair } = require('@solana/web3.js');
        const mintKeypair = Keypair.generate();
        const mint = mintKeypair.publicKey;
        const creator = devKeypair.publicKey;

        const { global, bondingCurve, bondingCurveV2, associatedBondingCurve, eventAuthority, feeConfig, globalVolumeAccumulator } = pump.getPumpPDAs(mint);
        const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PROGRAMS.PUMP);
        const [metadata] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), PROGRAMS.METADATA.toBuffer(), mint.toBuffer()], PROGRAMS.METADATA);
        const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PROGRAMS.PUMP);
        const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), creator.toBuffer()], PROGRAMS.PUMP);
        const [mayhemState] = PublicKey.findProgramAddressSync([Buffer.from("mayhem-state"), mint.toBuffer()], PROGRAMS.MAYHEM);
        const mayhemTokenVault = pump.getATA(mint, WALLETS.SOL_VAULT, PROGRAMS.TOKEN_2022);

        const createData = pump.buildCreateInstructionData(tokenName, tokenTicker, tokenMetadataUri, creator, useMayhemMode);
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

        const feeRecipient = useMayhemMode ? WALLETS.MAYHEM_FEE : WALLETS.FEE_STANDARD;
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
            { pubkey: PROGRAMS.FEE, isSigner: false, isWritable: false },
            // v25.47: bondingCurveV2 trailing account — required to prevent 6024 Overflow
            { pubkey: bondingCurveV2, isSigner: false, isWritable: false }
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

        const sig = await solana.sendTxWithRetry(tx, [devKeypair, mintKeypair]);

        // Fire-and-forget sell to recoup SOL
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
                        { pubkey: PROGRAMS.FEE, isSigner: false, isWritable: false },
                        // v25.47: bondingCurveV2 trailing account — required to prevent 6024 Overflow
                        { pubkey: bondingCurveV2, isSigner: false, isWritable: false }
                    ];
                    const sellIx = new TransactionInstruction({ keys: sellKeys, programId: PROGRAMS.PUMP, data: sellData });
                    const closeIx = createCloseAccountInstruction(associatedUser, creator, creator, [], PROGRAMS.TOKEN_2022);
                    const sellTx = new Transaction();
                    solana.addPriorityFee(sellTx);
                    sellTx.add(sellIx).add(closeIx);
                    await solana.sendTxWithRetry(sellTx, [devKeypair]);
                    logger.info(`Sold & Closed Account for ${tokenTicker} (${mint.toString().substring(0, 8)}...)`);
                }
            } catch (e) { logger.error("Sell error", { ticker: tokenTicker, msg: e.message }); }
        }, 1500);

        return { mint, mintKeypair, sig };
    }

    /**
     * Launch anti-bundling dud tokens before the real token
     * Creates 1-5 throwaway tokens to obscure the real launch from bundlers
     */
    async function launchDudTokens(job) {
        const dudCount = Math.floor(Math.random() * 5) + 1; // 1-5 duds
        logger.info(`[Anti-Bundle] Launching ${dudCount} dud token(s) for job ${job.id}`);

        // Upload dud metadata once (reuse for all duds)
        const dudMeta = await pinata.uploadMetadata(DUD_NAME, DUD_TICKER, DUD_DESCRIPTION, '', '', DUD_IMAGE);
        const dudMetadataUri = dudMeta.metadataUri;

        for (let i = 0; i < dudCount; i++) {
            await job.updateProgress({ phase: 'anti-bundle', current: i + 1, total: dudCount });
            try {
                const result = await launchTokenOnChain({
                    tokenName: DUD_NAME,
                    tokenTicker: DUD_TICKER,
                    tokenMetadataUri: dudMetadataUri,
                    useMayhemMode: false,
                    isDud: true
                });
                logger.info(`[Anti-Bundle] Dud ${i + 1}/${dudCount} launched: ${result.mint.toString().substring(0, 12)}...`);
            } catch (dudErr) {
                // Dud failure is non-fatal - log and continue
                logger.warn(`[Anti-Bundle] Dud ${i + 1}/${dudCount} failed (non-fatal)`, { error: dudErr.message });
            }
        }

        logger.info(`[Anti-Bundle] Dud phase complete for job ${job.id}`);
    }

    const worker = redis.createWorker('deployQueue', async (job) => {
        logger.info(`STARTING JOB ${job.id}: ${job.data.ticker}`);

        // Image here is now the URL passed from deploy route, NOT base64
        const { name, ticker, description, twitter: twitterHandle, website, image, userPubkey, isMayhemMode, metadataUri } = job.data;

        // v25.4: Debug logging for image URL tracking
        logger.info(`[Deploy] Job ${job.id} image debug`, {
            ticker,
            imageReceived: !!image,
            imageValue: image ? image.substring(0, 80) : 'NULL/UNDEFINED',
            imageType: typeof image
        });

        try {
            if (!metadataUri) throw new Error("Metadata URI missing");

            // Anti-bundling: Launch dud tokens first
            await launchDudTokens(job);

            // Now launch the real token
            await job.updateProgress({ phase: 'deploying', message: 'Launching your token...' });
            logger.info(`[Deploy] Launching real token: ${ticker}`);

            const { mint, sig } = await launchTokenOnChain({
                tokenName: name,
                tokenTicker: ticker,
                tokenMetadataUri: metadataUri,
                useMayhemMode: isMayhemMode
            });

            logger.info(`[Deploy] Real token confirmed: ${ticker} ${mint.toString()} sig=${sig}`);

            // CRITICAL: Ensure we have the image URL
            // v25.6: If image is missing, fetch it from the metadataUri (IPFS)
            let finalImageUrl = image;
            if (!finalImageUrl || finalImageUrl === '' || finalImageUrl === 'null' || finalImageUrl === 'undefined') {
                logger.info(`[Deploy] Image missing, fetching from metadataUri...`, { ticker, metadataUri: metadataUri?.substring(0, 50) });
                try {
                    const metadataImage = await imageUtils.fetchImageFromMetadataUri(metadataUri, 5000);
                    if (metadataImage) {
                        finalImageUrl = metadataImage;
                        logger.info(`[Deploy] Successfully fetched image from metadataUri`, { ticker, image: metadataImage.substring(0, 50) });
                    } else {
                        logger.warn(`[Deploy] Could not fetch image from metadataUri`, { ticker });
                    }
                } catch (metaErr) {
                    logger.warn(`[Deploy] Failed to fetch metadataUri`, { ticker, error: metaErr.message });
                }
            }

            logger.info(`[Deploy] Saving token to database...`, {
                mint: mint.toString(),
                ticker,
                name,
                userPubkey,
                hasImage: !!finalImageUrl,
                imageSource: image ? 'direct' : (finalImageUrl ? 'metadataUri' : 'none'),
                hasMetadataUri: !!metadataUri
            });

            try {
                await saveTokenData(userPubkey, mint.toString(), {
                    name, ticker, description, twitter: twitterHandle,
                    website, image: finalImageUrl, // v25.6: Use resolved image URL
                    isMayhemMode, metadataUri
                });
                logger.info(`[Deploy] Token saved to database successfully: ${ticker} (${mint.toString()})`);
            } catch (dbError) {
                logger.error(`[Deploy] FAILED to save token to database`, {
                    error: dbError.message,
                    mint: mint.toString(),
                    ticker
                });
                // Don't throw - token was created on-chain, we don't want to refund
                // But log it prominently for debugging
            }

            // Queue social post
            await redis.addSocialJob({ name, ticker, mint: mint.toString() });

            return { mint: mint.toString(), signature: sig };

        } catch (jobError) {
            logger.error(`Job Failed: ${jobError.message}`);
            if (userPubkey) await refundUser(userPubkey, "Deployment Failed: " + jobError.message);
            throw jobError;
        }
    }, { concurrency: 1 });

    // v25.4: Add error handlers for debugging worker issues
    if (worker) {
        worker.on('completed', (job, result) => {
            logger.info(`[DeployWorker] Job ${job.id} completed`, {
                ticker: job.data.ticker,
                mint: result?.mint
            });
        });

        worker.on('failed', (job, err) => {
            logger.error(`[DeployWorker] Job ${job?.id} failed`, {
                ticker: job?.data?.ticker,
                error: err.message,
                stack: err.stack
            });
        });

        worker.on('error', (err) => {
            logger.error('[DeployWorker] Worker error', { error: err.message });
        });

        worker.on('active', (job) => {
            logger.info(`[DeployWorker] Job ${job.id} is now active`, { ticker: job.data.ticker });
        });

        logger.info("Deploy worker initialized with event handlers");
    } else {
        logger.error("Deploy worker failed to initialize - Redis may not be connected");
    }

    return worker;
}

function initSocialWorker(deps) {
    const { db } = deps;
    const worker = redis.createWorker('socialQueue', async (job) => {
        const { name, ticker, mint } = job.data;
        const tweetUrl = await twitter.postLaunchTweet(name, ticker, mint);
        if (tweetUrl && db) {
            await db.run('UPDATE tokens SET "tweetUrl" = $1 WHERE mint = $2', [tweetUrl, mint]);
        }
        return tweetUrl;
    });
    return worker;
}

// ===========================================
// v13.0: Background Task Workers
// ===========================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

/**
 * Initialize Holder Scanner Worker
 * v27.3: Delegates to holderScanner.updateGlobalState() instead of running its own
 * independent copy of the holder scan + points/airdrop calculation.
 *
 * Previously this worker duplicated the entire holder-scanning pipeline (its own
 * getProgramAccounts loop, its own points/expected-airdrop math, its own user_points
 * writes) on a 5-minute interval, while flywheel.js separately triggered
 * holderScanner.updateGlobalState() on every 15-minute airdrop cycle. Both wrote to the
 * same token_holders/user_points tables independently, roughly quadrupling RPC volume
 * for the same scan. The worker's copy was also missing the AMM-pool-holder exclusion
 * that holderScanner.js has (see the ammPoolStr check there) — meaning a graduated
 * token's AMM pool address could be recorded as a top holder and receive a real SOL
 * airdrop share whenever the worker's (stale) scan was the freshest data.
 *
 * holderScanner.updateGlobalState() already has its own mutex (holder_scanner), so
 * calling it from both this worker and flywheel.js is safe — a call that arrives while
 * a scan is already in flight simply returns { scanCompleted: false, skipped: true }
 * instead of running a second concurrent scan.
 */
function initHolderScannerWorker(deps) {
    const holderScanner = require('./holderScanner');

    const worker = redis.createWorker('holderScannerQueue', async (job) => {
        logger.info('[Worker] Starting holder scanner job...');

        try {
            const result = await holderScanner.updateGlobalState(deps);

            if (result?.skipped) {
                logger.info('[Worker] Holder scanner job skipped — a scan was already in progress');
            } else if (result?.scanCompleted) {
                logger.info('[Worker] Holder scanner job complete');
            } else if (result?.error) {
                logger.warn('[Worker] Holder scanner job finished with an error', { error: result.error });
            }

            return result;
        } catch (e) {
            logger.error('[Worker] Holder scanner error', { error: e.message, stack: e.stack });
            throw e;
        }
    }, { concurrency: 1 }); // v25.27: Reduced to 1 to prevent overlap issues

    // Schedule recurring jobs
    setInterval(async () => {
        try {
            await redis.addHolderScannerJob({});
        } catch (e) {
            logger.error('[Worker] Failed to schedule holder scanner job', { error: e.message });
        }
    }, config.HOLDER_UPDATE_INTERVAL);

    // v25.64: Staggered initial job after 20 seconds (was 5s) to avoid RPC spike at startup
    setTimeout(async () => {
        try {
            await redis.addHolderScannerJob({});
        } catch (e) {
            logger.error('[Worker] Failed to add initial holder scanner job', { error: e.message });
        }
    }, 20000);

    logger.info('[Worker] Holder scanner worker initialized');
    return worker;
}

/**
 * Initialize Metadata Updater Worker
 * Updates token market data from DexScreener
 */
function initMetadataUpdaterWorker(deps) {
    const { db } = deps;

    const worker = redis.createWorker('metadataUpdaterQueue', async (job) => {
        logger.info('[Worker] Starting metadata updater job...');

        try {
            // v26.1: Keyset pagination (cursor-based) — avoids O(n) OFFSET scan
            // Uses lastUpdated as cursor; NULLS FIRST ensures unscanned tokens are processed first
            const TOKENS_PER_PAGE = 100;
            let cursor = null; // null means "before the beginning" — fetch NULLS FIRST
            let totalScanned = 0;

            while (true) {
                const tokens = cursor === null
                    ? await db.all(
                        'SELECT mint, image, "lastUpdated" FROM tokens ORDER BY "lastUpdated" ASC NULLS FIRST LIMIT $1',
                        [TOKENS_PER_PAGE]
                      )
                    : await db.all(
                        'SELECT mint, image, "lastUpdated" FROM tokens WHERE "lastUpdated" > $1 OR "lastUpdated" IS NULL ORDER BY "lastUpdated" ASC NULLS FIRST LIMIT $2',
                        [cursor, TOKENS_PER_PAGE]
                      );
                if (tokens.length === 0) break;

                // Advance cursor to the largest lastUpdated seen in this page
                const maxUpdated = tokens.reduce((m, t) => t.lastUpdated != null && t.lastUpdated > m ? t.lastUpdated : m, cursor ?? 0);
                cursor = maxUpdated;

                totalScanned += tokens.length;

                const chunks = chunkArray(tokens, 30);

            for (const chunk of chunks) {
                const mints = chunk.map(t => t.mint).join(',');

                try {
                    const dexRes = await axios.get(
                        `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
                        { timeout: 8000 }
                    );

                    const pairs = dexRes.data?.pairs || [];
                    const updates = new Map();

                    for (const pair of pairs) {
                        const mint = pair.baseToken?.address;
                        if (!mint) continue;

                        const existing = updates.get(mint);

                        if (!existing || (pair.liquidity?.usd > existing.liquidity)) {
                            updates.set(mint, {
                                marketCap: pair.fdv || pair.marketCap || 0,
                                volume24h: pair.volume?.h24 || 0,
                                priceUsd: parseFloat(pair.priceUsd) || 0,
                                liquidity: pair.liquidity?.usd || 0,
                                imageUrl: pair.info?.imageUrl || pair.info?.header || pair.baseToken?.info?.imageUrl || null
                            });
                        }
                    }

                    // M-10: Bulk UPDATE using VALUES clause — 1 round trip instead of N
                    const misses = [];
                    const updateRows = [];
                    const now = Date.now();
                    for (const t of chunk) {
                        const data = updates.get(t.mint);
                        if (data) {
                            const tokenHasImage = t.image && t.image !== '' && t.image !== 'null';
                            // Pass null for image if token already has one (COALESCE preserves existing)
                            updateRows.push([t.mint, data.volume24h, data.marketCap, data.priceUsd, now, tokenHasImage ? null : (data.imageUrl || null)]);
                        } else {
                            misses.push(t.mint);
                        }
                    }
                    if (updateRows.length > 0) {
                        const placeholders = updateRows.map((_, i) =>
                            `($${i*6+1}, $${i*6+2}::numeric, $${i*6+3}::numeric, $${i*6+4}::numeric, $${i*6+5}::bigint, $${i*6+6})`
                        ).join(', ');
                        await db.run(
                            `UPDATE tokens SET
                                volume24h = v.volume24h,
                                "marketCap" = v.market_cap,
                                "priceUsd" = v.price_usd,
                                "lastUpdated" = v.last_updated,
                                image = COALESCE(v.image, tokens.image)
                             FROM (VALUES ${placeholders}) AS v(mint, volume24h, market_cap, price_usd, last_updated, image)
                             WHERE tokens.mint = v.mint`,
                            updateRows.flat()
                        );
                    }

                    // Batch fetch Helius data for all DexScreener misses (1 call instead of N)
                    if (misses.length > 0 && config.HELIUS_API_KEY) {
                        try {
                            // v25.14 SECURITY: Move API key from URL to header
                            const heliusRes = await axios.post(
                                'https://mainnet.helius-rpc.com/',
                                {
                                    jsonrpc: '2.0',
                                    id: '1',
                                    method: 'getAssetBatch',
                                    params: { ids: misses, displayOptions: { showFungible: true } }
                                },
                                {
                                    timeout: 10000,
                                    headers: { 'Authorization': `Bearer ${config.HELIUS_API_KEY}` }
                                }
                            );
                            const assets = heliusRes.data?.result || [];
                            for (const asset of assets) {
                                if (asset?.id) {
                                    const marketCap = asset?.token_info?.price_info?.total_price || 0;
                                    // v21.0: Clean CDN-wrapped URLs
                                    const image = imageUtils.extractHeliusBatchImage(asset);
                                    // v25.4: Check if token already has an image (preserve Imgur URLs)
                                    const token = chunk.find(t => t.mint === asset.id);
                                    const tokenHasImage = token && token.image && token.image !== '' && token.image !== 'null';

                                    // Update with both marketCap and image if available
                                    // v25.4: Only update image if token doesn't already have one
                                    if (image && marketCap > 0 && !tokenHasImage) {
                                        await db.run(
                                            `UPDATE tokens SET "marketCap" = $1, image = $2, "lastUpdated" = $3 WHERE mint = $4`,
                                            [marketCap, image, Date.now(), asset.id]
                                        );
                                    } else if (marketCap > 0) {
                                        await db.run(
                                            `UPDATE tokens SET "marketCap" = $1, "lastUpdated" = $2 WHERE mint = $3`,
                                            [marketCap, Date.now(), asset.id]
                                        );
                                    } else if (image && !tokenHasImage) {
                                        await db.run(
                                            `UPDATE tokens SET image = $1, "lastUpdated" = $2 WHERE mint = $3`,
                                            [image, Date.now(), asset.id]
                                        );
                                    }
                                }
                            }
                        } catch (heliusErr) {
                            logger.debug('[Worker] Helius fallback error', { error: heliusErr.message });
                        }
                    }
                    await delay(1500);

                } catch (e) {
                    if (e.response && e.response.status === 429) {
                        logger.warn('[Worker] DexScreener Rate Limit (429). Pausing 30 seconds...');
                        await delay(30000);
                    } else {
                        logger.warn(`[Worker] DexScreener Batch Error: ${e.message}`);
                    }
                }
            }
            } // End pagination while loop

            await redis.setLastBackendUpdate(Date.now());
            logger.info(`[Worker] Metadata update complete. Tokens scanned: ${totalScanned}`);
            return { success: true, tokensScanned: totalScanned };

        } catch (e) {
            logger.error('[Worker] Metadata updater error', { error: e.message });
            throw e;
        }
    }, { concurrency: 2 }); // SCALABILITY FIX: Increased concurrency from 1 to 2

    // Schedule recurring jobs
    setInterval(async () => {
        try {
            await redis.addMetadataUpdaterJob({});
        } catch (e) {
            logger.error('[Worker] Failed to schedule metadata updater job', { error: e.message });
        }
    }, config.METADATA_FULL_INTERVAL || 300000); // v25.25: Fixed config key name

    // v25.64: Staggered initial job after 45 seconds (was 5s) to avoid RPC spike at startup
    setTimeout(async () => {
        try {
            await redis.addMetadataUpdaterJob({});
        } catch (e) {
            logger.error('[Worker] Failed to add initial metadata updater job', { error: e.message });
        }
    }, 45000);

    logger.info('[Worker] Metadata updater worker initialized');
    return worker;
}

/**
 * Initialize Robinhood Scanner Worker
 * Scans for fee sharing configs and updates Robinhood token holders
 */
function initRobinhoodScannerWorker(deps) {
    const { connection, devKeypair, db } = deps;

    const worker = redis.createWorker('robinhoodScannerQueue', async (job) => {
        logger.info('[Worker] Starting Robinhood scanner job...');

        try {
            // Import robinhoodScanner functions
            const robinhoodScanner = require('./robinhoodScanner');

            // Run the main update function
            await robinhoodScanner.updateRobinhoodState(deps);

            logger.info('[Worker] Robinhood scanner job complete');
            return { success: true };

        } catch (e) {
            logger.error('[Worker] Robinhood scanner error', { error: e.message });
            throw e;
        }
    }, { concurrency: 1 });

    // Schedule recurring jobs (every 10 minutes)
    setInterval(async () => {
        try {
            await redis.addRobinhoodScannerJob({});
        } catch (e) {
            logger.error('[Worker] Failed to schedule Robinhood scanner job', { error: e.message });
        }
    }, 10 * 60 * 1000);

    // v25.64: Staggered initial job after 60 seconds (was 10s) to avoid RPC spike at startup
    setTimeout(async () => {
        try {
            await redis.addRobinhoodScannerJob({});
        } catch (e) {
            logger.error('[Worker] Failed to add initial Robinhood scanner job', { error: e.message });
        }
    }, 60000);

    logger.info('[Worker] Robinhood scanner worker initialized');
    return worker;
}

/**
 * Initialize ASDF Sync Worker
 * Updates Top 100 ASDF holders for the 2x multiplier
 */
function initAsdfSyncWorker(deps) {
    const { connection } = deps;

    async function updateAsdfHolders() {
        try {
            if (!TOKENS.ASDF) {
                logger.warn("[Worker] ASDF Token address not configured in constants.");
                return;
            }

            const programId = TOKEN_PROGRAM_ID;
            const mintPubkey = new PublicKey(TOKENS.ASDF);

            const accounts = await connection.getProgramAccounts(programId, {
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } }
                ],
                encoding: 'base64'
            });

            // v25.115: Handle base64 array tuple format from encoding: 'base64'
            // Previously Buffer.from(array) produced garbage data, breaking ASDF top 100 list
            const parsedAccounts = accounts.map(acc => {
                const data = Array.isArray(acc.account.data)
                    ? Buffer.from(acc.account.data[0], 'base64')
                    : Buffer.from(acc.account.data);
                if (data.length < 72) return null;
                const owner = new PublicKey(data.slice(32, 64)).toString();
                const amount = new BN(data.slice(64, 72), 'le');
                return { owner, amount };
            }).filter(a => a !== null)
                .sort((a, b) => b.amount.cmp(a.amount));

            const top100 = [];
            for (const acc of parsedAccounts) {
                if (top100.length >= 100) break;
                if (acc.amount.gt(new BN(0))) {
                    top100.push(acc.owner);
                }
            }

            // Update Redis
            await redis.setAsdfTop100Holders(top100);
            logger.info(`[Worker] ASDF Sync: Updated Top 100 Holders. Found ${accounts.length} total, tracking ${top100.length}.`);

        } catch (e) {
            logger.error("[Worker] ASDF Sync Failed", { error: e.message });
        }
    }

    // Run immediately
    updateAsdfHolders();

    // Then run every 2 minutes
    setInterval(updateAsdfHolders, 2 * 60 * 1000);

    logger.info('[Worker] ASDF sync worker initialized');
}

function initAnsemSyncWorker(deps) {
    const { fetchTokenAccountsHeliusDAS } = require('../services/heliusDAS');

    // Pre-compute ANSEM LP exclusion addresses once at worker init (fixed mint)
    const ansemMintPubkey = new PublicKey(TOKENS.ANSEM);
    const [ansemBondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), ansemMintPubkey.toBuffer()],
        PROGRAMS.PUMP
    );
    const ANSEM_BONDING_CURVE_STR = ansemBondingCurve.toString();
    const ANSEM_AMM_POOL_STR = pump.getPumpAmmPDAs(ansemMintPubkey).pool.toString();

    async function updateAnsemHolders() {
        try {
            const mint = TOKENS.ANSEM;
            if (!mint) {
                logger.warn('[Worker] ANSEM token address not configured');
                return;
            }

            // Top 1000 holders — use Helius DAS to avoid RPC limits
            const accounts = await fetchTokenAccountsHeliusDAS(mint, 1000, 'AnsemSync');
            if (!accounts || accounts.length === 0) {
                logger.warn('[Worker] ANSEM Sync: Helius DAS returned no accounts');
                return;
            }

            // Sort by balance descending and take top 1000 owners, excluding LP accounts
            const sorted = accounts
                .filter(a => a.owner
                    && BigInt(a.balance || '0') > 0n
                    && a.owner !== WALLETS.PUMP_LIQUIDITY
                    && a.owner !== ANSEM_BONDING_CURVE_STR
                    && a.owner !== ANSEM_AMM_POOL_STR)
                .sort((a, b) => {
                    const diff = BigInt(b.balance || '0') - BigInt(a.balance || '0');
                    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
                })
                .slice(0, 1000)
                .map(a => a.owner);

            await redis.setAnsemTop1000Holders(sorted);
            logger.info(`[Worker] ANSEM Sync: Updated Top 1000 Holders. Tracking ${sorted.length}.`);
        } catch (e) {
            logger.error('[Worker] ANSEM Sync Failed', { error: e.message });
        }
    }

    updateAnsemHolders();
    setInterval(updateAnsemHolders, 5 * 60 * 1000); // every 5 minutes
    logger.info('[Worker] ANSEM sync worker initialized');
}

module.exports = {
    initDeployWorker,
    initSocialWorker,
    // v13.0: New workers
    initHolderScannerWorker,
    initMetadataUpdaterWorker,
    initRobinhoodScannerWorker,
    initAsdfSyncWorker,
    initAnsemSyncWorker,
};
