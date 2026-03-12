// Navigate - navigate() helper for hash routing
// Sets window.location.hash for client-side navigation.

/**
 * Navigate to a path using hash-based routing.
 * @param {string} path - The route path (e.g., '/tables', '/orders/123')
 */
export function navigate(path) {
  window.location.hash = '#' + path;
}

/**
 * Get the current route path from the hash.
 * @returns {string} Current path without the '#' prefix, defaults to '/'
 */
export function getCurrentPath() {
  return window.location.hash.slice(1) || '/';
}
