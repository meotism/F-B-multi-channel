/**
 * Service Worker for F&B Manager PWA
 *
 * Caching strategies:
 *   - Static assets (CSS, JS, HTML): stale-while-revalidate
 *     (serve from cache instantly, update in background)
 *   - API calls (supabase.co): network-only
 *   - CDN/external: browser default (no SW interception)
 *
 * No pre-caching: the cache builds up organically as the user navigates.
 * This avoids fragile asset lists that break the SW install on any mismatch.
 */

const CACHE_NAME = 'fb-restaurant-v22';

// ---------------------------------------------------------------------------
// Install: activate immediately, no pre-caching
// ---------------------------------------------------------------------------
self.addEventListener('install', () => self.skipWaiting());

// ---------------------------------------------------------------------------
// Activate: remove old versioned caches, take control of all clients
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
  self.clients.claim();
});

// ---------------------------------------------------------------------------
// Fetch: route requests to the appropriate strategy
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests; let mutations pass through
  if (event.request.method !== 'GET') return;

  // CDN / external: let the browser handle directly (no SW caching)
  if (url.hostname.includes('esm.sh') ||
      url.hostname.includes('jsdelivr.net') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com')) {
    return;
  }

  // API calls (Supabase): network-only — data freshness is critical
  if (url.hostname.includes('supabase.co')) {
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(staleWhileRevalidate(event.request));
});

// ---------------------------------------------------------------------------
// Strategy: stale-while-revalidate
// Serve cached response immediately (if available), then fetch an updated
// copy in the background so the next visit gets fresh content.
// ---------------------------------------------------------------------------
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || new Response('Offline', { status: 503 });
}
