// ESC/POS Service - ESC/POS byte formatting for bill data
//
// Provides EscPosBuilder for constructing ESC/POS command sequences and
// buildBillEscPos() for generating complete bill receipt byte data.
// All commands return `this` for method chaining. Call build() to get the
// final Uint8Array for sending to a thermal printer via Bluetooth.
//
// Requirements: 6 (AC-1 through AC-6)
// Design reference: Sections 6 (EscPosBuilder), 8 (Bill Print Template)

import { encodeVietnamese } from './escpos-encoder.js';

// ============================================================
// EscPosBuilder Class
// ============================================================

/**
 * Fluent builder for ESC/POS command byte sequences.
 * Supports 58mm (32 chars/line) and 80mm (48 chars/line) paper widths.
 *
 * @example
 *   const data = new EscPosBuilder({ paperWidth: 58 })
 *     .initialize()
 *     .alignCenter().boldOn().fontDoubleWH()
 *     .textLine('My Restaurant')
 *     .fontNormal().boldOff()
 *     .separator('=')
 *     .cutPaper(true)
 *     .build();
 */
export class EscPosBuilder {
  /**
   * @param {Object} [config={}]
   * @param {number} [config.paperWidth=58] - Paper width in mm (58 or 80)
   * @param {string} [config.encoding='cp1258'] - Vietnamese codepage ('cp1258', 'tcvn3', or 'utf8')
   * @param {number} [config.chunkSize=100] - BLE chunk size in bytes
   */
  constructor(config = {}) {
    this.paperWidth = config.paperWidth || 58;
    this.encoding = config.encoding || 'cp1258';
    this.chunkSize = config.chunkSize || 100;
    this.charsPerLine = this.paperWidth === 80 ? 48 : 32;
    this.buffer = [];
  }

  // --- Printer initialization ---

  /** ESC @ — Initialize printer, reset to default settings */
  initialize() { this.buffer.push(0x1B, 0x40); return this; }

  // --- Text alignment ---

  /** ESC a 0 — Align text left */
  alignLeft() { this.buffer.push(0x1B, 0x61, 0x00); return this; }

  /** ESC a 1 — Align text center */
  alignCenter() { this.buffer.push(0x1B, 0x61, 0x01); return this; }

  /** ESC a 2 — Align text right */
  alignRight() { this.buffer.push(0x1B, 0x61, 0x02); return this; }

  // --- Font size ---

  /** GS ! 0 — Normal font size */
  fontNormal() { this.buffer.push(0x1D, 0x21, 0x00); return this; }

  /** GS ! 1 — Double height font */
  fontDoubleH() { this.buffer.push(0x1D, 0x21, 0x01); return this; }

  /** GS ! 16 — Double width font */
  fontDoubleW() { this.buffer.push(0x1D, 0x21, 0x10); return this; }

  /** GS ! 17 — Double width and height font */
  fontDoubleWH() { this.buffer.push(0x1D, 0x21, 0x11); return this; }

  // --- Bold ---

  /** ESC E 1 — Enable bold */
  boldOn() { this.buffer.push(0x1B, 0x45, 0x01); return this; }

  /** ESC E 0 — Disable bold */
  boldOff() { this.buffer.push(0x1B, 0x45, 0x00); return this; }

  // --- Paper feeding and cutting ---

  /**
   * ESC d n — Feed n lines
   * @param {number} n - Number of lines to feed
   */
  feedLines(n) { this.buffer.push(0x1B, 0x64, n); return this; }

  /**
   * GS V — Cut paper
   * @param {boolean} [partial=false] - true for partial cut, false for full cut
   */
  cutPaper(partial = false) { this.buffer.push(0x1D, 0x56, partial ? 0x01 : 0x00); return this; }

  // --- Vietnamese codepage ---

  /**
   * ESC t n — Set character code table for Vietnamese printing.
   * CP1258 = codepage 47 (0x2F), TCVN-3 = codepage 30 (0x1E).
   * @param {string} [codepage] - 'tcvn3' or 'cp1258' (default uses this.encoding)
   */
  setVietnamese(codepage) {
    const cp = (codepage || this.encoding) === 'tcvn3' ? 0x1E : 0x2F;
    this.buffer.push(0x1B, 0x74, cp);
    return this;
  }

