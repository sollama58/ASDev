require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction, Keypair, TransactionInstruction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const { Wallet, BN } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const axios = require('axios');
const FormData = require('form-data');
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
// IMPORTS FIXED: Imported constants directly, removed duplicate declarations below
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount, createCloseAccountInstruction, createTransferInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// --- Config ---
const VERSION = "v10.26.10-FEE-TRACKER-UPDATE";
const PORT = process.env.PORT || 3000;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY;
const PRIORITY_FEE_MICRO_LAMPORTS = 100000; 
const DEPLOYMENT_FEE_SOL = 0.02;
// CHANGE 1: Define Fee Threshold used by Flywheel logic 
const FEE_THRESHOLD_SOL = 0.20; 

// Update Intervals (Env Vars or Default)
const HOLDER_UPDATE_INTERVAL = process.env.HOLDER_UPDATE_INTERVAL ? parseInt(process.env.HOLDER_UPDATE_INTERVAL) : 120000;
const METADATA_UPDATE_INTERVAL = process.env.METADATA_UPDATE_INTERVAL ? parseInt(process.env.METADATA_UPDATE_INTERVAL) : 60000; 
const ASDF_UPDATE_INTERVAL = 300000; // 5 minutes

// AUTH STRATEGY
const PINATA_JWT = process.env.PINATA_JWT ? process.env.PINATA_JWT.trim() : null; 
const PINATA_API_KEY_LEGACY = process.env.API_KEY ? process.env.API_KEY.trim() : null;
const PINATA_SECRET_KEY_LEGACY = process.env.SECRET_KEY ? process.env.SECRET_KEY.trim() : null;

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CLARIFAI_API_KEY = process.env.CLARIFAI_API_KEY; 
const HEADER_IMAGE_URL = process.env.HEADER_IMAGE_URL || "https://placehold.co/60x60/d97706/ffffff?text=LOGO";

const DISK_ROOT = '/var/data'; 
const DEBUG_LOG_FILE = path.join(DISK_ROOT, 'server_debug.log');
if (!fs.existsSync(DISK_ROOT)) { if (!fs.existsSync('./data')) fs.mkdirSync('./data'); }

const logStream = fs.createWriteStream(DEBUG_LOG_FILE, { flags: 'a' });
function log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] [${level.toUpperCase()}] ${message} ${JSON.stringify(meta)}\n`);
    const consoleMethod = level === 'error' ? console.error : console.log;
    consoleMethod(`[${level.toUpperCase()}] ${message}`, meta);
}
const logger = { info: (m, d) => log('info', m, d), warn: (m, d) => log('warn', m, d), error: (m, d) => log('error', m, d) };

// --- RPC ---
let SOLANA_CONNECTION_URL = "https://api.mainnet-beta.solana.com"; 
if (HELIUS_API_KEY) { SOLANA_CONNECTION_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`; logger.info("✅ RPC: Helius"); }


// --- CONSTANTS ---
const safePublicKey = (val, f, n) => { try { return new PublicKey(val); } catch (e) { logger.warn(`⚠️ Invalid ${n}`); return new PublicKey(f); } };

// Target: $PUMP
const TARGET_PUMP_TOKEN = safePublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", "11111111111111111111111111111111", "TARGET_PUMP_TOKEN");
// Target: $ASDF
const ASDF_TOKEN_MINT = safePublicKey("9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump", "11111111111111111111111111111111", "ASDF_TOKEN_MINT");

const WALLET_9_5 = safePublicKey("9Cx7bw3opoGJ2z9uYbMLcfb1ukJbJN4CP5uBbDvWwu7Z", "11111111111111111111111111111111", "WALLET_9_5"); 
const WALLET_0_5 = safePublicKey("9zT9rFzDA84K6hJJibcy9QjaFmM8Jm2LzdrvXEiBSq9g", "11111111111111111111111111111111", "WALLET_0_5"); 
const PUMP_LIQUIDITY_WALLET = "CJXSGQnTeRRGbZE1V4rQjYDeKLExPnxceczmAbgBdTsa"; // Wallet that holds tokens locked in the bonding curve

// Program IDs
const PUMP_PROGRAM_ID = safePublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "11111111111111111111111111111111", "PUMP_PROGRAM_ID");
const PUMP_AMM_PROGRAM_ID = safePublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "PUMP_AMM_PROGRAM_ID");
const TOKEN_PROGRAM_2022_ID = safePublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TOKEN_PROGRAM_2022_ID");
// Note: TOKEN_PROGRAM_ID and ASSOCIATED_TOKEN_PROGRAM_ID are now imported from @solana/spl-token
const WSOL_MINT = safePublicKey("So11111111111111111111111111111111111111112", "So11111111111111111111111111111111111111112", "WSOL_MINT");

// Fee & Metaplex
const FEE_PROGRAM_ID = safePublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", "11111111111111111111111111111111", "FEE_PROGRAM_ID");
const FEE_RECIPIENT_STANDARD = safePublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM", "11111111111111111111111111111111", "FEE_RECIPIENT_STANDARD"); 
const MPL_TOKEN_METADATA_PROGRAM_ID = safePublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "MPL_TOKEN_METADATA_PROGRAM_ID");

// Mayhem
const MAYHEM_PROGRAM_ID = safePublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e", "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e", "MAYHEM_PROGRAM_ID");
const GLOBAL_PARAMS = safePublicKey("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ", "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ", "GLOBAL_PARAMS");
const SOL_VAULT = safePublicKey("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", "SOL_VAULT");
const MAYHEM_FEE_RECIPIENT = safePublicKey("GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS", "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS", "MAYHEM_FEE_RECIPIENT");

// --- Global State ---
let lastBackendUpdate = Date.now(); 
let asdfTop50Holders = new Set(); 
let isBuybackRunning = false;
let isAirdropping = false;
let globalTotalPoints = 0; // Tracks total score of all users for airdrop calculation
let devPumpHoldings = 0; // Cached dev wallet pump holdings
// New cache for expected airdrop value calculation
let globalUserExpectedAirdrops = new Map();

// --- DB & Directories ---
if (!fs.existsSync(DISK_ROOT)) { if (!fs.existsSync('./data')) fs.mkdirSync('./data'); }
const DATA_DIR = path.join(DISK_ROOT, 'tokens');
const DB_PATH = fs.existsSync(DISK_ROOT) ? path.join(DISK_ROOT, 'launcher.db') : './data/launcher.db';
const ACTIVE_DATA_DIR = fs.existsSync(DISK_ROOT) ? DATA_DIR : './data/tokens';
const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };
ensureDir(ACTIVE_DATA_DIR);

let deployQueue;
let redisConnection;
try {
    redisConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
    deployQueue = new Queue('deployQueue', { connection: redisConnection });
    logger.info("✅ Redis Queue Initialized");
} catch (e) { logger.error("❌ Redis Init Fail", { error: e.message }); }

// --- CACHE HELPER ---
async function smartCache(key, ttlSeconds, fetchFunction) {
    if (!redisConnection) return await fetchFunction();
    
    try {
        const cached = await redisConnection.get(key);
        if (cached) return JSON.parse(cached);
        
        const data = await fetchFunction();
        if (data !== undefined && data !== null) {
            await redisConnection.set(key, JSON.stringify(data), 'EX', ttlSeconds);
        }
        return data;
    } catch (e) {
        console.error(`Cache Error [${key}]:`, e.message);
        return await fetchFunction(); // Fallback to live fetch
    }
}

