// Shared: JWT validation and role checking helper
// Validates Bearer tokens via Supabase Auth and enforces role-based access.

import { SupabaseClient, User } from 'https://esm.sh/@supabase/supabase-js@2';

/** User profile data from the public.users table */
export interface UserProfile {
  id: string;
  role: string;
  outlet_id: string;
  name: string;
}

/**
 * Extract and validate the Bearer token from the request.
 * Uses the provided Supabase client to verify the JWT via auth.getUser().
 *
 * @param req - The incoming HTTP request
 * @param supabaseClient - A Supabase client instance (typically with anon key + user's auth header)
 * @returns The authenticated Supabase Auth user
 * @throws Error with descriptive message if validation fails
 */
export async function validateAuth(
  req: Request,
  supabaseClient: SupabaseClient,
): Promise<User> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError('Thiếu token xác thực', 401, 'UNAUTHORIZED');
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseClient.auth.getUser(token);

  if (error || !user) {
    throw new AuthError('Token không hợp lệ hoặc đã hết hạn', 401, 'UNAUTHORIZED');
  }

  return user;
}

/**
 * Check if the user's role is in the allowed roles list.
 *
 * @param userProfile - The user profile containing the role field
 * @param allowedRoles - Array of roles that are permitted
 * @throws AuthError if the user's role is not in the allowed list
 */
export function requireRole(
  userProfile: UserProfile,
  allowedRoles: string[],
): void {
  if (!allowedRoles.includes(userProfile.role)) {
    throw new AuthError(
      `Bạn không có quyền thực hiện thao tác này. Yêu cầu vai trò: ${allowedRoles.join(', ')}`,
      403,
      'FORBIDDEN',
    );
  }
}

/**
 * Custom error class for authentication/authorization failures.
 * Carries HTTP status code and machine-readable error code.
 */
export class AuthError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}
