/*
 * Puente: la app usa google.script.run (como dentro de Apps Script). Aquí se traduce a una llamada
 * fetch al servidor (doPost), así el código de la app es el mismo en las dos versiones.
 */
(function () {
  var API = window.IV_API, ESPERA = 90000;
  function llamar(fn, args) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ESPERA) : null;
    return fetch(API, {
      method: 'POST', redirect: 'follow', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // petición "simple": sin preflight CORS
      body: JSON.stringify({ fn: fn, args: args }),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (t) clearTimeout(t);
      if (!r.ok) throw new Error('El servidor respondió ' + r.status);
      return r.text();
    }, function (e) { if (t) clearTimeout(t); throw e; });
  }
  function runner(ok, falla) {
    return new Proxy({}, {
      get: function (_, nombre) {
        if (nombre === 'withSuccessHandler') return function (h) { return runner(h, falla); };
        if (nombre === 'withFailureHandler') return function (h) { return runner(ok, h); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          llamar(nombre, args).then(function (txt) { if (ok) ok(txt); }, function (e) { if (falla) falla(e); });
        };
      }
    });
  }
  window.google = { script: { get run() { return runner(); } } };

  // Logotipo: el último que mandó el servidor (se cambia desde Configuración); mientras, el del paquete.
  var LS = 'iv_logo_pwa';
  try { window.LOGO = localStorage.getItem(LS) || 'logo.png'; } catch (e) { window.LOGO = 'logo.png'; }
  if (navigator.onLine !== false) llamar('logo', []).then(function (txt) {
    try { var r = JSON.parse(txt); if (r.ok && r.data && r.data !== window.LOGO) localStorage.setItem(LS, r.data); } catch (e) {}
  }, function () {});
})();
