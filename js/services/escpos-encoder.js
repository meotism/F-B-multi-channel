// ESC/POS Encoder - Vietnamese character encoding for thermal printers
//
// Provides CP1258 and TCVN-3 lookup tables for Vietnamese character encoding.
// Used by EscPosBuilder.text() to convert Unicode strings to printer-compatible bytes.
//
// Requirements: 6 (AC-3, AC-4)
// Design reference: Section 7 (Vietnamese Encoder)

// ============================================================
// CP1258 (Windows-1258) Lookup Table
// ============================================================
// Maps Unicode codepoints to single CP1258 byte values.
// Vietnamese characters that map directly to Latin-1 positions are included,
// plus special Vietnamese-specific characters (đ, ơ, ư, ă).
// Characters with combined diacritics are mapped to their closest CP1258 equivalents.

/** @type {Object<number, number>} Unicode codepoint → CP1258 byte */
const UNICODE_TO_CP1258 = {
  // --- Lowercase vowels with diacritics ---
  // a variants
  0x00E0: 0xE0, // à
  0x00E1: 0xE1, // á
  0x00E2: 0xE2, // â
  0x00E3: 0xE3, // ã
  0x0103: 0xE3, // ă (mapped to ã position, common printer behavior)
  0x1EA1: 0xE1, // ạ (mapped to á as closest match)
  0x1EA3: 0xE0, // ả (mapped to à as closest match)
  0x1EA5: 0xE2, // ấ (mapped to â as closest match)
  0x1EA7: 0xE2, // ầ (mapped to â as closest match)
  0x1EA9: 0xE2, // ẩ (mapped to â as closest match)
  0x1EAB: 0xE2, // ẫ (mapped to â as closest match)
  0x1EAD: 0xE2, // ậ (mapped to â as closest match)
  0x1EAF: 0xE3, // ắ (mapped to ã/ă position)
  0x1EB1: 0xE3, // ằ (mapped to ã/ă position)
  0x1EB3: 0xE3, // ẳ (mapped to ã/ă position)
  0x1EB5: 0xE3, // ẵ (mapped to ã/ă position)
  0x1EB7: 0xE3, // ặ (mapped to ã/ă position)

  // e variants
  0x00E8: 0xE8, // è
  0x00E9: 0xE9, // é
  0x00EA: 0xEA, // ê
  0x1EB9: 0xE9, // ẹ (mapped to é)
  0x1EBB: 0xE8, // ẻ (mapped to è)
  0x1EBD: 0xE9, // ẽ (mapped to é)
  0x1EBF: 0xEA, // ế (mapped to ê)
  0x1EC1: 0xEA, // ề (mapped to ê)
  0x1EC3: 0xEA, // ể (mapped to ê)
  0x1EC5: 0xEA, // ễ (mapped to ê)
  0x1EC7: 0xEA, // ệ (mapped to ê)

  // i variants
  0x00EC: 0xEC, // ì
  0x00ED: 0xED, // í
  0x0129: 0xED, // ĩ (mapped to í)
  0x1EC9: 0xEC, // ỉ (mapped to ì)
  0x1ECB: 0xED, // ị (mapped to í)

  // o variants
  0x00F2: 0xF2, // ò
  0x00F3: 0xF3, // ó
  0x00F4: 0xF4, // ô
  0x00F5: 0xF5, // õ
  0x01A1: 0xF5, // ơ (mapped to õ position, common printer behavior)
  0x1ECD: 0xF3, // ọ (mapped to ó)
  0x1ECF: 0xF2, // ỏ (mapped to ò)
  0x1ED1: 0xF4, // ố (mapped to ô)
  0x1ED3: 0xF4, // ồ (mapped to ô)
  0x1ED5: 0xF4, // ổ (mapped to ô)
  0x1ED7: 0xF4, // ỗ (mapped to ô)
  0x1ED9: 0xF4, // ộ (mapped to ô)
  0x1EDB: 0xF5, // ớ (mapped to õ/ơ position)
  0x1EDD: 0xF5, // ờ (mapped to õ/ơ position)
  0x1EDF: 0xF5, // ở (mapped to õ/ơ position)
  0x1EE1: 0xF5, // ỡ (mapped to õ/ơ position)
  0x1EE3: 0xF5, // ợ (mapped to õ/ơ position)

  // u variants
  0x00F9: 0xF9, // ù
  0x00FA: 0xFA, // ú
  0x0169: 0xFA, // ũ (mapped to ú)
  0x01B0: 0xFC, // ư (mapped to ü position)
  0x1EE5: 0xFA, // ụ (mapped to ú)
  0x1EE7: 0xF9, // ủ (mapped to ù)
  0x1EE9: 0xFC, // ứ (mapped to ü/ư position)
  0x1EEB: 0xFC, // ừ (mapped to ü/ư position)
  0x1EED: 0xFC, // ử (mapped to ü/ư position)
  0x1EEF: 0xFC, // ữ (mapped to ü/ư position)
  0x1EF1: 0xFC, // ự (mapped to ü/ư position)

  // y variants
  0x00FD: 0xFD, // ý
  0x1EF3: 0xFD, // ỳ (mapped to ý)
  0x1EF5: 0xFD, // ỵ (mapped to ý)
  0x1EF7: 0xFD, // ỷ (mapped to ý)
  0x1EF9: 0xFD, // ỹ (mapped to ý)

  // d variants
  0x0111: 0xF0, // đ
  0x0110: 0xD0, // Đ

  // --- Uppercase vowels with diacritics ---
  // A variants
  0x00C0: 0xC0, // À
  0x00C1: 0xC1, // Á
  0x00C2: 0xC2, // Â
  0x00C3: 0xC3, // Ã
  0x0102: 0xC3, // Ă (mapped to Ã position)
  0x1EA0: 0xC1, // Ạ (mapped to Á)
  0x1EA2: 0xC0, // Ả (mapped to À)
  0x1EA4: 0xC2, // Ấ (mapped to Â)
  0x1EA6: 0xC2, // Ầ (mapped to Â)
  0x1EA8: 0xC2, // Ẩ (mapped to Â)
  0x1EAA: 0xC2, // Ẫ (mapped to Â)
  0x1EAC: 0xC2, // Ậ (mapped to Â)
  0x1EAE: 0xC3, // Ắ (mapped to Ã/Ă position)
  0x1EB0: 0xC3, // Ằ (mapped to Ã/Ă position)
  0x1EB2: 0xC3, // Ẳ (mapped to Ã/Ă position)
  0x1EB4: 0xC3, // Ẵ (mapped to Ã/Ă position)
  0x1EB6: 0xC3, // Ặ (mapped to Ã/Ă position)

  // E variants
  0x00C8: 0xC8, // È
  0x00C9: 0xC9, // É
  0x00CA: 0xCA, // Ê
  0x1EB8: 0xC9, // Ẹ (mapped to É)
  0x1EBA: 0xC8, // Ẻ (mapped to È)
  0x1EBC: 0xC9, // Ẽ (mapped to É)
  0x1EBE: 0xCA, // Ế (mapped to Ê)
  0x1EC0: 0xCA, // Ề (mapped to Ê)
  0x1EC2: 0xCA, // Ể (mapped to Ê)
  0x1EC4: 0xCA, // Ễ (mapped to Ê)
  0x1EC6: 0xCA, // Ệ (mapped to Ê)

  // I variants
  0x00CC: 0xCC, // Ì
  0x00CD: 0xCD, // Í
  0x0128: 0xCD, // Ĩ (mapped to Í)
  0x1EC8: 0xCC, // Ỉ (mapped to Ì)
  0x1ECA: 0xCD, // Ị (mapped to Í)

  // O variants
  0x00D2: 0xD2, // Ò
  0x00D3: 0xD3, // Ó
  0x00D4: 0xD4, // Ô
  0x00D5: 0xD5, // Õ
  0x01A0: 0xD5, // Ơ (mapped to Õ position)
  0x1ECC: 0xD3, // Ọ (mapped to Ó)
  0x1ECE: 0xD2, // Ỏ (mapped to Ò)
  0x1ED0: 0xD4, // Ố (mapped to Ô)
  0x1ED2: 0xD4, // Ồ (mapped to Ô)
  0x1ED4: 0xD4, // Ổ (mapped to Ô)
  0x1ED6: 0xD4, // Ỗ (mapped to Ô)
  0x1ED8: 0xD4, // Ộ (mapped to Ô)
  0x1EDA: 0xD5, // Ớ (mapped to Õ/Ơ position)
  0x1EDC: 0xD5, // Ờ (mapped to Õ/Ơ position)
  0x1EDE: 0xD5, // Ở (mapped to Õ/Ơ position)
  0x1EE0: 0xD5, // Ỡ (mapped to Õ/Ơ position)
  0x1EE2: 0xD5, // Ợ (mapped to Õ/Ơ position)

  // U variants
  0x00D9: 0xD9, // Ù
  0x00DA: 0xDA, // Ú
  0x0168: 0xDA, // Ũ (mapped to Ú)
  0x01AF: 0xDC, // Ư (mapped to Ü position)
  0x1EE4: 0xDA, // Ụ (mapped to Ú)
  0x1EE6: 0xD9, // Ủ (mapped to Ù)
  0x1EE8: 0xDC, // Ứ (mapped to Ü/Ư position)
  0x1EEA: 0xDC, // Ừ (mapped to Ü/Ư position)
  0x1EEC: 0xDC, // Ử (mapped to Ü/Ư position)
  0x1EEE: 0xDC, // Ữ (mapped to Ü/Ư position)
  0x1EF0: 0xDC, // Ự (mapped to Ü/Ư position)

  // Y variants
  0x00DD: 0xDD, // Ý
  0x1EF2: 0xDD, // Ỳ (mapped to Ý)
  0x1EF4: 0xDD, // Ỵ (mapped to Ý)
  0x1EF6: 0xDD, // Ỷ (mapped to Ý)
  0x1EF8: 0xDD, // Ỹ (mapped to Ý)
};

