// Bluetooth Mock Fixture for E2E Tests
//
// Injects a mock Web Bluetooth API into the page context so that
// Bluetooth-dependent flows (bill printing) can be tested without
// a physical printer. Captures all print data for assertion.
//
// Usage:
//   import { mockWebBluetooth } from './fixtures/bluetooth-mock.js';
//   test('print flow', async ({ page }) => {
//     await mockWebBluetooth(page);
//     // ... test steps that trigger printing ...
//     const printData = await page.evaluate(() => window.__lastPrintData);
//     expect(printData).not.toBeNull();
//   });
//
// Design reference: Section 9.3 Key E2E Scenarios (Bluetooth mock)

/**
 * Inject a mock Web Bluetooth API into the page before any scripts run.
 * The mock simulates a successful Bluetooth printer connection and
 * captures all data sent via writeValueWithoutResponse / writeValueWithResponse.
 *
 * After injection, the following globals are available in page context:
 * - window.__lastPrintData: Array<number> — all bytes sent to the printer
 * - window.__printCallCount: number — number of write calls made
 * - window.__mockPrinterConnected: boolean — whether the mock device is connected
 *
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<void>}
 */
export async function mockWebBluetooth(page) {
  await page.addInitScript(() => {
    // Globals for test assertions
    window.__lastPrintData = null;
    window.__printCallCount = 0;
    window.__mockPrinterConnected = false;

    // Mock GATT characteristic (ESC/POS data sink)
    const mockCharacteristic = {
      properties: { writeWithoutResponse: true, notify: true, write: false },

      writeValueWithoutResponse: async (data) => {
        const bytes = Array.from(new Uint8Array(data));
        if (!window.__lastPrintData) window.__lastPrintData = [];
        window.__lastPrintData.push(...bytes);
        window.__printCallCount++;
      },

      writeValueWithResponse: async (data) => {
        const bytes = Array.from(new Uint8Array(data));
        if (!window.__lastPrintData) window.__lastPrintData = [];
        window.__lastPrintData.push(...bytes);
        window.__printCallCount++;
      },

      startNotifications: async () => {},
      addEventListener: () => {},
      uuid: '0000ae30-0000-1000-8000-00805f9b34fb',
    };

    // Mock GATT service
    const mockService = {
      getCharacteristics: async () => [mockCharacteristic],
    };

    // Mock GATT server
    const mockServer = {
      getPrimaryService: async () => mockService,
      connected: true,
    };

    // Mock Bluetooth device
    const mockDevice = {
      name: 'MockPrinter-BT',
      gatt: {
        connect: async () => {
          window.__mockPrinterConnected = true;
          return mockServer;
        },
        connected: true,
        disconnect: () => {
          window.__mockPrinterConnected = false;
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    // Override navigator.bluetooth
    navigator.bluetooth = {
      requestDevice: async () => mockDevice,
      getAvailability: async () => true,
    };
  });
}

/**
 * Retrieve print data captured by the mock Bluetooth API.
 *
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<{ data: number[] | null, callCount: number }>}
 */
export async function getPrintResult(page) {
  return page.evaluate(() => ({
    data: window.__lastPrintData,
    callCount: window.__printCallCount,
  }));
}

/**
 * Reset the captured print data and call counter.
 * Useful when testing multiple print actions in a single test.
 *
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<void>}
 */
export async function resetPrintData(page) {
  await page.evaluate(() => {
    window.__lastPrintData = null;
    window.__printCallCount = 0;
  });
}
