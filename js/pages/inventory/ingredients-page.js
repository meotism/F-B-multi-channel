// Ingredients Page - Ingredients list and create/edit/delete modal x-data component
//
// Alpine.js component for the ingredients management page (Manager/Owner only).
// Manages ingredient list display, create/edit modals, form validation,
// and CRUD operations via inventory-service.js.
//
// When creating an ingredient, a corresponding inventory record is automatically
// created with qty_on_hand = 0 and threshold = 0.
//
// Design reference: Section 3.1.8 ingredients table
// RLS: Section 3.2.7 (ingredients)

import {
  listIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
} from '../../services/inventory-service.js';
import { formatDate } from '../../utils/formatters.js';

/** Common unit options for the unit selector */
const UNIT_OPTIONS = ['g', 'kg', 'ml', 'l', 'pcs'];

/** Vietnamese labels for common units */
const UNIT_LABELS = {
  g: 'g (gram)',
  kg: 'kg (kilogram)',
  ml: 'ml (mililit)',
  l: 'l (lit)',
  pcs: 'pcs (cái/chiếc)',
};

/**
 * Alpine component factory for the ingredients management page.
 * Used as x-data="ingredientsPage()" in pages/ingredients.html.
 *
 * @returns {Object} Alpine component data object
 */
export function ingredientsPage() {
  return {
    // Ingredient list state
    ingredients: [],
    isLoading: true,

    // Modal state (shared for create and edit)
    showModal: false,
    editingIngredient: null, // null = create mode, object = edit mode

    // Delete confirmation state
    showDeleteModal: false,
    deleteTarget: null,

    // Form fields
    formName: '',
    formUnit: 'g',
    formError: '',
    isSaving: false,

    // Constants exposed to template
    unitOptions: UNIT_OPTIONS,
    unitLabels: UNIT_LABELS,

    /**
     * Initialize the component: load ingredients on mount.
     */
    async init() {
      await this.loadIngredients();
    },

    /**
     * Fetch all ingredients for the current outlet and update the list.
     */
    async loadIngredients() {
      this.isLoading = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) {
          throw new Error('Không tìm thấy thông tin cửa hàng');
        }
        this.ingredients = await listIngredients(outletId);
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể tải danh sách nguyên liệu',
          'error',
        );
        this.ingredients = [];
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Format a date string for display in the ingredients table.
     * @param {string} dateStr - ISO date string
     * @returns {string} Formatted date
     */
    formatDate(dateStr) {
      return formatDate(dateStr, 'short');
    },

    /**
     * Get the display label for a unit value.
     * Returns the raw value if no label is defined.
     * @param {string} unit - Unit key (e.g., 'g', 'ml', 'pcs')
     * @returns {string} Display label
     */
    getUnitLabel(unit) {
      return unit || '';
    },

    // ---- Create / Edit Modal ----

    /**
     * Open the modal in create mode with empty form fields.
     */
    openCreateModal() {
      this.editingIngredient = null;
      this.formName = '';
      this.formUnit = 'g';
      this.formError = '';
      this.showModal = true;
    },

    /**
     * Open the modal in edit mode, pre-filled with the selected ingredient's data.
     * @param {Object} ingredient - The ingredient object to edit
     */
    openEditModal(ingredient) {
      this.editingIngredient = ingredient;
      this.formName = ingredient.name;
      this.formUnit = ingredient.unit;
      this.formError = '';
      this.showModal = true;
    },

    /**
     * Close the create/edit modal.
     */
    closeModal() {
      this.showModal = false;
      this.editingIngredient = null;
    },

    /**
     * Validate and submit the create or edit form.
     * In create mode, also auto-creates an inventory record.
     */
    async submitForm() {
      // Client-side validation
      this.formError = '';

      if (!this.formName.trim()) {
        this.formError = 'Tên nguyên liệu không được để trống';
        return;
      }
      if (this.formName.trim().length > 255) {
        this.formError = 'Tên nguyên liệu không được vượt quá 255 ký tự';
        return;
      }
      if (!this.formUnit.trim()) {
        this.formError = 'Đơn vị không được để trống';
        return;
      }
      if (this.formUnit.trim().length > 50) {
        this.formError = 'Đơn vị không được vượt quá 50 ký tự';
        return;
      }

      this.isSaving = true;

      try {
        if (this.editingIngredient) {
          // Update existing ingredient
          await updateIngredient(this.editingIngredient.id, {
            name: this.formName.trim(),
            unit: this.formUnit.trim(),
          });
          Alpine.store('ui').showToast('Cập nhật nguyên liệu thành công', 'success');
        } else {
          // Create new ingredient (auto-creates inventory record)
          const outletId = Alpine.store('auth').user?.outlet_id;
          if (!outletId) {
            throw new Error('Không tìm thấy thông tin cửa hàng');
          }
          await createIngredient({
            outlet_id: outletId,
            name: this.formName.trim(),
            unit: this.formUnit.trim(),
          });
          Alpine.store('ui').showToast('Thêm nguyên liệu thành công', 'success');
        }

        this.closeModal();
        await this.loadIngredients();
      } catch (err) {
        this.formError = err.message || 'Không thể lưu nguyên liệu';
      } finally {
        this.isSaving = false;
      }
    },

    // ---- Delete Confirmation ----

    /**
     * Open the delete confirmation modal for an ingredient.
     * @param {Object} ingredient - The ingredient object to delete
     */
    confirmDelete(ingredient) {
      this.deleteTarget = ingredient;
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
     * Execute the ingredient deletion after confirmation.
     * Handles FK constraint errors gracefully.
     */
    async deleteIngredient() {
      if (!this.deleteTarget) return;

      this.isSaving = true;

      try {
        await deleteIngredient(this.deleteTarget.id);
        Alpine.store('ui').showToast('Xóa nguyên liệu thành công', 'success');
        this.closeDeleteModal();
        await this.loadIngredients();
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể xóa nguyên liệu',
          'error',
        );
        this.closeDeleteModal();
      } finally {
        this.isSaving = false;
      }
    },
  };
}

// Register as global function so x-data="ingredientsPage()" works
// when the template is dynamically loaded by the router
window.ingredientsPage = ingredientsPage;
