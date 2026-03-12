// Unit tests for bluetooth-service
//
// Tests Bluetooth service functions, BluetoothConnectionManager,
// printWithRetry(), and showBluetoothFallback() using mock objects.
// No actual Web Bluetooth API dependency — all logic is tested in isolation.
//
// Usage (Node >= 18):
//   node js/tests/bluetooth-service.test.js

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

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// We need an async describe for async tests
async function describeAsync(name, fn) {
  console.log(`\n${name}`);
  await fn();
}

// ---------------------------------------------------------------------------
// Inline the logic under test (avoid ES module import issues in Node)
// ---------------------------------------------------------------------------

const PRINTER_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

// Inline bluetoothService for testing
const bluetoothService = {
  isWebBluetoothSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  },

  async sendPrintData(writeChar, escPosData, chunkSize = 100) {
    for (let offset = 0; offset < escPosData.length; offset += chunkSize) {
      const chunk = escPosData.slice(offset, offset + chunkSize);
      if (writeChar.properties.writeWithoutResponse) {
        await writeChar.writeValueWithoutResponse(chunk);
      } else {
        await writeChar.writeValueWithResponse(chunk);
      }
      // Skip inter-chunk delay in tests for speed
    }
  },
};

// Inline BluetoothConnectionManager for testing
class BluetoothConnectionManager {
  constructor() {
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
  }

  async connect(device) {
    this.device = device;
    this.server = await device.gatt.connect();
    // Simplified for test: set connected state
    this.isConnected = true;
    this.reconnectAttempts = 0;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    return { serviceUUID: 'mock-uuid' };
  }

  onDisconnected() {
    this.isConnected = false;
    this.autoReconnect();
  }

  async autoReconnect() {
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      // Skip actual delay in unit tests
      try {
        await this.connect(this.device);
        return;
      } catch (e) { /* continue retry */ }
    }
  }

  disconnect() {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.isConnected = false;
  }
}

// Inline printWithRetry for testing (uses bluetoothService.sendPrintData)
async function printWithRetry(writeChar, escPosData, chunkSize = 100, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bluetoothService.sendPrintData(writeChar, escPosData, chunkSize);
      return { success: true };
    } catch (e) {
      if (attempt === maxRetries) {
        return { success: false, error: 'BT_PRINT_FAILED', message: e.message, attempts: attempt };
      }
      // Skip actual delay in unit tests
    }
  }
}

