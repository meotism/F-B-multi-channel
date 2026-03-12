// Edge Function: Cancel Order with Inventory Restoration
// Atomically cancels an order, resets the table, and restores inventory
// in a single database transaction via the cancel_order() stored procedure.
//
// POST /functions/v1/cancel-order
// Body: { order_id: string, outlet_id: string, reason?: string }
// Returns: 200 with cancelled order details (order_id, table_id, table_reset,
//          restorations[], item_count)
//
// Requirements: 5.2 AC-10 (cancel order with inventory restoration)
// Design reference: Section 4.3.9 (cancel order flow)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCorsPreflightRequest } from '../_shared/cors.ts';
import { validateAuth, requireRole, AuthError } from '../_shared/auth.ts';
import type { UserProfile } from '../_shared/auth.ts';
import { jsonResponse, errorResponse } from '../_shared/response.ts';

/** UUID v4 validation regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles permitted to cancel orders */
const ALLOWED_ROLES = ['manager', 'cashier'];

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

    const { order_id, outlet_id, reason } = body as {
      order_id: string;
      outlet_id: string;
      reason?: string;
    };

    // 7a. Validate order_id is a valid UUID
    if (!order_id || typeof order_id !== 'string' || !UUID_REGEX.test(order_id)) {
      return errorResponse(
        'order_id phải là UUID hợp lệ',
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7b. Validate outlet_id is a valid UUID
    if (!outlet_id || typeof outlet_id !== 'string' || !UUID_REGEX.test(outlet_id)) {
      return errorResponse(
        'outlet_id phải là UUID hợp lệ',
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7c. Validate reason is a string if provided
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return errorResponse(
        'reason phải là chuỗi ký tự',
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7d. Verify the caller belongs to the requested outlet (security check)
    if (callerProfile.outlet_id !== outlet_id) {
      return errorResponse(
        'Bạn không có quyền thao tác trên chi nhánh này',
        403,
        'FORBIDDEN',
      );
    }

    // 8. Call the cancel_order stored procedure for atomic cancellation.
    //    The procedure handles: order validation, status update, table reset,
    //    inventory restoration, and audit log creation -- all within a single
    //    transaction.
    const { data: result, error: rpcError } = await supabaseAdmin.rpc(
      'cancel_order',
      {
        p_order_id: order_id,
        p_user_id: authUser.id,
        p_outlet_id: outlet_id,
        p_reason: reason || null,
      },
    );

    // 9. Handle stored procedure errors
    if (rpcError) {
      const errorMessage = rpcError.message || '';

      // ORDER_NOT_FOUND: order does not exist or belongs to another outlet
      if (errorMessage.includes('ORDER_NOT_FOUND')) {
        return errorResponse(
          'Không tìm thấy đơn hàng',
          404,
          'ORDER_NOT_FOUND',
        );
      }

      // ORDER_NOT_CANCELLABLE: order status is 'finalized' or 'cancelled'
      if (errorMessage.includes('ORDER_NOT_CANCELLABLE')) {
        return errorResponse(
          'Đơn hàng không thể hủy',
          409,
          'ORDER_NOT_CANCELLABLE',
        );
      }

      // Unhandled database error
      console.error('cancel-order rpc error:', rpcError);
      return errorResponse(
        'Lỗi máy chủ nội bộ',
        500,
        'INTERNAL_ERROR',
      );
    }

    // 10. Return success with cancellation details
    return jsonResponse({
      message: 'Đơn hàng đã được hủy thành công',
      order_id: result?.order_id,
      table_id: result?.table_id,
      table_reset: result?.table_reset,
      restorations: result?.restorations || [],
      item_count: result?.item_count || 0,
    });
  } catch (error) {
    // Handle known auth/role errors from shared helpers
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status, error.code);
    }

    // Handle unexpected errors
    console.error('cancel-order error:', error);
    return errorResponse(
      'Lỗi máy chủ nội bộ',
      500,
      'INTERNAL_ERROR',
    );
  }
});
