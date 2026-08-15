/**
 * Robinhood Scanner Task
 * Tracks external PumpFun tokens that share creator fees with our wallet
 * and updates their holders for airdrop eligibility
 *
 * v16.0 - Simplified: Tokens are registered via API with on-chain verification
 *         This scanner only handles: metadata updates, holder tracking
 *         Fee verification happens at registration time via mintExtractor.verifyFeeRecipient()
 */
const { PublicKey } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const axios = require('axios');
const config = require('../config/env');
const { PROGRAMS, WALLETS } = require('../config/constants');
const { logger, pump, mutex, mintExtractor, imageUtils } = require('../services');
const { fetchTokenAccountsHeliusDAS } = require('../services/heliusDAS');

// RACE CONDITION FIX: Use mutex instead of boolean flag
const scannerMutex = mutex.getMutex('robinhood_scanner');
let websocketSubscription = null;

// Per-token reverify cooldown: skip tokens verified within the last 2 hours
const REVERIFY_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const lastReverifiedAt = new Map(); // mint -> timestamp

// Zero-pending fee cache: skip vault checks for tokens confirmed empty within 30 min
const ZERO_PENDING_COOLDOWN_MS = 30 * 60 * 1000;
const lastZeroPendingAt = new Map(); // mint -> timestamp

// Token program cache: avoids querying the wrong SPL program after first successful scan
// v27.5 EFFICIENCY: A mint's SPL program (Token vs Token-2022) is fixed permanently at
// creation and can never change, so the old 2h TTL was needlessly re-querying both
// programs for every active Robinhood token every 2 hours forever. Long TTL here is a
// self-healing safety net, not a real "recheck" — see matching fix in holderScanner.js.
const rhTokenProgramCache = new Map(); // mint -> 'TOKEN' | 'TOKEN_2022' | 'BOTH'
const rhTokenProgramConfirmedAt = new Map(); // mint -> timestamp
const RH_PROGRAM_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days (safety net only — this never actually changes)

// H-2: Periodic cleanup for cooldown Maps to prevent unbounded growth
setInterval(() => {
    const now = Date.now();
    for (const [mint, ts] of lastReverifiedAt) {
        if (now - ts > REVERIFY_COOLDOWN_MS * 2) lastReverifiedAt.delete(mint);
    }
    for (const [mint, ts] of lastZeroPendingAt) {
        if (now - ts > ZERO_PENDING_COOLDOWN_MS * 2) lastZeroPendingAt.delete(mint);
    }
    for (const [mint, ts] of rhTokenProgramConfirmedAt) {
        if (now - ts > RH_PROGRAM_CACHE_TTL * 3) {
            rhTokenProgramCache.delete(mint);
            rhTokenProgramConfirmedAt.delete(mint);
        }
    }
}, 60 * 60 * 1000); // Run hourly

/**
 * Parse fee sharing config account data
 *
 * The ACTUAL Pump.fun fee_sharing_config structure is:
 * - 8 bytes: discriminator (anchor account discriminator)
 * - 32 bytes: creator (the original token creator's pubkey)
 * - 4 bytes: shareholder_count (u32, little-endian)
 * - N * 34 bytes: shareholders (32 byte pubkey + 2 byte bps each)
 *
 * Total sizes: 44 base + 34 per shareholder
 * - 1 shareholder: 78 bytes
 * - 2 shareholders: 112 bytes
 * - 3 shareholders: 146 bytes
 * - 4 shareholders: 180 bytes
 * - 5 shareholders: 214 bytes
 *
 * NOTE: The fee_sharing_config does NOT store the mint.
 * When fee sharing is enabled, the coin_creator field in BC/AMM
 * IS set to the fee_sharing_config PDA itself.
 *
 * @param {Buffer} data - Raw account data
 * @param {PublicKey} [accountPubkey] - Optional: The account's public key
 * @returns {Object|null} Parsed config or null if invalid
 */
function parseFeeSharingConfig(data, accountPubkey = null) {
    try {
        if (data.length < 44) return null; // Minimum: 8 (discriminator) + 32 (creator) + 4 (count)

        const creator = new PublicKey(data.slice(8, 40));

        // Number of shareholders (4 bytes, little-endian) at offset 40
        const shareholderCount = data.readUInt32LE(40);

        // Sanity check - shouldn't have more than 10 shareholders, and must have at least 1
        if (shareholderCount > 10 || shareholderCount < 1) return null;

        // Expected size: 44 base + 34 per shareholder
        const expectedMinSize = 44 + (shareholderCount * 34);
        if (data.length < expectedMinSize) return null;

        const shareholders = [];
        let offset = 44;

        for (let i = 0; i < shareholderCount && offset + 34 <= data.length; i++) {
            const pubkey = new PublicKey(data.slice(offset, offset + 32));
            const shareBps = data.readUInt16LE(offset + 32);

            // M-8 FIX: Reject 0 BPS — a 0-share entry is invalid and should not be registered.
            // Also reject > 10000 BPS as before.
            if (shareBps === 0 || shareBps > 10000) return null;

            shareholders.push({ pubkey, shareBps });
            offset += 34;
        }

        // Verify we got all expected shareholders
        if (shareholders.length !== shareholderCount) return null;

        return { creator, mint: null, shareholders, configPubkey: accountPubkey };
    } catch (e) {
        return null;
    }
}

/**
 * Check if our wallet is a shareholder in a fee sharing config
 */
function findOurShare(config, ourWallet) {
    if (!config || !config.shareholders) return null;

    const ourWalletStr = ourWallet.toString();
    for (const sh of config.shareholders) {
        if (sh.pubkey.toString() === ourWalletStr) {
            return {
                shareBps: sh.shareBps,
                sharePercent: sh.shareBps / 100  // BUG FIX: This is BPS so /100 gives percent (1000 bps = 10%)
            };
        }
    }
    return null;
}

/**
 * Fetch token metadata from Helius DAS API
 */
