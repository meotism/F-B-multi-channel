/**
 * Service Worker for F&B Manager PWA
 *
 * Caching strategies:
 * - Install: pre-cache critical static assets for offline shell
 * - Activate: clean old versioned caches
 * - Fetch:
 *   - Static assets (CSS, JS, HTML): stale-while-revalidate
 *   - API calls (supabase.co): network-first with JSON error fallback
 *   - Other requests: network-only
 */

const CACHE_NAME = 'fb-restaurant-v13';

// Critical static assets to pre-cache during installation.
// This list covers the app shell, all CSS, core JS, store modules, and page HTML.
// NOTE: Only include files that actually exist — missing files will cause cache.addAll() to fail.
const STATIC_ASSETS = [
  './',
  './index.html',
  // CSS - core
  './css/variables.css',
  './css/reset.css',
  './css/layout.css',
  './css/components.css',
  './css/utilities.css',
  // CSS - pages
  './css/pages/auth.css',
  './css/pages/table-map.css',
  './css/pages/order.css',
  './css/pages/orders.css',
  './css/pages/bills.css',
  './css/pages/menu.css',
  './css/pages/inventory.css',
  './css/pages/reports.css',
  './css/pages/users.css',
  './css/pages/settings.css',
  // JS - core
  './js/app.js',
  './js/config.js',
  './js/router.js',
  // JS - stores
  './js/stores/auth-store.js',
  './js/stores/outlet-store.js',
  './js/stores/table-map-store.js',
  './js/stores/printer-store.js',
  './js/stores/ui-store.js',
  './js/stores/order-store.js',
  './js/stores/report-store.js',
  // JS - cache layer
  './js/services/cache-manager.js',
  './js/services/cached-query.js',
  './js/services/cache-invalidation.js',
  // Manifest
  './manifest.json',
  // Page HTML templates
  './pages/login.html',
  './pages/table-map.html',
  './pages/order.html',
  './pages/bill.html',
  './pages/menu-list.html',
  './pages/menu-edit.html',
  './pages/categories.html',
  './pages/inventory.html',
  './pages/ingredients.html',
  './pages/reports.html',
  './pages/users.html',
  './pages/settings.html',
];

// ---------------------------------------------------------------------------
// Install: pre-cache all static assets so the app shell works offline
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn('SW: failed to cache', url, err)
          )
        )
      )
    )
  );
  // Activate new SW immediately without waiting for old clients to close
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Activate: remove any caches from previous versions
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

// ---------------------------------------------------------------------------
// Fetch: route requests to the appropriate caching strategy
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests; let mutations (POST/PUT/DELETE) pass through
  if (event.request.method !== 'GET') return;

  // CDN / external modules: let the browser handle directly (no caching)
  // These are ES modules from esm.sh and scripts from jsdelivr — caching them
  // in the SW can cause stale or corrupt module responses and blank pages.
  if (url.hostname.includes('esm.sh') ||
      url.hostname.includes('jsdelivr.net') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com')) {
    return; // fall through to browser default fetch
  }

  // API calls (Supabase): network-first -- always try for fresh data
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Static assets: stale-while-revalidate -- fast from cache, update in background
  event.respondWith(staleWhileRevalidate(event.request));
});

// ---------------------------------------------------------------------------
// Strategy: network-first
// Try the network; on failure return a JSON error with Vietnamese message.
// No cache fallback for API calls -- data freshness is critical.
// ---------------------------------------------------------------------------
async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Khong co ket noi mang' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Strategy: stale-while-revalidate
// Serve cached response immediately (if available), then fetch an updated
// copy in the background so the next visit gets fresh content.
// ---------------------------------------------------------------------------
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Always attempt a network fetch to update the cache for next time
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Return cached version instantly, or wait for the network response
  return cached || (await fetchPromise) || new Response('Offline', { status: 503 });
}
