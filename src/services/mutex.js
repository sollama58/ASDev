/**
 * Mutex Service
 * Provides async-safe locking mechanisms for preventing race conditions
 * v13.0 - Added for race condition fixes
 * v25.21 - Added configurable timeout to tryAcquire and auto-release safety
 */
const logger = require('./logger');

// v25.21: Default lock timeout (5 minutes) - prevents deadlocks if process crashes while holding lock
const DEFAULT_LOCK_TIMEOUT_MS = 300000;

// v28.2 CORRECTNESS: compare-and-delete as a single Redis operation.
//
// Release used to be GET then DEL as two round-trips. Between them the lock can expire and
// be re-acquired by another process, at which point the DEL removes *that* process's lock —
// and two holders of e.g. the flywheel mutex proceed concurrently. A Lua script runs
// atomically on the server, so the ownership check and the delete cannot be interleaved.
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;

async function releaseIfOwner(redis, lockKey, lockId) {
    return redis.eval(RELEASE_SCRIPT, 1, lockKey, lockId);
}

/**
 * Simple async mutex implementation using Redis for distributed locking
 * Falls back to in-memory locks if Redis is unavailable
 */
class AsyncMutex {
    constructor(name, redis = null) {
        this.name = name;
        this.redis = redis;
        this._localLock = false;
        this._lockPromise = null;
        this._localLockTimeout = null;
    }

    /**
     * Acquire the lock - returns a release function
     * If lock is already held, waits until it's released
     */
    async acquire(timeoutMs = 60000, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
        const lockKey = `mutex:${this.name}`;
        const startTime = Date.now();

        // Try Redis-based lock first for distributed locking
        if (this.redis) {
            const lockId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

            while (Date.now() - startTime < timeoutMs) {
                // v28.2: the lock's TTL is how long it may be HELD, not how long we were
                // willing to WAIT for it. Previously PX was set to timeoutMs (the wait),
                // so a holder doing more than 60s of work lost its lock mid-run.
                const result = await this.redis.set(lockKey, lockId, 'NX', 'PX', lockTimeoutMs);

                if (result === 'OK') {
                    logger.debug(`[Mutex] Acquired lock: ${this.name}`);
                    return async () => {
                        if (await releaseIfOwner(this.redis, lockKey, lockId)) {
                            logger.debug(`[Mutex] Released lock: ${this.name}`);
                        }
                    };
                }

                // Wait and retry
                await new Promise(r => setTimeout(r, 100));
            }

            throw new Error(`[Mutex] Timeout acquiring lock: ${this.name}`);
        }

        // Fallback to in-memory locking
        while (this._localLock && Date.now() - startTime < timeoutMs) {
            await new Promise(r => setTimeout(r, 100));
        }

        if (this._localLock) {
            throw new Error(`[Mutex] Timeout acquiring lock: ${this.name}`);
        }

        this._localLock = true;
        logger.debug(`[Mutex] Acquired local lock: ${this.name}`);

        return () => {
            this._localLock = false;
            logger.debug(`[Mutex] Released local lock: ${this.name}`);
        };
    }

    /**
     * Try to acquire lock without waiting
     * Returns release function if successful, null otherwise
     * v25.21: Added configurable timeout with auto-release safety
     * @param {number} lockTimeoutMs - How long the lock can be held before auto-release (default 5 min)
     */
    async tryAcquire(lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
        const lockKey = `mutex:${this.name}`;

        if (this.redis) {
            const lockId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const result = await this.redis.set(lockKey, lockId, 'NX', 'PX', lockTimeoutMs);

            if (result === 'OK') {
                logger.debug(`[Mutex] Acquired Redis lock: ${this.name} (timeout: ${lockTimeoutMs}ms)`);
                return async () => {
                    if (await releaseIfOwner(this.redis, lockKey, lockId)) {
                        logger.debug(`[Mutex] Released Redis lock: ${this.name}`);
                    }
                };
            }
            return null;
        }

        // In-memory fallback with auto-release timeout
        if (this._localLock) {
            return null;
        }

        this._localLock = true;

        // v25.21: Auto-release after timeout to prevent deadlocks
        if (this._localLockTimeout) {
            clearTimeout(this._localLockTimeout);
        }
        this._localLockTimeout = setTimeout(() => {
            if (this._localLock) {
                logger.warn(`[Mutex] Auto-releasing stale lock: ${this.name} after ${lockTimeoutMs}ms`);
                this._localLock = false;
            }
        }, lockTimeoutMs);

        logger.debug(`[Mutex] Acquired local lock: ${this.name} (timeout: ${lockTimeoutMs}ms)`);

        return () => {
            this._localLock = false;
            if (this._localLockTimeout) {
                clearTimeout(this._localLockTimeout);
                this._localLockTimeout = null;
            }
            logger.debug(`[Mutex] Released local lock: ${this.name}`);
        };
    }

    /**
     * Check if lock is currently held (for read-only checks)
     */
    async isLocked() {
        if (this.redis) {
            const result = await this.redis.get(`mutex:${this.name}`);
            return result !== null;
        }
        return this._localLock;
    }
}

/**
 * Execute a function with mutex protection
 * Automatically acquires and releases the lock
 */
async function withMutex(mutex, fn, skipIfLocked = false) {
    if (skipIfLocked) {
        const release = await mutex.tryAcquire();
        if (!release) {
            logger.debug(`[Mutex] Skipping ${mutex.name} - already locked`);
            return null;
        }
        try {
            return await fn();
        } finally {
            await release();
        }
    }

    const release = await mutex.acquire();
    try {
        return await fn();
    } finally {
        await release();
    }
}

// Pre-created mutexes for common operations
const mutexes = {};

function getMutex(name, redis = null) {
    if (!mutexes[name]) {
        mutexes[name] = new AsyncMutex(name, redis);
    }
    return mutexes[name];
}

module.exports = {
    AsyncMutex,
    withMutex,
    getMutex,
};