async function fetchHeliusMetadata(mint) {
    if (!config.HELIUS_API_KEY) {
        return null;
    }
    try {
        const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
            {
                jsonrpc: '2.0',
                id: '1',
                method: 'getAsset',
                params: { id: mint }
            },
            { timeout: 5000 }
        );
        const asset = response.data?.result;
        if (asset) {
            const metadata = asset.content?.metadata || {};
            return {
                name: metadata.name || 'Unknown',
                ticker: metadata.symbol || 'UNKNOWN',
                image: imageUtils.extractHeliusImage(asset),
                marketCap: 0, // Will be fetched from DexScreener
                creator: asset.creators?.[0]?.address || null
            };
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

/**
 * Fetch token metadata from DexScreener
 */
async function fetchDexScreenerMetadata(mint) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
            timeout: 5000
        });
        const pairs = response.data?.pairs || [];
        if (pairs.length > 0) {
            const pair = pairs[0];
            return {
                name: pair.baseToken?.name || 'Unknown',
                ticker: pair.baseToken?.symbol || 'UNKNOWN',
                image: pair.info?.imageUrl || null,
                marketCap: pair.fdv || pair.marketCap || 0,
                volume24h: pair.volume?.h24 || 0
            };
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

/**
 * Fetch token metadata from GeckoTerminal API
 * Free API with 30 requests/minute rate limit
 * Good for images when DexScreener doesn't have them
 */
async function fetchGeckoTerminalMetadata(mint) {
    try {
        // GeckoTerminal uses "solana" as the network identifier
        const response = await axios.get(
            `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`,
            {
                timeout: 5000,
                headers: {
                    'Accept': 'application/json'
                }
            }
        );

        const tokenData = response.data?.data?.attributes;
        if (tokenData) {
            return {
                name: tokenData.name || null,
                ticker: tokenData.symbol || null,
                image: tokenData.image_url || null,
                marketCap: parseFloat(tokenData.fdv_usd) || 0,
                volume24h: parseFloat(tokenData.volume_usd?.h24) || 0,
                priceUsd: parseFloat(tokenData.price_usd) || 0
            };
        }
    } catch (e) {
        // Silent fail - GeckoTerminal may not have all tokens
        logger.debug(`[GeckoTerminal] Failed to fetch ${mint?.slice(0, 8)}...`, { error: e.message });
    }
    return null;
}

/**
 * Fetch token info (including image) from GeckoTerminal's /info endpoint
 * This endpoint specifically returns token metadata like images, descriptions, and socials
 */
async function fetchGeckoTerminalTokenInfo(mint) {
    try {
        const response = await axios.get(
            `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/info`,
            {
                timeout: 5000,
                headers: {
                    'Accept': 'application/json'
                }
            }
        );

        const tokenData = response.data?.data?.attributes;
        if (tokenData) {
            return {
                name: tokenData.name || null,
                ticker: tokenData.symbol || null,
                image: tokenData.image_url || null,
                description: tokenData.description || null,
                websites: tokenData.websites || [],
                twitter: tokenData.twitter_handle || null,
                telegram: tokenData.telegram_handle || null,
                discord: tokenData.discord_url || null
            };
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

/**
 * Re-verify fee share status for all active Robinhood tokens
 * This catches cases where fee sharing config has been updated on-chain
 */
async function reverifyRobinhoodTokens(deps) {
    const { connection, devKeypair, db } = deps;

    // RACE CONDITION FIX: Use mutex for atomic locking
    const release = await scannerMutex.tryAcquire();
    if (!release) {
        logger.debug('[Robinhood] Skipping reverify - already in progress');
        return;
    }

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL LIMIT 500');

        if (tokens.length === 0) {
            return;
        }

        const now = Date.now();
        const tokensNeedingReverify = tokens.filter(t => {
            const last = lastReverifiedAt.get(t.mint);
            return !last || (now - last) >= REVERIFY_COOLDOWN_MS;
        });
        logger.info(`[Robinhood] Re-verifying ${tokensNeedingReverify.length}/${tokens.length} tokens (${tokens.length - tokensNeedingReverify.length} skipped, verified within 2h)...`);

        // v27.3: Process re-verifications in parallel batches instead of one sequential
        // RPC round trip at a time — verifyFeeRecipient() does 1-3 getAccountInfo calls
        // per token, so serializing hundreds of tokens made this scan take far longer
        // than it needed to.
        const REVERIFY_BATCH_SIZE = 10;
        for (let i = 0; i < tokensNeedingReverify.length; i += REVERIFY_BATCH_SIZE) {
            const batch = tokensNeedingReverify.slice(i, i + REVERIFY_BATCH_SIZE);

            await Promise.allSettled(batch.map(async (token) => {
                try {
                    // Re-verify on-chain fee recipient status
                    const result = await mintExtractor.verifyFeeRecipient(
                        token.mint,
                        devKeypair.publicKey.toString(),
                        connection
                    );

                    if (!result.isRecipient) {
                        // v25.115: Check if verification actually succeeded or failed due to RPC error
                        // Previously, RPC errors returned isRecipient: false which incorrectly deactivated tokens
                        if (result.error) {
                            logger.debug(`[Robinhood] Skipping deactivation of ${token.ticker} (${token.mint.slice(0, 8)}...) - verification failed due to RPC error: ${result.error}`);
                        } else {
                            // Verification succeeded and we're genuinely no longer a fee recipient
                            logger.warn(`[Robinhood] ${token.ticker} (${token.mint.slice(0, 8)}...) - No longer a fee recipient, deactivating`);
                            await db.run('UPDATE robinhood_tokens SET "isActive" = 0 WHERE id = $1', [token.id]);
                            lastReverifiedAt.set(token.mint, Date.now());
                        }
                    } else {
                        if (result.feeShareBps !== token.feeShareBps) {
                            // Fee share changed - update it
                            logger.info(`[Robinhood] ${token.ticker} - Fee share changed: ${token.feeShareBps} -> ${result.feeShareBps} bps`);
                            await db.run('UPDATE robinhood_tokens SET "feeShareBps" = $1 WHERE id = $2', [result.feeShareBps, token.id]);
                        }
                        // Mark as verified — won't be re-checked for 2 hours
                        lastReverifiedAt.set(token.mint, Date.now());
                    }
                } catch (e) {
                    logger.debug(`[Robinhood] Reverify error for ${token.mint}`, { error: e.message });
                }
            }));

            // Rate limit between batches (previously between every single token)
            if (i + REVERIFY_BATCH_SIZE < tokensNeedingReverify.length) {
                await new Promise(r => setTimeout(r, 150));
            }
        }

        // v27.3: Metadata/image updates for Robinhood tokens are now owned solely by
        // metadataUpdater.updateAllMissingImages() (runs every METADATA_IMAGE_INTERVAL,
        // default 10 min) — this scanner used to run its own independent copy of the same
        // DexScreener/GeckoTerminal/Helius/Pump.fun fallback chain on the same ~10-minute
        // cadence, roughly doubling external API calls for identical data.

    } catch (e) {
        logger.error('[Robinhood] Reverify error', { error: e.message });
    } finally {
        await release();
    }
}

/**
 * Fetch token metadata from Pump.fun API
 */
async function fetchPumpFunMetadata(mint) {
    try {
        const response = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, {
            timeout: 5000
        });
        if (response.data) {
            const data = response.data;
            return {
                name: data.name || null,
                ticker: data.symbol || null,
                image: data.image_uri || data.image || null,
                marketCap: data.usd_market_cap || 0,
                creator: data.creator || null
            };
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

// v27.3: The Robinhood-specific updateRobinhoodTokenMetadata() that used to live here was
// removed — it duplicated metadataUpdater.updateRobinhoodTokenMetadata() (same
// DexScreener -> GeckoTerminal -> Helius -> Pump.fun fallback chain, same table, same
// ~10-minute cadence). metadataUpdater.updateAllMissingImages() is now the single owner
// of Robinhood token image/metadata backfill. The single-mint fetchHeliusMetadata,
// fetchDexScreenerMetadata, fetchGeckoTerminalMetadata, fetchGeckoTerminalTokenInfo, and
// fetchPumpFunMetadata helpers below have no remaining internal callers in this file — kept
// only because they're part of this module's exported surface.

// fetchTokenAccountsHeliusDAS is imported from ../services/heliusDAS

/**
 * Update holders for all active Robinhood tokens
 * v25.64: Fixed to track 250 holders (matching platform tokens) and use batch inserts
 * v25.65: Critical bugfix - don't delete holders on RPC failure, better error handling
 * v25.66: Use Helius DAS API with pagination for tokens with many holders
 */
async function updateRobinhoodHolders(deps) {
    const { connection, db } = deps;
    const TOP_HOLDERS_LIMIT = 250; // v25.64: Match platform token holder limit

    try {
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 AND mint IS NOT NULL LIMIT 500');

        if (tokens.length === 0) {
            logger.debug('[Robinhood] No active tokens to scan for holders');
            return;
        }

        logger.info(`[Robinhood] Scanning holders for ${tokens.length} active tokens...`);
        let totalHoldersUpdated = 0;
        let tokensWithHolders = 0;
        let tokensSkippedRpcFail = 0;
        let tokensUsedFallback = 0;

        for (const token of tokens) {
            try {
                if (!token.mint) continue;

                const tokenMintPublicKey = new PublicKey(token.mint);
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
                    PROGRAMS.PUMP
                );

                const holdersToInsert = [];
                const bondingCurvePDAStr = bondingCurvePDA.toString();
                // Exclude the Pump AMM pool PDA — after graduation, pool holds tokens as LP
                const ammPoolStr = pump.getPumpAmmPDAs(tokenMintPublicKey).pool.toString();
                const threshold = new BN(1000000);

                // v25.66: Try getProgramAccounts first, fallback to Helius DAS API for large tokens
                let rpcFailed = false;
                let usedFallback = false;
                let tokenAccounts = [];
                let token2022Accounts = [];

                // v25.115: Use Promise.allSettled so one failing program query doesn't discard the other's results
                // Previously Promise.all would reject if either TOKEN or TOKEN_2022 query failed,
                // discarding successful results from the other program
                async function queryWithRetry(program, label) {
                    // v25.115: dataSize: 165 for TOKEN program (standard SPL token accounts are exactly 165 bytes)
                    // Token-2022 accounts can be > 165 bytes due to extensions, so no dataSize filter
                    const isStandardToken = program.equals(PROGRAMS.TOKEN);
                    const filters = isStandardToken
                        ? [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: token.mint } }]
                        : [{ memcmp: { offset: 0, bytes: token.mint } }];
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            return await connection.getProgramAccounts(program, {
                                filters,
                                encoding: 'base64'
                            });
                        } catch (e) {
                            if (e.message?.includes('Too many accounts') || e.message?.includes('too many')) {
                                throw e; // Don't retry "too many accounts" - use fallback
                            }
                            if (attempt === 0) {
                                await new Promise(r => setTimeout(r, 1000));
                            } else {
                                throw e;
                            }
                        }
                    }
                }

                // Use program cache to skip querying the wrong SPL program (~50% RPC savings once warmed)
                const rhCachedProg = rhTokenProgramCache.get(token.mint);
                const rhCacheAge = Date.now() - (rhTokenProgramConfirmedAt.get(token.mint) || 0);
                const rhValidCache = rhCachedProg && rhCacheAge < RH_PROGRAM_CACHE_TTL;
                const rhQueryPrograms = [];
                if (!rhValidCache || rhCachedProg === 'TOKEN' || rhCachedProg === 'BOTH') rhQueryPrograms.push('TOKEN');
                if (!rhValidCache || rhCachedProg === 'TOKEN_2022' || rhCachedProg === 'BOTH') rhQueryPrograms.push('TOKEN_2022');

                const rhRawResults = await Promise.allSettled(
                    rhQueryPrograms.map(prog => queryWithRetry(prog === 'TOKEN' ? PROGRAMS.TOKEN : PROGRAMS.TOKEN_2022, prog))
                );

                const getRhResult = (prog) => {
                    const idx = rhQueryPrograms.indexOf(prog);
                    if (idx === -1) return { accounts: [], rejected: false, reason: null };
                    const r = rhRawResults[idx];
                    return { accounts: r.status === 'fulfilled' ? r.value : [], rejected: r.status === 'rejected', reason: r.reason };
                };
                const rhTokenRes = getRhResult('TOKEN');
                const rhT2022Res = getRhResult('TOKEN_2022');
                tokenAccounts = rhTokenRes.accounts;
                token2022Accounts = rhT2022Res.accounts;

                const rhIsTooMany = (r) => r.rejected && (r.reason?.message?.includes('Too many accounts') || r.reason?.message?.includes('too many'));
                const tooManyToken = rhIsTooMany(rhTokenRes);
                const tooManyToken2022 = rhIsTooMany(rhT2022Res);
                const allQueriesFailed = rhQueryPrograms.every((_, i) => rhRawResults[i].status === 'rejected');

                if (tooManyToken || tooManyToken2022) {
                    logger.debug(`[Robinhood] ${token.ticker || token.mint.slice(0, 8)} has too many holders, using Helius DAS API`);
                    usedFallback = true;
                    tokensUsedFallback++;
                    tokenAccounts = [];
                    token2022Accounts = [];
                } else if (allQueriesFailed) {
                    logger.warn(`[Robinhood] RPC failed for ${token.ticker || token.mint.slice(0, 8)}: TOKEN=${rhTokenRes.reason?.message}, TOKEN_2022=${rhT2022Res.reason?.message}`);
                    rpcFailed = true;
                    tokensSkippedRpcFail++;
                } else {
                    if (rhTokenRes.rejected) logger.debug(`[Robinhood] TOKEN query failed for ${token.ticker || token.mint.slice(0, 8)}: ${rhTokenRes.reason?.message}`);
                    if (rhT2022Res.rejected) logger.debug(`[Robinhood] TOKEN_2022 query failed for ${token.ticker || token.mint.slice(0, 8)}: ${rhT2022Res.reason?.message}`);
                    // Update program cache only when querying both programs AND both returned without error.
                    // Transient RPC failures must not poison the cache (e.g. TOKEN fails → wrongly cached as TOKEN_2022-only).
                    if (rhQueryPrograms.length === 2 && !rhTokenRes.rejected && !rhT2022Res.rejected) {
                        const hasToken = tokenAccounts.length > 0;
                        const hasT2022 = token2022Accounts.length > 0;
                        if (hasToken || hasT2022) {
                            rhTokenProgramCache.set(token.mint, hasToken && hasT2022 ? 'BOTH' : hasToken ? 'TOKEN' : 'TOKEN_2022');
                            rhTokenProgramConfirmedAt.set(token.mint, Date.now());
                        }
                    }
                }

                // v25.65: Skip this token if RPC failed - don't delete existing holders
                if (rpcFailed) {
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }

                // v25.66: Use Helius DAS API fallback for tokens with many holders
                if (usedFallback) {
                    const dasAccounts = await fetchTokenAccountsHeliusDAS(token.mint, TOP_HOLDERS_LIMIT, 'Robinhood');

                    if (dasAccounts && dasAccounts.length > 0) {
                        // Sort by balance descending and filter
                        const sortedAccounts = dasAccounts
                            .filter(acc => {
                                const bal = new BN(acc.balance);
                                return bal.gt(threshold) && acc.owner !== bondingCurvePDAStr && acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== ammPoolStr;
                            })
                            .sort((a, b) => {
                                const balA = new BN(a.balance);
                                const balB = new BN(b.balance);
                                return balB.cmp(balA);
                            })
                            .slice(0, TOP_HOLDERS_LIMIT);

                        for (const acc of sortedAccounts) {
                            holdersToInsert.push({ mint: token.mint, owner: acc.owner, balance: acc.balance });
                        }
                    } else {
                        // DAS API failed or returned no results - preserve existing holders
                        logger.warn(`[Robinhood] Helius DAS returned no results for ${token.ticker || token.mint.slice(0, 8)} - preserving existing`);
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                } else {
                    // Normal path - parse getProgramAccounts results
                    const accounts = [...tokenAccounts, ...token2022Accounts];

                    const parsedAccounts = accounts.map(acc => {
                        try {
                            const data = Array.isArray(acc.account.data)
                                ? Buffer.from(acc.account.data[0], 'base64')
                                : Buffer.from(acc.account.data);

                            if (data.length < 72) return null;

                            const owner = new PublicKey(data.slice(32, 64)).toString();
                            const amount = new BN(data.slice(64, 72), 'le');
                            return { owner, amount, balance: amount.toString() };
                        } catch (parseErr) {
                            return null;
                        }
                    })
                        .filter(a => a !== null)
                        .sort((a, b) => b.amount.cmp(a.amount));

                    for (const acc of parsedAccounts) {
                        if (holdersToInsert.length >= TOP_HOLDERS_LIMIT) break;
                        if (acc.amount.lte(threshold)) continue;

                        if (acc.owner !== bondingCurvePDAStr && acc.owner !== WALLETS.PUMP_LIQUIDITY && acc.owner !== ammPoolStr) {
                            holdersToInsert.push({ mint: token.mint, owner: acc.owner, balance: acc.balance });
                        }
                    }
                }

                // v25.65: Only update database if we got holders OR this is a known empty token
                // Don't delete existing holders if RPC returned 0 results (could be indexing delay)
                const existingHolders = await db.get(
                    'SELECT COUNT(*) as count FROM robinhood_token_holders WHERE mint = $1',
                    [token.mint]
                );
                const hadExistingHolders = (existingHolders?.count || 0) > 0;

                // Deduplicate by owner (one wallet may hold multiple token accounts)
                const deduped = new Map();
                for (const h of holdersToInsert) {
                    if (deduped.has(h.owner)) {
                        const prev = deduped.get(h.owner);
                        deduped.set(h.owner, { ...prev, balance: (BigInt(prev.balance) + BigInt(h.balance)).toString() });
                    } else {
                        deduped.set(h.owner, h);
                    }
                }
                const uniqueHolders = [...deduped.values()]
                    .sort((a, b) => { const d = BigInt(b.balance) - BigInt(a.balance); return d > 0n ? 1 : d < 0n ? -1 : 0; })
                    .slice(0, TOP_HOLDERS_LIMIT);

                // If we got holders from RPC, update the database atomically
                if (uniqueHolders.length > 0) {
                    const BATCH_SIZE = 50;
                    const now = Date.now();

                    await db.transaction(async (tx) => {
                        await tx.run('DELETE FROM robinhood_token_holders WHERE mint = $1', [token.mint]);

                        for (let i = 0; i < uniqueHolders.length; i += BATCH_SIZE) {
                            const batch = uniqueHolders.slice(i, i + BATCH_SIZE);
                            const placeholders = batch.map((_, idx) => {
                                const baseIdx = idx * 5;
                                return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5})`;
                            }).join(', ');

                            const params = batch.flatMap((h, idx) => [
                                h.mint,
                                h.owner,
                                h.balance,
                                i + idx + 1,
                                now
                            ]);

                            await tx.run(`
                                INSERT INTO robinhood_token_holders (mint, "holderPubkey", balance, rank, "updatedAt")
                                VALUES ${placeholders}
                                ON CONFLICT (mint, "holderPubkey") DO UPDATE SET
                                    balance = EXCLUDED.balance,
                                    rank = EXCLUDED.rank,
                                    "updatedAt" = EXCLUDED."updatedAt"
                            `, params);
                        }
                    });

                    totalHoldersUpdated += uniqueHolders.length;
                    tokensWithHolders++;
                } else if (!hadExistingHolders) {
                    // v25.65: New token with no holders yet - this is normal, log for visibility
                    logger.debug(`[Robinhood] ${token.ticker || token.mint.slice(0, 8)} has no holders yet (new token or not indexed)`);
                } else {
                    // v25.65: Token had holders but RPC returned 0 - preserve existing, log warning
                    logger.warn(`[Robinhood] ${token.ticker || token.mint.slice(0, 8)} RPC returned 0 holders but had ${existingHolders.count} - preserving existing`);
                }

                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                logger.error(`[Robinhood] Holder scan error for ${token.mint}`, { error: e.message });
            }
        }

        logger.info(`[Robinhood] Holder scan complete: ${totalHoldersUpdated} holders across ${tokensWithHolders}/${tokens.length} tokens (${tokensUsedFallback} used fallback, ${tokensSkippedRpcFail} skipped)`);
    } catch (e) {
        logger.error('[Robinhood] Holder update error', { error: e.message });
    }
}

/**
 * Get pending fees for all Robinhood tokens
 */
async function getRobinhoodPendingFees(deps) {
    const { connection, db } = deps;

    let totalPendingFees = new BN(0);
    const tokenFees = [];

    try {
        // v25.14 SCALABILITY: Limit to 500 tokens
        const tokens = await db.all('SELECT * FROM robinhood_tokens WHERE "isActive" = 1 LIMIT 500');

        for (const token of tokens) {
            try {
                // v25.74: Use feeVaultAddress for fee sharing tokens
                let bcVault, ammVaultAta;
                if (token.feeVaultAddress) {
                    bcVault = new PublicKey(token.feeVaultAddress);
                    const feeVaultPubkey = new PublicKey(token.feeVaultAddress);
                    const vaults = pump.getShareholderFeeVaults(feeVaultPubkey);
                    ammVaultAta = vaults.ammVaultAta;
                } else {
                    const creatorPubkey = new PublicKey(token.creatorPubkey);
                    const vaults = pump.getShareholderFeeVaults(creatorPubkey);
                    bcVault = vaults.bcVault;
                    ammVaultAta = vaults.ammVaultAta;
                }

                let tokenFeeAmount = new BN(0);

                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo && bcInfo.lamports > 0) {
                        const ourShare = Math.floor(bcInfo.lamports * (token.feeShareBps / 10000));
                        tokenFeeAmount = tokenFeeAmount.add(new BN(ourShare));
                    }
                } catch (e) { /* Silent */ }

                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
                    if (bal.value.amount && parseInt(bal.value.amount) > 0) {
                        const ourShare = Math.floor(parseInt(bal.value.amount) * (token.feeShareBps / 10000));
                        tokenFeeAmount = tokenFeeAmount.add(new BN(ourShare));
                    }
                } catch (e) { /* Silent */ }

                if (tokenFeeAmount.gt(new BN(0))) {
                    tokenFees.push({
                        mint: token.mint,
                        creator: token.creatorPubkey,
                        ticker: token.ticker,
                        pendingFees: tokenFeeAmount.toNumber(),
                        shareBps: token.feeShareBps
                    });
                    totalPendingFees = totalPendingFees.add(tokenFeeAmount);
                }
            } catch (e) {
                logger.debug(`[Robinhood] Fee check error for ${token.creatorPubkey}`, { error: e.message });
            }
        }
    } catch (e) {
        logger.error('[Robinhood] Get pending fees error', { error: e.message });
    }

    return { totalPendingFees, tokenFees };
}

/**
 * v25.90: Update pending fees in database from on-chain data
 * This allows WebSocket broadcasts to display accurate pending fees on the frontend
 * Batches all vault reads into getMultipleAccountsInfo calls (100 accounts per RPC call)
 * instead of individual getAccountInfo per token, reducing ~1000 RPC calls to ~10.
 */
async function updatePendingFeesInDb(deps) {
    const { connection, db } = deps;
    const LAMPORTS_PER_SOL = 1000000000;

    try {
        const tokens = await db.all('SELECT id, mint, ticker, "creatorPubkey", "feeShareBps", "feeVaultAddress" FROM robinhood_tokens WHERE "isActive" = 1 LIMIT 500');

        const now = Date.now();

        // Filter out tokens in zero-pending cooldown — no need to check them
        const tokensToCheck = tokens.filter(token => {
            const lastZero = lastZeroPendingAt.get(token.mint);
            return !lastZero || (now - lastZero) >= ZERO_PENDING_COOLDOWN_MS;
        });

        if (tokensToCheck.length === 0) return;

        // Derive all vault addresses up front (ammVaultAta may be a Promise)
        const vaultInfo = (await Promise.all(tokensToCheck.map(async token => {
            try {
                let bcVault, ammVaultAtaKey;
                if (token.feeVaultAddress) {
                    bcVault = new PublicKey(token.feeVaultAddress);
                    const vaults = pump.getShareholderFeeVaults(new PublicKey(token.feeVaultAddress));
                    ammVaultAtaKey = await vaults.ammVaultAta;
                } else {
                    const vaults = pump.getShareholderFeeVaults(new PublicKey(token.creatorPubkey));
                    bcVault = vaults.bcVault;
                    ammVaultAtaKey = await vaults.ammVaultAta;
                }
                return { token, bcVault, ammVaultAtaKey };
            } catch (e) {
                logger.debug(`[Robinhood] Vault derivation failed for ${token.ticker || token.mint?.slice(0, 8)}`, { error: e.message });
                return null;
            }
        }))).filter(Boolean);

        if (vaultInfo.length === 0) return;

        // Batch-fetch all BC vaults and AMM vault ATAs — 100 accounts per getMultipleAccountsInfo call
        const BATCH_SIZE = 100;
        const bcAccountMap = new Map(); // mint -> AccountInfo | null
        const ammAccountMap = new Map(); // mint -> AccountInfo | null

        for (let i = 0; i < vaultInfo.length; i += BATCH_SIZE) {
            const batch = vaultInfo.slice(i, i + BATCH_SIZE);
            const [bcInfos, ammInfos] = await Promise.all([
                connection.getMultipleAccountsInfo(batch.map(v => v.bcVault)),
                connection.getMultipleAccountsInfo(batch.map(v => v.ammVaultAtaKey))
            ]);
            for (let j = 0; j < batch.length; j++) {
                bcAccountMap.set(batch[j].token.mint, bcInfos[j]);
                ammAccountMap.set(batch[j].token.mint, ammInfos[j]);
            }
        }

        // Calculate fees from fetched account data and update DB
        let totalUpdated = 0;
        for (const { token } of vaultInfo) {
            try {
                let tokenFeeAmount = 0;

                const bcInfo = bcAccountMap.get(token.mint);
                if (bcInfo && bcInfo.lamports > 5000) {
                    tokenFeeAmount += Math.floor((bcInfo.lamports - 5000) * (token.feeShareBps / 10000));
                }

                // Parse token amount from raw SPL token account data (u64 at offset 64)
                const ammInfo = ammAccountMap.get(token.mint);
                if (ammInfo && ammInfo.data && ammInfo.data.length >= 72) {
                    const amount = Number(Buffer.from(ammInfo.data).readBigUInt64LE(64));
                    if (amount > 0) {
                        tokenFeeAmount += Math.floor(amount * (token.feeShareBps / 10000));
                    }
                }

                const pendingFeesSol = tokenFeeAmount / LAMPORTS_PER_SOL;
                await db.run('UPDATE robinhood_tokens SET "pendingFees" = $1 WHERE id = $2', [pendingFeesSol, token.id]);
                totalUpdated++;

                if (tokenFeeAmount === 0) {
                    lastZeroPendingAt.set(token.mint, now);
                } else {
                    lastZeroPendingAt.delete(token.mint);
                }
            } catch (e) {
                logger.debug(`[Robinhood] Pending fee update error for ${token.ticker}`, { error: e.message });
            }
        }

        if (totalUpdated > 0) {
            logger.debug(`[Robinhood] Updated pending fees for ${totalUpdated}/${tokens.length} tokens (${tokens.length - tokensToCheck.length} skipped via zero-cache)`);
        }
    } catch (e) {
        logger.error('[Robinhood] Update pending fees in DB error', { error: e.message });
    }
}

/**
 * Update market data for all registered tokens
 * v15.0 - Fetches fresh market data from DexScreener for existing tokens
 * v27.3: Batch DexScreener requests (30 mints/call, same pattern used in metadataUpdater.js)
 *        instead of one HTTP request per token, and cap the token set (LIMIT 500, matching
 *        every other query in this file) so this scales with the token count instead of
 *        growing unbounded.
 */
async function updateRegisteredTokensMarketData(deps) {
    const { db } = deps;

    try {
        // Get all registered tokens (bounded, matches the LIMIT used elsewhere in this file)
        const tokens = await db.all('SELECT mint, ticker FROM tokens WHERE mint IS NOT NULL LIMIT 500');

        if (tokens.length === 0) return;

        let tokensUpdated = 0;
        const CHUNK_SIZE = 30; // DexScreener's /tokens/{mints} endpoint accepts up to 30 comma-separated mints

        for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
            const chunk = tokens.slice(i, i + CHUNK_SIZE);
            const mints = chunk.map(t => t.mint).join(',');

            try {
                const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, {
                    timeout: 8000
                });
                const pairs = dexRes.data?.pairs || [];

                // Pick the highest-liquidity pair per mint (same "best pair" logic used elsewhere)
                const bestByMint = new Map();
                for (const pair of pairs) {
                    const mint = pair.baseToken?.address;
                    if (!mint) continue;
                    const existing = bestByMint.get(mint);
                    if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
                        bestByMint.set(mint, pair);
                    }
                }

                for (const token of chunk) {
                    const pair = bestByMint.get(token.mint);
                    if (!pair) continue;

                    const marketCap = pair.fdv || pair.marketCap || 0;
                    const volume24h = pair.volume?.h24 || 0;
                    if (marketCap <= 0 && volume24h <= 0) continue;

                    await db.run(`
                        UPDATE tokens SET
                            ticker = COALESCE(NULLIF($1, 'UNKNOWN'), ticker),
                            name = COALESCE(NULLIF($2, 'Unknown'), name),
                            image = COALESCE(NULLIF($3, ''), image),
                            volume24h = CASE WHEN $4 > 0 THEN $4 ELSE volume24h END,
                            "marketCap" = CASE WHEN $5 > 0 THEN $5 ELSE "marketCap" END
                        WHERE mint = $6
                    `, [
                        pair.baseToken?.symbol || 'UNKNOWN',
                        pair.baseToken?.name || 'Unknown',
                        pair.info?.imageUrl || null,  // FIX: Pass null instead of empty string to let NULLIF work correctly
                        volume24h,
                        marketCap,
                        token.mint
                    ]);
                    tokensUpdated++;
                }
            } catch (e) {
                logger.debug(`[Robinhood] Failed to fetch market data batch (${chunk.length} tokens)`, { error: e.message });
            }

            // Rate limit between chunks (previously between every single token)
            if (i + CHUNK_SIZE < tokens.length) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        if (tokensUpdated > 0) {
            logger.debug(`[Robinhood] Updated market data for ${tokensUpdated} registered tokens`);
        }
    } catch (e) {
        logger.error('[Robinhood] Market data update error', { error: e.message });
    }
}

/**
 * Main update function - runs periodically
 * v16.0: Tokens are registered via API with on-chain verification
 *        Scanner only handles: re-verification, metadata updates, holder tracking
 * v25.90: Also updates pending fees in database for WebSocket/frontend display
 */
async function updateRobinhoodState(deps) {
    try {
        // Re-verify fee share status and update metadata for Robinhood tokens
        // This catches on-chain changes to fee sharing configs
        await reverifyRobinhoodTokens(deps);

        // Update holders for existing Robinhood tokens
        await updateRobinhoodHolders(deps);

        // v25.90: Update pending fees from on-chain data for frontend display
        await updatePendingFeesInDb(deps);

    } catch (e) {
        logger.error('[Robinhood] Update state error', { error: e.message });
    }
}

/**
 * Start the Robinhood scanner
 */
function start(deps) {
    // Initial scan after 10 seconds
    setTimeout(() => updateRobinhoodState(deps), 10000);

    // Run every 10 minutes
    setInterval(() => updateRobinhoodState(deps), 10 * 60 * 1000);

    logger.info('[Robinhood] Scanner started');
}

/**
 * Stop the scanner
 */
function stop(deps) {
    const { connection } = deps;

    if (websocketSubscription !== null) {
        connection.removeProgramAccountChangeListener(websocketSubscription);
        websocketSubscription = null;
    }

    logger.info('[Robinhood] Scanner stopped');
}

/**
 * v25.65: Scan holders for a single token immediately
 * Called after new Robinhood token registration to populate holder data right away
 * instead of waiting for the next scheduled scan (up to 10 minutes)
 * v25.66: Added fallback for tokens with many holders
 *
 * @param {Object} deps - Dependencies (connection, db)
 * @param {string} mint - Token mint address
 * @param {string} [ticker] - Optional ticker for logging
 * @returns {Promise<{success: boolean, holdersCount: number}>}
 */
async function scanSingleTokenHolders(deps, mint, ticker = null) {
    const { connection, db } = deps;
    const TOP_HOLDERS_LIMIT = 250;

    try {
        if (!mint) {
            return { success: false, holdersCount: 0, error: 'No mint provided' };
        }

        const tokenMintPublicKey = new PublicKey(mint);
        const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()],
            PROGRAMS.PUMP
        );

        const holdersToInsert = [];
        const bondingCurvePDAStr = bondingCurvePDA.toString();
        const threshold = new BN(1000000);
        let usedFallback = false;

        // v25.115: Use Promise.allSettled so one failing program query doesn't discard the other's results
        let tokenAccounts = [];
        let token2022Accounts = [];

        async function queryWithRetry(program, label) {
            // v25.115: dataSize: 165 for TOKEN program optimization
            const isStandardToken = program.equals(PROGRAMS.TOKEN);
            const filters = isStandardToken
                ? [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }]
                : [{ memcmp: { offset: 0, bytes: mint } }];
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    return await connection.getProgramAccounts(program, {
                        filters,
                        encoding: 'base64'
                    });
                } catch (e) {
                    if (e.message?.includes('Too many accounts') || e.message?.includes('too many')) {
                        throw e; // Don't retry "too many accounts" - use fallback
                    }
                    if (attempt === 0) {
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        throw e;
                    }
                }
            }
        }

        const results = await Promise.allSettled([
            queryWithRetry(PROGRAMS.TOKEN, 'TOKEN'),
            queryWithRetry(PROGRAMS.TOKEN_2022, 'TOKEN_2022')
        ]);

        tokenAccounts = results[0].status === 'fulfilled' ? results[0].value : [];
        token2022Accounts = results[1].status === 'fulfilled' ? results[1].value : [];

        // Check for "too many accounts" errors - use Helius DAS API fallback
        const tooManyToken = results[0].status === 'rejected' && (results[0].reason?.message?.includes('Too many accounts') || results[0].reason?.message?.includes('too many'));
        const tooManyToken2022 = results[1].status === 'rejected' && (results[1].reason?.message?.includes('Too many accounts') || results[1].reason?.message?.includes('too many'));

        if (tooManyToken || tooManyToken2022) {
            logger.debug(`[Robinhood] ${ticker || mint.slice(0, 8)} has too many holders, using Helius DAS API`);
            usedFallback = true;
            tokenAccounts = [];
            token2022Accounts = [];
        } else if (results[0].status === 'rejected' && results[1].status === 'rejected') {
            // Both failed - return error
            logger.warn(`[Robinhood] Immediate scan RPC failed for ${ticker || mint.slice(0, 8)}: TOKEN=${results[0].reason?.message}, TOKEN_2022=${results[1].reason?.message}`);
            return { success: false, holdersCount: 0, error: results[0].reason?.message };
        } else {
            if (results[0].status === 'rejected') logger.debug(`[Robinhood] Immediate scan TOKEN query failed for ${ticker || mint.slice(0, 8)}: ${results[0].reason?.message}`);
            if (results[1].status === 'rejected') logger.debug(`[Robinhood] Immediate scan TOKEN_2022 query failed for ${ticker || mint.slice(0, 8)}: ${results[1].reason?.message}`);
        }

        // v25.66: Use Helius DAS API fallback for tokens with many holders
        if (usedFallback) {
            const dasAccounts = await fetchTokenAccountsHeliusDAS(mint, TOP_HOLDERS_LIMIT, 'Robinhood');

            if (dasAccounts && dasAccounts.length > 0) {
                // Sort by balance descending and filter
                const sortedAccounts = dasAccounts
                    .filter(acc => {
                        const bal = new BN(acc.balance);
                        return bal.gt(threshold) && acc.owner !== bondingCurvePDAStr && acc.owner !== WALLETS.PUMP_LIQUIDITY;
                    })
                    .sort((a, b) => {
                        const balA = new BN(a.balance);
                        const balB = new BN(b.balance);
                        return balB.cmp(balA);
                    })
                    .slice(0, TOP_HOLDERS_LIMIT);

                for (const acc of sortedAccounts) {
                    holdersToInsert.push({ mint, owner: acc.owner, balance: acc.balance });
                }
            } else {
                logger.warn(`[Robinhood] Helius DAS returned no results for ${ticker || mint.slice(0, 8)}`);
                return { success: false, holdersCount: 0, error: 'Helius DAS returned no results' };
            }
        } else {
            // Normal path - parse getProgramAccounts results
            const accounts = [...tokenAccounts, ...token2022Accounts];

            const parsedAccounts = accounts.map(acc => {
                try {
                    const data = Array.isArray(acc.account.data)
                        ? Buffer.from(acc.account.data[0], 'base64')
                        : Buffer.from(acc.account.data);

                    if (data.length < 72) return null;

                    const owner = new PublicKey(data.slice(32, 64)).toString();
                    const amount = new BN(data.slice(64, 72), 'le');
                    return { owner, amount, balance: amount.toString() };
                } catch (parseErr) {
                    return null;
                }
            })
                .filter(a => a !== null)
                .sort((a, b) => b.amount.cmp(a.amount));

            for (const acc of parsedAccounts) {
                if (holdersToInsert.length >= TOP_HOLDERS_LIMIT) break;
                if (acc.amount.lte(threshold)) continue;

                if (acc.owner !== bondingCurvePDAStr && acc.owner !== WALLETS.PUMP_LIQUIDITY) {
                    holdersToInsert.push({ mint, owner: acc.owner, balance: acc.balance });
                }
            }
        }

        // Deduplicate by owner (one wallet may hold multiple token accounts)
        const dedupedSingle = new Map();
        for (const h of holdersToInsert) {
            if (dedupedSingle.has(h.owner)) {
                const prev = dedupedSingle.get(h.owner);
                dedupedSingle.set(h.owner, { ...prev, balance: (BigInt(prev.balance) + BigInt(h.balance)).toString() });
            } else {
                dedupedSingle.set(h.owner, h);
            }
        }
        const uniqueHoldersSingle = [...dedupedSingle.values()]
            .sort((a, b) => { const d = BigInt(b.balance) - BigInt(a.balance); return d > 0n ? 1 : d < 0n ? -1 : 0; })
            .slice(0, TOP_HOLDERS_LIMIT);

        if (uniqueHoldersSingle.length > 0) {
            // Clear any existing holders (shouldn't be any for new tokens, but just in case)
            await db.run('DELETE FROM robinhood_token_holders WHERE mint = $1', [mint]);

            const BATCH_SIZE = 50;
            const now = Date.now();

            for (let i = 0; i < uniqueHoldersSingle.length; i += BATCH_SIZE) {
                const batch = uniqueHoldersSingle.slice(i, i + BATCH_SIZE);
                const placeholders = batch.map((_, idx) => {
                    const baseIdx = idx * 5;
                    return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5})`;
                }).join(', ');

                const params = batch.flatMap((h, idx) => [
                    h.mint,
                    h.owner,
                    h.balance,
                    i + idx + 1,
                    now
                ]);

                await db.run(`
                    INSERT INTO robinhood_token_holders (mint, "holderPubkey", balance, rank, "updatedAt")
                    VALUES ${placeholders}
                    ON CONFLICT (mint, "holderPubkey") DO UPDATE SET
                        balance = EXCLUDED.balance,
                        rank = EXCLUDED.rank,
                        "updatedAt" = EXCLUDED."updatedAt"
                `, params);
            }

            logger.info(`[Robinhood] Immediate scan for ${ticker || mint.slice(0, 8)}: found ${uniqueHoldersSingle.length} holders`);
        } else {
            logger.debug(`[Robinhood] Immediate scan for ${ticker || mint.slice(0, 8)}: no holders found yet (token may be very new)`);
        }

        return { success: true, holdersCount: holdersToInsert.length };

    } catch (e) {
        logger.error(`[Robinhood] Immediate scan error for ${mint}`, { error: e.message });
        return { success: false, holdersCount: 0, error: e.message };
    }
}

module.exports = {
    start,
    stop,
    updateRobinhoodState,
    updateRobinhoodHolders,
    updateRegisteredTokensMarketData,
    getRobinhoodPendingFees,
    reverifyRobinhoodTokens,
    parseFeeSharingConfig,
    findOurShare,
    fetchHeliusMetadata,
    fetchDexScreenerMetadata,
    fetchGeckoTerminalMetadata,
    fetchGeckoTerminalTokenInfo,
    fetchPumpFunMetadata,
    scanSingleTokenHolders, // v25.65: Immediate scan for new tokens
};
