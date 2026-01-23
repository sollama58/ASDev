/**
 * Workers Module
 * Deploy, social, and background task workers
 * v13.0 - Added holder scanner, metadata updater, and Robinhood scanner workers
 * v25.4 - Added worker event handlers for debugging job processing issues
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

        // v25.4: Debug logging for image URL tracking
        logger.info(`[Deploy] Job ${job.id} image debug`, {
            ticker,
            imageReceived: !!image,
            imageValue: image ? image.substring(0, 80) : 'NULL/UNDEFINED',
            imageType: typeof image
        });

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

// v25.27: Volume weight range (matches holderScanner.js)
const VOLUME_WEIGHT_MIN = 0.1;  // Lowest volume token gets 0.1x base points
const VOLUME_WEIGHT_MAX = 5.0;  // Highest volume token gets 5.0x base points
const MIN_VOLUME_USD = 100;     // Minimum 24hr volume for eligibility
const BASE_POINTS_PER_TOKEN = 1000; // Base points distributed per token
const TOP_HOLDERS_LIMIT = 250;  // Track top 250 holders per token

// v25.36: Pump.fun standard total supply (1 billion tokens with 6 decimals)
// All pump.fun tokens have fixed 1B supply - use this for accurate % of supply calculation
const PUMP_FUN_TOTAL_SUPPLY = BigInt('1000000000000000'); // 1B tokens * 10^6 decimals

/**
 * v25.27: Calculate dynamic volume weight for a token
 * Uses logarithmic scaling relative to the volume range of all eligible tokens
 */
function calculateVolumeWeight(tokenVolume, minVolume, maxVolume) {
    if (maxVolume <= minVolume || minVolume <= 0) return 1.0;
    const logMin = Math.log10(minVolume);
    const logMax = Math.log10(maxVolume);
    const logVolume = Math.log10(Math.max(tokenVolume, minVolume));
    const normalized = (logVolume - logMin) / (logMax - logMin);
    return Math.max(VOLUME_WEIGHT_MIN, Math.min(VOLUME_WEIGHT_MAX, VOLUME_WEIGHT_MIN + (normalized * (VOLUME_WEIGHT_MAX - VOLUME_WEIGHT_MIN))));
}

/**
 * Initialize Holder Scanner Worker
 * v25.27: MAJOR FIX - Now uses volume-weighted proportional points (same as holderScanner.js and /check-holder API)
 * - All tokens >$100 volume are eligible (not just top 10)
 * - Points are proportional to holdings (not just position count)
 * - Volume weighting: 0.5x to 2.0x multiplier based on token volume
 */
