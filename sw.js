/* sw.js - keeps the whole app on the phone so it works with no internet. */
const CACHE = 'hwscan-v24';
const FILES = ['./', 'index.html', 'app.js', 'i18n.js', 'db.js', 'pdf.js', 'worker.js', 'engine.wasm', 'engine-simd.wasm', 'updown.json', 'updown.bin',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request).then((res) => {
    // files used on demand (the JavaScript engine for phones with no WebAssembly) are kept after the first download
    if (res.ok && /engine-js\.js/.test(e.request.url)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});