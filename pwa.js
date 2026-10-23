/* App instalable: service worker (abrir sin señal) y aviso de versión nueva. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  var recargando = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () { if (recargando) return; recargando = true; location.reload(); });
  function avisar(sw) {
    if (document.getElementById('pwaNueva')) return;
    var b = document.createElement('div');
    b.id = 'pwaNueva'; b.className = 'pwa-nueva';
    b.innerHTML = '<span>✨ Hay una versión nueva de la app</span><button class="btn primario chico">Actualizar</button>';
    b.querySelector('button').onclick = function () { b.querySelector('button').disabled = true; sw.postMessage('actualizar'); };
    document.body.appendChild(b);
  }
  // Recién abierta la app (primeros 20 s, sin trabajo en pantalla) la versión nueva se aplica sola; después se avisa con un botón.
  function nueva(sw) { if (performance.now() < 20000) sw.postMessage('actualizar'); else avisar(sw); }
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
