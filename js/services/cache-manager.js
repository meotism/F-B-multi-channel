// Cache Manager - In-memory LRU cache with TTL, localStorage persistence, and diagnostics
//
// Core caching infrastructure for the Supabase cached egress layer.
// Provides O(1) lookup, LRU eviction, stale-while-revalidate support,
// invalidation version counters (prevents in-flight race conditions),
// structuredClone on read (prevents reference mutation), and localStorage
// persistence for static-tier data (survives page refresh).
//
// Design reference: cache-manager.js in design.md
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.1, 7.2, 7.4

// ---------------------------------------------------------------------------
// localStorage persistence helpers
// ---------------------------------------------------------------------------

/** localStorage key prefix for persisted cache entries */
const LS_PREFIX = 'fb_cache:';

/**
 * Tables whose data should be persisted to localStorage.
 * These are "static" tier tables that change rarely and benefit from
 * surviving page refreshes. Dynamic data (orders, order_items, etc.)
 * is always fetched fresh and never persisted.
 */
const PERSIST_TABLES = new Set(['categories', 'menu_items', 'ingredients', 'tables']);

/**
 * Determine if a cache key belongs to a persistable table.
 * Cache keys have the format "tableName:rest_of_key".
 * @param {string} key - Cache key
 * @returns {boolean}
 */
function shouldPersist(key) {
  const colonIdx = key.indexOf(':');
  if (colonIdx < 0) return false;
  const tableName = key.substring(0, colonIdx);
  return PERSIST_TABLES.has(tableName);
}

