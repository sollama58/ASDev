/**
 * Mutex Service
 * Provides async-safe locking mechanisms for preventing race conditions
 * v13.0 - Added for race condition fixes
 */
const logger = require('./logger');

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
    }

    /**
     * Acquire the lock - returns a release function
     * If lock is already held, waits until it's released
     */
    async acquire(timeoutMs = 60000) {
        const lockKey = `mutex:${this.name}`;
        const startTime = Date.now();

        // Try Redis-based lock first for distributed locking
        if (this.redis) {
            const lockId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

            while (Date.now() - startTime < timeoutMs) {
                // Try to set lock with NX (only if not exists) and EX (expiry)
                const result = await this.redis.set(lockKey, lockId, 'NX', 'PX', timeoutMs);

                if (result === 'OK') {
                    logger.debug(`[Mutex] Acquired lock: ${this.name}`);
                    return async () => {
                        // Only release if we still own the lock
                        const currentValue = await this.redis.get(lockKey);
                        if (currentValue === lockId) {
                            await this.redis.del(lockKey);
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
     */
    async tryAcquire() {
        const lockKey = `mutex:${this.name}`;

        if (this.redis) {
            const lockId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const result = await this.redis.set(lockKey, lockId, 'NX', 'PX', 60000);

            if (result === 'OK') {
                return async () => {
                    const currentValue = await this.redis.get(lockKey);
                    if (currentValue === lockId) {
                        await this.redis.del(lockKey);
                    }
                };
            }
            return null;
        }

        // In-memory fallback
        if (this._localLock) {
            return null;
        }

        this._localLock = true;
        return () => {
            this._localLock = false;
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
