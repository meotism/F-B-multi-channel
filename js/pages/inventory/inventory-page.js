// Inventory Page - Inventory dashboard, stock levels, threshold alerts, manual update
//
// Alpine.js component for the inventory dashboard page (Manager/Warehouse).
// Displays all inventory items with stock levels, threshold alerts, search/filter,
// sort, and a stock update modal.
//
// Subscribes to Supabase Realtime for live inventory updates.
//
// Design reference: Section 3.1.10 inventory table, Section 3.2.9 RLS (inventory)
// Realtime: Section 3.3.1 (inventory UPDATE events)

import { listInventory, updateInventory, getLowStockItems, recordStockIn, getStockMovements } from '../../services/inventory-service.js';
import { formatDate } from '../../utils/formatters.js';
import { supabase } from '../../services/supabase-client.js';
import { withCacheInvalidation } from '../../services/cache-invalidation.js';
import { cacheManager } from '../../services/cache-manager.js';

/**
 * Alpine component factory for the inventory dashboard page.
 * Used as x-data="inventoryPage()" in pages/inventory.html.
 *
 * @returns {Object} Alpine component data object
 */
export function inventoryPage() {
  return {
    // Inventory list state
    inventoryItems: [],
    isLoading: true,

    // Search and sort state
    searchQuery: '',
    sortBy: 'name',    // 'name' | 'qty_on_hand' | 'alert'
    sortDir: 'asc',    // 'asc' | 'desc'

    // Update modal state
    showUpdateModal: false,
    updatingItem: null,
    newQty: 0,
    updateError: '',
    isSaving: false,

    // Task 12.1: Low stock alert state
    lowStockItems: [],

    // Task 12.1: Stock-in modal state
    showStockInModal: false,
    stockInItem: null,
    stockInQty: 0,
    stockInNote: '',
    stockInError: '',
    isStockingIn: false,

    // Task 12.2: Stock movement history state (per-item expand)
    expandedItemId: null,
    stockMovements: [],
    isLoadingMovements: false,

    // Realtime subscription channel reference
    _realtimeChannel: null,

    // --- Computed Properties ---

    /**
     * Total number of inventory items.
     * @returns {number}
     */
    get totalCount() {
      return this.inventoryItems.length;
    },

    /**
     * Count of items where qty_on_hand <= threshold (low stock).
     * @returns {number}
     */
    get lowStockCount() {
      return this.inventoryItems.filter(
        item => item.qty_on_hand <= item.threshold
      ).length;
    },

    /**
     * Items filtered by search query and sorted by the active sort field.
     * @returns {Array}
     */
    get filteredItems() {
      let items = this.inventoryItems;

      // Apply search filter by ingredient name
      const query = this.searchQuery.trim().toLowerCase();
      if (query) {
        items = items.filter(item => {
          const name = (item.ingredients?.name || '').toLowerCase();
          return name.includes(query);
        });
      }

      // Apply sort
      const dir = this.sortDir === 'asc' ? 1 : -1;
      items = [...items].sort((a, b) => {
        if (this.sortBy === 'name') {
          const nameA = (a.ingredients?.name || '').toLowerCase();
          const nameB = (b.ingredients?.name || '').toLowerCase();
          return nameA.localeCompare(nameB, 'vi') * dir;
        }
        if (this.sortBy === 'qty_on_hand') {
          return (Number(a.qty_on_hand) - Number(b.qty_on_hand)) * dir;
        }
        if (this.sortBy === 'alert') {
          // Low-stock items first when ascending
          const aLow = a.qty_on_hand <= a.threshold ? 0 : 1;
          const bLow = b.qty_on_hand <= b.threshold ? 0 : 1;
          if (aLow !== bLow) return (aLow - bLow) * dir;
          // Secondary sort by name
          const nameA = (a.ingredients?.name || '').toLowerCase();
          const nameB = (b.ingredients?.name || '').toLowerCase();
          return nameA.localeCompare(nameB, 'vi');
        }
        return 0;
      });

      return items;
    },

    // --- Lifecycle ---

    /**
     * Initialize the component: load inventory data and subscribe to realtime.
     */
    async init() {
      await this.loadInventory();
      // Task 12.1: Load low stock items for the alert banner
      await this.loadLowStockItems();
      this.subscribeRealtime();
    },

    /**
     * Clean up realtime subscription when component is destroyed.
     */
    destroy() {
      this.unsubscribeRealtime();
    },

    // --- Data Loading ---

    /**
     * Fetch all inventory items for the current outlet.
     */
    async loadInventory() {
      this.isLoading = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) {
          throw new Error('Khong tim thay thong tin cua hang');
        }
        this.inventoryItems = await listInventory(outletId);
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Khong the tai du lieu ton kho',
          'error',
        );
        this.inventoryItems = [];
      } finally {
        this.isLoading = false;
      }
    },

    // --- Sort ---

    /**
     * Toggle sort direction for a field, or switch to a new sort field.
     * @param {string} field - Sort field: 'name', 'qty_on_hand', or 'alert'
     */
    toggleSort(field) {
      if (this.sortBy === field) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        this.sortBy = field;
        this.sortDir = 'asc';
      }
    },

    // --- Formatters ---

    /**
     * Format a date string for display.
     * @param {string} dateStr - ISO date string
     * @returns {string} Formatted date
     */
    formatDate(dateStr) {
      return formatDate(dateStr, 'long');
    },

    /**
     * Format a quantity value for display (remove trailing zeros).
     * @param {number|string} qty - Quantity value
     * @returns {string} Formatted quantity
     */
    formatQty(qty) {
      if (qty == null) return '0';
      const num = Number(qty);
      // Remove unnecessary trailing zeros from decimal representation
      return num % 1 === 0 ? num.toFixed(0) : num.toFixed(3).replace(/0+$/, '');
    },

    // --- Update Modal ---

    /**
     * Open the stock update modal for an inventory item.
     * @param {Object} item - The inventory item to update
     */
    openUpdateModal(item) {
      this.updatingItem = item;
      this.newQty = Number(item.qty_on_hand);
      this.updateError = '';
      this.showUpdateModal = true;
    },

    /**
     * Close the stock update modal.
     */
    closeUpdateModal() {
      this.showUpdateModal = false;
      this.updatingItem = null;
      this.newQty = 0;
      this.updateError = '';
    },

    /**
     * Validate and submit the stock update.
     * The audit_inventory_change trigger automatically logs the change.
     */
    async submitUpdate() {
      this.updateError = '';

      // Validate quantity
      if (this.newQty == null || this.newQty === '') {
        this.updateError = 'Vui long nhap so luong moi';
        return;
      }

      const qty = Number(this.newQty);
      if (isNaN(qty) || qty < 0) {
        this.updateError = 'So luong khong hop le';
        return;
      }

      if (!this.updatingItem) return;

      this.isSaving = true;

      try {
        await updateInventory(this.updatingItem.id, qty);

        // Update local data immediately
        const index = this.inventoryItems.findIndex(i => i.id === this.updatingItem.id);
        if (index !== -1) {
          this.inventoryItems[index].qty_on_hand = qty;
          this.inventoryItems[index].updated_at = new Date().toISOString();
        }

        Alpine.store('ui').showToast('Cap nhat ton kho thanh cong', 'success');
        this.closeUpdateModal();
      } catch (err) {
        this.updateError = err.message || 'Khong the cap nhat ton kho';
      } finally {
        this.isSaving = false;
      }
    },

    // --- Task 12.1: Low Stock Alerts ---

    /**
     * Fetch low stock items for the current outlet.
     */
    async loadLowStockItems() {
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) return;
        this.lowStockItems = await getLowStockItems(outletId);
      } catch (err) {
        console.warn('[inventoryPage] Failed to load low stock items:', err);
        this.lowStockItems = [];
      }
    },

    // --- Task 12.1: Stock-In Modal ---

    /**
     * Open the stock-in modal for an inventory item.
     * @param {Object} item - The inventory item
     */
    openStockInModal(item) {
      this.stockInItem = item;
      this.stockInQty = 0;
      this.stockInNote = '';
      this.stockInError = '';
      this.showStockInModal = true;
    },

    /**
     * Close the stock-in modal.
     */
    closeStockInModal() {
      this.showStockInModal = false;
      this.stockInItem = null;
      this.stockInQty = 0;
      this.stockInNote = '';
      this.stockInError = '';
    },

    /**
     * Submit the stock-in form.
     */
    async submitStockIn() {
      this.stockInError = '';

      if (!this.stockInQty || Number(this.stockInQty) <= 0) {
        this.stockInError = 'Số lượng nhập phải lớn hơn 0';
        return;
      }

      if (!this.stockInItem) return;

      this.isStockingIn = true;

      try {
        const userId = Alpine.store('auth').user?.id;
        const outletId = Alpine.store('auth').user?.outlet_id;

        const updated = await recordStockIn(
          this.stockInItem.id,
          Number(this.stockInQty),
          this.stockInNote,
          userId,
          outletId,
        );

        // Update local data
        const index = this.inventoryItems.findIndex(i => i.id === this.stockInItem.id);
        if (index !== -1) {
          this.inventoryItems[index].qty_on_hand = updated.qty_on_hand;
          this.inventoryItems[index].updated_at = updated.updated_at || new Date().toISOString();
        }

        Alpine.store('ui').showToast('Nhập kho thành công', 'success');
        this.closeStockInModal();

        // Refresh low stock items
        await this.loadLowStockItems();
      } catch (err) {
        this.stockInError = err.message || 'Không thể nhập kho';
      } finally {
        this.isStockingIn = false;
      }
    },

    // --- Task 12.2: Stock Movement History ---

    /**
     * Toggle the stock movement history for an inventory item.
     * @param {Object} item - The inventory item
     */
    async toggleMovementHistory(item) {
      if (this.expandedItemId === item.id) {
        // Collapse
        this.expandedItemId = null;
        this.stockMovements = [];
        return;
      }

      this.expandedItemId = item.id;
      this.isLoadingMovements = true;
      this.stockMovements = [];

      try {
        this.stockMovements = await getStockMovements(item.ingredient_id);
      } catch (err) {
        console.error('[inventoryPage] Failed to load stock movements:', err);
        Alpine.store('ui').showToast('Không thể tải lịch sử xuất nhập kho', 'error');
      } finally {
        this.isLoadingMovements = false;
      }
    },

    /**
     * Format a stock movement type to Vietnamese.
     * @param {string} type - 'in' | 'out' | 'adjustment'
     * @returns {string}
     */
    formatMovementType(type) {
      const map = { in: 'Nhập kho', out: 'Xuất kho', adjustment: 'Điều chỉnh' };
      return map[type] || type;
    },

    // --- Realtime Subscription ---

    /**
     * Subscribe to inventory table changes for the current outlet.
     * Updates local data when stock changes are received from other clients.
     */
    subscribeRealtime() {
      const outletId = Alpine.store('auth').user?.outlet_id;
      if (!outletId) return;

      this._realtimeChannel = supabase
        .channel('inventory:' + outletId)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'inventory',
            filter: 'outlet_id=eq.' + outletId,
          },
          withCacheInvalidation('inventory', (payload) => {
            this.handleRealtimeUpdate(payload);
          }, cacheManager),
        )
        .subscribe();
    },

    /**
     * Remove the realtime subscription channel.
     */
    unsubscribeRealtime() {
      if (this._realtimeChannel) {
        supabase.removeChannel(this._realtimeChannel);
        this._realtimeChannel = null;
      }
    },

    /**
     * Handle a realtime UPDATE event on the inventory table.
     * Updates the corresponding item in the local inventoryItems array.
     *
     * @param {Object} payload - Supabase realtime change payload
     */
    handleRealtimeUpdate(payload) {
      const updated = payload.new;
      if (!updated) return;

      const index = this.inventoryItems.findIndex(i => i.id === updated.id);
      if (index !== -1) {
        // Preserve the joined ingredient data (realtime payload only has inventory columns)
        this.inventoryItems[index].qty_on_hand = updated.qty_on_hand;
        this.inventoryItems[index].threshold = updated.threshold;
        this.inventoryItems[index].updated_at = updated.updated_at;
      }
    },
  };
}

// Register as global function so x-data="inventoryPage()" works
// when the template is dynamically loaded by the router
window.inventoryPage = inventoryPage;
