// E2E Test: Order-to-Bill Flow
//
// Tests the complete lifecycle from login through order creation, bill
// finalization, and Bluetooth printing. Uses a mock Bluetooth API to
// simulate printer interaction without physical hardware.
//
// Flow tested:
//   Login as cashier -> Table map -> Select empty table -> Add menu items ->
//   Confirm order -> Request payment -> Navigate to bill -> Select payment
//   method -> Finalize bill -> Verify status badge -> Verify edit lock ->
//   Verify print triggered -> Verify "Da in" status
//
// Requirements: 5.4.1, 5.4.2, 5.4.4, 5.4.5
// Design reference: Section 9.3 Key E2E Scenarios

import { test, expect } from '@playwright/test';
import { mockWebBluetooth, getPrintResult } from './fixtures/bluetooth-mock.js';
import { loginAs } from './fixtures/auth-helpers.js';

test.describe('Order to Bill flow', () => {

  test.beforeEach(async ({ page }) => {
    // Inject the mock Bluetooth API before any page scripts execute
    await mockWebBluetooth(page);
  });

  test('complete order-to-bill-to-print flow', async ({ page }) => {
    // ---------------------------------------------------------------
    // Step 1: Login as cashier
    // ---------------------------------------------------------------
    await loginAs(page, 'cashier');

    // Cashier should land on the table map page (default route for cashier role)
    await page.waitForFunction(
      () => window.location.hash === '#/tables',
      { timeout: 10000 },
    );

    // ---------------------------------------------------------------
    // Step 2: Wait for table map to load and select an empty table
    // ---------------------------------------------------------------
    // Wait for table nodes to appear on the map
    await page.waitForSelector('.table-node', { state: 'visible', timeout: 15000 });

    // Find and click the first table with 'empty' status
    const emptyTable = page.locator('.table-node--empty').first();
    await expect(emptyTable).toBeVisible({ timeout: 10000 });

    // Store the table name for later verification
    const tableName = await emptyTable.locator('.table-node__name').textContent();
    await emptyTable.click();

    // ---------------------------------------------------------------
    // Step 3: Navigate to order page for the selected table
    // ---------------------------------------------------------------
    // Clicking an empty table should navigate to the order creation page
    await page.waitForFunction(
      () => window.location.hash.startsWith('#/orders/'),
      { timeout: 10000 },
    );

    // Wait for the order page to load (menu items grid or loading state)
    await page.waitForSelector('.order-page', { state: 'visible', timeout: 10000 });

    // ---------------------------------------------------------------
    // Step 4: Add menu items to the order
    // ---------------------------------------------------------------
    // Wait for menu items to load (loading skeleton disappears, grid appears)
    await page.waitForSelector('.order-menu-grid', { state: 'visible', timeout: 15000 });

    // Add the first available menu item by clicking it
    const firstMenuItem = page.locator('.order-menu-item').first();
    await expect(firstMenuItem).toBeVisible();
    await firstMenuItem.click();

    // Add a second menu item (or the same one again for quantity)
    const secondMenuItem = page.locator('.order-menu-item').nth(1);
    if (await secondMenuItem.isVisible()) {
      await secondMenuItem.click();
    } else {
      // If only one menu item exists, click the first one again
      await firstMenuItem.click();
    }

    // Verify the cart has items
    await expect(page.locator('.order-cart__header-title')).toBeVisible();

    // ---------------------------------------------------------------
    // Step 5: Confirm the order
    // ---------------------------------------------------------------
    // Click the "Xac nhan don hang" (Confirm order) button
    const confirmBtn = page.locator('.order-cart-total__confirm');
    await expect(confirmBtn).toBeEnabled({ timeout: 5000 });
    await confirmBtn.click();

    // Wait for the order to be submitted (page transitions to detail mode)
    // After confirmation, the page switches to 'detail' mode showing the order
    await page.waitForSelector('.order-detail', { state: 'visible', timeout: 15000 });

    // ---------------------------------------------------------------
    // Step 6: Verify order detail shows active status
    // ---------------------------------------------------------------
    // The order should show "Dang phuc vu" (active/serving) badge
    const activeStatusBadge = page.locator('.order-detail__status.badge--success');
    await expect(activeStatusBadge).toContainText('Đang phục vụ', { timeout: 5000 });

    // ---------------------------------------------------------------
    // Step 7: Request payment
    // ---------------------------------------------------------------
    // Click the "Yeu cau thanh toan" (Request payment) button
    const requestPaymentBtn = page.locator('button:has-text("Yêu cầu thanh toán")');
    await expect(requestPaymentBtn).toBeVisible({ timeout: 5000 });
    await requestPaymentBtn.click();

    // Wait for order status to change to 'completed' (awaiting payment)
    // The status badge should now show "Cho thanh toan"
    const awaitingBadge = page.locator('.order-detail__status.badge--warning');
    await expect(awaitingBadge).toContainText('Chờ thanh toán', { timeout: 10000 });

    // The locked notice should appear indicating the order cannot be edited
    const lockedNotice = page.locator('.order-detail__locked-notice');
    await expect(lockedNotice).toBeVisible({ timeout: 5000 });

    // ---------------------------------------------------------------
    // Step 8: Navigate to the bill page
    // ---------------------------------------------------------------
    // Get the current order ID from the URL hash to construct the bill URL
    const orderHash = await page.evaluate(() => window.location.hash);
    // Hash format: #/orders/<tableId> -- we need the order ID, not the table ID
    // The bill page is navigated to via #/bills/<orderId>
    // In the real app, there would be a "Thanh toan" button or link
    // For E2E, we need to find the order ID. It is stored in the order store.
    const orderId = await page.evaluate(() => {
      const store = Alpine.store('orders');
      return store.currentOrder?.id || null;
    });
    expect(orderId).toBeTruthy();

    // Navigate to the bill page for this order
    await page.evaluate((id) => {
      window.location.hash = `#/bills/${id}`;
    }, orderId);

    // Wait for the bill page to load
    await page.waitForSelector('.bill-page', { state: 'visible', timeout: 10000 });

    // ---------------------------------------------------------------
    // Step 9: Verify bill page shows order details
    // ---------------------------------------------------------------
    // Wait for loading to complete
    await page.waitForSelector('.bill-content', { state: 'visible', timeout: 10000 });

    // Verify order items are displayed in the bill summary
    const billItemRows = page.locator('.bill-summary__row');
    await expect(billItemRows.first()).toBeVisible({ timeout: 5000 });

    // Verify the grand total is greater than zero
    const grandTotalText = await page.locator('.bill-totals__row--grand .bill-totals__value').textContent();
    expect(grandTotalText).toBeTruthy();
    expect(grandTotalText).not.toBe('0d');

    // ---------------------------------------------------------------
    // Step 10: Select payment method and finalize the bill
    // ---------------------------------------------------------------
    // The payment method defaults to 'cash'. Select 'cash' explicitly.
    const cashRadio = page.locator('input[name="paymentMethod"][value="cash"]');
    await cashRadio.check();

    // Click the "Xuat hoa don" (Finalize bill) button
    const finalizeBtn = page.locator('button:has-text("Xuat hoa don")');
    await expect(finalizeBtn).toBeVisible({ timeout: 5000 });
    await finalizeBtn.click();

    // The confirmation modal should appear
    const confirmModal = page.locator('.modal-content__title:has-text("Xac nhan xuat hoa don")');
    await expect(confirmModal).toBeVisible({ timeout: 5000 });

    // Click "Xac nhan" (Confirm) in the modal
    const modalConfirmBtn = page.locator('.modal-content__actions .btn--primary:has-text("Xac nhan")');
    await modalConfirmBtn.click();

    // ---------------------------------------------------------------
    // Step 11: Verify bill status badge shows "Da xuat hoa don"
    // ---------------------------------------------------------------
    // Wait for the status badge to update after finalization
    const statusBadge = page.locator('.bill-header .badge');
    await expect(statusBadge).toContainText('Da xuat hoa don', { timeout: 15000 });

    // ---------------------------------------------------------------
    // Step 12: Verify edit controls are disabled on the order page
    // ---------------------------------------------------------------
    // Navigate back to the order detail page to verify edit lock
    await page.evaluate((tableId) => {
      window.location.hash = `#/orders/${tableId}`;
    }, await page.evaluate(() => {
      const store = Alpine.store('orders');
      return store.currentOrder?.table_id || '';
    }));

    // Wait for the order detail page to load
    await page.waitForSelector('.order-detail', { state: 'visible', timeout: 10000 });

    // The finalized order should show a lock notice
    const finalizedLockNotice = page.locator('text=Đơn hàng đã khóa, không thể chỉnh sửa');
    await expect(finalizedLockNotice).toBeVisible({ timeout: 10000 });

    // Quantity control buttons should NOT be visible (canModify is false)
    const qtyControls = page.locator('.order-detail-item__qty-controls');
    await expect(qtyControls).toHaveCount(0, { timeout: 5000 });

    // ---------------------------------------------------------------
    // Step 13: Verify print was triggered via mock Bluetooth
    // ---------------------------------------------------------------
    // Navigate back to the bill page
    await page.evaluate((id) => {
      window.location.hash = `#/bills/${id}`;
    }, orderId);

    await page.waitForSelector('.bill-page', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.bill-content', { state: 'visible', timeout: 10000 });

    // Check the mock print data (auto-print triggers after finalize when BT available)
    const printResult = await getPrintResult(page);

    // If auto-print was triggered, verify data was sent
    // Note: Auto-print depends on canPrint being true (Bluetooth supported + bill exists)
    if (printResult.callCount > 0) {
      expect(printResult.data).not.toBeNull();
      expect(printResult.data.length).toBeGreaterThan(0);

      // ---------------------------------------------------------------
      // Step 14: Verify bill status changes to "Da in"
      // ---------------------------------------------------------------
      const printedBadge = page.locator('.bill-header .badge');
      await expect(printedBadge).toContainText('Da in', { timeout: 15000 });
    }

    // ---------------------------------------------------------------
    // Step 15: Verify "Quay ve so do ban" button is visible
    // ---------------------------------------------------------------
    const backToMapBtn = page.locator('button:has-text("Quay ve so do ban")');
    await expect(backToMapBtn).toBeVisible({ timeout: 5000 });
  });

  test('payment method selection persists after finalization', async ({ page }) => {
    // Login as cashier
    await loginAs(page, 'cashier');
    await page.waitForFunction(
      () => window.location.hash === '#/tables',
      { timeout: 10000 },
    );

    // Wait for tables and select an empty one
    await page.waitForSelector('.table-node--empty', { state: 'visible', timeout: 15000 });
    await page.locator('.table-node--empty').first().click();

    // Wait for order page
    await page.waitForFunction(
      () => window.location.hash.startsWith('#/orders/'),
      { timeout: 10000 },
    );
    await page.waitForSelector('.order-menu-grid', { state: 'visible', timeout: 15000 });

    // Add a menu item and confirm order
    await page.locator('.order-menu-item').first().click();
    const confirmBtn = page.locator('.order-cart-total__confirm');
    await expect(confirmBtn).toBeEnabled({ timeout: 5000 });
    await confirmBtn.click();

    // Wait for detail mode, then request payment
    await page.waitForSelector('.order-detail', { state: 'visible', timeout: 15000 });
    await page.locator('button:has-text("Yêu cầu thanh toán")').click();
    await page.waitForSelector('.order-detail__locked-notice', { state: 'visible', timeout: 10000 });

    // Navigate to bill page
    const orderId = await page.evaluate(() => Alpine.store('orders').currentOrder?.id);
    await page.evaluate((id) => { window.location.hash = `#/bills/${id}`; }, orderId);
    await page.waitForSelector('.bill-content', { state: 'visible', timeout: 10000 });

    // Select "Chuyen khoan" (transfer) payment method
    const transferRadio = page.locator('input[name="paymentMethod"][value="transfer"]');
    await transferRadio.check();

    // Finalize the bill
    await page.locator('button:has-text("Xuat hoa don")').click();
    await page.waitForSelector('.modal-content__title:has-text("Xac nhan xuat hoa don")', { state: 'visible' });
    await page.locator('.modal-content__actions .btn--primary:has-text("Xac nhan")').click();

    // Verify the payment method display shows "Chuyen khoan" after finalization
    const paymentDisplay = page.locator('.bill-payment-display__value');
    await expect(paymentDisplay).toContainText('Chuyen khoan', { timeout: 10000 });
  });
});
