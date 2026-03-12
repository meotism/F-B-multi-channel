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
