/**
 * Solana Program IDs and Addresses
 * All blockchain-related constants
 */
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// Helper to safely create PublicKey
const safePublicKey = (value, fallback, name) => {
    try {
        return new PublicKey(value);
    } catch (e) {
        console.warn(`Invalid ${name}, using fallback`);
        return new PublicKey(fallback);
    }
};

// Token Mints
const TOKENS = {
    PUMP: safePublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", "11111111111111111111111111111111", "TARGET_PUMP_TOKEN"),
    ASDF: safePublicKey("9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump", "11111111111111111111111111111111", "ASDF_TOKEN_MINT"),
    WSOL: safePublicKey("So11111111111111111111111111111111111111112", "So11111111111111111111111111111111111111112", "WSOL_MINT"),
    USDC: safePublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC_MINT"),
};

// Wallets
const WALLETS = {
    FEE_95: safePublicKey("9Cx7bw3opoGJ2z9uYbMLcfb1ukJbJN4CP5uBbDvWwu7Z", "11111111111111111111111111111111", "WALLET_9_5"),
    FEE_05: safePublicKey("9zT9rFzDA84K6hJJibcy9QjaFmM8Jm2LzdrvXEiBSq9g", "11111111111111111111111111111111", "WALLET_0_5"),
    PUMP_LIQUIDITY: "CJXSGQnTeRRGbZE1V4rQjYDeKLExPnxceczmAbgBdTsa",
    // Mayhem
    GLOBAL_PARAMS: safePublicKey("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ", "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ", "GLOBAL_PARAMS"),
    SOL_VAULT: safePublicKey("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", "SOL_VAULT"),
    MAYHEM_FEE: safePublicKey("GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS", "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS", "MAYHEM_FEE_RECIPIENT"),
    // Fee
    FEE_STANDARD: safePublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM", "11111111111111111111111111111111", "FEE_RECIPIENT_STANDARD"),
};

// Program IDs
const PROGRAMS = {
    // Pump.fun
    PUMP: safePublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "11111111111111111111111111111111", "PUMP_PROGRAM_ID"),
    PUMP_AMM: safePublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "PUMP_AMM_PROGRAM_ID"),

    // Token Programs
    TOKEN: TOKEN_PROGRAM_ID,
    TOKEN_2022: safePublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TOKEN_PROGRAM_2022_ID"),
    ASSOCIATED_TOKEN: ASSOCIATED_TOKEN_PROGRAM_ID,

    // Fee Program
    FEE: safePublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", "11111111111111111111111111111111", "FEE_PROGRAM_ID"),

    // Metaplex
    METADATA: safePublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "MPL_TOKEN_METADATA_PROGRAM_ID"),

    // Mayhem
    MAYHEM: safePublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e", "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e", "MAYHEM_PROGRAM_ID"),
};

// Mayhem Accounts
const MAYHEM = {
    GLOBAL_PARAMS: safePublicKey("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ", "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ", "GLOBAL_PARAMS"),
    SOL_VAULT: safePublicKey("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", "SOL_VAULT"),
    FEE_RECIPIENT: safePublicKey("GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS", "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS", "MAYHEM_FEE_RECIPIENT"),
};

// Fee Accounts
const FEES = {
    RECIPIENT_STANDARD: safePublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM", "11111111111111111111111111111111", "FEE_RECIPIENT_STANDARD"),
};

module.exports = {
    TOKENS,
    WALLETS,
    PROGRAMS,
    MAYHEM,
    FEES,
    safePublicKey,
};
