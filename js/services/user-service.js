// User Service - Users CRUD (Owner only)
//
// Provides functions to list, create, update, and delete users within an outlet.
// Create uses the Edge Function (requires service_role for auth.admin.createUser).
// Update and delete use direct PostgREST via the Supabase client.

import { supabase } from './supabase-client.js';
import { cachedSupabase } from './cached-query.js';

/**
 * List all users belonging to a specific outlet.
 * Orders by created_at ascending (oldest first).
 *
 * @param {string} outletId - The outlet UUID to filter users by
 * @returns {Promise<Array>} Array of user objects
 * @throws {Error} With Vietnamese message on failure
 */
export async function listUsers(outletId) {
  const { data, error } = await cachedSupabase
    .from('users')
    .select('id, name, email, role, outlet_id, is_active, last_login_at, created_at')
    .eq('outlet_id', outletId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error('Không thể tải danh sách người dùng: ' + error.message);
  }

  return data || [];
}

/**
 * Create a new user via the create-user Edge Function.
 * The Edge Function handles auth user creation and public.users insertion.
 *
 * @param {{ name: string, email: string, role: string, password: string }} userData
 * @returns {Promise<Object>} The created user object
 * @throws {Error} With Vietnamese message on failure
 */
export async function createUser(userData) {
  const { data, error } = await supabase.functions.invoke('create-user', {
    body: userData,
  });

  if (error) {
    throw new Error(error.message || 'Không thể tạo người dùng');
  }

  // Edge Function returns error in response body for validation/business errors
  if (data && data.error) {
    throw new Error(data.error.message || data.error || 'Không thể tạo người dùng');
  }

  cachedSupabase.invalidate('users');
  return data;
}

/**
 * Update an existing user's name and/or role via PostgREST.
 * Email cannot be changed (it is the auth identity).
 *
 * @param {string} id - The user UUID to update
 * @param {{ name?: string, role?: string }} updates - Fields to update
 * @returns {Promise<Object>} The updated user object
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateUser(id, updates) {
  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật người dùng: ' + error.message);
  }

  cachedSupabase.writeThrough('users', 'update', data);
  return data;
}

/**
 * Delete a user from the public.users table via PostgREST.
 * Note: This does not remove the auth user from Supabase Auth
 * (that would require service_role access via an Edge Function).
 *
 * @param {string} id - The user UUID to delete
 * @returns {Promise<void>}
 * @throws {Error} With Vietnamese message on failure
 */
export async function deleteUser(id) {
  const { error } = await supabase
    .from('users')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error('Không thể xóa người dùng: ' + error.message);
  }

  cachedSupabase.invalidate('users');
}

/**
 * Deactivate a user by setting is_active = false.
 *
 * @param {string} userId - The user UUID to deactivate
 * @returns {Promise<Object>} The updated user object
 * @throws {Error} With Vietnamese message on failure
 */
export async function deactivateUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .update({ is_active: false })
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể vô hiệu hóa người dùng: ' + error.message);
  }

  cachedSupabase.writeThrough('users', 'update', data);
  return data;
}

/**
 * Reactivate a user by setting is_active = true.
 *
 * @param {string} userId - The user UUID to reactivate
 * @returns {Promise<Object>} The updated user object
 * @throws {Error} With Vietnamese message on failure
 */
export async function reactivateUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .update({ is_active: true })
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể kích hoạt lại người dùng: ' + error.message);
  }

  cachedSupabase.writeThrough('users', 'update', data);
  return data;
}

/**
 * Reset a user's password via Supabase Auth admin API.
 * Requires service_role access (runs through the Supabase client with admin privileges).
 *
 * @param {string} userId - The auth user UUID
 * @param {string} newPassword - The new password to set
 * @returns {Promise<Object>} The updated auth user
 * @throws {Error} With Vietnamese message on failure
 */
export async function resetPassword(userId, newPassword) {
  const { data, error } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword,
  });

  if (error) {
    throw new Error('Không thể đặt lại mật khẩu: ' + error.message);
  }

  return data;
}

/**
 * Update the last_login_at timestamp for a user.
 *
 * @param {string} userId - The user UUID
 * @returns {Promise<void>}
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateLastLogin(userId) {
  const { error } = await supabase
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) {
    throw new Error('Không thể cập nhật thời gian đăng nhập: ' + error.message);
  }

  cachedSupabase.invalidate('users');
}
