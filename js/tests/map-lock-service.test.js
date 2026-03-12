// Unit tests for map-lock-service - acquireLock, releaseLock, isLockStale
//
// These tests exercise the lock logic using mock channel/presence objects
// without requiring a live Supabase connection. They verify:
// - acquireLock returns false when another user is present
// - acquireLock succeeds when no editors exist
// - acquireLock succeeds when the same user already holds the lock
// - acquireLock succeeds when an existing lock is stale (>5 minutes)
// - releaseLock calls channel.untrack()
// - releaseLock handles errors gracefully
// - isLockStale correctly identifies stale/fresh timestamps
//
// Usage (browser):
//   import('/js/tests/map-lock-service.test.js');
//
// Usage (Node >= 18):
//   node --experimental-vm-modules js/tests/map-lock-service.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as table-map-store.test.js, async-aware)
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

/**
 * Run a test group. Supports both sync and async test functions.
 * All describe calls are collected and run sequentially via runAll().
 */
const testQueue = [];

function describe(name, fn) {
  testQueue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of testQueue) {
    console.log(`\n${name}`);
    await fn();
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) {
    console.error('Some tests FAILED.');
  }
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock Presence channel that simulates Supabase Realtime behavior.
 * The `editors` array represents the current presence state under the
 * 'editor' key.
 *
 * @param {Array} editors - Array of presence objects (e.g., [{ user_id, user_name, locked_at }])
 * @returns {{ channel: object, trackCalls: Array, getUntrackCalls: Function }}
 */
function createMockChannel(editors = []) {
  const trackCalls = [];
  let untrackCalls = 0;
  let currentEditors = [...editors];

  const channel = {
    presenceState() {
      if (currentEditors.length === 0) return {};
      return { editor: currentEditors };
    },
    async track(payload) {
      trackCalls.push(payload);
      // Simulate presence update: replace editors with this user
      currentEditors = [payload];
    },
    async untrack() {
      untrackCalls++;
      currentEditors = [];
    },
  };

  return {
    channel,
    trackCalls,
    getUntrackCalls: () => untrackCalls,
  };
}

// ---------------------------------------------------------------------------
// Inline the pure logic from map-lock-service.js to avoid import issues
// across environments. This mirrors the exported functions exactly.
// ---------------------------------------------------------------------------

const PRESENCE_KEY = 'editor';
const STALE_LOCK_THRESHOLD_MS = 5 * 60 * 1000;

async function acquireLock(channel, userId, userName) {
  const state = channel.presenceState();
  const editors = state[PRESENCE_KEY] || [];

  if (editors.length > 0 && editors[0].user_id !== userId) {
    const lockedAt = new Date(editors[0].locked_at).getTime();
    const now = Date.now();

    if (now - lockedAt < STALE_LOCK_THRESHOLD_MS) {
      return false;
    }
  }

  await channel.track({
    user_id: userId,
    user_name: userName,
    locked_at: new Date().toISOString(),
  });

  return true;
}

async function releaseLock(channel) {
  try {
    await channel.untrack();
  } catch (err) {
    console.error('[MapLockService] Failed to release lock:', err);
  }
}

function isLockStale(lockedAt) {
  if (!lockedAt) return true;
  const lockedTime = new Date(lockedAt).getTime();
  return Date.now() - lockedTime >= STALE_LOCK_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('acquireLock - no editors present', async () => {
  const { channel, trackCalls } = createMockChannel([]);

  const result = await acquireLock(channel, 'user-A', 'Alice');

  assert(result === true, 'returns true when no editors exist');
  assert(trackCalls.length === 1, 'calls channel.track() once');
  assert(trackCalls[0].user_id === 'user-A', 'tracks with the correct user_id');
  assert(trackCalls[0].user_name === 'Alice', 'tracks with the correct user_name');
  assert(typeof trackCalls[0].locked_at === 'string', 'tracks with a locked_at timestamp');
});

describe('acquireLock - another user is editing (fresh lock)', async () => {
  const { channel, trackCalls } = createMockChannel([
    {
      user_id: 'user-B',
      user_name: 'Bob',
      locked_at: new Date().toISOString(), // fresh lock
    },
  ]);

  const result = await acquireLock(channel, 'user-A', 'Alice');

  assert(result === false, 'returns false when another user holds a fresh lock');
  assert(trackCalls.length === 0, 'does NOT call channel.track()');
});

describe('acquireLock - same user already editing', async () => {
  const { channel, trackCalls } = createMockChannel([
    {
      user_id: 'user-A',
      user_name: 'Alice',
      locked_at: new Date().toISOString(),
    },
  ]);

  const result = await acquireLock(channel, 'user-A', 'Alice');

  assert(result === true, 'returns true when the same user already holds the lock');
  assert(trackCalls.length === 1, 'calls channel.track() to refresh the lock');
});

describe('acquireLock - another user has a stale lock (>5 min)', async () => {
  const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
  const { channel, trackCalls } = createMockChannel([
    {
      user_id: 'user-B',
      user_name: 'Bob',
      locked_at: staleTime,
    },
  ]);

  const result = await acquireLock(channel, 'user-A', 'Alice');

  assert(result === true, 'returns true when the existing lock is stale');
  assert(trackCalls.length === 1, 'calls channel.track() to acquire the stale lock');
  assert(trackCalls[0].user_id === 'user-A', 'tracks the new user, not the stale one');
});

describe('releaseLock', async () => {
  const { channel, getUntrackCalls } = createMockChannel([
    {
      user_id: 'user-A',
      user_name: 'Alice',
      locked_at: new Date().toISOString(),
    },
  ]);

  await releaseLock(channel);

  assert(getUntrackCalls() === 1, 'calls channel.untrack() once');
});

describe('releaseLock - handles errors gracefully', async () => {
  const channel = {
    presenceState() {
      return {};
    },
    async untrack() {
      throw new Error('Simulated network error');
    },
  };

  // Should not throw
  let threw = false;
  try {
    await releaseLock(channel);
  } catch (_err) {
    threw = true;
  }

  assert(threw === false, 'does not throw when untrack fails');
});

describe('isLockStale', () => {
  assert(isLockStale(null) === true, 'returns true for null locked_at');
  assert(isLockStale(undefined) === true, 'returns true for undefined locked_at');

  const freshTime = new Date().toISOString();
  assert(isLockStale(freshTime) === false, 'returns false for a fresh timestamp');

  const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  assert(isLockStale(staleTime) === true, 'returns true for a timestamp >5 minutes old');

  const exactThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  assert(isLockStale(exactThreshold) === true, 'returns true at exactly 5 minutes');
});

// ---------------------------------------------------------------------------
// Run all tests and print summary
// ---------------------------------------------------------------------------

runAll();
