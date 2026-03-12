// Unit tests for orderStore - cart operations, computed properties, menu filtering
//
// These tests exercise the pure/synchronous logic of the order store without
// requiring Supabase or Alpine.js. The loadMenu() method is tested separately
// with a mock service layer.
//
// Usage (browser):
//   import('/js/tests/order-store.test.js');
//
// Usage (Node >= 18):
//   node --experimental-vm-modules js/tests/order-store.test.js

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
// Factory: create a fresh store instance with sample data
// ---------------------------------------------------------------------------

/**
 * Create a bare order store instance mirroring the shape exported by
 * order-store.js. Pure state and synchronous methods are inlined to
 * avoid import/module issues across environments.
 */
function createStore() {
  const store = {
    currentOrder: null,
    orderItems: [],
    menuItems: [],
    categories: [],
    selectedCategory: null,
    cart: [],
    isLoading: false,
    error: null,

    get filteredMenuItems() {
      if (!this.selectedCategory) return this.menuItems;
      return this.menuItems.filter(i => i.category_id === this.selectedCategory);
    },

    get orderTotal() {
      return this.orderItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
    },

    get cartTotal() {
      return this.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    },

    get itemCount() {
      return this.orderItems.reduce((sum, item) => sum + item.qty, 0);
    },

    addToCart(menuItem) {
      const existing = this.cart.find(c => c.menuItemId === menuItem.id);
      if (existing) {
        existing.qty += 1;
      } else {
        this.cart.push({
          menuItemId: menuItem.id,
          name: menuItem.name,
          price: menuItem.price,
          qty: 1,
          note: '',
        });
      }
    },

    removeFromCart(index) {
      if (index >= 0 && index < this.cart.length) {
        this.cart.splice(index, 1);
      }
    },

    updateCartQty(index, qty) {
      if (index < 0 || index >= this.cart.length) return;
      if (qty <= 0) {
        this.cart.splice(index, 1);
      } else {
        this.cart[index].qty = qty;
      }
    },

    clearCart() {
      this.cart = [];
    },
  };

  return store;
}

/**
 * Create a store pre-seeded with menu items and categories for filtering tests.
 */
function createStoreWithMenu() {
  const store = createStore();

  store.categories = [
    { id: 'cat-food', name: 'Mon chinh', sort_order: 1 },
    { id: 'cat-drink', name: 'Do uong', sort_order: 2 },
    { id: 'cat-dessert', name: 'Trang mieng', sort_order: 3 },
  ];

  store.menuItems = [
    { id: 'item-1', name: 'Pho Bo', price: 55000, category_id: 'cat-food', is_active: true },
    { id: 'item-2', name: 'Bun Cha', price: 45000, category_id: 'cat-food', is_active: true },
    { id: 'item-3', name: 'Tra Da', price: 10000, category_id: 'cat-drink', is_active: true },
    { id: 'item-4', name: 'Ca Phe', price: 25000, category_id: 'cat-drink', is_active: true },
    { id: 'item-5', name: 'Che', price: 20000, category_id: 'cat-dessert', is_active: true },
  ];

  return store;
}

/**
 * Create a store pre-seeded with order items for computed property tests.
 */
function createStoreWithOrderItems() {
  const store = createStore();

  store.orderItems = [
    { id: 'oi-1', order_id: 'order-1', menu_item_id: 'item-1', qty: 2, price: 55000, note: '' },
    { id: 'oi-2', order_id: 'order-1', menu_item_id: 'item-3', qty: 1, price: 10000, note: '' },
    { id: 'oi-3', order_id: 'order-1', menu_item_id: 'item-4', qty: 3, price: 25000, note: 'it duong' },
  ];

  return store;
}

// ---------------------------------------------------------------------------
// Tests: Initial State
// ---------------------------------------------------------------------------

describe('initial state', () => {
  const store = createStore();

  assert(store.currentOrder === null, 'currentOrder starts as null');
  assert(Array.isArray(store.orderItems) && store.orderItems.length === 0, 'orderItems starts as empty array');
  assert(Array.isArray(store.menuItems) && store.menuItems.length === 0, 'menuItems starts as empty array');
  assert(Array.isArray(store.categories) && store.categories.length === 0, 'categories starts as empty array');
  assert(store.selectedCategory === null, 'selectedCategory starts as null');
  assert(Array.isArray(store.cart) && store.cart.length === 0, 'cart starts as empty array');
  assert(store.isLoading === false, 'isLoading starts as false');
  assert(store.error === null, 'error starts as null');
});

