// Validators - Input validation functions
// All validators return null if valid, or a Vietnamese error message string if invalid.
// Pure functions with no side effects.

/**
 * Validate that a value is not empty.
 * @param {*} value - The value to check
 * @returns {string|null} Error message or null if valid
 */
export function required(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return 'Truong nay khong duoc de trong';
  }
  return null;
}

/**
 * Validate that a string does not exceed a maximum length.
 * @param {*} value - The value to check
 * @param {number} max - Maximum allowed length
 * @returns {string|null} Error message or null if valid
 */
export function maxLength(value, max) {
  if (value && String(value).length > max) {
    return `Khong duoc vuot qua ${max} ky tu`;
  }
  return null;
}

/**
 * Validate that a value is a valid email address.
 * @param {string} value - The email string to validate
 * @returns {string|null} Error message or null if valid
 */
export function isEmail(value) {
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'Email khong hop le';
  }
  return null;
}

/**
 * Validate that a value is a positive number (> 0).
 * @param {*} value - The value to check
 * @returns {string|null} Error message or null if valid
 */
export function isPositiveNumber(value) {
  const num = Number(value);
  if (isNaN(num) || num <= 0) {
    return 'Gia tri phai la so duong';
  }
  return null;
}

/**
 * Validate that a value is a valid UUID v4 format.
 * @param {string} value - The string to check
 * @returns {string|null} Error message or null if valid
 */
export function isUUID(value) {
  if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return 'ID khong hop le';
  }
  return null;
}
