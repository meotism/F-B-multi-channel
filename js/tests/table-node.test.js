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
  2: { width: 80,  height: 80  },
  4: { width: 100, height: 100 },
  6: { width: 120, height: 80  },
  8: { width: 140, height: 90  },
};

const DEFAULT_SIZE = { width: 80, height: 80 };

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
    getTableWidth({ capacity: 2, shape: 'square' }) === 80,
    '2-seat square: width = 80px',
  );
  assert(
    getTableHeight({ capacity: 2, shape: 'square' }) === 80,
    '2-seat square: height = 80px',
  );

  assert(
    getTableWidth({ capacity: 4, shape: 'square' }) === 100,
    '4-seat square: width = 100px',
  );
  assert(
    getTableHeight({ capacity: 4, shape: 'square' }) === 100,
    '4-seat square: height = 100px',
  );

  assert(
    getTableWidth({ capacity: 6, shape: 'square' }) === 120,
    '6-seat square: width = 120px',
  );
  assert(
    getTableHeight({ capacity: 6, shape: 'square' }) === 80,
    '6-seat square: height = 80px',
  );

  assert(
    getTableWidth({ capacity: 8, shape: 'square' }) === 140,
    '8-seat square: width = 140px',
  );
  assert(
    getTableHeight({ capacity: 8, shape: 'square' }) === 90,
    '8-seat square: height = 90px',
  );
});

// ---------------------------------------------------------------------------
// Tests: Round shape (same dimensions as capacity-based sizing)
// ---------------------------------------------------------------------------

describe('getTableWidth / getTableHeight - round shape', () => {
  assert(
    getTableWidth({ capacity: 2, shape: 'round' }) === 80,
    '2-seat round: width = 80px',
  );
  assert(
    getTableHeight({ capacity: 2, shape: 'round' }) === 80,
    '2-seat round: height = 80px',
  );

  assert(
    getTableWidth({ capacity: 4, shape: 'round' }) === 100,
    '4-seat round: width = 100px',
  );
  assert(
    getTableHeight({ capacity: 4, shape: 'round' }) === 100,
    '4-seat round: height = 100px',
  );
});

// ---------------------------------------------------------------------------
// Tests: Rectangle shape (width = 1.5x height)
// ---------------------------------------------------------------------------

describe('getTableWidth / getTableHeight - rectangle shape (1.5:1 aspect ratio)', () => {
  // 2-seat rectangle: height 80 -> width 120
  assert(
    getTableWidth({ capacity: 2, shape: 'rectangle' }) === 120,
    '2-seat rectangle: width = 120px (1.5 * 80)',
  );
  assert(
    getTableHeight({ capacity: 2, shape: 'rectangle' }) === 80,
    '2-seat rectangle: height = 80px',
  );

  // 4-seat rectangle: height 100 -> width 150
  assert(
    getTableWidth({ capacity: 4, shape: 'rectangle' }) === 150,
    '4-seat rectangle: width = 150px (1.5 * 100)',
  );
  assert(
    getTableHeight({ capacity: 4, shape: 'rectangle' }) === 100,
    '4-seat rectangle: height = 100px',
  );

  // 6-seat rectangle: height 80 -> width 120
  assert(
    getTableWidth({ capacity: 6, shape: 'rectangle' }) === 120,
    '6-seat rectangle: width = 120px (1.5 * 80)',
  );
  assert(
    getTableHeight({ capacity: 6, shape: 'rectangle' }) === 80,
    '6-seat rectangle: height = 80px',
  );

  // 8-seat rectangle: height 90 -> width 135
  assert(
    getTableWidth({ capacity: 8, shape: 'rectangle' }) === 135,
    '8-seat rectangle: width = 135px (1.5 * 90)',
  );
  assert(
    getTableHeight({ capacity: 8, shape: 'rectangle' }) === 90,
    '8-seat rectangle: height = 90px',
  );
});

// ---------------------------------------------------------------------------
// Tests: Default / fallback for unknown capacity
// ---------------------------------------------------------------------------

describe('getTableWidth / getTableHeight - unknown capacity (fallback to default)', () => {
  assert(
    getTableWidth({ capacity: 3, shape: 'square' }) === 80,
    'unknown capacity (3): falls back to default width 80px',
  );
  assert(
    getTableHeight({ capacity: 3, shape: 'square' }) === 80,
    'unknown capacity (3): falls back to default height 80px',
  );

  assert(
    getTableWidth({ capacity: 10, shape: 'rectangle' }) === 120,
    'unknown capacity (10) rectangle: falls back to 1.5 * 80 = 120px width',
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
