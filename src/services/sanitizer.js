/**
 * Input Sanitization Service
 * v24.0 - Provides input sanitization for user-provided content
 * v29.1 - Sanitization is split by destination.
 *
 * These two destinations need opposite treatment, and conflating them was a real bug:
 *
 *   - Text that ends up ON-CHAIN (a token's name, ticker and description) is written into
 *     the mint instruction and is immutable forever. HTML-entity encoding it corrupts
 *     ordinary input permanently: "Rock & Roll" was minted as "Rock &amp; Roll" and
 *     "Ben's Coin" as "Ben&#x27;s Coin". On-chain text is therefore STRIPPED of anything
 *     unsafe rather than escaped, so the characters a user typed survive intact.
 *
 *   - Text rendered into a PAGE still needs escaping, but that is the renderer's job at
 *     output time, where the surrounding context is known. Both frontends already escape
 *     every interpolated value, so nothing here needs to pre-encode for them.
 *
 * Escaping therefore no longer happens in this module. `sanitizeString` keeps an opt-in
 * `encodeHtml` flag for any future caller that genuinely writes into markup.
 */
const logger = require('./logger');

// Invisible and direction-controlling characters. These are stripped from on-chain text:
// they are never wanted in a token name, and bidi overrides in particular let a name render
// as something entirely different from the bytes that were signed.
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

// Characters that could be dangerous in various contexts
const DANGEROUS_PATTERNS = [
    /<script\b[^>]*>/i,            // Script tags
    /javascript:/i,                 // JavaScript protocol
    /on\w+\s*=/i,                  // Event handlers (onclick=, onerror=, etc.)
    /data:\s*text\/html/i,         // Data URLs with HTML
    /vbscript:/i,                  // VBScript protocol
    /expression\s*\(/i,            // CSS expression
    /&#x?[0-9a-f]+;?/i,            // HTML entities (potential XSS)
];

// SQL injection patterns (no /g flag — stateful regex causes .test() to alternate results)
const SQL_INJECTION_PATTERNS = [
    /(\b(union|select|insert|update|delete|drop|truncate|alter|exec|execute)\b)/i,
    /('|"|;|--|\bor\b|\band\b)/i,
    /\b(1\s*=\s*1|0\s*=\s*0)\b/i,
];

/**
 * Sanitize a string by removing potentially dangerous content
 * @param {string} input - The input string to sanitize
 * @param {Object} options - Sanitization options
 * @returns {string} - Sanitized string
 */
function sanitizeString(input, options = {}) {
    if (typeof input !== 'string') {
        return '';
    }

    const {
        maxLength = 500,
        encodeHtml = false,
        stripNewlines = false,
        trimWhitespace = true,
        checkSqlInjection = true,
        stripAngleBrackets = true,
        collapseWhitespace = false,
    } = options;

    let sanitized = input;

    // Always remove invisible and bidi-control characters, whatever the destination.
    sanitized = sanitized.replace(INVISIBLE_CHARS, '');

    // Trim whitespace
    if (trimWhitespace) {
        sanitized = sanitized.trim();
    }

    // Enforce max length
    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength);
        logger.debug('[Sanitizer] Input truncated to max length', { maxLength });
    }

    // Strip newlines if requested
    if (stripNewlines) {
        sanitized = sanitized.replace(/[\r\n]/g, ' ');
    }

    // M-1 FIX: Check dangerous patterns against the RAW (pre-encode) value so patterns like
    // <script> are caught before HTML encoding turns them into &lt;script&gt; which bypasses regex checks.
    const rawForPatternCheck = sanitized; // still pre-encode at this point
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(rawForPatternCheck)) {
            logger.warn('[Sanitizer] Dangerous pattern detected and removed', {
                pattern: pattern.toString()
            });
            // Remove from the raw string before encoding
            const globalPattern = new RegExp(pattern.source, pattern.flags + 'g');
            sanitized = sanitized.replace(globalPattern, '');
        }
    }

    // Drop angle brackets outright. Nothing legitimate in a token name needs them, and
    // removing them means no downstream renderer can be handed a partial tag, without
    // mangling the apostrophes and ampersands that people actually type.
    if (stripAngleBrackets) {
        sanitized = sanitized.replace(/[<>]/g, '');
    }

    // Opt-in only, for a caller that really is writing into markup. On-chain text must
    // never take this path: entity-encoding is not reversible once it has been minted.
    if (encodeHtml) {
        sanitized = sanitized
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    }

    if (collapseWhitespace) {
        sanitized = sanitized.replace(/\s{2,}/g, ' ').trim();
    }

    // Check for SQL injection patterns (warning only, as this is defense in depth)
    if (checkSqlInjection) {
        for (const pattern of SQL_INJECTION_PATTERNS) {
            if (pattern.test(input)) {
                logger.warn('[Sanitizer] Potential SQL injection pattern detected', {
                    pattern: pattern.toString()
                });
                // Don't remove these as they might be legitimate in descriptions
                // The real protection is parameterized queries
                break;
            }
        }
    }

    return sanitized;
}

