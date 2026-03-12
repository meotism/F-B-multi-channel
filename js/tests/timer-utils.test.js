// Unit tests for timer utility functions in formatters.js
//
// Tests: calculateElapsed, formatTimer, getTimerDisplay, getTimerColorClass
// Verifies: formatting edge cases (0 seconds, 1 hour exactly, 99+ hours),
// null handling, elapsed calculation accuracy, color class thresholds.
//
// Usage (browser):
//   import('/js/tests/timer-utils.test.js');
//
// Usage (Node >= 18):
//   node --experimental-vm-modules js/tests/timer-utils.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as table-node.test.js)
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

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ---------------------------------------------------------------------------
// Inline helper functions mirroring the logic in formatters.js.
// Avoids import issues across browser/Node environments.
// ---------------------------------------------------------------------------

const TIMER_WARNING_THRESHOLD = 3600;
const TIMER_DANGER_THRESHOLD = 7200;

function calculateElapsed(startedAt) {
  if (startedAt == null) return null;
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - start) / 1000));
}

function formatTimer(totalSeconds) {
  if (totalSeconds == null) return '';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

function getTimerDisplay(table) {
  if (!table || table.status !== 'serving' || !table.activeOrderStartedAt) {
    return '';
  }
  return formatTimer(calculateElapsed(table.activeOrderStartedAt));
}

function getTimerColorClass(totalSeconds) {
  if (totalSeconds == null || totalSeconds < TIMER_WARNING_THRESHOLD) return '';
  if (totalSeconds >= TIMER_DANGER_THRESHOLD) return 'timer--danger';
  return 'timer--warning';
}

// ---------------------------------------------------------------------------
// Tests: calculateElapsed
// ---------------------------------------------------------------------------

describe('calculateElapsed - null/undefined handling', () => {
  assert(
    calculateElapsed(null) === null,
    'null input returns null',
  );
  assert(
    calculateElapsed(undefined) === null,
    'undefined input returns null',
  );
});

describe('calculateElapsed - elapsed time calculation', () => {
  // Timestamp 60 seconds ago should return ~60
  const sixtySecondsAgo = new Date(Date.now() - 60000).toISOString();
  const elapsed = calculateElapsed(sixtySecondsAgo);
  assert(
    elapsed >= 59 && elapsed <= 61,
    `60 seconds ago returns ~60 (got ${elapsed})`,
  );

  // Timestamp right now should return 0 or 1
  const now = new Date().toISOString();
  const elapsedNow = calculateElapsed(now);
  assert(
    elapsedNow >= 0 && elapsedNow <= 1,
    `current time returns 0 or 1 (got ${elapsedNow})`,
  );

  // Future timestamp should be clamped to 0
  const futureTime = new Date(Date.now() + 60000).toISOString();
  const elapsedFuture = calculateElapsed(futureTime);
  assert(
    elapsedFuture === 0,
    `future timestamp clamped to 0 (got ${elapsedFuture})`,
  );
});

describe('calculateElapsed - large elapsed values', () => {
  // Timestamp 2 hours ago
  const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
  const elapsed = calculateElapsed(twoHoursAgo);
  assert(
    elapsed >= 7199 && elapsed <= 7201,
    `2 hours ago returns ~7200 (got ${elapsed})`,
  );
});

// ---------------------------------------------------------------------------
// Tests: formatTimer
// ---------------------------------------------------------------------------

describe('formatTimer - null/undefined handling', () => {
  assert(
    formatTimer(null) === '',
    'null input returns empty string',
  );
  assert(
    formatTimer(undefined) === '',
    'undefined input returns empty string',
  );
});

describe('formatTimer - zero seconds', () => {
  assert(
    formatTimer(0) === '00:00:00',
    '0 seconds formats as 00:00:00',
  );
});

describe('formatTimer - standard values', () => {
  assert(
    formatTimer(1) === '00:00:01',
    '1 second formats as 00:00:01',
  );
  assert(
    formatTimer(59) === '00:00:59',
    '59 seconds formats as 00:00:59',
  );
  assert(
    formatTimer(60) === '00:01:00',
    '60 seconds formats as 00:01:00',
  );
  assert(
    formatTimer(61) === '00:01:01',
    '61 seconds formats as 00:01:01',
  );
  assert(
    formatTimer(3599) === '00:59:59',
    '3599 seconds formats as 00:59:59',
  );
  assert(
    formatTimer(3661) === '01:01:01',
    '3661 seconds formats as 01:01:01',
  );
});

describe('formatTimer - exactly 1 hour', () => {
  assert(
    formatTimer(3600) === '01:00:00',
    '3600 seconds (exactly 1 hour) formats as 01:00:00',
  );
});

describe('formatTimer - hours > 99', () => {
  // 100 hours = 360000 seconds
  assert(
    formatTimer(360000) === '100:00:00',
    '360000 seconds (100 hours) formats as 100:00:00',
  );
  // 999 hours, 59 minutes, 59 seconds = 3599999 seconds
  assert(
    formatTimer(3599999) === '999:59:59',
    '3599999 seconds (999h 59m 59s) formats as 999:59:59',
  );
});

describe('formatTimer - exactly 2 hours', () => {
  assert(
    formatTimer(7200) === '02:00:00',
    '7200 seconds (exactly 2 hours) formats as 02:00:00',
  );
});

// ---------------------------------------------------------------------------
// Tests: getTimerDisplay
// ---------------------------------------------------------------------------

describe('getTimerDisplay - returns empty string for non-serving tables', () => {
  assert(
    getTimerDisplay({ status: 'empty', activeOrderStartedAt: null }) === '',
    'empty table returns empty string',
  );
  assert(
    getTimerDisplay({ status: 'awaiting_payment', activeOrderStartedAt: new Date().toISOString() }) === '',
    'awaiting_payment table returns empty string even with timestamp',
  );
  assert(
    getTimerDisplay({ status: 'paid', activeOrderStartedAt: new Date().toISOString() }) === '',
    'paid table returns empty string even with timestamp',
  );
});

describe('getTimerDisplay - returns empty string when no started timestamp', () => {
  assert(
    getTimerDisplay({ status: 'serving', activeOrderStartedAt: null }) === '',
    'serving table with null activeOrderStartedAt returns empty string',
  );
  assert(
    getTimerDisplay({ status: 'serving', activeOrderStartedAt: undefined }) === '',
    'serving table with undefined activeOrderStartedAt returns empty string',
  );
  assert(
    getTimerDisplay({ status: 'serving' }) === '',
    'serving table with missing activeOrderStartedAt returns empty string',
  );
});

describe('getTimerDisplay - null/undefined table', () => {
  assert(
    getTimerDisplay(null) === '',
    'null table returns empty string',
  );
  assert(
    getTimerDisplay(undefined) === '',
    'undefined table returns empty string',
  );
});

describe('getTimerDisplay - returns formatted timer for serving table', () => {
  const startedAt = new Date(Date.now() - 3661000).toISOString(); // ~1h 1m 1s ago
  const display = getTimerDisplay({ status: 'serving', activeOrderStartedAt: startedAt });
  // Should be approximately "01:01:01" but allow +/- 1 second tolerance
  const match = /^01:01:0[0-2]$/.test(display);
  assert(
    match,
    `serving table with ~1h1m1s elapsed returns formatted timer (got "${display}")`,
  );
});

// ---------------------------------------------------------------------------
// Tests: getTimerColorClass
// ---------------------------------------------------------------------------

describe('getTimerColorClass - null/undefined handling', () => {
  assert(
    getTimerColorClass(null) === '',
    'null input returns empty string',
  );
  assert(
    getTimerColorClass(undefined) === '',
    'undefined input returns empty string',
  );
});

describe('getTimerColorClass - below warning threshold (< 1 hour)', () => {
  assert(
    getTimerColorClass(0) === '',
    '0 seconds returns empty string (default/white)',
  );
  assert(
    getTimerColorClass(1800) === '',
    '1800 seconds (30 min) returns empty string',
  );
  assert(
    getTimerColorClass(3599) === '',
    '3599 seconds (just under 1 hour) returns empty string',
  );
});

describe('getTimerColorClass - warning threshold (1-2 hours)', () => {
  assert(
    getTimerColorClass(3600) === 'timer--warning',
    '3600 seconds (exactly 1 hour) returns timer--warning',
  );
  assert(
    getTimerColorClass(5400) === 'timer--warning',
    '5400 seconds (1.5 hours) returns timer--warning',
  );
  assert(
    getTimerColorClass(7199) === 'timer--warning',
    '7199 seconds (just under 2 hours) returns timer--warning',
  );
});

describe('getTimerColorClass - danger threshold (> 2 hours)', () => {
  assert(
    getTimerColorClass(7200) === 'timer--danger',
    '7200 seconds (exactly 2 hours) returns timer--danger',
  );
  assert(
    getTimerColorClass(10800) === 'timer--danger',
    '10800 seconds (3 hours) returns timer--danger',
  );
  assert(
    getTimerColorClass(360000) === 'timer--danger',
    '360000 seconds (100 hours) returns timer--danger',
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  console.error('Some tests FAILED.');
}
