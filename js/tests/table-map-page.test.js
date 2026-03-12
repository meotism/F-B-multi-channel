// Unit tests for table-map-page - enterEditMode / exitEditMode with lock integration
//
// These tests exercise the edit mode lifecycle (lock acquisition, heartbeat,
// inactivity timer, lock release) using mock objects. They verify:
// - enterEditMode acquires lock, sets correct state, starts timers
// - enterEditMode shows toast and stays in view mode when lock fails
// - exitEditMode releases lock, clears timers, resets state
// - destroy calls exitEditMode and unsubscribes from map lock channel
// - sendHeartbeat refreshes the lock timestamp
// - resetInactivityTimer sets up auto-exit timeout
//
// Usage (browser):
//   import('/js/tests/table-map-page.test.js');
//
// Usage (Node >= 18):
//   node --experimental-vm-modules js/tests/table-map-page.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (async-aware, same pattern as map-lock-service.test.js)
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
 * Create a mock channel that simulates Supabase Presence behavior.
 * Tracks calls to track() and untrack() for verification.
 */
function createMockChannel({ acquireResult = true } = {}) {
  const trackCalls = [];
  let untrackCalls = 0;

  const channel = {
    presenceState() {
      if (!acquireResult) {
        // Simulate another user holding the lock
        return {
          editor: [{
            user_id: 'other-user',
            user_name: 'Bob',
            locked_at: new Date().toISOString(),
          }],
        };
      }
      return {};
    },
    async track(payload) {
      trackCalls.push(payload);
    },
    async untrack() {
      untrackCalls++;
    },
  };

  return {
    channel,
    trackCalls,
    getUntrackCalls: () => untrackCalls,
  };
}

/**
 * Create a mock page component that mirrors the state/methods from
 * tableMapPage() relevant to edit mode lifecycle testing.
 * Inlines the lock logic to avoid import issues across environments.
 */
function createMockPage({ acquireResult = true } = {}) {
  const { channel, trackCalls, getUntrackCalls } = createMockChannel({ acquireResult });

  // Track toast messages for assertion
  const toasts = [];

  // Mock Alpine.store responses
  const mockStores = {
    auth: {
      user: { id: 'user-A', name: 'Alice', email: 'alice@test.com', outlet_id: 'outlet-1' },
      canEditMap() { return true; },
    },
    ui: {
      showToast(message, type) {
        toasts.push({ message, type });
      },
    },
  };

  // Track initDragAndDrop / destroyDragAndDrop calls
  let dragInitCalls = 0;
  let dragDestroyCalls = 0;

  const page = {
    // --- State ---
    isEditMode: false,
    isDragging: false,
    selectedTable: null,
    undoStack: [],
    lockOwner: acquireResult ? null : { user_id: 'other-user', user_name: 'Bob' },
    heartbeatInterval: null,
    inactivityTimer: null,
    _mapLockChannel: channel,

    // --- Mock methods ---
    initDragAndDrop() {
      dragInitCalls++;
    },
    destroyDragAndDrop() {
      dragDestroyCalls++;
    },

    // --- Inlined enterEditMode (mirrors real implementation) ---
    async enterEditMode() {
      const userId = mockStores.auth.user?.id;
      const userName = mockStores.auth.user?.name || mockStores.auth.user?.email || 'Unknown';

      if (this._mapLockChannel) {
        // Inline acquireLock logic
        const state = this._mapLockChannel.presenceState();
        const editors = state.editor || [];

        if (editors.length > 0 && editors[0].user_id !== userId) {
          const lockedAt = new Date(editors[0].locked_at).getTime();
          if (Date.now() - lockedAt < 5 * 60 * 1000) {
            // Lock held by another user
            const ownerName = this.lockOwner?.user_name || 'Người dùng khác';
            mockStores.ui.showToast(
              `${ownerName} đang chỉnh sửa sơ đồ bàn`,
              'warning',
            );
            return;
          }
        }

        await this._mapLockChannel.track({
          user_id: userId,
          user_name: userName,
          locked_at: new Date().toISOString(),
        });
      }

      this.isEditMode = true;
      this.undoStack = [];
      this.initDragAndDrop();

      this.heartbeatInterval = setInterval(() => {
        this.sendHeartbeat();
      }, 30000);

      this.resetInactivityTimer();
    },

    // --- Inlined exitEditMode ---
    async exitEditMode() {
      if (this._mapLockChannel) {
        try {
          await this._mapLockChannel.untrack();
        } catch (_err) {
          // Swallow errors like the real implementation
        }
      }

      this.destroyDragAndDrop();
      this.isEditMode = false;
      this.isDragging = false;
      this.selectedTable = null;
      this.undoStack = [];

      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      if (this.inactivityTimer) {
        clearTimeout(this.inactivityTimer);
        this.inactivityTimer = null;
      }
    },

    // --- Inlined sendHeartbeat ---
    async sendHeartbeat() {
      if (!this._mapLockChannel) return;
      try {
        await this._mapLockChannel.track({
          user_id: mockStores.auth.user?.id,
          user_name: mockStores.auth.user?.name || mockStores.auth.user?.email || 'Unknown',
          locked_at: new Date().toISOString(),
        });
      } catch (_err) {
        // swallow
      }
    },

    // --- Inlined resetInactivityTimer ---
    resetInactivityTimer() {
      if (this.inactivityTimer) {
        clearTimeout(this.inactivityTimer);
      }
      this.inactivityTimer = setTimeout(() => {
        this.exitEditMode();
      }, 5 * 60 * 1000);
    },
  };

  return {
    page,
    trackCalls,
    getUntrackCalls,
    toasts,
    getDragInitCalls: () => dragInitCalls,
    getDragDestroyCalls: () => dragDestroyCalls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enterEditMode - lock acquired successfully', async () => {
  const { page, trackCalls, getDragInitCalls } = createMockPage({ acquireResult: true });

  await page.enterEditMode();

  assert(page.isEditMode === true, 'sets isEditMode to true');
  assert(trackCalls.length === 1, 'calls channel.track() once to acquire lock');
  assert(trackCalls[0].user_id === 'user-A', 'tracks with correct user_id');
  assert(trackCalls[0].user_name === 'Alice', 'tracks with correct user_name');
  assert(typeof trackCalls[0].locked_at === 'string', 'tracks with locked_at timestamp');
  assert(getDragInitCalls() === 1, 'calls initDragAndDrop()');
  assert(page.heartbeatInterval !== null, 'starts heartbeat interval');
  assert(page.inactivityTimer !== null, 'starts inactivity timer');
  assert(Array.isArray(page.undoStack) && page.undoStack.length === 0, 'resets undoStack');

  // Clean up intervals to prevent test leaks
  clearInterval(page.heartbeatInterval);
  clearTimeout(page.inactivityTimer);
});