/**
 * Sanitize a token name
 */
function sanitizeName(name) {
    return sanitizeString(name, {
        maxLength: 32,
        stripNewlines: true,
        collapseWhitespace: true,
    });
}

/**
 * Sanitize a token ticker/symbol
 */
function sanitizeTicker(ticker) {
    if (typeof ticker !== 'string') return '';

    // Ticker should be alphanumeric only, uppercase
    return ticker
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .substring(0, 10);
}

/**
 * Sanitize a description
 */
function sanitizeDescription(description) {
    return sanitizeString(description, {
        maxLength: 200,
        stripNewlines: true,
        collapseWhitespace: true,
    });
}

/**
 * Sanitize a URL (twitter, website, etc.)
 */
function sanitizeUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
        return null;
    }

    const trimmed = url.trim();

    // Basic URL validation
    try {
        const parsed = new URL(trimmed);

        // Only allow http and https protocols
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            logger.warn('[Sanitizer] Invalid URL protocol rejected', { protocol: parsed.protocol });
            return null;
        }

        // Return the sanitized URL
        return parsed.href;
    } catch (e) {
        // If it doesn't start with http, try adding https://
        if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            return sanitizeUrl('https://' + trimmed);
        }

        logger.debug('[Sanitizer] Invalid URL rejected', { url: trimmed.substring(0, 50) });
        return null;
    }
}

/**
 * Sanitize a Twitter handle and return as full URL
 * v25.22 FIX: Returns full URL format for Pump.fun metadata compatibility
 */
function sanitizeTwitterHandle(handle) {
    if (typeof handle !== 'string' || !handle.trim()) {
        return null;
    }

    let sanitized = handle.trim();

    // If it's already a full URL, extract the handle
    const urlMatch = sanitized.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})/i);
    if (urlMatch) {
        sanitized = urlMatch[1];
    } else {
        // Remove @ if present
        sanitized = sanitized.replace(/^@/, '');
    }

    // Twitter handles: 1-15 characters, alphanumeric and underscore only
    if (!/^[A-Za-z0-9_]{1,15}$/.test(sanitized)) {
        return null;
    }

    // v25.22 FIX: Return as full URL for Pump.fun metadata compatibility
    return `https://x.com/${sanitized}`;
}

/**
 * Sanitize all fields in a token deployment request
 */
function sanitizeDeploymentRequest(body) {
    return {
        name: sanitizeName(body.name),
        ticker: sanitizeTicker(body.ticker),
        description: sanitizeDescription(body.description || ''),
        twitter: sanitizeTwitterHandle(body.twitter),
        website: sanitizeUrl(body.website),
        // Don't sanitize these - they're validated separately
        // (v30.2: metadataUri and isMayhemMode are no longer accepted from clients.)
        imageUrl: body.imageUrl,
        image: body.image,
        userTx: body.userTx,
        userPubkey: body.userPubkey,
    };
}

/**
 * Check if input contains suspicious patterns (for logging/monitoring)
 */
function hasSuspiciousPatterns(input) {
    if (typeof input !== 'string') return false;

    for (const pattern of [...DANGEROUS_PATTERNS, ...SQL_INJECTION_PATTERNS]) {
        if (pattern.test(input)) {
            return true;
        }
    }
    return false;
}

module.exports = {
    sanitizeString,
    sanitizeName,
    sanitizeTicker,
    sanitizeDescription,
    sanitizeUrl,
    sanitizeTwitterHandle,
    sanitizeDeploymentRequest,
    hasSuspiciousPatterns,
};