  // --- Text output ---

  /**
   * Encode and append a text string using the configured Vietnamese codepage.
   * @param {string} str - Text to encode and append
   */
  text(str) {
    const bytes = encodeVietnamese(str, this.encoding);
    this.buffer.push(...bytes);
    return this;
  }

  /**
   * Encode and append a text string followed by a newline.
   * @param {string} str - Text to encode and append
   */
  textLine(str) { return this.text(str + '\n'); }

  /**
   * Print a separator line (e.g., dashes or equals signs).
   * @param {string} [char='-'] - Character to repeat
   * @param {number} [width] - Line width (defaults to charsPerLine)
   */
  separator(char = '-', width) {
    const w = width || this.charsPerLine;
    return this.textLine(char.repeat(w));
  }

  // --- Barcode ---

  /**
   * GS k — Print CODE128 barcode.
   * @param {string} data - Barcode data string
   */
  barcode(data) {
    // CODE128 barcode: GS k 73 (length+2) { B (data bytes)
    this.buffer.push(0x1D, 0x6B, 0x49, data.length + 2, 0x7B, 0x42);
    for (let i = 0; i < data.length; i++) {
      this.buffer.push(data.charCodeAt(i));
    }
    return this;
  }

  // --- Raw bytes and build ---

  /**
   * Append raw byte values directly to the buffer.
   * @param {number[]} bytes - Array of byte values
   */
  raw(bytes) { this.buffer.push(...bytes); return this; }

  /**
   * Build the final ESC/POS byte data as a Uint8Array.
   * @returns {Uint8Array} Complete ESC/POS command sequence
   */
  build() { return new Uint8Array(this.buffer); }

  /**
   * Clear the internal buffer for reuse.
   * @returns {EscPosBuilder} this (for chaining)
   */
  reset() { this.buffer = []; return this; }
}

// ============================================================
// Bill Print Template Helper Functions
// ============================================================

/**
 * Format a bill code as 'HD' + 6 digits, derived deterministically from
 * the bill UUID. Mirrors the `billCode` getter in bill-page.js so screen
 * and print show the same code. Replace with a per-outlet sequence later
 * if accounting requires monotonic numbering.
 * @param {Object} bill - Bill record with id field
 * @returns {string} Formatted bill code (e.g., "HD036175")
 */
function formatBillCode(bill) {
  if (!bill || !bill.id) return 'HD000000';
  const hex = bill.id.replace(/-/g, '').slice(0, 6);
  const num = parseInt(hex, 16) % 1_000_000;
  return 'HD' + String(num).padStart(6, '0');
}

/**
 * Format a timestamp for display on the receipt.
 * @param {string} timestamp - ISO timestamp string
 * @returns {string} Formatted date/time (e.g., "12/03/2026 14:30")
 */
function formatDateTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

/**
 * Format an amount as Vietnamese Dong for receipt printing.
 * Simple number formatting with dot as thousands separator (no dependency on utils).
 * @param {number} amount - Amount in VND
 * @returns {string} Formatted amount (e.g., "150.000")
 */
function formatVND(amount) {
  if (amount == null || isNaN(amount)) return '0';
  const rounded = Math.round(amount);
  // Build thousands-separated string using dots
  const str = String(Math.abs(rounded));
  let result = '';
  for (let i = str.length - 1, count = 0; i >= 0; i--, count++) {
    if (count > 0 && count % 3 === 0) result = '.' + result;
    result = str[i] + result;
  }
  return rounded < 0 ? '-' + result : result;
}

/**
 * Format a payment method enum value to Vietnamese display text.
 * @param {string} method - Payment method: 'cash', 'card', or 'transfer'
 * @returns {string} Vietnamese label
 */
function formatPaymentMethod(method) {
  const labels = {
    cash: 'Tien mat',
    card: 'The',
    transfer: 'Chuyen khoan',
  };
  return labels[method] || method || '';
}

