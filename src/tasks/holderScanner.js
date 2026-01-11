/**
 * Holder Scanner Task
 * Updates token holders and calculates global points
 *
 * v14.0 - Changed to Top 250 holders with proportional points based on holdings
 *         Points are now calculated proportionally to token balance, not just position count
 * v17.0 - Fixed expected airdrop calculation to use actual SOL balance (not PUMP holdings)
 * v18.0 - Changed from top 10 tokens to all tokens with >$100 24hr volume
 */
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { BN } = require('@coral-xyz/anchor');
const config = require('../config/env');
const { TOKENS, PROGRAMS, WALLETS } = require('../config/constants');
const { logger } = require('../services');

// Constants for point calculation
const TOP_HOLDERS_LIMIT = 250; // Track top 250 holders per eligible token
const CREATOR_BONUS_MULTIPLIER = 2; // Creators get 2x points on their created tokens
const SAFETY_RESERVE_SOL = 0.5; // Reserve 0.5 SOL for operations
const MIN_VOLUME_USD = config.AIRDROP_MIN_VOLUME_USD || 100; // v18.0: Minimum 24hr volume for eligibility

/**
 * Update global state (holders, points, expected airdrops)
 *
 * v14.0 - New proportional point system:
 * - Track top 250 holders of each eligible token
 * - Points are proportional to holdings (balance / total supply held by top 250)
 * - Each token contributes 1000 base points distributed proportionally among holders
 * - Creator bonus: 2x points for tokens they created
 * - ASDF multiplier: 2x total points if top 100 ASDF holder
 * - KOTH: 10% of airdrop reserved for king token holders (unchanged)
 *
 * v18.0 - Eligibility now based on volume threshold:
 * - All tokens with >$100 24hr volume are eligible (no limit)
 * - Includes both tokens table and robinhood_tokens table
 */
