// Order Page - Order creation/editing/detail x-data component
//
// Alpine.js component for the order page. Supports two modes:
//   - 'create': Menu browsing UI with cart for new order creation
//   - 'detail': Existing order view with inline modification controls
//
// In detail mode, each item shows qty [-]/[+] controls, note editing, and
// a remove button. Modifications save immediately to the database (no "save"
// button). An "Add items" toggle opens the menu browser to append new items
// directly to the active order.
//
// The component reads the `tableId` from route params, loads the table info
// from $store.tableMap.tables, and loads the menu via $store.orders.loadMenu().
//
// Design reference: design.md Sections 4.3.4, 4.3.5
// Requirements: 5.2 AC-2, 5.2 AC-4, 5.2 AC-6

import { formatVND } from '../../utils/formatters.js';
import { navigate } from '../../utils/navigate.js';
import { supabase } from '../../services/supabase-client.js';

/**
 * Alpine component factory for the order page.
 * Used as x-data="orderPage()" in pages/order.html.
 *
 * @returns {Object} Alpine component data object
 */
export function orderPage() {
  return {
    // --- Route / page state ---
    tableId: null,       // UUID from route params
    tableName: '',       // Display name (e.g., "Ban 5")
    tableLabel: '',      // Table code / label (e.g., "A5")

    // --- UI state ---
    showCart: false,      // Whether the cart bottom sheet is visible (mobile/tablet)
    isSubmitting: false,  // Whether the confirm button is in loading state
    mode: 'create',      // 'create' = new order (menu + cart), 'detail' = existing order view
    isAddingItems: false, // Whether the "add more items" menu browser is shown in detail mode
    isSavingItem: null,   // orderItemId currently being modified (for per-item loading state)
    savingNote: null,     // orderItemId whose note is currently being saved
    isRequestingPayment: false, // loading state for request/cancel payment buttons

    // --- Cancel order state (S3-11) ---
    showCancelConfirm: false,
    isCancelling: false,

    // --- Transfer order state (S3-13) ---
    showTransferModal: false,
    isTransferring: false,
    emptyTables: [],
    selectedTransferTarget: null,

    // --- Merge orders state (S3-15) ---
    showMergeModal: false,
    isMerging: false,
    mergeCandidates: [],    // [{ orderId, tableId, tableName, tableLabel }]
    selectedMergeSources: [],

    /**
     * Initialize the component: read route params, load table info, load menu.
     * If the table already has an active order (status 'serving'), load it
     * and switch to detail mode instead of showing the create flow.
     * Called automatically by Alpine when the component mounts.
     */
    async init() {
      // Extract tableId from route params stored by the router
      const params = JSON.parse(
        document.getElementById('page-container').dataset.routeParams || '{}',
      );
      this.tableId = params.tableId;

      if (!this.tableId) {
        Alpine.store('ui').showToast('Thiếu thông tin bàn', 'error');
        navigate('/tables');
        return;
      }

      // Look up table info from the tableMap store
      const table = Alpine.store('tableMap').getTableById(this.tableId);
      if (table) {
        this.tableName = table.name || '';
        this.tableLabel = table.table_code || '';
      }

      // Load the menu for the current outlet
      const outletId = Alpine.store('auth').user?.outlet_id;
      if (outletId) {
        await Alpine.store('orders').loadMenu(outletId);
      }

      // Reset category selection to "All" on page entry
      Alpine.store('orders').selectedCategory = null;

      // Subscribe to realtime order/order_items changes so that updates
      // from other devices are reflected on this page (design 4.3.7).
      // The realtime-service handles channel deduplication so this is
      // safe to call even if subscriptions were already initialized.
      if (outletId) {
        Alpine.store('orders').subscribeToChanges(outletId);
      }

      // If the table is currently serving or awaiting_payment, load the
      // existing order and switch to detail mode (design 4.3.5).
      // When awaiting_payment, the order status is 'completed' so canModify
      // will return false, disabling all modification controls.
      if (table && (table.status === 'serving' || table.status === 'awaiting_payment')) {
        try {
          const order = await Alpine.store('orders').loadOrderByTable(this.tableId);
          if (order) {
            this.mode = 'detail';
          }
        } catch (err) {
          console.error('[orderPage] Failed to load existing order:', err);
          Alpine.store('ui').showToast('Không thể tải đơn hàng hiện tại.', 'error');
        }
      }
    },

    /**
     * Navigate back to the table map.
     */
    goBack() {
      navigate('/tables');
    },

    /**
     * Select a category filter tab. Pass null for "All" (Tat ca).
     * Delegates to the orders store.
     *
     * @param {string|null} categoryId - Category UUID or null for all
     */
    selectCategory(categoryId) {
      Alpine.store('orders').selectedCategory = categoryId;
    },

    /**
     * Add a menu item to the cart. Delegates to the orders store.
     * Repeated calls for the same item increment its quantity.
     *
     * @param {Object} menuItem - Menu item with { id, name, price }
     */
    addToCart(menuItem) {
      Alpine.store('orders').addToCart(menuItem);
    },

    /**
     * Format a price value as VND string (e.g., "55.000").
     * Exposed so the HTML template can call it via x-text.
     *
     * @param {number} amount - The price amount
     * @returns {string} Formatted VND string
     */
    formatVND(amount) {
      return formatVND(amount);
    },

    /**
     * Toggle the cart bottom sheet visibility (for mobile/tablet).
     */
    toggleCart() {
      this.showCart = !this.showCart;
    },

    /**
     * Close the cart bottom sheet (for mobile/tablet).
     */
    closeCart() {
      this.showCart = false;
    },

    /**
     * Confirm the order: create the order in Supabase with the current cart contents.
     * On success: clears cart, transitions to detail mode, shows success toast.
     * On error: preserves cart for retry, shows error toast.
     * Loading state disables the button and shows a spinner during the API call.
     *
     * Design reference: Section 4.3.10 (sequence diagram)
     * Requirements: 5.2 AC-2, 5.2 AC-3, 5.3 AC-1
     */
    async confirmOrder() {
      if (this.isSubmitting) return;

      const ordersStore = Alpine.store('orders');
      if (ordersStore.cart.length === 0) return;

      this.isSubmitting = true;

      try {
        await ordersStore.createOrder(this.tableId);

        // Show success toast with Vietnamese text
        Alpine.store('ui').showToast('Đơn hàng đã tạo thành công', 'success');

        // Transition to order detail mode (don't navigate away)
        this.mode = 'detail';

        // Close the cart bottom sheet if open (mobile/tablet)
        this.showCart = false;
      } catch (err) {
        console.error('[orderPage] confirmOrder failed:', err);

        // Show Vietnamese error message; cart is preserved for retry
        const message = err.message || 'Không thể tạo đơn hàng. Vui lòng thử lại.';
        Alpine.store('ui').showToast(message, 'error');
      } finally {
        this.isSubmitting = false;
      }
    },

    // --- Detail Mode: Inline Modification Methods ---
    // These methods are used in detail mode to modify an existing active order.
    // Each modification saves immediately to the database via the orders store.
    // Design reference: Section 4.3.5
    // Requirements: 5.2 AC-4, 5.2 AC-6

    /**
     * Whether modifications are allowed on the current order.
     * Only active orders can be modified. Completed (awaiting payment)
     * and finalized orders are locked.
     *
     * @returns {boolean} True if the order can be modified
     */
    get canModify() {
      return Alpine.store('orders').currentOrder?.status === 'active';
    },

    /**
     * Check if an order is locked (finalized or completed).
     * Locked orders cannot have their items modified.
     *
     * @param {Object|null|undefined} order - Order object with status property
     * @returns {boolean} True if the order is locked
     */
    isOrderLocked(order) {
      return ['finalized', 'completed'].includes(order?.status);
    },

    /**
     * Check if an order is editable (active status).
     * Only active orders allow item modifications.
     *
     * @param {Object|null|undefined} order - Order object with status property
     * @returns {boolean} True if the order can be edited
     */
    isOrderEditable(order) {
      return order?.status === 'active';
    },

    /**
     * Add a menu item directly to the active order (not to the cart).
     * Used when the "Them mon" (Add items) menu browser is open in detail mode.
     * Each tap inserts a new order_items row immediately.
     *
     * @param {Object} menuItem - Menu item with { id, name, price }
     */
    async addItemDirectly(menuItem) {
      if (!this.canModify) return;

      try {
        this.isSavingItem = 'adding';
        await Alpine.store('orders').addItemToOrder(menuItem, 1, '');
      } catch (err) {
        console.error('[orderPage] addItemDirectly failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể thêm món.', 'error');
      } finally {
        this.isSavingItem = null;
      }
    },

    /**
     * Change the quantity of an existing order item.
     * If the new quantity is <= 0, the item is removed.
     * Saves immediately to the database.
     *
     * @param {string} orderItemId - UUID of the order_item
     * @param {number} newQty - New quantity value
     */
    async changeQty(orderItemId, newQty) {
      if (!this.canModify) return;

      try {
        this.isSavingItem = orderItemId;
        await Alpine.store('orders').updateOrderItemQty(orderItemId, newQty);
      } catch (err) {
        console.error('[orderPage] changeQty failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể cập nhật số lượng.', 'error');
      } finally {
        this.isSavingItem = null;
      }
    },

    /**
     * Remove an order item from the current order.
     * Deletes the order_items row immediately.
     *
     * @param {string} orderItemId - UUID of the order_item to remove
     */
    async removeOrderItem(orderItemId) {
      if (!this.canModify) return;

      try {
        this.isSavingItem = orderItemId;
        await Alpine.store('orders').removeOrderItem(orderItemId);
      } catch (err) {
        console.error('[orderPage] removeOrderItem failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể xóa món.', 'error');
      } finally {
        this.isSavingItem = null;
      }
    },

    /**
     * Save the note for an order item. Called on blur of the note textarea
     * to save immediately to the database.
     *
     * @param {string} orderItemId - UUID of the order_item
     * @param {string} note - New note text
     */
    async saveNote(orderItemId, note) {
      if (!this.canModify) return;

      try {
        this.savingNote = orderItemId;
        await Alpine.store('orders').updateOrderItemNote(orderItemId, note);
      } catch (err) {
        console.error('[orderPage] saveNote failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể lưu ghi chú.', 'error');
      } finally {
        this.savingNote = null;
      }
    },

    // --- Payment Request Actions ---
    // Design reference: Section 4.3.6
    // Requirements: 5.2 AC-5

    /**
     * Request payment for the current order.
     * Transitions order to 'completed' and table to 'awaiting_payment',
     * locking modification controls. Shows success/error toast.
     */
    async requestPayment() {
      if (this.isRequestingPayment) return;
      this.isRequestingPayment = true;

      try {
        await Alpine.store('orders').requestPayment();
        Alpine.store('ui').showToast('Đã yêu cầu thanh toán', 'success');
      } catch (err) {
        console.error('[orderPage] requestPayment failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể yêu cầu thanh toán', 'error');
      } finally {
        this.isRequestingPayment = false;
      }
    },

    /**
     * Cancel a payment request, reverting the order to active.
     * Transitions order back to 'active' and table back to 'serving',
     * re-enabling modification controls. Shows success/error toast.
     */
    async cancelPaymentRequest() {
      if (this.isRequestingPayment) return;
      this.isRequestingPayment = true;

      try {
        await Alpine.store('orders').cancelPaymentRequest();
        Alpine.store('ui').showToast('Đã hủy yêu cầu thanh toán', 'success');
      } catch (err) {
        console.error('[orderPage] cancelPaymentRequest failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể hủy yêu cầu thanh toán', 'error');
      } finally {
        this.isRequestingPayment = false;
      }
    },

    /**
     * Toggle the "Add more items" menu browser in detail mode.
     * When activated, loads the menu if not already loaded and shows
     * the category tabs + menu grid. Tapping a menu item calls
     * addItemDirectly() instead of addToCart().
     */
    toggleAddItems() {
      this.isAddingItems = !this.isAddingItems;
      if (this.isAddingItems) {
        // Ensure menu is loaded for the current outlet
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (outletId && Alpine.store('orders').menuItems.length === 0) {
          Alpine.store('orders').loadMenu(outletId);
        }
      }
    },

    // --- Cancel Order (S3-11) ---
    // Design reference: Section 4.3.9
    // Requirements: 5.2 AC-10

    /**
     * Cancel the current order via the cancel-order Edge Function.
     * Restores inventory, resets table to empty, navigates back to table map.
     */
    async cancelOrder() {
      if (this.isCancelling) return;
      this.isCancelling = true;

      try {
        const orderId = Alpine.store('orders').currentOrder?.id;
        const outletId = Alpine.store('auth').user?.outlet_id;

        if (!orderId || !outletId) {
          throw new Error('Thiếu thông tin đơn hàng hoặc chi nhánh.');
        }

        const { data, error } = await supabase.functions.invoke('cancel-order', {
          body: { order_id: orderId, outlet_id: outletId },
        });

        if (error) {
          const msg = data?.message || error.message || 'Không thể hủy đơn hàng.';
          throw new Error(msg);
        }

        // Update local table map store
        const tableMap = Alpine.store('tableMap');
        const table = tableMap.getTableById(this.tableId);
        if (table) {
          table.status = 'empty';
          table.activeOrderStartedAt = null;
        }

        // Clear current order state
        Alpine.store('orders').currentOrder = null;
        Alpine.store('orders').orderItems = [];

        Alpine.store('ui').showToast('Đơn hàng đã bị hủy', 'success');
        navigate('/tables');
      } catch (err) {
        console.error('[orderPage] cancelOrder failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể hủy đơn hàng.', 'error');
      } finally {
        this.isCancelling = false;
        this.showCancelConfirm = false;
      }
    },

    // --- Transfer Order (S3-13) ---
    // Design reference: Section 3.4.4
    // Requirements: 5.2 AC-7

    /**
     * Open the transfer modal with a list of empty tables.
     */
    openTransferModal() {
      const tables = Alpine.store('tableMap').tables || [];
      this.emptyTables = tables.filter(t => t.status === 'empty');
      this.selectedTransferTarget = null;

      if (this.emptyTables.length === 0) {
        Alpine.store('ui').showToast('Không có bàn trống nào để chuyển.', 'warning');
        return;
      }

      this.showTransferModal = true;
    },

    /**
     * Confirm the transfer to the selected target table.
     * Updates table statuses and navigates to the target table's order view.
     * S3-22: Timer continuity — target table inherits original started_at.
     */
    async confirmTransfer() {
      if (this.isTransferring || !this.selectedTransferTarget) return;
      this.isTransferring = true;

      try {
        const orderId = Alpine.store('orders').currentOrder?.id;
        const startedAt = Alpine.store('orders').currentOrder?.started_at;

        if (!orderId) {
          throw new Error('Thiếu thông tin đơn hàng.');
        }

        const { data, error } = await supabase.functions.invoke('transfer-order', {
          body: { order_id: orderId, target_table_id: this.selectedTransferTarget },
        });

        if (error) {
          const msg = data?.message || error.message || 'Không thể chuyển bàn.';
          throw new Error(msg);
        }

        // Update local table map: source -> empty, target -> serving
        const tableMap = Alpine.store('tableMap');
        const sourceTable = tableMap.getTableById(this.tableId);
        if (sourceTable) {
          sourceTable.status = 'empty';
          sourceTable.activeOrderStartedAt = null;
        }

        const targetTable = tableMap.getTableById(this.selectedTransferTarget);
        if (targetTable) {
          targetTable.status = 'serving';
          // S3-22: Timer continuity — keep original started_at
          targetTable.activeOrderStartedAt = startedAt;
        }

        Alpine.store('ui').showToast('Đã chuyển bàn thành công', 'success');

        // Navigate to the target table's order view
        this.showTransferModal = false;
        navigate(`/orders/${this.selectedTransferTarget}`);
      } catch (err) {
        console.error('[orderPage] confirmTransfer failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể chuyển bàn.', 'error');
      } finally {
        this.isTransferring = false;
      }
    },

    // --- Merge Orders (S3-15) ---
    // Design reference: Section 3.4.3
    // Requirements: 5.2 AC-8

    /**
     * Open the merge modal. Loads serving tables (excluding current) with their
     * active order IDs so we can pass them to the merge edge function.
     */
    async openMergeModal() {
      const tables = Alpine.store('tableMap').tables || [];
      const servingTables = tables.filter(
        t => t.status === 'serving' && t.id !== this.tableId,
      );

      if (servingTables.length === 0) {
        Alpine.store('ui').showToast('Không có bàn nào đang phục vụ để gộp.', 'warning');
        return;
      }

      // Fetch active orders for all serving tables in a single query
      try {
        const tableIds = servingTables.map(t => t.id);
        const { data: orders, error } = await supabase
          .from('orders')
          .select('id, table_id')
          .in('table_id', tableIds)
          .eq('status', 'active');

        if (error) throw error;

        // Build merge candidates: match each order to its table info
        const orderByTable = {};
        (orders || []).forEach(o => { orderByTable[o.table_id] = o.id; });

        this.mergeCandidates = servingTables
          .filter(t => orderByTable[t.id]) // only tables with active orders
          .map(t => ({
            orderId: orderByTable[t.id],
            tableId: t.id,
            tableName: t.name || '',
            tableLabel: t.table_code || t.label || '',
          }));

        if (this.mergeCandidates.length === 0) {
          Alpine.store('ui').showToast('Không có đơn hàng hoạt động để gộp.', 'warning');
          return;
        }

        this.selectedMergeSources = [];
        this.showMergeModal = true;
      } catch (err) {
        console.error('[orderPage] openMergeModal failed:', err);
        Alpine.store('ui').showToast('Không thể tải danh sách bàn để gộp.', 'error');
      }
    },

    /**
     * Toggle a source order in/out of the merge selection.
     * @param {string} orderId - UUID of the order to toggle
     */
    toggleMergeSource(orderId) {
      const idx = this.selectedMergeSources.indexOf(orderId);
      if (idx >= 0) {
        this.selectedMergeSources.splice(idx, 1);
      } else {
        this.selectedMergeSources.push(orderId);
      }
    },

    /**
     * Confirm the merge: merge selected source orders into the current order.
     * Reloads the current order to show all merged items.
     */
    async confirmMerge() {
      if (this.isMerging || this.selectedMergeSources.length === 0) return;
      this.isMerging = true;

      try {
        const targetOrderId = Alpine.store('orders').currentOrder?.id;

        if (!targetOrderId) {
          throw new Error('Thiếu thông tin đơn hàng hiện tại.');
        }

        const { data, error } = await supabase.functions.invoke('merge-orders', {
          body: {
            target_order_id: targetOrderId,
            source_order_ids: this.selectedMergeSources,
          },
        });

        if (error) {
          const msg = data?.message || error.message || 'Không thể gộp đơn hàng.';
          throw new Error(msg);
        }

        // Update local table map: source tables -> empty
        const tableMap = Alpine.store('tableMap');
        for (const candidate of this.mergeCandidates) {
          if (this.selectedMergeSources.includes(candidate.orderId)) {
            const t = tableMap.getTableById(candidate.tableId);
            if (t) {
              t.status = 'empty';
              t.activeOrderStartedAt = null;
            }
          }
        }

        // Reload current order to reflect merged items
        await Alpine.store('orders').loadOrder(targetOrderId);

        Alpine.store('ui').showToast('Đã gộp đơn hàng thành công', 'success');
        this.showMergeModal = false;
      } catch (err) {
        console.error('[orderPage] confirmMerge failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể gộp đơn hàng.', 'error');
      } finally {
        this.isMerging = false;
      }
    },
  };
}

// Register as global function so x-data="orderPage()" works
// when the template is dynamically loaded by the router
window.orderPage = orderPage;
