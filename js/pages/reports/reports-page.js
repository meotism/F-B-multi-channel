// Reports Page - Report filters, charts, tables x-data component
//
// Alpine.js component for the reports dashboard page. Provides date range
// selection, category filtering, revenue summary cards, Chart.js charts
// (revenue bar chart + top items horizontal bar), and a breakdown data table.
//
// Chart.js is loaded dynamically on first visit to the reports page.
// Charts are created/destroyed reactively via $watch on store data.
//
// Design reference: design.md Section 18 (Reports Page)
// Requirements: 12 (Reports Dashboard)

import { listCategories } from '../../services/menu-service.js';
import { getRevenueByPaymentMethod, getRevenueByCategory, getPeakHours, getRevenueBySource } from '../../services/report-service.js';
import { formatVND } from '../../utils/formatters.js';

/**
 * Dynamically load Chart.js from CDN. Script tags in innerHTML are not
 * executed by the browser, so we create the element programmatically.
 * Subsequent calls are no-ops once the library is loaded.
 */
let chartJsLoaded = false;
async function loadChartJs() {
  if (chartJsLoaded || typeof Chart !== 'undefined') {
    chartJsLoaded = true;
    return;
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    script.onload = () => { chartJsLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Không thể tải thư viện biểu đồ'));
    document.head.appendChild(script);
  });
}

/**
 * Convert a YYYY-MM-DD date string to a UTC ISO string representing
 * the start of that day in the browser's local timezone.
 * E.g. '2026-03-13' in Asia/Ho_Chi_Minh → '2026-03-12T17:00:00.000Z'
 */
function localDateToUtcStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0).toISOString();
}

/**
 * Convert a YYYY-MM-DD date string to a UTC ISO string representing
 * the start of the NEXT day in the browser's local timezone (exclusive upper bound).
 * E.g. '2026-03-13' in Asia/Ho_Chi_Minh → '2026-03-13T17:00:00.000Z'
 */
function localDateToUtcEnd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d + 1, 0, 0, 0).toISOString();
}

/**
 * Alpine component factory for the reports page.
 * Used as x-data="reportsPage()" in pages/reports.html.
 *
 * @returns {Object} Alpine component data object
 */
