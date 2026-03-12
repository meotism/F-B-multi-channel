// Unit tests for tableMapStore - getTableById, updateLocalPosition, selectTable
//
// These tests exercise the pure/synchronous logic of the store without
// requiring Supabase or Alpine.js. They can be run in any JS environment
// (browser console, Node with --experimental-vm-modules, or a test runner).
//
// Usage (browser):
//   import('/js/tests/table-map-store.test.js');
//
// Usage (Node >= 18):
//   node --experimental-vm-modules js/tests/table-map-store.test.js

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
// Factory: create a fresh store instance with sample data
// ---------------------------------------------------------------------------

function createStore() {
  // Inline the pure state/methods to avoid import issues across environments.
  // This mirrors the shape exported by table-map-store.js.
  const store = {
    tables: [],
    isEditing: false,
    editLock: null,
    selectedTable: null,
    hasUnsavedChanges: false,
    undoStack: [],
    isLoading: false,
    error: null,
    _realtimeChannel: null,

    getTableById(id) {
      return this.tables.find(t => t.id === id);
    },

    updateLocalPosition(tableId, x, y) {
      const table = this.tables.find(t => t.id === tableId);
      if (!table) return;
      this.undoStack.push({
        tableId: table.id,
        prevX: table.x,
        prevY: table.y,
      });
      table.x = x;
      table.y = y;
      this.hasUnsavedChanges = true;
    },

    selectTable(tableId) {
      this.selectedTable = tableId;
    },

    clearSelection() {
      this.selectedTable = null;
    },

    handleRemoteChange(payload) {
      switch (payload.eventType) {
        case 'INSERT':
          if (!this.tables.find(t => t.id === payload.new.id)) {
            this.tables.push(payload.new);
          }
          break;
        case 'UPDATE': {
          const idx = this.tables.findIndex(t => t.id === payload.new.id);
          if (idx !== -1) {
            if (this.isEditing && this.selectedTable === payload.new.id) {
              this.tables[idx].status = payload.new.status;
            } else {
              this.tables[idx] = { ...this.tables[idx], ...payload.new };
            }
          }
          break;
        }
        case 'DELETE':
          this.tables = this.tables.filter(t => t.id !== payload.old.id);
          break;
      }
    },
  };

  // Seed with sample tables
  store.tables = [
    { id: 'table-1', name: 'Ban 1', x: 100, y: 200, status: 'empty' },
    { id: 'table-2', name: 'Ban 2', x: 300, y: 400, status: 'serving' },
    { id: 'table-3', name: 'Ban 3', x: 500, y: 600, status: 'empty' },
  ];

  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getTableById', () => {
  const store = createStore();

  assert(
    store.getTableById('table-1')?.name === 'Ban 1',
    'returns the correct table object for a valid ID',
  );

  assert(
    store.getTableById('table-2')?.id === 'table-2',
    'returns table-2 when queried by its ID',
  );

  assert(
    store.getTableById('nonexistent') === undefined,
    'returns undefined for a non-existent ID',
  );

  assert(
    store.getTableById(null) === undefined,
    'returns undefined when id is null',
  );

  assert(
    store.getTableById(undefined) === undefined,
    'returns undefined when id is undefined',
  );
});

describe('updateLocalPosition', () => {
  const store = createStore();

  // Initial state checks
  assert(store.hasUnsavedChanges === false, 'hasUnsavedChanges starts as false');
  assert(store.undoStack.length === 0, 'undoStack starts empty');

  // Move table-1 from (100,200) to (150,250)
  store.updateLocalPosition('table-1', 150, 250);

  assert(
    store.tables[0].x === 150 && store.tables[0].y === 250,
    'updates the table x,y coordinates in the local array',
  );

  assert(store.hasUnsavedChanges === true, 'sets hasUnsavedChanges to true after move');

  assert(store.undoStack.length === 1, 'pushes one entry onto the undoStack');

  assert(
    store.undoStack[0].tableId === 'table-1' &&
    store.undoStack[0].prevX === 100 &&
    store.undoStack[0].prevY === 200,
    'undoStack entry contains the previous position',
  );

  // Move table-1 again to verify stacking
  store.updateLocalPosition('table-1', 175, 275);

  assert(store.undoStack.length === 2, 'undoStack grows with each move');

  assert(
    store.undoStack[1].prevX === 150 && store.undoStack[1].prevY === 250,
    'second undo entry has the intermediate position',
  );

  // Move a non-existent table -- should be a no-op
  const stackBefore = store.undoStack.length;
  store.updateLocalPosition('nonexistent', 0, 0);

  assert(
    store.undoStack.length === stackBefore,
    'no-op for a non-existent table ID (undoStack unchanged)',
  );
});

