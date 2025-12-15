/**
 * Vanity Grinder Service
 * Integration with ASDF vanity address generator
 */
const axios = require('axios');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');
const config = require('../config/env');
const logger = require('./logger');

let isRefilling = false;

/**
 * Fetch a vanity keypair from the grinder pool
 * Supports both Rust (base58) and Node.js (byte array) formats
 */
async function fetchVanityKeypair() {
    if (!config.VANITY_GRINDER_ENABLED || !config.VANITY_GRINDER_URL) {
        return null;
    }

    try {
        const headers = {};
        if (config.VANITY_GRINDER_API_KEY) {
            headers['X-API-Key'] = config.VANITY_GRINDER_API_KEY;
        }

        const response = await axios.get(`${config.VANITY_GRINDER_URL}/mint`, {
            headers,
            timeout: 10000
        });

        let keypair = null;
        let address = null;

        // Format 1: Rust grinder format { success: true, mint: { mint_address, mint_keypair (base58) } }
        if (response.data?.success && response.data?.mint) {
            const { mint_address, mint_keypair } = response.data.mint;
            if (mint_address && mint_keypair) {
                const secretBytes = bs58.decode(mint_keypair);
                keypair = Keypair.fromSecretKey(secretBytes);
                address = keypair.publicKey.toBase58();
                logger.info(`Fetched vanity keypair (Rust): ${address} (${response.data.remaining} remaining)`);
            }
        }
        // Format 2: Node grinder format { public_key, secret: [byte array] }
        else if (response.data?.public_key && response.data?.secret) {
            const secretBytes = Uint8Array.from(response.data.secret);
            keypair = Keypair.fromSecretKey(secretBytes);
            address = keypair.publicKey.toBase58();
            logger.info(`Fetched vanity keypair (Node): ${address}`);
        }

        if (keypair && address) {
            // Verify address ends with ASDF
            if (!address.toUpperCase().endsWith('ASDF')) {
                logger.warn(`Vanity keypair doesn't end with ASDF: ${address}`);
                return null;
            }
            return keypair;
        }

        logger.warn("Invalid response from vanity grinder", { data: response.data });
        return null;
    } catch (e) {
        if (!e.message.includes('ECONNREFUSED')) {
            logger.error("Failed to fetch vanity keypair", { error: e.message });
        }
        return null;
    }
}

/**
 * Get a mint keypair - tries vanity grinder first, falls back to random
 */
async function getMintKeypair() {
    const vanityKeypair = await fetchVanityKeypair();
    if (vanityKeypair) {
        return vanityKeypair;
    }
    logger.info("Using random keypair (fallback)");
    return Keypair.generate();
}

/**
 * Check pool status and trigger refill if needed
 */
async function checkAndRefillPool() {
    if (!config.VANITY_GRINDER_ENABLED || !config.VANITY_GRINDER_URL || isRefilling) {
        return;
    }

    try {
        const headers = {};
        if (config.VANITY_GRINDER_API_KEY) {
            headers['X-API-Key'] = config.VANITY_GRINDER_API_KEY;
        }

        const statsResponse = await axios.get(`${config.VANITY_GRINDER_URL}/stats`, {
            headers,
            timeout: 5000
        });

        const available = statsResponse.data.available || 0;

        if (available < config.VANITY_POOL_MIN_SIZE) {
            logger.info(`Vanity pool low (${available}/${config.VANITY_POOL_MIN_SIZE}), triggering refill...`);
            isRefilling = true;

            try {
                const refillResponse = await axios.post(
                    `${config.VANITY_GRINDER_URL}/refill?count=${config.VANITY_POOL_REFILL_COUNT}`,
                    null,
                    { headers, timeout: 300000 }
                );

                if (refillResponse.data.success) {
                    logger.info(`Vanity pool refilled: +${refillResponse.data.generated} keys (total: ${refillResponse.data.total_available})`);
                }
            } catch (refillErr) {
                logger.error("Vanity pool refill error", { error: refillErr.message });
            } finally {
                isRefilling = false;
            }
        }
    } catch (e) {
        if (!e.message.includes('ECONNREFUSED')) {
            logger.error("Vanity pool check failed", { error: e.message });
        }
    }
}

/**
 * Start the auto-refill monitor
 */
function startAutoRefill() {
    if (config.VANITY_GRINDER_ENABLED && config.VANITY_GRINDER_URL) {
        setInterval(checkAndRefillPool, config.VANITY_POOL_CHECK_INTERVAL);
        setTimeout(checkAndRefillPool, 5000);
        logger.info(`Vanity pool auto-refill enabled (min: ${config.VANITY_POOL_MIN_SIZE}, refill: ${config.VANITY_POOL_REFILL_COUNT})`);
    }
}

module.exports = {
    fetchVanityKeypair,
    getMintKeypair,
    checkAndRefillPool,
    startAutoRefill,
};
