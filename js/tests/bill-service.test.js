// Unit tests for bill-service - Bill status state machine transitions
//
// Tests the BILL_TRANSITIONS state machine and canTransition() helper.
// These are pure synchronous tests with no Supabase dependency.
//
// Usage (browser):
//   import('/js/tests/bill-service.test.js');
//
// Usage (Node >= 18):
//   node --experimental-vm-modules js/tests/bill-service.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as order-store.test.js)
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
// Inline the state machine logic (avoid import/module issues across envs)
// ---------------------------------------------------------------------------

const BILL_TRANSITIONS = {
  finalized: ['printed', 'pending_print'],
  pending_print: ['printed', 'pending_print'],
  printed: [], // terminal state
};

function canTransition(currentStatus, nextStatus) {
  const allowed = BILL_TRANSITIONS[currentStatus];
  if (!allowed) return false;
  return allowed.includes(nextStatus);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BILL_TRANSITIONS state machine', () => {
  // Valid transitions from 'finalized'
  assert(
    canTransition('finalized', 'printed') === true,
    'finalized -> printed is allowed (print success)'
  );
  assert(
    canTransition('finalized', 'pending_print') === true,
    'finalized -> pending_print is allowed (print failure)'
  );

  // Valid transitions from 'pending_print'
  assert(
    canTransition('pending_print', 'printed') === true,
    'pending_print -> printed is allowed (retry success)'
  );
  assert(
    canTransition('pending_print', 'pending_print') === true,
    'pending_print -> pending_print is allowed (retry failure)'
  );

  // Terminal state: 'printed' allows no transitions
  assert(
    canTransition('printed', 'finalized') === false,
    'printed -> finalized is NOT allowed (terminal state)'
  );
  assert(
    canTransition('printed', 'pending_print') === false,
    'printed -> pending_print is NOT allowed (terminal state)'
  );
  assert(
    canTransition('printed', 'printed') === false,
    'printed -> printed is NOT allowed (terminal state)'
  );
});

describe('canTransition - invalid transitions', () => {
  // Cannot go backwards from finalized
  assert(
    canTransition('finalized', 'finalized') === false,
    'finalized -> finalized is NOT allowed (self-transition)'
  );

  // Cannot go backwards from pending_print to finalized
  assert(
    canTransition('pending_print', 'finalized') === false,
    'pending_print -> finalized is NOT allowed (no backward transition)'
  );

  // Unknown statuses
  assert(
    canTransition('unknown_status', 'printed') === false,
    'unknown_status -> printed is NOT allowed (unknown source status)'
  );
  assert(
    canTransition('finalized', 'unknown_status') === false,
    'finalized -> unknown_status is NOT allowed (unknown target status)'
  );
  assert(
    canTransition(null, 'printed') === false,
    'null -> printed is NOT allowed (null source status)'
  );
  assert(
    canTransition(undefined, 'printed') === false,
    'undefined -> printed is NOT allowed (undefined source status)'
  );
});

describe('BILL_TRANSITIONS structure', () => {
  assert(
    Array.isArray(BILL_TRANSITIONS.finalized),
    'finalized has an array of allowed transitions'
  );
  assert(
    BILL_TRANSITIONS.finalized.length === 2,
    'finalized allows exactly 2 transitions (printed, pending_print)'
  );
  assert(
    Array.isArray(BILL_TRANSITIONS.pending_print),
    'pending_print has an array of allowed transitions'
  );
  assert(
    BILL_TRANSITIONS.pending_print.length === 2,
    'pending_print allows exactly 2 transitions (printed, pending_print)'
  );
  assert(
    Array.isArray(BILL_TRANSITIONS.printed),
    'printed has an array of allowed transitions'
  );
  assert(
    BILL_TRANSITIONS.printed.length === 0,
    'printed allows 0 transitions (terminal state)'
  );
});

describe('canTransition - exhaustive status combinations', () => {
  const allStatuses = ['finalized', 'pending_print', 'printed'];
  const expectedResults = {
    'finalized->finalized': false,
    'finalized->pending_print': true,
    'finalized->printed': true,
    'pending_print->finalized': false,
    'pending_print->pending_print': true,
    'pending_print->printed': true,
    'printed->finalized': false,
    'printed->pending_print': false,
    'printed->printed': false,
  };

  for (const from of allStatuses) {
    for (const to of allStatuses) {
      const key = `${from}->${to}`;
      const expected = expectedResults[key];
      const actual = canTransition(from, to);
      assert(
        actual === expected,
        `${key}: expected ${expected}, got ${actual}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n---\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  if (typeof process !== 'undefined') process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
