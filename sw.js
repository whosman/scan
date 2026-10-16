// Offline cache. After one visit, the app opens with no connection.
// The page itself is fetched from the network first (so an update shows on the next open, not the one after), then falls back to the cache.
// Icons and the manifest come from the cache first.
const CACHE = 'scan-v11';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const isPage = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  if (isPage) {
    e.respondWith(
      Promise.race([
        fetch(e.request, { cache: 'no-cache' }).then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000)),
      ]).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const refresh = fetch(e.request).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => hit);
      return hit || refresh;
    })
  );
});