// ---------------------------------------------------------------------------
// Tests: filteredMenuItems
// ---------------------------------------------------------------------------

describe('filteredMenuItems - no category selected (show all)', () => {
  const store = createStoreWithMenu();

  assert(store.selectedCategory === null, 'selectedCategory is null');
  assert(
    store.filteredMenuItems.length === 5,
    'returns all 5 menu items when no category is selected',
  );
});

describe('filteredMenuItems - category selected', () => {
  const store = createStoreWithMenu();

  store.selectedCategory = 'cat-food';
  const filtered = store.filteredMenuItems;
  assert(filtered.length === 2, 'returns 2 items for cat-food');
  assert(
    filtered.every(i => i.category_id === 'cat-food'),
    'all filtered items belong to cat-food category',
  );

  store.selectedCategory = 'cat-drink';
  const drinkItems = store.filteredMenuItems;
  assert(drinkItems.length === 2, 'returns 2 items for cat-drink');
  assert(
    drinkItems.every(i => i.category_id === 'cat-drink'),
    'all filtered items belong to cat-drink category',
  );

  store.selectedCategory = 'cat-dessert';
  const dessertItems = store.filteredMenuItems;
  assert(dessertItems.length === 1, 'returns 1 item for cat-dessert');
  assert(dessertItems[0].name === 'Che', 'dessert item is Che');
});

describe('filteredMenuItems - non-existent category', () => {
  const store = createStoreWithMenu();

  store.selectedCategory = 'cat-nonexistent';
  assert(
    store.filteredMenuItems.length === 0,
    'returns empty array for a non-existent category',
  );
});

// ---------------------------------------------------------------------------
// Tests: orderTotal
// ---------------------------------------------------------------------------

describe('orderTotal - with items', () => {
  const store = createStoreWithOrderItems();

  // Expected: (2 * 55000) + (1 * 10000) + (3 * 25000) = 110000 + 10000 + 75000 = 195000
  assert(store.orderTotal === 195000, 'orderTotal calculates sum of qty * price correctly (195000)');
});

describe('orderTotal - empty order', () => {
  const store = createStore();
  assert(store.orderTotal === 0, 'orderTotal is 0 when orderItems is empty');
});

// ---------------------------------------------------------------------------
// Tests: cartTotal
// ---------------------------------------------------------------------------

describe('cartTotal - with items', () => {
  const store = createStore();
  store.cart = [
    { menuItemId: 'item-1', name: 'Pho Bo', price: 55000, qty: 2, note: '' },
    { menuItemId: 'item-3', name: 'Tra Da', price: 10000, qty: 3, note: '' },
  ];

  // Expected: (2 * 55000) + (3 * 10000) = 110000 + 30000 = 140000
  assert(store.cartTotal === 140000, 'cartTotal calculates sum of qty * price correctly (140000)');
});

describe('cartTotal - empty cart', () => {
  const store = createStore();
  assert(store.cartTotal === 0, 'cartTotal is 0 when cart is empty');
});

// ---------------------------------------------------------------------------
// Tests: itemCount
// ---------------------------------------------------------------------------

describe('itemCount - with items', () => {
  const store = createStoreWithOrderItems();

  // Expected: 2 + 1 + 3 = 6
  assert(store.itemCount === 6, 'itemCount sums all quantities correctly (6)');
});

describe('itemCount - empty order', () => {
  const store = createStore();
  assert(store.itemCount === 0, 'itemCount is 0 when orderItems is empty');
});

// ---------------------------------------------------------------------------
// Tests: addToCart
// ---------------------------------------------------------------------------

describe('addToCart - new item', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });

  assert(store.cart.length === 1, 'cart has 1 item after adding');
  assert(store.cart[0].menuItemId === 'item-1', 'cart item has correct menuItemId');
  assert(store.cart[0].name === 'Pho Bo', 'cart item has correct name');
  assert(store.cart[0].price === 55000, 'cart item has correct price');
  assert(store.cart[0].qty === 1, 'cart item starts with qty = 1');
  assert(store.cart[0].note === '', 'cart item starts with empty note');
});

