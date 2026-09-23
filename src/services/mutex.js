/**
 * Mutex Service
 * Provides async-safe locking mechanisms for preventing race conditions
 * v13.0 - Added for race condition fixes
 * v25.21 - Added configurable timeout to tryAcquire and auto-release safety
 * v30.2 - Locks are now actually distributed.
 *
 * Every mutex used to be created with `getMutex(name)` and no Redis client, so every lock
 * silently took the in-memory branch and only excluded callers in the same process. That
 * mattered because the admin buttons run in the API process while the scheduled jobs run in
 * the worker: "Run fee claim" could overlap the worker's own claim, both measure the same
 * vault drain, and both credit it -- promising holders SOL that was only collected once.
 *
 * The Redis connection is now resolved when a lock is taken rather than when the mutex is
 * constructed (mutexes are module-level constants, created before Redis connects), and a held
 * lock is renewed in the background so a long run -- an airdrop to thousands of holders --
 * cannot outlive its TTL and let a second process in halfway through.
 */
const logger = require('./logger');

const DEFAULT_LOCK_TIMEOUT_MS = 300000;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const UNAVAILABLE = Symbol('redis-unavailable');

/**
 * The shared Redis connection. Required lazily: redis.js is initialised after this module
 * loads. Returns null when the process has no Redis at all (scripts, tests), and UNAVAILABLE
 * when Redis is configured but currently disconnected.
 */
function currentRedis(explicit) {
    if (explicit) return explicit;
    try {
        const r = require('./redis');
        const conn = r.getConnection && r.getConnection();
        if (!conn) return null;
        return r.isRedisConnected && !r.isRedisConnected() ? UNAVAILABLE : conn;
    } catch (e) {
        return null;
    }
}

class AsyncMutex {
    constructor(name, redis = null) {
        this.name = name;
        this.redis = redis;
        this._localLock = false;
        this._localLockTimeout = null;
    }

    /**
     * Hold `lockKey` in Redis until the returned release function runs, renewing the TTL at a
     * third of its length so the lock survives however long the holder takes. If renewal
     * discovers the lock was lost (Redis restarted, or it genuinely expired), that is logged:
     * the holder cannot be stopped mid-flight, but the event should never be silent.
     */
    _holdRedis(redis, lockKey, lockId, lockTimeoutMs) {
        const renew = setInterval(async () => {
            try {
                const ok = await redis.eval(RENEW_SCRIPT, 1, lockKey, lockId, String(lockTimeoutMs));
                if (!ok) logger.warn(`[Mutex] Lost lock ${this.name} while still holding it`);
            } catch (e) {
                logger.debug(`[Mutex] Renew failed for ${this.name}`, { error: e.message });
            }
        }, Math.max(1000, Math.floor(lockTimeoutMs / 3)));
        renew.unref();

        let released = false;
        return async () => {
            if (released) return;
            released = true;
            clearInterval(renew);
            try {
                if (await redis.eval(RELEASE_SCRIPT, 1, lockKey, lockId)) {
                    logger.debug(`[Mutex] Released lock: ${this.name}`);
                }
            } catch (e) {
                // The TTL will clear it; nothing else can be done here.
                logger.debug(`[Mutex] Release failed for ${this.name}`, { error: e.message });
            }
        };
    }

    /**
     * Acquire the lock - returns a release function
     * If lock is already held, waits until it's released
     */
    async acquire(timeoutMs = 60000, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const release = await this.tryAcquire(lockTimeoutMs);
            if (release) return release;
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error(`[Mutex] Timeout acquiring lock: ${this.name}`);
    }

    /**
     * Try to acquire lock without waiting
     * Returns release function if successful, null otherwise
     * @param {number} lockTimeoutMs - TTL of the lock; renewed while held
     */
    async tryAcquire(lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
        const lockKey = `mutex:${this.name}`;
        const redis = currentRedis(this.redis);

        // Redis is configured but down. Refuse rather than fall back to a local lock: a
        // local lock is exactly what let two processes run the same money path at once, and
        // skipping one cycle is harmless.
        if (redis === UNAVAILABLE) {
            logger.warn(`[Mutex] Redis disconnected, not acquiring ${this.name}`);
            return null;
        }

        if (redis) {
            const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2)}`;
            let result;
            try {
                result = await redis.set(lockKey, lockId, 'NX', 'PX', lockTimeoutMs);
            } catch (e) {
                logger.warn(`[Mutex] Redis unavailable, not acquiring ${this.name}`, { error: e.message });
                return null;
            }
            if (result !== 'OK') return null;
            logger.debug(`[Mutex] Acquired Redis lock: ${this.name}`);
            return this._holdRedis(redis, lockKey, lockId, lockTimeoutMs);
        }

        // In-memory fallback (no Redis at all, e.g. scripts and tests).
        if (this._localLock) return null;
        this._localLock = true;
        if (this._localLockTimeout) clearTimeout(this._localLockTimeout);
        this._localLockTimeout = setTimeout(() => {
            if (this._localLock) {
                logger.warn(`[Mutex] Auto-releasing stale lock: ${this.name} after ${lockTimeoutMs}ms`);
                this._localLock = false;
            }
        }, lockTimeoutMs);
        this._localLockTimeout.unref();

        logger.debug(`[Mutex] Acquired local lock: ${this.name}`);
        return () => {
            this._localLock = false;
            if (this._localLockTimeout) {
                clearTimeout(this._localLockTimeout);
                this._localLockTimeout = null;
            }
        };
    }

    /**
     * Check if lock is currently held (for read-only checks)
     */
    async isLocked() {
        const redis = currentRedis(this.redis);
        if (redis === UNAVAILABLE) return true;
        if (redis) {
            const result = await redis.get(`mutex:${this.name}`);
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
    const release = skipIfLocked ? await mutex.tryAcquire() : await mutex.acquire();
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
