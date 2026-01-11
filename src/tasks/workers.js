/**
 * Workers Module
 * Deploy, social, and background task workers
 * v13.0 - Added holder scanner, metadata updater, and Robinhood scanner workers
 */
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const { getAssociatedTokenAddress, createCloseAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const axios = require('axios');
const config = require('../config/env');
const { PROGRAMS, WALLETS, TOKENS } = require('../config/constants');
const { logger, redis, pump, vanity, solana, twitter, imageUtils } = require('../services');

/**
 * Initialize deploy worker
 */
function initDeployWorker(deps) {
    const { connection, devKeypair, db, saveTokenData, refundUser } = deps;

    const worker = redis.createWorker('deployQueue', async (job) => {
        logger.info(`STARTING JOB ${job.id}: ${job.data.ticker}`);
        
        // Image here is now the URL passed from deploy route, NOT base64
        const { name, ticker, description, twitter: twitterHandle, website, image, userPubkey, isMayhemMode, metadataUri } = job.data;

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
            const sig = await solana.sendTxWithRetry(tx, [devKeypair, mintKeypair]);
            logger.info(`Transaction Confirmed: ${sig}`);

            // CRITICAL: Save data with the explicit Image URL we got from Pinata
            logger.info(`[Deploy] Saving token to database...`, {
                mint: mint.toString(),
                ticker,
                name,
                userPubkey,
                hasImage: !!image,
                hasMetadataUri: !!metadataUri
            });

            try {
                await saveTokenData(userPubkey, mint.toString(), {
                    name, ticker, description, twitter: twitterHandle,
                    website, image, // <-- This is now the URL
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

            // Sell tokens logic (Keep existing)
            setTimeout(async () => {
                try {
                    const bal = await connection.getTokenAccountBalance(associatedUser);
                    if (bal.value?.uiAmount > 0) {
                        const sellData = pump.buildSellInstructionData(new BN(bal.value.amount));
                        // ... (Keep sell keys) ...
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
                } catch (e) { logger.error("Sell error", { msg: e.message }); }
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
 * Runs as a job-based worker that updates token holders and calculates global points
 */
function initHolderScannerWorker(deps) {
    const { connection, devKeypair, db } = deps;

    const worker = redis.createWorker('holderScannerQueue', async (job) => {
        logger.info('[Worker] Starting holder scanner job...');

        try {
            // 1. Fetch Top 10 tokens by volume (v13.0: PostgreSQL syntax)
            const topTokens = await db.all('SELECT mint, "userPubkey" FROM tokens ORDER BY volume24h DESC LIMIT 10');
            const top10Mints = topTokens.map(t => t.mint);

            // 2. Cache dev wallet PUMP holdings (legacy, kept for backwards compatibility)
            let devPumpHoldings = 0;
            try {
                const devPumpAta = await getAssociatedTokenAddress(
                    TOKENS.PUMP, devKeypair.publicKey, false, PROGRAMS.TOKEN_2022
                );
                const tokenBal = await connection.getTokenAccountBalance(devPumpAta);
                devPumpHoldings = tokenBal.value.uiAmount || 0;
            } catch (e) {
                devPumpHoldings = 0;
            }
            await redis.setDevPumpHoldings(devPumpHoldings);

            // 3. Calculate distribution pots based on SOL balance (v11.0+: SOL airdrops)
            // BUG FIX: Previously used devPumpHoldings which was for PUMP token airdrops
            // Now we use the actual SOL balance available for airdrop distribution
            const SAFETY_RESERVE = 0.5; // SOL reserved for operations
            let solBalance = 0;
            try {
                const balanceLamports = await connection.getBalance(devKeypair.publicKey);
                solBalance = balanceLamports / 1e9; // Convert lamports to SOL
            } catch (e) {
                logger.error('[Worker] Failed to fetch SOL balance', { error: e.message });
                solBalance = 0;
            }

            const availableForAirdrop = Math.max(0, solBalance - SAFETY_RESERVE);
            const totalDistributable = availableForAirdrop * 0.99; // 99% distributed, 1% buffer
            const kothPot = totalDistributable * 0.10;
            const communityPot = totalDistributable * 0.90;

            // 4. Identify KOTH Creator (v13.0: PostgreSQL syntax)
            const kothToken = await db.get('SELECT "userPubkey" FROM tokens ORDER BY "marketCap" DESC LIMIT 1');
            const kothCreator = kothToken ? kothToken.userPubkey : null;

            // 5. Update holders for each top token
            for (const token of topTokens) {
                try {
                    if (!token.mint) continue;

                    const tokenMintPublicKey = new PublicKey(token.mint);
                    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                        [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
                        PROGRAMS.PUMP
                    );

                    const holdersToInsert = [];

                    try {
                        const accounts = await connection.getProgramAccounts(PROGRAMS.TOKEN_2022, {
                            filters: [
                                { memcmp: { offset: 0, bytes: token.mint } }
                            ],
                            encoding: 'base64'
                        });

                        const parsedAccounts = accounts.map(acc => {
                            const data = Buffer.from(acc.account.data);
                            if (data.length < 72) return null;

                            const owner = new PublicKey(data.slice(32, 64)).toString();
                            const amount = new BN(data.slice(64, 72), 'le');
                            return { owner, amount };
                        })
                            .filter(a => a !== null)
                            .sort((a, b) => b.amount.cmp(a.amount));

                        const bondingCurvePDAStr = bondingCurvePDA.toString();
                        const threshold = new BN(1000000);

                        for (const acc of parsedAccounts) {
                            if (holdersToInsert.length >= 100) break;
                            if (acc.amount.lte(threshold)) continue;

                            if (acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== bondingCurvePDAStr) {
                                holdersToInsert.push({ mint: token.mint, owner: acc.owner });
                            }
                        }
                    } catch (scanErr) {
                        logger.error(`[Worker] Failed to scan holders for ${token.mint}`, { error: scanErr.message });
                    }

                    // Update database - SCALABILITY FIX: Use batch insert instead of N+1 queries
                    await db.run('DELETE FROM token_holders WHERE mint = $1', [token.mint]);

                    if (holdersToInsert.length > 0) {
                        // v24.0 SECURITY FIX: Use parameterized queries to prevent SQL injection
                        const BATCH_SIZE = 50;
                        const now = Date.now();
                        for (let i = 0; i < holdersToInsert.length; i += BATCH_SIZE) {
                            const batch = holdersToInsert.slice(i, i + BATCH_SIZE);
                            // Build parameterized placeholders: ($1, $2, $3, $4), ($5, $6, $7, $8), ...
                            const placeholders = batch.map((_, idx) => {
                                const baseIdx = idx * 4;
                                return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4})`;
                            }).join(', ');

                            // Flatten params array: [mint1, owner1, rank1, now, mint2, owner2, rank2, now, ...]
                            const params = batch.flatMap((h, idx) => [
                                h.mint,
                                h.owner,
                                i + idx + 1, // rank
                                now
                            ]);

                            await db.run(`
                                INSERT INTO token_holders (mint, "holderPubkey", rank, "lastUpdated")
                                VALUES ${placeholders}
                                ON CONFLICT DO NOTHING
                            `, params);
                        }
                    }
                } catch (e) {
                    logger.error(`[Worker] Holder update loop error for ${token.mint}: ${e.message}`);
                }

                await delay(500); // SCALABILITY FIX: Reduced from 2000ms to 500ms
            }

            // 6. Fetch ASDF Top 100 holders from Redis
            const asdfTop100Holders = await redis.getAsdfTop100Holders();

            // 7. Calculate global points
            let rawPointsMap = new Map();
            let tempTotalPoints = 0;

            if (top10Mints.length > 0) {
                const placeholders = top10Mints.map((_, i) => `$${i + 1}`).join(',');
                const rows = await db.all(
                    `SELECT "holderPubkey", COUNT(*) as "positionCount" FROM token_holders WHERE mint IN (${placeholders}) GROUP BY "holderPubkey"`,
                    top10Mints
                );

                for (const row of rows) {
                    rawPointsMap.set(row.holderPubkey, { holderPoints: parseInt(row.positionCount), creatorPoints: 0, robinhoodPoints: 0 });
                }

                for (const token of topTokens) {
                    if (token.userPubkey) {
                        const entry = rawPointsMap.get(token.userPubkey) || { holderPoints: 0, creatorPoints: 0, robinhoodPoints: 0 };
                        entry.creatorPoints += 1;
                        rawPointsMap.set(token.userPubkey, entry);
                    }
                }
            }

            // 8. Include Robinhood token holders
            try {
                const robinhoodTokens = await db.all('SELECT mint FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL LIMIT 10');
                const robinhoodMints = robinhoodTokens.map(t => t.mint).filter(m => m);

                if (robinhoodMints.length > 0) {
                    const rhPlaceholders = robinhoodMints.map((_, i) => `$${i + 1}`).join(',');
                    const robinhoodRows = await db.all(
                        `SELECT "holderPubkey", COUNT(*) as "positionCount" FROM robinhood_token_holders WHERE mint IN (${rhPlaceholders}) GROUP BY "holderPubkey"`,
                        robinhoodMints
                    );

                    for (const row of robinhoodRows) {
                        const entry = rawPointsMap.get(row.holderPubkey) || { holderPoints: 0, creatorPoints: 0, robinhoodPoints: 0 };
                        entry.robinhoodPoints = parseInt(row.positionCount);
                        rawPointsMap.set(row.holderPubkey, entry);
                    }

                    logger.debug(`[Worker] Included ${robinhoodRows.length} unique holders from ${robinhoodMints.length} Robinhood tokens`);
                }
            } catch (e) {
                logger.debug('[Worker] Robinhood holder points calculation skipped', { error: e.message });
            }

            // 9. Calculate final points
            const devPubkeyStr = devKeypair.publicKey.toString();
            for (const [pubkey, data] of rawPointsMap.entries()) {
                if (pubkey === devPubkeyStr) continue;

                const isAsdfTop100 = asdfTop100Holders.has(pubkey);
                const basePoints = data.holderPoints + (data.creatorPoints * 2) + (data.robinhoodPoints || 0);
                const totalPoints = basePoints * (isAsdfTop100 ? 2 : 1);

                if (totalPoints > 0) {
                    tempTotalPoints += totalPoints;
                }
            }

            await redis.setTotalPoints(tempTotalPoints);
            logger.info(`[Worker] Global Points: ${tempTotalPoints} | Community Pot: ${communityPot.toFixed(4)} SOL | KOTH Pot: ${kothPot.toFixed(4)} SOL | Available: ${availableForAirdrop.toFixed(4)} SOL`);

            // 10. Update expected airdrops in Redis
            await redis.clearUserExpectedAirdrops();
            await redis.clearUserPoints();

            const userExpectedAirdrops = new Map();
            const userPointsMap = new Map();

            for (const [pubkey, data] of rawPointsMap.entries()) {
                if (pubkey === devPubkeyStr) continue;

                const isAsdfTop100 = asdfTop100Holders.has(pubkey);
                const points = (data.holderPoints + (data.creatorPoints * 2) + (data.robinhoodPoints || 0)) * (isAsdfTop100 ? 2 : 1);

                if (points > 0) {
                    userPointsMap.set(pubkey, points);

                    let expected = 0;
                    if (communityPot > 0 && tempTotalPoints > 0) {
                        const share = points / tempTotalPoints;
                        expected = share * communityPot;
                    }

                    if (pubkey === kothCreator) {
                        expected += kothPot;
                    }

                    userExpectedAirdrops.set(pubkey, expected);
                }
            }

            // KOTH edge case
            if (kothCreator && !userExpectedAirdrops.has(kothCreator) && kothCreator !== devPubkeyStr) {
                userExpectedAirdrops.set(kothCreator, kothPot);
            }

            await redis.setAllUserExpectedAirdrops(userExpectedAirdrops);
            await redis.setAllUserPoints(userPointsMap);
            await redis.setLastBackendUpdate(Date.now());

            logger.info('[Worker] Holder scanner job complete');
            return { success: true, totalPoints: tempTotalPoints };

        } catch (e) {
            logger.error('[Worker] Holder scanner error', { error: e.message });
            throw e;
        }
    }, { concurrency: 2 }); // SCALABILITY FIX: Increased concurrency from 1 to 2

    // Schedule recurring jobs
    setInterval(async () => {
        try {
            await redis.addHolderScannerJob({});
        } catch (e) {
            logger.error('[Worker] Failed to schedule holder scanner job', { error: e.message });
        }
    }, config.HOLDER_UPDATE_INTERVAL);

    // Initial job after 5 seconds
    setTimeout(async () => {
        try {
            await redis.addHolderScannerJob({});
        } catch (e) {
            logger.error('[Worker] Failed to add initial holder scanner job', { error: e.message });
        }
    }, 5000);

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
            // SCALABILITY FIX: Add pagination to avoid loading all tokens into memory
            const TOKENS_PER_PAGE = 100;
            let offset = 0;
            let totalScanned = 0;

            while (true) {
                const tokens = await db.all('SELECT mint FROM tokens ORDER BY "lastUpdated" ASC NULLS FIRST LIMIT $1 OFFSET $2', [TOKENS_PER_PAGE, offset]);
                if (tokens.length === 0) break;

                totalScanned += tokens.length;
                offset += TOKENS_PER_PAGE;

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

                    // Update tokens that DexScreener has data for
                    const misses = [];
                    for (const t of chunk) {
                        const data = updates.get(t.mint);

                        if (data) {
                            if (data.imageUrl) {
                                await db.run(
                                    `UPDATE tokens SET volume24h = $1, "marketCap" = $2, "priceUsd" = $3, "lastUpdated" = $4, image = $5 WHERE mint = $6`,
                                    [data.volume24h, data.marketCap, data.priceUsd, Date.now(), data.imageUrl, t.mint]
                                );
                            } else {
                                await db.run(
                                    `UPDATE tokens SET volume24h = $1, "marketCap" = $2, "priceUsd" = $3, "lastUpdated" = $4 WHERE mint = $5`,
                                    [data.volume24h, data.marketCap, data.priceUsd, Date.now(), t.mint]
                                );
                            }
                        } else {
                            misses.push(t.mint);
                        }
                    }

                    // Batch fetch Helius data for all DexScreener misses (1 call instead of N)
                    if (misses.length > 0 && config.HELIUS_API_KEY) {
                        try {
                            const heliusRes = await axios.post(
                                `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
                                {
                                    jsonrpc: '2.0',
                                    id: '1',
                                    method: 'getAssetBatch',
                                    params: { ids: misses, displayOptions: { showFungible: true } }
                                },
                                { timeout: 10000 }
                            );
                            const assets = heliusRes.data?.result || [];
                            for (const asset of assets) {
                                if (asset?.id) {
                                    const marketCap = asset?.token_info?.price_info?.total_price || 0;
                                    // v21.0: Clean CDN-wrapped URLs
                                    const image = imageUtils.extractHeliusBatchImage(asset);

                                    // Update with both marketCap and image if available
                                    if (image && marketCap > 0) {
                                        await db.run(
                                            `UPDATE tokens SET "marketCap" = $1, image = $2, "lastUpdated" = $3 WHERE mint = $4`,
                                            [marketCap, image, Date.now(), asset.id]
                                        );
                                    } else if (marketCap > 0) {
                                        await db.run(
                                            `UPDATE tokens SET "marketCap" = $1, "lastUpdated" = $2 WHERE mint = $3`,
                                            [marketCap, Date.now(), asset.id]
                                        );
                                    } else if (image) {
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
    }, config.METADATA_UPDATE_INTERVAL);

    // Initial job after 5 seconds
    setTimeout(async () => {
        try {
            await redis.addMetadataUpdaterJob({});
        } catch (e) {
            logger.error('[Worker] Failed to add initial metadata updater job', { error: e.message });
        }
    }, 5000);

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

    // Initial job after 10 seconds
    setTimeout(async () => {
        try {
            await redis.addRobinhoodScannerJob({});
        } catch (e) {
            logger.error('[Worker] Failed to add initial Robinhood scanner job', { error: e.message });
        }
    }, 10000);

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

            const parsedAccounts = accounts.map(acc => {
                const data = Buffer.from(acc.account.data);
                const owner = new PublicKey(data.slice(32, 64)).toString();
                const amount = new BN(data.slice(64, 72), 'le');
                return { owner, amount };
            })
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

module.exports = {
    initDeployWorker,
    initSocialWorker,
    // v13.0: New workers
    initHolderScannerWorker,
    initMetadataUpdaterWorker,
    initRobinhoodScannerWorker,
    initAsdfSyncWorker,
};
