// Service worker for Billtracker PWA.
//
// Strategy:
//   - On install: precache the application shell (HTML, JS, CSS, fonts, icons,
//     manifest) so the app boots offline.
//   - On fetch:
//     * Same-origin /api/* requests: bypass the cache, network-only. We never
//       want stale API answers and writes must always hit the server.
//     * Same-origin static assets: cache-first with network fallback. New
//       deploys bump the SW_VERSION constant which invalidates caches.
//     * Navigation (HTML) requests: try network, fall back to cached index.
//   - On activate: drop any caches whose name doesn't match SW_VERSION.
//
// SW_VERSION is replaced at build time (see vite.config.js). When the CSS or
// JS bundle hash changes, Vite emits new filenames — but the SW itself only
// changes when SW_VERSION changes, so update this string when shipping a new
// PWA release.

const SW_VERSION = '__SW_VERSION__';
const SHELL_CACHE = `billtracker-shell-${SW_VERSION}`;
const ASSET_CACHE = `billtracker-assets-${SW_VERSION}`;

// The list of shell URLs is injected at build time. Fallback to a minimal set
// for dev/manual loads.
const SHELL_URLS = self.__SHELL_URLS__ || [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails atomically — if any URL 404s the install fails, which is
    // exactly what we want.
    await cache.addAll(SHELL_URLS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n !== SHELL_CACHE && n !== ASSET_CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Cross-origin (e.g. devtools, analytics if any later) — let the network
  // handle it normally.
  if (url.origin !== self.location.origin) return;

  // Never cache the API. Always go to network. If offline we let the request
  // fail so the local-store fallback can kick in client-side.
  if (url.pathname.startsWith('/api/')) {
    return; // default browser handling = network
  }

  // Navigation requests: network-first with cached index fallback so the app
  // works on a flaky connection.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match('./index.html') || await cache.match('./');
        if (cached) return cached;
        return new Response('<h1>Offline</h1>', { status: 503, headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // Other GETs (JS, CSS, fonts, icons, manifest): cache-first with network
  // fallback. Successful network responses are cached for future offline use.
  if (req.method === 'GET') {
    event.respondWith((async () => {
      const shellMatch = await caches.match(req);
      if (shellMatch) return shellMatch;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(ASSET_CACHE);
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
  }
});

// Allow the page to ask the SW to activate immediately on update.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
