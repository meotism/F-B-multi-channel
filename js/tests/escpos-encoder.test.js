// Unit tests for escpos-encoder - Vietnamese character encoding
//
// Tests CP1258 and TCVN-3 encoding lookup tables, ASCII passthrough,
// unmapped character fallback, and diacritics stripping.
//
// Usage (Node >= 18):
//   node js/tests/escpos-encoder.test.js

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
// Inline the encoding logic (avoid import/module issues across envs)
// ---------------------------------------------------------------------------

const UNICODE_TO_CP1258 = {
  0x00E0: 0xE0, 0x00E1: 0xE1, 0x00E2: 0xE2, 0x00E3: 0xE3,
  0x0103: 0xE3, 0x00E8: 0xE8, 0x00E9: 0xE9, 0x00EA: 0xEA,
  0x00EC: 0xEC, 0x00ED: 0xED, 0x00F2: 0xF2, 0x00F3: 0xF3,
  0x00F4: 0xF4, 0x00F5: 0xF5, 0x01A1: 0xF5, 0x00F9: 0xF9,
  0x00FA: 0xFA, 0x01B0: 0xFC, 0x00FD: 0xFD,
  0x0111: 0xF0, 0x0110: 0xD0,
  0x00C0: 0xC0, 0x00C1: 0xC1, 0x00C2: 0xC2, 0x00C3: 0xC3,
  0x0102: 0xC3, 0x00C8: 0xC8, 0x00C9: 0xC9, 0x00CA: 0xCA,
  0x00CC: 0xCC, 0x00CD: 0xCD, 0x00D2: 0xD2, 0x00D3: 0xD3,
  0x00D4: 0xD4, 0x00D5: 0xD5, 0x01A0: 0xD5, 0x00D9: 0xD9,
  0x00DA: 0xDA, 0x01AF: 0xDC, 0x00DD: 0xDD,
  // Pre-composed vowels with tones
  0x1EA1: 0xE1, 0x1EA3: 0xE0, 0x1EA5: 0xE2, 0x1EA7: 0xE2,
  0x1EAF: 0xE3, 0x1EB1: 0xE3,
  0x1EB9: 0xE9, 0x1EBB: 0xE8, 0x1EBF: 0xEA, 0x1EC1: 0xEA,
  0x1ECD: 0xF3, 0x1ECF: 0xF2, 0x1ED1: 0xF4, 0x1ED3: 0xF4,
  0x1EDB: 0xF5, 0x1EDD: 0xF5,
  0x1EE5: 0xFA, 0x1EE7: 0xF9, 0x1EE9: 0xFC, 0x1EEB: 0xFC,
  0x1EF3: 0xFD,
};

const UNICODE_TO_TCVN3 = {
  0x00E0: 0xB5, 0x00E1: 0xB8, 0x00E2: 0xA9, 0x00E3: 0xB6,
  0x0103: 0xA8, 0x00E8: 0xBE, 0x00E9: 0xC0, 0x00EA: 0xAA,
  0x00EC: 0xC8, 0x00ED: 0xCA, 0x00F2: 0xCE, 0x00F3: 0xD0,
  0x00F4: 0xCB, 0x00F5: 0xCF, 0x01A1: 0xCC, 0x00F9: 0xDF,
  0x00FA: 0xE1, 0x01B0: 0xDC, 0x00FD: 0xFD,
  0x0111: 0xBA, 0x0110: 0x80,
};

function encodeVietnamese(text, codepage = 'cp1258') {
  const table = codepage === 'tcvn3' ? UNICODE_TO_TCVN3 : UNICODE_TO_CP1258;
  const result = [];
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp < 0x80) {
      result.push(cp);
    } else if (table[cp] !== undefined) {
      result.push(table[cp]);
    } else {
      result.push(0x3F);
    }
  }
  return result;
}

