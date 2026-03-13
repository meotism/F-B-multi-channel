// Split Bill Service - Split orders into multiple bills
//
// Provides functions to split a single order's bill into multiple
// bills, either by selecting specific items per bill or by dividing
// the total equally.
//
// Requirements: 3.4
// Design reference: Section 3.4 (Split Bill)

import { supabase } from './supabase-client.js';
import { cachedSupabase } from './cached-query.js';

/**
 * Split an order's bill by items — create one bill per group of items.
 *
 * @param {string} orderId - Order UUID
 * @param {Array<{orderItemIds: string[], paymentMethod: string}>} itemGroups - Groups of item IDs, each becoming a bill
 * @param {string} userId - UUID of the user performing the split
 * @param {string} outletId - UUID of the outlet
 * @returns {Promise<Array>} Array of created bill objects
 */
export async function splitByItems(orderId, itemGroups, userId, outletId) {
  // Fetch all order items to validate and calculate totals
  const { data: orderItems, error: itemsError } = await supabase
    .from('order_items')
    .select('id, price, qty')
    .eq('order_id', orderId);

  if (itemsError) {
    throw new Error('Không thể tải danh sách món: ' + itemsError.message);
  }

  const itemMap = new Map(orderItems.map(i => [i.id, i]));

  // Validate all item IDs belong to this order
  for (const group of itemGroups) {
    for (const itemId of group.orderItemIds) {
      if (!itemMap.has(itemId)) {
        throw new Error('Món không thuộc đơn hàng này: ' + itemId);
      }
    }
  }

  // Validate all items are covered (no orphans)
  const allGroupedIds = new Set(itemGroups.flatMap(g => g.orderItemIds));
  const allItemIds = new Set(orderItems.map(i => i.id));
  for (const id of allItemIds) {
    if (!allGroupedIds.has(id)) {
      throw new Error('Tất cả món phải được phân vào nhóm thanh toán');
    }
  }

  // Create bills for each group
  const bills = [];
  for (const group of itemGroups) {
    const groupTotal = group.orderItemIds.reduce((sum, id) => {
      const item = itemMap.get(id);
      return sum + (item.price * item.qty);
    }, 0);

    const { data: bill, error: billError } = await supabase
      .from('bills')
      .insert({
        order_id: orderId,
        outlet_id: outletId,
        total: groupTotal,
        tax: 0,
        discount_amount: 0,
        payment_method: group.paymentMethod || 'cash',
        status: 'finalized',
        split_type: 'by_item',
        finalized_at: new Date().toISOString()
      })
      .select()
      .single();

    if (billError) {
      throw new Error('Không thể tạo hóa đơn tách: ' + billError.message);
    }
    bills.push(bill);
  }

  // Update order status to finalized
  await supabase
    .from('orders')
    .update({ status: 'finalized', ended_at: new Date().toISOString() })
    .eq('id', orderId);

  // Audit log
  await supabase
    .from('audit_logs')
    .insert({
      outlet_id: outletId,
      entity: 'bill',
      entity_id: bills[0]?.id,
      action: 'split_bill_by_items',
      user_id: userId,
      details: {
        order_id: orderId,
        bill_count: bills.length,
        bill_ids: bills.map(b => b.id),
        totals: bills.map(b => b.total)
      }
    });

  cachedSupabase.invalidate('bills');
  cachedSupabase.invalidate('orders');

  return bills;
}

/**
 * Split an order's bill equally into N parts.
 *
 * @param {string} orderId - Order UUID
 * @param {number} numWays - Number of equal splits
 * @param {string} paymentMethod - Payment method for all splits
 * @param {string} userId - UUID of the user performing the split
 * @param {string} outletId - UUID of the outlet
 * @returns {Promise<Array>} Array of created bill objects
 */
export async function splitEqual(orderId, numWays, paymentMethod, userId, outletId) {
  if (numWays < 2) {
    throw new Error('Số lượng tách phải >= 2');
  }

  // Calculate total from order items
  const { data: orderItems, error: itemsError } = await supabase
    .from('order_items')
    .select('price, qty')
    .eq('order_id', orderId);

  if (itemsError) {
    throw new Error('Không thể tải danh sách món: ' + itemsError.message);
  }

  const orderTotal = orderItems.reduce((sum, i) => sum + (i.price * i.qty), 0);
  const perBill = Math.floor(orderTotal / numWays);
  const remainder = orderTotal - (perBill * numWays);

  // Create N bills
  const bills = [];
  for (let i = 0; i < numWays; i++) {
    // Add remainder to the first bill
    const billTotal = i === 0 ? perBill + remainder : perBill;

    const { data: bill, error: billError } = await supabase
      .from('bills')
      .insert({
        order_id: orderId,
        outlet_id: outletId,
        total: billTotal,
        tax: 0,
        discount_amount: 0,
        payment_method: paymentMethod,
        status: 'finalized',
        split_type: 'equal',
        finalized_at: new Date().toISOString()
      })
      .select()
      .single();

    if (billError) {
      throw new Error('Không thể tạo hóa đơn tách: ' + billError.message);
    }
    bills.push(bill);
  }

  // Update order status
  await supabase
    .from('orders')
    .update({ status: 'finalized', ended_at: new Date().toISOString() })
    .eq('id', orderId);

  // Audit log
  await supabase
    .from('audit_logs')
    .insert({
      outlet_id: outletId,
      entity: 'bill',
      entity_id: bills[0]?.id,
      action: 'split_bill_equal',
      user_id: userId,
      details: {
        order_id: orderId,
        num_ways: numWays,
        order_total: orderTotal,
        per_bill: perBill,
        remainder,
        bill_ids: bills.map(b => b.id)
      }
    });

  cachedSupabase.invalidate('bills');
  cachedSupabase.invalidate('orders');

  return bills;
}
