/**
 * Input Sanitization Service
 * v24.0 - Provides input sanitization for user-provided content
 *
 * Prevents XSS, SQL injection attempts, and other malicious input
 */
const logger = require('./logger');

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
        allowHtml = false,
        stripNewlines = false,
        trimWhitespace = true,
        checkSqlInjection = true,
    } = options;

    let sanitized = input;

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

    // HTML entity encode if not allowing HTML (after pattern removal)
    if (!allowHtml) {
        sanitized = sanitized
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
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
        allowHtml: false,
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
        allowHtml: false,
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
        metadataUri: body.metadataUri,
        imageUrl: body.imageUrl,
        image: body.image,
        userTx: body.userTx,
        userPubkey: body.userPubkey,
        isMayhemMode: body.isMayhemMode,
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
