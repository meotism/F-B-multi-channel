// Realtime sync performance test
//
// Validates NFR 6.1.3: Table status changes propagate to all connected
// devices within 2 seconds via Supabase Realtime (WebSocket).
//
// Requires a running local Supabase instance with at least one table row.
// The seed-performance-data.sql script creates suitable test data.
//
// Setup:
//   1. supabase start
//   2. psql <local-db-url> -f js/tests/performance/seed-performance-data.sql
//
// Run:
//   node js/tests/performance/realtime-performance.test.js
//
// Requirements: NFR 6.1.3
// Design reference: Section 9.5 Realtime Sync < 2s Validation

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

// Performance threshold (milliseconds)
const REALTIME_SYNC_THRESHOLD_MS = 2000;

// Table to use for the test (set to a seeded table UUID)
const TEST_TABLE_ID = process.env.TEST_TABLE_ID || '';

// Supabase Realtime WebSocket URL (derived from REST URL)
const WS_URL = SUPABASE_URL.replace(/^http/, 'ws') + '/realtime/v1/websocket';

// ---------------------------------------------------------------------------
// Helper: update table status via REST API
// ---------------------------------------------------------------------------

async function updateTableStatus(tableId, newStatus) {
  const url = `${SUPABASE_URL}/rest/v1/tables?id=eq.${tableId}`;
  const apiKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      status: newStatus,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Table update failed (${response.status}): ${errorText}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: get current table status via REST API
// ---------------------------------------------------------------------------

async function getTableStatus(tableId) {
  const url = `${SUPABASE_URL}/rest/v1/tables?id=eq.${tableId}&select=status`;
  const apiKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Table fetch failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.length > 0 ? data[0].status : null;
}

// ---------------------------------------------------------------------------
// Realtime subscription via native WebSocket
// ---------------------------------------------------------------------------
// Uses the Supabase Realtime protocol (Phoenix channels) over WebSocket.
// This avoids depending on the @supabase/supabase-js npm package.

function createRealtimeSubscription(tableId, onChangeCallback) {
  return new Promise((resolve, reject) => {
    const apiKey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
    const wsUrl = `${WS_URL}?apikey=${apiKey}&vsn=1.0.0`;

    // Use dynamic import for Node.js WebSocket (built-in since Node 21,
    // or available via 'ws' package on older versions)
    let WebSocketImpl;
    try {
      WebSocketImpl = globalThis.WebSocket || require('ws');
    } catch {
      reject(new Error('WebSocket not available. Node >= 21 required, or install "ws" package.'));
      return;
    }

    const ws = new WebSocketImpl(wsUrl);
    let heartbeatInterval;
    let ref = 0;

    function send(topic, event, payload) {
      ref++;
      ws.send(JSON.stringify({
        topic,
        event,
        payload,
        ref: String(ref),
      }));
    }

    ws.onopen = () => {
      // Join the Phoenix channel for postgres_changes on the tables table
      const channelTopic = `realtime:public:tables:id=eq.${tableId}`;

      send(channelTopic, 'phx_join', {
        config: {
          broadcast: { self: false },
          postgres_changes: [
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'tables',
              filter: `id=eq.${tableId}`,
            },
          ],
        },
      });

      // Start heartbeat (required by Phoenix channels, every 30s)
      heartbeatInterval = setInterval(() => {
        send('phoenix', 'heartbeat', {});
      }, 30000);

      // Give the subscription time to establish before resolving
      setTimeout(() => {
        resolve({
          ws,
          close: () => {
            clearInterval(heartbeatInterval);
            ws.close();
          },
        });
      }, 1000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());

        // Look for postgres_changes events (UPDATE on tables)
        if (msg.event === 'postgres_changes' || msg.event === 'UPDATE') {
          onChangeCallback(msg.payload);
        }

        // Also check for system-level broadcast of the change
        if (msg.payload && msg.payload.type === 'postgres_changes') {
          onChangeCallback(msg.payload);
        }
      } catch {
        // Ignore non-JSON messages (heartbeat acks, etc.)
      }
    };

    ws.onerror = (err) => {
      clearInterval(heartbeatInterval);
      reject(new Error(`WebSocket error: ${err.message || 'connection failed'}`));
    };

    ws.onclose = () => {
      clearInterval(heartbeatInterval);
    };
  });
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
    TEST_TABLE_ID.length > 0,
    'TEST_TABLE_ID is configured (set TEST_TABLE_ID env var to a seeded table UUID)'
  );
});

// ---------------------------------------------------------------------------
// Performance tests (async, wrapped in IIFE)
// ---------------------------------------------------------------------------

(async () => {
  const canRunTests = SUPABASE_URL.length > 0
    && (SUPABASE_ANON_KEY.length > 0 || SUPABASE_SERVICE_ROLE_KEY.length > 0)
    && TEST_TABLE_ID.length > 0;

  if (!canRunTests) {
    console.log('\nSkipping realtime performance tests: missing configuration.');
    console.log('Set environment variables: SUPABASE_URL, SUPABASE_ANON_KEY, TEST_TABLE_ID');
    console.log('Then run: node js/tests/performance/realtime-performance.test.js');
    printSummary();
    return;
  }

  // ---------- Test 1: Table status change propagation < 2 seconds ----------

  console.log('\nRealtime sync performance');

  let subscription = null;

  try {
    // 1. Get current table status to determine the toggle target
    const currentStatus = await getTableStatus(TEST_TABLE_ID);
    const targetStatus = currentStatus === 'serving' ? 'empty' : 'serving';

    console.log(`  Current table status: ${currentStatus}`);
    console.log(`  Will update to: ${targetStatus}`);

    // 2. Subscribe to table changes via Realtime WebSocket
    let changeReceived = false;
    let receiveTime = 0;

    subscription = await createRealtimeSubscription(TEST_TABLE_ID, (payload) => {
      if (!changeReceived) {
        changeReceived = true;
        receiveTime = performance.now();
      }
    });

    console.log('  Realtime subscription established, waiting 500ms for stability...');
    await new Promise((r) => setTimeout(r, 500));

    // 3. Record the update timestamp and trigger the status change
    const updateStartTime = performance.now();
    await updateTableStatus(TEST_TABLE_ID, targetStatus);
    console.log(`  Table status update sent at ${updateStartTime.toFixed(0)}ms`);

    // 4. Wait for the Realtime callback (with timeout)
    const timeoutMs = REALTIME_SYNC_THRESHOLD_MS + 500; // small buffer for test mechanics
    const deadline = performance.now() + timeoutMs;

    while (!changeReceived && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (changeReceived) {
      const propagationMs = receiveTime - updateStartTime;

      assert(
        propagationMs < REALTIME_SYNC_THRESHOLD_MS,
        `Table status change propagated in ${propagationMs.toFixed(0)}ms (threshold: ${REALTIME_SYNC_THRESHOLD_MS}ms)`
      );

      assert(
        propagationMs >= 0,
        `Propagation time is non-negative: ${propagationMs.toFixed(0)}ms`
      );
    } else {
      failed++;
      console.error(`  FAIL: Realtime notification not received within ${timeoutMs}ms`);
    }

    // 5. Restore original status
    await updateTableStatus(TEST_TABLE_ID, currentStatus || 'empty');
    console.log(`  Table status restored to: ${currentStatus || 'empty'}`);

  } catch (err) {
    failed++;
    console.error(`  FAIL: Realtime sync test - ${err.message}`);
  } finally {
    // Clean up WebSocket connection
    if (subscription) {
      subscription.close();
    }
  }

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
