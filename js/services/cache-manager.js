// Cache Manager - In-memory LRU cache with TTL, version counters, and diagnostics
//
// Core caching infrastructure for the Supabase cached egress layer.
// Provides O(1) lookup, LRU eviction, stale-while-revalidate support,
// invalidation version counters (prevents in-flight race conditions),
// and structuredClone on read (prevents reference mutation).
//
// Design reference: cache-manager.js in design.md
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.1, 7.2, 7.4

/**
 * @typedef {Object} CacheEntry
 * @property {*} data - The cached data
 * @property {number} createdAt - Timestamp when entry was stored
 * @property {number} ttl - Time-to-live in milliseconds
 * @property {number} lastAccessed - Timestamp of last access (for LRU)
 */

export class CacheManager {
  /**
   * @param {Object} options
   * @param {number} [options.maxEntries=200] - Maximum cache entries before LRU eviction
   * @param {boolean} [options.debug=false] - Enable debug logging to console
   */
  constructor(options = {}) {
    /** @type {Map<string, CacheEntry>} */
    this.store = new Map();

    /**
     * Invalidation version counters keyed by table prefix.
     * Each invalidateByPrefix call increments the version, allowing
     * CachedQueryBuilder to detect mid-flight invalidations and discard
     * stale fetch results (Design Issue 2 fix).
     * @type {Map<string, number>}
     */
    this.invalidationVersions = new Map();

    this.maxEntries = options.maxEntries ?? 200;
    this.debug = options.debug ?? false;

    // Statistics counters
    this._hits = 0;
    this._misses = 0;
    this._invalidations = 0;
    this._evictions = 0;
  }

  /**
   * Get a cached entry by key.
   *
   * Returns a deep clone of the data via structuredClone() to prevent
   * caller mutations from corrupting the cache (Design Issue 5 fix).
   *
   * If the entry exists but TTL has expired, returns { data, isStale: true }
   * so the caller can decide to serve stale or re-fetch (stale-while-revalidate).
   *
   * @param {string} key - Cache key
   * @returns {{ data: *, isStale: boolean } | null} Cloned data with staleness flag, or null
   */
  get(key) {
    const entry = this.store.get(key);

    if (!entry) {
      this._misses++;
      if (this.debug) {
        console.debug(`[Cache] MISS ${key}`);
      }
      return null;
    }

    const now = Date.now();
    const isStale = now > entry.createdAt + entry.ttl;

    // Update last accessed time for LRU tracking
    entry.lastAccessed = now;

    this._hits++;
    if (this.debug) {
      const ageMs = now - entry.createdAt;
      console.debug(
        `[Cache] ${isStale ? 'STALE' : 'HIT'} ${key} (age: ${Math.round(ageMs / 1000)}s, ttl: ${Math.round(entry.ttl / 1000)}s)`,
      );
    }

    return {
      data: structuredClone(entry.data),
      isStale,
    };
  }

  /**
   * Store data in the cache with a TTL.
   *
   * If maxEntries is exceeded, evicts the least-recently-used entry
   * (the one with the oldest lastAccessed timestamp).
   *
   * @param {string} key - Cache key
   * @param {*} data - Data to cache (stored by reference internally; cloned on read)
   * @param {number} ttlMs - Time-to-live in milliseconds
   */
  set(key, data, ttlMs) {
    // If updating an existing entry, delete first so Map ordering is refreshed
    if (this.store.has(key)) {
      this.store.delete(key);
    }

    // Evict LRU entry if at capacity
    if (this.store.size >= this.maxEntries) {
      this._evictLRU();
    }

    const now = Date.now();
    this.store.set(key, {
      data,
      createdAt: now,
      ttl: ttlMs,
      lastAccessed: now,
    });

    if (this.debug) {
      console.debug(`[Cache] SET ${key} (ttl: ${Math.round(ttlMs / 1000)}s)`);
    }
  }

  /**
   * Remove a specific cache entry.
   *
   * @param {string} key - Cache key to remove
   * @returns {boolean} True if the entry existed and was removed
   */
  delete(key) {
    const existed = this.store.delete(key);
    if (existed && this.debug) {
      console.debug(`[Cache] DELETE ${key}`);
    }
    return existed;
  }