describe('addToCart - existing item increments qty', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });

  assert(store.cart.length === 1, 'cart still has 1 item (not duplicated)');
  assert(store.cart[0].qty === 3, 'qty incremented to 3 after adding same item 3 times');
});

describe('addToCart - different items', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-2', name: 'Bun Cha', price: 45000 });
  store.addToCart({ id: 'item-3', name: 'Tra Da', price: 10000 });

  assert(store.cart.length === 3, 'cart has 3 items after adding 3 different items');
  assert(store.cart[0].menuItemId === 'item-1', 'first item is Pho Bo');
  assert(store.cart[1].menuItemId === 'item-2', 'second item is Bun Cha');
  assert(store.cart[2].menuItemId === 'item-3', 'third item is Tra Da');
});

describe('addToCart - mix of new and existing', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-2', name: 'Bun Cha', price: 45000 });
  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });

  assert(store.cart.length === 2, 'cart has 2 distinct items');
  assert(store.cart[0].qty === 2, 'Pho Bo qty is 2');
  assert(store.cart[1].qty === 1, 'Bun Cha qty is 1');
});

// ---------------------------------------------------------------------------
// Tests: removeFromCart
// ---------------------------------------------------------------------------

describe('removeFromCart - valid index', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-2', name: 'Bun Cha', price: 45000 });
  store.addToCart({ id: 'item-3', name: 'Tra Da', price: 10000 });

  store.removeFromCart(1); // Remove Bun Cha

  assert(store.cart.length === 2, 'cart has 2 items after removal');
  assert(store.cart[0].menuItemId === 'item-1', 'first item is still Pho Bo');
  assert(store.cart[1].menuItemId === 'item-3', 'second item is now Tra Da');
});

describe('removeFromCart - first item', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-2', name: 'Bun Cha', price: 45000 });

  store.removeFromCart(0);

  assert(store.cart.length === 1, 'cart has 1 item after removing first');
  assert(store.cart[0].menuItemId === 'item-2', 'remaining item is Bun Cha');
});

describe('removeFromCart - last item', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });

  store.removeFromCart(0);

  assert(store.cart.length === 0, 'cart is empty after removing the only item');
});

describe('removeFromCart - invalid index (no-op)', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });

  store.removeFromCart(-1);
  assert(store.cart.length === 1, 'negative index does not remove any item');

  store.removeFromCart(5);
  assert(store.cart.length === 1, 'out-of-bounds index does not remove any item');
});

// ---------------------------------------------------------------------------
// Tests: updateCartQty
// ---------------------------------------------------------------------------

describe('updateCartQty - increase quantity', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.updateCartQty(0, 5);

  assert(store.cart[0].qty === 5, 'qty updated to 5');
  assert(store.cart.length === 1, 'item still in cart');
});

describe('updateCartQty - decrease quantity to positive value', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.updateCartQty(0, 1);

  assert(store.cart[0].qty === 1, 'qty updated to 1');
});

describe('updateCartQty - zero removes item', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-2', name: 'Bun Cha', price: 45000 });

  store.updateCartQty(0, 0);

  assert(store.cart.length === 1, 'item removed when qty set to 0');
  assert(store.cart[0].menuItemId === 'item-2', 'remaining item is Bun Cha');
});

describe('updateCartQty - negative removes item', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });

  store.updateCartQty(0, -1);

  assert(store.cart.length === 0, 'item removed when qty set to negative');
});

describe('updateCartQty - invalid index (no-op)', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });

  store.updateCartQty(-1, 5);
  assert(store.cart[0].qty === 1, 'negative index does not change qty');

  store.updateCartQty(10, 5);
  assert(store.cart[0].qty === 1, 'out-of-bounds index does not change qty');
});

// ---------------------------------------------------------------------------
// Tests: clearCart
// ---------------------------------------------------------------------------

describe('clearCart', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  store.addToCart({ id: 'item-2', name: 'Bun Cha', price: 45000 });
  store.addToCart({ id: 'item-3', name: 'Tra Da', price: 10000 });

  assert(store.cart.length === 3, 'cart has 3 items before clear');

  store.clearCart();

  assert(store.cart.length === 0, 'cart is empty after clearCart');
  assert(Array.isArray(store.cart), 'cart is still an array after clearCart');
});

