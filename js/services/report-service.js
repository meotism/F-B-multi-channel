// Report Service - Report queries (calls Edge Function or direct query)
//
// Provides functions to generate reports via the aggregate-reports Edge Function,
// aggregate revenue data client-side, and sort/filter top items.
// All operations use Supabase client (Functions).
//
// Requirements: 11 (Report Generation), 12 (Report Aggregation)
// Design reference: Section 16 (Report Service)

import { supabase } from './supabase-client.js';
import { cachedSupabase } from './cached-query.js';

/**
 * Generate a report by calling the aggregate-reports Edge Function.
 * The Edge Function executes revenue summary, top items, and breakdown
 * queries in parallel and returns the aggregated result.
 *
 * @param {string} from - Start date in YYYY-MM-DD format
 * @param {string} to - End date in YYYY-MM-DD format
 * @param {string} type - Report type: 'daily' | 'monthly' | 'yearly' | 'custom'
 * @param {string|null} [categoryId=null] - Optional category UUID filter
 * @param {number} [topN=10] - Number of top items to return (max 50)
 * @returns {Promise<Object>} Report data with summary, top_items_by_qty, top_items_by_revenue, breakdown
 * @throws {Error} With Vietnamese message on failure
 */
export async function generateReport(from, to, type, categoryId = null, topN = 10) {
  const { data, error } = await cachedSupabase.functions.invoke('aggregate-reports', {
    body: { from, to, type, category_id: categoryId, top_n: topN },
    cache: { ttl: 120000 },
  });

  if (error) {
    let msg = error.message;
    try {
      const errBody = await error.context?.json?.();
      if (errBody?.error?.message) msg = errBody.error.message;
    } catch { /* ignore parse errors */ }
    throw new Error(msg);
  }

  // The Edge Function may return an error in the response body
  if (data?.error) {
    throw new Error(data.error?.message || 'Lỗi tạo báo cáo');
  }

  return data;
}

/**
 * Client-side revenue aggregation helper.
 * Computes totals from an array of bill records.
 *
 * @param {Array<Object>} bills - Array of bill objects with { total, tax }
 * @returns {{ totalRevenue: number, totalTax: number, billCount: number, averageBillValue: number }}
 */
export function aggregateRevenue(bills) {
  if (!bills || !bills.length) {
    return { totalRevenue: 0, totalTax: 0, billCount: 0, averageBillValue: 0 };
  }

  const totalRevenue = bills.reduce((sum, b) => sum + (b.total || 0), 0);
  const totalTax = bills.reduce((sum, b) => sum + (b.tax || 0), 0);

  return {
    totalRevenue,
    totalTax,
    billCount: bills.length,
    averageBillValue: Math.round(totalRevenue / bills.length),
  };
}

/**
 * Client-side helper to sort and limit top items.
 * Returns a new array sorted by the given field in descending order.
 *
 * @param {Array<Object>} items - Array of item objects
 * @param {string} [sortBy='total_qty'] - Field to sort by ('total_qty' or 'total_revenue')
 * @param {number} [limit=10] - Maximum number of items to return
 * @returns {Array<Object>} Sorted and limited array
 */
export function getTopItems(items, sortBy = 'total_qty', limit = 10) {
  return [...items]
    .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Stored-procedure report helpers (RPC)
// ---------------------------------------------------------------------------

/**
 * Helper to call a Supabase RPC function with caching support.
 * Uses cachedSupabase.rpc() when available, otherwise falls back to supabase.rpc().
 *
 * @param {string} fnName - Stored procedure name
 * @param {Object} params - RPC parameters
 * @returns {Promise<{data: *, error: *}>}
 * @private
 */
async function _cachedRpc(fnName, params) {
  if (typeof cachedSupabase.rpc === 'function') {
    return cachedSupabase.rpc(fnName, params);
  }
  return supabase.rpc(fnName, params);
}

/**
 * Get revenue breakdown by payment method for a given outlet and date range.
 * Calls the `get_revenue_by_payment_method` stored procedure.
 *
 * @param {string} outletId - Outlet UUID
 * @param {string} from - Start date in YYYY-MM-DD format
 * @param {string} to - End date in YYYY-MM-DD format
 * @returns {Promise<Array<Object>>} Revenue rows grouped by payment method
 * @throws {Error} With Vietnamese message on failure
 */
export async function getRevenueByPaymentMethod(outletId, from, to) {
  const { data, error } = await _cachedRpc('get_revenue_by_payment_method', {
    p_outlet_id: outletId,
    p_from: from,
    p_to: to,
  });

  if (error) {
    throw new Error('Không thể tải báo cáo: ' + error.message);
  }

  return data;
}

/**
 * Get revenue breakdown by category for a given outlet and date range.
 * Calls the `get_revenue_by_category` stored procedure.
 *
 * @param {string} outletId - Outlet UUID
 * @param {string} from - Start date in YYYY-MM-DD format
 * @param {string} to - End date in YYYY-MM-DD format
 * @returns {Promise<Array<Object>>} Revenue rows grouped by category
 * @throws {Error} With Vietnamese message on failure
 */
export async function getRevenueByCategory(outletId, from, to) {
  const { data, error } = await _cachedRpc('get_revenue_by_category', {
    p_outlet_id: outletId,
    p_from: from,
    p_to: to,
  });

  if (error) {
    throw new Error('Không thể tải báo cáo: ' + error.message);
  }

  return data;
}

/**
 * Get peak hours analysis for a given outlet and date range.
 * Calls the `get_peak_hours` stored procedure.
 *
 * @param {string} outletId - Outlet UUID
 * @param {string} from - Start date in YYYY-MM-DD format
 * @param {string} to - End date in YYYY-MM-DD format
 * @returns {Promise<Array<Object>>} Peak hour aggregation rows
 * @throws {Error} With Vietnamese message on failure
 */
export async function getPeakHours(outletId, from, to) {
  const { data, error } = await _cachedRpc('get_peak_hours', {
    p_outlet_id: outletId,
    p_from: from,
    p_to: to,
  });

  if (error) {
    throw new Error('Không thể tải báo cáo: ' + error.message);
  }

  return data;
}

/**
 * Get revenue split by source (items vs hourly) for a given outlet and date range.
 * Calls the `get_revenue_by_source` stored procedure.
 *
 * @param {string} outletId - Outlet UUID
 * @param {string} from - Start date (UTC ISO string)
 * @param {string} to - End date (UTC ISO string)
 * @returns {Promise<Object>} { items_revenue, hourly_revenue, total_revenue, hourly_bill_count, total_bill_count }
 * @throws {Error} With Vietnamese message on failure
 */
export async function getRevenueBySource(outletId, from, to) {
  const { data, error } = await _cachedRpc('get_revenue_by_source', {
    p_outlet_id: outletId,
    p_from: from,
    p_to: to,
  });

  if (error) {
    throw new Error('Không thể tải báo cáo: ' + error.message);
  }

  // RPC returns array with single row
  return Array.isArray(data) && data.length > 0
    ? data[0]
    : { items_revenue: 0, hourly_revenue: 0, total_revenue: 0, hourly_bill_count: 0, total_bill_count: 0 };
}
