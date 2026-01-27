/**
 * Pump.fun Service
 * Pump.fun program interactions and helpers
 */
const { PublicKey, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { PROGRAMS, TOKENS, WALLETS } = require('../config/constants');
const logger = require('./logger');

/**
 * Get Associated Token Address
 */
function getATA(mint, owner, tokenProgramId = PROGRAMS.TOKEN_2022) {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
}

/**
 * Get Pump.fun PDAs for a token
 */
function getPumpPDAs(mint) {
    const [global] = PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        PROGRAMS.PUMP
    );

    const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mint.toBuffer()],
        PROGRAMS.PUMP
    );

    const associatedBondingCurve = getATA(mint, bondingCurve);

    const [eventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        PROGRAMS.PUMP
    );

    const feeConfig = new PublicKey("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");

    const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        PROGRAMS.PUMP
    );

    return {
        global,
        bondingCurve,
        associatedBondingCurve,
        eventAuthority,
        feeConfig,
        globalVolumeAccumulator
    };
}

/**
 * Get Pump AMM PDAs for a token
 */
function getPumpAmmPDAs(mint) {
    const [poolAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool-authority"), mint.toBuffer()],
        PROGRAMS.PUMP_AMM
    );

    const [pool] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), poolAuthority.toBuffer(), mint.toBuffer(), TOKENS.WSOL.toBuffer()],
        PROGRAMS.PUMP_AMM
    );

    const [lpMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_lp_mint"), pool.toBuffer()],
        PROGRAMS.PUMP_AMM
    );

    const poolBaseTokenAccount = getATA(mint, pool, PROGRAMS.TOKEN_2022);
    const poolQuoteTokenAccount = getATA(TOKENS.WSOL, pool, TOKEN_PROGRAM_ID);

    return {
        pool,
        poolAuthority,
        lpMint,
        poolBaseTokenAccount,
        poolQuoteTokenAccount
    };
}

/**
 * Get creator fee vault addresses
 */
function getCreatorFeeVaults(creator) {
    const [bcVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), creator.toBuffer()],
        PROGRAMS.PUMP
    );

    const [ammVaultAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator_vault"), creator.toBuffer()],
        PROGRAMS.PUMP_AMM
    );

    const ammVaultAta = getAssociatedTokenAddress(TOKENS.WSOL, ammVaultAuth, true);

    return { bcVault, ammVaultAuth, ammVaultAta };
}

/**
 * Calculate tokens received for SOL amount using bonding curve
 */
function calculateTokensForSol(solAmountLamports) {
    const virtualSolReserves = new BN(30000000000);
    const virtualTokenReserves = new BN(1073000000000000);
    const solIn = new BN(solAmountLamports);
    const k = virtualSolReserves.mul(virtualTokenReserves);
    const newVirtualSol = virtualSolReserves.add(solIn);
    const newVirtualTokens = k.div(newVirtualSol);
    return virtualTokenReserves.sub(newVirtualTokens);
}

/**
 * Serialize string for Pump instructions
 */
function serializeString(str) {
    const b = Buffer.from(str, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
}

/**
 * Build create token instruction data
 */
function buildCreateInstructionData(name, ticker, metadataUri, creator, isMayhemMode) {
    const discriminator = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);

    return Buffer.concat([
        discriminator,
        serializeString(name),
        serializeString(ticker),
        serializeString(metadataUri),
        creator.toBuffer(),
        Buffer.from([isMayhemMode ? 1 : 0])
    ]);
}

/**
 * Build buy instruction data
 */
function buildBuyInstructionData(tokenAmount, maxSolCost) {
    const discriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    const amountBuf = tokenAmount.toArrayLike(Buffer, 'le', 8);
    const maxSolCostBuf = maxSolCost.toArrayLike(Buffer, 'le', 8);
    const trackVolumeBuf = Buffer.from([0]);

    return Buffer.concat([discriminator, amountBuf, maxSolCostBuf, trackVolumeBuf]);
}