let db;
async function initDB() {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL;');
    // REMOVED expectedAirdrop from token_holders for simpler logic, storing globally/in memory
    await db.exec(`CREATE TABLE IF NOT EXISTS tokens (mint TEXT PRIMARY KEY, userPubkey TEXT, name TEXT, ticker TEXT, description TEXT, twitter TEXT, website TEXT, image TEXT, isMayhemMode BOOLEAN, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, volume24h REAL DEFAULT 0, marketCap REAL DEFAULT 0, lastUpdated INTEGER DEFAULT 0, complete BOOLEAN DEFAULT 0, metadataUri TEXT);
        CREATE TABLE IF NOT EXISTS transactions (signature TEXT PRIMARY KEY, userPubkey TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, data TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value REAL);
        CREATE TABLE IF NOT EXISTS token_holders (mint TEXT, holderPubkey TEXT, rank INTEGER, lastUpdated INTEGER, PRIMARY KEY (mint, holderPubkey));
        CREATE TABLE IF NOT EXISTS airdrops (id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL, recipients INTEGER, totalPoints REAL, signatures TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('accumulatedFeesLamports', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('lifetimeFeesLamports', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('lifetimeCreatorFeesLamports', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('totalPumpBoughtLamports', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('lastClaimTimestamp', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('lastClaimAmountLamports', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('nextCheckTimestamp', 0);`); 
    
    // Manual Migration: Dropping old expectedAirdrop column if it exists
    try { await db.exec('ALTER TABLE token_holders DROP COLUMN expectedAirdrop'); } catch(e) {}
    try { await db.exec('ALTER TABLE tokens ADD COLUMN metadataUri TEXT'); } catch(e) {}
    try { await db.exec('ALTER TABLE airdrops ADD COLUMN totalPoints REAL'); } catch(e) {}
    try { await db.exec('ALTER TABLE airdrops ADD COLUMN signatures TEXT'); } catch(e) {}
    
    // Ensure new stat key exists for existing DBs
    try { await db.run("INSERT OR IGNORE INTO stats (key, value) VALUES ('lifetimeCreatorFeesLamports', 0)"); } catch(e) {}

    logger.info(`DB Initialized at ${DB_PATH}`);
}

async function checkContentSafety(base64Data) {
    if (!CLARIFAI_API_KEY) return true;
    try {
        const base64Content = base64Data.replace(/^data:image\/(.*);base64,/, '');
        const response = await axios.post(`https://api.clarifai.com/v2/models/d16f390eb32cad478c7ae150069bd2c6/versions/aa8be956dbaa4b7a858826a84253cab9/outputs`, { inputs: [{ data: { image: { base64: base64Content } } }] }, { headers: { "Authorization": `Key ${CLARIFAI_API_KEY}`, "Content-Type": "application/json" } });
        const concepts = response.data.outputs[0].data.concepts;
        const unsafe = concepts.find(c => (c.name === 'gore' || c.name === 'explicit' || c.name === 'drug') && c.value > 0.85);
        return !unsafe;
    } catch (e) { return true; }
}

initDB();
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const connection = new Connection(SOLANA_CONNECTION_URL, "confirmed");
const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_PRIVATE_KEY));
const wallet = new Wallet(devKeypair);

// --- Helpers ---
const addPriorityFee = (tx) => {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
    return tx;
};

async function sendTxWithRetry(tx, signers, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
            tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight;
            const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed', skipPreflight: true });
            return sig;
        } catch (err) { if (i === retries - 1) throw err; await new Promise(r => setTimeout(r, 2000)); }
    }
}

async function refundUser(userPubkeyStr, reason) {
    try {
        const userPubkey = new PublicKey(userPubkeyStr);
        const tx = new Transaction();
        addPriorityFee(tx); // Gas
        tx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: userPubkey, lamports: (DEPLOYMENT_FEE_SOL - 0.001) * LAMPORTS_PER_SOL }));
        const sig = await sendTxWithRetry(tx, [devKeypair]);
        logger.info(`💰 REFUNDED ${userPubkeyStr}: ${sig} (Reason: ${reason})`);
        return sig;
    } catch (e) { logger.error(`❌ REFUND FAILED: ${e.message}`); return null; }
}

async function addFees(amt) { if(db) { await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amt, 'accumulatedFeesLamports']); await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amt, 'lifetimeFeesLamports']); }}
async function addPumpBought(amt) { if(db) await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amt, 'totalPumpBoughtLamports']); }
async function getTotalLaunches() { if(!db) return 0; const res = await db.get('SELECT COUNT(*) as count FROM tokens'); return res ? res.count : 0; }

async function getStats() { 
    if(!db) return {}; 
    const rows = await db.all('SELECT key, value FROM stats');
    const stats = {};
    rows.forEach(r => stats[r.key] = r.value);
    return stats;
}

// Reset accumulator to 0 since we now use on-chain polling, but keep lifetime
async function resetAccumulatedFees(used) { 
    const cur = await db.get('SELECT value FROM stats WHERE key = ?', 'accumulatedFeesLamports'); 
    await db.run('UPDATE stats SET value = ? WHERE key = ?', [0, 'accumulatedFeesLamports']); 
}

async function recordClaim(amount) {
    if(db) {
        const now = Date.now();
        await db.run('UPDATE stats SET value = ? WHERE key = ?', [now, 'lastClaimTimestamp']);
        await db.run('UPDATE stats SET value = ? WHERE key = ?', [amount, 'lastClaimAmountLamports']);
    }
}

async function updateNextCheckTime() {
    if (db) {
        const nextCheck = Date.now() + 5 * 60 * 1000;
        await db.run('UPDATE stats SET value = ? WHERE key = ?', [nextCheck, 'nextCheckTimestamp']);
    }
}

async function logPurchase(type, data) { 
    try { 
        // UPDATED: Logging structure for better front-end rendering
        await db.run('INSERT INTO logs (type, data, timestamp) VALUES (?, ?, ?)', [type, JSON.stringify(data), new Date().toISOString()]); 
    } catch (e) { console.error("Log error", e); } 
}

