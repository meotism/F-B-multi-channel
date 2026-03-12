// Error Handler - Error categorization and Vietnamese messages
// All errors are caught, categorized, and returned as Vietnamese-language messages.
// No raw error messages or English text is shown to the user (NFR 6.4.3).

export const ERROR_MESSAGES = {
  // Network errors
  'NETWORK_ERROR': 'Khong co ket noi mang. Vui long kiem tra lai.',
  'TIMEOUT': 'Yeu cau qua thoi gian cho. Vui long thu lai.',

  // Auth errors
  'INVALID_CREDENTIALS': 'Email hoac mat khau khong dung.',
  'SESSION_EXPIRED': 'Phien dang nhap da het han. Vui long dang nhap lai.',
  'UNAUTHORIZED': 'Ban khong co quyen thuc hien thao tac nay.',
  'RATE_LIMIT': 'Qua nhieu lan thu. Vui long doi 15 phut.',

  // Business logic errors
  'BILL_LOCKED': 'Hoa don da duoc khoa, khong the chinh sua.',
  'TABLE_IN_USE': 'Ban nay dang co don hang, khong the xoa.',
  'TABLE_NOT_EMPTY': 'Ban nay khong trong, khong the tao don hang moi.',
  'ORDER_FINALIZED': 'Don hang da duoc finalize, khong the chinh sua.',
  'INSUFFICIENT_STOCK': 'Nguyen lieu khong du ton kho.',
  'MAP_LOCKED': 'Nguoi khac dang chinh sua so do ban.',
  'DUPLICATE_ORDER': 'Don hang trung lap. Ban nay da co don hang.',
  'CONCURRENT_FINALIZE': 'Hoa don da duoc xu ly boi nguoi khac.',

  // Supabase PostgreSQL error codes
  'PGRST301': 'Phien dang nhap da het han. Vui long dang nhap lai.',
  '23505': 'Du lieu da ton tai. Vui long kiem tra lai.',
  '23503': 'Khong the xoa vi du lieu dang duoc su dung.',
  '42501': 'Ban khong co quyen thuc hien thao tac nay.',

  // Printer errors
  'BLUETOOTH_NOT_SUPPORTED': 'Trinh duyet khong ho tro Bluetooth. Vui long dung Chrome.',
  'PRINTER_NOT_FOUND': 'Khong tim thay may in. Vui long kiem tra may in da bat.',
  'PRINTER_DISCONNECTED': 'Mat ket noi may in. Vui long thu lai.',
  'PRINT_FAILED': 'In that bai. Vui long kiem tra may in va thu lai.',

  // Generic
  'UNKNOWN': 'Da xay ra loi. Vui long thu lai.',
  'VALIDATION': 'Vui long kiem tra lai thong tin nhap.'
};

/**
 * Categorize an error and return a user-friendly Vietnamese message.
 * Logs the error to the console for debugging.
 *
 * @param {Error|object|string} error - The error to handle
 * @param {string} context - Optional context label for console logging
 * @returns {string} User-friendly Vietnamese error message
 */
export function handleError(error, context = '') {
  console.error(`[${context}]`, error);

  let messageKey = 'UNKNOWN';

  if (!error) {
    return ERROR_MESSAGES.UNKNOWN;
  }

  // Supabase error code mapping (e.g., PGRST301, 23505)
  if (error.code && ERROR_MESSAGES[error.code]) {
    messageKey = error.code;
  }
  // Session expired via HTTP status
  else if (error.code === 'PGRST301' || error.status === 401) {
    messageKey = 'SESSION_EXPIRED';
  }
  // Forbidden
  else if (error.status === 403) {
    messageKey = 'UNAUTHORIZED';
  }
  // Rate limiting
  else if (error.status === 429) {
    messageKey = 'RATE_LIMIT';
  }
  // Bill locked (FK constraint or explicit message)
  else if (error.message?.includes('bill_locked') || error.code === '23503') {
    messageKey = 'BILL_LOCKED';
  }
  // Network error (fetch failure)
  else if (error.message?.includes('fetch') || error.name === 'TypeError') {
    messageKey = 'NETWORK_ERROR';
  }
  // Bluetooth error codes
  else if (error.code === 'BLUETOOTH_NOT_SUPPORTED') {
    messageKey = 'BLUETOOTH_NOT_SUPPORTED';
  }
  // Custom error_code from Edge Functions
  else if (error.error_code && ERROR_MESSAGES[error.error_code]) {
    messageKey = error.error_code;
  }
  // String error key
  else if (typeof error === 'string' && ERROR_MESSAGES[error]) {
    messageKey = error;
  }

  return ERROR_MESSAGES[messageKey];
}
