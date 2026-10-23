/* App instalable: service worker (abrir sin señal) y aviso de versión nueva. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  // Salida de emergencia: app.interesveterinario.com/?reiniciar quita la copia guardada de la app (archivos)
  // y la vuelve a bajar. NO borra la sesión ni las ventas pendientes de enviar.
  if (/[?&]reiniciar/.test(location.search)) {
    navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })
      .then(function () { return window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf('iv-app-') === 0; }).map(function (k) { return caches.delete(k); })); }) : 0; })
      .catch(function () {}).then(function () { location.replace(location.pathname); });
    return;
  }
  var recargando = false;
  var cargada = Date.now();
  // versión nueva activa: recién abierta se recarga sola; si ya estás trabajando, solo se avisa (para no perder lo capturado)
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (recargando) return;
    if (Date.now() - cargada < 20000) { recargando = true; location.reload(); return; }
    if (document.getElementById('pwaNueva')) return;
    var b = document.createElement('div'); b.id = 'pwaNueva'; b.className = 'pwa-nueva';
    b.innerHTML = '<span>✨ Hay una versión nueva de la app</span><button class="btn primario chico">Recargar</button>';
    b.querySelector('button').onclick = function () { recargando = true; location.reload(); };
    document.body.appendChild(b);
  });
  function avisar(sw) {
    if (document.getElementById('pwaNueva')) return;
    var b = document.createElement('div');
    b.id = 'pwaNueva'; b.className = 'pwa-nueva';
    b.innerHTML = '<span>✨ Hay una versión nueva de la app</span><button class="btn primario chico">Actualizar</button>';
    b.querySelector('button').onclick = function () { b.querySelector('button').disabled = true; sw.postMessage('actualizar'); };
    document.body.appendChild(b);
  }
  // Recién abierta la app (primeros 20 s, sin trabajo en pantalla) la versión nueva se aplica sola; después se avisa con un botón.
  function nueva(sw) { sw.postMessage('actualizar'); }
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      if (reg.waiting && navigator.serviceWorker.controller) nueva(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var n = reg.installing; if (!n) return;
        n.addEventListener('statechange', function () { if (n.state === 'installed' && navigator.serviceWorker.controller) nueva(n); });
      });
      reg.update().catch(function () {});
      var revisar = function () { reg.update().catch(function () {}); };
      setInterval(revisar, 10 * 60000);   // revisa cada 10 min
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') revisar(); });
      window.addEventListener('focus', revisar);
      window.addEventListener('online', revisar);
    }).catch(function (e) { console.warn('Service worker:', e); });
  });
})();
