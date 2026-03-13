// Order Service - Orders CRUD, add/remove items, status transitions
//
// Provides functions to create, load, modify, and manage orders and order items.
// Handles table status transitions triggered by order actions (see design 4.3.6).
// All operations use direct PostgREST via the Supabase client.
// RLS policies enforce outlet isolation and role-based access.
//
// Requirements: 5.2 AC-1, 5.2 AC-2, 5.2 AC-3, 5.2 AC-4, 5.2 AC-5, 5.2 AC-6, 5.2 EC-5
// Design reference: Sections 4.3.3, 4.3.5, 4.3.6

import { supabase } from './supabase-client.js';
import { cachedSupabase } from './cached-query.js';
import { assertOutlet } from '../utils/outlet-guard.js';

// ============================================================
// Order CRUD
// ============================================================

/**
 * Create a new order for a table with the given cart items.
 *
 * Inserts an `orders` row (status = 'active', started_at = now), then inserts
 * `order_items` rows for each cart item with a price snapshot (EC-5: price at
 * order time, not a live reference to menu_items.price). Finally updates the
 * table status to 'serving'.
 *
 * @param {string} tableId - UUID of the table to create the order for
 * @param {string} outletId - UUID of the outlet
 * @param {string} userId - UUID of the user creating the order
 * @param {Array<{menuItemId: string, name: string, price: number, qty: number, note: string}>} cartItems - Items from the cart with price snapshots
 * @param {Object} [options] - Optional parameters
 * @param {number} [options.guestCount] - Number of guests at the table
 * @returns {Promise<{order: Object, items: Array}>} The created order and its items
 * @throws {Error} With Vietnamese message on failure
 */
export async function createOrder(tableId, outletId, userId, cartItems, options = {}) {
  assertOutlet(outletId);

  // 1. Insert the order row
  const insertData = {
    table_id: tableId,
    outlet_id: outletId,
    user_id: userId,
    status: 'active',
    started_at: new Date().toISOString(),
  };
  if (options.guestCount != null) {
    insertData.guest_count = options.guestCount;
  }

  let order, items;

  try {
    const { data: orderData, error: orderError } = await supabase
      .from('orders')
      .insert(insertData)
      .select()
      .single();

    if (orderError) {
      throw new Error('Không thể tạo đơn hàng: ' + orderError.message);
    }

    order = orderData;

    // 2. Insert order_items with price snapshot (EC-5)
    const itemRows = cartItems.map(item => ({
      order_id: order.id,
      menu_item_id: item.menuItemId,
      qty: item.qty,
      price: item.price,       // Snapshot: captures price at order time
      note: item.note || null,
    }));

    const { data: itemsData, error: itemsError } = await supabase
      .from('order_items')
      .insert(itemRows)
      .select('*, menu_items(name)');

    if (itemsError) {
      throw new Error('Không thể thêm món vào đơn hàng: ' + itemsError.message);
    }

    items = itemsData;

    // 3. Update table status to 'serving' (design 4.3.6: empty -> serving)
    // S3-26: Guard with .eq('status', 'empty') to prevent race conditions
    const { data: updatedTable, error: tableError } = await supabase
      .from('tables')
      .update({ status: 'serving' })
      .eq('id', tableId)
      .eq('status', 'empty')
      .select('id')
      .single();

    if (tableError || !updatedTable) {
      // Table was no longer empty — another user may have claimed it
      console.warn('[order-service] Table status guard: table not empty or update failed');
    }

    cachedSupabase.invalidate('orders');
    cachedSupabase.invalidate('order_items');
  } catch (err) {
    // Task 24.1: If offline, enqueue the operation for later
    if (!navigator.onLine) {
      const { offlineQueue } = await import('./offline-queue.js');
      offlineQueue.enqueue({
        type: 'create_order',
        tableId,
        outletId,
        userId,
        cartItems,
        guestCount: options?.guestCount,
      });
      console.info('[order-service] Offline: createOrder enqueued');
      // Return a placeholder so the UI can continue
      return {
        order: { id: 'offline-' + Date.now(), table_id: tableId, status: 'active', started_at: new Date().toISOString() },
        items: cartItems.map(item => ({
          id: 'offline-item-' + Date.now() + '-' + item.menuItemId,
          order_id: 'offline',
          menu_item_id: item.menuItemId,
          qty: item.qty,
          price: item.price,
          note: item.note || null,
          menu_items: { name: item.name },
        })),
      };
    }
    throw err;
  }

  return { order, items: items || [] };
}

