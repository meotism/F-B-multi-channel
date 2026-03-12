// Performance tests for report queries
//
// Validates NFR 6.1.4: Report queries < 3 seconds for datasets under 10,000 bills.
// Requires a running local Supabase instance with seeded performance data.
//
// Setup:
//   1. supabase start
//   2. psql <local-db-url> -f js/tests/performance/seed-performance-data.sql
//
// Run:
//   node js/tests/performance/report-performance.test.js
//
// Requirements: 5.7.4, NFR 6.1.4
// Design reference: Section 9.5 Report Query < 3s Validation

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
// Configuration
// ---------------------------------------------------------------------------

// Local Supabase defaults (override via environment variables)
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Performance thresholds (milliseconds)
const REPORT_QUERY_THRESHOLD_MS = 3000;

// Test parameters: query across the full year of seeded data
const TEST_OUTLET_ID = process.env.TEST_OUTLET_ID || '';
const TEST_FROM = '2025-01-01T00:00:00Z';
const TEST_TO = '2026-01-01T00:00:00Z';

// ---------------------------------------------------------------------------
// Helper: measure async function execution time
// ---------------------------------------------------------------------------

async function measure(label, fn) {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  console.log(`  ${label}: ${elapsed.toFixed(0)}ms`);
  return { elapsed, result };
}

// ---------------------------------------------------------------------------
// Helper: call Supabase RPC via fetch (no SDK dependency)
// ---------------------------------------------------------------------------

async function rpc(fnName, params) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RPC ${fnName} failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Helper: invoke Edge Function via fetch
// ---------------------------------------------------------------------------