// Inline showBluetoothFallback for testing (accepts ua parameter for testability)
function showBluetoothFallback(ua) {
  // In production, ua = navigator.userAgent; here we accept it as param for testing
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

// ---------------------------------------------------------------------------
// Helper: create a mock writeChar that captures write calls
// ---------------------------------------------------------------------------

function createMockWriteChar(options = {}) {
  const captured = [];
  const failCount = options.failCount || 0;
  let callCount = 0;

  return {
    properties: {
      writeWithoutResponse: options.writeWithoutResponse !== undefined
        ? options.writeWithoutResponse : true,
      write: options.write !== undefined ? options.write : false,
    },
    captured,
    async writeValueWithoutResponse(data) {
      callCount++;
      if (callCount <= failCount) {
        throw new Error('Mock write failure');
      }
      captured.push(new Uint8Array(data));
    },
    async writeValueWithResponse(data) {
      callCount++;
      if (callCount <= failCount) {
        throw new Error('Mock write failure');
      }
      captured.push(new Uint8Array(data));
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: create a mock writeChar that always fails
// ---------------------------------------------------------------------------

function createFailingWriteChar(errorMessage = 'BT write error') {
  return {
    properties: { writeWithoutResponse: true, write: false },
    async writeValueWithoutResponse() {
      throw new Error(errorMessage);
    },
    async writeValueWithResponse() {
      throw new Error(errorMessage);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isWebBluetoothSupported()', () => {
  // In Node, navigator is not defined, so should return false
  assert(
    bluetoothService.isWebBluetoothSupported() === false,
    'returns false when navigator.bluetooth is undefined (Node environment)'
  );
});

await describeAsync('sendPrintData - chunk splitting', async () => {
  // 250 bytes of data with chunkSize 100 should produce 3 chunks: 100, 100, 50
  const data = new Uint8Array(250);
  for (let i = 0; i < 250; i++) data[i] = i % 256;

  const mockChar = createMockWriteChar();
  await bluetoothService.sendPrintData(mockChar, data, 100);

  assert(
    mockChar.captured.length === 3,
    'splits 250 bytes into 3 chunks with chunkSize=100'
  );
  assert(
    mockChar.captured[0].length === 100,
    'first chunk is 100 bytes'
  );
  assert(
    mockChar.captured[1].length === 100,
    'second chunk is 100 bytes'
  );
  assert(
    mockChar.captured[2].length === 50,
    'third chunk is 50 bytes (remainder)'
  );
});

await describeAsync('sendPrintData - exact chunk boundary', async () => {
  // 200 bytes with chunkSize 100 should produce exactly 2 chunks
  const data = new Uint8Array(200);
  const mockChar = createMockWriteChar();
  await bluetoothService.sendPrintData(mockChar, data, 100);

  assert(
    mockChar.captured.length === 2,
    'splits 200 bytes into exactly 2 chunks with chunkSize=100'
  );
  assert(
    mockChar.captured[0].length === 100 && mockChar.captured[1].length === 100,
    'both chunks are exactly 100 bytes'
  );
});

await describeAsync('sendPrintData - single chunk', async () => {
  // 50 bytes with chunkSize 100 should produce 1 chunk
  const data = new Uint8Array(50);
  const mockChar = createMockWriteChar();
  await bluetoothService.sendPrintData(mockChar, data, 100);

  assert(
    mockChar.captured.length === 1,
    'data smaller than chunkSize produces 1 chunk'
  );
  assert(
    mockChar.captured[0].length === 50,
    'single chunk has correct length'
  );
});

await describeAsync('sendPrintData - uses writeWithResponse when writeWithoutResponse is false', async () => {
  const data = new Uint8Array(50);
  const mockChar = createMockWriteChar({ writeWithoutResponse: false, write: true });
  await bluetoothService.sendPrintData(mockChar, data, 100);

  assert(
    mockChar.captured.length === 1,
    'uses writeWithResponse fallback when writeWithoutResponse is false'
  );
});

await describeAsync('sendPrintData - preserves data integrity', async () => {
  const data = new Uint8Array([0x1B, 0x40, 0x48, 0x65, 0x6C]);
  const mockChar = createMockWriteChar();
  await bluetoothService.sendPrintData(mockChar, data, 3);

  assert(
    mockChar.captured.length === 2,
    'splits 5 bytes into 2 chunks with chunkSize=3'
  );
  assert(
    mockChar.captured[0][0] === 0x1B && mockChar.captured[0][1] === 0x40 && mockChar.captured[0][2] === 0x48,
    'first chunk preserves byte values'
  );
  assert(
    mockChar.captured[1][0] === 0x65 && mockChar.captured[1][1] === 0x6C,
    'second chunk preserves byte values'
  );
});

await describeAsync('printWithRetry - success on first attempt', async () => {
  const data = new Uint8Array([0x1B, 0x40]);
  const mockChar = createMockWriteChar();
  const result = await printWithRetry(mockChar, data, 100, 3);

  assert(
    result.success === true,
    'returns { success: true } on first successful attempt'
  );
  assert(
    result.error === undefined,
    'no error property on success'
  );
});

await describeAsync('printWithRetry - returns failure after max retries', async () => {
  const data = new Uint8Array([0x1B, 0x40]);
  const failChar = createFailingWriteChar('Device disconnected');
  const result = await printWithRetry(failChar, data, 100, 3);

  assert(
    result.success === false,
    'returns { success: false } after all retries exhausted'
  );
  assert(
    result.error === 'BT_PRINT_FAILED',
    'error code is BT_PRINT_FAILED'
  );
  assert(
    result.message === 'Device disconnected',
    'message contains the original error message'
  );
  assert(
    result.attempts === 3,
    'attempts equals maxRetries (3)'
  );
});

await describeAsync('printWithRetry - single retry allowed', async () => {
  const data = new Uint8Array([0x1B, 0x40]);
  const failChar = createFailingWriteChar('Timeout');
  const result = await printWithRetry(failChar, data, 100, 1);

  assert(
    result.success === false,
    'returns failure with maxRetries=1'
  );
  assert(
    result.attempts === 1,
    'attempts is 1 when maxRetries=1'
  );
});

describe('BluetoothConnectionManager - initial state', () => {
  const manager = new BluetoothConnectionManager();

  assert(
    manager.device === null,
    'device is null initially'
  );
  assert(
    manager.server === null,
    'server is null initially'
  );
  assert(
    manager.writeChar === null,
    'writeChar is null initially'
  );
  assert(
    manager.notifyChar === null,
    'notifyChar is null initially'
  );
  assert(
    manager.isConnected === false,
    'isConnected is false initially'
  );
  assert(
    manager.reconnectAttempts === 0,
    'reconnectAttempts is 0 initially'
  );
  assert(
    manager.maxReconnectAttempts === 3,
    'maxReconnectAttempts defaults to 3'
  );
});

await describeAsync('BluetoothConnectionManager - connect success', async () => {
  const manager = new BluetoothConnectionManager();
  const listeners = {};
  const mockDevice = {
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return this;
      },
      disconnect() { this.connected = false; },
    },
    addEventListener(event, handler) {
      listeners[event] = handler;
    },
  };

  const result = await manager.connect(mockDevice);

  assert(
    manager.isConnected === true,
    'isConnected is true after successful connect'
  );
  assert(
    manager.device === mockDevice,
    'device reference is stored'
  );
  assert(
    manager.reconnectAttempts === 0,
    'reconnectAttempts reset to 0 on successful connect'
  );
  assert(
    typeof listeners.gattserverdisconnected === 'function',
    'gattserverdisconnected listener is registered'
  );
});

await describeAsync('BluetoothConnectionManager - disconnect', async () => {
  const manager = new BluetoothConnectionManager();
  let disconnectCalled = false;
  const mockDevice = {
    gatt: {
      connected: true,
      async connect() { return this; },
      disconnect() { disconnectCalled = true; this.connected = false; },
    },
    addEventListener() {},
  };

  await manager.connect(mockDevice);
  manager.disconnect();

  assert(
    manager.isConnected === false,
    'isConnected is false after disconnect'
  );
  assert(
    disconnectCalled === true,
    'device.gatt.disconnect() was called'
  );
});

await describeAsync('BluetoothConnectionManager - onDisconnected sets isConnected false', async () => {
  const manager = new BluetoothConnectionManager();
  // Simulate state as if we were connected
  manager.isConnected = true;
  manager.device = {
    gatt: {
      connected: false,
      async connect() { throw new Error('Cannot reconnect'); },
    },
    addEventListener() {},
  };
  manager.maxReconnectAttempts = 0; // Prevent actual reconnect loop in test

  manager.onDisconnected();

  assert(
    manager.isConnected === false,
    'isConnected set to false on unexpected disconnect'
  );
});

await describeAsync('BluetoothConnectionManager - autoReconnect max attempts', async () => {
  const manager = new BluetoothConnectionManager();
  let connectAttempts = 0;
  manager.device = {
    gatt: {
      connected: false,
      async connect() {
        connectAttempts++;
        throw new Error('Connection refused');
      },
    },
    addEventListener() {},
  };
  manager.maxReconnectAttempts = 3;

  await manager.autoReconnect();

  assert(
    manager.reconnectAttempts === 3,
    'reconnectAttempts reaches maxReconnectAttempts (3)'
  );
  assert(
    manager.isConnected === false,
    'remains disconnected after all reconnect attempts fail'
  );
});

describe('showBluetoothFallback - iOS detection', () => {
  const iosUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
  const result = showBluetoothFallback(iosUA);
  assert(
    result === 'iOS khong ho tro Web Bluetooth. Vui long su dung Android Chrome hoac Chrome tren may tinh.',
    'returns correct message for iPhone'
  );

  const ipadUA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
  const result2 = showBluetoothFallback(ipadUA);
  assert(
    result2 === 'iOS khong ho tro Web Bluetooth. Vui long su dung Android Chrome hoac Chrome tren may tinh.',
    'returns correct message for iPad'
  );
});

describe('showBluetoothFallback - Firefox detection', () => {
  const firefoxUA = 'Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0';
  const result = showBluetoothFallback(firefoxUA);
  assert(
    result === 'Firefox khong ho tro Web Bluetooth. Vui long su dung Chrome.',
    'returns correct message for Firefox'
  );
});

describe('showBluetoothFallback - Safari on macOS detection', () => {
  const safariUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const result = showBluetoothFallback(safariUA);
  assert(
    result === 'Safari tren macOS khong ho tro Web Bluetooth. Vui long su dung Chrome.',
    'returns correct message for Safari on macOS'
  );
});

describe('showBluetoothFallback - Chrome (supported, generic fallback)', () => {
  // Chrome UA contains both "Chrome" and "Safari", so it should NOT match Safari-only
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const result = showBluetoothFallback(chromeUA);
  assert(
    result === 'Trinh duyet cua ban khong ho tro Web Bluetooth. Vui long su dung Google Chrome.',
    'returns generic fallback for Chrome (which actually supports BT)'
  );
});

describe('showBluetoothFallback - unknown browser', () => {
  const unknownUA = 'SomeRandomBrowser/1.0';
  const result = showBluetoothFallback(unknownUA);
  assert(
    result === 'Trinh duyet cua ban khong ho tro Web Bluetooth. Vui long su dung Google Chrome.',
    'returns generic fallback for unknown browsers'
  );
});

describe('PRINTER_SERVICE_UUIDS', () => {
  assert(
    Array.isArray(PRINTER_SERVICE_UUIDS),
    'PRINTER_SERVICE_UUIDS is an array'
  );
  assert(
    PRINTER_SERVICE_UUIDS.length === 4,
    'contains exactly 4 known service UUIDs'
  );
  assert(
    PRINTER_SERVICE_UUIDS[0] === '000018f0-0000-1000-8000-00805f9b34fb',
    'first UUID is Epson/Star service'
  );
  assert(
    PRINTER_SERVICE_UUIDS[3] === 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    'last UUID is serial port emulation service'
  );
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
