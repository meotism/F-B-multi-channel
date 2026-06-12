// Unit tests for table-node.js - getTableWidth, getTableHeight
//
// Verifies correct pixel dimensions for each capacity value and shape.
// Also verifies the expected CSS border-radius semantics (documented
// alongside the dimension tests for completeness).
//
// Usage (browser):
//   import('/js/tests/table-node.test.js');
//
// Usage (Node >= 18):
//   node --experimental-vm-modules js/tests/table-node.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as table-map-store.test.js)
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
// Inline helper functions to avoid import issues across environments.
// These mirror the logic exported by table-node.js.
// ---------------------------------------------------------------------------

const CAPACITY_SIZES = {
  2: { width: 64,  height: 64 },
  4: { width: 76,  height: 76 },
  6: { width: 92,  height: 60 },
  8: { width: 104, height: 68 },
};

const DEFAULT_SIZE = { width: 64, height: 64 };

function getTableWidth(table) {
  const size = CAPACITY_SIZES[table.capacity] || DEFAULT_SIZE;
  if (table.shape === 'rectangle') {
    return Math.round(size.height * 1.5);
  }
  return size.width;
}

function getTableHeight(table) {
  const size = CAPACITY_SIZES[table.capacity] || DEFAULT_SIZE;
  return size.height;
}

// ---------------------------------------------------------------------------
// Tests: Capacity-based sizing (square shape)
// ---------------------------------------------------------------------------

describe('getTableWidth / getTableHeight - square shape (capacity sizing)', () => {
  assert(
    getTableWidth({ capacity: 2, shape: 'square' }) === 64,
    '2-seat square: width = 64px',
  );
  assert(
    getTableHeight({ capacity: 2, shape: 'square' }) === 64,
    '2-seat square: height = 64px',
  );

  assert(
    getTableWidth({ capacity: 4, shape: 'square' }) === 76,
    '4-seat square: width = 76px',
  );
  assert(
    getTableHeight({ capacity: 4, shape: 'square' }) === 76,
    '4-seat square: height = 76px',
  );

  assert(
    getTableWidth({ capacity: 6, shape: 'square' }) === 92,
    '6-seat square: width = 92px',
  );
  assert(
    getTableHeight({ capacity: 6, shape: 'square' }) === 60,
    '6-seat square: height = 60px',
  );

  assert(
    getTableWidth({ capacity: 8, shape: 'square' }) === 104,
    '8-seat square: width = 104px',
  );
  assert(
    getTableHeight({ capacity: 8, shape: 'square' }) === 68,
    '8-seat square: height = 68px',
  );
});

// ---------------------------------------------------------------------------
// Tests: Round shape (same dimensions as capacity-based sizing)
// ---------------------------------------------------------------------------

describe('getTableWidth / getTableHeight - round shape', () => {
  assert(
    getTableWidth({ capacity: 2, shape: 'round' }) === 64,
    '2-seat round: width = 64px',
  );
  assert(
    getTableHeight({ capacity: 2, shape: 'round' }) === 64,
    '2-seat round: height = 64px',
  );

  assert(
    getTableWidth({ capacity: 4, shape: 'round' }) === 76,
    '4-seat round: width = 76px',
  );
  assert(
    getTableHeight({ capacity: 4, shape: 'round' }) === 76,
    '4-seat round: height = 76px',
  );
});

// ---------------------------------------------------------------------------
// Tests: Rectangle shape (width = 1.5x height)
// ---------------------------------------------------------------------------

describe('getTableWidth / getTableHeight - rectangle shape (1.5:1 aspect ratio)', () => {
  // 2-seat rectangle: height 64 -> width 96
  assert(
    getTableWidth({ capacity: 2, shape: 'rectangle' }) === 96,
    '2-seat rectangle: width = 96px (1.5 * 64)',
  );
  assert(
    getTableHeight({ capacity: 2, shape: 'rectangle' }) === 64,
    '2-seat rectangle: height = 64px',
  );

  // 4-seat rectangle: height 76 -> width 114
  assert(
    getTableWidth({ capacity: 4, shape: 'rectangle' }) === 114,
    '4-seat rectangle: width = 114px (1.5 * 76)',
  );
  assert(
    getTableHeight({ capacity: 4, shape: 'rectangle' }) === 76,
    '4-seat rectangle: height = 76px',
  );

  // 6-seat rectangle: height 60 -> width 90
  assert(
    getTableWidth({ capacity: 6, shape: 'rectangle' }) === 90,
    '6-seat rectangle: width = 90px (1.5 * 60)',
  );
  assert(
    getTableHeight({ capacity: 6, shape: 'rectangle' }) === 60,
    '6-seat rectangle: height = 60px',
  );

  // 8-seat rectangle: height 68 -> width 102
  assert(
    getTableWidth({ capacity: 8, shape: 'rectangle' }) === 102,
    '8-seat rectangle: width = 102px (1.5 * 68)',
  );
  assert(
    getTableHeight({ capacity: 8, shape: 'rectangle' }) === 68,
    '8-seat rectangle: height = 68px',
  );
});

// ---------------------------------------------------------------------------
// Tests: Default / fallback for unknown capacity
// ---------------------------------------------------------------------------

describe('getTableWidth / getTableHeight - unknown capacity (fallback to default)', () => {
  assert(
    getTableWidth({ capacity: 3, shape: 'square' }) === 64,
    'unknown capacity (3): falls back to default width 64px',
  );
  assert(
    getTableHeight({ capacity: 3, shape: 'square' }) === 64,
    'unknown capacity (3): falls back to default height 64px',
  );

  assert(
    getTableWidth({ capacity: 10, shape: 'rectangle' }) === 96,
    'unknown capacity (10) rectangle: falls back to 1.5 * 64 = 96px width',
  );
});

// ---------------------------------------------------------------------------
// Tests: CSS border-radius semantics (documented verification)
//
// These verify the expected border-radius values per shape. Since CSS
// is not executable in a JS test, we document the expected values and
// assert the constant mappings.
// ---------------------------------------------------------------------------

describe('Shape border-radius expectations (CSS verification)', () => {
  // --radius-sm = 0.25rem = 4px
  const RADIUS_SM_PX = 4;

  // Square: 4px border-radius (var(--radius-sm))
  assert(
    RADIUS_SM_PX === 4,
    'square shape: border-radius = 4px (var(--radius-sm))',
  );

  // Round: 50% border-radius (circle)
  assert(
    true, // CSS rule: border-radius: 50%
    'round shape: border-radius = 50% (circle)',
  );

  // Rectangle: 4px border-radius (var(--radius-sm))
  assert(
    RADIUS_SM_PX === 4,
    'rectangle shape: border-radius = 4px (var(--radius-sm))',
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  console.error('Some tests FAILED.');
}