/**
 * Load a single order by ID, with its order_items joined with menu_items name.
 *
 * @param {string} orderId - UUID of the order to load
 * @returns {Promise<Object>} The order object with nested order_items (each containing menu_items.name)
 * @throws {Error} With Vietnamese message on failure
 */
export async function loadOrder(orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*, menu_items(name))')
    .eq('id', orderId)
    .single();

  if (error) {
    throw new Error('Không thể tải đơn hàng: ' + error.message);
  }

  return data;
}

/**
 * Find the active or completed order for a specific table.
 * Returns the most recent order with status 'active' or 'completed'.
 * Used when a user taps a table with status 'serving' or 'awaiting_payment'
 * to display the existing order (design 4.3.5).
 *
 * @param {string} tableId - UUID of the table to find the order for
 * @returns {Promise<Object|null>} The order object with nested order_items, or null if no active order
 * @throws {Error} With Vietnamese message on failure
 */
export async function loadOrderByTable(tableId) {
  const { data, error } = await cachedSupabase
    .from('orders')
    .select('*, order_items(*, menu_items(name))')
    .eq('table_id', tableId)
    .in('status', ['active', 'completed'])
    .order('started_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    // PGRST116 = "JSON object requested, multiple (or no) rows returned"
    // This is expected when no active order exists for the table
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error('Không thể tải đơn hàng cho bàn: ' + error.message);
  }

  return data;
}

// ============================================================
// Order Items Modification
// ============================================================

/**
 * Add a new item to an existing active order.
 * The price is captured at insertion time (price snapshot, EC-5).
 *
 * @param {string} orderId - UUID of the order to add the item to
 * @param {{ id: string, name: string, price: number }} menuItem - Menu item object with at least id, name, and current price
 * @param {number} qty - Quantity to add
 * @param {string} [note] - Optional note for the item
 * @returns {Promise<Object>} The created order_item with joined menu_items(name)
 * @throws {Error} With Vietnamese message on failure
 */
export async function addItem(orderId, menuItem, qty, note) {
  const { data, error } = await supabase
    .from('order_items')
    .insert({
      order_id: orderId,
      menu_item_id: menuItem.id,
      qty,
      price: menuItem.price,  // Snapshot: captures price at order time
      note: note || null,
    })
    .select('*, menu_items(name)')
    .single();

  if (error) {
    throw new Error('Không thể thêm món vào đơn hàng: ' + error.message);
  }

  cachedSupabase.invalidate('order_items');
  return data;
}

