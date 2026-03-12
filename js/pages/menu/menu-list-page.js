// Menu List Page - Menu items list and filter x-data component
//
// Alpine.js component for the menu management page (Manager/Owner only).
// Displays a filterable, searchable grid of menu items with category filter bar,
// active/inactive toggle, and soft-delete actions.
//
// Design reference: design.md Section 3.1.7 menu_items table
// Requirements: 5.6 AC-1/5/6 (menu CRUD, edit, disable/remove)

import {
  listMenuItems,
  updateMenuItem,
  deleteMenuItem,
  listCategories,
} from '../../services/menu-service.js';
import { formatVND } from '../../utils/formatters.js';
import { navigate } from '../../utils/navigate.js';

/**
 * Alpine component factory for the menu list page.
 * Used as x-data="menuPage()" in pages/menu-list.html.
 *
 * @returns {Object} Alpine component data object
 */
export function menuPage() {
  return {
    // Data state
    menuItems: [],
    categories: [],

    // Filter state
    selectedCategory: null, // null = show all categories
    searchQuery: '',

    // Loading state
    isLoading: true,

    // Delete confirmation modal state
    showDeleteModal: false,
    deleteTarget: null,
    isSaving: false,

    /**
     * Computed: filter menu items by selected category and search query.
     * Returns items matching both the category filter and the name search.
     * @returns {Array} Filtered menu items
     */
    get filteredItems() {
      let items = this.menuItems;

      // Filter by category
      if (this.selectedCategory !== null) {
        items = items.filter(item => item.category_id === this.selectedCategory);
      }

      // Filter by search query (case-insensitive name match)
      const query = this.searchQuery.trim().toLowerCase();
      if (query) {
        items = items.filter(item =>
          item.name.toLowerCase().includes(query),
        );
      }

      return items;
    },

    /**
     * Initialize the component: load data on mount.
     */
    async init() {
      await this.loadData();
    },

    /**
     * Fetch menu items (with category join) and categories list in parallel.
     */
    async loadData() {
      this.isLoading = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) {
          throw new Error('Không tìm thấy thông tin cửa hàng');
        }

        const [items, cats] = await Promise.all([
          listMenuItems(outletId),
          listCategories(outletId),
        ]);

        this.menuItems = items;
        this.categories = cats;
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể tải danh sách món ăn',
          'error',
        );
        this.menuItems = [];
        this.categories = [];
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Format a price value as VND string (e.g., "150.000").
     * @param {number} amount - The price amount
     * @returns {string} Formatted VND string
     */
    formatPrice(amount) {
      return formatVND(amount);
    },

    /**
     * Get the category name for a menu item from the joined data.
     * @param {Object} item - Menu item with nested categories object
     * @returns {string} Category name or empty placeholder
     */
    getCategoryName(item) {
      return item.categories?.name || 'Chưa phân loại';
    },

    /**
     * Navigate to create a new menu item.
     */
    goToCreate() {
      navigate('/menu/new');
    },

    /**
     * Navigate to edit an existing menu item.
     * @param {Object} item - The menu item to edit
     */
    goToEdit(item) {
      navigate('/menu/' + item.id);
    },

    /**
     * Toggle the is_active status of a menu item.
     * Uses optimistic update with rollback on failure.
     *
     * @param {Object} item - The menu item to toggle
     */
    async toggleActive(item) {
      const previousState = item.is_active;
      // Optimistic update
      item.is_active = !item.is_active;

      try {
        await updateMenuItem(item.id, { is_active: item.is_active });
        Alpine.store('ui').showToast(
          item.is_active ? 'Đã kích hoạt món ăn' : 'Đã ẩn món ăn',
          'success',
        );
      } catch (err) {
        // Revert on failure
        item.is_active = previousState;
        Alpine.store('ui').showToast(
          err.message || 'Không thể cập nhật trạng thái',
          'error',
        );
      }
    },

    /**
     * Open the delete confirmation modal for a menu item.
     * Soft-delete sets is_active = false to retain historical data.
     * @param {Object} item - The menu item to soft-delete
     */
    confirmDelete(item) {
      this.deleteTarget = item;
      this.showDeleteModal = true;
    },

    /**
     * Close the delete confirmation modal.
     */
    closeDeleteModal() {
      this.showDeleteModal = false;
      this.deleteTarget = null;
    },

    /**
     * Execute the soft-delete after confirmation.
     * Sets is_active = false and refreshes the list.
     */
    async submitDelete() {
      if (!this.deleteTarget) return;

      this.isSaving = true;

      try {
        await deleteMenuItem(this.deleteTarget.id);
        Alpine.store('ui').showToast('Đã xóa món ăn', 'success');
        this.closeDeleteModal();
        await this.loadData();
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể xóa món ăn',
          'error',
        );
        this.closeDeleteModal();
      } finally {
        this.isSaving = false;
      }
    },

    /**
     * Select a category filter. Pass null to show all items.
     * @param {string|null} categoryId - Category UUID or null for all
     */
    selectCategory(categoryId) {
      this.selectedCategory = categoryId;
    },
  };
}

// Register as global function so x-data="menuPage()" works
// when the template is dynamically loaded by the router
window.menuPage = menuPage;
