// Cached Query Builder - Supabase PostgREST wrapper with tiered caching
//
// Provides a drop-in caching layer over Supabase's query builder. Queries
// are built using the same chainable API (.select, .eq, .order, etc.) but
// results are served from an in-memory cache when possible.
//
// Features:
//   - Tiered TTL (static / dynamic / reports)
//   - Request deduplication for identical in-flight queries
//   - Version-checked caching to prevent stale writes (Design Issue 2)
//   - Stale-while-revalidate for instant perceived performance
//   - Offline fallback using cached data when disconnected
//   - Edge Function response caching
//   - Group-based invalidation for related tables
//
// Design reference: cached-query.js in design.md

import { supabase } from './supabase-client.js';
import { cacheManager } from './cache-manager.js';
import { connectionStatus } from './realtime-service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tiered TTL configuration.
 * Each tier defines a TTL and the tables that belong to it.
 * Tables not listed in any tier fall back to the dynamic TTL.
 */
export const CACHE_TIERS = {
  static: {
    ttlMs: 5 * 60 * 1000, // 5 phút
    tables: ['categories', 'menu_items', 'ingredients', 'tables'],
  },
  dynamic: {
    ttlMs: 30 * 1000, // 30 giây
    tables: ['orders', 'order_items', 'bills', 'inventory'],
  },
  reports: {
    ttlMs: 2 * 60 * 1000, // 2 phút
    tables: [],
  },
};

/**
 * Groups of related tables that must be invalidated together.
 * When one table in a group is invalidated, all members are invalidated
 * to prevent cross-table staleness (e.g., orders and their items).
 */
