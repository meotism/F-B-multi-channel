// Auth Service - Login, logout, session restore, token refresh
//
// Wraps Supabase Auth calls and enriches the auth user with profile data
// (role, outlet_id, name) from the `users` table.

import { supabase } from './supabase-client.js';
import { navigate } from '../utils/navigate.js';

/**
 * Sign in with email and password via Supabase Auth.
 * After successful authentication, fetches the user profile from the `users` table
 * to get role, outlet_id, and name.
 *
 * @param {string} email - User email address
 * @param {string} password - User password
 * @returns {Promise<{ user: Object, session: Object }>} Combined user profile and session
 * @throws {Error} With Vietnamese message on failure
 */
export async function signIn(email, password) {
  // Authenticate via Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError) {
    throw categorizeAuthError(authError);
  }

  const { user: authUser, session } = authData;

  // Fetch user profile (role, outlet_id, name) from the users table
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('id, name, email, role, outlet_id')
    .eq('id', authUser.id)
    .single();

  if (profileError) {
    throw new Error('Không thể tải thông tin người dùng. Vui lòng thử lại.');
  }

  // Return combined user object with session
  return {
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
      outlet_id: profile.outlet_id,
    },
    session,
  };
}

/**
 * Categorize a Supabase auth error into a user-friendly Vietnamese error.
 *
 * @param {Object} error - Supabase auth error object
 * @returns {Error} Error with Vietnamese message
 */
function categorizeAuthError(error) {
  const message = error.message || '';

  // Invalid credentials (wrong email or password)
  if (message.includes('Invalid login credentials')) {
    return new Error('Email hoặc mật khẩu không đúng');
  }

  // Network / connectivity errors
  if (message.includes('fetch') || message.includes('network') || message.includes('Failed to fetch')) {
    return new Error('Không thể kết nối. Vui lòng kiểm tra mạng.');
  }

  // Generic fallback
  return new Error('Đã có lỗi xảy ra. Vui lòng thử lại.');
}

/**
 * Sign out the current user via Supabase Auth.
 * Unsubscribes all Realtime channels, then navigates to the login page.
 *
 * @returns {Promise<void>}
 */
export async function signOut() {
  // Unsubscribe all Supabase Realtime channels before signing out
  supabase.removeAllChannels();

  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error('[AuthService] signOut error:', error.message);
  }

  navigate('/login');
}

/**
 * Restore an existing session from Supabase's local storage.
 * If a valid session exists, fetches the user profile from the `users` table
 * and returns the combined user object with the session.
 *
 * @returns {Promise<{ user: Object, session: Object } | null>} User + session, or null if no session
 */
export async function restoreSession() {
  const { data: { session }, error } = await supabase.auth.getSession();

  if (error || !session) {
    return null;
  }

  // Fetch user profile (role, outlet_id, name) from the users table
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('id, name, email, role, outlet_id')
    .eq('id', session.user.id)
    .single();

  if (profileError) {
    console.error('[AuthService] Failed to fetch profile during session restore:', profileError.message);
    return null;
  }

  return {
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
      outlet_id: profile.outlet_id,
    },
    session,
  };
}

/**
 * Set up a Supabase auth state change listener.
 * Handles SIGNED_OUT (redirect to login), TOKEN_REFRESHED (update session),
 * and SIGNED_IN events via the provided callbacks.
 *
 * @param {Object} callbacks
 * @param {Function} callbacks.onSignedOut - Called when the user signs out
 * @param {Function} callbacks.onTokenRefreshed - Called with the new session on token refresh
 * @param {Function} callbacks.onSignedIn - Called with the session on sign-in
 * @returns {{ data: { subscription: Object } }} Subscription object (call .unsubscribe() to clean up)
 */
export function setupAuthListener(callbacks) {
  return supabase.auth.onAuthStateChange((event, session) => {
    switch (event) {
      case 'SIGNED_OUT':
        callbacks.onSignedOut?.();
        break;
      case 'TOKEN_REFRESHED':
        callbacks.onTokenRefreshed?.(session);
        break;
      case 'SIGNED_IN':
        callbacks.onSignedIn?.(session);
        break;
    }
  });
}
