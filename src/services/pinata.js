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

        return `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`;
    } catch (e) {
        logger.error("Pinata image upload failed", { error: e.message });
        // Return fallback to prevent crash, but log error
        return "https://placehold.co/400x400/333/fff?text=Upload+Failed";
    }
}

/**
 * Upload token metadata to Pinata IPFS
 * Returns object with both metadata URI and the direct Image URI
 */
async function uploadMetadata(name, symbol, description, twitter, website, imageBase64) {
    let imageUrl = "https://placehold.co/400x400/333/fff?text=No+Image";

    if (imageBase64) {
        imageUrl = await uploadImage(imageBase64);
    }

    const metadata = {
        name,
        symbol,
        description,
        image: imageUrl,
        showName: true,
        createdOn: "https://pump.fun",
        twitter: twitter || "",
        telegram: "",
        website: website || ""
    };

    try {
        const response = await axios.post(
            'https://api.pinata.cloud/pinning/pinJSONToIPFS',
            metadata,
            { headers: getPinataJSONHeaders() }
        );
        
        return {
            metadataUri: `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`,
            imageUrl: imageUrl
        };
    } catch (e) {
        throw new Error(`Pinata Error: ${e.response?.data?.error || e.message}`);
    }
}

module.exports = {
    uploadImage,
    uploadMetadata,
};