export const INVALIDATION_GROUPS = {
  menu: ['categories', 'menu_items'],
  orders: ['orders', 'order_items'],
  stock: ['ingredients', 'inventory'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the TTL for a given table name by scanning CACHE_TIERS.
 * Falls back to the dynamic tier TTL if the table isn't explicitly listed.
 *
 * @param {string} tableName - Database table name
 * @returns {number} TTL in milliseconds
 */
export function getTtlForTable(tableName) {
  for (const tier of Object.values(CACHE_TIERS)) {
    if (tier.tables.includes(tableName)) {
      return tier.ttlMs;
    }
  }
  // Mặc định dùng TTL của tier dynamic
  return CACHE_TIERS.dynamic.ttlMs;
}

/**
 * Shared map of in-flight requests keyed by cache key.
 * Prevents duplicate network calls for the same query.
 * @type {Map<string, Promise<{data: *, error: *}>>}
 */
const inFlightRequests = new Map();

// ---------------------------------------------------------------------------
// CachedQueryBuilder
// ---------------------------------------------------------------------------

/**
 * Mirrors Supabase's PostgREST chainable API for SELECT queries while
 * adding transparent caching, deduplication, and offline support.
 *
 * Usage:
 * ```js
 * const { data, error } = await cachedSupabase.from('categories').select('*').eq('active', true);
 * ```
 *
 * The builder records each chained operation and replays them against the
 * real Supabase client only when a network fetch is needed.
 */
export class CachedQueryBuilder {
  /**
   * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
   * @param {import('./cache-manager.js').CacheManager} cacheMgr
   * @param {string} tableName
   */
  constructor(supabaseClient, cacheMgr, tableName) {
    this._supabase = supabaseClient;
    this._cache = cacheMgr;
    this._table = tableName;

    // Recorded query operations — replayed onto the real Supabase query
    this._selectColumns = '*';
    /** @type {Array<{type: string, column: string, value: *}>} */
    this._filters = [];
    /** @type {{column: string, options: Object} | null} */
    this._orderBy = null;
    /** @type {number | null} */
    this._limitCount = null;
    this._singleRow = false;
    this._maybeSingleRow = false;

    // Cache override options set via .cache()
    this._cacheOptions = {
      bypass: false,
      ttl: null,
      key: null,
    };
  }

  // -------------------------------------------------------------------------
  // Chainable methods
  // -------------------------------------------------------------------------

  /**
   * Specify which columns to retrieve.
   * @param {string} columns - Column selection string (e.g., '*, orders(*)' )
   * @returns {this}
   */
  select(columns = '*') {
    this._selectColumns = columns;
    return this;
  }

  /**
   * Add an equality filter.
   * @param {string} column - Column name
   * @param {*} value - Value to match
   * @returns {this}
   */
  eq(column, value) {
    this._filters.push({ type: 'eq', column, value });
    return this;
  }

  /**
   * Add an "in" filter (column value in array).
   * @param {string} column - Column name
   * @param {Array<*>} values - Array of allowed values
   * @returns {this}
   */
  in(column, values) {
    this._filters.push({ type: 'in', column, value: values });
    return this;
  }

  /**
   * Specify ordering.
   * @param {string} column - Column to order by
   * @param {Object} [options] - e.g., { ascending: false }
   * @returns {this}
   */
  order(column, options = {}) {
    this._orderBy = { column, options };
    return this;
  }

  /**
   * Limit the number of rows returned.
   * @param {number} count
   * @returns {this}
   */
  limit(count) {
    this._limitCount = count;
    return this;
  }

  /**
   * Expect exactly one row (error if 0 or >1).
   * @returns {this}
   */
  single() {
    this._singleRow = true;
    return this;
  }

  /**
   * Expect at most one row (null if 0, error if >1).
   * @returns {this}
   */
  maybeSingle() {
    this._maybeSingleRow = true;
    return this;
  }

  /**
   * Override cache behavior for this specific query.
   * @param {Object} options
   * @param {boolean} [options.bypass=false] - Skip cache entirely
   * @param {number}  [options.ttl] - Custom TTL in ms
   * @param {string}  [options.key] - Custom cache key
   * @returns {this}
   */
  cache(options = {}) {
    if (options.bypass !== undefined) this._cacheOptions.bypass = options.bypass;
    if (options.ttl !== undefined) this._cacheOptions.ttl = options.ttl;
    if (options.key !== undefined) this._cacheOptions.key = options.key;
    return this;
  }

  // -------------------------------------------------------------------------
  // Thenable interface — allows `await cachedSupabase.from('x').select('*')`
  // -------------------------------------------------------------------------

  /**
   * Makes the builder thenable so it can be awaited like a Supabase query.
   * Triggers the actual execute() call.
   *
   * @param {Function} resolve
   * @param {Function} reject
   */
  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  // -------------------------------------------------------------------------
  // Cache key generation
  // -------------------------------------------------------------------------

  /**
   * Build a deterministic cache key from the recorded query state.
   *
   * Format: {table}:{select}:{filters_sorted}:{order}:{limit}:{single|maybeSingle}
   *
   * Filters are sorted alphabetically by column name so that
   * `.eq('a',1).eq('b',2)` and `.eq('b',2).eq('a',1)` produce the same key.
   *
   * @returns {string}
   * @private
   */
  _buildCacheKey() {
    // Cho phép ghi đè key thủ công
    if (this._cacheOptions.key) {
      return this._cacheOptions.key;
    }

    const parts = [this._table, this._selectColumns];

    // Sắp xếp filters theo tên cột để đảm bảo tính xác định
    const sortedFilters = [...this._filters]
      .sort((a, b) => a.column.localeCompare(b.column))
      .map((f) => `${f.type}.${f.column}=${JSON.stringify(f.value)}`)
      .join(',');
    parts.push(sortedFilters || '_');

    // Order
    if (this._orderBy) {
      const dir = this._orderBy.options.ascending === false ? 'desc' : 'asc';
      parts.push(`${this._orderBy.column}.${dir}`);
    } else {
      parts.push('_');
    }

    // Limit
    parts.push(this._limitCount != null ? String(this._limitCount) : '_');

    // Single / maybeSingle
    if (this._singleRow) {
      parts.push('single');
    } else if (this._maybeSingleRow) {
      parts.push('maybeSingle');
    } else {
      parts.push('_');
    }

    return parts.join(':');
  }

  // -------------------------------------------------------------------------
  // Query replay — build the real Supabase query chain
  // -------------------------------------------------------------------------

  /**
   * Replay all recorded operations onto a real Supabase query builder.
   *
   * @returns {import('@supabase/supabase-js').PostgrestFilterBuilder}
   * @private
   */
  _buildSupabaseQuery() {
    let query = this._supabase.from(this._table).select(this._selectColumns);

    for (const filter of this._filters) {
      if (filter.type === 'eq') {
        query = query.eq(filter.column, filter.value);
      } else if (filter.type === 'in') {
        query = query.in(filter.column, filter.value);
      }
    }

    if (this._orderBy) {
      query = query.order(this._orderBy.column, this._orderBy.options);
    }

    if (this._limitCount != null) {
      query = query.limit(this._limitCount);
    }

    if (this._singleRow) {
      query = query.single();
    } else if (this._maybeSingleRow) {
      query = query.maybeSingle();
    }

    return query;
  }

  // -------------------------------------------------------------------------
  // Execute — main orchestration
  // -------------------------------------------------------------------------

  /**
   * Execute the query with cache lookup, deduplication, and offline fallback.
   *
   * Flow:
   * 1. Build cache key
   * 2. If bypass → skip to network
   * 3. Check cache: fresh hit → return, stale hit → return + background re-fetch
   * 4. Check dedup: if same key in-flight → return same promise
   * 5. Network fetch with version-checked caching
   * 6. On error → fallback to cache if available
   *
   * @returns {Promise<{data: *, error: *}>}
   */
  async execute() {
    const cacheKey = this._buildCacheKey();
    const ttl = this._cacheOptions.ttl ?? getTtlForTable(this._table);
    const tablePrefix = `${this._table}:`;

    // ----- Bước 1: Kiểm tra bypass cache -----
    if (!this._cacheOptions.bypass) {
      // ----- Bước 2: Đọc cache -----
      const cached = this._cache.get(cacheKey);

      if (cached && !cached.isStale) {
        // Fresh hit — trả kết quả ngay
        return { data: cached.data, error: null };
      }

      if (cached && cached.isStale) {
        // Stale-while-revalidate: trả dữ liệu cũ ngay lập tức,
        // đồng thời chạy re-fetch nền để cập nhật cache
        this._backgroundRevalidate(cacheKey, tablePrefix, ttl);
        return { data: cached.data, error: null };
      }
    }

    // ----- Bước 3: Kiểm tra request trùng lặp (dedup) -----
    if (inFlightRequests.has(cacheKey)) {
      return inFlightRequests.get(cacheKey);
    }

    // ----- Bước 4: Gọi mạng -----
    const fetchPromise = this._networkFetch(cacheKey, tablePrefix, ttl);

    // Đăng ký vào map dedup và dọn dẹp khi xong
    inFlightRequests.set(cacheKey, fetchPromise);
    fetchPromise.finally(() => {
      inFlightRequests.delete(cacheKey);
    });

    return fetchPromise;
  }

  /**
   * Perform the actual network fetch with version-checked caching
   * and offline/error fallback.
   *
   * @param {string} cacheKey
   * @param {string} tablePrefix - e.g., 'categories:'
   * @param {number} ttl - TTL in ms
   * @returns {Promise<{data: *, error: *}>}
   * @private
   */
  async _networkFetch(cacheKey, tablePrefix, ttl) {
    // Kiểm tra offline — nếu đang mất kết nối, dùng cache nếu có
    if (connectionStatus.state === 'disconnected') {
      const cached = this._cache.get(cacheKey);
      if (cached) {
        // Notify UI that cached data is being served while offline
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('cache:offline-served', { detail: { table: this._table } }));
        }
        return { data: cached.data, error: null, _fromCache: true };
      }
      return {
        data: null,
        error: { message: 'Không có kết nối mạng và không có dữ liệu trong cache' },
      };
    }

    // Snapshot version TRƯỚC khi gọi fetch (Design Issue 2)
    const versionBefore = this._cache.getVersion(tablePrefix);

    try {
      const query = this._buildSupabaseQuery();
      const { data, error } = await query;

      if (error) {
        // Lỗi mạng/server — thử fallback cache
        const cached = this._cache.get(cacheKey);
        if (cached) {
          console.warn(
            `[CachedQuery] Lỗi truy vấn ${this._table}, dùng cache fallback:`,
            error.message,
          );
          return { data: cached.data, error: null, _fromCache: true };
        }
        return { data, error };
      }

      // Kiểm tra version SAU fetch — chỉ lưu cache nếu không bị invalidate giữa chừng
      const versionAfter = this._cache.getVersion(tablePrefix);
      if (versionBefore === versionAfter) {
        this._cache.set(cacheKey, data, ttl);
      }

      return { data, error: null };
    } catch (err) {
      // Lỗi mạng (network error) — fallback cache
      const cached = this._cache.get(cacheKey);
      if (cached) {
        console.warn(
          `[CachedQuery] Lỗi mạng khi truy vấn ${this._table}, dùng cache fallback:`,
          err.message,
        );
        return { data: cached.data, error: null, _fromCache: true };
      }
      return {
        data: null,
        error: { message: err.message || 'Lỗi mạng không xác định' },
      };
    }
  }

  /**
   * Fire-and-forget background re-fetch for stale-while-revalidate.
   * Updates the cache if the version is still unchanged after fetch.
   *
   * @param {string} cacheKey
   * @param {string} tablePrefix
   * @param {number} ttl
   * @private
   */
  _backgroundRevalidate(cacheKey, tablePrefix, ttl) {
    // Không await — chạy nền
    this._networkFetch(cacheKey, tablePrefix, ttl).catch((err) => {
      console.warn('[CachedQuery] Background revalidate thất bại:', err.message);
    });
  }
}

