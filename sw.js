// sw.js — Service worker for offline support
// Online: network-first, so a new deployment is picked up on the next launch; responses are cached.
// Offline: serve from cache so the app and imported books still work.
const CACHE = 'folio-1.3.9';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'desktop.js', 'reader.js', 'annotations.js', 'stats.js', 'cover.js', 'epub.js', 'backup.js', 'library.js', 'sync.js', 'cloud.js', 'repo.js', 'migrate.js', 'importer.js', 'formats.js', 'links.js', 'db.js', 'ui.js', 'lib/t2s.js', 'collector.js', 'push.js',
  'fonts/NotoSerifSC-Regular.woff', 'fonts/NotoSerifSC-Medium.woff', 'fonts/sans/sans.css', 'fonts/sans/folio-quotes.woff2', 'fonts/inter-latin-wght-normal.woff2',
  // The Chinese pieces of Folio Sans (fonts/sans/*.woff2) are cached as they are first shown, not up front:
  // devices with PingFang never need them
  'manifest.json', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'favicon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'folio-open').map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // The page itself is fetched past every cache: with a unique query, so neither the browser nor
  // GitHub Pages' CDN can hand back an older index.html (whose version line and script addresses
  // would then lag behind the deployment). It is cached under the app's own address for offline use.
  const nav = req.mode === 'navigate';
  e.respondWith((async () => {
    try {
      const url = new URL(req.url);
      if (nav) url.searchParams.set('_', Date.now());
      // Fall back to cache if the network takes longer than 4 s
      let res = await Promise.race([
        nav ? fetch(url.href, { cache: 'no-store', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' }),
        new Promise((_, reject) => setTimeout(() => reject('timeout'), 4000)),
      ]);
      if (nav && res.ok) res = new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
      if (res.ok) (await caches.open(CACHE)).put(nav ? self.registration.scope : req, res.clone());
      return res;
    } catch {
      return (nav ? await caches.match(self.registration.scope) : await caches.match(req, { ignoreSearch: true })) || caches.match('index.html');
    }
  })());
});

// ---- 收书 notifications (push.js; sent by .github/workflows/folio-push.yml in the data repository) ----
// Messages are Declarative Web Push JSON ({ web_push: 8030, notification: { title, body, navigate } }):
// iOS 18.4+ shows them by itself; for other systems, or when this worker handles the event, the
// same notification is shown here. Every push shows a notification, as iOS requires.
self.addEventListener('push', e => {
  let n = {};
  try { n = e.data?.json()?.notification || {}; } catch {}
  e.waitUntil(self.registration.showNotification(n.title || 'Folio', {
    body: n.body || '', tag: 'folio-collected', icon: 'icon-192.png', data: { url: n.navigate || './?from=push' },
  }));
});
// A tap: bring an open Folio window forward (and tell it), or open Folio. The address the
// notification points to (which book to open) is also left in the small cache 'folio-open', because
// iOS may start the app on its start page and drop the address that openWindow was given; Folio
// reads and removes that note when it starts or comes to the front (app.js, takePendingOpen).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './?from=push', self.registration.scope).href;
  e.waitUntil((async () => {
    try { await (await caches.open('folio-open')).put('pending', new Response(JSON.stringify({ url, at: Date.now() }))); } catch {}
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => c.url.startsWith(self.registration.scope));
    if (w) { await w.focus().catch(() => {}); w.postMessage({ type: 'push-open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