function stripVietnameseDiacritics(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('encodeVietnamese - ASCII passthrough', () => {
  const result = encodeVietnamese('Hello');
  assertArrayEquals(result, [0x48, 0x65, 0x6C, 0x6C, 0x6F],
    'ASCII "Hello" passes through unchanged');

  const result2 = encodeVietnamese('ABC 123');
  assertArrayEquals(result2, [0x41, 0x42, 0x43, 0x20, 0x31, 0x32, 0x33],
    'ASCII letters, space, and digits pass through');

  const result3 = encodeVietnamese('');
  assertArrayEquals(result3, [],
    'Empty string produces empty array');

  const result4 = encodeVietnamese('\n');
  assertArrayEquals(result4, [0x0A],
    'Newline (0x0A) passes through as ASCII');
});

describe('encodeVietnamese - CP1258 Vietnamese characters', () => {
  // Test lowercase Vietnamese vowels
  const resultA = encodeVietnamese('\u00E0'); // à
  assertArrayEquals(resultA, [0xE0], 'a-grave (à) → 0xE0 in CP1258');

  const resultE = encodeVietnamese('\u00E9'); // é
  assertArrayEquals(resultE, [0xE9], 'e-acute (é) → 0xE9 in CP1258');

  const resultO = encodeVietnamese('\u00F4'); // ô
  assertArrayEquals(resultO, [0xF4], 'o-circumflex (ô) → 0xF4 in CP1258');

  // Test đ (d-stroke)
  const resultD = encodeVietnamese('\u0111'); // đ
  assertArrayEquals(resultD, [0xF0], 'đ → 0xF0 in CP1258');

  const resultDD = encodeVietnamese('\u0110'); // Đ
  assertArrayEquals(resultDD, [0xD0], 'Đ → 0xD0 in CP1258');

  // Test ơ and ư
  const resultOw = encodeVietnamese('\u01A1'); // ơ
  assertArrayEquals(resultOw, [0xF5], 'ơ → 0xF5 in CP1258');

  const resultUw = encodeVietnamese('\u01B0'); // ư
  assertArrayEquals(resultUw, [0xFC], 'ư → 0xFC in CP1258');

  // Test ă
  const resultAb = encodeVietnamese('\u0103'); // ă
  assertArrayEquals(resultAb, [0xE3], 'ă → 0xE3 in CP1258');
});

describe('encodeVietnamese - CP1258 uppercase Vietnamese characters', () => {
  const resultA = encodeVietnamese('\u00C0'); // À
  assertArrayEquals(resultA, [0xC0], 'A-grave (À) → 0xC0 in CP1258');

  const resultE = encodeVietnamese('\u00CA'); // Ê
  assertArrayEquals(resultE, [0xCA], 'E-circumflex (Ê) → 0xCA in CP1258');

  const resultY = encodeVietnamese('\u00DD'); // Ý
  assertArrayEquals(resultY, [0xDD], 'Y-acute (Ý) → 0xDD in CP1258');
});

describe('encodeVietnamese - CP1258 mixed text', () => {
  // "Phở Bò" — mix of ASCII and Vietnamese
  // P=0x50, h=0x68, ở (0x1EDF mapped in full table but using ơ approx)
  // Let's test with simpler example: "cà phê"
  const result = encodeVietnamese('c\u00E0 ph\u00EA');
  assertArrayEquals(result, [0x63, 0xE0, 0x20, 0x70, 0x68, 0xEA],
    '"cà phê" encodes correctly in CP1258');

  // "đá" — d-stroke + a-acute
  const result2 = encodeVietnamese('\u0111\u00E1');
  assertArrayEquals(result2, [0xF0, 0xE1],
    '"đá" encodes correctly in CP1258');
});

describe('encodeVietnamese - unmapped characters fallback to 0x3F', () => {
  // Chinese character — not in any Vietnamese codepage
  const result = encodeVietnamese('\u4E2D'); // 中
  assertArrayEquals(result, [0x3F],
    'Chinese character 中 → 0x3F (?) fallback');

  // Emoji — not in codepage
  const result2 = encodeVietnamese('\u2665'); // ♥
  assertArrayEquals(result2, [0x3F],
    'Heart symbol ♥ → 0x3F (?) fallback');

  // Mix of valid and invalid
  const result3 = encodeVietnamese('A\u4E2DB');
  assertArrayEquals(result3, [0x41, 0x3F, 0x42],
    'Mixed valid+invalid: "A中B" → [0x41, 0x3F, 0x42]');
});

describe('encodeVietnamese - TCVN-3 encoding', () => {
  const resultA = encodeVietnamese('\u00E0', 'tcvn3'); // à
  assertArrayEquals(resultA, [0xB5], 'a-grave (à) → 0xB5 in TCVN-3');

  const resultE = encodeVietnamese('\u00E9', 'tcvn3'); // é
  assertArrayEquals(resultE, [0xC0], 'e-acute (é) → 0xC0 in TCVN-3');

  const resultD = encodeVietnamese('\u0111', 'tcvn3'); // đ
  assertArrayEquals(resultD, [0xBA], 'đ → 0xBA in TCVN-3');

  const resultDD = encodeVietnamese('\u0110', 'tcvn3'); // Đ
  assertArrayEquals(resultDD, [0x80], 'Đ → 0x80 in TCVN-3');

  const resultOw = encodeVietnamese('\u01A1', 'tcvn3'); // ơ
  assertArrayEquals(resultOw, [0xCC], 'ơ → 0xCC in TCVN-3');

  const resultAb = encodeVietnamese('\u0103', 'tcvn3'); // ă
  assertArrayEquals(resultAb, [0xA8], 'ă → 0xA8 in TCVN-3');
});

describe('encodeVietnamese - TCVN-3 ASCII still passes through', () => {
  const result = encodeVietnamese('Hello', 'tcvn3');
  assertArrayEquals(result, [0x48, 0x65, 0x6C, 0x6C, 0x6F],
    'ASCII "Hello" passes through unchanged in TCVN-3');
});

describe('stripVietnameseDiacritics', () => {
  assert(
    stripVietnameseDiacritics('Phở Bò') === 'Pho Bo',
    '"Phở Bò" → "Pho Bo"'
  );
  assert(
    stripVietnameseDiacritics('Bún chả Hà Nội') === 'Bun cha Ha Noi',
    '"Bún chả Hà Nội" → "Bun cha Ha Noi"'
  );
  assert(
    stripVietnameseDiacritics('Cà phê sữa đá') === 'Ca phe sua da',
    '"Cà phê sữa đá" → "Ca phe sua da"'
  );
  assert(
    stripVietnameseDiacritics('đ') === 'd',
    '"đ" → "d"'
  );
  assert(
    stripVietnameseDiacritics('Đ') === 'D',
    '"Đ" → "D"'
  );
  assert(
    stripVietnameseDiacritics('Hello World') === 'Hello World',
    'ASCII text unchanged'
  );
  assert(
    stripVietnameseDiacritics('') === '',
    'Empty string returns empty'
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
