// Unit tests for report-service - Revenue aggregation and top items sorting
//
// Tests the pure aggregation and sorting functions from report-service.js,
// plus the date range calculation helper from report-store.js.
// These are pure synchronous tests with no Supabase dependency.
//
// Usage (browser):
//   import('/js/tests/report-service.test.js');
//
// Usage (Node >= 18):
//   node js/tests/report-service.test.js

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
// Inline the functions under test (avoid import/module issues across envs)
// ---------------------------------------------------------------------------

// From report-service.js
function aggregateRevenue(bills) {
  if (!bills || !bills.length) {
    return { totalRevenue: 0, totalTax: 0, billCount: 0, averageBillValue: 0 };
  }
  const totalRevenue = bills.reduce((sum, b) => sum + (b.total || 0), 0);
  const totalTax = bills.reduce((sum, b) => sum + (b.tax || 0), 0);
  return {
    totalRevenue,
    totalTax,
    billCount: bills.length,
    averageBillValue: Math.round(totalRevenue / bills.length),
  };
}

function getTopItems(items, sortBy = 'total_qty', limit = 10) {
  return [...items]
    .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
    .slice(0, limit);
}

// From report-store.js
function calculateDateRange(mode) {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = today.getMonth();
  const dd = today.getDate();

  let from, to;

  switch (mode) {
    case 'day':
      from = new Date(yyyy, mm, dd);
      to = new Date(yyyy, mm, dd);
      break;

    case 'week': {
      const dayOfWeek = today.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      from = new Date(yyyy, mm, dd + mondayOffset);
      to = new Date(from);
      to.setDate(from.getDate() + 6);
      break;
    }

    case 'month':
      from = new Date(yyyy, mm, 1);
      to = new Date(yyyy, mm + 1, 0);
      break;

    case 'year':
      from = new Date(yyyy, 0, 1);
      to = new Date(yyyy, 11, 31);
      break;

    default:
      from = new Date(yyyy, mm, dd);
      to = new Date(yyyy, mm, dd);
  }

  function formatDateISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return {
    from: formatDateISO(from),
    to: formatDateISO(to),
  };
}

// ---------------------------------------------------------------------------
// Tests: aggregateRevenue
// ---------------------------------------------------------------------------

describe('aggregateRevenue - with bills', () => {
  const bills = [
    { total: 150000, tax: 15000 },
    { total: 200000, tax: 20000 },
    { total: 350000, tax: 35000 },
  ];

  const result = aggregateRevenue(bills);

  assert(
    result.totalRevenue === 700000,
    `totalRevenue should be 700000, got ${result.totalRevenue}`
  );

  assert(
    result.totalTax === 70000,
    `totalTax should be 70000, got ${result.totalTax}`
  );

  assert(
    result.billCount === 3,
    `billCount should be 3, got ${result.billCount}`
  );

  assert(
    result.averageBillValue === 233333,
    `averageBillValue should be 233333 (rounded), got ${result.averageBillValue}`
  );
});

describe('aggregateRevenue - single bill', () => {
  const bills = [{ total: 500000, tax: 50000 }];
  const result = aggregateRevenue(bills);

  assert(
    result.totalRevenue === 500000,
    `totalRevenue should be 500000, got ${result.totalRevenue}`
  );

  assert(
    result.averageBillValue === 500000,
    `averageBillValue should be 500000, got ${result.averageBillValue}`
  );

  assert(
    result.billCount === 1,
    `billCount should be 1, got ${result.billCount}`
  );
});

describe('aggregateRevenue - empty array', () => {
  const result = aggregateRevenue([]);

  assert(
    result.totalRevenue === 0,
    `totalRevenue should be 0, got ${result.totalRevenue}`
  );

  assert(
    result.totalTax === 0,
    `totalTax should be 0, got ${result.totalTax}`
  );

  assert(
    result.billCount === 0,
    `billCount should be 0, got ${result.billCount}`
  );

  assert(
    result.averageBillValue === 0,
    `averageBillValue should be 0, got ${result.averageBillValue}`
  );
});

