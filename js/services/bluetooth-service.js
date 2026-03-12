// Bluetooth Service - Web Bluetooth API: scan, connect, send ESC/POS
//
// Provides low-level Bluetooth primitives for thermal printer communication,
// a BluetoothConnectionManager class for connection lifecycle with auto-reconnect,
// a printWithRetry() function for reliable print delivery, and
// a showBluetoothFallback() function for browser compatibility guidance.
//
// Requirements: 7 (Web Bluetooth), 8 (Browser compatibility), 9 (Print retry)
// Design reference: Sections 9, 10, 11, 19

// ============================================================
// Known thermal printer service UUIDs
// ============================================================

const PRINTER_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Epson, Star
  '0000ae30-0000-1000-8000-00805f9b34fb', // Xprinter, ZiJiang
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Nordic UART
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Serial port emulation
];

// ============================================================
// Bluetooth Service (Section 9)
// ============================================================

/**
 * Low-level Bluetooth service for scanning, connecting, and sending
 * ESC/POS data to thermal printers via the Web Bluetooth API.
 */
export const bluetoothService = {
  /**
   * Check if the Web Bluetooth API is available in the current browser.
   * @returns {boolean} True if navigator.bluetooth exists
   */
  isWebBluetoothSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  },

  /**
   * Prompt the user to select a Bluetooth printer device.
   * Filters by known thermal printer service UUIDs.
   * @returns {Promise<BluetoothDevice>} The selected device
   */
  async scanForPrinter() {
    return navigator.bluetooth.requestDevice({
      filters: PRINTER_SERVICE_UUIDS.map(uuid => ({ services: [uuid] })),
      optionalServices: PRINTER_SERVICE_UUIDS,
    });
  },

  /**
   * Connect to the GATT server of a Bluetooth device.
   * @param {BluetoothDevice} device - The device to connect to
   * @returns {Promise<BluetoothRemoteGATTServer>} The connected GATT server
   */
  async connectToPrinter(device) {
    const server = await device.gatt.connect();
    return server;
  },

  /**
   * Discover the writable and notify characteristics on the GATT server.
   * Iterates through known printer service UUIDs until a writable
   * characteristic is found.
   * @param {BluetoothRemoteGATTServer} server - The connected GATT server
   * @returns {Promise<{writeChar: BluetoothRemoteGATTCharacteristic, notifyChar: BluetoothRemoteGATTCharacteristic|null, serviceUUID: string}>}
   * @throws {Error} With code 'BT_CHAR_NOT_FOUND' if no writable characteristic found
   */
  async discoverPrintCharacteristic(server) {
    for (const uuid of PRINTER_SERVICE_UUIDS) {
      try {
        const service = await server.getPrimaryService(uuid);
        const chars = await service.getCharacteristics();
        const writeChar = chars.find(c =>
          c.properties.writeWithoutResponse || c.properties.write
        );
        const notifyChar = chars.find(c => c.properties.notify);
        if (writeChar) return { writeChar, notifyChar, serviceUUID: uuid };
      } catch (e) { continue; }
    }
    throw new Error('BT_CHAR_NOT_FOUND');
  },

  /**
   * Send ESC/POS data to the printer in chunks.
   * Uses writeWithoutResponse when available, falls back to writeWithResponse.
   * A 20ms inter-chunk delay prevents buffer overflows on the printer.
   * @param {BluetoothRemoteGATTCharacteristic} writeChar - The writable characteristic
   * @param {Uint8Array} escPosData - The ESC/POS byte data to send
   * @param {number} [chunkSize=100] - Maximum bytes per write operation
   */
  async sendPrintData(writeChar, escPosData, chunkSize = 100) {
    for (let offset = 0; offset < escPosData.length; offset += chunkSize) {
      const chunk = escPosData.slice(offset, offset + chunkSize);
      if (writeChar.properties.writeWithoutResponse) {
        await writeChar.writeValueWithoutResponse(chunk);
      } else {
        await writeChar.writeValueWithResponse(chunk);
      }
      // Inter-chunk delay to prevent printer buffer overflow
      if (offset + chunkSize < escPosData.length) {
        await new Promise(r => setTimeout(r, 20));
      }
    }
  },
};

// ============================================================
// Bluetooth Connection Manager (Section 10)
// ============================================================