async function saveTokenData(pk, mint, meta) {
    try {
        // FIXED: Removed types (TEXT, BOOLEAN) from INSERT statement
        await db.run(`INSERT INTO tokens (mint, userPubkey, name, ticker, description, twitter, website, image, isMayhemMode, metadataUri) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [mint, pk, meta.name, meta.ticker, meta.description, meta.twitter, meta.website, meta.image, meta.isMayhemMode, meta.metadataUri]);
        const shard = pk.slice(0, 2).toLowerCase(); const dir = path.join(ACTIVE_DATA_DIR, shard); ensureDir(dir);
        fs.writeFileSync(path.join(dir, `${mint}.json`), JSON.stringify({ userPubkey: pk, mint, metadata: meta, timestamp: new Date().toISOString() }, null, 2));
    } catch (e) { logger.error("Save Token Error", { err: e.message }); }
}

// --- Bonding Curve Calc ---
function calculateTokensForSol(solAmountLamports) {
    const virtualSolReserves = new BN(30000000000); 
    const virtualTokenReserves = new BN(1073000000000000); 
    const solIn = new BN(solAmountLamports);
    const k = virtualSolReserves.mul(virtualTokenReserves);
    const newVirtualSol = virtualSolReserves.add(solIn);
    const newVirtualTokens = k.div(newVirtualSol);
    return virtualTokenReserves.sub(newVirtualTokens);
}

// --- WORKER ---
if (redisConnection) {
    worker = new Worker('deployQueue', async (job) => {
        logger.info(`STARTING JOB ${job.id}: ${job.data.ticker}`);
        const { name, ticker, description, twitter, website, image, userPubkey, isMayhemMode, metadataUri } = job.data;

        try {
            if (!metadataUri) throw new Error("Metadata URI missing");
            const mintKeypair = Keypair.generate();
            const mint = mintKeypair.publicKey;
            const creator = devKeypair.publicKey;

            // PDAs (Standard)
            const { global, bondingCurve, associatedBondingCurve, eventAuthority, feeConfig, globalVolumeAccumulator } = getPumpPDAs(mint);
            const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
            const [metadata] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], MPL_TOKEN_METADATA_PROGRAM_ID);
            const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID);
            const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), creator.toBuffer()], PUMP_PROGRAM_ID);

            // Mayhem PDAs
            let mayhemState, mayhemTokenVault;
            [mayhemState] = PublicKey.findProgramAddressSync([Buffer.from("mayhem-state"), mint.toBuffer()], MAYHEM_PROGRAM_ID);
            mayhemTokenVault = getATA(mint, SOL_VAULT, TOKEN_PROGRAM_2022_ID);

            // --- CREATE INSTRUCTION ---
            const discriminator = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]); // create_v2
            const serializeString = (str) => { const b = Buffer.from(str, 'utf8'); const len = Buffer.alloc(4); len.writeUInt32LE(b.length, 0); return Buffer.concat([len, b]); };
            
            const data = Buffer.concat([
                discriminator,
                serializeString(name),
                serializeString(ticker),
                serializeString(metadataUri),
                creator.toBuffer(), 
                Buffer.from([isMayhemMode ? 1 : 0]) 
            ]);

            const keys = [
                { pubkey: mint, isSigner: true, isWritable: true },
                { pubkey: mintAuthority, isSigner: false, isWritable: false },
                { pubkey: bondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                { pubkey: global, isSigner: false, isWritable: false },
                { pubkey: creator, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_2022_ID, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: MAYHEM_PROGRAM_ID, isSigner: false, isWritable: true }, 
                { pubkey: GLOBAL_PARAMS, isSigner: false, isWritable: false },
                { pubkey: SOL_VAULT, isSigner: false, isWritable: true },
                { pubkey: mayhemState, isSigner: false, isWritable: true },
                { pubkey: mayhemTokenVault, isSigner: false, isWritable: true },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
            ];

            const createIx = new TransactionInstruction({ keys, programId: PUMP_PROGRAM_ID, data });

            // Buy
            const feeRecipient = isMayhemMode ? MAYHEM_FEE_RECIPIENT : FEE_RECIPIENT_STANDARD;
            const associatedUser = getATA(mint, creator, TOKEN_PROGRAM_2022_ID);
            
            const solBuyAmount = Math.floor(0.01 * LAMPORTS_PER_SOL);
            const tokenBuyAmount = calculateTokensForSol(solBuyAmount);
            
            const buyDiscriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
            const amountBuf = tokenBuyAmount.toArrayLike(Buffer, 'le', 8);
            const maxSolCostBuf = new BN(Math.floor(solBuyAmount * 1.05)).toArrayLike(Buffer, 'le', 8);
            const trackVolumeBuf = Buffer.from([0]); 

            const buyData = Buffer.concat([buyDiscriminator, amountBuf, maxSolCostBuf, trackVolumeBuf]);

            const buyKeys = [
                { pubkey: global, isSigner: false, isWritable: false },
                { pubkey: feeRecipient, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: bondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedUser, isSigner: false, isWritable: true },
                { pubkey: creator, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_2022_ID, isSigner: false, isWritable: false },
                { pubkey: creatorVault, isSigner: false, isWritable: true },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false }, 
                { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
                { pubkey: feeConfig, isSigner: false, isWritable: false },
                { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false }
            ];

            const buyIx = new TransactionInstruction({ keys: buyKeys, programId: PUMP_PROGRAM_ID, data: buyData });

            const createATAIx = new TransactionInstruction({
                keys: [
                    { pubkey: creator, isSigner: true, isWritable: true },
                    { pubkey: associatedUser, isSigner: false, isWritable: true },
                    { pubkey: creator, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_2022_ID, isSigner: false, isWritable: false },
                ],
                programId: ASSOCIATED_TOKEN_PROGRAM_ID,
                data: Buffer.alloc(0),
            });

            const tx = new Transaction();
            addPriorityFee(tx); 
            tx.add(createIx).add(createATAIx).add(buyIx);
            
            tx.feePayer = creator;
            
            logger.info(`Sending Transaction... Buy Amount: ${tokenBuyAmount.toString()} tokens.`);
            const sig = await sendTxWithRetry(tx, [devKeypair, mintKeypair]);
            logger.info(`Transaction Confirmed: ${sig}`);
            
            await saveTokenData(userPubkey, mint.toString(), { name, ticker, description, twitter, website, image, isMayhemMode, metadataUri });

            setTimeout(async () => { try { 
                const bal = await connection.getTokenAccountBalance(associatedUser); 
                if (bal.value && bal.value.uiAmount > 0) { 
                    const sellDiscriminator = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
                    const sellAmountBuf = new BN(bal.value.amount).toArrayLike(Buffer, 'le', 8);
                    const minSolOutputBuf = new BN(0).toArrayLike(Buffer, 'le', 8);
                    const sellData = Buffer.concat([sellDiscriminator, sellAmountBuf, minSolOutputBuf]);

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
                        { pubkey: TOKEN_PROGRAM_2022_ID, isSigner: false, isWritable: false },
                        { pubkey: eventAuthority, isSigner: false, isWritable: false },
                        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
                        { pubkey: feeConfig, isSigner: false, isWritable: false },
                        { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false }
                    ];

                    const sellIx = new TransactionInstruction({ keys: sellKeys, programId: PUMP_PROGRAM_ID, data: sellData });
                    const sellTx = new Transaction();
                    addPriorityFee(sellTx); 
                    sellTx.add(sellIx); 
                    await sendTxWithRetry(sellTx, [devKeypair]); 
                } 
            } catch (e) { logger.error("Sell error", {msg: e.message}); } }, 1500); 

            return { mint: mint.toString(), signature: sig };

        } catch (jobError) {
            logger.error(`❌ Job Failed: ${jobError.message}`);
            if (userPubkey) await refundUser(userPubkey, "Deployment Failed: " + jobError.message);
            throw jobError;
        }
    }, { connection: redisConnection, concurrency: 1 });
}

// --- PDAs/Uploads ---
function getATA(mint, owner, tokenProgramId = TOKEN_PROGRAM_2022_ID) { 
    return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0]; 
}

function getPumpPDAs(mint) {
    const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID);
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
    const associatedBondingCurve = getATA(mint, bondingCurve); 
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
    
    // Hardcoded Fee Config Address
    const feeConfig = new PublicKey("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
    
    const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM_ID);
    return { global, bondingCurve, associatedBondingCurve, eventAuthority, feeConfig, globalVolumeAccumulator };
}

// Helper for Pump AMM (PumpSwap) PDAs
function getPumpAmmPDAs(mint) {
    const [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_AMM_PROGRAM_ID);
    const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), poolAuthority.toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()], PUMP_AMM_PROGRAM_ID);
    const [lpMint] = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), pool.toBuffer()], PUMP_AMM_PROGRAM_ID);
    const poolBaseTokenAccount = getATA(mint, pool, TOKEN_PROGRAM_2022_ID); 
    const poolQuoteTokenAccount = getATA(WSOL_MINT, pool, TOKEN_PROGRAM_ID); 
    return { pool, poolAuthority, lpMint, poolBaseTokenAccount, poolQuoteTokenAccount };
}

function getPinataHeaders(formData) {
    const headers = { ...formData.getHeaders() };
    if (PINATA_JWT) headers['Authorization'] = `Bearer ${PINATA_JWT}`;
    else if (PINATA_API_KEY_LEGACY) { headers['pinata_api_key'] = PINATA_API_KEY_LEGACY; headers['pinata_secret_api_key'] = PINATA_SECRET_KEY_LEGACY; }
    else throw new Error("Missing Pinata Credentials");
    return headers;
}
function getPinataJSONHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (PINATA_JWT) headers['Authorization'] = `Bearer ${PINATA_JWT}`;
    else if (PINATA_API_KEY_LEGACY) { headers['pinata_api_key'] = PINATA_API_KEY_LEGACY; headers['pinata_secret_api_key'] = PINATA_SECRET_KEY_LEGACY; }
    else throw new Error("Missing Pinata Credentials");
    return headers;
}

async function uploadImageToPinata(b64) {
    try {
        const b = Buffer.from(b64.split(',')[1], 'base64');
        const f = new FormData(); f.append('file', b, { filename: 'i.png' });
        const r = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', f, { headers: getPinataHeaders(f), maxBodyLength: Infinity });
        return `https://gateway.pinata.cloud/ipfs/${r.data.IpfsHash}`;
    } catch (e) { return "https://gateway.pinata.cloud/ipfs/QmPc5gX8W8h9j5h8x8h8h8h8h8h8h8h8h8h8h8h8h8"; }
}

async function uploadMetadataToPinata(n, s, d, t, w, i) {
    let u = "https://gateway.pinata.cloud/ipfs/QmPc5gX8W8h9j5h8x8h8h8h8h8h8h8h8h8h8h8h8h8";
    if (i) u = await uploadImageToPinata(i);
    const m = { name: n, symbol: s, description: d, image: u, showName: true, createdOn: "https://pump.fun", twitter: t || "", telegram: "", website: w || "" };
    try {
        const r = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', m, { headers: getPinataJSONHeaders() });
        return `https://gateway.pinata.cloud/ipfs/${r.data.IpfsHash}`;
    } catch (e) { throw new Error(`Pinata Error: ${e.response?.data?.error || e.message}`); }
}

// --- Routes ---
app.get('/api/version', (req, res) => res.json({ version: VERSION }));
app.get('/api/health', async (req, res) => { 
    try { 
        // CACHE IMPLEMENTATION FOR HEALTH ENDPOINT
        const cachedHealth = await smartCache('health_data', 10, async () => {
            const stats = await getStats(); 
            const launches = await getTotalLaunches(); 
            const logs = await db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 50'); 
            
            // RPC Calls to Cache
            const currentBalance = await connection.getBalance(devKeypair.publicKey);
            
            // NEW: Fetch Creator Vault Balances (Pending Fees)
            const { bcVault, ammVaultAta } = getCreatorFeeVaults(devKeypair.publicKey);
            let totalPendingFees = 0;
            
            // 1. Bonding Curve Vault (SOL)
            try {
                const bcInfo = await connection.getAccountInfo(bcVault);
                if (bcInfo) totalPendingFees += bcInfo.lamports;
            } catch(e) {}

            // 2. AMM Vault (WSOL)
            try {
                const ammVaultAtaKey = await ammVaultAta; 
                const wsolBal = await connection.getTokenAccountBalance(ammVaultAtaKey);
                if (wsolBal.value.amount) totalPendingFees += Number(wsolBal.value.amount);
            } catch (e) {}

            let pumpHoldings = 0;
            try {
                const tokenAccounts = await connection.getParsedTokenAccountsByOwner(devKeypair.publicKey, { mint: TARGET_PUMP_TOKEN });
                if (tokenAccounts.value.length > 0) {
                    pumpHoldings = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
                }
            } catch (e) { }

            return {
                stats, launches, logs, currentBalance, pumpHoldings, totalPendingFees
            };
        });

        // CALCULATE LIFETIME FEES (Deployment Fees + Creator Trading Fees)
        const totalFeesLamports = (cachedHealth.stats.lifetimeFeesLamports || 0) + (cachedHealth.stats.lifetimeCreatorFeesLamports || 0);

        res.json({ 
            status: "online", 
            wallet: devKeypair.publicKey.toString(), 
            lifetimeFees: (totalFeesLamports / LAMPORTS_PER_SOL).toFixed(4), // Consolidated Metric
            totalPumpBought: (cachedHealth.stats.totalPumpBoughtLamports / LAMPORTS_PER_SOL).toFixed(4), 
            pumpHoldings: cachedHealth.pumpHoldings,
            totalPoints: globalTotalPoints, 
            totalLaunches: cachedHealth.launches, 
            recentLogs: cachedHealth.logs.map(l => ({ ...JSON.parse(l.data), type: l.type, timestamp: l.timestamp })), 
            headerImageUrl: HEADER_IMAGE_URL,
            // UPDATED: Now showing the sum of Bonding Curve + AMM Vaults
            currentFeeBalance: (cachedHealth.totalPendingFees / LAMPORTS_PER_SOL).toFixed(4),
            lastClaimTime: cachedHealth.stats.lastClaimTimestamp || 0,
            lastClaimAmount: (cachedHealth.stats.lastClaimAmountLamports / LAMPORTS_PER_SOL).toFixed(4),
            nextCheckTime: cachedHealth.stats.nextCheckTimestamp || (Date.now() + 5*60*1000)
        }); 
    } catch (e) { res.status(500).json({ error: "DB Error" }); } 
});

// NEW: Endpoint to fetch all launches
app.get('/api/all-launches', async (req, res) => {
    try {
        // Fetch ALL tokens, ordered by 24h volume descending
        const rows = await db.all('SELECT * FROM tokens ORDER BY volume24h DESC'); 
        const allLaunches = await Promise.all(rows.map(async (r) => { 
            return { 
                mint: r.mint, 
                userPubkey: r.userPubkey, // Included creator's pubkey
                name: r.name, 
                ticker: r.ticker, 
                image: r.image, 
                metadataUri: r.metadataUri, 
                marketCap: r.marketCap || 0, 
                volume: r.volume24h, 
                complete: !!r.complete 
            }; 
        })); 
        res.json({ tokens: allLaunches, lastUpdate: lastBackendUpdate }); 
    } catch (e) { 
        logger.error("All Launches Error", { error: e.message });
        res.status(500).json({ tokens: [], lastUpdate: Date.now() }); 
    } 
});

// NEW: Endpoint to fetch all eligible users and their points
app.get('/api/all-eligible-users', async (req, res) => {
    try {
        // 1. Get List of Top 10 Leaderboard Mints (Active)
        const top10 = await db.all('SELECT mint FROM tokens ORDER BY volume24h DESC LIMIT 10');
        const top10Mints = top10.map(t => t.mint);

        if (top10Mints.length === 0) {
            return res.json({ users: [], totalPoints: 0 });
        }

        // 2. Fetch all holders who hold a top 10 token
        const placeholders = top10Mints.map(() => '?').join(',');
        // No longer fetching expectedAirdrop per token
        const rows = await db.all(`
            SELECT holderPubkey, COUNT(*) as positionCount 
            FROM token_holders 
            WHERE mint IN (${placeholders}) 
            GROUP BY holderPubkey
        `, top10Mints);

        const eligibleUsers = [];
        let calculatedTotalPoints = 0;

        for (const row of rows) {
            // EXCLUDE DEV WALLET
            if (row.holderPubkey === devKeypair.publicKey.toString()) {
                continue; 
            }
            
            const isAsdfTop50 = asdfTop50Holders.has(row.holderPubkey);
            const multiplier = isAsdfTop50 ? 2 : 1;
            const points = row.positionCount * multiplier;

            // Calculate expected airdrop using the global cache (globalUserExpectedAirdrops)
            const expectedAirdrop = globalUserExpectedAirdrops.get(row.holderPubkey) || 0;

            if (points > 0) {
                eligibleUsers.push({
                    pubkey: row.holderPubkey,
                    points: points,
                    positions: row.positionCount,
                    isAsdfTop50: isAsdfTop50,
                    expectedAirdrop: expectedAirdrop
                });
                calculatedTotalPoints += points;
            }
        }

        res.json({ users: eligibleUsers, totalPoints: calculatedTotalPoints });

    } catch (e) { 
        logger.error("All Eligible Users Error", {msg: e.message});
        res.status(500).json({ error: "DB Error" }); 
    } 
});

// NEW: Airdrop Logs Endpoint
app.get('/api/airdrop-logs', async (req, res) => {
    try {
        const logs = await db.all('SELECT * FROM airdrops ORDER BY timestamp DESC LIMIT 20');
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: "DB Error" });
    }
});