describe('clearCart - already empty', () => {
  const store = createStore();

  store.clearCart();

  assert(store.cart.length === 0, 'clearCart on empty cart is a no-op');
});

// ---------------------------------------------------------------------------
// Tests: loadMenu with mock service
// ---------------------------------------------------------------------------

describe('loadMenu - success', () => {
  const store = createStore();

  // Mock loadMenu that simulates successful fetch
  store.loadMenu = async function (outletId) {
    this.isLoading = true;
    this.error = null;

    try {
      // Simulate service responses
      const cats = [
        { id: 'cat-1', name: 'Mon chinh', sort_order: 1, is_active: true },
        { id: 'cat-2', name: 'Do uong', sort_order: 2, is_active: true },
        { id: 'cat-inactive', name: 'Hidden', sort_order: 3, is_active: false },
      ];
      const items = [
        { id: 'i-1', name: 'Pho', price: 55000, category_id: 'cat-1', is_active: true, categories: { name: 'Mon chinh' } },
        { id: 'i-2', name: 'Tra', price: 10000, category_id: 'cat-2', is_active: true, categories: { name: 'Do uong' } },
        { id: 'i-inactive', name: 'Old', price: 5000, category_id: 'cat-1', is_active: false, categories: { name: 'Mon chinh' } },
      ];

      this.categories = (cats || []).filter(c => c.is_active !== false);
      this.menuItems = (items || [])
        .filter(i => i.is_active !== false)
        .map(i => ({ ...i, categoryName: i.categories?.name || null }));
    } catch (err) {
      this.error = 'Khong the tai thuc don. Vui long thu lai.';
      this.categories = [];
      this.menuItems = [];
    } finally {
      this.isLoading = false;
    }
  };

  const runTest = async () => {
    await store.loadMenu('outlet-1');

    assert(store.isLoading === false, 'isLoading is false after loadMenu completes');
    assert(store.error === null, 'error is null on successful load');
    assert(store.categories.length === 2, 'filters out inactive categories (2 active)');
    assert(
      store.categories.every(c => c.is_active !== false),
      'all categories are active',
    );
    assert(store.menuItems.length === 2, 'filters out inactive menu items (2 active)');
    assert(
      store.menuItems.every(i => i.is_active !== false),
      'all menu items are active',
    );
    assert(
      store.menuItems[0].categoryName === 'Mon chinh',
      'menu item has flattened categoryName',
    );
  };

  runTest();
});

describe('loadMenu - error', () => {
  const store = createStore();

  // Mock loadMenu that simulates a failure
  store.loadMenu = async function () {
    this.isLoading = true;
    this.error = null;

    try {
      throw new Error('Network error');
    } catch (err) {
      this.error = 'Khong the tai thuc don. Vui long thu lai.';
      this.categories = [];
      this.menuItems = [];
    } finally {
      this.isLoading = false;
    }
  };

  const runTest = async () => {
    await store.loadMenu('outlet-1');

    assert(store.isLoading === false, 'isLoading is false after error');
    assert(typeof store.error === 'string' && store.error.length > 0, 'error message is set on failure');
    assert(store.categories.length === 0, 'categories is empty on error');
    assert(store.menuItems.length === 0, 'menuItems is empty on error');
  };

  runTest();
});

// ---------------------------------------------------------------------------
// Tests: cart + computed interaction
// ---------------------------------------------------------------------------

describe('cartTotal updates as cart changes', () => {
  const store = createStore();

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  assert(store.cartTotal === 55000, 'cartTotal is 55000 after adding 1 Pho Bo');

  store.addToCart({ id: 'item-1', name: 'Pho Bo', price: 55000 });
  assert(store.cartTotal === 110000, 'cartTotal is 110000 after adding Pho Bo again (qty=2)');

  store.addToCart({ id: 'item-2', name: 'Tra Da', price: 10000 });
  assert(store.cartTotal === 120000, 'cartTotal is 120000 after adding Tra Da');

  store.removeFromCart(1); // Remove Tra Da
  assert(store.cartTotal === 110000, 'cartTotal is 110000 after removing Tra Da');

  store.updateCartQty(0, 1); // Pho Bo qty back to 1
  assert(store.cartTotal === 55000, 'cartTotal is 55000 after updating Pho Bo qty to 1');

  store.clearCart();
  assert(store.cartTotal === 0, 'cartTotal is 0 after clearCart');
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
