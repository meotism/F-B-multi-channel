// Edge Function: Report Aggregation
// Generates comprehensive revenue and sales reports by executing parallel
// database queries: revenue summary, top items (by qty and revenue), and
// revenue breakdown (hourly or daily). Uses outlet timezone for correct
// date grouping.
//
// POST /functions/v1/aggregate-reports
// Body: { from: string, to: string, type: 'daily'|'monthly'|'yearly'|'custom',
//         category_id?: string, top_n?: number }
// Returns: 200 with { summary, top_items_by_qty, top_items_by_revenue, breakdown }
//
// Requirements: 11 AC-1/2/3/4/5/6 (report generation)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCorsPreflightRequest } from '../_shared/cors.ts';
import { validateAuth, requireRole, AuthError } from '../_shared/auth.ts';
import type { UserProfile } from '../_shared/auth.ts';
import { jsonResponse, errorResponse } from '../_shared/response.ts';

/** UUID v4 validation regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Convert a local date (YYYY-MM-DD) at midnight in the given IANA timezone
 * to a UTC ISO string.  Uses the Intl API available in Deno / V8.
 *
 * Example: localDateToUtc('2026-03-12', 'Asia/Ho_Chi_Minh')
 *        → '2026-03-11T17:00:00.000Z'  (midnight VN = 17:00 UTC day before)
 */
function localDateToUtc(dateStr: string, timezone: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));

  // Format the same instant in both UTC and target timezone
  // sv-SE locale produces "YYYY-MM-DD HH:mm:ss" which is easy to parse
  const utcStr = utcMidnight.toLocaleString('sv-SE', { timeZone: 'UTC' });
  const tzStr = utcMidnight.toLocaleString('sv-SE', { timeZone: timezone });

  // Parse back to compute offset (positive = east of UTC)
  const utcMs = Date.parse(utcStr.replace(' ', 'T') + 'Z');
  const tzMs = Date.parse(tzStr.replace(' ', 'T') + 'Z');
  const offsetMs = tzMs - utcMs;

  // Midnight local = UTC midnight − offset
  return new Date(utcMidnight.getTime() - offsetMs).toISOString();
}

/** Add one day to a YYYY-MM-DD string. */
function addOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().split('T')[0];
}

/** Allowed report type values */
const VALID_TYPES = ['daily', 'monthly', 'yearly', 'custom'] as const;

/** Roles permitted to call this function */
const ALLOWED_ROLES = ['owner', 'manager'];

/** Giới hạn khoảng thời gian tối đa (366 ngày, tính bằng milliseconds) */
const MAX_RANGE_DAYS = 366;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** Giá trị top_n tối đa cho phép */
const MAX_TOP_N = 50;

/** Giá trị top_n mặc định */
const DEFAULT_TOP_N = 10;

