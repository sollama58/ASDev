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

// --- Config ---
const VERSION = "v10.22.0-LOG-FIX";
const PORT = process.env.PORT || 3000;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY;
const PRIORITY_FEE_MICRO_LAMPORTS = 100000; 
const DEPLOYMENT_FEE_SOL = 0.02;

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

const WALLET_9_5 = safePublicKey("9Cx7bw3opoGJ2z9uYbMLcfb1ukJbJN4CP5uBbDvWwu7Z", "11111111111111111111111111111111", "WALLET_9_5"); 
const WALLET_0_5 = safePublicKey("9zT9rFzDA84K6hJJibcy9QjaFmM8Jm2LzdrvXEiBSq9g", "11111111111111111111111111111111", "WALLET_0_5"); 
const PUMP_LIQUIDITY_WALLET = "CJXSGQnTeRRGbZE1V4rQjYDeKLExPnxceczmAbgBdTsa";
const FEE_THRESHOLD_SOL = 0.20;

// Program IDs
const PUMP_PROGRAM_ID = safePublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "11111111111111111111111111111111", "PUMP_PROGRAM_ID");
const PUMP_AMM_PROGRAM_ID = safePublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "PUMP_AMM_PROGRAM_ID");
const TOKEN_PROGRAM_2022_ID = safePublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TOKEN_PROGRAM_2022_ID");
const TOKEN_PROGRAM_ID = safePublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TOKEN_PROGRAM_ID");
const ASSOCIATED_TOKEN_PROGRAM_ID = safePublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "11111111111111111111111111111111", "ASSOCIATED_TOKEN_PROGRAM_ID");
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

// --- DB & Directories ---
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

