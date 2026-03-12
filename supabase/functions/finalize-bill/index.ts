// Edge Function: Bill Finalization
// Finalizes a completed order into a bill atomically by calling the
// finalize_bill PostgreSQL stored procedure. The procedure locks the order
// row, calculates totals, inserts the bill, updates order status to
// 'finalized', and creates an audit log entry — all within a single
// transaction.
//
// POST /functions/v1/finalize-bill
// Body: { order_id: string, payment_method: 'cash' | 'card' | 'transfer' }
// Returns: 200 with bill data (id, order_id, total, tax, payment_method, status, finalized_at)
//
// Requirements: 1 AC-1/2/3/4/5/6/7 (bill finalization)
//               5 AC-1 (audit logging)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCorsPreflightRequest } from '../_shared/cors.ts';
import { validateAuth, requireRole, AuthError } from '../_shared/auth.ts';
import type { UserProfile } from '../_shared/auth.ts';
import { jsonResponse, errorResponse } from '../_shared/response.ts';

/** UUID v4 validation regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Allowed payment method values */
const VALID_PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const;

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

    const { order_id, payment_method } = body as {
      order_id: string;
      payment_method: string;
    };

    // 7a. Validate order_id is a valid UUID
    if (!order_id || typeof order_id !== 'string' || !UUID_REGEX.test(order_id)) {
      return errorResponse(
        'order_id phải là UUID hợp lệ',
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7b. Validate payment_method is 'cash', 'card', or 'transfer'
    if (!payment_method || !VALID_PAYMENT_METHODS.includes(payment_method as typeof VALID_PAYMENT_METHODS[number])) {
      return errorResponse(
        "payment_method phải là 'cash', 'card' hoặc 'transfer'",
        400,
        'VALIDATION_ERROR',
      );
    }

    // 8. Verify the order exists and belongs to the caller's outlet
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .select('id, outlet_id, status')
      .eq('id', order_id)
      .single();

    if (orderError || !order) {
      return errorResponse(
        'Không tìm thấy đơn hàng',
        404,
        'ORDER_NOT_FOUND',
      );
    }

    if (order.outlet_id !== callerProfile.outlet_id) {
      return errorResponse(
        'Đơn hàng không thuộc chi nhánh của bạn',
        404,
        'ORDER_NOT_FOUND',
      );
    }

    // 9. Call the stored procedure for atomic bill finalization.
    //    The procedure handles: order locking (FOR UPDATE), status check,
    //    duplicate bill check, total calculation, bill insertion, order
    //    status update, and audit log creation -- all within a single
    //    transaction.
    const { data: result, error: rpcError } = await supabaseAdmin.rpc(
      'finalize_bill',
      {
        p_order_id: order_id,
        p_payment_method: payment_method,
        p_user_id: authUser.id,
        p_outlet_id: callerProfile.outlet_id,
      },
    );

    // 10. Handle stored procedure errors
    if (rpcError) {
      const errorMessage = rpcError.message || '';

      // ORDER_NOT_FOUND: order does not exist
      if (errorMessage.includes('ORDER_NOT_FOUND')) {
        return errorResponse(
          'Không tìm thấy đơn hàng',
          404,
          'ORDER_NOT_FOUND',
        );
      }

      // ORDER_NOT_COMPLETED: order status is not 'completed'
      if (errorMessage.includes('ORDER_NOT_COMPLETED')) {
        return errorResponse(
          'Đơn hàng chưa hoàn thành, không thể xuất hóa đơn',
          409,
          'ORDER_NOT_COMPLETED',
        );
      }

      // BILL_ALREADY_EXISTS: bill already created for this order
      if (errorMessage.includes('BILL_ALREADY_EXISTS')) {
        return errorResponse(
          'Hóa đơn đã được xuất cho đơn hàng này',
          409,
          'BILL_ALREADY_EXISTS',
        );
      }

      // Unhandled database error
      console.error('finalize-bill rpc error:', rpcError);
      return errorResponse(
        'Lỗi máy chủ nội bộ',
        500,
        'INTERNAL_ERROR',
      );
    }

    // 11. Return success with bill data
    return jsonResponse(result);
  } catch (error) {
    // Handle known auth/role errors from shared helpers
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status, error.code);
    }

    // Handle unexpected errors
    console.error('finalize-bill error:', error);
    return errorResponse(
      'Lỗi máy chủ nội bộ',
      500,
      'INTERNAL_ERROR',
    );
  }
});
