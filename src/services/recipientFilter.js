/**
 * Payable-recipient filter
 * v30.2 - Keeps SOL airdrops away from accounts no person controls.
 *
 * A holder list is built from token-account owners, and an owner can be a program account:
 * a PumpSwap pool, a lending vault, a locker. SOL transferred to an account owned by another
 * program is stranded there -- only that program could ever move it, and none of them will --
 * so paying such an "owner" throws the share away. The pool of a graduated coin is the worst
 * case, because it is normally that coin's single largest holder.
 *
 * Rather than trying to enumerate every program's PDAs, this asks the chain who owns each
 * address and keeps only accounts owned by the System Program (ordinary wallets) or that do
 * not exist yet (a wallet with zero SOL; the airdrop itself will create it, and the 0.01 SOL
 * minimum share is above the rent-exempt floor). Multisig vaults such as Squads are
 * system-owned PDAs and still pass.
 *
 * Ownership essentially never changes, so answers are cached for a day; steady-state cost is
 * close to zero RPC.
 */
const { PublicKey, SystemProgram } = require('@solana/web3.js');
const logger = require('./logger');

const TTL_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;
const cache = new Map(); // base58 -> { payable: boolean, at }

setInterval(() => {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
}, 60 * 60 * 1000).unref();

/**
 * @param {Connection} connection
 * @param {string[]} owners - base58 addresses
 * @returns {Promise<Set<string>>} the subset that can safely receive SOL. On an RPC failure
 *          the unresolved addresses are treated as NOT payable: skipping someone for one cycle
 *          leaves their share in the pool, while paying a program account loses it.
 */
async function payableSet(connection, owners) {
    const now = Date.now();
    const out = new Set();
    const unknown = [];

    for (const o of new Set(owners)) {
        const hit = cache.get(o);
        if (hit && now - hit.at < TTL_MS) {
            if (hit.payable) out.add(o);
        } else {
            unknown.push(o);
        }
    }

    for (let i = 0; i < unknown.length; i += BATCH) {
        const slice = unknown.slice(i, i + BATCH);
        let infos;
        try {
            infos = await connection.getMultipleAccountsInfo(slice.map(s => new PublicKey(s)));
        } catch (e) {
            logger.warn('[RecipientFilter] Owner lookup failed; skipping those holders this cycle', {
                count: slice.length, error: e.message
            });
            continue;
        }
        slice.forEach((addr, n) => {
            const info = infos[n];
            const payable = !info || info.owner.equals(SystemProgram.programId);
            cache.set(addr, { payable, at: Date.now() });
            if (payable) out.add(addr);
        });
    }

    return out;
}

function resetCache() {
    cache.clear();
}

module.exports = { payableSet, resetCache };
