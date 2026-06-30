/**
 * Vanity Grinder Service — DISABLED
 * Grinder has been decommissioned; all mint keypairs are now random.
 */
const { Keypair } = require('@solana/web3.js');

async function getMintKeypair() {
    return Keypair.generate();
}

module.exports = { getMintKeypair };
