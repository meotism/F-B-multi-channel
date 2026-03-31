// Reservation Service - CRUD, status transitions, scheduled task enqueue/cancel
//
// Provides functions to create, load, modify, and manage table reservations.
// Handles enqueue-at pattern for auto-expiry via scheduled_tasks table.
// All operations use direct PostgREST via the Supabase client.
// RLS policies enforce outlet isolation and role-based access.

import { supabase } from './supabase-client.js';
import { assertOutlet } from '../utils/outlet-guard.js';
import { DEFAULT_RESERVATION_TIMEOUT_MINUTES, SCHEDULER_API_URL, SUPABASE_ANON_KEY, DEFAULT_PAGE_SIZE } from '../config.js';

// ============================================================
// QStash Scheduling Helper
// ============================================================

/**
 * Schedule a reservation expiry via Vercel + Upstash QStash.
 * Calls the /api/schedule-expiry endpoint which publishes a delayed
 * QStash message to /api/process-tasks at the exact expiry time.
 *
 * @param {string} reservationId - Reservation UUID
 * @param {string} scheduleFor - ISO datetime string for when to expire
 */
async function scheduleExpiry(reservationId, scheduleFor) {
  if (!SCHEDULER_API_URL) {
    console.warn('[reservation-service] SCHEDULER_API_URL not configured, skipping QStash schedule');
    return;
  }

  try {
    const resp = await fetch(`${SCHEDULER_API_URL}/api/schedule-expiry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ reservationId, scheduleFor }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[reservation-service] scheduleExpiry failed:', err);
    }
  } catch (err) {
    // Non-fatal: expiry will still work via process_due_tasks RPC if called manually
    console.error('[reservation-service] scheduleExpiry network error:', err);
  }
}

// ============================================================
// Load / Query
// ============================================================

/**
 * Load reservations for an outlet with optional filters and pagination.
 * Used by the /reservations list page for browsing across dates.
 *
 * @param {string} outletId - Outlet UUID
 * @param {Object} [filters] - Optional filters
 * @param {string} [filters.dateFrom] - ISO date string (inclusive)
 * @param {string} [filters.dateTo] - ISO date string (inclusive)
 * @param {string} [filters.status] - Filter by reservation_status
 * @param {string} [filters.tableId] - Filter by table UUID
 * @param {Object} [pagination] - Pagination options
 * @param {number} [pagination.pageSize=50] - Items per page
 * @param {number} [pagination.pageNumber=1] - Current page (1-based)
 * @returns {Promise<{data: Array, totalCount: number, pageSize: number, pageNumber: number, totalPages: number}>}
 */
export async function loadReservations(outletId, filters = {}, pagination = {}) {
  assertOutlet(outletId);

  const pageSize = pagination.pageSize || DEFAULT_PAGE_SIZE;
  const pageNumber = pagination.pageNumber || 1;
  const offset = (pageNumber - 1) * pageSize;

  let query = supabase
    .from('reservations')
    .select('*, tables(name, table_code)', { count: 'exact' })
    .eq('outlet_id', outletId)
    .order('reserved_at', { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (filters.dateFrom) {
    query = query.gte('reserved_at', filters.dateFrom + 'T00:00:00');
  }
  if (filters.dateTo) {
    query = query.lte('reserved_at', filters.dateTo + 'T23:59:59');
  }
  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.tableId) {
    query = query.eq('table_id', filters.tableId);
  }

  const { data, error, count } = await query;
  if (error) throw new Error('Không thể tải danh sách đặt hẹn: ' + error.message);

  return {
    data: data || [],
    totalCount: count || 0,
    pageSize,
    pageNumber,
    totalPages: Math.ceil((count || 0) / pageSize),
  };
}

/**
 * Load today's pending/active reservations for an outlet.
 * Used by the table map overlay to show reservation indicators.
 *
 * @param {string} outletId - Outlet UUID
 * @returns {Promise<Array>} Array of today's pending/active reservations
 */
export async function loadTodayReservations(outletId) {
  assertOutlet(outletId);

  // Get today's date range in Vietnam timezone
  const now = new Date();
  const vnFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = vnFormatter.format(now); // YYYY-MM-DD

  const { data, error } = await supabase
    .from('reservations')
    .select('*, tables(name, table_code)')
    .eq('outlet_id', outletId)
    .in('status', ['pending', 'active'])
    .gte('reserved_at', today + 'T00:00:00')
    .lte('reserved_at', today + 'T23:59:59')
    .order('reserved_at', { ascending: true });

  if (error) throw new Error('Không thể tải đặt hẹn hôm nay: ' + error.message);
  return data || [];
}

// ============================================================
// Create / Update
// ============================================================

/**
 * Get the reservation timeout in minutes for an outlet.
 * Reads from outlets.settings.reservation_timeout_minutes, falls back to config default.
 *
 * @param {string} outletId - Outlet UUID
 * @returns {Promise<number>} Timeout in minutes
 */
async function getReservationTimeout(outletId) {
  const { data } = await supabase
    .from('outlets')
    .select('settings')
    .eq('id', outletId)
    .single();

  return data?.settings?.reservation_timeout_minutes || DEFAULT_RESERVATION_TIMEOUT_MINUTES;
}

/**
 * Create a new reservation and enqueue its expiry task.
 *
 * @param {string} outletId - Outlet UUID
 * @param {Object} data - Reservation data
 * @param {string} data.table_id - Table UUID
 * @param {string} data.customer_name - Customer name
 * @param {string} [data.customer_phone] - Customer phone
 * @param {number} data.party_size - Number of guests
 * @param {string} data.reserved_at - ISO datetime string for arrival time
 * @param {string} [data.notes] - Notes
 * @param {string} userId - UUID of the user creating the reservation
 * @returns {Promise<Object>} Created reservation object
 */
export async function createReservation(outletId, data, userId) {
  assertOutlet(outletId);

  const { data: reservation, error } = await supabase
    .from('reservations')
    .insert({
      outlet_id: outletId,
      table_id: data.table_id,
      customer_name: data.customer_name,
      customer_phone: data.customer_phone || null,
      party_size: data.party_size,
      reserved_at: data.reserved_at,
      notes: data.notes || null,
      created_by: userId,
    })
    .select('*, tables(name, table_code)')
    .single();

  if (error) {
    // Unique index violation → double booking
    if (error.code === '23505') {
      throw new Error('Bàn này đã có đặt hẹn cho ngày đó. Vui lòng chọn bàn hoặc ngày khác.');
    }
    throw new Error('Không thể tạo đặt hẹn: ' + error.message);
  }

  // Enqueue expiry task at reserved_at + timeout
  const timeoutMinutes = await getReservationTimeout(outletId);
  const reservedAt = new Date(data.reserved_at);
  const scheduleFor = new Date(reservedAt.getTime() + timeoutMinutes * 60 * 1000);
  const scheduleForISO = scheduleFor.toISOString();

  // 1. Save task in DB (source of truth for process_due_tasks RPC)
  await supabase.rpc('enqueue_reservation_expiry', {
    p_reservation_id: reservation.id,
    p_outlet_id: outletId,
    p_schedule_for: scheduleForISO,
  });

  // 2. Schedule via QStash for precise timing (fire-and-forget)
  scheduleExpiry(reservation.id, scheduleForISO);

  return reservation;
}

/**
 * Update an existing reservation. If reserved_at changes,
 * cancels the old expiry task and enqueues a new one.
 *
 * @param {string} reservationId - Reservation UUID
 * @param {Object} updates - Fields to update
 * @param {string} outletId - Outlet UUID (for re-enqueue)
 * @returns {Promise<Object>} Updated reservation
 */
export async function updateReservation(reservationId, updates, outletId) {
  const timeChanged = !!updates.reserved_at;

  const { data: reservation, error } = await supabase
    .from('reservations')
    .update(updates)
    .eq('id', reservationId)
    .select('*, tables(name, table_code)')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error('Bàn này đã có đặt hẹn cho ngày đó. Vui lòng chọn bàn hoặc ngày khác.');
    }
    throw new Error('Không thể cập nhật đặt hẹn: ' + error.message);
  }

  // Re-enqueue expiry if time changed
  if (timeChanged && reservation.status === 'pending') {
    await supabase.rpc('cancel_scheduled_task', { p_reference_id: reservationId });

    const timeoutMinutes = await getReservationTimeout(outletId);
    const reservedAt = new Date(reservation.reserved_at);
    const scheduleFor = new Date(reservedAt.getTime() + timeoutMinutes * 60 * 1000);
    const scheduleForISO = scheduleFor.toISOString();

    await supabase.rpc('enqueue_reservation_expiry', {
      p_reservation_id: reservationId,
      p_outlet_id: outletId,
      p_schedule_for: scheduleForISO,
    });

    scheduleExpiry(reservationId, scheduleForISO);
  }

  return reservation;
}

// ============================================================
// Status Transitions
// ============================================================

/**
 * Confirm customer arrival: pending → active.
 * Cancels the scheduled expiry task.
 *
 * @param {string} reservationId - Reservation UUID
 * @returns {Promise<Object>} Updated reservation
 */
export async function confirmArrival(reservationId) {
  const { data, error } = await supabase
    .from('reservations')
    .update({ status: 'active' })
    .eq('id', reservationId)
    .eq('status', 'pending')
    .select('*, tables(name, table_code)')
    .single();

  if (error) {
    throw new Error('Không thể xác nhận. Đặt hẹn có thể đã hết hạn hoặc bị hủy.');
  }

  // Cancel the expiry task — no longer needed
  await supabase.rpc('cancel_scheduled_task', { p_reference_id: reservationId });

  return data;
}

/**
 * Cancel a reservation. Cancels the scheduled expiry task.
 *
 * @param {string} reservationId - Reservation UUID
 * @returns {Promise<Object>} Updated reservation
 */
export async function cancelReservation(reservationId) {
  const { data, error } = await supabase
    .from('reservations')
    .update({ status: 'cancelled' })
    .eq('id', reservationId)
    .in('status', ['pending', 'active'])
    .select()
    .single();

  if (error) throw new Error('Không thể hủy đặt hẹn: ' + error.message);

  await supabase.rpc('cancel_scheduled_task', { p_reference_id: reservationId });

  return data;
}

/**
 * Complete a reservation (when order flow begins from a reserved table).
 *
 * @param {string} reservationId - Reservation UUID
 * @returns {Promise<Object>} Updated reservation
 */
export async function completeReservation(reservationId) {
  const { data, error } = await supabase
    .from('reservations')
    .update({ status: 'completed' })
    .eq('id', reservationId)
    .eq('status', 'active')
    .select()
    .single();

  if (error) throw new Error('Không thể hoàn thành đặt hẹn: ' + error.message);
  return data;
}
