// Printer Service - Printer CRUD (save/load from DB)
//
// Provides functions to save, load, delete, and update printer records in
// the `printers` table. Each printer stores Bluetooth device info (service UUID,
// characteristic UUID, paper width, encoding, chunk size) as a JSONB column.
// All operations use direct PostgREST via the Supabase client.
// RLS policies enforce outlet isolation.
//
// Requirements: 8 (Printer Management)
// Design reference: Section 12 (Printer Service)

import { supabase } from './supabase-client.js';
import { printWithRetry } from './bluetooth-service.js';

// ---------------------------------------------------------------------------
// Print Queue (Task 4.10)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

/**
 * In-memory print queue. Each entry contains the bill ID, ESC/POS data,
 * and the current retry count.
 * @type {Array<{ billId: string, escposData: Uint8Array, retries: number }>}
 */
const printQueue = [];

/** Whether the queue processor is currently running. */
let isProcessing = false;

/**
 * Add a print job to the queue and trigger processing.
 *
 * @param {string} billId - UUID of the bill being printed
 * @param {Uint8Array} escposData - Pre-built ESC/POS byte data
 */
export function enqueuePrint(billId, escposData) {
  printQueue.push({ billId, escposData, retries: 0 });
  processPrintQueue();
}

/**
 * Process the print queue sequentially. For each item, attempts to send
 * data via the connected Bluetooth printer. On failure, increments the retry
 * counter; removes the item on success or after MAX_RETRIES failures.
 */
