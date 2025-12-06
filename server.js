require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet, BN } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// --- Configuration ---
const VERSION = "v10.0.0";
const PORT = process.env.PORT || 3000;
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const PINATA_JWT = process.env.PINATA_JWT;
const HEADER_IMAGE_URL = process.env.HEADER_IMAGE_URL || "https://placehold.co/60x60/d97706/ffffff?text=LOGO";

const TARGET_PUMP_TOKEN = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const WALLET_19_5 = new PublicKey("9Cx7bw3opoGJ2z9uYbMLcfb1ukJbJN4CP5uBbDvWwu7Z"); // Fee Wallet
const WALLET_0_5 = new PublicKey("9zT9rFzDA84K6hJJibcy9QjaFmM8Jm2LzdrvXEiBSq9g"); // Upkeep Fee
const FEE_THRESHOLD_SOL = 0.20;

// --- PERSISTENT DISK CONFIGURATION ---
const DISK_ROOT = '/var/data'; 
const DATA_DIR = path.join(DISK_ROOT, 'tokens'); 
const STATS_FILE = path.join(DISK_ROOT, 'stats.json');
const PURCHASE_LOG = path.join(DISK_ROOT, 'purchase_logs.json');

// Directory Setup
if (!fs.existsSync(DISK_ROOT)) {
    console.warn(`⚠️ Warning: Disk root ${DISK_ROOT} does not exist. Fallback to local.`);
    if (!fs.existsSync('./data')) fs.mkdirSync('./data');
} 

const ACTIVE_DATA_DIR = fs.existsSync(DISK_ROOT) ? DATA_DIR : './data/tokens';
const ACTIVE_STATS_FILE = fs.existsSync(DISK_ROOT) ? STATS_FILE : './data/stats.json';
const ACTIVE_LOG_FILE = fs.existsSync(DISK_ROOT) ? PURCHASE_LOG : './data/purchase_logs.json';

// Ensure Directories
const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };
ensureDir(ACTIVE_DATA_DIR);
const DB_PATH = fs.existsSync(DISK_ROOT) ? path.join(DISK_ROOT, 'launcher.db') : './data/launcher.db';

// --- Database Init ---
let db;
async function initDB() {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tokens (mint TEXT PRIMARY KEY, userPubkey TEXT, name TEXT, ticker TEXT, description TEXT, twitter TEXT, website TEXT, image TEXT, isMayhemMode BOOLEAN, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, volume24h REAL DEFAULT 0, marketCap REAL DEFAULT 0, lastUpdated INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS transactions (signature TEXT PRIMARY KEY, userPubkey TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, data TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value REAL);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('accumulatedFeesLamports', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('lifetimeFeesLamports', 0);
    `);
    console.log(`✅ Database initialized at ${DB_PATH}`);
}
initDB();

if (!DEV_WALLET_PRIVATE_KEY || !HELIUS_API_KEY || !PINATA_JWT) {
    console.error("❌ ERROR: Missing Environment Variables.");
    process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const CONNECTION_CONFIG = { commitment: "confirmed", confirmTransactionInitialTimeout: 120000 };

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_PROGRAM_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const FEE_RECIPIENT = new PublicKey("FNLWHjvjptwC7LxycdK3Knqcv5ptC19C9rynn6u2S1tB");

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const connection = new Connection(RPC_URL, CONNECTION_CONFIG);
let devKeypair;
try {
    devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_PRIVATE_KEY));
} catch (err) {
    console.error("❌ Invalid Private Key format.");
    process.exit(1);
}
const wallet = new Wallet(devKeypair);
const provider = new AnchorProvider(connection, wallet, CONNECTION_CONFIG);

const idlRaw = fs.readFileSync('./pump_idl.json', 'utf8');
const idl = JSON.parse(idlRaw);
idl.address = PUMP_PROGRAM_ID.toString();
const program = new Program(idl, PUMP_PROGRAM_ID, provider);

// --- Helpers ---

// Retry Helper
async function sendTxWithRetry(tx, signers, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed', skipPreflight: true });
            return sig;
        } catch (err) {
            console.warn(`⚠️ Tx attempt ${i + 1} failed:`, err.message);
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function saveTokenData(userPubkey, mint, metadata) {
    try {
        await db.run(`INSERT INTO tokens (mint, userPubkey, name, ticker, description, twitter, website, image, isMayhemMode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [mint, userPubkey, metadata.name, metadata.ticker, metadata.description, metadata.twitter, metadata.website, metadata.image, metadata.isMayhemMode]);
        
        // Also save to disk for redundancy
        const shard = userPubkey.slice(0, 2).toLowerCase();
        const shardDir = path.join(ACTIVE_DATA_DIR, shard);
        ensureDir(shardDir);
        fs.writeFileSync(path.join(shardDir, `${mint}.json`), JSON.stringify({ userPubkey, mint, metadata, timestamp: new Date().toISOString() }, null, 2));
    } catch (e) { console.error("DB Save Token Error:", e); }
}

async function checkTransactionUsed(signature) {
    const result = await db.get('SELECT signature FROM transactions WHERE signature = ?', signature);
    return !!result;
}

async function markTransactionUsed(signature, userPubkey) {
    await db.run('INSERT INTO transactions (signature, userPubkey) VALUES (?, ?)', [signature, userPubkey]);
}

async function addFees(amountLamports) {
    await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amountLamports, 'accumulatedFeesLamports']);
    await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amountLamports, 'lifetimeFeesLamports']);
}

