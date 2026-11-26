// Offline support: cache the app shell so vs-computer games work with no signal.
// Network-first for everything, so a new version shows up on the next load when online.
const CACHE = 'yaniv-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/engine.js', 'js/ai.js', 'js/theme.js', 'js/session.js', 'js/ui.js', 'icons/icon-192.png', 'icons/icon-180.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/ws')) return;
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
