#!/usr/bin/env node
/**
 * Smoke test
 *
 * Runs without a network, Redis or a wallet with funds:
 *  1. `node --check` on every source file.
 *  2. Loads every module with a throwaway wallet and a temporary data directory.
 *  3. Exercises the pure helpers and the SQLite layer.
 *
 * Run with `npm test`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asdev-smoke-'));

// --- 1. Syntax ---------------------------------------------------------------
const listJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? listJs(full) : (d.name.endsWith('.js') ? [full] : []);
});
const sources = [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'scripts'))];
for (const file of sources) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`syntax ok (${sources.length} files)`);

// --- 2. Environment for module loading ---------------------------------------
const { Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
process.env.DEV_WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.DISK_ROOT = dataDir;
process.env.NODE_ENV = 'test';
process.env.RPC_URL = 'http://127.0.0.1:9'; // never contacted by this script

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- 3. Tests ----------------------------------------------------------------
test('every module loads', () => {
    require(path.join(ROOT, 'src/services'));
    require(path.join(ROOT, 'src/routes'));
    require(path.join(ROOT, 'src/tasks'));
});

test('run guard skips overlapping runs and recovers from a stuck one', () => {
    const { createRunGuard, maxRunAge } = require(path.join(ROOT, 'src/tasks/runGuard'));
    const guard = createRunGuard('test', 1000);
    const first = guard.tryAcquire();
    assert.ok(first, 'first run acquires');
    assert.strictEqual(guard.tryAcquire(), null, 'second run is skipped while the first is fresh');
    guard.release(first);
    assert.ok(guard.tryAcquire(), 'acquires again once released');

    const stuck = createRunGuard('stuck', 0); // anything older than 0 ms counts as stuck
    const a = stuck.tryAcquire();
    const b = stuck.tryAcquire();
    assert.ok(b && b !== null, 'a stuck run does not block the next one');
    stuck.release(a);
    assert.strictEqual(stuck.isRunning(), true, 'the late release of the stuck run does not clear the new one');
    stuck.release(b);
    assert.strictEqual(stuck.isRunning(), false);

    assert.strictEqual(maxRunAge(60000), 10 * 60 * 1000, 'never sooner than ten minutes');
    assert.strictEqual(maxRunAge(5 * 60 * 1000), 15 * 60 * 1000, 'three intervals otherwise');
});

test('holder exclusions drop program-owned accounts and named wallets', () => {
    const { isExcludedHolder } = require(path.join(ROOT, 'src/tasks/holderScanner'));
    const { PROGRAMS, WALLETS } = require(path.join(ROOT, 'src/config/constants'));
    const wallet = Keypair.generate().publicKey.toString();
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), Keypair.generate().publicKey.toBuffer()], PROGRAMS.PUMP);
    const excluded = new Set([WALLETS.PUMP_LIQUIDITY]);
    assert.strictEqual(isExcludedHolder(wallet, excluded), false, 'a normal wallet is kept');
    assert.strictEqual(isExcludedHolder(pda.toString(), excluded), true, 'a PDA (pool, vault, curve) is excluded');
    assert.strictEqual(isExcludedHolder(WALLETS.PUMP_LIQUIDITY, excluded), true, 'listed wallets are excluded');
    assert.strictEqual(isExcludedHolder('not-a-key', excluded), true, 'garbage is excluded');
});

test('deploy input validation', () => {
    const { validateNameAndTicker, validateOptionalFields, isServerMetadataUri } = require(path.join(ROOT, 'src/routes/deploy'));
    assert.strictEqual(validateNameAndTicker('Token', 'TKN'), null);
    assert.strictEqual(validateNameAndTicker('ü'.repeat(16), 'TKN'), null, '16 two-byte chars fit in 32 bytes');
    assert.ok(validateNameAndTicker('x'.repeat(33), 'TKN'), 'name over 32 bytes rejected');
    assert.ok(validateNameAndTicker('ü'.repeat(17), 'TKN'), 'byte length, not character length (17 chars, 34 bytes)');
    assert.ok(validateNameAndTicker('Token', 'TOOLONGTICKER'), 'ticker over 10 bytes rejected');
    assert.ok(validateNameAndTicker('', 'TKN'), 'empty name rejected');
    assert.ok(validateNameAndTicker(42, 'TKN'), 'non-string rejected');
    assert.strictEqual(validateOptionalFields({ description: 'hi', twitter: 'x', website: 'y' }), null);
    assert.ok(validateOptionalFields({ description: 'x'.repeat(76) }), 'description over 75 rejected');
    assert.ok(validateOptionalFields({ website: 'x'.repeat(201) }), 'long links rejected');
    assert.strictEqual(isServerMetadataUri('https://gateway.pinata.cloud/ipfs/QmabcDEF'), true);
    assert.strictEqual(isServerMetadataUri('https://evil.example/metadata.json'), false, 'foreign hosts rejected');
    assert.strictEqual(isServerMetadataUri('https://gateway.pinata.cloud/ipfs/'), false, 'empty hash rejected');
    assert.strictEqual(isServerMetadataUri('https://gateway.pinata.cloud/ipfs/' + 'a'.repeat(200)), false, 'over 200 bytes rejected');
});

test('permanent transaction errors are recognised', () => {
    const { isPermanentError } = require(path.join(ROOT, 'src/services/solana'));
    assert.strictEqual(isPermanentError(new Error('Transaction simulation failed: InstructionError')), true);
    assert.strictEqual(isPermanentError(new Error('insufficient lamports 1, need 2')), true);
    assert.strictEqual(isPermanentError(new Error('fetch failed')), false);
    assert.strictEqual(isPermanentError(new Error('TransactionExpiredBlockheightExceededError')), false);
});

test('metadata refresh tiers', () => {
    const { selectDueTokens } = require(path.join(ROOT, 'src/tasks/metadataUpdater'));
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const tokens = [
        { mint: 'new', timestamp: now - hour, volume24h: 0, lastUpdated: now },
        { mint: 'old-stale', timestamp: now - 100 * hour, volume24h: 0, lastUpdated: now - 100 * hour },
        { mint: 'old-fresh', timestamp: now - 100 * hour, volume24h: 0, lastUpdated: now - 1000 },
    ];
    const { due } = selectDueTokens(tokens, now);
    const mints = due.map(t => t.mint);
    assert.ok(mints.includes('new'), 'recently launched is hot');
    assert.ok(mints.includes('old-stale'), 'stale old token is due');
});

test('sqlite: schema, upsert keeps market data, log pruning', async () => {
    const database = require(path.join(ROOT, 'src/services/database'));
    await database.initDB();
    const db = database.getDB();

    const cols = (await db.all('PRAGMA table_info(tokens)')).map(c => c.name);
    for (const c of ['complete', 'lastUpdated', 'priceUsd']) assert.ok(cols.includes(c), `tokens.${c} exists`);
    const holderCols = (await db.all('PRAGMA table_info(token_holders)')).map(c => c.name);
    for (const c of ['balance', 'updatedAt']) assert.ok(holderCols.includes(c), `token_holders.${c} exists`);
    const indexes = (await db.all("SELECT name FROM sqlite_master WHERE type = 'index'")).map(i => i.name);
    assert.ok(indexes.includes('idx_logs_timestamp'), 'logs index exists');

    const creator = Keypair.generate().publicKey.toString();
    const mint = Keypair.generate().publicKey.toString();
    await database.saveTokenData(creator, mint, { name: 'A', ticker: 'A', metadataUri: 'u', image: 'i' });
    await db.run('UPDATE tokens SET volume24h = 123, marketCap = 456, complete = 1 WHERE mint = ?', [mint]);
    await database.saveTokenData(creator, mint, { name: 'B', ticker: 'B', metadataUri: 'u', image: 'i' });
    const row = await db.get('SELECT name, volume24h, marketCap, complete FROM tokens WHERE mint = ?', [mint]);
    assert.strictEqual(row.name, 'B', 'metadata updated on re-save');
    assert.strictEqual(row.volume24h, 123, 'volume kept on re-save');
    assert.strictEqual(row.marketCap, 456, 'market cap kept on re-save');
    assert.strictEqual(row.complete, 1, 'complete flag kept on re-save');

    for (let i = 0; i < 30; i++) await database.logPurchase('TEST', { i });
    const removed = await database.pruneLogs(10);
    assert.strictEqual(removed, 20, 'prune keeps the newest rows');
    const left = await db.get('SELECT COUNT(*) as n, MIN(id) as minId FROM logs');
    assert.strictEqual(left.n, 10);
    await db.close();
});

test('rpc connection times out instead of hanging', async () => {
    const http = require('http');
    const server = http.createServer(() => { /* never answer */ });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { Connection } = require('@solana/web3.js');
    const config = require(path.join(ROOT, 'src/config/env'));
    const connection = new Connection(`http://127.0.0.1:${server.address().port}`, {
        commitment: 'confirmed',
        fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(300) }),
    });
    assert.ok(config.RPC_TIMEOUT_MS > 0);
    const started = Date.now();
    await assert.rejects(connection.getSlot(), /abort|timeout/i);
    assert.ok(Date.now() - started < 5000, 'rejected promptly');
    server.close();
});

// --- Runner ------------------------------------------------------------------
(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`PASS ${name}`);
        } catch (e) {
            failed++;
            console.error(`FAIL ${name}\n  ${e.stack || e.message}`);
        }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (failed) {
        console.error(`${failed} test(s) failed`);
        process.exit(1);
    }
    console.log(`all ${tests.length} tests passed`);
    process.exit(0);
})();
