/**
 * Holder Scanner Task
 * Updates token holders and calculates global points
 */
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { BN } = require('@coral-xyz/anchor');
const config = require('../config/env');
const { TOKENS, PROGRAMS, WALLETS } = require('../config/constants');
const { logger } = require('../services');

/**
 * Update global state (holders, points, expected airdrops)
 */
async function updateGlobalState(deps) {
    const { connection, devKeypair, db, globalState } = deps;

    try {
        const topTokens = await db.all('SELECT mint, userPubkey FROM tokens ORDER BY volume24h DESC LIMIT 10');
        const top10Mints = topTokens.map(t => t.mint);

        // Cache dev wallet PUMP holdings
        try {
            const devPumpAta = await getAssociatedTokenAddress(
                TOKENS.PUMP, devKeypair.publicKey, false, PROGRAMS.TOKEN_2022
            );
            const tokenBal = await connection.getTokenAccountBalance(devPumpAta);
            globalState.devPumpHoldings = tokenBal.value.uiAmount || 0;
        } catch (e) {
            globalState.devPumpHoldings = 0;
        }

        // --- UPDATED LOGIC FOR KOTH ---
        // Total available in wallet
        const rawHoldings = globalState.devPumpHoldings;
        
        // 1. Calculate the 'Distributable' amount (99% of holdings, as per flywheel logic)
        const totalDistributable = rawHoldings * 0.99;
        
        // 2. KOTH gets 10% of that distributable amount
        // const kothShare = totalDistributable * 0.10; // (Unused variable, but kept for clarity of logic)
        
        // 3. Community gets the remaining 90%
        const communityPool = totalDistributable * 0.90;

        // Update holders for each top token
        for (const token of topTokens) {
            try {
                if (!token.mint) continue;

                const tokenMintPublicKey = new PublicKey(token.mint);
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
                    PROGRAMS.PUMP
                );
                const bondingCurvePDAStr = bondingCurvePDA.toString();

                const accounts = await connection.getTokenLargestAccounts(tokenMintPublicKey);
                const holdersToInsert = [];

                if (accounts.value) {
                    const topHolders = accounts.value.slice(0, 50);

                    for (const acc of topHolders) {
                        try {
                            const info = await connection.getParsedAccountInfo(acc.address);
                            if (info.value?.data?.parsed) {
                                const owner = info.value.data.parsed.info.owner;
                                const tokenAmountObj = info.value.data.parsed.info.tokenAmount;

                                // Filter: must hold > 1 token
                                if (tokenAmountObj.uiAmount <= 1) continue;

                                // Exclude liquidity wallets
                                if (owner !== WALLETS.PUMP_LIQUIDITY && owner !== bondingCurvePDAStr) {
                                    holdersToInsert.push({ mint: token.mint, owner });
                                }
                            }
                        } catch (e) {}
                    }
                }

                // Atomic DB update
                await db.run('BEGIN TRANSACTION');
                try {
                    await db.run('DELETE FROM token_holders WHERE mint = ?', token.mint);

                    if (holdersToInsert.length > 0) {
                        let rank = 1;
                        for (const h of holdersToInsert) {
                            await db.run(
                                'INSERT OR IGNORE INTO token_holders (mint, holderPubkey, rank, lastUpdated) VALUES (?, ?, ?, ?)',
                                [h.mint, h.owner, rank, Date.now()]
                            );
                            rank++;
                        }
                    }
                    await db.run('COMMIT');
                } catch (err) {
                    await db.run('ROLLBACK');
                }
            } catch (e) {}

            await new Promise(r => setTimeout(r, 1000));
        }

        // Calculate global points
        let rawPointsMap = new Map();
        let tempTotalPoints = 0;

        if (top10Mints.length > 0) {
            const placeholders = top10Mints.map(() => '?').join(',');
            const rows = await db.all(
                `SELECT holderPubkey, COUNT(*) as positionCount FROM token_holders WHERE mint IN (${placeholders}) GROUP BY holderPubkey`,
                top10Mints
            );

            for (const row of rows) {
                rawPointsMap.set(row.holderPubkey, { holderPoints: row.positionCount, creatorPoints: 0 });
            }

            for (const token of topTokens) {
                if (token.userPubkey) {
                    const entry = rawPointsMap.get(token.userPubkey) || { holderPoints: 0, creatorPoints: 0 };
                    entry.creatorPoints += 1;
                    rawPointsMap.set(token.userPubkey, entry);
                }
            }

            for (const [pubkey, data] of rawPointsMap.entries()) {
                if (pubkey === devKeypair.publicKey.toString()) continue;

                const isTop50 = globalState.asdfTop50Holders.has(pubkey);
                const basePoints = data.holderPoints + (data.creatorPoints * 2);
                const totalPoints = basePoints * (isTop50 ? 2 : 1);

                if (totalPoints > 0) {
                    tempTotalPoints += totalPoints;
                }
            }
        }

        globalState.totalPoints = tempTotalPoints;
        logger.info(`Global Points: ${globalState.totalPoints} | Est. Pool: ${communityPool.toFixed(2)} PUMP`);

        // Update expected airdrops
        globalState.userExpectedAirdrops.clear();
        globalState.userPointsMap.clear();

        for (const [pubkey, data] of rawPointsMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;

            const isTop50 = globalState.asdfTop50Holders.has(pubkey);
            const points = (data.holderPoints + (data.creatorPoints * 2)) * (isTop50 ? 2 : 1);

            if (points > 0) {
                globalState.userPointsMap.set(pubkey, points);

                if (communityPool > 0 && globalState.totalPoints > 0) {
                    const share = points / globalState.totalPoints;
                    // FIX: Use communityPool (90%) instead of totalDistributable
                    const expectedAirdrop = share * communityPool;
                    globalState.userExpectedAirdrops.set(pubkey, expectedAirdrop);
                }
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