/**
 * Build sell instruction data
 */
function buildSellInstructionData(tokenAmount) {
    const discriminator = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
    const sellAmountBuf = tokenAmount.toArrayLike(Buffer, 'le', 8);
    const minSolOutputBuf = new BN(0).toArrayLike(Buffer, 'le', 8);

    return Buffer.concat([discriminator, sellAmountBuf, minSolOutputBuf]);
}

/**
 * Build claim creator fees instruction data
 */
function buildClaimFeesData() {
    return Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
}

/**
 * Get fee sharing config PDA for a creator
 * This is used when a creator enables fee sharing with other wallets
 */
function getFeeSharingConfigPDA(creator) {
    const [sharingConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_sharing_config"), creator.toBuffer()],
        PROGRAMS.PUMP
    );
    return sharingConfig;
}

/**
 * Get distribute creator fees instruction data (BC - bonding curve)
 * Used to distribute fees from a sharing config to all shareholders
 */
function buildDistributeFeesData() {
    // distribute_creator_fees discriminator for PUMP program (BC)
    return Buffer.from([202, 87, 148, 171, 74, 66, 138, 57]);
}

/**
 * Get distribute creator fees instruction data for AMM (PumpSwap)
 * v25.91: Used to distribute AMM fees from creator vault to all shareholders
 * Similar to BC distribute but for graduated tokens on PumpSwap
 */
function buildDistributeAmmFeesData() {
    // distribute_creator_fees discriminator for PUMP_AMM program
    // This is the same instruction pattern as BC but for PumpSwap
    return Buffer.from([202, 87, 148, 171, 74, 66, 138, 57]);
}

/**
 * Get AMM fee sharing config PDA
 * v25.91: PumpSwap may have its own sharing config for AMM fees
 */
function getAmmFeeSharingConfigPDA(creator) {
    const [sharingConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_sharing_config"), creator.toBuffer()],
        PROGRAMS.PUMP_AMM
    );
    return sharingConfig;
}

/**
 * Get creator vaults for a fee sharing shareholder
 *
 * IMPORTANT: Fees accumulate in the ORIGINAL CREATOR's vault, not a fee_sharing_config vault.
 * The fee_sharing_config PDA only stores the shareholder configuration.
 * When distribute_creator_fees is called, it reads the config and distributes from the creator vault.
 *
 * v25.16 FIX: Derive vaults from the original creator, not the sharing config PDA
 *
 * @param {PublicKey} originalCreator - The original token creator
 * @returns {Object} Vault addresses for the original creator
 */
function getShareholderFeeVaults(originalCreator) {
    // Get the sharing config PDA (needed for claim instructions)
    const sharingConfigPDA = getFeeSharingConfigPDA(originalCreator);

    // v25.16 FIX: Fees accumulate in the ORIGINAL CREATOR's vault
    // NOT in a vault derived from the sharing config PDA
    const [bcVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), originalCreator.toBuffer()],
        PROGRAMS.PUMP
    );

    const [ammVaultAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator_vault"), originalCreator.toBuffer()],
        PROGRAMS.PUMP_AMM
    );

    const ammVaultAta = getAssociatedTokenAddress(TOKENS.WSOL, ammVaultAuth, true);

    return { bcVault, ammVaultAuth, ammVaultAta, sharingConfigPDA };
}

module.exports = {
    getATA,
    getPumpPDAs,
    getPumpAmmPDAs,
    getCreatorFeeVaults,
    getFeeSharingConfigPDA,
    getAmmFeeSharingConfigPDA,
    getShareholderFeeVaults,
    calculateTokensForSol,
    serializeString,
    buildCreateInstructionData,
    buildBuyInstructionData,
    buildSellInstructionData,
    buildClaimFeesData,
    buildDistributeFeesData,
    buildDistributeAmmFeesData,
};
