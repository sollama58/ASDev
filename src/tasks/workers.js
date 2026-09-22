/**
 * Workers Module
 * Deploy, social, and background task workers
 * v13.0 - Added holder scanner and metadata updater workers
 * v25.4 - Added worker event handlers for debugging job processing issues
 */
const { PublicKey, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
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
    async function launchTokenOnChain({
        tokenName, tokenTicker, tokenMetadataUri, useMayhemMode,
        quoteMint = null,      // null = SOL; otherwise a supported quote mint (Custom Pairs)
        quoteAmount = null,    // base units of the quote asset for the seed buy
        isDud = false,
    }) {
        const { Keypair } = require('@solana/web3.js');
        const pumpLaunch = require('../services/pumpLaunch');

        // v28.1: real launches draw a pre-ground vanity mint from the pool; anti-bundling
        // duds are throwaway tokens and must never burn one. getMintKeypair falls back to a
        // random mint whenever the pool is empty or unavailable, so this cannot block a
        // launch -- vanityId is null on that path and the release/markUsed calls below no-op.
        const vanity = require('../services/vanity');
        const { keypair: mintKeypair, isVanity, id: vanityId } = isDud
            ? { keypair: Keypair.generate(), isVanity: false, id: null }
            : await vanity.getMintKeypair(db);

        const mint = mintKeypair.publicKey;
        const creator = devKeypair.publicKey;

        // Decoys are always SOL-quoted: their only job is to obscure the real launch, and a
        // token quote would make them cost quote-asset inventory as well as rent.
        const effectiveQuoteMint = isDud ? null : quoteMint;
        const seedAmount = new BN(
            quoteAmount != null && !isDud ? quoteAmount : Math.floor(0.01 * LAMPORTS_PER_SOL)
        );

        // Tracks whether we reached the point of no return (see the send block below).
        let broadcastAttempted = false;
        try {

        // v30.0: the create/buy instructions now come from the official SDK rather than being
        // hand-assembled here. The hand-written create_v2 payload had fallen ten bytes behind
        // the program's argument list, and Custom Pairs adds four positional remaining
        // accounts plus a 27-account buy_v2 that is not worth re-deriving by hand.
        // buildLaunchInstructions also pins holderReward and cashback off, which is what keeps
        // this platform the on-chain creator and therefore the recipient of every creator fee.
        const built = await pumpLaunch.buildLaunchInstructions({
            connection,
            mint,
            name: tokenName,
            symbol: tokenTicker,
            uri: tokenMetadataUri,
            creator,
            user: creator,
            quoteAmount: seedAmount,
            mayhemMode: !!useMayhemMode,
            quoteMint: effectiveQuoteMint,
        });

        // v30.0: the launch may not fit in one legacy transaction. buildLaunchInstructions
        // measures it and hands back one group, or two when create + seed buy would exceed
        // 1232 bytes -- which happens on any token-quoted launch, and on a SOL launch once
        // the metadata URI is a real gateway URL and the name is long.
        let sig = null;
        for (const [n, group] of built.transactions.entries()) {
            const tx = new Transaction();
            // One SetComputeUnitLimit per transaction: the budget has to be chosen here, not
            // added alongside a second one. Token-quoted launches need the larger figure.
            solana.addPriorityFee(tx, { units: built.computeUnitLimit });
            for (const ix of group.instructions) tx.add(ix);
            tx.feePayer = creator;

            const signers = group.needsMintSignature ? [devKeypair, mintKeypair] : [devKeypair];

            if (group.critical) {
                // v28.1: the point of no return for a claimed vanity address. Once we have
                // entered sendTxWithRetry the mint may exist on-chain, so the address can
                // never be handed to another launch -- a second create against the same mint
                // could never succeed. Anything that threw *before* this line left the mint
                // untouched, and the catch at the end of this function returns it to the pool.
                broadcastAttempted = true;
                sig = await solana.sendTxWithRetry(tx, signers);
            } else {
                // The coin already exists and trades by this point. A failed seed buy leaves
                // it without a seed position, which is not worth failing the launch or
                // refunding the user over.
                try {
                    await solana.sendTxWithRetry(tx, signers);
                } catch (seedErr) {
                    logger.warn('[Deploy] Seed buy failed; the coin is live without one', {
                        ticker: tokenTicker, mint: mint.toString(), group: n, error: seedErr.message
                    });
                }
            }
        }

        if (vanityId) await vanity.markUsed(db, vanityId);
        if (isVanity) logger.info(`Launched ${tokenTicker} on vanity mint ${mint.toString()}`);

        // Sell the seed position back, whatever the coin is quoted in.
        //
        // v30.0: built by the SDK from the curve's own state rather than a hand-assembled
        // SOL-only `sell`, which would have stranded the position on any token-quoted coin.
        // Still deliberately detached: the launch has already succeeded and the user has
        // their token, so nothing here may fail the job or trigger a refund.
        setTimeout(async () => {
            try {
                const seedSell = await pumpLaunch.buildSeedSellInstructions({
                    connection,
                    mint,
                    user: creator,
                    tokenProgram: PROGRAMS.TOKEN_2022,
                });
                if (!seedSell) return; // nothing was received, nothing to sell

                const sellTx = new Transaction();
                solana.addPriorityFee(sellTx, {
                    units: seedSell.isTokenQuoted
                        ? pumpLaunch.CU_LIMIT_TOKEN_LAUNCH
                        : pumpLaunch.CU_LIMIT_SOL_LAUNCH,
                });
                for (const ix of seedSell.instructions) sellTx.add(ix);
                sellTx.feePayer = creator;

                await solana.sendTxWithRetry(sellTx, [devKeypair]);
                logger.info(`Sold seed position for ${tokenTicker} (${mint.toString().substring(0, 8)}...)`, {
                    tokenQuoted: seedSell.isTokenQuoted
                });
            } catch (e) {
                logger.error('Seed sell error', { ticker: tokenTicker, msg: e.message });
            }
        }, 1500);

        return { mint, mintKeypair, sig, quoteMint: built.quoteMint, isTokenQuoted: built.isTokenQuoted };

        } catch (launchErr) {
            // A failure before broadcast means this mint was never created, so the ground
            // address is still good — return it to the pool rather than wasting it. After a
            // broadcast attempt it is retired instead, because the mint may now exist.
            if (vanityId) {
                if (broadcastAttempted) await vanity.markUsed(db, vanityId);
                else await vanity.release(db, vanityId);
            }
            throw launchErr;
        }
    }

    /**
     * Launch anti-bundling dud tokens before the real token.
     *
     * v29.1: the count is configurable and may be zero. Each dud is a full create plus buy,
     * and a create allocates mint, bonding-curve and metadata accounts whose rent the
     * sell-and-close below does NOT recover -- so this runs at a real per-launch cost set
     * against a 0.02 SOL deployment fee. It was a hardcoded random 1 to 5, which made that
     * cost invisible. Set ANTI_BUNDLE_MAX to 0 to turn decoys off.
     */
    async function launchDudTokens(job) {
        // ANTI_BUNDLE_MAX is the off switch: setting it to 0 disables decoys whatever the
        // minimum says, so an operator cannot half-disable them by touching only one value.
        const hi = config.ANTI_BUNDLE_MAX;
        const lo = Math.min(config.ANTI_BUNDLE_MIN, hi);
        const dudCount = hi === 0 ? 0 : lo + Math.floor(Math.random() * (hi - lo + 1));

        if (dudCount === 0) {
            logger.debug(`[Anti-Bundle] Disabled, skipping decoys for job ${job.id}`);
            return;
        }

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
        const { name, ticker, description, twitter: twitterHandle, website, image, userPubkey, isMayhemMode, metadataUri, quoteMint } = job.data;

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

            const launched = await launchTokenOnChain({
                tokenName: name,
                tokenTicker: ticker,
                tokenMetadataUri: metadataUri,
                useMayhemMode: isMayhemMode,
                quoteMint: quoteMint || null,
            });
            const { mint, sig } = launched;

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
                    isMayhemMode, metadataUri,
                    // v30.0: what the coin is quoted in. Fee collection needs this to sweep
                    // the right vaults once a quote is de-listed from QuoteControl.
                    quoteMint: launched.quoteMint || null,
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
            // v28.3 MONEY: non-fatal. This was the last unguarded await inside the catch-all
            // below, which refunds the user on ANY error — so a Redis blip here, AFTER the token
            // had launched on-chain and the user had it, paid them the deployment fee back and
            // marked the job failed. A missed tweet is not a failed launch.
            try {
                await redis.addSocialJob({ name, ticker, mint: mint.toString() });
            } catch (socialErr) {
                logger.warn('[Deploy] Launch succeeded but social post could not be queued', { mint: mint.toString(), error: socialErr.message });
            }

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
            // v28.6: delegate to the task module, as the holder/asdf workers already
            // do. This worker used to carry its own 190-line copy of the price/image update —
            // its own DexScreener chunking, its own Helius fallback, its own UPDATE statements —
            // none of it shared with metadataUpdater.js, so the two implementations drifted
            // (the task module gained cross-run miss aggregation and cross-table image lookup
            // in v27.5; this copy never did). One implementation, two schedulers.
            const metadataUpdater = require('./metadataUpdater');
            await metadataUpdater.updateAllTokenPrices(deps);
            await redis.setLastBackendUpdate(Date.now());
            logger.info('[Worker] Metadata update complete');
            return { success: true };
        } catch (e) {
            logger.error('[Worker] Metadata updater error', { error: e.message });
            throw e;
        }
    }, { concurrency: 1 });

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
 * Initialize ASDF Sync Worker
 * Updates Top 100 ASDF holders for the 2x multiplier
 */
