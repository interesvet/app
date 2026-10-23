/* Service worker de la app instalable. Versión: __VERSION__ (la pone tools/construir.py) */
const VERSION = '__VERSION__';
const CACHE = 'iv-app-' + VERSION, CACHE_EXT = 'iv-ext-v1';
const ARCHIVOS = __ARCHIVOS__;
const EXTERNOS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)\//;

self.addEventListener('install', e => {
  // la versión nueva se activa de inmediato (no espera a que se cierren todas las ventanas)
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
    // la app: con señal se baja lo más nuevo (máx. 4 s) y se guarda; sin señal o red lenta, lo guardado
    e.respondWith(caches.open(CACHE).then(c => {
      const guardado = () => c.match(r, { ignoreSearch: true }).then(m => m || caches.match(r, { ignoreSearch: true })).then(m => m || (r.mode === 'navigate' ? c.match('./') : undefined));
      const red = fetch(new Request(r, { cache: 'no-cache' })).then(resp => { if (resp && resp.ok) c.put(r, resp.clone()); return resp; });
      return new Promise(ok => {
        let listo = false; const dar = x => { if (!listo && x) { listo = true; ok(x); } };
        const t = setTimeout(() => guardado().then(m => m ? dar(m) : red.then(dar, () => {})), 4000);
        red.then(resp => { clearTimeout(t); resp.ok ? dar(resp) : guardado().then(m => dar(m || resp)); },
          () => { clearTimeout(t); guardado().then(m => dar(m || Response.error())); });
      });
    }));
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