async function updateGlobalState(deps) {
    const { connection, devKeypair, db, globalState } = deps;

    try {
        // v18.0: Get all tokens with >$100 24hr volume (no limit)
        const eligibleTokens = await db.all(
            'SELECT mint, userPubkey FROM tokens WHERE volume24h >= $1 ORDER BY volume24h DESC',
            [MIN_VOLUME_USD]
        );
        const eligibleMints = eligibleTokens.map(t => t.mint);

        logger.debug(`[HolderScanner] Found ${eligibleTokens.length} eligible tokens with >${MIN_VOLUME_USD} USD volume`);

        // v17.0: Get actual SOL balance for expected airdrop calculation (not PUMP holdings)
        let availableSolForAirdrop = 0;
        try {
            const solBalance = await connection.getBalance(devKeypair.publicKey);
            // Available for airdrop = SOL balance minus safety reserve
            const safetyReserveLamports = SAFETY_RESERVE_SOL * LAMPORTS_PER_SOL;
            availableSolForAirdrop = Math.max(0, (solBalance - safetyReserveLamports) / LAMPORTS_PER_SOL);
            globalState.devSolBalance = solBalance / LAMPORTS_PER_SOL;
        } catch (e) {
            availableSolForAirdrop = 0;
            globalState.devSolBalance = 0;
        }

        // --- CALCULATION LOGIC ---

        // 1. Determine Pots (based on actual SOL available for airdrop)
        const totalDistributable = availableSolForAirdrop * 0.99; // 99% distributed, 1% dust buffer

        // KOTH gets 10% of the distributable amount
        const kothPot = totalDistributable * 0.10;

        // Community gets the remaining 90%
        const communityPot = totalDistributable * 0.90;

        // 2. Identify KOTH Token (for expected airdrop calculation)
        const kothToken = await db.get('SELECT mint, userPubkey FROM tokens ORDER BY "marketCap" DESC LIMIT 1');

        // --- END CALCULATION PREP ---

        // v18.0: Update holders for all eligible tokens (>$100 volume) - tracking Top 250 with balances
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
                    const threshold = new BN(1000000); // Minimum balance threshold (dust filter)

                    for (const acc of parsedAccounts) {
                        // v14.0: Track Top 250 Holders of Leaderboard Tokens
                        if (holdersToInsert.length >= TOP_HOLDERS_LIMIT) break;

                        if (acc.amount.lte(threshold)) continue;

                        if (acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== bondingCurvePDAStr) {
                            holdersToInsert.push({
                                mint: token.mint,
                                owner: acc.owner,
                                balance: acc.amount.toString() // Store balance for proportional calculation
                            });
                        }
                    }
                } catch (scanErr) {
                    logger.error(`Failed to scan holders for ${token.mint}`, { error: scanErr.message });
                }

                await db.run('BEGIN TRANSACTION');
                try {
                    await db.run('DELETE FROM token_holders WHERE mint = ?', token.mint);

                    if (holdersToInsert.length > 0) {
                        let rank = 1;
                        for (const h of holdersToInsert) {
                            await db.run(
                                'INSERT OR IGNORE INTO token_holders (mint, holderPubkey, rank, balance, lastUpdated) VALUES (?, ?, ?, ?, ?)',
                                [h.mint, h.owner, rank, h.balance, Date.now()]
                            );
                            rank++;
                        }
                    }
                    await db.run('COMMIT');
                } catch (err) {
                    await db.run('ROLLBACK');
                    throw err;
                }
            } catch (e) {
                logger.error(`Holder update loop error for ${token.mint}: ${e.message}`);
            }

            await new Promise(r => setTimeout(r, 2000));
        }

        // v14.0: Calculate global points with proportional holdings
        // Each token distributes 1000 base points proportionally among its top 250 holders
        const POINTS_PER_TOKEN = 1000;
        let rawPointsMap = new Map(); // pubkey -> { basePoints, creatorBonus, robinhoodPoints }
        let tempTotalPoints = 0;

        if (eligibleMints.length > 0) {
            // v18.0: For each eligible token (>$100 volume), calculate proportional points
            for (const token of eligibleTokens) {
                if (!token.mint) continue;

                // Get all holders with balances for this token
                const holders = await db.all(
                    'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1 ORDER BY rank ASC',
                    [token.mint]
                );

                if (holders.length === 0) continue;

                // Calculate total balance held by top 250
                let totalBalance = BigInt(0);
                for (const h of holders) {
                    totalBalance += BigInt(h.balance || '0');
                }

                if (totalBalance === BigInt(0)) continue;

                // Distribute points proportionally
                for (const holder of holders) {
                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance === BigInt(0)) continue;

                    // Calculate proportional points for this token
                    // points = (holderBalance / totalBalance) * POINTS_PER_TOKEN
                    const proportionalPoints = Number((holderBalance * BigInt(POINTS_PER_TOKEN * 1000)) / totalBalance) / 1000;

                    // Check if this holder is the creator (gets 2x bonus)
                    const isCreator = holder.holderPubkey === token.userPubkey;
                    const pointsWithBonus = isCreator ? proportionalPoints * CREATOR_BONUS_MULTIPLIER : proportionalPoints;

                    // Accumulate points
                    const entry = rawPointsMap.get(holder.holderPubkey) || {
                        basePoints: 0,
                        creatorBonus: 0,
                        robinhoodPoints: 0
                    };

                    if (isCreator) {
                        entry.creatorBonus += pointsWithBonus - proportionalPoints; // Track the bonus separately
                    }
                    entry.basePoints += proportionalPoints;
                    rawPointsMap.set(holder.holderPubkey, entry);
                }
            }
        }

        // v12.0: Include Robinhood token holders in points calculation
        // Holders of tokens that share fees with us also earn airdrop eligibility
        // v16.0: Points are now scaled proportionally to our fee share percentage
        // v18.0: All robinhood tokens with >$100 volume are eligible (no limit)
        try {
            const robinhoodTokens = await db.all(
                'SELECT mint, "feeShareBps", ticker FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL AND volume24h >= $1',
                [MIN_VOLUME_USD]
            );
            const robinhoodMints = robinhoodTokens.map(t => t.mint).filter(m => m);

            logger.debug(`[HolderScanner] Found ${robinhoodMints.length} eligible Robinhood tokens with >${MIN_VOLUME_USD} USD volume`);

            if (robinhoodMints.length > 0) {
                // For each robinhood token, calculate proportional points scaled by our fee share
                for (const rhToken of robinhoodTokens) {
                    if (!rhToken.mint) continue;

                    // Get fee share multiplier (100% = 10000 bps = 1.0 multiplier)
                    const feeShareBps = rhToken.feeShareBps || 10000; // Default to 100% if not set
                    const feeShareMultiplier = feeShareBps / 10000; // Convert BPS to decimal (1000 bps = 0.1 = 10%)

                    logger.debug(`[Robinhood] ${rhToken.ticker || rhToken.mint.slice(0, 8)}: Fee share ${(feeShareMultiplier * 100).toFixed(1)}% (${feeShareBps} bps)`);

                    const holders = await db.all(
                        'SELECT "holderPubkey", balance FROM robinhood_token_holders WHERE mint = $1 ORDER BY rank ASC',
                        [rhToken.mint]
                    );

                    if (holders.length === 0) continue;

                    // Calculate total balance
                    let totalBalance = BigInt(0);
                    for (const h of holders) {
                        totalBalance += BigInt(h.balance || '0');
                    }

                    if (totalBalance === BigInt(0)) continue;

                    // Distribute points proportionally, scaled by fee share percentage
                    for (const holder of holders) {
                        const holderBalance = BigInt(holder.balance || '0');
                        if (holderBalance === BigInt(0)) continue;

                        // Base proportional points for this token
                        const baseProportionalPoints = Number((holderBalance * BigInt(POINTS_PER_TOKEN * 1000)) / totalBalance) / 1000;
                        // Scale by our fee share percentage (100% share = full points, 50% share = half points)
                        const scaledPoints = baseProportionalPoints * feeShareMultiplier;

                        const entry = rawPointsMap.get(holder.holderPubkey) || {
                            basePoints: 0,
                            creatorBonus: 0,
                            robinhoodPoints: 0
                        };
                        entry.robinhoodPoints += scaledPoints;
                        rawPointsMap.set(holder.holderPubkey, entry);
                    }
                }

                logger.debug(`[Robinhood] Calculated proportional points for ${robinhoodMints.length} Robinhood tokens (scaled by fee share %)`);
            }
        } catch (e) {
            logger.debug('[Robinhood] Holder points calculation skipped', { error: e.message });
        }

        // Calculate final points including ASDF multiplier
        for (const [pubkey, data] of rawPointsMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;

            // CHECK ASDF MULTIPLIER (Top 100)
            const isAsdfTop100 = globalState.asdfTop50Holders.has(pubkey);

            // Total base points from all sources
            const basePoints = data.basePoints + data.creatorBonus + data.robinhoodPoints;
            const totalPoints = basePoints * (isAsdfTop100 ? 2 : 1);

            if (totalPoints > 0) {
                tempTotalPoints += totalPoints;
            }
        }

        globalState.totalPoints = tempTotalPoints;
        globalState.availableSolForAirdrop = availableSolForAirdrop; // v17.0: Track available SOL
        logger.info(`Global Points: ${globalState.totalPoints.toFixed(2)} | Available SOL: ${availableSolForAirdrop.toFixed(4)} | Community Pot: ${communityPot.toFixed(4)} SOL | KOTH Pot: ${kothPot.toFixed(4)} SOL`);

        // Update expected airdrops and points map
        globalState.userExpectedAirdrops.clear();
        globalState.userPointsMap.clear();

        // Get KOTH holders for expected airdrop calculation
        let kothHoldersMap = new Map(); // pubkey -> proportional share of KOTH pot
        if (kothToken && kothToken.mint) {
            const kothHolders = await db.all(
                'SELECT "holderPubkey", balance FROM token_holders WHERE mint = $1',
                [kothToken.mint]
            );

            let kothTotalBalance = BigInt(0);
            for (const h of kothHolders) {
                kothTotalBalance += BigInt(h.balance || '0');
            }

            if (kothTotalBalance > BigInt(0)) {
                for (const holder of kothHolders) {
                    const holderBalance = BigInt(holder.balance || '0');
                    if (holderBalance === BigInt(0)) continue;

                    const share = Number(holderBalance * BigInt(10000) / kothTotalBalance) / 10000;
                    kothHoldersMap.set(holder.holderPubkey, share * kothPot);
                }
            }
        }

        for (const [pubkey, data] of rawPointsMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;

            const isAsdfTop100 = globalState.asdfTop50Holders.has(pubkey);
            const basePoints = data.basePoints + data.creatorBonus + data.robinhoodPoints;
            const points = basePoints * (isAsdfTop100 ? 2 : 1);

            if (points > 0) {
                globalState.userPointsMap.set(pubkey, points);

                let expected = 0;

                // Community share based on points
                if (communityPot > 0 && globalState.totalPoints > 0) {
                    const share = points / globalState.totalPoints;
                    expected = share * communityPot;
                }

                // Add KOTH bonus if applicable
                const kothBonus = kothHoldersMap.get(pubkey) || 0;
                expected += kothBonus;

                globalState.userExpectedAirdrops.set(pubkey, expected);
            }
        }

        // Edge Case: KOTH holders with 0 community points still get their KOTH share
        for (const [pubkey, kothShare] of kothHoldersMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;
            if (!globalState.userExpectedAirdrops.has(pubkey) && kothShare > 0) {
                globalState.userExpectedAirdrops.set(pubkey, kothShare);
            }
        }

    } catch (e) {
        logger.error("Holder scanner error", { error: e.message });
    }
}

/**
 * Start the holder scanner interval
 */
function start(deps) {
    setInterval(() => updateGlobalState(deps), config.HOLDER_UPDATE_INTERVAL);
    setTimeout(() => updateGlobalState(deps), 5000);
    logger.info("Holder scanner started");
}

module.exports = { updateGlobalState, start };