function initAsdfSyncWorker(deps) {
    const { connection } = deps;
    const { fetchTopHoldersByBalance } = require('../services/heliusDAS');

    // Pre-compute ASDF LP exclusion addresses once at worker init (fixed mint).
    // v27.6: this worker previously had no exclusions at all, unlike its twin in
    // tasks/asdfSync.js, so the pump bonding curve and AMM pool occupied top slots and
    // pushed real holders out of the Top 100.
    const asdfMintPubkey = new PublicKey(TOKENS.ASDF);
    const [asdfBondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), asdfMintPubkey.toBuffer()],
        PROGRAMS.PUMP
    );
    const ASDF_BONDING_CURVE_STR = asdfBondingCurve.toString();
    const ASDF_AMM_POOL_STR = pump.getPumpAmmPDAs(asdfMintPubkey).pool.toString();

    async function updateAsdfHolders() {
        try {
            if (!TOKENS.ASDF) {
                logger.warn("[Worker] ASDF Token address not configured in constants.");
                return;
            }

            const top100 = await fetchTopHoldersByBalance(asdfMintPubkey.toBase58(), {
                topN: 100,
                exclude: [WALLETS.PUMP_LIQUIDITY, ASDF_BONDING_CURVE_STR, ASDF_AMM_POOL_STR],
                caller: 'Worker ASDF Sync',
                connection
            });

            // v27.6: never overwrite a good list with a bad scan.
            if (top100 === null) {
                logger.warn('[Worker] ASDF Sync: holder scan failed, keeping previous Top 100 list');
                return;
            }
            if (top100.length === 0) {
                logger.warn('[Worker] ASDF Sync: holder scan returned no holders, keeping previous Top 100 list');
                return;
            }

            // Update Redis
            await redis.setAsdfTop100Holders(top100);
            logger.info(`[Worker] ASDF Sync: Updated Top 100 Holders. Tracking ${top100.length}.`);

        } catch (e) {
            logger.error("[Worker] ASDF Sync Failed", { error: e.message });
        }
    }

    // Run immediately
    updateAsdfHolders();

    // v27.6: 5 minutes, matching the ANSEM worker. The previous 2-minute cadence was tuned
    // for a holder list that barely moves, and it now drives paginated DAS scans.
    setInterval(updateAsdfHolders, 5 * 60 * 1000);

    logger.info('[Worker] ASDF sync worker initialized');
}

function initAnsemSyncWorker(deps) {
    const { fetchTopHoldersByBalance } = require('../services/heliusDAS');

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

            // v27.6: scan well past 1000 before ranking. DAS getTokenAccounts does not return
            // accounts in balance order, so capping the *fetch* at 1000 and then sorting those
            // ranked an arbitrary 1000 accounts rather than the actual top 1000.
            const sorted = await fetchTopHoldersByBalance(mint, {
                topN: 1000,
                exclude: [WALLETS.PUMP_LIQUIDITY, ANSEM_BONDING_CURVE_STR, ANSEM_AMM_POOL_STR],
                caller: 'Worker ANSEM Sync',
                connection: deps.connection
            });

            if (sorted === null) {
                logger.warn('[Worker] ANSEM Sync: holder scan failed, keeping previous Top 1000 list');
                return;
            }
            if (sorted.length === 0) {
                logger.warn('[Worker] ANSEM Sync: holder scan returned no holders, keeping previous Top 1000 list');
                return;
            }

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
    initAsdfSyncWorker,
    initAnsemSyncWorker,
};