let db;
async function initDB() {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL;');
    // [CHANGED] Added `metadataUri` to schema
    await db.exec(`CREATE TABLE IF NOT EXISTS tokens (mint TEXT PRIMARY KEY, userPubkey TEXT, name TEXT, ticker TEXT, description TEXT, twitter TEXT, website TEXT, image TEXT, isMayhemMode BOOLEAN, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, volume24h REAL DEFAULT 0, marketCap REAL DEFAULT 0, lastUpdated INTEGER DEFAULT 0, complete BOOLEAN DEFAULT 0, metadataUri TEXT);
        CREATE TABLE IF NOT EXISTS transactions (signature TEXT PRIMARY KEY, userPubkey TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, data TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value REAL);
        CREATE TABLE IF NOT EXISTS token_holders (mint TEXT, holderPubkey TEXT, rank INTEGER, lastUpdated INTEGER, PRIMARY KEY (mint, holderPubkey));
        INSERT OR IGNORE INTO stats (key, value) VALUES ('accumulatedFeesLamports', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('lifetimeFeesLamports', 0);
        INSERT OR IGNORE INTO stats (key, value) VALUES ('totalPumpBoughtLamports', 0);`);
    
    try { await db.exec('ALTER TABLE tokens ADD COLUMN metadataUri TEXT'); } catch(e) {}

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
async function getStats() { if(!db) return { accumulatedFeesLamports: 0, lifetimeFeesLamports: 0, totalPumpBoughtLamports: 0 }; const acc = await db.get('SELECT value FROM stats WHERE key = ?', 'accumulatedFeesLamports'); const life = await db.get('SELECT value FROM stats WHERE key = ?', 'lifetimeFeesLamports'); const pump = await db.get('SELECT value FROM stats WHERE key = ?', 'totalPumpBoughtLamports'); return { accumulatedFeesLamports: acc ? acc.value : 0, lifetimeFeesLamports: life ? life.value : 0, totalPumpBoughtLamports: pump ? pump.value : 0 }; }
async function resetAccumulatedFees(used) { const cur = await db.get('SELECT value FROM stats WHERE key = ?', 'accumulatedFeesLamports'); await db.run('UPDATE stats SET value = ? WHERE key = ?', [Math.max(0, (cur ? cur.value : 0) - used), 'accumulatedFeesLamports']); }

// [FIX] Ensure logging stores structured data properly
async function logPurchase(type, data) { 
    try { 
        await db.run('INSERT INTO logs (type, data, timestamp) VALUES (?, ?, ?)', [type, JSON.stringify(data), new Date().toISOString()]); 
    } catch (e) { console.error("Log error", e); } 
}

async function saveTokenData(pk, mint, meta) {
    try {
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

function calculateTokensForSolWithReserves(solAmountLamports, virtualSolReserves, virtualTokenReserves) {
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
            
            // [CHANGED] Pass metadataUri to save function
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
app.get('/api/health', async (req, res) => { try { const stats = await getStats(); const launches = await getTotalLaunches(); const logs = await db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 50'); res.json({ status: "online", wallet: devKeypair.publicKey.toString(), lifetimeFees: (stats.lifetimeFeesLamports / LAMPORTS_PER_SOL).toFixed(4), totalPumpBought: (stats.totalPumpBoughtLamports / LAMPORTS_PER_SOL).toFixed(4), totalLaunches: launches, recentLogs: logs.map(l => ({ ...JSON.parse(l.data), type: l.type, timestamp: l.timestamp })), headerImageUrl: HEADER_IMAGE_URL }); } catch (e) { res.status(500).json({ error: "DB Error" }); } });
app.get('/api/check-holder', async (req, res) => { const { userPubkey } = req.query; if (!userPubkey) return res.json({ isHolder: false }); try { const result = await db.get('SELECT mint, rank FROM token_holders WHERE holderPubkey = ? LIMIT 1', userPubkey); res.json({ isHolder: !!result, ...(result || {}) }); } catch (e) { res.status(500).json({ error: "DB Error" }); } });
app.get('/api/leaderboard', async (req, res) => { const { userPubkey } = req.query; try { const rows = await db.all('SELECT * FROM tokens ORDER BY volume24h DESC LIMIT 10'); const leaderboard = await Promise.all(rows.map(async (r) => { let isUserTopHolder = false; if (userPubkey) { const holderEntry = await db.get('SELECT rank FROM token_holders WHERE mint = ? AND holderPubkey = ?', [r.mint, userPubkey]); if (holderEntry) isUserTopHolder = true; } 
    // [CHANGED] Include metadataUri in response
    return { mint: r.mint, name: r.name, ticker: r.ticker, image: r.image, metadataUri: r.metadataUri, price: (r.marketCap / 1000000000).toFixed(6), volume: r.volume24h, isUserTopHolder, complete: !!r.complete }; 
})); res.json(leaderboard); } catch (e) { res.status(500).json([]); } });
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
setInterval(async () => { 
    if (!db) return; 
    try {
        const topTokens = await db.all('SELECT mint FROM tokens ORDER BY volume24h DESC LIMIT 10'); 
        for (const token of topTokens) { 
            try { 
                if (!token.mint) continue;
                const accounts = await connection.getTokenLargestAccounts(new PublicKey(token.mint)); 
                if (accounts.value) { 
                    const top20 = accounts.value.slice(0, 20); 
                    let rank = 1; 
                    await db.run('DELETE FROM token_holders WHERE mint = ?', token.mint); 
                    for (const acc of top20) { 
                        try { 
                            const info = await connection.getParsedAccountInfo(acc.address); 
                            if (info.value?.data?.parsed) { 
                                const owner = info.value.data.parsed.info.owner; 
                                if (owner !== PUMP_LIQUIDITY_WALLET) { await db.run(`INSERT OR REPLACE INTO token_holders (mint, holderPubkey, rank, lastUpdated) VALUES (?, ?, ?, ?)`, [token.mint, owner, rank, Date.now()]); rank++; } 
                            } 
                        } catch (e) {} 
                    } 
                } 
            } catch (e) { console.error("Error processing token", token.mint, e.message); } 
            await new Promise(r => setTimeout(r, 2000)); 
        } 
    } catch(e) { console.error("Loop Error", e); }
}, 60 * 60 * 1000); 

setInterval(async () => { if (!db) return; const tokens = await db.all('SELECT mint FROM tokens'); for (let i = 0; i < tokens.length; i += 5) { const batch = tokens.slice(i, i + 5); await Promise.all(batch.map(async (t) => { try { const response = await axios.get(`https://frontend-api.pump.fun/coins/${t.mint}`, { timeout: 2000 }); const data = response.data; 
    if (data) {
        const isComplete = data.complete ? 1 : 0;
        await db.run(`UPDATE tokens SET volume24h = ?, marketCap = ?, lastUpdated = ?, complete = ? WHERE mint = ?`, [data.usd_market_cap || 0, data.usd_market_cap || 0, Date.now(), isComplete, t.mint]); 
    }
} catch (e) {} })); await new Promise(r => setTimeout(r, 1000)); } }, 2 * 60 * 1000);

let isBuybackRunning = false;
async function runPurchaseAndFees() {
    if (isBuybackRunning) return;
    isBuybackRunning = true;
    try {
        const stats = await getStats();
        if (stats.accumulatedFeesLamports >= FEE_THRESHOLD_SOL * LAMPORTS_PER_SOL) {
             const realBalance = await connection.getBalance(devKeypair.publicKey);
             const spendable = Math.min(stats.accumulatedFeesLamports, realBalance - 5000000);
             if (spendable > 0) {
                 const transfer9_5 = Math.floor(spendable * 0.095); 
                 const transfer0_5 = Math.floor(spendable * 0.005); 
                 const solBuyAmountLamports = Math.floor(spendable * 0.90);

                 if (TARGET_PUMP_TOKEN.toString() === "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn") {
                     await buyViaPumpAmm(solBuyAmountLamports, transfer9_5, transfer0_5, spendable);
                     return;
                 }

                 const { global, bondingCurve, associatedBondingCurve, eventAuthority, feeConfig, globalVolumeAccumulator } = getPumpPDAs(TARGET_PUMP_TOKEN);
                 
                 let creator, isMayhem = false;
                 let virtualSol = new BN(30000000000); 
                 let virtualToken = new BN(1073000000000000); 

                 try {
                    const accInfo = await connection.getAccountInfo(bondingCurve);
                    if (!accInfo) throw new Error("Bonding curve not found");
                    const data = accInfo.data;
                    virtualToken = new BN(data.subarray(8, 16), 'le');
                    virtualSol = new BN(data.subarray(16, 24), 'le');
                    creator = new PublicKey(data.subarray(49, 81));
                    isMayhem = data[81] === 1;
                 } catch (bcError) {
                    logger.warn("Bonding curve fetch failed. Using default calc.", { error: bcError.message });
                    return; 
                 }

                 const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID);
                 const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), devKeypair.publicKey.toBuffer()], PUMP_PROGRAM_ID);
                 const associatedUser = getATA(TARGET_PUMP_TOKEN, devKeypair.publicKey, TOKEN_PROGRAM_2022_ID);
                 
                 const feeRecipient = isMayhem ? MAYHEM_FEE_RECIPIENT : FEE_RECIPIENT_STANDARD;

                 const tokenBuyAmount = calculateTokensForSolWithReserves(solBuyAmountLamports, virtualSol, virtualToken);
                 
                 const buyDiscriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
                 const amountBuf = tokenBuyAmount.toArrayLike(Buffer, 'le', 8);
                 const maxSolCostBuf = new BN(Math.floor(solBuyAmountLamports * 1.05)).toArrayLike(Buffer, 'le', 8); 
                 const trackVolumeBuf = Buffer.from([0]); 

                 const buyData = Buffer.concat([buyDiscriminator, amountBuf, maxSolCostBuf, trackVolumeBuf]);

                 const buyKeys = [
                    { pubkey: global, isSigner: false, isWritable: false },
                    { pubkey: feeRecipient, isSigner: false, isWritable: true },
                    { pubkey: TARGET_PUMP_TOKEN, isSigner: false, isWritable: false },
                    { pubkey: bondingCurve, isSigner: false, isWritable: true },
                    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                    { pubkey: associatedUser, isSigner: false, isWritable: true },
                    { pubkey: devKeypair.publicKey, isSigner: true, isWritable: true },
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
                 
                 const tx = new Transaction();
                 addPriorityFee(tx); 
                 tx.add(buyIx)
                    .add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_9_5, lamports: transfer9_5 }))
                    .add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_0_5, lamports: transfer0_5 }));
                 
                 tx.feePayer = devKeypair.publicKey;
                 const sig = await sendTxWithRetry(tx, [devKeypair]);
                 await addPumpBought(tokenBuyAmount.toNumber()); 
                 logPurchase('SUCCESS', { totalSpent: spendable, buyAmount: tokenBuyAmount.toString(), signature: sig });
                 await resetAccumulatedFees(spendable);
             } else { logPurchase('SKIPPED', { reason: 'Insufficient Real Balance', balance: realBalance }); }
        } else { logPurchase('SKIPPED', { reason: 'Fees Under Limit', current: (stats.accumulatedFeesLamports/LAMPORTS_PER_SOL).toFixed(4), target: FEE_THRESHOLD_SOL }); }
    } catch(e) { logPurchase('ERROR', { message: e.message }); } finally { isBuybackRunning = false; }
}

