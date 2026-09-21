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

    // Handle IPFS protocol - use ipfs.io gateway (H-5 FIX: cloudflare-ipfs.com was shut down Aug 2023)
    if (cleanUrl.startsWith('ipfs://')) {
        cleanUrl = cleanUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
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

    // v25.42: Normalize various IPFS gateways to ipfs.io
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
            cleanUrl = cleanUrl.replace(gateway, 'ipfs.io');
            break;
        }
    }

    // Handle bare IPFS CIDs (Qm... for v0, bafy... for v1)
    if (/^(Qm[a-zA-Z0-9]{44}|bafy[a-zA-Z0-9]{50,})/.test(cleanUrl)) {
        cleanUrl = `https://ipfs.io/ipfs/${cleanUrl}`;
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
/**
 * v28.2 SECURITY: refuse to fetch anything that could reach the local network.
 *
 * metadataUri comes from on-chain metadata that anyone can
 * write when they register a token, so this function is an SSRF primitive without a guard:
 * a URI of http://169.254.169.254/ or http://localhost:6379/ would be fetched from inside
 * the platform's network. The response is only ever read for a `.image` field, which keeps
 * it blind, but blind SSRF is still a foothold. Hostnames are checked literally — a DNS
 * name resolving to a private range is not caught here, which is why the fetch also runs
 * with a short timeout and never follows the result anywhere sensitive.
 */
function isSafeFetchUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    // IPv4 literals in private, loopback, link-local or unspecified ranges
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
        const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
        if (a === 10 || a === 127 || a === 0) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT / cloud metadata
    }
    // IPv6 loopback, unspecified, link-local, unique-local, and IPv4-mapped forms
    if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('::ffff:')) return false;
    return true;
}

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
        if (!isSafeFetchUrl(fetchUrl)) {
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
 * v29.3: Confirm an image URL actually serves an image before a token is minted against it.
 *
 * Nothing used to check this. The URL was validated for host and scheme, then written into the
 * metadata document and minted. A dead link, a typo, or an Imgur page URL the normaliser could
 * not convert therefore produced a token with a permanently broken image, and the creator had
 * already paid for it. On-chain metadata is immutable, so the only place this can be caught is
 * before the launch is queued.
 *
 * Streamed rather than buffered: the body is read only until the size limit is exceeded, then
 * the connection is destroyed. That keeps a hostile or merely enormous file from occupying
 * memory, and no part of the image is retained once the check finishes.
 *
 * @returns {Promise<{ok: true, contentType: string, bytes: number}|{ok: false, reason: string}>}
 */
async function verifyImageUrl(url, { maxBytes = 10 * 1024 * 1024, timeoutMs = 8000 } = {}) {
    if (!url || typeof url !== 'string') return { ok: false, reason: 'No image URL was provided.' };
    if (!isSafeFetchUrl(url)) return { ok: false, reason: 'That image URL cannot be fetched.' };

    const axios = require('axios');
    let response;
    try {
        response = await axios.get(url, {
            responseType: 'stream',
            timeout: timeoutMs,
            maxRedirects: 3,
            // Treat every status as non-throwing so a 404 becomes a clear message rather than
            // an exception indistinguishable from a network failure.
            validateStatus: () => true,
            headers: { 'Accept': 'image/*', 'User-Agent': 'ShitPad/1.0' }
        });
    } catch (e) {
        return { ok: false, reason: 'The image could not be reached. Check the link and try again.' };
    }

    const destroy = () => { try { response.data.destroy(); } catch (e) { /* already closed */ } };

    if (response.status < 200 || response.status >= 300) {
        destroy();
        return { ok: false, reason: `The image URL returned ${response.status}. Make sure the link is public and still exists.` };
    }

    // Imgur answers a deleted image with a 200 and a placeholder rather than a 404, so the
    // status alone does not tell us the image is still there.
    const finalUrl = response.request?.res?.responseUrl || url;
    if (/\/removed(\.[a-z]+)?$/i.test(new URL(finalUrl).pathname)) {
        destroy();
        return { ok: false, reason: 'That image has been removed from Imgur. Upload it again and use the new link.' };
    }

    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
        destroy();
        return { ok: false, reason: `That URL serves ${contentType || 'unknown content'}, not an image.` };
    }

    // Trust a declared length when it is already over the limit, but never trust it as proof of
    // being under: a wrong or absent header is checked against the bytes actually delivered.
    const declared = parseInt(response.headers['content-length'], 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
        destroy();
        return { ok: false, reason: `That image is ${(declared / 1048576).toFixed(1)}MB. The limit is ${(maxBytes / 1048576).toFixed(0)}MB.` };
    }

    const bytes = await new Promise((resolve) => {
        let seen = 0;
        response.data.on('data', (chunk) => {
            seen += chunk.length;
            if (seen > maxBytes) { destroy(); resolve(-1); }
        });
        response.data.on('end', () => resolve(seen));
        response.data.on('error', () => resolve(-1));
    });

    if (bytes === -1) return { ok: false, reason: `That image is larger than the ${(maxBytes / 1048576).toFixed(0)}MB limit.` };
    if (bytes === 0) return { ok: false, reason: 'That URL returned an empty file.' };

    return { ok: true, contentType, bytes };
}

module.exports = {
    normalizeImageUrl,
    verifyImageUrl,
    extractHeliusImage,
    extractHeliusBatchImage,
    fetchImageFromMetadataUri
};