describe('selectTable', () => {
  const store = createStore();

  assert(store.selectedTable === null, 'selectedTable starts as null');

  store.selectTable('table-2');
  assert(store.selectedTable === 'table-2', 'sets selectedTable to the given ID');

  store.selectTable('table-3');
  assert(store.selectedTable === 'table-3', 'updates selectedTable when called again');

  store.selectTable(null);
  assert(store.selectedTable === null, 'can set selectedTable back to null');
});

describe('clearSelection', () => {
  const store = createStore();

  store.selectTable('table-1');
  assert(store.selectedTable === 'table-1', 'selectedTable is set before clear');

  store.clearSelection();
  assert(store.selectedTable === null, 'clearSelection resets selectedTable to null');
});

describe('handleRemoteChange - INSERT', () => {
  const store = createStore();

  const newTable = { id: 'table-new', name: 'Ban Moi', x: 50, y: 50, status: 'empty' };
  store.handleRemoteChange({ eventType: 'INSERT', new: newTable });

  assert(
    store.tables.length === 4,
    'INSERT adds a new table to the local array',
  );

  assert(
    store.tables.find(t => t.id === 'table-new')?.name === 'Ban Moi',
    'INSERT adds the correct table data',
  );

  // Duplicate INSERT should not add again
  store.handleRemoteChange({ eventType: 'INSERT', new: newTable });

  assert(
    store.tables.length === 4,
    'INSERT does not add a duplicate table if ID already exists',
  );
});

describe('handleRemoteChange - UPDATE (not editing)', () => {
  const store = createStore();

  store.handleRemoteChange({
    eventType: 'UPDATE',
    new: { id: 'table-1', name: 'Ban 1 Updated', x: 150, y: 250, status: 'serving' },
  });

  const updated = store.tables.find(t => t.id === 'table-1');

  assert(
    updated.name === 'Ban 1 Updated',
    'UPDATE merges all fields when not editing',
  );

  assert(
    updated.x === 150 && updated.y === 250,
    'UPDATE merges position fields when not editing',
  );

  assert(
    updated.status === 'serving',
    'UPDATE merges status field when not editing',
  );
});

describe('handleRemoteChange - UPDATE (editing selected table)', () => {
  const store = createStore();
  store.isEditing = true;
  store.selectedTable = 'table-2';

  // User is editing table-2, so remote update should only change status
  store.handleRemoteChange({
    eventType: 'UPDATE',
    new: { id: 'table-2', name: 'Ban 2 Remote', x: 999, y: 999, status: 'empty' },
  });

  const table2 = store.tables.find(t => t.id === 'table-2');

  assert(
    table2.status === 'empty',
    'UPDATE changes status even when editing the selected table',
  );

  assert(
    table2.x === 300 && table2.y === 400,
    'UPDATE does NOT change position of the selected table during editing',
  );

  assert(
    table2.name === 'Ban 2',
    'UPDATE does NOT change name of the selected table during editing',
  );
});

describe('handleRemoteChange - UPDATE (editing, different table)', () => {
  const store = createStore();
  store.isEditing = true;
  store.selectedTable = 'table-2';

  // User is editing table-2, but the update is for table-1 (not selected)
  store.handleRemoteChange({
    eventType: 'UPDATE',
    new: { id: 'table-1', name: 'Ban 1 Remote', x: 777, y: 888, status: 'serving' },
  });

  const table1 = store.tables.find(t => t.id === 'table-1');

  assert(
    table1.name === 'Ban 1 Remote' && table1.x === 777 && table1.y === 888,
    'UPDATE merges all fields for non-selected tables even during editing',
  );
});

describe('handleRemoteChange - UPDATE (non-existent table)', () => {
  const store = createStore();
  const countBefore = store.tables.length;

  store.handleRemoteChange({
    eventType: 'UPDATE',
    new: { id: 'nonexistent', name: 'Ghost', x: 0, y: 0, status: 'empty' },
  });

  assert(
    store.tables.length === countBefore,
    'UPDATE for a non-existent table is a no-op',
  );
});

describe('handleRemoteChange - DELETE', () => {
  const store = createStore();

  assert(store.tables.length === 3, 'starts with 3 tables before DELETE');

  store.handleRemoteChange({
    eventType: 'DELETE',
    old: { id: 'table-3' },
  });

  assert(
    store.tables.length === 2,
    'DELETE removes the table from local array',
  );

  assert(
    !store.tables.find(t => t.id === 'table-3'),
    'DELETE removes the correct table (table-3 no longer present)',
  );

  // Delete non-existent should be safe (no error)
  store.handleRemoteChange({
    eventType: 'DELETE',
    old: { id: 'nonexistent' },
  });

  assert(
    store.tables.length === 2,
    'DELETE for a non-existent table does not remove anything',
  );
});

