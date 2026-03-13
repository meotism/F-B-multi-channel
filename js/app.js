// App - Bootstrap: init Supabase, register stores, start router
//
// Application entry point. Imports Alpine.js as ES module (not CDN auto-start)
// to guarantee stores are registered BEFORE Alpine processes the DOM.
// Then initializes auth, loads outlet data, and starts the router.

import Alpine from 'https://esm.sh/alpinejs@3';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { authStore } from './stores/auth-store.js';
import { outletStore } from './stores/outlet-store.js';
import { tableMapStore } from './stores/table-map-store.js';
import { printerStore } from './stores/printer-store.js';
import { uiStore } from './stores/ui-store.js';
import { orderStore } from './stores/order-store.js';
import { reportStore } from './stores/report-store.js';
import { initRouter } from './router.js';
import { initRealtimeSubscriptions } from './services/realtime-service.js';
import { cacheManager } from './services/cache-manager.js';
import { initCacheInvalidation } from './services/cache-invalidation.js';

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
import './pages/bills/bill-list-page.js';
import './pages/reports/reports-page.js';
import './pages/settings/settings-page.js';
import './pages/discounts/discounts-page.js';
import './pages/dashboard/dashboard-page.js';
import './pages/orders/order-list-page.js';

// Make Alpine available globally (required for x-data, $store, etc. in templates)
window.Alpine = Alpine;

// Register all stores BEFORE Alpine.start() so $store references work
Alpine.store('auth', authStore());
Alpine.store('outlet', outletStore());
Alpine.store('tableMap', tableMapStore());
Alpine.store('printer', printerStore());
Alpine.store('ui', uiStore());
Alpine.store('orders', orderStore());
Alpine.store('reports', reportStore());

// Start Alpine - processes all x-data, x-show, etc. directives in the DOM
Alpine.start();

// Online/offline connectivity tracking
// Task 24.1: Flush offline queue on reconnect
window.addEventListener('online', async () => {
  Alpine.store('ui').isOffline = false;
  Alpine.store('ui').showToast('Đã kết nối lại', 'success');

  // Flush pending offline operations
  try {
    const { offlineQueue } = await import('./services/offline-queue.js');
    const queueSize = offlineQueue.getSize();
    if (queueSize > 0) {
      const { processed, failed } = await offlineQueue.flush();
      if (processed > 0 || failed > 0) {
        Alpine.store('ui').showToast(
          `Đã đồng bộ ${processed} thao tác.${failed ? ` ${failed} thất bại, sẽ thử lại.` : ''}`,
          failed ? 'warning' : 'success',
        );
      }
    }
  } catch (err) {
    console.error('[App] Offline queue flush failed:', err);
  }
});
window.addEventListener('offline', () => {
  Alpine.store('ui').isOffline = true;
});

// Offline cache notification — show toast once per offline period
let offlineToastShown = false;
window.addEventListener('cache:offline-served', () => {
  if (!offlineToastShown) {
    Alpine.store('ui').showToast('Đang offline — hiển thị dữ liệu từ cache', 'warning');
    offlineToastShown = true;
  }
});
window.addEventListener('online', () => { offlineToastShown = false; });

// Bootstrap: init auth, load data, start router
async function bootstrap() {
  try {
    await Alpine.store('auth').init();
    if (Alpine.store('auth').isAuthenticated) {
      const outletId = Alpine.store('auth').user.outlet_id;
      await Alpine.store('outlet').loadOutlet(outletId);
      await Alpine.store('tableMap').loadTables(outletId);
      initRealtimeSubscriptions(outletId);
      initCacheInvalidation(cacheManager, outletId);
    }
  } catch (err) {
    console.error('[App] Bootstrap error:', err);
  }
  // Start hash-based SPA router after auth state is resolved
  initRouter();
}

bootstrap();
