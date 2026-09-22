// Service worker: makes Noter installable and lets you read public pages
// you've opened before while offline. Private pages are never cached.
const SHELL_CACHE = 'noter-shell-v1';
const API_CACHE = 'noter-api';
const SHELL = [
  '/',
  '/app.css',
  '/files.html',
  '/js/theme-init.js',
  '/js/app/main.js',
  '/js/app/page.js',
  '/js/app/sidebar.js',
  '/js/app/dialogs.js',
  '/js/lib/api.js',
  '/js/lib/ui.js',
  '/js/lib/identity.js',
  '/js/lib/markdown.js',
  '/js/files.js',
  '/vendor/marked.esm.js',
  '/vendor/purify.es.mjs',
  '/vendor/diff3.mjs',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('noter-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isPageData(url) {
  return url.pathname === '/api/pages' || /^\/api\/pages\/[^/]+$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page data: network first, fall back to the last copy of a public page
  if (isPageData(url)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const cacheable = response.ok && response.headers.get('X-Noter-Protected') !== '1' && url.pathname !== '/api/pages';
          const copy = response.clone();
          if (cacheable) caches.open(API_CACHE).then(cache => cache.put(request, copy));
          else if (response.status === 401) caches.open(API_CACHE).then(cache => cache.delete(request));
          return response;
        })
        .catch(() => caches.match(request).then(hit => hit || Response.error()))
    );
    return;
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/download/') || url.pathname.startsWith('/s/')) return;

  // App pages: network first so updates arrive, shell as fallback
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }

  // Static assets: network first (so a deploy never mixes old and new code),
  // cached copy when offline
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then(hit => hit || Response.error()))
  );
});