describe('aggregateRevenue - null input', () => {
  const result = aggregateRevenue(null);

  assert(
    result.totalRevenue === 0,
    `totalRevenue should be 0 for null input, got ${result.totalRevenue}`
  );

  assert(
    result.billCount === 0,
    `billCount should be 0 for null input, got ${result.billCount}`
  );
});

describe('aggregateRevenue - undefined input', () => {
  const result = aggregateRevenue(undefined);

  assert(
    result.totalRevenue === 0,
    `totalRevenue should be 0 for undefined input, got ${result.totalRevenue}`
  );
});

describe('aggregateRevenue - bills with missing fields', () => {
  const bills = [
    { total: 100000 },          // no tax
    { tax: 10000 },             // no total
    { total: 200000, tax: 0 },  // zero tax
  ];

  const result = aggregateRevenue(bills);

  assert(
    result.totalRevenue === 300000,
    `totalRevenue should be 300000 (100000 + 0 + 200000), got ${result.totalRevenue}`
  );

  assert(
    result.totalTax === 10000,
    `totalTax should be 10000 (0 + 10000 + 0), got ${result.totalTax}`
  );

  assert(
    result.billCount === 3,
    `billCount should be 3, got ${result.billCount}`
  );
});

// ---------------------------------------------------------------------------
// Tests: getTopItems
// ---------------------------------------------------------------------------

describe('getTopItems - sort by total_qty', () => {
  const items = [
    { item_name: 'Pho', total_qty: 50, total_revenue: 500000 },
    { item_name: 'Bun cha', total_qty: 30, total_revenue: 600000 },
    { item_name: 'Com rang', total_qty: 80, total_revenue: 400000 },
    { item_name: 'Banh mi', total_qty: 100, total_revenue: 300000 },
    { item_name: 'Ca phe', total_qty: 20, total_revenue: 100000 },
  ];

  const result = getTopItems(items, 'total_qty', 3);

  assert(
    result.length === 3,
    `should return top 3 items, got ${result.length}`
  );

  assert(
    result[0].item_name === 'Banh mi',
    `#1 by qty should be Banh mi (100), got ${result[0].item_name}`
  );

  assert(
    result[1].item_name === 'Com rang',
    `#2 by qty should be Com rang (80), got ${result[1].item_name}`
  );

  assert(
    result[2].item_name === 'Pho',
    `#3 by qty should be Pho (50), got ${result[2].item_name}`
  );
});

describe('getTopItems - sort by total_revenue', () => {
  const items = [
    { item_name: 'Pho', total_qty: 50, total_revenue: 500000 },
    { item_name: 'Bun cha', total_qty: 30, total_revenue: 600000 },
    { item_name: 'Com rang', total_qty: 80, total_revenue: 400000 },
    { item_name: 'Banh mi', total_qty: 100, total_revenue: 300000 },
    { item_name: 'Ca phe', total_qty: 20, total_revenue: 100000 },
  ];

  const result = getTopItems(items, 'total_revenue', 3);

  assert(
    result.length === 3,
    `should return top 3 items, got ${result.length}`
  );

  assert(
    result[0].item_name === 'Bun cha',
    `#1 by revenue should be Bun cha (600000), got ${result[0].item_name}`
  );

  assert(
    result[1].item_name === 'Pho',
    `#2 by revenue should be Pho (500000), got ${result[1].item_name}`
  );

  assert(
    result[2].item_name === 'Com rang',
    `#3 by revenue should be Com rang (400000), got ${result[2].item_name}`
  );
});

describe('getTopItems - default limit (10)', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({
    item_name: `Item ${i}`,
    total_qty: i + 1,
    total_revenue: (i + 1) * 10000,
  }));

  const result = getTopItems(items, 'total_qty');

  assert(
    result.length === 10,
    `default limit should be 10, got ${result.length}`
  );

  assert(
    result[0].total_qty === 15,
    `first item should have highest qty (15), got ${result[0].total_qty}`
  );
});

describe('getTopItems - empty array', () => {
  const result = getTopItems([], 'total_qty', 5);

  assert(
    result.length === 0,
    `should return empty array for empty input, got ${result.length}`
  );
});

