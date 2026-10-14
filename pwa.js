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
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      if (reg.waiting && navigator.serviceWorker.controller) avisar(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var n = reg.installing; if (!n) return;
        n.addEventListener('statechange', function () { if (n.state === 'installed' && navigator.serviceWorker.controller) avisar(n); });
      });
      setInterval(function () { reg.update().catch(function () {}); }, 30 * 60000);   // revisa cada 30 min
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reg.update().catch(function () {}); });
    }).catch(function (e) { console.warn('Service worker:', e); });
  });
})();
