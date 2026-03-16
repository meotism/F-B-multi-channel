// Discount Service - Discount CRUD and application
//
// Provides functions to manage discounts (create, list, update, delete)
// and apply/remove discounts to orders and order items.
// All operations use direct PostgREST via the Supabase client.
// RLS policies enforce outlet isolation and owner/manager write access.
//
// Requirements: 3.10
// Design reference: Section 3.10 (Discount System)

import { supabase } from './supabase-client.js';
import { cachedSupabase } from './cached-query.js';

// ============================================================
// Discount CRUD
// ============================================================

/**
 * List all active and currently valid discounts for an outlet.
 * Filters by is_active=true and validity window (valid_from <= now <= valid_to).
 *
 * @param {string} outletId - UUID of the outlet
 * @returns {Promise<Array>} Array of discount objects
 */
export async function listActiveDiscounts(outletId) {
  const now = new Date().toISOString();
  const { data, error } = await cachedSupabase
    .from('discounts')
    .select('*')
    .eq('outlet_id', outletId)
    .eq('is_active', true)
    .or(`valid_from.is.null,valid_from.lte.${now}`)
    .or(`valid_to.is.null,valid_to.gte.${now}`)
    .order('name');

  if (error) {
    throw new Error('Không thể tải danh sách khuyến mãi: ' + error.message);
  }
  return data || [];
}

/**
 * List all discounts for an outlet (including inactive).
 *
 * @param {string} outletId - UUID of the outlet
 * @returns {Promise<Array>} Array of discount objects
 */
export async function listAllDiscounts(outletId) {
  const { data, error } = await cachedSupabase
    .from('discounts')
    .select('*')
    .eq('outlet_id', outletId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error('Không thể tải danh sách khuyến mãi: ' + error.message);
  }
  return data || [];
}

/**
 * Create a new discount.
 *
 * @param {Object} data - Discount data
 * @param {string} data.outlet_id
 * @param {string} data.name
 * @param {string} data.type - 'percent' or 'fixed'
 * @param {number} data.value
 * @param {string} data.scope - 'order' or 'item'
 * @param {string|null} data.valid_from - ISO timestamp or null
 * @param {string|null} data.valid_to - ISO timestamp or null
 * @returns {Promise<Object>} Created discount
 */
export async function createDiscount(data) {
  const { data: discount, error } = await supabase
    .from('discounts')
    .insert(data)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể tạo khuyến mãi: ' + error.message);
  }
  cachedSupabase.invalidate('discounts');
  return discount;
}

/**
 * Update a discount.
 *
 * @param {string} id - Discount UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated discount
 */
export async function updateDiscount(id, updates) {
  const { data, error } = await supabase
    .from('discounts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật khuyến mãi: ' + error.message);
  }
  cachedSupabase.writeThrough('discounts', 'update', data);
  return data;
}

/**
 * Delete a discount.
 *
 * @param {string} id - Discount UUID
 */
export async function deleteDiscount(id) {
  const { error } = await supabase
    .from('discounts')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error('Không thể xóa khuyến mãi: ' + error.message);
  }
  cachedSupabase.invalidate('discounts');
}

// ============================================================
// Discount Application
// ============================================================

/**
 * Apply a discount to an order.
 *
 * @param {string} orderId - Order UUID
 * @param {string} discountId - Discount UUID
 * @returns {Promise<Object>} Updated order
 */
export async function applyToOrder(orderId, discountId) {
  const { data, error } = await supabase
    .from('orders')
    .update({ discount_id: discountId })
    .eq('id', orderId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể áp dụng khuyến mãi: ' + error.message);
  }
  cachedSupabase.writeThrough('orders', 'update', data);
  return data;
}

/**
 * Apply a discount to a specific order item.
 *
 * @param {string} orderItemId - Order item UUID
 * @param {string} discountId - Discount UUID
 * @returns {Promise<Object>} Updated order item
 */
export async function applyToItem(orderItemId, discountId) {
  const { data, error } = await supabase
    .from('order_items')
    .update({ discount_id: discountId })
    .eq('id', orderItemId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể áp dụng khuyến mãi cho món: ' + error.message);
  }
  cachedSupabase.writeThrough('order_items', 'update', data);
  return data;
}

/**
 * Remove discount from an order.
 *
 * @param {string} orderId - Order UUID
 * @returns {Promise<Object>} Updated order
 */
export async function removeFromOrder(orderId) {
  const { data, error } = await supabase
    .from('orders')
    .update({ discount_id: null })
    .eq('id', orderId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể xóa khuyến mãi: ' + error.message);
  }
  cachedSupabase.writeThrough('orders', 'update', data);
  return data;
}

// ============================================================
// Discount Calculation
// ============================================================

/**
 * Calculate the discount amount based on a subtotal and discount definition.
 *
 * @param {number} subtotal - Order or item subtotal
 * @param {Object} discount - Discount object with type and value
 * @param {string} discount.type - 'percent' or 'fixed'
 * @param {number} discount.value - Percent (1-100) or fixed VND amount
 * @returns {number} Discount amount (rounded, capped at subtotal)
 */
export function calculateDiscount(subtotal, discount) {
  if (!discount || !subtotal || subtotal <= 0) return 0;

  let amount;
  if (discount.type === 'percent') {
    amount = Math.round(subtotal * discount.value / 100);
  } else {
    amount = discount.value;
  }

  // Discount cannot exceed subtotal
  return Math.min(amount, subtotal);
}