  /**
   * Remove all entries whose key starts with the given prefix,
   * AND increment the invalidation version counter for that prefix.
   *
   * The version counter allows CachedQueryBuilder to detect whether
   * an invalidation occurred during an in-flight network fetch and
   * discard the result rather than caching stale data (Design Issue 2).
   *
   * @param {string} prefix - Key prefix to match (e.g., 'categories:')
   * @returns {number} Number of entries removed
   */
  invalidateByPrefix(prefix) {
    // Increment version BEFORE deleting entries
    const currentVersion = this.invalidationVersions.get(prefix) || 0;
    this.invalidationVersions.set(prefix, currentVersion + 1);

    let removed = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed++;
      }
    }

    this._invalidations++;

    if (this.debug) {
      console.debug(
        `[Cache] INVALIDATE prefix="${prefix}" (${removed} entries removed, version: ${currentVersion + 1})`,
      );
    }

    return removed;
  }

  /**
   * Get the current invalidation version for a prefix.
   *
   * Used by CachedQueryBuilder to snapshot the version before a fetch
   * and compare after the fetch completes.
   *
   * @param {string} prefix - Key prefix (e.g., 'categories:')
   * @returns {number} Current version (0 if never invalidated)
   */
  getVersion(prefix) {
    return this.invalidationVersions.get(prefix) || 0;
  }

  /**
   * Clear the entire cache and reset all version counters.
   * Called on logout to prevent data leakage between sessions.
   */
  clear() {
    this.store.clear();
    this.invalidationVersions.clear();
    this._hits = 0;
    this._misses = 0;
    this._invalidations = 0;
    this._evictions = 0;

    if (this.debug) {
      console.debug('[Cache] CLEAR — all entries and versions reset');
    }
  }

  /**
   * Return cache statistics.
   *
   * @returns {{ hits: number, misses: number, entries: number, invalidations: number, evictions: number, hitRate: number }}
   */
  getStats() {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      entries: this.store.size,
      invalidations: this._invalidations,
      evictions: this._evictions,
      hitRate: total > 0 ? this._hits / total : 0,
    };
  }

  /**
   * Return the full cache state for diagnostics.
   *
   * @returns {Array<{ key: string, age: number, ttl: number, stale: boolean, dataSize: number }>}
   */
  inspect() {
    const now = Date.now();
    const entries = [];

    for (const [key, entry] of this.store) {
      const ageMs = now - entry.createdAt;
      entries.push({
        key,
        age: Math.round(ageMs / 1000),
        ttl: Math.round(entry.ttl / 1000),
        stale: ageMs > entry.ttl,
        dataSize: _estimateSize(entry.data),
      });
    }

    return entries;
  }

  /**
   * Evict the least-recently-used entry (oldest lastAccessed).
   * @private
   */
  _evictLRU() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.store.delete(oldestKey);
      this._evictions++;

      if (this.debug) {
        console.debug(`[Cache] EVICT (LRU) ${oldestKey}`);
      }
    }
  }
}

/**
 * Rough size estimate for diagnostic purposes.
 * Not precise — just gives a ballpark for arrays/objects.
 *
 * @param {*} data
 * @returns {number} Estimated size in characters (rough proxy for bytes)
 */
function _estimateSize(data) {
  if (data == null) return 0;
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}

// Singleton instance — debug mode can be enabled via localStorage
const debugEnabled =
  typeof localStorage !== 'undefined' && localStorage.getItem('cache_debug') === 'true';

export const cacheManager = new CacheManager({ debug: debugEnabled });

// Debug utilities — exposed on window when debug mode is active
if (typeof window !== 'undefined' && debugEnabled) {
  window.__cacheDebug = {
    stats: () => cacheManager.getStats(),
    inspect: () => cacheManager.inspect(),
    clear: () => { cacheManager.clear(); console.info('[Cache] Manually cleared via __cacheDebug'); },
    setDebug: (enabled) => { cacheManager.debug = enabled; console.info(`[Cache] Debug mode ${enabled ? 'enabled' : 'disabled'}`); },
  };
  console.info('[Cache] Debug utilities available at window.__cacheDebug');
}