async function buyViaPumpAmm(amountIn, transfer9_5, transfer0_5, totalSpendable) {
    logger.info("Starting Pump AMM Swap for $PUMP...");
    try {
        const swapDiscriminator = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]); 
        const amountInBuf = new BN(amountIn).toArrayLike(Buffer, 'le', 8);
        const minAmountOutBuf = new BN(1).toArrayLike(Buffer, 'le', 8);
        const swapData = Buffer.concat([swapDiscriminator, amountInBuf, minAmountOutBuf]);

        logger.info("AMM Swap not fully constructed (Missing Keys). Distributing fees directly.");
        
        const distTx = new Transaction();
        addPriorityFee(distTx);
        distTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_9_5, lamports: transfer9_5 + amountIn })); 
        distTx.add(SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_0_5, lamports: transfer0_5 }));
        
        const sig = await sendTxWithRetry(distTx, [devKeypair]);
        await addPumpBought(0); 
        logPurchase('SUCCESS (MANUAL DIST)', { totalSpent: totalSpendable, signature: sig });
        await resetAccumulatedFees(totalSpendable);

    } catch (e) {
        logger.error("Pump AMM Swap Failed", { error: e.message });
    }
}

setInterval(runPurchaseAndFees, 5 * 60 * 1000);

app.listen(PORT, () => logger.info(`Server v${VERSION} running on ${PORT}`));