export async function processPrintQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (printQueue.length > 0) {
      const job = printQueue[0];

      // Obtain the write characteristic from the printer store
      const writeChar = _getWriteCharacteristic();
      if (!writeChar) {
        // No connected printer — show toast and stop processing
        _showToast('Không có máy in được kết nối. Vui lòng kết nối máy in.', 'error');
        break;
      }

      const result = await printWithRetry(writeChar, job.escposData);

      if (result.success) {
        printQueue.shift(); // Remove completed job
      } else {
        job.retries++;
        if (job.retries >= MAX_RETRIES) {
          printQueue.shift(); // Remove after max retries
          _showToast('In thất bại sau 3 lần thử', 'error');
          console.error(`[PrinterService] Print failed for bill ${job.billId} after ${MAX_RETRIES} retries`);
        }
        // On failure but below max retries, the job stays at the front for next attempt
      }
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * Get the current number of jobs in the print queue.
 * @returns {number}
 */
export function getPrintQueueLength() {
  return printQueue.length;
}

/**
 * Retrieve the active Bluetooth write characteristic from the Alpine printer store.
 * Returns null if no printer is connected.
 *
 * @returns {BluetoothRemoteGATTCharacteristic|null}
 * @private
 */
function _getWriteCharacteristic() {
  if (typeof Alpine !== 'undefined' && Alpine.store('printer')) {
    const store = Alpine.store('printer');
    // The connection manager exposes writeChar when connected
    if (store.isConnected && store._connectionManager?.writeChar) {
      return store._connectionManager.writeChar;
    }
  }
  return null;
}

/**
 * Show a toast notification via Alpine UI store if available, otherwise log.
 *
 * @param {string} message - Vietnamese message to display
 * @param {string} type - Toast type ('error', 'warning', 'success')
 * @private
 */
function _showToast(message, type) {
  if (typeof Alpine !== 'undefined' && Alpine.store('ui')) {
    Alpine.store('ui').showToast(message, type);
  } else {
    console.warn(`[PrinterService] ${type}: ${message}`);
  }
}

/**
 * Save or update printer information in the database.
 * Upserts on the (outlet_id, name) unique constraint so that reconnecting
 * the same physical device updates the existing record rather than creating
 * a duplicate.
 *
 * @param {BluetoothDevice} device - Web Bluetooth device object (needs .name)
 * @param {string} serviceUUID - GATT service UUID used for printing
 * @param {string} characteristicUUID - GATT characteristic UUID used for writing
 * @param {string} outletId - UUID of the outlet this printer belongs to
 * @param {Object} [config={}] - Optional printer configuration overrides
 * @param {number} [config.paperWidth=58] - Paper width in mm (58 or 80)
 * @param {string} [config.encoding='cp1258'] - Character encoding (cp1258, tcvn3, utf8)
 * @param {number} [config.chunkSize=100] - BLE chunk size in bytes
 * @returns {Promise<Object>} The saved printer record
 * @throws {Error} With Vietnamese message on failure
 */
export async function savePrinterInfo(device, serviceUUID, characteristicUUID, outletId, config = {}) {
  const deviceInfo = {
    deviceName: device.name,
    serviceUUID,
    characteristicUUID,
    paperWidth: config.paperWidth || 58,
    encoding: config.encoding || 'cp1258',
    chunkSize: config.chunkSize || 100,
  };

  const { data, error } = await supabase
    .from('printers')
    .upsert(
      {
        outlet_id: outletId,
        name: device.name,
        device_info: deviceInfo,
        last_seen: new Date().toISOString(),
      },
      { onConflict: 'outlet_id,name' },
    )
    .select()
    .single();

  if (error) {
    throw new Error('Không thể lưu thông tin máy in: ' + error.message);
  }

  return data;
}

/**
 * Load all printers for a given outlet, ordered by most recently seen first.
 *
 * @param {string} outletId - UUID of the outlet
 * @returns {Promise<Array<Object>>} Array of printer records
 * @throws {Error} With Vietnamese message on failure
 */
export async function loadPrinters(outletId) {
  const { data, error } = await supabase
    .from('printers')
    .select('*')
    .eq('outlet_id', outletId)
    .order('last_seen', { ascending: false });

  if (error) {
    throw new Error('Không thể tải danh sách máy in: ' + error.message);
  }

  return data || [];
}

/**
 * Delete a printer record by its ID.
 *
 * @param {string} printerId - UUID of the printer to delete
 * @returns {Promise<void>}
 * @throws {Error} With Vietnamese message on failure
 */
export async function deletePrinter(printerId) {
  const { error } = await supabase
    .from('printers')
    .delete()
    .eq('id', printerId);

  if (error) {
    throw new Error('Không thể xóa máy in: ' + error.message);
  }
}

/**
 * Update the last_seen timestamp for a printer (called on each connection).
 *
 * @param {string} printerId - UUID of the printer to update
 * @returns {Promise<void>}
 * @throws {Error} With Vietnamese message on failure
 */
export async function updateLastSeen(printerId) {
  const { error } = await supabase
    .from('printers')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', printerId);

  if (error) {
    throw new Error('Không thể cập nhật thời gian kết nối máy in: ' + error.message);
  }
}

/**
 * Update printer configuration (paper width, encoding, chunk size).
 * Merges the provided config into the existing device_info JSONB column.
 *
 * @param {string} printerId - UUID of the printer to update
 * @param {Object} config - Configuration fields to update
 * @param {number} [config.paperWidth] - Paper width in mm (58 or 80)
 * @param {string} [config.encoding] - Character encoding (cp1258, tcvn3, utf8)
 * @param {number} [config.chunkSize] - BLE chunk size in bytes
 * @returns {Promise<Object>} The updated printer record
 * @throws {Error} With Vietnamese message on failure
 */
export async function updatePrinterConfig(printerId, config) {
  // First fetch current device_info to merge with new config
  const { data: current, error: fetchError } = await supabase
    .from('printers')
    .select('device_info')
    .eq('id', printerId)
    .single();

  if (fetchError) {
    throw new Error('Không thể tải cấu hình máy in: ' + fetchError.message);
  }

  const updatedDeviceInfo = {
    ...current.device_info,
    ...config,
  };

  const { data, error } = await supabase
    .from('printers')
    .update({ device_info: updatedDeviceInfo })
    .eq('id', printerId)
    .select()
    .single();

  if (error) {
    throw new Error('Không thể cập nhật cấu hình máy in: ' + error.message);
  }

  return data;
}
