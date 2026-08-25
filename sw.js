// Offline cache.
//
// Two strategies on purpose:
//   lib/**        cache-first. Vendored libraries never change, and pdf.js
//                 pulls font and cmap files at render time -- those must be
//                 on disk before the plane doors close.
//   everything    network-first, falling back to cache. This keeps editing
//   else          painless (refresh shows your change) while still working
//                 with no connection.
//
// Bump CACHE when you change the file list, or the old cache lingers.

const CACHE = 'my-reader-v7';

const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'lib/pdf-textlayer.css',
  'js/app.js',
  'js/db.js',
  'js/reader.js',
  'js/settings.js',
  'js/epub-engine.js',
  'js/pdf-engine.js',
  'lib/jszip.min.js',
  'lib/epub.min.js',
  'lib/pdf.min.mjs',
  'lib/pdf.worker.min.mjs',
  'icons/icon-192.png',
  'icons/icon-512.png',
  // pdf.js falls back to these whenever a PDF does not embed its fonts, which
  // is common. Worth the ~800KB to have them cached up front.
  'lib/standard_fonts/FoxitDingbats.pfb',
  'lib/standard_fonts/FoxitFixed.pfb',
  'lib/standard_fonts/FoxitFixedBold.pfb',
  'lib/standard_fonts/FoxitFixedBoldItalic.pfb',
  'lib/standard_fonts/FoxitFixedItalic.pfb',
  'lib/standard_fonts/FoxitSerif.pfb',
  'lib/standard_fonts/FoxitSerifBold.pfb',
  'lib/standard_fonts/FoxitSerifBoldItalic.pfb',
  'lib/standard_fonts/FoxitSerifItalic.pfb',
  'lib/standard_fonts/FoxitSymbol.pfb',
  'lib/standard_fonts/LiberationSans-Bold.ttf',
  'lib/standard_fonts/LiberationSans-BoldItalic.ttf',
  'lib/standard_fonts/LiberationSans-Italic.ttf',
  'lib/standard_fonts/LiberationSans-Regular.ttf',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, so one missing file cannot fail the whole install.
    await Promise.all(CORE.map(url =>
      cache.add(new Request(url, { cache: 'reload' }))
        .catch(err => console.warn('[sw] could not precache', url, err))
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const immutable = url.pathname.includes('/lib/');
  event.respondWith(immutable ? cacheFirst(request) : networkFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    // { cache: 'no-cache' } matters more than it looks. A plain fetch() inside
    // a service worker still goes through the browser's HTTP cache, and GitHub
    // Pages serves these files with max-age=600 -- so "network first" could
    // hand back a ten-minute-old file without touching the network, then store
    // that stale copy here. This forces a revalidation against the ETag, which
    // costs a 304 and nothing more.
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    throw err;
  }
}