async function invokeEdgeFunction(fnName, body, authToken) {
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  const token = authToken || SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge Function ${fnName} failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Pre-flight: verify configuration
// ---------------------------------------------------------------------------

describe('Pre-flight checks', () => {
  assert(
    SUPABASE_URL.length > 0,
    `SUPABASE_URL is configured: ${SUPABASE_URL}`
  );

  assert(
    (SUPABASE_ANON_KEY.length > 0 || SUPABASE_SERVICE_ROLE_KEY.length > 0),
    'At least one API key is configured (set SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY env var)'
  );

  assert(
    TEST_OUTLET_ID.length > 0,
    'TEST_OUTLET_ID is configured (set TEST_OUTLET_ID env var to seeded outlet UUID)'
  );
});

// ---------------------------------------------------------------------------
// Performance tests (async, wrapped in IIFE)
// ---------------------------------------------------------------------------

(async () => {
  // Skip RPC tests if configuration is incomplete
  const canRunTests = SUPABASE_URL.length > 0
    && (SUPABASE_ANON_KEY.length > 0 || SUPABASE_SERVICE_ROLE_KEY.length > 0)
    && TEST_OUTLET_ID.length > 0;

  if (!canRunTests) {
    console.log('\nSkipping performance tests: missing configuration.');
    console.log('Set environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_OUTLET_ID');
    console.log('Then run: node js/tests/performance/report-performance.test.js');
    printSummary();
    return;
  }

  // ---------- Test 1: get_top_items RPC < 3 seconds ----------

  describe('Report query performance (10,000 bills)', async () => {
    try {
      const { elapsed: topItemsElapsed, result: topItemsData } = await measure(
        'get_top_items RPC',
        () => rpc('get_top_items', {
          p_outlet_id: TEST_OUTLET_ID,
          p_from: TEST_FROM,
          p_to: TEST_TO,
          p_limit: 10,
        })
      );

      assert(
        topItemsElapsed < REPORT_QUERY_THRESHOLD_MS,
        `get_top_items completed in ${topItemsElapsed.toFixed(0)}ms (threshold: ${REPORT_QUERY_THRESHOLD_MS}ms)`
      );

      assert(
        Array.isArray(topItemsData) && topItemsData.length > 0,
        `get_top_items returned ${Array.isArray(topItemsData) ? topItemsData.length : 0} items`
      );

      assert(
        topItemsData.length <= 10,
        `get_top_items respects p_limit=10, got ${topItemsData.length} items`
      );
    } catch (err) {
      failed++;
      console.error(`  FAIL: get_top_items RPC - ${err.message}`);
    }

    // ---------- Test 2: get_revenue_breakdown hourly < 3 seconds ----------

    try {
      const { elapsed: hourlyElapsed, result: hourlyData } = await measure(
        'get_revenue_breakdown (hourly) RPC',
        () => rpc('get_revenue_breakdown', {
          p_outlet_id: TEST_OUTLET_ID,
          p_from: TEST_FROM,
          p_to: TEST_TO,
          p_group_by: 'hour',
        })
      );

      assert(
        hourlyElapsed < REPORT_QUERY_THRESHOLD_MS,
        `get_revenue_breakdown (hourly) completed in ${hourlyElapsed.toFixed(0)}ms (threshold: ${REPORT_QUERY_THRESHOLD_MS}ms)`
      );

      assert(
        Array.isArray(hourlyData) && hourlyData.length > 0,
        `get_revenue_breakdown (hourly) returned ${Array.isArray(hourlyData) ? hourlyData.length : 0} periods`
      );

      // Hourly grouping should return at most 24 periods (00:00 - 23:00)
      assert(
        hourlyData.length <= 24,
        `get_revenue_breakdown (hourly) has <= 24 periods, got ${hourlyData.length}`
      );
    } catch (err) {
      failed++;
      console.error(`  FAIL: get_revenue_breakdown (hourly) RPC - ${err.message}`);
    }

    // ---------- Test 3: get_revenue_breakdown daily < 3 seconds ----------

    try {
      const { elapsed: dailyElapsed, result: dailyData } = await measure(
        'get_revenue_breakdown (daily) RPC',
        () => rpc('get_revenue_breakdown', {
          p_outlet_id: TEST_OUTLET_ID,
          p_from: TEST_FROM,
          p_to: TEST_TO,
          p_group_by: 'day',
        })
      );

      assert(
        dailyElapsed < REPORT_QUERY_THRESHOLD_MS,
        `get_revenue_breakdown (daily) completed in ${dailyElapsed.toFixed(0)}ms (threshold: ${REPORT_QUERY_THRESHOLD_MS}ms)`
      );

      assert(
        Array.isArray(dailyData) && dailyData.length > 0,
        `get_revenue_breakdown (daily) returned ${Array.isArray(dailyData) ? dailyData.length : 0} periods`
      );

      // Daily grouping across ~365 days should return <= 366 periods
      assert(
        dailyData.length <= 366,
        `get_revenue_breakdown (daily) has <= 366 periods, got ${dailyData.length}`
      );
    } catch (err) {
      failed++;
      console.error(`  FAIL: get_revenue_breakdown (daily) RPC - ${err.message}`);
    }

    // ---------- Test 4: aggregate-reports Edge Function < 3 seconds ----------

    try {
      const { elapsed: edgeFnElapsed, result: reportData } = await measure(
        'aggregate-reports Edge Function',
        () => invokeEdgeFunction('aggregate-reports', {
          from: TEST_FROM,
          to: TEST_TO,
          type: 'monthly',
        })
      );

      assert(
        edgeFnElapsed < REPORT_QUERY_THRESHOLD_MS,
        `aggregate-reports Edge Function completed in ${edgeFnElapsed.toFixed(0)}ms (threshold: ${REPORT_QUERY_THRESHOLD_MS}ms)`
      );

      assert(
        reportData != null && typeof reportData === 'object',
        'aggregate-reports returned a valid response object'
      );
    } catch (err) {
      failed++;
      console.error(`  FAIL: aggregate-reports Edge Function - ${err.message}`);
    }
  });

  printSummary();
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary() {
  console.log(`\n---\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) {
    console.error('SOME TESTS FAILED');
    if (typeof process !== 'undefined') process.exit(1);
  } else {
    console.log('ALL TESTS PASSED');
  }
}
