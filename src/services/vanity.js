/**
 * Vanity Mint Service (consumer side)
 * v28.1 - Hands pre-ground mint keypairs to the launch path.
 *
 * This is the half that runs inside the API/worker processes. It never grinds -- it only
 * claims from the pool that the dedicated grinder service fills. Every failure mode here
 * falls back to a random mint, because a launch must never be blocked by the pool being
 * empty, the grinder being down, or an encryption key being wrong.
 */
const { Keypair } = require('@solana/web3.js');
const logger = require('./logger');
const config = require('../config/env');
const vanitySecret = require('./vanitySecret');

/**
 * Claim one address from the pool.
 *
 * The claim is a single atomic statement. `FOR UPDATE SKIP LOCKED` is what makes concurrent
 * launches safe: two simultaneous deploys each lock a different row instead of both reading
 * the same one, and neither blocks waiting on the other.
 *
 * @returns {Promise<{keypair: Keypair, address: string, suffix: string}|null>}
 */
async function claimMintKeypair(db) {
    if (!db) return null;
    if (!vanitySecret.isConfigured()) return null;

    let row;
    try {
        row = await db.get(
            `UPDATE vanity_mints
                SET status = 'claimed', claimed_at = $1
              WHERE id = (
                    SELECT id FROM vanity_mints
                     WHERE status = 'available'
                     ORDER BY id
                     LIMIT 1
                     FOR UPDATE SKIP LOCKED
              )
          RETURNING id, mint_address, encrypted_seed, suffix`,
            [Date.now()]
        );
    } catch (e) {
        logger.warn('[Vanity] Pool claim query failed, falling back to a random mint', { error: e.message });
        return null;
    }

    if (!row) return null; // pool empty — expected, not an error

    const seed = vanitySecret.decryptSeed(row.encrypted_seed);
    if (!seed || seed.length !== 32) {
        // Unreadable row: quarantine it so the next launch does not trip over it again.
        logger.error('[Vanity] Claimed row could not be decrypted, marking it failed', { address: row.mint_address });
        await db.run("UPDATE vanity_mints SET status = 'failed' WHERE id = $1", [row.id]).catch(() => {});
        return null;
    }

    let keypair;
    try {
        keypair = Keypair.fromSeed(Uint8Array.from(seed));
    } catch (e) {
        logger.error('[Vanity] Claimed seed is not a valid keypair, marking it failed', { address: row.mint_address, error: e.message });
        await db.run("UPDATE vanity_mints SET status = 'failed' WHERE id = $1", [row.id]).catch(() => {});
        return null;
    }

    // Guard against a row whose stored address disagrees with its seed.
    if (keypair.publicKey.toBase58() !== row.mint_address) {
        logger.error('[Vanity] Stored address does not match its seed, marking it failed', { address: row.mint_address });
        await db.run("UPDATE vanity_mints SET status = 'failed' WHERE id = $1", [row.id]).catch(() => {});
        return null;
    }

    return { keypair, address: row.mint_address, suffix: row.suffix, id: row.id };
}

/**
 * Get a mint keypair for a launch: a pooled vanity address when one is available, otherwise
 * a plain random one.
 *
 * @param {object} [db] - database handle; omit to force the random path
 * @returns {Promise<{keypair: Keypair, isVanity: boolean, id: number|null}>}
 */
async function getMintKeypair(db) {
    try {
        const claimed = await claimMintKeypair(db);
        if (claimed) {
            logger.info(`[Vanity] Using pooled mint ${claimed.address} (…${claimed.suffix})`);
            return { keypair: claimed.keypair, isVanity: true, id: claimed.id };
        }
    } catch (e) {
        // Defensive: claimMintKeypair handles its own errors, but a launch must never fail
        // because of this service.
        logger.warn('[Vanity] Unexpected error claiming a pooled mint', { error: e.message });
    }

    logger.info('[Vanity] No pooled mint available — using a random mint');
    return { keypair: Keypair.generate(), isVanity: false, id: null };
}

/** Mark a claimed address as spent, once its create transaction has been broadcast. */
async function markUsed(db, id) {
    if (!db || !id) return;
    await db.run("UPDATE vanity_mints SET status = 'used', used_at = $1 WHERE id = $2", [Date.now(), id])
        .catch(e => logger.warn('[Vanity] Could not mark mint used', { id, error: e.message }));
}

/**
 * Return a claimed address to the pool.
 *
 * Only safe to call when the launch failed *before* the create transaction was broadcast.
 * After broadcast the mint may exist on-chain, and re-handing it to another launch would
 * produce a create that can never succeed.
 */
async function release(db, id) {
    if (!db || !id) return;
    await db.run("UPDATE vanity_mints SET status = 'available', claimed_at = NULL WHERE id = $1 AND status = 'claimed'", [id])
        .catch(e => logger.warn('[Vanity] Could not release mint back to the pool', { id, error: e.message }));
}

/**
 * v29.1: Return addresses stranded in the 'claimed' state to the pool.
 *
 * A launch claims an address and then either marks it used, once its create transaction has
 * been broadcast, or releases it if it failed before that point. A crash between those two
 * steps left the row claimed forever, so every hard restart mid-launch permanently leaked a
 * ground address -- expensive, since each one costs minutes of CPU to produce.
 *
 * Only rows older than the timeout are touched, so an in-flight launch is never reaped out
 * from under itself. This is deliberately conservative about the opposite risk too: a row
 * reaped while its transaction was in fact broadcast would be handed to a second launch
 * whose create could never succeed, which is why the timeout is far longer than any launch.
 *
 * @returns {Promise<number>} how many addresses were recovered
 */
async function reapStrandedClaims(db, timeoutMs = config.VANITY_CLAIM_TIMEOUT_MS) {
    if (!db) return 0;
    try {
        const cutoff = Date.now() - timeoutMs;
        const rows = await db.all(
            `UPDATE vanity_mints
                SET status = 'available', claimed_at = NULL
              WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < $1
          RETURNING mint_address`,
            [cutoff]
        );
        const n = rows?.length || 0;
        if (n > 0) {
            logger.warn(`[Vanity] Returned ${n} stranded address(es) to the pool`, {
                addresses: rows.slice(0, 5).map(r => r.mint_address),
                strandedForLongerThanMs: timeoutMs
            });
        }
        return n;
    } catch (e) {
        logger.warn('[Vanity] Stranded-claim sweep failed', { error: e.message });
        return 0;
    }
}

/** Pool depth by status, for health and admin views. */
async function getPoolStats(db) {
    if (!db) return null;
    try {
        const rows = await db.all('SELECT status, COUNT(*) AS c FROM vanity_mints GROUP BY status');
        const out = { available: 0, claimed: 0, used: 0, failed: 0 };
        for (const r of rows) out[r.status] = parseInt(r.c, 10) || 0;
        return out;
    } catch (e) {
        return null;
    }
}

module.exports = { getMintKeypair, claimMintKeypair, markUsed, release, reapStrandedClaims, getPoolStats };
