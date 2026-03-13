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
 * @param {Object} [options] - Optional parameters
 * @param {number} [options.discountAmount=0] - Total discount amount to distribute proportionally
 * @returns {Promise<Array>} Array of created bill objects
 */
export async function splitByItems(orderId, itemGroups, userId, outletId, options = {}) {
  const totalDiscount = options.discountAmount || 0;

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

  // Calculate order subtotal for proportional discount distribution
  const orderSubtotal = orderItems.reduce((sum, i) => sum + (i.price * i.qty), 0);

  // Create bills for each group
  const bills = [];
  let discountDistributed = 0;
  for (let gi = 0; gi < itemGroups.length; gi++) {
    const group = itemGroups[gi];
    const groupSubtotal = group.orderItemIds.reduce((sum, id) => {
      const item = itemMap.get(id);
      return sum + (item.price * item.qty);
    }, 0);

    // Distribute discount proportionally; last group gets remainder
    let groupDiscount = 0;
    if (totalDiscount > 0 && orderSubtotal > 0) {
      if (gi === itemGroups.length - 1) {
        groupDiscount = totalDiscount - discountDistributed;
      } else {
        groupDiscount = Math.round(totalDiscount * groupSubtotal / orderSubtotal);
        discountDistributed += groupDiscount;
      }
    }

    const groupTotal = Math.max(0, groupSubtotal - groupDiscount);

    const { data: bill, error: billError } = await supabase
      .from('bills')
      .insert({
        order_id: orderId,
        outlet_id: outletId,
        total: groupTotal,
        tax: 0,
        discount_amount: groupDiscount,
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

  // Update order status to finalized and get table_id for table reset
  const { data: updatedOrder } = await supabase
    .from('orders')
    .update({ status: 'finalized', ended_at: new Date().toISOString() })
    .eq('id', orderId)
    .select('table_id')
    .single();

  // Reset table status to 'empty' (same as finalize_bill stored procedure)
  if (updatedOrder?.table_id) {
    // Only reset if no other active/completed orders remain on this table
    const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', updatedOrder.table_id)
      .neq('id', orderId)
      .in('status', ['active', 'completed']);

    if (count === 0) {
      await supabase
        .from('tables')
        .update({ status: 'empty' })
        .eq('id', updatedOrder.table_id);
    }
  }

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
 * @param {Object} [options] - Optional parameters
 * @param {number} [options.discountAmount=0] - Total discount amount to distribute equally
 * @returns {Promise<Array>} Array of created bill objects
 */
export async function splitEqual(orderId, numWays, paymentMethod, userId, outletId, options = {}) {
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

  const totalDiscount = options.discountAmount || 0;
  const orderSubtotal = orderItems.reduce((sum, i) => sum + (i.price * i.qty), 0);
  const orderTotal = Math.max(0, orderSubtotal - totalDiscount);
  const perBill = Math.floor(orderTotal / numWays);
  const remainder = orderTotal - (perBill * numWays);
  const perDiscount = totalDiscount > 0 ? Math.floor(totalDiscount / numWays) : 0;
  const discountRemainder = totalDiscount - (perDiscount * numWays);

  // Create N bills
  const bills = [];
  for (let i = 0; i < numWays; i++) {
    // Add remainder to the first bill
    const billTotal = i === 0 ? perBill + remainder : perBill;
    const billDiscount = i === 0 ? perDiscount + discountRemainder : perDiscount;

    const { data: bill, error: billError } = await supabase
      .from('bills')
      .insert({
        order_id: orderId,
        outlet_id: outletId,
        total: billTotal,
        tax: 0,
        discount_amount: billDiscount,
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

  // Update order status and get table_id for table reset
  const { data: updatedOrder } = await supabase
    .from('orders')
    .update({ status: 'finalized', ended_at: new Date().toISOString() })
    .eq('id', orderId)
    .select('table_id')
    .single();

  // Reset table status to 'empty' (same as finalize_bill stored procedure)
  if (updatedOrder?.table_id) {
    const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', updatedOrder.table_id)
      .neq('id', orderId)
      .in('status', ['active', 'completed']);

    if (count === 0) {
      await supabase
        .from('tables')
        .update({ status: 'empty' })
        .eq('id', updatedOrder.table_id);
    }
  }

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
