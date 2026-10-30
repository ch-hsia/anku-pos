// 離線快取：安裝時快取所有程式檔，之後一律先用快取（現場沒有網路）。
// 更新程式時把 CACHE 的版本號加一，新版會在下次開啟時生效。
const CACHE = 'anku-pos-v6';
const FILES = [
  './',
  'index.html',
  'style.css',
  'core.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('anku-pos-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => (request.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    }),
  );
});
