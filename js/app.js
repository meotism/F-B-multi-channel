// App - Bootstrap: init Supabase, register stores, start router
//
// Application entry point. Initializes Supabase client, registers all Alpine.js
// global stores, and boots the router after authentication is resolved.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { authStore } from './stores/auth-store.js';
import { outletStore } from './stores/outlet-store.js';
import { tableMapStore } from './stores/table-map-store.js';
import { printerStore } from './stores/printer-store.js';
import { uiStore } from './stores/ui-store.js';
import { orderStore } from './stores/order-store.js';
import { reportStore } from './stores/report-store.js';
import { initRouter } from './router.js';
import { initRealtimeSubscriptions, unsubscribeAll } from './services/realtime-service.js';

// Page components -- imported for side effects (registers on window for x-data)
import './pages/auth/login-page.js';
import './pages/table-map/table-map-page.js';
import './pages/users/users-page.js';
import './pages/inventory/ingredients-page.js';
import './pages/inventory/inventory-page.js';
import './pages/categories/categories-page.js';
import './pages/menu/menu-list-page.js';
import './pages/menu/menu-edit-page.js';
import './pages/orders/order-page.js';
import './pages/bills/bill-page.js';
import './pages/reports/reports-page.js';
import './pages/settings/settings-page.js';

// Initialize Supabase client (singleton)
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Register Alpine stores before Alpine.start()
document.addEventListener('alpine:init', () => {
  Alpine.store('auth', authStore());
  Alpine.store('outlet', outletStore());
  Alpine.store('tableMap', tableMapStore());  // single source of truth for table data
  Alpine.store('printer', printerStore());
  Alpine.store('ui', uiStore());
  Alpine.store('orders', orderStore());   // order state, cart, menu browsing
  Alpine.store('reports', reportStore()); // report state, date range, chart data
});

// After Alpine starts, initialize app
document.addEventListener('alpine:initialized', async () => {
  await Alpine.store('auth').init();
  if (Alpine.store('auth').isAuthenticated) {
    const outletId = Alpine.store('auth').user.outlet_id;
    await Alpine.store('outlet').loadOutlet(outletId);
    await Alpine.store('tableMap').loadTables(outletId);
    // Initialize centralized Realtime subscriptions for this outlet
    initRealtimeSubscriptions(outletId);
  }
  // Start hash-based SPA router after auth state is resolved
  initRouter();
});