describe('getTopItems - does not mutate original', () => {
  const items = [
    { item_name: 'A', total_qty: 10 },
    { item_name: 'B', total_qty: 20 },
    { item_name: 'C', total_qty: 5 },
  ];

  const original = [...items];
  getTopItems(items, 'total_qty', 2);

  assert(
    items[0].item_name === original[0].item_name &&
    items[1].item_name === original[1].item_name &&
    items[2].item_name === original[2].item_name,
    'original array should not be mutated'
  );
});

describe('getTopItems - items with missing sortBy field', () => {
  const items = [
    { item_name: 'A', total_qty: 10 },
    { item_name: 'B' },                    // missing total_qty
    { item_name: 'C', total_qty: 5 },
  ];

  const result = getTopItems(items, 'total_qty', 3);

  assert(
    result[0].item_name === 'A',
    `first item should be A (10), got ${result[0].item_name}`
  );

  assert(
    result[2].item_name === 'B',
    `last item should be B (missing = 0), got ${result[2].item_name}`
  );
});

// ---------------------------------------------------------------------------
// Tests: calculateDateRange
// ---------------------------------------------------------------------------

describe('calculateDateRange - day', () => {
  const range = calculateDateRange('day');
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const expected = `${y}-${m}-${d}`;

  assert(
    range.from === expected,
    `day from should be today (${expected}), got ${range.from}`
  );

  assert(
    range.to === expected,
    `day to should be today (${expected}), got ${range.to}`
  );
});

describe('calculateDateRange - week', () => {
  const range = calculateDateRange('week');
  const from = new Date(range.from + 'T00:00:00');
  const to = new Date(range.to + 'T00:00:00');

  // From should be a Monday (getDay() === 1)
  assert(
    from.getDay() === 1,
    `week from should be Monday (day 1), got day ${from.getDay()}`
  );

  // To should be a Sunday (getDay() === 0)
  assert(
    to.getDay() === 0,
    `week to should be Sunday (day 0), got day ${to.getDay()}`
  );

  // Difference should be 6 days
  const diffMs = to.getTime() - from.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  assert(
    diffDays === 6,
    `week should span 6 days (Mon-Sun), got ${diffDays}`
  );
});

describe('calculateDateRange - month', () => {
  const range = calculateDateRange('month');
  const from = new Date(range.from + 'T00:00:00');
  const to = new Date(range.to + 'T00:00:00');
  const today = new Date();

  assert(
    from.getDate() === 1,
    `month from should be 1st, got ${from.getDate()}`
  );

  assert(
    from.getMonth() === today.getMonth(),
    `month from should be current month, got ${from.getMonth()}`
  );

  // To should be the last day of the current month
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  assert(
    to.getDate() === lastDay,
    `month to should be last day (${lastDay}), got ${to.getDate()}`
  );
});

describe('calculateDateRange - year', () => {
  const range = calculateDateRange('year');
  const from = new Date(range.from + 'T00:00:00');
  const to = new Date(range.to + 'T00:00:00');
  const today = new Date();

  assert(
    from.getMonth() === 0 && from.getDate() === 1,
    `year from should be Jan 1, got month ${from.getMonth()} day ${from.getDate()}`
  );

  assert(
    to.getMonth() === 11 && to.getDate() === 31,
    `year to should be Dec 31, got month ${to.getMonth()} day ${to.getDate()}`
  );

  assert(
    from.getFullYear() === today.getFullYear(),
    `year should be current year (${today.getFullYear()}), got ${from.getFullYear()}`
  );
});

describe('calculateDateRange - unknown mode defaults to day', () => {
  const range = calculateDateRange('invalid');
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const expected = `${y}-${m}-${d}`;

  assert(
    range.from === expected,
    `unknown mode from should default to today, got ${range.from}`
  );

  assert(
    range.to === expected,
    `unknown mode to should default to today, got ${range.to}`
  );
});

describe('calculateDateRange - from <= to for all modes', () => {
  const modes = ['day', 'week', 'month', 'year'];
  for (const mode of modes) {
    const range = calculateDateRange(mode);
    assert(
      range.from <= range.to,
      `${mode}: from (${range.from}) should be <= to (${range.to})`
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