// [UPDATED] Check Holder Status - Includes ASDF Top 50 Check & Points Calculation
app.get('/api/check-holder', async (req, res) => { 
    const { userPubkey } = req.query; 
    // New default: Include expectedAirdrop = 0
    if (!userPubkey) return res.json({ isHolder: false, isAsdfTop50: false, points: 0, multiplier: 1, heldPositionsCount: 0, expectedAirdrop: 0 }); 
    
    try { 
        const top10 = await db.all('SELECT mint FROM tokens ORDER BY volume24h DESC LIMIT 10');
        const top10Mints = top10.map(t => t.mint);

        let heldPositionsCount = 0;
        
        if (top10Mints.length > 0) {
            const placeholders = top10Mints.map(() => '?').join(',');
            
            // Query only for position count
            const query = `SELECT COUNT(*) as count FROM token_holders WHERE holderPubkey = ? AND mint IN (${placeholders})`;
            const params = [userPubkey, ...top10Mints];
            
            const result = await db.get(query, params);
            heldPositionsCount = result ? result.count : 0;
        }
        
        // 3. Check ASDF Top 50 Status (from Memory Set)
        const isAsdfTop50 = asdfTop50Holders.has(userPubkey);

        // 4. Calculate Points
        const multiplier = isAsdfTop50 ? 2 : 1;
        const points = heldPositionsCount * multiplier;
        
        // FIX: Retrieve expected airdrop value from the global cache map
        const totalExpectedAirdrop = globalUserExpectedAirdrops.get(userPubkey) || 0;

        res.json({ 
            isHolder: heldPositionsCount > 0, 
            isAsdfTop50: isAsdfTop50, 
            points: points,
            multiplier: multiplier,
            heldPositionsCount: heldPositionsCount,
            expectedAirdrop: totalExpectedAirdrop // Return the aggregated, pre-calculated expected drop
        }); 
    } catch (e) { 
        logger.error("Check Holder Error", {msg: e.message});
        res.status(500).json({ error: "DB Error", expectedAirdrop: 0 }); 
    } 
});