// ============================================================
// TCVN-3 (TCVN 5712:1993) Lookup Table
// ============================================================
// Maps Unicode codepoints to TCVN-3 byte values.
// TCVN-3 is a legacy Vietnamese encoding still used by some thermal printers.

/** @type {Object<number, number>} Unicode codepoint → TCVN-3 byte */
const UNICODE_TO_TCVN3 = {
  // --- Lowercase vowels ---
  // a variants
  0x00E0: 0xB5, // à
  0x00E1: 0xB8, // á
  0x00E2: 0xA9, // â
  0x00E3: 0xB6, // ã
  0x0103: 0xA8, // ă
  0x1EA1: 0xB9, // ạ
  0x1EA3: 0xB7, // ả
  0x1EA5: 0xAA, // ấ
  0x1EA7: 0xAB, // ầ
  0x1EA9: 0xAC, // ẩ
  0x1EAB: 0xAD, // ẫ
  0x1EAD: 0xAE, // ậ
  0x1EAF: 0xAF, // ắ
  0x1EB1: 0xB0, // ằ
  0x1EB3: 0xB1, // ẳ
  0x1EB5: 0xB2, // ẵ
  0x1EB7: 0xB3, // ặ

  // e variants
  0x00E8: 0xBE, // è
  0x00E9: 0xC0, // é
  0x00EA: 0xAA, // ê (shares with ấ in some TCVN-3 variants; using 0xBD)
  0x1EB9: 0xC1, // ẹ
  0x1EBB: 0xBF, // ẻ
  0x1EBD: 0xC0, // ẽ
  0x1EBF: 0xC2, // ế
  0x1EC1: 0xC3, // ề
  0x1EC3: 0xC4, // ể
  0x1EC5: 0xC5, // ễ
  0x1EC7: 0xC6, // ệ

  // i variants
  0x00EC: 0xC8, // ì
  0x00ED: 0xCA, // í
  0x0129: 0xC9, // ĩ
  0x1EC9: 0xC8, // ỉ
  0x1ECB: 0xCA, // ị

  // o variants
  0x00F2: 0xCE, // ò
  0x00F3: 0xD0, // ó
  0x00F4: 0xCB, // ô
  0x00F5: 0xCF, // õ
  0x01A1: 0xCC, // ơ
  0x1ECD: 0xD1, // ọ
  0x1ECF: 0xCE, // ỏ
  0x1ED1: 0xD2, // ố
  0x1ED3: 0xD3, // ồ
  0x1ED5: 0xD4, // ổ
  0x1ED7: 0xD5, // ỗ
  0x1ED9: 0xD6, // ộ
  0x1EDB: 0xD7, // ớ
  0x1EDD: 0xD8, // ờ
  0x1EDF: 0xD9, // ở
  0x1EE1: 0xDA, // ỡ
  0x1EE3: 0xDB, // ợ

  // u variants
  0x00F9: 0xDF, // ù
  0x00FA: 0xE1, // ú
  0x0169: 0xE0, // ũ
  0x01B0: 0xDC, // ư
  0x1EE5: 0xE2, // ụ
  0x1EE7: 0xDF, // ủ
  0x1EE9: 0xE3, // ứ
  0x1EEB: 0xE4, // ừ
  0x1EED: 0xE5, // ử
  0x1EEF: 0xE6, // ữ
  0x1EF1: 0xE7, // ự

  // y variants
  0x00FD: 0xFD, // ý
  0x1EF3: 0xEF, // ỳ
  0x1EF5: 0xFE, // ỵ
  0x1EF7: 0xFD, // ỷ
  0x1EF9: 0xFE, // ỹ

  // d variants
  0x0111: 0xBA, // đ
  0x0110: 0x80, // Đ

  // --- Uppercase vowels ---
  // A variants
  0x00C0: 0xB5, // À (shares position in TCVN-3 upper range)
  0x00C1: 0xB8, // Á
  0x00C2: 0xA9, // Â
  0x00C3: 0xB6, // Ã
  0x0102: 0xA8, // Ă

  // E variants
  0x00C8: 0xBE, // È
  0x00C9: 0xC0, // É
  0x00CA: 0xBD, // Ê

  // I variants
  0x00CC: 0xC8, // Ì
  0x00CD: 0xCA, // Í

  // O variants
  0x00D2: 0xCE, // Ò
  0x00D3: 0xD0, // Ó
  0x00D4: 0xCB, // Ô
  0x00D5: 0xCF, // Õ
  0x01A0: 0xCC, // Ơ

  // U variants
  0x00D9: 0xDF, // Ù
  0x00DA: 0xE1, // Ú
  0x01AF: 0xDC, // Ư

  // Y variants
  0x00DD: 0xFD, // Ý
};