Deno.serve(async (req: Request) => {
  // 1. Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest();
  }

  try {
    // 2. Only accept POST requests
    if (req.method !== 'POST') {
      return errorResponse('Phương thức không được hỗ trợ', 405, 'METHOD_NOT_ALLOWED');
    }

    // 3. Create Supabase clients
    // User client: uses caller's JWT for identity verification
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
    );

    // Admin client: uses service_role key for queries (bypasses RLS)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 4. Validate JWT and get authenticated user
    const authUser = await validateAuth(req, supabaseUser);

    // 5. Get caller's profile (role and outlet_id) from public.users
    const { data: callerProfile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('id, role, outlet_id, name')
      .eq('id', authUser.id)
      .single();

    if (profileError || !callerProfile) {
      return errorResponse(
        'Không tìm thấy thông tin người dùng',
        401,
        'UNAUTHORIZED',
      );
    }

    // 6. Check caller has an allowed role (owner or manager)
    requireRole(callerProfile as UserProfile, ALLOWED_ROLES);

    // 7. Parse and validate request body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Dữ liệu yêu cầu không hợp lệ', 400, 'INVALID_JSON');
    }

    const { from, to, type, category_id, top_n } = body as {
      from: string;
      to: string;
      type: string;
      category_id?: string;
      top_n?: number;
    };

    // 7a. Validate required fields
    if (!from || typeof from !== 'string') {
      return errorResponse(
        'Trường "from" là bắt buộc và phải là chuỗi ngày ISO',
        400,
        'VALIDATION_ERROR',
      );
    }

    if (!to || typeof to !== 'string') {
      return errorResponse(
        'Trường "to" là bắt buộc và phải là chuỗi ngày ISO',
        400,
        'VALIDATION_ERROR',
      );
    }

    if (!type || !VALID_TYPES.includes(type as typeof VALID_TYPES[number])) {
      return errorResponse(
        "Trường \"type\" phải là 'daily', 'monthly', 'yearly' hoặc 'custom'",
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7b. Validate from and to are valid dates
    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (isNaN(fromDate.getTime())) {
      return errorResponse(
        'Giá trị "from" không phải ngày hợp lệ',
        400,
        'VALIDATION_ERROR',
      );
    }

    if (isNaN(toDate.getTime())) {
      return errorResponse(
        'Giá trị "to" không phải ngày hợp lệ',
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7c. Validate from <= to
    if (fromDate > toDate) {
      return errorResponse(
        'Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc',
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7d. Validate range does not exceed 366 days
    if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_MS) {
      return errorResponse(
        `Khoảng thời gian không được vượt quá ${MAX_RANGE_DAYS} ngày`,
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7e. Validate optional category_id (if provided, must be UUID)
    const categoryId: string | null = category_id ?? null;
    if (categoryId !== null && (typeof categoryId !== 'string' || !UUID_REGEX.test(categoryId))) {
      return errorResponse(
        'category_id phải là UUID hợp lệ',
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7f. Validate optional top_n (default 10, max 50)
    let topN = DEFAULT_TOP_N;
    if (top_n !== undefined && top_n !== null) {
      if (typeof top_n !== 'number' || !Number.isInteger(top_n) || top_n < 1) {
        return errorResponse(
          'top_n phải là số nguyên dương',
          400,
          'VALIDATION_ERROR',
        );
      }
      topN = Math.min(top_n, MAX_TOP_N);
    }

    // 8. Fetch outlet timezone
    const { data: outlet, error: outletError } = await supabaseAdmin
      .from('outlets')
      .select('timezone')
      .eq('id', callerProfile.outlet_id)
      .single();

    if (outletError || !outlet) {
      return errorResponse(
        'Không tìm thấy thông tin chi nhánh',
        404,
        'OUTLET_NOT_FOUND',
      );
    }

    // 9. Determine group_by based on report type
    // daily → nhóm theo giờ, monthly/yearly/custom → nhóm theo ngày
    const groupBy = type === 'daily' ? 'hour' : 'day';

    // 10. Convert local date range to UTC using outlet timezone.
    //     "from" is inclusive, "to" is inclusive → add 1 day for exclusive upper bound.
    const tz = outlet.timezone || 'Asia/Ho_Chi_Minh';
    const fromUtc = localDateToUtc(from, tz);
    const toUtc = localDateToUtc(addOneDay(to), tz);

    // 11. Execute 3 queries in parallel
    const outletId = callerProfile.outlet_id;

    const [summaryResult, topItemsResult, breakdownResult] = await Promise.all([
      // 11a. Revenue summary: tổng doanh thu, số hóa đơn, trung bình, tổng thuế
      supabaseAdmin
        .from('bills')
        .select('total, tax')
        .eq('outlet_id', outletId)
        .gte('finalized_at', fromUtc)
        .lt('finalized_at', toUtc)
        .in('status', ['finalized', 'printed']),

      // 11b. Top items by qty (RPC)
      supabaseAdmin.rpc('get_top_items', {
        p_outlet_id: outletId,
        p_from: fromUtc,
        p_to: toUtc,
        p_category_id: categoryId,
        p_limit: topN,
      }),

      // 11c. Revenue breakdown by hour or day (RPC)
      supabaseAdmin.rpc('get_revenue_breakdown', {
        p_outlet_id: outletId,
        p_from: fromUtc,
        p_to: toUtc,
        p_group_by: groupBy,
      }),
    ]);

    // 12. Handle query errors
    if (summaryResult.error) {
      console.error('aggregate-reports summary query error:', summaryResult.error);
      return errorResponse('Lỗi máy chủ nội bộ', 500, 'INTERNAL_ERROR');
    }

    if (topItemsResult.error) {
      console.error('aggregate-reports get_top_items rpc error:', topItemsResult.error);
      return errorResponse('Lỗi máy chủ nội bộ', 500, 'INTERNAL_ERROR');
    }

    if (breakdownResult.error) {
      console.error('aggregate-reports get_revenue_breakdown rpc error:', breakdownResult.error);
      return errorResponse('Lỗi máy chủ nội bộ', 500, 'INTERNAL_ERROR');
    }

    // 13. Aggregate revenue summary from bills data
    // Xử lý trường hợp không có dữ liệu — trả về giá trị 0 (không phải lỗi)
    const bills = summaryResult.data || [];
    const billCount = bills.length;
    const totalRevenue = bills.reduce((sum: number, b: { total: number }) => sum + (b.total || 0), 0);
    const totalTax = bills.reduce((sum: number, b: { tax: number }) => sum + (b.tax || 0), 0);
    const averageBillValue = billCount > 0 ? Math.round(totalRevenue / billCount) : 0;

    // 14. Build top_items_by_qty and top_items_by_revenue
    // get_top_items RPC trả về kết quả đã sắp xếp theo qty DESC
    const topItemsByQty = topItemsResult.data || [];

    // Sắp xếp lại theo total_revenue DESC cho danh sách theo doanh thu
    const topItemsByRevenue = [...topItemsByQty]
      .sort((a: { total_revenue: number }, b: { total_revenue: number }) =>
        (b.total_revenue || 0) - (a.total_revenue || 0)
      );

    // 15. Return structured response
    return jsonResponse({
      summary: {
        totalRevenue,
        billCount,
        averageBillValue,
        totalTax,
      },
      top_items_by_qty: topItemsByQty,
      top_items_by_revenue: topItemsByRevenue,
      breakdown: breakdownResult.data || [],
    });
  } catch (error) {
    // Handle known auth/role errors from shared helpers
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status, error.code);
    }

    // Handle unexpected errors
    console.error('aggregate-reports error:', error);
    return errorResponse(
      'Lỗi máy chủ nội bộ',
      500,
      'INTERNAL_ERROR',
    );
  }
});
