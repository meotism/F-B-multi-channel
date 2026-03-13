// Order List Page - Order listing with filters x-data component
//
// Alpine.js component for the order list page. Displays a filterable,
// sortable list of orders for the current outlet. Supports filters by
// status, date range, and table. Desktop shows a data table; mobile
// shows card layout (handled via CSS responsive classes).
//
// Design reference: Requirements 5.2 (Order List)

import { listOrders } from '../../services/order-service.js';
import { formatVND, formatDate } from '../../utils/formatters.js';
import { navigate } from '../../utils/navigate.js';

/**
 * Alpine component factory for the order list page.
 * Used as x-data="orderListPage()" in pages/order-list.html.
 *
 * @returns {Object} Alpine component data object
 */
export function orderListPage() {
  return {
    // --- Page state ---
    isLoading: true,
    orders: [],

    // --- Filter state ---
    filterStatus: '',
    filterDateFrom: '',
    filterDateTo: '',
    filterTableId: '',

    // --- Available tables for filter dropdown ---
    tables: [],

    /**
     * Initialize the component: load tables for the filter dropdown, then load orders.
     */
    async init() {
      // Populate table dropdown from the tableMap store
      this.tables = Alpine.store('tableMap').tables || [];

      await this.loadOrders();
    },

    /**
     * Load orders using current filters.
     */
    async loadOrders() {
      this.isLoading = true;

      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) return;

        const filters = {};

        if (this.filterStatus) {
          filters.status = this.filterStatus;
        }
        if (this.filterDateFrom) {
          filters.dateFrom = new Date(this.filterDateFrom).toISOString();
        }
        if (this.filterDateTo) {
          // Set to end of day
          const endDate = new Date(this.filterDateTo);
          endDate.setHours(23, 59, 59, 999);
          filters.dateTo = endDate.toISOString();
        }
        if (this.filterTableId) {
          filters.tableId = this.filterTableId;
        }

        this.orders = await listOrders(outletId, filters);
      } catch (err) {
        console.error('[orderListPage] loadOrders failed:', err);
        Alpine.store('ui').showToast('Không thể tải danh sách đơn hàng.', 'error');
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Apply filters and reload orders.
     */
    applyFilters() {
      this.loadOrders();
    },

    /**
     * Clear all filters and reload orders.
     */
    clearFilters() {
      this.filterStatus = '';
      this.filterDateFrom = '';
      this.filterDateTo = '';
      this.filterTableId = '';
      this.loadOrders();
    },

    /**
     * Navigate to the order detail page for a given order.
     * Routes to the order's table view.
     */
    viewOrder(order) {
      if (order.table_id) {
        navigate(`/orders/${order.table_id}`);
      }
    },

    /**
     * Calculate the total for an order from its order_items.
     */
    orderTotal(order) {
      if (!order.order_items || order.order_items.length === 0) return 0;
      return order.order_items.reduce(
        (sum, item) => sum + (item.price || 0) * (item.qty || 0),
        0,
      );
    },

    /**
     * Count total items in an order.
     */
    itemCount(order) {
      if (!order.order_items || order.order_items.length === 0) return 0;
      return order.order_items.reduce((sum, item) => sum + (item.qty || 0), 0);
    },

    /**
     * Get the table name for an order.
     */
    tableName(order) {
      return order.tables?.name || 'Không xác định';
    },

    /**
     * Truncate a UUID for display (first 8 chars).
     */
    truncateId(id) {
      if (!id) return '';
      return id.substring(0, 8);
    },

    /**
     * Get a Vietnamese status label for an order status.
     */
    statusLabel(status) {
      const map = {
        active: 'Đang phục vụ',
        completed: 'Chờ thanh toán',
        finalized: 'Đã thanh toán',
        cancelled: 'Đã hủy',
      };
      return map[status] || status;
    },

    /**
     * Get the badge CSS class for an order status.
     */
    statusBadgeClass(status) {
      const map = {
        active: 'badge--success',
        completed: 'badge--warning',
        finalized: 'badge--muted',
        cancelled: 'badge--danger',
      };
      return map[status] || 'badge--muted';
    },

    // --- Formatting helpers ---

    formatVND(amount) {
      return formatVND(amount);
    },

    formatDate(dateStr) {
      return formatDate(dateStr, 'long');
    },

    formatDateShort(dateStr) {
      return formatDate(dateStr, 'short');
    },
  };
}

// Register as global function so x-data="orderListPage()" works
// when the template is dynamically loaded by the router
window.orderListPage = orderListPage;