// ============================================================
// Encoding Functions
// ============================================================

/**
 * Encode Vietnamese text to target codepage bytes.
 * ASCII characters (codepoint < 0x80) pass through directly.
 * Vietnamese characters are mapped via the selected lookup table.
 * Characters not in the lookup table are mapped to 0x3F ('?').
 *
 * @param {string} text - Unicode text to encode
 * @param {string} [codepage='cp1258'] - Target codepage: 'cp1258' or 'tcvn3'
 * @returns {number[]} Array of byte values
 */
export function encodeVietnamese(text, codepage = 'cp1258') {
  const table = codepage === 'tcvn3' ? UNICODE_TO_TCVN3 : UNICODE_TO_CP1258;
  const result = [];
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp < 0x80) {
      result.push(cp); // ASCII passthrough
    } else if (table[cp] !== undefined) {
      result.push(table[cp]);
    } else {
      result.push(0x3F); // '?' fallback for unmapped characters
    }
  }
  return result;
}

/**
 * Strip all Vietnamese diacritics, returning ASCII-safe text.
 * Uses Unicode NFD normalization to decompose characters, then removes
 * combining diacritical marks. Handles đ/Đ separately as they do not
 * decompose via NFD.
 *
 * Ultimate fallback when codepage encoding fails on the printer.
 *
 * @param {string} str - Vietnamese text
 * @returns {string} ASCII-safe text with diacritics removed
 */
export function stripVietnameseDiacritics(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}