async function getStats() {
    const acc = await db.get('SELECT value FROM stats WHERE key = ?', 'accumulatedFeesLamports');
    const life = await db.get('SELECT value FROM stats WHERE key = ?', 'lifetimeFeesLamports');
    return { accumulatedFeesLamports: acc ? acc.value : 0, lifetimeFeesLamports: life ? life.value : 0 };
}

async function resetAccumulatedFees(amountUsed) {
    const current = await db.get('SELECT value FROM stats WHERE key = ?', 'accumulatedFeesLamports');
    const newVal = Math.max(0, (current ? current.value : 0) - amountUsed);
    await db.run('UPDATE stats SET value = ? WHERE key = ?', [newVal, 'accumulatedFeesLamports']);
}

async function logPurchase(type, data) {
    try { await db.run('INSERT INTO logs (type, data) VALUES (?, ?)', [type, JSON.stringify(data)]); } catch (e) {}
}

async function getRecentLogs(limit = 5) {
    const rows = await db.all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', limit);
    return rows.map(row => ({ ...JSON.parse(row.data), type: row.type, timestamp: row.timestamp }));
}

// --- Leaderboard Indexer ---
setInterval(async () => {
    if (!db) return;
    const tokens = await db.all('SELECT mint FROM tokens'); 
    for (let i = 0; i < tokens.length; i += 5) {
        const batch = tokens.slice(i, i + 5);
        await Promise.all(batch.map(async (t) => {
            try {
                const response = await axios.get(`https://frontend-api.pump.fun/coins/${t.mint}`, { timeout: 2000 });
                const data = response.data;
                if (data) await db.run(`UPDATE tokens SET volume24h = ?, marketCap = ?, lastUpdated = ? WHERE mint = ?`, [data.usd_market_cap || 0, data.usd_market_cap || 0, Date.now(), t.mint]);
            } catch (e) {}
        }));
        await new Promise(r => setTimeout(r, 1000));
    }
}, 2 * 60 * 1000);

// --- Buyback Loop (5 Mins) ---
let isBuybackRunning = false;
async function runPurchaseAndFees() {
    if (isBuybackRunning) return;
    isBuybackRunning = true;
    console.log("🔄 Running PurchaseAndFees Routine...");

    try {
        const stats = await getStats();
        const balanceLamports = stats.accumulatedFeesLamports;
        const thresholdLamports = FEE_THRESHOLD_SOL * LAMPORTS_PER_SOL;

        if (balanceLamports >= thresholdLamports) {
            const realBalance = await connection.getBalance(devKeypair.publicKey);
            const spendable = Math.min(balanceLamports, realBalance - 5000000); 
            if (spendable <= 0) { await logPurchase('SKIPPED', { reason: 'Insufficient Real Balance', balance: (realBalance/LAMPORTS_PER_SOL).toFixed(4) }); return; }

            const buyAmount = new BN(Math.floor(spendable * 0.80));
            const transfer19_5 = Math.floor(spendable * 0.195);
            const transfer0_5 = Math.floor(spendable * 0.005);

            const { bondingCurve, associatedBondingCurve } = getPumpPDAs(TARGET_PUMP_TOKEN, PUMP_PROGRAM_ID);
            const associatedUser = getATA(TARGET_PUMP_TOKEN, devKeypair.publicKey);
            
            const buyIx = await program.methods.buyExactSolIn(buyAmount, new BN(1), false)
            .accounts({
                global: PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID)[0],
                feeRecipient: FEE_RECIPIENT, mint: TARGET_PUMP_TOKEN, bondingCurve, associatedBondingCurve, associatedUser, user: devKeypair.publicKey,
                systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID, 
                creatorVault: PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), bondingCurve.toBuffer()], PUMP_PROGRAM_ID)[0],
                eventAuthority: PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID)[0],
                program: PUMP_PROGRAM_ID, globalVolumeAccumulator: PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM_ID)[0],
                userVolumeAccumulator: PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), devKeypair.publicKey.toBuffer()], PUMP_PROGRAM_ID)[0],
                feeConfig: PublicKey.findProgramAddressSync([Buffer.from("fee_config")], FEE_PROGRAM_ID)[0], feeProgram: FEE_PROGRAM_ID
            }).instruction();

            const tx = new Transaction().add(buyIx)
                .add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_19_5, lamports: transfer19_5 }))
                .add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_0_5, lamports: transfer0_5 }));
            
            tx.feePayer = devKeypair.publicKey;
            const sig = await sendTxWithRetry(tx, [devKeypair]);
            console.log(`✅ Buyback Success: ${sig}`);

            await logPurchase('SUCCESS', { totalSpent: spendable, buyAmount: buyAmount.toString(), signature: sig });
            await resetAccumulatedFees(spendable);
        } else {
            await logPurchase('SKIPPED', { reason: 'Fees Under Limit', current: (balanceLamports/LAMPORTS_PER_SOL).toFixed(4), target: FEE_THRESHOLD_SOL });
        }
    } catch (err) {
        console.error("❌ Buyback Routine Failed:", err);
        await logPurchase('ERROR', { message: err.message });
    } finally { isBuybackRunning = false; }
}
setInterval(runPurchaseAndFees, 5 * 60 * 1000);

