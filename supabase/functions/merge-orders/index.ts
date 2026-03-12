// Edge Function: Merge Orders
// Merges order_items from one or more source orders into a target order.
// Cancels source orders and resets their tables to "empty" if no other
// active orders remain. Uses a stored procedure with FOR UPDATE row-level
// locking (sorted by ID) to prevent deadlocks in concurrent scenarios.
//
// POST /functions/v1/merge-orders
// Body: { target_order_id: string, source_order_ids: string[] }
// Returns: 200 with merged order details
//
// Requirements: 5.2 AC-8 (merge orders)
// Design reference: Section 3.4.3

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCorsPreflightRequest } from '../_shared/cors.ts';
import { validateAuth, requireRole, AuthError } from '../_shared/auth.ts';
import type { UserProfile } from '../_shared/auth.ts';
import { jsonResponse, errorResponse } from '../_shared/response.ts';

/** UUID v4 validation regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles permitted to call this function */
const ALLOWED_ROLES = ['manager', 'cashier', 'owner'];

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

    // Admin client: uses service_role key for RPC call (bypasses RLS)
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

    // 6. Check caller has an allowed role (manager or cashier)
    requireRole(callerProfile as UserProfile, ALLOWED_ROLES);

    // 7. Parse and validate request body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Dữ liệu yêu cầu không hợp lệ', 400, 'INVALID_JSON');
    }

    const { target_order_id, source_order_ids } = body as {
      target_order_id: string;
      source_order_ids: string[];
    };

    // 7a. Validate target_order_id is a valid UUID
    if (!target_order_id || typeof target_order_id !== 'string' || !UUID_REGEX.test(target_order_id)) {
      return errorResponse(
        'target_order_id phải là UUID hợp lệ',
        400,
        'INVALID_REQUEST',
      );
    }

    // 7b. Validate source_order_ids is a non-empty array of valid UUIDs
    if (
      !source_order_ids ||
      !Array.isArray(source_order_ids) ||
      source_order_ids.length === 0
    ) {
      return errorResponse(
        'source_order_ids phải là mảng UUID không rỗng',
        400,
        'INVALID_REQUEST',
      );
    }

    for (const sourceId of source_order_ids) {
      if (!sourceId || typeof sourceId !== 'string' || !UUID_REGEX.test(sourceId)) {
        return errorResponse(
          'Tất cả source_order_ids phải là UUID hợp lệ',
          400,
          'INVALID_REQUEST',
        );
      }
    }

    // 7c. Validate target_order_id is not in source_order_ids
    if (source_order_ids.includes(target_order_id)) {
      return errorResponse(
        'Đơn hàng đích không được nằm trong danh sách nguồn',
        400,
        'INVALID_REQUEST',
      );
    }

    // 8. Call the stored procedure for atomic order merging.
    //    The procedure handles: order locking (sorted by ID for deadlock prevention),
    //    validation (existence, active status, same outlet), moving order_items,
    //    cancelling source orders, resetting source tables, counting items,
    //    and audit log creation -- all within a single transaction.
    const { data: result, error: rpcError } = await supabaseAdmin.rpc(
      'merge_orders',
      {
        p_target_order_id: target_order_id,
        p_source_order_ids: source_order_ids,
        p_user_id: authUser.id,
        p_outlet_id: callerProfile.outlet_id,
      },
    );

    // 9. Handle stored procedure errors
    if (rpcError) {
      const errorMessage = rpcError.message || '';

      // ORDER_NOT_FOUND: one or more orders do not exist or belong to another outlet
      if (errorMessage.includes('ORDER_NOT_FOUND')) {
        return errorResponse(
          'Không tìm thấy một hoặc nhiều đơn hàng',
          404,
          'ORDER_NOT_FOUND',
        );
      }

      // ORDER_NOT_ACTIVE: one or more orders are not in active status
      if (errorMessage.includes('ORDER_NOT_ACTIVE')) {
        return errorResponse(
          'Một hoặc nhiều đơn hàng không ở trạng thái hoạt động',
          409,
          'ORDER_NOT_ACTIVE',
        );
      }

      // OUTLET_MISMATCH: orders belong to different outlets
      if (errorMessage.includes('OUTLET_MISMATCH')) {
        return errorResponse(
          'Đơn hàng thuộc các chi nhánh khác nhau',
          409,
          'OUTLET_MISMATCH',
        );
      }

      // Unhandled database error
      console.error('merge-orders rpc error:', rpcError);
      return errorResponse(
        'Lỗi máy chủ nội bộ',
        500,
        'INTERNAL_ERROR',
      );
    }

    // 10. Return success with merged order details
    return jsonResponse({
      merged_order: {
        id: target_order_id,
        table_id: result?.table_id,
        total_items: result?.total_items ?? 0,
        source_orders_cancelled: result?.source_orders_cancelled || [],
        tables_reset: result?.tables_reset || [],
      },
    });
  } catch (error) {
    // Handle known auth/role errors from shared helpers
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status, error.code);
    }

    // Handle unexpected errors
    console.error('merge-orders error:', error);
    return errorResponse(
      'Lỗi máy chủ nội bộ',
      500,
      'INTERNAL_ERROR',
    );
  }
});
