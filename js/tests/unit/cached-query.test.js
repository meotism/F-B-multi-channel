// Unit tests for CachedQueryBuilder + createCachedClient
//
// Tests cache key generation, cache hit/miss, stale-while-revalidate,
// version-checked caching, bypass, request deduplication, offline fallback,
// group invalidation, and Edge Function caching.
//
// Usage (Node >= 18):
//   node js/tests/unit/cached-query.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as cache-manager.test.js)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  if (!ok) {
    message += ` (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`;
  }
  assert(ok, message);
}

function describe(name, fn) {
  console.log(`\n${name}`);
  const result = fn();
  // If fn returns a promise, attach error handler
  if (result && typeof result.then === 'function') {
    return result.catch((err) => {
      failed++;
      console.error(`  FAIL: ${name} threw: ${err.message}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Inline CacheManager (copied from cache-manager.test.js)
// ---------------------------------------------------------------------------

class CacheManager {
  constructor(options = {}) {
    this.store = new Map();
    this.invalidationVersions = new Map();
    this.maxEntries = options.maxEntries ?? 200;
    this.debug = options.debug ?? false;
    this._hits = 0;
    this._misses = 0;
    this._invalidations = 0;
    this._evictions = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this._misses++;
      return null;
    }
    const now = Date.now();
    const isStale = now > entry.createdAt + entry.ttl;
    entry.lastAccessed = now;
    this._hits++;
    return {
      data: structuredClone(entry.data),
      isStale,
    };
  }

  set(key, data, ttlMs) {
    if (this.store.has(key)) {
      this.store.delete(key);
    }
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
  }

  delete(key) {
    return this.store.delete(key);
  }

  invalidateByPrefix(prefix) {
    const currentVersion = this.invalidationVersions.get(prefix) || 0;
    this.invalidationVersions.set(prefix, currentVersion + 1);
    let removed = 0;
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        removed++;
      }
    }
    this._invalidations++;
    return removed;
  }

  getVersion(prefix) {
    return this.invalidationVersions.get(prefix) || 0;
  }

  clear() {
    this.store.clear();
    this.invalidationVersions.clear();
    this._hits = 0;
    this._misses = 0;
    this._invalidations = 0;
    this._evictions = 0;
  }

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
    }
  }
}

// ---------------------------------------------------------------------------
// Inline constants from cached-query.js
// ---------------------------------------------------------------------------

const CACHE_TIERS = {
  static: {
    ttlMs: 5 * 60 * 1000,
    tables: ['categories', 'menu_items', 'ingredients', 'tables'],
  },
  dynamic: {
    ttlMs: 30 * 1000,
    tables: ['orders', 'order_items', 'bills', 'inventory'],
  },
  reports: {
    ttlMs: 2 * 60 * 1000,
    tables: [],
  },
};

const INVALIDATION_GROUPS = {
  menu: ['categories', 'menu_items'],
  orders: ['orders', 'order_items'],
  stock: ['ingredients', 'inventory'],
};

function getTtlForTable(tableName) {
  for (const tier of Object.values(CACHE_TIERS)) {
    if (tier.tables.includes(tableName)) {
      return tier.ttlMs;
    }
  }
  return CACHE_TIERS.dynamic.ttlMs;
}

// ---------------------------------------------------------------------------
// Inline CachedQueryBuilder (from cached-query.js)
// ---------------------------------------------------------------------------

// Per-test in-flight map (scoped so tests don't interfere)
const inFlightRequests = new Map();

class CachedQueryBuilder {
  constructor(supabaseClient, cacheMgr, tableName, connStatus) {
    this._supabase = supabaseClient;
    this._cache = cacheMgr;
    this._table = tableName;
    this._connectionStatus = connStatus;

    this._selectColumns = '*';
    this._filters = [];
    this._orderBy = null;
    this._limitCount = null;
    this._singleRow = false;
    this._maybeSingleRow = false;

    this._cacheOptions = {
      bypass: false,
      ttl: null,
      key: null,
    };
  }

  select(columns = '*') {
    this._selectColumns = columns;
    return this;
  }

  eq(column, value) {
    this._filters.push({ type: 'eq', column, value });
    return this;
  }

  in(column, values) {
    this._filters.push({ type: 'in', column, value: values });
    return this;
  }

  order(column, options = {}) {
    this._orderBy = { column, options };
    return this;
  }

  limit(count) {
    this._limitCount = count;
    return this;
  }

  single() {
    this._singleRow = true;
    return this;
  }

  maybeSingle() {
    this._maybeSingleRow = true;
    return this;
  }

  cache(options = {}) {
    if (options.bypass !== undefined) this._cacheOptions.bypass = options.bypass;
    if (options.ttl !== undefined) this._cacheOptions.ttl = options.ttl;
    if (options.key !== undefined) this._cacheOptions.key = options.key;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  _buildCacheKey() {
    if (this._cacheOptions.key) {
      return this._cacheOptions.key;
    }
    const parts = [this._table, this._selectColumns];

    const sortedFilters = [...this._filters]
      .sort((a, b) => a.column.localeCompare(b.column))
      .map((f) => `${f.type}.${f.column}=${JSON.stringify(f.value)}`)
      .join(',');
    parts.push(sortedFilters || '_');

    if (this._orderBy) {
      const dir = this._orderBy.options.ascending === false ? 'desc' : 'asc';
      parts.push(`${this._orderBy.column}.${dir}`);
    } else {
      parts.push('_');
    }

    parts.push(this._limitCount != null ? String(this._limitCount) : '_');

    if (this._singleRow) {
      parts.push('single');
    } else if (this._maybeSingleRow) {
      parts.push('maybeSingle');
    } else {
      parts.push('_');
    }

    return parts.join(':');
  }

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

  async execute() {
    const cacheKey = this._buildCacheKey();
    const ttl = this._cacheOptions.ttl ?? getTtlForTable(this._table);
    const tablePrefix = `${this._table}:`;

    if (!this._cacheOptions.bypass) {
      const cached = this._cache.get(cacheKey);

      if (cached && !cached.isStale) {
        return { data: cached.data, error: null };
      }

      if (cached && cached.isStale) {
        this._backgroundRevalidate(cacheKey, tablePrefix, ttl);
        return { data: cached.data, error: null };
      }
    }

    if (inFlightRequests.has(cacheKey)) {
      return inFlightRequests.get(cacheKey);
    }

    const fetchPromise = this._networkFetch(cacheKey, tablePrefix, ttl);

    inFlightRequests.set(cacheKey, fetchPromise);
    fetchPromise.finally(() => {
      inFlightRequests.delete(cacheKey);
    });

    return fetchPromise;
  }

  async _networkFetch(cacheKey, tablePrefix, ttl) {
    if (this._connectionStatus.state === 'disconnected') {
      const cached = this._cache.get(cacheKey);
      if (cached) {
        return { data: cached.data, error: null, _fromCache: true };
      }
      return {
        data: null,
        error: { message: 'No network and no cached data' },
      };
    }

    const versionBefore = this._cache.getVersion(tablePrefix);

    try {
      const query = this._buildSupabaseQuery();
      const { data, error } = await query;

      if (error) {
        const cached = this._cache.get(cacheKey);
        if (cached) {
          return { data: cached.data, error: null, _fromCache: true };
        }
        return { data, error };
      }

      const versionAfter = this._cache.getVersion(tablePrefix);
      if (versionBefore === versionAfter) {
        this._cache.set(cacheKey, data, ttl);
      }

      return { data, error: null };
    } catch (err) {
      const cached = this._cache.get(cacheKey);
      if (cached) {
        return { data: cached.data, error: null, _fromCache: true };
      }
      return {
        data: null,
        error: { message: err.message || 'Unknown network error' },
      };
    }
  }

  _backgroundRevalidate(cacheKey, tablePrefix, ttl) {
    this._networkFetch(cacheKey, tablePrefix, ttl).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Inline createCachedClient (from cached-query.js)
// ---------------------------------------------------------------------------

function createCachedFunctions(supabaseClient, cacheMgr) {
  return {
    async invoke(fnName, options = {}) {
      const { cache: cacheOpts, ...invokeOptions } = options;

      if (!cacheOpts) {
        return supabaseClient.functions.invoke(fnName, invokeOptions);
      }

      const ttl = cacheOpts.ttl ?? CACHE_TIERS.reports.ttlMs;
      const cacheKey = cacheOpts.key ?? `fn:${fnName}:${JSON.stringify(invokeOptions.body ?? {})}`;

      const cached = cacheMgr.get(cacheKey);
      if (cached && !cached.isStale) {
        return { data: cached.data, error: null };
      }

      if (cached && cached.isStale) {
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

      try {
        const { data, error } = await supabaseClient.functions.invoke(fnName, invokeOptions);
        if (!error && data != null) {
          cacheMgr.set(cacheKey, data, ttl);
        }
        return { data, error };
      } catch (err) {
        return {
          data: null,
          error: { message: err.message || 'Edge Function error' },
        };
      }
    },
  };
}

function createCachedClient(supabaseClient, cacheMgr, connStatus) {
  return {
    from(tableName) {
      return new CachedQueryBuilder(supabaseClient, cacheMgr, tableName, connStatus);
    },
    functions: createCachedFunctions(supabaseClient, cacheMgr),
    invalidate(tableName) {
      cacheMgr.invalidateByPrefix(`${tableName}:`);
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
// Mock Supabase client factory
// ---------------------------------------------------------------------------

function createMockSupabase(mockData = [], mockError = null) {
  let callCount = 0;
  const lastQuery = {};

  const createBuilder = () => {
    const builder = {
      select: (cols) => { lastQuery.select = cols; return builder; },
      eq: (col, val) => { lastQuery.eq = lastQuery.eq || []; lastQuery.eq.push([col, val]); return builder; },
      in: (col, vals) => { lastQuery.in = [col, vals]; return builder; },
      order: (col, opts) => { lastQuery.order = [col, opts]; return builder; },
      limit: (n) => { lastQuery.limit = n; return builder; },
      single: () => { lastQuery.single = true; return builder; },
      maybeSingle: () => { lastQuery.maybeSingle = true; return builder; },
      then: (resolve, reject) => {
        callCount++;
        return Promise.resolve({ data: mockData, error: mockError }).then(resolve, reject);
      },
    };
    return builder;
  };

  return {
    from: (table) => {
      lastQuery.table = table;
      // Reset per-query state (keep callCount)
      delete lastQuery.select;
      delete lastQuery.eq;
      delete lastQuery.in;
      delete lastQuery.order;
      delete lastQuery.limit;
      delete lastQuery.single;
      delete lastQuery.maybeSingle;
      const builder = createBuilder();
      return { select: builder.select };
    },
    functions: {
      invoke: async (fn, opts) => {
        callCount++;
        return { data: { fn, ...(opts?.body ?? {}) }, error: null };
      },
    },
    getCallCount: () => callCount,
    getLastQuery: () => lastQuery,
    reset: () => {
      callCount = 0;
      Object.keys(lastQuery).forEach((k) => delete lastQuery[k]);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {

  // Test 1: Cache key generation is deterministic
  describe('CachedQueryBuilder - cache key is deterministic for identical queries', () => {
    const cm = new CacheManager();
    const mock = createMockSupabase();
    const connStatus = { state: 'connected' };

    const b1 = new CachedQueryBuilder(mock, cm, 'categories', connStatus);
    b1.select('*').eq('active', true);

    const b2 = new CachedQueryBuilder(mock, cm, 'categories', connStatus);
    b2.select('*').eq('active', true);

    assertEqual(b1._buildCacheKey(), b2._buildCacheKey(), 'identical queries produce the same cache key');
  });

  // Test 2: Cache key includes all chain params
  describe('CachedQueryBuilder - cache key includes all chain params', () => {
    const cm = new CacheManager();
    const mock = createMockSupabase();
    const connStatus = { state: 'connected' };

    const b = new CachedQueryBuilder(mock, cm, 'orders', connStatus);
    b.select('id, total')
      .eq('status', 'paid')
      .in('table_id', [1, 2])
      .order('created_at', { ascending: false })
      .limit(10)
      .single();

    const key = b._buildCacheKey();
    assert(key.includes('orders'), 'key includes table name');
    assert(key.includes('id, total'), 'key includes select columns');
    assert(key.includes('eq.status'), 'key includes eq filter');
    assert(key.includes('in.table_id'), 'key includes in filter');
    assert(key.includes('created_at.desc'), 'key includes order');
    assert(key.includes('10'), 'key includes limit');
    assert(key.includes('single'), 'key includes single flag');
  });

  // Test 3: Filter order independence
  describe('CachedQueryBuilder - filter order independence', () => {
    const cm = new CacheManager();
    const mock = createMockSupabase();
    const connStatus = { state: 'connected' };

    const b1 = new CachedQueryBuilder(mock, cm, 'orders', connStatus);
    b1.select('*').eq('a', 1).eq('b', 2);

    const b2 = new CachedQueryBuilder(mock, cm, 'orders', connStatus);
    b2.select('*').eq('b', 2).eq('a', 1);

    assertEqual(b1._buildCacheKey(), b2._buildCacheKey(), 'eq(a,1).eq(b,2) same key as eq(b,2).eq(a,1)');
  });

  // Test 4: Cache hit returns cached data without network call
  await describe('CachedQueryBuilder - cache hit returns cached data without network call', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase([{ id: 1, name: 'Tea' }]);
    const connStatus = { state: 'connected' };

    // First call: cache miss, hits network
    const q1 = new CachedQueryBuilder(mock, cm, 'categories', connStatus);
    const r1 = await q1.select('*').execute();
    assertEqual(mock.getCallCount(), 1, 'first call makes a network request');
    assertEqual(r1.data.length, 1, 'first call returns data');

    // Second call: cache hit, no network call
    mock.reset(); // reset callCount but cache still has data
    // Need to reset callCount only - we cannot call mock.reset() because it clears lastQuery too
    // Actually reset is fine, we just need callCount back to 0
    const q2 = new CachedQueryBuilder(mock, cm, 'categories', connStatus);
    const r2 = await q2.select('*').execute();
    assertEqual(mock.getCallCount(), 0, 'second call does NOT make a network request (cache hit)');
    assertEqual(r2.data.length, 1, 'second call returns cached data');
    assertEqual(r2.error, null, 'no error on cache hit');
  });

  // Test 5: Cache miss makes network call and stores result
  await describe('CachedQueryBuilder - cache miss makes network call and stores result', async () => {
    const cm = new CacheManager();
    const mockData = [{ id: 1 }, { id: 2 }];
    const mock = createMockSupabase(mockData);
    const connStatus = { state: 'connected' };

    const q = new CachedQueryBuilder(mock, cm, 'menu_items', connStatus);
    q.select('*');
    const key = q._buildCacheKey();

    // Before call: cache is empty
    assert(cm.get(key) === null, 'cache is empty before first call');

    const result = await q.execute();
    assertEqual(result.data.length, 2, 'network returns 2 items');
    assertEqual(mock.getCallCount(), 1, 'one network call made');

    // After call: cache has data
    const cached = cm.get(key);
    assert(cached !== null, 'data is stored in cache after network call');
    assertEqual(cached.data.length, 2, 'cached data matches network response');
  });

  // Test 6: Stale-while-revalidate returns stale data immediately
  await describe('CachedQueryBuilder - stale-while-revalidate returns stale data immediately', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase([{ id: 99, name: 'Fresh' }]);
    const connStatus = { state: 'connected' };

    // Manually insert a stale cache entry
    const q = new CachedQueryBuilder(mock, cm, 'categories', connStatus);
    q.select('*');
    const key = q._buildCacheKey();

    cm.store.set(key, {
      data: [{ id: 1, name: 'Stale' }],
      createdAt: Date.now() - 600000, // 10 minutes ago
      ttl: 300000,                     // 5 min TTL - expired
      lastAccessed: Date.now() - 600000,
    });

    const result = await q.execute();
    assertEqual(result.data[0].name, 'Stale', 'stale data is returned immediately');
    assertEqual(result.error, null, 'no error on stale-while-revalidate');

    // Give background revalidate a tick to fire
    await new Promise((r) => setTimeout(r, 50));
    assertEqual(mock.getCallCount(), 1, 'background revalidation triggered a network call');
  });

  // Test 7: Version check prevents caching if invalidation happened mid-flight
  await describe('CachedQueryBuilder - version check prevents caching on mid-flight invalidation', async () => {
    const cm = new CacheManager();
    const connStatus = { state: 'connected' };

    // Create a mock that invalidates the cache mid-flight (simulates realtime event)
    let callCount = 0;
    const mockWithInvalidation = {
      from: (table) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          single: () => builder,
          maybeSingle: () => builder,
          then: (resolve, reject) => {
            callCount++;
            // Simulate invalidation happening DURING the fetch
            cm.invalidateByPrefix('orders:');
            return Promise.resolve({ data: [{ id: 'stale-from-network' }], error: null }).then(resolve, reject);
          },
        };
        return { select: () => builder };
      },
    };

    const q = new CachedQueryBuilder(mockWithInvalidation, cm, 'orders', connStatus);
    q.select('*');
    const key = q._buildCacheKey();

    const result = await q.execute();
    assertEqual(result.data[0].id, 'stale-from-network', 'data is still returned to caller');

    // But it should NOT have been cached because version changed mid-flight
    const cached = cm.get(key);
    assert(cached === null, 'result NOT cached because invalidation happened mid-flight');
  });

  // Test 8: Cache bypass always fetches from network
  await describe('CachedQueryBuilder - cache bypass always fetches from network', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase([{ id: 'fresh' }]);
    const connStatus = { state: 'connected' };

    // Pre-populate cache
    const q1 = new CachedQueryBuilder(mock, cm, 'categories', connStatus);
    q1.select('*');
    const key = q1._buildCacheKey();
    cm.set(key, [{ id: 'cached' }], 300000);

    mock.reset();

    // Query with bypass
    const q2 = new CachedQueryBuilder(mock, cm, 'categories', connStatus);
    q2.select('*').cache({ bypass: true });
    const result = await q2.execute();

    assertEqual(mock.getCallCount(), 1, 'bypass forces a network call despite cached data');
    assertEqual(result.data[0].id, 'fresh', 'bypass returns fresh network data');
  });

  // Test 9: Request deduplication - two concurrent queries make one network call
  await describe('CachedQueryBuilder - request deduplication', async () => {
    const cm = new CacheManager();
    const connStatus = { state: 'connected' };

    // Clear in-flight map to avoid interference from previous tests
    inFlightRequests.clear();

    let callCount = 0;
    const slowMock = {
      from: (table) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          single: () => builder,
          maybeSingle: () => builder,
          then: (resolve, reject) => {
            callCount++;
            // Slightly delayed response to ensure both queries are in-flight
            return new Promise((res) => setTimeout(() => res({ data: [{ id: 1 }], error: null }), 30))
              .then(resolve, reject);
          },
        };
        return { select: () => builder };
      },
    };

    const q1 = new CachedQueryBuilder(slowMock, cm, 'orders', connStatus);
    q1.select('*').eq('outlet_id', 'abc');

    const q2 = new CachedQueryBuilder(slowMock, cm, 'orders', connStatus);
    q2.select('*').eq('outlet_id', 'abc');

    // Fire both concurrently
    const [r1, r2] = await Promise.all([q1.execute(), q2.execute()]);

    assertEqual(callCount, 1, 'only one network call for two concurrent identical queries');
    assertEqual(r1.data[0].id, 1, 'first query gets data');
    assertEqual(r2.data[0].id, 1, 'second query gets same data');
  });

  // Test 10: Deduplication error - all waiters reject if fetch fails
  await describe('CachedQueryBuilder - deduplication error rejects all waiters', async () => {
    const cm = new CacheManager();
    const connStatus = { state: 'connected' };

    inFlightRequests.clear();

    let callCount = 0;
    const failingMock = {
      from: (table) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          single: () => builder,
          maybeSingle: () => builder,
          then: (resolve, reject) => {
            callCount++;
            return new Promise((res) => setTimeout(() => res({ data: null, error: { message: 'Server error' } }), 30))
              .then(resolve, reject);
          },
        };
        return { select: () => builder };
      },
    };

    const q1 = new CachedQueryBuilder(failingMock, cm, 'orders', connStatus);
    q1.select('*');

    const q2 = new CachedQueryBuilder(failingMock, cm, 'orders', connStatus);
    q2.select('*');

    const [r1, r2] = await Promise.all([q1.execute(), q2.execute()]);

    assertEqual(callCount, 1, 'only one network call made');
    assertEqual(r1.error.message, 'Server error', 'first waiter gets the error');
    assertEqual(r2.error.message, 'Server error', 'second waiter gets the same error');
    assertEqual(r1.data, null, 'first waiter data is null');
    assertEqual(r2.data, null, 'second waiter data is null');
  });

  // Test 11: Offline fallback returns cached data when disconnected
  await describe('CachedQueryBuilder - offline fallback returns cached data', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase([{ id: 'should-not-reach' }]);
    const connStatus = { state: 'disconnected' };

    inFlightRequests.clear();

    // Pre-populate cache
    const key = 'categories:*:_:_:_:_';
    cm.set(key, [{ id: 1, name: 'Cached offline' }], 300000);

    const q = new CachedQueryBuilder(mock, cm, 'categories', connStatus);
    q.select('*').cache({ bypass: true }); // bypass cache read to force networkFetch path

    const result = await q.execute();
    assertEqual(result.data[0].name, 'Cached offline', 'returns cached data when offline');
    assertEqual(result._fromCache, true, '_fromCache flag is set');
    assertEqual(mock.getCallCount(), 0, 'no network call when offline');
  });

  // Test 12: invalidate() clears target table + group members
  describe('CachedQueryBuilder - invalidate clears target table and group members', () => {
    const cm = new CacheManager();
    const mock = createMockSupabase();
    const connStatus = { state: 'connected' };
    const client = createCachedClient(mock, cm, connStatus);

    // Populate cache for orders and order_items
    cm.set('orders:key1', [{ id: 1 }], 60000);
    cm.set('orders:key2', [{ id: 2 }], 60000);
    cm.set('order_items:key3', [{ id: 3 }], 60000);
    cm.set('categories:key4', [{ id: 4 }], 60000);

    // Invalidate 'orders' -> should also invalidate 'order_items'
    client.invalidate('orders');

    assert(cm.get('orders:key1') === null, 'orders:key1 was invalidated');
    assert(cm.get('orders:key2') === null, 'orders:key2 was invalidated');
    assert(cm.get('order_items:key3') === null, 'order_items:key3 was invalidated via group');
    assert(cm.get('categories:key4') !== null, 'categories:key4 NOT invalidated (different group)');
  });

  // Test 13: Edge Function caching
  await describe('CachedQueryBuilder - Edge Function caching', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase();
    const connStatus = { state: 'connected' };
    const client = createCachedClient(mock, cm, connStatus);

    // First call with cache config -> network call
    const r1 = await client.functions.invoke('get-report', {
      body: { date: '2025-01-01' },
      cache: { ttl: 60000 },
    });

    assert(r1.data !== null, 'first Edge Function call returns data');
    assertEqual(r1.data.fn, 'get-report', 'Edge Function name passed through');
    assertEqual(r1.error, null, 'no error on first call');

    // Second call with same params -> should be cached
    const callsBefore = mock.getCallCount();
    const r2 = await client.functions.invoke('get-report', {
      body: { date: '2025-01-01' },
      cache: { ttl: 60000 },
    });

    assertEqual(mock.getCallCount(), callsBefore, 'second call uses cache (no new network call)');
    assert(r2.data !== null, 'cached Edge Function data returned');
    assertEqual(r2.error, null, 'no error on cached call');

    // Third call with different params -> new fetch
    const callsBefore2 = mock.getCallCount();
    const r3 = await client.functions.invoke('get-report', {
      body: { date: '2025-02-01' },
      cache: { ttl: 60000 },
    });

    assertEqual(mock.getCallCount(), callsBefore2 + 1, 'different params trigger a new network call');
    assert(r3.data !== null, 'new Edge Function call returns data');
  });
}

// ---------------------------------------------------------------------------
// Run all tests then print summary
// ---------------------------------------------------------------------------

runTests().then(() => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`CachedQueryBuilder tests: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
