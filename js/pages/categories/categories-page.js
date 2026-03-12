// Categories Page - Categories list and inline edit x-data component
//
// Alpine.js component for the categories management page (Manager only).
// Manages category list display, create/edit modal, active toggle,
// sort order editing, and CRUD operations via menu-service.js.

import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from '../../services/menu-service.js';

/**
 * Alpine component factory for the categories management page.
 * Used as x-data="categoriesPage()" in pages/categories.html.
 *
 * @returns {Object} Alpine component data object
 */
export function categoriesPage() {
  return {
    // Category list state
    categories: [],
    isLoading: true,

    // Modal state (shared for create and edit)
    showModal: false,
    editingCategory: null, // null = create mode, object = edit mode

    // Form fields
    formName: '',
    formSortOrder: 0,
    formError: '',
    isSaving: false,

    // Delete confirmation modal state
    showDeleteModal: false,
    deleteTarget: null,

    /**
     * Whether the modal is in edit mode (vs. create mode).
     * @returns {boolean}
     */
    get isEditMode() {
      return this.editingCategory !== null;
    },

    /**
     * Initialize the component: load categories on mount.
     */
    async init() {
      await this.loadCategories();
    },

    /**
     * Fetch all categories for the current outlet and update the list.
     */
    async loadCategories() {
      this.isLoading = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) {
          throw new Error('Không tìm thấy thông tin cửa hàng');
        }
        this.categories = await listCategories(outletId);
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể tải danh sách danh mục',
          'error',
        );
        this.categories = [];
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Open the modal in create mode with empty form fields.
     * Calculates the next sort_order as max(existing) + 1.
     */
    openCreateModal() {
      this.editingCategory = null;
      this.formName = '';
      // Default sort_order: max existing + 1 (or 0 if no categories exist)
      const maxOrder = this.categories.reduce(
        (max, cat) => Math.max(max, cat.sort_order),
        -1,
      );
      this.formSortOrder = maxOrder + 1;
      this.formError = '';
      this.showModal = true;
    },

    /**
     * Open the modal in edit mode, pre-filled with the selected category's data.
     * @param {Object} cat - The category object to edit
     */
    openEditModal(cat) {
      this.editingCategory = cat;
      this.formName = cat.name;
      this.formSortOrder = cat.sort_order;
      this.formError = '';
      this.showModal = true;
    },

    /**
     * Close the create/edit modal.
     */
    closeModal() {
      this.showModal = false;
      this.editingCategory = null;
    },

    /**
     * Validate and submit the create/edit form.
     * Routes to create or update based on current mode.
     */
    async submitForm() {
      // Client-side validation
      this.formError = '';

      if (!this.formName.trim()) {
        this.formError = 'Tên danh mục không được để trống';
        return;
      }
      if (this.formName.trim().length > 100) {
        this.formError = 'Tên danh mục không được vượt quá 100 ký tự';
        return;
      }

      const sortOrder = parseInt(this.formSortOrder, 10);
      if (isNaN(sortOrder) || sortOrder < 0) {
        this.formError = 'Thứ tự sắp xếp phải là số không âm';
        return;
      }

      this.isSaving = true;

      try {
        if (this.isEditMode) {
          // Update existing category
          await updateCategory(this.editingCategory.id, {
            name: this.formName.trim(),
            sort_order: sortOrder,
          });
          Alpine.store('ui').showToast('Cập nhật danh mục thành công', 'success');
        } else {
          // Create new category
          const outletId = Alpine.store('auth').user?.outlet_id;
          if (!outletId) {
            throw new Error('Không tìm thấy thông tin cửa hàng');
          }
          await createCategory({
            outlet_id: outletId,
            name: this.formName.trim(),
            sort_order: sortOrder,
          });
          Alpine.store('ui').showToast('Tạo danh mục thành công', 'success');
        }

        this.closeModal();
        await this.loadCategories();
      } catch (err) {
        this.formError = err.message || 'Không thể lưu danh mục';
      } finally {
        this.isSaving = false;
      }
    },

    /**
     * Toggle the is_active status of a category immediately via API.
     * Updates the local state optimistically and reverts on failure.
     *
     * @param {Object} cat - The category object to toggle
     */
    async toggleActive(cat) {
      const previousState = cat.is_active;
      // Optimistic update
      cat.is_active = !cat.is_active;

      try {
        await updateCategory(cat.id, { is_active: cat.is_active });
        Alpine.store('ui').showToast(
          cat.is_active ? 'Đã kích hoạt danh mục' : 'Đã ẩn danh mục',
          'success',
        );
      } catch (err) {
        // Revert on failure
        cat.is_active = previousState;
        Alpine.store('ui').showToast(
          err.message || 'Không thể cập nhật trạng thái',
          'error',
        );
      }
    },

    /**
     * Open the delete confirmation modal for a category.
     * @param {Object} cat - The category object to delete
     */
    confirmDelete(cat) {
      this.deleteTarget = cat;
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
     * Execute the category deletion after confirmation.
     * Handles FK constraint errors with a user-friendly message.
     */
    async submitDelete() {
      if (!this.deleteTarget) return;

      this.isSaving = true;

      try {
        await deleteCategory(this.deleteTarget.id);
        Alpine.store('ui').showToast('Xóa danh mục thành công', 'success');
        this.closeDeleteModal();
        await this.loadCategories();
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể xóa danh mục',
          'error',
        );
        this.closeDeleteModal();
      } finally {
        this.isSaving = false;
      }
    },
  };
}

// Register as global function so x-data="categoriesPage()" works
// when the template is dynamically loaded by the router
window.categoriesPage = categoriesPage;