// [UPDATED] Return object with lastUpdate timestamp for "Synced" display
app.get('/api/leaderboard', async (req, res) => { const { userPubkey } = req.query; try { const rows = await db.all('SELECT * FROM tokens ORDER BY volume24h DESC LIMIT 10'); const leaderboard = await Promise.all(rows.map(async (r) => { let isUserTopHolder = false; if (userPubkey) { const holderEntry = await db.get('SELECT rank FROM token_holders WHERE mint = ? AND holderPubkey = ?', [r.mint, userPubkey]); if (holderEntry) isUserTopHolder = true; } 
    return { 
        mint: r.mint, 
        name: r.name, 
        ticker: r.ticker, 
        image: r.image, 
        metadataUri: r.metadataUri, 
        price: (r.marketCap / 1000000000).toFixed(6), // Legacy price calc 
        marketCap: r.marketCap || 0, // Raw market cap from DB
        volume: r.volume24h, 
        isUserTopHolder, 
        complete: !!r.complete 
    }; 
})); 
// Return object wrapper
res.json({ tokens: leaderboard, lastUpdate: lastBackendUpdate }); 
} catch (e) { res.status(500).json({ tokens: [], lastUpdate: Date.now() }); } });

app.get('/api/recent-launches', async (req, res) => { try { const rows = await db.all('SELECT userPubkey, ticker, mint, timestamp FROM tokens ORDER BY timestamp DESC LIMIT 10'); res.json(rows.map(r => ({ userSnippet: r.userPubkey.slice(0, 5), ticker: r.ticker, mint: r.mint }))); } catch (e) { res.status(500).json([]); } });
app.get('/api/debug/logs', (req, res) => { const logPath = path.join(DISK_ROOT, 'server_debug.log'); if (fs.existsSync(logPath)) { const stats = fs.statSync(logPath); const stream = fs.createReadStream(logPath, { start: Math.max(0, stats.size - 50000) }); stream.pipe(res); } else { res.send("No logs yet."); } });
app.get('/api/job-status/:id', async (req, res) => { if (!deployQueue) return res.status(500).json({ error: "Queue not initialized" }); const job = await deployQueue.getJob(req.params.id); if (!job) return res.status(404).json({ error: "Job not found" }); const state = await job.getState(); res.json({ id: job.id, state, result: job.returnvalue, failedReason: job.failedReason }); });

app.get('/api/balance', async (req, res) => { try { const { pubkey } = req.query; if (!pubkey) return res.status(400).json({ error: "Missing pubkey" }); const balance = await connection.getBalance(new PublicKey(pubkey)); res.json({ balance }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/blockhash', async (req, res) => { try { const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized'); res.json({ blockhash, lastValidBlockHeight }); } catch (err) { res.status(500).json({ error: "Failed to get blockhash" }); } });

app.post('/api/prepare-metadata', async (req, res) => {
    try {
        const { name, ticker, description, twitter, website, image } = req.body;
        if (!name || name.length > 32) return res.status(400).json({ error: "Invalid Name" });
        if (!ticker || ticker.length > 10) return res.status(400).json({ error: "Invalid Ticker" });
        if (!image) return res.status(400).json({ error: "Image required" });
        const isSafe = await checkContentSafety(image);
        if (!isSafe) return res.status(400).json({ error: "Upload blocked: Illegal content detected." });
        const metadataUri = await uploadMetadataToPinata(name, ticker, description, twitter, website, image);
        res.json({ success: true, metadataUri });
    } catch (err) { logger.error("Metadata Prep Error", {error: err.message}); res.status(500).json({ error: err.message }); }
});

