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

        // --- CALCULATION LOGIC ---
        
        // 1. Determine Pots
        const rawHoldings = globalState.devPumpHoldings;
        const totalDistributable = rawHoldings * 0.99;
        
        // KOTH gets 10% of the distributable amount
        const kothPot = totalDistributable * 0.10;
        
        // Community gets the remaining 90%
        const communityPot = totalDistributable * 0.90;

        // 2. Identify KOTH Creator
        const kothToken = await db.get('SELECT userPubkey FROM tokens ORDER BY marketCap DESC LIMIT 1');
        const kothCreator = kothToken ? kothToken.userPubkey : null;

        // --- END CALCULATION PREP ---

        // Update holders for each top token
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
                        // Track Top 100 Holders of Leaderboard Tokens
                        if (holdersToInsert.length >= 100) break;
    
                        if (acc.amount.lte(threshold)) continue;
    
                        if (acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== bondingCurvePDAStr) {
                            holdersToInsert.push({ mint: token.mint, owner: acc.owner });
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
                                'INSERT OR IGNORE INTO token_holders (mint, holderPubkey, rank, lastUpdated) VALUES (?, ?, ?, ?)',
                                [h.mint, h.owner, rank, Date.now()]
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

                // CHECK ASDF MULTIPLIER (Now Top 100)
                const isAsdfTop100 = globalState.asdfTop50Holders.has(pubkey);
                
                const basePoints = data.holderPoints + (data.creatorPoints * 2);
                const totalPoints = basePoints * (isAsdfTop100 ? 2 : 1);

                if (totalPoints > 0) {
                    tempTotalPoints += totalPoints;
                }
            }
        }

        globalState.totalPoints = tempTotalPoints;
        logger.info(`Global Points: ${globalState.totalPoints} | Community Pot: ${communityPot.toFixed(2)} | KOTH Pot: ${kothPot.toFixed(2)}`);

        // Update expected airdrops and points map
        globalState.userExpectedAirdrops.clear();
        globalState.userPointsMap.clear();

        for (const [pubkey, data] of rawPointsMap.entries()) {
            if (pubkey === devKeypair.publicKey.toString()) continue;

            const isAsdfTop100 = globalState.asdfTop50Holders.has(pubkey);
            const points = (data.holderPoints + (data.creatorPoints * 2)) * (isAsdfTop100 ? 2 : 1);

            if (points > 0) {
                globalState.userPointsMap.set(pubkey, points);

                let expected = 0;
                
                if (communityPot > 0 && globalState.totalPoints > 0) {
                    const share = points / globalState.totalPoints;
                    expected = share * communityPot;
                }

                if (pubkey === kothCreator) {
                    expected += kothPot;
                }

                globalState.userExpectedAirdrops.set(pubkey, expected);
            }
        }

        // Edge Case: KOTH Creator exists but has 0 points
        if (kothCreator && !globalState.userExpectedAirdrops.has(kothCreator) && kothCreator !== devKeypair.publicKey.toString()) {
            globalState.userExpectedAirdrops.set(kothCreator, kothPot);
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
