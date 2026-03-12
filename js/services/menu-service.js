// Menu Service - Menu items CRUD, categories CRUD
//
// Provides functions to list, create, update, and delete menu items and
// categories within an outlet.
// All operations use direct PostgREST via the Supabase client.
// RLS policies enforce outlet isolation and manager-only write access.

import { supabase } from './supabase-client.js';

// ============================================================
// Categories
// ============================================================

/**
 * List all categories for a specific outlet, ordered by sort_order ascending.
 *
 * @param {string} outletId - The outlet UUID to filter categories by
 * @returns {Promise<Array>} Array of category objects
 * @throws {Error} With Vietnamese message on failure
 */
export async function listCategories(outletId) {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('outlet_id', outletId)
    .order('sort_order', { ascending: true });

  if (error) {
    throw new Error('Không thể tải danh sách danh mục: ' + error.message);
  }

  return data || [];
}

/**
 * Create a new category in the specified outlet.
 * The outlet_id must be included in the data object.
 *
 * @param {{ outlet_id: string, name: string, sort_order: number }} data - Category data
 * @returns {Promise<Object>} The created category object
 * @throws {Error} With Vietnamese message on failure
 */
export async function createCategory(data) {
  const { data: created, error } = await supabase
    .from('categories')
    .insert(data)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể tạo danh mục: ' + error.message);
  }

  return created;
}

/**
 * Update an existing category's name, sort_order, or is_active status.
 *
 * @param {string} id - The category UUID to update
 * @param {{ name?: string, sort_order?: number, is_active?: boolean }} updates - Fields to update
 * @returns {Promise<Object>} The updated category object
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateCategory(id, updates) {
  const { data, error } = await supabase
    .from('categories')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật danh mục: ' + error.message);
  }

  return data;
}

/**
 * Delete a category by ID.
 * If the category has menu items referencing it (FK constraint), the database
 * will reject the deletion. The caller should catch the error and display
 * an appropriate message about existing menu items.
 *
 * @param {string} id - The category UUID to delete
 * @returns {Promise<void>}
 * @throws {Error} With Vietnamese message on failure (includes FK violation)
 */
export async function deleteCategory(id) {
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('id', id);

  if (error) {
    // Check for foreign key constraint violation (menu_items references categories)
    if (error.code === '23503' || error.message.includes('violates foreign key')) {
      throw new Error('Không thể xóa danh mục đang có món ăn');
    }
    throw new Error('Không thể xóa danh mục: ' + error.message);
  }
}


// ============================================================
// Menu Items
// ============================================================

/**
 * List all menu items for a specific outlet, with joined category name.
 * Ordered by name ascending for consistent display.
 *
 * @param {string} outletId - The outlet UUID to filter menu items by
 * @returns {Promise<Array>} Array of menu item objects with nested categories({ name })
 * @throws {Error} With Vietnamese message on failure
 */
export async function listMenuItems(outletId) {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*, categories(name)')
    .eq('outlet_id', outletId)
    .order('name', { ascending: true });

  if (error) {
    throw new Error('Không thể tải danh sách món ăn: ' + error.message);
  }

  return data || [];
}

/**
 * Get a single menu item by ID, with joined category name.
 *
 * @param {string} id - The menu item UUID
 * @returns {Promise<Object>} The menu item object with nested categories({ name })
 * @throws {Error} With Vietnamese message on failure
 */
export async function getMenuItem(id) {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*, categories(name)')
    .eq('id', id)
    .single();

  if (error) {
    throw new Error('Không thể tải thông tin món ăn: ' + error.message);
  }

  return data;
}

/**
 * Create a new menu item. The data object must include outlet_id.
 *
 * @param {{ outlet_id: string, name: string, price: number, category_id?: string, is_active?: boolean }} data - Menu item data
 * @returns {Promise<Object>} The created menu item object
 * @throws {Error} With Vietnamese message on failure
 */
export async function createMenuItem(data) {
  const { data: created, error } = await supabase
    .from('menu_items')
    .insert(data)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể tạo món ăn: ' + error.message);
  }

  return created;
}

