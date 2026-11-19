// sw.js — Service worker for offline support
// Online: network-first, so a new deployment is picked up on the next launch; responses are cached.
// Offline: serve from cache so the app and imported books still work.
const CACHE = 'folio-1.2.3';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'reader.js', 'annotations.js', 'stats.js', 'cover.js', 'epub.js', 'library.js', 'sync.js', 'importer.js', 'formats.js', 'db.js', 'ui.js', 'lib/t2s.js', 'collector.js',
  'fonts/NotoSerifSC-Regular.woff', 'fonts/NotoSerifSC-Medium.woff', 'manifest.json', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'favicon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      // Fall back to cache if the network takes longer than 4 s
      const res = await Promise.race([
        fetch(req, { cache: 'no-cache' }),
        new Promise((_, reject) => setTimeout(() => reject('timeout'), 4000)),
      ]);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch {
      return (await caches.match(req, { ignoreSearch: true })) || caches.match('index.html');
    }
  })());
});
