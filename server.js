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

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const PINATA_JWT = process.env.PINATA_JWT;

const TARGET_PUMP_TOKEN = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const WALLET_19_5 = new PublicKey("9Cx7bw3opoGJ2z9uYbMLcfb1ukJbJN4CP5uBbDvWwu7Z");
const WALLET_0_5 = new PublicKey("9zT9rFzDA84K6hJJibcy9QjaFmM8Jm2LzdrvXEiBSq9g");
const FEE_THRESHOLD_SOL = 0.20;

const DISK_ROOT = '/var/data'; 
const DATA_DIR = path.join(DISK_ROOT, 'tokens'); 
const STATS_FILE = path.join(DISK_ROOT, 'stats.json');
const PURCHASE_LOG = path.join(DISK_ROOT, 'purchase_logs.json');

// Ensure Directory Structure
if (!fs.existsSync(DISK_ROOT)) {
    console.warn(`⚠️ Warning: Disk root ${DISK_ROOT} does not exist. Fallback to local.`);
    if (!fs.existsSync('./data')) fs.mkdirSync('./data');
} else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const ACTIVE_DATA_DIR = fs.existsSync(DISK_ROOT) ? DATA_DIR : './data/tokens';
const ACTIVE_STATS_FILE = fs.existsSync(DISK_ROOT) ? STATS_FILE : './data/stats.json';
const ACTIVE_LOG_FILE = fs.existsSync(DISK_ROOT) ? PURCHASE_LOG : './data/purchase_logs.json';

if (!fs.existsSync(path.dirname(ACTIVE_DATA_DIR))) fs.mkdirSync(path.dirname(ACTIVE_DATA_DIR), { recursive: true });

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

function saveTokenData(userPubkey, mint, metadata) {
    try {
        const shard = userPubkey.slice(0, 2).toLowerCase();
        const shardDir = path.join(ACTIVE_DATA_DIR, shard);
        if (!fs.existsSync(shardDir)) fs.mkdirSync(shardDir, { recursive: true });
        const filePath = path.join(shardDir, `${mint}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ userPubkey, mint, metadata, timestamp: new Date().toISOString() }, null, 2));
    } catch (e) { console.error("Save Data Error:", e); }
}

function getStats() {
    try {
        if (!fs.existsSync(ACTIVE_STATS_FILE)) return { accumulatedFeesLamports: 0, lifetimeFeesLamports: 0 };
        return JSON.parse(fs.readFileSync(ACTIVE_STATS_FILE, 'utf8'));
    } catch (e) { return { accumulatedFeesLamports: 0, lifetimeFeesLamports: 0 }; }
}

function addFees(amountLamports) {
    try {
        const stats = getStats();
        stats.accumulatedFeesLamports += amountLamports;
        stats.lifetimeFeesLamports += amountLamports;
        const tempFile = `${ACTIVE_STATS_FILE}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(stats, null, 2));
        fs.renameSync(tempFile, ACTIVE_STATS_FILE);
    } catch (e) { console.error("Fee update error:", e); }
}

