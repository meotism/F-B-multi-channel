// Unit tests for cache-invalidation.js (withCacheInvalidation, invalidateWithGroup)
//
// Tests the higher-order callback wrapper and group-based invalidation logic.
//
// Usage (Node >= 18):
//   node js/tests/unit/cache-invalidation.test.js

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
  fn();
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
// Inline INVALIDATION_GROUPS constant (from cached-query.js)
// ---------------------------------------------------------------------------

const INVALIDATION_GROUPS = {
  menu: ['categories', 'menu_items'],
  orders: ['orders', 'order_items'],
  stock: ['ingredients', 'inventory'],
};

// ---------------------------------------------------------------------------
// Inline withCacheInvalidation and invalidateWithGroup (from cache-invalidation.js)
// ---------------------------------------------------------------------------

function invalidateWithGroup(tableName, cacheManager) {
  const removed = cacheManager.invalidateByPrefix(tableName + ':');

  if (cacheManager.debug) {
    console.debug(
      `[CacheInvalidation] Invalidated "${tableName}" (${removed} entries removed)`,
    );
  }

  for (const group of Object.values(INVALIDATION_GROUPS)) {
    if (group.includes(tableName)) {
      for (const member of group) {
        if (member !== tableName) {
          const memberRemoved = cacheManager.invalidateByPrefix(member + ':');

          if (cacheManager.debug) {
            console.debug(
              `[CacheInvalidation] Group invalidated "${member}" via "${tableName}" (${memberRemoved} entries removed)`,
            );
          }
        }
      }
    }
  }
}

function withCacheInvalidation(tableName, originalCallback, cacheManager) {
  return (payload) => {
    invalidateWithGroup(tableName, cacheManager);
    originalCallback(payload);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withCacheInvalidation - invalidates cache then calls original callback', () => {
  const cm = new CacheManager();

  // Populate cache with an orders entry
  cm.set('orders:key1', [{ id: 1 }], 60000);

  let callbackCalled = false;
  const originalCb = () => { callbackCalled = true; };

  const wrapped = withCacheInvalidation('orders', originalCb, cm);
  wrapped({ type: 'INSERT', new: { id: 2 } });

  assert(callbackCalled, 'original callback was called');
  assert(cm.get('orders:key1') === null, 'cache entry was invalidated before callback');
});

describe('withCacheInvalidation - callback receives the payload correctly', () => {
  const cm = new CacheManager();

  let receivedPayload = null;
  const originalCb = (payload) => { receivedPayload = payload; };

  const wrapped = withCacheInvalidation('orders', originalCb, cm);
  const testPayload = { type: 'UPDATE', new: { id: 5, status: 'paid' }, old: { id: 5, status: 'pending' } };
  wrapped(testPayload);

  assert(receivedPayload !== null, 'callback received a payload');
  assertEqual(receivedPayload.type, 'UPDATE', 'payload type is correct');
  assertEqual(receivedPayload.new.id, 5, 'payload new.id is correct');
  assertEqual(receivedPayload.new.status, 'paid', 'payload new.status is correct');
  assertEqual(receivedPayload.old.status, 'pending', 'payload old.status is correct');
});

describe('Group invalidation - invalidating categories also invalidates menu_items', () => {
  const cm = new CacheManager();

  cm.set('categories:all', [{ id: 1, name: 'Drinks' }], 60000);
  cm.set('menu_items:all', [{ id: 10, name: 'Coffee' }], 60000);
  cm.set('orders:recent', [{ id: 100 }], 60000);

  invalidateWithGroup('categories', cm);

  assert(cm.get('categories:all') === null, 'categories entry was invalidated');
  assert(cm.get('menu_items:all') === null, 'menu_items entry was invalidated via group');
  assert(cm.get('orders:recent') !== null, 'orders entry NOT invalidated (different group)');
});

describe('Group invalidation - invalidating orders also invalidates order_items', () => {
  const cm = new CacheManager();

  cm.set('orders:list', [{ id: 1 }], 60000);
  cm.set('order_items:list', [{ id: 10 }], 60000);
  cm.set('categories:all', [{ id: 20, name: 'Food' }], 60000);
  cm.set('ingredients:stock', [{ id: 30 }], 60000);

  invalidateWithGroup('orders', cm);

  assert(cm.get('orders:list') === null, 'orders entry was invalidated');
  assert(cm.get('order_items:list') === null, 'order_items entry was invalidated via group');
  assert(cm.get('categories:all') !== null, 'categories entry NOT invalidated');
  assert(cm.get('ingredients:stock') !== null, 'ingredients entry NOT invalidated');
});

describe('Non-grouped table - invalidating a table not in any group only invalidates itself', () => {
  const cm = new CacheManager();

  // 'bills' is not part of any INVALIDATION_GROUPS group
  cm.set('bills:recent', [{ id: 1 }], 60000);
  cm.set('orders:list', [{ id: 2 }], 60000);
  cm.set('categories:all', [{ id: 3 }], 60000);

  invalidateWithGroup('bills', cm);

  assert(cm.get('bills:recent') === null, 'bills entry was invalidated');
  assert(cm.get('orders:list') !== null, 'orders entry NOT invalidated');
  assert(cm.get('categories:all') !== null, 'categories entry NOT invalidated');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(50)}`);
console.log(`CacheInvalidation tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
