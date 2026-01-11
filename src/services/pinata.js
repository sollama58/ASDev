/**
 * Pinata IPFS Service
 * Upload images and metadata to IPFS via Pinata
 * v25.0 - Updated to accept image URLs (from Cloudflare) instead of base64
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
 * Upload image to Pinata IPFS (legacy - for base64 data)
 * Returns the IPFS Hash (CID)
 * @deprecated Use Cloudflare Images for uploads, this is kept for backwards compatibility
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
 * v25.0: Now accepts imageUrl directly (from Cloudflare) instead of base64
 *
 * @param {string} name - Token name
 * @param {string} symbol - Token symbol/ticker
 * @param {string} description - Token description
 * @param {string} twitter - Twitter handle or URL
 * @param {string} website - Website URL
 * @param {string} imageUrl - Direct URL to the image (Cloudflare CDN URL)
 * @returns {Promise<{imageUrl: string, metadataUri: string}>}
 */
async function uploadMetadata(name, symbol, description, twitter, website, imageUrl) {
    // v25.0: Use the provided image URL directly (from Cloudflare Images)
    // No more base64 processing on our server

    // Construct Metadata with the CDN image URL
    const metadata = {
        name,
        symbol,
        description,
        image: imageUrl || "",  // v25.0: Direct URL instead of ipfs://
        showName: true,
        createdOn: "https://pump.fun",
        twitter: twitter || "",
        telegram: "",
        website: website || ""
    };

    try {
        // Upload Metadata JSON to IPFS
        const response = await axios.post(
            'https://api.pinata.cloud/pinning/pinJSONToIPFS',
            metadata,
            { headers: getPinataJSONHeaders() }
        );

        const metadataHash = response.data.IpfsHash;

        logger.info('[Pinata] Metadata uploaded', {
            name,
            symbol,
            metadataHash,
            hasImage: !!imageUrl
        });

        return {
            // Return the image URL that was provided
            imageUrl: imageUrl || "",
            // Return the HTTP URL for the metadata so the Token Program can read it
            metadataUri: `https://gateway.pinata.cloud/ipfs/${metadataHash}`
        };
    } catch (e) {
        logger.error('[Pinata] Metadata upload failed', { error: e.message });
        throw new Error(`Metadata upload failed. Please try again.`);
    }
}

/**
 * Upload metadata with legacy base64 image support
 * @deprecated Use uploadMetadata with imageUrl instead
 */
async function uploadMetadataWithBase64(name, symbol, description, twitter, website, imageBase64) {
    let imageCid = "";

    // Upload Image to IPFS
    if (imageBase64) {
        imageCid = await uploadImage(imageBase64);
    }

    // Construct Metadata with IPFS image reference
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
        const response = await axios.post(
            'https://api.pinata.cloud/pinning/pinJSONToIPFS',
            metadata,
            { headers: getPinataJSONHeaders() }
        );

        const metadataHash = response.data.IpfsHash;

        return {
            imageUrl: imageCid ? `https://gateway.pinata.cloud/ipfs/${imageCid}` : "",
            metadataUri: `https://gateway.pinata.cloud/ipfs/${metadataHash}`
        };
    } catch (e) {
        throw new Error(`Pinata Error: ${e.response?.data?.error || e.message}`);
    }
}

module.exports = {
    uploadImage,
    uploadMetadata,
    uploadMetadataWithBase64,
};