app.post('/api/deploy', async (req, res) => {
    try {
        const { name, ticker, description, twitter, website, image, metadataUri, userTx, userPubkey, isMayhemMode } = req.body;
        if (!metadataUri) return res.status(400).json({ error: "Missing metadata URI" });

        try { await db.run('INSERT INTO transactions (signature, userPubkey) VALUES (?, ?)', [userTx, userPubkey]); } 
        catch (dbErr) { if (dbErr.message.includes('UNIQUE')) return res.status(400).json({ error: "Tx already used." }); throw dbErr; }

        let validPayment = false;
        for (let i = 0; i < 15; i++) {
            const txInfo = await connection.getParsedTransaction(userTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
            if (txInfo) {
                validPayment = txInfo.transaction.message.instructions.some(ix => { 
                    if (ix.programId.toString() !== '11111111111111111111111111111111') return false; 
                    if (ix.parsed.type !== 'transfer') return false; 
                    return ix.parsed.info.destination === devKeypair.publicKey.toString() && ix.parsed.info.lamports >= DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL; 
                });
                break;
            } else {
                 const { value } = await connection.getSignatureStatus(userTx);
                 if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
                 }
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        if (!validPayment) {
            await db.run('DELETE FROM transactions WHERE signature = ?', [userTx]);
            return res.status(400).json({ error: "Payment verification failed or timed out." });
        }

        await addFees(DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL);
        if (!deployQueue) return res.status(500).json({ error: "Deployment Queue Unavailable" });
        const job = await deployQueue.add('deployToken', { name, ticker, description, twitter, website, image, userPubkey, isMayhemMode, metadataUri });
        res.json({ success: true, jobId: job.id, message: "Queued" });
    } catch (err) { logger.error("Deploy API Error", { error: err.message }); res.status(500).json({ error: err.message }); }
});

// Loops

// 1. Holder Scanner Loop (Internal Launches) + GLOBAL POINTS CALCULATION + ATOMIC UPDATES
// REFACTORED: Extracted loop logic into named function to allow immediate execution
async function updateGlobalState() {
    if (!db) return; 
    try {
        const topTokens = await db.all('SELECT mint FROM tokens ORDER BY volume24h DESC LIMIT 10'); 
        const top10Mints = topTokens.map(t => t.mint);

        // 1A. Cache Dev Wallet Pump Holdings
        const devPumpAta = await getAssociatedTokenAddress(TARGET_PUMP_TOKEN, devKeypair.publicKey);
        try {
            const info = await connection.getTokenAccountBalance(devPumpAta);
            devPumpHoldings = info.value.uiAmount;
        } catch(e) { devPumpHoldings = 0; }
        const distributableAmount = devPumpHoldings * 0.99;
        
        // 1B. Update Individual Token Holders
        for (const token of topTokens) { 
            try { 
                if (!token.mint) continue;
                
                const tokenMintPublicKey = new PublicKey(token.mint);
                // CRITICAL FIX: Calculate the unique Bonding Curve PDA for this token
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), tokenMintPublicKey.toBuffer()], PUMP_PROGRAM_ID);
                const bondingCurvePDAStr = bondingCurvePDA.toString();

                
                // 1. Fetch data from blockchain FIRST (In Memory)
                const accounts = await connection.getTokenLargestAccounts(tokenMintPublicKey); 
                const holdersToInsert = [];

                if (accounts.value) { 
                    // Fetch top 50
                    const topHolders = accounts.value.slice(0, 50); 

                    for (const acc of topHolders) { 
                        try { 
                            const info = await connection.getParsedAccountInfo(acc.address); 
                            if (info.value?.data?.parsed) { 
                                const owner = info.value.data.parsed.info.owner; 
                                
                                // REFINED EXCLUSION LOGIC: 
                                if (owner !== PUMP_LIQUIDITY_WALLET && owner !== bondingCurvePDAStr) { 
                                    holdersToInsert.push({ mint: token.mint, owner: owner }); 
                                } 
                            } 
                        } catch (e) {} 
                    } 
                } 

                // 2. Perform Atomic Update in DB
                if (holdersToInsert.length > 0) {
                    await db.run('BEGIN TRANSACTION');
                    try {
                        // Clear old holders for this specific mint
                        await db.run('DELETE FROM token_holders WHERE mint = ?', token.mint);
                        
                        // Insert new holders 
                        let rank = 1;
                        for (const h of holdersToInsert) {
                            // Note: expectedAirdrop is no longer stored here
                            await db.run(`INSERT OR IGNORE INTO token_holders (mint, holderPubkey, rank, lastUpdated) VALUES (?, ?, ?, ?)`, 
                                [h.mint, h.owner, rank, Date.now()]);
                            rank++;
                        }
                        await db.run('COMMIT');
                    } catch (err) {
                        console.error("Transaction Error", err);
                        await db.run('ROLLBACK');
                    }
                }

            } catch (e) { console.error("Error processing token", token.mint, e.message); } 
            
            // Rate limit protection inside loop
            await new Promise(r => setTimeout(r, 1000)); 
        }

        // --- CALCULATE GLOBAL TOTAL POINTS AND EXPECTED AIRDROP (Global Cache) ---
        let userPointMap = new Map();
        let tempTotalPoints = 0;
        
        if (top10Mints.length > 0) {
            const placeholders = top10Mints.map(() => '?').join(',');
            // Fetch all point-eligible entries (already filtered for LPs/BCs)
            const rows = await db.all(`SELECT holderPubkey, COUNT(*) as positionCount FROM token_holders WHERE mint IN (${placeholders}) GROUP BY holderPubkey`, top10Mints);
            
            for (const row of rows) {
                const isTop50 = asdfTop50Holders.has(row.holderPubkey);
                if (row.holderPubkey !== devKeypair.publicKey.toString()) {
                    const points = row.positionCount * (isTop50 ? 2 : 1);
                    if (points > 0) {
                        userPointMap.set(row.holderPubkey, points);
                        tempTotalPoints += points;
                    }
                }
            }
        }
        globalTotalPoints = tempTotalPoints;
        logger.info(`Updated Global Points: ${globalTotalPoints} | Distributable: ${distributableAmount}`);

        // --- UPDATE GLOBAL CACHE FOR EXPECTED AIRDROP ---
        globalUserExpectedAirdrops.clear();
        if (globalTotalPoints > 0) {
            for (const [pubkey, points] of userPointMap.entries()) {
                const share = points / globalTotalPoints;
                const expectedAirdrop = share * distributableAmount;
                globalUserExpectedAirdrops.set(pubkey, expectedAirdrop);
            }
        }
        // No DB transaction needed for expectedAirdrop calculation, as it's cached in memory map.

    } catch(e) { console.error("Loop Error", e); }
}

// Execute loop on standard interval
setInterval(updateGlobalState, HOLDER_UPDATE_INTERVAL);
// Execute ONCE immediately after startup (with 5s delay to let DB/Connections settle)
setTimeout(updateGlobalState, 5000);


// 2. Token Metadata Loop - [UPDATED] Uses DexScreener first, fallbacks to Pump
setInterval(async () => { 
    if (!db) return; 
    const tokens = await db.all('SELECT mint FROM tokens'); 
    
    // Process tokens sequentially to be gentle on rate limits
    for (const t of tokens) {
        try { 
            // Try DexScreener first (works for both pre-bond and post-bond on Solana)
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${t.mint}`, { timeout: 3000 });
            let mcap = 0;
            let vol = 0;
            let isComplete = 0; // Don't know bonding status from DexScreener alone easily, assume unchanged unless we check Pump API

            if (dexRes.data && dexRes.data.pairs && dexRes.data.pairs.length > 0) {
                const pair = dexRes.data.pairs[0];
                mcap = pair.fdv || pair.marketCap || 0;
                vol = pair.volume ? pair.volume.h24 : 0;
            } else {
                // Fallback to Pump API if DexScreener has no data (brand new token)
                const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${t.mint}`, { timeout: 3000 });
                const pumpData = pumpRes.data;
                if (pumpData) {
                    isComplete = pumpData.complete ? 1 : 0;
                    mcap = pumpData.usd_market_cap || 0;
                    // Pump doesn't give easy volume, so leave as 0 or keep existing
                }
            }

            // Only update completion status if we confirmed it via Pump API or if we trust existing state
            // For now, let's just update metrics. If we want accurate completion status, we need to hit Pump API periodically too.
            // Let's do a quick Pump check if DexScreener worked, just to be sure about "complete" status
            if (mcap > 0) {
                 await db.run(`UPDATE tokens SET volume24h = ?, marketCap = ?, lastUpdated = ? WHERE mint = ?`, 
                    [vol, mcap, Date.now(), t.mint]);
            }

        } catch (e) {
            // logger.warn(`Data Sync Fail for ${t.mint}: ${e.message}`);
        }
        // Small delay between requests
        await new Promise(r => setTimeout(r, 500)); 
    }
    lastBackendUpdate = Date.now();
}, METADATA_UPDATE_INTERVAL);

// 3. ASDF Token Top 50 Loop - CACHED PERSISTENCE
async function syncAsdfHolders() {
    try {
        // Cached fetch logic
        const fetchAsdfHolders = async () => {
            const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
                filters: [
                    { dataSize: 165 }, 
                    { memcmp: { offset: 0, bytes: ASDF_TOKEN_MINT.toBase58() } } 
                ],
                encoding: 'base64'
            });
            const holders = accounts.map(acc => {
                const data = Buffer.from(acc.account.data);
                const amount = new BN(data.slice(64, 72), 'le'); 
                const owner = new PublicKey(data.slice(32, 64)).toString(); 
                return { owner, amount: amount.toString() }; // BN to string for JSON
            }).sort((a, b) => new BN(b.amount).cmp(new BN(a.amount)));
            
            return holders.slice(0, 50).map(h => h.owner);
        };

        // Cache for 5 mins (same as interval), effectively persisting it
        const top50 = await smartCache('asdf_top_50', 300, fetchAsdfHolders);
        
        asdfTop50Holders = new Set(top50);
        logger.info(`✅ Updated ASDF Top 50 Holders. Count: ${asdfTop50Holders.size}`);

    } catch (e) {
        logger.error(`❌ ASDF Sync Failed: ${e.message}`);
    }
}
setInterval(syncAsdfHolders, ASDF_UPDATE_INTERVAL);

// Run ASDF sync immediately on startup
setTimeout(syncAsdfHolders, 5000);


// --- Helper for fee addresses ---
function getCreatorFeeVaults(creator) {
    const [bcVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID);
    const [ammVaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM_PROGRAM_ID);
    const ammVaultAta = getAssociatedTokenAddress(WSOL_MINT, ammVaultAuth, true);
    return { bcVault, ammVaultAuth, ammVaultAta };
}

