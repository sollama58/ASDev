require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet, BN } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const fs = require('fs');
const axios = require('axios');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const PINATA_JWT = process.env.PINATA_JWT;

if (!DEV_WALLET_PRIVATE_KEY || !HELIUS_API_KEY || !PINATA_JWT) {
    console.error("ERROR: Missing Environment Variables.");
    process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const CONNECTION_CONFIG = { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 };

// Program IDs
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_PROGRAM_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

// Hardcoded Fee Recipient (as per user request)
const FEE_RECIPIENT = new PublicKey("FNLWHjvjptwC7LxycdK3Knqcv5ptC19C9rynn6u2S1tB");

// --- Setup ---
const app = express();
app.use(cors());
app.use(express.json());

const connection = new Connection(RPC_URL, CONNECTION_CONFIG);
const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_PRIVATE_KEY));
const wallet = new Wallet(devKeypair);
const provider = new AnchorProvider(connection, wallet, CONNECTION_CONFIG);

const idl = JSON.parse(fs.readFileSync('./pump_idl.json', 'utf8'));
const program = new Program(idl, provider);

// --- Helper Functions ---

async function uploadMetadataToPinata(name, symbol, description, twitter, website) {
    const metadata = {
        name: name,
        symbol: symbol,
        description: description,
        image: "https://gateway.pinata.cloud/ipfs/QmPc5gX8W8h9j5h8x8h8h8h8h8h8h8h8h8h8h8h8h8",
        extensions: { twitter: twitter || "", website: website || "" }
    };

    try {
        const response = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', metadata, {
            headers: { 'Authorization': `Bearer ${PINATA_JWT}` }
        });
        return `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`;
    } catch (error) {
        console.error("Pinata Upload Error:", error);
        throw new Error("Failed to upload metadata");
    }
}

function getPumpPDAs(mint, creator) {
    const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
    const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID);
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
    
    const [globalVolume] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM_ID);
    const [userVolume] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), creator.toBuffer()], PUMP_PROGRAM_ID);
    const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config")], FEE_PROGRAM_ID);
    
    // FIX: Creator Vault seed must use the CREATOR wallet, not the bonding curve
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
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), TOKEN_PROGRAM_2022_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
}

// --- API Endpoint ---

app.post('/api/deploy', async (req, res) => {
    try {
        const { name, ticker, description, twitter, website, userTx } = req.body;
        
        // 1. Verify Payment
        const txInfo = await connection.getParsedTransaction(userTx, { commitment: "confirmed" });
        if (!txInfo) return res.status(400).json({ error: "Transaction not found." });
        
        // 2. Upload Metadata
        const metadataUri = await uploadMetadataToPinata(name, ticker, description, twitter, website);

        // 3. Prepare Transactions
        const mintKeypair = Keypair.generate();
        const mint = mintKeypair.publicKey;
        const creator = devKeypair.publicKey;
        
        const { mintAuthority, bondingCurve, global, eventAuthority, globalVolume, userVolume, feeConfig, creatorVault } = getPumpPDAs(mint, creator);
        const { globalParams, solVault, mayhemState } = getMayhemPDAs(mint);
        
        const associatedBondingCurve = getATA(mint, bondingCurve);
        const mayhemTokenVault = getATA(mint, solVault);
        const associatedUser = getATA(mint, creator);

        console.log("Mint:", mint.toString());
        console.log("Bonding Curve:", bondingCurve.toString());
        console.log("Creator Vault:", creatorVault.toString());

        // Instruction 1: Create V2
        const createIx = await program.methods.createV2(name, ticker, metadataUri, creator, false)
            .accounts({
                mint, mintAuthority, bondingCurve, associatedBondingCurve,
                global, user: creator,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_2022_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                mayhemProgramId: MAYHEM_PROGRAM_ID,
                globalParams, solVault, mayhemState, mayhemTokenVault,
                eventAuthority, program: PUMP_PROGRAM_ID
            })
            .instruction();

        // Instruction 2: Buy 0.01 SOL
        // Note: trackVolume passed as 'false' (boolean) to match modified IDL
        const buyIx = await program.methods.buyExactSolIn(new BN(0.01 * LAMPORTS_PER_SOL), new BN(1), false)
            .accounts({
                global, 
                feeRecipient: FEE_RECIPIENT, 
                mint, bondingCurve, associatedBondingCurve,
                associatedUser, user: creator,
                systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID,
                creatorVault, eventAuthority, program: PUMP_PROGRAM_ID,
                globalVolumeAccumulator: globalVolume, userVolumeAccumulator: userVolume,
                feeConfig, feeProgram: FEE_PROGRAM_ID
            })
            .instruction();

        const tx = new Transaction().add(createIx).add(buyIx);
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = creator;
        
        const sig = await sendAndConfirmTransaction(connection, tx, [devKeypair, mintKeypair]);
        console.log(`Deployed: https://solscan.io/tx/${sig}`);

        // 4. Schedule Sell
        setTimeout(async () => {
            try {
                const bal = await connection.getTokenAccountBalance(associatedUser);
                if (bal.value.uiAmount > 0) {
                    console.log(`Selling ${bal.value.amount} tokens...`);
                    const sellIx = await program.methods.sell(new BN(bal.value.amount), new BN(0))
                        .accounts({
                            global, feeRecipient: FEE_RECIPIENT, mint, bondingCurve, associatedBondingCurve,
                            associatedUser, user: creator,
                            systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            creatorVault, eventAuthority, program: PUMP_PROGRAM_ID,
                            globalVolumeAccumulator: globalVolume, userVolumeAccumulator: userVolume,
                            feeConfig, feeProgram: FEE_PROGRAM_ID
                        })
                        .instruction();
                    
                    const sellTx = new Transaction().add(sellIx);
                    await sendAndConfirmTransaction(connection, sellTx, [devKeypair]);
                    console.log(`Sold positions for ${ticker}`);
                }
            } catch (e) {
                console.error("Sell failed:", e.message);
            }
        }, 2000); 

        res.json({ success: true, mint: mint.toString(), signature: sig });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Launcher running on port ${PORT}`));
