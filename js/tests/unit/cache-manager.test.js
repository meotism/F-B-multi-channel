// Unit tests for CacheManager
//
// Tests LRU eviction, TTL expiration, version counters, structuredClone safety,
// invalidation, statistics, and diagnostics.
//
// Usage (Node >= 18):
//   node js/tests/unit/cache-manager.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as bill-service.test.js)
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
  fn();
}

// ---------------------------------------------------------------------------
// Inline CacheManager (avoid ESM import issues in Node CJS context)
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

function _estimateSize(data) {
  if (data == null) return 0;
  try { return JSON.stringify(data).length; } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CacheManager — get/set/delete basics', () => {
  const cm = new CacheManager();

  cm.set('a', { name: 'Alice' }, 60000);
  const result = cm.get('a');
  assert(result !== null, 'get returns non-null for existing key');
  assertEqual(result.data.name, 'Alice', 'get returns correct data');
  assertEqual(result.isStale, false, 'entry is not stale within TTL');

  assert(cm.get('nonexistent') === null, 'get returns null for missing key');

  cm.delete('a');
  assert(cm.get('a') === null, 'get returns null after delete');
});

describe('CacheManager — set overwrites existing key', () => {
  const cm = new CacheManager();

  cm.set('x', 'v1', 60000);
  cm.set('x', 'v2', 60000);
  assertEqual(cm.get('x').data, 'v2', 'set overwrites existing key with new data');
  assertEqual(cm.store.size, 1, 'store size is still 1 after overwrite');
});

describe('CacheManager — TTL expiration marks entry as stale', () => {
  const cm = new CacheManager();

  // Manually create an entry with a past createdAt to simulate TTL expiration
  cm.store.set('expired', {
    data: [1, 2, 3],
    createdAt: Date.now() - 10000, // 10 seconds ago
    ttl: 5000,                      // 5 second TTL — already expired
    lastAccessed: Date.now() - 10000,
  });

  const result = cm.get('expired');
  assert(result !== null, 'expired entry is still returned (not deleted)');
  assertEqual(result.isStale, true, 'expired entry is marked as stale');
  assert(Array.isArray(result.data), 'stale entry data is still accessible');
  assertEqual(result.data.length, 3, 'stale entry data is intact');
});

describe('CacheManager — LRU eviction', () => {
  const cm = new CacheManager({ maxEntries: 3 });

  cm.set('a', 1, 60000);
  cm.set('b', 2, 60000);
  cm.set('c', 3, 60000);

  // Manually set lastAccessed to simulate time differences
  // (Date.now() calls within the same tick return the same ms)
  const now = Date.now();
  cm.store.get('a').lastAccessed = now - 300; // oldest
  cm.store.get('b').lastAccessed = now - 200;
  cm.store.get('c').lastAccessed = now - 100; // most recent

  // Access 'a' to make it recently used (updates lastAccessed to Date.now())
  cm.get('a');

  // Adding 'd' should evict 'b' (oldest lastAccessed after 'a' was refreshed)
  cm.set('d', 4, 60000);

  assertEqual(cm.store.size, 3, 'store size stays at maxEntries after eviction');
  assert(cm.get('b') === null, 'LRU entry "b" was evicted');
  assert(cm.get('a') !== null, 'recently accessed "a" was NOT evicted');
  assert(cm.get('c') !== null, '"c" was NOT evicted');
  assert(cm.get('d') !== null, 'newly added "d" exists');
  assertEqual(cm._evictions, 1, 'eviction counter incremented');
});

describe('CacheManager — invalidateByPrefix', () => {
  const cm = new CacheManager();

  cm.set('categories:abc:1', 'data1', 60000);
  cm.set('categories:abc:2', 'data2', 60000);
  cm.set('menu_items:abc:1', 'data3', 60000);
  cm.set('orders:xyz:1', 'data4', 60000);

  const removed = cm.invalidateByPrefix('categories:');

  assertEqual(removed, 2, 'invalidateByPrefix removes matching entries');
  assert(cm.get('categories:abc:1') === null, 'categories entry 1 removed');
  assert(cm.get('categories:abc:2') === null, 'categories entry 2 removed');
  assert(cm.get('menu_items:abc:1') !== null, 'non-matching menu_items entry preserved');
  assert(cm.get('orders:xyz:1') !== null, 'non-matching orders entry preserved');
});

describe('CacheManager — invalidateByPrefix increments version', () => {
  const cm = new CacheManager();

  assertEqual(cm.getVersion('categories:'), 0, 'initial version is 0');

  cm.invalidateByPrefix('categories:');
  assertEqual(cm.getVersion('categories:'), 1, 'version is 1 after first invalidation');

  cm.invalidateByPrefix('categories:');
  assertEqual(cm.getVersion('categories:'), 2, 'version is 2 after second invalidation');

  // Other prefixes unaffected
  assertEqual(cm.getVersion('orders:'), 0, 'unrelated prefix version is still 0');
});

describe('CacheManager — getVersion returns correct version', () => {
  const cm = new CacheManager();

  cm.invalidateByPrefix('a:');
  cm.invalidateByPrefix('a:');
  cm.invalidateByPrefix('a:');
  cm.invalidateByPrefix('b:');

  assertEqual(cm.getVersion('a:'), 3, 'prefix "a:" has version 3');
  assertEqual(cm.getVersion('b:'), 1, 'prefix "b:" has version 1');
  assertEqual(cm.getVersion('c:'), 0, 'never-invalidated prefix has version 0');
});

