// Menu Edit Page - Menu item create/edit form x-data component
//
// Alpine.js component for the menu item create/edit page (Manager only).
// Handles form state, validation, and CRUD operations via menu-service.js.
// Route params: id = 'new' for create mode, UUID for edit mode.
//
// Design reference: design.md Section 3.1.7 menu_items table
// Requirements: 5.6 AC-1/5 (create with name/price/category, edit menu item)

import {
  getMenuItem,
  createMenuItem,
  updateMenuItem,
  listCategories,
  getRecipes,
  addRecipe,
  deleteRecipe,
} from '../../services/menu-service.js';
import { listIngredients } from '../../services/inventory-service.js';
import { navigate } from '../../utils/navigate.js';

/**
 * Alpine component factory for the menu item create/edit page.
 * Used as x-data="menuEditPage()" in pages/menu-edit.html.
 *
 * @returns {Object} Alpine component data object
 */
export function menuEditPage() {
  return {
    // Mode state
    isNew: true,
    itemId: null,

    // Form fields
    formName: '',
    formPrice: '',
    formCategoryId: '',
    formIsActive: true,

    // Supporting data
    categories: [],

    // Recipe state
    recipes: [],
    ingredients: [],
    newIngredientId: '',
    newIngredientQty: '',
    recipesLoading: false,

    // UI state
    isLoading: true,
    isSaving: false,
    formError: '',

    /**
     * Initialize the component: determine create/edit mode from route params,
     * then load categories and (if editing) the existing menu item.
     */
    async init() {
      this.isLoading = true;

      try {
        // Extract route params from the page container's data attribute
        const container = document.getElementById('page-container');
        const params = JSON.parse(container?.dataset.routeParams || '{}');
        const id = params.id;

        if (id && id !== 'new') {
          this.isNew = false;
          this.itemId = id;
        }

        // Load categories first (needed for the dropdown)
        await this.loadCategories();

        // Load existing item data and recipes if in edit mode
        if (!this.isNew) {
          await this.loadItem(this.itemId);
          await this.loadIngredients();
          await this.loadRecipes(this.itemId);
        }
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể tải dữ liệu',
          'error',
        );
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Fetch all categories for the category dropdown.
     */
    async loadCategories() {
      const outletId = Alpine.store('auth').user?.outlet_id;
      if (!outletId) {
        throw new Error('Không tìm thấy thông tin cửa hàng');
      }
      this.categories = await listCategories(outletId);
    },

    /**
     * Fetch an existing menu item and populate form fields.
     * @param {string} id - The menu item UUID to load
     */
    async loadItem(id) {
      const item = await getMenuItem(id);
      this.formName = item.name;
      this.formPrice = item.price;
      this.formCategoryId = item.category_id || '';
      this.formIsActive = item.is_active;
    },

    // -----------------------------------------------------------------
    // Recipe management methods
    // -----------------------------------------------------------------

    /**
     * Fetch all recipes for this menu item.
     * @param {string} menuItemId - The menu item UUID
     */
    async loadRecipes(menuItemId) {
      this.recipesLoading = true;
      try {
        this.recipes = await getRecipes(menuItemId);
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể tải công thức',
          'error',
        );
      } finally {
        this.recipesLoading = false;
      }
    },

    /**
     * Fetch all ingredients for the dropdown. Uses the outlet from auth store.
     */
    async loadIngredients() {
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) return;
        this.ingredients = await listIngredients(outletId);
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể tải danh sách nguyên liệu',
          'error',
        );
      }
    },

    /**
     * Computed: ingredients not yet assigned to this recipe.
     * Used to populate the add-ingredient dropdown.
     * @returns {Array} Filtered ingredient list
     */
    get availableIngredients() {
      const usedIds = new Set(this.recipes.map(r => r.ingredient_id));
      return this.ingredients.filter(i => !usedIds.has(i.id));
    },

    /**
     * Get ingredient name by ID.
     * @param {string} id - Ingredient UUID
     * @returns {string} Ingredient name or empty string
     */
    getIngredientName(id) {
      const ing = this.ingredients.find(i => i.id === id);
      return ing ? ing.name : '';
    },

    /**
     * Get ingredient unit by ID.
     * @param {string} id - Ingredient UUID
     * @returns {string} Ingredient unit or empty string
     */
    getIngredientUnit(id) {
      const ing = this.ingredients.find(i => i.id === id);
      return ing ? ing.unit : '';
    },

    /**
     * Add a new ingredient to this menu item's recipe.
     * Validates ingredient selection and quantity before calling the service.
     */
    async addRecipeIngredient() {
      // Validate ingredient selection
      if (!this.newIngredientId) {
        Alpine.store('ui').showToast('Vui lòng chọn nguyên liệu', 'warning');
        return;
      }

      // Validate quantity is a positive number
      const qty = parseFloat(this.newIngredientQty);
      if (isNaN(qty) || qty <= 0) {
        Alpine.store('ui').showToast('Số lượng phải là số dương', 'warning');
        return;
      }

      try {
        await addRecipe(this.itemId, this.newIngredientId, qty);
        Alpine.store('ui').showToast('Thêm nguyên liệu vào công thức thành công', 'success');

        // Reset form and reload recipes
        this.newIngredientId = '';
        this.newIngredientQty = '';
        await this.loadRecipes(this.itemId);
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể thêm nguyên liệu vào công thức',
          'error',
        );
      }
    },

    /**
     * Remove an ingredient from this menu item's recipe.
     * @param {string} recipeId - The recipe UUID to delete
     */
    async removeRecipe(recipeId) {
      try {
        await deleteRecipe(recipeId);
        Alpine.store('ui').showToast('Xóa nguyên liệu khỏi công thức thành công', 'success');
        await this.loadRecipes(this.itemId);
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể xóa nguyên liệu khỏi công thức',
          'error',
        );
      }
    },

    /**
     * Validate form fields and save the menu item (create or update).
     * Navigates back to the menu list on success.
     */
    async save() {
      // Client-side validation
      this.formError = '';

      if (!this.formName.trim()) {
        this.formError = 'Tên món ăn không được để trống';
        return;
      }
      if (this.formName.trim().length > 255) {
        this.formError = 'Tên món ăn không được vượt quá 255 ký tự';
        return;
      }

      const price = parseInt(this.formPrice, 10);
      if (isNaN(price) || price < 0) {
        this.formError = 'Giá phải là số nguyên không âm';
        return;
      }

      this.isSaving = true;

      try {
        const data = {
          name: this.formName.trim(),
          price: price,
          category_id: this.formCategoryId || null,
          is_active: this.formIsActive,
        };

        if (this.isNew) {
          // Create new menu item
          const outletId = Alpine.store('auth').user?.outlet_id;
          if (!outletId) {
            throw new Error('Không tìm thấy thông tin cửa hàng');
          }
          data.outlet_id = outletId;
          await createMenuItem(data);
          Alpine.store('ui').showToast('Tạo món ăn thành công', 'success');
        } else {
          // Update existing menu item
          await updateMenuItem(this.itemId, data);
          Alpine.store('ui').showToast('Cập nhật món ăn thành công', 'success');
        }

        navigate('/menu');
      } catch (err) {
        this.formError = err.message || 'Không thể lưu món ăn';
      } finally {
        this.isSaving = false;
      }
    },

    /**
     * Cancel editing and navigate back to the menu list.
     */
    cancel() {
      navigate('/menu');
    },
  };
}

// Register as global function so x-data="menuEditPage()" works
// when the template is dynamically loaded by the router
window.menuEditPage = menuEditPage;
