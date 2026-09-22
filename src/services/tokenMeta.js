/**
 * On-chain token name/symbol resolution.
 * v30.1 - Added so the quote-asset picker can show "TSLAx" instead of a base58 blob.
 *
 * Custom Pairs let a coin be quoted in any of ~90 tokenised assets, and pump.fun's
 * `fetchSupportedQuoteMints` returns nothing but the mint address and where it was admitted
 * from. A picker listing raw addresses is unusable, so the label has to come from somewhere.
 *
 * It comes from chain rather than from a token-list API on purpose: the launcher already
 * depends on an RPC endpoint, and adding a second network dependency to render a dropdown
 * means the dropdown breaks for reasons unrelated to launching. Two sources are read, in the
 * order a mint is likely to use them:
 *
 *   1. The Metaplex token-metadata PDA — what classic SPL mints use.
 *   2. The Token-2022 `TokenMetadata` extension, stored on the mint account itself — what the
 *      newer tokenised-equity mints use, and which has no Metaplex PDA at all.
 *
 * Both are read in batches and cached for a long TTL: a mint's symbol does not change.
 */
const { PublicKey } = require('@solana/web3.js');
const { getTokenMetadata, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const logger = require('./logger');

const METAPLEX_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// A symbol is immutable in practice; an hour keeps a restart cheap without pinning a rename
// forever.
const TTL_MS = 60 * 60 * 1000;

// getMultipleAccountsInfo caps at 100 keys per call.
const BATCH = 100;

const cache = new Map(); // mint base58 -> { value: {symbol, name}|null, at }

function metadataPda(mint) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mint.toBuffer()],
        METAPLEX_PROGRAM
    )[0];
}

/**
 * Decode the name and symbol out of a Metaplex `Metadata` account.
 *
 * The layout up to the fields we want is fixed: 1 byte key, 32 bytes update authority,
 * 32 bytes mint, then borsh strings (u32 length prefix, then utf-8) for name, symbol and uri.
 * Only the first two strings are read. The stored strings are fixed-width and padded with NUL
 * bytes, which have to come off or every label ends in invisible junk.
 */
function decodeMetaplex(data) {
    try {
        let off = 1 + 32 + 32;
        const readString = () => {
            const len = data.readUInt32LE(off);
            off += 4;
            // A corrupt or non-Metadata account can encode an absurd length; refuse it rather
            // than slicing far past the end of the buffer.
            if (len > 256 || off + len > data.length) throw new Error('bad string length');
            const s = data.slice(off, off + len).toString('utf8');
            off += len;
            return s.replace(/\0+$/, '').trim();
        };
        const name = readString();
        const symbol = readString();
        if (!name && !symbol) return null;
        return { name, symbol };
    } catch (e) {
        return null;
    }
}

/**
 * Resolve `{ symbol, name }` for each mint, as a Map keyed by base58 address.
 *
 * Mints that cannot be resolved are absent from the Map rather than mapped to a placeholder,
 * so a caller can tell "no metadata" from "metadata says empty" and pick its own fallback.
 * Never throws: a label is cosmetic, and losing it must not fail the call it decorates.
 */
async function resolveSymbols(connection, mints) {
    const keys = [];
    const out = new Map();
    const now = Date.now();

    for (const m of mints) {
        const s = typeof m === 'string' ? m : m.toBase58();
        const hit = cache.get(s);
        if (hit && now - hit.at < TTL_MS) {
            if (hit.value) out.set(s, hit.value);
            continue;
        }
        keys.push(s);
    }
    if (!keys.length) return out;

    // Pass 1: Metaplex PDAs, in batches.
    const unresolved = [];
    for (let i = 0; i < keys.length; i += BATCH) {
        const slice = keys.slice(i, i + BATCH);
        let infos;
        try {
            infos = await connection.getMultipleAccountsInfo(slice.map(s => metadataPda(new PublicKey(s))));
        } catch (e) {
            logger.debug('[TokenMeta] Metaplex batch read failed', { error: e.message });
            unresolved.push(...slice);
            continue;
        }
        slice.forEach((s, n) => {
            const info = infos[n];
            const decoded = info && info.data ? decodeMetaplex(info.data) : null;
            if (decoded) {
                cache.set(s, { value: decoded, at: Date.now() });
                out.set(s, decoded);
            } else {
                unresolved.push(s);
            }
        });
    }
    if (!unresolved.length) return out;

    // Pass 2: the Token-2022 metadata extension, which lives on the mint account. Read the
    // mint accounts first so only genuine Token-2022 mints cost a getTokenMetadata call.
    for (let i = 0; i < unresolved.length; i += BATCH) {
        const slice = unresolved.slice(i, i + BATCH);
        let infos;
        try {
            infos = await connection.getMultipleAccountsInfo(slice.map(s => new PublicKey(s)));
        } catch (e) {
            logger.debug('[TokenMeta] Mint batch read failed', { error: e.message });
            continue;
        }
        for (let n = 0; n < slice.length; n++) {
            const s = slice[n];
            const info = infos[n];
            if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
                cache.set(s, { value: null, at: Date.now() });
                continue;
            }
            try {
                const md = await getTokenMetadata(connection, new PublicKey(s), 'confirmed', TOKEN_2022_PROGRAM_ID);
                const value = md && (md.name || md.symbol)
                    ? { name: (md.name || '').trim(), symbol: (md.symbol || '').trim() }
                    : null;
                cache.set(s, { value, at: Date.now() });
                if (value) out.set(s, value);
            } catch (e) {
                cache.set(s, { value: null, at: Date.now() });
            }
        }
    }

    return out;
}

function resetCache() {
    cache.clear();
}

module.exports = { resolveSymbols, resetCache, decodeMetaplex, metadataPda };
