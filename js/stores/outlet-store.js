// Outlet Store - Alpine.store('outlet'): outlet metadata (id, name, address, settings, timezone)
//
// Holds ONLY outlet metadata. Table data lives exclusively in
// Alpine.store('tableMap') -- see table-map-store.js. Do NOT store tables here.

import { supabase } from '../services/supabase-client.js';

export function outletStore() {
  return {
    currentOutlet: null,  // { id, name, address, timezone, settings }

    async loadOutlet(outletId) {
      if (!outletId) return;
      const { data, error } = await supabase
        .from('outlets')
        .select('id, name, address, timezone, settings')
        .eq('id', outletId)
        .maybeSingle();
      if (error) {
        console.error('[outletStore] loadOutlet failed:', error);
        return;
      }
      this.currentOutlet = data;
    },
  };
}
