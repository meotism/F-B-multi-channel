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

import { formatVND, calculateElapsed, formatTimer, getTimerColorClass } from '../../utils/formatters.js';
import { navigate } from '../../utils/navigate.js';
import { supabase } from '../../services/supabase-client.js';
import { updateOrderNote, setGuestCount } from '../../services/order-service.js';
import { onSwipe } from '../../utils/swipe.js';
import {
  listActiveDiscounts,
  applyToOrder,
  removeFromOrder,
  calculateDiscount,
} from '../../services/discount-service.js';

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
    tableHourlyRate: 0,  // Hourly rate for time-based billing (0 = standard F&B)

    // --- UI state ---
    showCart: false,      // Whether the cart bottom sheet is visible (mobile/tablet)
    isSubmitting: false,  // Whether the confirm button is in loading state
    mode: 'create',      // 'create' = new order (menu + cart), 'detail' = existing order view
    isAddingItems: false, // Whether the "add more items" menu browser is shown in detail mode
    isSavingItem: null,   // orderItemId currently being modified (for per-item loading state)
    savingNote: null,     // orderItemId whose note is currently being saved
    isRequestingPayment: false, // loading state for request/cancel payment buttons

    // --- Order-level fields (Task 9.1) ---
    orderNote: '',        // Order-level note text
    guestCount: 0,        // Number of guests at the table

    // --- Cart highlight animation (Task 9.2) ---
    justAdded: null,      // menuItemId that was just added to cart (cleared after 300ms)

    // --- Swipe-to-remove cleanup (Task 9.3) ---
    _swipeCleanups: [],   // Array of cleanup functions for swipe listeners

    // --- Conflict detection (Task 9.4) ---
    orderUpdatedAt: null,  // Tracks order.updated_at for conflict detection

    // --- Cancel order state (S3-11 + Task 9.5) ---
    showCancelConfirm: false,
    isCancelling: false,
    cancelReason: '',      // Cancellation reason text (manager/owner)

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

    // --- Hourly rate timer state ---
    _timerTick: 0,
    _timerInterval: null,

    // --- Discount state (Task 17.2) ---
    showDiscountModal: false,
    isLoadingDiscounts: false,
    availableDiscounts: [],   // Active/valid discounts from discount-service
    appliedDiscount: null,    // Currently applied discount object
    discountAmount: 0,        // Calculated discount amount in VND

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
        this.tableHourlyRate = table.hourly_rate || 0;
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
            // Task 9.1: Sync order-level fields from store
            this.orderNote = Alpine.store('orders').orderNote;
            this.guestCount = Alpine.store('orders').guestCount;
            // Task 9.4: Track updated_at for conflict detection
            this.orderUpdatedAt = order.updated_at || null;
            // Task 17.2: Sync discount if already applied
            if (order.discount_id) {
              try {
                const outletId = Alpine.store('auth').user?.outlet_id;
                if (outletId) {
                  const discounts = await listActiveDiscounts(outletId);
                  this.appliedDiscount = discounts.find(d => d.id === order.discount_id) || null;
                  this.recalcDiscount();
                }
              } catch (discErr) {
                console.warn('[orderPage] Failed to load applied discount:', discErr);
              }
            }
          }
        } catch (err) {
          console.error('[orderPage] Failed to load existing order:', err);
          Alpine.store('ui').showToast('Không thể tải đơn hàng hiện tại.', 'error');
        }
      }

      // Start timer for live hourly charge display (hourly-rate tables)
      if (this.tableHourlyRate > 0 && this.mode === 'detail') {
        this._timerInterval = setInterval(() => {
          this._timerTick = this._timerTick + 1;
        }, 1000);
      }
    },

    /**
     * Clean up swipe listeners and other resources when component is destroyed.
     * Task 9.3: Remove all swipe event listeners to prevent memory leaks.
     */
    destroy() {
      this._swipeCleanups.forEach(cleanup => cleanup());
      this._swipeCleanups = [];
      if (this._timerInterval) {
        clearInterval(this._timerInterval);
        this._timerInterval = null;
      }
    },

    /**
     * Navigate back to the table map.
     */
    goBack() {
      navigate('/tables');
    },

    /**
     * Navigate to the bill page for the current order.
     * Only callable when order status is 'completed' and user has cashier/manager/owner role.
     */
    goToBill() {
      const orderId = Alpine.store('orders').currentOrder?.id;
      if (orderId) {
        navigate(`/bills/${orderId}`);
      }
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
     * Task 9.2: Sets justAdded flag for highlight animation.
     *
     * @param {Object} menuItem - Menu item with { id, name, price }
     */
    addToCart(menuItem) {
      // Task 11.2: Prevent adding unavailable items
      if (menuItem.is_available === false) {
        Alpine.store('ui').showToast('Món này hiện đã hết hàng', 'warning');
        return;
      }
      Alpine.store('orders').addToCart(menuItem);

      // Task 9.2: Flash highlight on the cart item row
      this.justAdded = menuItem.id;
      setTimeout(() => {
        this.justAdded = null;
      }, 300);
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
      // Allow empty cart for hourly-rate tables (e.g., badminton courts)
      if (ordersStore.cart.length === 0 && !this.tableHourlyRate) return;

      this.isSubmitting = true;

      try {
        // Task 9.1: Pass guest count to store for order creation
        if (this.guestCount > 0) {
          ordersStore.guestCount = this.guestCount;
        }

        await ordersStore.createOrder(this.tableId);

        // Show success toast with Vietnamese text
        Alpine.store('ui').showToast('Đơn hàng đã tạo thành công', 'success');

        // Transition to order detail mode (don't navigate away)
        this.mode = 'detail';

        // Task 9.4: Track updated_at for conflict detection
        if (ordersStore.currentOrder?.updated_at) {
          this.orderUpdatedAt = ordersStore.currentOrder.updated_at;
        }

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

    // --- Hourly Rate Timer Methods ---

    /**
     * Get formatted elapsed time (HH:MM:SS) for the current order.
     * @returns {string} Formatted timer string
     */
    getElapsedTime() {
      void this._timerTick;
      const startedAt = Alpine.store('orders').currentOrder?.started_at;
      if (!startedAt) return '';
      return formatTimer(calculateElapsed(startedAt));
    },

    /**
     * Get the running hourly charge in VND.
     * @returns {number} Running charge amount
     */
    getRunningHourlyCharge() {
      void this._timerTick;
      const startedAt = Alpine.store('orders').currentOrder?.started_at;
      if (!startedAt || !this.tableHourlyRate) return 0;
      const elapsed = calculateElapsed(startedAt);
      return Math.round((elapsed / 3600) * this.tableHourlyRate);
    },

    /**
     * Get timer color CSS class based on elapsed time.
     * @returns {string} CSS class name
     */
    getTimerColorClass() {
      const startedAt = Alpine.store('orders').currentOrder?.started_at;
      if (!startedAt) return '';
      return getTimerColorClass(calculateElapsed(startedAt));
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
      // Task 11.2: Prevent adding unavailable items
      if (menuItem.is_available === false) {
        Alpine.store('ui').showToast('Món này hiện đã hết hàng', 'warning');
        return;
      }

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

    // --- Task 9.1: Order-level Note and Guest Count ---

    /**
     * Save the order-level note on blur.
     * Persists via orderService.updateOrderNote().
     */
    async saveOrderNote() {
      const orderId = Alpine.store('orders').currentOrder?.id;
      if (!orderId) return;

      try {
        const updated = await updateOrderNote(orderId, this.orderNote);
        Alpine.store('orders').orderNote = this.orderNote;
        if (updated.updated_at) {
          this.orderUpdatedAt = updated.updated_at;
        }
      } catch (err) {
        console.error('[orderPage] saveOrderNote failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể lưu ghi chú đơn hàng.', 'error');
      }
    },

    /**
     * Save the guest count on blur.
     * Persists via orderService.setGuestCount().
     */
    async saveGuestCount() {
      const orderId = Alpine.store('orders').currentOrder?.id;
      if (!orderId) return;

      const count = parseInt(this.guestCount, 10) || 0;
      if (count < 0) {
        this.guestCount = 0;
        return;
      }

      try {
        const updated = await setGuestCount(orderId, count);
        Alpine.store('orders').guestCount = count;
        if (updated.updated_at) {
          this.orderUpdatedAt = updated.updated_at;
        }
      } catch (err) {
        console.error('[orderPage] saveGuestCount failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể cập nhật số khách.', 'error');
      }
    },

    // --- Task 9.3: Swipe-to-remove on Cart Items ---

    /**
     * Attach swipe-left handlers to all cart item elements.
     * Called after the cart renders (via x-effect or after DOM update).
     * Cleans up previous listeners before reattaching.
     */
    attachCartSwipeHandlers() {
      // Clean up previous listeners
      this._swipeCleanups.forEach(cleanup => cleanup());
      this._swipeCleanups = [];

      // Find all cart item elements and attach swipe handlers
      this.$nextTick(() => {
        const cartItems = this.$el.querySelectorAll('.order-cart-item[data-cart-index]');
        cartItems.forEach(el => {
          const index = parseInt(el.dataset.cartIndex, 10);
          if (isNaN(index)) return;

          const cleanup = onSwipe(el, {
            onLeft: () => {
              // Slide-out animation then remove
              el.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
              el.style.transform = 'translateX(-100%)';
              el.style.opacity = '0';
              setTimeout(() => {
                Alpine.store('orders').removeFromCart(index);
              }, 250);
            },
          });
          this._swipeCleanups.push(cleanup);
        });
      });
    },

    // --- Task 9.4: Conflict Detection ---

    /**
     * Check if a realtime order update indicates a conflict.
     * Called from the template via x-effect watching $store.orders.currentOrder.
     * If updated_at differs from our tracked version, show a warning and reload.
     */
    checkForConflict() {
      const order = Alpine.store('orders').currentOrder;
      if (!order || !this.orderUpdatedAt) return;

      if (order.updated_at && order.updated_at !== this.orderUpdatedAt) {
        Alpine.store('ui').showToast(
          'Đơn hàng đã được cập nhật bởi người khác. Đang tải lại...',
          'warning',
        );
        this.orderUpdatedAt = order.updated_at;
        // Sync local fields from refreshed order
        this.orderNote = order.note || '';
        this.guestCount = order.guest_count || 0;
        // Reload the full order to get fresh items
        Alpine.store('orders').loadOrder(order.id);
      }
    },

    // --- Cancel Order (S3-11 + Task 9.5) ---
    // Design reference: Section 4.3.9
    // Requirements: 5.2 AC-10

    /**
     * Check if the current user can cancel orders.
     * Task 9.5: Only manager/owner/cashier roles with 'cancel_order' permission.
     *
     * @returns {boolean}
     */
    get canCancelOrder() {
      return Alpine.store('auth').hasPermission('cancel_order');
    },

    /**
     * Check if the current user is a manager or owner (can provide cancel reason).
     * Task 9.5: Managers/owners see the reason textarea.
     *
     * @returns {boolean}
     */
    get isManagerOrOwner() {
      const role = Alpine.store('auth').user?.role;
      return role === 'manager' || role === 'owner';
    },

    /**
     * Cancel the current order via the cancel-order Edge Function.
     * Task 9.5: Passes cancellation reason for manager/owner roles.
     * Restores inventory, resets table to empty, navigates back to table map.
     */
    async cancelOrder() {
      if (this.isCancelling) return;

      // Task 9.5: Require reason from manager/owner
      if (this.isManagerOrOwner && !this.cancelReason.trim()) {
        Alpine.store('ui').showToast('Vui lòng nhập lý do hủy đơn hàng.', 'warning');
        return;
      }

      this.isCancelling = true;

      try {
        const orderId = Alpine.store('orders').currentOrder?.id;
        const outletId = Alpine.store('auth').user?.outlet_id;

        if (!orderId || !outletId) {
          throw new Error('Thiếu thông tin đơn hàng hoặc chi nhánh.');
        }

        const body = { order_id: orderId, outlet_id: outletId };
        // Task 9.5: Include cancellation reason if provided
        if (this.cancelReason.trim()) {
          body.reason = this.cancelReason.trim();
        }

        const { data, error } = await supabase.functions.invoke('cancel-order', {
          body,
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
        this.cancelReason = '';
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

    // --- Discount Application (Task 17.2) ---
    // Design reference: Section 3.10 (Discount System)

    /**
     * Open the discount picker modal. Loads active/valid discounts for the outlet.
     * Also syncs the currently applied discount from the order if any.
     */
    async openDiscountModal() {
      this.showDiscountModal = true;
      this.isLoadingDiscounts = true;

      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) throw new Error('Thiếu thông tin cửa hàng');

        this.availableDiscounts = await listActiveDiscounts(outletId);

        // Sync applied discount from current order
        const order = Alpine.store('orders').currentOrder;
        if (order?.discount_id) {
          this.appliedDiscount = this.availableDiscounts.find(
            d => d.id === order.discount_id,
          ) || null;
          this.recalcDiscount();
        }
      } catch (err) {
        console.error('[orderPage] openDiscountModal failed:', err);
        Alpine.store('ui').showToast(
          err.message || 'Không thể tải danh sách khuyến mãi.',
          'error',
        );
      } finally {
        this.isLoadingDiscounts = false;
      }
    },

    /**
     * Apply a discount to the current order.
     * Updates the order's discount_id in the database, recalculates
     * the discount amount, and stores the discount info locally.
     *
     * @param {Object} discount - Discount object from availableDiscounts
     */
    async selectDiscount(discount) {
      const orderId = Alpine.store('orders').currentOrder?.id;
      if (!orderId) return;

      try {
        await applyToOrder(orderId, discount.id);
        this.appliedDiscount = discount;
        Alpine.store('orders').currentOrder.discount_id = discount.id;
        this.recalcDiscount();
        this.showDiscountModal = false;
        Alpine.store('ui').showToast('Đã áp dụng khuyến mãi: ' + discount.name, 'success');
      } catch (err) {
        console.error('[orderPage] selectDiscount failed:', err);
        Alpine.store('ui').showToast(
          err.message || 'Không thể áp dụng khuyến mãi.',
          'error',
        );
      }
    },

    /**
     * Remove the applied discount from the current order.
     */
    async clearDiscount() {
      const orderId = Alpine.store('orders').currentOrder?.id;
      if (!orderId) return;

      try {
        await removeFromOrder(orderId);
        this.appliedDiscount = null;
        this.discountAmount = 0;
        Alpine.store('orders').currentOrder.discount_id = null;
        Alpine.store('ui').showToast('Đã xóa khuyến mãi', 'success');
      } catch (err) {
        console.error('[orderPage] clearDiscount failed:', err);
        Alpine.store('ui').showToast(
          err.message || 'Không thể xóa khuyến mãi.',
          'error',
        );
      }
    },

    /**
     * Recalculate the discount amount based on the current order subtotal
     * and the applied discount. Called after applying/removing a discount
     * and when items change.
     */
    recalcDiscount() {
      if (!this.appliedDiscount) {
        this.discountAmount = 0;
        return;
      }
      const subtotal = Alpine.store('orders').orderTotal;
      this.discountAmount = calculateDiscount(subtotal, this.appliedDiscount);
    },

    /**
     * Format a discount description for display.
     * @param {Object} discount - Discount object with type and value
     * @returns {string} e.g., "10%" or "50.000đ"
     */
    formatDiscountValue(discount) {
      if (!discount) return '';
      if (discount.type === 'percent') return discount.value + '%';
      return formatVND(discount.value) + 'đ';
    },

    /**
     * Get the final total after discount.
     * @returns {number} Order total minus discount amount
     */
    get finalTotal() {
      const subtotal = Alpine.store('orders').orderTotal;
      return Math.max(0, subtotal - this.discountAmount);
    },
  };
}

// Register as global function so x-data="orderPage()" works
// when the template is dynamically loaded by the router
window.orderPage = orderPage;