// ---------------------------------------------------------------------------
// Edge Function Caching
// ---------------------------------------------------------------------------

/**
 * Create a cached wrapper around Supabase Edge Functions.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {import('./cache-manager.js').CacheManager} cacheMgr
 * @returns {{ invoke: (fnName: string, options?: Object) => Promise<{data: *, error: *}> }}
 */
function createCachedFunctions(supabaseClient, cacheMgr) {
  return {
    /**
     * Invoke an Edge Function with optional response caching.
     *
     * Pass `cache: { ttl, key }` in options to enable caching.
     * Default cache key: `fn:{fnName}:{JSON.stringify(body)}`
     *
     * @param {string} fnName - Edge Function name
     * @param {Object} [options] - Supabase invoke options + cache config
     * @param {Object} [options.body] - Request body
     * @param {Object} [options.cache] - Cache configuration
     * @param {number} [options.cache.ttl] - TTL in ms
     * @param {string} [options.cache.key] - Custom cache key
     * @returns {Promise<{data: *, error: *}>}
     */
    async invoke(fnName, options = {}) {
      const { cache: cacheOpts, ...invokeOptions } = options;

      // Nếu không có cache config, gọi trực tiếp
      if (!cacheOpts) {
        return supabaseClient.functions.invoke(fnName, invokeOptions);
      }

      const ttl = cacheOpts.ttl ?? CACHE_TIERS.reports.ttlMs;
      const cacheKey = cacheOpts.key ?? `fn:${fnName}:${JSON.stringify(invokeOptions.body ?? {})}`;

      // Kiểm tra cache
      const cached = cacheMgr.get(cacheKey);
      if (cached && !cached.isStale) {
        return { data: cached.data, error: null };
      }

      // Stale → trả ngay + revalidate nền
      if (cached && cached.isStale) {
        // Fire-and-forget revalidate
        supabaseClient.functions
          .invoke(fnName, invokeOptions)
          .then(({ data, error }) => {
            if (!error && data != null) {
              cacheMgr.set(cacheKey, data, ttl);
            }
          })
          .catch(() => {});
        return { data: cached.data, error: null };
      }

      // Cache miss — gọi mạng
      try {
        const { data, error } = await supabaseClient.functions.invoke(fnName, invokeOptions);

        if (!error && data != null) {
          cacheMgr.set(cacheKey, data, ttl);
        }

        return { data, error };
      } catch (err) {
        return {
          data: null,
          error: { message: err.message || 'Lỗi khi gọi Edge Function' },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a cached Supabase client that wraps the real client with caching.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {import('./cache-manager.js').CacheManager} cacheMgr
 * @returns {{
 *   from: (tableName: string) => CachedQueryBuilder,
 *   functions: { invoke: Function },
 *   invalidate: (tableName: string) => void
 * }}
 */
export function createCachedClient(supabaseClient, cacheMgr) {
  return {
    /**
     * Start building a cached query for the given table.
     * Drop-in replacement for `supabase.from(tableName)`.
     *
     * @param {string} tableName
     * @returns {CachedQueryBuilder}
     */
    from(tableName) {
      return new CachedQueryBuilder(supabaseClient, cacheMgr, tableName);
    },

    /**
     * Cached Edge Function invocation.
     */
    functions: createCachedFunctions(supabaseClient, cacheMgr),

    /**
     * Invalidate cache for a table and all related tables in its
     * INVALIDATION_GROUPS group.
     *
     * For example, invalidating 'orders' also invalidates 'order_items'.
     *
     * @param {string} tableName - Table name to invalidate
     */
    invalidate(tableName) {
      // Luôn invalidate bảng được chỉ định
      cacheMgr.invalidateByPrefix(`${tableName}:`);

      // Tìm và invalidate tất cả bảng trong cùng nhóm
      for (const groupMembers of Object.values(INVALIDATION_GROUPS)) {
        if (groupMembers.includes(tableName)) {
          for (const member of groupMembers) {
            if (member !== tableName) {
              cacheMgr.invalidateByPrefix(`${member}:`);
            }
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof createCachedClient>} */
export const cachedSupabase = createCachedClient(supabase, cacheManager);