// --- PDAs & Helpers ---
function getPumpPDAs(mint, programId = PUMP_PROGRAM_ID) {
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], programId);
    const associatedBondingCurve = PublicKey.findProgramAddressSync([bondingCurve.toBuffer(), TOKEN_PROGRAM_2022_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
    return { bondingCurve, associatedBondingCurve };
}
function getDeploymentPDAs(mint, creator) {
    const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
    const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID);
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
    const [globalVolume] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM_ID);
    const [userVolume] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), creator.toBuffer()], PUMP_PROGRAM_ID);
    const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config")], FEE_PROGRAM_ID);
    const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID);
    return { mintAuthority, bondingCurve, global, eventAuthority, globalVolume, userVolume, feeConfig, creatorVault };
}
function getMayhemPDAs(mint) {
    const [globalParams] = PublicKey.findProgramAddressSync([Buffer.from("global-params")], MAYHEM_PROGRAM_ID);
    const [solVault] = PublicKey.findProgramAddressSync([Buffer.from("sol-vault")], MAYHEM_PROGRAM_ID);
    const [mayhemState] = PublicKey.findProgramAddressSync([Buffer.from("mayhem-state"), mint.toBuffer()], MAYHEM_PROGRAM_ID);
    return { globalParams, solVault, mayhemState };
}
function getATA(mint, owner) {
    return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_2022_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
async function uploadImageToPinata(base64Data) {
    try {
        const buffer = Buffer.from(base64Data.split(',')[1], 'base64');
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'token_image.png' });
        const res = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, { headers: { 'Authorization': `Bearer ${PINATA_JWT}`, ...formData.getHeaders() } });
        return `https://gateway.pinata.cloud/ipfs/${res.data.IpfsHash}`;
    } catch (e) { return "https://gateway.pinata.cloud/ipfs/QmPc5gX8W8h9j5h8x8h8h8h8h8h8h8h8h8h8h8h8h8"; }
}
async function uploadMetadataToPinata(name, symbol, description, twitter, website, imageBase64) {
    let imageUrl = "https://gateway.pinata.cloud/ipfs/QmPc5gX8W8h9j5h8x8h8h8h8h8h8h8h8h8h8h8h8h8";
    if (imageBase64) imageUrl = await uploadImageToPinata(imageBase64);
    const metadata = { name, symbol, description, image: imageUrl, extensions: { twitter: twitter || "", website: website || "" } };
    try {
        const res = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', metadata, { headers: { 'Authorization': `Bearer ${PINATA_JWT}` } });
        return `https://gateway.pinata.cloud/ipfs/${res.data.IpfsHash}`;
    } catch (e) { throw new Error("Failed to upload metadata"); }
}

// --- Routes ---
app.get('/api/version', (req, res) => res.json({ version: VERSION }));

