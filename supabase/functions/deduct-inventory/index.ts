// Edge Function: Inventory Deduction / Restoration
// Atomically reduces or restores ingredient stock based on recipe formulas
// when an order is confirmed or cancelled. Uses a stored procedure with
// FOR UPDATE row-level locking to prevent negative inventory in concurrent
// scenarios.
//
// POST /functions/v1/deduct-inventory
// Body: { order_id: string, action: 'deduct' | 'restore' }
// Returns: 200 with deductions[] and low_stock_alerts[]
//
// Requirements: 5.6 AC-3/8 (inventory deduction on order, restore on cancel)
//               5.6 EC-1 (concurrent stock protection via FOR UPDATE locking)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCorsPreflightRequest } from '../_shared/cors.ts';
import { validateAuth, requireRole, AuthError } from '../_shared/auth.ts';
import type { UserProfile } from '../_shared/auth.ts';
import { jsonResponse, errorResponse } from '../_shared/response.ts';

/** UUID v4 validation regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Allowed action values */
const VALID_ACTIONS = ['deduct', 'restore'] as const;

/** Roles permitted to call this function */
const ALLOWED_ROLES = ['manager', 'staff', 'cashier', 'owner'];

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

    // 6. Check caller has an allowed role (manager, staff, or cashier)
    requireRole(callerProfile as UserProfile, ALLOWED_ROLES);

    // 7. Parse and validate request body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Dữ liệu yêu cầu không hợp lệ', 400, 'INVALID_JSON');
    }

    const { order_id, action } = body as {
      order_id: string;
      action: string;
    };

    // 7a. Validate order_id is a valid UUID
    if (!order_id || typeof order_id !== 'string' || !UUID_REGEX.test(order_id)) {
      return errorResponse(
        'order_id phải là UUID hợp lệ',
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7b. Validate action is 'deduct' or 'restore'
    if (!action || !VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
      return errorResponse(
        "action phải là 'deduct' hoặc 'restore'",
        400,
        'VALIDATION_ERROR',
      );
    }

    // 8. Call the stored procedure for atomic inventory deduction/restoration.
    //    The procedure handles: order validation, ingredient aggregation,
    //    FOR UPDATE locking, stock sufficiency check, inventory update,
    //    and audit log creation -- all within a single transaction.
    const { data: result, error: rpcError } = await supabaseAdmin.rpc(
      'deduct_inventory',
      {
        p_order_id: order_id,
        p_action: action,
        p_user_id: authUser.id,
        p_outlet_id: callerProfile.outlet_id,
      },
    );

    // 9. Handle stored procedure errors
    if (rpcError) {
      const errorMessage = rpcError.message || '';

      // ORDER_NOT_FOUND: order does not exist or belongs to another outlet
      if (errorMessage.includes('ORDER_NOT_FOUND')) {
        return errorResponse(
          'Không tìm thấy đơn hàng hoặc đơn hàng không thuộc chi nhánh của bạn',
          404,
          'ORDER_NOT_FOUND',
        );
      }

      // INSUFFICIENT_STOCK: deduction would result in negative inventory
      if (errorMessage.includes('INSUFFICIENT_STOCK')) {
        // Parse the details from the exception message.
        // The stored procedure encodes details as: INSUFFICIENT_STOCK:<json_array>
        let insufficientDetails: unknown[] = [];
        try {
          const detailsMatch = errorMessage.match(/INSUFFICIENT_STOCK:(.*)/);
          if (detailsMatch && detailsMatch[1]) {
            insufficientDetails = JSON.parse(detailsMatch[1]);
          }
        } catch {
          // If parsing fails, return without details
        }

        return errorResponse(
          'Không đủ tồn kho cho một số nguyên liệu',
          409,
          'INSUFFICIENT_STOCK',
          insufficientDetails.length > 0 ? insufficientDetails : undefined,
        );
      }

      // Unhandled database error
      console.error('deduct-inventory rpc error:', JSON.stringify({
        message: rpcError.message,
        details: rpcError.details,
        hint: rpcError.hint,
        code: rpcError.code,
      }));
      return errorResponse(
        'Lỗi máy chủ nội bộ',
        500,
        'INTERNAL_ERROR',
        rpcError.message,
      );
    }

    // 10. Return success with deductions and low-stock alerts
    return jsonResponse({
      deductions: result?.deductions || [],
      low_stock_alerts: result?.low_stock_alerts || [],
    });
  } catch (error) {
    // Handle known auth/role errors from shared helpers
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status, error.code);
    }

    // Handle unexpected errors
    console.error('deduct-inventory error:', JSON.stringify({
      message: (error as Error).message,
      stack: (error as Error).stack,
    }));
    return errorResponse(
      'Lỗi máy chủ nội bộ',
      500,
      'INTERNAL_ERROR',
      (error as Error).message,
    );
  }
});