/**
 * Manages the lifecycle of a Bluetooth printer connection including
 * automatic reconnection with exponential backoff on disconnect.
 */
export class BluetoothConnectionManager {
  constructor() {
    /** @type {BluetoothDevice|null} */
    this.device = null;
    /** @type {BluetoothRemoteGATTServer|null} */
    this.server = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this.writeChar = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this.notifyChar = null;
    /** @type {boolean} */
    this.isConnected = false;
    /** @type {number} */
    this.reconnectAttempts = 0;
    /** @type {number} */
    this.maxReconnectAttempts = 3;
  }

  /**
   * Connect to a Bluetooth printer device.
   * Performs GATT connection, discovers print characteristics, and registers
   * a disconnect listener for automatic reconnection.
   * @param {BluetoothDevice} device - The device to connect to
   * @returns {Promise<{serviceUUID: string}>} The discovered service UUID
   */
  async connect(device) {
    this.device = device;
    this.server = await bluetoothService.connectToPrinter(device);
    const { writeChar, notifyChar, serviceUUID } =
      await bluetoothService.discoverPrintCharacteristic(this.server);
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;
    this.isConnected = true;
    this.reconnectAttempts = 0;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    return { serviceUUID };
  }

  /**
   * Handle unexpected disconnection.
   * Sets isConnected to false and triggers automatic reconnection.
   */
  onDisconnected() {
    this.isConnected = false;
    this.autoReconnect();
  }

  /**
   * Attempt to reconnect with exponential backoff.
   * Delays: 2s, 4s, 8s (2^attempt * 1000ms). Max 3 attempts.
   * Shows a toast notification on final failure if Alpine UI store is available.
   */
  async autoReconnect() {
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.pow(2, this.reconnectAttempts) * 1000; // 2s, 4s, 8s
      await new Promise(r => setTimeout(r, delay));
      try {
        await this.connect(this.device);
        return;
      } catch (e) { /* continue retry */ }
    }
    // Notify user of permanent disconnection via Alpine UI store (if available)
    if (typeof Alpine !== 'undefined' && Alpine.store('ui')) {
      Alpine.store('ui').showToast('Mat ket noi may in. Vui long ket noi lai.', 'error');
    }
  }

  /**
   * Gracefully disconnect from the Bluetooth printer.
   */
  disconnect() {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.isConnected = false;
  }
}

// ============================================================
// Print Retry Logic (Section 11)
// ============================================================

/**
 * Print ESC/POS data with exponential backoff retry on failure.
 * Retry delays: 1s, 2s, 4s (2^(attempt-1) * 1000ms).
 *
 * @param {BluetoothRemoteGATTCharacteristic} writeChar - The writable characteristic
 * @param {Uint8Array} escPosData - The ESC/POS byte data to send
 * @param {number} [chunkSize=100] - Maximum bytes per write operation
 * @param {number} [maxRetries=3] - Maximum number of attempts
 * @returns {Promise<{success: boolean, error?: string, message?: string, attempts?: number}>}
 */
export async function printWithRetry(writeChar, escPosData, chunkSize = 100, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bluetoothService.sendPrintData(writeChar, escPosData, chunkSize);
      return { success: true };
    } catch (e) {
      if (attempt === maxRetries) {
        return { success: false, error: 'BT_PRINT_FAILED', message: e.message, attempts: attempt };
      }
      const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ============================================================
// Browser Compatibility Detection (Section 19)
// ============================================================

/**
 * Detect browser compatibility with Web Bluetooth API and return
 * a Vietnamese guidance message for unsupported browsers.
 *
 * @returns {string} Vietnamese fallback message for the detected browser
 */
export function showBluetoothFallback() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) {
    return 'iOS khong ho tro Web Bluetooth. Vui long su dung Android Chrome hoac Chrome tren may tinh.';
  }
  if (/Firefox/.test(ua)) {
    return 'Firefox khong ho tro Web Bluetooth. Vui long su dung Chrome.';
  }
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) {
    return 'Safari tren macOS khong ho tro Web Bluetooth. Vui long su dung Chrome.';
  }
  return 'Trinh duyet cua ban khong ho tro Web Bluetooth. Vui long su dung Google Chrome.';
}

export { PRINTER_SERVICE_UUIDS };