describe('CacheManager — structuredClone prevents reference mutation', () => {
  const cm = new CacheManager();

  const original = [{ id: 1, name: 'Beverages' }, { id: 2, name: 'Food' }];
  cm.set('cats', original, 60000);

  // Get and mutate the returned data
  const result1 = cm.get('cats');
  result1.data.push({ id: 3, name: 'Desserts' });
  result1.data[0].name = 'MUTATED';

  // Get again — should be unaffected by the mutation
  const result2 = cm.get('cats');
  assertEqual(result2.data.length, 2, 'cache entry not affected by caller push()');
  assertEqual(result2.data[0].name, 'Beverages', 'cache entry not affected by caller property mutation');
});

describe('CacheManager — clear resets everything', () => {
  const cm = new CacheManager();

  cm.set('a', 1, 60000);
  cm.set('b', 2, 60000);
  cm.invalidateByPrefix('a:');
  cm.get('a'); // miss
  cm.get('b'); // hit

  cm.clear();

  assertEqual(cm.store.size, 0, 'store is empty after clear');
  assertEqual(cm.getVersion('a:'), 0, 'invalidation versions reset after clear');
  const stats = cm.getStats();
  assertEqual(stats.hits, 0, 'hits counter reset after clear');
  assertEqual(stats.misses, 0, 'misses counter reset after clear');
  assertEqual(stats.invalidations, 0, 'invalidations counter reset after clear');
});

describe('CacheManager — getStats accuracy', () => {
  const cm = new CacheManager();

  cm.set('cats:abc', 1, 60000);
  cm.set('orders:xyz', 2, 60000);

  cm.get('cats:abc');  // hit
  cm.get('cats:abc');  // hit
  cm.get('orders:xyz'); // hit
  cm.get('missing');    // miss

  cm.invalidateByPrefix('cats:');

  const stats = cm.getStats();
  assertEqual(stats.hits, 3, 'hits count is 3');
  assertEqual(stats.misses, 1, 'misses count is 1');
  assertEqual(stats.entries, 1, 'entries count is 1 (after invalidation)');
  assertEqual(stats.invalidations, 1, 'invalidations count is 1');
  assertEqual(stats.hitRate, 0.75, 'hitRate is 3/(3+1) = 0.75');
});

describe('CacheManager — getStats with no operations', () => {
  const cm = new CacheManager();
  const stats = cm.getStats();

  assertEqual(stats.hits, 0, 'hits is 0 initially');
  assertEqual(stats.misses, 0, 'misses is 0 initially');
  assertEqual(stats.entries, 0, 'entries is 0 initially');
  assertEqual(stats.hitRate, 0, 'hitRate is 0 with no operations');
});

describe('CacheManager — inspect returns diagnostics', () => {
  const cm = new CacheManager();

  cm.set('categories:abc', [{ id: 1 }], 300000);
  cm.set('orders:xyz', [{ id: 2 }, { id: 3 }], 30000);

  const entries = cm.inspect();
  assertEqual(entries.length, 2, 'inspect returns 2 entries');

  const catEntry = entries.find(e => e.key === 'categories:abc');
  assert(catEntry !== undefined, 'inspect includes categories entry');
  assertEqual(catEntry.ttl, 300, 'TTL is 300 seconds');
  assertEqual(catEntry.stale, false, 'entry is not stale');
  assert(catEntry.dataSize > 0, 'dataSize is positive');
  assert(catEntry.age >= 0, 'age is non-negative');
});

describe('CacheManager — inspect reports stale entries', () => {
  const cm = new CacheManager();

  // Insert a manually-expired entry
  cm.store.set('old', {
    data: 'stale-data',
    createdAt: Date.now() - 120000,
    ttl: 60000,
    lastAccessed: Date.now() - 120000,
  });

  const entries = cm.inspect();
  assertEqual(entries.length, 1, 'inspect returns 1 entry');
  assertEqual(entries[0].stale, true, 'expired entry is reported as stale');
});

describe('CacheManager — eviction counter in stats', () => {
  const cm = new CacheManager({ maxEntries: 2 });

  cm.set('a', 1, 60000);
  cm.set('b', 2, 60000);
  cm.set('c', 3, 60000); // evicts 'a'
  cm.set('d', 4, 60000); // evicts 'b'

  const stats = cm.getStats();
  assertEqual(stats.evictions, 2, 'evictions count is 2');
  assertEqual(stats.entries, 2, 'entries count is 2 (at capacity)');
});

describe('CacheManager — invalidateByPrefix with no matching entries', () => {
  const cm = new CacheManager();

  cm.set('orders:1', 'data', 60000);
  const removed = cm.invalidateByPrefix('categories:');

  assertEqual(removed, 0, 'returns 0 when no entries match');
  assert(cm.get('orders:1') !== null, 'unrelated entries are preserved');
  assertEqual(cm.getVersion('categories:'), 1, 'version still increments even with 0 removals');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(50)}`);
console.log(`CacheManager tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
