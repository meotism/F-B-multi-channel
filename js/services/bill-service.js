// Bill Service - Bill finalization (calls Edge Function), status updates
//
// Provides functions to finalize bills via the finalize-bill Edge Function,
// manage bill status transitions through a defined state machine, and
// query bill records. All operations use Supabase client (PostgREST + Functions).
//
// Requirements: 1 (Bill Finalization), 2 (Bill Status State Machine)
// Design reference: Sections 1, 2 (Bill Service, Edge Function)

import { supabase } from './supabase-client.js';
import { cachedSupabase } from './cached-query.js';
import { assertOutlet } from '../utils/outlet-guard.js';

// ============================================================
// Bill Status State Machine
// ============================================================

/**
 * Allowed bill status transitions.
 * - finalized → printed (print success) or pending_print (print failure)
 * - pending_print → printed (retry success) or pending_print (retry failure)
 * - printed → (terminal, no transitions allowed)
 */
export const BILL_TRANSITIONS = {
  finalized: ['printed', 'pending_print'],
  pending_print: ['printed', 'pending_print'],
  printed: [], // terminal state
};

/**
 * Check if a bill status transition is allowed.
 *
 * @param {string} currentStatus - Current bill status
 * @param {string} nextStatus - Desired next status
 * @returns {boolean} True if the transition is allowed
 */
export function canTransition(currentStatus, nextStatus) {
  const allowed = BILL_TRANSITIONS[currentStatus];
  if (!allowed) return false;
  return allowed.includes(nextStatus);
}

// ============================================================
// Bill Service
// ============================================================

/**
 * Finalize a bill by calling the finalize-bill Edge Function.
 * The Edge Function atomically creates the bill record, locks the order,
 * and writes an audit log entry.
 *
 * @param {string} orderId - UUID of the completed order
 * @param {string} paymentMethod - 'cash' | 'card' | 'transfer'
 * @param {number} [discountAmount] - Optional discount amount to apply
 * @param {number} [hourlyCharge] - Optional pre-calculated hourly charge in VND
 * @param {number} [durationSeconds] - Optional pre-calculated duration in seconds
 * @returns {Promise<Object>} Created bill record with id, total, status, etc.
 * @throws {Error} With Vietnamese message on failure (403, 404, 409, 500)
 */
export async function finalizeBill(orderId, paymentMethod, discountAmount, hourlyCharge, durationSeconds) {
  const body = { order_id: orderId, payment_method: paymentMethod };
  if (discountAmount != null) {
    body.discount_amount = discountAmount;
  }
  if (hourlyCharge != null) {
    body.hourly_charge = hourlyCharge;
  }
  if (durationSeconds != null) {
    body.duration_seconds = durationSeconds;
  }

  const { data, error } = await supabase.functions.invoke('finalize-bill', {
    body,
  });

  if (error) {
    // Edge Function errors come as FunctionsHttpError with context
    let message = error.message || 'Lỗi không xác định';
    try {
      const errBody = await error.context?.json?.();
      if (errBody?.error?.message) message = errBody.error.message;
    } catch { /* ignore parse errors */ }
    throw new Error(message);
  }

  // The Edge Function may return an error in the response body
  if (data?.error) {
    const errorMessages = {
      ORDER_NOT_FOUND: 'Không tìm thấy đơn hàng',
      ORDER_NOT_COMPLETED: 'Đơn hàng chưa hoàn thành',
      BILL_ALREADY_EXISTS: 'Hóa đơn đã được xuất trước đó',
      FORBIDDEN: 'Bạn không có quyền xuất hóa đơn',
      INVALID_DISCOUNT: 'Giảm giá không hợp lệ',
    };
    const code = data.error?.code || data.error;
    const msg = errorMessages[code] || data.error?.message || 'Lỗi xuất hóa đơn';
    throw new Error(msg);
  }

  return data;
}

/**
 * Update bill status via PostgREST.
 * Enforces the BILL_TRANSITIONS state machine before updating.
 *
 * @param {string} billId - UUID of the bill to update
 * @param {string} newStatus - 'printed' | 'pending_print'
 * @param {string} userId - UUID of the user performing the action
 * @returns {Promise<Object>} Updated bill record
 * @throws {Error} If transition is not allowed or update fails
 */
