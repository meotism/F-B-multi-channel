// Reports Page - Report filters, charts, tables x-data component
//
// Alpine.js component for the reports dashboard page. Provides date range
// selection, category filtering, revenue summary cards, Chart.js charts
// (revenue bar chart + top items horizontal bar), and a breakdown data table.
//
// Chart.js is loaded via CDN in pages/reports.html (not in index.html).
// Charts are created/destroyed reactively via $watch on store data.
//
// Design reference: design.md Section 18 (Reports Page)
// Requirements: 12 (Reports Dashboard)

import { listCategories } from '../../services/menu-service.js';
import { formatVND } from '../../utils/formatters.js';

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

    // --- Lifecycle ---

    /**
     * Initialize the component: load categories, set default date range,
     * and set up chart watchers. Called automatically by Alpine when the
     * component mounts.
     */
    async init() {
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

      // Set default date range to today
      Alpine.store('reports').setDateRange('day');

      // Watch for chart data changes and re-render charts
      this.$watch('$store.reports.chartData', (newData) => {
        this.renderRevenueChart(newData);
      });

      this.$watch('$store.reports.topItemsByQty', () => {
        if (this.topItemsTab === 'qty') {
          this.renderTopItemsChart();
        }
      });

      this.$watch('$store.reports.topItemsByRevenue', () => {
        if (this.topItemsTab === 'revenue') {
          this.renderTopItemsChart();
        }
      });
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
     * Trigger report generation via the store.
     */
    async fetchReport() {
      await Alpine.store('reports').generateReport();
    },

    /**
     * Switch the top items tab and re-render the chart.
     *
     * @param {string} tab - 'qty' | 'revenue'
     */
    switchTopItemsTab(tab) {
      this.topItemsTab = tab;
      this.renderTopItemsChart();
    },

    // --- Chart Rendering ---

    /**
     * Render or update the revenue bar chart.
     * Destroys the previous instance before creating a new one.
     *
     * @param {Object|null} data - Chart data { labels, datasets }
     */
    renderRevenueChart(data) {
      // Destroy existing chart
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
              ticks: {
                callback: (value) => formatVND(value),
              },
            },
            x: {
              grid: { display: false },
            },
          },
        },
      });
    },

    /**
     * Render or update the top items horizontal bar chart.
     * Destroys the previous instance before creating a new one.
     */
    renderTopItemsChart() {
      // Destroy existing chart
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

      this.topItemsChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: isRevenue ? 'Doanh thu' : 'So luong',
            data: values,
            backgroundColor: isRevenue
              ? 'rgba(22, 163, 74, 0.7)'
              : 'rgba(37, 99, 235, 0.7)',
            borderColor: isRevenue
              ? 'rgba(22, 163, 74, 1)'
              : 'rgba(37, 99, 235, 1)',
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
                  : ctx.raw.toString(),
              },
            },
          },
          scales: {
            x: {
              beginAtZero: true,
              ticks: {
                callback: (value) => isRevenue ? formatVND(value) : value,
              },
            },
            y: {
              grid: { display: false },
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
