// Report Store - Alpine.store('reports'): report state, date range, chart data
//
// Pure state manager for report generation, date range selection, and chart data.
// Calls the report service to fetch aggregated data from the aggregate-reports
// Edge Function. Registered as Alpine.store('reports') in app.js.
//
// Requirements: 12 (Reports Dashboard)
// Design reference: Section 17 (Reports Store)

import { generateReport } from '../services/report-service.js';
import { formatVND } from '../utils/formatters.js';

/**
 * Calculate date range based on view mode.
 * Returns { from, to } as YYYY-MM-DD strings.
 *
 * @param {string} mode - 'day' | 'week' | 'month' | 'year'
 * @returns {{ from: string, to: string }}
 */
export function calculateDateRange(mode) {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = today.getMonth();
  const dd = today.getDate();

  let from, to;

  switch (mode) {
    case 'day':
      from = new Date(yyyy, mm, dd);
      to = new Date(yyyy, mm, dd);
      break;

    case 'week': {
      // Start from Monday of the current week
      const dayOfWeek = today.getDay(); // 0 = Sunday
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      from = new Date(yyyy, mm, dd + mondayOffset);
      to = new Date(from);
      to.setDate(from.getDate() + 6);
      break;
    }

    case 'month':
      from = new Date(yyyy, mm, 1);
      to = new Date(yyyy, mm + 1, 0); // Last day of current month
      break;

    case 'year':
      from = new Date(yyyy, 0, 1);
      to = new Date(yyyy, 11, 31);
      break;

    default:
      from = new Date(yyyy, mm, dd);
      to = new Date(yyyy, mm, dd);
  }

  return {
    from: formatDateISO(from),
    to: formatDateISO(to),
  };
}

/**
 * Format a Date object as YYYY-MM-DD string.
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function reportStore() {
  // Initialize with today's date
  const todayStr = formatDateISO(new Date());

  return {
    // --- Date range state ---
    dateFrom: todayStr,
    dateTo: todayStr,
    viewMode: 'day',           // 'day' | 'week' | 'month' | 'year' | 'custom'
    categoryFilter: null,       // UUID of selected category or null for all

    // --- Report data ---
    summary: null,              // { total_revenue, total_tax, bill_count, average_value }
    chartData: null,            // { labels: [], datasets: [] } for revenue chart
    topItemsByQty: [],          // Array of top items sorted by quantity
    topItemsByRevenue: [],      // Array of top items sorted by revenue
    breakdownData: [],          // Array of { period, revenue, bill_count, average_value }
    hourlyRevenueSplit: null,    // { items_revenue, hourly_revenue, total_revenue, hourly_bill_count, total_bill_count }

    // --- UI state ---
    isLoading: false,
    error: null,
    noData: false,
    hasGeneratedReport: false,

    /**
     * Set date range based on view mode and trigger report generation.
     * For 'custom' mode, dates are set manually via the date inputs.
     *
     * @param {string} mode - 'day' | 'week' | 'month' | 'year' | 'custom'
     */
    setDateRange(mode) {
      this.viewMode = mode;
      if (mode !== 'custom') {
        const range = calculateDateRange(mode);
        this.dateFrom = range.from;
        this.dateTo = range.to;
      }
    },

    /**
     * Set the category filter.
     *
     * @param {string|null} categoryId - Category UUID or null for all
     */
    setCategory(categoryId) {
      this.categoryFilter = categoryId;
    },

    /**
     * Format a currency amount as VND string.
     * Convenience method for use in templates.
     *
     * @param {number} amount
     * @returns {string} Formatted VND string (e.g., "150.000")
     */
    formatCurrency(amount) {
      return formatVND(amount);
    },

    /**
     * Generate the report by calling the Edge Function.
     * Maps the view mode to the Edge Function's type parameter,
     * then updates all store data with the response.
     */
    async generateReport() {
      this.isLoading = true;
      this.error = null;
      this.noData = false;
      this.hasGeneratedReport = true;

      // Map viewMode to Edge Function type parameter
      const typeMap = {
        day: 'daily',
        week: 'daily',
        month: 'daily',
        year: 'monthly',
        custom: 'daily',
      };
      const type = typeMap[this.viewMode] || 'daily';

      try {
        const data = await generateReport(
          this.dateFrom,
          this.dateTo,
          type,
          this.categoryFilter,
          10,
        );

        // Update summary
        this.summary = data.summary || {
          total_revenue: 0,
          total_tax: 0,
          bill_count: 0,
          average_value: 0,
        };

        // Update top items
        this.topItemsByQty = data.top_items_by_qty || [];
        this.topItemsByRevenue = data.top_items_by_revenue || [];

        // Update breakdown data
        this.breakdownData = data.breakdown || [];

        // Update hourly revenue split
        this.hourlyRevenueSplit = data.hourly_revenue_split || null;

        // Build chart data from breakdown
        if (this.breakdownData.length > 0) {
          this.chartData = {
            labels: this.breakdownData.map(d => d.period),
            datasets: [{
              label: 'Doanh thu',
              data: this.breakdownData.map(d => d.revenue || 0),
              backgroundColor: 'rgba(37, 99, 235, 0.7)',
              borderColor: 'rgba(37, 99, 235, 1)',
              borderWidth: 1,
            }],
          };
          this.noData = false;
        } else {
          this.chartData = null;
          // Check if everything is empty (no data at all)
          this.noData = this.summary.bill_count === 0
            && this.topItemsByQty.length === 0
            && this.topItemsByRevenue.length === 0;
        }
      } catch (err) {
        console.error('[report-store] generateReport failed:', err);
        this.error = err.message || 'Khong the tao bao cao';
        this.noData = true;
        this.summary = null;
        this.chartData = null;
        this.topItemsByQty = [];
        this.topItemsByRevenue = [];
        this.breakdownData = [];
        this.hourlyRevenueSplit = null;
      } finally {
        this.isLoading = false;
      }
    },
  };
}
