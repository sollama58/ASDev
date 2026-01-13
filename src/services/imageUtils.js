/**
 * Image Utilities
 * Helper functions for processing image URLs from various sources
 *
 * v1.0 - Clean Helius CDN-wrapped URLs to extract actual image URLs
 * v25.8 - Added comprehensive URL normalization for all image formats
 * v25.9 - Added Imgur URL normalization
 * v25.10 - Added GeckoTerminal asset URL support
 */

/**
 * v25.8: Normalize and clean any image URL to a standard format
 * v25.9: Added Imgur URL support
 * v25.10: Added GeckoTerminal asset URL support
 * Handles: IPFS, Arweave, Helius CDN, Imgur, GeckoTerminal, various gateways, data URLs, etc.
 *
 * @param {string|null} url - The URL to normalize
 * @returns {string|null} Normalized URL or null if invalid
 */
function normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }

    let cleanUrl = url.trim();

    // Handle null/undefined strings
    if (cleanUrl === '' || cleanUrl === 'null' || cleanUrl === 'undefined') {
        return null;
    }

    // Data URLs are valid as-is
    if (cleanUrl.startsWith('data:image/')) {
        return cleanUrl;
    }

    // Handle Helius CDN-wrapped URLs first
    if (cleanUrl.includes('cdn.helius-rpc.com/cdn-cgi/image/')) {
        const httpIndex = cleanUrl.indexOf('http', cleanUrl.indexOf('cdn-cgi/image/') + 14);
        if (httpIndex !== -1) {
            cleanUrl = cleanUrl.substring(httpIndex);
        }
    }

    // Handle IPFS protocol - use reliable Cloudflare gateway
    if (cleanUrl.startsWith('ipfs://')) {
        cleanUrl = cleanUrl.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
    }

    // Handle Arweave protocol
    if (cleanUrl.startsWith('ar://')) {
        cleanUrl = cleanUrl.replace('ar://', 'https://arweave.net/');
    }

    // v25.9: Normalize Imgur URLs to direct image format
    // Handles: imgur.com/abc123, imgur.com/a/abc123, imgur.com/gallery/abc123
    if (cleanUrl.includes('imgur.com')) {
        // Extract the image ID from various Imgur URL formats
        const imgurMatch = cleanUrl.match(/imgur\.com\/(?:a\/|gallery\/)?([a-zA-Z0-9]+)(?:\.[a-zA-Z]+)?/);
        if (imgurMatch && imgurMatch[1]) {
            const imgId = imgurMatch[1];
            // Skip if it's already an i.imgur.com direct link with extension
            if (!cleanUrl.includes('i.imgur.com') || !/\.(jpg|jpeg|png|gif|webp)$/i.test(cleanUrl)) {
                cleanUrl = `https://i.imgur.com/${imgId}.png`;
            }
        }
    }

    // v25.10: GeckoTerminal asset URLs are valid as-is
    // Format: https://assets.geckoterminal.com/<asset-id>
    // These don't need transformation, just pass through

    // v25.42: Normalize various IPFS gateways to Cloudflare (more reliable)
    const ipfsGateways = [
        'gateway.pinata.cloud',
        'ipfs.io',
        'dweb.link',
        'nftstorage.link',
        'ipfs.infura.io',
        'ipfs.fleek.co',
        'gateway.ipfs.io',
        'cf-ipfs.com'
    ];
    for (const gateway of ipfsGateways) {
        if (cleanUrl.includes(gateway)) {
            cleanUrl = cleanUrl.replace(gateway, 'cloudflare-ipfs.com');
            break;
        }
    }

    // Handle bare IPFS CIDs (Qm... for v0, bafy... for v1)
    if (/^(Qm[a-zA-Z0-9]{44}|bafy[a-zA-Z0-9]{50,})/.test(cleanUrl)) {
        cleanUrl = `https://cloudflare-ipfs.com/ipfs/${cleanUrl}`;
    }

    // Validate URL format
    try {
        new URL(cleanUrl);
    } catch (e) {
        return null;
    }

    return cleanUrl;
}

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
 * v25.8: Now uses normalizeImageUrl for comprehensive URL handling
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
        // v25.8: Use normalizeImageUrl for the metadata URI itself
        let fetchUrl = normalizeImageUrl(metadataUri);
        if (!fetchUrl) {
            return null;
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
            // v25.8: Use normalizeImageUrl for comprehensive image URL handling
            return normalizeImageUrl(metadata.image);
        }

        return null;
    } catch (e) {
        // Silently fail - this is a fallback mechanism
        return null;
    }
}

/**
 * v25.4: Get the best available image for a token
 * v25.8: Now normalizes all image URLs for consistency
 * Tries multiple sources in order:
 * 1. Direct image URL from database (normalized)
 * 2. Fetch from metadataUri
 *
 * @param {Object} token - Token object with image and metadataUri fields
 * @param {number} timeout - Request timeout for metadata fetch
 * @returns {Promise<string|null>} Best available image URL or null
 */
async function getBestImage(token, timeout = 3000) {
    // If we have a valid image already, normalize and use it
    if (token.image && token.image !== '' && token.image !== 'null' && token.image !== 'undefined') {
        const normalized = normalizeImageUrl(token.image);
        if (normalized) {
            return normalized;
        }
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
    normalizeImageUrl,
    cleanHeliusImageUrl,
    extractHeliusImage,
    extractHeliusBatchImage,
    fetchImageFromMetadataUri,
    getBestImage
};
