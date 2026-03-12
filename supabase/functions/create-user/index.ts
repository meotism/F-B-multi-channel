// Edge Function: User Creation (Owner Only)
// Allows Owners to create new users via Supabase Auth admin API.
// Creates the auth user, inserts into public.users, and logs the action.
//
// POST /functions/v1/create-user
// Body: { name: string, email: string, role: string, password: string }
// Returns: 201 with created user data

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCorsPreflightRequest } from '../_shared/cors.ts';
import { validateAuth, requireRole, AuthError } from '../_shared/auth.ts';
import type { UserProfile } from '../_shared/auth.ts';
import { jsonResponse, errorResponse } from '../_shared/response.ts';

/** Valid roles that can be assigned to new users (owner cannot be assigned) */
const ASSIGNABLE_ROLES = ['manager', 'staff', 'cashier', 'warehouse'];

/** Simple email validation regex */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    // Admin client: uses service_role key for admin operations
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

    // 6. Check caller has owner role
    requireRole(callerProfile as UserProfile, ['owner']);

    // 7. Parse and validate request body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Dữ liệu yêu cầu không hợp lệ', 400, 'INVALID_JSON');
    }

    const { name, email, role, password } = body as {
      name: string;
      email: string;
      role: string;
      password: string;
    };

    // 7a. Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return errorResponse('Tên không được để trống', 400, 'VALIDATION_ERROR');
    }
    if (name.trim().length > 255) {
      return errorResponse('Tên không được vượt quá 255 ký tự', 400, 'VALIDATION_ERROR');
    }

    // 7b. Validate email
    if (!email || typeof email !== 'string') {
      return errorResponse('Email không được để trống', 400, 'VALIDATION_ERROR');
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      return errorResponse('Email không hợp lệ', 400, 'VALIDATION_ERROR');
    }

    // 7c. Validate role (must be a valid assignable role, NOT owner)
    if (!role || typeof role !== 'string') {
      return errorResponse('Vai trò không được để trống', 400, 'VALIDATION_ERROR');
    }
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return errorResponse(
        `Vai trò không hợp lệ. Các vai trò cho phép: ${ASSIGNABLE_ROLES.join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }

    // 7d. Validate password
    if (!password || typeof password !== 'string') {
      return errorResponse('Mật khẩu không được để trống', 400, 'VALIDATION_ERROR');
    }
    if (password.length < 8) {
      return errorResponse('Mật khẩu phải có ít nhất 8 ký tự', 400, 'VALIDATION_ERROR');
    }

    // 8. Create auth user via Supabase Auth admin API
    const { data: newAuthUser, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
      email: email.trim(),
      password,
      email_confirm: true,
      app_metadata: { role },
    });

    if (createAuthError) {
      // Check for duplicate email
      if (
        createAuthError.message?.toLowerCase().includes('already') ||
        createAuthError.message?.toLowerCase().includes('duplicate') ||
        createAuthError.message?.toLowerCase().includes('exists')
      ) {
        return errorResponse(
          'Email này đã được sử dụng',
          409,
          'EMAIL_EXISTS',
        );
      }
      return errorResponse(
        `Không thể tạo tài khoản: ${createAuthError.message}`,
        500,
        'AUTH_CREATE_FAILED',
      );
    }

    if (!newAuthUser?.user) {
      return errorResponse(
        'Không thể tạo tài khoản xác thực',
        500,
        'AUTH_CREATE_FAILED',
      );
    }

    // 9. Insert into public.users with the auth user's ID and owner's outlet_id
    const { data: newUser, error: insertError } = await supabaseAdmin
      .from('users')
      .insert({
        id: newAuthUser.user.id,
        name: name.trim(),
        email: email.trim(),
        role,
        outlet_id: callerProfile.outlet_id,
      })
      .select()
      .single();

    if (insertError) {
      // Attempt to clean up the auth user if public.users insert fails
      await supabaseAdmin.auth.admin.deleteUser(newAuthUser.user.id);

      if (insertError.code === '23505') {
        return errorResponse('Email này đã được sử dụng', 409, 'EMAIL_EXISTS');
      }
      return errorResponse(
        `Không thể tạo người dùng: ${insertError.message}`,
        500,
        'USER_INSERT_FAILED',
      );
    }

    // 10. Create audit log entry
    await supabaseAdmin.from('audit_logs').insert({
      outlet_id: callerProfile.outlet_id,
      entity: 'users',
      entity_id: newAuthUser.user.id,
      action: 'user_created',
      user_id: authUser.id,
      details: {
        created_user_name: name.trim(),
        created_user_email: email.trim(),
        created_user_role: role,
      },
    });

    // 11. Return 201 with created user data
    return jsonResponse(
      {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        outlet_id: newUser.outlet_id,
        created_at: newUser.created_at,
      },
      201,
    );
  } catch (error) {
    // Handle known auth/role errors
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status, error.code);
    }

    // Handle unexpected errors
    console.error('create-user error:', error);
    return errorResponse(
      'Lỗi máy chủ nội bộ',
      500,
      'INTERNAL_ERROR',
    );
  }
});