/**
 * Calculate and format the duration between two timestamps.
 * @param {string} startedAt - ISO timestamp of order start
 * @param {string} endedAt - ISO timestamp of order end (finalization)
 * @returns {string} Formatted duration (e.g., "01:30:00")
 */
function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '00:00:00';
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Format a row with columns for the item list: name, quantity, unit price, total.
 * Distributes available width across columns with fixed widths for qty/price/total.
 * @param {string} name - Item name (variable width, left-aligned)
 * @param {string} qty - Quantity string (right-aligned, 3 chars)
 * @param {string} price - Unit price string (right-aligned, 7 chars)
 * @param {string} total - Line total string (right-aligned, 8 chars)
 * @param {number} width - Total line width in characters
 * @returns {string} Formatted column row
 */
function padColumns(name, qty, price, total, width) {
  // Fixed column widths: qty=3, price=7, total=8, spaces=3 (between columns)
  const fixedWidth = 3 + 7 + 8 + 3; // 21 chars for fixed columns + spacing
  const nameWidth = width - fixedWidth;
  const paddedName = name.length > nameWidth
    ? name.substring(0, nameWidth)
    : name.padEnd(nameWidth);
  const paddedQty = qty.padStart(3);
  const paddedPrice = price.padStart(7);
  const paddedTotal = total.padStart(8);
  return `${paddedName} ${paddedQty} ${paddedPrice} ${paddedTotal}`;
}

/**
 * Format a label-value pair, right-aligning the value within the line width.
 * @param {string} label - Left-aligned label text
 * @param {string} value - Right-aligned value text
 * @param {number} width - Total line width in characters
 * @returns {string} Formatted label:value row
 */
function padRight(label, value, width) {
  const valueStr = String(value);
  const available = width - label.length;
  if (available <= 0) return label;
  return label + valueStr.padStart(available);
}

/**
 * Place two strings on one line, the first left-aligned, the second right-aligned.
 * Truncates the right value to fit if the combined length exceeds the width.
 * @param {string} left - Left-aligned text
 * @param {string} right - Right-aligned text
 * @param {number} width - Total line width in characters
 * @returns {string} Formatted left / right row
 */
function padBetween(left, right, width) {
  const leftStr = String(left);
  const rightStr = String(right);
  const space = width - leftStr.length - rightStr.length;
  if (space <= 0) return (leftStr + ' ' + rightStr).slice(0, width);
  return leftStr + ' '.repeat(space) + rightStr;
}

/**
 * Truncate a string to a maximum length, appending '..' if truncated.
 * @param {string} str - String to truncate
 * @param {number} maxLen - Maximum allowed length
 * @returns {string} Truncated string
 */
function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 2) + '..';
}

// ============================================================
// Bill Print Template
// ============================================================

/**
 * Build ESC/POS bytes for a bill receipt.
 * Produces a complete thermal receipt matching the on-screen receipt layout:
 * shop header (name/address/phone), title + bill code, table tag + time row,
 * item table, totals (Tổng tiền hàng / Chiết khấu / Tổng cộng), payment lines
 * (cash → Tiền khách đưa + Tiền thừa; transfer → Chuyển khoản), footer, cut.
 *
 * @param {Object} bill - Bill record (id, total, tax, discount_amount, hourly_charge, duration_seconds, payment_method, finalized_at)
 * @param {Object} outlet - Outlet record (name, address, settings.phone)
 * @param {Object} order - Order record (started_at)
 * @param {Array<{name: string, quantity: number, price: number, note?: string}>} orderItems - Order items
 * @param {Object} table - Table record (name)
 * @param {string} staffName - Name of the staff who served (kept for future use)
 * @param {Object} printerConfig - Printer configuration { paperWidth, encoding, chunkSize }
 * @param {Object} [paymentInfo={}] - Cashier-flow values { cashTendered, changeAmount }
 * @returns {Uint8Array} ESC/POS byte data ready to send to printer
 */
