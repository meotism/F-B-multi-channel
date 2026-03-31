// Settings Page - Printer pairing, outlet settings x-data component
//
// Alpine.js component for the settings page. Provides Bluetooth printer
// management: scanning for new printers, listing paired printers with
// per-printer configuration (paper width, encoding, chunk size), and
// actions to select active printer, test print, or remove.
//
// Requirements: 8 (Printer Management)
// Design reference: Section 13 (Printer Store), Section 2.10.8 (Settings Page)

import { bluetoothService, showBluetoothFallback } from '../../services/bluetooth-service.js';
import { supabase } from '../../services/supabase-client.js';
import { DEFAULT_RESERVATION_TIMEOUT_MINUTES } from '../../config.js';

/**
 * Alpine component factory for the settings page.
 * Used as x-data="settingsPage()" in pages/settings.html.
 *
 * @returns {Object} Alpine component data object
 */
export function settingsPage() {
  return {
    // --- Printer management state ---
    printers: [],
    isScanning: false,
    isPrinterLoading: false,
    testPrintingId: null, // ID of printer currently test-printing

    // --- Reservation settings state ---
    reservationTimeout: DEFAULT_RESERVATION_TIMEOUT_MINUTES,

    /**
     * Initialize the component: load printers and reservation settings.
     * Called automatically by Alpine when the component mounts.
     */
    async init() {
      await this.loadPrinters();
      await this.loadReservationSettings();
    },

    /**
     * Load printers from the printer store into local state.
     */
    async loadPrinters() {
      await Alpine.store('printer').loadPrinters();
      this.printers = Alpine.store('printer').printers;
    },

    /**
     * Scan for a Bluetooth printer using the Web Bluetooth API.
     * On success: connects, discovers print characteristic, saves to DB,
     * and reloads the printer list.
     */
    async scanForPrinter() {
      if (this.isScanning) return;
      this.isScanning = true;

      try {
        const device = await bluetoothService.scanForPrinter();
        const server = await bluetoothService.connectToPrinter(device);
        const { writeChar, notifyChar, serviceUUID } =
          await bluetoothService.discoverPrintCharacteristic(server);

        // Save printer info to the store and database
        await Alpine.store('printer').savePrinter(
          device,
          serviceUUID,
          writeChar?.uuid,
        );
        await this.loadPrinters();

        Alpine.store('ui').showToast('Kết nối máy in thành công!', 'success');
      } catch (e) {
        // User cancellation of the Bluetooth picker is not an error
        if (e.name === 'NotFoundError') {
          // User cancelled the device picker -- no toast needed
          return;
        }
        Alpine.store('ui').showToast(
          'Không thể kết nối máy in: ' + e.message,
          'error',
        );
      } finally {
        this.isScanning = false;
      }
    },

    /**
     * Send a simple test receipt to a specific printer.
     * Dynamically imports the ESC/POS builder (if available) and sends
     * basic text via Bluetooth. Falls back to a plain text test if the
     * builder is not yet implemented.
     *
     * @param {string} printerId - UUID of the printer to test
     */
    async testPrint(printerId) {
      if (this.testPrintingId) return;
      this.testPrintingId = printerId;

      try {
        const printer = this.printers.find(p => p.id === printerId);
        if (!printer?.device_info) {
          throw new Error('Không tìm thấy thông tin máy in');
        }

        // Attempt to connect and send test data via Bluetooth
        const device = await bluetoothService.scanForPrinter();
        const server = await bluetoothService.connectToPrinter(device);
        const { writeChar } =
          await bluetoothService.discoverPrintCharacteristic(server);

        // Build a simple test receipt using raw ESC/POS commands
        const encoder = new TextEncoder();
        const init = new Uint8Array([0x1b, 0x40]); // ESC @ (initialize)
        const centerOn = new Uint8Array([0x1b, 0x61, 0x01]); // ESC a 1 (center)
        const boldOn = new Uint8Array([0x1b, 0x45, 0x01]); // ESC E 1 (bold on)
        const boldOff = new Uint8Array([0x1b, 0x45, 0x00]); // ESC E 0 (bold off)
        const leftAlign = new Uint8Array([0x1b, 0x61, 0x00]); // ESC a 0 (left)
        const feedCut = new Uint8Array([0x1d, 0x56, 0x00]); // GS V 0 (full cut)
        const newline = encoder.encode('\n');

        const paperWidth = printer.device_info.paperWidth || 58;
        const charsPerLine = paperWidth === 80 ? 48 : 32;
        const separator = encoder.encode('-'.repeat(charsPerLine) + '\n');

        // Assemble test receipt
        const parts = [
          init,
          centerOn,
          boldOn,
          encoder.encode('TEST PRINT\n'),
          boldOff,
          separator,
          leftAlign,
          encoder.encode('May in: ' + (printer.name || 'Unknown') + '\n'),
          encoder.encode('Khong giay: ' + paperWidth + 'mm\n'),
          encoder.encode('Thoi gian: ' + new Date().toLocaleString('vi-VN') + '\n'),
          separator,
          centerOn,
          encoder.encode('In thu thanh cong!\n'),
          newline,
          newline,
          newline,
          feedCut,
        ];

        // Combine all parts into a single Uint8Array
        const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
        const testData = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          testData.set(part, offset);
          offset += part.length;
        }

        const chunkSize = printer.device_info.chunkSize || 100;
        await bluetoothService.sendPrintData(writeChar, testData, chunkSize);

        Alpine.store('ui').showToast('In thử thành công!', 'success');
      } catch (e) {
        if (e.name === 'NotFoundError') return;
        Alpine.store('ui').showToast(
          'Không thể in thử: ' + e.message,
          'error',
        );
      } finally {
        this.testPrintingId = null;
      }
    },

    /**
     * Remove a printer from the database and local state.
     * If the removed printer was active, auto-selects the next available.
     *
     * @param {string} printerId - UUID of the printer to remove
     */
    async removePrinter(printerId) {
      try {
        await Alpine.store('printer').removePrinter(printerId);
        this.printers = Alpine.store('printer').printers;
        Alpine.store('ui').showToast('Đã xóa máy in', 'success');
      } catch (e) {
        Alpine.store('ui').showToast(
          'Không thể xóa máy in: ' + e.message,
          'error',
        );
      }
    },

    /**
     * Set a printer as the active printer.
     *
     * @param {string} printerId - UUID of the printer to activate
     */
    setActivePrinter(printerId) {
      Alpine.store('printer').setActive(printerId);
    },

    /**
     * Update configuration for a specific printer.
     * Persists to DB and updates local state.
     *
     * @param {string} printerId - UUID of the printer to update
     * @param {string} field - Config field name (e.g., 'paperWidth', 'encoding', 'chunkSize')
     * @param {*} value - New value for the field
     */
    async updatePrinterConfig(printerId, field, value) {
      try {
        // Parse numeric values
        if (field === 'paperWidth' || field === 'chunkSize') {
          value = parseInt(value, 10);
        }
        await Alpine.store('printer').updateConfig(printerId, { [field]: value });
        // Refresh local state
        this.printers = Alpine.store('printer').printers;
      } catch (e) {
        Alpine.store('ui').showToast(
          'Không thể cập nhật cấu hình: ' + e.message,
          'error',
        );
      }
    },

    /**
     * Get the Bluetooth fallback message for unsupported browsers.
     * @returns {string} Vietnamese guidance message
     */
    getBluetoothFallback() {
      return showBluetoothFallback();
    },

    // --- Reservation Settings ---

    /**
     * Load reservation timeout from outlet settings.
     */
    async loadReservationSettings() {
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) return;

        const { data } = await supabase
          .from('outlets')
          .select('settings')
          .eq('id', outletId)
          .single();

        this.reservationTimeout =
          data?.settings?.reservation_timeout_minutes || DEFAULT_RESERVATION_TIMEOUT_MINUTES;
      } catch (err) {
        console.error('[SettingsPage] loadReservationSettings failed:', err);
      }
    },

    /**
     * Save reservation timeout to outlet settings.
     */
    async saveReservationTimeout() {
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) return;

        // Read current settings, merge, update
        const { data: outlet } = await supabase
          .from('outlets')
          .select('settings')
          .eq('id', outletId)
          .single();

        const currentSettings = outlet?.settings || {};
        const newSettings = {
          ...currentSettings,
          reservation_timeout_minutes: this.reservationTimeout,
        };

        const { error } = await supabase
          .from('outlets')
          .update({ settings: newSettings })
          .eq('id', outletId);

        if (error) throw error;

        Alpine.store('ui').showToast('Đã lưu cài đặt đặt hẹn', 'success');
      } catch (err) {
        console.error('[SettingsPage] saveReservationTimeout failed:', err);
        Alpine.store('ui').showToast('Không thể lưu cài đặt: ' + err.message, 'error');
      }
    },
  };
}

// Register as global function so x-data="settingsPage()" works
// when the template is dynamically loaded by the router
window.settingsPage = settingsPage;
