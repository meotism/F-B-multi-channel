// Order Store - Alpine.store('orders'): order state, cart, menu loading
//
// SINGLE SOURCE OF TRUTH for order data, cart staging, and menu browsing state.
// Registered as Alpine.store('orders') in app.js.
//
// Requirements: 5.2 AC-2 (create order with menu items), 5.2 AC-6 (update order total in real-time)
// Design reference: Section 4.3.3, Section 4.3.7 (Realtime Sync)

import { listCategories, listMenuItems } from '../services/menu-service.js';
import {
  createOrder as createOrderService,
  loadOrder as loadOrderService,
  loadOrderByTable as loadOrderByTableService,
  addItem as addItemService,
  updateItemQty as updateItemQtyService,
  updateItemNote as updateItemNoteService,
  removeItem as removeItemService,
  requestPayment as requestPaymentService,
  cancelPaymentRequest as cancelPaymentRequestService,
} from '../services/order-service.js';
import { supabase } from '../services/supabase-client.js';
import {
  subscribeToOrders,
  subscribeToOrderItems,
  onReconnect,
} from '../services/realtime-service.js';
import { withCacheInvalidation } from '../services/cache-invalidation.js';
import { cacheManager } from '../services/cache-manager.js';

export function orderStore() {
  return {
    // --- State ---
    currentOrder: null,        // Current order being viewed/edited
                               // { id, table_id, outlet_id, user_id, status, started_at, ended_at }
    orderItems: [],            // Items in current order
                               // [{ id, order_id, menu_item_id, qty, price, note, menuItemName }]
    menuItems: [],             // All active menu items for outlet
                               // [{ id, name, price, category_id, categoryName, is_active }]
    categories: [],            // All active categories
                               // [{ id, name, sort_order }]
    selectedCategory: null,    // UUID of selected category filter (null = all)
    cart: [],                  // Pre-confirmation staging area
                               // [{ menuItemId, name, price, qty, note }]
    orderNote: '',             // Order-level note text
    guestCount: 0,             // Number of guests at the table
    isLoading: false,
    error: null,

    // --- Computed Properties ---

    /**
     * Filter menu items by selected category. When selectedCategory is null,
     * returns all menu items (the "Tat ca" / "All" tab).
     *
     * @returns {Array} Filtered menu items
     */
    get filteredMenuItems() {
      if (!this.selectedCategory) return this.menuItems;
      return this.menuItems.filter(i => i.category_id === this.selectedCategory);
    },

    /**
     * Total price of the current order's items (sum of qty * price).
     * Used when displaying an existing order that has been persisted.
     *
     * @returns {number} Order total in currency units
     */
    get orderTotal() {
      return this.orderItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
    },

    /**
     * Total price of cart items (sum of qty * price).
     * Used for the pre-confirmation cart display before order is created.
     *
     * @returns {number} Cart total in currency units
     */
    get cartTotal() {
      return this.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    },

    /**
     * Total item count in the current order (sum of quantities).
     * Used for badge display and order summary.
     *
     * @returns {number} Total number of items
     */
    get itemCount() {
      return this.orderItems.reduce((sum, item) => sum + item.qty, 0);
    },

    // --- Actions ---

    /**
     * Fetch active categories and active menu items for the given outlet.
     * Categories are sorted by sort_order (handled by the service).
     * Only active items (is_active = true) are included in the menu display.
     *
     * @param {string} outletId - UUID of the outlet to load menu for
     */
    async loadMenu(outletId) {
      this.isLoading = true;
      this.error = null;

      try {
        const [cats, items] = await Promise.all([
          listCategories(outletId),
          listMenuItems(outletId),
        ]);

        // Filter to active categories only
        this.categories = (cats || []).filter(c => c.is_active !== false);

        // Filter to active menu items and flatten the joined category name
        this.menuItems = (items || [])
          .filter(i => i.is_active !== false)
          .map(i => ({
            ...i,
            categoryName: i.categories?.name || null,
          }));
      } catch (err) {
        console.error('[orderStore] loadMenu failed:', err);
        this.error = 'Khong the tai thuc don. Vui long thu lai.';
        this.categories = [];
        this.menuItems = [];
      } finally {
        this.isLoading = false;
      }
    },

    // --- Cart Methods (pre-confirmation staging) ---

    /**
     * Add a menu item to the cart. If the item already exists in the cart
     * (matched by menuItemId), increment its quantity by 1. Otherwise,
     * add a new entry with qty = 1.
     *
     * @param {object} menuItem - Menu item object with at least { id, name, price }
     */
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

    /**
     * Remove a cart item at the given index.
     *
     * @param {number} index - Zero-based index of the item to remove
     */
    removeFromCart(index) {
      if (index >= 0 && index < this.cart.length) {
        this.cart.splice(index, 1);
      }
    },

    /**
     * Update the quantity of a cart item at the given index.
     * If the new quantity is <= 0, the item is removed from the cart.
     *
     * @param {number} index - Zero-based index of the item to update
     * @param {number} qty - New quantity value
     */
    updateCartQty(index, qty) {
      if (index < 0 || index >= this.cart.length) return;

      if (qty <= 0) {
        this.cart.splice(index, 1);
      } else {
        this.cart[index].qty = qty;
      }
    },

    /**
     * Clear all items from the cart.
     */
    clearCart() {
      this.cart = [];
    },

    // --- Order Persistence Actions ---

    /**
     * Create a new order for the given table using the current cart contents.
     * Calls order-service.createOrder() which inserts the order, order_items
     * (with price snapshots per EC-5), and updates the table status to 'serving'.
     *
     * On success: sets currentOrder and orderItems, clears the cart,
     * and updates the table status in the tableMap store's local state.
     * On error: preserves the cart for retry and re-throws the error.
     *
     * @param {string} tableId - UUID of the table to create the order for
     * @returns {Promise<{order: Object, items: Array}>} The created order and items
     * @throws {Error} With Vietnamese message on failure
     */
    async createOrder(tableId) {
      const auth = Alpine.store('auth');
      const outletId = auth.user?.outlet_id;
      const userId = auth.user?.id;

      if (!outletId || !userId) {
        throw new Error('Thiếu thông tin người dùng. Vui lòng đăng nhập lại.');
      }

      if (this.cart.length === 0) {
        throw new Error('Giỏ hàng trống. Vui lòng thêm món trước khi xác nhận.');
      }

      // S3-26: Pre-check table status to prevent duplicate orders (concurrent access)
      const { data: freshTable } = await supabase
        .from('tables')
        .select('status')
        .eq('id', tableId)
        .single();

      if (freshTable && freshTable.status !== 'empty') {
        throw new Error('Bàn này đã có đơn hàng. Vui lòng làm mới trang.');
      }

      const options = {};
      if (this.guestCount > 0) {
        options.guestCount = this.guestCount;
      }
      const result = await createOrderService(tableId, outletId, userId, this.cart, options);

      // Update store state with the created order
      this.currentOrder = result.order;

      // Flatten order_items: attach the menu item name for display
      this.orderItems = (result.items || []).map(item => ({
        ...item,
        menuItemName: item.menu_items?.name || '',
      }));

      // Clear the cart after successful order creation
      this.cart = [];

      // Update the table status in the local tableMap store so the map
      // reflects 'serving' immediately without waiting for Realtime
      const tableMap = Alpine.store('tableMap');
      const table = tableMap.getTableById(tableId);
      if (table) {
        table.status = 'serving';
        table.activeOrderStartedAt = result.order.started_at;
      }

      // S3-08: Fire-and-forget inventory deduction (non-blocking)
      // The order is already created — inventory issues are warnings, not blockers
      supabase.functions.invoke('deduct-inventory', {
        body: { order_id: result.order.id, action: 'deduct' },
      }).then(({ data, error }) => {
        if (error) {
          // Parse edge function error response
          const errBody = typeof error === 'object' ? error : {};
          const code = errBody?.context?.status || errBody?.status;
          if (code === 409) {
            Alpine.store('ui').showToast(
              'Cảnh báo: Một số nguyên liệu không đủ tồn kho',
              'warning',
            );
          } else {
            console.error('[orderStore] Inventory deduction failed:', error);
          }
          return;
        }
        // Show low-stock alerts if any
        if (data?.low_stock_alerts?.length > 0) {
          const names = data.low_stock_alerts
            .map(a => a.ingredient_name || a.name)
            .join(', ');
          Alpine.store('ui').showToast(
            `Cảnh báo tồn kho thấp: ${names}`,
            'warning',
          );
        }
      }).catch(err => {
        console.error('[orderStore] Inventory deduction error:', err);
      });

      return result;
    },

    /**
     * Load an existing order by its ID and populate currentOrder + orderItems.
     * Used when navigating directly to an order by ID.
     *
     * @param {string} orderId - UUID of the order to load
     * @returns {Promise<Object>} The loaded order with items
     * @throws {Error} With Vietnamese message on failure
     */
    async loadOrder(orderId) {
      this.isLoading = true;
      this.error = null;

      try {
        const data = await loadOrderService(orderId);
        this.currentOrder = data;
        this.orderNote = data.note || '';
        this.guestCount = data.guest_count || 0;

        // Flatten order_items: attach the menu item name for display
        this.orderItems = (data.order_items || []).map(item => ({
          ...item,
          menuItemName: item.menu_items?.name || '',
        }));

        return data;
      } catch (err) {
        console.error('[orderStore] loadOrder failed:', err);
        this.error = err.message || 'Không thể tải đơn hàng.';
        throw err;
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Load the active order for a specific table by table ID.
     * Returns null if no active order exists (table is empty).
     * Used when navigating to a table with status 'serving' to display
     * the existing order in detail mode.
     *
     * @param {string} tableId - UUID of the table to find the order for
     * @returns {Promise<Object|null>} The order with items, or null if none found
     * @throws {Error} With Vietnamese message on failure
     */
    async loadOrderByTable(tableId) {
      this.isLoading = true;
      this.error = null;

      try {
        const data = await loadOrderByTableService(tableId);

        if (!data) {
          this.currentOrder = null;
          this.orderItems = [];
          this.orderNote = '';
          this.guestCount = 0;
          return null;
        }

        this.currentOrder = data;
        this.orderNote = data.note || '';
        this.guestCount = data.guest_count || 0;

        // Flatten order_items: attach the menu item name for display
        this.orderItems = (data.order_items || []).map(item => ({
          ...item,
          menuItemName: item.menu_items?.name || '',
        }));

        return data;
      } catch (err) {
        console.error('[orderStore] loadOrderByTable failed:', err);
        this.error = err.message || 'Không thể tải đơn hàng cho bàn.';
        throw err;
      } finally {
        this.isLoading = false;
      }
    },

    // --- Active Order Modification Actions ---
    // These methods modify an existing active order by calling order-service
    // functions and updating local state. Each call saves immediately to the
    // database (no batching, no "save" button).
    // Requirements: 5.2 AC-4, 5.2 AC-6

    /**
     * Add a menu item to the current active order.
     * Inserts a new order_items row via the service and appends it to
     * the local orderItems array so the UI updates immediately.
     *
     * If the same menu item already exists in the order, a new row is added
     * (items are not merged). The user can adjust qty via the qty controls.
     *
     * @param {Object} menuItem - Menu item with { id, name, price }
     * @param {number} [qty=1] - Quantity to add
     * @param {string} [note=''] - Optional note for the item
     * @returns {Promise<Object>} The created order_item row
     * @throws {Error} If no active order is loaded
     */
    async addItemToOrder(menuItem, qty = 1, note = '') {
      if (!this.currentOrder) {
        throw new Error('Không có đơn hàng hiện tại để thêm món.');
      }

      const newItem = await addItemService(this.currentOrder.id, menuItem, qty, note);

      // Append to local state with flattened menu item name
      this.orderItems.push({
        ...newItem,
        menuItemName: newItem.menu_items?.name || menuItem.name,
      });

      return newItem;
    },

    /**
     * Update the quantity of an existing order item.
     * If newQty is <= 0, the item is removed instead.
     * Updates the local orderItems array to reflect the change immediately.
     *
     * @param {string} orderItemId - UUID of the order_item to update
     * @param {number} newQty - New quantity value
     */
    async updateOrderItemQty(orderItemId, newQty) {
      if (newQty <= 0) {
        await this.removeOrderItem(orderItemId);
        return;
      }

      const updated = await updateItemQtyService(orderItemId, newQty);

      // Update local state, preserving the flattened menuItemName
      const idx = this.orderItems.findIndex(i => i.id === orderItemId);
      if (idx >= 0 && updated) {
        this.orderItems[idx] = {
          ...this.orderItems[idx],
          ...updated,
          menuItemName: this.orderItems[idx].menuItemName,
        };
      }
    },

    /**
     * Update the note of an existing order item.
     * Saves immediately to the database.
     *
     * @param {string} orderItemId - UUID of the order_item to update
     * @param {string} note - New note text
     */
    async updateOrderItemNote(orderItemId, note) {
      const updated = await updateItemNoteService(orderItemId, note);

      // Update local state, preserving the flattened menuItemName
      const idx = this.orderItems.findIndex(i => i.id === orderItemId);
      if (idx >= 0 && updated) {
        this.orderItems[idx] = {
          ...this.orderItems[idx],
          ...updated,
          menuItemName: this.orderItems[idx].menuItemName,
        };
      }
    },

    /**
     * Remove an order item from the current order.
     * Deletes the order_items row and removes it from the local array.
     *
     * @param {string} orderItemId - UUID of the order_item to remove
     */
    async removeOrderItem(orderItemId) {
      await removeItemService(orderItemId);
      this.orderItems = this.orderItems.filter(i => i.id !== orderItemId);
    },

    // --- Payment Status Transition Actions ---
    // Transitions: active <-> completed (order), serving <-> awaiting_payment (table)
    // Design reference: Section 4.3.6
    // Requirements: 5.2 AC-5

    /**
     * Request payment for the current order.
     * Sets order status to 'completed' and table status to 'awaiting_payment'.
     * After this, modification controls are locked (canModify returns false).
     *
     * @returns {Promise<Object>} The updated order object
     * @throws {Error} If no current order is loaded
     */
    async requestPayment() {
      if (!this.currentOrder) {
        throw new Error('Không có đơn hàng hiện tại.');
      }

      const updatedOrder = await requestPaymentService(this.currentOrder.id);

      // Merge the updated order data and ensure status is 'completed'
      this.currentOrder = { ...this.currentOrder, ...updatedOrder, status: 'completed' };

      // Update table status in the local tableMap store so the map
      // reflects 'awaiting_payment' immediately without waiting for Realtime
      const tableMap = Alpine.store('tableMap');
      const table = tableMap.getTableById(this.currentOrder.table_id);
      if (table) {
        table.status = 'awaiting_payment';
      }
    },

    /**
     * Cancel the payment request, reverting the order to active.
     * Sets order status back to 'active' and table status back to 'serving'.
     * Re-enables modification controls (canModify returns true again).
     *
     * @returns {Promise<Object>} The updated order object
     * @throws {Error} If no current order is loaded
     */
    async cancelPaymentRequest() {
      if (!this.currentOrder) {
        throw new Error('Không có đơn hàng hiện tại.');
      }

      const updatedOrder = await cancelPaymentRequestService(this.currentOrder.id);

      // Merge the updated order data and ensure status is 'active'
      this.currentOrder = { ...this.currentOrder, ...updatedOrder, status: 'active' };

      // Revert table status in the local tableMap store so the map
      // reflects 'serving' immediately without waiting for Realtime
      const tableMap = Alpine.store('tableMap');
      const table = tableMap.getTableById(this.currentOrder.table_id);
      if (table) {
        table.status = 'serving';
      }
    },

    // --- Realtime Subscription ---
    // Design reference: Section 4.3.7
    // Requirements: 5.2 AC-6 (update order total in real-time), 5.2 EC-1

    /**
     * Subscribe to realtime changes for orders and order_items.
     * Re-subscribes the existing realtime-service channels with order-store
     * aware callbacks so that changes from other devices are reflected
     * in the currently viewed order and on the table map.
     *
     * The realtime-service handles channel deduplication internally
     * (replaces existing channels with the same name), so calling this
     * multiple times is safe.
     *
     * @param {string} outletId - UUID of the outlet to subscribe to
     */
    subscribeToChanges(outletId) {
      if (!outletId) {
        console.warn('[orderStore] subscribeToChanges: no outletId provided');
        return;
      }

      subscribeToOrders(outletId, withCacheInvalidation('orders', (payload) => this.handleOrderChange(payload), cacheManager));
      subscribeToOrderItems(outletId, withCacheInvalidation('order_items', (payload) => this.handleOrderItemChange(payload), cacheManager));

      // On reconnect after a disconnection, reload the current order
      // to reconcile any events that were missed while offline
      onReconnect(() => {
        if (this.currentOrder) {
          this.loadOrder(this.currentOrder.id);
        }
      });

      console.info('[orderStore] Realtime subscriptions active for outlet:', outletId);
    },

    /**
     * Handle a realtime change event on the orders table.
     * If the changed order is the one currently being viewed, merge the
     * updated fields into currentOrder so the UI reflects the latest state.
     *
     * Also provides optimistic table status updates to the tableMap store
     * for faster UI feedback (the tables Realtime channel will deliver the
     * authoritative update shortly after).
     *
     * @param {object} payload - Supabase realtime payload with eventType, new, old
     */
    handleOrderChange(payload) {
      const changedOrder = payload.new;
      if (!changedOrder) return;

      // If the changed order is currently being viewed, update it
      if (this.currentOrder && changedOrder.id === this.currentOrder.id) {
        this.currentOrder = { ...this.currentOrder, ...changedOrder };
      }

      // Optimistic table status update for faster UI feedback.
      // The server-side trigger also updates the table, and the tables
      // Realtime channel will deliver the authoritative change, but this
      // provides a snappier experience on other devices.
      if (changedOrder.table_id) {
        const tableMap = Alpine.store('tableMap');
        const table = tableMap.getTableById(changedOrder.table_id);
        if (table) {
          if (changedOrder.status === 'active') {
            table.status = 'serving';
            if (changedOrder.started_at) {
              table.activeOrderStartedAt = changedOrder.started_at;
            }
          } else if (changedOrder.status === 'completed') {
            table.status = 'awaiting_payment';
          } else if (changedOrder.status === 'cancelled') {
            // Optimistic reset -- the server handles the actual table
            // reset and verifies no other active orders exist on the table
            table.status = 'empty';
            table.activeOrderStartedAt = null;
          }
        }
      }
    },

    /**
     * Handle a realtime change event on the order_items table.
     * If the changed item belongs to the currently viewed order, reload
     * the full order to get fresh items with joined menu_item names.
     *
     * For DELETE events, payload.new is null so we fall back to payload.old
     * to determine the order_id.
     *
     * @param {object} payload - Supabase realtime payload with eventType, new, old
     */
    handleOrderItemChange(payload) {
      // Only process if we have an active order being viewed
      if (!this.currentOrder) return;

      // For DELETE events payload.new is null; use payload.old to get order_id
      const changedItem = payload.new || payload.old;
      if (!changedItem) return;

      // Only reload if the changed item belongs to our currently viewed order
      if (changedItem.order_id === this.currentOrder.id) {
        this.loadOrder(this.currentOrder.id);
      }
    },
  };
}
