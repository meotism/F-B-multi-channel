// Bill List Page - Today's bills listing component
//
// Alpine.js component for viewing all bills finalized today (UTC+7).
// Displays a summary list with table name, total, payment method, time,
// and status. Allows clicking through to view individual bill details.

import { getTodayBills } from '../../services/bill-service.js';
import { formatVND, formatDate } from '../../utils/formatters.js';
import { navigate } from '../../utils/navigate.js';

/**
 * Alpine component factory for the bill list page.
 * Used as x-data="billListPage()" in pages/bill-list.html.
 *
 * @returns {Object} Alpine component data object
 */
export function billListPage() {
  return {
    isLoading: true,
    bills: [],
    filterStatus: 'all', // 'all' | 'finalized' | 'printed' | 'pending_print'

    get filteredBills() {
      if (this.filterStatus === 'all') return this.bills;
      return this.bills.filter(b => b.status === this.filterStatus);
    },

    get totalRevenue() {
      return this.filteredBills.reduce((sum, b) => sum + (b.total || 0) + (b.hourly_charge || 0), 0);
    },

    get billCount() {
      return this.filteredBills.length;
    },

    async init() {
      await this.loadBills();
    },

    async loadBills() {
      this.isLoading = true;
      try {
        this.bills = await getTodayBills();
      } catch (err) {
        console.error('[billListPage] loadBills failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể tải danh sách hóa đơn', 'error');
      } finally {
        this.isLoading = false;
      }
    },

    viewBill(bill) {
      if (bill.order_id) {
        navigate(`/bills/${bill.order_id}`);
      }
    },

    getTableName(bill) {
      return bill.orders?.tables?.name || 'Không xác định';
    },

    getBillNumber(bill) {
      if (!bill || !bill.id) return 'HD-000000';
      return 'HD-' + bill.id.substring(0, 8).toUpperCase();
    },

    getStatusBadge(status) {
      const map = {
        finalized: { text: 'Đã xuất', class: 'badge--info' },
        printed: { text: 'Đã in', class: 'badge--success' },
        pending_print: { text: 'Chờ in', class: 'badge--warning' },
      };
      return map[status] || { text: status, class: 'badge--muted' };
    },

    formatPaymentMethod(method) {
      const map = { cash: 'Tiền mặt', card: 'Thẻ', transfer: 'Chuyển khoản' };
      return map[method] || method;
    },

    formatVND(amount) {
      return formatVND(amount);
    },

    formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      // Display in UTC+7
      const utc7 = new Date(d.getTime() + 7 * 60 * 60 * 1000);
      const h = String(utc7.getUTCHours()).padStart(2, '0');
      const m = String(utc7.getUTCMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    },

    getTodayDateString() {
      const now = new Date();
      const utc7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const day = String(utc7.getUTCDate()).padStart(2, '0');
      const month = String(utc7.getUTCMonth() + 1).padStart(2, '0');
      const year = utc7.getUTCFullYear();
      return `${day}/${month}/${year}`;
    },
  };
}

window.billListPage = billListPage;