async function claimCreatorFees() {
    const { bcVault, ammVaultAuth, ammVaultAta } = getCreatorFeeVaults(devKeypair.publicKey);
    const tx = new Transaction();
    addPriorityFee(tx);
    let claimedSomething = false;

    // 1. Claim Bonding Curve Fees (SOL)
    try {
        const bcInfo = await connection.getAccountInfo(bcVault);
        if (bcInfo && bcInfo.lamports > 0) {
            const discriminator = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
            const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
            
            const keys = [
                { pubkey: devKeypair.publicKey, isSigner: false, isWritable: true }, // creator
                { pubkey: bcVault, isSigner: false, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
            ];
            tx.add(new TransactionInstruction({ keys, programId: PUMP_PROGRAM_ID, data: discriminator }));
            claimedSomething = true;
        }
    } catch(e) {}

    // 2. Claim AMM Fees (WSOL)
    try {
        const myWsolAta = await getAssociatedTokenAddress(WSOL_MINT, devKeypair.publicKey);
        try { await getAccount(connection, myWsolAta); } 
        catch (error) { 
            tx.add(createAssociatedTokenAccountInstruction(devKeypair.publicKey, myWsolAta, devKeypair.publicKey, WSOL_MINT));
        }

        const ammVaultAtaKey = await ammVaultAta;
        const bal = await connection.getTokenAccountBalance(ammVaultAtaKey).catch(() => ({ value: { amount: "0" } }));
        
        if (new BN(bal.value.amount).gt(new BN(0))) {
            const ammDiscriminator = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]); // collect_coin_creator_fee
            const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM_ID);
            
            const keys = [
                { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: devKeypair.publicKey, isSigner: true, isWritable: false }, // coin_creator
                { pubkey: ammVaultAuth, isSigner: false, isWritable: false },
                { pubkey: ammVaultAtaKey, isSigner: false, isWritable: true },
                { pubkey: myWsolAta, isSigner: false, isWritable: true }, // destination
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false }
            ];
            tx.add(new TransactionInstruction({ keys, programId: PUMP_AMM_PROGRAM_ID, data: ammDiscriminator }));
            tx.add(createCloseAccountInstruction(myWsolAta, devKeypair.publicKey, devKeypair.publicKey));
            claimedSomething = true;
        }
    } catch(e) {}

    if (claimedSomething) {
        tx.feePayer = devKeypair.publicKey;
        await sendTxWithRetry(tx, [devKeypair]);
        return true;
    }
    return false;
}

// --- NEW AUTOMATED AIRDROP LOGIC ---
async function processAirdrop() {
    if (isAirdropping) return;
    isAirdropping = true;
    try {
        // 1. Check Balance (Use cached devPumpHoldings from the interval loop)
        const balance = devPumpHoldings;
        if (balance <= 10000) return;

        logger.info(`🔥 AIRDROP TRIGGERED: Balance ${balance} PUMP > 10,000`);

        // 2. Calculate Distributable
        const amountToDistribute = balance * 0.99;
        const amountToDistributeInt = new BN(amountToDistribute * 1000000); // 6 decimals

        // 3. Get Eligible Users (Use cached map calculated in Loop 1)
        const userPoints = Array.from(globalUserExpectedAirdrops.entries())
            .map(([pubkey, expectedAirdrop]) => ({
                pubkey: new PublicKey(pubkey),
                // We need the raw points to calculate the share during the TX process
                points: globalTotalPoints > 0 ? (expectedAirdrop / (amountToDistribute / globalTotalPoints)) : 0 
            }))
            .filter(user => user.points > 0);


        // Use the globally calculated point total
        if (globalTotalPoints === 0 || userPoints.length === 0) return;

        logger.info(` distributing ${amountToDistribute} PUMP to ${userPoints.length} users (Total Points: ${globalTotalPoints})`);

        const devPumpAta = await getAssociatedTokenAddress(TARGET_PUMP_TOKEN, devKeypair.publicKey);

        // 4. Build Transactions
        const BATCH_SIZE = 8; 
        let currentBatch = [];
        let allSignatures = [];
        
        for (const user of userPoints) {
            const share = amountToDistributeInt.mul(new BN(user.points)).div(new BN(globalTotalPoints));
            if (share.eqn(0)) continue;

            currentBatch.push({ user: user.pubkey, amount: share });

            if (currentBatch.length >= BATCH_SIZE) {
                const sig = await sendAirdropBatch(currentBatch, devPumpAta);
                if (sig) allSignatures.push(sig);
                currentBatch = [];
                await new Promise(r => setTimeout(r, 1000)); // Rate limit protection
            }
        }

        if (currentBatch.length > 0) {
            const sig = await sendAirdropBatch(currentBatch, devPumpAta);
            if (sig) allSignatures.push(sig);
        }

        // Log Airdrop with signatures
        const signaturesStr = allSignatures.join(',');
        await db.run('INSERT INTO airdrops (amount, recipients, totalPoints, signatures, timestamp) VALUES (?, ?, ?, ?, ?)', 
            [amountToDistribute, userPoints.length, globalTotalPoints, signaturesStr, new Date().toISOString()]);

    } catch (e) {
        logger.error("Airdrop Failed", { error: e.message });
    } finally {
        isAirdropping = false;
    }
}

async function sendAirdropBatch(batch, sourceAta) {
    const tx = new Transaction();
    addPriorityFee(tx);

    const atas = await Promise.all(batch.map(i => getAssociatedTokenAddress(TARGET_PUMP_TOKEN, i.user)));
    const infos = await connection.getMultipleAccountsInfo(atas);
    
    batch.forEach((item, idx) => {
        const ata = atas[idx];
        if (!infos[idx]) {
            tx.add(createAssociatedTokenAccountInstruction(devKeypair.publicKey, ata, item.user, TARGET_PUMP_TOKEN));
        }
        tx.add(createTransferInstruction(sourceAta, ata, devKeypair.publicKey, BigInt(item.amount.toString())));
    });

    try {
        const sig = await sendTxWithRetry(tx, [devKeypair]);
        logger.info(`Batch sent to ${batch.length} users. Sig: ${sig}`);
        return sig;
    } catch(e) {
        logger.error(`Batch failed`, {e: e.message});
        return null;
    }
}

async function runPurchaseAndFees() {
    if (isBuybackRunning) return;
    isBuybackRunning = true;
    let logData = {
        status: 'SKIPPED',
        reason: 'Unknown Error',
        feesCollected: 0,
        solSpent: 0,
        transfer9_5: 0,
        transfer0_5: 0,
        pumpBuySig: null
    };

    try {
        // 1. Poll On-Chain Fees (Bonding Curve + AMM)
        const { bcVault, ammVaultAuth, ammVaultAta } = getCreatorFeeVaults(devKeypair.publicKey);
        let totalPendingFees = new BN(0);

        try {
            const bcInfo = await connection.getAccountInfo(bcVault);
            if (bcInfo) totalPendingFees = totalPendingFees.add(new BN(bcInfo.lamports));
        } catch(e) {}

        try {
            const ammVaultAtaKey = await ammVaultAta;
            const bal = await connection.getTokenAccountBalance(ammVaultAtaKey);
            if (bal.value.amount) totalPendingFees = totalPendingFees.add(new BN(bal.value.amount));
        } catch(e) {}
        
        logData.feesCollected = totalPendingFees.toNumber() / LAMPORTS_PER_SOL;

        const threshold = new BN(FEE_THRESHOLD_SOL * LAMPORTS_PER_SOL);
        
        // 1. Always Claim if threshold met (Income generation)
        if (totalPendingFees.gte(threshold)) {
             logger.info(`CLAIM TRIGGERED...`);
             await claimCreatorFees();
             
             // UPDATE CREATOR FEE STATS
             try {
                await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [totalPendingFees.toNumber(), 'lifetimeCreatorFeesLamports']);
             } catch(e) {}

             await new Promise(r => setTimeout(r, 2000));
        } else {
            logData.reason = `Threshold not met (Needed: ${FEE_THRESHOLD_SOL} SOL, Found: ${logData.feesCollected.toFixed(4)} SOL)`;
        }

        // 2. Check Balance & Buffer
        const realBalance = await connection.getBalance(devKeypair.publicKey);
        // CHANGE 2: Updated SAFETY_BUFFER to 0.05 SOL (50,000,000 lamports)
        const SAFETY_BUFFER = 50000000; 
        const SAFETY_BUFFER_SOL = SAFETY_BUFFER / LAMPORTS_PER_SOL;


        if (realBalance < SAFETY_BUFFER) {
            logData.reason = `LOW BALANCE: ${(realBalance/LAMPORTS_PER_SOL).toFixed(4)} SOL < ${SAFETY_BUFFER_SOL} SOL Buffer. Skipping Buyback/Airdrop.`;
            logger.warn(`⚠️ ${logData.reason}`);
            logData.status = 'LOW_BALANCE_SKIP';
        } else if (totalPendingFees.gte(threshold)) {
            // 3. Execute Buyback
             const spendable = realBalance - SAFETY_BUFFER; 
             const MIN_SPEND = 0.05 * LAMPORTS_PER_SOL;
             
             if (spendable > MIN_SPEND) { 
                 const transfer9_5 = Math.floor(spendable * 0.095); 
                 const transfer0_5 = Math.floor(spendable * 0.005); 
                 const solBuyAmountLamports = Math.floor(spendable * 0.90);

                 // Log data before attempt
                 logData.solSpent = (solBuyAmountLamports + transfer9_5 + transfer0_5) / LAMPORTS_PER_SOL;
                 logData.transfer9_5 = transfer9_5 / LAMPORTS_PER_SOL;
                 logData.transfer0_5 = transfer0_5 / LAMPORTS_PER_SOL;

                 const sig = await buyViaPumpAmm(solBuyAmountLamports, transfer9_5, transfer0_5, spendable);
                 
                 logData.pumpBuySig = sig;
                 logData.status = sig ? 'SUCCESS' : 'BUY_FAIL';
                 logData.reason = sig ? 'Flywheel Buyback Complete' : 'Buyback Transaction Failed';
             } else {
                 logData.reason = `Spendable SOL too low for efficient buyback (Spendable: ${(spendable/LAMPORTS_PER_SOL).toFixed(4)} SOL)`;
                 logData.status = 'LOW_SPEND_SKIP';
             }
        } 
        
        // 4. Run Airdrop (Safe now)
        await processAirdrop();
        logPurchase('FLYWHEEL_CYCLE', logData);

    } catch(e) { 
        logData.status = 'CRITICAL_ERROR';
        logData.reason = e.message;
        logPurchase('FLYWHEEL_CYCLE', logData);
        logger.error(`CRITICAL FLYWHEEL ERROR`, { message: e.message }); 
    } 
    finally { 
        isBuybackRunning = false; 
        await updateNextCheckTime();
    }
}