// ---------------------------------------------------------------------------
// CacheManager
// ---------------------------------------------------------------------------

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
    this._writeThroughs = 0;

    // Hydrate in-memory cache from localStorage on construction.
    // Restores static-tier data after page refresh so the first
    // render can display cached data without waiting for network.
    this._hydrateFromLocalStorage();
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
   * Falls back to localStorage on in-memory miss (page refresh scenario).
   *
   * @param {string} key - Cache key
   * @returns {{ data: *, isStale: boolean } | null} Cloned data with staleness flag, or null
   */
  get(key) {
    let entry = this.store.get(key);

    if (!entry) {
      // Try localStorage fallback (page refresh scenario)
      const lsEntry = this._getFromLocalStorage(key);
      if (lsEntry) {
        // Restore to in-memory cache for subsequent fast access
        this.store.set(key, lsEntry);
        entry = lsEntry;
        if (this.debug) {
          console.debug(`[Cache] LS_RESTORE ${key}`);
        }
      } else {
        this._misses++;
        if (this.debug) {
          console.debug(`[Cache] MISS ${key}`);
        }
        return null;
      }
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
   * Static-tier entries are also persisted to localStorage.
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
    const entry = { data, createdAt: now, ttl: ttlMs, lastAccessed: now };
    this.store.set(key, entry);

    // Persist static-tier entries to localStorage for page-refresh survival
    this._persistToLocalStorage(key, entry);

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
    if (existed) {
      this._removeFromLocalStorage(key);
      if (this.debug) {
        console.debug(`[Cache] DELETE ${key}`);
      }
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

    // Also remove from localStorage
    this._invalidateLocalStorageByPrefix(prefix);

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
    this._writeThroughs = 0;

    // Clear all persisted cache entries from localStorage
    this._clearLocalStorage();

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
      writeThroughs: this._writeThroughs,
      hitRate: total > 0 ? this._hits / total : 0,
    };
  }

  /**
   * Scan all entries whose key starts with the given prefix and apply
   * an updater function to each entry's data in-place.
   *
   * The updater receives the current entry data and returns either:
   *   - The new data value (entry is replaced with fresh TTL)
   *   - undefined (entry is left unchanged)
   *   - null (entry should be deleted)
   *
   * Also increments the invalidation version counter for the prefix,
   * so in-flight fetches that started before this call will not
   * overwrite the freshly-updated entries.
   *
   * @param {string} prefix - Key prefix to match (e.g., 'categories:')
   * @param {function(*): *|undefined|null} updateFn - Updater function
   * @param {number} ttlMs - TTL to apply to updated entries
   * @returns {number} Number of entries that were updated
   */
  updateByPrefix(prefix, updateFn, ttlMs) {
    // Increment version BEFORE updating entries (same as invalidateByPrefix)
    const currentVersion = this.invalidationVersions.get(prefix) || 0;
    this.invalidationVersions.set(prefix, currentVersion + 1);

    let updated = 0;
    const toDelete = [];

    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        const newData = updateFn(entry.data);
        if (newData === null) {
          // Signal deletion
          toDelete.push(key);
          updated++;
        } else if (newData !== undefined) {
          entry.data = newData;
          entry.createdAt = Date.now();
          entry.ttl = ttlMs;
          entry.lastAccessed = Date.now();
          updated++;
        }
      }
    }

    // Delete entries marked for removal
    for (const key of toDelete) {
      this.store.delete(key);
      this._removeFromLocalStorage(key);
    }

    // Re-persist updated entries to localStorage
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        this._persistToLocalStorage(key, entry);
      }
    }

    this._writeThroughs++;

    if (this.debug) {
      console.debug(
        `[Cache] WRITE_THROUGH prefix="${prefix}" (${updated} entries updated, ${toDelete.length} deleted, version: ${currentVersion + 1})`,
      );
    }

    return updated;
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

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

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
      this._removeFromLocalStorage(oldestKey);
      this._evictions++;

      if (this.debug) {
        console.debug(`[Cache] EVICT (LRU) ${oldestKey}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // localStorage persistence
  // -------------------------------------------------------------------------

  /**
   * Restore persisted cache entries from localStorage into the in-memory Map.
   * Only loads entries that haven't expired (TTL check).
   * Silently skips corrupt or unparseable entries.
   * @private
   */
  _hydrateFromLocalStorage() {
    if (typeof localStorage === 'undefined') return;

    const now = Date.now();
    let hydrated = 0;

    try {
      // Collect keys first to avoid issues with iteration during removal
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const lsKey = localStorage.key(i);
        if (lsKey && lsKey.startsWith(LS_PREFIX)) keys.push(lsKey);
      }

      for (const lsKey of keys) {
        const cacheKey = lsKey.slice(LS_PREFIX.length);

        try {
          const raw = localStorage.getItem(lsKey);
          if (!raw) continue;

          const entry = JSON.parse(raw);

          // Skip expired entries; remove them from localStorage
          if (now > entry.createdAt + entry.ttl) {
            localStorage.removeItem(lsKey);
            continue;
          }

          // Restore into in-memory Map
          entry.lastAccessed = now;
          this.store.set(cacheKey, entry);
          hydrated++;
        } catch {
          // Corrupt entry — remove it
          localStorage.removeItem(lsKey);
        }
      }
    } catch (err) {
      // localStorage access may fail in certain contexts (private browsing quota, etc.)
      if (this.debug) {
        console.warn('[Cache] localStorage hydration failed:', err.message);
      }
    }

    if (this.debug && hydrated > 0) {
      console.debug(`[Cache] Hydrated ${hydrated} entries from localStorage`);
    }
  }

  /**
   * Try to read a cache entry from localStorage.
   * @param {string} key - Cache key
   * @returns {CacheEntry|null}
   * @private
   */
  _getFromLocalStorage(key) {
    if (typeof localStorage === 'undefined') return null;
    if (!shouldPersist(key)) return null;

    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (!raw) return null;

      const entry = JSON.parse(raw);
      entry.lastAccessed = Date.now();
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Write a cache entry to localStorage if it belongs to a persistable table.
   * Handles quota errors gracefully by evicting the oldest persisted entries.
   * @param {string} key - Cache key
   * @param {{ data: *, createdAt: number, ttl: number }} entry - Entry to persist
   * @private
   */
  _persistToLocalStorage(key, entry) {
    if (typeof localStorage === 'undefined') return;
    if (!shouldPersist(key)) return;

    const lsKey = LS_PREFIX + key;
    // Only persist data, createdAt, and ttl (not lastAccessed — transient)
    const serialized = JSON.stringify({
      data: entry.data,
      createdAt: entry.createdAt,
      ttl: entry.ttl,
    });

    try {
      localStorage.setItem(lsKey, serialized);
    } catch (err) {
      // QuotaExceededError — try to free space
      if (err.name === 'QuotaExceededError') {
        this._evictLocalStorageEntries(3);
        try {
          localStorage.setItem(lsKey, serialized);
        } catch {
          // Still failed — give up silently; in-memory cache still works
          if (this.debug) {
            console.warn('[Cache] localStorage quota exceeded, could not persist:', key);
          }
        }
      }
    }
  }

  /**
   * Remove a single cache entry from localStorage.
   * @param {string} key - Cache key
   * @private
   */
  _removeFromLocalStorage(key) {
    if (typeof localStorage === 'undefined') return;
    if (!shouldPersist(key)) return;

    try {
      localStorage.removeItem(LS_PREFIX + key);
    } catch {
      // Ignore — not critical
    }
  }

  /**
   * Remove all persisted cache entries whose key starts with the given prefix.
   * @param {string} prefix - Key prefix to match
   * @private
   */
  _invalidateLocalStorageByPrefix(prefix) {
    if (typeof localStorage === 'undefined') return;

    const lsPrefix = LS_PREFIX + prefix;
    const toRemove = [];

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const lsKey = localStorage.key(i);
        if (lsKey && lsKey.startsWith(lsPrefix)) {
          toRemove.push(lsKey);
        }
      }

      for (const lsKey of toRemove) {
        localStorage.removeItem(lsKey);
      }
    } catch {
      // Ignore — not critical
    }
  }

  /**
   * Remove all cache entries from localStorage (entries prefixed with fb_cache:).
   * @private
   */
  _clearLocalStorage() {
    if (typeof localStorage === 'undefined') return;

    const toRemove = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const lsKey = localStorage.key(i);
        if (lsKey && lsKey.startsWith(LS_PREFIX)) {
          toRemove.push(lsKey);
        }
      }

      for (const lsKey of toRemove) {
        localStorage.removeItem(lsKey);
      }
    } catch {
      // Ignore — not critical
    }
  }

  /**
   * Remove the oldest N persisted cache entries from localStorage to free space.
   * @param {number} count - Number of entries to evict
   * @private
   */
  _evictLocalStorageEntries(count) {
    if (typeof localStorage === 'undefined') return;

    const entries = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const lsKey = localStorage.key(i);
        if (lsKey && lsKey.startsWith(LS_PREFIX)) {
          try {
            const raw = localStorage.getItem(lsKey);
            const parsed = JSON.parse(raw);
            entries.push({ lsKey, createdAt: parsed.createdAt || 0 });
          } catch {
            // Corrupt — remove immediately
            localStorage.removeItem(lsKey);
            count--;
          }
        }
      }

      // Sort oldest first and remove
      entries.sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 0; i < Math.min(count, entries.length); i++) {
        localStorage.removeItem(entries[i].lsKey);
      }
    } catch {
      // Ignore — not critical
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