export function buildBillEscPos(bill, outlet, order, orderItems, table, staffName, printerConfig, paymentInfo = {}) {
  const b = new EscPosBuilder(printerConfig);
  const w = b.charsPerLine;
  const phone = outlet?.settings?.phone || '';
  const cashTendered = Number(paymentInfo.cashTendered) || 0;
  const changeAmount = Number(paymentInfo.changeAmount) || 0;
  const grandTotal = (bill.total || 0) + (bill.tax || 0) + (bill.hourly_charge || 0);
  const discount = bill.discount_amount || 0;

  b.initialize()
   .setVietnamese(printerConfig.encoding)
   // Header: shop name centered, bold, double size
   .alignCenter().boldOn().fontDoubleWH()
   .textLine(outlet?.name || '')
   .fontNormal().boldOff();

  if (outlet?.address) b.textLine('ĐC: ' + outlet.address);
  if (phone) b.textLine('ĐT: ' + phone);

  b.separator('=', w)
   // Title + bill code
   .alignCenter().boldOn()
   .textLine('PHIẾU TÍNH TIỀN')
   .boldOff()
   .textLine(formatBillCode(bill))
   .separator('-', w)
   // Table tag + Giờ vào / Giờ ra row
   .alignLeft().boldOn()
   .textLine('[Bàn ' + (table?.name || '?') + ']')
   .boldOff()
   .textLine(padBetween(
     'Giờ vào: ' + formatDateTime(order?.started_at),
     'Giờ ra: ' + (bill.finalized_at ? formatDateTime(bill.finalized_at) : '(Giờ):(Phút)'),
     w,
   ))
   .separator('-', w)
   // Column headers: Tên hàng | Đ.Giá | SL | Thành tiền
   .boldOn()
   .textLine(padColumns('Tên hàng', 'Đ.Giá', 'SL', 'TT', w))
   .boldOff()
   .separator('-', w);

  // Items: column order matches headers (name, price, qty, line total)
  for (const item of orderItems) {
    const lineTotal = item.price * item.quantity;
    b.textLine(padColumns(
      truncate(item.name, w - 18),
      formatVND(item.price),
      String(item.quantity),
      formatVND(lineTotal),
      w,
    ));
    if (item.note) {
      b.textLine('  * ' + truncate(item.note, w - 4));
    }
  }

  // Hourly charge line (billiard/pool tables)
  if (bill.hourly_charge && bill.hourly_charge > 0) {
    const durationSecs = bill.duration_seconds || 0;
    const dh = Math.floor(durationSecs / 3600);
    const dm = Math.floor((durationSecs % 3600) / 60);
    const durStr = dh > 0 ? `${dh}h${dm}p` : `${dm}p`;
    b.textLine(padRight(`Phí giờ (${durStr}):`, formatVND(bill.hourly_charge), w));
  }

  b.separator('-', w)
   // Totals
   .textLine(padRight('Tổng tiền hàng:', formatVND(bill.total), w))
   .textLine(padRight('Chiết khấu:', formatVND(discount), w))
   .boldOn().fontDoubleH()
   .textLine(padRight('Tổng cộng:', formatVND(grandTotal), w))
   .fontNormal().boldOff();

  // Payment lines
  if (bill.payment_method === 'cash') {
    b.textLine(padRight('Tiền Khách Đưa:', formatVND(cashTendered), w))
     .textLine(padRight('Tiền Thừa trả Khách:', formatVND(changeAmount), w));
  } else if (bill.payment_method === 'transfer') {
    b.textLine(padRight('Chuyển khoản:', formatVND(grandTotal), w));
  } else {
    b.textLine(padRight('Thanh toán:', formatPaymentMethod(bill.payment_method), w));
  }

  b.separator('=', w)
   // Footer
   .alignCenter()
   .textLine('Cám Ơn & Hẹn Gặp Lại!!!')
   .textLine('')
   .textLine('Made by Meotism\u{1F495}')
   .textLine('')
   .barcode(formatBillCode(bill))
   .feedLines(3)
   .cutPaper(true);

  return b.build();
}
