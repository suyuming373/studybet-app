// 賭讀 / StudyBet — service worker.
// Bump CACHE_VERSION (and APP_VERSION in src/version.js) on every release.
importScripts('./sw-push.js');

const CACHE_VERSION = 'v1.1.1';
const SHELL = `studybet-shell-${CACHE_VERSION}`;
const CDN = `studybet-cdn-${CACHE_VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './push.js',
  './onboarding.js',
  './sw-push.js',
  './src/api-supabase.js',
  './src/clock.js',
  './src/debug.js',
  './src/dom.js',
  './src/errors.js',
  './src/fx.js',
  './src/home.js',
  './src/idb.js',
  './src/image.js',
  './src/pairing.js',
  './src/sheets.js',
  './src/store.js',
  './src/time.js',
  './src/version.js',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-96.png',
];

// supabase-js 2.117.3 (jsDelivr ESM build) and every module it imports, all version-pinned.
// Keep in sync with SUPABASE_JS in src/api-supabase.js.
const CDN_FILES = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm',
  'https://cdn.jsdelivr.net/npm/@supabase/functions-js@2.117.3/+esm',
  'https://cdn.jsdelivr.net/npm/@supabase/postgrest-js@2.117.3/+esm',
  'https://cdn.jsdelivr.net/npm/@supabase/realtime-js@2.117.3/+esm',
  'https://cdn.jsdelivr.net/npm/@supabase/storage-js@2.117.3/+esm',
  'https://cdn.jsdelivr.net/npm/@supabase/auth-js@2.117.3/+esm',
  'https://cdn.jsdelivr.net/npm/@supabase/phoenix@0.4.5/+esm',
  'https://cdn.jsdelivr.net/npm/tslib@2.8.1/+esm',
  'https://cdn.jsdelivr.net/npm/iceberg-js@0.8.1/+esm',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })));
    // The CDN is best effort: the app shell must install even if jsDelivr is slow.
    const cdn = await caches.open(CDN);
    await Promise.all(CDN_FILES.map((u) => cdn.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, CDN]);
    for (const k of await caches.keys()) if (k.startsWith('studybet-') && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(event, request, cacheKey) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(cacheKey || request, { ignoreSearch: true });
  const network = fetch(request).then((res) => {
    if (res && res.ok && res.type === 'basic') cache.put(cacheKey || request, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { event.waitUntil(network); return cached; }
  return (await network) || new Response('offline', { status: 503, statusText: 'offline' });
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request, { cache: 'no-store' });
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) || new Response('', { status: 503 });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CDN);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === 'https://cdn.jsdelivr.net') { event.respondWith(cacheFirst(req)); return; }
  if (url.origin !== self.location.origin) return;            // Supabase, Turnstile: straight to network
  if (req.mode === 'navigate') { event.respondWith(staleWhileRevalidate(event, req, './index.html')); return; }
  if (url.pathname.endsWith('/config.js')) { event.respondWith(networkFirst(req)); return; }
  event.respondWith(staleWhileRevalidate(event, req));
});
