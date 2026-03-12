// Unit tests for escpos-service - EscPosBuilder and buildBillEscPos
//
// Tests ESC/POS command byte sequences, chaining, buffer management,
// paper width configuration, and bill print template output.
//
// Usage (Node >= 18):
//   node js/tests/escpos-service.test.js

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as bill-service.test.js)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertArrayEquals(actual, expected, message) {
  const match = actual.length === expected.length &&
    actual.every((v, i) => v === expected[i]);
  if (match) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    expected: [${expected.map(b => '0x' + b.toString(16).toUpperCase()).join(', ')}]`);
    console.error(`    actual:   [${actual.map(b => '0x' + b.toString(16).toUpperCase()).join(', ')}]`);
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ---------------------------------------------------------------------------
// Inline EscPosBuilder (avoid import/module issues across envs)
// ---------------------------------------------------------------------------

// Simplified encodeVietnamese for testing (ASCII passthrough only needed here)
function encodeVietnamese(text, codepage) {
  const result = [];
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp < 0x80) {
      result.push(cp);
    } else {
      result.push(0x3F);
    }
  }
  return result;
}

class EscPosBuilder {
  constructor(config = {}) {
    this.paperWidth = config.paperWidth || 58;
    this.encoding = config.encoding || 'cp1258';
    this.chunkSize = config.chunkSize || 100;
    this.charsPerLine = this.paperWidth === 80 ? 48 : 32;
    this.buffer = [];
  }
  initialize() { this.buffer.push(0x1B, 0x40); return this; }
  alignLeft() { this.buffer.push(0x1B, 0x61, 0x00); return this; }
  alignCenter() { this.buffer.push(0x1B, 0x61, 0x01); return this; }
  alignRight() { this.buffer.push(0x1B, 0x61, 0x02); return this; }
  fontNormal() { this.buffer.push(0x1D, 0x21, 0x00); return this; }
  fontDoubleH() { this.buffer.push(0x1D, 0x21, 0x01); return this; }
  fontDoubleW() { this.buffer.push(0x1D, 0x21, 0x10); return this; }
  fontDoubleWH() { this.buffer.push(0x1D, 0x21, 0x11); return this; }
  boldOn() { this.buffer.push(0x1B, 0x45, 0x01); return this; }
  boldOff() { this.buffer.push(0x1B, 0x45, 0x00); return this; }
  feedLines(n) { this.buffer.push(0x1B, 0x64, n); return this; }
  cutPaper(partial = false) { this.buffer.push(0x1D, 0x56, partial ? 0x01 : 0x00); return this; }
  setVietnamese(codepage) {
    const cp = (codepage || this.encoding) === 'tcvn3' ? 0x1E : 0x2F;
    this.buffer.push(0x1B, 0x74, cp);
    return this;
  }
  text(str) {
    const bytes = encodeVietnamese(str, this.encoding);
    this.buffer.push(...bytes);
    return this;
  }
  textLine(str) { return this.text(str + '\n'); }
  separator(char = '-', width) {
    const w = width || this.charsPerLine;
    return this.textLine(char.repeat(w));
  }
  barcode(data) {
    this.buffer.push(0x1D, 0x6B, 0x49, data.length + 2, 0x7B, 0x42);
    for (let i = 0; i < data.length; i++) {
      this.buffer.push(data.charCodeAt(i));
    }
    return this;
  }
  raw(bytes) { this.buffer.push(...bytes); return this; }
  build() { return new Uint8Array(this.buffer); }
  reset() { this.buffer = []; return this; }
}

// Inline helper functions for buildBillEscPos testing
function formatBillNumber(bill) {
  if (!bill || !bill.id) return 'HD-000000';
  return 'HD-' + bill.id.substring(0, 8).toUpperCase();
}

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

function formatVND(amount) {
  if (amount == null || isNaN(amount)) return '0';
  const rounded = Math.round(amount);
  const str = String(Math.abs(rounded));
  let result = '';
  for (let i = str.length - 1, count = 0; i >= 0; i--, count++) {
    if (count > 0 && count % 3 === 0) result = '.' + result;
    result = str[i] + result;
  }
  return rounded < 0 ? '-' + result : result;
}

function formatPaymentMethod(method) {
  const labels = { cash: 'Tien mat', card: 'The', transfer: 'Chuyen khoan' };
  return labels[method] || method || '';
}

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

function padColumns(name, qty, price, total, width) {
  const fixedWidth = 3 + 7 + 8 + 3;
  const nameWidth = width - fixedWidth;
  const paddedName = name.length > nameWidth
    ? name.substring(0, nameWidth)
    : name.padEnd(nameWidth);
  const paddedQty = qty.padStart(3);
  const paddedPrice = price.padStart(7);
  const paddedTotal = total.padStart(8);
  return `${paddedName} ${paddedQty} ${paddedPrice} ${paddedTotal}`;
}

function padRight(label, value, width) {
  const valueStr = String(value);
  const available = width - label.length;
  if (available <= 0) return label;
  return label + valueStr.padStart(available);
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 2) + '..';
}

function buildBillEscPos(bill, outlet, order, orderItems, table, staffName, printerConfig) {
  const b = new EscPosBuilder(printerConfig);
  const w = b.charsPerLine;
  b.initialize()
   .setVietnamese(printerConfig.encoding)
   .alignCenter().boldOn().fontDoubleWH()
   .textLine(outlet.name)
   .fontNormal().boldOff()
   .textLine(outlet.address || '')
   .separator('=', w)
   .alignLeft()
   .textLine(padRight('HD:', formatBillNumber(bill), w))
   .textLine(padRight('Ngay:', formatDateTime(bill.finalized_at), w))
   .textLine(padRight('Ban:', table.name, w))
   .textLine(padRight('NV:', staffName, w))
   .separator('-', w)
   .boldOn()
   .textLine(padColumns('Mon', 'SL', 'DG', 'TT', w))
   .boldOff()
   .separator('-', w);
  for (const item of orderItems) {
    const lineTotal = item.price * item.quantity;
    b.textLine(padColumns(
      truncate(item.name, w - 18),
      String(item.quantity),
      formatVND(item.price),
      formatVND(lineTotal),
      w
    ));
    if (item.note) {
      b.textLine('  * ' + truncate(item.note, w - 4));
    }
  }
  b.separator('-', w)
   .textLine(padRight('Tam tinh:', formatVND(bill.total), w))
   .textLine(padRight('Thue:', formatVND(bill.tax), w))
   .boldOn().fontDoubleH()
   .textLine(padRight('TONG:', formatVND(bill.total + bill.tax), w))
   .fontNormal().boldOff()
   .separator('-', w)
   .textLine(padRight('Thanh toan:', formatPaymentMethod(bill.payment_method), w))
   .textLine(padRight('Thoi gian:', formatDuration(order.created_at, bill.finalized_at), w))
   .separator('=', w)
   .alignCenter()
   .textLine('Cam on quy khach!')
   .textLine('')
   .barcode(formatBillNumber(bill))
   .feedLines(3)
   .cutPaper(true);
  return b.build();
}

// ---------------------------------------------------------------------------
// Tests: EscPosBuilder command byte sequences
// ---------------------------------------------------------------------------

describe('EscPosBuilder - initialize command', () => {
  const b = new EscPosBuilder();
  b.initialize();
  const data = b.build();
  assertArrayEquals(Array.from(data), [0x1B, 0x40],
    'initialize() → [0x1B, 0x40] (ESC @)');
});

describe('EscPosBuilder - alignment commands', () => {
  const b1 = new EscPosBuilder();
  b1.alignLeft();
  assertArrayEquals(Array.from(b1.build()), [0x1B, 0x61, 0x00],
    'alignLeft() → [0x1B, 0x61, 0x00]');

  const b2 = new EscPosBuilder();
  b2.alignCenter();
  assertArrayEquals(Array.from(b2.build()), [0x1B, 0x61, 0x01],
    'alignCenter() → [0x1B, 0x61, 0x01]');

  const b3 = new EscPosBuilder();
  b3.alignRight();
  assertArrayEquals(Array.from(b3.build()), [0x1B, 0x61, 0x02],
    'alignRight() → [0x1B, 0x61, 0x02]');
});

describe('EscPosBuilder - font size commands', () => {
  const b1 = new EscPosBuilder();
  b1.fontNormal();
  assertArrayEquals(Array.from(b1.build()), [0x1D, 0x21, 0x00],
    'fontNormal() → [0x1D, 0x21, 0x00]');

  const b2 = new EscPosBuilder();
  b2.fontDoubleH();
  assertArrayEquals(Array.from(b2.build()), [0x1D, 0x21, 0x01],
    'fontDoubleH() → [0x1D, 0x21, 0x01]');

  const b3 = new EscPosBuilder();
  b3.fontDoubleW();
  assertArrayEquals(Array.from(b3.build()), [0x1D, 0x21, 0x10],
    'fontDoubleW() → [0x1D, 0x21, 0x10]');

  const b4 = new EscPosBuilder();
  b4.fontDoubleWH();
  assertArrayEquals(Array.from(b4.build()), [0x1D, 0x21, 0x11],
    'fontDoubleWH() → [0x1D, 0x21, 0x11]');
});

describe('EscPosBuilder - bold commands', () => {
  const b1 = new EscPosBuilder();
  b1.boldOn();
  assertArrayEquals(Array.from(b1.build()), [0x1B, 0x45, 0x01],
    'boldOn() → [0x1B, 0x45, 0x01]');

  const b2 = new EscPosBuilder();
  b2.boldOff();
  assertArrayEquals(Array.from(b2.build()), [0x1B, 0x45, 0x00],
    'boldOff() → [0x1B, 0x45, 0x00]');
});

describe('EscPosBuilder - feedLines command', () => {
  const b = new EscPosBuilder();
  b.feedLines(3);
  assertArrayEquals(Array.from(b.build()), [0x1B, 0x64, 0x03],
    'feedLines(3) → [0x1B, 0x64, 0x03]');

  const b2 = new EscPosBuilder();
  b2.feedLines(0);
  assertArrayEquals(Array.from(b2.build()), [0x1B, 0x64, 0x00],
    'feedLines(0) → [0x1B, 0x64, 0x00]');
});

describe('EscPosBuilder - cutPaper command', () => {
  const b1 = new EscPosBuilder();
  b1.cutPaper(false);
  assertArrayEquals(Array.from(b1.build()), [0x1D, 0x56, 0x00],
    'cutPaper(false) → [0x1D, 0x56, 0x00] (full cut)');

  const b2 = new EscPosBuilder();
  b2.cutPaper(true);
  assertArrayEquals(Array.from(b2.build()), [0x1D, 0x56, 0x01],
    'cutPaper(true) → [0x1D, 0x56, 0x01] (partial cut)');

  const b3 = new EscPosBuilder();
  b3.cutPaper();
  assertArrayEquals(Array.from(b3.build()), [0x1D, 0x56, 0x00],
    'cutPaper() default → full cut [0x1D, 0x56, 0x00]');
});

describe('EscPosBuilder - setVietnamese command', () => {
  const b1 = new EscPosBuilder();
  b1.setVietnamese('cp1258');
  assertArrayEquals(Array.from(b1.build()), [0x1B, 0x74, 0x2F],
    'setVietnamese("cp1258") → [0x1B, 0x74, 0x2F] (codepage 47)');

  const b2 = new EscPosBuilder();
  b2.setVietnamese('tcvn3');
  assertArrayEquals(Array.from(b2.build()), [0x1B, 0x74, 0x1E],
    'setVietnamese("tcvn3") → [0x1B, 0x74, 0x1E] (codepage 30)');
});

describe('EscPosBuilder - barcode command', () => {
  const b = new EscPosBuilder();
  b.barcode('123');
  const data = Array.from(b.build());
  // GS k 73 (len+2) { B 1 2 3
  assertArrayEquals(data, [0x1D, 0x6B, 0x49, 5, 0x7B, 0x42, 0x31, 0x32, 0x33],
    'barcode("123") → CODE128 prefix + data bytes');
});

// ---------------------------------------------------------------------------
// Tests: Command chaining and buffer management
// ---------------------------------------------------------------------------

describe('EscPosBuilder - command chaining', () => {
  const b = new EscPosBuilder();
  const result = b.initialize().alignCenter().boldOn();
  assert(result === b, 'All commands return this for chaining');

  const data = b.build();
  assert(data instanceof Uint8Array, 'build() returns Uint8Array');

  const expected = [0x1B, 0x40, 0x1B, 0x61, 0x01, 0x1B, 0x45, 0x01];
  assertArrayEquals(Array.from(data), expected,
    'Chained commands produce correct combined byte sequence');
});

describe('EscPosBuilder - build() returns Uint8Array', () => {
  const b = new EscPosBuilder();
  b.initialize();
  const data = b.build();
  assert(data instanceof Uint8Array, 'build() returns a Uint8Array instance');
  assert(data.length === 2, 'Uint8Array has correct length');
});

describe('EscPosBuilder - reset() clears buffer', () => {
  const b = new EscPosBuilder();
  b.initialize().alignCenter().boldOn();
  assert(b.buffer.length > 0, 'Buffer has data before reset');

  b.reset();
  assert(b.buffer.length === 0, 'Buffer is empty after reset()');

  const data = b.build();
  assert(data.length === 0, 'build() after reset() returns empty Uint8Array');
});

describe('EscPosBuilder - reset() returns this for chaining', () => {
  const b = new EscPosBuilder();
  const result = b.reset();
  assert(result === b, 'reset() returns this');
});

// ---------------------------------------------------------------------------
// Tests: Text and separator
// ---------------------------------------------------------------------------

describe('EscPosBuilder - text and textLine', () => {
  const b = new EscPosBuilder();
  b.text('Hi');
  assertArrayEquals(Array.from(b.build()), [0x48, 0x69],
    'text("Hi") → [0x48, 0x69]');

  const b2 = new EscPosBuilder();
  b2.textLine('Hi');
  assertArrayEquals(Array.from(b2.build()), [0x48, 0x69, 0x0A],
    'textLine("Hi") → [0x48, 0x69, 0x0A] (with newline)');
});

describe('EscPosBuilder - separator with default 58mm width', () => {
  const b = new EscPosBuilder({ paperWidth: 58 });
  b.separator('-');
  const data = Array.from(b.build());

  // 32 dashes (0x2D) + newline (0x0A) = 33 bytes
  assert(data.length === 33, 'separator("-", 32) produces 33 bytes (32 dashes + LF)');

  // Verify all dashes
  const allDashes = data.slice(0, 32).every(byte => byte === 0x2D);
  assert(allDashes, 'First 32 bytes are all dashes (0x2D)');
  assert(data[32] === 0x0A, 'Last byte is newline (0x0A)');
});

describe('EscPosBuilder - separator with explicit width', () => {
  const b = new EscPosBuilder();
  b.separator('-', 32);
  const data = Array.from(b.build());
  assert(data.length === 33, 'separator("-", 32) produces 33 bytes');

  const b2 = new EscPosBuilder();
  b2.separator('=', 48);
  const data2 = Array.from(b2.build());
  assert(data2.length === 49, 'separator("=", 48) produces 49 bytes');
  assert(data2[0] === 0x3D, 'First byte is "=" (0x3D)');
});

describe('EscPosBuilder - raw bytes', () => {
  const b = new EscPosBuilder();
  b.raw([0xFF, 0x00, 0xAA]);
  assertArrayEquals(Array.from(b.build()), [0xFF, 0x00, 0xAA],
    'raw([0xFF, 0x00, 0xAA]) appends exact bytes');
});

// ---------------------------------------------------------------------------
// Tests: Paper width configuration
// ---------------------------------------------------------------------------

describe('EscPosBuilder - paper width 58mm → 32 charsPerLine', () => {
  const b = new EscPosBuilder({ paperWidth: 58 });
  assert(b.charsPerLine === 32, '58mm paper → 32 chars per line');
});

describe('EscPosBuilder - paper width 80mm → 48 charsPerLine', () => {
  const b = new EscPosBuilder({ paperWidth: 80 });
  assert(b.charsPerLine === 48, '80mm paper → 48 chars per line');
});

describe('EscPosBuilder - default paper width is 58mm', () => {
  const b = new EscPosBuilder();
  assert(b.paperWidth === 58, 'Default paperWidth is 58');
  assert(b.charsPerLine === 32, 'Default charsPerLine is 32');
});

describe('EscPosBuilder - default encoding is cp1258', () => {
  const b = new EscPosBuilder();
  assert(b.encoding === 'cp1258', 'Default encoding is cp1258');
});

describe('EscPosBuilder - default chunkSize is 100', () => {
  const b = new EscPosBuilder();
  assert(b.chunkSize === 100, 'Default chunkSize is 100');
});

describe('EscPosBuilder - custom config', () => {
  const b = new EscPosBuilder({ paperWidth: 80, encoding: 'tcvn3', chunkSize: 200 });
  assert(b.paperWidth === 80, 'Custom paperWidth 80');
  assert(b.encoding === 'tcvn3', 'Custom encoding tcvn3');
  assert(b.chunkSize === 200, 'Custom chunkSize 200');
  assert(b.charsPerLine === 48, 'Custom 80mm → 48 chars');
});

// ---------------------------------------------------------------------------
// Tests: Helper functions
// ---------------------------------------------------------------------------

describe('formatBillNumber', () => {
  assert(
    formatBillNumber({ id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }) === 'HD-A1B2C3D4',
    'Formats bill ID first 8 chars uppercase'
  );
  assert(
    formatBillNumber(null) === 'HD-000000',
    'Null bill → "HD-000000"'
  );
  assert(
    formatBillNumber({}) === 'HD-000000',
    'Missing id → "HD-000000"'
  );
});

describe('formatVND (receipt version)', () => {
  assert(formatVND(150000) === '150.000', '150000 → "150.000"');
  assert(formatVND(0) === '0', '0 → "0"');
  assert(formatVND(1000) === '1.000', '1000 → "1.000"');
  assert(formatVND(50) === '50', '50 → "50"');
  assert(formatVND(1000000) === '1.000.000', '1000000 → "1.000.000"');
  assert(formatVND(null) === '0', 'null → "0"');
});

describe('formatPaymentMethod', () => {
  assert(formatPaymentMethod('cash') === 'Tien mat', 'cash → "Tien mat"');
  assert(formatPaymentMethod('card') === 'The', 'card → "The"');
  assert(formatPaymentMethod('transfer') === 'Chuyen khoan', 'transfer → "Chuyen khoan"');
  assert(formatPaymentMethod('unknown') === 'unknown', 'unknown → passthrough');
});

describe('formatDuration', () => {
  assert(
    formatDuration('2026-03-12T10:00:00Z', '2026-03-12T11:30:00Z') === '01:30:00',
    '1.5 hours → "01:30:00"'
  );
  assert(
    formatDuration('2026-03-12T10:00:00Z', '2026-03-12T10:00:00Z') === '00:00:00',
    '0 duration → "00:00:00"'
  );
  assert(
    formatDuration(null, null) === '00:00:00',
    'null timestamps → "00:00:00"'
  );
});

describe('padRight', () => {
  const result = padRight('HD:', 'HD-A1B2C3D4', 32);
  assert(result.length === 32, 'padRight produces line of correct width');
  assert(result.startsWith('HD:'), 'padRight starts with label');
  assert(result.endsWith('HD-A1B2C3D4'), 'padRight ends with value');
});

describe('truncate', () => {
  assert(truncate('Short', 10) === 'Short', 'Short string not truncated');
  assert(truncate('A very long item name', 10) === 'A very l..', 'Long string truncated with ..');
  assert(truncate('', 10) === '', 'Empty string returns empty');
  assert(truncate(null, 10) === '', 'null returns empty');
});

describe('padColumns', () => {
  const result = padColumns('Pho Bo', '2', '50.000', '100.000', 32);
  assert(result.length === 32, 'padColumns produces line of width 32');
  assert(result.startsWith('Pho Bo'), 'padColumns starts with item name');
});

// ---------------------------------------------------------------------------
// Tests: buildBillEscPos
// ---------------------------------------------------------------------------

describe('buildBillEscPos - produces non-empty Uint8Array', () => {
  const bill = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    total: 150000,
    tax: 15000,
    payment_method: 'cash',
    finalized_at: '2026-03-12T14:30:00Z',
  };
  const outlet = { name: 'Pho 24', address: '123 Le Loi, Q1, TPHCM' };
  const order = { created_at: '2026-03-12T12:00:00Z' };
  const orderItems = [
    { name: 'Pho Bo', quantity: 2, price: 50000 },
    { name: 'Ca phe sua da', quantity: 1, price: 25000, note: 'It duong' },
  ];
  const table = { name: 'Ban 5' };
  const staffName = 'Nguyen Van A';
  const printerConfig = { paperWidth: 58, encoding: 'cp1258', chunkSize: 100 };

  const result = buildBillEscPos(bill, outlet, order, orderItems, table, staffName, printerConfig);

  assert(result instanceof Uint8Array, 'buildBillEscPos returns Uint8Array');
  assert(result.length > 0, 'buildBillEscPos returns non-empty data');
  assert(result.length > 100, 'buildBillEscPos returns substantial data (> 100 bytes)');
});

describe('buildBillEscPos - starts with initialize command', () => {
  const bill = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    total: 100000, tax: 10000, payment_method: 'cash',
    finalized_at: '2026-03-12T14:00:00Z',
  };
  const result = buildBillEscPos(
    bill,
    { name: 'Test', address: '' },
    { created_at: '2026-03-12T12:00:00Z' },
    [{ name: 'Item 1', quantity: 1, price: 100000 }],
    { name: 'Ban 1' },
    'Staff',
    { paperWidth: 58, encoding: 'cp1258' }
  );

  // First two bytes should be ESC @ (initialize)
  assert(result[0] === 0x1B && result[1] === 0x40,
    'First bytes are initialize command (0x1B, 0x40)');
});

describe('buildBillEscPos - ends with cut paper command', () => {
  const bill = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    total: 100000, tax: 10000, payment_method: 'card',
    finalized_at: '2026-03-12T14:00:00Z',
  };
  const result = buildBillEscPos(
    bill,
    { name: 'Test', address: '' },
    { created_at: '2026-03-12T12:00:00Z' },
    [{ name: 'Item', quantity: 1, price: 100000 }],
    { name: 'Ban 1' },
    'Staff',
    { paperWidth: 58, encoding: 'cp1258' }
  );

  // Last 3 bytes should be cut paper partial (0x1D, 0x56, 0x01)
  const last3 = Array.from(result.slice(-3));
  assertArrayEquals(last3, [0x1D, 0x56, 0x01],
    'Last bytes are partial cut paper command');
});

describe('buildBillEscPos - includes item notes', () => {
  const bill = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    total: 50000, tax: 5000, payment_method: 'cash',
    finalized_at: '2026-03-12T14:00:00Z',
  };
  const result = buildBillEscPos(
    bill,
    { name: 'Test', address: '' },
    { created_at: '2026-03-12T12:00:00Z' },
    [{ name: 'Pho Bo', quantity: 1, price: 50000, note: 'Khong hanh' }],
    { name: 'Ban 1' },
    'Staff',
    { paperWidth: 58, encoding: 'cp1258' }
  );

  // The note "  * Khong hanh" should be present in the byte data
  const notePrefix = [0x20, 0x20, 0x2A, 0x20]; // "  * "
  let found = false;
  for (let i = 0; i <= result.length - notePrefix.length; i++) {
    if (notePrefix.every((b, j) => result[i + j] === b)) {
      found = true;
      break;
    }
  }
  assert(found, 'Output contains item note prefix "  * "');
});

describe('buildBillEscPos - 80mm produces wider output', () => {
  const bill = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    total: 100000, tax: 10000, payment_method: 'cash',
    finalized_at: '2026-03-12T14:00:00Z',
  };
  const items = [{ name: 'Item', quantity: 1, price: 100000 }];
  const args = [
    bill,
    { name: 'Test', address: '' },
    { created_at: '2026-03-12T12:00:00Z' },
    items,
    { name: 'Ban 1' },
    'Staff',
  ];

  const result58 = buildBillEscPos(...args, { paperWidth: 58, encoding: 'cp1258' });
  const result80 = buildBillEscPos(...args, { paperWidth: 80, encoding: 'cp1258' });

  assert(result80.length > result58.length,
    '80mm output is larger than 58mm output (wider separator lines and padded columns)');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n---\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  if (typeof process !== 'undefined') process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