/**
 * Update an existing menu item's name, price, category_id, or is_active status.
 *
 * @param {string} id - The menu item UUID to update
 * @param {{ name?: string, price?: number, category_id?: string|null, is_active?: boolean }} updates - Fields to update
 * @returns {Promise<Object>} The updated menu item object
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateMenuItem(id, updates) {
  const { data, error } = await supabase
    .from('menu_items')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật món ăn: ' + error.message);
  }

  return data;
}

/**
 * Soft-delete a menu item by setting is_active = false.
 * Retains the record for historical order data referencing this item.
 *
 * @param {string} id - The menu item UUID to soft-delete
 * @returns {Promise<Object>} The updated menu item object
 * @throws {Error} With Vietnamese message on failure
 */
export async function deleteMenuItem(id) {
  const { data, error } = await supabase
    .from('menu_items')
    .update({ is_active: false })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể xóa món ăn: ' + error.message);
  }

  return data;
}


// ============================================================
// Recipes (ingredient consumption formula per menu item)
// ============================================================

/**
 * Get all recipes for a specific menu item, with joined ingredient name and unit.
 * Each recipe row defines how much of an ingredient is consumed per 1 unit of the menu item.
 *
 * @param {string} menuItemId - The menu item UUID
 * @returns {Promise<Array>} Array of recipe objects with nested ingredients(name, unit)
 * @throws {Error} With Vietnamese message on failure
 */
export async function getRecipes(menuItemId) {
  const { data, error } = await supabase
    .from('recipes')
    .select('*, ingredients(name, unit)')
    .eq('menu_item_id', menuItemId);

  if (error) {
    throw new Error('Không thể tải công thức: ' + error.message);
  }

  return data || [];
}

/**
 * Add a new ingredient to a menu item's recipe.
 * The UNIQUE constraint on (menu_item_id, ingredient_id) prevents duplicates.
 *
 * @param {string} menuItemId - The menu item UUID
 * @param {string} ingredientId - The ingredient UUID
 * @param {number} qty - Quantity of the ingredient consumed per 1 unit of the menu item
 * @returns {Promise<Object>} The created recipe object
 * @throws {Error} With Vietnamese message on failure (includes duplicate handling)
 */
export async function addRecipe(menuItemId, ingredientId, qty) {
  const { data, error } = await supabase
    .from('recipes')
    .insert({
      menu_item_id: menuItemId,
      ingredient_id: ingredientId,
      qty: qty,
    })
    .select('*, ingredients(name, unit)')
    .single();

  if (error) {
    // Handle UNIQUE constraint violation (duplicate ingredient in recipe)
    if (error.code === '23505' || error.message.includes('uq_recipe_item_ingredient')) {
      throw new Error('Nguyên liệu đã có trong công thức');
    }
    throw new Error('Không thể thêm nguyên liệu vào công thức: ' + error.message);
  }

  return data;
}

/**
 * Update the quantity of an ingredient in a recipe.
 *
 * @param {string} recipeId - The recipe UUID to update
 * @param {number} qty - New quantity value (must be positive)
 * @returns {Promise<Object>} The updated recipe object
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateRecipe(recipeId, qty) {
  const { data, error } = await supabase
    .from('recipes')
    .update({ qty: qty })
    .eq('id', recipeId)
    .select('*, ingredients(name, unit)')
    .single();

  if (error) {
    throw new Error('Không thể cập nhật công thức: ' + error.message);
  }

  return data;
}

/**
 * Delete an ingredient from a menu item's recipe.
 *
 * @param {string} recipeId - The recipe UUID to delete
 * @returns {Promise<void>}
 * @throws {Error} With Vietnamese message on failure
 */
export async function deleteRecipe(recipeId) {
  const { error } = await supabase
    .from('recipes')
    .delete()
    .eq('id', recipeId);

  if (error) {
    throw new Error('Không thể xóa nguyên liệu khỏi công thức: ' + error.message);
  }
}