/**
 * Update the quantity of an existing order item.
 * If newQty is <= 0, the item is deleted instead (same as removeItem).
 *
 * @param {string} orderItemId - UUID of the order_item to update
 * @param {number} newQty - New quantity value; item is deleted if <= 0
 * @returns {Promise<Object|null>} The updated order_item, or null if deleted
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateItemQty(orderItemId, newQty) {
  // Delete the item if quantity is zero or negative
  if (newQty <= 0) {
    await removeItem(orderItemId);
    return null;
  }

  try {
    const { data, error } = await supabase
      .from('order_items')
      .update({ qty: newQty })
      .eq('id', orderItemId)
      .select('*, menu_items(name)')
      .single();

    if (error) {
      throw new Error('Không thể cập nhật số lượng: ' + error.message);
    }

    cachedSupabase.invalidate('order_items');
    return data;
  } catch (err) {
    // Task 24.1: If offline, enqueue the operation for later
    if (!navigator.onLine) {
      const { offlineQueue } = await import('./offline-queue.js');
      offlineQueue.enqueue({
        type: 'update_item_qty',
        itemId: orderItemId,
        qty: newQty,
      });
      console.info('[order-service] Offline: updateItemQty enqueued');
      return { id: orderItemId, qty: newQty };
    }
    throw err;
  }
}

/**
 * Update the note of an existing order item.
 *
 * @param {string} orderItemId - UUID of the order_item to update
 * @param {string} note - New note text (empty string to clear)
 * @returns {Promise<Object>} The updated order_item
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateItemNote(orderItemId, note) {
  const { data, error } = await supabase
    .from('order_items')
    .update({ note: note || null })
    .eq('id', orderItemId)
    .select('*, menu_items(name)')
    .single();

  if (error) {
    throw new Error('Không thể cập nhật ghi chú: ' + error.message);
  }

  cachedSupabase.invalidate('order_items');
  return data;
}

/**
 * Remove an order item from an order.
 *
 * @param {string} orderItemId - UUID of the order_item to delete
 * @returns {Promise<void>}
 * @throws {Error} With Vietnamese message on failure
 */
export async function removeItem(orderItemId) {
  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('id', orderItemId);

  if (error) {
    throw new Error('Không thể xóa món khỏi đơn hàng: ' + error.message);
  }

  cachedSupabase.invalidate('order_items');
}

// ============================================================
// Order Status Transitions (design 4.3.6)
// ============================================================

/**
 * Request payment for an order.
 * Transitions: order status active -> completed, table status serving -> awaiting_payment.
 * After this, no item modifications are allowed until cancelPaymentRequest is called.
 *
 * @param {string} orderId - UUID of the order to request payment for
 * @returns {Promise<Object>} The updated order object
 * @throws {Error} With Vietnamese message on failure
 */
export async function requestPayment(orderId) {
  // 1. Update order status to 'completed'
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .update({ status: 'completed' })
    .eq('id', orderId)
    .select()
    .single();

  if (orderError) {
    throw new Error('Không thể yêu cầu thanh toán: ' + orderError.message);
  }

  // 2. Update table status to 'awaiting_payment'
  const { error: tableError } = await supabase
    .from('tables')
    .update({ status: 'awaiting_payment' })
    .eq('id', order.table_id);

  if (tableError) {
    throw new Error('Không thể cập nhật trạng thái bàn: ' + tableError.message);
  }

  cachedSupabase.invalidate('orders');
  return order;
}

/**
 * Cancel a payment request, reverting the order back to active.
 * Transitions: order status completed -> active, table status awaiting_payment -> serving.
 * This re-enables item modifications on the order (design 4.3.5).
 *
 * @param {string} orderId - UUID of the order to cancel the payment request for
 * @returns {Promise<Object>} The updated order object
 * @throws {Error} With Vietnamese message on failure
 */
export async function cancelPaymentRequest(orderId) {
  // 1. Revert order status to 'active'
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .update({ status: 'active' })
    .eq('id', orderId)
    .select()
    .single();

  if (orderError) {
    throw new Error('Không thể hủy yêu cầu thanh toán: ' + orderError.message);
  }

  // 2. Revert table status to 'serving'
  const { error: tableError } = await supabase
    .from('tables')
    .update({ status: 'serving' })
    .eq('id', order.table_id);

  if (tableError) {
    throw new Error('Không thể cập nhật trạng thái bàn: ' + tableError.message);
  }

  cachedSupabase.invalidate('orders');
  return order;
}

// ============================================================
// Order-level Fields
// ============================================================

/**
 * Update the order note.
 *
 * @param {string} orderId - UUID of the order
 * @param {string} note - Note text (empty string to clear)
 * @returns {Promise<Object>} Updated order
 */
