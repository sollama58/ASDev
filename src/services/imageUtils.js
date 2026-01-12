/**
 * Image Utilities
 * Helper functions for processing image URLs from various sources
 *
 * v1.0 - Clean Helius CDN-wrapped URLs to extract actual image URLs
 */

/**
 * Clean a Helius CDN-wrapped URL to extract the actual image URL
 * Helius wraps image URLs in their CDN proxy format like:
 * https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/...
 *
 * This function extracts the actual underlying URL
 *
 * @param {string|null} url - The URL to clean (may be CDN-wrapped or already clean)
 * @returns {string|null} The clean image URL or null
 */
function cleanHeliusImageUrl(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }

    // Check if this is a Helius CDN-wrapped URL
    // Pattern: https://cdn.helius-rpc.com/cdn-cgi/image/<options>/<actual-url>
    const heliusCdnPrefix = 'https://cdn.helius-rpc.com/cdn-cgi/image/';

    if (url.startsWith(heliusCdnPrefix)) {
        // The actual URL comes after the CDN prefix and optional transform params
        // Find where the actual URL starts (it will start with http:// or https://)
        const afterPrefix = url.substring(heliusCdnPrefix.length);

        // Look for http:// or https:// in the remaining string
        const httpIndex = afterPrefix.indexOf('http://');
        const httpsIndex = afterPrefix.indexOf('https://');

        let actualUrlStart = -1;
        if (httpIndex !== -1 && httpsIndex !== -1) {
            actualUrlStart = Math.min(httpIndex, httpsIndex);
        } else if (httpIndex !== -1) {
            actualUrlStart = httpIndex;
        } else if (httpsIndex !== -1) {
            actualUrlStart = httpsIndex;
        }

        if (actualUrlStart !== -1) {
            return afterPrefix.substring(actualUrlStart);
        }
    }

    // Not a CDN-wrapped URL, return as-is
    return url;
}

/**
 * Extract and clean image URL from Helius asset response
 * Tries multiple sources in order of preference and cleans any CDN-wrapped URLs
 *
 * @param {Object} asset - Helius asset object
 * @returns {string|null} Clean image URL or null
 */
function extractHeliusImage(asset) {
    if (!asset) return null;

    const files = asset.content?.files || [];
    const imageFile = files.find(f => f.mime?.startsWith('image/')) || files[0];

    // Try multiple sources in order of preference
    const rawUrl = imageFile?.cdn_uri ||
                   imageFile?.uri ||
                   asset.content?.links?.image ||
                   null;

    return cleanHeliusImageUrl(rawUrl);
}

/**
 * Extract and clean image URL from Helius batch asset response
 * Uses slightly different field paths than single asset response
 *
 * @param {Object} asset - Helius batch asset object
 * @returns {string|null} Clean image URL or null
 */
function extractHeliusBatchImage(asset) {
    if (!asset) return null;

    // Try multiple sources in order of preference (batch response format)
    const rawUrl = asset?.content?.links?.image ||
                   asset?.content?.files?.[0]?.cdn_uri ||
                   asset?.content?.files?.[0]?.uri ||
                   null;

    return cleanHeliusImageUrl(rawUrl);
}

/**
 * v25.4: Fetch image from metadataUri as a fallback
 * Fetches the JSON metadata and extracts the image field
 *
 * @param {string} metadataUri - The URI to the token metadata JSON
 * @param {number} timeout - Request timeout in ms (default 5000)
 * @returns {Promise<string|null>} Image URL or null
 */
async function fetchImageFromMetadataUri(metadataUri, timeout = 5000) {
    if (!metadataUri || typeof metadataUri !== 'string') {
        return null;
    }

    try {
        // Handle IPFS URIs
        let fetchUrl = metadataUri;
        if (metadataUri.startsWith('ipfs://')) {
            fetchUrl = metadataUri.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }
        // Convert Pinata gateway to more reliable IPFS gateway
        if (fetchUrl.includes('gateway.pinata.cloud')) {
            fetchUrl = fetchUrl.replace('gateway.pinata.cloud', 'ipfs.io');
        }

        const axios = require('axios');
        const response = await axios.get(fetchUrl, {
            timeout,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'ASDF-Launcher/1.0'
            }
        });

        const metadata = response.data;
        if (metadata && metadata.image) {
            // Clean the image URL if needed
            let imageUrl = metadata.image;
            if (imageUrl.startsWith('ipfs://')) {
                imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
            }
            return imageUrl;
        }

        return null;
    } catch (e) {
        // Silently fail - this is a fallback mechanism
        return null;
    }
}

/**
 * v25.4: Get the best available image for a token
 * Tries multiple sources in order:
 * 1. Direct image URL from database
 * 2. Fetch from metadataUri
 *
 * @param {Object} token - Token object with image and metadataUri fields
 * @param {number} timeout - Request timeout for metadata fetch
 * @returns {Promise<string|null>} Best available image URL or null
 */
async function getBestImage(token, timeout = 3000) {
    // If we have a valid image already, use it
    if (token.image && token.image !== '' && token.image !== 'null' && token.image !== 'undefined') {
        return token.image;
    }

    // Try fetching from metadataUri as fallback
    if (token.metadataUri) {
        const metadataImage = await fetchImageFromMetadataUri(token.metadataUri, timeout);
        if (metadataImage) {
            return metadataImage;
        }
    }

    return null;
}

module.exports = {
    cleanHeliusImageUrl,
    extractHeliusImage,
    extractHeliusBatchImage,
    fetchImageFromMetadataUri,
    getBestImage
};