export async function updateBillStatus(billId, newStatus, userId) {
  // 1. Fetch current bill to validate transition
  const currentBill = await getBillById(billId);
  if (!currentBill) {
    throw new Error('Không tìm thấy hóa đơn');
  }

  // 2. Enforce outlet isolation
  assertOutlet(currentBill.outlet_id);

  // 3. Validate state machine transition
  if (!canTransition(currentBill.status, newStatus)) {
    throw new Error(
      `Không thể chuyển trạng thái từ "${currentBill.status}" sang "${newStatus}"`
    );
  }

  // 4. Build update payload
  const updateData = { status: newStatus, updated_at: new Date().toISOString() };
  if (newStatus === 'printed') {
    updateData.printed_at = new Date().toISOString();
  }

  // 5. Perform update
  const { data, error } = await supabase
    .from('bills')
    .update(updateData)
    .eq('id', billId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật trạng thái hóa đơn: ' + error.message);
  }

  cachedSupabase.writeThrough('bills', 'update', data);

  // 6. Create audit log entry
  const action = newStatus === 'printed' ? 'print' : 'print_failed';
  await supabase.from('audit_logs').insert({
    entity: 'bill',
    entity_id: billId,
    action,
    user_id: userId,
    details: {
      bill_id: billId,
      order_id: currentBill.order_id,
      previous_status: currentBill.status,
      new_status: newStatus,
    },
    outlet_id: currentBill.outlet_id,
  });

  return data;
}

/**
 * Fetch a bill by its associated order ID.
 *
 * @param {string} orderId - UUID of the order
 * @returns {Promise<Object|null>} Bill record or null if not found
 * @throws {Error} With Vietnamese message on unexpected failure
 */
export async function getBillByOrderId(orderId) {
  const { data, error } = await cachedSupabase
    .from('bills')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error('Không thể tải hóa đơn: ' + error.message);
  }

  return data;
}

/**
 * Fetch a bill by its ID.
 *
 * @param {string} billId - UUID of the bill
 * @returns {Promise<Object|null>} Bill record or null if not found
 * @throws {Error} With Vietnamese message on unexpected failure
 */
export async function getBillById(billId) {
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('id', billId)
    .maybeSingle();

  if (error) {
    throw new Error('Không thể tải hóa đơn: ' + error.message);
  }

  return data;
}

/**
 * Fetch all bills finalized today (UTC+7 timezone).
 * Returns bills with joined order and table data for display.
 *
 * @returns {Promise<Object[]>} Array of bill records with order/table info
 * @throws {Error} With Vietnamese message on unexpected failure
 */
export async function getTodayBills() {
  // Calculate today's start and end in UTC+7
  const now = new Date();
  const utc7Offset = 7 * 60 * 60 * 1000;
  const utc7Now = new Date(now.getTime() + utc7Offset);
  const todayStart = new Date(Date.UTC(
    utc7Now.getUTCFullYear(),
    utc7Now.getUTCMonth(),
    utc7Now.getUTCDate(),
    0, 0, 0, 0
  ));
  // Convert back to UTC for query
  const startUTC = new Date(todayStart.getTime() - utc7Offset).toISOString();
  const endUTC = new Date(todayStart.getTime() - utc7Offset + 24 * 60 * 60 * 1000).toISOString();

  // Get current outlet for filtering
  const outletId = Alpine.store('auth').user?.outlet_id;

  let query = cachedSupabase
    .from('bills')
    .select('*, orders(id, table_id, started_at, tables(name))')
    .gte('finalized_at', startUTC)
    .lt('finalized_at', endUTC)
    .order('finalized_at', { ascending: false });

  if (outletId) {
    query = query.eq('outlet_id', outletId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error('Không thể tải danh sách hóa đơn: ' + error.message);
  }

  return data || [];
}

/**
 * Fetch all bills for a given order (supports split bill scenarios).
 *
 * @param {string} orderId - UUID of the order
 * @returns {Promise<Object[]>} Array of bill records (may be empty)
 * @throws {Error} With Vietnamese message on unexpected failure
 */
export async function getBillsByOrderId(orderId) {
  const { data, error } = await cachedSupabase
    .from('bills')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error('Không thể tải danh sách hóa đơn: ' + error.message);
  }

  return data;
}
