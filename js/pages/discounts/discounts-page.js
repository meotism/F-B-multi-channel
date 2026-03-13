// Discounts Page - CRUD management for discount definitions
//
// Alpine.js component for managing discounts (create, edit, delete, toggle).
// Requirements: 3.10

import {
  listAllDiscounts,
  createDiscount,
  updateDiscount,
  deleteDiscount,
} from '../../services/discount-service.js';

/**
 * Alpine component factory for the discounts page.
 * Used as x-data="discountsPage()" in pages/discounts.html.
 */
export function discountsPage() {
  return {
    discounts: [],
    isLoading: false,
    showModal: false,
    editingDiscount: null,
    isSaving: false,
    form: {
      name: '',
      type: 'percent',
      value: 0,
      scope: 'order',
      valid_from: '',
      valid_to: '',
      is_active: true,
    },

    async init() {
      await this.loadDiscounts();
    },

    async loadDiscounts() {
      this.isLoading = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        this.discounts = await listAllDiscounts(outletId);
      } catch (err) {
        Alpine.store('ui').showToast(err.message, 'error');
      } finally {
        this.isLoading = false;
      }
    },

    formatVND(amount) {
      return new Intl.NumberFormat('vi-VN').format(amount) + ' đ';
    },

    openCreateModal() {
      this.editingDiscount = null;
      this.form = {
        name: '',
        type: 'percent',
        value: 0,
        scope: 'order',
        valid_from: '',
        valid_to: '',
        is_active: true,
      };
      this.showModal = true;
    },

    openEditModal(discount) {
      this.editingDiscount = discount;
      this.form = {
        name: discount.name,
        type: discount.type,
        value: discount.value,
        scope: discount.scope,
        valid_from: discount.valid_from ? discount.valid_from.slice(0, 16) : '',
        valid_to: discount.valid_to ? discount.valid_to.slice(0, 16) : '',
        is_active: discount.is_active,
      };
      this.showModal = true;
    },

    closeModal() {
      this.showModal = false;
      this.editingDiscount = null;
    },

    async saveDiscount() {
      this.isSaving = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        const payload = {
          ...this.form,
          outlet_id: outletId,
          valid_from: this.form.valid_from || null,
          valid_to: this.form.valid_to || null,
        };

        if (this.editingDiscount) {
          await updateDiscount(this.editingDiscount.id, payload);
          Alpine.store('ui').showToast('Đã cập nhật khuyến mãi', 'success');
        } else {
          await createDiscount(payload);
          Alpine.store('ui').showToast('Đã tạo khuyến mãi', 'success');
        }

        this.closeModal();
        await this.loadDiscounts();
      } catch (err) {
        Alpine.store('ui').showToast(err.message, 'error');
      } finally {
        this.isSaving = false;
      }
    },

    confirmDelete(discount) {
      Alpine.store('ui').openConfirmDialog({
        title: 'Xóa khuyến mãi',
        message: `Bạn có chắc muốn xóa "${discount.name}"?`,
        danger: true,
        confirmLabel: 'Xóa',
        onConfirm: async () => {
          try {
            await deleteDiscount(discount.id);
            Alpine.store('ui').showToast('Đã xóa khuyến mãi', 'success');
            await this.loadDiscounts();
          } catch (err) {
            Alpine.store('ui').showToast(err.message, 'error');
          }
        },
      });
    },
  };
}

// Register globally for x-data reference
window.discountsPage = discountsPage;
