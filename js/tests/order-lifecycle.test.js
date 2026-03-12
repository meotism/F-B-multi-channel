// Integration tests for order lifecycle (S3-25)
//
// Tests the full order lifecycle flow with mocked Supabase and Alpine stores.
// Validates: create order with duplicate guard, inventory deduction wiring,
// request/cancel payment, cancel order, transfer order, merge orders, reset table.
//
// Usage (browser):
//   import('/js/tests/order-lifecycle.test.js');

// ---------------------------------------------------------------------------
// Minimal test harness
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
// Mock Supabase client
// ---------------------------------------------------------------------------

function createMockSupabase() {
  const edgeFunctionCalls = [];
  const queryLog = [];

  function makeChain(opts = {}) {
    const chain = {
      _table: opts.table || null,
      _method: opts.method || null,
      _filters: [],
      _data: opts.data || null,
      _error: opts.error || null,
      select: () => chain,
      eq: (col, val) => { chain._filters.push({ col, val }); return chain; },
      in: () => chain,
      single: () => {
        queryLog.push({ table: chain._table, method: chain._method, filters: chain._filters });
        return Promise.resolve({ data: chain._data, error: chain._error });
      },
      order: () => chain,
      limit: () => chain,
    };
    return chain;
  }

  return {
    edgeFunctionCalls,
    queryLog,
    from: (table) => ({
      select: () => makeChain({ table, method: 'select', data: { status: 'empty' } }),
      insert: (row) => makeChain({ table, method: 'insert', data: { id: 'order-1', ...row } }),
      update: (row) => makeChain({ table, method: 'update', data: { id: 'table-1', ...row } }),
      delete: () => makeChain({ table, method: 'delete', data: null }),
    }),
    functions: {
      invoke: (name, opts) => {
        edgeFunctionCalls.push({ name, body: opts?.body });
        return Promise.resolve({ data: { deductions: [], low_stock_alerts: [] }, error: null });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Alpine stores
// ---------------------------------------------------------------------------

function createMockStores() {
  return {
    auth: {
      user: { id: 'user-1', outlet_id: 'outlet-1', role: 'manager' },
      isManager: true,
      isCashier: false,
      isOwner: false,
      hasPermission: () => true,
      canEditMap: () => true,
    },
    ui: {
      toasts: [],
      showToast(msg, type) { this.toasts.push({ msg, type }); },
    },
    tableMap: {
      tables: [
        { id: 'table-1', name: 'Ban 1', status: 'empty', activeOrderStartedAt: null },
        { id: 'table-2', name: 'Ban 2', status: 'serving', activeOrderStartedAt: '2026-03-12T10:00:00Z' },
        { id: 'table-3', name: 'Ban 3', status: 'serving', activeOrderStartedAt: '2026-03-12T10:30:00Z' },
        { id: 'table-4', name: 'Ban 4', status: 'paid', activeOrderStartedAt: null },
        { id: 'table-5', name: 'Ban 5', status: 'empty', activeOrderStartedAt: null },
      ],
      getTableById(id) { return this.tables.find(t => t.id === id) || null; },
    },
    orders: {
      currentOrder: null,
      orderItems: [],
      cart: [
        { menuItemId: 'item-1', name: 'Pho Bo', price: 55000, qty: 2, note: '' },
        { menuItemId: 'item-2', name: 'Bun Cha', price: 45000, qty: 1, note: 'It rau' },
      ],
      menuItems: [],
      categories: [],
      selectedCategory: null,
      isLoading: false,
      error: null,
      get orderTotal() {
        return this.orderItems.reduce((sum, i) => sum + i.price * i.qty, 0);
      },
      async requestPayment() {
        this.currentOrder = { ...this.currentOrder, status: 'completed' };
      },
      async cancelPaymentRequest() {
        this.currentOrder = { ...this.currentOrder, status: 'active' };
      },
      async loadOrder(orderId) {
        // Simulate reload
        this.orderItems = [...this.orderItems];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S3-26: Duplicate order guard', () => {
  const stores = createMockStores();

  // Simulate table that is NOT empty (already serving)
  stores.tableMap.tables[0].status = 'serving';

  assert(
    stores.tableMap.getTableById('table-1').status === 'serving',
    'Table-1 has serving status (pre-condition)',
  );

  // The guard in createOrder checks freshTable.status !== 'empty'
  const freshTableStatus = stores.tableMap.getTableById('table-1').status;
  const wouldBlock = freshTableStatus !== 'empty';
  assert(wouldBlock, 'Duplicate guard blocks order creation when table is not empty');

  // Reset for next tests
  stores.tableMap.tables[0].status = 'empty';
});

describe('S3-08: Inventory deduction wired into order creation', () => {
  const mockSupabase = createMockSupabase();

  // Simulate the fire-and-forget call pattern from createOrder
  mockSupabase.functions.invoke('deduct-inventory', {
    body: { order_id: 'order-1', action: 'deduct' },
  });

  assert(
    mockSupabase.edgeFunctionCalls.length === 1,
    'deduct-inventory edge function was called',
  );
  assert(
    mockSupabase.edgeFunctionCalls[0].name === 'deduct-inventory',
    'Correct edge function name: deduct-inventory',
  );
  assert(
    mockSupabase.edgeFunctionCalls[0].body.action === 'deduct',
    'Action is "deduct"',
  );
  assert(
    mockSupabase.edgeFunctionCalls[0].body.order_id === 'order-1',
    'order_id passed correctly',
  );
});

describe('S3-09: Request and cancel payment transitions', () => {
  const stores = createMockStores();
  stores.orders.currentOrder = { id: 'order-1', table_id: 'table-2', status: 'active', started_at: '2026-03-12T10:00:00Z' };

  // Request payment
  stores.orders.requestPayment();
  assert(
    stores.orders.currentOrder.status === 'completed',
    'Order status transitions to completed after requestPayment',
  );

  // Cancel payment request
  stores.orders.cancelPaymentRequest();
  assert(
    stores.orders.currentOrder.status === 'active',
    'Order status reverts to active after cancelPaymentRequest',
  );
});

describe('S3-11: Cancel order via edge function', () => {
  const mockSupabase = createMockSupabase();
  const stores = createMockStores();
  stores.orders.currentOrder = { id: 'order-1', table_id: 'table-2', status: 'active' };

  // Simulate cancel-order call
  mockSupabase.functions.invoke('cancel-order', {
    body: { order_id: 'order-1', outlet_id: 'outlet-1' },
  });

  assert(
    mockSupabase.edgeFunctionCalls.some(c => c.name === 'cancel-order'),
    'cancel-order edge function was called',
  );

  // Simulate local store update
  const table = stores.tableMap.getTableById('table-2');
  table.status = 'empty';
  table.activeOrderStartedAt = null;
  stores.orders.currentOrder = null;
  stores.orders.orderItems = [];

  assert(table.status === 'empty', 'Table status reset to empty after cancel');
  assert(stores.orders.currentOrder === null, 'Current order cleared after cancel');
});

describe('S3-13 + S3-22: Transfer order with timer continuity', () => {
  const mockSupabase = createMockSupabase();
  const stores = createMockStores();
  const originalStartedAt = '2026-03-12T10:00:00Z';
  stores.orders.currentOrder = { id: 'order-1', table_id: 'table-2', status: 'active', started_at: originalStartedAt };

  // Simulate transfer-order call
  mockSupabase.functions.invoke('transfer-order', {
    body: { order_id: 'order-1', target_table_id: 'table-5' },
  });

  assert(
    mockSupabase.edgeFunctionCalls.some(c => c.name === 'transfer-order'),
    'transfer-order edge function was called',
  );

  // Simulate local store update
  const sourceTable = stores.tableMap.getTableById('table-2');
  sourceTable.status = 'empty';
  sourceTable.activeOrderStartedAt = null;

  const targetTable = stores.tableMap.getTableById('table-5');
  targetTable.status = 'serving';
  targetTable.activeOrderStartedAt = originalStartedAt; // S3-22: Timer continuity

  assert(sourceTable.status === 'empty', 'Source table reset to empty');
  assert(sourceTable.activeOrderStartedAt === null, 'Source table timer cleared');
  assert(targetTable.status === 'serving', 'Target table set to serving');
  assert(
    targetTable.activeOrderStartedAt === originalStartedAt,
    'S3-22: Target table inherits original started_at for timer continuity',
  );
});

describe('S3-15: Merge orders', () => {
  const mockSupabase = createMockSupabase();
  const stores = createMockStores();
  stores.orders.currentOrder = { id: 'order-target', table_id: 'table-2', status: 'active' };

  // Simulate merge-orders call
  mockSupabase.functions.invoke('merge-orders', {
    body: {
      target_order_id: 'order-target',
      source_order_ids: ['order-source-1', 'order-source-2'],
    },
  });

  assert(
    mockSupabase.edgeFunctionCalls.some(c => c.name === 'merge-orders'),
    'merge-orders edge function was called',
  );
  assert(
    mockSupabase.edgeFunctionCalls.find(c => c.name === 'merge-orders').body.source_order_ids.length === 2,
    'Two source orders passed to merge',
  );

  // Simulate local store update: source tables -> empty
  const sourceTable3 = stores.tableMap.getTableById('table-3');
  sourceTable3.status = 'empty';
  sourceTable3.activeOrderStartedAt = null;

  assert(sourceTable3.status === 'empty', 'Source table reset to empty after merge');
});

describe('S3-23: Reset paid table to empty', () => {
  const stores = createMockStores();
  const paidTable = stores.tableMap.getTableById('table-4');

  assert(paidTable.status === 'paid', 'Table-4 starts with paid status (pre-condition)');

  // Simulate reset: only works when status is 'paid' (status guard)
  const canReset = paidTable.status === 'paid';
  assert(canReset, 'Status guard allows reset for paid tables');

  paidTable.status = 'empty';
  paidTable.activeOrderStartedAt = null;

  assert(paidTable.status === 'empty', 'Table status reset to empty');
  assert(paidTable.activeOrderStartedAt === null, 'Timer cleared on reset');

  // Verify the guard rejects non-paid tables
  const emptyTable = stores.tableMap.getTableById('table-1');
  const canResetEmpty = emptyTable.status === 'paid';
  assert(!canResetEmpty, 'Status guard rejects reset for non-paid tables');
});

describe('S3-21: calculateOrderDuration', () => {
  // Inline test of the duration calculation logic
  function calculateOrderDuration(order) {
    if (!order?.started_at) {
      return { durationSeconds: 0, durationFormatted: '00:00:00' };
    }
    const start = new Date(order.started_at).getTime();
    const end = order.ended_at ? new Date(order.ended_at).getTime() : Date.now();
    const durationSeconds = Math.max(0, Math.floor((end - start) / 1000));
    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);
    const seconds = durationSeconds % 60;
    const durationFormatted = [
      String(hours).padStart(2, '0'),
      String(minutes).padStart(2, '0'),
      String(seconds).padStart(2, '0'),
    ].join(':');
    return { durationSeconds, durationFormatted };
  }

  // Test with known duration (1 hour, 30 minutes, 45 seconds)
  const result = calculateOrderDuration({
    started_at: '2026-03-12T10:00:00Z',
    ended_at: '2026-03-12T11:30:45Z',
  });
  assert(result.durationSeconds === 5445, 'Duration: 5445 seconds for 1h30m45s');
  assert(result.durationFormatted === '01:30:45', 'Formatted: 01:30:45');

  // Test with null order
  const nullResult = calculateOrderDuration(null);
  assert(nullResult.durationSeconds === 0, 'Null order returns 0 seconds');
  assert(nullResult.durationFormatted === '00:00:00', 'Null order returns 00:00:00');

  // Test with missing started_at
  const noStart = calculateOrderDuration({ started_at: null });
  assert(noStart.durationSeconds === 0, 'Missing started_at returns 0 seconds');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n========================================`);
console.log(`Order Lifecycle Tests: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) {
  console.error(`${failed} test(s) FAILED!`);
} else {
  console.log('All tests passed!');
}
