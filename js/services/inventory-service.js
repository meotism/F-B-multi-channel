// Inventory Service - Ingredients CRUD, Inventory reads, manual updates, threshold alerts
//
// Provides functions to manage ingredients and inventory records.
// Ingredients are scoped to an outlet via outlet_id.
// When creating an ingredient, a corresponding inventory record is automatically created.
//
// Design reference: Section 3.1.8 ingredients table, Section 3.1.10 inventory table
// RLS: Section 3.2.7 (ingredients), Section 3.2.9 (inventory)

import { supabase } from './supabase-client.js';
import { cachedSupabase } from './cached-query.js';

// ---------------------------------------------------------------------------
// Ingredients CRUD
// ---------------------------------------------------------------------------

/**
 * List all ingredients for a given outlet, ordered by name ascending.
 *
 * @param {string} outletId - The outlet UUID
 * @returns {Promise<Array>} Array of ingredient objects
 * @throws {Error} With Vietnamese message on failure
 */
export async function listIngredients(outletId) {
  const { data, error } = await cachedSupabase
    .from('ingredients')
    .select('*')
    .eq('outlet_id', outletId)
    .order('name');

  if (error) {
    throw new Error('Không thể tải danh sách nguyên liệu: ' + error.message);
  }

  return data || [];
}

/**
 * Create a new ingredient and auto-create a corresponding inventory record
 * with qty_on_hand = 0 and threshold = 0.
 *
 * @param {{ outlet_id: string, name: string, unit: string }} data - Ingredient data
 * @returns {Promise<Object>} The created ingredient object
 * @throws {Error} With Vietnamese message on failure
 */
export async function createIngredient(data) {
  // Insert the ingredient
  const { data: ingredient, error: ingredientError } = await supabase
    .from('ingredients')
    .insert({
      outlet_id: data.outlet_id,
      name: data.name,
      unit: data.unit,
    })
    .select()
    .single();

  if (ingredientError) {
    throw new Error('Không thể tạo nguyên liệu: ' + ingredientError.message);
  }

  // Auto-create corresponding inventory record with qty_on_hand = 0
  const { error: inventoryError } = await supabase
    .from('inventory')
    .insert({
      outlet_id: data.outlet_id,
      ingredient_id: ingredient.id,
      qty_on_hand: 0,
      threshold: 0,
    });

  if (inventoryError) {
    // Log but do not fail -- the ingredient was created successfully.
    // The inventory record can be created later if needed.
    console.error('[InventoryService] Failed to auto-create inventory record:', inventoryError.message);
  } else {
    cachedSupabase.invalidate('inventory');
  }

  cachedSupabase.invalidate('ingredients');
  return ingredient;
}

/**
 * Update an existing ingredient's name and/or unit.
 *
 * @param {string} id - The ingredient UUID
 * @param {{ name?: string, unit?: string }} updates - Fields to update
 * @returns {Promise<Object>} The updated ingredient object
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateIngredient(id, updates) {
  const { data, error } = await supabase
    .from('ingredients')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật nguyên liệu: ' + error.message);
  }

  cachedSupabase.invalidate('ingredients');
  return data;
}

/**
 * Delete an ingredient by ID.
 * Handles FK constraint errors (PostgreSQL error code 23503) when the ingredient
 * is referenced by recipe records.
 *
 * @param {string} id - The ingredient UUID to delete
 * @returns {Promise<void>}
 * @throws {Error} With Vietnamese message on failure
 */
export async function deleteIngredient(id) {
  const { error } = await supabase
    .from('ingredients')
    .delete()
    .eq('id', id);

  if (error) {
    // FK constraint violation: ingredient is used in recipes
    if (error.code === '23503') {
      throw new Error('Không thể xóa nguyên liệu đang được sử dụng trong công thức');
    }
    throw new Error('Không thể xóa nguyên liệu: ' + error.message);
  }

  cachedSupabase.invalidate('ingredients');
}

// ---------------------------------------------------------------------------
// Inventory Dashboard
// ---------------------------------------------------------------------------

/**
 * List all inventory records for a given outlet, joined with ingredient
 * name and unit. Results are ordered by ingredient name ascending.
 *
 * Query: supabase.from('inventory').select('*, ingredients(name, unit)')
 *        .eq('outlet_id', outletId).order('updated_at', { ascending: false })
 *
 * @param {string} outletId - The outlet UUID
 * @returns {Promise<Array>} Array of inventory objects with nested ingredients data
 * @throws {Error} With Vietnamese message on failure
 */
export async function listInventory(outletId) {
  const { data, error } = await cachedSupabase
    .from('inventory')
    .select('*, ingredients(name, unit)')
    .eq('outlet_id', outletId)
    .order('updated_at', { ascending: false });

  if (error) {
    throw new Error('Khong the tai du lieu ton kho: ' + error.message);
  }

  return data || [];
}

/**
 * Update the qty_on_hand for a specific inventory record.
 * The `trg_audit_inventory_change` trigger automatically logs the change
 * to audit_logs (no manual audit logging needed from the frontend).
 *
 * @param {string} id - The inventory record UUID
 * @param {number} newQty - New quantity on hand value
 * @returns {Promise<Object>} The updated inventory record
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateInventory(id, newQty) {
  const { data, error } = await supabase
    .from('inventory')
    .update({ qty_on_hand: newQty })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error('Khong the cap nhat ton kho: ' + error.message);
  }

  cachedSupabase.invalidate('inventory');
  return data;
}
