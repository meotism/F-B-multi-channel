// Outlet Store - Alpine.store('outlet'): outlet metadata (id, name, address, timezone)
//
// Holds ONLY outlet metadata. Table data lives exclusively in
// Alpine.store('tableMap') -- see table-map-store.js. Do NOT store tables here.

export function outletStore() {
  return {
    currentOutlet: null,  // { id, name, address, timezone }

    /** Fetch outlet metadata from Supabase -- stub, implemented in Sprint 1 */
    async loadOutlet(outletId) { /* fetch outlet metadata from Supabase */ },
  };
}