export function reportsPage() {
  return {
    // --- Page state ---
    categories: [],           // All categories for the filter dropdown
    revenueChart: null,       // Chart.js instance for revenue bar chart
    topItemsChart: null,      // Chart.js instance for top items chart
    topItemsTab: 'qty',       // 'qty' | 'revenue' — which top items tab is active

    // Task 13.1: Report type tabs
    activeReportTab: 'overview', // 'overview' | 'by_payment' | 'by_category' | 'peak_hours' | 'revenue_source'
    paymentMethodData: [],       // Revenue by payment method
    categoryRevenueData: [],     // Revenue by category
    peakHoursData: [],           // Peak hours heatmap data
    revenueSourceData: null,     // Revenue by source (items vs hourly)
    isLoadingTab: false,         // Loading state for tab-specific data

    // Task 13.2: Peak hours heatmap state
    peakHoursGrid: [],           // 7x24 grid for heatmap
    peakHoursMaxCount: 0,        // Max count for opacity calculation

    // --- Lifecycle ---

    /**
     * Initialize the component: load categories, set default date range,
     * and set up chart watchers. Called automatically by Alpine when the
     * component mounts.
     */
    async init() {
      // Load Chart.js dynamically (script tags in innerHTML are not executed)
      try {
        await loadChartJs();
      } catch (err) {
        console.error('[reportsPage] Failed to load Chart.js:', err);
        Alpine.store('ui').showToast('Không thể tải thư viện biểu đồ', 'error');
      }

      // Load categories for the filter dropdown
      const outletId = Alpine.store('auth').user?.outlet_id;
      if (outletId) {
        try {
          const cats = await listCategories(outletId);
          this.categories = (cats || []).filter(c => c.is_active !== false);
        } catch (err) {
          console.error('[reportsPage] Failed to load categories:', err);
        }
      }

      // Set default date range to today and auto-fetch
      Alpine.store('reports').setDateRange('day');
      await this.fetchReport();
    },

    // --- Actions ---

    /**
     * Select a date range mode and update the store.
     *
     * @param {string} mode - 'day' | 'week' | 'month' | 'year' | 'custom'
     */
    selectDateRange(mode) {
      Alpine.store('reports').setDateRange(mode);
    },

    /**
     * Set the category filter and update the store.
     *
     * @param {Event} event - Change event from the select element
     */
    onCategoryChange(event) {
      const value = event.target.value;
      Alpine.store('reports').setCategory(value || null);
    },

    /**
     * Trigger report generation via the store, then render charts after the
     * DOM updates (x-show removes display:none before Chart.js measures canvas).
     */
    async fetchReport() {
      await Alpine.store('reports').generateReport();
      this.$nextTick(() => {
        const store = Alpine.store('reports');
        if (store.chartData) {
          this.renderRevenueChart(store.chartData);
        }
        if (store.topItemsByQty.length > 0 || store.topItemsByRevenue.length > 0) {
          this.renderTopItemsChart();
        }
      });
    },

    /**
     * Switch the top items tab and re-render the chart.
     *
     * @param {string} tab - 'qty' | 'revenue'
     */
    switchTopItemsTab(tab) {
      this.topItemsTab = tab;
      this.$nextTick(() => this.renderTopItemsChart());
    },

    // --- Task 13.1: Report Tab Methods ---

    /**
     * Switch the active report tab and load data for the selected tab.
     * @param {string} tab - 'overview' | 'by_payment' | 'by_category' | 'peak_hours'
     */
    async switchReportTab(tab) {
      this.activeReportTab = tab;

      if (tab === 'overview') return; // Overview data is already loaded via fetchReport

      this.isLoadingTab = true;

      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        const store = Alpine.store('reports');
        const fromUtc = localDateToUtcStart(store.dateFrom);
        const toUtc = localDateToUtcEnd(store.dateTo);

        if (!outletId) {
          throw new Error('Không tìm thấy thông tin cửa hàng');
        }

        if (tab === 'by_payment') {
          this.paymentMethodData = await getRevenueByPaymentMethod(outletId, fromUtc, toUtc);
        } else if (tab === 'by_category') {
          this.categoryRevenueData = await getRevenueByCategory(outletId, fromUtc, toUtc);
        } else if (tab === 'peak_hours') {
          const rawData = await getPeakHours(outletId, fromUtc, toUtc);
          this.peakHoursData = rawData;
          this.buildPeakHoursGrid(rawData);
        } else if (tab === 'revenue_source') {
          this.revenueSourceData = await getRevenueBySource(outletId, fromUtc, toUtc);
        }
      } catch (err) {
        console.error(`[reportsPage] Failed to load ${tab} data:`, err);
        Alpine.store('ui').showToast(err.message || 'Không thể tải dữ liệu báo cáo', 'error');
      } finally {
        this.isLoadingTab = false;
      }
    },

    /**
     * Task 13.2: Build the 7x24 peak hours grid from raw data.
     * Each cell: { dayOfWeek, hour, count, revenue, opacity }
     * @param {Array} rawData - Peak hours data from the RPC
     */
    buildPeakHoursGrid(rawData) {
      // Initialize 7 days x 24 hours grid
      const grid = [];
      let maxCount = 0;

      for (let day = 0; day < 7; day++) {
        const row = [];
        for (let hour = 0; hour < 24; hour++) {
          row.push({ dayOfWeek: day, hour, count: 0, revenue: 0, opacity: 0 });
        }
        grid.push(row);
      }

      // Fill in data from the raw results
      (rawData || []).forEach(item => {
        const day = Number(item.day_of_week || item.dow || 0);
        const hour = Number(item.hour || 0);
        const count = Number(item.order_count || item.bill_count || 0);
        const revenue = Number(item.total_revenue || 0);

        if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
          grid[day][hour].count = count;
          grid[day][hour].revenue = revenue;
          if (count > maxCount) maxCount = count;
        }
      });

      // Calculate opacity based on max count
      if (maxCount > 0) {
        for (let day = 0; day < 7; day++) {
          for (let hour = 0; hour < 24; hour++) {
            grid[day][hour].opacity = grid[day][hour].count / maxCount;
          }
        }
      }

      this.peakHoursGrid = grid;
      this.peakHoursMaxCount = maxCount;
    },

    /**
     * Get Vietnamese day name.
     * @param {number} dayIndex - 0-6 (0 = Sunday)
     * @returns {string}
     */
    getDayName(dayIndex) {
      const days = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
      return days[dayIndex] || '';
    },

    /**
     * Format Vietnamese payment method name for reports.
     * @param {string} method - Payment method code
     * @returns {string}
     */
    formatPaymentMethodReport(method) {
      const map = { cash: 'Tiền mặt', card: 'Thẻ', transfer: 'Chuyển khoản' };
      return map[method] || method;
    },

    // --- Chart Rendering (Task 23.1: Improved Chart.js rendering) ---

    /**
     * Extract a CSS variable value from the document root.
     * @param {string} varName - CSS variable name (e.g., '--color-primary')
     * @returns {string} The resolved value
     */
    getCSSVar(varName) {
      return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    },

    /**
     * Render or update the revenue bar chart.
     * Task 23.1: Uses CSS theme colors, Vietnamese axis labels,
     * formatVND tooltips, responsive + no maintainAspectRatio,
     * and destroys/recreates on data refresh.
     *
     * @param {Object|null} data - Chart data { labels, datasets }
     */
    renderRevenueChart(data) {
      // Destroy existing chart to prevent canvas reuse errors
      if (this.revenueChart) {
        this.revenueChart.destroy();
        this.revenueChart = null;
      }

      if (!data || !data.labels || data.labels.length === 0) return;

      // Check if Chart.js is loaded
      if (typeof Chart === 'undefined') {
        console.warn('[reportsPage] Chart.js not loaded yet');
        return;
      }

      const canvas = this.$refs.revenueCanvas;
      if (!canvas) return;

      // Task 23.1: Extract theme colors from CSS variables
      const primaryColor = this.getCSSVar('--color-primary') || '#2563eb';
      const textColor = this.getCSSVar('--color-text') || '#1e293b';
      const textSecondaryColor = this.getCSSVar('--color-text-secondary') || '#64748b';
      const borderColor = this.getCSSVar('--color-border') || '#e2e8f0';

      // Apply theme color to dataset if not already set
      if (data.datasets && data.datasets.length > 0) {
        data.datasets.forEach(ds => {
          if (!ds.backgroundColor) ds.backgroundColor = primaryColor + 'b3'; // 70% opacity
          if (!ds.borderColor) ds.borderColor = primaryColor;
          if (ds.borderWidth == null) ds.borderWidth = 1;
        });
      }

      this.revenueChart = new Chart(canvas, {
        type: 'bar',
        data: data,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => formatVND(ctx.raw) + ' VND',
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              title: {
                display: true,
                text: 'Doanh thu (VND)',
                color: textSecondaryColor,
                font: { size: 12 },
              },
              ticks: {
                callback: (value) => formatVND(value),
                color: textSecondaryColor,
              },
              grid: {
                color: borderColor,
              },
            },
            x: {
              title: {
                display: true,
                text: 'Thời gian',
                color: textSecondaryColor,
                font: { size: 12 },
              },
              grid: { display: false },
              ticks: {
                color: textColor,
              },
            },
          },
        },
      });
    },

    /**
     * Render or update the top items horizontal bar chart.
     * Task 23.1: Uses CSS theme colors, Vietnamese labels,
     * formatVND tooltips, and destroys/recreates on refresh.
     */
    renderTopItemsChart() {
      // Destroy existing chart to prevent canvas reuse errors
      if (this.topItemsChart) {
        this.topItemsChart.destroy();
        this.topItemsChart = null;
      }

      // Check if Chart.js is loaded
      if (typeof Chart === 'undefined') {
        console.warn('[reportsPage] Chart.js not loaded yet');
        return;
      }

      const canvas = this.$refs.topItemsCanvas;
      if (!canvas) return;

      const store = Alpine.store('reports');
      const items = this.topItemsTab === 'qty'
        ? store.topItemsByQty
        : store.topItemsByRevenue;

      if (!items || items.length === 0) return;

      const isRevenue = this.topItemsTab === 'revenue';
      const labels = items.map(i => i.item_name || '');
      const values = items.map(i => isRevenue ? (i.total_revenue || 0) : (i.total_qty || 0));

      // Task 23.1: Extract theme colors from CSS variables
      const primaryColor = this.getCSSVar('--color-primary') || '#2563eb';
      const successColor = this.getCSSVar('--color-success') || '#16a34a';
      const textColor = this.getCSSVar('--color-text') || '#1e293b';
      const textSecondaryColor = this.getCSSVar('--color-text-secondary') || '#64748b';
      const borderColorCSS = this.getCSSVar('--color-border') || '#e2e8f0';

      const barColor = isRevenue ? successColor : primaryColor;

      this.topItemsChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: isRevenue ? 'Doanh thu' : 'Số lượng',
            data: values,
            backgroundColor: barColor + 'b3',
            borderColor: barColor,
            borderWidth: 1,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => isRevenue
                  ? formatVND(ctx.raw) + ' VND'
                  : ctx.raw + ' phần',
              },
            },
          },
          scales: {
            x: {
              beginAtZero: true,
              title: {
                display: true,
                text: isRevenue ? 'Doanh thu (VND)' : 'Số lượng bán',
                color: textSecondaryColor,
                font: { size: 12 },
              },
              ticks: {
                callback: (value) => isRevenue ? formatVND(value) : value,
                color: textSecondaryColor,
              },
              grid: {
                color: borderColorCSS,
              },
            },
            y: {
              title: {
                display: true,
                text: 'Món ăn',
                color: textSecondaryColor,
                font: { size: 12 },
              },
              grid: { display: false },
              ticks: {
                color: textColor,
              },
            },
          },
        },
      });
    },

    // --- Formatting helpers ---

    /**
     * Format a price value as VND string.
     *
     * @param {number} amount
     * @returns {string} Formatted VND string
     */
    formatVND(amount) {
      return formatVND(amount);
    },
  };
}

// Register as global function so x-data="reportsPage()" works
// when the template is dynamically loaded by the router
window.reportsPage = reportsPage;
