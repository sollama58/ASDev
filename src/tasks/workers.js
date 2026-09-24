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
const { logger, redis, pump, solana, twitter, pinata } = require('../services');

/**
 * Initialize deploy worker
 *
 * v30.2 - Launch safety:
 *   - Metadata is pinned HERE, after payment, from the sanitised fields in the job. The API
 *     no longer accepts a metadata URI from the client, so a paying user can no longer point
 *     a ShitPad coin at any IPFS document they like (and at any image), and nobody can use
 *     /prepare-metadata to pin content to our Pinata account without paying.
 *   - A job that stalls (its process died mid-launch) is never silently re-run. BullMQ's
 *     default re-runs a stalled job once, which could launch a paid coin twice. Stalled jobs
 *     now fail, and a reconciler decides from the chain whether the coin was created (record
 *     it) or not (refund).
 *   - A failure after the create was broadcast is resolved against the chain before any
 *     refund: if the mint exists the launch succeeded, and the user keeps the coin without
 *     also getting the fee back.
 *   - Refunds are idempotent per payment (solana.refundUser claims them on the payment row).
 */
const LAUNCH_DESCRIPTION_FOOTER = ' Launched via ShitPad.';

function initDeployWorker(deps) {
    const { connection, signer, db, saveTokenData, refundUser } = deps;

    // Anti-bundling dud token constants
    const DUD_NAME = 'ASDFGHJKL';
    const DUD_TICKER = 'ASDFGHJKL';
    const DUD_IMAGE = 'https://i.imgur.com/dBRNdzu.png';
    const DUD_DESCRIPTION = '';

    /** True once the mint account exists on chain. Retries a few times: a missing answer is
     * not the same as "absent" when the RPC is flaky, and a wrong "absent" means a refund for
     * a coin that exists. Throws if it can never get an answer. */
    async function mintExists(mintStr) {
        let lastErr = null;
        for (let i = 0; i < 4; i++) {
            try {
                const info = await connection.getAccountInfo(new PublicKey(mintStr), 'confirmed');
                return !!info;
            } catch (e) {
                lastErr = e;
                await new Promise(r => setTimeout(r, 1500 * (i + 1)));
            }
        }
        throw new Error(`Could not check whether mint ${mintStr} exists: ${lastErr?.message}`);
    }

    /** Record a seed position so the reconciler can sell it if the scheduled sell never runs. */
    async function recordSeedPosition(mintStr, isDecoy) {
        await db.run(
            `INSERT INTO seed_positions (mint, is_decoy, created_at) VALUES ($1, $2, $3)
             ON CONFLICT (mint) DO NOTHING`,
            [mintStr, !!isDecoy, Date.now()]
        ).catch(e => logger.warn('[Deploy] Could not record seed position', { mint: mintStr, error: e.message }));
    }

    /**
     * Build and send a token create (+ seed buy) on-chain.
     * Reusable for both real tokens and anti-bundling duds.
     *
     * Throws on failure. An error thrown AFTER the create was broadcast carries
     * `broadcastMint` so the caller can check the chain before deciding to refund.
     */
    async function launchTokenOnChain({
        tokenName, tokenTicker, tokenMetadataUri,
        quoteMint = null,      // null = SOL; otherwise a supported quote mint (Custom Pairs)
        isDud = false,
        onBroadcast = null,    // async (mintStr) => void, called just before the create is sent
    }) {
        const { Keypair } = require('@solana/web3.js');
        const pumpLaunch = require('../services/pumpLaunch');

        // v28.1: real launches draw a pre-ground vanity mint from the pool; duds never burn one.
        const vanity = require('../services/vanity');
        const { keypair: mintKeypair, isVanity, id: vanityId } = isDud
            ? { keypair: Keypair.generate(), isVanity: false, id: null }
            : await vanity.getMintKeypair(db);

        const mint = mintKeypair.publicKey;
        const creator = signer.publicKey;

        // Decoys are always SOL-quoted. Token-quoted launches get no seed buy (see
        // pumpLaunch.buildLaunchInstructions `seedBuy`).
        const effectiveQuoteMint = isDud ? null : quoteMint;
        const seedBuy = !effectiveQuoteMint;

        let broadcastAttempted = false;
        try {
            const built = await pumpLaunch.buildLaunchInstructions({
                connection,
                mint,
                name: tokenName,
                symbol: tokenTicker,
                uri: tokenMetadataUri,
                creator,
                user: creator,
                quoteAmount: new BN(Math.floor(0.01 * LAMPORTS_PER_SOL)),
                // v30.2: mayhem mode is never enabled. The UI does not offer it, and the holder
                // and fee maths here (1B supply, platform as sole creator) are unverified for it.
                mayhemMode: false,
                quoteMint: effectiveQuoteMint,
                seedBuy,
            });

            let sig = null;
            for (const [n, group] of built.transactions.entries()) {
                const tx = new Transaction();
                // One SetComputeUnitLimit per transaction.
                solana.addPriorityFee(tx, { units: built.computeUnitLimit });
                for (const ix of group.instructions) tx.add(ix);
                tx.feePayer = creator;

                const signers = group.needsMintSignature ? [mintKeypair] : [];

                if (group.critical) {
                    // The point of no return: once we are inside sendTxWithRetry the mint may
                    // exist on-chain.
                    if (onBroadcast) await onBroadcast(mint.toString());
                    broadcastAttempted = true;
                    sig = await solana.sendTxWithRetry(tx, signers);
                } else {
                    // The coin already exists and trades. A failed seed buy is not a failed launch.
                    try {
                        await solana.sendTxWithRetry(tx, signers);
                    } catch (seedErr) {
                        logger.warn('[Deploy] Seed buy failed; the coin is live without one', {
                            ticker: tokenTicker, mint: mint.toString(), group: n, error: seedErr.message
                        });
                    }
                }
            }

            // Nothing below may throw: the coin exists, and a throw here would reach the
            // refund path for a launch that succeeded.
            if (vanityId) await vanity.markUsed(db, vanityId).catch(e => logger.warn('[Deploy] markUsed failed', { error: e.message }));
            if (isVanity) logger.info(`Launched ${tokenTicker} on vanity mint ${mint.toString()}`);

            if (built.seedBuy) {
                await recordSeedPosition(mint.toString(), isDud);
                // Sell the seed position back. Detached, and backed by the seed_positions
                // reconciler if this process dies before it runs.
                setTimeout(() => {
                    sellSeedPosition({ connection, signer, db }, mint.toString())
                        .catch(e => logger.error('Seed sell error', { ticker: tokenTicker, msg: e.message }));
                }, 1500);
            }

            return { mint, mintKeypair, sig, quoteMint: built.quoteMint, isTokenQuoted: built.isTokenQuoted };
        } catch (launchErr) {
            if (vanityId) {
                if (broadcastAttempted) await vanity.markUsed(db, vanityId).catch(() => {});
                else await vanity.release(db, vanityId).catch(() => {});
            }
            if (broadcastAttempted) launchErr.broadcastMint = mint.toString();
            throw launchErr;
        }
    }

    // v30.2: the decoy metadata never changes, so it is pinned once per process, not per job.
    let dudMetadataUri = null;

    /**
     * Launch anti-bundling dud tokens before the real token.
     *
     * Each dud is a full create plus buy, and the rent a create allocates is not recovered by
     * the sell that follows, so this is a real per-launch cost against a 0.02 SOL fee. Default
     * is now 0-1 decoys (was 1-5); set ANTI_BUNDLE_MAX=0 to turn decoys off.
     */
    async function launchDudTokens(job) {
        const hi = config.ANTI_BUNDLE_MAX;
        const lo = Math.min(config.ANTI_BUNDLE_MIN, hi);
        const dudCount = hi === 0 ? 0 : lo + Math.floor(Math.random() * (hi - lo + 1));

        if (dudCount === 0) {
            logger.debug(`[Anti-Bundle] No decoys for job ${job.id}`);
            return;
        }

        logger.info(`[Anti-Bundle] Launching ${dudCount} dud token(s) for job ${job.id}`);

        if (!dudMetadataUri) {
            const dudMeta = await pinata.uploadMetadata(DUD_NAME, DUD_TICKER, DUD_DESCRIPTION, '', '', DUD_IMAGE);
            dudMetadataUri = dudMeta.metadataUri;
        }

        for (let i = 0; i < dudCount; i++) {
            await job.updateProgress({ phase: 'anti-bundle', current: i + 1, total: dudCount });
            try {
                const result = await launchTokenOnChain({
                    tokenName: DUD_NAME,
                    tokenTicker: DUD_TICKER,
                    tokenMetadataUri: dudMetadataUri,
                    isDud: true
                });
                logger.info(`[Anti-Bundle] Dud ${i + 1}/${dudCount} launched: ${result.mint.toString().substring(0, 12)}...`);
            } catch (dudErr) {
                logger.warn(`[Anti-Bundle] Dud ${i + 1}/${dudCount} failed (non-fatal)`, { error: dudErr.message });
            }
        }
    }

    /** Persist a launched coin. Never throws: the coin exists whatever happens here. */
    async function recordLaunchedToken(data, mintStr, quoteMint) {
        const { name, ticker, description, twitter: twitterHandle, website, image, userPubkey, metadataUri } = data;
        try {
            const existing = await db.get('SELECT mint FROM tokens WHERE mint = $1', [mintStr]);
            if (existing) return;
            await saveTokenData(userPubkey, mintStr, {
                name, ticker, description, twitter: twitterHandle,
                website, image,
                isMayhemMode: false, metadataUri,
                quoteMint: quoteMint || null,
            });
            logger.info(`[Deploy] Token saved to database: ${ticker} (${mintStr})`);
            // v30.4: the listing pages are cached for 15s per page; drop them so the new coin
            // shows up on the next request rather than the next expiry.
            await redis.invalidateCachePrefix('all_launches_').catch(() => {});
        } catch (dbError) {
            logger.error(`[Deploy] FAILED to save token to database`, { error: dbError.message, mint: mintStr, ticker });
        }
    }

    const worker = redis.createWorker('deployQueue', async (job) => {
        logger.info(`STARTING JOB ${job.id}: ${job.data.ticker}`);
        const { name, ticker, description, twitter: twitterHandle, website, image, userPubkey, quoteMint, userTx } = job.data;

        try {
            // Pin the metadata. Kept on the job so nothing re-pins it.
            let metadataUri = job.data.metadataUri;
            if (!metadataUri) {
                await job.updateProgress({ phase: 'metadata', message: 'Uploading metadata...' });
                const pinned = await pinata.uploadMetadata(
                    name, ticker, (description || '') + LAUNCH_DESCRIPTION_FOOTER, twitterHandle, website, image
                );
                metadataUri = pinned.metadataUri;
                if (!metadataUri) throw new Error('Metadata upload failed');
                await job.updateData({ ...job.data, metadataUri });
            }

            await launchDudTokens(job);

            await job.updateProgress({ phase: 'deploying', message: 'Launching your token...' });
            logger.info(`[Deploy] Launching real token: ${ticker}`);

            const launched = await launchTokenOnChain({
                tokenName: name,
                tokenTicker: ticker,
                tokenMetadataUri: metadataUri,
                quoteMint: quoteMint || null,
                // Recorded before the send, so a reconciler can find the mint if this process
                // dies mid-send.
                onBroadcast: (mintStr) => job.updateProgress({ phase: 'broadcast', mint: mintStr }),
            });
            const mintStr = launched.mint.toString();
            logger.info(`[Deploy] Real token confirmed: ${ticker} ${mintStr} sig=${launched.sig}`);

            await recordLaunchedToken({ ...job.data, metadataUri }, mintStr, launched.quoteMint);

            try {
                await redis.addSocialJob({ name, ticker, mint: mintStr });
            } catch (socialErr) {
                logger.warn('[Deploy] Launch succeeded but social post could not be queued', { mint: mintStr, error: socialErr.message });
            }

            return { mint: mintStr, signature: launched.sig };

        } catch (jobError) {
            logger.error(`Job Failed: ${jobError.message}`);

            // Did the coin get created anyway? Only the chain can say.
            if (jobError.broadcastMint) {
                let exists = null;
                try {
                    exists = await mintExists(jobError.broadcastMint);
                } catch (checkErr) {
                    // Cannot tell. Refunding could pay for a coin that exists; not refunding
                    // could keep a fee for one that does not. Fail without refunding and say
                    // so loudly -- this needs a human.
                    logger.error('[Deploy] LAUNCH OUTCOME UNKNOWN - not refunding; check the mint on chain', {
                        job: job.id, mint: jobError.broadcastMint, userPubkey, userTx, error: checkErr.message
                    });
                    throw jobError;
                }
                if (exists) {
                    logger.warn('[Deploy] Launch reported an error but the mint exists; treating as launched', {
                        job: job.id, mint: jobError.broadcastMint
                    });
                    await recordLaunchedToken(job.data, jobError.broadcastMint, quoteMint);
                    return { mint: jobError.broadcastMint, signature: null };
                }
            }

            if (userPubkey) await refundUser(userPubkey, "Deployment Failed: " + jobError.message, userTx || null);
            throw jobError;
        }
    }, {
        concurrency: 1,
        // v30.2: a stalled launch is never re-run automatically (see header).
        maxStalledCount: 0,
        // Launches run for a while (decoys + confirmation polling); give the lock room.
        lockDuration: 120000,
    });

    /**
     * A job that stalled failed without its handler running to completion. Decide from the
     * chain what actually happened.
     */
    async function reconcileStalledLaunch(job) {
        const { userPubkey, userTx } = job.data || {};
        const mintStr = job.progress && job.progress.mint;
        logger.warn('[DeployWorker] Reconciling stalled launch', { job: job.id, mint: mintStr || null });
        try {
            if (mintStr && await mintExists(mintStr)) {
                await recordLaunchedToken(job.data, mintStr, job.data.quoteMint);
                return;
            }
        } catch (e) {
            logger.error('[DeployWorker] STALLED LAUNCH OUTCOME UNKNOWN - not refunding; check the mint on chain', {
                job: job.id, mint: mintStr, userPubkey, userTx, error: e.message
            });
            return;
        }
        if (userPubkey) await refundUser(userPubkey, 'Launch interrupted before the coin was created', userTx || null);
    }

    if (worker) {
        worker.on('completed', (job, result) => {
            logger.info(`[DeployWorker] Job ${job.id} completed`, { ticker: job.data.ticker, mint: result?.mint });
        });

        worker.on('failed', (job, err) => {
            logger.error(`[DeployWorker] Job ${job?.id} failed`, { ticker: job?.data?.ticker, error: err.message });
            if (job && /stalled/i.test(err?.message || '')) {
                reconcileStalledLaunch(job).catch(e => logger.error('[DeployWorker] Stall reconciliation failed', { error: e.message }));
            }
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

/**
 * Sell the platform's seed position in `mintStr`, whatever the coin is quoted in, and mark it
 * sold. Shared by the post-launch timer and the reconciler.
 */
async function sellSeedPosition({ connection, signer, db }, mintStr) {
    const pumpLaunch = require('../services/pumpLaunch');
    const seedSell = await pumpLaunch.buildSeedSellInstructions({
        connection,
        mint: new PublicKey(mintStr),
        user: signer.publicKey,
        tokenProgram: PROGRAMS.TOKEN_2022,
    });
    if (seedSell) {
        const sellTx = new Transaction();
        solana.addPriorityFee(sellTx, {
            units: seedSell.isTokenQuoted ? pumpLaunch.CU_LIMIT_TOKEN_LAUNCH : pumpLaunch.CU_LIMIT_SOL_LAUNCH,
        });
        for (const ix of seedSell.instructions) sellTx.add(ix);
        sellTx.feePayer = signer.publicKey;
        await solana.sendTxWithRetry(sellTx);
        logger.info(`Sold seed position ${mintStr.substring(0, 8)}...`, { tokenQuoted: seedSell.isTokenQuoted });
    }
    // Null means nothing is held: either sold already or the buy never filled. Done either way.
    await db.run('UPDATE seed_positions SET sold_at = $2 WHERE mint = $1', [mintStr, Date.now()]).catch(() => {});
}

/**
 * v30.2: sell any seed position whose post-launch sell never ran (process restarted, RPC
 * failure). Positions older than a minute and still unsold are retried, with a cap so one
 * permanently unsellable mint cannot be retried forever.
 */
async function reconcileSeedPositions(deps) {
    const { db } = deps;
    const rows = await db.all(
        `SELECT mint FROM seed_positions
          WHERE sold_at IS NULL AND created_at < $1 AND attempts < 10
          ORDER BY created_at ASC LIMIT 20`,
        [Date.now() - 60_000]
    ).catch(() => []);
    for (const { mint } of rows) {
        await db.run('UPDATE seed_positions SET attempts = attempts + 1 WHERE mint = $1', [mint]).catch(() => {});
        try {
            await sellSeedPosition(deps, mint);
        } catch (e) {
            await db.run('UPDATE seed_positions SET last_error = $2 WHERE mint = $1', [mint, String(e.message).slice(0, 300)]).catch(() => {});
            logger.warn('[SeedReconcile] Sell failed', { mint, error: e.message });
        }
    }
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
/**
 * v30.4: Consumer for admin "run it now" requests (redis.addFlywheelJob). Lives with the
 * flywheel so it runs in the process that holds the wallet key; the API only enqueues.
 * Each run takes the same mutex as the scheduled one, so a request that arrives mid-cycle
 * simply finds the lock held and returns.
 */
function initFlywheelControlWorker(deps) {
    const flywheel = require('./flywheel');
    return redis.createWorker('flywheelQueue', async (job) => {
        logger.info(`[Flywheel] Manual run requested: ${job.name}`, { source: job.data?.source || 'unknown' });
        switch (job.name) {
            case 'feeCollection': return flywheel.runFeeCollection(deps);
            case 'tokenAirdrops': return flywheel.processTokenAirdrops(deps);
            default: throw new Error(`unknown flywheel job ${job.name}`);
        }
    }, { concurrency: 1 });
}

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
 * Keeps the ASDF top-holder list (config.ASDF_BONUS_TOP_N wallets) that receives the airdrop
 * bonus. v30.3: Top 250 (was 100); the parallel ANSEM Top 1000 list was removed.
 */
const HOLDER_LIST_SYNC_MS = parseInt(process.env.HOLDER_LIST_SYNC_MS, 10) || 30 * 60 * 1000;

function initAsdfSyncWorker(deps) {
    const { connection } = deps;
    const { fetchTopHoldersByBalance } = require('../services/heliusDAS');
    const topN = config.ASDF_BONUS_TOP_N;

    // Pre-compute ASDF LP exclusion addresses once at worker init (fixed mint). Without them
    // the bonding curve and AMM pool occupy top slots and push real holders out of the list.
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

            const top = await fetchTopHoldersByBalance(asdfMintPubkey.toBase58(), {
                topN,
                exclude: [WALLETS.PUMP_LIQUIDITY, ASDF_BONDING_CURVE_STR, ASDF_AMM_POOL_STR],
                caller: 'Worker ASDF Sync',
                connection
            });

            // Never overwrite a good list with a bad scan.
            if (top === null) {
                logger.warn(`[Worker] ASDF Sync: holder scan failed, keeping previous Top ${topN} list`);
                return;
            }
            if (top.length === 0) {
                logger.warn(`[Worker] ASDF Sync: holder scan returned no holders, keeping previous Top ${topN} list`);
                return;
            }

            await redis.setAsdfTopHolders(top);
            logger.info(`[Worker] ASDF Sync: Updated Top ${topN} holders. Tracking ${top.length}.`);
        } catch (e) {
            logger.error("[Worker] ASDF Sync Failed", { error: e.message });
        }
    }

    updateAsdfHolders();
    // v30.2: 30 minutes. A top-holder list barely moves, and each refresh is a paginated
    // Helius DAS scan of every holder -- up to 20 paid pages a time.
    setInterval(updateAsdfHolders, HOLDER_LIST_SYNC_MS);

    logger.info(`[Worker] ASDF sync worker initialized (top ${topN})`);
}

module.exports = {
    initFlywheelControlWorker,
    initDeployWorker,
    reconcileSeedPositions,
    sellSeedPosition,
    initSocialWorker,
    // v13.0: New workers
    initHolderScannerWorker,
    initMetadataUpdaterWorker,
    initAsdfSyncWorker,
};