app.get('/api/health', async (req, res) => {
    try {
        const stats = await getStats();
        const logs = await db.all('SELECT * FROM logs ORDER BY id DESC LIMIT 50'); 
        res.json({ 
            status: "online", 
            wallet: devKeypair.publicKey.toString(),
            lifetimeFees: (stats.lifetimeFeesLamports / LAMPORTS_PER_SOL).toFixed(4),
            recentLogs: logs.map(l => ({ ...JSON.parse(l.data), type: l.type, timestamp: l.timestamp })),
            headerImageUrl: HEADER_IMAGE_URL 
        });
    } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

app.get('/api/recent-launches', async (req, res) => {
    try {
        const rows = await db.all('SELECT userPubkey, ticker, mint, timestamp FROM tokens ORDER BY timestamp DESC LIMIT 10');
        res.json(rows.map(r => ({ userSnippet: r.userPubkey.slice(0, 5), ticker: r.ticker, mint: r.mint })));
    } catch (e) { res.status(500).json([]); }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const rows = await db.all('SELECT * FROM tokens ORDER BY volume24h DESC LIMIT 10');
        res.json(rows.map(r => ({
            mint: r.mint, name: r.name, ticker: r.ticker, image: r.image,
            price: (r.marketCap / 1000000000).toFixed(6), volume: r.volume24h
        })));
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/deploy', async (req, res) => {
    try {
        const { name, ticker, description, twitter, website, userTx, userPubkey, image, isMayhemMode } = req.body;
        
        if (!name || name.length > 32) return res.status(400).json({ error: "Invalid Name" });
        if (!ticker || ticker.length > 10) return res.status(400).json({ error: "Invalid Ticker" });
        if (!image) return res.status(400).json({ error: "Image required" });

        const used = await checkTransactionUsed(userTx);
        if (used) return res.status(400).json({ error: "Transaction signature already used." });

        const txInfo = await connection.getParsedTransaction(userTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!txInfo) return res.status(400).json({ error: "Transaction not found." });
        
        const validPayment = txInfo.transaction.message.instructions.some(ix => {
            if (ix.programId.toString() !== '11111111111111111111111111111111') return false; 
            if (ix.parsed.type !== 'transfer') return false;
            return ix.parsed.info.destination === devKeypair.publicKey.toString() && ix.parsed.info.lamports >= 0.05 * LAMPORTS_PER_SOL;
        });
        if (!validPayment) return res.status(400).json({ error: "Payment verification failed." });

        await markTransactionUsed(userTx, userPubkey);
        await addFees(0.05 * LAMPORTS_PER_SOL);

        const metadataUri = await uploadMetadataToPinata(name, ticker, description, twitter, website, image);
        const mintKeypair = Keypair.generate();
        const mint = mintKeypair.publicKey;
        const creator = devKeypair.publicKey;

        await saveTokenData(userPubkey, mint.toString(), { name, ticker, description, twitter, website, image, isMayhemMode });

        const { mintAuthority, bondingCurve, global, eventAuthority, globalVolume, userVolume, feeConfig, creatorVault } = getDeploymentPDAs(mint, creator);
        const { globalParams, solVault, mayhemState } = getMayhemPDAs(mint);
        const associatedBondingCurve = getATA(mint, bondingCurve);
        const mayhemTokenVault = getATA(mint, solVault);
        const associatedUser = getATA(mint, creator);

        const createIx = await program.methods.createV2(name, ticker, metadataUri, creator, !!isMayhemMode)
            .accounts({ mint, mintAuthority, bondingCurve, associatedBondingCurve, global, user: creator, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, mayhemProgramId: MAYHEM_PROGRAM_ID, globalParams, solVault, mayhemState, mayhemTokenVault, eventAuthority, program: PUMP_PROGRAM_ID }).instruction();

        const buyIx = await program.methods.buyExactSolIn(new BN(0.01 * LAMPORTS_PER_SOL), new BN(1), false)
            .accounts({ global, feeRecipient: FEE_RECIPIENT, mint, bondingCurve, associatedBondingCurve, associatedUser, user: creator, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID, creatorVault, eventAuthority, program: PUMP_PROGRAM_ID, globalVolumeAccumulator: globalVolume, userVolumeAccumulator: userVolume, feeConfig, feeProgram: FEE_PROGRAM_ID }).instruction();

        const tx = new Transaction().add(createIx).add(buyIx);
        tx.feePayer = creator;
        const sig = await sendTxWithRetry(tx, [devKeypair, mintKeypair]);
        
        setTimeout(async () => {
            try {
                const bal = await connection.getTokenAccountBalance(associatedUser);
                if (bal.value.uiAmount > 0) {
                    const sellIx = await program.methods.sell(new BN(bal.value.amount), new BN(0)).accounts({ global, feeRecipient: FEE_RECIPIENT, mint, bondingCurve, associatedBondingCurve, associatedUser, user: creator, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, creatorVault, eventAuthority, program: PUMP_PROGRAM_ID, globalVolumeAccumulator: globalVolume, userVolumeAccumulator: userVolume, feeConfig, feeProgram: FEE_PROGRAM_ID }).instruction();
                    const sellTx = new Transaction().add(sellIx);
                    await sendTxWithRetry(sellTx, [devKeypair]);
                }
            } catch (e) { console.error("Sell error:", e.message); }
        }, 1500); 

        res.json({ success: true, mint: mint.toString(), signature: sig });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Launcher running on ${PORT}`));
