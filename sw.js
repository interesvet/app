/* Service worker de la app instalable. Versión: 20261016-f4a17740 (la pone tools/construir.py) */
const VERSION = '20261016-f4a17740';
const CACHE = 'iv-app-' + VERSION, CACHE_EXT = 'iv-ext-v1';
const ARCHIVOS = ["./", "index.html", "estilos.css", "app.js", "config.js", "shim.js", "pwa.js", "manifest.webmanifest", "logo.png", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon.png"];
const EXTERNOS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('iv-app-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'actualizar') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;                                   // las llamadas al servidor (POST) nunca se guardan
  const url = new URL(r.url);
  if (url.origin === location.origin) {
    // la app: primero lo guardado (abre al instante y sin señal); las versiones nuevas llegan por el aviso "Actualizar"
    e.respondWith(caches.match(r, { ignoreSearch: true }).then(m => m || fetch(r).catch(() => r.mode === 'navigate' ? caches.match('./') : undefined)));
    return;
  }
  if (EXTERNOS.test(r.url)) {
    // tipografía y gráficas: lo guardado y se refresca en segundo plano
    e.respondWith(caches.open(CACHE_EXT).then(c => c.match(r).then(m => {
      const red = fetch(r).then(resp => { if (resp && (resp.ok || resp.type === 'opaque')) c.put(r, resp.clone()); return resp; }).catch(() => m);
      return m || red;
    })));
  }
});