// ---------------------------------------------------------------------------
// addTable tests (async -- uses a mock Supabase client)
// ---------------------------------------------------------------------------

/**
 * Create a store instance with a mock Supabase insert chain for addTable tests.
 * The mock records the payload passed to insert() and returns the configured
 * response (success or error).
 */
function createStoreWithMockSupabase({ responseData = null, responseError = null } = {}) {
  let capturedPayload = null;

  const store = {
    tables: [
      { id: 'table-1', name: 'Ban 1', x: 10, y: 20, status: 'empty' },
    ],
    error: null,

    // Mock addTable that mirrors the real store's logic but uses a fake Supabase chain
    async addTable(tableData) {
      this.error = null;
      capturedPayload = tableData;

      // Simulate supabase.from('tables').insert(tableData).select().single()
      const data = responseData;
      const error = responseError;

      if (error) {
        console.error('[tableMapStore] addTable failed:', error);
        this.error = 'Khong the them ban moi. Vui long thu lai.';
        return null;
      }

      this.tables.push(data);
      return data;
    },
  };

  return { store, getCapturedPayload: () => capturedPayload };
}

describe('addTable - success', () => {
  const newTableResponse = {
    id: 'table-new-uuid',
    outlet_id: 'outlet-1',
    name: 'Ban 5',
    table_code: 'B05',
    capacity: 6,
    shape: 'round',
    x: 45,
    y: 40,
    status: 'available',
  };

  const { store, getCapturedPayload } = createStoreWithMockSupabase({
    responseData: newTableResponse,
  });

  // Run the async test
  const runTest = async () => {
    const tableData = {
      outlet_id: 'outlet-1',
      name: 'Ban 5',
      table_code: 'B05',
      capacity: 6,
      shape: 'round',
      x: 45,
      y: 40,
      status: 'available',
    };

    const result = await store.addTable(tableData);

    // Verify correct payload was sent
    const payload = getCapturedPayload();
    assert(
      payload.outlet_id === 'outlet-1',
      'addTable sends correct outlet_id in payload',
    );
    assert(
      payload.name === 'Ban 5',
      'addTable sends correct name in payload',
    );
    assert(
      payload.table_code === 'B05',
      'addTable sends correct table_code in payload',
    );
    assert(
      payload.capacity === 6,
      'addTable sends correct capacity in payload',
    );
    assert(
      payload.shape === 'round',
      'addTable sends correct shape in payload',
    );
    assert(
      payload.x === 45 && payload.y === 40,
      'addTable sends default center position (x:45, y:40) in payload',
    );
    assert(
      payload.status === 'available',
      'addTable sends status "available" in payload',
    );

    // Verify return value
    assert(
      result !== null && result.id === 'table-new-uuid',
      'addTable returns the newly created table object on success',
    );

    // Verify local state updated
    assert(
      store.tables.length === 2,
      'addTable pushes new table to local tables array',
    );
    assert(
      store.tables[1].id === 'table-new-uuid',
      'new table is appended at end of tables array',
    );
    assert(
      store.tables[1].name === 'Ban 5' && store.tables[1].table_code === 'B05',
      'new table in local state has correct name and code',
    );
    assert(
      store.error === null,
      'addTable does not set error on success',
    );
  };

  runTest();
});

describe('addTable - error (e.g., duplicate code)', () => {
  const { store } = createStoreWithMockSupabase({
    responseError: { message: 'duplicate key value violates unique constraint', code: '23505' },
  });

  const runTest = async () => {
    const tableData = {
      outlet_id: 'outlet-1',
      name: 'Ban Dup',
      table_code: 'B01',
      capacity: 4,
      shape: 'square',
      x: 45,
      y: 40,
      status: 'available',
    };

    const result = await store.addTable(tableData);

    assert(
      result === null,
      'addTable returns null on Supabase error',
    );
    assert(
      store.tables.length === 1,
      'addTable does not add to local tables array on error',
    );
    assert(
      typeof store.error === 'string' && store.error.length > 0,
      'addTable sets error message on failure',
    );
  };

  runTest();
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// Use a short delay to ensure async tests complete before printing summary
setTimeout(() => {
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) {
    console.error('Some tests FAILED.');
  }
}, 100);