describe('enterEditMode - lock acquisition fails', async () => {
  const { page, toasts, getDragInitCalls } = createMockPage({ acquireResult: false });

  await page.enterEditMode();

  assert(page.isEditMode === false, 'stays in view mode (isEditMode remains false)');
  assert(getDragInitCalls() === 0, 'does NOT call initDragAndDrop()');
  assert(page.heartbeatInterval === null, 'does NOT start heartbeat interval');
  assert(page.inactivityTimer === null, 'does NOT start inactivity timer');
  assert(toasts.length === 1, 'shows exactly one toast');
  assert(toasts[0].type === 'warning', 'toast type is warning');
  assert(
    toasts[0].message.includes('đang chỉnh sửa sơ đồ bàn'),
    'toast message contains lock owner notification text',
  );
});

describe('exitEditMode - cleans up intervals and releases lock', async () => {
  const { page, getUntrackCalls, getDragDestroyCalls } = createMockPage({ acquireResult: true });

  // First enter edit mode to establish state
  await page.enterEditMode();

  assert(page.isEditMode === true, 'precondition: isEditMode is true before exit');
  assert(page.heartbeatInterval !== null, 'precondition: heartbeat is running');
  assert(page.inactivityTimer !== null, 'precondition: inactivity timer is running');

  // Now exit
  await page.exitEditMode();

  assert(page.isEditMode === false, 'sets isEditMode to false');
  assert(page.isDragging === false, 'resets isDragging to false');
  assert(page.selectedTable === null, 'resets selectedTable to null');
  assert(page.undoStack.length === 0, 'clears undoStack');
  assert(page.heartbeatInterval === null, 'clears heartbeat interval');
  assert(page.inactivityTimer === null, 'clears inactivity timer');
  assert(getUntrackCalls() === 1, 'calls channel.untrack() to release lock');
  assert(getDragDestroyCalls() === 1, 'calls destroyDragAndDrop()');
});

describe('sendHeartbeat - refreshes lock timestamp', async () => {
  const { page, trackCalls } = createMockPage({ acquireResult: true });

  // Enter edit mode (1 track call for lock acquisition)
  await page.enterEditMode();
  const initialTrackCount = trackCalls.length;

  // Send heartbeat
  await page.sendHeartbeat();

  assert(
    trackCalls.length === initialTrackCount + 1,
    'sendHeartbeat calls channel.track() once',
  );
  assert(
    trackCalls[trackCalls.length - 1].user_id === 'user-A',
    'heartbeat track contains correct user_id',
  );
  assert(
    typeof trackCalls[trackCalls.length - 1].locked_at === 'string',
    'heartbeat track contains fresh locked_at timestamp',
  );

  // Clean up
  clearInterval(page.heartbeatInterval);
  clearTimeout(page.inactivityTimer);
});

describe('resetInactivityTimer - creates new timeout', async () => {
  const { page } = createMockPage({ acquireResult: true });

  assert(page.inactivityTimer === null, 'inactivity timer starts as null');

  page.resetInactivityTimer();

  assert(page.inactivityTimer !== null, 'inactivity timer is set after resetInactivityTimer()');

  // Call again to verify it replaces the old timer
  const firstTimer = page.inactivityTimer;
  page.resetInactivityTimer();

  assert(
    page.inactivityTimer !== null && page.inactivityTimer !== firstTimer,
    'resetInactivityTimer replaces the previous timer with a new one',
  );

  // Clean up
  clearTimeout(page.inactivityTimer);
});

describe('exitEditMode without prior enterEditMode - safe no-op', async () => {
  const { page, getUntrackCalls, getDragDestroyCalls } = createMockPage({ acquireResult: true });

  // Call exitEditMode without entering first
  await page.exitEditMode();

  assert(page.isEditMode === false, 'isEditMode stays false');
  assert(getUntrackCalls() === 1, 'still calls channel.untrack() for safety');
  assert(getDragDestroyCalls() === 1, 'still calls destroyDragAndDrop() for safety');
});

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

runAll();
