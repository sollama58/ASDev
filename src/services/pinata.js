/**
 * Pinata IPFS Service
 * Upload images and metadata to IPFS via Pinata
 */
const axios = require('axios');
const FormData = require('form-data');
const config = require('../config/env');
const logger = require('./logger');

/**
 * Get headers for Pinata file upload
 */
function getPinataHeaders(formData) {
    const headers = { ...formData.getHeaders() };
    if (config.PINATA_JWT) {
        headers['Authorization'] = `Bearer ${config.PINATA_JWT}`;
    } else {
        throw new Error("Missing Pinata Credentials");
    }
    return headers;
}

/**
 * Get headers for Pinata JSON upload
 */
function getPinataJSONHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (config.PINATA_JWT) {
        headers['Authorization'] = `Bearer ${config.PINATA_JWT}`;
    } else {
        throw new Error("Missing Pinata Credentials");
    }
    return headers;
}

/**
 * Upload image to Pinata IPFS
 * Returns the IPFS Hash (CID)
 */
async function uploadImage(base64Data) {
    try {
        const buffer = Buffer.from(base64Data.split(',')[1], 'base64');
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'image.png' });

        const response = await axios.post(
            'https://api.pinata.cloud/pinning/pinFileToIPFS',
            formData,
            { headers: getPinataHeaders(formData), maxBodyLength: Infinity }
        );

        return response.data.IpfsHash;
    } catch (e) {
        logger.error("Pinata image upload failed", { error: e.message });
        throw new Error("Image upload failed");
    }
}

/**
 * Upload token metadata to Pinata IPFS
 * Returns object with metadata URI and the direct Image URI (Gateway)
 */
async function uploadMetadata(name, symbol, description, twitter, website, imageBase64) {
    let imageCid = "";
    
    // 1. Upload Image
    if (imageBase64) {
        imageCid = await uploadImage(imageBase64);
    }

    // 2. Construct Metadata
    // CRITICAL FIX: Use ipfs:// scheme for the on-chain metadata.
    // This allows Pump.fun/Solscan/Wallets to use their own fast gateways.
    const metadata = {
        name,
        symbol,
        description,
        image: imageCid ? `ipfs://${imageCid}` : "", 
        showName: true,
        createdOn: "https://pump.fun",
        twitter: twitter || "",
        telegram: "",
        website: website || ""
    };

    try {
        // 3. Upload Metadata JSON
        const response = await axios.post(
            'https://api.pinata.cloud/pinning/pinJSONToIPFS',
            metadata,
            { headers: getPinataJSONHeaders() }
        );
        
        const metadataHash = response.data.IpfsHash;

        return {
            // Return the gateway URL for the frontend to display immediately
            imageUrl: imageCid ? `https://gateway.pinata.cloud/ipfs/${imageCid}` : "",
            // Return the HTTP URL for the metadata so the Token Program can read it
            metadataUri: `https://gateway.pinata.cloud/ipfs/${metadataHash}`
        };
    } catch (e) {
        throw new Error(`Pinata Error: ${e.response?.data?.error || e.message}`);
    }
}

module.exports = {
    uploadImage,
    uploadMetadata,
};
