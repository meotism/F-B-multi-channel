// Users Page - User list and create/edit modal x-data component
//
// Alpine.js component for the user management page (Owner only).
// Manages user list display, create/edit/delete modals, form validation,
// and CRUD operations via user-service.js.

import { listUsers, createUser, updateUser, deleteUser } from '../../services/user-service.js';
import { formatDate } from '../../utils/formatters.js';

/** Roles that can be assigned to new users (owner is excluded) */
const ASSIGNABLE_ROLES = ['manager', 'staff', 'cashier', 'warehouse'];

/** Vietnamese labels for each role */
const ROLE_LABELS = {
  owner: 'Chủ sở hữu',
  manager: 'Quản lý',
  staff: 'Nhân viên',
  cashier: 'Thu ngân',
  warehouse: 'Kho',
};

/** Simple email validation regex (matches server-side) */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Alpine component factory for the user management page.
 * Used as x-data="usersPage()" in pages/users.html.
 *
 * @returns {Object} Alpine component data object
 */
export function usersPage() {
  return {
    // User list state
    users: [],
    isLoading: true,

    // Create modal state
    showCreateModal: false,

    // Edit modal state
    showEditModal: false,
    editUser: null,

    // Delete modal state
    showDeleteModal: false,
    deleteUserTarget: null,

    // Shared form state (used by both create and edit modals)
    formName: '',
    formEmail: '',
    formRole: 'staff',
    formPassword: '',
    formError: '',
    isSaving: false,

    // Constants exposed to template
    assignableRoles: ASSIGNABLE_ROLES,
    roleLabels: ROLE_LABELS,

    /**
     * Initialize the component: load users on mount.
     */
    async init() {
      await this.loadUsers();
    },

    /**
     * Fetch all users for the current outlet and update the list.
     */
    async loadUsers() {
      this.isLoading = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) {
          throw new Error('Không tìm thấy thông tin cửa hàng');
        }
        this.users = await listUsers(outletId);
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể tải danh sách người dùng',
          'error',
        );
        this.users = [];
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Format a date string for display in the user table.
     * @param {string} dateStr - ISO date string
     * @returns {string} Formatted date
     */
    formatDate(dateStr) {
      return formatDate(dateStr, 'short');
    },

    /**
     * Get the Vietnamese label for a role.
     * @param {string} role - Role key
     * @returns {string} Vietnamese role label
     */
    getRoleLabel(role) {
      return ROLE_LABELS[role] || role;
    },

    /**
     * Get the badge CSS class for a role.
     * @param {string} role - Role key
     * @returns {string} CSS class for the badge
     */
    getRoleBadgeClass(role) {
      switch (role) {
        case 'owner':     return 'badge--danger';
        case 'manager':   return 'badge--success';
        case 'cashier':   return 'badge--warning';
        case 'warehouse': return 'badge--muted';
        case 'staff':
        default:          return 'badge--muted';
      }
    },

    // ---- Create Modal ----

    /**
     * Open the create user modal with empty form fields.
     */
    openCreateModal() {
      this.formName = '';
      this.formEmail = '';
      this.formRole = 'staff';
      this.formPassword = '';
      this.formError = '';
      this.showCreateModal = true;
    },

    /**
     * Close the create user modal.
     */
    closeCreateModal() {
      this.showCreateModal = false;
    },

    /**
     * Validate and submit the create user form.
     */
    async submitCreate() {
      // Client-side validation
      this.formError = '';

      if (!this.formName.trim()) {
        this.formError = 'Tên không được để trống';
        return;
      }
      if (this.formName.trim().length > 255) {
        this.formError = 'Tên không được vượt quá 255 ký tự';
        return;
      }
      if (!this.formEmail.trim()) {
        this.formError = 'Email không được để trống';
        return;
      }
      if (!EMAIL_REGEX.test(this.formEmail.trim())) {
        this.formError = 'Email không hợp lệ';
        return;
      }
      if (!this.formRole) {
        this.formError = 'Vui lòng chọn vai trò';
        return;
      }
      if (!this.formPassword) {
        this.formError = 'Mật khẩu không được để trống';
        return;
      }
      if (this.formPassword.length < 8) {
        this.formError = 'Mật khẩu phải có ít nhất 8 ký tự';
        return;
      }

      this.isSaving = true;

      try {
        await createUser({
          name: this.formName.trim(),
          email: this.formEmail.trim(),
          role: this.formRole,
          password: this.formPassword,
        });

        Alpine.store('ui').showToast('Tạo người dùng thành công', 'success');
        this.closeCreateModal();
        await this.loadUsers();
      } catch (err) {
        this.formError = err.message || 'Không thể tạo người dùng';
      } finally {
        this.isSaving = false;
      }
    },

    // ---- Edit Modal ----

    /**
     * Open the edit modal pre-filled with the selected user's data.
     * @param {Object} user - The user object to edit
     */
    openEditModal(user) {
      this.editUser = user;
      this.formName = user.name;
      this.formEmail = user.email;
      this.formRole = user.role;
      this.formPassword = '';
      this.formError = '';
      this.showEditModal = true;
    },

    /**
     * Close the edit user modal.
     */
    closeEditModal() {
      this.showEditModal = false;
      this.editUser = null;
    },

    /**
     * Validate and submit the edit user form.
     * Only name and role can be updated; email is read-only.
     */
    async submitEdit() {
      this.formError = '';

      if (!this.formName.trim()) {
        this.formError = 'Tên không được để trống';
        return;
      }
      if (this.formName.trim().length > 255) {
        this.formError = 'Tên không được vượt quá 255 ký tự';
        return;
      }
      if (!this.formRole) {
        this.formError = 'Vui lòng chọn vai trò';
        return;
      }

      this.isSaving = true;

      try {
        await updateUser(this.editUser.id, {
          name: this.formName.trim(),
          role: this.formRole,
        });

        Alpine.store('ui').showToast('Cập nhật người dùng thành công', 'success');
        this.closeEditModal();
        await this.loadUsers();
      } catch (err) {
        this.formError = err.message || 'Không thể cập nhật người dùng';
      } finally {
        this.isSaving = false;
      }
    },

    // ---- Delete Modal ----

    /**
     * Open the delete confirmation modal for a user.
     * Prevents self-deletion by checking against current user ID.
     * @param {Object} user - The user object to delete
     */
    confirmDelete(user) {
      const currentUserId = Alpine.store('auth').user?.id;
      if (user.id === currentUserId) {
        Alpine.store('ui').showToast('Bạn không thể xóa chính mình', 'error');
        return;
      }
      this.deleteUserTarget = user;
      this.showDeleteModal = true;
    },

    /**
     * Close the delete confirmation modal.
     */
    closeDeleteModal() {
      this.showDeleteModal = false;
      this.deleteUserTarget = null;
    },

    /**
     * Execute the user deletion after confirmation.
     */
    async submitDelete() {
      if (!this.deleteUserTarget) return;

      this.isSaving = true;

      try {
        await deleteUser(this.deleteUserTarget.id);
        Alpine.store('ui').showToast('Xóa người dùng thành công', 'success');
        this.closeDeleteModal();
        await this.loadUsers();
      } catch (err) {
        Alpine.store('ui').showToast(
          err.message || 'Không thể xóa người dùng',
          'error',
        );
        this.closeDeleteModal();
      } finally {
        this.isSaving = false;
      }
    },
  };
}

// Register as global function so x-data="usersPage()" works
// when the template is dynamically loaded by the router
window.usersPage = usersPage;
