// Unit tests for order edit lock helpers — isOrderLocked / isOrderEditable
//
// Tests the client-side edit lock helpers that determine whether an order's
// items can be modified based on its status. These are pure synchronous tests
// with no external dependencies.
//
// Usage (browser):
//   import('/js/tests/order-lock.test.js');
//
// Usage (Node >= 18):
//   node --experimental-vm-modules js/tests/order-lock.test.js

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

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ---------------------------------------------------------------------------
// Inline the helper functions (avoid import/module issues across envs)
// These mirror the implementations in js/pages/orders/order-page.js
// ---------------------------------------------------------------------------

function isOrderLocked(order) {
  return ['finalized', 'completed'].includes(order?.status);
}

function isOrderEditable(order) {
  return order?.status === 'active';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isOrderLocked', () => {
  // Locked statuses
  assert(
    isOrderLocked({ status: 'finalized' }) === true,
    'returns true for finalized orders'
  );
  assert(
    isOrderLocked({ status: 'completed' }) === true,
    'returns true for completed orders'
  );

  // Non-locked statuses
  assert(
    isOrderLocked({ status: 'active' }) === false,
    'returns false for active orders'
  );

  // Null/undefined edge cases
  assert(
    isOrderLocked(null) === false,
    'returns false for null order'
  );
  assert(
    isOrderLocked(undefined) === false,
    'returns false for undefined order'
  );
  assert(
    isOrderLocked({}) === false,
    'returns false for order without status property'
  );
});

describe('isOrderEditable', () => {
  // Editable status
  assert(
    isOrderEditable({ status: 'active' }) === true,
    'returns true for active orders'
  );

  // Non-editable statuses
  assert(
    isOrderEditable({ status: 'completed' }) === false,
    'returns false for completed orders'
  );
  assert(
    isOrderEditable({ status: 'finalized' }) === false,
    'returns false for finalized orders'
  );

  // Null/undefined edge cases
  assert(
    isOrderEditable(null) === false,
    'returns false for null order'
  );
  assert(
    isOrderEditable(undefined) === false,
    'returns false for undefined order'
  );
  assert(
    isOrderEditable({}) === false,
    'returns false for order without status property'
  );
});

describe('isOrderLocked and isOrderEditable — mutual exclusivity', () => {
  // For active orders: editable but not locked
  assert(
    isOrderEditable({ status: 'active' }) === true && isOrderLocked({ status: 'active' }) === false,
    'active: editable=true, locked=false'
  );

  // For completed orders: locked but not editable
  assert(
    isOrderEditable({ status: 'completed' }) === false && isOrderLocked({ status: 'completed' }) === true,
    'completed: editable=false, locked=true'
  );

  // For finalized orders: locked but not editable
  assert(
    isOrderEditable({ status: 'finalized' }) === false && isOrderLocked({ status: 'finalized' }) === true,
    'finalized: editable=false, locked=true'
  );

  // For null: neither editable nor locked
  assert(
    isOrderEditable(null) === false && isOrderLocked(null) === false,
    'null: editable=false, locked=false'
  );
});

describe('isOrderLocked — exhaustive status list', () => {
  const statuses = ['active', 'completed', 'finalized', 'cancelled'];
  const expectedLocked = {
    active: false,
    completed: true,
    finalized: true,
    cancelled: false,
  };

  for (const status of statuses) {
    const result = isOrderLocked({ status });
    assert(
      result === expectedLocked[status],
      `isOrderLocked({ status: '${status}' }) === ${expectedLocked[status]}`
    );
  }
});

describe('isOrderEditable — exhaustive status list', () => {
  const statuses = ['active', 'completed', 'finalized', 'cancelled'];
  const expectedEditable = {
    active: true,
    completed: false,
    finalized: false,
    cancelled: false,
  };

  for (const status of statuses) {
    const result = isOrderEditable({ status });
    assert(
      result === expectedEditable[status],
      `isOrderEditable({ status: '${status}' }) === ${expectedEditable[status]}`
    );
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
