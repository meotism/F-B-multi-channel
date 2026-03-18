// Self-destructing service worker — replaces the old caching SW.
// When the old SW detects this as a new version, it installs and activates.
// On activation, this SW clears all caches and unregisters itself,
// ensuring all users get fresh files from the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    ).then(() => self.registration.unregister())
  );
});