async function buyViaPumpAmm(amountIn, transfer9_5, transfer0_5, totalSpendable) {
    logger.info("Starting Pump AMM Swap for $PUMP...");
    try {
        const mint = TARGET_PUMP_TOKEN;
        const [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_AMM_PROGRAM_ID);
        // Canonical pool index is 0
        const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), new Uint8Array([0,0]), poolAuthority.toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()], PUMP_AMM_PROGRAM_ID);
        
        // Dynamically fetch Pool to get coin_creator
        const poolInfo = await connection.getAccountInfo(pool);
        if (!poolInfo) throw new Error("Pump Pool Not Found");
        
        // Decode coin_creator from Pool data (Offset 211 based on IDL/Struct)
        // Discriminator(8) + Bump(1) + Index(2) + Creator(32) + Base(32) + Quote(32) + LP(32) + PoolBase(32) + PoolQuote(32) + Supply(8) = 211 bytes
        const coinCreator = new PublicKey(poolInfo.data.subarray(211, 243));
        const [coinCreatorVaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), coinCreator.toBuffer()], PUMP_AMM_PROGRAM_ID);
        const coinCreatorVaultAta = await getAssociatedTokenAddress(WSOL_MINT, coinCreatorVaultAuth, true);

        const [ammGlobalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_AMM_PROGRAM_ID);
        const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), FEE_PROGRAM_ID.toBuffer()], PUMP_PROGRAM_ID); // Fee program config? Actually usually derived from Fee Program ID in Pump logic. IDL says seeds=["fee_config", feeProgram]
        
        // For Protocol Fee Recipient: Default to the one in docs/global config or read from GlobalConfig
        const protocolFeeRecipient = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV"); // From PUMP_SWAP_README
        const protocolFeeRecipientTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, protocolFeeRecipient, true);

        const userWsol = await getAssociatedTokenAddress(WSOL_MINT, devKeypair.publicKey);
        const userToken = await getAssociatedTokenAddress(mint, devKeypair.publicKey, false, TOKEN_PROGRAM_2022_ID); // Pump uses Token2022? Wait, legacy tokens are on standard. Pump is legacy.
        // Let's assume Legacy for PUMP token itself unless specified.
        const userTokenLegacy = await getAssociatedTokenAddress(mint, devKeypair.publicKey);

        const poolBaseTokenAccount = getATA(mint, pool, TOKEN_PROGRAM_ID); // Using Standard
        const poolQuoteTokenAccount = getATA(WSOL_MINT, pool, TOKEN_PROGRAM_ID);

        const tx = new Transaction();
        addPriorityFee(tx);

        // 1. Setup User Token Account (if not exists)
        const tokenAccountInfo = await connection.getAccountInfo(userTokenLegacy);
        if (!tokenAccountInfo) {
            tx.add(createAssociatedTokenAccountInstruction(devKeypair.publicKey, userTokenLegacy, devKeypair.publicKey, mint));
        }

        // 2. Setup WSOL & Fund it
        try { await getAccount(connection, userWsol); } catch (e) {
            tx.add(createAssociatedTokenAccountInstruction(devKeypair.publicKey, userWsol, devKeypair.publicKey, WSOL_MINT));
        }
        tx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: userWsol, lamports: amountIn }));
        tx.add({ keys: [{ pubkey: userWsol, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }); // SyncNative

        // 3. Swap Instruction
        const swapDiscriminator = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]); // buy_exact_quote_in (We are spending SOL)
        const amountInBuf = new BN(amountIn).toArrayLike(Buffer, 'le', 8);
        const minAmountOutBuf = new BN(1).toArrayLike(Buffer, 'le', 8);
        const trackVolumeBuf = Buffer.from([0]);
        const swapData = Buffer.concat([swapDiscriminator, amountInBuf, minAmountOutBuf, trackVolumeBuf]);

        const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM_ID);
        const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_AMM_PROGRAM_ID);
        const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), devKeypair.publicKey.toBuffer()], PUMP_AMM_PROGRAM_ID);

        const swapKeys = [
            { pubkey: pool, isSigner: false, isWritable: true },
            { pubkey: devKeypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: ammGlobalConfig, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
            { pubkey: userTokenLegacy, isSigner: false, isWritable: true }, // Base Dest
            { pubkey: userWsol, isSigner: false, isWritable: true }, // Quote Source
            { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
            { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
            { pubkey: protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Base Prog
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Quote Prog
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: eventAuthority, isSigner: false, isWritable: false },
            { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
            { pubkey: coinCreatorVaultAuth, isSigner: false, isWritable: false },
            { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
            { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
            { pubkey: feeConfig, isSigner: false, isWritable: false },
            { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false }
        ];

        tx.add(new TransactionInstruction({
            keys: swapKeys,
            programId: PUMP_AMM_PROGRAM_ID,
            data: swapData
        }));

        // 4. Close WSOL
        tx.add(createCloseAccountInstruction(userWsol, devKeypair.publicKey, devKeypair.publicKey));

        // 5. Fee Distribution
        tx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_9_5, lamports: transfer9_5 })); 
        tx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_0_5, lamports: transfer0_5 }));

        tx.feePayer = devKeypair.publicKey;

        const sig = await sendTxWithRetry(tx, [devKeypair]);
        await addPumpBought(0); // Tracking only, can update to actual bought amount if needed
        await recordClaim(totalSpendable); 
        // Note: Buyback log details are handled by runPurchaseAndFees wrapper
        return sig;

    } catch (e) {
        logger.error("Pump AMM Swap Failed", { error: e.message });
        return null;
    }
}

// Poll every 5 minutes
setInterval(runPurchaseAndFees, 5 * 60 * 1000); 

app.listen(PORT, () => logger.info(`Server v${VERSION} running on ${PORT}`));
