// Reservation Page - Reservation listing with filters, create/edit modal
//
// Alpine.js component for the /reservations page. Displays a filterable
// list of reservations for the current outlet. Supports filters by status,
// date range, and table. Desktop shows a data table; mobile shows card layout.
// Includes create/edit reservation modal and status transition actions.

import {
  loadReservations,
  createReservation,
  updateReservation,
  confirmArrival,
  cancelReservation,
} from '../../services/reservation-service.js';
import { formatVND } from '../../utils/formatters.js';
import { navigate } from '../../utils/navigate.js';
import { supabase } from '../../services/supabase-client.js';

/**
 * Alpine component factory for the reservation page.
 * Used as x-data="reservationPage()" in pages/reservations.html.
 *
 * @returns {Object} Alpine component data object
 */
export function reservationPage() {
  return {
    // --- Page state ---
    isLoading: true,
    reservations: [],

    // --- Filter state ---
    filterStatus: '',
    filterDateFrom: '',
    filterDateTo: '',
    filterTableId: '',

    // --- Available tables for filter dropdown and create form ---
    tables: [],

    // --- Create/Edit modal ---
    showModal: false,
    isEditing: false,
    isSaving: false,
    form: {
      id: null,
      table_id: '',
      customer_name: '',
      customer_phone: '',
      party_size: 2,
      reserved_at: '',
      notes: '',
    },
    formError: '',

    // --- Realtime channel ---
    _realtimeChannel: null,

    /**
     * Initialize the component: set default date filter to today,
     * load tables, load reservations, subscribe to realtime.
     */
    async init() {
      // Default filter: today
      const today = this.todayDateString();
      this.filterDateFrom = today;
      this.filterDateTo = today;

      this.tables = Alpine.store('tableMap').tables || [];

      await this.loadData();
      this.subscribeRealtime();
    },

    /**
     * Cleanup on page destroy.
     */
    destroy() {
      if (this._realtimeChannel) {
        supabase.removeChannel(this._realtimeChannel);
        this._realtimeChannel = null;
      }
    },

    /**
     * Get today's date string in YYYY-MM-DD format (Vietnam timezone).
     * @returns {string}
     */
    todayDateString() {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
    },

    /**
     * Load reservations using current filters.
     */
    async loadData() {
      this.isLoading = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        const filters = {};
        if (this.filterDateFrom) filters.dateFrom = this.filterDateFrom;
        if (this.filterDateTo) filters.dateTo = this.filterDateTo;
        if (this.filterStatus) filters.status = this.filterStatus;
        if (this.filterTableId) filters.tableId = this.filterTableId;

        this.reservations = await loadReservations(outletId, filters);
      } catch (err) {
        console.error('[ReservationPage] loadData failed:', err);
        Alpine.store('ui').showToast(err.message, 'error');
        this.reservations = [];
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Subscribe to realtime reservation changes for auto-updating the list.
     */
    subscribeRealtime() {
      const outletId = Alpine.store('auth').user?.outlet_id;
      if (!outletId) return;

      this._realtimeChannel = supabase
        .channel(`reservations:${outletId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'reservations',
            filter: `outlet_id=eq.${outletId}`,
          },
          () => {
            // Reload data on any change (simple & reliable)
            this.loadData();
          },
        )
        .subscribe();
    },

    /**
     * Apply filters and reload data.
     */
    applyFilters() {
      this.loadData();
    },

    /**
     * Clear all filters and reload.
     */
    clearFilters() {
      const today = this.todayDateString();
      this.filterStatus = '';
      this.filterDateFrom = today;
      this.filterDateTo = today;
      this.filterTableId = '';
      this.loadData();
    },

    // --- Modal ---

    /**
     * Open the create reservation modal.
     * Pre-fills default datetime to now + 1 hour.
     */
    openCreateModal() {
      this.isEditing = false;
      this.formError = '';
      const defaultTime = new Date(Date.now() + 60 * 60 * 1000);
      // Format for datetime-local input (YYYY-MM-DDTHH:MM)
      const offset = defaultTime.getTimezoneOffset();
      const local = new Date(defaultTime.getTime() - offset * 60 * 1000);
      this.form = {
        id: null,
        table_id: '',
        customer_name: '',
        customer_phone: '',
        party_size: 2,
        reserved_at: local.toISOString().slice(0, 16),
        notes: '',
      };
      this.showModal = true;
    },

    /**
     * Open the edit reservation modal with existing data.
     * @param {Object} reservation - Reservation to edit
     */
    openEditModal(reservation) {
      this.isEditing = true;
      this.formError = '';
      const dt = new Date(reservation.reserved_at);
      const offset = dt.getTimezoneOffset();
      const local = new Date(dt.getTime() - offset * 60 * 1000);
      this.form = {
        id: reservation.id,
        table_id: reservation.table_id,
        customer_name: reservation.customer_name,
        customer_phone: reservation.customer_phone || '',
        party_size: reservation.party_size,
        reserved_at: local.toISOString().slice(0, 16),
        notes: reservation.notes || '',
      };
      this.showModal = true;
    },

    /**
     * Close the modal.
     */
    closeModal() {
      this.showModal = false;
      this.formError = '';
    },

    /**
     * Submit the create/edit form.
     */
    async submitForm() {
      this.formError = '';

      // Validate required fields
      if (!this.form.customer_name.trim()) {
        this.formError = 'Vui lòng nhập tên khách hàng.';
        return;
      }
      if (!this.form.table_id) {
        this.formError = 'Vui lòng chọn bàn.';
        return;
      }
      if (!this.form.reserved_at) {
        this.formError = 'Vui lòng chọn thời gian đến.';
        return;
      }
      if (this.form.party_size < 1) {
        this.formError = 'Số khách phải lớn hơn 0.';
        return;
      }

      this.isSaving = true;
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        const userId = Alpine.store('auth').user?.id;

        // Convert local datetime-local value to ISO string
        const reservedAtISO = new Date(this.form.reserved_at).toISOString();

        if (this.isEditing) {
          await updateReservation(this.form.id, {
            table_id: this.form.table_id,
            customer_name: this.form.customer_name.trim(),
            customer_phone: this.form.customer_phone.trim() || null,
            party_size: this.form.party_size,
            reserved_at: reservedAtISO,
            notes: this.form.notes.trim() || null,
          }, outletId);
          Alpine.store('ui').showToast('Đã cập nhật đặt hẹn', 'success');
        } else {
          await createReservation(outletId, {
            table_id: this.form.table_id,
            customer_name: this.form.customer_name.trim(),
            customer_phone: this.form.customer_phone.trim() || null,
            party_size: this.form.party_size,
            reserved_at: reservedAtISO,
            notes: this.form.notes.trim() || null,
          }, userId);
          Alpine.store('ui').showToast('Đã tạo đặt hẹn', 'success');
        }

        this.closeModal();
        await this.loadData();
      } catch (err) {
        this.formError = err.message;
      } finally {
        this.isSaving = false;
      }
    },

    // --- Status Actions ---

    /**
     * Confirm customer arrival: pending → active.
     * @param {Object} reservation
     */
    async handleConfirmArrival(reservation) {
      try {
        await confirmArrival(reservation.id);
        Alpine.store('ui').showToast('Đã xác nhận khách đến', 'success');
      } catch (err) {
        Alpine.store('ui').showToast(err.message, 'error');
      }
    },

    /**
     * Cancel a reservation.
     * @param {Object} reservation
     */
    async handleCancel(reservation) {
      const confirmed = await Alpine.store('ui').openConfirmDialog({
        title: 'Hủy đặt hẹn',
        message: `Bạn có chắc muốn hủy đặt hẹn của ${reservation.customer_name}?`,
        confirmLabel: 'Hủy đặt hẹn',
        danger: true,
      });
      if (!confirmed) return;

      try {
        await cancelReservation(reservation.id);
        Alpine.store('ui').showToast('Đã hủy đặt hẹn', 'success');
      } catch (err) {
        Alpine.store('ui').showToast(err.message, 'error');
      }
    },

    /**
     * Navigate to order page for an active reservation's table.
     * @param {Object} reservation
     */
    goToOrder(reservation) {
      navigate(`/orders/${reservation.table_id}`);
    },

    // --- Display Helpers ---

    /**
     * Get the table name for a reservation.
     * @param {Object} reservation
     * @returns {string}
     */
    tableName(reservation) {
      return reservation.tables?.name || '—';
    },

    /**
     * Format reserved_at to display string.
     * @param {string} isoString
     * @returns {string}
     */
    formatDateTime(isoString) {
      if (!isoString) return '—';
      const d = new Date(isoString);
      return d.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    },

    /**
     * Format reserved_at for mobile card (shorter).
     * @param {string} isoString
     * @returns {string}
     */
    formatDateShort(isoString) {
      if (!isoString) return '—';
      const d = new Date(isoString);
      return d.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit', minute: '2-digit',
      });
    },

    /**
     * Get Vietnamese label for a status.
     * @param {string} status
     * @returns {string}
     */
    statusLabel(status) {
      const labels = {
        pending: 'Chờ đến',
        active: 'Đã đến',
        expired: 'Hết hạn',
        cancelled: 'Đã hủy',
        completed: 'Hoàn thành',
      };
      return labels[status] || status;
    },

    /**
     * Get CSS class for status badge.
     * @param {string} status
     * @returns {string}
     */
    statusBadgeClass(status) {
      const classes = {
        pending: 'badge--reserved-pending',
        active: 'badge--reserved-active',
        expired: 'badge--muted',
        cancelled: 'badge--danger',
        completed: 'badge--success',
      };
      return classes[status] || '';
    },

    /**
     * Truncate UUID for display.
     * @param {string} id
     * @returns {string}
     */
    truncateId(id) {
      return id ? id.slice(0, 8) : '';
    },

    formatVND,
  };
}

// Register as global function so x-data="reservationPage()" works
window.reservationPage = reservationPage;
