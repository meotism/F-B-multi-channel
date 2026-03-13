// Integration tests for the full cache lifecycle
//
// Tests the interplay between CacheManager, CachedQueryBuilder, createCachedClient,
// withCacheInvalidation, invalidateWithGroup, and Edge Function caching across
// realistic multi-step scenarios.
//
// Usage (Node >= 18):
//   node js/tests/integration/cached-services.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as unit tests)
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
  if (result && typeof result.then === 'function') {
    return result.catch((err) => {
      failed++;
      console.error(`  FAIL: ${name} threw: ${err.message}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Inline CacheManager
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
// Inline constants (from cached-query.js)
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
// Shared in-flight deduplication map
// ---------------------------------------------------------------------------

const inFlightRequests = new Map();

// ---------------------------------------------------------------------------
// Inline CachedQueryBuilder (from cached-query.js, with connStatus param)
// ---------------------------------------------------------------------------

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
// Inline createCachedFunctions + createCachedClient (from cached-query.js)
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
// Inline withCacheInvalidation + invalidateWithGroup (from cache-invalidation.js)
// ---------------------------------------------------------------------------

function withCacheInvalidation(tableName, originalCallback, cacheManager) {
  return (payload) => {
    invalidateWithGroup(tableName, cacheManager);
    originalCallback(payload);
  };
}

function invalidateWithGroup(tableName, cacheManager) {
  cacheManager.invalidateByPrefix(tableName + ':');
  for (const group of Object.values(INVALIDATION_GROUPS)) {
    if (group.includes(tableName)) {
      for (const member of group) {
        if (member !== tableName) {
          cacheManager.invalidateByPrefix(member + ':');
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mock Supabase client factory
// ---------------------------------------------------------------------------

function createMockSupabase(mockData = [], mockError = null) {
  let callCount = 0;

  const createBuilder = () => {
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
        return Promise.resolve({ data: mockData, error: mockError }).then(resolve, reject);
      },
    };
    return builder;
  };

  return {
    from: () => {
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
    resetCallCount: () => { callCount = 0; },
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

async function runTests() {

  // =========================================================================
  // Test 1: Cache hit on second call
  // =========================================================================
  await describe('Integration — cache hit on second call (0 network calls)', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase([{ id: 1, name: 'Beverages' }, { id: 2, name: 'Food' }]);
    const connStatus = { state: 'connected' };
    const client = createCachedClient(mock, cm, connStatus);

    // First call: cache miss, network fetch
    const r1 = await client.from('categories').select('*');
    assertEqual(mock.getCallCount(), 1, 'first call makes 1 network request');
    assertEqual(r1.data.length, 2, 'first call returns 2 categories');
    assertEqual(r1.error, null, 'first call has no error');

    // Second call: cache hit, 0 network calls
    mock.resetCallCount();
    const r2 = await client.from('categories').select('*');
    assertEqual(mock.getCallCount(), 0, 'second call makes 0 network requests (cache hit)');
    assertEqual(r2.data.length, 2, 'second call returns same 2 categories from cache');
    assertEqual(r2.error, null, 'second call has no error');

    // Verify stats reflect the hit
    const stats = cm.getStats();
    assert(stats.hits >= 1, 'cache stats show at least 1 hit');
  });

  // =========================================================================
  // Test 2: Write-through invalidation (no dirty read)
  // =========================================================================
  await describe('Integration — write-through invalidation prevents dirty reads', async () => {
    const cm = new CacheManager();
    const connStatus = { state: 'connected' };

    // Track which data the mock returns (simulates DB state changes)
    let currentData = [{ id: 1, name: 'Old Category' }];
    let callCount = 0;
    const mock = {
      from: () => {
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
            return Promise.resolve({ data: currentData, error: null }).then(resolve, reject);
          },
        };
        return { select: builder.select };
      },
      functions: { invoke: async () => ({ data: null, error: null }) },
    };

    const client = createCachedClient(mock, cm, connStatus);

    // Step 1: Read -> cached
    const r1 = await client.from('categories').select('*');
    assertEqual(callCount, 1, 'initial read hits network');
    assertEqual(r1.data[0].name, 'Old Category', 'initial read returns old data');

    // Step 2: Simulate a write that changes DB data, then invalidate
    currentData = [{ id: 1, name: 'New Category' }];
    client.invalidate('categories');

    // Step 3: Read again -> cache miss, fresh network fetch
    const r2 = await client.from('categories').select('*');
    assertEqual(callCount, 2, 'post-invalidation read hits network again');
    assertEqual(r2.data[0].name, 'New Category', 'post-invalidation read returns fresh data');
  });

  // =========================================================================
  // Test 3: Realtime invalidation via withCacheInvalidation
  // =========================================================================
  await describe('Integration — realtime invalidation clears cache for table', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase([{ id: 1, name: 'Beverages' }]);
    const connStatus = { state: 'connected' };
    const client = createCachedClient(mock, cm, connStatus);

    // Populate cache
    await client.from('categories').select('*');
    assertEqual(cm.store.size, 1, 'cache has 1 entry after read');

    // Simulate a realtime event via withCacheInvalidation
    let callbackPayload = null;
    const realtimeCallback = withCacheInvalidation('categories', (payload) => {
      callbackPayload = payload;
    }, cm);

    const mockPayload = { eventType: 'INSERT', new: { id: 2, name: 'Desserts' } };
    realtimeCallback(mockPayload);

    // Verify cache was cleared
    assertEqual(cm.store.size, 0, 'cache is empty after realtime invalidation');
    assertEqual(callbackPayload.eventType, 'INSERT', 'original callback received the payload');
    assertEqual(callbackPayload.new.name, 'Desserts', 'payload data passed through correctly');

    // Next read should be a cache miss
    mock.resetCallCount();
    await client.from('categories').select('*');
    assertEqual(mock.getCallCount(), 1, 'next read after invalidation is a cache miss');
  });

  // =========================================================================
  // Test 4: Group invalidation (categories + menu_items)
  // =========================================================================
  await describe('Integration — group invalidation clears related tables', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase([{ id: 1 }]);
    const connStatus = { state: 'connected' };
    const client = createCachedClient(mock, cm, connStatus);

    // Populate cache for both 'categories' and 'menu_items'
    await client.from('categories').select('*');
    await client.from('menu_items').select('*');
    assertEqual(cm.store.size, 2, 'cache has 2 entries (categories + menu_items)');

    // Invalidate 'categories' -> should also clear 'menu_items' (same group: menu)
    client.invalidate('categories');

    assertEqual(cm.store.size, 0, 'both entries cleared after group invalidation');

    // Verify both tables need fresh fetches
    mock.resetCallCount();
    await client.from('categories').select('*');
    await client.from('menu_items').select('*');
    assertEqual(mock.getCallCount(), 2, 'both tables require fresh network fetches');
  });

  // =========================================================================
  // Test 5: Edge Function caching
  // =========================================================================
  await describe('Integration — Edge Function caching (same params cached, different params fetch)', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase();
    const connStatus = { state: 'connected' };
    const client = createCachedClient(mock, cm, connStatus);

    // First call: cache miss, network
    const r1 = await client.functions.invoke('generate-report', {
      body: { start: '2025-01-01', end: '2025-01-31' },
      cache: { ttl: 120000 },
    });
    assertEqual(mock.getCallCount(), 1, 'first Edge Function call hits network');
    assert(r1.data !== null, 'first call returns data');
    assertEqual(r1.data.fn, 'generate-report', 'function name in data');
    assertEqual(r1.error, null, 'no error on first call');

    // Second call (same params): cache hit
    mock.resetCallCount();
    const r2 = await client.functions.invoke('generate-report', {
      body: { start: '2025-01-01', end: '2025-01-31' },
      cache: { ttl: 120000 },
    });
    assertEqual(mock.getCallCount(), 0, 'second call with same params is cached (0 network calls)');
    assert(r2.data !== null, 'cached data returned');

    // Third call (different params): cache miss, new fetch
    mock.resetCallCount();
    const r3 = await client.functions.invoke('generate-report', {
      body: { start: '2025-02-01', end: '2025-02-28' },
      cache: { ttl: 120000 },
    });
    assertEqual(mock.getCallCount(), 1, 'different params trigger a new network fetch');
    assert(r3.data !== null, 'new call returns data');
  });

  // =========================================================================
  // Test 6: Request deduplication
  // =========================================================================
  await describe('Integration — request deduplication (1 network call for 2 concurrent reads)', async () => {
    const cm = new CacheManager();
    const connStatus = { state: 'connected' };

    inFlightRequests.clear();

    let callCount = 0;
    const slowMock = {
      from: () => {
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
            return new Promise((res) =>
              setTimeout(() => res({ data: [{ id: 1, name: 'Deduped' }], error: null }), 30)
            ).then(resolve, reject);
          },
        };
        return { select: builder.select };
      },
      functions: { invoke: async () => ({ data: null, error: null }) },
    };

    const client = createCachedClient(slowMock, cm, connStatus);

    // Fire two identical reads concurrently
    const [r1, r2] = await Promise.all([
      client.from('categories').select('*').execute(),
      client.from('categories').select('*').execute(),
    ]);

    assertEqual(callCount, 1, 'only 1 network call for 2 concurrent identical reads');
    assertEqual(r1.data[0].name, 'Deduped', 'first reader gets data');
    assertEqual(r2.data[0].name, 'Deduped', 'second reader gets same data');
  });

  // =========================================================================
  // Test 7: Session lifecycle (populate -> clear -> empty -> repopulate -> works)
  // =========================================================================
  await describe('Integration — session lifecycle: populate, clear, repopulate', async () => {
    const cm = new CacheManager();
    const mock = createMockSupabase([{ id: 1, name: 'Session Item' }]);
    const connStatus = { state: 'connected' };
    const client = createCachedClient(mock, cm, connStatus);

    // Populate cache
    await client.from('categories').select('*');
    await client.from('menu_items').select('*');
    assertEqual(cm.store.size, 2, 'cache has 2 entries after populating');
    assert(cm.getStats().misses >= 2, 'stats reflect 2 misses for initial loads');

    // Simulate session clear (e.g., logout)
    cm.clear();
    assertEqual(cm.store.size, 0, 'cache is empty after clear()');
    assertEqual(cm.getStats().hits, 0, 'stats reset: hits = 0');
    assertEqual(cm.getStats().misses, 0, 'stats reset: misses = 0');
    assertEqual(cm.getVersion('categories:'), 0, 'invalidation versions reset');

    // Repopulate (e.g., new session login)
    mock.resetCallCount();
    await client.from('categories').select('*');
    assertEqual(mock.getCallCount(), 1, 'repopulate triggers network fetch (cache was cleared)');
    assertEqual(cm.store.size, 1, 'cache has 1 entry after repopulate');

    // Confirm the repopulated entry is a cache hit now
    mock.resetCallCount();
    const r = await client.from('categories').select('*');
    assertEqual(mock.getCallCount(), 0, 'repopulated entry is a cache hit');
    assertEqual(r.data[0].name, 'Session Item', 'cached data is correct');
  });

  // =========================================================================
  // Test 8: Version counter prevents stale caching
  // =========================================================================
  await describe('Integration — version counter prevents stale caching on mid-flight invalidation', async () => {
    const cm = new CacheManager();
    const connStatus = { state: 'connected' };

    inFlightRequests.clear();

    // Create a mock whose fetch takes 50ms, during which we'll invalidate
    let callCount = 0;
    const delayedMock = {
      from: () => {
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
            return new Promise((res) =>
              setTimeout(() => res({ data: [{ id: 'stale-result' }], error: null }), 50)
            ).then(resolve, reject);
          },
        };
        return { select: builder.select };
      },
      functions: { invoke: async () => ({ data: null, error: null }) },
    };

    const q = new CachedQueryBuilder(delayedMock, cm, 'categories', connStatus);
    q.select('*');
    const cacheKey = q._buildCacheKey();

    // Snapshot version before fetch
    const versionBefore = cm.getVersion('categories:');
    assertEqual(versionBefore, 0, 'version starts at 0');

    // Start the async fetch (takes 50ms)
    const fetchPromise = q.execute();

    // While fetch is in-flight (< 50ms), invalidate the cache
    await new Promise((r) => setTimeout(r, 10));
    cm.invalidateByPrefix('categories:');
    const versionAfter = cm.getVersion('categories:');
    assertEqual(versionAfter, 1, 'version incremented to 1 during in-flight fetch');

    // Wait for fetch to complete
    const result = await fetchPromise;
    assertEqual(result.data[0].id, 'stale-result', 'data is still returned to the caller');

    // The result should NOT have been cached because version changed mid-flight
    const cached = cm.get(cacheKey);
    assert(cached === null, 'stale fetch result was NOT cached (version mismatch)');
    assertEqual(callCount, 1, 'exactly 1 network call was made');
  });
}

// ---------------------------------------------------------------------------
// Run all tests then print summary
// ---------------------------------------------------------------------------

runTests().then(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Integration (cached-services) tests: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
