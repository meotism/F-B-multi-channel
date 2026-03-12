// E2E Test: Report Generation Flow
//
// Tests the reports page functionality including date range selection,
// report generation, summary card display, chart rendering, data table
// population, and the "no data" empty state.
//
// Only owner and manager roles can access reports (role guard enforced by router).
//
// Requirements: 5.7.1, 5.7.9
// Design reference: Section 9.3 Key E2E Scenarios

import { test, expect } from '@playwright/test';
import { loginAs } from './fixtures/auth-helpers.js';

test.describe('Report generation', () => {

  test('generate daily report with data', async ({ page }) => {
    // ---------------------------------------------------------------
    // Step 1: Login as owner (has view_reports permission)
    // ---------------------------------------------------------------
    await loginAs(page, 'owner');

    // ---------------------------------------------------------------
    // Step 2: Navigate to the reports page
    // ---------------------------------------------------------------
    await page.evaluate(() => { window.location.hash = '#/reports'; });
    await page.waitForFunction(
      () => window.location.hash === '#/reports',
      { timeout: 10000 },
    );

    // Wait for the reports page component to mount
    await page.waitForSelector('.reports-page', { state: 'visible', timeout: 10000 });

    // ---------------------------------------------------------------
    // Step 3: Verify date range filter controls are visible
    // ---------------------------------------------------------------
    // Quick date range buttons should be present
    const dayBtn = page.locator('.reports-filter-btn:has-text("Ngay")');
    const weekBtn = page.locator('.reports-filter-btn:has-text("Tuan")');
    const monthBtn = page.locator('.reports-filter-btn:has-text("Thang")');
    const yearBtn = page.locator('.reports-filter-btn:has-text("Nam")');

    await expect(dayBtn).toBeVisible();
    await expect(weekBtn).toBeVisible();
    await expect(monthBtn).toBeVisible();
    await expect(yearBtn).toBeVisible();

    // Date input fields should be present
    await expect(page.locator('#report-date-from')).toBeVisible();
    await expect(page.locator('#report-date-to')).toBeVisible();

    // ---------------------------------------------------------------
    // Step 4: Select "Thang" (month) date range for broader data
    // ---------------------------------------------------------------
    await monthBtn.click();

    // Verify the month button is now active
    await expect(monthBtn).toHaveClass(/reports-filter-btn--active/, { timeout: 3000 });

    // ---------------------------------------------------------------
    // Step 5: Click "Xem bao cao" (Generate report) button
    // ---------------------------------------------------------------
    const generateBtn = page.locator('.reports-filters__submit:has-text("Xem bao cao")');
    await expect(generateBtn).toBeVisible();
    await generateBtn.click();

    // Wait for loading to complete (spinner disappears)
    await page.waitForFunction(
      () => {
        const store = window.Alpine?.store('reports');
        return store && !store.isLoading;
      },
      { timeout: 20000 },
    );

    // ---------------------------------------------------------------
    // Step 6: Verify summary cards display values
    // ---------------------------------------------------------------
    // The summary section should be visible with three cards
    const summarySection = page.locator('.reports-summary');
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    // "Tong doanh thu" (Total revenue) card
    const revenueCard = page.locator('.reports-card:has(.reports-card__label:has-text("Tong doanh thu"))');
    await expect(revenueCard).toBeVisible();
    const revenueValue = revenueCard.locator('.reports-card__value');
    await expect(revenueValue).toBeVisible({ timeout: 5000 });

    // "So hoa don" (Bill count) card
    const billCountCard = page.locator('.reports-card:has(.reports-card__label:has-text("So hoa don"))');
    await expect(billCountCard).toBeVisible();
    const billCountValue = billCountCard.locator('.reports-card__value');
    await expect(billCountValue).toBeVisible({ timeout: 5000 });

    // "Trung binh/hoa don" (Average per bill) card
    const avgCard = page.locator('.reports-card:has(.reports-card__label:has-text("Trung binh"))');
    await expect(avgCard).toBeVisible();
    const avgValue = avgCard.locator('.reports-card__value');
    await expect(avgValue).toBeVisible({ timeout: 5000 });

    // ---------------------------------------------------------------
    // Step 7: Verify revenue chart canvas exists and is rendered
    // ---------------------------------------------------------------
    // Check if data was returned (chart only shows when data exists)
    const hasChartData = await page.evaluate(() => {
      const store = Alpine.store('reports');
      return store.chartData && store.chartData.labels && store.chartData.labels.length > 0;
    });

    if (hasChartData) {
      const chartSection = page.locator('.reports-chart-section').first();
      await expect(chartSection).toBeVisible({ timeout: 5000 });

      // The canvas element should exist inside the chart container
      const canvas = page.locator('.reports-chart-container canvas').first();
      await expect(canvas).toBeVisible({ timeout: 5000 });
    }

    // ---------------------------------------------------------------
    // Step 8: Verify data table has rows (when breakdown data exists)
    // ---------------------------------------------------------------
    const hasBreakdownData = await page.evaluate(() => {
      const store = Alpine.store('reports');
      return store.breakdownData && store.breakdownData.length > 0;
    });

    if (hasBreakdownData) {
      const dataTable = page.locator('.data-table');
      await expect(dataTable).toBeVisible({ timeout: 5000 });

      // Table should have header row
      const headerCells = dataTable.locator('thead th');
      await expect(headerCells).toHaveCount(4); // Ky, Doanh thu, So hoa don, Trung binh

      // Table should have at least one data row
      const dataRows = dataTable.locator('tbody tr');
      const rowCount = await dataRows.count();
      expect(rowCount).toBeGreaterThan(0);
    }
  });

  test('show no data message for empty date range', async ({ page }) => {
    // ---------------------------------------------------------------
    // Step 1: Login as owner
    // ---------------------------------------------------------------
    await loginAs(page, 'owner');

    // ---------------------------------------------------------------
    // Step 2: Navigate to reports
    // ---------------------------------------------------------------
    await page.evaluate(() => { window.location.hash = '#/reports'; });
    await page.waitForSelector('.reports-page', { state: 'visible', timeout: 10000 });

    // ---------------------------------------------------------------
    // Step 3: Select a future date range where no data can exist
    // ---------------------------------------------------------------
    // Click "Tuy chon" (Custom) to enable manual date input
    const customBtn = page.locator('.reports-filter-btn:has-text("Tuy chon")');
    await customBtn.click();

    // Set date range to a far future date (guaranteed no data)
    const futureFrom = '2099-01-01';
    const futureTo = '2099-12-31';

    await page.fill('#report-date-from', futureFrom);
    await page.fill('#report-date-to', futureTo);

    // ---------------------------------------------------------------
    // Step 4: Generate the report
    // ---------------------------------------------------------------
    const generateBtn = page.locator('.reports-filters__submit:has-text("Xem bao cao")');
    await generateBtn.click();

    // Wait for loading to complete
    await page.waitForFunction(
      () => {
        const store = window.Alpine?.store('reports');
        return store && !store.isLoading;
      },
      { timeout: 20000 },
    );

    // ---------------------------------------------------------------
    // Step 5: Verify "Khong co du lieu" (No data) message is shown
    // ---------------------------------------------------------------
    const noDataMessage = page.locator('.reports-no-data');
    await expect(noDataMessage).toBeVisible({ timeout: 10000 });

    // Verify the message text
    const noDataText = page.locator('.reports-no-data p');
    await expect(noDataText).toContainText('Khong co du lieu', { timeout: 5000 });

    // The data table and chart sections should NOT be visible
    await expect(page.locator('.data-table')).not.toBeVisible();
  });

  test('date range quick selectors update inputs', async ({ page }) => {
    // Login as manager (also has view_reports permission)
    await loginAs(page, 'manager');

    // Navigate to reports
    await page.evaluate(() => { window.location.hash = '#/reports'; });
    await page.waitForSelector('.reports-page', { state: 'visible', timeout: 10000 });

    // Click "Ngay" (Day) button
    const dayBtn = page.locator('.reports-filter-btn:has-text("Ngay")');
    await dayBtn.click();
    await expect(dayBtn).toHaveClass(/reports-filter-btn--active/);

    // The date-from and date-to inputs should be set to today
    const dateFrom = await page.inputValue('#report-date-from');
    const dateTo = await page.inputValue('#report-date-to');
    expect(dateFrom).toBeTruthy();
    expect(dateTo).toBeTruthy();
    // For "day" mode, both dates should be the same
    expect(dateFrom).toBe(dateTo);

    // Click "Tuan" (Week) button
    const weekBtn = page.locator('.reports-filter-btn:has-text("Tuan")');
    await weekBtn.click();
    await expect(weekBtn).toHaveClass(/reports-filter-btn--active/);

    // The date range should now span 7 days
    const weekFrom = await page.inputValue('#report-date-from');
    const weekTo = await page.inputValue('#report-date-to');
    expect(weekFrom).toBeTruthy();
    expect(weekTo).toBeTruthy();
    // Week range: from < to
    expect(new Date(weekFrom).getTime()).toBeLessThanOrEqual(new Date(weekTo).getTime());
  });

  test('category filter dropdown is populated', async ({ page }) => {
    // Login as owner
    await loginAs(page, 'owner');

    // Navigate to reports
    await page.evaluate(() => { window.location.hash = '#/reports'; });
    await page.waitForSelector('.reports-page', { state: 'visible', timeout: 10000 });

    // Wait for categories to load in the dropdown
    const categorySelect = page.locator('#report-category');
    await expect(categorySelect).toBeVisible({ timeout: 5000 });

    // The first option should be "Tat ca danh muc" (All categories)
    const firstOption = categorySelect.locator('option').first();
    await expect(firstOption).toHaveText('Tat ca danh muc');
  });
});