export async function updateOrderNote(orderId, note) {
  const { data, error } = await supabase
    .from('orders')
    .update({ note: note || '' })
    .eq('id', orderId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật ghi chú đơn hàng: ' + error.message);
  }

  cachedSupabase.invalidate('orders');
  return data;
}

/**
 * Set the guest count for an order.
 *
 * @param {string} orderId - UUID of the order
 * @param {number} guestCount - Number of guests
 * @returns {Promise<Object>} Updated order
 */
export async function setGuestCount(orderId, guestCount) {
  const { data, error } = await supabase
    .from('orders')
    .update({ guest_count: guestCount })
    .eq('id', orderId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật số khách: ' + error.message);
  }

  cachedSupabase.invalidate('orders');
  return data;
}

// ============================================================
// Order Listing with Filters
// ============================================================

/**
 * List orders for an outlet with optional filters.
 *
 * @param {string} outletId - UUID of the outlet
 * @param {Object} [filters] - Optional filters
 * @param {string} [filters.status] - Filter by order status
 * @param {string} [filters.dateFrom] - ISO date string — orders started on or after
 * @param {string} [filters.dateTo] - ISO date string — orders started on or before
 * @param {string} [filters.tableId] - Filter by table UUID
 * @returns {Promise<Array>} Array of order objects with joined table name
 */
export async function listOrders(outletId, filters = {}) {
  let query = cachedSupabase
    .from('orders')
    .select('*, tables(name), order_items(price, qty)')
    .eq('outlet_id', outletId)
    .order('started_at', { ascending: false });

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.dateFrom) {
    query = query.gte('started_at', filters.dateFrom);
  }
  if (filters.dateTo) {
    query = query.lte('started_at', filters.dateTo);
  }
  if (filters.tableId) {
    query = query.eq('table_id', filters.tableId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error('Không thể tải danh sách đơn hàng: ' + error.message);
  }

  return data || [];
}

// ============================================================
// Conflict Detection
// ============================================================

/**
 * Load an order including updated_at for conflict detection.
 * Returns updated_at alongside all order data.
 *
 * @param {string} orderId - UUID of the order
 * @returns {Promise<Object>} Order with updated_at field
 */
export async function loadOrderWithVersion(orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, updated_at, order_items(*, menu_items(name))')
    .eq('id', orderId)
    .single();

  if (error) {
    throw new Error('Không thể tải đơn hàng: ' + error.message);
  }

  return data;
}

/**
 * Update an order with conflict detection.
 * Checks that updated_at hasn't changed since the order was loaded.
 *
 * @param {string} orderId - UUID of the order
 * @param {Object} updates - Fields to update
 * @param {string} expectedUpdatedAt - The updated_at value from when the order was loaded
 * @returns {Promise<Object>} Updated order
 * @throws {Error} 'ORDER_CONFLICT' if the order was modified by another user
 */
export async function updateOrderSafe(orderId, updates, expectedUpdatedAt) {
  const { data, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', orderId)
    .eq('updated_at', expectedUpdatedAt)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw new Error('ORDER_CONFLICT');
    }
    throw new Error('Không thể cập nhật đơn hàng: ' + error.message);
  }

  cachedSupabase.invalidate('orders');
  return data;
}

// ============================================================
// Duration Helpers (S3-21)
// ============================================================

/**
 * Calculate usage duration for an order.
 * Uses ended_at if available, otherwise calculates from now.
 * Prepares duration data for the finalize-bill flow (Sprint 4).
 *
 * @param {Object} order - Order object with started_at and optionally ended_at
 * @returns {{ durationSeconds: number, durationFormatted: string }}
 */
export function calculateOrderDuration(order) {
  if (!order?.started_at) {
    return { durationSeconds: 0, durationFormatted: '00:00:00' };
  }

  const start = new Date(order.started_at).getTime();
  const end = order.ended_at ? new Date(order.ended_at).getTime() : Date.now();
  const durationSeconds = Math.max(0, Math.floor((end - start) / 1000));

  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  const durationFormatted = [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');

  return { durationSeconds, durationFormatted };
}
