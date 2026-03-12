// Printer Store - Alpine.store('printer'): printer list, active printer, connection state
//
// Pure state manager for Bluetooth printer persistence and selection.
// Bluetooth connection logic (BluetoothConnectionManager) will be wired in Task 9.
// Registered as Alpine.store('printer') in app.js.
//
// Requirements: 8 (Printer Management)
// Design reference: Section 13 (Printer Store)

import {
  loadPrinters,
  deletePrinter,
  updateLastSeen,
  savePrinterInfo,
  updatePrinterConfig,
} from '../services/printer-service.js';

export function printerStore() {
  return {
    printers: [],            // All saved printers for the current outlet
    activePrinterId: null,   // UUID of the currently selected printer
    isConnected: false,      // Whether the active printer is connected (managed externally)
    lastPrinterInfo: null,   // Last paired device info for quick reconnection

    /**
     * Computed getter: returns the full printer record for the active printer,
     * or null if no printer is selected.
     */
    get activePrinter() {
      return this.printers.find(p => p.id === this.activePrinterId) || null;
    },

    /**
     * Check if the Web Bluetooth API is supported in the current browser.
     * @returns {boolean}
     */
    isBluetoothSupported() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    },

    /**
     * Load all printers for the current outlet from the database.
     * Auto-selects the first printer if none is currently active.
     */
    async loadPrinters() {
      const outletId = Alpine.store('outlet').currentOutlet?.id;
      if (!outletId) return;

      try {
        this.printers = await loadPrinters(outletId);
        // Auto-select the first printer if none is active
        if (this.printers.length && !this.activePrinterId) {
          this.activePrinterId = this.printers[0].id;
        }
      } catch (e) {
        console.error('[printer-store] Failed to load printers:', e);
      }
    },

    /**
     * Set the active printer. Resets connection state since the connection
     * manager will need to reconnect to the new device.
     *
     * @param {string} printerId - UUID of the printer to activate
     */
    setActive(printerId) {
      this.activePrinterId = printerId;
      this.isConnected = false; // Connection will be re-established by connection manager
    },

    /**
     * Get the configuration for the active printer.
     * Returns sensible defaults if no printer is selected or device_info is missing.
     *
     * @returns {{ paperWidth: number, encoding: string, chunkSize: number }}
     */
    getActivePrinterConfig() {
      const p = this.activePrinter;
      if (!p?.device_info) {
        return { paperWidth: 58, encoding: 'cp1258', chunkSize: 100 };
      }
      return {
        paperWidth: p.device_info.paperWidth || 58,
        encoding: p.device_info.encoding || 'cp1258',
        chunkSize: p.device_info.chunkSize || 100,
      };
    },

    /**
     * Remove a printer from the database and local state.
     * If the removed printer was active, auto-selects the next available printer.
     *
     * @param {string} printerId - UUID of the printer to remove
     */
    async removePrinter(printerId) {
      await deletePrinter(printerId);
      this.printers = this.printers.filter(p => p.id !== printerId);
      if (this.activePrinterId === printerId) {
        this.activePrinterId = this.printers[0]?.id || null;
        this.isConnected = false;
      }
    },

    /**
     * Update the configuration for a specific printer (paper width, encoding, chunk size).
     * Persists to DB and updates local state.
     *
     * @param {string} printerId - UUID of the printer to update
     * @param {Object} config - Configuration fields to update
     */
    async updateConfig(printerId, config) {
      await updatePrinterConfig(printerId, config);
      const printer = this.printers.find(p => p.id === printerId);
      if (printer) {
        printer.device_info = { ...printer.device_info, ...config };
      }
    },

    /**
     * Save a newly paired printer to the database and add it to the local list.
     * Sets the new printer as active.
     *
     * @param {BluetoothDevice} device - Web Bluetooth device object
     * @param {string} serviceUUID - GATT service UUID
     * @param {string} characteristicUUID - GATT characteristic UUID
     * @param {Object} [config={}] - Optional printer configuration
     * @returns {Promise<Object>} The saved printer record
     */
    async savePrinter(device, serviceUUID, characteristicUUID, config = {}) {
      const outletId = Alpine.store('outlet').currentOutlet?.id;
      if (!outletId) {
        throw new Error('Không có thông tin cửa hàng');
      }

      const saved = await savePrinterInfo(device, serviceUUID, characteristicUUID, outletId, config);
      this.lastPrinterInfo = saved;

      // Update local list: replace existing or add new
      const existingIndex = this.printers.findIndex(p => p.id === saved.id);
      if (existingIndex >= 0) {
        this.printers[existingIndex] = saved;
      } else {
        this.printers.unshift(saved);
      }

      this.activePrinterId = saved.id;
      return saved;
    },

    /**
     * Update the last_seen timestamp for a printer (called on each connection).
     *
     * @param {string} printerId - UUID of the printer
     */
    async touchLastSeen(printerId) {
      try {
        await updateLastSeen(printerId);
      } catch (e) {
        console.error('[printer-store] Failed to update last_seen:', e);
      }
    },
  };
}
