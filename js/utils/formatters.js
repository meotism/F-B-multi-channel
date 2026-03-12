// Formatters - formatVND(), formatVNDFull(), formatDate(), formatDuration()
// Timer utilities - calculateElapsed(), formatTimer(), getTimerDisplay(), getTimerColorClass()
// VND has no decimal places -- all amounts are integers.
// All date/time formatting uses 'vi-VN' locale per design spec.

/**
 * Format an amount as Vietnamese Dong (dots as thousands separator).
 * Input: integer (e.g., 150000)
 * Output: "150.000"
 */
export function formatVND(amount) {
  if (amount == null) return '0';
  return new Intl.NumberFormat('vi-VN').format(Math.round(amount));
}

/**
 * Format an amount as Vietnamese Dong with "VND" suffix.
 * Output: "150.000 VND"
 */
export function formatVNDFull(amount) {
  return formatVND(amount) + ' VND';
}

/**
 * Format a date string using vi-VN locale.
 * @param {string} dateStr - ISO date string or any Date-parseable string
 * @param {string} format - 'short' for DD/MM/YYYY, 'long' for DD/MM/YYYY HH:mm:ss
 * @returns {string} Formatted date string
 */
export function formatDate(dateStr, format = 'short') {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (format === 'short') {
    return date.toLocaleDateString('vi-VN'); // DD/MM/YYYY
  }
  return date.toLocaleString('vi-VN'); // DD/MM/YYYY HH:mm:ss
}

/**
 * Format elapsed time from a start timestamp as HH:MM:SS.
 * Used for table serving timers.
 * @param {string} startedAt - ISO timestamp of when the timer started
 * @returns {string} Formatted duration "HH:MM:SS"
 */
export function formatDuration(startedAt) {
  if (!startedAt) return '00:00:00';
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const elapsed = Math.floor((now - start) / 1000);
  if (elapsed < 0) return '00:00:00';
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// --- Timer Utility Functions (design Section 4.4.2) ---
// Pure functions for serving-table elapsed time display.
// Requirements: 5.3 AC-2 (live timer display), 5.3 AC-5 (HH:MM:SS format)

/** Timer color threshold: 1 hour in seconds */
const TIMER_WARNING_THRESHOLD = 3600;

/** Timer color threshold: 2 hours in seconds */
const TIMER_DANGER_THRESHOLD = 7200;

/**
 * Calculate elapsed seconds from an ISO timestamp to now.
 * Returns null for null/undefined input. Negative elapsed values
 * are clamped to 0 (future timestamps treated as just started).
 *
 * @param {string|null|undefined} startedAt - ISO timestamp
 * @returns {number|null} Elapsed seconds, or null if input is null/undefined
 */
export function calculateElapsed(startedAt) {
  if (startedAt == null) return null;
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - start) / 1000));
}

/**
 * Format total seconds as HH:MM:SS string.
 * Returns empty string for null/undefined input.
 * Handles 0 seconds ("00:00:00") and hours > 99 (e.g., "100:00:00").
 *
 * @param {number|null|undefined} totalSeconds - Total elapsed seconds
 * @returns {string} Formatted timer string "HH:MM:SS" or empty string
 */
export function formatTimer(totalSeconds) {
  if (totalSeconds == null) return '';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

/**
 * Get the formatted timer display string for a table.
 * Returns a formatted HH:MM:SS string only for tables with status 'serving'
 * and an activeOrderStartedAt timestamp set. Returns empty string otherwise.
 *
 * @param {Object} table - Table object with status and activeOrderStartedAt
 * @returns {string} Formatted timer string or empty string
 */
export function getTimerDisplay(table) {
  if (!table || table.status !== 'serving' || !table.activeOrderStartedAt) {
    return '';
  }
  return formatTimer(calculateElapsed(table.activeOrderStartedAt));
}

/**
 * Get CSS class for timer color coding based on elapsed seconds.
 * Thresholds per design Section 4.4.5:
 *   - < 1 hour (3600s): '' (default/white)
 *   - 1-2 hours (3600-7200s): 'timer--warning' (yellow)
 *   - > 2 hours (7200s+): 'timer--danger' (red)
 *
 * @param {number|null|undefined} totalSeconds - Total elapsed seconds
 * @returns {string} CSS class name or empty string
 */
export function getTimerColorClass(totalSeconds) {
  if (totalSeconds == null || totalSeconds < TIMER_WARNING_THRESHOLD) return '';
  if (totalSeconds >= TIMER_DANGER_THRESHOLD) return 'timer--danger';
  return 'timer--warning';
}
