/**
 * BigInt Utilities
 * v25.24 - Safe BigInt conversion helpers for production robustness
 *
 * Handles null, undefined, and invalid values gracefully to prevent
 * "Cannot convert null to a BigInt" runtime errors.
 */

/**
 * Safely convert a value to BigInt with fallback
 * Handles null, undefined, empty strings, and invalid values
 *
 * @param {any} value - Value to convert (string, number, or BigInt)
 * @param {string|bigint} fallback - Fallback value if conversion fails (default: '0')
 * @returns {bigint} The converted BigInt value
 */
function safeBigInt(value, fallback = '0') {
    // Handle null, undefined, empty string
    if (value === null || value === undefined || value === '') {
        return BigInt(fallback);
    }

    // Already a BigInt
    if (typeof value === 'bigint') {
        return value;
    }

    try {
        // Handle string and number conversions
        const str = String(value).trim();
        if (str === '' || str === 'null' || str === 'undefined' || str === 'NaN') {
            return BigInt(fallback);
        }

        // Remove any decimal points (BigInt doesn't support decimals)
        const intPart = str.split('.')[0];
        return BigInt(intPart);
    } catch (e) {
        // Any conversion error - return fallback
        return BigInt(fallback);
    }
}

/**
 * Safely convert balance string to BigInt
 * Convenience wrapper with '0' as default fallback
 *
 * @param {any} balance - Balance value (typically from database)
 * @returns {bigint} The balance as BigInt, or 0n if invalid
 */
function safeBalance(balance) {
    return safeBigInt(balance, '0');
}

/**
 * Safely convert total balance with '1' fallback to prevent division by zero
 *
 * @param {any} totalBalance - Total balance value
 * @returns {bigint} The total balance as BigInt, or 1n if invalid/zero
 */
function safeTotalBalance(totalBalance) {
    const result = safeBigInt(totalBalance, '1');
    // Ensure we never return 0 to prevent division by zero
    return result === 0n ? 1n : result;
}

module.exports = {
    safeBigInt,
    safeBalance,
    safeTotalBalance,
};
