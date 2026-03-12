// Retry - withRetry() utility for critical operations
// Uses exponential backoff (delayMs * attempt) between retries.
// Pure async utility with no external dependencies.

/**
 * Retry an async function with exponential backoff.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} options - Retry options
 * @param {number} options.maxAttempts - Maximum number of attempts (default: 3)
 * @param {number} options.delayMs - Base delay in milliseconds between retries (default: 1000)
 * @param {string} options.context - Label for console warning on failures (default: '')
 * @returns {Promise<*>} Result of the function call
 * @throws {Error} The last error if all attempts fail
 */
export async function withRetry(fn, { maxAttempts = 3, delayMs = 1000, context = '' } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      console.warn(`[${context}] Attempt ${attempt}/${maxAttempts} failed:`, error);
      if (attempt === maxAttempts) {
        throw error;
      }
      // Exponential backoff: delayMs * attempt (1x, 2x, 3x, ...)
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}
