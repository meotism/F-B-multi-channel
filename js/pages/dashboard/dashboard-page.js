// Dashboard Page - Role-based dashboard x-data component
//
// Alpine.js component for the role-based dashboard home page.
// Shows different content sections depending on the user's role:
//   - Owner/Manager: Revenue today, active orders, low-stock alerts, quick actions
//   - Staff: Table map summary, pending order count
//   - Cashier: Pending bills count, recent finalized bills
//   - Warehouse: Low-stock items list, recent stock movements
//
// The component reads the user role from $store.auth and fetches data
// from the relevant services on init.
//
// Design reference: Requirements 3.9 (Dashboard)

import { supabase } from '../../services/supabase-client.js';
import { cachedSupabase } from '../../services/cached-query.js';
import { getLowStockItems } from '../../services/inventory-service.js';
import { formatVND } from '../../utils/formatters.js';
import { navigate } from '../../utils/navigate.js';

/**
 * Alpine component factory for the dashboard page.
 * Used as x-data="dashboardPage()" in pages/dashboard.html.
 *
 * @returns {Object} Alpine component data object
 */
export function dashboardPage() {
  return {
    // --- Page state ---
    isLoading: true,

    // --- Owner/Manager data ---
    revenueToday: 0,
    activeOrdersCount: 0,
    lowStockCount: 0,

    // --- Staff data ---
    totalTables: 0,
    servingTables: 0,
    emptyTables: 0,
    pendingOrdersCount: 0,

    // --- Cashier data ---
    pendingBillsCount: 0,
    recentBills: [],

    // --- Warehouse data ---
    lowStockItems: [],
    recentMovements: [],

    // --- Role helpers ---
    get role() {
      return Alpine.store('auth').user?.role || '';
    },

    get isOwnerOrManager() {
      return this.role === 'owner' || this.role === 'manager';
    },

    get isStaffRole() {
      return this.role === 'staff';
    },

    get isCashierRole() {
      return this.role === 'cashier';
    },

    get isWarehouseRole() {
      return this.role === 'warehouse';
    },

    get userName() {
      return Alpine.store('auth').user?.name || '';
    },

    /**
     * Initialize the dashboard: load data based on user role.
     */
    async init() {
      this.isLoading = true;

      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) return;

        // All roles see a greeting; load role-specific data in parallel
        const promises = [];

        if (this.isOwnerOrManager) {
          promises.push(this.loadOwnerManagerData(outletId));
        }

        if (this.isStaffRole) {
          promises.push(this.loadStaffData(outletId));
        }

        if (this.isCashierRole) {
          promises.push(this.loadCashierData(outletId));
        }

        if (this.isWarehouseRole) {
          promises.push(this.loadWarehouseData(outletId));
        }

        await Promise.all(promises);
      } catch (err) {
        console.error('[dashboardPage] init failed:', err);
        Alpine.store('ui').showToast('Không thể tải dữ liệu tổng quan.', 'error');
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Load Owner/Manager dashboard data: revenue today, active orders, low-stock count.
     */
    async loadOwnerManagerData(outletId) {
      // Revenue today: sum of finalized bills created today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [billsResult, ordersResult, lowStockResult] = await Promise.all([
        cachedSupabase
          .from('bills')
          .select('total')
          .eq('outlet_id', outletId)
          .gte('created_at', todayStart.toISOString()),
        cachedSupabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('outlet_id', outletId)
          .eq('status', 'active'),
        getLowStockItems(outletId),
      ]);

      // Calculate revenue
      if (billsResult.data) {
        this.revenueToday = billsResult.data.reduce(
          (sum, bill) => sum + (bill.total || 0),
          0,
        );
      }

      // Active orders count
      this.activeOrdersCount = ordersResult.count || 0;

      // Low stock count
      this.lowStockItems = lowStockResult || [];
      this.lowStockCount = this.lowStockItems.length;
    },

    /**
     * Load Staff dashboard data: table summary and pending orders.
     */
    async loadStaffData(outletId) {
      const tables = Alpine.store('tableMap').tables || [];
      this.totalTables = tables.length;
      this.servingTables = tables.filter(t => t.status === 'serving').length;
      this.emptyTables = tables.filter(t => t.status === 'empty').length;

      const { count } = await cachedSupabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('outlet_id', outletId)
        .eq('status', 'active');

      this.pendingOrdersCount = count || 0;
    },

    /**
     * Load Cashier dashboard data: pending bills count and recent finalized bills.
     */
    async loadCashierData(outletId) {
      const [pendingResult, recentResult] = await Promise.all([
        cachedSupabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('outlet_id', outletId)
          .eq('status', 'completed'),
        cachedSupabase
          .from('bills')
          .select('id, total, payment_method, created_at, status')
          .eq('outlet_id', outletId)
          .order('created_at', { ascending: false })
          .limit(5),
      ]);

      this.pendingBillsCount = pendingResult.count || 0;
      this.recentBills = recentResult.data || [];
    },

    /**
     * Load Warehouse dashboard data: low-stock items and recent stock movements.
     */
    async loadWarehouseData(outletId) {
      const [lowStockResult, movementsResult] = await Promise.all([
        getLowStockItems(outletId),
        cachedSupabase
          .from('stock_movements')
          .select('*, ingredients(name)')
          .eq('outlet_id', outletId)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      this.lowStockItems = lowStockResult || [];
      this.lowStockCount = this.lowStockItems.length;
      this.recentMovements = movementsResult.data || [];
    },

    // --- Formatting helpers ---

    formatVND(amount) {
      return formatVND(amount);
    },

    formatDate(dateStr) {
      if (!dateStr) return '';
      return new Date(dateStr).toLocaleString('vi-VN');
    },

    formatPaymentMethod(method) {
      const map = {
        cash: 'Tiền mặt',
        card: 'Thẻ',
        transfer: 'Chuyển khoản',
      };
      return map[method] || method;
    },

    formatMovementType(type) {
      const map = {
        in: 'Nhập kho',
        out: 'Xuất kho',
        adjustment: 'Điều chỉnh',
      };
      return map[type] || type;
    },

    /**
     * Truncate a UUID for display (first 8 chars).
     */
    truncateId(id) {
      if (!id) return '';
      return id.substring(0, 8);
    },

    // --- Navigation helpers ---

    goToTables() {
      navigate('/tables');
    },

    goToOrders() {
      navigate('/order-list');
    },

    goToMenu() {
      navigate('/menu');
    },

    goToInventory() {
      navigate('/inventory');
    },

    goToReports() {
      navigate('/reports');
    },

    goToSettings() {
      navigate('/settings');
    },
  };
}

// Register as global function so x-data="dashboardPage()" works
// when the template is dynamically loaded by the router
window.dashboardPage = dashboardPage;
