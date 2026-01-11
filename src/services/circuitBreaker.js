/**
 * Circuit Breaker Service
 * Provides resilience patterns for external API calls
 * v24.0 - Initial implementation
 */
const logger = require('./logger');

// Circuit states
const STATE = {
    CLOSED: 'CLOSED',     // Normal operation
    OPEN: 'OPEN',         // Failing, reject requests
    HALF_OPEN: 'HALF_OPEN' // Testing if service recovered
};

// Store circuit breakers by name
const circuits = new Map();

/**
 * Default circuit breaker options
 */
const DEFAULT_OPTIONS = {
    failureThreshold: 5,      // Failures before opening
    successThreshold: 2,       // Successes to close from half-open
    timeout: 30000,            // Time in ms before trying again (half-open)
    resetTimeout: 60000,       // Time to fully reset failure count
};

/**
 * Create or get a circuit breaker for a service
 */
function getCircuit(name, options = {}) {
    if (!circuits.has(name)) {
        circuits.set(name, {
            name,
            state: STATE.CLOSED,
            failures: 0,
            successes: 0,
            lastFailureTime: null,
            lastAttemptTime: null,
            options: { ...DEFAULT_OPTIONS, ...options }
        });
    }
    return circuits.get(name);
}

/**
 * Check if circuit allows requests
 */
function canRequest(name) {
    const circuit = getCircuit(name);
    const now = Date.now();

    switch (circuit.state) {
        case STATE.CLOSED:
            return true;

        case STATE.OPEN:
            // Check if timeout has passed to transition to half-open
            if (now - circuit.lastFailureTime >= circuit.options.timeout) {
                circuit.state = STATE.HALF_OPEN;
                circuit.successes = 0;
                logger.info(`[CircuitBreaker] ${name}: OPEN -> HALF_OPEN`);
                return true;
            }
            return false;

        case STATE.HALF_OPEN:
            return true;

        default:
            return true;
    }
}

/**
 * Record a successful request
 */
function recordSuccess(name) {
    const circuit = getCircuit(name);
    const now = Date.now();

    // Reset failure count if enough time has passed
    if (circuit.lastFailureTime &&
        now - circuit.lastFailureTime >= circuit.options.resetTimeout) {
        circuit.failures = 0;
    }

    if (circuit.state === STATE.HALF_OPEN) {
        circuit.successes++;
        if (circuit.successes >= circuit.options.successThreshold) {
            circuit.state = STATE.CLOSED;
            circuit.failures = 0;
            circuit.successes = 0;
            logger.info(`[CircuitBreaker] ${name}: HALF_OPEN -> CLOSED (recovered)`);
        }
    }

    circuit.lastAttemptTime = now;
}

/**
 * Record a failed request
 */
function recordFailure(name, error) {
    const circuit = getCircuit(name);
    const now = Date.now();

    circuit.failures++;
    circuit.lastFailureTime = now;
    circuit.lastAttemptTime = now;

    if (circuit.state === STATE.HALF_OPEN) {
        // Any failure in half-open goes back to open
        circuit.state = STATE.OPEN;
        logger.warn(`[CircuitBreaker] ${name}: HALF_OPEN -> OPEN (failed again)`, { error: error?.message });
    } else if (circuit.state === STATE.CLOSED &&
               circuit.failures >= circuit.options.failureThreshold) {
        circuit.state = STATE.OPEN;
        logger.warn(`[CircuitBreaker] ${name}: CLOSED -> OPEN (threshold reached)`, {
            failures: circuit.failures,
            error: error?.message
        });
    }
}

/**
 * Execute a function with circuit breaker protection
 * @param {string} name - Circuit breaker name
 * @param {Function} fn - Async function to execute
 * @param {*} fallback - Fallback value if circuit is open or function fails
 * @param {Object} options - Circuit breaker options
 */
async function execute(name, fn, fallback = null, options = {}) {
    const circuit = getCircuit(name, options);

    if (!canRequest(name)) {
        logger.debug(`[CircuitBreaker] ${name}: Request rejected (circuit OPEN)`);
        return fallback;
    }

    try {
        const result = await fn();
        recordSuccess(name);
        return result;
    } catch (error) {
        recordFailure(name, error);
        logger.debug(`[CircuitBreaker] ${name}: Request failed`, { error: error.message });
        return fallback;
    }
}

/**
 * Execute multiple requests in parallel with circuit breaker
 * Returns array of results (fallback for failed/rejected)
 */
async function executeAll(requests) {
    return Promise.all(
        requests.map(({ name, fn, fallback, options }) =>
            execute(name, fn, fallback, options)
        )
    );
}

/**
 * Get circuit status for monitoring
 */
function getStatus(name) {
    if (!circuits.has(name)) {
        return { state: 'UNKNOWN', exists: false };
    }
    const circuit = circuits.get(name);
    return {
        name: circuit.name,
        state: circuit.state,
        failures: circuit.failures,
        successes: circuit.successes,
        lastFailureTime: circuit.lastFailureTime,
        lastAttemptTime: circuit.lastAttemptTime,
        exists: true
    };
}

/**
 * Get all circuit statuses
 */
function getAllStatuses() {
    const statuses = {};
    for (const [name, circuit] of circuits) {
        statuses[name] = {
            state: circuit.state,
            failures: circuit.failures,
            successes: circuit.successes,
            lastFailureTime: circuit.lastFailureTime
        };
    }
    return statuses;
}

/**
 * Reset a specific circuit (for admin/testing)
 */
function reset(name) {
    if (circuits.has(name)) {
        const circuit = circuits.get(name);
        circuit.state = STATE.CLOSED;
        circuit.failures = 0;
        circuit.successes = 0;
        circuit.lastFailureTime = null;
        logger.info(`[CircuitBreaker] ${name}: Manually reset`);
    }
}

/**
 * Reset all circuits
 */
function resetAll() {
    for (const name of circuits.keys()) {
        reset(name);
    }
}

module.exports = {
    STATE,
    execute,
    executeAll,
    canRequest,
    recordSuccess,
    recordFailure,
    getStatus,
    getAllStatuses,
    reset,
    resetAll,
    getCircuit,
};
