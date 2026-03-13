// Outlet Guard - assertOutlet() for outlet isolation enforcement
// Compares a given outlet ID against the authenticated user's outlet_id
// from Alpine.store('auth'). Throws if they don't match or the store
// outlet is missing. Used to enforce client-side outlet isolation.

/**
 * Assert that the given outlet ID matches the authenticated user's outlet.
 * Throws an error if the IDs don't match or the user's outlet is not set.
 *
 * @param {string} outletId - The outlet ID to verify
 * @throws {Error} With message 'OUTLET_MISMATCH' if validation fails
 */
export function assertOutlet(outletId) {
  const storeOutletId = Alpine.store('auth').user?.outlet_id;

  if (!storeOutletId || storeOutletId !== outletId) {
    throw new Error('OUTLET_MISMATCH');
  }
}
