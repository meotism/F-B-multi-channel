// Auth Store - Alpine.store('auth'): user, session, ROLE_PERMISSIONS
//
// CANONICAL AUTH STORE -- Single source of truth for authentication and permissions.
// Feature modules reference this store via Alpine.store('auth').hasPermission('permission_key').
// Do NOT duplicate permission logic elsewhere.

import { signIn, signOut, restoreSession, setupAuthListener } from '../services/auth-service.js';
import {
  initRealtimeSubscriptions,
  unsubscribeAll as unsubscribeAllRealtime,
} from '../services/realtime-service.js';
import { navigate } from '../utils/navigate.js';

/**
 * Role-to-permissions map. Each role lists the permission keys it grants.
 * To check access, call hasPermission(key) which looks up the current user's role.
 */
const ROLE_PERMISSIONS = {
  owner: [
    'view_table_map', 'edit_table_map', 'create_order', 'finalize_bill',
    'print_bill', 'manage_menu', 'manage_categories', 'manage_inventory',
    'view_reports', 'manage_users', 'manage_settings',
    'view_orders', 'view_bills', 'view_menu', 'view_inventory',
    'transfer_order', 'merge_orders',
  ],
  manager: [
    'view_table_map', 'edit_table_map', 'create_order', 'finalize_bill',
    'manage_menu', 'manage_categories', 'manage_inventory', 'view_reports',
    'manage_settings', 'view_orders', 'view_bills', 'transfer_order', 'merge_orders',
  ],
  cashier: [
    'view_table_map', 'create_order', 'finalize_bill', 'print_bill',
    'manage_settings', 'view_orders', 'view_bills', 'transfer_order',
  ],
  staff: [
    'view_table_map', 'create_order', 'view_orders', 'transfer_order',
  ],
  warehouse: [
    'view_table_map', 'manage_inventory', 'view_inventory',
  ],
};

export function authStore() {
  return {
    user: null,           // { id, name, email, role, outlet_id }
    session: null,        // Supabase session object
    isAuthenticated: false,
    isLoading: true,

    // Role convenience getters
    get isOwner() { return this.user?.role === 'owner'; },
    get isManager() { return this.user?.role === 'manager'; },
    get isStaff() { return this.user?.role === 'staff'; },
    get isCashier() { return this.user?.role === 'cashier'; },
    get isWarehouse() { return this.user?.role === 'warehouse'; },

    /**
     * Canonical permission check. All UI guards and feature modules
     * MUST use this method instead of ad-hoc role checks.
     *
     * @param {string} permissionKey - One of the keys in ROLE_PERMISSIONS.
     * @returns {boolean}
     */
    hasPermission(permissionKey) {
      const role = this.user?.role;
      if (!role) return false;
      const perms = ROLE_PERMISSIONS[role];
      return perms ? perms.includes(permissionKey) : false;
    },

    // Convenience wrappers (delegates to hasPermission)
    canEditMap()          { return this.hasPermission('edit_table_map'); },
    canCreateOrder()      { return this.hasPermission('create_order'); },
    canFinalizeBill()     { return this.hasPermission('finalize_bill'); },
    canManageMenu()       { return this.hasPermission('manage_menu'); },
    canManageInventory()  { return this.hasPermission('manage_inventory'); },
    canViewReports()      { return this.hasPermission('view_reports'); },
    canManageUsers()      { return this.hasPermission('manage_users'); },

    /**
     * Initialize auth state by restoring session from Supabase's local storage.
     * If a valid session exists, updates user/session/isAuthenticated state and
     * triggers outlet + tableMap loading. Sets up an auth state change listener
     * to handle sign-out, token refresh, and session expiry events.
     */
    async init() {
      this.isLoading = true;

      try {
        const result = await restoreSession();

        if (result) {
          this.user = result.user;
          this.session = result.session;
          this.isAuthenticated = true;
        } else {
          this.user = null;
          this.session = null;
          this.isAuthenticated = false;
        }
      } catch (err) {
        console.error('[AuthStore] init failed:', err);
        this.user = null;
        this.session = null;
        this.isAuthenticated = false;
      } finally {
        this.isLoading = false;
      }

      // Set up auth state change listener for session lifecycle events
      setupAuthListener({
        onSignedOut: () => {
          // Clear all state and redirect to login
          this.user = null;
          this.session = null;
          this.isAuthenticated = false;
          navigate('/login');
        },
        onTokenRefreshed: (session) => {
          // Update session with refreshed tokens
          if (session) {
            this.session = session;
          } else {
            // Token refresh failed -- session has expired (8-hour limit)
            this.user = null;
            this.session = null;
            this.isAuthenticated = false;
            Alpine.store('ui').showToast(
              'Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.',
              'warning',
            );
            navigate('/login');
          }
        },
        onSignedIn: (session) => {
          // Update session on new sign-in (handled primarily by login() method,
          // but this covers external sign-in events such as tab sync)
          if (session) {
            this.session = session;
          }
        },
      });
    },

    /**
     * Login with email and password.
     * Calls the auth service, updates store state, and navigates to /tables on success.
     *
     * @param {string} email - User email address
     * @param {string} password - User password
     * @throws {Error} Re-throws auth service errors for the UI to handle
     */
    async login(email, password) {
      const result = await signIn(email, password);

      // Update store state
      this.user = result.user;
      this.session = result.session;
      this.isAuthenticated = true;

      // Load outlet and table data via the app bootstrap flow
      const outletId = this.user.outlet_id;
      if (outletId) {
        await Promise.all([
          Alpine.store('outlet').loadOutlet(outletId),
          Alpine.store('tableMap').loadTables(outletId),
        ]);
        // Initialize centralized Realtime subscriptions for the logged-in outlet
        initRealtimeSubscriptions(outletId);
      }

      // Navigate to table map
      navigate('/tables');
    },

    /**
     * Logout the current user. Calls the auth service signOut() to invalidate
     * the Supabase session, unsubscribe Realtime channels, and navigate to login.
     * Resets all store state to defaults.
     */
    async logout() {
      this.user = null;
      this.session = null;
      this.isAuthenticated = false;

      // Clean up centralized realtime subscriptions before signing out
      unsubscribeAllRealtime();

      await signOut();
    },
  };
}