function initHolderScannerWorker(deps) {
    const { connection, devKeypair, db } = deps;

    const worker = redis.createWorker('holderScannerQueue', async (job) => {
        logger.info('[Worker] Starting holder scanner job (v25.27 - volume-weighted proportional points)...');

        try {
            // 1. Get all tokens with >$100 volume (not just top 10)
            const eligibleTokens = await db.all(
                'SELECT mint, "userPubkey", volume24h FROM tokens WHERE volume24h >= $1 ORDER BY volume24h DESC',
                [MIN_VOLUME_USD]
            );
            const eligibleMints = eligibleTokens.map(t => t.mint);

            // Calculate volume range for dynamic weighting
            let platformMinVolume = MIN_VOLUME_USD;
            let platformMaxVolume = MIN_VOLUME_USD;
            if (eligibleTokens.length > 0) {
                const volumes = eligibleTokens.map(t => parseFloat(t.volume24h) || MIN_VOLUME_USD);
                platformMinVolume = Math.min(...volumes);
                platformMaxVolume = Math.max(...volumes);
            }
            logger.info(`[Worker] Found ${eligibleTokens.length} eligible tokens (vol range: $${platformMinVolume.toFixed(0)} - $${platformMaxVolume.toFixed(0)})`);

            // 2. Cache dev wallet PUMP holdings (legacy)
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

            // 3. Calculate distribution pots based on SOL balance
            const SAFETY_RESERVE = 0.5;
            let solBalance = 0;
            try {
                const balanceLamports = await connection.getBalance(devKeypair.publicKey);
                solBalance = balanceLamports / 1e9;
            } catch (e) {
                logger.error('[Worker] Failed to fetch SOL balance', { error: e.message });
            }

            const availableForAirdrop = Math.max(0, solBalance - SAFETY_RESERVE);
            const totalDistributable = availableForAirdrop * 0.99;
            const kothPot = totalDistributable * 0.10;
            const communityPot = totalDistributable * 0.90;

            // 4. Identify KOTH Token and holders (not just creator)
            const kothToken = await db.get('SELECT mint, "userPubkey" FROM tokens ORDER BY "marketCap" DESC LIMIT 1');

            // 5. Update holders for ALL eligible tokens (not just top 10)
            for (const token of eligibleTokens) {
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
                            filters: [{ memcmp: { offset: 0, bytes: token.mint } }],
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
                            if (holdersToInsert.length >= TOP_HOLDERS_LIMIT) break;
                            if (acc.amount.lte(threshold)) continue;
                            if (acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== bondingCurvePDAStr) {
                                holdersToInsert.push({
                                    mint: token.mint,
                                    owner: acc.owner,
                                    balance: acc.amount.toString()
                                });
                            }
                        }
                    } catch (scanErr) {
                        logger.debug(`[Worker] Failed to scan holders for ${token.mint.slice(0, 8)}`, { error: scanErr.message });
                    }

                    // Update database
                    await db.run('DELETE FROM token_holders WHERE mint = $1', [token.mint]);
                    if (holdersToInsert.length > 0) {
                        const BATCH_SIZE = 50;
                        const now = Date.now();
                        for (let i = 0; i < holdersToInsert.length; i += BATCH_SIZE) {
                            const batch = holdersToInsert.slice(i, i + BATCH_SIZE);
                            const placeholders = batch.map((_, idx) => {
                                const baseIdx = idx * 5;
                                return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5})`;
                            }).join(', ');
                            const params = batch.flatMap((h, idx) => [h.mint, h.owner, i + idx + 1, h.balance || '0', now]);
                            await db.run(`
                                INSERT INTO token_holders (mint, "holderPubkey", rank, balance, "lastUpdated")
                                VALUES ${placeholders}
                                ON CONFLICT (mint, "holderPubkey") DO UPDATE SET rank = EXCLUDED.rank, balance = EXCLUDED.balance, "lastUpdated" = EXCLUDED."lastUpdated"
                            `, params);
                        }
                    }
                } catch (e) {
                    logger.error(`[Worker] Holder update error for ${token.mint?.slice(0, 8)}: ${e.message}`);
                }
                await delay(500);
            }

            // 6. Fetch ASDF Top 100 holders from Redis
            const asdfTop100Holders = await redis.getAsdfTop100Holders();

            // 7. Calculate VOLUME-WEIGHTED PROPORTIONAL points (matching holderScanner.js)
            let rawPointsMap = new Map(); // pubkey -> { basePoints, robinhoodPoints }
            let tempTotalPoints = 0;

            // Platform tokens: proportional points with volume weighting
            // v25.36: Points now based on % of TOTAL SUPPLY, not % of tracked holders
            for (const token of eligibleTokens) {
                if (!token.mint) continue;

                const tokenVolume = parseFloat(token.volume24h) || MIN_VOLUME_USD;
                const volumeWeight = calculateVolumeWeight(tokenVolume, platformMinVolume, platformMaxVolume);
                const weightedPointsForToken = BASE_POINTS_PER_TOKEN * volumeWeight;

                const holders = await db.all(
                    'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC',
                    [token.mint]
                );
                if (holders.length === 0) continue;

                for (const holder of holders) {
                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance === BigInt(0)) continue;

                    // v25.36: Calculate points based on % of total supply (1B tokens)
                    // If user holds 1% of total supply, they get 1% of the token's weighted points
                    const proportionalPoints = Number((holderBalance * BigInt(Math.round(weightedPointsForToken * 1000))) / PUMP_FUN_TOTAL_SUPPLY) / 1000;
                    // v25.33: Track positions count for user_points table
                    const entry = rawPointsMap.get(holder.holderPubkey) || { basePoints: 0, robinhoodPoints: 0, positionsCount: 0 };
                    entry.basePoints += proportionalPoints;
                    entry.positionsCount++;
                    rawPointsMap.set(holder.holderPubkey, entry);
                }
            }

            // 8. Include Robinhood token holders (with volume weighting and fee share scaling)
            try {
                const robinhoodTokens = await db.all(
                    'SELECT mint, "feeShareBps", volume24h FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL AND volume24h >= $1',
                    [MIN_VOLUME_USD]
                );

                let rhMinVolume = MIN_VOLUME_USD, rhMaxVolume = MIN_VOLUME_USD;
                if (robinhoodTokens.length > 0) {
                    const rhVolumes = robinhoodTokens.map(t => parseFloat(t.volume24h) || MIN_VOLUME_USD);
                    rhMinVolume = Math.min(...rhVolumes);
                    rhMaxVolume = Math.max(...rhVolumes);
                }
                logger.info(`[Worker] Found ${robinhoodTokens.length} eligible Robinhood tokens (vol range: $${rhMinVolume.toFixed(0)} - $${rhMaxVolume.toFixed(0)})`);

                // v25.36: Points now based on % of TOTAL SUPPLY for Robinhood tokens too
                for (const rhToken of robinhoodTokens) {
                    if (!rhToken.mint) continue;

                    const tokenVolume = parseFloat(rhToken.volume24h) || MIN_VOLUME_USD;
                    const volumeWeight = calculateVolumeWeight(tokenVolume, rhMinVolume, rhMaxVolume);
                    const weightedBasePoints = BASE_POINTS_PER_TOKEN * volumeWeight;
                    const feeShareMultiplier = (rhToken.feeShareBps || 10000) / 10000;

                    const holders = await db.all(
                        'SELECT "holderPubkey", balance FROM robinhood_token_holders WHERE mint = $1 ORDER BY rank ASC',
                        [rhToken.mint]
                    );
                    if (holders.length === 0) continue;

                    for (const holder of holders) {
                        const holderBalance = BigInt(holder.balance || '0');
                        if (holderBalance === BigInt(0)) continue;

                        // v25.36: Calculate points based on % of total supply (1B tokens)
                        const baseProportionalPoints = Number((holderBalance * BigInt(Math.round(weightedBasePoints * 1000))) / PUMP_FUN_TOTAL_SUPPLY) / 1000;
                        const scaledPoints = baseProportionalPoints * feeShareMultiplier;

                        // v25.33: Track positions count for user_points table
                        const entry = rawPointsMap.get(holder.holderPubkey) || { basePoints: 0, robinhoodPoints: 0, positionsCount: 0 };
                        entry.robinhoodPoints += scaledPoints;
                        entry.positionsCount++;
                        rawPointsMap.set(holder.holderPubkey, entry);
                    }
                }
            } catch (e) {
                logger.debug('[Worker] Robinhood holder points calculation skipped', { error: e.message });
            }

            // 9. Calculate final points with ASDF multiplier
            const devPubkeyStr = devKeypair.publicKey.toString();
            for (const [pubkey, data] of rawPointsMap.entries()) {
                if (pubkey === devPubkeyStr) continue;
                const isAsdfTop100 = asdfTop100Holders.has(pubkey);
                const basePoints = data.basePoints + data.robinhoodPoints;
                const totalPoints = basePoints * (isAsdfTop100 ? 2 : 1);
                if (totalPoints > 0) tempTotalPoints += totalPoints;
            }

            await redis.setTotalPoints(tempTotalPoints);
            logger.info(`[Worker] Global Points: ${tempTotalPoints.toFixed(2)} | Community Pot: ${communityPot.toFixed(4)} SOL | KOTH Pot: ${kothPot.toFixed(4)} SOL`);

            // 10. Update expected airdrops in Redis
            await redis.clearUserExpectedAirdrops();
            await redis.clearUserPoints();

            // Calculate KOTH holders' share (proportional, not just creator)
            let kothHoldersMap = new Map();
            if (kothToken && kothToken.mint) {
                const kothHolders = await db.all(
                    'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1',
                    [kothToken.mint]
                );
                let kothTotalBalance = BigInt(0);
                for (const h of kothHolders) kothTotalBalance += BigInt(h.balance || '0');

                if (kothTotalBalance > BigInt(0)) {
                    for (const holder of kothHolders) {
                        const holderBalance = BigInt(holder.balance || '0');
                        if (holderBalance === BigInt(0)) continue;
                        const share = Number(holderBalance * BigInt(10000) / kothTotalBalance) / 10000;
                        kothHoldersMap.set(holder.holderPubkey, share * kothPot);
                    }
                }
            }

            const userExpectedAirdrops = new Map();
            const userPointsMap = new Map();
            const userPointsData = []; // v25.33: For database storage

            for (const [pubkey, data] of rawPointsMap.entries()) {
                if (pubkey === devPubkeyStr) continue;

                const isAsdfTop100 = asdfTop100Holders.has(pubkey);
                const multiplier = isAsdfTop100 ? 2 : 1;
                const points = (data.basePoints + data.robinhoodPoints) * multiplier;

                if (points > 0) {
                    userPointsMap.set(pubkey, points);

                    let expected = 0;
                    if (communityPot > 0 && tempTotalPoints > 0) {
                        expected = (points / tempTotalPoints) * communityPot;
                    }
                    // Add KOTH bonus if applicable
                    expected += kothHoldersMap.get(pubkey) || 0;
                    userExpectedAirdrops.set(pubkey, expected);

                    // v25.33: Collect data for database upsert
                    userPointsData.push({
                        pubkey,
                        basePoints: data.basePoints,
                        robinhoodPoints: data.robinhoodPoints,
                        multiplier,
                        totalPoints: points,
                        expectedAirdropSol: expected,
                        positionsCount: data.positionsCount || 0,
                        isAsdfHolder: isAsdfTop100
                    });
                }
            }

            // KOTH edge case: holders with 0 community points still get KOTH share
            for (const [pubkey, kothShare] of kothHoldersMap.entries()) {
                if (pubkey === devPubkeyStr) continue;
                if (!userExpectedAirdrops.has(pubkey) && kothShare > 0) {
                    userExpectedAirdrops.set(pubkey, kothShare);
                    // v25.33: Add KOTH-only holders to database
                    userPointsData.push({
                        pubkey,
                        basePoints: 0,
                        robinhoodPoints: 0,
                        multiplier: 1,
                        totalPoints: 0,
                        expectedAirdropSol: kothShare,
                        positionsCount: 0,
                        isAsdfHolder: false
                    });
                }
            }

            // v25.33: Write to user_points table (single source of truth)
            const now = Date.now();
            try {
                // Clear old points that are no longer active
                await db.run('DELETE FROM user_points WHERE updated_at < $1 OR updated_at IS NULL', [now - 3600000]); // Remove stale entries older than 1 hour

                // Batch upsert in chunks of 100 for performance
                const BATCH_SIZE = 100;
                for (let i = 0; i < userPointsData.length; i += BATCH_SIZE) {
                    const batch = userPointsData.slice(i, i + BATCH_SIZE);
                    const values = batch.map((_, idx) => {
                        const base = idx * 9;
                        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
                    }).join(', ');

                    const params = batch.flatMap(u => [
                        u.pubkey,
                        u.basePoints,
                        u.robinhoodPoints,
                        u.multiplier,
                        u.totalPoints,
                        u.expectedAirdropSol,
                        u.positionsCount,
                        u.isAsdfHolder,
                        now
                    ]);

                    await db.run(`
                        INSERT INTO user_points (pubkey, base_points, robinhood_points, multiplier, total_points, expected_airdrop_sol, positions_count, is_asdf_holder, updated_at)
                        VALUES ${values}
                        ON CONFLICT (pubkey) DO UPDATE SET
                            base_points = EXCLUDED.base_points,
                            robinhood_points = EXCLUDED.robinhood_points,
                            multiplier = EXCLUDED.multiplier,
                            total_points = EXCLUDED.total_points,
                            expected_airdrop_sol = EXCLUDED.expected_airdrop_sol,
                            positions_count = EXCLUDED.positions_count,
                            is_asdf_holder = EXCLUDED.is_asdf_holder,
                            updated_at = EXCLUDED.updated_at
                    `, params);
                }
                logger.info(`[Worker] Wrote ${userPointsData.length} users to user_points table`);
            } catch (e) {
                logger.error('[Worker] Failed to write user_points table', { error: e.message });
                // Don't throw - Redis is still updated as fallback
            }

            // Continue updating Redis for backwards compatibility (during migration)
            await redis.setAllUserExpectedAirdrops(userExpectedAirdrops);
            await redis.setAllUserPoints(userPointsMap);
            await redis.setLastBackendUpdate(Date.now());

            logger.info(`[Worker] Holder scanner complete - ${userPointsMap.size} users with points`);
            return { success: true, totalPoints: tempTotalPoints, usersWithPoints: userPointsMap.size };

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
                        // v25.4: Check if token already has an image (preserve Imgur URLs)
                        const tokenHasImage = t.image && t.image !== '' && t.image !== 'null';

                        if (data) {
                            // v25.4: Only update image if token doesn't already have one
                            if (data.imageUrl && !tokenHasImage) {
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