function resetAccumulatedFees(amountUsed) {
    try {
        const stats = getStats();
        stats.accumulatedFeesLamports = Math.max(0, stats.accumulatedFeesLamports - amountUsed);
        const tempFile = `${ACTIVE_STATS_FILE}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(stats, null, 2));
        fs.renameSync(tempFile, ACTIVE_STATS_FILE);
    } catch (e) { console.error("Fee reset error:", e); }
}

function logPurchase(type, data) {
    try {
        let logs = [];
        if (fs.existsSync(ACTIVE_LOG_FILE)) logs = JSON.parse(fs.readFileSync(ACTIVE_LOG_FILE));
        
        const entry = {
            timestamp: new Date().toISOString(),
            type: type, // 'SUCCESS' or 'SKIPPED'
            ...data
        };
        
        // Keep only last 50 logs to prevent file explosion
        if (logs.length > 50) logs.shift(); 
        logs.push(entry);
        
        fs.writeFileSync(ACTIVE_LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) { console.error("Logging error:", e); }
}

// --- Buyback Loop ---

async function runPurchaseAndFees() {
    console.log("🔄 Running PurchaseAndFees Routine...");
    const stats = getStats();
    const balanceLamports = stats.accumulatedFeesLamports;
    const thresholdLamports = FEE_THRESHOLD_SOL * LAMPORTS_PER_SOL;

    if (balanceLamports >= thresholdLamports) {
        try {
            const realBalance = await connection.getBalance(devKeypair.publicKey);
            const spendable = Math.min(balanceLamports, realBalance - 5000000); 
            
            if (spendable <= 0) {
                logPurchase('SKIPPED', { reason: 'Insufficient Real Balance', balance: realBalance });
                return;
            }

            const buyAmount = new BN(Math.floor(spendable * 0.80));
            const transfer19_5 = Math.floor(spendable * 0.195);
            const transfer0_5 = Math.floor(spendable * 0.005);

            const { bondingCurve, associatedBondingCurve } = getPumpPDAs(TARGET_PUMP_TOKEN, PUMP_PROGRAM_ID);
            const associatedUser = getATA(TARGET_PUMP_TOKEN, devKeypair.publicKey);
            
            const buyIx = await program.methods.buyExactSolIn(buyAmount, new BN(1), false)
            .accounts({
                global: PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID)[0],
                feeRecipient: FEE_RECIPIENT, mint: TARGET_PUMP_TOKEN, bondingCurve, associatedBondingCurve,
                associatedUser, user: devKeypair.publicKey, systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_2022_ID, 
                creatorVault: PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), bondingCurve.toBuffer()], PUMP_PROGRAM_ID)[0],
                eventAuthority: PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID)[0],
                program: PUMP_PROGRAM_ID, 
                globalVolumeAccumulator: PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM_ID)[0],
                userVolumeAccumulator: PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), devKeypair.publicKey.toBuffer()], PUMP_PROGRAM_ID)[0],
                feeConfig: PublicKey.findProgramAddressSync([Buffer.from("fee_config")], FEE_PROGRAM_ID)[0],
                feeProgram: FEE_PROGRAM_ID
            }).instruction();

            const tx1 = SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_19_5, lamports: transfer19_5 });
            const tx2 = SystemProgram.transfer({ fromPubkey: devKeypair.publicKey, toPubkey: WALLET_0_5, lamports: transfer0_5 });

            const tx = new Transaction().add(buyIx).add(tx1).add(tx2);
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
            tx.feePayer = devKeypair.publicKey;

            const sig = await sendAndConfirmTransaction(connection, tx, [devKeypair]);
            console.log(`✅ Buyback Success: ${sig}`);

            logPurchase('SUCCESS', {
                totalSpent: spendable,
                buyAmount: buyAmount.toString(),
                signature: sig
            });

            resetAccumulatedFees(spendable);

        } catch (err) {
            console.error("❌ Buyback Routine Failed:", err);
            logPurchase('ERROR', { message: err.message });
        }
    } else {
        const currentSol = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);
        console.log(`⏳ Threshold not met (${currentSol} / ${FEE_THRESHOLD_SOL} SOL).`);
        // Log Skipped round for Frontend Display
        logPurchase('SKIPPED', { 
            reason: 'Fees Under Limit', 
            current: currentSol, 
            target: FEE_THRESHOLD_SOL 
        });
    }
}

setInterval(runPurchaseAndFees, 5 * 60 * 1000);

// --- Helpers (PDAs, Uploads) ---
function getPumpPDAs(mint, programId = PUMP_PROGRAM_ID) {
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], programId);
    const associatedBondingCurve = PublicKey.findProgramAddressSync([bondingCurve.toBuffer(), TOKEN_PROGRAM_2022_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
    return { bondingCurve, associatedBondingCurve };
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

// --- Routes ---
app.get('/api/health', (req, res) => {
    const stats = getStats();
    let logs = [];
    if (fs.existsSync(ACTIVE_LOG_FILE)) logs = JSON.parse(fs.readFileSync(ACTIVE_LOG_FILE));
    res.json({ 
        status: "online", 
        wallet: devKeypair.publicKey.toString(),
        lifetimeFees: (stats.lifetimeFeesLamports / LAMPORTS_PER_SOL).toFixed(4),
        recentLogs: logs.reverse().slice(0, 5) // Send last 5 logs
    });
});

app.post('/api/deploy', async (req, res) => {
    try {
        const { name, ticker, description, twitter, website, userTx, userPubkey, image } = req.body;
        if (!name || name.length > 32) return res.status(400).json({ error: "Invalid Name" });
        if (!ticker || ticker.length > 10) return res.status(400).json({ error: "Invalid Ticker" });
        if (!image) return res.status(400).json({ error: "Image required" });

        const txInfo = await connection.getParsedTransaction(userTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!txInfo) return res.status(400).json({ error: "Transaction not found." });
        const validPayment = txInfo.transaction.message.instructions.some(ix => {
            if (ix.programId.toString() !== SystemProgram.programId.toString()) return false;
            if (ix.parsed.type !== 'transfer') return false;
            return ix.parsed.info.destination === devKeypair.publicKey.toString() && ix.parsed.info.lamports >= 0.05 * LAMPORTS_PER_SOL;
        });
        if (!validPayment) return res.status(400).json({ error: "Payment verification failed." });

        addFees(0.05 * LAMPORTS_PER_SOL);
        const metadataUri = await uploadMetadataToPinata(name, ticker, description, twitter, website, image);
        const mintKeypair = Keypair.generate();
        const mint = mintKeypair.publicKey;
        const creator = devKeypair.publicKey;
        
        saveTokenData(userPubkey, mint.toString(), { name, ticker, description, twitter, website });

        const { mintAuthority, bondingCurve, global, eventAuthority, globalVolume, userVolume, feeConfig, creatorVault } = getDeploymentPDAs(mint, creator);
        const { globalParams, solVault, mayhemState } = getMayhemPDAs(mint);
        const associatedBondingCurve = getATA(mint, bondingCurve);
        const mayhemTokenVault = getATA(mint, solVault);
        const associatedUser = getATA(mint, creator);

        const createIx = await program.methods.createV2(name, ticker, metadataUri, creator, false)
            .accounts({ mint, mintAuthority, bondingCurve, associatedBondingCurve, global, user: creator, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, mayhemProgramId: MAYHEM_PROGRAM_ID, globalParams, solVault, mayhemState, mayhemTokenVault, eventAuthority, program: PUMP_PROGRAM_ID }).instruction();

        const buyIx = await program.methods.buyExactSolIn(new BN(0.01 * LAMPORTS_PER_SOL), new BN(1), false)
            .accounts({ global, feeRecipient: FEE_RECIPIENT, mint, bondingCurve, associatedBondingCurve, associatedUser, user: creator, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID, creatorVault, eventAuthority, program: PUMP_PROGRAM_ID, globalVolumeAccumulator: globalVolume, userVolumeAccumulator: userVolume, feeConfig, feeProgram: FEE_PROGRAM_ID }).instruction();

        const tx = new Transaction().add(createIx).add(buyIx);
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = creator;
        const sig = await sendAndConfirmTransaction(connection, tx, [devKeypair, mintKeypair]);
        
        setTimeout(async () => {
            try {
                const bal = await connection.getTokenAccountBalance(associatedUser);
                if (bal.value.uiAmount > 0) {
                    const sellIx = await program.methods.sell(new BN(bal.value.amount), new BN(0)).accounts({ global, feeRecipient: FEE_RECIPIENT, mint, bondingCurve, associatedBondingCurve, associatedUser, user: creator, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, creatorVault, eventAuthority, program: PUMP_PROGRAM_ID, globalVolumeAccumulator: globalVolume, userVolumeAccumulator: userVolume, feeConfig, feeProgram: FEE_PROGRAM_ID }).instruction();
                    const sellTx = new Transaction().add(sellIx);
                    await sendAndConfirmTransaction(connection, sellTx, [devKeypair]);
                }
            } catch (e) { console.error("Sell error:", e.message); }
        }, 1500); 

        res.json({ success: true, mint: mint.toString(), signature: sig });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Launcher running on ${PORT}`));
