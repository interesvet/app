/* =============================================================================
 *  INTERÉS VETERINARIO — Aplicación cliente (funciona en celular, iPad y Mac)
 *  - Guarda catálogos y existencias en el dispositivo para trabajar sin red.
 *  - Ventas, cobros, clientes y mermas capturados sin red quedan en cola y se
 *    envían solos al recuperar la conexión.
 * ========================================================================== */
const App = (() => {
  /* ---------------- almacenamiento local ---------------- */
  /* Copia durable (IndexedDB) de lo que se necesita para trabajar sin señal: catálogos/existencias ('datos')
   * y operaciones por enviar ('cola'). localStorage tiene ~5 MB; IndexedDB no se llena con los datos ni con fotos de comprobantes. */
  const KV = (() => {
    let p = null;
    const db = () => p || (p = new Promise((res, rej) => {
      try { const r = indexedDB.open('iv_local', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }
      catch (e) { rej(e); }
    }).catch(e => { p = null; throw e; }));
    const op = (modo, f) => db().then(d => new Promise((res, rej) => {
      const t = d.transaction('kv', modo), q = f(t.objectStore('kv')); let out;
      if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
    const pend = {};
    return {
      get: k => op('readonly', st => st.get(k)).catch(() => undefined),
      set: (k, v) => { clearTimeout(pend[k]); pend[k] = setTimeout(() => op('readwrite', st => st.put(v, k)).catch(() => {}), 400); },
      del: k => op('readwrite', st => st.delete(k)).catch(() => {})
    };
  })();
  const DURABLE = { datos: 1, cola: 1 };
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('iv_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) {
      if (k === 'datos' && v) v._t = Date.now();
      if (DURABLE[k] && typeof indexedDB !== 'undefined') KV.set(k, v);
      try { localStorage.setItem('iv_' + k, JSON.stringify(v)); } catch (e) { console.warn('Almacenamiento lleno (queda la copia en IndexedDB)', e); }
    },
    del(k) { try { localStorage.removeItem('iv_' + k); } catch (e) {} }
  };
  /** Al abrir: completa lo guardado con la copia de IndexedDB (la más reciente gana; en la cola no se pierde ninguna operación). */
  async function cargarLocal() {
    if (typeof indexedDB === 'undefined') return;
    try {
      const [d, c] = await Promise.race([Promise.all([KV.get('datos'), KV.get('cola')]), new Promise(r => setTimeout(() => r([null, null]), 2500))]);
      if (d && d.user && (!S.datos || (d._t || 0) > (S.datos._t || 0))) S.datos = d;
      if (Array.isArray(c) && c.length) { const ya = {}; S.cola.forEach(o => ya[o.opId] = 1); c.forEach(o => { if (o && !ya[o.opId]) S.cola.push(o); }); }
    } catch (e) {}
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }

  /* ---------------- calidad de la señal ---------------- */
  const RED = { lat: [], prueba: 0, fuerte: null };
  /** 'sin' | 'debil' | 'buena' | '?' (sin dato del sistema) */
  const debilSistema = () => { const c = navigator.connection; return !!(c && (/2g$/.test(c.effectiveType || '') || (c.downlink && c.downlink < 0.35) || (c.rtt && c.rtt > 1500))); };
  function senal() {
    if (navigator.onLine === false) return 'sin';
    const c = navigator.connection;
    if (debilSistema()) return 'debil';
    const l = RED.lat.slice(-3);
    if (l.length >= 2 && l.reduce((a, b) => a + b, 0) / l.length > 9000) return 'debil';
    return c && c.effectiveType ? 'buena' : '?';
  }
  /** ¿Hay señal suficiente para sincronizar? Prueba real con el servidor (respuesta en menos de 6 s), máx. una vez por minuto. */
  async function senalFuerte(forzar) {
    // lo que diga el sistema (sin red / 2G) descarta; si no, manda la prueba real (las respuestas lentas de antes no cuentan)
    if (navigator.onLine === false || debilSistema()) return (RED.fuerte = false);
    if (!forzar && RED.fuerte !== null && Date.now() - RED.prueba < 60000) return RED.fuerte;
    const t0 = Date.now(); let ok = false;
    try { await Promise.race([call('ping', {}), new Promise((_, r) => setTimeout(() => r(new Error('lento')), 8000))]); ok = Date.now() - t0 < 6000; } catch (e) { ok = false; }
    RED.prueba = Date.now(); RED.fuerte = ok;
    return ok;
  }

  const S = {
    token: LS.get('token', null), datos: LS.get('datos', null), cola: LS.get('cola', []),
    online: navigator.onLine, vista: LS.get('vista', 'inicio'), suc: LS.get('suc', null),
    venta: LS.get('borrador_venta', null), oc: null, tr: null, aj: null, charts: [], sincronizando: false
  };

  /* ---------------- utilidades ---------------- */
  const $ = s => document.querySelector(s);
  const esc = v => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMoneda = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const $$ = n => fmtMoneda.format(Number(n) || 0);
  const nf = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-MX');
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const hoyISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const isoDe = dmy => { const m = String(dmy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : ''; };
  const fechaDe = dmy => { const i = isoDe(dmy); return i ? new Date(i + 'T00:00:00') : null; };
  const diasA = dmy => { const f = fechaDe(dmy); return f ? Math.floor((f - new Date(hoyISO() + 'T00:00:00')) / 86400000) : null; };
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(4))).map(b => ('0' + b.toString(16)).slice(-2)).join('');
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const coincide = (texto, q) => { const t = norm(texto); return norm(q).split(/\s+/).filter(Boolean).every(p => t.indexOf(p) >= 0); };
  const D = () => S.datos || {};
  /** Filtros de fecha guardados: si "Hasta" era el día de hoy cuando se usó, al cambiar de día se recorre a la nueva fecha
   *  (la app puede quedar abierta de un día para otro). */
  const alDia = f => { if (!f) return f; const h = hoyISO(); if (f.hasta && f.hastaHoy === f.hasta && f.hasta < h) { f.hasta = h; f.hastaHoy = h; } return f; };
  const marcarHoy = f => { if (f) f.hastaHoy = f.hasta === hoyISO() ? f.hasta : ''; return f; };
  const U = () => (S.datos && S.datos.user) || {};
  const puede = p => { const per = U().permisos || {}; return Array.isArray(p) ? p.some(x => per[x]) : !p || !!per[p]; };
  const prod = id => (D().productos || []).find(p => p.id === id);
  const cliente = id => (D().clientes || []).find(c => c.id === id);
  const sucNom = id => { const s = (D().sucursales || []).find(x => x.id === id); return s ? s.nombre : id || ''; };
  const sucsPermitidas = () => (D().sucursales || []).filter(s => (D().permitidas || []).indexOf(s.id) >= 0);
  /** Filtro de sucursal por omisión en reportes y consultas: el dueño ve TODAS; los demás, su sucursal de trabajo. */
  const sucFiltro = () => puede('dueno') ? '' : sucTrabajo();
  const sucTrabajo = () => (S.suc && (D().permitidas || []).indexOf(S.suc) >= 0) ? S.suc : U().sucursal;
  const opts = (lista, sel, vacio) => (vacio !== undefined ? `<option value="">${esc(vacio)}</option>` : '') +
    lista.map(o => { const obj = o && typeof o === 'object', v = Array.isArray(o) ? o[0] : obj ? o.id : o, t = Array.isArray(o) ? o[1] : obj ? (o.nombre || o.id) : o; return `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(t)}</option>`; }).join('');
  const optsSuc = (sel, todas, vacio) => opts((todas ? (D().sucursales || []) : sucsPermitidas()), sel, vacio);

  function lotes(idProd, suc) {
    return (D().stock || []).filter(s => s.p === idProd && s.s === suc && s.q > 0)
      .sort((a, b) => ((fechaDe(a.c) || new Date(9e15)) - (fechaDe(b.c) || new Date(9e15))));
  }
  /** "Otras sucursales: Champotón 4 · Escárcega 2" (solo las que tienen existencia). */
  const existOtras = (idProd, suc) => { const m = {}; (D().stock || []).forEach(s => { if (s.p === idProd && s.s !== suc && s.q > 0) m[s.s] = (m[s.s] || 0) + s.q; });
    const l = Object.keys(m).map(k => sucNom(k) + ' ' + nf(m[k])); return l.length ? 'Otras sucursales: ' + l.join(' · ') : ''; };
  /** Piezas en órdenes de compra todavía no recibidas (solo si hay alguna): ' · 🚚 Por llegar 24'. */
  const porLlegarHtml = (idProd, suc) => { let q = 0; const oc = [];
    (D().porLlegar || []).forEach(x => { if (x.p === idProd && (!suc || x.s === suc)) { q += x.q; (x.oc || []).forEach(f => { if (oc.indexOf(f) < 0) oc.push(f); }); } });
    return q > 0 ? ` · <span class="por-llegar" title="En orden de compra sin recibir: ${esc(oc.join(', '))}">🚚 Por llegar <b>${nf(r2(q))}</b></span>` : ''; };
  const existencia = (idProd, suc) => r2((D().stock || []).filter(s => s.p === idProd && (!suc || s.s === suc)).reduce((t, s) => t + s.q, 0));
  /** Existencia de todos los productos de una vez (suc vacío = todas). */
  const mapaExist = suc => { const m = {}; (D().stock || []).forEach(s => { if (!suc || s.s === suc) m[s.p] = (m[s.p] || 0) + s.q; }); return m; };
  /** Orden de productos: primero con existencia (mayor a menor), luego sin existencia por orden alfabético. */
  const porExistencia = (m, idDe, nomDe) => (a, b) => {
    const qa = m[idDe(a)] > 0.0001 ? m[idDe(a)] : 0, qb = m[idDe(b)] > 0.0001 ? m[idDe(b)] : 0;
    if (qa > 0 && qb > 0) return qb - qa || String(nomDe(a)).localeCompare(String(nomDe(b)));
    if (qa > 0 || qb > 0) return qa > 0 ? -1 : 1;
    return String(nomDe(a)).localeCompare(String(nomDe(b)));
  };

  /* ---------------- interfaz común ---------------- */
  /** Foto de la sucursal que emite el documento (se llena sola; sin foto no ocupa espacio). */
  const fotoSucDoc = id => { const x = (D().sucursales || []).find(o => o.id === id); if (!x || !x.foto || esMatriz(id)) return ''; setTimeout(llenarFotosSuc, 0); return `<img class="doc-suc" data-sucdoc="${esc(id)}" alt="">`; };
  async function llenarFotosSuc() {
    const ims = Array.from(document.querySelectorAll('img[data-sucdoc]:not([src])')); if (!ims.length) return;
    S.minis = S.minis || {}; const m = S.minis.sucFoto = Object.assign(LS.get('minisSuc', {}), S.minis.sucFoto || {});
    Object.keys(m).forEach(k => { if (!m[k]) delete m[k]; });
    if (Object.keys(m).some(k => /^data:image\/jpeg/.test(m[k]))) { await transparentarMinis(m); guardarMinisSuc(m); }
    const faltan = Array.from(new Set(ims.map(i => i.dataset.sucdoc).filter(id => !m[id])));
    if (faltan.length && navigator.onLine !== false) {
      try { const r = await transparentarMinis(await pedir('minisArchivo', { tipo: 'sucFoto', ids: faltan }, true)); Object.keys(r).forEach(k => { if (r[k]) m[k] = r[k]; }); guardarMinisSuc(m); } catch (e) {}
    }
    document.querySelectorAll('img[data-sucdoc]:not([src])').forEach(im => { if (m[im.dataset.sucdoc]) im.src = m[im.dataset.sucdoc]; });
  }
  const guardarMinisSuc = m => { const o = {}; Object.keys(m || {}).forEach(k => { if (m[k]) o[k] = m[k]; }); LS.set('minisSuc', o); };
  /** Achica una imagen (dataURI) a "max" px del lado mayor, en JPEG. */
  const achicarUri = (uri, max) => new Promise((res, rej) => { const im = new Image(); im.onerror = rej; im.onload = () => {
    const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', .8)); }; im.src = uri; });
  /** Logotipo sin fondo: lo transparente se respeta y el fondo liso (blanco) que toca los bordes se vuelve transparente;
   *  se recorta al contenido y se entrega en PNG de "max" px. Si no se distingue un fondo liso, se deja igual (PNG). */
  const logoTransparente = (uri, max) => new Promise(res => { const im = new Image(); im.onerror = () => res(uri); im.onload = () => {
    try {
      const k = Math.min(1, max / Math.max(im.width, im.height)), w = Math.max(1, Math.round(im.width * k)), h = Math.max(1, Math.round(im.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h), px = d.data, N = w * h, fuera = new Uint8Array(N), pila = [];
      const claro = q => { const a = q * 4; return px[a + 3] < 30 || (px[a] > 232 && px[a + 1] > 232 && px[a + 2] > 232); };
      const borde = []; for (let i = 0; i < w; i++) borde.push(i, (h - 1) * w + i); for (let j = 0; j < h; j++) borde.push(j * w, j * w + w - 1);
      if (borde.filter(claro).length / borde.length >= 0.5) {
        borde.forEach(q => { if (!fuera[q] && claro(q)) { fuera[q] = 1; pila.push(q); } });
        while (pila.length) { const q = pila.pop(), qx = q % w;
          for (const n of [qx > 0 ? q - 1 : -1, qx < w - 1 ? q + 1 : -1, q - w, q + w]) if (n >= 0 && n < N && !fuera[n] && claro(n)) { fuera[n] = 1; pila.push(n); } }
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let q = 0; q < N; q++) { const a = q * 4;
          if (fuera[q]) { px[a + 3] = 0; continue; }
          const qx = q % w, qy = (q / w) | 0; if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
          // orilla suave: los pixeles claros pegados al fondo se vuelven semitransparentes
          let f = 0; if (qx > 0 && fuera[q - 1]) f++; if (qx < w - 1 && fuera[q + 1]) f++; if (q >= w && fuera[q - w]) f++; if (q + w < N && fuera[q + w]) f++;
          if (f) { const luz = Math.min(px[a], px[a + 1], px[a + 2]) / 255; px[a + 3] = Math.round(px[a + 3] * Math.max(0.15, 1 - luz * 0.85)); } }
        x.putImageData(d, 0, 0);
        if (x1 >= x0 && (x1 - x0) * (y1 - y0) > N * 0.02) { const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1; o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height); return res(o.toDataURL('image/png')); }
      }
      res(c.toDataURL('image/png'));
    } catch (e) { res(uri); } }; im.src = uri; });
  /** Las miniaturas de sucursal que llegan en JPEG (con fondo blanco) se dejan sin fondo antes de mostrarse. */
  async function transparentarMinis(m) {
    for (const k of Object.keys(m || {})) if (/^data:image\/jpeg/.test(m[k] || '')) { try { m[k] = await logoTransparente(m[k], 360); } catch (e) {} }
    return m;
  }
  /** C.P., Régimen fiscal y Uso de CFDI del cliente (encabezado de notas, cotizaciones, comprobantes y estados de cuenta). */
  const fiscalHtml = (f, sinCp) => { if (!f) return ''; const l = [];
    if (f.cp && !sinCp) l.push('C.P. ' + esc(f.cp));
    const et = (c, t) => !t ? c : String(t).indexOf(c) === 0 ? t : c + ' – ' + t;
    if (f.regimen) l.push('Régimen fiscal: ' + esc(et(f.regimen, f.regimenTxt)));
    if (f.uso) l.push('Uso de CFDI: ' + esc(et(f.uso, f.usoTxt)));
    return l.length ? '<br><small>' + l.join('<br>') + '</small>' : ''; };
  const logoHtml = () => window.LOGO ? `<img src="${window.LOGO}" alt="Interés Veterinario" style="height:64px">` : '<h3 style="color:#1f6f4a">🐾 Interés Veterinario</h3>';
  let toastT;
  function toast(msg, mal) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast ver' + (mal ? ' mal' : '');
    clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast', mal ? 5000 : 2800);
  }
  const cargando = v => $('#cargando').classList.toggle('oculto', !v);
  function modal(titulo, html) { $('#modalTit').textContent = titulo; $('#modalCuerpo').innerHTML = html; $('#modal').classList.remove('oculto'); if (html.indexOf('data-arch=') >= 0) setTimeout(() => cargarArchs($('#modalCuerpo')), 0); }
  function cerrarModal() { $('#modal').classList.add('oculto'); $('#modalCuerpo').innerHTML = ''; }
  function tabla(cols, filas, opc) {
    opc = opc || {};
    if (!filas.length) return `<div class="vacio">${esc(opc.vacio || 'Sin registros')}</div>`;
    return `<div class="tabla-cont"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''} ${c.cls || ''}">${esc(c.t)}</th>`).join('')}</tr></thead><tbody>` +
      filas.map((f, i) => `<tr class="${opc.clic ? 'clic' : ''}" ${opc.clic ? `onclick="${opc.clic}(${i})"` : ''}>` +
        cols.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.h ? c.h(f) : esc(f[c.k])}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  /* ---------------- copia local de consultas (para consultar sin conexión) ----------------
   *  Cada consulta que se hace con internet se guarda en el dispositivo (IndexedDB). Sin señal, la app muestra
   *  la última copia de esa misma consulta; si no existe con esos filtros exactos, la más reciente del mismo
   *  tipo (y del mismo cliente / nota / producto). Además, cada 3 h se precargan las consultas principales.
   *  Se borra al cerrar sesión. Nunca se guardan PDFs, fotos ni archivos.
   */
  const CQ = (() => {
    const LECT = ('kardex listarVentas aniosRegistros pedidoSugerido seguimiento listarVisitas detalleVisita configReceta listarRecetas detalleReceta ' +
      'detalleVenta listarCobros cuentasPorCobrar adjuntosCobro estadosCuenta estadoCuentaCliente listarPagosProv detallePagoProv listarCompras ' +
      'detalleCompra listarTraspasos detalleTraspaso reporteTraspasos listarConteos detalleConteo historialAjustes selListaPrecios historialPrecios ' +
      'listarMovimientos listarProveedores detalleCobro dashboard costosReales listarCotizaciones detalleCotizacion facturas detalleFactura facturasNota ' +
      'listarRequisiciones detalleRequisicion detalleDevolucion porFacturar listarVendedores utilidadVentas utilidadNota gastosDetalle gastos sucursalesResumen gruposGasto ' +
      'radar metas historialCliente registro comparativo analisis').split(' ');
    const MAX = 4000, MAX_TXT = 4e6;   // "Actualizar para ruta" guarda miles de consultas (IndexedDB aguanta cientos de MB)
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('iv_consultas', 1);
        r.onupgradeneeded = () => { const st = r.result.createObjectStore('c', { keyPath: 'k' }); st.createIndex('a', 'a'); st.createIndex('t', 't'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    }).catch(e => { dbp = null; throw e; }));
    const tx = (modo, fn) => db().then(d => new Promise((res, rej) => {
      const t = d.transaction('c', modo), st = t.objectStore('c'); let out;
      fn(st, v => { out = v; }); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
    const ordenado = o => o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort().reduce((m, k) => (m[k] = ordenado(o[k]), m), {}) : o;
    const usuario = () => String(U().id || '');
    // Lo que identifica "de quién / de qué" es la consulta (cliente, nota, producto…): nunca se muestra la de otro.
    const ident = p => JSON.stringify(Object.keys(p).filter(k => /^id/i.test(k) || ['folio', 'producto', 'tabla'].indexOf(k) >= 0).sort()
      .filter(k => p[k] !== '' && p[k] !== null && p[k] !== undefined).map(k => [k, p[k]]));
    const clave = (a, p) => usuario() + '|' + a + '|' + JSON.stringify(ordenado(p));
    return {
      guardable: a => typeof indexedDB !== 'undefined' && LECT.indexOf(a) >= 0,
      guardar(a, p, d, largo) {
        if (!usuario() || largo > MAX_TXT) return;
        tx('readwrite', st => st.put({ k: clave(a, p), a: a, u: usuario(), i: ident(p), t: Date.now(), d: d }))
          .then(() => tx('readwrite', st => {
            const cnt = st.count(); cnt.onsuccess = () => { let sobran = cnt.result - MAX; if (sobran <= 0) return;
              st.index('t').openCursor().onsuccess = ev => { const c = ev.target.result; if (c && sobran-- > 0) { c.delete(); c.continue(); } }; };
          })).catch(() => {});
      },
      buscar(a, p) {
        if (!usuario()) return Promise.resolve(null);
        const k = clave(a, p), id = ident(p), u = usuario();
        return tx('readonly', (st, fin) => {
          const g = st.get(k);
          g.onsuccess = () => {
            if (g.result) return fin(Object.assign({ exacto: true }, g.result));
            const q = st.index('a').getAll(a);
            // sin la consulta exacta: la más reciente del mismo cliente / nota / producto; si hay una con fechas que cubren las pedidas, esa primero
            const rango = x => { try { const o = JSON.parse(x.k.split('|').slice(2).join('|')); return [o.desde || '', o.hasta || '']; } catch (e) { return ['', '']; } };
            const cubre = x => { if (!p.desde && !p.hasta) return true; const [d, h] = rango(x); return (!d || (p.desde && d <= p.desde)) && (!h || (p.hasta && h >= p.hasta)); };
            q.onsuccess = () => { const l = (q.result || []).filter(x => x.u === u && x.i === id).sort((x, y) => (cubre(y) - cubre(x)) || (y.t - x.t)); fin(l[0] ? Object.assign({ exacto: false }, l[0]) : null); };
          };
        });
      },
      contar: () => tx('readonly', (st, fin) => { const c = st.count(); c.onsuccess = () => fin(c.result); }).catch(() => 0),
      borrar: () => tx('readwrite', st => st.clear()).catch(() => {})
    };
  })();
  /** Aviso arriba de la vista cuando lo que se ve es una copia guardada. */
  function avisoCache(c) {
    let el = $('#avisoCache');
    if (!el) { el = document.createElement('div'); el.id = 'avisoCache'; el.className = 'aviso-cache oculto'; const v = $('#vista'); if (!v) return; v.parentNode.insertBefore(el, v); }
    const prev = Number(el.dataset.t || 0), t = prev ? Math.min(prev, c.t) : c.t, exacto = el.dataset.t ? el.dataset.exacto === '1' && c.exacto : c.exacto;
    el.dataset.t = t; el.dataset.exacto = exacto ? '1' : '0';
    const f = new Date(t), hoy = new Date().toDateString() === f.toDateString();
    const cuando = (hoy ? 'hoy' : f.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })) + ' a las ' + f.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
    el.innerHTML = `<span>📦 <b>Sin conexión.</b> Estás viendo información guardada ${esc(cuando)}${exacto ? '' : ' (última consulta guardada; los filtros pueden ser distintos)'}${/\.$/.test(cuando) && exacto ? '' : '.'}</span>` +
      `<button class="btn chico" onclick="App.ir(App.vistaActual(), true)">↻ Actualizar</button>`;
    el.classList.remove('oculto');
  }
  function quitarAvisoCache() { const el = $('#avisoCache'); if (el) { el.classList.add('oculto'); el.dataset.t = ''; el.dataset.exacto = ''; } }
  /** Precarga silenciosa de las consultas principales (cada 3 h, solo con internet) para tenerlas a la mano sin señal. */
  /**
   * completo = "Actualizar para ruta": rangos amplios y el detalle de muchas más notas, cotizaciones, requisiciones,
   * compras y clientes, pedidos en lotes (una llamada trae hasta 40 detalles) para que tarde poco.
   */
  async function precargar(forzar, avance, completo) {
    if (!S.token || !navigator.onLine || S.precargando) return;
    const ult = LS.get('precarga_' + (U().id || ''), 0);
    if (!forzar && Date.now() - ult < 3 * 3600e3) return;
    S.precargando = true;
    const h = hoyISO(), dia = n => { const d = new Date(h + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    if (completo) { try { return await precargaRuta(h, dia, avance); } finally { S.precargando = false; } }
    const lista = [
      ['seguimiento', 'seguimiento', { suc: '', vendedor: '' }],
      ['seguimiento', 'listarVisitas', { desde: dia(-30), hasta: dia(60), vendedor: '', estado: '' }],
      ['ventas', 'listarVentas', { desde: dia(-30), hasta: h, sucursal: '', texto: '', conSaldo: false, idCliente: '' }],
      ['cobranza', 'cuentasPorCobrar', { sucursal: '' }],
      ['cobranza', 'estadosCuenta', { texto: '', tramo: '' }],
      ['cobranza', 'listarCobros', { desde: dia(-30), hasta: h, sucursal: '', forma: '', texto: '' }],
      ['cotizaciones', 'listarCotizaciones', { sucursal: '', desde: dia(-60), hasta: h, estado: '', texto: '' }],
      ['recetas', 'listarRecetas', { desde: dia(-90), hasta: h }],
      ['requisiciones', 'listarRequisiciones', { desde: dia(-60), hasta: h, estado: '', texto: '', sucursal: '' }]
    ];
    // detalle de las más recientes (para abrirlas, ver su PDF y compartirlas sin señal)
    const DETALLES = { listarCotizaciones: ['cotizaciones', 'detalleCotizacion', 60, 'id'], listarRequisiciones: ['requisiciones', 'detalleRequisicion', 40, 'id'], listarVentas: [null, 'detalleVenta', 40, 'ID_Venta'] };
    let ok = 0;
    try {
      for (const [perm, a, p] of lista) {
        if (!puede(perm) || !navigator.onLine || !S.token) continue;
        let r;
        try { r = await call(a, p); ok++; } catch (e) { if (e.red) break; continue; }
        const det = DETALLES[a];
        if (det && r) {
          const ids = ((det[0] ? r[det[0]] : r) || []).filter(x => !/cancel/i.test(x.estado || '')).slice(0, det[2]).map(x => x.id).filter(Boolean);
          for (let i = 0; i < ids.length; i++) {
            if (!navigator.onLine || !S.token) break;
            if (avance) avance(det[0] || 'notas de venta', i, ids.length);
            const prm = { [det[3]]: ids[i] };
            try { const c = await CQ.buscar(det[1], prm); if (c && c.exacto && Date.now() - c.t < 3 * 3600e3 && !forzar) continue; } catch (e) {}
            try { await call(det[1], prm); } catch (e) { if (e.red) break; }
          }
        }
      }
      if (ok) { LS.set('precarga_' + (U().id || ''), Date.now()); guardarLibs(); }
    } finally { S.precargando = false; }
    return ok;
  }
  /** Lotes de detalle: guarda cada respuesta en el equipo como si se hubiera consultado una por una. */
  async function loteDetalles(accion, params, avance, etiqueta) {
    let hechos = 0;
    for (let i = 0; i < params.length; i += 40) {
      if (!navigator.onLine || !S.token) break;
      const parte = params.slice(i, i + 40);
      if (avance) avance(etiqueta, Math.min(i + 40, params.length) - 1, params.length);
      let r; try { r = await call('lote', { accion: accion, lista: parte }); } catch (e) { if (e.red) break; continue; }
      (r.res || []).forEach((x, j) => { if (x && x.ok) { const txt = JSON.stringify(x.data); CQ.guardar(accion, parte[j], x.data, txt.length); hechos++; } });
      const faltan = (r.res || []).map((x, j) => x ? null : parte[j]).filter(Boolean);   // el servidor se detuvo por tiempo: se reintentan
      if (faltan.length) { params = params.concat(faltan); }
    }
    return hechos;
  }
  async function precargaRuta(h, dia, avance) {
    const res = { listas: 0, detalles: 0 }, guardar = async (a, p, perm) => { if (perm && !puede(perm)) return null; try { const r = await call(a, p); res.listas++; return r; } catch (e) { if (e.red) throw e; return null; } };
    const paso = (t) => avance && avance(t, 0, 1);
    paso('listas');
    const ventas = await guardar('listarVentas', { desde: dia(-365), hasta: h, sucursal: '', texto: '', conSaldo: false, idCliente: '' });
    await guardar('listarVentas', { desde: dia(-30), hasta: h, sucursal: '', texto: '', conSaldo: false, idCliente: '' });
    await guardar('listarVentas', { desde: '', hasta: '', sucursal: '', texto: '', conSaldo: true, idCliente: '' });
    const cxc = await guardar('cuentasPorCobrar', { sucursal: '' }, 'cobranza');
    await guardar('estadosCuenta', { texto: '', tramo: '' }, 'cobranza');
    await guardar('listarCobros', { desde: dia(-180), hasta: h, sucursal: '', forma: '', texto: '' }, 'cobranza');
    const cots = await guardar('listarCotizaciones', { sucursal: '', desde: dia(-180), hasta: h, estado: '', texto: '' }, 'cotizaciones');
    await guardar('listarCotizaciones', { sucursal: '', desde: dia(-60), hasta: h, estado: '', texto: '' }, 'cotizaciones');
    const reqs = await guardar('listarRequisiciones', { desde: dia(-180), hasta: h, estado: '', texto: '', sucursal: '' }, 'requisiciones');
    const comp = await guardar('listarCompras', { desde: dia(-180), hasta: h, texto: '', pendientes: false, idProveedor: '' }, 'compras');
    await guardar('listarCompras', { pendientes: true }, 'compras');
    const seg = await guardar('seguimiento', { suc: '', vendedor: '' }, 'seguimiento');
    await guardar('radar', { suc: '', vendedor: '' }, 'seguimiento');
    await guardar('metas', { mes: '', suc: '' }, 'seguimiento');
    await guardar('listarVisitas', { desde: dia(-90), hasta: dia(90), vendedor: '', estado: '' }, 'seguimiento');
    await guardar('listarVisitas', { desde: dia(-30), hasta: dia(60), vendedor: '', estado: '' }, 'seguimiento');
    await guardar('listarRecetas', { desde: dia(-365), hasta: h }, 'recetas');
    await guardar('configReceta', {}, 'recetas');
    // detalles en lotes
    const vivos = l => (l || []).filter(x => !/cancel/i.test(x.estado || x.estatus || ''));
    const idsV = vivos(Array.isArray(ventas) ? ventas : (ventas || {}).notas).slice(0, 600).map(x => ({ ID_Venta: x.id || x.ID_Venta })).filter(x => x.ID_Venta);
    res.detalles += await loteDetalles('detalleVenta', idsV, avance, 'notas de venta');
    const lc = cots ? (cots.cotizaciones || cots) : [];
    if (puede('cotizaciones')) res.detalles += await loteDetalles('detalleCotizacion', vivos(Array.isArray(lc) ? lc : []).slice(0, 300).map(x => ({ id: x.id })).filter(x => x.id), avance, 'cotizaciones');
    const lr = reqs ? (reqs.requisiciones || reqs) : [];
    if (puede('requisiciones')) res.detalles += await loteDetalles('detalleRequisicion', (Array.isArray(lr) ? lr : []).slice(0, 150).map(x => ({ id: x.id })).filter(x => x.id), avance, 'requisiciones');
    if (puede('compras') && Array.isArray(comp)) res.detalles += await loteDetalles('detalleCompra', comp.slice(0, 200).map(x => ({ ID_O_Compra: x.id })).filter(x => x.ID_O_Compra), avance, 'órdenes de compra');
    // clientes: ficha completa, estado de cuenta e historia de los que se atienden en ruta (por atender, con saldo y los del radar)
    const idsC = [];
    ((seg || {}).clientes || []).filter(c => c.estado !== 'Perdido').forEach(c => idsC.push(c.id));
    (Array.isArray(cxc) ? cxc : ((cxc || {}).clientes || [])).forEach(c => idsC.push(c.idCliente || c.id));
    const unicos = idsC.filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 400);
    if (puede('clientes')) res.detalles += await loteDetalles('registro', unicos.map(id => ({ tabla: 'cliente', id: id })), avance, 'fichas de clientes');
    if (puede('cobranza')) res.detalles += await loteDetalles('estadoCuentaCliente', unicos.map(id => ({ idCliente: id })), avance, 'estados de cuenta');
    if (puede('recetas')) res.detalles += await loteDetalles('historialCliente', unicos.slice(0, 250).map(id => ({ id: id })), avance, 'historias clínicas');
    LS.set('precarga_' + (U().id || ''), Date.now()); LS.set('ruta_' + (U().id || ''), { t: Date.now(), listas: res.listas, detalles: res.detalles });
    return res.listas + res.detalles;
  }
  async function precargarAhora() {
    if (!navigator.onLine) return toast('Necesitas conexión para actualizar la información guardada', true);
    cargando(true);
    try { const n = await precargar(true); toast(n ? '✔ Información guardada en este dispositivo' : 'No se pudo actualizar', !n); }
    finally { cargando(false); if (S.vista === 'config') V.config(); }
  }

  /* ---------------- comunicación con el servidor ---------------- */
  function marcarRed(ok) {
    S.online = ok;
    const e = $('#estadoRed');
    if (e) { e.className = 'pastilla ' + (ok ? 'ok' : 'off'); e.textContent = ok ? 'En línea' : 'Sin conexión'; }
  }
  // Ventas y cobros (con ID propio, el servidor no los duplica): con señal débil no se espera de más; se guardan en la cola.
  const ENCOLA_RAPIDO = { guardarVenta: 1, guardarCobro: 1, guardarCotizacion: 1 };
  function call(accion, params) {
    return new Promise((res0, rej0) => {
      const t0 = Date.now(); let listo = false;
      const res = v => { if (listo) return; listo = true; RED.lat.push(Date.now() - t0); if (RED.lat.length > 10) RED.lat.shift(); res0(v); };
      const rej = e => { if (listo) return; listo = true; rej0(e); };
      if (ENCOLA_RAPIDO[accion]) {
        const s = senal();
        if (s === 'sin') { const e = new Error('Sin conexión'); e.red = true; return rej(e); }
        setTimeout(() => { const e = new Error('Señal débil'); e.red = true; e.lento = true; RED.fuerte = false; rej(e); }, s === 'debil' ? 15000 : 35000);
      }
      if (typeof google === 'undefined' || !google.script) {
        const e = new Error('Sin conexión'); e.red = true;
        if (!CQ.guardable(accion)) return rej(e);
        return CQ.buscar(accion, params || {}).then(c => { if (!c) return rej(e); avisoCache(c); res(c.d); }).catch(() => rej(e));
      }
      // un corte momentáneo (celular que cambia de red, app en segundo plano, servidor ocupado) no debe marcar "Sin conexión":
      // se reintenta una vez antes de darlo por perdido
      const intento = n => google.script.run
        .withSuccessHandler(txt => {
          marcarRed(true);
          const r = JSON.parse(txt);
          if (r.ok) { if (CQ.guardable(accion)) CQ.guardar(accion, params || {}, r.data, txt.length); return res(r.data); }
          if (String(r.error).indexOf('SESION') === 0) { salir(r.error.replace('SESION: ', '')); }
          rej(new Error(r.error));
        })
        .withFailureHandler(err => {
          if (n < 1 && navigator.onLine !== false && (CQ.guardable(accion) || /^(listar|detalle|ver|minis|reporte|historial|folio|version|bajar|portafolio|pdf|dashboard|datos|bootstrap|archivos|existencias|kardex|pedido)/i.test(accion))) return setTimeout(() => intento(n + 1), 1500 + Math.random() * 1000);
          const e = new Error('Sin conexión con el servidor'); e.red = true; e.original = err;
          marcarRed(false);
          if (!CQ.guardable(accion)) return rej(e);
          CQ.buscar(accion, params || {}).then(c => { if (!c) return rej(e); avisoCache(c); res(c.d); }).catch(() => rej(e));
        })
        .api(S.token, accion, params || {});
      intento(0);
    });
  }
  async function pedir(accion, params, silencioso) {
    if (!silencioso) cargando(true);
    try { return await call(accion, params); }
    catch (e) { if (!silencioso) toast(e.message, true); throw e; }
    finally { if (!silencioso) cargando(false); }
  }

  /* ---------------- sesión ---------------- */
  function entrar(ev) {
    ev.preventDefault();
    const btn = $('#lgBtn'); btn.disabled = true; $('#lgErr').textContent = '';
    google.script.run.withSuccessHandler(async txt => {
      btn.disabled = false;
      const r = JSON.parse(txt);
      if (!r.ok) { $('#lgErr').textContent = r.error; return; }
      S.token = r.token; LS.set('token', r.token);
      try { await refrescarDatos(); mostrarApp(); setTimeout(precargar, 20000); setTimeout(revisarMinisSuc, 8000); setTimeout(fotosAlEntrar, 4000); }
      catch (e) { $('#lgErr').textContent = e.message; }
    }).withFailureHandler(e => { btn.disabled = false; $('#lgErr').textContent = 'Sin conexión: ' + e.message; })
      .login($('#lgUser').value, $('#lgPass').value);
  }
  function salir(msg) {
    if (S.cola.length && !confirm('Tienes ' + S.cola.length + ' operaciones sin sincronizar. Se conservarán en este dispositivo. ¿Salir?')) return;
    S.token = null; LS.del('token'); CQ.borrar(); quitarAvisoCache(); { const bv = $('#bienvenida'); if (bv) bv.classList.add('oculto'); document.body.classList.remove('con-bienv'); }
    $('#app').classList.add('oculto'); $('#login').classList.remove('oculto'); avisarNativoLogin(); revisarVersionApp();
    if (msg) $('#lgErr').textContent = msg;
  }
  async function refrescarDatos(silencioso) {
    const d = await pedir('bootstrap', {}, silencioso);
    S.datos = d; LS.set('datos', d);
    if (!S.suc || d.permitidas.indexOf(S.suc) < 0) { S.suc = d.user.sucursal; LS.set('suc', S.suc); }
    return d;
  }
  async function refrescarStock() {
    try { const st = await call('stock', {}); S.datos.stock = st; LS.set('datos', S.datos); } catch (e) {}
  }

  /* ---------------- cola offline ---------------- */
  function encolar(tipo, params, desc) {
    S.cola.push({ opId: uid() + uid(), tipo: tipo, params: params, desc: desc, creado: new Date().toLocaleString('es-MX'), error: '' });
    LS.set('cola', S.cola); pintarCola(); pintarBienvEstado();
  }
  function pintarCola() {
    const b = $('#btnSync'); if (!b) return;
    b.classList.toggle('oculto', !S.cola.length);
    b.textContent = '⟳ ' + S.cola.length + ' por sincronizar';
  }
  /**
   * Envía la cola al servidor solo con señal fuerte (prueba real), en lotes pequeños y en orden
   * (una venta va antes que su cobro). Cada operación lleva su opId: si una llega dos veces, el servidor no la duplica.
   */
  async function sincronizar(manual) {
    if (S.sincronizando || !S.cola.length || !S.token) { if (manual && !S.cola.length) toast('Todo está sincronizado'); return; }
    if (!manual && !(await senalFuerte())) return;
    S.sincronizando = true; pintarCola();
    let hechos = 0, stock = null;
    try {
      const ops = S.cola.slice(); let i = 0;
      while (i < ops.length) {
        const lote = []; let peso = 0;
        while (i < ops.length && lote.length < 8) { const w = JSON.stringify(ops[i].params || {}).length; if (lote.length && peso + w > 1500000) break; lote.push(ops[i]); peso += w; i++; }
        const r = await call('sync', { ops: lote.map(o => ({ opId: o.opId, tipo: o.tipo, params: o.params })) });
        const res = {}; r.resultados.forEach(x => res[x.opId] = x);
        S.cola = S.cola.filter(o => { const x = res[o.opId]; if (!x) return true; if (!x.ok) { o.error = x.error; return true; } hechos++; return false; });
        LS.set('cola', S.cola); pintarCola();
        if (r.stock) stock = r.stock;
      }
    } catch (e) { if (manual) toast(e.message, true); }
    finally {
      S.sincronizando = false; pintarCola();
      if (stock && S.datos) { S.datos.stock = stock; LS.set('datos', S.datos); }
      if (hechos) { toast('✔ ' + hechos + ' operaciones sincronizadas'); refrescarDatos(true).catch(() => {}); }
      const mal = S.cola.filter(o => o.error).length;
      if (hechos && mal) toast(mal + ' operaciones con error. Revísalas en Configuración.', true);
      pintarBienvEstado();
    }
  }
  /** Renueva la sesión al abrir con señal, para que no caduque a media ruta. */
  async function renovarSesion() {
    try {
      const exp = Number((atob(String(S.token || '').split('.')[0].replace(/-/g, '+').replace(/_/g, '/')).split('|')[1]) || 0);
      if (exp && exp - Date.now() > 6.5 * 86400000) return;
      const r = await call('renovarSesion', {}); if (r && r.token) { S.token = r.token; LS.set('token', r.token); }
    } catch (e) {}
  }
  /** Antes de salir a ruta: catálogos, clientes, existencias y consultas principales al día en el equipo. */
  async function prepararRuta() {
    if (navigator.onLine === false) return toast('Necesitas señal para actualizar la información', true);
    cargando(true);
    try {
      if (S.cola.length) await sincronizar(true);
      for (let i = 0; S.precargando && i < 240; i++) await new Promise(r => setTimeout(r, 500));   // si ya corría la precarga automática, se espera y se hace completa
      // que el navegador no borre lo guardado cuando le falte espacio (Safari/iPad lo respeta si la app está instalada)
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
      await refrescarDatos(true);
      await precargar(true, (que, i, t) => toast(t > 1 ? '📥 Guardando ' + que + '… ' + (i + 1) + ' de ' + t : '📥 Guardando ' + que + '…'), true);
      await renovarSesion(); await guardarLibs();
      await descargarFotos(!S.fotosT || Date.now() - S.fotosT > FOTOS_DIAS * 86400e3, (i, t) => toast('📷 Descargando fotos de productos… ' + Math.round(i / t * 100) + '%'));
      const rt = LS.get('ruta_' + (U().id || ''), {}); let mb = '';
      try { const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; if (est && est.usage) mb = ' · ' + (est.usage / 1048576).toFixed(0) + ' MB en el equipo'; } catch (e) {}
      toast('✔ Listo para ruta: ' + nf((rt.listas || 0) + (rt.detalles || 0)) + ' consultas guardadas (' + nf(rt.detalles || 0) + ' notas, cotizaciones, compras y clientes)' + mb);
    } catch (e) { toast('No se pudo completar con esta señal; intenta de nuevo', true); }
    finally { cargando(false); pintarBienvEstado(); }
  }
  function haceTxt(t) { if (!t) return 'sin datos'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'hace un momento' : m < 60 ? 'hace ' + m + ' min' : m < 1440 ? 'hace ' + Math.round(m / 60) + ' h' : 'hace ' + Math.round(m / 1440) + ' días'; }
  function pintarBienvEstado() {
    const el = $('#bienvEstado'); if (!el) return;
    const d = S.datos || {}, n = S.cola.length;
    const rt = LS.get('ruta_' + (U().id || ''), null);
    el.innerHTML = `<span>📦 Información en este equipo: <b>${haceTxt(d._t)}</b> · ${(d.clientes || []).length} clientes · ${(d.productos || []).length} productos</span>
      ${rt ? `<span>🧭 Preparado para ruta <b>${haceTxt(rt.t)}</b> · ${nf((rt.listas || 0) + (rt.detalles || 0))} consultas guardadas</span>` : ''}
      ${n ? `<span>⟳ <b>${n}</b> por sincronizar${S.sincronizando ? ' (enviando…)' : ' · se envían solas con buena señal'}</span>` : '<span>✔ Todo sincronizado</span>'}
      <button onclick="App.prepararRuta()">📥 Actualizar para ruta</button>`;
  }


  /* ---------- filtro rápido Mes / Año (se agrega junto a Desde / Hasta) ---------- */
  const MESES_TXT = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  /**
   * Selectores Mes / Año junto a "Desde - Hasta".
   * tabla (ventas, compras, traspasos…): el Año muestra solo los años que tienen registros y agrega "Todos"
   * (todo el historial: Desde y Hasta vacíos).
   */
  function agregarMesAnio(idDesde, idHasta, buscar, tabla) {
    const dI = $('#' + idDesde), hI = $('#' + idHasta);
    if (!dI || !hI || $('#' + idDesde + 'Mes')) return;
    const iso = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const anioAct = new Date().getFullYear();
    S.anios = S.anios || {};
    const base = () => { const a = []; for (let y = anioAct; y >= 2022; y--) a.push(y); return a; };
    let anios = tabla && S.anios[tabla] ? S.anios[tabla].slice() : base();
    // ¿las fechas actuales son todo el historial, un mes completo o un año completo?
    const detectar = () => {
      const a = dI.value, b = hI.value;
      if (tabla && !a && !b) return ['', 'todos'];
      if (!a || !b) return ['', String(anioAct)];
      const y = +a.slice(0, 4), m = +a.slice(5, 7);
      if (a === iso(y, 1, 1) && (b === iso(y, 12, 31) || (y === anioAct && b === hoyISO()))) return ['todo', String(y)];
      const fin = iso(y, m, new Date(y, m, 0).getDate());
      if (a === iso(y, m, 1) && (b === fin || (b.slice(0, 7) === a.slice(0, 7) && b === hoyISO()))) return [String(m), String(y)];
      return ['', String(y)];
    };
    const opsAnio = sel => (tabla ? `<option value="todos" ${sel === 'todos' ? 'selected' : ''}>Todos</option>` : '') +
      anios.concat(sel && sel !== 'todos' && anios.indexOf(+sel) < 0 ? [+sel] : []).sort((x, y) => y - x).map(y => `<option value="${y}" ${String(y) === sel ? 'selected' : ''}>${y}</option>`).join('');
    const [mSel, ySel] = detectar();
    const lblD = dI.closest('label');
    const cont = document.createElement('span'); cont.style.display = 'contents';
    cont.innerHTML = `<label>Mes<select id="${idDesde}Mes" ${ySel === 'todos' ? 'disabled' : ''}><option value="">Personalizado</option>${MESES_TXT.map((n, i) => `<option value="${i + 1}" ${mSel === String(i + 1) ? 'selected' : ''}>${n}</option>`).join('')}<option value="todo" ${mSel === 'todo' ? 'selected' : ''}>Todo el año</option></select></label>
      <label>Año<select id="${idDesde}Anio">${opsAnio(ySel)}</select></label>`;
    lblD.parentNode.insertBefore(cont, lblD);
    const mS = $('#' + idDesde + 'Mes'), yS = $('#' + idDesde + 'Anio');
    const aplicar = () => {
      if (yS.value === 'todos') { mS.value = ''; mS.disabled = true; dI.value = ''; hI.value = ''; if (buscar) buscar(); return; }
      mS.disabled = false;
      const y = +yS.value, m = mS.value;
      if (!m) return;
      if (m === 'todo') { dI.value = iso(y, 1, 1); hI.value = iso(y, 12, 31); }
      else { dI.value = iso(y, +m, 1); hI.value = iso(y, +m, new Date(y, +m, 0).getDate()); }
      if (buscar) buscar();
    };
    mS.onchange = aplicar;
    yS.onchange = () => { if (yS.value !== 'todos' && !mS.value) mS.value = 'todo'; aplicar(); };
    const manual = () => { mS.value = ''; mS.disabled = false; if (yS.value === 'todos' && (dI.value || hI.value)) yS.value = String((dI.value || hI.value).slice(0, 4)) || String(anioAct); };
    dI.addEventListener('input', manual); hI.addEventListener('input', manual);
    // años reales con registros (una vez por sesión)
    if (tabla && !S.anios[tabla]) pedir('aniosRegistros', { tabla: tabla }, true).then(l => {
      if (!Array.isArray(l) || !l.length) return;
      S.anios[tabla] = l; anios = l.slice();
      if (document.body.contains(yS)) { const v = yS.value; yS.innerHTML = opsAnio(v); yS.value = v; }
    }).catch(() => {});
  }

  /* ---------------- navegación ---------------- */
  const MENU = [
    { id: 'inicio', t: 'Inicio', i: '🏠' },
    { id: 'tablero', t: 'Dashboard', i: '📊', p: 'dashboard' },
    { id: 'venta', t: 'Nueva venta', i: '🛒', p: 'ventas' },
    { id: 'ventas', t: 'Ventas', i: '🧾', p: ['ventas', 'cobranza'] },
    { id: 'cotizaciones', t: 'Cotizaciones', i: '📝', p: 'cotizaciones' },
    { id: 'seguimiento', t: 'Seguimiento', i: '🤝', p: ['seguimiento', 'recetas'] },
    { id: 'visitas', t: 'Visitas', i: '📅', p: 'seguimiento', oculto: 1 },
    { id: 'radar', t: 'Radar comercial', i: '🎯', p: 'seguimiento', oculto: 1 },
    { id: 'metas', t: 'Metas y comisiones', i: '🏆', p: 'seguimiento', oculto: 1 },
    { id: 'recetas', t: 'Recetas', i: '💊', p: 'recetas', oculto: 1 },
    { id: 'compras', t: 'Compras', i: '📦', p: ['compras', 'traspasos'] },
    { id: 'gastos', t: 'Gastos', i: '🔒', p: ['dueno', 'clasificar_gastos'] },
    { id: 'sucursales', t: 'Sucursales', i: '🏬', p: ['dueno', 'inventario', 'traspasos', 'requisiciones', 'ajustes', 'mermas', 'inventario_fisico'] },
    { id: 'traspasos', t: 'Traspasos', i: '🚚', p: 'traspasos', oculto: 1 },
    { id: 'requisiciones', t: 'Requisiciones de traspaso', i: '📑', p: 'requisiciones', oculto: 1 },
    { id: 'ajustes', t: 'Ajustes y mermas', i: '⚖️', p: ['ajustes', 'mermas'], oculto: 1 },
    { id: 'inventario', t: 'Inventario', i: '🏷️', p: 'inventario', oculto: 1 },
    { id: 'conteo', t: 'Conteo físico', i: '📋', p: 'inventario_fisico', oculto: 1 },
    { id: 'pedido', t: 'Pedido sugerido', i: '🛒', p: ['compras', 'traspasos'], oculto: 1 },
    { id: 'anCompras', t: 'Análisis de compras', i: '📊', p: 'compras', oculto: 1 },
    { id: 'precios', t: 'Lista de precios', i: '💲', p: 'listas_precios', oculto: 1 },
    { id: 'productos', t: 'Productos', i: '💊', p: 'listas_precios' },
    { id: 'matriz', t: 'Actualizar desde Matriz', i: '🔄', p: 'productos_editar', oculto: 1 },
    { id: 'clientes', t: 'Clientes', i: '👥', p: 'clientes' },
    { id: 'proveedores', t: 'Proveedores', i: '🏭', p: 'proveedores' },
    { id: 'config', t: 'Configuración', i: '⚙️' }
  ];
  function pintarMenu() {
    const u = U();
    $('#menu').innerHTML = `<div class="cab">${window.LOGO ? `<img src="${window.LOGO}" alt="Interés Veterinario">` : '<b>🐾 Interés Veterinario</b>'}<small>${esc(u.nombre)} · ${esc(u.rolNombre || u.rol)}</small></div>
      <nav>${MENU.filter(m => !m.oculto && puede(m.p)).map(m => { const solo = GRUPOS[m.id] && tabsGrupo(m.id).length === 1 ? MENU.find(x => x.id === tabsGrupo(m.id)[0].v) : null, e = solo || m;
        return `<button class="${S.vista === m.id || grupoDe(S.vista) === m.id ? 'activo' : ''}" onclick="App.ir('${m.id}')"><span>${e.i}</span>${esc(e.t)}</button>`; }).join('')}</nav>
      <div class="pie"><div class="con-avatar">${avatarSuc(sucTrabajo())}${u.todasSucursales ? `<label style="flex:1">Sucursal de trabajo<select onchange="App.cambiarSuc(this.value)">${optsSuc(sucTrabajo())}</select></label>` : `<span>Sucursal: <b>${esc(sucNom(u.sucursal))}</b></span>`}</div>
      <button class="btn chico" onclick="App.salir()">Cerrar sesión</button><div class="ver-app"></div></div>`;
    cargarAvatares($('#menu')); pintarVersion();
  }
  const esMatriz = id => { const x = (D().sucursales || []).find(o => o.id === id); return id === 'SUC_MAT_1' || !!(x && /^matriz$/i.test(String(x.tipo || ''))); };
  const avatarSuc = id => { const x = (D().sucursales || []).find(o => o.id === id) || {};
    if (esMatriz(id) && window.LOGO) return `<span class="avatar con-foto avatar-logo"><img src="${window.LOGO}" alt=""><b>M</b></span>`;
    return avatar('sucFoto', id, x.foto, x.nombre || id); };
  function cambiarSuc(v) { S.suc = v; LS.set('suc', v); ir(S.vista); }
  function menu(v) { document.body.classList.toggle('menu-abierto', v); }
  /* Secciones con pestañas: cada pestaña es una pantalla (v) y opcionalmente una sub-pestaña (a). */
  const GRUPOS = {
    sucursales: { t: 'Sucursales', tabs: [
      { v: 'sucursales', t: '🔒 Resumen', p: 'dueno' }, { v: 'inventario', t: '🏷️ Inventario', p: 'inventario' },
      { v: 'traspasos', t: '🚚 Traspasos', p: 'traspasos' }, { v: 'requisiciones', t: '📑 Requisición de traspaso', p: 'requisiciones' }, { v: 'ajustes', t: '⚖️ Ajustes y mermas', p: ['ajustes', 'mermas'] },
      { v: 'conteo', t: '📋 Conteo físico', p: 'inventario_fisico' }] },
    seguimiento: { t: 'Seguimiento de clientes', tabs: [
      { v: 'radar', t: '🎯 Radar', p: 'seguimiento' }, { v: 'metas', t: '🏆 Metas', p: 'seguimiento' }, { v: 'seguimiento', t: '🔔 Por atender', p: 'seguimiento' }, { v: 'visitas', t: '📅 Visitas', p: 'seguimiento' }, { v: 'recetas', t: '💊 Recetas', p: 'recetas' }] },
    compras: { t: 'Compras', tabs: [
      { v: 'compras', t: '📦 Órdenes de compra', p: 'compras' }, { v: 'pedido', t: '🛒 Pedido sugerido', p: ['compras', 'traspasos'] }, { v: 'anCompras', t: '📊 Análisis de compras', p: 'compras' }] },
    productos: { t: 'Productos', tabs: [
      { v: 'productos', a: 'cat', t: '💊 Catálogo', p: 'listas_precios' }, { v: 'productos', a: 'port', t: '📚 Portafolio de productos', p: 'listas_precios' }, { v: 'precios', t: '💲 Lista de precios', p: 'listas_precios' },
      { v: 'productos', a: 'margen', t: '📊 Análisis de precios', p: 'analisis_precios' },
      { v: 'matriz', t: '🔄 Actualizar desde Matriz', p: 'productos_editar' }] }
  };
  const grupoDe = v => Object.keys(GRUPOS).find(g => GRUPOS[g].tabs.some(t => t.v === v)) || null;
  const tabsGrupo = g => GRUPOS[g].tabs.filter(t => puede(t.p));
  const argVista = v => v === 'productos' ? (S.tabProd || 'cat') : undefined;
  const claveTab = t => t.v + (t.a ? ':' + t.a : '');
  function pintarSubnav() {
    let el = $('#subnav');
    if (!el) { $('#vista').insertAdjacentHTML('beforebegin', '<div id="subnav" class="subnav oculto"></div>'); el = $('#subnav'); }
    const g = grupoDe(S.vista), tabs = g ? tabsGrupo(g) : [];
    el.classList.toggle('oculto', tabs.length < 2);
    if (tabs.length < 2) { el.innerHTML = ''; return; }
    const act = tabs.find(t => t.v === S.vista && (!t.a || t.a === argVista(S.vista))) || tabs.find(t => t.v === S.vista);
    el.innerHTML = `<div class="subnav-tabs">${tabs.map((t, i) => `<button class="${t === act ? 'activo' : ''}" onclick="App.irTab('${g}',${i})">${t.t}</button>`).join('')}</div>`;
  }
  function irTab(g, i) {
    const t = tabsGrupo(g)[i]; if (!t) return;
    S.ultGrupo = S.ultGrupo || {}; S.ultGrupo[g] = claveTab(t);
    if (t.v === 'productos') S.tabProd = t.a;
    ir(t.v, true);
  }
  function ir(v, directo) {
    if (v === 'cobranza') { S.tabVen = 'cobranza'; v = 'ventas'; }   // Cobranza ahora es una pestaña de Ventas
    if (GRUPOS[v] && !directo) {   // desde el menú: la última pestaña usada de la sección, o la primera permitida
      const tabs = tabsGrupo(v), ult = (S.ultGrupo || {})[v];
      const t = tabs.find(x => claveTab(x) === ult) || tabs[0];
      if (t) { v = t.v; if (t.v === 'productos' && t.a) S.tabProd = t.a; }
    }
    const g = grupoDe(v), spec = g ? GRUPOS[g].tabs.find(t => t.v === v) : null;
    let m = MENU.find(x => x.id === v && puede(spec ? spec.p : x.p));
    if (!m) m = MENU[0];
    if (m.id !== 'ventas') S.ventasCli = null;
    if (m.id !== 'compras') S.comprasProv = null;
    S.vista = m.id; LS.set('vista', m.id);
    if (g) { S.ultGrupo = S.ultGrupo || {}; S.ultGrupo[g] = m.id === 'productos' ? 'productos:' + (S.tabProd || 'cat') : m.id; }
    S.charts.forEach(c => c.destroy()); S.charts = [];
    $('#titulo').textContent = g && tabsGrupo(g).length > 1 ? GRUPOS[g].t : m.t; menu(false); pintarMenu(); pintarSubnav();
    $('#vista').innerHTML = ''; quitarAvisoCache();
    (V[m.id] || V.inicio)();
    window.scrollTo(0, 0);
  }
  /* ---------- BIENVENIDA (solo celulares y tabletas: iPhone, iPad, Android) ---------- */
  const esMovil = () => { try { return window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) || window.innerWidth <= 820; } catch (e) { return window.innerWidth <= 820; } };
  const SUB_MENU = { inicio: 'Resultados y resumen del día', tablero: 'Análisis y comparativos por año', venta: 'Capturar una nota de venta', ventas: 'Notas, cobranza y facturas', cotizaciones: 'Cotizar y dar seguimiento',
    seguimiento: 'Clientes por atender y visitas', compras: 'Órdenes de compra y pedido sugerido', gastos: 'Gastos del negocio', sucursales: 'Inventario, traspasos y requisiciones',
    productos: 'Catálogo, portafolio y precios', clientes: 'Cartera de clientes', proveedores: 'Laboratorios y distribuidores', config: 'Folios, permisos y ajustes' };
  function saludo() { const h = new Date().getHours(); return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'; }
  function bienvenida() {
    let el = $('#bienvenida');
    if (!el) { el = document.createElement('section'); el.id = 'bienvenida'; el.className = 'bienv'; document.body.appendChild(el); }
    const u = U(), items = MENU.filter(m => !m.oculto && puede(m.p) && m.id !== 'venta').map(m => { const solo = GRUPOS[m.id] && tabsGrupo(m.id).length === 1 ? MENU.find(x => x.id === tabsGrupo(m.id)[0].v) : null; return { id: m.id, e: solo || m }; });
    const fecha = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    const nombre = String(u.apodo || u.nombre || '').trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
    el.innerHTML = `<div class="bienv-fondo" aria-hidden="true"></div>
      <div class="bienv-cont">
        <div class="bienv-top"><span class="bienv-pill"><i class="${S.online ? 'ok' : ''}"></i>${S.online ? 'En línea' : 'Sin conexión'}</span>
          <span class="bienv-pill">🏬 ${esc(sucNom(sucTrabajo()))}</span></div>
        <div class="bienv-marca">${window.LOGO ? `<img src="${window.LOGO}" alt="Interés Veterinario">` : '<b>Interés Veterinario</b>'}</div>
        <div class="bienv-tit"><b>CRM &amp; Ventas</b><span>Inteligencia y Gestión Comercial</span></div>
        <div class="bienv-hola"><h2>${saludo()}${nombre ? ', ' + esc(nombre) : ''}</h2><p>${esc(fecha.charAt(0).toUpperCase() + fecha.slice(1))} · ${esc(u.rolNombre || u.rol || '')}</p></div>
        <div class="bienv-estado" id="bienvEstado"></div>
        ${puede('ventas') ? `<button class="bienv-cta" onclick="App.bienvIr('venta')"><span>🛒</span><div><b>Nueva venta</b><small>Captura una nota en segundos</small></div><em>›</em></button>` : ''}
        <div class="bienv-grid">${items.map(x => `<button class="bienv-item" onclick="App.bienvIr('${x.id}')"><span class="bienv-ico">${x.e.i}</span><b>${esc(x.e.t)}</b><small>${esc(SUB_MENU[x.id] || '')}</small></button>`).join('')}</div>
        <div class="bienv-pie">Interés Veterinario · ${new Date().getFullYear()}${S.cola && S.cola.length ? ` · <b>${S.cola.length} por sincronizar</b>` : ''}<div class="ver-app"></div></div>
        <button class="bienv-salir" onclick="App.salirBienv()" aria-label="Cerrar sesión">⏻ Cerrar sesión</button>
      </div>`;
    el.classList.remove('oculto'); el.scrollTop = 0; document.body.classList.add('con-bienv'); pintarBienvEstado(); pintarVersion();
  }
  function salirBienv() {
    const sin = navigator.onLine === false || S.online === false;
    if (sin && !confirm('⚠️ Estás sin señal: si cierras sesión no podrás volver a entrar hasta tener conexión. ¿Cerrar sesión de todos modos?')) return;
    if (!sin && !(S.cola && S.cola.length) && !confirm('¿Cerrar sesión en este dispositivo?')) return;
    salir();
  }
  function bienvIr(id) { const el = $('#bienvenida'); if (el) el.classList.add('oculto'); document.body.classList.remove('con-bienv'); ir(id); }
  function botonBienvenida() {
    if ($('#btnBienv') || !esMovil()) return;
    const t = $('#titulo'); if (!t) return;
    const b = document.createElement('button'); b.id = 'btnBienv'; b.className = 'icono btn-bienv'; b.setAttribute('aria-label', 'Menú principal'); b.innerHTML = '<span></span><span></span><span></span><span></span>';
    b.onclick = bienvenida; t.parentNode.insertBefore(b, t);
  }
  /* ---------- versión nueva de la app (web de Google): avisa para recargar y no usar una versión vieja ---------- */
  async function revisarVersion(forzar) {
    if (window.IV_API || !S.token) return false;                       // la app instalable tiene su propio aviso
    let r; try { r = await pedir('versionCliente', {}, true); } catch (e) { return false; }
    if (!r || !r.v) return false;
    if (!S.verCli) { S.verCli = r.v; return false; }
    if (r.v === S.verCli) return false;
    if (!$('#avisoVersion')) { const b = document.createElement('div'); b.id = 'avisoVersion'; b.className = 'aviso-version';
      b.innerHTML = `<span>✨ Hay una versión nueva de la app</span><a class="btn primario chico" href="${esc(r.url || '#')}" target="_top" onclick="${r.url ? '' : 'location.reload();return false'}">Actualizar</a>`; document.body.appendChild(b); }
    if (forzar) toast('Hay una versión nueva de la app: toca “Actualizar” antes de continuar', true);
    return true;
  }
  /* ---------- versión de la app instalable: cuál está trabajando en este equipo y si hay una más nueva ---------- */
  /** VERSION del service worker: "144.20261023-0810-hash" → { n: '144', fecha: '23 oct 2026 · 8:10 a. m.' } (las anteriores no tenían número). */
  function textoVersion(v) {
    const m = /^(?:(\d+)\.)?(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?-/.exec(String(v || '')); if (!m) return { n: '', fecha: v ? String(v) : '' };
    const mes = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(m[3]) - 1];
    let t = Number(m[4]) + ' ' + mes + ' ' + m[2];
    if (m[5]) { const h = Number(m[5]); t += ' · ' + (h % 12 || 12) + ':' + m[6] + (h < 12 ? ' a. m.' : ' p. m.'); }
    return { n: m[1] || '', fecha: t };
  }
  async function versionActiva() {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (sw) { try { const v = await new Promise((ok, no) => { const c = new MessageChannel(); c.port1.onmessage = e => ok(e.data); sw.postMessage('version', [c.port2]); setTimeout(() => no(), 1500); }); if (v) return v; } catch (e) {} }
    try { const k = (await caches.keys()).filter(x => x.indexOf('iv-app-') === 0).sort(); if (k.length) return k[k.length - 1].slice(7); } catch (e) {}
    return '';
  }
  async function revisarVersionApp() {
    const pwa = !!window.IV_API, act = pwa ? await versionActiva() : ''; let nueva = '';
    if (pwa && navigator.onLine !== false) { try { const t = await (await fetch('sw.js?v=' + Date.now(), { cache: 'no-store' })).text(); nueva = (/const VERSION = '([^']+)'/.exec(t) || [])[1] || ''; } catch (e) {} }
    let srv = S.ver && S.ver.srv || '';
    if (navigator.onLine !== false && S.token) { try { const r = await pedir('ping', {}, true); if (r && r.v) srv = r.v; } catch (e) {} }
    S.ver = { act: act, nueva: nueva, srv: srv }; pintarVersion();
  }
  function pintarVersion() {
    const v = S.ver; if (!v || (!v.act && !v.srv)) return;
    const a = textoVersion(v.act), n = textoVersion(v.nueva), vieja = v.nueva && v.nueva !== v.act;
    const html = `<span title="Publicada el ${esc(a.fecha)}">${v.act ? `📱 Versión <b>${esc(a.n || a.fecha)}</b>` : '📱'}${v.srv ? ` · servidor <b>${esc(v.srv)}</b>` : ''}</span> ` +
      (vieja ? `<a href="#" class="ver-nueva" onclick="App.actualizarApp();return false">✨ Hay una nueva${n.n ? ' (' + esc(n.n) + ')' : ''}: actualizar</a>`
      : v.nueva ? '<span class="ver-ok">✔ al día</span>' : !v.act ? '' : '<span class="muted">· sin conexión para revisar</span>');
    document.querySelectorAll('.ver-app').forEach(el => { el.innerHTML = html; el.classList.toggle('vieja', !!vieja); });
    // en la barra de arriba (escritorio y tableta): corto, el detalle va en el globo
    const top = $('#verTop');
    if (top) {
      top.classList.remove('oculto'); top.classList.toggle('aviso', !!vieja);
      top.title = (a.n ? 'App versión ' + a.n + ' · publicada el ' + a.fecha : 'App') + (v.srv ? ' · servidor ' + v.srv : '') + (vieja ? ' · hay una nueva, toca para actualizar' : v.nueva ? ' · al día' : '');
      top.innerHTML = vieja ? '✨ Actualizar a ' + esc(n.n || 'nueva') : (a.n ? 'v' + esc(a.n) : '') + (v.srv ? (a.n ? ' · ' : '') + 's' + esc(v.srv) : '') + (v.nueva ? ' ✔' : '');
      top.onclick = vieja ? () => App.actualizarApp() : null; top.style.cursor = vieja ? 'pointer' : '';
    }
  }
  /** Baja de nuevo los archivos de la app (no toca la sesión ni lo pendiente de enviar). */
  function actualizarApp() {
    if (navigator.onLine === false) return toast('Necesitas señal para actualizar la app', true);
    location.href = location.pathname + '?reiniciar';
  }
  function mostrarApp() {
    $('#login').classList.add('oculto'); $('#app').classList.remove('oculto');
    marcarRed(S.online); pintarCola(); ir(S.vista);
    botonBienvenida(); if (esMovil()) bienvenida();
    revisarVersionApp(); revisarVersion(); if (!S.verTimer) { S.verTimer = setInterval(() => { revisarVersion(); revisarVersionApp(); }, 15 * 60000); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { revisarVersion(); revisarVersionApp(); } }); }
    // logotipos de sucursal guardados con fondo blanco: el administrador los deja sin fondo (una vez, en segundo plano)
    if (U().rol === 'Administrador' && LS.get('minisSucRev', '') !== hoyISO()) setTimeout(() => { try { LS.set('minisSucRev', hoyISO()); repararMinisSuc(D().sucursales || []); } catch (e) {} }, 30000);
  }

  /* ---------------- buscador con autocompletar ---------------- */
  function buscador(input, o) {
    const box = document.createElement('div'); box.className = 'sugerencias oculto'; input.parentElement.appendChild(box);
    let items = [], sel = -1;
    let resto = 0;
    const pintar = () => { box.innerHTML = items.map((x, i) => `<div data-i="${i}" class="${i === sel ? 'sel' : ''}${x.nuevo ? ' sug-nuevo' : ''}">${esc(x.t)}<small>${esc(x.s || '')}</small></div>`).join('') +
      (resto ? `<div class="sug-mas">… y ${resto} más. Escribe más letras para afinar.</div>` : ''); box.classList.toggle('oculto', !items.length); };
    const buscar = () => { const q = input.value.trim(), todos = q ? o.fuente(q) : []; items = todos.slice(0, 40); resto = Math.max(0, todos.length - items.length);
      // ¿no está? → renglón para darlo de alta ahí mismo (al final de la lista; si no hay resultados, es el único)
      if (o.nuevo && q.length >= 2) items.push({ nuevo: 1, q: q, t: (todos.length ? '➕ ¿No está? Dar de alta "' : '➕ No existe: dar de alta "') + q + '" como cliente nuevo', s: '' });
      sel = items.length ? 0 : -1; pintar(); };
    const elegir = x => { box.classList.add('oculto'); if (x.nuevo) return o.nuevo(x.q); input.value = o.limpiar ? '' : x.t; o.alElegir(x); };
    input.addEventListener('input', buscar);
    input.addEventListener('focus', buscar);
    input.addEventListener('keydown', e => {
      if (box.classList.contains('oculto')) return;
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); pintar(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); pintar(); e.preventDefault(); }
      else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); elegir(items[sel]); }
      else if (e.key === 'Escape') box.classList.add('oculto');
    });
    box.addEventListener('mousedown', e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); elegir(items[+d.dataset.i]); } });
    input.addEventListener('blur', () => setTimeout(() => box.classList.add('oculto'), 180));
  }
  /** Ordena resultados: clave exacta, nombre que empieza con lo escrito, palabra del nombre que empieza así, nombre que lo contiene, y al final lo demás (laboratorio, categoría…). */
  function rankear(lista, q, nombreDe, claveDe) {
    const nq = norm(q).trim(), pals = nq.split(/\s+/).filter(Boolean);
    const nivel = x => {
      const n = norm(nombreDe(x)), pn = n.split(/[^a-z0-9ñ]+/).filter(Boolean);
      if (claveDe && norm(claveDe(x)) === nq) return 0;
      if (n.indexOf(nq) === 0) return 1;
      if (pals.every(p => pn.some(w => w.indexOf(p) === 0))) return 2;
      if (pals.every(p => n.indexOf(p) >= 0)) return 3;
      return 4;
    };
    return lista.map(x => [nivel(x), x]).sort((a, b) => a[0] - b[0] || String(nombreDe(a[1])).localeCompare(String(nombreDe(b[1])))).map(z => z[1]);
  }
  const fuenteProductos = (suc, lista, soloActivos) => q => rankear((D().productos || [])
    .filter(p => (!soloActivos || p.activo) && coincide(p.id + ' ' + p.nombre + ' ' + p.lab + ' ' + p.categoria, q)), q, p => p.nombre, p => p.id)
    .map(p => ({ id: p.id, t: p.nombre, s: `${p.id} · ${lista ? $$(p.precios[lista]) + ' · ' : ''}Exist. ${suc ? nf(existencia(p.id, suc)) : nf(existencia(p.id))}${p.activo ? '' : ' · INACTIVO'}` }));
  const fuenteClientes = q => rankear((D().clientes || []).filter(c => coincide(c.nombre + ' ' + c.razon + ' ' + (c.rancho || '') + ' ' + c.rfc + ' ' + c.localidad + ' ' + c.cel, q)), q, c => (c.razon || '') + ' ' + c.nombre + ' ' + (c.rancho || ''))
    .map(c => ({ id: c.id, t: c.razon && c.razon !== c.nombre ? c.razon + ' — ' + c.nombre : c.nombre, s: `${c.lista} · ${c.credito} días · ${c.localidad || c.municipio || ''}${c.status === 'Inactivo' ? ' · INACTIVO' : ''}` }));

  /* ---------------- formularios genéricos ---------------- */
  function campoHtml(c, v) {
    v = v === undefined || v === null ? '' : v;
    const dis = c.dis ? 'disabled' : '', req = c.req ? 'required' : '', st = c.ancho ? 'style="grid-column:1/-1"' : '';
    let inp;
    if (c.tipo === 'select') inp = `<select data-k="${esc(c.k)}" ${dis} ${req}>${opts(c.ops, v, c.vacio)}</select>`;
    else if (c.tipo === 'lista') { const dl = 'dl_' + c.k.replace(/\W/g, '');
      inp = `<input data-k="${esc(c.k)}" list="${dl}" value="${esc(v)}" placeholder="${esc(c.ph || 'Elige o escribe uno nuevo')}" autocomplete="off" ${dis} ${req}><datalist id="${dl}">${(c.ops || []).map(x => `<option value="${esc(x)}">`).join('')}</datalist>`; }
    else if (c.tipo === 'multi') {
      const sel = String(v).split(',').map(x => x.trim()).filter(Boolean), todas = (c.ops || []).concat(sel.filter(x => (c.ops || []).indexOf(x) < 0));
      inp = `<input type="hidden" data-k="${esc(c.k)}" value="${esc(v)}"><div class="multi-sel">${todas.map(o => `<label class="chip-op${sel.indexOf(o) >= 0 ? ' on' : ''}"><input type="checkbox" value="${esc(o)}" ${sel.indexOf(o) >= 0 ? 'checked' : ''} ${dis} onchange="App.multiSel(this)">${esc(o)}</label>`).join('')}</div>`; }
    else if (c.tipo === 'textarea') inp = `<textarea data-k="${esc(c.k)}" ${dis}>${esc(v)}</textarea>`;
    else if (c.tipo === 'check') return `<label class="check" ${st}><input type="checkbox" data-k="${esc(c.k)}" ${String(v).toUpperCase() === 'TRUE' || v === true ? 'checked' : ''} ${dis}> ${esc(c.t)}</label>`;
    else inp = `<input data-k="${esc(c.k)}" type="${c.tipo || 'text'}" ${c.tipo === 'number' ? 'step="any"' : ''} value="${esc(v)}" ${dis} ${req}>`;
    return `<label ${st}>${esc(c.t)}${c.req ? ' *' : ''}${inp}</label>`;
  }
  /** Selección múltiple: guarda las opciones marcadas separadas por " , " (igual que AppSheet). */
  function multiSel(cb) {
    const caja = cb.closest('label').parentNode, oculto = caja.previousElementSibling;
    cb.closest('label').classList.toggle('on', cb.checked);
    oculto.value = Array.from(caja.querySelectorAll('input:checked')).map(x => x.value).join(' , ');
  }
  const NICHOS = ['Doble propósito', 'Leche', 'Carne', 'Equinos', 'Porcinos', 'Ovinos', 'Caprinos', 'Aves', 'Pequeñas especies', 'Fauna Silvestre', 'Apícola', 'Búfalos', 'Conejos'];
  /** Filtros de listas: texto con 'input' y listas/casillas con 'change'. (Con los dos, al salir del buscador la lista se
   *  redibujaba justo al tocar una fila y ese primer toque se perdía.) */
  const enlazarFiltro = (sel, fn) => { const el = $(sel); if (!el) return; if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.oninput = fn; else el.onchange = fn; };
  const formulario = (campos, val) => `<div class="rejilla">${campos.map(c => campoHtml(c, val[c.k])).join('')}</div>`;
  function leerForm(cont) {
    const o = {};
    cont.querySelectorAll('[data-k]').forEach(el => { o[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
    return o;
  }
  function soloCambios(ini, nuevo) {
    const o = {};
    Object.keys(nuevo).forEach(k => { const a = ini[k] === undefined || ini[k] === null ? '' : String(ini[k]); if (String(nuevo[k]) !== a) o[k] = nuevo[k]; });
    return o;
  }

  /* ---------------- gráficas ---------------- */
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function grafica(id, cfg) {
    const el = document.getElementById(id); if (!el || typeof Chart === 'undefined') return;
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.color = css('--texto-2');
    Chart.defaults.borderColor = css('--borde');
    if (cfg.type === 'doughnut' || cfg.type === 'pie') circularConPct(cfg);
    S.charts.push(new Chart(el, cfg));
  }
  /**
   * Gráficas circulares: el % de cada rebanada escrito sobre ella (si cabe) y en la leyenda ("Nombre · 28.1 %"),
   * porque el color solo no dice nada. Se aplica a todas las de la app.
   */
  function circularConPct(cfg) {
    const ds = cfg.data.datasets[0], tot = () => (ds.data || []).reduce((t, v) => t + (Number(v) || 0), 0);
    const pct = v => { const t = tot(); return t ? (v / t * 100) : 0; }, txt = v => { const p = pct(v); return (p >= 10 ? p.toFixed(0) : p.toFixed(1)) + '%'; };
    ds.borderColor = css('--superficie') || '#fff'; ds.borderWidth = 2;
    cfg.options = cfg.options || {}; cfg.options.plugins = cfg.options.plugins || {};
    const lg = cfg.options.plugins.legend = Object.assign({ position: 'right' }, cfg.options.plugins.legend || {});
    lg.labels = Object.assign({}, lg.labels || {}, { generateLabels: ch => {
      const base = Chart.overrides[ch.config.type].plugins.legend.labels.generateLabels(ch);
      return base.map((it, i) => { const n = String(it.text || ''), corto = n.length > 24 ? n.slice(0, 23) + '…' : n; return Object.assign(it, { text: corto + ' · ' + txt(ds.data[i] || 0) }); });
    } });
    cfg.plugins = (cfg.plugins || []).concat([{ id: 'pctCirc', afterDatasetsDraw(ch) {
      const meta = ch.getDatasetMeta(0), c = ch.ctx; c.save(); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '600 12px Inter, system-ui, sans-serif';
      meta.data.forEach((arc, i) => { if (meta.data[i].hidden) return; const v = ds.data[i] || 0; if (pct(v) < 4) return;
        const pos = arc.tooltipPosition(); c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.35)'; c.strokeText(txt(v), pos.x, pos.y); c.fillStyle = '#fff'; c.fillText(txt(v), pos.x, pos.y); });
      c.restore(); } }]);
  }
  const tickMoneda = v => { const a = Math.abs(v); return (a >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? '$' + (v / 1e3).toFixed(0) + 'k' : '$' + v); };
  function barras(id, items, color, horizontal) {
    grafica(id, {
      type: 'bar',
      data: { labels: items.map(x => x.nombre), datasets: [{ data: items.map(x => x.valor), backgroundColor: color || css('--s1'), borderRadius: 4, maxBarThickness: 26 }] },
      options: {
        indexAxis: horizontal ? 'y' : 'x', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => $$(c.raw) } } },
        scales: { [horizontal ? 'x' : 'y']: { ticks: { callback: tickMoneda }, grid: { color: css('--borde') } }, [horizontal ? 'y' : 'x']: { grid: { display: false }, ticks: { autoSkip: false, callback: function (v) { const l = this.getLabelForValue(v); return l.length > 22 ? l.slice(0, 21) + '…' : l; } } } }
      }
    });
  }

  /* =========================================================================
   *  VISTAS
   * ======================================================================= */
  const V = {};

  /* ---------- INICIO / DASHBOARD ---------- */
  V.inicio = () => {
    if (puede('dashboard')) return V.dashboard();
    const suc = sucTrabajo();
    const dias = (D().config || {}).diasCaducidad || 120;
    const alerta = (D().stock || []).filter(s => s.s === suc && s.q > 0 && diasA(s.c) !== null && diasA(s.c) <= dias).sort((a, b) => diasA(a.c) - diasA(b.c));
    $('#vista').innerHTML = `<div class="tarjeta"><h3>Hola, ${esc(U().nombre)} 👋</h3><p class="muted">Sucursal ${esc(sucNom(suc))}</p>
      <div class="fila">${puede('ventas') ? '<button class="btn primario fijo" onclick="App.ir(\'venta\')">🛒 Nueva venta</button>' : ''}
      ${puede('cobranza') ? '<button class="btn fijo" onclick="App.ir(\'cobranza\')">💵 Cobranza</button>' : ''}
      ${puede('inventario') ? '<button class="btn fijo" onclick="App.ir(\'inventario\')">🏷️ Inventario</button>' : ''}
      ${puede('traspasos') ? '<button class="btn fijo" onclick="App.ir(\'traspasos\')">🚚 Traspasos</button>' : ''}
      ${puede('inventario_fisico') ? '<button class="btn fijo" onclick="App.ir(\'conteo\')">📋 Conteo físico</button>' : ''}</div></div>
      <div class="tarjeta"><h3>Productos por caducar en tu sucursal (${alerta.length})</h3>
      ${tabla([{ t: 'Producto', h: x => esc((prod(x.p) || {}).nombre || x.p) }, { t: 'Lote', k: 'l' }, { t: 'Caducidad', k: 'c' },
        { t: 'Días', num: 1, h: x => `<span class="etq ${diasA(x.c) < 0 ? 'mal' : 'av'}">${diasA(x.c)}</span>` }, { t: 'Existencia', num: 1, h: x => nf(x.q) }], alerta.slice(0, 50), { vacio: 'Sin productos próximos a caducar' })}</div>`;
  };

  V.dashboard = () => {
    const h = hoyISO(), ini = h.slice(0, 8) + '01';
    const u = U();
    $('#vista').innerHTML = `<div class="tarjeta"><div class="fila">
      <label>Desde<input type="date" id="dDesde" value="${ini}"></label><label>Hasta<input type="date" id="dHasta" value="${h}"></label>
      ${u.todasSucursales ? `<label>Sucursal<select id="dSuc">${optsSuc('', false, 'Todas')}</select></label>` : ''}
      <button class="btn primario fijo" onclick="App.cargarDashboard()">Actualizar</button></div></div><div class="espacio"></div><div id="dash"></div>`;
    agregarMesAnio('dDesde', 'dHasta', cargarDashboard);
    cargarDashboard();
  };
  async function cargarDashboard() {
    S.charts.forEach(c => c.destroy()); S.charts = [];
    const p = { desde: $('#dDesde').value, hasta: $('#dHasta').value, sucursal: $('#dSuc') ? $('#dSuc').value : '' };
    let r;
    try { r = await pedir('dashboard', p); } catch (e) { $('#dash').innerHTML = '<div class="vacio">El tablero requiere conexión.</div>'; return; }
    const k = r.kpi, c = k.utilidad !== undefined;
    const kpi = (t, v, s) => `<div class="kpi"><small>${t}</small><b>${v}</b><span>${s || ''}</span></div>`;
    // Resumen de compras (igual que en Compras › Órdenes de compra): solo órdenes con factura o nota del proveedor
    const vc = k.compras !== null && k.compras !== undefined;
    const htmlCompras = !vc ? '' : `<div class="tarjeta"><h3 style="margin-top:0">📦 Compras y cuentas por pagar <small class="muted" style="font-weight:400">· solo órdenes con factura o nota del proveedor</small></h3><div class="kpis" style="margin:0">
      <div class="kpi kpi-clic" onclick="App.ir('compras')"><small>Compras del periodo</small><b>${$$(k.compras)}</b><span>${k.ordenes} ${k.ordenes === 1 ? 'orden con factura' : 'órdenes con factura'}${k.porRecibir ? ' · ' + k.porRecibir + ' por recibir' : ''}${k.sinFactura ? '<br>' + k.sinFactura + ' sin factura (' + $$(k.sinFacturaTotal) + ') no se cuentan' : ''}</span></div>
      <div class="kpi"><small>Pagado de esas compras</small><b>${$$(k.comprasPagado || 0)}</b><span>${k.compras > 0 ? Math.round((k.comprasPagado || 0) / k.compras * 100) + ' % del total' : '—'}</span></div>
      <div class="kpi"><small>Por pagar del periodo</small><b>${$$(k.comprasSaldo || 0)}</b><span>${k.comprasConSaldo || 0} ${k.comprasConSaldo === 1 ? 'orden' : 'órdenes'} con saldo</span></div>
      <div class="kpi kpi-clic" onclick="App.ir('compras')"><small>Cuentas por pagar (total)</small><b>${$$(k.cxp)}</b><span>${k.cxpOrdenes || 0} ${k.cxpOrdenes === 1 ? 'orden' : 'órdenes'}${k.cxpVencido > 0.009 ? ` · <b class="txt-mal">vencido ${$$(k.cxpVencido)}</b>` : ' · nada vencido'}</span></div>
      </div></div>`;
    $('#dash').innerHTML = `<div class="tarjeta cmp" id="dashComp"><div class="vacio">📅 Comparando con el mismo periodo del año anterior…</div></div>${r.resultados && !r.resultados.error ? htmlUtilNeta(r.resultados) : ''}${htmlCompras}<div class="kpis">
      ${kpi('Ventas netas (sin IVA)', $$(k.ventas), k.notas + ' notas · ticket ' + $$(k.ticket))}
      ${c ? kpi(U().costoLista ? 'Utilidad bruta (costo de lista)' : 'Utilidad bruta (costo real)', $$(k.utilidad), 'Margen ' + k.margen + '% · costo ' + $$(k.costoVentas) + ' (incl. ' + k.fletePct + '% flete)') : ''}
      ${c ? kpi('Utilidad después de mermas', $$(k.utilidadNeta), 'Margen ' + (k.ventas ? (k.utilidadNeta / k.ventas * 100).toFixed(1) : 0) + '%') : ''}
      ${kpi('Cobrado en el periodo', $$(k.cobrado), 'Ventas con IVA ' + $$(k.ventasConIva))}
      ${r.resultados && !r.resultados.error ? kpi('🔒 Gastos', $$(r.resultados.gastosOperacion + r.resultados.financieros),
        'Operación ' + $$(r.resultados.gastosOperacion) + ' · financieros ' + $$(r.resultados.financieros) + (k.ventas ? ' · ' + ((r.resultados.gastosOperacion + r.resultados.financieros) / k.ventas * 100).toFixed(1) + '% de ventas' : '') + ' · sin IVA') : ''}
      ${kpi('Mermas', $$(k.mermas), c ? k.mermaPct + '% de las ventas · ' + (U().costoLista ? 'a costo de lista' : 'a costo real') : 'a costo')}
      ${kpi('Por cobrar', $$(k.cxc), 'Vencido ' + $$(k.cxcVencida))}
      ${c ? kpi('Inventario valorizado', $$(k.valorInventario), nf(k.piezas) + ' piezas') : kpi('Piezas en inventario', nf(k.piezas), '')}
      ${kpi('Lotes por caducar', k.porCaducar, k.caducados + ' lotes ya caducados con existencia')}
      </div>
      ${r.resultados ? htmlResultados(r.resultados) : ''}
      <div class="tarjeta"><h3>Últimos 12 meses</h3><div class="grafica"><canvas id="gMeses"></canvas></div></div>
      <div class="espacio"></div>
      <div class="rejilla-2">
        <div class="tarjeta"><h3>Ventas por sucursal</h3><div class="grafica"><canvas id="gSuc"></canvas></div></div>
        <div class="tarjeta"><h3>Ventas por categoría</h3><div class="grafica"><canvas id="gCat"></canvas></div></div>
        <div class="tarjeta"><h3>Ventas por vendedor</h3><div class="grafica"><canvas id="gVend"></canvas></div></div>
        <div class="tarjeta"><h3>Mejores clientes</h3>${tabla([{ t: 'Cliente', k: 'nombre' }, { t: 'Venta neta', num: 1, h: x => $$(x.valor) }], r.topClientes)}</div>
      </div>
      <div class="espacio"></div>
      <div class="tarjeta"><h3>Productos más vendidos</h3>${tabla([{ t: 'Producto', k: 'nombre' }, { t: 'Cantidad', num: 1, h: x => nf(x.cant) },
        { t: 'Venta neta', num: 1, h: x => $$(x.importe) }].concat(c ? [{ t: 'Utilidad', num: 1, h: x => $$(x.utilidad) }, { t: 'Margen', num: 1, h: x => x.importe ? (x.utilidad / x.importe * 100).toFixed(1) + '%' : '—' }] : []), r.topProductos)}</div>
      <div class="tarjeta"><h3>Por caducar (≤ ${(D().config || {}).diasCaducidad || 120} días)</h3>${tablaCaducidad(r.porCaducar)}</div>
      ${r.caducados.length ? `<div class="tarjeta"><h3>Caducados con existencia</h3>${tablaCaducidad(r.caducados)}</div>` : ''}`;
    const ds = [{ label: 'Ventas', data: r.meses.map(m => m.ventas), borderColor: css('--s1'), backgroundColor: css('--s1') }];
    if (k.compras !== null && k.compras !== undefined) ds.push({ label: 'Compras', data: r.meses.map(m => m.compras), borderColor: css('--s2'), backgroundColor: css('--s2') });
    if (c) ds.push({ label: 'Utilidad', data: r.meses.map(m => m.utilidad), borderColor: css('--s3'), backgroundColor: css('--s3') });
    if (r.resultados && !r.resultados.error) {
      ds.push({ label: 'Gastos de operación', data: r.meses.map(m => m.gastosOp), borderColor: css('--aviso'), backgroundColor: css('--aviso') });
      ds.push({ label: 'Utilidad neta', data: r.meses.map(m => m.utilidadNeta), borderColor: css('--texto'), backgroundColor: css('--texto'), borderDash: [5, 4] });
    }
    ds.forEach(d => { d.borderWidth = 2; d.pointRadius = 3; d.tension = .25; });
    grafica('gMeses', { type: 'line', data: { labels: r.meses.map(m => m.etiqueta), datasets: ds },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: x => x.dataset.label + ': ' + $$(x.raw) } } },
        scales: { y: { ticks: { callback: tickMoneda } }, x: { grid: { display: false } } } } });
    barras('gSuc', r.porSucursal.map(x => ({ nombre: sucNom(x.nombre), valor: x.valor })), null, true);
    cargarComparativo(p);
    barras('gCat', r.porCategoria, null, true);
    barras('gVend', r.porVendedor, null, true);
    if (r.resultados && !r.resultados.error && $('#gGastos')) {
      const op = r.resultados.porCategoria.filter(x => x.grupo === 'Operación');
      barras('gGastos', op.map(x => ({ nombre: x.cat, valor: x.monto })), css('--aviso'), true);
    }
  }
  /* ---------- 📅 Comparativo contra el año anterior (Inicio) ---------- */
  const delta = (a, b) => b ? Math.round((a - b) / Math.abs(b) * 1000) / 10 : (a ? null : 0);
  function chipDelta(a, b, malSiSube, tipo) {
    if (tipo === '%') { const d = Math.round((a - b) * 10) / 10; if (!d) return '<span class="cmp-d igual">= igual</span>'; const bueno = malSiSube ? d < 0 : d > 0; return `<span class="cmp-d ${bueno ? 'sube' : 'baja'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)} pts</span>`; }
    const d = delta(a, b);
    if (d === null) return '<span class="cmp-d sube">✨ nuevo</span>';
    if (!d) return '<span class="cmp-d igual">= igual</span>';
    const bueno = malSiSube ? d < 0 : d > 0;
    return `<span class="cmp-d ${bueno ? 'sube' : 'baja'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toLocaleString('es-MX')}%</span>`;
  }
  const fmtK = (v, tipo) => tipo === 'n' ? nf(v) : tipo === '%' ? v + '%' : $$(v);
  async function cargarComparativo(p) {
    const el = $('#dashComp'); if (!el) return;
    let r; try { r = await pedir('comparativo', p, true); } catch (e) { el.innerHTML = `<div class="vacio">${e.red ? 'El comparativo necesita conexión.' : /desconocida/i.test(e.message) ? '📅 El comparativo contra el año anterior se activa en cuanto se publique la actualización del servidor (155).' : esc(e.message)}</div>`; return; }
    if (!$('#dashComp')) return;
    S.comp = r; pintarComparativo();
  }
  function pintarComparativo() {
    const r = S.comp, el = $('#dashComp'); if (!r || !el) return;
    const yA = r.periodo.actual.hasta.slice(-4), yB = r.periodo.anterior.hasta.slice(-4);
    const fila = (x, i, cmpA, cmpB, nom) => `<tr><td class="num muted">${i + 1}</td><td>${esc(nom)}</td><td class="num"><b>${$$(cmpA)}</b></td><td class="num muted">${cmpB ? $$(cmpB) : '—'}</td><td class="num">${chipDelta(cmpA, cmpB)}</td>
      <td class="num muted">${x.rB ? '#' + x.rB : '<span class="cmp-d sube">nuevo</span>'}</td></tr>`;
    const tablaTop = (l, f, g, nom, titulo) => `<div class="tabla-cont"><table class="cmp-tabla"><thead><tr><th class="num">#</th><th>${titulo}</th><th class="num">${yA}</th><th class="num">${yB}</th><th class="num">Cambio</th><th class="num">Lugar en ${yB}</th></tr></thead>
      <tbody>${l.length ? l.map((x, i) => fila(x, i, f(x), g(x), nom(x))).join('') : '<tr><td colspan="6" class="vacio">Sin ventas en el periodo</td></tr>'}</tbody></table></div>`;
    const salieron = (top, ant, key) => ant.filter(x => !top.some(y => key(y) === key(x)));
    const fuera = (l, key, nom, f) => l.length ? `<p class="muted peq" style="margin:6px 0 0">Salieron del top 10 de ${yB}: ${l.map(x => `<b>${esc(nom(x))}</b> (#${x.rB} → ${x.rA ? '#' + x.rA : 'sin venta'})`).join(' · ')}</p>` : '';
    el.innerHTML = `<div class="cmp-cab"><h3 style="margin:0">📅 Contra el año anterior</h3><small class="muted">${esc(r.periodo.actual.desde)} – ${esc(r.periodo.actual.hasta)} <b>vs</b> ${esc(r.periodo.anterior.desde)} – ${esc(r.periodo.anterior.hasta)}</small></div>
      <div class="cmp-kpis">${r.kpi.map(k => `<div class="cmp-kpi"><small>${esc(k.t)}</small><b>${fmtK(k.a, k.tipo)}</b><span>${chipDelta(k.a, k.b, k.malSiSube, k.tipo)} <em>${yB}: ${fmtK(k.b, k.tipo)}</em></span></div>`).join('')}</div>
      <div class="grafica" style="height:240px;margin-top:10px"><canvas id="gComp"></canvas></div>
      <div class="rejilla-2" style="margin-top:12px">
        <div><h4 style="margin:4px 0 8px">🏷️ Top 10 productos</h4>${tablaTop(r.topProductos, x => x.impA, x => x.impB, x => x.nombre, 'Producto')}${fuera(salieron(r.topProductos, r.topProductosAnt, x => x.id), x => x.id, x => rdCorto(x.nombre))}</div>
        <div><h4 style="margin:4px 0 8px">👥 Top 10 clientes</h4>${tablaTop(r.topClientes, x => x.a, x => x.b, x => x.nombre, 'Cliente')}${fuera(salieron(r.topClientes, r.topClientesAnt, x => x.nombre), x => x.nombre, x => x.nombre)}</div>
      </div>
      <div class="acciones izq" style="margin-top:10px"><button class="btn primario" onclick="App.compProductos()">📋 Producto por producto (${nf(r.productos.length)})</button>
        <span class="muted peq">✨ ${nf(r.nuevos)} productos nuevos · ${nf(r.perdidos)} que se vendieron en ${yB} y no ahora · ${nf(r.clientesNuevos)} clientes nuevos · ${nf(r.clientesPerdidos)} que compraron en ${yB} y no ahora</span></div>`;
    const ds = [{ label: 'Ventas de cada mes', data: r.meses.map(m => m.ventas), backgroundColor: css('--s1'), borderRadius: 4 },
      { label: 'Mismo mes del año anterior', data: r.meses.map(m => m.ventasAnt), backgroundColor: css('--texto-3') || '#bbb', borderRadius: 4 }];
    grafica('gComp', { type: 'bar', data: { labels: r.meses.map(m => m.etiqueta), datasets: ds },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: x => x.dataset.label + ': ' + $$(x.raw), footer: it => { const m = r.meses[it[0].dataIndex], d = delta(m.ventas, m.ventasAnt); return d === null ? 'nuevo' : (d > 0 ? '▲ ' : '▼ ') + Math.abs(d) + '% contra el año anterior'; } } } },
        scales: { y: { ticks: { callback: tickMoneda } }, x: { grid: { display: false } } } } });
  }
  /** Ventana con todos los productos: este periodo contra el mismo periodo del año anterior. */
  function compProductos() {
    const r = S.comp; if (!r) return;
    S.fComp = S.fComp || { q: '', filtro: 'todos', orden: 'actual' };
    const yA = r.periodo.actual.hasta.slice(-4), yB = r.periodo.anterior.hasta.slice(-4);
    modal('📋 Producto por producto · ' + yA + ' vs ' + yB, `<div class="fila" style="margin-bottom:8px">
        <label style="flex:2 1 200px">Buscar<input id="cpQ" value="${esc(S.fComp.q)}" placeholder="Nombre o clave"></label>
        <label>Mostrar<select id="cpF">${opts([['todos', 'Todos'], ['crecen', '▲ Crecen'], ['caen', '▼ Caen'], ['nuevos', '✨ Nuevos (no se vendían)'], ['perdidos', '⚠️ Ya no se venden']], S.fComp.filtro)}</select></label>
        <label>Ordenar por<select id="cpO">${opts([['actual', 'Venta ' + yA], ['anterior', 'Venta ' + yB], ['sube', 'Mayor crecimiento $'], ['baja', 'Mayor caída $'], ['pct', 'Cambio %']], S.fComp.orden)}</select></label>
        <button class="btn fijo" onclick="App.compCsv()">⬇️ Excel (CSV)</button></div><div id="cpRes"></div>`);
    const pinta = () => {
      const f = S.fComp; let l = r.productos.slice();
      if (f.q) l = l.filter(x => coincide(x.id + ' ' + x.nombre, f.q));
      if (f.filtro === 'crecen') l = l.filter(x => x.impA > x.impB && x.impB > 0); if (f.filtro === 'caen') l = l.filter(x => x.impA < x.impB && x.impA > 0);
      if (f.filtro === 'nuevos') l = l.filter(x => x.impA > 0 && !(x.impB > 0)); if (f.filtro === 'perdidos') l = l.filter(x => x.impB > 0 && !(x.impA > 0));
      const ord = { actual: (a, b) => b.impA - a.impA, anterior: (a, b) => b.impB - a.impB, sube: (a, b) => (b.impA - b.impB) - (a.impA - a.impB), baja: (a, b) => (a.impA - a.impB) - (b.impA - b.impB), pct: (a, b) => (delta(b.impA, b.impB) || 9e9) - (delta(a.impA, a.impB) || 9e9) };
      l.sort(ord[f.orden]);
      const tA = l.reduce((t, x) => t + x.impA, 0), tB = l.reduce((t, x) => t + x.impB, 0);
      $('#cpRes').innerHTML = `<p class="muted peq" style="margin:0 0 6px">${nf(l.length)} productos · ${yA}: <b>${$$(tA)}</b> · ${yB}: <b>${$$(tB)}</b> ${chipDelta(tA, tB)}</p>
        <div class="tabla-cont" style="max-height:60vh"><table class="cmp-tabla"><thead><tr><th>Producto</th><th class="num">Piezas ${yA}</th><th class="num">Piezas ${yB}</th><th class="num">Venta ${yA}</th><th class="num">Venta ${yB}</th><th class="num">Diferencia</th><th class="num">Cambio</th>${r.verUtil ? `<th class="num">Utilidad ${yA}</th><th class="num">Utilidad ${yB}</th>` : ''}</tr></thead>
        <tbody>${l.slice(0, 600).map(x => `<tr><td class="cmp-prod">${esc(x.nombre)}<small class="muted"> · ${esc(x.id)}${x.rA ? ' · #' + x.rA : ''}</small></td><td class="num">${nf(x.cantA)}</td><td class="num muted">${nf(x.cantB)}</td>
          <td class="num"><b>${$$(x.impA)}</b></td><td class="num muted">${$$(x.impB)}</td><td class="num ${x.impA - x.impB >= 0 ? 'ok-txt' : 'error'}">${(x.impA - x.impB >= 0 ? '+' : '') + $$(x.impA - x.impB)}</td><td class="num">${chipDelta(x.impA, x.impB)}</td>
          ${r.verUtil ? `<td class="num">${$$(x.utilA || 0)}</td><td class="num muted">${$$(x.utilB || 0)}</td>` : ''}</tr>`).join('')}</tbody></table></div>${l.length > 600 ? '<p class="muted peq">Se muestran 600; usa el buscador o descarga el CSV para verlos todos.</p>' : ''}`;
    };
    $('#cpQ').oninput = e => { S.fComp.q = e.target.value; pinta(); };
    $('#cpF').onchange = e => { S.fComp.filtro = e.target.value; pinta(); };
    $('#cpO').onchange = e => { S.fComp.orden = e.target.value; pinta(); };
    pinta();
  }
  function compCsv() {
    const r = S.comp; if (!r) return;
    const yA = r.periodo.actual.hasta.slice(-4), yB = r.periodo.anterior.hasta.slice(-4), q = v => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
    const cab = ['Clave', 'Producto', 'Piezas ' + yA, 'Piezas ' + yB, 'Venta ' + yA, 'Venta ' + yB, 'Diferencia', 'Cambio %'].concat(r.verUtil ? ['Utilidad ' + yA, 'Utilidad ' + yB] : []);
    const filas = r.productos.map(x => [x.id, x.nombre, x.cantA, x.cantB, x.impA, x.impB, Math.round((x.impA - x.impB) * 100) / 100, delta(x.impA, x.impB) === null ? 'nuevo' : delta(x.impA, x.impB)].concat(r.verUtil ? [x.utilA, x.utilB] : []));
    const csv = '﻿' + [cab].concat(filas).map(f => f.map(q).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'Comparativo productos ' + r.periodo.actual.desde.replace(/\//g, '-') + ' al ' + r.periodo.actual.hasta.replace(/\//g, '-') + ' vs ' + yB + '.csv'; a.click();
  }

  /* ---------- Estado de resultados (solo el dueño) ---------- */
  /** Inicio (dueño): de las ventas a la UTILIDAD NETA del periodo, paso por paso. */
  function htmlUtilNeta(R) {
    if (R.utilidadDespuesDepr === undefined && R.depreciacion) {   // servidor anterior: la depreciación venía restada; se regresa
      R = Object.assign({}, R, { utilidadOperacion: R.utilidadOperacion + R.depreciacion, utilidadNeta: R.utilidadNeta + R.depreciacion, utilidadDespuesDepr: R.utilidadNeta }); }
    const pct = v => R.ventas ? (v / R.ventas * 100).toFixed(1) + '%' : '—';
    const paso = (t, v, cls, menos) => `<div class="un-paso ${cls || ''}"><small>${menos ? '− ' : ''}${t}</small><b>${menos ? $$(Math.abs(v)) : $$(v)}</b>${!menos ? `<span>${pct(v)} de ventas</span>` : ''}</div>`;
    const neta = R.utilidadNeta, est = neta < 0 ? 'mal' : (R.ventas && neta / R.ventas < 0.05 ? 'av' : 'ok');
    return `<div class="tarjeta un-card"><div class="un-cab"><div><h3 style="margin:0">💰 Utilidad neta del periodo</h3>
        <p class="muted" style="margin:4px 0 0">Lo que realmente le queda a la empresa: ventas − costo de lo vendido − mermas − gastos de operación − gastos financieros. Sin IVA. La depreciación va aparte.</p></div>
        <div class="un-total ${est}"><small>Utilidad neta</small><b>${$$(neta)}</b><span>Margen neto ${pct(neta)}</span></div></div>
      <div class="un-flujo">
        ${paso('Ventas netas', R.ventas)}${paso('Costo de lo vendido', R.costo, 'resta', 1)}${paso('Utilidad bruta', R.utilidadBruta, 'sub')}
        ${paso('Mermas', R.mermas, 'resta', 1)}${paso('Gastos de operación', R.gastosOperacion, 'resta', 1)}
        ${paso('Utilidad de operación', R.utilidadOperacion, 'sub')}${paso('Gastos financieros', R.financieros, 'resta', 1)}${paso('Utilidad neta', neta, 'fin ' + est)}
      </div></div>` + htmlDepreciacion(R);
  }
  /** Depreciación de inversiones: cuadro aparte (informativo), con la explicación del cálculo. No se resta de la utilidad neta. */
  function htmlDepreciacion(R) {
    if (!R.depreciacion) return '';
    const pct = v => R.ventas ? (v / R.ventas * 100).toFixed(1) + '%' : '—', l = R.deprActivos || [];
    return `<div class="tarjeta dep-card"><div class="un-cab"><div><h3 style="margin:0">🏗️ Depreciación de inversiones (informativa)</h3>
        <p class="muted" style="margin:4px 0 0">No se resta de tu utilidad neta: no es dinero que salga en este periodo, es el desgaste contable de lo que ya compraste (equipo, vehículos, mobiliario…).</p></div>
        <div class="un-total"><small>Depreciación del periodo</small><b>${$$(R.depreciacion)}</b><span>${pct(R.depreciacion)} de ventas · ${nf(R.deprNumActivos || l.length)} inversiones</span></div></div>
      <div class="dep-como"><b>¿Cómo se calcula?</b> En <b>línea recta</b>: por cada factura del grupo <b>Inversión</b>, su monto sin IVA × la tasa anual de depreciación ÷ 12 = lo que se deprecia cada mes.
        Empieza el mes siguiente a la compra y sigue hasta depreciar el 100 % (por ejemplo, al 25 % anual dura 4 años). Del periodo se cuentan solo los meses ya transcurridos.
        Las inversiones de "Prorrateo" se reparten según el % de ventas de la sucursal. La tasa de cada categoría se ajusta en Configuración › Grupos de gasto. Es un cálculo gerencial; los topes fiscales los aplica tu contador.</div>
      ${l.length ? `<div class="tabla-cont" style="margin-top:10px">${tabla([{ t: 'Inversión', h: x => `<b>${esc(x.cat || 'Inversión')}</b><br><small class="muted">${esc(x.emisor || '')} · ${esc(x.fecha)}</small>` },
        { t: 'Monto', num: 1, h: x => $$(x.monto) }, { t: 'Tasa anual', num: 1, h: x => (x.tasa || 0) + '%' }, { t: 'Por mes', num: 1, cls: 'ocultar-movil', h: x => $$(x.mensual) }, { t: 'En el periodo', num: 1, h: x => `<b>${$$(x.periodo)}</b>` }], l.slice(0, 8))}</div>` : ''}
      <p class="muted" style="margin:8px 0 0">Si la restaras, la utilidad quedaría en <b>${$$(R.utilidadDespuesDepr !== undefined ? R.utilidadDespuesDepr : R.utilidadNeta - R.depreciacion)}</b> (utilidad contable después de depreciación).</p></div>`;
  }
  function htmlResultados(R) {
    if (R.utilidadDespuesDepr === undefined && R.depreciacion) R = Object.assign({}, R, { utilidadOperacion: R.utilidadOperacion + R.depreciacion, utilidadNeta: R.utilidadNeta + R.depreciacion, utilidadDespuesDepr: R.utilidadNeta });
    if (R.error) return `<div class="tarjeta"><h3>🔒 Estado de resultados</h3><p class="error">No se pudieron leer los egresos: ${esc(R.error)}</p></div>`;
    S.resultados = R;
    const pct = v => R.ventas ? (v / R.ventas * 100).toFixed(1) + '%' : '—';
    const fila = (t, v, o) => `<tr class="${o && o.total ? 'res-total' : ''}"><td>${o && o.sangria ? '<span style="padding-left:16px"></span>' : ''}${t}</td><td class="num ${!(o && o.menos) && v < 0 ? 'error' : ''}">${o && o.menos ? '−' + $$(Math.abs(v)) : $$(v)}</td><td class="num muted">${pct(v)}</td></tr>`;
    const grupos = ['Operación', 'Financiero', 'Inversión', 'Excluir'];
    const nombresG = { 'Operación': 'Gastos de operación', 'Financiero': 'Gastos financieros', 'Inversión': 'Inversión (no se resta del mes)', 'Excluir': 'Excluidos (personal)' };
    const cats = R.porCategoria;
    S.listaGastos = cats;
    return `<div class="rejilla-2">
      <div class="tarjeta"><h3>🔒 Estado de resultados</h3>${R.prorrateo !== null ? `<p class="muted">Gastos asignados a esta sucursal; las facturas marcadas "Prorrateo" se reparten según su % de ventas (${R.prorrateo}% en el periodo).</p>` : ''}
        <div class="tabla-cont"><table class="estado-res"><tbody>
        ${fila('Ventas netas', R.ventas)}
        ${fila('Costo real de lo vendido', R.costo, { menos: 1, sangria: 1 })}
        ${fila('<b>Utilidad bruta</b>', R.utilidadBruta, { total: 1 })}
        ${fila('Mermas', R.mermas, { menos: 1, sangria: 1 })}
        ${fila('Gastos de operación', R.gastosOperacion, { menos: 1, sangria: 1 })}
        ${fila('<b>Utilidad de operación</b>', R.utilidadOperacion, { total: 1 })}
        ${fila('Gastos financieros', R.financieros, { menos: 1, sangria: 1 })}
        ${fila('<b>Utilidad neta</b>', R.utilidadNeta, { total: 1 })}
        ${R.depreciacion ? fila('Aparte: depreciación de inversiones (estimada, no se resta)', R.depreciacion, { sangria: 1 }) : ''}
        </tbody></table></div>
        <p class="muted" style="margin-top:8px">Aparte: inversión ${$$(R.inversion)} · excluidos ${$$(R.excluidos)}. Montos sin IVA.</p>
        <h4 style="margin-top:12px">IVA del periodo (estimado)</h4>
        <div class="tabla-cont"><table><tbody><tr><td>IVA de tus ventas (trasladado)</td><td class="num">${$$(R.ivaTrasladado)}</td></tr>
        <tr><td>IVA de tus gastos (acreditable)</td><td class="num">−${$$(R.ivaAcreditable)}</td></tr>
        <tr class="res-total"><td><b>${R.ivaEstimado >= 0 ? 'IVA estimado a pagar' : 'IVA a favor estimado'}</b></td><td class="num"><b>${$$(Math.abs(R.ivaEstimado))}</b></td></tr></tbody></table></div>
        <p class="muted" style="margin-top:6px;font-size:12px">Estimado gerencial; lo deducible y el IVA a declarar los confirma tu contador.</p></div>
      <div class="tarjeta"><h3>🔒 Gastos de operación por categoría</h3><div class="grafica"><canvas id="gGastos"></canvas></div></div></div>
      <div class="tarjeta"><h3>🔒 Gastos por categoría</h3>
        ${!cats.length ? '<div class="vacio">Sin facturas de egresos en el periodo</div>' : grupos.filter(g => cats.some(x => x.grupo === g)).map(g => {
          const ls = cats.filter(x => x.grupo === g), tot = ls.reduce((t, x) => t + x.monto, 0);
          return `<h4 style="margin:10px 0 6px">${nombresG[g]} · ${$$(tot)}</h4>` + tabla([{ t: 'Categoría', h: x => `<b>${esc(x.cat)}</b>` }, { t: 'Facturas', num: 1, h: x => nf(x.n) },
            { t: 'Monto sin IVA', num: 1, h: x => $$(x.monto) }, { t: 'IVA', num: 1, cls: 'ocultar-movil', h: x => $$(x.iva) }, { t: '% de ventas', num: 1, h: x => pct(x.monto) }],
            ls, { clic: 'App.verGastosCat' }).replace(/App\.verGastosCat\((\d+)\)/g, (m0, i) => 'App.verGastosCat(' + cats.indexOf(ls[+i]) + ')');
        }).join('')}
        <p class="muted" style="margin-top:8px">Toca una categoría para ver sus facturas. Los grupos se ajustan en Configuración › Grupos de gasto.</p></div>`;
  }
  async function verGastosCat(i) {
    const x = S.listaGastos[i];
    let l; try { l = await pedir('gastosDetalle', { desde: $('#dDesde').value, hasta: $('#dHasta').value, categoria: x.cat, grupo: x.grupo }); } catch (e) { return; }
    const t = l.reduce((a, f) => a + f.monto, 0);
    modal(x.cat + ' · ' + x.grupo, `<p>${nf(l.length)} facturas · ${$$(t)} sin IVA</p>` + tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Emisor', h: f => `<b>${esc(f.emisor)}</b><br><small class="muted">${esc(f.rfc)}</small>` },
      { t: 'Sin IVA', num: 1, h: f => $$(f.monto) }, { t: 'IVA', num: 1, h: f => $$(f.iva) }, { t: 'Total', num: 1, h: f => $$(f.total) }, { t: 'Pago', k: 'metodo', cls: 'ocultar-movil' }], l));
  }
  const tablaCaducidad = l => tabla([{ t: 'Producto', k: 'nombre' }, { t: 'Sucursal', h: x => esc(sucNom(x.suc)) }, { t: 'Lote', k: 'lote' }, { t: 'Caducidad', k: 'cad' },
    { t: 'Días', num: 1, h: x => `<span class="etq ${x.dias < 0 ? 'mal' : x.dias <= 60 ? 'av' : ''}">${x.dias}</span>` }, { t: 'Existencia', num: 1, h: x => nf(x.cant) }], l, { vacio: 'Nada por aquí 👍' });

  /* ---------- NUEVA VENTA ---------- */
  function ventaNueva() {
    return { suc: sucTrabajo(), cli: null, lista: 'Publico', dias: 0, metodo: 'PUE', descPC: 0, flete: 0, comentarios: '',
      estatus: 'Pendiente', idFlete: ENVIO_DEFAULT, guia: '',
      lineas: [], cobro: { monto: '', forma: '1', banco: 'EFECTI10' } };
  }
  const guardarBorrador = () => LS.set('borrador_venta', S.venta);
  const WA_BASE = 'https:' + '\/\/wa.me/'; // sin doble diagonal literal: HtmlService la toma como comentario
  const ENVIO_DEFAULT = '12whb32'; // "Entrega física" en Catalogo_Paqueteria
  const ESTATUS_ETQ = { Entregado: ['ok', 'Entregado'], Pendiente: ['av', 'Pendiente de entrega'], Cancelado: ['mal', 'Cancelado'], Devuelto: ['mal', 'Devuelto'] };
  const etqEstatus = e => { const x = ESTATUS_ETQ[e] || ['', e || '—']; return `<span class="etq ${x[0]}">${esc(x[1])}</span>`; };

  V.venta = () => {
    if (!S.venta || (D().permitidas || []).indexOf(S.venta.suc) < 0) S.venta = ventaNueva();
    const v = S.venta, u = U(), c = v.cli ? cliente(v.cli) : null;
    const cat = D().catalogos || {};
    v.estatus = v.estatus || 'Pendiente'; v.idFlete = v.idFlete || ENVIO_DEFAULT; v.guia = v.guia || '';
    const paqs = cat.paqueterias && cat.paqueterias.length ? cat.paqueterias : [{ id: ENVIO_DEFAULT, nombre: 'Entrega física' }];
    const ed = !!v.editId, vse = (D().config || {}).ventaSinExist || {};
    $('#vista').innerHTML = `
      ${vse.vigente ? `<div class="filtro-activo">⚠️ Venta sin existencia permitida${vse.hasta ? ' hasta el ' + esc(fechaCorta(vse.hasta)) : ''}: si el sistema no tiene piezas, la nota se guarda y la existencia queda en negativo para cuadrarla en el inventario físico.</div>` : ''}
      ${ed ? `<div class="tarjeta" style="border-color:var(--aviso);background:var(--aviso-suave)"><div class="fila"><div style="flex:3 1 260px">✏️ <b>Editando la nota ${esc(v.editFolio)}</b><br><small class="muted">Al guardar se reemplazan sus productos y condiciones; se conservan folio, fecha y cobros. Si estaba entregada, el inventario se ajusta solo.</small></div>
        <button class="btn fijo" onclick="App.limpiarVenta()">Salir sin guardar</button></div></div>` : ''}
      ${v.desdeCot && !ed ? `<div class="tarjeta" style="border-color:var(--s1)"><div class="fila"><div style="flex:3 1 260px">📝 <b>Venta desde la cotización ${esc(v.desdeCot.folio)}</b><br><small class="muted">Al guardar, la cotización queda como vendida y ligada a esta nota. Revisa existencias y lotes.</small></div>
        <button class="btn fijo" onclick="App.quitarCotVenta()">Quitar liga</button></div></div>` : ''}
      <div class="tarjeta"><div class="fila">
        <div class="fijo folio" id="vFolio">${ed ? `<span class="folio-et">Nota de Venta · editando</span><b>${esc(v.editFolio)}</b><small>${esc(sucNom(v.suc))}</small>` : ''}</div>
        ${u.todasSucursales && !ed ? `<label class="fijo" style="min-width:180px">Sucursal<select id="vSuc">${optsSuc(v.suc)}</select></label>` : ''}
        <label style="flex:3 1 280px">Cliente<div class="buscador"><input id="vCli" placeholder="Buscar por nombre, razón social, RFC o teléfono…" value="${c ? esc(c.razon || c.nombre) : ''}" autocomplete="off"></div></label>
        ${puede('clientes_editar') ? '<button class="btn fijo" onclick="App.formCliente(null,\'venta\')">+ Cliente</button>' : ''}
      </div>
      <div id="vCliInfo" class="muted" style="margin-top:8px">${c ? `Lista <b>${esc(v.lista)}</b> · Crédito ${c.credito} días · ${esc(c.rfc || 'Sin RFC')} · ${esc(c.localidad || c.municipio || '')} ${c.status === 'Inactivo' ? '<span class="etq mal">Inactivo</span>' : ''}` : 'Selecciona un cliente para aplicar su lista de precios.'}</div></div>
      <div class="tarjeta"><div class="buscador buscador-prod"><input id="vProd" enterkeyhint="search" placeholder="🔍 Agregar producto: clave, nombre, laboratorio o categoría…" autocomplete="off"></div>
        <div class="espacio"></div>
        <div class="doc-lineas" id="vLineas"></div></div>
      <div class="rejilla-2" style="margin-top:14px">
        <div class="tarjeta"><h3>Condiciones, entrega y cobro</h3><div class="rejilla">
          <label>Estatus de la nota<select id="vEstatus">${opts([['Pendiente', 'Pendiente de entrega (no descuenta)'], ['Entregado', 'Entregado (descuenta inventario)']], v.estatus)}</select></label>
          <label>Envío / flete<select id="vEnvio">${opts(paqs, v.idFlete)}</select></label>
          <label>No. de guía<input id="vGuia" value="${esc(v.guia)}" placeholder="Solo si se envía por paquetería"></label>
          <label>Días de crédito<input type="number" id="vDias" value="${v.dias}" ${puede('precio_editar') ? '' : 'readonly'}></label>
          <label>Método de pago<select id="vMetodo">${opts(cat.metodosPago || [], v.metodo)}</select></label>
          <label>Desc. pronto pago %<input type="number" id="vPC" value="${v.descPC}" ${puede('precio_editar') ? '' : 'readonly'}></label>
          <label>Flete $<input type="number" id="vFlete" value="${v.flete}"></label>
          ${ed ? '' : `<label>Cobrar ahora $<input type="number" id="vCobro" value="${esc(v.cobro.monto)}" placeholder="0.00"></label>
          <label>Forma de pago<select id="vForma">${opts(cat.formasPago || [], v.cobro.forma)}</select></label>
          <label>Cuenta / caja<select id="vBanco">${opts(cat.bancos || [], v.cobro.banco)}</select></label>`}
          <label style="grid-column:1/-1">Comentarios<input id="vCom" value="${esc(v.comentarios)}"></label>
        </div></div>
        <div class="tarjeta"><h3>Totales</h3><div class="totales" id="vTot"></div>
          <div class="acciones"><button class="btn peligro" onclick="App.limpiarVenta()">${ed ? 'Salir sin guardar' : 'Descartar'}</button>
          <button class="btn primario" id="vGuardar" onclick="App.guardarVenta()">${ed ? '💾 Guardar cambios' : '💾 Guardar venta'}</button></div></div>
      </div>`;
    if ($('#vSuc')) $('#vSuc').onchange = e => { v.suc = e.target.value; v.lineas.forEach(l => l.lote = ''); guardarBorrador(); V.venta(); };
    buscador($('#vCli'), { fuente: fuenteClientes, nuevo: puede('clientes_editar') ? q => formCliente(null, 'venta', q) : null, alElegir: x => elegirClienteVenta(x.id) });
    buscador($('#vProd'), { fuente: q => fuenteProductos(v.suc, v.lista, true)(q), limpiar: true, alElegir: x => agregarLineaVenta(x.id) });
    const bind = (id, k, num, sub) => { if (!$(id)) return; $(id).oninput = e => { if (sub) v.cobro[k] = e.target.value; else v[k] = num ? Number(e.target.value) || 0 : e.target.value; guardarBorrador(); totalesVenta(); }; $(id).onchange = $(id).oninput; };
    bind('#vEstatus', 'estatus'); bind('#vEnvio', 'idFlete'); bind('#vGuia', 'guia');
    bind('#vDias', 'dias', 1); bind('#vMetodo', 'metodo'); bind('#vPC', 'descPC', 1); bind('#vFlete', 'flete', 1);
    bind('#vCobro', 'monto', 0, 1); bind('#vForma', 'forma', 0, 1); bind('#vBanco', 'banco', 0, 1); bind('#vCom', 'comentarios');
    if (!ed) mostrarFolio('vFolio', v.suc, 'Nota de Venta');
    pintarLineasVenta();
  };
  function elegirClienteVenta(id) {
    const v = S.venta, c = cliente(id);
    v.cli = id; v.lista = c.lista && D().catalogos.listas.indexOf(c.lista) >= 0 ? c.lista : 'Publico';
    v.dias = c.credito || 0; v.metodo = v.dias > 0 ? 'PPD' : 'PUE';
    v.lineas.forEach(l => { const p = prod(l.id); if (p) l.precio = p.precios[v.lista] || 0; });
    guardarBorrador(); V.venta();
  }
  function agregarLineaVenta(id) {
    const v = S.venta, p = prod(id);
    const ya = v.lineas.find(l => l.id === id && !l.lote);
    if (ya) ya.cant = Number(ya.cant) + 1;
    else v.lineas.push({ id: id, cant: 1, precio: p.precios[v.lista] || 0, desc: 0, lote: '' });
    if (existencia(id, v.suc) <= 0) toast('⚠️ ' + p.nombre + ' no tiene existencia en esta sucursal', true);
    guardarBorrador(); pintarLineasVenta();
    setTimeout(() => { const ins = document.querySelectorAll('#vLineas [data-f=cant]'); if (ins.length) ins[ins.length - 1].focus(); }, 30);
  }
  /* Precio editado: muestra el de lista como referencia; 🎁 = sin cargo ($0.01) */
  const refPrecio = (lp, precio) => { lp = Number(lp) || 0; precio = Number(precio) || 0;
    if (Math.abs(lp - precio) < 0.005) return '';
    return precio <= 0.01 ? `<small class="ref-precio regalo">🎁 Sin cargo · lista ${$$(lp)}</small>` : `<small class="ref-precio ${precio < lp ? 'baja' : 'sube'}">Lista ${$$(lp)}${lp ? ' · ' + (precio < lp ? '−' : '+') + Math.abs(Math.round((precio - lp) / lp * 1000) / 10) + '%' : ''}</small>`; };
  function pintarLineasVenta() {
    const v = S.venta, editarPrecio = puede('precio_editar');
    const cont = $('#vLineas');
    cont.innerHTML = !v.lineas.length ? '<div class="vacio">Agrega productos con el buscador</div>' :
      `<div class="linea cab"><div>Producto</div><div>Lote</div><div>Cant.</div><div>Precio</div><div>Desc %</div><div class="num">Importe</div><div></div></div>` +
      v.lineas.map((l, i) => {
        const p = prod(l.id) || { nombre: l.id, precios: {} };
        const ls = lotes(l.id, v.suc);
        if (l.lote && !ls.some(x => x.k === l.lote)) ls.unshift({ k: l.lote, l: 'Lote actual ' + l.lote.replace(l.id + '-' + sucNom(v.suc) + '-', '').replace(/-([^-]*)$/, ' · $1'), c: 'de esta nota', q: '' });
        return `<div class="linea" data-i="${i}">
          <div class="nom"><b>${esc(p.nombre)}</b><small>${esc(l.id)} · Exist. ${nf(existencia(l.id, v.suc))}${p.iva ? ' · IVA <span data-iva></span>' : ''}</small></div>
          <div>${p.usaLote === false && !ls.length ? '<small class="muted">Sin lote</small>' : `<select data-f="lote"><option value="">Auto (caduca primero)</option>${ls.map(x => `<option value="${esc(x.k)}" ${x.k === l.lote ? 'selected' : ''}>${esc(x.l)} · ${esc(x.c)}${x.q !== '' ? ' · ' + nf(x.q) : ''}</option>`).join('')}</select>`}</div>
          <div><input type="number" data-f="cant" min="0" step="any" value="${l.cant}" inputmode="decimal"></div>
          <div><input type="number" data-f="precio" step="0.01" value="${l.precio}" ${editarPrecio ? '' : 'readonly'} inputmode="decimal"><span data-ref>${refPrecio(p.precios[v.lista], l.precio)}</span></div>
          <div><input type="number" data-f="desc" step="0.01" value="${l.desc}" ${editarPrecio ? '' : 'readonly'} inputmode="decimal"></div>
          <div class="num" data-imp></div>
          <div class="lin-btns">${editarPrecio ? '<button class="icono" data-regalo title="Sin cargo ($0.01)">🎁</button>' : ''}<button class="icono" data-del title="Quitar">✕</button></div></div>`;
      }).join('');
    cont.oninput = e => {
      const f = e.target.dataset.f, row = e.target.closest('[data-i]'); if (!f || !row) return;
      const l = v.lineas[+row.dataset.i]; l[f] = f === 'lote' ? e.target.value : Number(e.target.value) || 0;
      if (f === 'precio') { const p = prod(l.id) || { precios: {} }; row.querySelector('[data-ref]').innerHTML = refPrecio(p.precios[v.lista], l.precio); }
      guardarBorrador(); totalesVenta();
    };
    cont.onchange = cont.oninput;
    cont.onclick = e => { const row = e.target.closest('[data-i]'); if (!row) return;
      if (e.target.closest('[data-del]')) { v.lineas.splice(+row.dataset.i, 1); guardarBorrador(); pintarLineasVenta(); }
      else if (e.target.closest('[data-regalo]')) { const l = v.lineas[+row.dataset.i]; l.precio = 0.01; l.desc = 0; guardarBorrador(); pintarLineasVenta(); } };
    totalesVenta();
  }
  function calcVenta(v) {
    const pc = Math.min(100, Math.max(0, Number(v.descPC) || 0)) / 100;
    let sub = 0, desc = 0, iva = 0;
    const brutos = [], descs = [], ivas = [];
    const imps = v.lineas.map(l => {
      const p = prod(l.id) || {};
      const s = r2(l.cant * l.precio), d = r2(s * (Number(l.desc) || 0) / 100), i = r2((s - d) * (1 - pc) * (p.iva || 0));
      brutos.push(s); descs.push(d); ivas.push(i);
      sub += s; desc += d; iva += i; return r2(s - d + i);
    });
    const descPC = r2((sub - desc) * pc);
    return { imps: imps, brutos: brutos, descs: descs, ivas: ivas, sub: r2(sub), desc: r2(desc), descPC: descPC, iva: r2(iva), flete: r2(v.flete), total: r2(sub - desc - descPC + iva + (Number(v.flete) || 0)) };
  }
  function totalesVenta() {
    const v = S.venta, t = calcVenta(v);
    document.querySelectorAll('#vLineas .linea[data-i]').forEach(r => { const i = +r.dataset.i, sp = r.querySelector('[data-iva]');
      r.querySelector('[data-imp]').textContent = $$(t.imps[i]); if (sp) sp.textContent = $$(t.ivas[i]); });
    $('#vTot').innerHTML = `<div><span>Subtotal</span><span>${$$(t.sub)}</span></div>
      ${t.desc ? `<div><span>Descuentos</span><span>−${$$(t.desc)}</span></div>` : ''}${t.descPC ? `<div><span>Pronto pago</span><span>−${$$(t.descPC)}</span></div>` : ''}
      <div><span>IVA</span><span>${$$(t.iva)}</span></div>${t.flete ? `<div><span>Flete</span><span>${$$(t.flete)}</span></div>` : ''}
      <div class="gran"><span>Total</span><span>${$$(t.total)}</span></div>
      <div class="muted"><span>Saldo a crédito</span><span>${$$(Math.max(0, t.total - (Number(v.cobro.monto) || 0)))}</span></div>`;
  }
  function limpiarVenta() {
    if (S.venta.editId) { if (!confirm('¿Salir de la edición sin guardar? La nota queda como estaba.')) return; }
    else if (S.venta.lineas.length && !confirm('¿Descartar la venta en captura?')) return;
    S.venta = ventaNueva(); guardarBorrador(); V.venta();
  }
  function editarNota(id) {
    const d = S.ultimaVenta;
    if (!d || d.id !== id) return;
    if (S.venta && S.venta.lineas.length && S.venta.editId !== id && !confirm('Tienes una venta en captura que se va a descartar. ¿Continuar?')) return;
    const listas = (D().catalogos || {}).listas || [];
    S.venta = { editId: d.id, editFolio: d.folio, suc: d.sucursal.id, cli: d.idCliente, lista: listas.indexOf(d.lista) >= 0 ? d.lista : 'Publico',
      dias: d.dias, metodo: d.metodo || 'PUE', descPC: d.descPCPct || 0, flete: d.flete || 0, comentarios: d.comentarios || '',
      estatus: d.estatus === 'Pendiente' ? 'Pendiente' : 'Entregado', idFlete: d.idFlete || ENVIO_DEFAULT, guia: d.guia || '',
      cobro: { monto: '', forma: '1', banco: 'EFECTI10' },
      lineas: d.lineas.filter(l => l.cant > 0).map(l => ({ id: l.prod, cant: l.cant, precio: l.precio, desc: r2(l.descPct * 100), lote: l.k || '' })) };
    guardarBorrador(); cerrarModal(); ir('venta');
  }

  async function guardarVenta() {
    const v = S.venta;
    if (!v.cli) return toast('Selecciona un cliente', true);
    if (!v.lineas.length) return toast('Agrega productos', true);
    if (v.lineas.some(l => !(l.cant > 0))) return toast('Revisa las cantidades', true);
    const t = calcVenta(v);
    const cobro = Math.min(Number(v.cobro.monto) || 0, t.total);
    const params = {
      ID_Venta: uid(), ID_Sucursal: v.suc, ID_Cliente: v.cli, Lista_de_Precios: v.lista, Dias_de_credito: v.dias,
      Metodo_de_pago: v.metodo, descPC: v.descPC, Costo_Flete: v.flete, Comentarios: v.comentarios, fecha: hoyISO(), ID_Cotizacion: v.desdeCot ? v.desdeCot.id : '',
      Estatus: v.estatus || 'Pendiente', ID_Flete: v.idFlete || ENVIO_DEFAULT, No_Guia: v.guia || '',
      ID_Visita: (v.ligar && v.ligar.visita) || '', ID_Receta: (v.ligar && v.ligar.receta) || '',
      lineas: v.lineas.map(l => ({ ID_Producto: l.id, Cantidad: l.cant, Precio: l.precio, Desc_pct: l.desc, lote: l.lote })),
      pago: cobro > 0 ? { monto: cobro, forma: v.cobro.forma, banco: v.cobro.banco } : null
    };
    $('#vGuardar').disabled = true;
    if (v.editId) {
      const rep = v.lineas.filter((l, i) => v.lineas.findIndex(x => x.id === l.id && (x.lote || '') === (l.lote || '')) !== i);
      if (rep.length && !confirm('Hay productos repetidos en la nota (' + rep.map(l => (prod(l.id) || {}).nombre || l.id).join(', ') + '). ¿Guardar así?')) { $('#vGuardar').disabled = false; return; }
      params.ID_Venta = v.editId; delete params.pago;
      try {
        const r = await pedir('editarVenta', params);
        (r.avisos || []).forEach(a => toast(a, true));
        toast('✔ Nota ' + r.folio + ' actualizada. Total ' + $$(r.total) + ' · saldo ' + $$(r.saldo));
        S.venta = ventaNueva(); guardarBorrador(); refrescarStock(); V.venta(); verVenta(r.ID_Venta);
      } catch (e) { if (e.red) toast('Editar una nota requiere conexión', true); if ($('#vGuardar')) $('#vGuardar').disabled = false; }
      return;
    }
    try {
      const r = await pedir('guardarVenta', params, true);
      S.venta = ventaNueva(); guardarBorrador();
      (r.avisos || []).forEach(a => toast(a, true));
      toast('✔ Venta ' + r.folio + (r.estatus === 'Pendiente' ? ' guardada como Pendiente de entrega (no descontó inventario)' : ' guardada') + (r.cotPendiente && r.cotPendiente.folio ? ' · lo que faltó de la cotización pasó a la ' + r.cotPendiente.folio : ''));
      refrescarStock();
      V.venta(); verVenta(r.ID_Venta, true);
    } catch (e) {
      if (e.red) {
        encolar('guardarVenta', params, 'Venta a ' + ((cliente(v.cli) || {}).razon || '') + ' por ' + $$(t.total));
        if (v.estatus === 'Entregado') descontarStockLocal(v);
        const nota = notaOffline(v, t, params);
        S.venta = ventaNueva(); guardarBorrador();
        toast('📴 Sin conexión: venta guardada en el dispositivo. Se enviará al reconectar.');
        V.venta(); modal('Venta pendiente de sincronizar', nota);
      } else { toast(e.message, true); $('#vGuardar').disabled = false; }
    }
  }
  function descontarStockLocal(v) {
    v.lineas.forEach(l => {
      let resta = Number(l.cant);
      const ls = l.lote ? (D().stock || []).filter(s => s.k === l.lote && s.s === v.suc) : lotes(l.id, v.suc);
      ls.forEach(s => { if (resta <= 0) return; const u = l.lote ? resta : Math.min(s.q, resta); s.q = r2(s.q - u); resta = r2(resta - u); });
    });
    LS.set('datos', S.datos);
  }
  function notaOffline(v, t, params) {
    const c = cliente(v.cli) || {};
    const conRfc = c.rfc && !/^X[AE]XX010101000$/i.test(c.rfc);
    const d = { folio: 'PENDIENTE', fecha: new Date().toLocaleDateString('es-MX'), cliente: c.nombre, razon: c.razon, rfc: c.rfc, cel: c.cel,
      fiscal: { cp: c.cp || '', regimen: conRfc ? c.regimen || '' : '', uso: conRfc ? c.uso || '' : '' },
      domicilio: [c.calle, c.colonia, c.municipio, c.estado].filter(Boolean).join(', '), lista: v.lista, dias: v.dias, metodo: v.metodo,
      sub: t.sub, desc: t.desc, descPC: t.descPC, iva: t.iva, flete: t.flete, total: t.total, cobrado: params.pago ? params.pago.monto : 0,
      saldo: t.total - (params.pago ? params.pago.monto : 0), estatus: params.Estatus, sucursal: { id: v.suc, nombre: sucNom(v.suc) }, vendedor: U().nombre,
      envio: ((D().catalogos.paqueterias || []).find(x => x.id === params.ID_Flete) || { nombre: 'Entrega física' }).nombre, guia: params.No_Guia,
      lineas: v.lineas.map((l, i) => ({ nombre: (prod(l.id) || {}).nombre, prod: l.id, cant: l.cant, precio: l.precio, sub: t.brutos[i], desc: t.descs[i], iva: t.ivas[i], total: t.imps[i], lote: l.lote ? 'Elegido' : 'Auto', cad: '' })),
      cobros: [] };
    S.notaOff = d;
    return htmlNota(d, true);
  }

  /* ---------- NOTA DE VENTA (impresión / WhatsApp) ---------- */
  const pagadaNota = d => !!(d && d.id && d.total > 0.009 && d.cobrado > 0.009 && d.saldo <= 0.009 && d.estatus !== 'Cancelado' && d.estatus !== 'Devuelto');
  /** Serie-folio y UUID (folio fiscal) de las facturas asignadas, debajo de la fecha de la nota. */
  const htmlFacturaNota = d => {
    const fs = d.facturas || [];
    if (!fs.length) return d.anotFactura ? `<div class="fact-enc">Factura: ${esc(d.anotFactura)}</div>` : '';
    return fs.map(f => `<div class="fact-enc"><b>Factura ${esc(f.sf)}</b>${f.uuid ? `<br><span>Folio fiscal: ${esc(f.uuid)}</span>` : ''}</div>`).join('');
  };
  function htmlNota(d, offline) {
    const pagada = pagadaNota(d), viva = d.estatus !== 'Cancelado' && d.estatus !== 'Devuelto';
    const bloq = pagada || (!!d.facturada && viva);   // facturada o pagada: sin quitar productos, editar ni cancelar
    return `<div class="imprimible"><div class="nota">
      <div class="enc"><div><div class="doc-logos">${logoHtml()}${fotoSucDoc(d.sucursal.id || d.suc)}</div><div>${esc(d.sucursal.nombre || '')}</div><small>${esc(d.sucursal.direccion || '')} ${d.sucursal.tel ? '· Tel. ' + esc(d.sucursal.tel) : ''}</small></div>
      <div style="text-align:right"><b>NOTA DE VENTA</b><div style="font-size:18px">${esc(d.folio)}</div><div>${esc(d.fecha)}</div><div>${etqEstatus(d.estatus)}</div>${htmlFacturaNota(d)}</div></div>
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
        <div><b>${esc(d.razon || d.cliente)}</b>${d.razon && d.razon !== d.cliente ? '<br>' + esc(d.cliente) : ''}<br>${d.rfc ? 'RFC ' + esc(d.rfc) : ''} ${esc(d.domicilio || '')}${fiscalHtml(d.fiscal)}</div>
        <div style="text-align:right">Crédito: ${d.dias} días ${d.venc ? '· Vence ' + esc(d.venc) : ''}<br>Vendedor: ${esc(d.vendedor || '')}<br>Envío: ${esc(d.envio || 'Entrega física')}${d.guia ? ' · Guía ' + esc(d.guia) : ''}</div></div>
      ${(() => { const canc = !offline && d.id && !bloq && viva && puede('ventas_cancelar'); return `
      <div class="tabla-cont"><table><thead><tr><th class="num">Cant.</th><th>Producto</th><th>Lote</th><th>Cad.</th><th class="num">Precio</th><th class="num">Importe</th><th class="num">IVA $</th><th class="num">Total</th>${canc ? '<th class="no-imprimir"></th>' : ''}</tr></thead><tbody>
      ${d.lineas.filter(l => l.cant > 0 || !d.id || d.estatus === 'Cancelado').map(l => `<tr><td class="num">${l.cant > 0 ? nf(l.cant) : '<small class="error">cancelado</small>'}</td><td>${esc(l.nombre)}</td><td>${esc(l.lote || (d.estatus === 'Pendiente' ? 'Se asigna al entregar' : ''))}</td><td>${esc(l.cad || '')}</td><td class="num">${$$(l.precio)}</td>${(() => { const im = Math.round(((l.sub !== undefined && l.sub !== null ? l.sub : l.cant * l.precio) - (l.desc || 0)) * 100) / 100, iv = l.iva !== undefined && l.iva !== null ? l.iva : Math.max(0, Math.round(((l.total || 0) - im) * 100) / 100); return `<td class="num">${$$(im)}</td><td class="num">${$$(iv)}</td><td class="num"><b>${$$(l.total !== undefined ? l.total : im + iv)}</b></td>`; })()}${canc ? `<td class="no-imprimir">${l.cant > 0 ? `<button class="btn chico peligro" onclick="App.formCancelarLinea('${d.id}','${esc(l.idDet)}')">Cancelar</button>` : ''}</td>` : ''}</tr>`).join('')}`; })()}
      </tbody></table></div>
      <div class="sellos-zona">${pagada || (d.facturadaTotal && d.estatus !== 'Cancelado' && d.estatus !== 'Devuelto') ? `<div class="sellos">${pagada ? '<span class="sello pagado">PAGADO</span>' : ''}${d.facturadaTotal && d.estatus !== 'Cancelado' && d.estatus !== 'Devuelto' ? '<span class="sello facturado">FACTURADO</span>' : ''}</div>` : ''}
      <div class="totales" style="margin-top:10px"><div><span>Subtotal</span><span>${$$(d.sub)}</span></div>${d.desc ? `<div><span>Descuento</span><span>−${$$(d.desc)}</span></div>` : ''}${d.descPC ? `<div><span>Pronto pago</span><span>−${$$(d.descPC)}</span></div>` : ''}
      <div><span>IVA</span><span>${$$(d.iva)}</span></div>${d.flete ? `<div><span>Flete</span><span>${$$(d.flete)}</span></div>` : ''}<div class="gran"><span>Total</span><span>${$$(d.total)}</span></div>
      <div><span>Pagado</span><span>${$$(d.cobrado)}</span></div><div><b>Saldo</b><b>${$$(d.saldo)}</b></div></div></div>
      ${d.letras ? `<p><small>(${esc(d.letras)})</small></p>` : ''}${d.comentarios ? `<p><small>${esc(d.comentarios)}</small></p>` : ''}${d.motivo ? `<p><small><b>Cancelaciones:</b> ${esc(d.motivo)}</small></p>` : ''}
      ${d.cobros && d.cobros.length ? `<div style="margin-top:14px;break-inside:avoid"><b>Pagos realizados</b>
        <div class="tabla-cont" style="margin-top:6px"><table><thead><tr><th>Fecha</th><th>Forma de pago</th><th>Banco / cuenta</th><th class="num">Importe</th></tr></thead><tbody>
        ${d.cobros.map(c => `<tr><td>${esc(c.fecha)}${c.id && puede('cobranza') && !offline ? ` <a class="no-imprimir" href="#" title="Ver comprobante del pago" onclick="App.verCobro('${c.id}');return false">${c.adj ? '📎' + c.adj : '🧾'}</a>` : ''}</td><td>${esc(c.forma || '')}</td><td>${esc(c.banco || '')}</td><td class="num">${$$(c.monto)}</td></tr>`).join('')}
        <tr><td colspan="3" style="text-align:right"><b>Total pagado</b></td><td class="num"><b>${$$(d.cobros.reduce((t, c) => t + c.monto, 0))}</b></td></tr>
        </tbody></table></div></div>` : ''}
      <p style="margin-top:36px;text-align:center">_______________________________<br><small>Recibí de conformidad</small></p></div></div>
      <div class="acciones no-imprimir">
        ${!offline && d.id ? `<button class="btn primario" onclick="App.pdfNota('${d.id}')">📄 PDF para enviar / imprimir</button>` : '<button class="btn primario" onclick="App.pdfNotaOffline()">📄 PDF para enviar</button><button class="btn" onclick="App.imprimir()">🖨️ Imprimir</button>'}
        ${d.cel ? `<a class="btn" target="_blank" href="${WA_BASE}52${String(d.cel).replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent('Interés Veterinario — Nota ' + d.folio + '\nTotal: ' + $$(d.total) + '\nSaldo: ' + $$(d.saldo) + '\n¡Gracias por su compra!')}">💬 WhatsApp</a>` : ''}
        ${!offline && d.id && viva && !bloq && d.saldo > 0.009 && puede('ventas_editar') ? `<button class="btn" onclick="App.editarNota('${d.id}')">✏️ Editar nota</button>` : ''}
        ${!offline && d.id && d.estatus === 'Pendiente' && puede('ventas') ? `<button class="btn primario" onclick="App.entregarVenta('${d.id}')">📦 Marcar como entregado</button>` : ''}
        ${!offline && d.id && d.estatus !== 'Cancelado' && puede('ventas') ? `<button class="btn" onclick="App.formEnvio('${d.id}')">🚚 Envío / guía</button>` : ''}
        ${!offline && d.id && d.saldo > 0.009 && d.estatus !== 'Cancelado' && puede('cobranza') ? `<button class="btn" onclick="App.formCobro('${d.id}')">💵 Cobrar</button>` : ''}
        ${!offline && d.id && !bloq && viva && puede('ventas_cancelar') ? `<button class="btn peligro" onclick="App.cancelarVenta('${d.id}')">Cancelar toda la nota</button>` : ''}
        ${!offline && d.id && bloq && viva && puede('devoluciones') ? `<button class="btn peligro" onclick="App.nuevaDevolucion('${d.id}')">↩️ Devolución de la nota completa</button>` : ''}
        ${d.devolucion && puede('devoluciones') ? `<button class="btn" onclick="App.verDev('${esc(d.devolucion.id)}')">↩️ Ver devolución ${esc(d.devolucion.folio)}</button>` : ''}
      </div>${!offline && d.id && d.estatus !== 'Cancelado' && puede('facturacion') ? '<div id="notaFact" class="no-imprimir fact-bloque"><span class="muted">Cargando facturación…</span></div>' : ''}${!offline && d.id && puede('ventas') ? bloqueArch('ventaGuia', d.id) + (d.estatus === 'Entregado' ? bloqueArch('ventaFirma', d.id) : '') : ''}${bloq ? `<p class="muted no-imprimir" style="text-align:right;margin-top:6px">🔒 Nota ${[d.facturada ? 'facturada' : '', pagada ? 'pagada al 100 %' : ''].filter(Boolean).join(' y ')}: ya no se pueden quitar productos, editarla ni cancelarla.${puede('devoluciones') ? ' Si el cliente regresa la mercancía, usa “Devolución de la nota completa”' + (d.facturada ? ' con el acuse de cancelación o la nota de crédito.' : '.') : ''}</p>` : ''}`;
  }
  /* ---------- PDF: se genera en el servidor, se guarda en Drive y se abre para compartir ---------- */
  async function generarPdf(accion, params, info) {
    if (DOC_LOCAL[accion] && (navigator.onLine === false || S.online === false)) return pdfSinConexion(accion, params, info);
    let w = null;
    // En la app instalada (iPhone / iPad / Mac) una ventana abierta así puede quedarse encima de la app sin botón para regresar:
    // ahí no se abre nada solo; el PDF se abre con el botón "Abrir PDF" (con "Listo" para volver).
    const instalada = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!instalada) try { w = window.open('', '_blank'); if (w) w.document.write('<p style="font-family:-apple-system,sans-serif;padding:24px;font-size:18px">Generando PDF…</p>'); } catch (e) { w = null; }
    try {
      const r = await pedir(accion, params);
      if (w && !w.closed) { try { w.location.href = r.url; } catch (e) {} }
      const msg = info.texto + '\n' + r.url;
      S.pdfListo = { titulo: r.nombre, texto: info.texto, url: r.url };
      const tel = String(info.cel || '').replace(/\D/g, '').slice(-10);
      modal('PDF listo', `<p>📄 <b>${esc(r.nombre)}</b></p>
        <p class="muted">Quedó guardado en tu Drive, carpeta “Interés Veterinario - PDF”. Ábrelo y usa el botón <b>Compartir</b> de tu iPhone, iPad o Mac para mandar el archivo por WhatsApp o correo, o envía directamente el enlace:</p>
        <div class="acciones" style="justify-content:flex-start">
          <a class="btn primario" href="${esc(r.url)}" target="_blank" rel="noopener">📄 Abrir PDF</a>
          <a class="btn" href="${esc(r.descarga)}" target="_blank">⬇️ Descargar</a>
          ${navigator.share ? `<button class="btn" onclick="App.compartirPdf()">📤 Compartir</button>` : ''}
          <a class="btn" target="_blank" href="${WA_BASE}${tel ? '52' + tel : ''}?text=${encodeURIComponent(msg)}">💬 WhatsApp</a>
          <a class="btn" target="_blank" href="mailto:${encodeURIComponent(info.correo || '')}?subject=${encodeURIComponent(info.asunto)}&body=${encodeURIComponent(msg)}">✉️ Correo${info.correo ? ' a ' + esc(info.correo) : ''}</a>
          <button class="btn" onclick="${info.volver}">Volver</button></div>`);
    } catch (e) { if (w) { try { w.close(); } catch (x) {} } if (e.red && DOC_LOCAL[accion]) pdfSinConexion(accion, params, info); }
  }
  /** Hoja de compartir del iPhone / iPad / Mac con el enlace del PDF (WhatsApp, Mensajes, correo…). */
  function compartirPdf() { const p = S.pdfListo; if (!p || !navigator.share) return; navigator.share({ title: p.titulo, text: p.texto, url: p.url }).catch(() => {}); }
  function pdfNota(id) {
    const d = S.ultimaVenta || {};
    generarPdf('pdfNota', { ID_Venta: id }, { cel: d.cel, asunto: 'Nota de venta ' + (d.folio || ''),
      texto: 'Interés Veterinario — Nota de venta ' + (d.folio || '') + '\nTotal: ' + $$(d.total) + ' · Saldo: ' + $$(d.saldo), volver: `App.verVentaId('${id}')` });
  }
  function pdfCobro(id) {
    const d = S.ultimoCobro || {};
    generarPdf('pdfCobro', { ID_Cobranza: id }, { cel: d.cel, asunto: 'Comprobante de pago ' + (d.folio || ''),
      texto: 'Interés Veterinario — Comprobante de pago ' + (d.folio || '') + '\nImporte: ' + $$(d.monto) + ' a la nota ' + (d.folioNota || '') + ' · Saldo: ' + $$(Math.max(0, d.saldoDespues || 0)), volver: `App.verCobro('${id}')` });
  }

  /* ---------- COMPROBANTE DE PAGO ---------- */
  function htmlComprobante(d) {
    return `<div class="imprimible"><div class="nota">
      <div class="enc"><div><div class="doc-logos">${logoHtml()}${fotoSucDoc(d.sucursal.id || d.suc)}</div><div>${esc(d.sucursal.nombre || '')}</div><small>${esc(d.sucursal.direccion || '')} ${d.sucursal.tel ? '· Tel. ' + esc(d.sucursal.tel) : ''}</small></div>
      <div style="text-align:right"><b>COMPROBANTE DE PAGO</b><div style="font-size:18px">${esc(d.folio)}</div><div>${esc(d.fecha)}</div></div></div>
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px">
        <div><small style="color:#666">Recibimos de</small><br><b style="font-size:16px">${esc(d.razon || d.cliente)}</b>${d.razon && d.razon !== d.cliente ? '<br>' + esc(d.cliente) : ''}${d.rfc ? '<br>RFC ' + esc(d.rfc) : ''}${fiscalHtml(d.fiscal)}</div>
        <div style="text-align:right"><small style="color:#666">La cantidad de</small><br><b style="font-size:24px;color:#1f6f4a">${$$(d.monto)}</b></div></div>
      <p><small>(${esc(d.letras)})</small></p>
      <div class="tabla-cont"><table><thead><tr><th>Concepto</th><th>Forma de pago</th><th>Banco / cuenta</th><th class="num">Importe</th></tr></thead><tbody>
        <tr><td>Pago ${d.totalPagos > 1 ? d.numPago + ' de ' + d.totalPagos + ' ' : ''}a la nota de venta <b>${esc(d.folioNota)}</b>${d.fechaNota ? ' del ' + esc(d.fechaNota) : ''}${d.nota ? '<br><small>' + esc(d.nota) + '</small>' : ''}</td>
        <td>${esc(d.forma)}</td><td>${esc(d.banco)}</td><td class="num"><b>${$$(d.monto)}</b></td></tr></tbody></table></div>
      <div class="totales" style="margin-top:12px"><div><span>Total de la nota</span><span>${$$(d.totalNota)}</span></div><div><span>Pagos anteriores</span><span>${$$(d.anteriores)}</span></div>
        <div><span>Saldo anterior</span><span>${$$(d.saldoAntes)}</span></div><div><span>Este pago</span><span>−${$$(d.monto)}</span></div>
        <div class="gran"><span>Saldo pendiente</span><span>${$$(Math.max(0, d.saldoDespues))}</span></div></div>
      ${d.saldoDespues <= 0.009 ? '<p style="text-align:center;color:#1f6f4a;font-weight:700;margin-top:10px">NOTA LIQUIDADA</p>' : ''}
      <p style="margin-top:40px;text-align:center">_______________________________<br><small>Recibió${d.vendedor ? ': ' + esc(d.vendedor) : ''}</small></p></div></div>
      ${htmlAdjCobro(d)}
      <div class="acciones no-imprimir">
        <button class="btn primario" onclick="App.pdfCobro('${d.id}')">📄 PDF para enviar / imprimir</button>
        ${d.idVenta && puede('ventas') ? `<button class="btn" onclick="App.verVentaId('${d.idVenta}')">🧾 Ver nota ${esc(d.folioNota)}</button>` : ''}
        ${d.cel ? `<a class="btn" target="_blank" href="${WA_BASE}52${String(d.cel).replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent('Interés Veterinario — Recibimos su pago de ' + $$(d.monto) + ' a la nota ' + d.folioNota + '. Saldo pendiente: ' + $$(Math.max(0, d.saldoDespues)) + '. ¡Gracias!')}">💬 WhatsApp</a>` : ''}
      </div>`;
  }
  /* ---------- ARCHIVOS DE COMPROBANTE (cobros y pagos a proveedores) ---------- */
  const ADJ = {
    cobro: { ver: 'verAdjuntoCobro', subir: 'subirAdjuntoCobro', quitar: 'quitarAdjuntoCobro', p: (id, f) => ({ ID_Cobranza: id, id: f }), ps: (id, u) => ({ ID_Cobranza: id, dataUri: u }),
      volver: id => verCobro(id), volverTxt: 'Volver al comprobante', lista: () => { if ($('#lCob')) buscarCobros(); } },
    pago: { ver: 'verAdjuntoPago', subir: 'subirAdjuntoPago', quitar: 'quitarAdjuntoPago', p: (id, f) => ({ id: id, archivo: f }), ps: (id, u) => ({ id: id, dataUri: u }),
      volver: id => verPagoProv(id), volverTxt: 'Volver al pago', lista: () => { if ($('#lPP')) buscarPagosProv(); } }
  };
  const icoAdj = t => t === 'pdf' ? '📄' : t === 'foto' ? '🖼️' : t === 'xml' ? '🧾' : '📎';
  /** Casillas: comprobante del pago (foto y PDF, puede tener ambos) y, en notas de crédito, el PDF y el XML de la N/C. */
  const CASILLAS = { foto: { t: '🖼️ Foto del comprobante', acc: 'image/&#42;', btn: '📷 Agregar foto' }, pdf: { t: '📄 PDF del comprobante', acc: 'application/pdf', btn: '📄 Agregar PDF' },
    ncPdf: { t: '📄 PDF de la nota de crédito', acc: 'application/pdf', btn: '📄 Agregar PDF', nc: 1 }, ncXml: { t: '🧾 XML de la nota de crédito', acc: '.xml,text/xml,application/xml', btn: '🧾 Agregar XML', nc: 1 } };
  function htmlAdj(tipo, id, a, esNC) {
    a = a || [];
    const casOf = x => x.casilla || (x.tipo === 'pdf' ? 'pdf' : x.tipo === 'xml' ? 'xml' : 'foto');
    const llaves = esNC ? ['ncPdf', 'ncXml'].concat(a.some(x => casOf(x) === 'foto') ? ['foto'] : [], a.some(x => casOf(x) === 'pdf') ? ['pdf'] : []) : ['foto', 'pdf'];
    const fila = x => `<div class="fact-fila"><span style="flex:1;min-width:0;word-break:break-all">${icoAdj(x.tipo)} ${esc(x.etiqueta || x.nombre)}</span><button class="btn chico" onclick="App.verAdj('${tipo}','${id}','${x.id}')">Ver</button>${U().rol === 'Administrador' ? `<button class="btn chico peligro" title="Quitar este archivo (no se borra)" onclick="App.quitarAdj('${tipo}','${id}','${x.id}')">Quitar</button>` : ''}</div>`;
    const usados = {};
    const bloques = llaves.map(k => {
      const c = CASILLAS[k], l = a.filter(x => casOf(x) === k); l.forEach(x => usados[x.id] = 1);
      return `<div class="adj-casilla"><div class="adj-cas-tit">${c.t}${l.length ? ' <span class="etq ok">✔</span>' : ''}</div>${l.map(fila).join('')}
        ${l.length ? (l.length > 1 ? '<p class="muted" style="margin:4px 0 0;font-size:12px"><b>Hay ' + l.length + ' archivos: revisa si alguno está repetido.</b></p>' : '')
          : `<label class="btn chico" style="margin-top:4px;display:inline-block;cursor:pointer">${c.btn}<input type="file" accept="${c.acc}" style="display:none" onchange="App.subirAdj('${tipo}','${id}', this, '${k}')"></label>`}</div>`;
    }).join('');
    const otros = a.filter(x => !usados[x.id]);
    return `<div class="fact-bloque no-imprimir"><h4>📎 ${esNC ? 'Nota de crédito y comprobantes' : 'Comprobantes del pago'} <span class="muted" style="font-weight:400;font-size:13px">${a.length ? a.length + (a.length === 1 ? ' archivo' : ' archivos') : 'sin archivos'}</span></h4>
      <div class="adj-casillas">${bloques}</div>${otros.length ? `<div style="margin-top:6px"><small class="muted">Otros archivos</small>${otros.map(fila).join('')}</div>` : ''}
      <p class="muted" style="margin:6px 0 0;font-size:12px">🔒 Se acepta un archivo por casilla; si uno está mal, el Administrador lo quita y se sube el correcto.</p></div>`;
  }
  const htmlAdjCobro = d => htmlAdj('cobro', d.id, d.adjuntos);
  function uriABlobUrl(uri) {
    const m = String(uri).match(/^data:([^;]+);base64,(.*)$/); if (!m) return uri;
    const bin = atob(m[2]), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    if (S.blobUrl) { try { URL.revokeObjectURL(S.blobUrl); } catch (e) {} }
    return (S.blobUrl = URL.createObjectURL(new Blob([u8], { type: m[1] })));
  }
  async function verAdj(tipo, id, idF) {
    const c = ADJ[tipo];
    try {
      const r = await pedir(c.ver, c.p(id, idF));
      const volver = `<button class="btn" onclick="App.volverAdj('${tipo}','${id}')">← ${c.volverTxt}</button>`;
      const drive = r.drive ? `<a class="btn" target="_blank" rel="noopener" href="${esc(r.drive)}">Abrir en Drive</a>` : '';
      if (r.tipo === 'xml' && r.texto !== undefined) return modal('🧾 ' + r.nombre, `<pre style="white-space:pre-wrap;word-break:break-all;max-height:65vh;overflow:auto;font-size:11px;background:var(--superficie-2);padding:10px;border-radius:8px">${esc(r.texto)}</pre><div class="acciones">${volver}${drive}</div>`);
      if (r.grande || !r.uri) return modal('📎 ' + r.nombre, `<p class="muted">El archivo es muy grande para mostrarlo aquí.</p><div class="acciones">${volver}${drive}</div>`);
      const url = uriABlobUrl(r.uri);
      const vista = r.tipo === 'pdf' ? `<iframe src="${url}" title="Comprobante" style="width:100%;height:70vh;border:0;border-radius:8px;background:#fff"></iframe>`
        : `<img src="${url}" alt="Comprobante" style="max-width:100%;max-height:75vh;border-radius:8px;display:block;margin:auto">`;
      modal('📎 ' + r.nombre, vista + `<div class="acciones">${volver}<a class="btn" href="${url}" download="${esc(r.nombre)}">⬇️ Descargar</a><a class="btn" target="_blank" rel="noopener" href="${url}">Abrir aparte</a>${drive}</div>`);
    } catch (e) {}
  }
  /** Foto → JPG reducido; PDF → tal cual (máx. 8 MB). */
  async function leerComprobante(f, maxFoto) {
    const esPdf = /pdf$/i.test(f.type || '') || /\.pdf$/i.test(f.name || '');
    if (esPdf) {
      if (f.size > 8 * 1024 * 1024) throw new Error('El PDF es muy grande (máx. 8 MB)');
      return String(await leerArchivo(f)).replace(/^data:[^;]*;/, 'data:application/pdf;');
    }
    if (String(f.type || '').toLowerCase().indexOf('image') !== 0) throw new Error('Solo se aceptan fotos o PDF');
    return reducirImagen(f, maxFoto || 1600);
  }
  /** XML (CFDI) → data URI text/xml (máx. 2 MB). */
  async function leerXml(f) {
    if (!/\.xml$/i.test(f.name || '') && !/xml/i.test(f.type || '')) throw new Error('Elige un archivo XML');
    if (f.size > 2 * 1024 * 1024) throw new Error('El XML es muy grande');
    return String(await leerArchivo(f)).replace(/^data:[^;]*;/, 'data:text/xml;');
  }
  /** Hasta dos comprobantes: una foto y un PDF. */
  async function leerComprobantes(input, maxFoto) {
    const fs = Array.from((input && input.files) || []); if (!fs.length) return [];
    const out = []; let foto = 0, pdf = 0;
    for (const f of fs) {
      const u = await leerComprobante(f, maxFoto), esPdf = /^data:application\/pdf/.test(u);
      if (esPdf ? pdf++ : foto++) throw new Error('Elige como máximo una foto y un PDF');
      out.push(u);
    }
    return out;
  }
  async function subirAdj(tipo, id, input, cas) {
    const c = ADJ[tipo], f = input.files && input.files[0]; if (!f) return;
    const k = CASILLAS[cas] || {};
    let uri;
    try {
      if (cas === 'ncXml') uri = await leerXml(f);
      else { uri = await leerComprobante(f); if ((cas === 'pdf' || cas === 'ncPdf') && !/^data:application\/pdf/.test(uri)) throw new Error('Esta casilla es para el PDF'); if (cas === 'foto' && !/^data:image/.test(uri)) throw new Error('Esta casilla es para la foto'); }
    } catch (e) { input.value = ''; return toast(e.message || 'No se pudo leer el archivo', true); }
    try {
      await pedir(c.subir, Object.assign(c.ps(id, uri), k.nc ? { nc: true } : {}));
      toast('✔ Comprobante agregado'); c.volver(id); c.lista();
    } catch (e) { if (e.red) toast('Sin conexión: vuelve a intentarlo al reconectar', true); }
  }
  async function quitarAdj(tipo, id, idF) {
    const c = ADJ[tipo];
    if (!confirm('¿Quitar este comprobante del pago? El archivo no se borra: se mueve a la carpeta "Comprobantes quitados".')) return;
    try { await pedir(c.quitar, c.p(id, idF)); toast('Comprobante quitado'); c.volver(id); c.lista(); } catch (e) {}
  }
  const verAdjCob = (id, f) => verAdj('cobro', id, f), subirAdjCob = (id, i) => subirAdj('cobro', id, i), quitarAdjCob = (id, f) => quitarAdj('cobro', id, f);
  /* ---------- FOTOS Y DOCUMENTOS: clientes, ventas, compras, vendedores, proveedores ---------- */
  const ARCH_TIT = { cliFoto: '📷 Foto del cliente', cliCsf: '🧾 Constancia de situación fiscal', ventaGuia: '📦 Guía de envío', ocGuia: '📦 Guía de envío', trGuia: '📦 Guía de envío', vendFoto: '📷 Foto del vendedor', provLogo: '🏷️ Logotipo del proveedor',
    visFoto: '📷 Fotos de la visita', recFirma: '✍️ Firma', recPdf: '📄 Receta anterior (AppSheet)', sucFoto: '🏬 Foto de la sucursal',
    ocFactura: '🧾 Factura del proveedor (PDF y XML)', ocNota: '📝 Nota de venta / cotización del proveedor (foto o PDF)', prodFicha: '📑 Ficha técnica (PDF)', ventaFirma: '✍️ Firma de recibido', ocFirma: '✍️ Firma de recepción', trFirma: '✍️ Firma de recibido', devDoc: '🧾 Documento fiscal de cancelación (XML y PDF)' };
  const ARCH_ACEPTA = { devDoc: 'application/pdf,.xml,text/xml,application/xml', ocFactura: 'application/pdf,.xml,text/xml,application/xml', prodFicha: 'application/pdf' };
  const ARCH_BTN = { devDoc: '➕ Agregar XML o PDF', ocFactura: '➕ Adjuntar PDF o XML', prodFicha: '📑 Subir ficha técnica (PDF)' };
  const ARCH_FIRMA = { ventaFirma: 1, ocFirma: 1, trFirma: 1 };
  const ARCH_MULTIFOTO = { visFoto: 1 }, ARCH_SOLOVER = { recFirma: 1, recPdf: 1 };
  const ARCH_FOTO = { cliFoto: 1, vendFoto: 1, provLogo: 1, sucFoto: 1 };
  const ACEPTA_FOTO = 'image/jpeg,image/png,image/heic,image/webp', ACEPTA_DOC = ACEPTA_FOTO + ',application/pdf';
  const bloqueArch = (tipo, id) => `<div class="fact-bloque arch-bloque no-imprimir" data-arch="${tipo}" data-id="${esc(id)}"><h4>${ARCH_TIT[tipo]}</h4><span class="muted">Cargando…</span></div>`;
  function cargarArchs(cont) { (cont || document).querySelectorAll('[data-arch]').forEach(el => cargarArch(el.dataset.arch, el.dataset.id)); }
  const elArch = (tipo, id) => document.querySelector(`[data-arch="${tipo}"][data-id="${CSS.escape(String(id))}"]`);
  async function cargarArch(tipo, id) {
    let el = elArch(tipo, id); if (!el) return;
    let r;
    try { r = await pedir('archivos', { tipo: tipo, id: id }, true); }
    catch (e) { el = elArch(tipo, id); if (el) el.innerHTML = `<h4>${ARCH_TIT[tipo]}</h4><span class="muted">${e.red ? 'Disponible cuando haya conexión' : esc(e.message || 'No disponible')}</span>`; return; }
    el = elArch(tipo, id); if (!el) return;
    const a = r.archivos || [], foto = !!ARCH_FOTO[tipo], act = foto ? a.find(x => x.actual) : null, resto = act ? a.filter(x => x !== act) : a;
    const fila = x => `<div class="fact-fila"><span style="flex:1;min-width:0;word-break:break-all">${icoAdj(x.tipo)} ${esc(x.etiqueta || x.nombre)}${x.actual && tipo === 'prodFicha' ? ' <span class="etq ok">vigente</span>' : ''}</span><button class="btn chico" onclick="App.verArch('${tipo}','${esc(id)}','${x.id}')">Ver</button>${r.quitar ? `<button class="btn chico peligro" title="Quitar (el archivo no se borra)" onclick="App.quitarArch('${tipo}','${esc(id)}','${x.id}')">Quitar</button>` : ''}</div>`;
    const subir = r.puedeSubir && ARCH_FIRMA[tipo] ? (a.length ? '' : `<button class="btn chico arch-subir" onclick="App.firmaArch('${tipo}','${esc(id)}')">✍️ Capturar firma</button>`)
      : r.puedeSubir && ARCH_ACEPTA[tipo] ? `<label class="btn chico arch-subir">${tipo === 'prodFicha' && a.length ? '📑 Subir versión nueva (PDF)' : ARCH_BTN[tipo]}<input type="file" accept="${ARCH_ACEPTA[tipo]}" style="display:none" onchange="App.subirArch('${tipo}','${esc(id)}', this)"></label>`
      : r.puedeSubir ? `<label class="btn chico arch-subir">${foto ? (act ? '📷 Cambiar' : '📷 Agregar') + (tipo === 'provLogo' ? ' logotipo' : ' foto') : ARCH_MULTIFOTO[tipo] ? '📷 Agregar foto' : '➕ Adjuntar imagen o PDF'}<input type="file" accept="${foto || ARCH_MULTIFOTO[tipo] ? ACEPTA_FOTO : ACEPTA_DOC}" style="display:none" onchange="App.subirArch('${tipo}','${esc(id)}', this)"></label>`
      : (r.motivo && !ARCH_SOLOVER[tipo] ? `<p class="muted" style="margin:6px 0 0;font-size:13px">${esc(r.motivo)}</p>` : '');
    el.innerHTML = `<h4>${ARCH_TIT[tipo]} <span class="muted" style="font-weight:400;font-size:13px">${foto ? '' : a.length ? a.length + (a.length === 1 ? ' archivo' : ' archivos') : 'sin archivos'}</span></h4>
      ${foto ? `<div class="arch-foto">${act ? `<img alt="" data-actual="${act.id}" onclick="App.verArch('${tipo}','${esc(id)}','${act.id}')"><span class="muted">Cargando imagen…</span>` : '<span class="muted">Sin imagen</span>'}</div>` : ''}
      ${tipo === 'sucFoto' && act && r.quitar ? `<button class="btn chico peligro" style="margin-top:6px" onclick="App.quitarArch('${tipo}','${esc(id)}','${act.id}')">🗑️ Quitar imagen</button>` : ''}
      ${foto && resto.length ? `<details style="margin-top:6px"><summary class="muted" style="font-size:13px;cursor:pointer">Anteriores (${resto.length})</summary>${resto.map(fila).join('')}</details>` : resto.map(fila).join('')}
      ${!foto && !a.length ? `<p class="muted" style="margin:4px 0 0;font-size:13px">No hay archivos.</p>` : ''}${subir}`;
    if (act) {
      try {
        const v = await pedir('verArchivo', { tipo: tipo, id: id, archivo: act.id, mini: 1 }, true);
        const e2 = elArch(tipo, id), im = e2 && e2.querySelector('img[data-actual]');
        if (im) { if (v.uri) { im.src = v.uri; im.nextElementSibling && im.nextElementSibling.remove(); } else im.nextElementSibling.textContent = 'Imagen muy grande: tócala para abrirla'; }
      } catch (e) { const e2 = elArch(tipo, id), s = e2 && e2.querySelector('.arch-foto .muted'); if (s) s.textContent = 'No se pudo cargar la imagen'; }
    }
  }
  function visor(html) {
    let v = $('#visor');
    if (!v) { v = document.createElement('div'); v.id = 'visor'; v.className = 'visor'; v.onclick = e => { if (e.target === v) cerrarVisor(); }; document.body.appendChild(v); }
    v.innerHTML = `<div class="visor-caja">${html}</div>`; v.classList.remove('oculto');
  }
  // (cerrarVisor está más abajo: cierra este visor de archivos y el de PDF)
  async function verArch(tipo, id, archivo) {
    visor('<p class="muted" style="text-align:center;padding:30px">Cargando…</p>');
    let r; try { r = await pedir('verArchivo', { tipo: tipo, id: id, archivo: archivo }); } catch (e) { return cerrarVisor(); }
    const cerrar = '<button class="btn" onclick="App.cerrarVisor()">✕ Cerrar</button>';
    const drive = r.drive ? `<a class="btn" target="_blank" rel="noopener" href="${esc(r.drive)}">Abrir en Drive</a>` : '';
    if (r.tipo === 'xml' && r.texto !== undefined) return visor(`<h4 style="margin:0 0 8px;word-break:break-all">🧾 ${esc(r.nombre)}</h4><pre style="white-space:pre-wrap;word-break:break-all;max-height:68vh;overflow:auto;font-size:11px;background:var(--superficie-2);padding:10px;border-radius:8px">${esc(r.texto)}</pre><div class="acciones">${cerrar}${drive}</div>`);
    if (r.grande || !r.uri) return visor(`<h4>${esc(r.nombre)}</h4><p class="muted">El archivo es muy grande para mostrarlo aquí.</p><div class="acciones">${cerrar}${drive}</div>`);
    const url = uriABlobUrl(r.uri);
    const vista = r.tipo === 'pdf' ? `<iframe src="${url}" title="Documento" style="width:100%;height:72vh;border:0;border-radius:8px;background:#fff"></iframe>`
      : `<img src="${url}" alt="" style="max-width:100%;max-height:74vh;border-radius:8px;display:block;margin:auto">`;
    visor(`<h4 style="margin:0 0 8px;word-break:break-all">${esc(r.nombre)}</h4>${vista}<div class="acciones">${cerrar}<a class="btn" href="${url}" download="${esc(r.nombre)}">⬇️ Descargar</a><a class="btn" target="_blank" rel="noopener" href="${url}">Abrir aparte</a>${drive}</div>`);
  }
  async function leerArch(tipo, f) {
    if (ARCH_FOTO[tipo] || ARCH_MULTIFOTO[tipo]) return reducirImagen(f, tipo === 'provLogo' ? 600 : tipo === 'sucFoto' ? 800 : 1000, (tipo === 'sucFoto' || tipo === 'provLogo') && /png|webp|gif/i.test(f.type || ''));
    if (tipo === 'ocFactura' && (/\.xml$/i.test(f.name || '') || /xml/i.test(f.type || ''))) return leerXml(f);
    const u = await leerComprobante(f);
    if ((tipo === 'prodFicha' || tipo === 'ocFactura') && !/^data:application\/pdf/.test(u)) throw new Error(tipo === 'prodFicha' ? 'La ficha técnica debe ser PDF' : 'La factura se adjunta en PDF o XML');
    return u;
  }
  function marcarArch(tipo, id) {
    if (S.minis && S.minis[tipo]) delete S.minis[tipo][id];
    if (tipo === 'sucFoto') { const m = LS.get('minisSuc', {}); delete m[id]; LS.set('minisSuc', m); }
    if (tipo === 'prodFicha') { const pr = prod(id); if (pr) { pr.ficha = 1; LS.set('datos', S.datos); } }
    const arr = tipo === 'cliFoto' || tipo === 'cliCsf' ? D().clientes : tipo === 'provLogo' ? D().proveedores : tipo === 'vendFoto' ? D().vendedores : tipo === 'sucFoto' ? D().sucursales : null;
    const x = arr && arr.find(o => String(o.id) === String(id));
    if (x) { x[tipo === 'provLogo' ? 'logo' : tipo === 'cliCsf' ? 'csf' : 'foto'] = 1; LS.set('datos', S.datos); }
  }
  async function subirArch(tipo, id, input) {
    const f = input.files && input.files[0]; if (!f) return;
    let uri; try { uri = await leerArch(tipo, f); } catch (e) { input.value = ''; return toast(e.message || 'No se pudo leer el archivo', true); }
    toast('Subiendo…');
    let mini = ''; if (tipo === 'sucFoto') { try { mini = await logoTransparente(uri, 360); } catch (e) {} }
    try { await pedir('subirArchivo', { tipo: tipo, id: id, dataUri: uri, mini: mini }); toast('✔ Archivo guardado'); marcarArch(tipo, id); cargarArch(tipo, id); if (tipo === 'sucFoto') { pintarMenu(); cargarSucsCfg(); } }
    catch (e) { input.value = ''; if (e.red) toast('Sin conexión: vuelve a intentarlo al reconectar', true); }
  }
  async function quitarArch(tipo, id, archivo) {
    if (!confirm('¿Quitar este archivo? No se borra: se mueve a la carpeta "Archivos quitados".')) return;
    try { await pedir('quitarArchivo', { tipo: tipo, id: id, archivo: archivo }); toast('Archivo quitado'); if (S.minis && S.minis[tipo]) delete S.minis[tipo][id]; if (tipo === 'sucFoto') { const m = LS.get('minisSuc', {}); delete m[id]; LS.set('minisSuc', m); } cargarArch(tipo, id); if (tipo === 'sucFoto') { refrescarDatos(true).then(() => { pintarMenu(); cargarSucsCfg(); }).catch(() => {}); } } catch (e) {}
  }
  /** Para formularios de alta: elige archivo y lo muestra; se sube después de guardar el registro. */
  async function prevArchNuevo(input, tipo) {
    const f = input.files && input.files[0], el = input.closest('.fact-bloque').querySelector('.arch-prev');
    if (!f) { el.innerHTML = ''; return; }
    try { const uri = await leerArch(tipo, f); input._uri = uri; el.innerHTML = /^data:image/.test(uri) ? `<img src="${uri}" alt="">` : `<span>📄 ${esc(f.name)}</span>`; }
    catch (e) { input.value = ''; input._uri = ''; el.innerHTML = ''; toast(e.message || 'No se pudo leer el archivo', true); }
  }
  const bloqueArchNuevo = (tipo, idInput) => `<div class="fact-bloque arch-bloque"><h4>${ARCH_TIT[tipo]}</h4><div class="arch-prev"></div>
    <label class="btn chico arch-subir">${ARCH_FOTO[tipo] ? '📷 Elegir imagen' : '➕ Elegir imagen o PDF'}<input type="file" id="${idInput}" accept="${ARCH_FOTO[tipo] ? ACEPTA_FOTO : ACEPTA_DOC}" style="display:none" onchange="App.prevArchNuevo(this,'${tipo}')"></label>
    <p class="muted" style="margin:6px 0 0;font-size:12px">Se adjunta al guardar.</p></div>`;
  /** Sube los archivos elegidos en un alta. Regresa el texto para el aviso. */
  async function subirArchNuevos(lista, id) {
    let ok = 0, mal = 0;
    for (const [tipo, sel] of lista) {
      const inp = $(sel); if (!inp || !inp._uri) continue;
      try { await pedir('subirArchivo', { tipo: tipo, id: id, dataUri: inp._uri }); marcarArch(tipo, id); ok++; } catch (e) { mal++; }
    }
    return mal ? ' · ' + mal + ' archivo(s) no se pudieron subir: agrégalos al abrir el registro' : ok ? ' · ' + ok + ' archivo(s) adjunto(s)' : '';
  }
  /** Miniaturas redondas en listas (clientes, proveedores, vendedores). */
  const avatar = (tipo, id, tiene, txt) => `<span class="avatar">${tiene ? `<img data-avatar="${tipo}" data-aid="${esc(id)}" alt="">` : ''}<b>${esc(String(txt || '?').trim().charAt(0).toUpperCase())}</b></span>`;
  async function cargarAvatares(cont) {
    if (!cont) return;
    S.minis = S.minis || {};
    const pend = {};
    cont.querySelectorAll('img[data-avatar]').forEach(im => {
      const t = im.dataset.avatar, id = im.dataset.aid, m = S.minis[t] = S.minis[t] || {};
      if (m[id]) { im.src = m[id]; im.parentNode.classList.add('con-foto'); } else if (m[id] === undefined) (pend[t] = pend[t] || []).push(id);
    });
    for (const t of Object.keys(pend)) {
      const ids = Array.from(new Set(pend[t]));
      for (let i = 0; i < ids.length; i += 40) {
        let r; try { r = await pedir('minisArchivo', { tipo: t, ids: ids.slice(i, i + 40) }, true); if (t === 'sucFoto') r = await transparentarMinis(r); } catch (e) { break; }
        Object.assign(S.minis[t], r);
        cont.querySelectorAll(`img[data-avatar="${t}"]`).forEach(im => { const u = S.minis[t][im.dataset.aid]; if (u) { im.src = u; im.parentNode.classList.add('con-foto'); } });
      }
    }
  }

  /* ---------- VENDER SIN EXISTENCIA (temporal, mientras se cuadran inventarios) ---------- */
  const fechaCorta = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : iso; };
  function tarjetaVentaSinExist() {
    const c = (D().config || {}).ventaSinExist || {}, d15 = new Date(Date.now() + 15 * 86400000), def = new Date(d15 - d15.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const neg = {}; (D().stock || []).forEach(x => { if (x.q < -0.0001) (neg[x.s] = neg[x.s] || []).push(x); });
    const nNeg = Object.keys(neg).reduce((t, k) => t + neg[k].length, 0);
    return `<div class="tarjeta" style="${c.vigente ? 'border-color:var(--aviso)' : ''}"><h3>📦 Vender aunque el sistema no tenga existencia</h3>
      <p class="muted">Úsalo mientras haces los inventarios físicos. Solo aplica a <b>notas de venta</b> (crear, editar y entregar): si el sistema no tiene piezas, la nota se guarda y la existencia queda en <b>negativo</b>; la app avisa qué productos quedaron así. Traspasos y ajustes siguen validando existencia.</p>
      <div class="fila"><label class="check fijo"><input type="checkbox" id="vseAct" ${c.vigente ? 'checked' : ''}> Permitir</label>
        <label class="fijo">Hasta<input type="date" id="vseHasta" value="${esc(c.vigente && c.hasta ? c.hasta : def)}"></label>
        <button class="btn primario fijo" onclick="App.guardarVentaSinExist()">Guardar</button></div>
      <p class="muted" style="margin-top:6px">${c.vigente ? `Activo${c.hasta ? ' hasta el ' + esc(fechaCorta(c.hasta)) : ''} · lo activó ${esc(c.quien || '')}` : c.activo && c.hasta ? 'Venció el ' + esc(fechaCorta(c.hasta)) + ': las ventas vuelven a validar existencia.' : 'Desactivado: las ventas validan existencia.'}</p>
      ${nNeg ? `<details style="margin-top:8px"><summary><b>${nNeg}</b> lote(s) con existencia negativa (revísalos en el inventario físico)</summary>${Object.keys(neg).map(k => `<p style="margin:8px 0 2px"><b>${esc(sucNom(k))}</b></p>` +
        neg[k].map(x => `<div class="muted" style="font-size:13px">${esc((prod(x.p) || {}).nombre || x.p)} · lote ${esc(x.l)} · <span class="error">${nf(x.q)}</span></div>`).join('')).join('')}</details>` : ''}</div>`;
  }
  async function guardarVentaSinExist() {
    const act = $('#vseAct').checked, hasta = $('#vseHasta').value;
    if (act && hasta && hasta < hoyISO()) return toast('La fecha "hasta" ya pasó', true);
    try { const c = await pedir('guardarVentaSinExist', { activo: act, hasta: hasta }); S.datos.config = Object.assign(D().config || {}, { ventaSinExist: c }); LS.set('datos', S.datos);
      toast(c.vigente ? '✔ Ventas sin existencia permitidas' + (c.hasta ? ' hasta el ' + fechaCorta(c.hasta) : '') : '✔ Las ventas vuelven a validar existencia'); V.config(); } catch (e) {}
  }

  /* ---------- SUCURSALES (foto) ---------- */
  function cargarSucsCfg() {
    const el = $('#cfSucs'); if (!el) return;
    const l = U().rol === 'Administrador' ? (D().sucursales || []) : sucsPermitidas();
    S.sucsCfg = l;
    el.innerHTML = tabla([{ t: 'Sucursal', h: x => `<div class="con-avatar">${avatarSuc(x.id)}<div><b>${esc(x.nombre)}</b><br><small class="muted">${esc(x.tipo || '')}</small></div></div>` },
      { t: 'Dirección', cls: 'ocultar-movil', h: x => esc(x.direccion) }, { t: 'Teléfono', h: x => esc(x.tel) }], l, { clic: 'App.verSucCfg', vacio: 'Sin sucursales' });
    cargarAvatares(el).then(() => { if (U().rol === 'Administrador') repararMinisSuc(l); });
  }
  /** Al abrir la app (administrador): revisa qué sucursales con foto aún no tienen miniatura y la crea. */
  async function revisarMinisSuc() {
    if (U().rol !== 'Administrador' || navigator.onLine === false) return;
    const l = (D().sucursales || []).filter(x => x.foto); if (!l.length) return;
    try {
      const r = await pedir('minisArchivo', { tipo: 'sucFoto', ids: l.map(x => x.id) }, true);
      S.minis = S.minis || {}; const m = S.minis.sucFoto = S.minis.sucFoto || {};
      Object.keys(r).forEach(k => { if (r[k]) m[k] = r[k]; else delete m[k]; }); guardarMinisSuc(m);
      await repararMinisSuc(l);
    } catch (e) {}
  }
  /** Fotos de sucursal subidas antes de las miniaturas: se crea su miniatura una sola vez (solo el administrador). */
  async function repararMinisSuc(l) {
    if (S.reparandoMinis || navigator.onLine === false) return;
    S.minis = S.minis || {}; const m = S.minis.sucFoto = S.minis.sucFoto || {};
    // también las que el servidor tiene en JPEG (con fondo blanco): se rehacen sin fondo una sola vez
    let srv = {}; try { srv = await pedir('minisArchivo', { tipo: 'sucFoto', ids: l.filter(x => x.foto).map(x => x.id) }, true); } catch (e) {}
    const hechas = LS.get('minisSucPng', {}), pend = l.filter(x => x.foto && (!srv[x.id] || (/^data:image\/jpeg/.test(srv[x.id]) && !hechas[x.id])));
    if (!pend.length) return;
    S.reparandoMinis = true;
    try {
      for (const x of pend) {
        try {
          const r = await pedir('archivos', { tipo: 'sucFoto', id: x.id }, true), act = (r.archivos || []).find(a => a.actual);
          if (!act) continue;
          const v = await pedir('verArchivo', { tipo: 'sucFoto', id: x.id, archivo: act.id }, true);
          if (!v.uri) continue;
          const mini = await logoTransparente(v.uri, 360);
          await pedir('subirArchivo', { tipo: 'sucFoto', id: x.id, soloMini: 1, mini: mini }, true);
          hechas[x.id] = 1; LS.set('minisSucPng', hechas);
          m[x.id] = mini; S.minis.sucFoto = m; guardarMinisSuc(m);
          document.querySelectorAll(`img[data-avatar="sucFoto"][data-aid="${CSS.escape(x.id)}"]`).forEach(im => { im.src = mini; im.parentNode.classList.add('con-foto'); });
        } catch (e) {}
      }
    } finally { S.reparandoMinis = false; }
  }
  function verSucCfg(i) {
    const x = S.sucsCfg[i]; if (!x) return;
    const dato = (t, v) => v ? `<p style="margin:4px 0"><span class="muted">${t}:</span> ${esc(v)}</p>` : '';
    const fotoBloque = bloqueFotoSuc(x.id);
    modal('🏬 ' + x.nombre, `<div class="arch-par">${fotoBloque}</div>
      <div class="tarjeta" style="margin-top:10px">${dato('Tipo', x.tipo)}${dato('Dirección', x.direccion)}${dato('Teléfono', x.tel)}${dato('Correo', x.email)}${dato('Serie de notas', x.serie)}${dato('Lista de precios', x.lista)}</div>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cerrar</button></div>`);
  }
  /** Imagen de la sucursal: Matriz usa el logotipo general; las demás su foto (con Cambiar / Quitar). */
  function bloqueFotoSuc(id) {
    return esMatriz(id) ? `<div class="fact-bloque arch-bloque"><h4>🏬 Imagen de la sucursal</h4><div class="arch-foto">${window.LOGO ? `<img src="${window.LOGO}" alt="" style="background:#fff">` : '<span class="muted">Sin logotipo</span>'}</div>
      <p class="muted" style="margin:6px 0 0;font-size:13px">Matriz usa el <b>logotipo general</b> de la app (en notas y documentos solo sale una vez). Se cambia en Configuración → Logotipo de la empresa.</p></div>` : bloqueArch('sucFoto', id);
  }
  /* ---------- VENDEDORES (fotos) y LOGOTIPO DE LA EMPRESA ---------- */
  async function cargarVendedores() {
    const el = $('#cfVend'); if (!el) return;
    let l; try { l = await pedir('listarVendedores', {}, true); } catch (e) { el.innerHTML = '<div class="vacio">Requiere conexión</div>'; return; }
    S.vendLista = l;
    el.innerHTML = tabla([{ t: 'Vendedor', h: v => `<div class="con-avatar">${avatar('vendFoto', v.id, v.foto, v.nombre)}<div><b>${esc(v.nombre)}</b>${v.apodo ? ' <small class="muted">(' + esc(v.apodo) + ')</small>' : ''}<br><small class="muted">${esc(v.puesto || v.rol)}</small></div></div>` },
      { t: 'Sucursal', h: v => esc(sucNom(v.suc) || v.suc) }, { t: 'Celular', k: 'cel', cls: 'ocultar-movil' },
      { t: 'Estado', h: v => `<span class="etq ${v.activo ? 'ok' : 'mal'}">${v.activo ? 'Activo' : 'Inactivo'}</span>` },
      { t: '', h: v => `<button class="btn chico" onclick="event.stopPropagation();App.fotoVendedor('${esc(v.id)}')">📷 Foto</button>` }], l);
    cargarAvatares(el);
  }
  function fotoVendedor(id) {
    const v = (S.vendLista || []).find(x => x.id === id) || { nombre: id };
    modal(v.nombre, bloqueArch('vendFoto', id) + `<div class="acciones"><button class="btn" onclick="App.cerrarModal();App.cargarVendedores()">Cerrar</button></div>`);
  }
  function cargarImg(file) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onerror = rej; fr.onload = () => { const im = new Image(); im.onerror = () => rej(new Error('No se pudo leer la imagen')); im.onload = () => res(im); im.src = fr.result; }; fr.readAsDataURL(file); });
  }
  /** PNG (conserva transparencia) con el lado mayor ≤ max y opacidad alfa; lo reduce hasta que pese menos de ~65 KB. */
  function pngDe(im, max, alfa, minimo) {
    let lado = max, uri = '', w = 0, h = 0;
    while (true) {
      const k = Math.min(1, lado / Math.max(im.width, im.height)); w = Math.max(1, Math.round(im.width * k)); h = Math.max(1, Math.round(im.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.globalAlpha = alfa; x.drawImage(im, 0, 0, w, h);
      uri = c.toDataURL('image/png');
      if (uri.length < 90000 || lado <= minimo) break;
      lado = Math.round(lado * 0.85);
    }
    return { uri: uri, w: w, h: h };
  }
  async function prepararLogo(input) {
    const f = input.files && input.files[0]; if (!f) return;
    let im; try { im = await cargarImg(f); } catch (e) { input.value = ''; return toast('No se pudo leer la imagen', true); }
    const logo = pngDe(im, 600, 1, 260), marca = pngDe(im, 700, 0.075, 420);
    S.logoNuevo = { logo: logo.uri, marca: marca.uri, marcaW: marca.w, marcaH: marca.h };
    $('#lgNuevo').innerHTML = `<div><small class="muted">Nuevo</small><div class="logo-caja"><img src="${logo.uri}" alt=""></div></div>
      <div><small class="muted">Así se verá la marca de agua en el PDF</small><div class="logo-hoja"><img src="${marca.uri}" alt=""><span></span><span></span><span></span><span></span><span></span></div></div>`;
    $('#lgAcc').innerHTML = `<button class="btn" onclick="App.cancelarLogo()">Cancelar</button><button class="btn primario" onclick="App.guardarLogo()">✔ Usar este logotipo</button>`;
    input.value = '';
  }
  function cancelarLogo() { S.logoNuevo = null; $('#lgNuevo').innerHTML = ''; $('#lgAcc').innerHTML = ''; }
  async function guardarLogo() {
    const n = S.logoNuevo; if (!n) return;
    if (!confirm('¿Cambiar el logotipo de la empresa? Se usará en la app y en todos los PDF que se generen a partir de ahora. El anterior se guarda en "_versiones anteriores (no usar)".')) return;
    try {
      const r = await pedir('cambiarLogo', n);
      window.LOGO = r.logo || n.logo;
      document.querySelectorAll('#menu .cab img').forEach(i => i.src = window.LOGO);
      S.logoNuevo = null; toast('✔ Logotipo actualizado'); V.config();
    } catch (e) {}
  }

  async function verCobro(id) {
    try { const d = await pedir('detalleCobro', { ID_Cobranza: id }); S.ultimoCobro = d; modal('Comprobante ' + d.folio, htmlComprobante(d)); } catch (e) {}
  }

  async function verVenta(id) {
    try { const d = await pedir('detalleVenta', { ID_Venta: id }); S.ultimaVenta = d; modal('Nota ' + d.folio, htmlNota(d)); if ($('#notaFact')) cargarFactNota(id); } catch (e) {}
  }
  function formCancelarLinea(idVenta, idDet) {
    const d = S.ultimaVenta, l = d && d.lineas.find(x => x.idDet === idDet);
    if (!l) return;
    modal('Cancelar producto de la nota ' + d.folio, `<p><b>${esc(l.nombre)}</b><br><span class="muted">${esc(l.lote || '')} ${esc(l.cad || '')} · en la nota: ${nf(l.cant)}</span></p>
      <p class="muted">${l.movido ? 'Las piezas canceladas regresan al inventario de ' + esc(d.sucursal.nombre) + '.' : 'Este producto aún no se había descontado del inventario.'} El total y el saldo de la nota se recalculan.</p>
      <div class="rejilla"><label>Cantidad a cancelar<input type="number" id="clCant" value="${l.cant}" min="0" max="${l.cant}" step="any"></label>
      <label style="grid-column:1/-1">Motivo *<input id="clMot" list="clMotivos" placeholder="Ej. el cliente cambió de opinión"><datalist id="clMotivos"><option>El cliente cambió de opinión</option><option>Producto equivocado</option><option>Producto dañado</option><option>Sin existencia para surtir</option></datalist></label></div>
      <div class="acciones"><button class="btn" onclick="App.verVentaId('${idVenta}')">Volver</button><button class="btn peligro" onclick="App.cancelarLinea('${idVenta}','${esc(idDet)}')">Cancelar producto</button></div>`);
  }
  async function cancelarLinea(idVenta, idDet) {
    const cant = Number($('#clCant').value), motivo = $('#clMot').value.trim();
    if (!(cant > 0)) return toast('Indica la cantidad', true);
    if (!motivo) return toast('Indica el motivo', true);
    try {
      const r = await pedir('cancelarLineaVenta', { ID_Venta: idVenta, ID_Detalle: idDet, cantidad: cant, motivo: motivo });
      toast('✔ Producto cancelado. Nuevo total ' + $$(r.total) + (r.regresoInventario ? ' · inventario ajustado' : ''));
      (r.avisos || []).forEach(a => toast(a, true));
      refrescarStock(); verVenta(idVenta); if ($('#lVentas')) buscarVentas();
    } catch (e) {}
  }
  async function entregarVenta(id) {
    const d = S.ultimaVenta && S.ultimaVenta.id === id ? S.ultimaVenta : {};
    const f = await capturarFirma({ titulo: 'Entregar nota ' + (d.folio || '') + ' · firma de recibido', verbo: 'recibe', nombreIni: d.recibio || '', nombreObl: false, opcional: true, omitirTxt: 'Entregar sin firma', okTxt: 'Firmar y entregar' });
    if (!f) return;
    if (f.omitida && !confirm('¿Marcar la nota como Entregada sin firma? Se descontarán las piezas del inventario de la sucursal.')) return;
    try { const r = await pedir('entregarVenta', Object.assign({ ID_Venta: id }, f.nombre ? { Recibio: f.nombre } : {}));
      if (f.png) { if (await subirFirma('ventaFirma', id, f)) toast('✔ Firma guardada'); }
      toast('✔ Nota entregada: inventario descontado'); (r.avisos || []).forEach(a => setTimeout(() => toast('⚠️ ' + a, true), 2900)); refrescarStock(); verVenta(id); if ($('#lVentas')) buscarVentas(); } catch (e) {}
  }
  function formEnvio(id) {
    const d = S.ultimaVenta, cat = D().catalogos || {};
    const paqs = cat.paqueterias && cat.paqueterias.length ? cat.paqueterias : [{ id: ENVIO_DEFAULT, nombre: 'Entrega física' }];
    modal('Envío de la nota ' + d.folio, `<div class="rejilla">
      <label>Envío / flete<select id="enPaq">${opts(paqs, d.idFlete || ENVIO_DEFAULT)}</select></label>
      <label>No. de guía<input id="enGuia" value="${esc(d.guia || '')}"></label>
      <label>Costo de flete $<input type="number" id="enCosto" step="0.01" value="${d.flete || 0}" ${pagadaNota(d) ? 'disabled' : ''}></label></div>
      <p class="muted">${pagadaNota(d) ? '🔒 La nota está pagada al 100 %: solo puedes cambiar la paquetería y el número de guía.' : 'Si cambias el costo de flete, el total y el saldo de la nota se recalculan.'}</p>
      <div class="acciones"><button class="btn" onclick="App.verVentaId('${id}')">Volver</button><button class="btn primario" onclick="App.guardarEnvio('${id}')">Guardar</button></div>`);
  }
  async function guardarEnvio(id) {
    try { const r = await pedir('editarEnvioVenta', { ID_Venta: id, ID_Flete: $('#enPaq').value, No_Guia: $('#enGuia').value, Costo_Flete: Number($('#enCosto').value) || 0 });
      toast('✔ Envío actualizado. Total ' + $$(r.total)); verVenta(id); if ($('#lVentas')) buscarVentas(); } catch (e) {}
  }
  async function cancelarVenta(id) {
    const motivo = prompt('Motivo de la cancelación (el producto regresa al inventario):');
    if (!motivo) return;
    try { await pedir('cancelarVenta', { ID_Venta: id, motivo: motivo }); toast('Venta cancelada'); cerrarModal(); refrescarStock(); if ($('#lVentas')) buscarVentas(); } catch (e) {}
  }


  /* ---------- DEVOLUCIONES (nota completa facturada o pagada) ---------- */
  function vistaDevoluciones(barra) {
    S.devSub = S.devSub || 'lista';
    const sb = (id, n) => `<button class="${S.devSub === id ? 'activo' : ''}" onclick="App.subDev('${id}')">${n}</button>`;
    const sub = `<div class="pestanas">${sb('lista', 'Devoluciones registradas')}${sb('nueva', '+ Nueva devolución')}</div>`;
    if (S.devSub === 'nueva') return formDevolucion(barra + sub);
    const h = hoyISO(), f = alDia(S.fdev || (S.fdev = { desde: h.slice(0, 8) + '01', hasta: h, hastaHoy: h, texto: '', sucursal: '' }));
    $('#vista').innerHTML = barra + sub + `<div class="tarjeta no-imprimir"><div class="fila">
      <label>Desde<input type="date" id="dvDesde" value="${f.desde}"></label><label>Hasta<input type="date" id="dvHasta" value="${f.hasta}"></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="dvSuc">${optsSuc(f.sucursal || '', false, 'Todas')}</select></label>` : ''}
      <label>Buscar<input id="dvTxt" placeholder="Folio, nota, cliente, factura o UUID" value="${esc(f.texto)}"></label>
      <button class="btn primario fijo" onclick="App.cargarDev()">Buscar</button></div>
      <p class="muted" style="margin-top:8px">Las notas facturadas o pagadas ya no se cancelan ni se les quitan productos: si el cliente regresa la mercancía se registra aquí la devolución de la nota completa.
      Si la nota está facturada se exige el documento fiscal de cancelación (acuse de cancelación de la factura o nota de crédito).</p></div>
      <div class="espacio"></div><div id="lDev"><div class="vacio">Cargando…</div></div>`;
    $('#dvTxt').onkeydown = e => { if (e.key === 'Enter') cargarDev(); };
    if ($('#dvSuc')) $('#dvSuc').onchange = cargarDev;
    agregarMesAnio('dvDesde', 'dvHasta', cargarDev);
    cargarDev();
  }
  async function cargarDev() {
    S.fdev = marcarHoy({ desde: $('#dvDesde').value, hasta: $('#dvHasta').value, texto: $('#dvTxt').value.trim(), sucursal: $('#dvSuc') ? $('#dvSuc').value : '' });
    let r; try { r = await pedir('listarDevoluciones', S.fdev); } catch (e) { if ($('#lDev')) $('#lDev').innerHTML = '<div class="vacio">Consultar devoluciones requiere conexión.</div>'; return; }
    if (!$('#lDev')) return;
    S.lista = r.devoluciones; const k = r.kpi, ver = k.total !== null;
    $('#lDev').innerHTML = `<div class="kpis"><div class="kpi"><small>Devoluciones</small><b>${nf(k.num)}</b><span>${nf(k.piezas)} piezas regresaron al inventario</span></div>
      ${ver ? `<div class="kpi"><small>Importe devuelto</small><b>${$$(k.total)}</b><span>con IVA</span></div><div class="kpi"><small>Reembolsos</small><b>${$$(k.reembolso)}</b><span>de lo que ya habían pagado</span></div>` : ''}</div>` +
      tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Nota', h: x => esc(x.nota) }, { t: 'Cliente', h: x => esc(x.cliente) },
        { t: 'Factura / documento', cls: 'ocultar-movil', h: x => x.facturas ? `${esc(x.facturas)}<br><small class="muted">${esc(x.docTipo || '')}</small>` : '<small class="muted">Sin factura</small>' },
        { t: 'Piezas', num: 1, h: x => nf(x.piezas) }].concat(ver ? [{ t: 'Total', num: 1, h: x => $$(x.total) }, { t: 'Reembolso', num: 1, cls: 'ocultar-movil', h: x => x.reembolso ? $$(x.reembolso) : '—' }] : [])
        .concat(U().todasSucursales ? [{ t: 'Sucursal', cls: 'ocultar-movil', h: x => esc(sucNom(x.suc)) }] : []), r.devoluciones, { clic: 'App.abrirDev', vacio: 'Sin devoluciones en el periodo' });
  }
  function subDev(id) { S.devSub = id; if (id === 'nueva' && !S.devPrep) S.devNota = ''; V.ventas('dev'); }
  function nuevaDevolucion(idVenta) { cerrarModal(); S.tabVen = 'dev'; S.devSub = 'nueva'; S.devPrep = null; S.devNota = idVenta; if (S.vista === 'ventas') V.ventas('dev'); else ir('ventas', true); }
  function formDevolucion(barra) {
    const P = S.devPrep;
    if (!P) {
      $('#vista').innerHTML = barra + `<div class="tarjeta"><h3 style="margin-top:0">¿Qué nota se devuelve?</h3>
        <div class="fila"><label>Buscar nota<input id="dvBus" placeholder="Folio (ej. No/Rem-0622), cliente o RFC"></label><button class="btn primario fijo" onclick="App.buscarNotaDev()">Buscar</button></div>
        <p class="muted" style="margin-top:6px">Solo aparecen notas facturadas o pagadas. Las demás se cancelan desde la propia nota.</p></div><div class="espacio"></div><div id="dvRes"></div>`;
      $('#dvBus').onkeydown = e => { if (e.key === 'Enter') buscarNotaDev(); };
      if (S.devNota) { const id = S.devNota; S.devNota = ''; elegirNotaDev(id); }
      return;
    }
    const d = P.nota, conPago = d.cobrado > 0.009;
    $('#vista').innerHTML = barra + `<div class="tarjeta">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><h3 style="margin:0">Devolución de la nota ${esc(d.folio)}</h3>
        <span class="muted">${esc(d.fecha)} · ${esc(d.razon || d.cliente)}${d.rfc ? ' · RFC ' + esc(d.rfc) : ''} · ${esc(d.sucursal.nombre || '')}</span></div>
        <div style="text-align:right"><small class="muted">Folio de la devolución</small><div><b>${esc(P.folio)}</b></div></div></div>
      <div style="margin-top:6px">${P.facturada ? '<span class="etq av">Facturada</span> ' : ''}${P.pagada ? '<span class="etq ok">Pagada</span> ' : ''}${P.facturas.map(f => `<small class="muted">Factura <b>${esc(f.sf)}</b>${f.uuid ? ' · ' + esc(f.uuid) : ''}</small>`).join('<br>')}</div>
      <div class="tabla-cont" style="margin-top:10px"><table><thead><tr><th class="num">Cant.</th><th>Producto</th><th>Lote</th><th class="num">Importe</th><th class="num">IVA $</th><th class="num">Total</th></tr></thead><tbody>
      ${d.lineas.filter(l => l.cant > 0).map(l => `<tr><td class="num">${nf(l.cant)}</td><td>${esc(l.nombre)}</td><td>${esc(l.lote || '')}</td><td class="num">${$$(l.sub - (l.desc || 0))}</td><td class="num">${$$(l.iva)}</td><td class="num"><b>${$$(l.total)}</b></td></tr>`).join('')}
      </tbody></table></div>
      <div class="totales" style="margin-top:8px"><div><span>Subtotal</span><span>${$$(d.sub)}</span></div>${d.desc + d.descPC ? `<div><span>Descuentos</span><span>−${$$(d.desc + d.descPC)}</span></div>` : ''}
        <div><span>IVA (suma de los productos)</span><span>${$$(d.iva)}</span></div>${d.flete ? `<div><span>Flete</span><span>${$$(d.flete)}</span></div>` : ''}<div class="gran"><span>Total a devolver</span><span>${$$(d.total)}</span></div>
        <div><span>Pagado por el cliente</span><span>${$$(d.cobrado)}</span></div></div></div>
      ${P.facturada ? `<div class="tarjeta" style="margin-top:12px"><h3 style="margin-top:0">🧾 Documento fiscal de cancelación <span class="error">*</span></h3>
        <p class="muted" style="margin-top:0">La nota está facturada: sube el <b>acuse de cancelación</b> de la factura (SAT) o la <b>nota de crédito</b> (CFDI de egreso). Con el XML se valida solo que corresponda a la factura de esta nota.</p>
        <div class="rejilla"><label>XML del documento<input type="file" id="dvXml" accept=".xml,text/xml,application/xml"></label><label>PDF del documento<input type="file" id="dvPdf" accept="application/pdf"></label></div>
        <div class="rejilla" style="margin-top:6px"><label>Tipo de documento<select id="dvTipo">${opts(Object.keys(P.tiposDoc).map(k => [k, P.tiposDoc[k]]), '', 'Elige (si no subes el XML)')}</select></label>
          <label>Folio fiscal (UUID)<input id="dvUuid" placeholder="Si solo subes el PDF" autocapitalize="characters"></label><label>Serie-folio del documento<input id="dvDocFolio" placeholder="Opcional (ej. NC-15)"></label></div></div>` : ''}
      <div class="tarjeta" style="margin-top:12px"><div class="rejilla">
        <label>Motivo de la devolución <span class="error">*</span><textarea id="dvMotivo" rows="2" placeholder="Ej. producto dañado, error de pedido…"></textarea></label>
        ${conPago ? `<label>¿Cómo se regresan los ${$$(d.cobrado)} pagados? <span class="error">*</span><select id="dvReemb">${opts(P.reembolsos.map(x => [x, x]), '', 'Elige')}</select></label>` : ''}
        <label>Comentarios<textarea id="dvCom" rows="2"></textarea></label></div>
        <p class="muted">Al registrarla: la nota queda <b>Devuelto</b> (sale de ventas, utilidades y cobranza)${d.lineas.some(l => l.movido && l.cant > 0) ? ', las piezas regresan al inventario de ' + esc(d.sucursal.nombre || '') : ''}${P.facturada ? ' y, con el acuse, la factura queda marcada como Cancelada' : ''}. No se puede deshacer.</p>
        <div class="acciones"><button class="btn" onclick="App.cancelarCapturaDev()">Elegir otra nota</button><button class="btn primario" id="dvBtn" onclick="App.guardarDev()">↩️ Registrar devolución</button></div></div>`;
  }
  async function buscarNotaDev() {
    const t = $('#dvBus').value.trim(); if (t.length < 2) return toast('Escribe al menos 2 letras del folio o del cliente', true);
    let r; try { r = await pedir('notasDevolucion', { texto: t }); } catch (e) { return; }
    S.devRes = r;
    $('#dvRes').innerHTML = tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Nota', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Cliente', h: x => esc(x.cliente) },
      { t: 'Estado', h: x => (x.facturada ? '<span class="etq av">Facturada</span> ' : '') + (x.pagada ? '<span class="etq ok">Pagada</span>' : '') + (!x.puede ? '<small class="muted">Sin factura ni pago completo: cancélala desde la nota</small>' : '') },
      { t: 'Factura', cls: 'ocultar-movil', h: x => esc(x.facturas || '') }, { t: 'Total', num: 1, h: x => $$(x.total) }], r, { clic: 'App.elegirNotaDevI', vacio: 'No encontré notas con ese texto' });
  }
  async function elegirNotaDev(id) {
    try { S.devPrep = await pedir('prepararDevolucion', { ID_Venta: id }); } catch (e) { return; }
    if (!S.devPrep.facturada && !S.devPrep.pagada) { const d = S.devPrep.nota; S.devPrep = null; toast('La nota ' + d.folio + ' no está facturada ni pagada: cancélala desde la propia nota', true); return; }
    S.devSub = 'nueva'; V.ventas('dev');
  }
  function cancelarCapturaDev() { S.devPrep = null; S.devNota = ''; V.ventas('dev'); }
  async function guardarDev() {
    const P = S.devPrep; if (!P) return;
    const prm = { ID_Venta: P.nota.id, motivo: $('#dvMotivo').value.trim(), comentarios: $('#dvCom').value.trim(), reembolsoForma: $('#dvReemb') ? $('#dvReemb').value : '' };
    if (!prm.motivo) return toast('Escribe el motivo de la devolución', true);
    if ($('#dvReemb') && !prm.reembolsoForma) return toast('Indica cómo se regresa lo que pagó el cliente', true);
    if (P.facturada) {
      const fx = $('#dvXml').files[0], fp = $('#dvPdf').files[0];
      if (!fx && !fp) return toast('Sube el XML o el PDF del acuse de cancelación o de la nota de crédito', true);
      if (fp && fp.size > 8e6) return toast('El PDF es muy grande (máx. 8 MB)', true);
      try { prm.xml = fx ? await leerArchivo(fx, true) : ''; prm.pdf = fp ? await leerArchivo(fp) : ''; } catch (e) { return toast('No se pudo leer el archivo', true); }
      prm.docTipo = $('#dvTipo').value; prm.uuid = $('#dvUuid').value.trim(); prm.docFolio = $('#dvDocFolio').value.trim();
      if (!fx && (!prm.docTipo || !prm.uuid)) return toast('Sin XML, indica el tipo de documento y su folio fiscal (UUID)', true);
    }
    if (!confirm('¿Registrar la devolución completa de la nota ' + P.nota.folio + ' por ' + $$(P.nota.total) + '? No se puede deshacer.')) return;
    const b = $('#dvBtn'); if (b) b.disabled = true;
    try {
      const r = await pedir('guardarDevolucion', prm);
      S.devPrep = null; S.devSub = 'lista'; toast('✔ Devolución ' + r.folio + ' registrada'); refrescarStock();
      V.ventas('dev'); verDev(r.id, r.avisos);
    } catch (e) { if (b) b.disabled = false; }
  }
  async function verDev(id, avisos) {
    let d; try { d = await pedir('detalleDevolucion', { id: id }); } catch (e) { return; }
    S.ultimaDev = d; const ver = d.total !== null;
    modal('Devolución ' + d.folio, `${avisos && avisos.length ? `<div class="aviso-cand">${avisos.map(esc).join('<br>')}</div>` : ''}
      <div class="enc" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><b>${esc(d.cliente || '')}</b>${d.rfc ? '<br>RFC ' + esc(d.rfc) : ''}<br><small class="muted">${esc(d.sucursal.nombre || '')}</small></div>
        <div style="text-align:right"><b>DEVOLUCIÓN ${esc(d.folio)}</b><div>${esc(d.fecha)} ${esc(d.hora || '')}</div><div><a href="#" onclick="App.verVentaId('${esc(d.idVenta)}');return false">Nota ${esc(d.nota)}</a></div></div></div>
      <p style="margin:8px 0"><b>Motivo:</b> ${esc(d.motivo || '')}</p>
      <p class="muted" style="margin:0 0 8px">${d.facturas ? 'Factura ' + esc(d.facturas) + ' · ' : 'Nota sin factura · '}${esc(d.docTipo || 'sin documento fiscal')}${d.docFolio ? ' ' + esc(d.docFolio) : ''}${d.uuid ? '<br>Folio fiscal: ' + esc(d.uuid) : ''}</p>
      <div class="tabla-cont"><table><thead><tr><th class="num">Cant.</th><th>Producto</th><th>Lote</th>${ver ? '<th class="num">Importe</th><th class="num">IVA $</th><th class="num">Total</th>' : ''}</tr></thead><tbody>
      ${d.lineas.map(l => `<tr><td class="num">${nf(l.cant)}</td><td>${esc(l.nombre)}</td><td>${esc(l.lote || '')}</td>${ver ? `<td class="num">${$$(l.sub - (l.desc || 0))}</td><td class="num">${$$(l.iva)}</td><td class="num"><b>${$$(l.total)}</b></td>` : ''}</tr>`).join('')}
      ${ver ? `<tr><td colspan="3" style="text-align:right"><b>Suma de los productos</b></td><td class="num"><b>${$$(d.lineas.reduce((t, l) => t + l.sub - (l.desc || 0), 0))}</b></td><td class="num"><b>${$$(d.lineas.reduce((t, l) => t + (l.iva || 0), 0))}</b></td><td class="num"><b>${$$(d.lineas.reduce((t, l) => t + (l.total || 0), 0))}</b></td></tr>` : ''}
      </tbody></table></div>
      ${ver ? `<div class="totales" style="margin-top:8px"><div><span>Subtotal</span><span>${$$(d.sub)}</span></div>${d.desc ? `<div><span>Descuentos</span><span>−${$$(d.desc)}</span></div>` : ''}<div><span>IVA (suma de los productos)</span><span>${$$(d.iva)}</span></div>
        ${d.flete ? `<div><span>Flete</span><span>${$$(d.flete)}</span></div>` : ''}<div class="gran"><span>Total devuelto</span><span>${$$(d.total)}</span></div>
        ${d.reembolso ? `<div><span>Reembolso</span><span>${$$(d.reembolso)}</span></div><div><small class="muted">${esc(d.reembolsoForma || '')}</small></div>` : ''}</div>` : ''}
      <p class="muted">${nf(d.piezas)} piezas regresaron al inventario · Registró ${esc(d.usuario || '')}${d.comentarios ? '<br>' + esc(d.comentarios) : ''}</p>
      <div class="acciones no-imprimir"><button class="btn primario" onclick="App.pdfDev('${esc(d.id)}')">📄 PDF para enviar / imprimir</button></div>
      ${bloqueArch('devDoc', d.id)}`);
  }
  function pdfDev(id) { const d = S.ultimaDev || {}; generarPdf('pdfDevolucion', { id: id }, { asunto: 'Devolución ' + (d.folio || ''), texto: 'Interés Veterinario — Devolución ' + (d.folio || '') + ' de la nota ' + (d.nota || ''), volver: `App.verDev('${id}')` }); }

  /* ---------- COTIZACIONES ---------- */
  const COT_ETQ = { Abierta: 'av', Vendida: 'ok', Vencida: 'mal', Cancelada: 'mal' };
  const etqCot = e => `<span class="etq ${COT_ETQ[e] || ''}">${esc(e)}</span>`;
  const cotNueva = () => ({ suc: sucTrabajo(), cli: null, lista: 'Publico', obs: '', lineas: [], descPC: 0, flete: 0 });
  const guardarBorradorCot = () => LS.set('borrador_cot', S.cot);
  V.cotizaciones = (tab) => {
    tab = tab || S.tabCot || 'lista'; S.tabCot = tab;
    const tb = (id, n) => `<button class="${tab === id ? 'activo' : ''}" onclick="App.vistaCot('${id}')">${n}</button>`;
    const barra = `<div class="pestanas">${tb('lista', 'Cotizaciones')}${tb('nueva', S.cot && S.cot.editId ? '✏️ Editando ' + esc(S.cot.editFolio) : '+ Nueva cotización')}</div>`;
    if (tab === 'nueva') return editorCot(barra);
    const h = hoyISO();
    if (!S.fcot) S.fcot = { desde: h.slice(0, 8) + '01', hasta: h, hastaHoy: h, estado: '', texto: '' };
    const f = alDia(S.fcot);
    $('#vista').innerHTML = barra + `<div class="tarjeta no-imprimir"><div class="fila">
      <label>Desde<input type="date" id="fDesde" value="${f.desde}"></label><label>Hasta<input type="date" id="fHasta" value="${f.hasta}"></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="fSuc">${optsSuc('', false, 'Todas')}</select></label>` : ''}
      <label>Buscar<input id="fTxt" placeholder="Folio o cliente" value="${esc(f.texto)}"></label>
      <label>Estado<select id="fEstC">${opts([['Abierta', 'Abiertas'], ['Vendida', 'Vendidas'], ['Vencida', 'Vencidas'], ['Cancelada', 'Canceladas']], f.estado, 'Todas')}</select></label>
      <button class="btn primario fijo" onclick="App.cargarCotizaciones()">Buscar</button></div></div><div class="espacio"></div><div id="lCot"><div class="vacio">Cargando…</div></div>`;
    $('#fTxt').onkeydown = e => { if (e.key === 'Enter') cargarCotizaciones(); };
    $('#fEstC').onchange = cargarCotizaciones;
    agregarMesAnio('fDesde', 'fHasta', cargarCotizaciones);
    cargarCotizaciones();
  };
  async function cargarCotizaciones() {
    S.fcot = marcarHoy({ desde: $('#fDesde').value, hasta: $('#fHasta').value, estado: $('#fEstC').value, texto: $('#fTxt').value.trim() });
    const p = Object.assign({ sucursal: $('#fSuc') ? $('#fSuc').value : '' }, S.fcot);
    let r; try { r = await pedir('listarCotizaciones', p); } catch (e) { $('#lCot').innerHTML = '<div class="vacio">Consultar cotizaciones requiere conexión.</div>'; return; }
    if (!$('#lCot')) return;   // ya se cambió de pestaña
    S.lista = r.cotizaciones; const k = r.kpi;
    $('#lCot').innerHTML = `<div class="kpis">
      <div class="kpi"><small>Cotizado</small><b>${$$(k.cotizado)}</b><span>${nf(k.total)} cotizaciones</span></div>
      <div class="kpi"><small>Abiertas</small><b>${nf(k.abiertas)}</b><span>${$$(k.montoAbierto)} por cerrar</span></div>
      <div class="kpi"><small>Vendidas</small><b>${nf(k.vendidas)}</b><span>conversión ${k.conversion}% · ${$$(k.montoVendido)}</span></div>
      <div class="kpi"><small>Vencidas / canceladas</small><b>${nf(k.vencidas)} / ${nf(k.canceladas)}</b><span>vigencia ${r.vigenciaDias} días</span></div></div>` +
      tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Cliente', k: 'cliente' }, { t: 'Sucursal', cls: 'ocultar-movil', h: x => esc(sucNom(x.suc)) },
        { t: 'Total', num: 1, h: x => $$(x.total) }, { t: 'Estado', h: x => etqCot(x.estado) + (x.estado === 'Abierta' ? `<br><small class="muted">vence ${esc(x.vigencia)}</small>` : '') + (x.pendiente ? `<br><small class="muted">pendiente → ${esc(x.pendiente)}</small>` : '') + (x.origen ? `<br><small class="muted">resto de ${esc(x.origen)}</small>` : '') },
        { t: 'Venta', h: x => x.venta ? `<b>${esc(x.venta.folio)}</b>` : '—' }], r.cotizaciones, { clic: 'App.abrirCot', vacio: 'Sin cotizaciones en el periodo' });
  }
  function editorCot(barra) {
    if (!S.cot || (D().permitidas || []).indexOf(S.cot.suc) < 0) S.cot = LS.get('borrador_cot', null) || cotNueva();
    if ((D().permitidas || []).indexOf(S.cot.suc) < 0) S.cot = cotNueva();
    const v = S.cot, c = v.cli ? cliente(v.cli) : null, ed = !!v.editId;
    $('#vista').innerHTML = barra + `
      ${ed ? `<div class="tarjeta" style="border-color:var(--aviso);background:var(--aviso-suave)"><div class="fila"><div style="flex:3 1 260px">✏️ <b>Editando la cotización ${esc(v.editFolio)}</b></div><button class="btn fijo" onclick="App.limpiarCot()">Salir sin guardar</button></div></div>` : ''}
      <div class="tarjeta"><div class="fila">
        <div class="fijo folio" id="cFolio">${ed ? `<span class="folio-et">Cotización · editando</span><b>${esc(v.editFolio)}</b><small>${esc(sucNom(v.suc))}</small>` : ''}</div>
        ${U().todasSucursales && !ed ? `<label class="fijo" style="min-width:180px">Sucursal<select id="cSuc">${optsSuc(v.suc)}</select></label>` : ''}
        <label style="flex:3 1 280px">Cliente<div class="buscador"><input id="cCli" placeholder="Buscar por nombre, razón social, RFC o teléfono…" value="${c ? esc(c.razon || c.nombre) : ''}" autocomplete="off"></div></label>
        ${puede('clientes_editar') ? '<button class="btn fijo" onclick="App.formCliente(null,\'cot\')">+ Cliente</button>' : ''}</div>
        <div class="muted" style="margin-top:8px">${c ? `Lista <b>${esc(v.lista)}</b> · ${esc(c.rfc || 'Sin RFC')} · ${esc(c.localidad || c.municipio || '')}` : 'Selecciona un cliente para aplicar su lista de precios.'}</div></div>
      <div class="tarjeta"><div class="buscador buscador-prod"><input id="cProd" enterkeyhint="search" placeholder="🔍 Agregar producto: clave, nombre, laboratorio o categoría…" autocomplete="off"></div>
        <div class="espacio"></div><div class="doc-lineas" id="cLineas"></div></div>
      <div class="rejilla-2" style="margin-top:14px">
        <div class="tarjeta"><h3>Observaciones</h3><label>Notas para el cliente (salen en el PDF)<input id="cObs" value="${esc(v.obs)}" placeholder="Ej. precios con envío incluido, tiempo de entrega 3 días…"></label></div>
        <div class="tarjeta"><h3>Totales</h3><div class="totales" id="cTot"></div>
          <div class="acciones"><button class="btn peligro" onclick="App.limpiarCot()">${ed ? 'Salir sin guardar' : 'Descartar'}</button>
          <button class="btn primario" id="cGuardar" onclick="App.guardarCot()">${ed ? '💾 Guardar cambios' : '💾 Guardar cotización'}</button></div></div></div>`;
    if ($('#cSuc')) $('#cSuc').onchange = e => { v.suc = e.target.value; v.lineas.forEach(l => l.lote = ''); guardarBorradorCot(); V.cotizaciones('nueva'); };
    buscador($('#cCli'), { fuente: fuenteClientes, nuevo: puede('clientes_editar') ? q => formCliente(null, 'cot', q) : null, alElegir: x => elegirClienteCot(x.id) });
    buscador($('#cProd'), { fuente: q => fuenteProductos(v.suc, v.lista, true)(q), limpiar: true, alElegir: x => agregarLineaCot(x.id) });
    $('#cObs').oninput = e => { v.obs = e.target.value; guardarBorradorCot(); };
    if (!ed) mostrarFolio('cFolio', v.suc, 'Cotizacion');
    pintarLineasCot();
  }
  function elegirClienteCot(id) {
    const v = S.cot, c = cliente(id);
    v.cli = id; v.lista = c.lista && D().catalogos.listas.indexOf(c.lista) >= 0 ? c.lista : 'Publico';
    v.lineas.forEach(l => { const p = prod(l.id); if (p) l.precio = p.precios[v.lista] || 0; });
    guardarBorradorCot(); V.cotizaciones('nueva');
  }
  function agregarLineaCot(id) {
    const v = S.cot, p = prod(id), ya = v.lineas.find(l => l.id === id);
    if (ya) ya.cant = Number(ya.cant) + 1; else v.lineas.push({ id: id, cant: 1, precio: p.precios[v.lista] || 0, desc: 0 });
    guardarBorradorCot(); pintarLineasCot();
    setTimeout(() => { const ins = document.querySelectorAll('#cLineas [data-f=cant]'); if (ins.length) ins[ins.length - 1].focus(); }, 30);
  }
  function pintarLineasCot() {
    const v = S.cot, ep = puede('precio_editar'), cont = $('#cLineas');
    cont.innerHTML = !v.lineas.length ? '<div class="vacio">Agrega productos con el buscador</div>' :
      `<div class="linea cab"><div>Producto</div><div>Lote</div><div>Cant.</div><div>Precio</div><div>Desc %</div><div class="num">Importe</div><div></div></div>` +
      v.lineas.map((l, i) => { const p = prod(l.id) || { nombre: l.id }, ls = lotes(l.id, v.suc), ex = existencia(l.id, v.suc), otras = existOtras(l.id, v.suc);
        if (l.lote && !ls.some(x => x.k === l.lote)) ls.unshift({ k: l.lote, l: (l.loteTxt || 'Lote guardado'), c: l.cadTxt || 'sin existencia hoy', q: '' });
        const selLote = ls.length ? `<select data-f="lote"><option value="">Auto (caduca primero)</option>${ls.map(x => `<option value="${esc(x.k)}" ${x.k === l.lote ? 'selected' : ''}>${esc(x.l)} · ${esc(x.c)}${x.q !== '' ? ' · ' + nf(x.q) + ' disp.' : ''}</option>`).join('')}</select>`
          : `<small class="${ex > 0 ? 'muted' : 'error'}">${ex > 0 ? 'Sin lote' : 'Sin existencia en ' + esc(sucNom(v.suc))}</small>`;
        return `<div class="linea" data-i="${i}"><div class="nom"><b>${esc(p.nombre)}</b><small>${esc(l.id)} · Exist. <span style="font-weight:600" class="${ex < (Number(l.cant) || 0) ? 'error' : ''}">${nf(ex)}</span> en ${esc(sucNom(v.suc))}${porLlegarHtml(l.id, v.suc)}${p.iva ? ' · IVA <span data-iva></span>' : ' · Exento de IVA'}</small>${otras ? `<small class="muted">${esc(otras)}</small>` : ''}</div><div>${selLote}</div>
          <div><input type="number" data-f="cant" min="0" step="any" value="${l.cant}" inputmode="decimal"></div>
          <div><input type="number" data-f="precio" step="0.01" value="${l.precio}" ${ep ? '' : 'readonly'} inputmode="decimal"><span data-ref>${refPrecio((p.precios || {})[v.lista], l.precio)}</span></div>
          <div><input type="number" data-f="desc" step="0.01" value="${l.desc}" ${ep ? '' : 'readonly'} inputmode="decimal"><small class="ref-precio baja" data-dsc></small></div>
          <div class="num" data-imp></div><div class="lin-btns">${ep ? '<button class="icono" data-regalo title="Sin cargo ($0.01)">🎁</button>' : ''}<button class="icono" data-del title="Quitar">✕</button></div></div>`; }).join('');
    cont.oninput = cont.onchange = e => { const f = e.target.dataset.f, row = e.target.closest('[data-i]'); if (!f || !row) return; const l = v.lineas[+row.dataset.i]; l[f] = f === 'lote' ? e.target.value : Number(e.target.value) || 0;
      if (f === 'precio') { const p = prod(l.id) || { precios: {} }; row.querySelector('[data-ref]').innerHTML = refPrecio(p.precios[v.lista], l.precio); }
      guardarBorradorCot(); totalesCot(); };
    cont.onclick = e => { const row = e.target.closest('[data-i]'); if (!row) return;
      if (e.target.closest('[data-del]')) { v.lineas.splice(+row.dataset.i, 1); guardarBorradorCot(); pintarLineasCot(); }
      else if (e.target.closest('[data-regalo]')) { const l = v.lineas[+row.dataset.i]; l.precio = 0.01; l.desc = 0; guardarBorradorCot(); pintarLineasCot(); } };
    if (v.lineas.length) cont.insertAdjacentHTML('beforeend', '<div class="totales tot-lineas" id="cTotLin"></div>');
    totalesCot();
  }
  /* Totales en pesos: Subtotal, Descuento (solo si hay), IVA y Total */
  const totalesHtml = (sub, desc, iva, total) => `<div><span>Subtotal</span><span>${$$(sub)}</span></div>${desc ? `<div><span>Descuento</span><span>−${$$(desc)}</span></div>` : ''}
      <div><span>IVA</span><span>${$$(iva)}</span></div><div class="gran"><span>Total</span><span>${$$(total)}</span></div>`;
  function totalesCot() {
    const t = calcVenta(S.cot);
    document.querySelectorAll('#cLineas .linea[data-i]').forEach(r => { const i = +r.dataset.i, sp = r.querySelector('[data-iva]'), ds = r.querySelector('[data-dsc]');
      r.querySelector('[data-imp]').textContent = $$(t.brutos[i]); if (sp) sp.textContent = $$(t.ivas[i]); if (ds) ds.textContent = t.descs[i] ? '−' + $$(t.descs[i]) : ''; });
    const h = totalesHtml(t.sub, t.desc, t.iva, t.total);
    $('#cTot').innerHTML = `<div class="gran"><span>Total</span><span>${$$(t.total)}</span></div>`; if ($('#cTotLin')) $('#cTotLin').innerHTML = h;
  }
  function limpiarCot() {
    if (S.cot && S.cot.lineas.length && !confirm(S.cot.editId ? '¿Salir sin guardar los cambios?' : '¿Descartar la cotización en captura?')) return;
    const eraEdicion = !!(S.cot && S.cot.editId);
    S.cot = cotNueva(); guardarBorradorCot(); V.cotizaciones(eraEdicion ? 'lista' : 'nueva');
  }
  async function guardarCot() {
    const v = S.cot;
    if (!v.cli) return toast('Selecciona un cliente', true);
    if (!v.lineas.length) return toast('Agrega productos', true);
    if (v.lineas.some(l => !(l.cant > 0))) return toast('Revisa las cantidades', true);
    $('#cGuardar').disabled = true;
    try {
      const r = await pedir('guardarCotizacion', { ID_Cotizacion: v.editId || v.nuevoId || (v.nuevoId = uid()), nueva: !v.editId, ID_Sucursal: v.suc, ID_Cliente: v.cli, Observacion: v.obs,
        lineas: v.lineas.map(l => ({ ID_Producto: l.id, Cantidad: l.cant, Precio: l.precio, Desc_pct: l.desc, lote: l.lote || '' })) });
      toast('✔ Cotización ' + r.folio + ' guardada · ' + $$(r.total));
      S.cot = cotNueva(); guardarBorradorCot(); S.tabCot = 'lista';
      if (S.fcot && S.fcot.hasta && S.fcot.hasta < hoyISO()) { S.fcot.hasta = hoyISO(); S.fcot.hastaHoy = S.fcot.hasta; }   // que la nueva sí aparezca en la lista
      V.cotizaciones('lista'); verCotizacion(r.id);
    } catch (e) {
      if (e.red) return cotOffline(v);
      if ($('#cGuardar')) $('#cGuardar').disabled = false;
    }
  }
  /** Sin señal: la cotización queda en la cola (el folio se asigna al sincronizar) y ya se puede mandar en PDF. */
  function cotOffline(v) {
    const t = calcVenta(v), c = cliente(v.cli) || {}, conRfc = c.rfc && !/^X[AE]XX010101000$/i.test(c.rfc);
    const params = { ID_Cotizacion: v.editId || v.nuevoId || (v.nuevoId = uid()), nueva: !v.editId, ID_Sucursal: v.suc, ID_Cliente: v.cli, Observacion: v.obs,
      lineas: v.lineas.map(l => ({ ID_Producto: l.id, Cantidad: l.cant, Precio: l.precio, Desc_pct: l.desc, lote: l.lote || '' })) };
    encolar('guardarCotizacion', params, 'Cotización a ' + (c.razon || c.nombre || '') + ' por ' + $$(t.total));
    const vig = new Date(); vig.setDate(vig.getDate() + 15);
    const d = { id: params.ID_Cotizacion, folio: v.editFolio || 'PROVISIONAL', fecha: new Date().toLocaleDateString('es-MX'), vigencia: vig.toLocaleDateString('es-MX'), vigenciaDias: 15,
      cliente: c.nombre, razon: c.razon, rfc: c.rfc, cel: c.cel, domicilio: [c.calle, c.colonia, c.municipio, c.estado].filter(Boolean).join(', '),
      fiscal: { cp: c.cp || '', regimen: conRfc ? c.regimen || '' : '', uso: conRfc ? c.uso || '' : '' }, obs: v.obs, vendedor: U().nombre, sucursal: sucDe(v.suc),
      lineas: v.lineas.map((l, i) => { const p = prod(l.id) || {}; return { nombre: p.nombre || l.id, unidad: p.unidad || '', cant: l.cant, precioLista: l.precio, desc: t.descs[i], importe: r2c(t.brutos[i] - t.descs[i]), ivaMonto: t.ivas[i], total: t.imps[i], lote: '', cad: '' }; }),
      sub: t.sub, desc: t.desc, iva: t.iva, total: t.total };
    S.cotOff = d;
    S.cot = cotNueva(); guardarBorradorCot(); S.tabCot = 'lista';
    V.cotizaciones('lista');
    modal('Cotización guardada en el equipo', `<p>📴 Sin conexión: la cotización para <b>${esc(c.razon || c.nombre || '')}</b> por <b>${$$(t.total)}</b> quedó guardada en este equipo.
      El folio se asigna al sincronizar, en cuanto haya buena señal.</p>
      <div class="acciones" style="justify-content:flex-start"><button class="btn primario" onclick="App.pdfCotOffline()">📄 PDF para enviar</button>
      ${c.cel ? `<a class="btn" target="_blank" href="${WA_BASE}52${String(c.cel).replace(/\D/g, '').slice(-10)}">💬 WhatsApp</a>` : ''}<button class="btn" onclick="App.cerrarModal()">Cerrar</button></div>`);
  }
  async function verCotizacion(id) {
    let d; try { d = await pedir('detalleCotizacion', { id: id }); } catch (e) { return; }
    S.ultimaCot = d;
    const abierta = d.estado === 'Abierta' || d.estado === 'Vencida';
    modal('Cotización ' + d.folio, `<div class="imprimible"><div class="nota">
      <div class="enc"><div><div class="doc-logos">${logoHtml()}${fotoSucDoc(d.sucursal.id || d.suc)}</div><div>${esc(d.sucursal.nombre || '')}</div><small>${esc(d.sucursal.direccion || '')} ${d.sucursal.tel ? '· Tel. ' + esc(d.sucursal.tel) : ''}</small></div>
      <div style="text-align:right"><b>COTIZACIÓN</b><div style="font-size:18px">${esc(d.folio)}</div><div>${esc(d.fecha)}</div><div>${etqCot(d.estado)}</div><div class="fact-enc">Vigente hasta ${esc(d.vigencia)}</div>${d.venta ? `<div class="fact-enc"><b>Venta ${esc(d.venta.folio)}</b></div>` : ''}</div></div>
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
        <div><b>${esc(d.razon || d.cliente)}</b>${d.razon && d.razon !== d.cliente ? '<br>' + esc(d.cliente) : ''}<br>${d.rfc ? 'RFC ' + esc(d.rfc) : ''} ${esc(d.domicilio || '')}${fiscalHtml(d.fiscal)}</div>
        <div style="text-align:right">Atendió: ${esc(d.vendedor || '')}</div></div>
      <div class="tabla-cont"><table><thead><tr><th class="num">Cant.</th><th>Producto</th>${d.lineas.some(l => l.lote) ? '<th>Lote</th><th>Cad.</th>' : ''}<th class="num">Precio unit.</th>${d.desc ? '<th class="num">Descuento</th>' : ''}<th class="num">Importe</th><th class="num">IVA $</th><th class="num">Total</th></tr></thead><tbody>
      ${d.lineas.map(l => `<tr><td class="num">${nf(l.cant)}</td><td>${esc(l.nombre)}</td>${d.lineas.some(x => x.lote) ? `<td>${esc(l.lote || 'Auto')}</td><td>${esc(l.cad || '')}</td>` : ''}<td class="num">${$$(l.precioLista !== undefined ? l.precioLista : l.precio)}</td>${d.desc ? `<td class="num">${l.desc ? '−' + $$(l.desc) : '—'}</td>` : ''}<td class="num">${$$(l.importe)}</td><td class="num">${$$(l.ivaMonto !== undefined ? l.ivaMonto : l.importe * (l.iva || 0))}</td><td class="num"><b>${$$(l.total !== undefined ? l.total : l.importe * (1 + (l.iva || 0)))}</b></td></tr>`).join('')}
      </tbody></table></div>
      <div class="totales" style="margin-top:10px">${totalesHtml(d.sub, d.desc || 0, d.iva, d.total)}</div>
      ${d.letras ? `<p><small>(${esc(d.letras)})</small></p>` : ''}${d.obs ? `<p><small>${esc(d.obs)}</small></p>` : ''}
      ${d.motivoPerdida && d.estado === 'Cancelada' ? `<p class="no-imprimir"><span class="etq mal">💔 ${esc(d.motivoPerdida)}</span></p>` : ''}
      <p class="muted"><small>Cotización válida por ${d.vigenciaDias} días (hasta el ${esc(d.vigencia)}). Precios sujetos a existencias y a cambio sin previo aviso después de la vigencia.</small></p></div></div>
      ${d.cotOrigen ? `<div class="aviso-cand no-imprimir">↩️ Es lo que faltó entregar de la cotización <a href="#" onclick="App.verCot('${esc(d.cotOrigen.id)}');return false"><b>${esc(d.cotOrigen.folio)}</b></a>.</div>` : ''}
      ${d.surtido ? surtidoCotHtml(d) : ''}
      <div class="acciones no-imprimir">
        <button class="btn primario" onclick="App.pdfCot('${d.id}')">📄 PDF para enviar</button>
        ${d.cel ? `<a class="btn" target="_blank" href="${WA_BASE}52${String(d.cel).replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent('Interés Veterinario — Cotización ' + d.folio + '\nTotal: ' + $$(d.total) + '\nVigente hasta ' + d.vigencia)}">💬 WhatsApp</a>` : ''}
        ${abierta && puede('ventas') ? `<button class="btn primario" onclick="App.cotAVenta('${d.id}')">🛒 Convertir en venta</button>` : ''}
        ${abierta ? `<button class="btn" onclick="App.editarCot('${d.id}')">✏️ Editar</button>` : ''}
        ${abierta && puede('seguimiento') && d.idCliente ? `<button class="btn" onclick="App.formVisita({idCliente:'${esc(d.idCliente)}', idCot:'${d.id}'})">📅 Programar visita para entregarla</button>` : ''}
        ${d.estado !== 'Vendida' ? `<button class="btn" onclick="App.ligarCot('${d.id}')">🔗 Ligar a una nota existente</button>` : ''}
        ${d.venta ? `<button class="btn" onclick="App.verVentaId('${d.venta.id}')">🧾 Ver nota ${esc(d.venta.folio)}</button>` : ''}
        ${d.estado === 'Cancelada' || d.estado === 'Vencida' ? `<button class="btn" onclick="App.reabrirCot('${d.id}')">🔄 Renovar / reabrir</button>` : ''}
        ${abierta || d.estado === 'Vencida' ? `<button class="btn peligro" onclick="App.cancelarCot('${d.id}')">❌ Se perdió / cancelar</button>` : ''}
      </div>`);
  }
  /** Cotizado contra lo que llevó la venta: lo pendiente pasa (o ya pasó) a una cotización nueva. */
  function surtidoCotHtml(d) {
    const s = d.surtido, pend = s.filas.filter(f => f.pendiente > 0), comp = s.filas.filter(f => !(f.pendiente > 0));
    return `<div class="fc-sec no-imprimir"><h4>📦 Cotizado contra lo vendido en la nota ${esc(d.venta.folio)}</h4>
      ${tabla([{ t: 'Producto', h: f => esc(f.nombre) }, { t: 'Cotizado', num: 1, h: f => nf(f.cot) }, { t: 'Vendido', num: 1, h: f => nf(f.vendido) },
        { t: 'Pendiente', num: 1, h: f => f.pendiente > 0 ? `<b class="txt-mal">${nf(f.pendiente)}</b>` : '<span class="etq ok">✔ completo</span>' }], s.filas)}
      ${s.extras.length ? `<p class="muted" style="font-size:13px;margin:6px 0 0">➕ La venta además llevó (no estaba cotizado): ${s.extras.map(x => esc(x.nombre) + ' × ' + nf(x.vendido)).join(' · ')}</p>` : ''}
      ${d.cotPendiente ? `<p style="margin:8px 0 0">➡️ Lo pendiente está en la cotización <a href="#" onclick="App.verCot('${esc(d.cotPendiente.id)}');return false"><b>${esc(d.cotPendiente.folio)}</b></a> ${etqCot(d.cotPendiente.estado)}</p>`
        : pend.length ? `<div class="acciones izq"><button class="btn primario" onclick="App.pendienteCot('${esc(d.id)}')">➡️ Pasar lo pendiente (${pend.length} producto${pend.length === 1 ? '' : 's'}) a una nueva cotización</button></div>` : `<p class="muted" style="margin:6px 0 0">✔ La venta cubrió todo lo cotizado.</p>`}</div>`;
  }
  async function pendienteCot(id) {
    try { const r = await pedir('pendienteCotizacion', { id: id }); toast('✔ Lo pendiente pasó a la cotización ' + r.folio); if (S.vista === 'cotizaciones') cargarCotizaciones(); verCotizacion(r.id); } catch (e) {}
  }
  function pdfCot(id) { const d = S.ultimaCot || {}; generarPdf('pdfCotizacion', { id: id }, { cel: d.cel, asunto: 'Cotización ' + (d.folio || ''), texto: 'Interés Veterinario — Cotización ' + (d.folio || '') + '\nTotal: ' + $$(d.total) + '\nVigente hasta ' + (d.vigencia || ''), volver: `App.verCot('${id}')` }); }
  function editarCot(id) {
    const d = S.ultimaCot; if (!d || d.id !== id) return;
    if (S.cot && S.cot.lineas.length && S.cot.editId !== id && !confirm('Tienes una cotización en captura que se va a descartar. ¿Continuar?')) return;
    const listas = (D().catalogos || {}).listas || [], c = cliente(d.idCliente);
    S.cot = { editId: d.id, editFolio: d.folio, suc: d.sucursal.id, cli: d.idCliente, lista: c && listas.indexOf(c.lista) >= 0 ? c.lista : 'Publico', obs: d.obs, descPC: 0, flete: 0,
      lineas: d.lineas.map(l => ({ id: l.prod, cant: l.cant, precio: l.descPct ? l.precioLista : l.precio, desc: l.descPct || 0, lote: l.k || '', loteTxt: l.lote || '', cadTxt: l.cad || '' })) };
    guardarBorradorCot(); cerrarModal(); S.tabCot = 'nueva'; ir('cotizaciones');
  }
  function cotAVenta(id) {
    const d = S.ultimaCot; if (!d || d.id !== id) return;
    if (S.venta && S.venta.lineas.length && !confirm('Tienes una venta en captura que se va a reemplazar. ¿Continuar?')) return;
    const v = ventaNueva(), c = cliente(d.idCliente), listas = (D().catalogos || {}).listas || [];
    if ((D().permitidas || []).indexOf(d.sucursal.id) >= 0) v.suc = d.sucursal.id;
    v.cli = d.idCliente; v.lista = c && listas.indexOf(c.lista) >= 0 ? c.lista : 'Publico'; v.dias = c ? c.credito || 0 : 0; v.metodo = v.dias > 0 ? 'PPD' : 'PUE';
    v.comentarios = 'Cotización ' + d.folio + (d.obs ? ' · ' + d.obs : '');
    v.lineas = d.lineas.map(l => ({ id: l.prod, cant: l.cant, precio: l.descPct ? l.precioLista : l.precio, desc: l.descPct || 0, lote: l.k && lotes(l.prod, v.suc).some(x => x.k === l.k) ? l.k : '' }));
    v.desdeCot = { id: d.id, folio: d.folio };
    S.venta = v; guardarBorrador(); cerrarModal(); ir('venta');
    const sin = d.lineas.filter(l => existencia(l.prod, v.suc) < l.cant); if (sin.length) toast('⚠️ ' + sin.length + ' producto(s) sin existencia suficiente en ' + sucNom(v.suc), true);
  }
  function quitarCotVenta() { if (S.venta) { delete S.venta.desdeCot; guardarBorrador(); V.venta(); } }
  const COT_MOTIVOS = ['Precio', 'No había existencia', 'Compró a otro proveedor', 'Tiempo de entrega', 'Ya no lo necesitó', 'Sin presupuesto / crédito', 'No respondió', 'Error o duplicada', 'Otro'];
  const COT_MOT_ICO = { 'Precio': '💲', 'No había existencia': '📦', 'Compró a otro proveedor': '🏃', 'Tiempo de entrega': '⏱️', 'Ya no lo necesitó': '🤷', 'Sin presupuesto / crédito': '💳', 'No respondió': '🔇', 'Error o duplicada': '🗑️', 'Otro': '✏️' };
  /** Cerrar como perdida: el motivo se elige de una lista (para poder medir por qué se pierden ventas) + comentario opcional. */
  function cancelarCot(id) {
    S.motCot = '';
    modal('❌ ¿Por qué se perdió?', `<p class="muted" style="margin-top:0">Elige el motivo principal. Con esto el Radar te dice <b>por qué se pierden tus ventas</b>.</p>
      <div class="mot-opc">${COT_MOTIVOS.map(m => `<button class="chip-op" data-m="${esc(m)}" onclick="App.motCotElegir(this)">${COT_MOT_ICO[m] || ''} ${esc(m)}</button>`).join('')}</div>
      <label style="margin-top:10px">Comentario (opcional)<input id="motCotTxt" placeholder="Ej. la competencia lo dio en $1,200; pidió entrega en 2 días…"></label>
      <p class="muted peq">🗑️ "Error o duplicada" la cancela sin contarla como venta perdida.</p>
      <div class="acciones"><button class="btn" onclick="App.verCot('${esc(id)}')">← Volver</button><button class="btn peligro" id="motCotOk" disabled onclick="App.motCotGuardar('${esc(id)}')">Cerrar como perdida</button></div>`);
  }
  function motCotElegir(b) {
    document.querySelectorAll('.mot-opc .chip-op').forEach(x => x.classList.toggle('on', x === b)); S.motCot = b.dataset.m;
    const ok = $('#motCotOk'); ok.disabled = false; ok.textContent = S.motCot === 'Error o duplicada' ? 'Cancelar cotización' : 'Cerrar como perdida';
  }
  async function motCotGuardar(id) {
    if (!S.motCot) return toast('Elige un motivo', true);
    try { await pedir('cancelarCotizacion', { id: id, categoria: S.motCot, motivo: ($('#motCotTxt') || {}).value || '' });
      toast(S.motCot === 'Error o duplicada' ? 'Cotización cancelada' : '💔 Registrada como perdida: ' + S.motCot); despuesDeCot(id); } catch (e) {}
  }
  /** Vencida o cancelada: renovar a precios de hoy o reabrir igual. */
  function reabrirCot(id) {
    modal('🔄 Volver a ofrecer la cotización', `<p class="muted" style="margin-top:0">La fecha cambia a hoy y la vigencia vuelve a correr ${'15'} días.</p>
      <div class="rd-opc">
        <button class="rd-opc-b" onclick="App.reabrirCotOk('${esc(id)}', true)"><b>🔄 Renovar con precios de hoy</b><small>Cada producto toma el precio actual de la lista del cliente (respeta los descuentos % de cada renglón).</small></button>
        <button class="rd-opc-b" onclick="App.reabrirCotOk('${esc(id)}', false)"><b>↩️ Reabrir con los mismos precios</b><small>Respeta los precios que ya se le habían dado.</small></button>
      </div><div class="acciones"><button class="btn" onclick="App.verCot('${esc(id)}')">← Volver</button></div>`);
  }
  async function reabrirCotOk(id, precios) {
    try { const r = await pedir('reabrirCotizacion', { id: id, precios: !!precios });
      toast(precios ? (r.cambios ? '🔄 Renovada: ' + r.cambios + ' precio' + (r.cambios === 1 ? '' : 's') + ' actualizado' + (r.cambios === 1 ? '' : 's') + (puede('ver_importes') ? ' · total ' + $$(r.antes) + ' → ' + $$(r.total) : '') : '🔄 Renovada: los precios ya estaban al día') : 'Cotización reabierta');
      despuesDeCot(id); } catch (e) {}
  }
  function despuesDeCot(id) {
    if (S.vista === 'radar') { cerrarModal(); S.radar = null; cargarRadar(); } else verCotizacion(id);
    if (S.vista === 'cotizaciones') cargarCotizaciones();
  }
  async function ligarCot(id) {
    const folio = prompt('Folio de la nota de venta que corresponde a esta cotización (ej. No/Rem-0622):'); if (!folio) return;
    try { const r = await pedir('ligarVentaCotizacion', { id: id, folio: folio.trim() }); toast('✔ Ligada a la nota ' + r.venta + (r.pendiente && r.pendiente.folio ? ' · lo que faltó pasó a la cotización ' + r.pendiente.folio : '')); verCotizacion(id); if (S.vista === 'cotizaciones') cargarCotizaciones(); } catch (e) {}
  }

  /* ---------- HISTORIAL DE VENTAS ---------- */
  V.ventas = (tab) => {
    const tabs = (puede('ventas') ? [['notas', 'Notas de venta']] : []).concat(puede('cobranza') ? [['cobranza', '💵 Cobranza'], ['edocta', '📑 Estados de cuenta']] : [])
      .concat(puede('facturacion') ? [['fact', '🧾 Facturación']] : []).concat(puede('devoluciones') ? [['dev', '↩️ Devoluciones']] : []).concat(puede('dueno') ? [['util', '🔒 Utilidad por nota']] : []);
    tab = tab || S.tabVen || 'notas'; if (!tabs.some(x => x[0] === tab)) tab = tabs[0][0]; S.tabVen = tab;
    const h = hoyISO(), ini = h.slice(0, 8) + '01';   // mes en curso: del día 1 a hoy
    const tb = (id, n) => `<button class="${tab === id ? 'activo' : ''}" onclick="App.vistaVentas('${id}')">${n}</button>`;
    const barra = tabs.length > 1 ? `<div class="pestanas">${tabs.map(x => tb(x[0], x[1])).join('')}</div>` : '';
    if (tab === 'fact') return vistaFacturacion(barra);
    if (tab === 'cobranza') return V.cobranza(barra);
    if (tab === 'edocta') return vistaEdoCta(barra);
    if (tab === 'dev') return vistaDevoluciones(barra);
    if (tab === 'util') {
      $('#vista').innerHTML = `${barra}
        <div class="tarjeta"><div class="fila">
        <label>Desde<input type="date" id="fDesde" value="${ini}"></label><label>Hasta<input type="date" id="fHasta" value="${h}"></label>
        ${U().todasSucursales ? `<label>Sucursal<select id="fSuc">${optsSuc(sucFiltro(), false, 'Todas')}</select></label>` : ''}
        <label>Buscar<input id="fTxt" placeholder="Folio o cliente"></label>
        <button class="btn primario fijo" onclick="App.buscarUtilidad()">Buscar</button></div>
        <p class="muted" style="margin-top:8px">Solo tú ves este apartado. Venta neta sin IVA (con descuentos). Costo real = costo de compra del lote vendido (bonificaciones y flete incluidos).</p></div>
        <div class="espacio"></div><div id="lUtil"></div>`;
      $('#fTxt').onkeydown = e => { if (e.key === 'Enter') buscarUtilidad(); };
      agregarMesAnio('fDesde', 'fHasta', buscarUtilidad);
      buscarUtilidad();
      return;
    }
    const vc = S.ventasCli;   // historial de un cliente (desde su ficha): todas las fechas y todas las sucursales
    const vs = S.ventasSuc; S.ventasSuc = null;   // desde Sucursales: esa sucursal, todas las fechas
    $('#vista').innerHTML = barra + (vc ? `<div class="filtro-activo">🧾 Mostrando solo las ventas de <b>${esc(vc.nombre)}</b> (todas las sucursales)<button class="btn chico" onclick="App.quitarFiltroCliente()">✕ Quitar filtro</button></div>` : '') + `<div class="tarjeta"><div class="fila">
      <label>Desde<input type="date" id="fDesde" value="${vc || vs ? '' : ini}"></label><label>Hasta<input type="date" id="fHasta" value="${vc || vs ? '' : h}"></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="fSuc">${optsSuc(vc ? '' : vs || sucFiltro(), false, 'Todas')}</select></label>` : ''}
      <label>Buscar<input id="fTxt" placeholder="Folio o cliente" value="${esc(vc ? '' : S.filtroVentas || '')}"></label>
      <label>Estatus<select id="fEst">${opts([['Entregado', 'Entregado'], ['Pendiente', 'Pendiente de entrega'], ['Cancelado', 'Cancelado'], ['Devuelto', 'Devuelto']], '', 'Todos')}</select></label>
      <label>Factura<select id="fFact">${opts([['SI', 'Facturadas'], ['Parcial', 'Facturadas en parte'], ['NO', 'Sin facturar']], '', 'Todas')}</select></label>
      <label class="check fijo"><input type="checkbox" id="fSaldo"> Solo con saldo</label>
      <button class="btn primario fijo" onclick="App.buscarVentas()">Buscar</button></div></div><div class="espacio"></div><div id="lVentas"></div>`;
    $('#fFact').onchange = buscarVentas;
    S.filtroVentas = '';
    agregarMesAnio('fDesde', 'fHasta', buscarVentas, 'ventas');
    buscarVentas();
  };
  async function buscarVentas() {
    const nq = S.qVentas = (S.qVentas || 0) + 1;   // solo cuenta la búsqueda más reciente
    if ($('#lVentas')) $('#lVentas').innerHTML = '<div class="vacio">Buscando…</div>';
    try {
      let l = await pedir('listarVentas', { desde: $('#fDesde').value, hasta: $('#fHasta').value, sucursal: $('#fSuc') ? $('#fSuc').value : '', texto: $('#fTxt').value, conSaldo: $('#fSaldo').checked, idCliente: S.ventasCli ? S.ventasCli.id : '' });
      if (nq !== S.qVentas || !$('#lVentas')) return;
      if ($('#fEst').value) l = l.filter(x => x.estatus === $('#fEst').value);
      const ff = $('#fFact') ? $('#fFact').value : '', fv = x => { const t = String(x.facturado || '').trim().toUpperCase(); return t === 'SI' ? 'SI' : t === 'PARCIAL' ? 'Parcial' : 'NO'; };
      if (ff) l = l.filter(x => fv(x) === ff);
      S.lista = l;
      const vivas = l.filter(x => x.estatus !== 'Cancelado');
      const tot = vivas.reduce((a, x) => a + x.total, 0), sal = vivas.reduce((a, x) => a + Math.max(0, x.saldo), 0), cob = vivas.reduce((a, x) => a + x.cobrado, 0);
      const conSal = vivas.filter(x => x.saldo > 0.009).length;
      $('#lVentas').innerHTML = `<div class="kpis">
        <div class="kpi"><small>${S.ventasCli && !$('#fDesde').value && !$('#fHasta').value ? 'Ventas históricas del cliente' : 'Ventas del periodo'}</small><b>${$$(tot)}</b><span>${vivas.length} ${vivas.length === 1 ? 'nota' : 'notas'}${l.length > vivas.length ? ' · ' + (l.length - vivas.length) + ' canceladas' : ''}</span></div>
        <div class="kpi"><small>Cobrado de esas notas</small><b>${$$(cob)}</b><span>${tot > 0 ? Math.round(cob / tot * 100) + ' % del total' : '—'}</span></div>
        <div class="kpi"><small>Por cobrar del periodo</small><b>${$$(sal)}</b><span>${conSal} ${conSal === 1 ? 'nota' : 'notas'} con saldo</span></div>
        ${puede('cobranza') ? `<div class="kpi kpi-clic" id="kCxC" onclick="App.verCxC()" title="Ver todas las notas con saldo"><small>Cuentas por cobrar (total)</small><b>…</b><span>calculando</span></div>` : ''}
      </div>` + tabla([
        { t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Cliente', k: 'cliente' }, { t: 'Sucursal', cls: 'ocultar-movil', h: x => esc(sucNom(x.suc)) },
        { t: 'Total', num: 1, h: x => $$(x.total) }, { t: 'Saldo', num: 1, h: x => x.saldo > 0.009 && x.estatus !== 'Cancelado' ? `<b>${$$(x.saldo)}</b>` : '—' },
        { t: 'Estatus', h: x => etqEstatus(x.estatus) },
        { t: 'Factura', cls: 'ocultar-movil', h: x => { const t = String(x.facturado || '').trim().toUpperCase(); if (x.estatus === 'Cancelado') return '—';
          return (t === 'SI' ? '<span class="etq ok">Facturada</span>' : t === 'PARCIAL' ? '<span class="etq av">Parcial</span>' : '<span class="muted">Sin facturar</span>') + (x.factura ? `<br><small class="muted">${esc(x.factura)}</small>` : ''); } },
        { t: 'Pago', h: x => x.estatus === 'Cancelado' || x.estatus === 'Devuelto' ? '—' : x.saldo > 0.009 ? '<span class="etq av">Con saldo</span>' : x.saldo < -0.009 ? '<span class="etq av">Saldo a favor</span>' : '<span class="etq ok">Pagada</span>' }
      ], l, { clic: 'App.abrirVenta' });
      if (puede('cobranza')) totalCxC();
    } catch (e) { if (nq === S.qVentas && $('#lVentas')) $('#lVentas').innerHTML = `<div class="vacio">${e.red ? 'Consultar ventas requiere conexión.' : 'No se pudo consultar: ' + esc(e.message || '')}</div>`; }
  }
  /** Cuentas por cobrar de TODAS las fechas (no depende del periodo elegido). */
  async function totalCxC() {
    const suc = $('#fSuc') ? $('#fSuc').value : '', k = 'cxc|' + suc;
    let r = S.cacheTot && S.cacheTot[k] && Date.now() - S.cacheTot[k].t < 120000 ? S.cacheTot[k].r : null;
    if (!r) {
      try {
        const l = await pedir('cuentasPorCobrar', { sucursal: suc }, true), hoy = hoyISO();
        const viv = l.filter(x => x.estatus !== 'Cancelado' && x.saldo > 0.009);
        const venc = viv.filter(x => x.diasVencido > 0 || (x.venc && isoDe(x.venc) && isoDe(x.venc) < hoy));
        r = { total: viv.reduce((a, x) => a + x.saldo, 0), n: viv.length, vencido: venc.reduce((a, x) => a + x.saldo, 0), nv: venc.length };
        S.cacheTot = S.cacheTot || {}; S.cacheTot[k] = { t: Date.now(), r: r };
      } catch (e) { const el = $('#kCxC'); if (el) el.querySelector('span').textContent = 'requiere conexión'; return; }
    }
    const el = $('#kCxC'); if (!el) return;
    el.querySelector('b').textContent = $$(r.total);
    el.querySelector('span').innerHTML = r.n + (r.n === 1 ? ' nota' : ' notas') + (r.vencido > 0.009 ? ` · <b class="txt-mal">vencido ${$$(r.vencido)}</b>` : ' · nada vencido');
  }
  function verCxC() {
    $('#fDesde').value = ''; $('#fHasta').value = ''; $('#fSaldo').checked = true; if ($('#fEst')) $('#fEst').value = '';
    buscarVentas();
  }


  /* ---------- ESTADOS DE CUENTA (notas no liquidadas por cliente) ---------- */
  const COL_TRAMO = { corriente: 'var(--ok)', d30: '#d9a400', d60: '#eb6834', d90: '#d4502a', d90m: 'var(--peligro)' };
  function chipDias(d) {
    if (d <= 0) return '<span class="etq ok">Al corriente</span>';
    const c = d > 90 ? 'mal' : d > 30 ? 'av' : 'av';
    return `<span class="etq ${c}" ${d > 30 && d <= 90 ? 'style="background:#fde3d4;color:#a8441a"' : ''}>${d} días vencido</span>`;
  }
  function vistaEdoCta(barra) {
    $('#vista').innerHTML = barra + `<div class="tarjeta"><div class="fila">
      <label>Desde<input type="date" id="eDesde" value=""></label><label>Hasta<input type="date" id="eHasta" value=""></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="eSuc">${optsSuc('', false, 'Todas')}</select></label>` : ''}
      <label>Antigüedad<select id="eTramo"><option value="">Todas</option><option value="vencido">Solo vencidas</option><option value="corriente">Al corriente</option>
        <option value="d30">1 a 30 días</option><option value="d60">31 a 60 días</option><option value="d90">61 a 90 días</option><option value="d90m">Más de 90 días</option></select></label>
      <label>Buscar<input id="eTxt" placeholder="Cliente o RFC"></label>
      <button class="btn primario fijo" onclick="App.buscarEdoCta()">Buscar</button></div>
      <p class="muted" style="margin:8px 0 0;font-size:12.5px">Solo notas no liquidadas. Sin fechas se muestran todas; con fechas, solo las notas emitidas en ese periodo.</p></div>
      <div class="espacio"></div><div id="lEC"></div>`;
    $('#eTxt').onkeydown = e => { if (e.key === 'Enter') buscarEdoCta(); };
    $('#eTramo').onchange = buscarEdoCta;
    agregarMesAnio('eDesde', 'eHasta', buscarEdoCta);
    buscarEdoCta();
  }
  function filtroEC() { return { desde: $('#eDesde') ? $('#eDesde').value : '', hasta: $('#eHasta') ? $('#eHasta').value : '', sucursal: $('#eSuc') ? $('#eSuc').value : '' }; }
  async function buscarEdoCta() {
    const f = filtroEC(); S.ecFiltro = f;
    try {
      const r = await pedir('estadosCuenta', Object.assign({ texto: $('#eTxt').value, tramo: $('#eTramo').value }, f));
      if (!$('#lEC')) return;
      const T = r.totales, l = r.clientes; S.lista = l;
      const pct = x => T.saldo > 0 ? Math.round(x / T.saldo * 100) : 0;
      const barra = T.saldo > 0 ? `<div class="ec-barra">${r.tramos.filter(t => T.tramos[t.k] > 0.009).map(t => `<div title="${esc(t.t)}: ${$$(T.tramos[t.k])}" onclick="App.filtrarTramo('${t.k}')" style="flex:${T.tramos[t.k]};background:${COL_TRAMO[t.k]}"></div>`).join('')}</div>
        <div class="ec-leyenda">${r.tramos.map(t => `<button onclick="App.filtrarTramo('${t.k}')" class="${$('#eTramo').value === t.k ? 'activo' : ''}"><i style="background:${COL_TRAMO[t.k]}"></i>${esc(t.t)} <b>${$$(T.tramos[t.k])}</b> <span>${pct(T.tramos[t.k])} %</span></button>`).join('')}</div>` : '';
      $('#lEC').innerHTML = `<div class="kpis">
        <div class="kpi"><small>Por cobrar</small><b>${$$(T.saldo)}</b><span>${T.clientes} ${T.clientes === 1 ? 'cliente' : 'clientes'} · ${T.notas} ${T.notas === 1 ? 'nota' : 'notas'}</span></div>
        <div class="kpi kpi-clic" onclick="App.filtrarTramo('vencido')"><small>Vencido</small><b style="color:var(--peligro)">${$$(T.vencido)}</b><span>${pct(T.vencido)} % del saldo</span></div>
        <div class="kpi kpi-clic" onclick="App.filtrarTramo('corriente')"><small>Por vencer</small><b>${$$(T.porVencer)}</b><span>${pct(T.porVencer)} % del saldo</span></div>
        <div class="kpi kpi-clic" onclick="App.filtrarTramo('d90m')"><small>Más de 90 días (riesgo)</small><b>${$$(T.tramos.d90m)}</b><span>${pct(T.tramos.d90m)} % del saldo</span></div>
      </div>${barra ? `<div class="tarjeta" style="padding:12px 14px;margin-bottom:14px"><b style="font-size:13px">Antigüedad del saldo</b>${barra}</div>` : ''}` + tabla([
        { t: 'Cliente', h: x => `<b>${esc(x.razon || x.cliente)}</b>${x.razon && x.cliente && x.razon !== x.cliente ? `<br><small class="muted">${esc(x.cliente)}</small>` : ''}` },
        { t: 'Notas', num: 1, h: x => x.notas }, { t: 'Saldo', num: 1, h: x => `<b>${$$(x.saldo)}</b>` },
        { t: 'Vencido', num: 1, h: x => x.vencido > 0.009 ? `<b style="color:var(--peligro)">${$$(x.vencido)}</b>` : '—' },
        { t: 'Antigüedad', h: x => chipDias(x.maxDias) },
        { t: 'Último pago', cls: 'ocultar-movil', h: x => x.ultimoPago ? `${esc(x.ultimoPago.fecha)}<br><small class="muted">${$$(x.ultimoPago.monto)} · hace ${x.ultimoPago.dias} d</small>` : '<span class="muted">Sin pagos</span>' },
        { t: '', h: x => `<span style="white-space:nowrap"><button class="btn chico" title="PDF del estado de cuenta" onclick="event.stopPropagation();App.pdfEdoCta('${esc(x.idCliente)}')">📄 PDF</button> <button class="btn chico" title="Recordatorio por WhatsApp" onclick="event.stopPropagation();App.recordatorioEC('${esc(x.idCliente)}')">💬</button></span>` }
      ], l, { clic: 'App.abrirEdoCta', vacio: 'No hay saldos pendientes con esos filtros 🎉' });
    } catch (e) { if ($('#lEC')) $('#lEC').innerHTML = '<div class="vacio">Consultar estados de cuenta requiere conexión.</div>'; }
  }
  function filtrarTramo(k) { const s = $('#eTramo'); if (!s) return; s.value = s.value === k ? '' : k; buscarEdoCta(); }
  async function cargarEC(idCliente) {
    return pedir('estadoCuentaCliente', Object.assign({ idCliente: idCliente }, S.ecFiltro || {}));
  }
  async function verEdoCta(idCliente) {
    let d; try { d = await cargarEC(idCliente); } catch (e) { return; }
    S.ultimoEC = d; const R = d.resumen;
    const caja = (t, v, col, extra) => `<div class="ec-caja" style="border-top-color:${col}${extra || ''}"><small>${t}</small><b>${v}</b></div>`;
    modal('Estado de cuenta · ' + (d.cliente.razon || d.cliente.nombre), `<div class="imprimible"><div class="nota">
      <div class="enc"><div><div class="doc-logos">${logoHtml()}${fotoSucDoc(d.sucursal.id)}</div><div>${esc(d.sucursal.nombre || '')}</div></div>
        <div style="text-align:right"><b>ESTADO DE CUENTA</b><div style="font-size:16px">${esc(d.folio)}</div><div>Corte al ${esc(d.corte)}</div>${d.periodo ? `<small class="muted">Notas del ${esc(d.periodo.desde || 'inicio')} al ${esc(d.periodo.hasta || d.corte)}</small>` : ''}</div></div>
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px">
        <div><small class="muted">Cliente</small><br><b style="font-size:16px">${esc(d.cliente.razon || d.cliente.nombre)}</b>${d.cliente.razon && d.cliente.nombre !== d.cliente.razon ? '<br>' + esc(d.cliente.nombre) : ''}${d.cliente.rfc ? '<br><small>RFC ' + esc(d.cliente.rfc) + '</small>' : ''}${d.cliente.domicilio ? '<br><small class="muted">' + esc(d.cliente.domicilio) + '</small>' : ''}${fiscalHtml(d.cliente.fiscal, true)}</div>
        <div style="text-align:right"><small class="muted">Crédito</small><br>${d.cliente.diasCredito ? d.cliente.diasCredito + ' días' : 'Contado'}${d.vendedor ? '<br><small class="muted">Ejecutivo: ' + esc(d.vendedor) + '</small>' : ''}</div></div>
      <div class="ec-cajas">${caja('Importe de las notas', $$(R.total), '#8a8e83')}${caja('Pagado', $$(R.cobrado), 'var(--info)')}${caja('Vencido', $$(R.vencido), 'var(--peligro)', R.vencido > 0.009 ? ';background:var(--peligro-suave)' : '')}${caja('Saldo a pagar', $$(R.saldo), 'var(--marca)', ';background:var(--marca-suave)')}</div>
      <div class="ec-leyenda" style="margin-top:8px">${d.tramos.map(t => `<span><i style="background:${COL_TRAMO[t.k]}"></i>${esc(t.t)} <b>${$$(R.tramos[t.k])}</b></span>`).join('')}</div>
      ${tabla([{ t: 'Nota', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Fecha', k: 'fecha' }, { t: 'Vence', k: 'venc' }, { t: 'Estado', h: x => chipDias(x.dias) },
        { t: 'Importe', num: 1, cls: 'ocultar-movil', h: x => $$(x.total) }, { t: 'Pagado', num: 1, cls: 'ocultar-movil', h: x => $$(x.cobrado) }, { t: 'Saldo', num: 1, h: x => `<b>${$$(x.saldo)}</b>` },
        { t: '', cls: 'no-imprimir', h: x => `<span style="white-space:nowrap"><button class="btn chico" onclick="event.stopPropagation();App.verVentaId('${x.id}')">Ver</button>${puede('cobranza') ? ` <button class="btn chico primario" onclick="event.stopPropagation();App.formCobro('${x.id}', ${x.saldo})">Cobrar</button>` : ''}</span>` }], d.notas)}
      ${d.pagos.length ? `<p style="margin:12px 0 4px"><b>Pagos recibidos (últimos ${d.diasPagos} días)</b></p>` + tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Nota', k: 'folio' }, { t: 'Forma de pago', k: 'forma' }, { t: 'Importe', num: 1, h: x => $$(x.monto) }], d.pagos) : ''}
      </div></div>
      <div class="acciones no-imprimir">
        <button class="btn primario" onclick="App.pdfEdoCta('${esc(d.cliente.id)}')">📄 PDF para enviar</button>
        <button class="btn" onclick="App.recordatorioEC('${esc(d.cliente.id)}')">💬 Recordatorio por WhatsApp</button>
        ${d.cliente.correo ? `<a class="btn" target="_blank" href="mailto:${encodeURIComponent(d.cliente.correo)}?subject=${encodeURIComponent('Estado de cuenta ' + d.folio)}&body=${encodeURIComponent(textoEC(d))}">✉️ Recordatorio por correo</a>` : ''}
      </div>`);
  }
  function textoEC(d) {
    const R = d.resumen, venc = d.notas.filter(n => n.dias > 0);
    return `Estimado cliente ${d.cliente.razon || d.cliente.nombre}:\nLe compartimos su estado de cuenta al ${d.corte} con Interés Veterinario.\n\n` +
      `Saldo a pagar: ${$$(R.saldo)}` + (R.vencido > 0.009 ? `\nVencido: ${$$(R.vencido)} (${venc.length} ${venc.length === 1 ? 'nota' : 'notas'})` : '') +
      '\n\nNotas pendientes:\n' + d.notas.map(n => `• ${n.folio} del ${n.fecha}: ${$$(n.saldo)}${n.dias > 0 ? ' (vencida ' + n.dias + ' días)' : ''}`).join('\n') +
      `\n\nDatos para su pago (${d.bancos.titular}):\n` + d.bancos.cuentas.map(b => b.banco + ': ' + b.lineas.join(' · ')).join('\n') +
      '\n\nSi ya realizó su pago, le agradecemos enviarnos el comprobante y hacer caso omiso de este mensaje. ¡Gracias por su preferencia!';
  }
  async function pdfEdoCta(idCliente) {
    let d = S.ultimoEC && S.ultimoEC.cliente.id === idCliente ? S.ultimoEC : null;
    if (!d) { try { d = await cargarEC(idCliente); S.ultimoEC = d; } catch (e) { return; } }
    generarPdf('pdfEstadoCuenta', Object.assign({ idCliente: idCliente }, S.ecFiltro || {}), { cel: d.cliente.cel, correo: d.cliente.correo, asunto: 'Estado de cuenta ' + d.folio + ' — Interés Veterinario',
      texto: 'Interés Veterinario — Estado de cuenta al ' + d.corte + '\nSaldo a pagar: ' + $$(d.resumen.saldo) + (d.resumen.vencido > 0.009 ? ' · Vencido: ' + $$(d.resumen.vencido) : '') + '\nConsulte el detalle en el PDF:',
      volver: `App.verEdoCta('${idCliente}')` });
  }
  async function recordatorioEC(idCliente) {
    let d = S.ultimoEC && S.ultimoEC.cliente.id === idCliente ? S.ultimoEC : null;
    if (!d) { try { d = await cargarEC(idCliente); S.ultimoEC = d; } catch (e) { return; } }
    const tel = String(d.cliente.cel || '').replace(/\D/g, '').slice(-10);
    window.open(WA_BASE + (tel ? '52' + tel : '') + '?text=' + encodeURIComponent(textoEC(d)), '_blank');
  }

  /* ---------- FACTURACIÓN: facturas (CFDI) ligadas a las notas ---------- */
  const etqFact = e => /^Facturada|^SI/.test(e) ? `<span class="etq ok">${esc(e)}</span>` : /Parcial/.test(e) ? `<span class="etq av">${esc(e)}</span>` : `<span class="etq mal">${esc(e)}</span>`;
  const etqCuadre = c => ({ 'cuadra': '<span class="etq ok">Cuadra</span>', 'falta asignar': '<span class="etq av">Falta asignar</span>', 'excede': '<span class="etq mal">Excede</span>',
    'por definir': '<span class="etq av">Montos por definir</span>', 'sin XML': '<span class="etq">Sin XML</span>', 'sin notas': '<span class="etq mal">Sin notas</span>' })[c] || esc(c);
  async function cargarFactNota(id) {
    const el = $('#notaFact'); if (!el) return;
    let r; try { r = await pedir('facturasNota', { ID_Venta: id }, true); } catch (e) { el.innerHTML = '<span class="muted">Facturación: requiere conexión.</span>'; return; }
    S.factNota = r; pintarFactNota();
  }
  function pintarFactNota(form) {
    const r = S.factNota, el = $('#notaFact'); if (!r || !el) return;
    const fila = f => `<div class="fact-fila"><b>${esc(f.sf)}</b> <span class="muted">${esc(f.fecha || '')}</span> · ${f.monto === null ? '<span class="etq av">monto por definir</span>' : $$(f.monto)}${f.total !== null ? ' <small class="muted">de ' + $$(f.total) + '</small>' : ''}
      ${f.urlPdf ? `<a href="${esc(f.urlPdf)}" target="_blank">PDF</a>` : ''} ${f.urlXml ? `<a href="${esc(f.urlXml)}" target="_blank">XML</a>` : ''}
      <button class="icono" title="Cambiar monto" onclick="App.montoFactNota('${f.rel}', ${f.monto === null ? "''" : f.monto})">✏️</button><button class="icono" title="Quitar" onclick="App.quitarFactNota('${f.rel}', '${esc(f.sf)}')">✕</button></div>`;
    let h = `<h4>🧾 Facturación ${etqFact(r.estado)}</h4>
      <p class="muted">Total de la nota ${$$(r.total)} · facturado ${$$(r.facturado)}${r.porFacturar ? ' · por facturar <b>' + $$(r.porFacturar) + '</b>' : ''}${!r.facturas.length && r.anotacion ? ' · anotación: ' + esc(r.anotacion) : ''}</p>
      ${r.facturas.map(fila).join('') || '<p class="muted">Sin factura ligada.</p>'}`;
    if (form === 'asignar') {
      h += `<div class="tarjeta" style="margin-top:8px"><div class="rejilla">
        <label>Factura<select id="nfSel">${r.sugeridas.map(f => `<option value="${f.id}">${esc(f.sf)} · ${esc(f.fecha)}${f.global ? ' · GLOBAL' : ''}${f.libre !== null ? ' · libre ' + $$(f.libre) : ''}</option>`).join('')}<option value="">Otra: escribir serie-folio…</option></select></label>
        <label>Serie-folio<input id="nfSF" placeholder="IV-260"></label>
        <label>Monto de esta nota $<input type="number" step="0.01" id="nfMonto" value="${r.porFacturar !== null && r.porFacturar !== undefined && r.porFacturar > 0 ? r.porFacturar : r.total}"></label></div>
        <p class="muted">El monto es lo que esta factura cubre de la nota (con IVA). Si la factura cubre varias notas, asígnala en cada una.</p>
        <div class="acciones"><button class="btn" onclick="App.pintarFactNota()">Cancelar</button><button class="btn primario" onclick="App.asignarFactNota('${r.id}')">Asignar</button></div></div>`;
    } else if (form === 'xml') {
      h += `<div class="tarjeta" style="margin-top:8px"><div class="rejilla">
        <label>XML de la factura *<input type="file" id="nfXml" accept=".xml,text/xml"></label>
        <label>PDF (opcional)<input type="file" id="nfPdf" accept="application/pdf,.pdf"></label>
        <label>Monto de esta nota $<input type="number" step="0.01" id="nfMontoX" value="${r.porFacturar !== null && r.porFacturar !== undefined && r.porFacturar > 0 ? r.porFacturar : r.total}"></label></div>
        <div class="acciones"><button class="btn" onclick="App.pintarFactNota()">Cancelar</button><button class="btn primario" onclick="App.subirXmlNota('${r.id}')">Subir y asignar</button></div></div>`;
    } else {
      h += `<div class="acciones" style="justify-content:flex-start"><button class="btn" onclick="App.pintarFactNota('asignar')">🧾 Asignar factura</button><button class="btn" onclick="App.pintarFactNota('xml')">⬆️ Subir XML de la factura</button></div>`;
    }
    el.innerHTML = h;
    if (form === 'asignar') { const sel = $('#nfSel'), sf = $('#nfSF'); const t = () => { sf.parentElement.style.display = sel.value ? 'none' : ''; }; sel.onchange = t; t(); }
  }
  async function asignarFactNota(id) {
    const sel = $('#nfSel').value, sf = $('#nfSF').value.trim(), monto = $('#nfMonto').value;
    if (!sel && !sf) return toast('Elige la factura o escribe la serie-folio', true);
    try { S.factNota = await pedir('asignarFactura', { ID_Venta: id, ID_Factura: sel, serieFolio: sf, monto: monto }); toast('✔ Factura asignada'); verVenta(id); if (S.vista === 'ventas') refrescarVentasVista(); } catch (e) {}
  }
  async function quitarFactNota(rel, sf) {
    if (!confirm('¿Quitar la factura ' + sf + ' de esta nota?')) return;
    try { const r = await pedir('quitarFactura', { rel: rel }); if (r && r.facturas && $('#notaFact')) verVenta(r.id); else if (S.facDet) verFactura(S.facDet); toast('Factura quitada'); if (S.vista === 'ventas') refrescarVentasVista(); } catch (e) {}
  }
  async function montoFactNota(rel, actual) {
    const v = prompt('Monto que cubre esta factura de la nota (con IVA). Déjalo vacío si aún no lo sabes:', actual === '' ? '' : actual);
    if (v === null) return;
    try { await pedir('montoFacturaNota', { rel: rel, monto: v.trim() }); toast('✔ Monto actualizado');
      if ($('#notaFact') && S.factNota) cargarFactNota(S.factNota.id); else if (S.facDet) verFactura(S.facDet); if (S.vista === 'ventas') refrescarVentasVista(); } catch (e) {}
  }
  const leerArchivo = (f, comoTexto) => new Promise((res, rej) => { const fr = new FileReader(); fr.onerror = rej; fr.onload = () => res(fr.result); comoTexto ? fr.readAsText(f) : fr.readAsDataURL(f); });
  async function subirXmlNota(id) {
    const fx = $('#nfXml').files[0], fp = $('#nfPdf').files[0];
    if (!fx) return toast('Elige el archivo XML', true);
    try {
      const xml = await leerArchivo(fx, true), pdf = fp ? await leerArchivo(fp) : '';
      S.factNota = await pedir('subirFacturaXml', { ID_Venta: id, xml: xml, pdf: pdf, monto: $('#nfMontoX').value }); toast('✔ Factura registrada y asignada'); verVenta(id);
      if (S.vista === 'ventas') refrescarVentasVista();
    } catch (e) {}
  }
  function refrescarVentasVista() { if (S.tabVen === 'fact') cargarFacturacion(); else if ($('#lVentas')) buscarVentas(); }

  function vistaFacturacion(barra) {
    const h = hoyISO(), ini = h.slice(0, 8) + '01';
    S.tabFact = S.tabFact || 'facturas';
    const sb = (id, n) => `<button class="${S.tabFact === id ? 'activo' : ''}" onclick="App.subFact('${id}')">${n}</button>`;
    $('#vista').innerHTML = barra + `<div class="pestanas">${sb('facturas', 'Facturas')}${sb('pend', 'Por facturar')}${sb('revisar', 'Marcadas SI sin factura')}</div>
      <div class="tarjeta no-imprimir"><div class="fila">
      <label>Desde<input type="date" id="fDesde" value="${ini}"></label><label>Hasta<input type="date" id="fHasta" value="${h}"></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="fSuc">${optsSuc('', false, 'Todas')}</select></label>` : ''}
      <label>Buscar<input id="fTxt" placeholder="Factura, nota, RFC o cliente"></label>
      ${S.tabFact === 'facturas' ? `<label>Cuadre<select id="fCuadre">${opts([['cuadra', 'Cuadra'], ['falta asignar', 'Falta asignar'], ['excede', 'Excede'], ['por definir', 'Montos por definir'], ['sin XML', 'Sin XML'], ['sin notas', 'Sin notas']], '', 'Todos')}</select></label>` : ''}
      <button class="btn primario fijo" onclick="App.cargarFacturacion()">Buscar</button>
      ${S.tabFact === 'facturas' ? `<button class="btn fijo" onclick="App.formSubirFactura()">⬆️ Subir XML</button>` : ''}
      ${S.tabFact === 'facturas' && U().rol === 'Administrador' ? `<button class="btn fijo" onclick="App.importarFacturas()">🔄 Importar de AppSheet</button>` : ''}</div></div>
      <div class="espacio"></div><div id="lFact"><div class="vacio">Cargando…</div></div>`;
    $('#fTxt').onkeydown = e => { if (e.key === 'Enter') cargarFacturacion(); };
    if ($('#fCuadre')) $('#fCuadre').onchange = cargarFacturacion;
    agregarMesAnio('fDesde', 'fHasta', cargarFacturacion);
    cargarFacturacion();
  }
  function subFact(t) { S.tabFact = t; V.ventas('fact'); }
  async function cargarFacturacion() {
    const p = { desde: $('#fDesde').value, hasta: $('#fHasta').value, sucursal: $('#fSuc') ? $('#fSuc').value : '', texto: $('#fTxt').value, cuadre: $('#fCuadre') ? $('#fCuadre').value : '' };
    $('#lFact').innerHTML = '<div class="vacio">Cargando…</div>';
    if (S.tabFact === 'facturas') {
      let r; try { r = await pedir('facturas', p); } catch (e) { if ($('#lFact')) $('#lFact').innerHTML = '<div class="vacio">Requiere conexión.</div>'; return; }
      if (!$('#lFact')) return;
      S.lista = r.facturas;
      $('#lFact').innerHTML = `<div class="kpis"><div class="kpi"><small>Facturas</small><b>${nf(r.totales.facturas)}</b><span></span></div>
        <div class="kpi"><small>Total facturado</small><b>${$$(r.totales.total)}</b><span>según XML</span></div>
        <div class="kpi"><small>Asignado a notas</small><b>${$$(r.totales.asignado)}</b><span></span></div></div>` +
        (r.facturas.length ? '' : '<p class="muted">¿Aún no hay facturas? ' + (U().rol === 'Administrador' ? 'Usa <b>🔄 Importar de AppSheet</b> para traer los XML y las anotaciones que ya tienes.' : 'Pide al administrador que importe las facturas.') + '</p>') +
        tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Factura', h: x => `<b>${esc(x.sf)}</b>${x.global ? ' <span class="etq">Global</span>' : ''}` },
          { t: 'Cliente', h: x => `${esc(x.receptor || '')}<br><small class="muted">${esc(x.rfc || '')}</small>` },
          { t: 'Total', num: 1, h: x => x.total === null ? '—' : $$(x.total) }, { t: 'Asignado', num: 1, h: x => $$(x.asignado) },
          { t: 'Notas', num: 1, h: x => nf(x.notas) }, { t: 'Cuadre', h: x => etqCuadre(x.cuadre) + (x.dif && Math.abs(x.dif) > 1 && x.cuadre !== 'sin notas' ? `<br><small class="muted">${$$(x.dif)}</small>` : '') }],
          r.facturas, { clic: 'App.abrirFactura', vacio: 'Sin facturas en el periodo' });
      return;
    }
    let r; try { r = await pedir('porFacturar', Object.assign(p, { revisar: S.tabFact === 'revisar' })); } catch (e) { if ($('#lFact')) $('#lFact').innerHTML = '<div class="vacio">Requiere conexión.</div>'; return; }
    if (!$('#lFact')) return;
    S.lista = r.notas;
    $('#lFact').innerHTML = (S.tabFact === 'revisar' ? '<p class="muted">Notas con <b>Facturado? = SI</b> (o Parcial) pero sin una factura ligada. Ábrelas y asigna su factura.</p>' :
      `<div class="kpis"><div class="kpi"><small>Notas por facturar</small><b>${nf(r.totales.notas)}</b><span></span></div><div class="kpi"><small>Monto por facturar</small><b>${$$(r.totales.porFacturar)}</b><span>con IVA</span></div></div>`) +
      tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Nota', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Cliente', h: x => `${esc(x.cliente || '')}<br><small class="muted">${esc(x.rfc || '')}</small>` },
        { t: 'Sucursal', cls: 'ocultar-movil', h: x => esc(sucNom(x.suc)) }, { t: 'Total', num: 1, h: x => $$(x.total) }, { t: 'Facturado', num: 1, h: x => x.facturado ? $$(x.facturado) : '—' },
        { t: 'Por facturar', num: 1, h: x => x.porFacturar === null ? '<span class="etq av">por definir</span>' : `<b>${$$(x.porFacturar)}</b>` }, { t: 'Estado', h: x => etqFact(x.estado) + (x.anotacion ? `<br><small class="muted">${esc(x.anotacion)}</small>` : '') }],
        r.notas, { clic: 'App.abrirVenta', vacio: S.tabFact === 'revisar' ? 'Todo en orden ✔' : 'Todo facturado ✔' });
  }
  async function verFactura(id) {
    S.facDet = id;
    let d; try { d = await pedir('detalleFactura', { id: id }); } catch (e) { return; }
    const dif = d.total === null ? null : d.total - d.asignado;
    modal('Factura ' + d.sf, `<div class="kpis"><div class="kpi"><small>Total factura</small><b>${d.total === null ? '—' : $$(d.total)}</b><span>${esc(d.fecha || '')}${d.global ? ' · Global' : ''}</span></div>
      <div class="kpi"><small>Asignado a notas</small><b>${$$(d.asignado)}</b><span>${nf(d.notas.length)} notas</span></div>
      <div class="kpi"><small>Diferencia</small><b class="${dif !== null && Math.abs(dif) > 1 ? 'error' : ''}">${dif === null ? '—' : $$(dif)}</b><span>${dif === null ? 'falta el XML' : Math.abs(dif) <= 1 ? 'cuadra ✔' : dif > 0 ? 'falta asignar' : 'se asignó de más'}</span></div></div>
      <p>${esc(d.receptor || '')} ${d.rfc ? '· RFC ' + esc(d.rfc) : ''}${d.uuid ? '<br><small class="muted">UUID ' + esc(d.uuid) + '</small>' : ''}${d.comentarios ? '<br><small class="muted">' + esc(d.comentarios) + '</small>' : ''}</p>
      <div class="acciones" style="justify-content:flex-start">${d.urlPdf ? `<a class="btn" target="_blank" href="${esc(d.urlPdf)}">📄 PDF</a>` : ''}${d.urlXml ? `<a class="btn" target="_blank" href="${esc(d.urlXml)}">🧾 XML</a>` : ''}</div>
      ${tabla([{ t: 'Nota', h: x => `<b>${esc(x.folio)}</b><br><small class="muted">${esc(x.fecha)}</small>` }, { t: 'Cliente', h: x => esc(x.cliente) },
        { t: 'Total nota', num: 1, h: x => $$(x.totalNota) }, { t: 'Monto en esta factura', num: 1, h: x => x.monto === null ? '<span class="etq av">por definir</span>' : $$(x.monto) },
        { t: 'Otras facturas', h: x => esc(x.otras.join(', ')) },
        { t: '', h: x => `<button class="icono" title="Cambiar monto" onclick="event.stopPropagation();App.montoFactNota('${x.rel}', ${x.monto === null ? "''" : x.monto})">✏️</button><button class="icono" title="Quitar" onclick="event.stopPropagation();App.quitarFactNota('${x.rel}', '${esc(d.sf)}')">✕</button>` }], d.notas, { vacio: 'Sin notas ligadas' })}
      <div class="tarjeta" style="margin-top:10px"><div class="rejilla"><label>Agregar nota (folio)<input id="fdNota" placeholder="No/Rem-0622"></label>
        <label>Monto $<input type="number" step="0.01" id="fdMonto" placeholder="${dif !== null && dif > 0 ? dif.toFixed(2) : 'total de la nota'}"></label></div>
        <div class="acciones"><button class="btn primario" onclick="App.agregarNotaFactura('${d.id}')">➕ Agregar nota</button></div></div>`);
  }
  async function agregarNotaFactura(id) {
    const folio = $('#fdNota').value.trim(); if (!folio) return toast('Escribe el folio de la nota', true);
    try { await pedir('asignarFactura', { ID_Factura: id, folio: folio, monto: $('#fdMonto').value }); toast('✔ Nota agregada'); verFactura(id); refrescarVentasVista(); } catch (e) {}
  }
  function formSubirFactura() {
    modal('Subir XML de factura', `<div class="rejilla"><label>XML *<input type="file" id="sfXml" accept=".xml,text/xml"></label><label>PDF (opcional)<input type="file" id="sfPdf" accept="application/pdf,.pdf"></label></div>
      <p class="muted">Se guarda en la carpeta de facturas y queda lista para asignarla a sus notas.</p>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.subirFactura()">Subir</button></div>`);
  }
  async function subirFactura() {
    const fx = $('#sfXml').files[0], fp = $('#sfPdf').files[0]; if (!fx) return toast('Elige el XML', true);
    try { const r = await pedir('subirFacturaXml', { xml: await leerArchivo(fx, true), pdf: fp ? await leerArchivo(fp) : '' }); toast('✔ Factura ' + r.sf + ' registrada'); verFactura(r.id); cargarFacturacion(); } catch (e) {}
  }
  async function importarFacturas() {
    if (!confirm('Se leerán los XML de la carpeta de AppSheet (Facturas_de_Venta_PDF) y las anotaciones "IV-…" de las notas para ligarlas. No se modifica Nota_Venta. ¿Continuar?')) return;
    try { const r = await pedir('sincronizarFacturas', {});
      modal('Importación de facturas', `<p>✔ XML leídos: <b>${r.xmlLeidos}</b> · facturas nuevas: <b>${r.facturasNuevas}</b> (de ellas ${r.stubs} solo por anotación, sin XML) · notas ligadas: <b>${r.ligas}</b></p>
        ${r.errores.length ? '<p class="error">' + r.errores.slice(0, 10).map(esc).join('<br>') + '</p>' : ''}
        <p class="muted">Las notas con varias facturas o marcadas como Parcial quedan con <b>monto por definir</b>: revísalas en cada factura.</p>
        <div class="acciones"><button class="btn primario" onclick="App.cerrarModal()">Listo</button></div>`); cargarFacturacion(); } catch (e) {}
  }

  /* ---------- UTILIDAD POR NOTA (solo el dueño) ---------- */
  const claseMg = m => m < 10 ? 'mal' : m < 20 ? 'av' : 'ok';
  async function buscarUtilidad() {
    $('#lUtil').innerHTML = '<div class="vacio">Calculando…</div>';
    let r;
    try { r = await pedir('utilidadVentas', { desde: $('#fDesde').value, hasta: $('#fHasta').value, sucursal: $('#fSuc') ? $('#fSuc').value : '', texto: $('#fTxt').value }); }
    catch (e) { $('#lUtil').innerHTML = '<div class="vacio">Requiere conexión.</div>'; return; }
    S.lista = r.notas;
    const t = r.totales;
    $('#lUtil').innerHTML = `<div class="kpis"><div class="kpi"><small>Venta neta</small><b>${$$(t.venta)}</b><span>${nf(t.notas)} notas</span></div>
      <div class="kpi"><small>Costo real</small><b>${$$(t.costo)}</b><span></span></div>
      <div class="kpi"><small>Utilidad</small><b>${$$(t.utilidad)}</b><span>Margen ${t.margen}%</span></div></div>` +
      tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Cliente', k: 'cliente' }, { t: 'Sucursal', cls: 'ocultar-movil', h: x => esc(sucNom(x.suc)) },
        { t: 'Venta neta', num: 1, h: x => $$(x.venta) }, { t: 'Costo real', num: 1, cls: 'ocultar-movil', h: x => $$(x.costo) },
        { t: 'Utilidad $', num: 1, h: x => `<b>${$$(x.utilidad)}</b>` }, { t: 'Utilidad %', num: 1, h: x => `<span class="etq ${claseMg(x.margen)}">${x.margen.toFixed(1)}%</span>` }],
        r.notas, { clic: 'App.abrirUtilidad', vacio: 'Sin notas en el periodo' });
  }
  async function verUtilidad(id) {
    let d; try { d = await pedir('utilidadNota', { ID_Venta: id }); } catch (e) { return; }
    const fuente = { lote: '', promedio: '<small class="muted"> (prom.)</small>', lista: '<small style="color:var(--aviso)"> (lista)</small>' };
    modal('Utilidad · ' + d.folio, `<p><b>${esc(d.cliente)}</b> · ${esc(d.fecha)} · ${esc(sucNom(d.suc))} · ${etqEstatus(d.estatus)}${d.lista ? ' · lista ' + esc(d.lista) : ''}</p>
      <div class="kpis"><div class="kpi"><small>Venta neta</small><b>${$$(d.venta)}</b><span>sin IVA</span></div><div class="kpi"><small>Costo real</small><b>${$$(d.costo)}</b><span></span></div>
      <div class="kpi"><small>Utilidad</small><b>${$$(d.utilidad)}</b><span><span class="etq ${claseMg(d.margen)}">${d.margen.toFixed(1)}%</span></span></div></div>
      ${tabla([{ t: 'Cant.', num: 1, h: x => nf(x.cant) }, { t: 'Producto', h: x => `<b>${esc(x.nombre)}</b><br><small class="muted">${esc(x.prod)} · Lote ${esc(x.lote || '—')}</small>` },
        { t: 'Precio neto', num: 1, h: x => $$(x.precioNeto) }, { t: 'Costo real u.', num: 1, h: x => $$(x.costoU) + fuente[x.fuente] },
        { t: 'Venta', num: 1, h: x => $$(x.venta) }, { t: 'Costo', num: 1, h: x => $$(x.costo) },
        { t: 'Utilidad $', num: 1, h: x => `<b class="${x.utilidad < 0 ? 'error' : ''}">${$$(x.utilidad)}</b>` }, { t: 'Utilidad %', num: 1, h: x => `<span class="etq ${claseMg(x.margen)}">${x.margen.toFixed(1)}%</span>` }], d.lineas)}
      <p class="muted" style="margin-top:8px">Costo real u. = costo de compra del lote vendido, con bonificaciones y ${(d.flete * 100).toFixed(0)}% de flete. <i>(prom.)</i> = promedio real del producto (lote sin compra registrada o nota pendiente de entrega); <i>(lista)</i> = sin compras, se usó el costo de lista.${d.fleteCobrado ? ' El flete cobrado al cliente (' + $$(d.fleteCobrado) + ') no se incluye.' : ''}</p>
      <div class="acciones"><button class="btn" onclick="App.verVentaId('${d.id}')">Ver nota de venta</button></div>`);
  }


  /* ---------- GASTOS (solo el dueño) ---------- */
  const GRUPOS_G = ['Operación', 'Financiero', 'Inversión', 'Excluir'];
  const NOMBRE_G = { 'Operación': 'Gastos de operación', 'Financiero': 'Gastos financieros', 'Inversión': 'Inversiones (activo fijo)', 'Excluir': 'Excluidos (personales)' };
  V.gastos = (tab) => {
    if (!puede('dueno')) return vistaPorClasificar(false);   // contador: solo la pestaña de facturas por clasificar
    tab = tab || S.tabGas || 'resumen'; S.tabGas = tab;
    if (tab === 'clasificar') return vistaPorClasificar(true);
    const h = hoyISO(), f = alDia(S.fgas || (S.fgas = { desde: h.slice(0, 8) + '01', hasta: h, hastaHoy: h, grupo: '', categoria: '', texto: '' }));
    const tb = (id, n) => `<button class="${tab === id ? 'activo' : ''}" onclick="App.vistaGastos('${id}')">${n}</button>`;
    $('#vista').innerHTML = `<div class="pestanas">${tb('resumen', 'Estado de gastos')}${tb('mes', 'Por mes')}${tb('facturas', 'Facturas')}${tb('inversion', 'Inversiones')}${tb('emisores', 'Proveedores')}${tb('clasificar', '🏷️ Por clasificar')}</div>
      <div class="tarjeta no-imprimir"><div class="fila">
        <label>Desde<input type="date" id="gDesde" value="${f.desde}"></label><label>Hasta<input type="date" id="gHasta" value="${f.hasta}"></label>
        <label>Sucursal<select id="gSuc">${opts(D().sucursales || [], f.sucursal || '', 'Todas')}</select></label>
        <label>Grupo<select id="gGrupo">${opts(GRUPOS_G.map(g => [g, NOMBRE_G[g]]), f.grupo, 'Todos')}</select></label>
        <label>Categoría<select id="gCat"><option value="">Todas</option>${(S.catsGas || []).map(c => `<option ${c === f.categoria ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label>Buscar<input id="gTxt" placeholder="Proveedor, RFC o UUID" value="${esc(f.texto)}"></label>
        <button class="btn primario fijo" onclick="App.cargarGastos()">Buscar</button><button class="btn fijo" onclick="App.pdfGastos()">📄 PDF</button>
        <button class="btn fijo" onclick="App.formFacturasGasto()">📥 Subir facturas</button><button class="btn fijo" onclick="App.correoGastos()">✉️ Correo</button></div></div>
      <div id="gAviso"></div>
      <div class="espacio"></div><div id="gRes"><div class="vacio">Cargando…</div></div>`;
    agregarMesAnio('gDesde', 'gHasta', cargarGastos);
    ['#gGrupo', '#gCat', '#gSuc'].forEach(x => $(x).onchange = cargarGastos);
    $('#gTxt').onkeydown = e => { if (e.key === 'Enter') cargarGastos(); };
    if (S.datGas && S.datGasKey === JSON.stringify(f)) pintarGastos(); else cargarGastos();
  };
  function leerFiltrosGas() { S.fgas = marcarHoy({ desde: $('#gDesde').value, hasta: $('#gHasta').value, sucursal: $('#gSuc').value, grupo: $('#gGrupo').value, categoria: $('#gCat').value, texto: $('#gTxt').value.trim() }); return S.fgas; }
  async function cargarGastos() {
    const f = leerFiltrosGas();
    $('#gRes').innerHTML = '<div class="vacio">Cargando…</div>';
    try { S.datGas = await pedir('gastos', f); S.datGasKey = JSON.stringify(f); } catch (e) { $('#gRes').innerHTML = '<div class="vacio">Requiere conexión.</div>'; return; }
    if (!S.catsGas || S.catsGas.length !== S.datGas.categorias.length) { S.catsGas = S.datGas.categorias; const sel = $('#gCat'); if (sel) sel.innerHTML = '<option value="">Todas</option>' + S.catsGas.map(c => `<option ${c === f.categoria ? 'selected' : ''}>${esc(c)}</option>`).join(''); }
    pintarGastos();
  }
  function pintarGastos() {
    const r = S.datGas, t = r.totales, tab = S.tabGas;
    S.charts.forEach(c => c.destroy()); S.charts = [];
    const pct = v => r.ventas ? (v / r.ventas * 100).toFixed(1) + '%' : '—';
    const vari = (a, b) => b ? `<span class="${a > b ? 'error' : 'ok-txt'}">${a > b ? '▲' : '▼'} ${Math.abs((a - b) / b * 100).toFixed(1)}%</span>` : '<span class="muted">—</span>';
    const kpi = (ti, v, sub) => `<div class="kpi"><small>${ti}</small><b>${v}</b><span>${sub || ''}</span></div>`;
    const cargado = t.operacion + t.depreciacion + t.financiero;
    let html = `<div class="kpis">
      ${kpi('Gastos de operación', $$(t.operacion), pct(t.operacion) + ' de ventas · vs anterior ' + vari(t.operacion, t.anterior.operacion))}
      ${kpi('Depreciación (estimada)', $$(t.depreciacion), 'de las inversiones del negocio')}
      ${kpi('Gastos financieros', $$(t.financiero), 'vs anterior ' + vari(t.financiero, t.anterior.financiero))}
      ${kpi('Total cargado a resultados', $$(cargado), pct(cargado) + ' de ventas (' + $$(r.ventas) + ')')}
      ${kpi('Inversiones del periodo', $$(t.inversion), 'activo fijo · no se cargan completas')}
      ${kpi('Excluidos', $$(t.excluir), 'personales / no del negocio')}
      ${kpi('IVA acreditable', $$(t.iva), nf(t.facturas) + ' facturas')}</div>`;
    if (tab === 'resumen') {
      html += `<div class="rejilla-2"><div class="tarjeta"><h3>Estado de gastos · ${esc(r.periodo.desde)} al ${esc(r.periodo.hasta)}</h3>
        <p class="muted" style="margin-bottom:8px">Comparado contra ${esc(r.periodo.anterior)} (mismo número de días).</p>` +
        GRUPOS_G.filter(g => r.resumen.some(x => x.grupo === g)).map(g => {
          const ls = r.resumen.filter(x => x.grupo === g), tot = ls.reduce((a, x) => a + x.monto, 0), totA = ls.reduce((a, x) => a + x.anterior, 0);
          return `<h4 style="margin:12px 0 6px">${NOMBRE_G[g]} · ${$$(tot)} ${g !== 'Excluir' && g !== 'Inversión' ? '<small class="muted">(' + pct(tot) + ' de ventas)</small>' : ''}</h4>` +
            tabla([{ t: 'Categoría', h: x => `<b>${esc(x.cat)}</b>` }, { t: 'Facturas', num: 1, cls: 'ocultar-movil', h: x => nf(x.n) }, { t: 'Sin IVA', num: 1, h: x => $$(x.monto) },
              { t: 'IVA', num: 1, cls: 'ocultar-movil', h: x => $$(x.iva) }, { t: '% del grupo', num: 1, cls: 'ocultar-movil', h: x => tot ? (x.monto / tot * 100).toFixed(1) + '%' : '—' },
              { t: 'Anterior', num: 1, h: x => $$(x.anterior) }, { t: 'Var.', num: 1, h: x => vari(x.monto, x.anterior) }], ls, { clic: 'App.filtrarCatGasto' })
              .replace(/App\.filtrarCatGasto\((\d+)\)/g, (m0, i) => `App.filtrarCatGasto('${esc(ls[+i].cat).replace(/'/g, "\\'")}')`) +
            `<div style="text-align:right;margin-top:4px"><small class="muted">Total anterior ${$$(totA)} · ${vari(tot, totA)}</small></div>`;
        }).join('') + `</div><div class="tarjeta"><h3>Gastos de operación por categoría</h3><div class="grafica"><canvas id="gcOp"></canvas></div>
        <h3 style="margin-top:14px">Distribución por grupo</h3><div class="grafica" style="height:220px"><canvas id="gcGrupo"></canvas></div></div></div>
        <div class="tarjeta"><h3>Peso de los gastos por sucursal</h3><p class="muted">Gastos sin sucursal asignada = Matriz. Las facturas marcadas "Prorrateo" se reparten según el % de ventas de cada sucursal. Asigna sucursal en la pestaña Facturas.</p>` +
        tabla([{ t: 'Sucursal', h: x => `<b>${esc(sucNom(x.suc))}</b>` }, { t: 'Ventas', num: 1, h: x => $$(x.ventas) }, { t: 'Operación', num: 1, h: x => $$(x.operacion) },
          { t: 'Depreciación', num: 1, cls: 'ocultar-movil', h: x => $$(x.depreciacion) }, { t: 'Financieros', num: 1, cls: 'ocultar-movil', h: x => $$(x.financiero) },
          { t: 'Total cargado', num: 1, h: x => `<b>${$$(x.cargado)}</b>` }, { t: '% de sus ventas', num: 1, h: x => x.pctVentas === null ? '—' : x.pctVentas.toFixed(1) + '%' },
          { t: '% del gasto total', num: 1, h: x => { const t = r.porSucursal.reduce((a, y) => a + y.cargado, 0); return t ? (x.cargado / t * 100).toFixed(1) + '%' : '—'; } }], r.porSucursal, { vacio: 'Sin datos' }) + `</div>
        <p class="muted">Toca una categoría para ver solo sus facturas. Los grupos y tasas de depreciación se ajustan en Configuración › Grupos de gasto.</p>`;
    } else if (tab === 'mes') {
      const tm = Array(12).fill(0); r.porMes.forEach(x => x.meses.forEach((v, i) => { if (x.grupo !== 'Excluir' && x.grupo !== 'Inversión') tm[i] += v; }));
      html += `<div class="tarjeta"><h3>Gastos por mes · ${r.periodo.anio}</h3><div class="grafica"><canvas id="gcMes"></canvas></div></div>
        <div class="tarjeta"><h3>Categoría × mes · ${r.periodo.anio} (sin IVA)</h3><div class="tabla-cont"><table class="matriz"><thead><tr><th>Categoría</th>${MESES_TXT.map(m => `<th class="num">${m.slice(0, 3)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
        ${GRUPOS_G.filter(g => r.porMes.some(x => x.grupo === g)).map(g => { const ls = r.porMes.filter(x => x.grupo === g); const sub = Array(12).fill(0); ls.forEach(x => x.meses.forEach((v, i) => sub[i] += v));
          return `<tr class="grupo"><td colspan="14"><b>${NOMBRE_G[g]}</b></td></tr>` + ls.map(x => `<tr><td>${esc(x.cat)}</td>${x.meses.map(v => `<td class="num">${v ? nf(Math.round(v)) : '<span class="muted">·</span>'}</td>`).join('')}<td class="num"><b>${nf(Math.round(x.meses.reduce((a, b) => a + b, 0)))}</b></td></tr>`).join('') +
            `<tr class="res-total"><td>Subtotal</td>${sub.map(v => `<td class="num">${nf(Math.round(v))}</td>`).join('')}<td class="num">${nf(Math.round(sub.reduce((a, b) => a + b, 0)))}</td></tr>`; }).join('')}
        <tr class="res-total"><td><b>Operación + financieros</b></td>${tm.map(v => `<td class="num"><b>${nf(Math.round(v))}</b></td>`).join('')}<td class="num"><b>${nf(Math.round(tm.reduce((a, b) => a + b, 0)))}</b></td></tr>
        </tbody></table></div><p class="muted" style="margin-top:6px">El año se toma de la fecha "Hasta". Montos redondeados a pesos.</p></div>`;
    } else if (tab === 'facturas') {
      S.listaFact = r.facturas;
      const optSucG = sel => `<option value="PRORRATEO" ${sel === 'PRORRATEO' ? 'selected' : ''}>Prorrateo (% ventas)</option>` + (D().sucursales || []).map(x => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('');
      html += `<div class="tarjeta"><div class="fila no-imprimir" style="margin-bottom:8px"><label>Asignar las ${nf(r.facturas.length)} facturas mostradas a<select id="gAsigTodas"><option value="">Elige sucursal…</option>${optSucG('')}</select></label>
        <button class="btn fijo" onclick="App.asignarSucGastos(null)">Aplicar</button></div>
        <p class="muted">${nf(r.facturas.length)} facturas · ${$$(r.facturas.reduce((a, x) => a + x.monto, 0))} sin IVA · ${$$(r.facturas.reduce((a, x) => a + x.total, 0))} con IVA${r.sucursal ? ' · montos ponderados para ' + esc(sucNom(r.sucursal)) : ''}</p>` +
        tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Proveedor', h: x => `<b>${esc(x.emisor)}</b><br><small class="muted">${esc(x.rfc)}</small>` }, { t: 'Categoría', h: x => x.cat === 'POR CLASIFICAR' ? selCatGasto(x) : esc(x.cat) + `<br><small class="muted">${esc(x.grupo)}</small>` },
          { t: 'Sin IVA', num: 1, h: x => $$(x.monto) }, { t: 'IVA', num: 1, cls: 'ocultar-movil', h: x => $$(x.iva) }, { t: 'Total', num: 1, h: x => $$(x.total) }, { t: 'Pago', k: 'metodo', cls: 'ocultar-movil' },
          { t: 'Sucursal', h: (x) => `<select class="chico" onchange="App.asignarSucGastos('${esc(x.uuid)}', this.value)">${optSucG(x.suc)}</select>${x.peso < 1 ? `<br><small class="muted">${(x.peso * 100).toFixed(1)}%</small>` : ''}` },
          { t: 'PDF', h: x => `<button class="btn chico" title="${x.pdf ? 'Ver PDF' : x.xml ? 'Ver (armado con el XML)' : 'Sin archivos: súbelos'}" ${x.pdf || x.xml ? '' : 'style="opacity:.45"'} onclick="App.verPdfGasto('${esc(x.uuid)}')">📄</button>` },
          { t: 'UUID', cls: 'ocultar-movil', h: x => `<small class="muted">${esc(String(x.uuid).slice(0, 8))}…</small>` }], r.facturas, { vacio: 'Sin facturas' }) + '</div>';
    } else if (tab === 'inversion') {
      const tl = r.activos.reduce((a, x) => a + x.libros, 0), tm = r.activos.reduce((a, x) => a + x.monto, 0), ta = r.activos.reduce((a, x) => a + x.acumulada, 0);
      html += `<div class="tarjeta"><h3>Activo fijo y depreciación al ${esc(r.periodo.corte)}</h3>
        <p class="muted">Línea recta desde el mes siguiente a la compra. Tasas: vehículos 25 %, equipo de cómputo 30 %, mobiliario y equipo 10 % (ajustables en Configuración). Cálculo gerencial: los topes fiscales (p. ej. automóviles) los aplica tu contador.</p>
        <div class="kpis">${kpi('Monto original', $$(tm), nf(r.activos.length) + ' facturas')}${kpi('Depreciación acumulada', $$(ta), '')}${kpi('Valor en libros', $$(tl), '')}${kpi('Depreciación del periodo', $$(t.depreciacion), 'se resta en resultados')}</div>` +
        tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Proveedor', h: x => `<b>${esc(x.emisor)}</b><br><small class="muted">${esc(x.cat)}</small>` }, { t: 'Monto', num: 1, h: x => $$(x.monto) },
          { t: 'Tasa', num: 1, h: x => x.tasa + '%' }, { t: 'Mensual', num: 1, cls: 'ocultar-movil', h: x => $$(x.mensual) }, { t: 'Del periodo', num: 1, h: x => $$(x.periodo) },
          { t: 'Acumulada', num: 1, cls: 'ocultar-movil', h: x => $$(x.acumulada) }, { t: 'Valor en libros', num: 1, h: x => `<b>${$$(x.libros)}</b>` }], r.activos, { vacio: 'Sin inversiones registradas' }) + '</div>';
    } else {
      html += `<div class="tarjeta"><h3>Proveedores de gastos del periodo</h3>` + tabla([{ t: 'Proveedor', h: x => `<b>${esc(x.emisor)}</b><br><small class="muted">${esc(x.rfc)}</small>` },
        { t: 'Categorías', k: 'cats', cls: 'ocultar-movil' }, { t: 'Grupo', k: 'grupo' }, { t: 'Facturas', num: 1, h: x => nf(x.n) }, { t: 'Sin IVA', num: 1, h: x => $$(x.monto) }], r.emisores) + '</div>';
    }
    $('#gRes').innerHTML = html;
    if ($('#gAviso')) $('#gAviso').innerHTML = r.porClasificar ? `<div class="tarjeta aviso-cl" style="border-left:4px solid var(--aviso);margin-top:8px">🏷️ Hay <b>${nf(r.porClasificar)}</b> factura(s) <b>POR CLASIFICAR</b> (llegaron de un proveedor nuevo). <button class="btn chico" onclick="App.vistaGastos('clasificar')">Clasificar</button></div>` : '';
    if (tab === 'resumen') {
      barras('gcOp', r.resumen.filter(x => x.grupo === 'Operación').map(x => ({ nombre: x.cat, valor: x.monto })), css('--aviso'), true);
      barras('gcGrupo', [{ nombre: 'Operación', valor: t.operacion }, { nombre: 'Depreciación', valor: t.depreciacion }, { nombre: 'Financieros', valor: t.financiero }, { nombre: 'Inversiones', valor: t.inversion }, { nombre: 'Excluidos', valor: t.excluir }], css('--s1'), true);
    }
    if (tab === 'mes') {
      const serie = g => MESES_TXT.map((m, i) => r.porMes.filter(x => x.grupo === g).reduce((a, x) => a + x.meses[i], 0));
      const col = { 'Operación': css('--aviso'), 'Financiero': css('--s1'), 'Inversión': css('--s3'), 'Excluir': css('--texto-3') };
      grafica('gcMes', { type: 'bar', data: { labels: MESES_TXT.map(m => m.slice(0, 3)), datasets: GRUPOS_G.filter(g => r.porMes.some(x => x.grupo === g)).map(g => ({ label: g, data: serie(g), backgroundColor: col[g], stack: 's', borderRadius: 3 })) },
        options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: x => x.dataset.label + ': ' + $$(x.raw) } } },
          scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: tickMoneda } } } } });
    }
  }
  async function asignarSucGastos(uuid, suc) {
    const uuids = uuid ? [uuid] : (S.listaFact || []).map(x => x.uuid);
    suc = suc || $('#gAsigTodas').value;
    if (!suc) return toast('Elige la sucursal', true);
    if (!uuid && !confirm('¿Asignar ' + uuids.length + ' facturas a ' + (suc === 'PRORRATEO' ? 'Prorrateo' : sucNom(suc)) + '?')) return;
    try { const r = await pedir('asignarSucursalGasto', { uuids: uuids, ID_Sucursal: suc }, !!uuid); toast('✔ ' + r.asignadas + ' factura(s) → ' + (suc === 'PRORRATEO' ? 'Prorrateo' : sucNom(suc))); if (!uuid) cargarGastos(); else S.datGasKey = ''; } catch (e) { if (uuid) toast(e.message, true); }
  }
  /* ---------- Facturas por clasificar (dueño y contador / permiso clasificar_gastos) ---------- */
  async function vistaPorClasificar(conPestanas) {
    S.tabGas = 'clasificar';
    const tb = (id, n) => `<button class="${id === 'clasificar' ? 'activo' : ''}" onclick="App.vistaGastos('${id}')">${n}</button>`;
    $('#vista').innerHTML = (conPestanas ? `<div class="pestanas">${tb('resumen', 'Estado de gastos')}${tb('mes', 'Por mes')}${tb('facturas', 'Facturas')}${tb('inversion', 'Inversiones')}${tb('emisores', 'Proveedores')}${tb('clasificar', '🏷️ Por clasificar')}</div>` : '') +
      `<div class="tarjeta"><div class="fila"><div style="flex:3 1 280px"><b>🏷️ Facturas de gastos por clasificar</b><br><small class="muted">Llegaron de proveedores nuevos (por correo o subidas) y no se les pudo poner categoría. Elige la categoría de cada una; si marcas "todas del proveedor", también se usa para las que lleguen después de ese mismo RFC. Mientras no tengan categoría cuentan como gastos de operación. Si es una <b>compra</b> a un proveedor (mercancía), toca "🧾 Es compra": se pasa a Compras y deja de contar como gasto.</small></div>
        <label>Buscar<input id="pcTxt" placeholder="Proveedor o RFC"></label></div></div><div class="espacio"></div><div id="pcRes"><div class="vacio">Cargando…</div></div>`;
    let r; try { r = S.porClasif = await pedir('gastosPorClasificar', {}); } catch (e) { if ($('#pcRes')) $('#pcRes').innerHTML = '<div class="vacio">Requiere conexión.</div>'; return; }
    S.catsGas = S.catsGas && S.catsGas.length ? S.catsGas : r.categorias.map(c => c.cat);
    if (r.movidas && r.movidas.length) toast('🧾 ' + r.movidas.length + ' factura(s) de proveedores del catálogo se pasaron a Compras');
    $('#pcTxt').oninput = () => pintarPorClasificar();
    pintarPorClasificar();
  }
  function pintarPorClasificar() {
    const r = S.porClasif, el = $('#pcRes'); if (!r || !el) return;
    const q = ($('#pcTxt') ? $('#pcTxt').value : '').trim().toLowerCase();
    const l = r.facturas.filter(x => !q || (x.emisor + ' ' + x.rfc).toLowerCase().indexOf(q) >= 0);
    const grupo = {}; r.categorias.forEach(c => grupo[c.cat] = c.grupo);
    const optCats = sug => `<option value="">Elige categoría…</option>` + ['Operación', 'Financiero', 'Inversión', 'Excluir'].map(g => { const cs = r.categorias.filter(c => c.grupo === g); return cs.length ? `<optgroup label="${esc(g === 'Excluir' ? 'Excluir (personal / no es del negocio)' : g)}">${cs.map(c => `<option ${c.cat === sug ? 'selected' : ''}>${esc(c.cat)}</option>`).join('')}</optgroup>` : ''; }).join('') + `<option value="__nueva">+ Otra categoría…</option>`;
    el.innerHTML = !r.facturas.length ? '<div class="vacio">✔ No hay facturas por clasificar</div>' :
      `<p class="muted">${nf(r.total)} factura(s) por clasificar${l.length !== r.facturas.length ? ' · mostrando ' + nf(l.length) : ''}</p>` +
      l.map(x => `<div class="tarjeta" data-pc="${esc(x.uuid)}"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="flex:3 1 240px"><b>${esc(x.emisor)}</b><br><small class="muted">${esc(x.rfc)} · ${esc(x.fecha)}${x.metodo ? ' · ' + esc(x.metodo) : ''}</small>${x.concepto && x.concepto.trim() ? `<br><small>🧾 ${esc(x.concepto)}</small>` : ''}</div>
        <div style="text-align:right"><b>${$$(x.total)}</b><br><small class="muted">${$$(x.subtotal)} + IVA ${$$(x.iva)}</small></div></div>
        <div class="fila" style="margin-top:8px"><label style="flex:3 1 240px">Categoría${x.sugerida ? ' <small class="muted">(sugerida por el historial del proveedor)</small>' : ''}<select data-cat>${optCats(x.sugerida)}</select></label>
          <label class="check fijo"><input type="checkbox" data-todas checked> Todas de este proveedor</label>
          <button class="btn primario fijo" onclick="App.guardarClasif('${esc(x.uuid)}')">✔ Guardar</button>
          <button class="btn fijo" ${x.pdf || x.xml ? '' : 'disabled title="Sin archivos"'} onclick="App.verPdfGasto('${esc(x.uuid)}')">📄 PDF</button>
          ${x.xml ? `<button class="btn fijo" onclick="App.gastoACompra('${esc(x.uuid)}')">🧾 Es compra</button>` : ''}</div></div>`).join('');
  }
  async function gastoACompra(uuid) {
    const x = S.porClasif.facturas.find(f => f.uuid === uuid); if (!x) return;
    if (!confirm('¿Pasar la factura de ' + x.emisor + ' (' + $$(x.total) + ') a Compras? Dejará de contar como gasto.')) return;
    try { const r = await pedir('moverGastoACompras', { uuid: uuid });
      toast('🧾 Pasada a Compras' + (r.accion ? ' · ' + r.accion : ''));
      S.porClasif.facturas = S.porClasif.facturas.filter(f => f.uuid !== uuid); S.porClasif.total = S.porClasif.facturas.length; S.datGasKey = ''; pintarPorClasificar(); } catch (e) {}
  }
  async function guardarClasif(uuid) {
    const card = document.querySelector(`[data-pc="${CSS.escape(uuid)}"]`); if (!card) return;
    let cat = card.querySelector('[data-cat]').value, todas = card.querySelector('[data-todas]').checked;
    if (!cat) return toast('Elige la categoría', true);
    if (cat === '__nueva') { cat = (prompt('Nombre de la nueva categoría:') || '').trim().toUpperCase(); if (!cat) return; }
    try {
      const r = await pedir('clasificarGasto', { uuid: uuid, categoria: cat, todasDelProveedor: todas });
      toast('✔ ' + r.cambiadas + ' factura(s) → ' + cat);
      const x = S.porClasif.facturas.find(f => f.uuid === uuid), rfc = x ? x.rfc : '';
      S.porClasif.facturas = S.porClasif.facturas.filter(f => f.uuid !== uuid && !(todas && f.rfc === rfc));
      S.porClasif.total = S.porClasif.facturas.length;
      if (!S.porClasif.categorias.some(c => c.cat === cat)) S.porClasif.categorias.push({ cat: cat, grupo: 'Operación' });
      S.datGasKey = ''; pintarPorClasificar();
    } catch (e) {}
  }

  /* ---------- Facturas de gastos: subir, correo, ver PDF, clasificar ---------- */
  const selCatGasto = x => `<select class="chico" style="border-color:var(--aviso)" onchange="App.clasificarGasto('${esc(x.uuid)}', this.value, '${esc(x.emisor).replace(/'/g, "\\'")}')"><option value="">🏷️ Por clasificar…</option>${(S.catsGas || []).filter(c => c !== 'POR CLASIFICAR').map(c => `<option>${esc(c)}</option>`).join('')}<option value="__nueva">+ Otra categoría…</option></select>`;
  async function clasificarGasto(uuid, cat, emisor) {
    if (!cat) return;
    if (cat === '__nueva') { cat = (prompt('Nombre de la nueva categoría:') || '').trim().toUpperCase(); if (!cat) return; }
    const todas = confirm('¿Usar "' + cat + '" también para las demás facturas de ' + emisor + ' que estén por clasificar (y las que lleguen después)?');
    try { const r = await pedir('clasificarGasto', { uuid: uuid, categoria: cat, todasDelProveedor: todas }); toast('✔ ' + (r.cambiadas || 1) + ' factura(s) → ' + cat); S.datGasKey = ''; cargarGastos(); } catch (e) {}
  }
  async function verPdfGasto(uuid) {
    toast('Abriendo PDF…');
    try { const r = await pedir('verPdfGasto', { uuid: uuid }); verPdf(b64aBytes(r.b64), r.nombre, { url: r.url }); if (r.generado) toast('No llegó PDF: se armó uno con los datos del XML'); } catch (e) {}
  }
  function formFacturasGasto(dest) {
    S.subirDest = dest === 'compra' ? 'compra' : 'gasto';
    modal(S.subirDest === 'compra' ? 'Subir facturas de proveedores' : 'Subir facturas de gastos', `<p>Elige los <b>XML</b> (y sus <b>PDF</b>) de tus facturas${S.subirDest === 'compra' ? ' y notas de crédito de proveedores' : ' de gastos'}; también puedes subir archivos <b>.zip</b>. Puedes elegir muchos a la vez.</p>
      <div class="fila"><label>Archivos<input type="file" id="fgArch" multiple accept=".xml,.pdf,.zip,text/xml,application/pdf,application/zip"></label>
        ${'webkitdirectory' in document.createElement('input') && !/iPhone|iPad|iPod/.test(navigator.userAgent) ? `<label>…o una carpeta completa<input type="file" id="fgCarp" webkitdirectory multiple></label>` : ''}</div>
      <p class="muted">${S.subirDest === 'compra' ? 'Se reconocen por el RFC del catálogo de proveedores: se ligan a su orden de compra (o quedan aquí para que elijas) y las notas de crédito se aplican a la orden de su factura.' : 'Se registran en Egresos CFDI con su categoría (según el proveedor), los archivos se guardan en Drive › Facturas de gastos y no se duplican si ya estaban. Las de proveedores del catálogo se van a Compras.'} Solo se aceptan facturas a tu RFC.</p>
      <div id="fgProg"></div>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" id="fgBtn" onclick="App.subirFacturasGasto()">Subir</button></div>`);
  }
  async function subirFacturasGasto() {
    const fs = [...($('#fgArch').files || []), ...(($('#fgCarp') || {}).files || [])].filter(f => /\.(xml|pdf|zip)$/i.test(f.name) && !/^\./.test(f.name));
    if (!fs.length) return toast('Elige los archivos (XML, PDF o ZIP)', true);
    const grandes = fs.filter(f => f.size > 15e6); if (grandes.length) toast(grandes.length + ' archivo(s) de más de 15 MB se omiten', true);
    const fsOk = fs.filter(f => f.size <= 15e6), estricto = fsOk.length > 2;
    if (fsOk.length > 40 && !confirm('Se subirán ' + fsOk.length + ' archivos en grupos pequeños. Puede tardar varios minutos: deja esta pantalla abierta hasta que termine. ¿Continuar?')) return;
    // lotes de ~8 MB, sin separar un XML de su PDF (mismo nombre base)
    const base = n => n.replace(/\.[^.]+$/, '').toLowerCase(), grupos = {};
    fsOk.forEach(f => (grupos[base(f.name)] = grupos[base(f.name)] || []).push(f));
    const lotes = [[]]; let peso = 0;   // grupos pequeños (≤ 12 archivos, ≤ 8 MB) para que cada envío termine a tiempo
    Object.values(grupos).forEach(g => { const t = g.reduce((a, f) => a + f.size, 0), l = lotes[lotes.length - 1]; if ((peso + t > 8e6 || l.length + g.length > 12) && l.length) { lotes.push([]); peso = 0; } lotes[lotes.length - 1].push(...g); peso += t; });
    $('#fgBtn').disabled = true;
    const tot = { nuevas: 0, duplicadas: 0, omitidas: 0, porClasificar: 0, detalle: [] }, fallidos = [];
    for (let i = 0; i < lotes.length; i++) {
      if (!$('#fgProg')) break;   // se cerró la ventana
      $('#fgProg').innerHTML = `<p class="muted">Subiendo grupo ${i + 1} de ${lotes.length} · ✔ ${nf(tot.nuevas)} nuevas · = ${nf(tot.duplicadas)} ya estaban · ✕ ${nf(tot.omitidas)} omitidas${fallidos.length ? ' · ⚠️ ' + fallidos.length + ' grupo(s) con error' : ''}</p>
        <div style="height:6px;background:var(--borde);border-radius:3px"><div style="height:6px;width:${Math.round(i / lotes.length * 100)}%;background:var(--marca);border-radius:3px"></div></div>`;
      let r = null;
      for (let intento = 0; intento < 2 && !r; intento++) {
        try { const archivos = []; for (const f of lotes[i]) archivos.push({ nombre: f.name, dataUri: await leerArchivo(f) });
          r = await pedir(S.subirDest === 'compra' ? 'subirFacturasCompra' : 'subirFacturasGasto', { archivos: archivos, estricto: estricto }, true); } catch (e) { if (intento) fallidos.push(lotes[i].map(f => f.name).join(', ')); }
      }
      if (r) { ['nuevas', 'duplicadas', 'omitidas', 'porClasificar'].forEach(k => tot[k] += r[k] || 0); tot.detalle.push(...r.detalle); }
    }
    if (fallidos.length) fallidos.forEach(n => tot.detalle.push({ estado: 'omitida', archivo: n.slice(0, 120), motivo: 'No se pudo subir (vuelve a subir estos; los que ya entraron no se duplican)' }));
    if (fallidos.length) tot.omitidas += fallidos.length;
    resultadoFacturasGasto('Facturas subidas', tot); if (S.subirDest === 'compra') { if ($('#cCont')) bandejaCfdi(); } else { S.datGasKey = ''; cargarGastos(); }
  }
  function resultadoFacturasGasto(tit, r, extra) {
    const ic = { nueva: '✔', duplicada: '=', omitida: '✕' };
    modal(tit, `<div class="kpis">${[['Nuevas', r.nuevas], ['Ya estaban', r.duplicadas], ['Omitidas', r.omitidas], ['Por clasificar', r.porClasificar || r.detalle.filter(x => x.categoria === 'POR CLASIFICAR').length]].map(k => `<div class="kpi"><small>${k[0]}</small><b>${nf(k[1])}</b></div>`).join('')}</div>` +
      (r.detalle.length ? tabla([{ t: '', h: x => ic[x.estado] || '' }, { t: 'Proveedor', h: x => `<b>${esc(x.emisor || x.archivo || '')}</b>${x.de ? `<br><small class="muted">${esc(x.de)}</small>` : ''}` },
        { t: 'Total', num: 1, h: x => x.total ? $$(x.total) : '' }, { t: 'Resultado', h: x => x.compra && x.estado === 'nueva' ? `🧾 Compra · ${esc(x.accion || '')}${x.motivo ? '<br><small class="muted">' + esc(x.motivo) + '</small>' : ''}` : esc(x.estado === 'nueva' ? x.categoria : x.motivo || '') }], r.detalle) : '<p class="muted">No había facturas nuevas.</p>') +
      (extra || '') + `<div class="acciones"><button class="btn primario" onclick="App.cerrarModal()">Listo</button></div>`);
  }
  async function correoGastos() {
    modal('Facturas por correo', '<div class="vacio">Cargando…</div>');
    let e; try { e = await pedir('estadoCorreoGastos', {}); } catch (x) { $('#modalCuerpo').innerHTML = '<div class="vacio">Requiere conexión.</div>'; return; }
    const fh = s => s ? new Date(s).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
    $('#modalCuerpo').innerHTML = `<p>${e.activo ? '🟢 <b>Revisión automática activa</b> (cada hora)' : '⚪ <b>Revisión automática apagada</b> — se activa desde el editor de Apps Script (función <code>activarCorreoGastos</code>).'}</p>
      <p class="muted">Correo que se revisa: <b>${esc(e.correo)}</b> · facturas desde ${esc(e.desde || 'el día 1 del mes')} · última revisión: ${esc(fh(e.ultima))}</p>
      ${e.gmail ? '' : '<p class="error">Falta habilitar el servicio Gmail en el proyecto.</p>'}
      <details style="margin:8px 0"><summary><b>Cómo mandar aquí las facturas de otro correo</b> (p. ej. manolocaaf@gmail.com)</summary><ol class="peq" style="margin:6px 0 0 18px;line-height:1.5">
        <li>Entra a Gmail con la cuenta que recibe las facturas › ⚙️ <b>Ver todos los ajustes</b> › <b>Reenvío y correo POP/IMAP</b> › <b>Añadir una dirección de reenvío</b> › escribe <b>${esc(e.correo)}</b>.</li>
        <li>Google manda un código a ${esc(e.correo)}: ábrelo y confirma.</li>
        <li>En la búsqueda de Gmail escribe <code>has:attachment filename:xml</code> › ícono de filtros › <b>Crear filtro</b> › marca <b>Reenviarlo a</b> ${esc(e.correo)} › <b>Crear filtro</b>.</li>
        <li>Listo: cada factura que llegue se reenvía y la app la registra sola (con su PDF) en la siguiente revisión.</li></ol></details>
      <h4 style="margin:10px 0 4px">Últimos correos revisados</h4>` +
      tabla([{ t: 'Revisado', k: 'fecha' }, { t: 'De / asunto', h: x => `<b>${esc(x.de)}</b><br><small class="muted">${esc(x.asunto)}</small>` }, { t: 'Nuevas', num: 1, h: x => nf(x.facturas) }, { t: 'Resultado', h: x => `<small>${esc(x.resultado)}</small>` }], e.ultimos, { vacio: 'Todavía no se revisa ningún correo' }) +
      `<div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cerrar</button><button class="btn primario" id="cgBtn" onclick="App.revisarCorreoGastos()">✉️ Revisar ahora</button></div>`;
  }
  async function revisarCorreoGastos() {
    $('#cgBtn').disabled = true; $('#cgBtn').textContent = 'Revisando…';
    try { const r = await pedir('revisarCorreoGastos', {}); S.cfdiCompras = null; resultadoFacturasGasto('Revisión de correo · ' + nf(r.revisados) + ' correo(s)', r, r.pendientes ? `<p class="muted">Quedan ${nf(r.pendientes)} correos por revisar: vuelve a tocar "Revisar ahora" o espera la revisión automática.</p>` : ''); S.datGasKey = ''; cargarGastos(); }
    catch (x) { if ($('#cgBtn')) { $('#cgBtn').disabled = false; $('#cgBtn').textContent = '✉️ Revisar ahora'; } }
  }
  function filtrarCatGasto(cat) { S.fgas.categoria = cat; S.tabGas = 'facturas'; V.gastos('facturas'); $('#gCat').value = cat; cargarGastos(); }
  function pdfGastos() { const f = leerFiltrosGas(); generarPdf('pdfGastos', f, { asunto: 'Estado de gastos', texto: 'Interés Veterinario — Estado de gastos ' + f.desde + ' a ' + f.hasta, volver: 'App.cerrarModal()' }); }


  /* ---------- SUCURSALES (rentabilidad, solo el dueño) ---------- */
  V.sucursales = () => {
    const h = hoyISO();
    if (!S.fsuc) S.fsuc = { desde: h.slice(0, 8) + '01', hasta: h, hastaHoy: h };
    alDia(S.fsuc);
    $('#vista').innerHTML = `<div class="tarjeta no-imprimir"><div class="fila"><label>Desde<input type="date" id="sDesde" value="${S.fsuc.desde}"></label><label>Hasta<input type="date" id="sHasta" value="${S.fsuc.hasta}"></label>
      <button class="btn primario fijo" onclick="App.cargarSucursales()">Actualizar</button></div></div><div class="espacio"></div><div id="sRes"><div class="vacio">Cargando…</div></div>`;
    agregarMesAnio('sDesde', 'sHasta', cargarSucursales);
    cargarSucursales();
  };
  async function cargarSucursales() {
    S.fsuc = marcarHoy({ desde: $('#sDesde').value, hasta: $('#sHasta').value });
    $('#sRes').innerHTML = '<div class="vacio">Calculando…</div>';
    try { S.datSuc = await pedir('sucursalesResumen', S.fsuc); } catch (e) { $('#sRes').innerHTML = '<div class="vacio">Requiere conexión.</div>'; return; }
    pintarSucursales();
  }
  const pctTxt = v => v === null || v === undefined ? '—' : v.toFixed(1) + '%';
  const claseMg2 = m => m < 0 ? 'mal' : m < 10 ? 'av' : 'ok';
  function pintarSucursales() {
    const r = S.datSuc, T = r.totales, L = r.sucursales;
    S.charts.forEach(c => c.destroy()); S.charts = [];
    S.lista = L;
    const kpi = (t, v, s) => `<div class="kpi"><small>${t}</small><b>${v}</b><span>${s || ''}</span></div>`;
    $('#sRes').innerHTML = `<div class="kpis">
      ${kpi('Ventas netas', $$(T.ventas), nf(T.notas) + ' notas · ' + r.periodo.dias + ' días')}
      ${kpi('Utilidad bruta', $$(T.utilidadBruta), 'margen ' + pctTxt(T.margenBruto))}
      ${kpi('Contribución de sucursales', $$(T.contribucion), 'después de mermas, gastos y depreciación')}
      ${kpi('Utilidad neta', $$(T.utilidadNeta), 'margen ' + pctTxt(T.margenNeto))}
      ${kpi('Inventario a costo real', $$(T.inventario), (T.diasInventario === null ? '' : T.diasInventario + ' días de inventario · ') + 'GMROI ' + (T.gmroi === null ? '—' : T.gmroi))}
      ${kpi('Por cobrar', $$(T.cxc), 'vencido ' + $$(T.cxcVencida))}</div>
      <div class="tarjeta"><h3>Rentabilidad por sucursal · ${esc(r.periodo.desde)} al ${esc(r.periodo.hasta)}</h3>` +
      tabla([{ t: 'Sucursal', h: x => `<div class="con-avatar">${avatarSuc(x.suc)}<div><b>${esc(x.nombre)}</b><br><small class="muted">${esc(x.tipo)}</small></div></div>` }, { t: 'Ventas', num: 1, h: x => $$(x.ventas) },
        { t: '% del total', num: 1, cls: 'ocultar-movil', h: x => T.ventas ? (x.ventas / T.ventas * 100).toFixed(1) + '%' : '—' },
        { t: 'Utilidad bruta', num: 1, h: x => `${$$(x.utilidadBruta)}<br><span class="etq ${claseMg2(x.margenBruto)}">${pctTxt(x.margenBruto)}</span>` },
        { t: 'Mermas', num: 1, cls: 'ocultar-movil', h: x => $$(x.mermas) }, { t: 'Gastos + depr.', num: 1, cls: 'ocultar-movil', h: x => $$(x.operacion + x.depreciacion) },
        { t: 'Contribución', num: 1, h: x => `<b class="${x.contribucion < 0 ? 'error' : ''}">${$$(x.contribucion)}</b><br><span class="etq ${claseMg2(x.margenContribucion)}">${pctTxt(x.margenContribucion)}</span>` },
        { t: 'Financieros', num: 1, cls: 'ocultar-movil', h: x => $$(x.financiero) },
        { t: 'Utilidad neta', num: 1, h: x => `<b class="${x.utilidadNeta < 0 ? 'error' : ''}">${$$(x.utilidadNeta)}</b>` }], L, { clic: 'App.verSucursal' }) + `</div>
      <div class="rejilla-2"><div class="tarjeta"><h3>Ventas vs contribución</h3><div class="grafica"><canvas id="sgBar"></canvas></div></div>
      <div class="tarjeta"><h3>Inventario y cartera</h3>` +
      tabla([{ t: 'Sucursal', h: x => `<b>${esc(x.nombre)}</b>` }, { t: 'Inventario', num: 1, h: x => $$(x.inventario) }, { t: 'Días inv.', num: 1, h: x => x.diasInventario === null ? '—' : nf(x.diasInventario) },
        { t: 'GMROI', num: 1, h: x => x.gmroi === null ? '—' : x.gmroi }, { t: 'Por caducar', num: 1, cls: 'ocultar-movil', h: x => x.porCaducar ? `<span class="etq av">${$$(x.porCaducar)}</span>` : '—' },
        { t: 'Caducado', num: 1, cls: 'ocultar-movil', h: x => x.caducado ? `<span class="etq mal">${$$(x.caducado)}</span>` : '—' }, { t: 'Por cobrar', num: 1, h: x => $$(x.cxc) }], L, { clic: 'App.verSucursal' }) + `</div></div>
      <div class="tarjeta"><h3>¿Cómo leer estos indicadores?</h3><p class="muted"><b>Contribución</b> = utilidad bruta − mermas − gastos de operación − depreciación asignados a la sucursal: lo que la sucursal deja para cubrir lo financiero y la utilidad. Si es negativa, la sucursal cuesta más de lo que aporta.
      <b>Días de inventario</b> = cuántos días de venta (a costo) tienes en anaquel; menos es mejor. <b>GMROI</b> = utilidad bruta anualizada ÷ inventario: cuántos pesos de utilidad genera cada peso invertido en mercancía al año (arriba de 2 es sano en distribución). Los gastos se asignan en Gastos › Facturas (sin asignar = Matriz; "Prorrateo" = según % de ventas).</p></div>`;
    cargarAvatares($('#sRes'));
    grafica('sgBar', { type: 'bar', data: { labels: L.map(x => x.nombre), datasets: [
      { label: 'Ventas', data: L.map(x => x.ventas), backgroundColor: css('--s1'), borderRadius: 4, maxBarThickness: 28 },
      { label: 'Contribución', data: L.map(x => x.contribucion), backgroundColor: css('--s3'), borderRadius: 4, maxBarThickness: 28 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + $$(c.raw) } } },
        scales: { y: { ticks: { callback: tickMoneda } }, x: { grid: { display: false } } } } });
  }
  function verSucursal(i) {
    const x = S.datSuc.sucursales[i];
    const pct = v => x.ventas ? (v / x.ventas * 100).toFixed(1) + '%' : '—';
    const fila = (t, v, neg, tot) => `<tr class="${tot ? 'res-total' : ''}"><td>${neg ? '<span style="padding-left:16px"></span>' : ''}${t}</td><td class="num ${!neg && v < 0 ? 'error' : ''}">${neg ? '−' + $$(Math.abs(v)) : $$(v)}</td><td class="num muted">${pct(v)}</td></tr>`;
    const kpi = (t, v, s) => `<div class="kpi"><small>${t}</small><b>${v}</b><span>${s || ''}</span></div>`;
    modal('🔒 ' + x.nombre, `<div class="arch-par">${bloqueFotoSuc(x.suc)}</div><div class="kpis">${kpi('Notas', nf(x.notas), 'ticket ' + $$(x.ticket))}${kpi('Clientes', nf(x.clientes), 'compraron en el periodo')}${kpi('Cobrado', $$(x.cobrado), 'por cobrar ' + $$(x.cxc) + ' · vencido ' + $$(x.cxcVencida))}
      ${kpi('Inventario', $$(x.inventario), nf(x.piezas) + ' pzs · ' + nf(x.productos) + ' productos')}${kpi('Días de inventario', x.diasInventario === null ? '—' : nf(x.diasInventario), 'GMROI ' + (x.gmroi === null ? '—' : x.gmroi))}
      ${kpi('Traspasos', $$(x.traspasosRecibidos), 'recibidos · enviados ' + $$(x.traspasosEnviados))}</div>
      <div class="rejilla-2"><div><h4>Estado de resultados</h4><div class="tabla-cont"><table class="estado-res"><tbody>
      ${fila('Ventas netas', x.ventas)}${fila('Costo real de lo vendido', x.costo, 1)}${fila('<b>Utilidad bruta</b>', x.utilidadBruta, 0, 1)}${fila('Mermas', x.mermas, 1)}${fila('Gastos de operación', x.operacion, 1)}
      ${fila('<b>Contribución</b>', x.contribucion, 0, 1)}${fila('Gastos financieros', x.financiero, 1)}${fila('<b>Utilidad neta</b>', x.utilidadNeta, 0, 1)}</tbody></table></div>
      ${x.depreciacion ? `<p class="muted" style="margin-top:6px">Aparte (no se resta de la utilidad neta): depreciación estimada de sus inversiones ${$$(x.depreciacion)}.</p>` : ''}
      <p class="muted" style="margin-top:6px">Inventario por caducar ${$$(x.porCaducar)} · caducado ${$$(x.caducado)}.</p></div>
      <div><h4>Últimos 12 meses</h4><div class="grafica"><canvas id="sgMes"></canvas></div></div></div>
      <div class="acciones">${puede('ventas') ? `<button class="btn" onclick="App.ventasDeSucursal('${esc(x.suc)}')">🧾 Ver sus ventas</button>` : ''}${puede('traspasos') ? `<button class="btn primario" onclick="App.traspasosDeSucursal('${esc(x.suc)}')">🔁 Ver sus traspasos (histórico)</button>` : ''}</div>`);
    grafica('sgMes', { type: 'line', data: { labels: S.datSuc.meses, datasets: [
      { label: 'Ventas', data: x.meses.map(m => m.ventas), borderColor: css('--s1'), backgroundColor: css('--s1'), tension: .25, borderWidth: 2, pointRadius: 2 },
      { label: 'Utilidad bruta', data: x.meses.map(m => m.utilidad), borderColor: css('--s3'), backgroundColor: css('--s3'), tension: .25, borderWidth: 2, pointRadius: 2 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + $$(c.raw) } } },
        scales: { y: { ticks: { callback: tickMoneda } }, x: { grid: { display: false } } } } });
  }

  /* ---------- COBRANZA ---------- */
  V.cobranza = (barra) => {
    const h = hoyISO(), ini = h.slice(0, 8) + '01';
    $('#vista').innerHTML = (barra || '') + `<div class="tarjeta"><div class="fila">
      <label>Desde<input type="date" id="cDesde" value="${ini}"></label><label>Hasta<input type="date" id="cHasta" value="${h}"></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="cSuc">${optsSuc('', false, 'Todas')}</select></label>` : ''}
      <label>Forma de pago<select id="cForma">${opts((D().catalogos || {}).formasPago || [], '', 'Todas')}</select></label>
      <label>Buscar<input id="cTxt" placeholder="Cliente o folio"></label><button class="btn primario fijo" onclick="App.buscarCobros()">Buscar</button></div>
      <p class="muted" style="margin:10px 0 0;font-size:12.5px">Para ver lo que falta cobrar usa la pestaña Notas de venta › “Cuentas por cobrar”.</p></div>
      <div class="espacio"></div><div id="lCob"></div>`;
    agregarMesAnio('cDesde', 'cHasta', buscarCobros);
    buscarCobros();
  };
  async function buscarCobros() {
    try {
      const l = await pedir('listarCobros', { desde: $('#cDesde').value, hasta: $('#cHasta').value, sucursal: $('#cSuc') ? $('#cSuc').value : '', forma: $('#cForma').value, texto: $('#cTxt').value });
      if (!$('#lCob')) return;
      S.lista = l;
      const tot = l.reduce((a, x) => a + x.monto, 0);
      const porForma = {};
      l.forEach(x => { const k = x.forma || 'Sin forma'; porForma[k] = (porForma[k] || 0) + x.monto; });
      $('#lCob').innerHTML = `<div class="kpis"><div class="kpi"><small>Total cobrado</small><b>${$$(tot)}</b><span>${l.length} ${l.length === 1 ? 'cobro' : 'cobros'}</span></div>
        ${Object.keys(porForma).sort((a, b) => porForma[b] - porForma[a]).map(k => `<div class="kpi"><small>${esc(k)}</small><b>${$$(porForma[k])}</b></div>`).join('')}</div>` + tabla([
        { t: 'Fecha', k: 'fecha' }, { t: 'Nota', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Cliente', k: 'cliente' },
        { t: 'Sucursal', cls: 'ocultar-movil', h: x => esc(sucNom(x.suc)) }, { t: 'Forma de pago', k: 'forma' }, { t: 'Cuenta', cls: 'ocultar-movil', k: 'banco' },
        { t: 'Monto', num: 1, h: x => `<b>${$$(x.monto)}</b>` }, { t: '📎', h: x => x.adj ? `<span title="${x.adj} comprobante(s)">📎${x.adj > 1 ? x.adj : ''}</span>` : '<span class="muted" title="Sin comprobante">—</span>' },
        { t: 'Nota del cobro', cls: 'ocultar-movil', k: 'nota' }
      ], l, { clic: 'App.abrirCobro', vacio: 'No hay cobros en ese periodo' });
    } catch (e) { if ($('#lCob')) $('#lCob').innerHTML = '<div class="vacio">Consultar cobros requiere conexión.</div>'; }
  }
  function formCobro(idVenta, saldo) {
    const cat = D().catalogos;
    const s = saldo !== undefined ? saldo : (S.ultimaVenta && S.ultimaVenta.id === idVenta ? S.ultimaVenta.saldo : '');
    modal('Registrar cobro', `<div class="rejilla">
      <label>Monto $<input type="number" id="cbMonto" step="0.01" value="${s}"></label>
      <label>Fecha<input type="date" id="cbFecha" value="${hoyISO()}"></label>
      <label>Forma de pago<select id="cbForma">${opts(cat.formasPago, '1')}</select></label>
      <label>Cuenta / caja<select id="cbBanco">${opts(cat.bancos, 'EFECTI10')}</select></label>
      <label style="grid-column:1/-1">Nota<input id="cbNota"></label>
      <label style="grid-column:1/-1">Comprobante (foto y/o PDF, opcional — puedes elegir ambos)<input type="file" id="cbArch" multiple accept="image/&#42;,application/pdf"></label></div>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.guardarCobro('${idVenta}')">Guardar cobro</button></div>`);
  }
  async function guardarCobro(idVenta) {
    const p = { ID_Venta: idVenta, ID_Cobranza: uid(), monto: Number($('#cbMonto').value), fecha: $('#cbFecha').value, forma: $('#cbForma').value, banco: $('#cbBanco').value, nota: $('#cbNota').value };
    if (!(p.monto > 0)) return toast('Captura el monto', true);
    let adjs;
    try { adjs = await leerComprobantes($('#cbArch'), navigator.onLine === false ? 1200 : 1600); } catch (e) { return toast(e.message || 'No se pudo leer el comprobante', true); }
    const adj = adjs.length;
    const encolarAdj = () => {
      let av = '';
      adjs.forEach(u => { if (u.length > 900000) av = ' Un comprobante es pesado: agrégalo desde el cobro cuando tengas señal.'; else encolar('subirAdjuntoCobro', { ID_Cobranza: p.ID_Cobranza, dataUri: u }, 'Comprobante del cobro ' + $$(p.monto)); });
      return av;
    };
    let r;
    try { r = await pedir('guardarCobro', p); }
    catch (e) { if (e.red) { encolar('guardarCobro', p, 'Cobro ' + $$(p.monto)); const av = encolarAdj(); cerrarModal(); toast('📴 Cobro guardado en el dispositivo; se enviará al reconectar.' + av, !!av); } return; }
    if (S.cacheTot) S.cacheTot = {};
    let msg = '✔ Cobro registrado. Saldo: ' + $$(r.saldo);
    if (adj) {
      try { for (const u of adjs) await pedir('subirAdjuntoCobro', { ID_Cobranza: p.ID_Cobranza, dataUri: u }); msg += adjs.length > 1 ? ' · foto y PDF adjuntos' : ' · comprobante adjunto'; }
      catch (e) { if (e.red) { const av = encolarAdj(); msg += av || ' · el comprobante se enviará al reconectar'; } else msg += ' · el comprobante no se pudo subir, agrégalo desde el cobro'; }
    }
    toast(msg); cerrarModal(); if ($('#lCob')) buscarCobros(); if ($('#lVentas')) buscarVentas();
  }

  /* ---------- COMPRAS ---------- */
  V.compras = (tab) => {
    tab = tab || 'lista';
    if (tab === 'pagos' && !puede('pagos_proveedor')) tab = 'lista';
    $('#vista').innerHTML = `<div class="pestanas"><button class="${tab === 'lista' ? 'activo' : ''}" onclick="App.vistaCompras('lista')">Órdenes de compra</button>
      ${puede('pagos_proveedor') ? `<button class="${tab === 'pagos' ? 'activo' : ''}" onclick="App.vistaCompras('pagos')">💳 Pagos a proveedores</button>` : ''}
      ${verBandejaCfdi() ? `<button class="${tab === 'cfdi' ? 'activo' : ''}" onclick="App.vistaCompras('cfdi')">🧾 Facturas de proveedores<span id="cfdiN"></span></button>` : ''}
      <button class="${tab === 'nueva' ? 'activo' : ''}" onclick="App.vistaCompras('nueva')">${S.oc && S.oc.editId ? '✏️ Editando ' + esc(S.oc.folio) : '+ Nueva orden'}</button></div><div id="cCont"></div>`;
    tab === 'lista' ? listaCompras() : tab === 'pagos' ? listaPagosProv() : tab === 'cfdi' && verBandejaCfdi() ? bandejaCfdi() : nuevaCompra();
    if (tab !== 'cfdi' && verBandejaCfdi()) contarCfdi();
  };

  /* ---------- FACTURAS Y NOTAS DE CRÉDITO DE PROVEEDORES (CFDI por correo o subidos) ---------- */
  const verBandejaCfdi = () => puede('compras') && !!U().todasSucursales;
  async function contarCfdi() {
    try { const r = await pedir('comprasCfdi', {}); S.cfdiCompras = r; const el = $('#cfdiN'); if (el) el.innerHTML = r.pendientes.length ? ` <span class="etq" style="background:var(--aviso);color:#fff">${r.pendientes.length}</span>` : ''; } catch (e) {}
  }
  async function bandejaCfdi() {
    $('#cCont').innerHTML = '<div class="vacio">Cargando…</div>';
    let r; try { r = S.cfdiCompras = await pedir('comprasCfdi', {}); } catch (e) { if ($('#cCont')) $('#cCont').innerHTML = '<div class="vacio">Requiere conexión.</div>'; return; }
    if (!$('#cCont')) return;
    const el = $('#cfdiN'); if (el) el.innerHTML = r.pendientes.length ? ` <span class="etq" style="background:var(--aviso);color:#fff">${r.pendientes.length}</span>` : '';
    const optsSug = x => x.sugeridas.map(o => `<option value="${esc(o.id)}">${o.igual ? '✓ ' : ''}${esc(o.folio)} · ${esc(o.fecha)} · ${$$(o.total)}${o.saldo !== undefined ? ' · saldo ' + $$(o.saldo) : ''}${o.factura ? ' · fact. ' + esc(o.factura) : ''}</option>`).join('');
    const EST_REP = { ligado: ['ok', '✔ ligado al pago'], 'sin pago': ['av', 'pago sin capturar'], 'sin orden': ['mal', 'la factura no está en ninguna orden'], excede: ['mal', 'mayor que el saldo de la orden'] };
    const tarjetaRep = (x, i) => `<div class="tarjeta" style="border-left:4px solid var(--s2, #3b82f6)">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><span class="etq">💳 Complemento de pago</span> <b>${esc(x.emisor)}</b><br><small class="muted">${esc(x.rfc)} · ${esc(x.folio)} · ${esc(x.fecha)}${x.origen ? ' · ' + esc(x.origen) : ''}</small></div>
      <div style="text-align:right"><b style="font-size:18px">${$$(Math.abs(x.total))}</b><br><small class="muted">pagado en ${(x.detalle || []).length} factura(s)</small></div></div>
      <div class="tabla-cont" style="margin-top:8px"><table><thead><tr><th>Factura</th><th>Orden</th><th>Fecha de pago</th><th class="num">Pagado</th><th>Estado</th></tr></thead><tbody>
      ${(x.detalle || []).map(d => `<tr><td><b>${esc(d.folio)}</b>${d.parc ? ' <small class="muted">parc. ' + esc(d.parc) + '</small>' : ''}</td><td>${d.idOC ? `<a href="#" onclick="App.abrirCompraId('${esc(d.idOC)}');return false">${esc(d.folioOC)}</a>` : '—'}</td><td>${esc(String(d.fecha || '').split('-').reverse().join('/'))}</td><td class="num">${$$(d.imp)}</td>
        <td><span class="etq ${(EST_REP[d.estado] || ['', ''])[0]}">${esc((EST_REP[d.estado] || ['', d.estado])[1])}</span>${d.estado === 'excede' ? ' <small class="muted">saldo ' + $$(d.saldo) + '</small>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No se pudieron leer las facturas del complemento</td></tr>'}</tbody></table></div>
      <div class="fila" style="margin-top:6px"><span class="muted peq" style="flex:3 1 260px">${(x.detalle || []).some(d => d.estado === 'sin pago') ? 'Si ya pagaste y no lo capturaste, regístralo con los datos del complemento (monto, fecha y forma de pago).' : (x.detalle || []).some(d => d.estado === 'sin orden') ? 'Liga primero la factura a su orden de compra y luego da Reintentar.' : ''}</span>
        ${(x.detalle || []).some(d => d.estado === 'sin pago') && puede('pagos_proveedor') ? `<button class="btn primario fijo" onclick="App.aplicarRep('${esc(x.uuid)}', true)">💳 Registrar pago(s)</button>` : ''}
        <button class="btn fijo" onclick="App.aplicarRep('${esc(x.uuid)}', false)">↻ Reintentar</button>
        <button class="btn fijo" onclick="App.verPdfCfdi('${esc(x.uuid)}')">📄 PDF</button>
        <button class="btn fijo" onclick="App.descartarCfdi('${esc(x.uuid)}')">Descartar</button></div></div>`;
    const tarjeta = (x, i) => x.tipo === 'Complemento de pago' ? tarjetaRep(x, i) : `<div class="tarjeta" style="border-left:4px solid ${x.tipo === 'Factura' ? 'var(--marca)' : 'var(--aviso)'}">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><span class="etq">${esc(x.tipo)}</span> <b>${esc(x.emisor)}</b><br><small class="muted">${esc(x.rfc)} · ${esc(x.folio)} · ${esc(x.fecha)}${x.origen ? ' · ' + esc(x.origen) : ''}</small></div>
      <div style="text-align:right"><b style="font-size:18px">${$$(Math.abs(x.total))}</b><br><small class="muted">IVA ${$$(Math.abs(x.iva))}</small></div></div>
      ${x.nota ? `<p class="peq" style="margin:6px 0;color:var(--aviso)">⚠️ ${esc(x.nota)}</p>` : ''}
      ${x.tipo === 'Factura' && x.sugeridas.length ? `<div style="margin-top:8px"><small class="muted">Palomea la orden u órdenes que cubre esta factura (puede juntar varias, aunque ya estén recibidas):</small>
        <div class="cfdi-ocs" data-i="${i}" style="display:grid;gap:4px;margin-top:6px;max-height:240px;overflow:auto">${x.sugeridas.map(o => `<label class="check" style="align-items:flex-start"><input type="checkbox" value="${esc(o.id)}" data-t="${o.total}" ${o.sel ? 'checked' : ''} onchange="App.sumaCfdi(${i})">
          <span><b>${esc(o.folio)}</b> · ${esc(o.fecha)} · ${$$(o.total)}${o.recibida ? ' · recibida' : ' · por recibir'}${o.factura ? ` · <span class="${o.conUuid ? 'txt-mal' : 'muted'}">fact. ${esc(o.factura)}</span>` : ''}${o.rel ? ' · <b>esta factura la sustituye</b>' : ''}</span></label>`).join('')}</div>
        <div id="cfdiSum${i}" class="peq" style="margin-top:6px"></div></div>` : ''}
      <div class="fila" style="margin-top:6px">${x.tipo === 'Factura' ? (x.sugeridas.length ? `<span style="flex:3 1 260px"></span><button class="btn primario fijo" onclick="App.ligarCfdi(${i})">🔗 Ligar</button>` : '<span class="muted peq" style="flex:3 1 260px">No hay órdenes de este proveedor en los últimos 12 meses.</span>')
        : x.sugeridas.length ? `<label style="flex:3 1 260px">Aplicar a la orden<select id="cfdiOC${i}">${optsSug(x)}</select></label>
        <button class="btn primario fijo" onclick="App.ligarCfdi(${i})">✔ Aplicar</button>` : `<span class="muted peq" style="flex:3 1 260px">No hay órdenes de este proveedor con saldo suficiente.</span>`}
        <button class="btn fijo" onclick="App.verPdfCfdi('${esc(x.uuid)}')">📄 PDF</button>
        ${x.tipo === 'Factura' ? `<button class="btn fijo" onclick="App.ocDesdeCfdi('${esc(x.uuid)}')">➕ Crear orden</button>` : ''}
        <button class="btn fijo" onclick="App.descartarCfdi('${esc(x.uuid)}')">Descartar</button></div></div>`;
    $('#cCont').innerHTML = `<div class="tarjeta"><div class="fila"><div style="flex:3 1 280px"><b>Facturas, notas de crédito y complementos de pago de proveedores</b><br><small class="muted">Se reconocen por el RFC del catálogo de proveedores. Las claras se ligan solas a su orden (mismo proveedor y mismo total), las notas de crédito con factura relacionada se aplican solas y los complementos de pago (REP) se ligan al pago capturado del mismo monto. Aquí quedan las que necesitan que elijas.${U().rol === 'Administrador' || puede('dueno') ? ' Las que llegan por correo se revisan cada hora (Gastos › ✉️ Correo).' : ''}</small></div>
      <button class="btn fijo" onclick="App.formFacturasGasto('compra')">📥 Subir facturas</button></div></div>
      <h3 style="margin:12px 0 6px">Por ligar (${r.pendientes.length})</h3>${r.pendientes.length ? r.pendientes.map(tarjeta).join('') : '<div class="vacio">✔ No hay facturas pendientes</div>'}
      <div class="tarjeta"><h3>Últimas ligadas o aplicadas</h3>` + tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Tipo', h: x => `<span class="etq">${esc(x.tipo)}</span>` }, { t: 'Proveedor', h: x => `<b>${esc(x.emisor)}</b><br><small class="muted">${esc(x.folio)}</small>` },
        { t: 'Total', num: 1, h: x => $$(x.total) }, { t: 'Estado', h: x => esc(x.estado) + (x.nota ? `<br><small class="muted">${esc(x.nota)}</small>` : '') }, { t: 'Orden', h: x => { const ids = String(x.idOC || '').split(/\s*,\s*/).filter(String), fs = String(x.orden || '').split(/\s*,\s*/); return ids.map((id, k) => `<a href="#" onclick="App.abrirCompraId('${esc(id)}');return false">${esc(fs[k] || id)}</a>`).join('<br>'); } },
        { t: 'PDF', h: x => `<button class="btn chico" onclick="App.verPdfCfdi('${esc(x.uuid)}')">📄</button>` + (x.tipo === 'Factura' && x.estado === 'Ligada' ? ` <button class="btn chico" title="Corregir a qué órdenes está ligada" onclick="App.cambiarOrdenesCfdi('${esc(x.uuid)}')">✏️ Cambiar órdenes</button>` : '') }], r.recientes, { vacio: 'Todavía no hay' }) + '</div>';
    r.pendientes.forEach((x, i) => { if (x.tipo === 'Factura') sumaCfdi(i); });
  }
  async function aplicarRep(uuid, registrar) {
    const x = (S.cfdiCompras.pendientes || []).find(y => y.uuid === uuid) || {};
    const falt = (x.detalle || []).filter(d => d.estado === 'sin pago');
    if (registrar && !confirm('Se registran ' + falt.length + ' pago(s) con los datos del complemento ' + (x.folio || '') + ':\n' + falt.map(d => '· ' + d.folioOC + ' (fact. ' + d.folio + '): ' + $$(d.imp) + ' del ' + d.fecha).join('\n') + '\n¿Continuar?')) return;
    try { const r = await pedir('aplicarRepCompra', { uuid: uuid, registrar: !!registrar }); toast(r.todos ? '✔ Complemento ligado a ' + r.ligados + ' pago(s)' : 'Ligados ' + r.ligados + ' de ' + r.detalle.length); S.cacheTot = {}; bandejaCfdi(); } catch (e) {}
  }
  /** Corregir las órdenes de una factura ya ligada. */
  async function cambiarOrdenesCfdi(uuid) {
    let d; try { d = await pedir('ordenesFacturaCompra', { uuid: uuid }); } catch (e) { return; }
    S.cfdiCambio = d;
    modal('✏️ Órdenes de la factura ' + d.folio, `<p class="muted" style="margin-top:0">${esc(d.emisor)} · total <b>${$$(d.total)}</b>. Palomea las órdenes que cubre esta factura. Las que desmarques regresan a como estaban antes (su factura anterior o sin factura); no se borra ningún archivo.</p>
      <div class="cfdi-ocs" data-i="cambio" style="display:grid;gap:4px;max-height:50vh;overflow:auto">${d.ordenes.map(o => `<label class="check" style="align-items:flex-start"><input type="checkbox" value="${esc(o.id)}" data-t="${o.total}" ${o.sel ? 'checked' : ''} onchange="App.sumaCfdiCambio()">
        <span><b>${esc(o.folio)}</b> · ${esc(o.fecha)} · ${$$(o.total)}${o.recibida ? ' · recibida' : ' · por recibir'}${o.factura && !o.sel ? ` · <span class="${o.conUuid ? 'txt-mal' : 'muted'}">fact. ${esc(o.factura)}</span>` : ''}${o.sel ? ' · <b>ligada ahora</b>' : ''}</span></label>`).join('')}</div>
      <div id="cfdiSumCambio" class="peq" style="margin-top:8px"></div>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.guardarCambioCfdi()">💾 Guardar</button></div>`);
    sumaCfdiCambio();
  }
  function sumaCfdiCambio() {
    const d = S.cfdiCambio, el = $('#cfdiSumCambio'); if (!d || !el) return;
    const ch = [...document.querySelectorAll('.cfdi-ocs[data-i="cambio"] input:checked')], suma = ch.reduce((a, c) => a + Number(c.dataset.t || 0), 0), dif = Math.round((suma - d.total) * 100) / 100;
    el.innerHTML = !ch.length ? '<span class="txt-mal">Palomea al menos una orden</span>' : `${ch.length} ${ch.length === 1 ? 'orden' : 'órdenes'}: <b>${$$(suma)}</b> · factura ${$$(d.total)} · ` + (Math.abs(dif) <= 1 ? '<b style="color:var(--marca)">✓ cuadra</b>' : `<b class="txt-mal">diferencia ${$$(dif)}</b>`);
  }
  async function guardarCambioCfdi() {
    const d = S.cfdiCambio; if (!d) return;
    const ids = [...document.querySelectorAll('.cfdi-ocs[data-i="cambio"] input:checked')].map(c => c.value);
    if (!ids.length) return toast('Palomea al menos una orden', true);
    const nuevas = d.ordenes.filter(o => ids.indexOf(o.id) >= 0 && !o.sel && o.conUuid);
    if (nuevas.length && !confirm('Estas órdenes ya tienen otra factura y se sustituye: ' + nuevas.map(o => o.folio + ' (fact. ' + o.factura + ')').join(', ') + '. ¿Continuar?')) return;
    try { const r = await pedir('reasignarFacturaCompra', { uuid: d.uuid, ids: ids }); cerrarModal(); toast('✔ Factura ' + d.folio + ' ligada a ' + r.orden + (r.quitadas.length ? ' · se quitó de ' + r.quitadas.join(', ') : '')); S.cacheTot = {}; bandejaCfdi(); } catch (e) {}
  }
  /** Suma de las órdenes palomeadas contra el total de la factura. */
  function sumaCfdi(i) {
    const x = S.cfdiCompras.pendientes[i], el = $('#cfdiSum' + i); if (!el) return;
    const ch = [...document.querySelectorAll('.cfdi-ocs[data-i="' + i + '"] input:checked')], suma = ch.reduce((a, c) => a + Number(c.dataset.t || 0), 0), dif = Math.round((suma - x.total) * 100) / 100;
    el.innerHTML = !ch.length ? '<span class="muted">Ninguna orden seleccionada</span>' : `${ch.length} ${ch.length === 1 ? 'orden' : 'órdenes'}: <b>${$$(suma)}</b> · factura ${$$(x.total)} · ` +
      (Math.abs(dif) <= 1 ? '<b style="color:var(--marca)">✓ cuadra</b>' : `<b class="txt-mal">diferencia ${$$(dif)}</b>`);
  }
  async function ligarCfdi(i) {
    const x = S.cfdiCompras.pendientes[i];
    if (x.tipo === 'Factura') {
      const ids = [...document.querySelectorAll('.cfdi-ocs[data-i="' + i + '"] input:checked')].map(c => c.value), sel = x.sugeridas.filter(o => ids.indexOf(o.id) >= 0);
      if (!sel.length) return toast('Palomea la orden u órdenes de esta factura', true);
      const suma = sel.reduce((a, o) => a + o.total, 0);
      if (Math.abs(suma - x.total) > 1 && !confirm('La suma de ' + (sel.length > 1 ? 'las órdenes' : 'la orden') + ' (' + $$(suma) + ') no es igual al total de la factura (' + $$(x.total) + '). ¿Ligar de todos modos?')) return;
      const conOtra = sel.filter(o => o.conUuid);
      if (conOtra.length && !confirm('Esta factura SUSTITUYE la que ya tenían: ' + conOtra.map(o => o.folio + ' (fact. ' + o.factura + ')').join(', ') + '. La anterior queda como "Sustituida" (sus archivos no se borran). ¿Continuar?')) return;
      try { const r = await pedir('ligarFacturaCompra', { uuid: x.uuid, ids: ids, reemplazar: conOtra.length > 0 }); toast('✔ Factura ligada a ' + r.orden + (r.notas && r.notas.length ? ' · también se aplicó: ' + r.notas.join(', ') : '')); bandejaCfdi(); } catch (e) {}
      return;
    }
    const id = $('#cfdiOC' + i).value, o = x.sugeridas.find(y => y.id === id);
    if (!o) return;
    if (x.tipo === 'Factura' && !o.igual && !confirm('El total de la orden (' + $$(o.total) + ') no es igual al de la factura (' + $$(x.total) + '). ¿Ligar de todos modos?')) return;
    if (x.tipo !== 'Factura' && !confirm('¿Aplicar la nota de crédito ' + x.folio + ' por ' + $$(Math.abs(x.total)) + ' a la orden ' + o.folio + '? Baja su saldo.')) return;
    try { const r = await pedir('ligarFacturaCompra', { uuid: x.uuid, ID_O_Compra: id }); toast('✔ ' + (x.tipo === 'Factura' ? 'Factura ligada a ' : 'Nota aplicada a ') + r.orden + (r.notas && r.notas.length ? ' · también se aplicó: ' + r.notas.join(', ') : '')); bandejaCfdi(); } catch (e) {}
  }
  async function descartarCfdi(uuid) {
    const m = prompt('¿Por qué la descartas? (ej. cancelada, duplicada, no es compra)'); if (m === null) return;
    try { await pedir('descartarFacturaCompra', { uuid: uuid, motivo: m }); toast('Descartada'); bandejaCfdi(); } catch (e) {}
  }
  async function verPdfCfdi(uuid) {
    toast('Abriendo PDF…');
    try { const r = await pedir('verPdfCompra', { uuid: uuid }); verPdf(b64aBytes(r.b64), r.nombre, { url: r.url }); if (r.generado) toast('No llegó PDF: se armó uno con los datos del XML'); } catch (e) {}
  }
  async function ocDesdeCfdi(uuid) {
    let d; try { d = await pedir('ocDesdeFactura', { uuid: uuid }); } catch (e) { return; }
    if (S.oc && S.oc.lineas && S.oc.lineas.length && !confirm('Ya tienes una orden de compra en captura. ¿Reemplazarla con esta factura?')) return;
    const ok = d.lineas.filter(l => l.id && prod(l.id)), sin = d.lineas.filter(l => !l.id || !prod(l.id));
    S.oc = { prov: d.prov, suc: sucTrabajo(), factura: d.factura, fecha: d.fecha, dias: d.dias || '', descEsp: 0, descPP: 0, flete: 0, recibido: false, actCosto: false,
      obs: 'Factura ' + d.factura, lineas: ok.map(l => ({ id: l.id, cant: l.cant, precio: l.precio, desc: 0, lote: '', cad: '' })), pago: 0,
      cfdi: { uuid: d.uuid, factura: d.factura, total: d.total, sin: sin } };
    V.compras('nueva');
    toast('Orden armada con la factura ' + d.factura + (sin.length ? ' · ' + sin.length + ' producto(s) por emparejar' : ''));
  }

  /* ---------- PAGOS A PROVEEDORES (hoja Pago_Proveedor) ---------- */
  function listaPagosProv() {
    const h = hoyISO(), ini = h.slice(0, 8) + '01';
    $('#cCont').innerHTML = `<div class="tarjeta"><div class="fila">
      <label>Desde<input type="date" id="ppDesde" value="${ini}"></label><label>Hasta<input type="date" id="ppHasta" value="${h}"></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="ppSuc">${optsSuc('', false, 'Todas')}</select></label>` : ''}
      <label>Buscar<input id="ppTxt" placeholder="Proveedor, orden o factura"></label>
      <label class="check fijo"><input type="checkbox" id="ppSinAdj"> Sin comprobante</label>
      <button class="btn primario fijo" onclick="App.buscarPagosProv()">Buscar</button></div></div>
      <div class="espacio"></div><div id="lPP"></div>`;
    $('#ppTxt').onkeydown = e => { if (e.key === 'Enter') buscarPagosProv(); };
    $('#ppSinAdj').onchange = buscarPagosProv;
    agregarMesAnio('ppDesde', 'ppHasta', buscarPagosProv);
    buscarPagosProv();
  }
  async function buscarPagosProv() {
    try {
      let l = await pedir('listarPagosProv', { desde: $('#ppDesde').value, hasta: $('#ppHasta').value, sucursal: $('#ppSuc') ? $('#ppSuc').value : '', texto: $('#ppTxt').value });
      if (!$('#lPP')) return;
      const todos = l;
      if ($('#ppSinAdj').checked) l = l.filter(x => !x.adj);
      S.lista = l;
      const pagos = todos.filter(x => !x.nc && !x.esNC), ncs = todos.filter(x => x.nc || x.esNC);
      const tot = pagos.reduce((a, x) => a + x.monto, 0), totNC = ncs.reduce((a, x) => a + x.monto, 0), sinAdj = todos.filter(x => !x.adj).length;
      const prov = {}; pagos.forEach(x => { const k = x.proveedor || 'Sin proveedor'; prov[k] = (prov[k] || 0) + x.monto; });
      const top = Object.keys(prov).sort((a, b) => prov[b] - prov[a]).slice(0, 2);
      $('#lPP').innerHTML = `<div class="kpis">
        <div class="kpi"><small>Pagado en el periodo</small><b>${$$(tot)}</b><span>${pagos.length} ${pagos.length === 1 ? 'pago' : 'pagos'}</span></div>
        ${ncs.length ? `<div class="kpi"><small>Notas de crédito aplicadas</small><b>${$$(totNC)}</b><span>${ncs.length} ${ncs.length === 1 ? 'nota' : 'notas'}</span></div>` : ''}
        ${top.map(k => `<div class="kpi"><small>${esc(k)}</small><b>${$$(prov[k])}</b><span>${tot > 0 ? Math.round(prov[k] / tot * 100) + ' % de lo pagado' : ''}</span></div>`).join('')}
        ${pagos.some(x => x.ppd && !x.rep) ? `<div class="kpi"><small>Falta complemento (REP)</small><b>${pagos.filter(x => x.ppd && !x.rep).length}</b><span>pagos de facturas PPD sin su REP</span></div>` : ''}
        <div class="kpi${sinAdj ? ' kpi-clic' : ''}" ${sinAdj ? 'onclick="App.pagosSinAdj()"' : ''}><small>Sin comprobante</small><b>${sinAdj}</b><span>${sinAdj ? 'pagos sin foto ni PDF' : 'todos tienen comprobante'}</span></div>
      </div>` + tabla([
        { t: 'Fecha', k: 'fecha' }, { t: 'Orden', h: x => `<b>${esc(x.folioOC)}</b>` }, { t: 'Proveedor', k: 'proveedor' }, { t: 'Factura', cls: 'ocultar-movil', k: 'factura' },
        { t: 'Forma de pago', cls: 'ocultar-movil', h: x => x.nc || x.esNC ? `<span class="etq">Nota de crédito ${esc(x.nc || '')}</span>` : esc(x.forma) }, { t: 'Cuenta', cls: 'ocultar-movil', k: 'banco' },
        { t: 'Monto', num: 1, h: x => `<b>${$$(x.monto)}</b>` }, { t: '📎', h: x => x.adj ? `<span title="${x.adj} archivo(s)">📎${x.adj > 1 ? x.adj : ''}</span>` : '<span class="muted" title="Sin comprobante">—</span>' },
        { t: 'REP', h: x => x.esNC || x.nc ? '' : x.rep ? '<span class="etq ok" title="Complemento de pago ligado">✔ REP</span>' : x.ppd ? '<span class="etq av" title="La factura es PPD: pide al proveedor el complemento de pago">Falta REP</span>' : '' },
        { t: 'Comentarios', cls: 'ocultar-movil', k: 'comentarios' }
      ], l, { clic: 'App.abrirPagoProv', vacio: 'No hay pagos en ese periodo' });
    } catch (e) { if ($('#lPP')) $('#lPP').innerHTML = '<div class="vacio">Consultar pagos requiere conexión.</div>'; }
  }
  async function verPagoProv(id) {
    let d; try { d = await pedir('detallePagoProv', { id: id }); } catch (e) { return; }
    S.ultimoPago = d;
    modal((d.nc ? 'Nota de crédito ' + d.nc : 'Pago a proveedor') + ' · ' + d.fecha, `<div class="nota">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div><small class="muted">${d.nc ? 'Nota de crédito de' : 'Pagamos a'}</small><br><b style="font-size:16px">${esc(d.proveedor)}</b>${d.razon && d.razon !== d.proveedor ? '<br>' + esc(d.razon) : ''}</div>
        <div style="text-align:right"><small class="muted">Importe</small><br><b style="font-size:24px;color:var(--marca)">${$$(d.monto)}</b></div></div>
      <div class="tabla-cont" style="margin-top:10px"><table><tbody>
        <tr><td>Orden de compra</td><td><b>${esc(d.folioOC)}</b></td></tr>
        ${d.factura ? `<tr><td>Factura</td><td>${esc(d.factura)}</td></tr>` : ''}
        <tr><td>${d.nc ? 'Motivo' : 'Forma de pago'}</td><td>${esc(d.nc ? d.motivoNC : d.forma)}</td></tr>
        ${d.nc || d.esNC ? `<tr><td>Folio fiscal (UUID)</td><td>${d.uuidNC ? `<span style="font-family:monospace;font-size:12px;word-break:break-all">${esc(d.uuidNC)}</span>` : '<span class="muted">sin capturar</span>'}</td></tr>` : ''}
        ${!d.nc ? `<tr><td>Cuenta</td><td>${esc(d.banco)}</td></tr>` : ''}
        <tr><td>Sucursal</td><td>${esc(sucNom(d.suc))}</td></tr>
        ${d.comentarios ? `<tr><td>Comentarios</td><td>${esc(d.comentarios)}</td></tr>` : ''}
        ${d.oc ? `<tr><td>Saldo de la orden</td><td>${$$(d.oc.saldo)} <span class="muted">de ${$$(d.oc.total)}</span></td></tr>` : ''}
        ${!d.nc && !d.esNC && (d.rep || d.ppd) ? `<tr><td>Complemento de pago</td><td>${d.rep ? '<span class="etq ok">✔ ligado</span> <small class="muted">' + esc(d.rep) + '</small>' : '<span class="etq av">Falta REP</span> <small class="muted">la factura es PPD</small>'}</td></tr>` : ''}
      </tbody></table></div></div>
      ${htmlAdj('pago', d.id, d.adjuntos, d.esNC || !!d.nc)}
      <div class="acciones no-imprimir">${d.oc ? `<button class="btn" onclick="App.abrirCompraId('${d.oc.id}')">📦 Ver orden ${esc(d.oc.folio)}</button>` : ''}${d.puedeEditar ? `<button class="btn" onclick="App.formEditarPago()">✏️ Editar</button>` : ''}</div>`);
  }
  /** Propietario / administrador: corrige folio de N/C, motivo y comentarios (el importe no cambia). */
  function formEditarPago() {
    const d = S.ultimoPago; if (!d || !d.puedeEditar) return;
    const esNC = !!(d.nc || d.esNC);
    modal('✏️ Editar ' + (esNC ? 'nota de crédito' : 'pago') + ' · ' + d.fecha, `<p class="muted" style="margin-top:0">${esc(d.proveedor)} · orden <b>${esc(d.folioOC)}</b> · importe <b>${$$(d.monto)}</b>. El importe, la fecha y la orden no cambian.</p>
      <div class="rejilla"><label>Folio de la nota de crédito<input id="epFolio" value="${esc(d.nc)}" placeholder="Ej. NC 1234"></label>
        <label>Motivo de la N/C<input id="epMotivo" list="epMotivos" value="${esc(d.motivoNC)}" placeholder="Ej. Pronto pago"><datalist id="epMotivos">${MOTIVOS_NC.filter(m => m !== 'Otro').map(m => `<option value="${m}">`).join('')}</datalist></label>
        <label style="grid-column:1/-1">Folio fiscal (UUID) de la nota de crédito<input id="epUuid" value="${esc(d.uuidNC || '')}" placeholder="Ej. 4CC99ABF-D34F-48F1-AE75-094110C692BC" style="font-family:monospace" autocapitalize="characters" spellcheck="false"></label>
        <label style="grid-column:1/-1">Comentarios / observaciones<textarea id="epCom" rows="3" maxlength="500">${esc(d.comentarios)}</textarea></label></div>
      ${esNC ? '' : '<p class="muted peq">Si capturas un folio de nota de crédito, este movimiento se mostrará como nota de crédito (no como pago).</p>'}
      <div class="acciones"><button class="btn" onclick="App.verPagoProv('${d.id}')">Volver</button><button class="btn primario" id="epGuardar" onclick="App.guardarEdicionPago()">Guardar cambios</button></div>`);
  }
  async function guardarEdicionPago() {
    const d = S.ultimoPago; if (!d) return;
    const folio = $('#epFolio').value.trim(), motivo = $('#epMotivo').value.trim(), com = $('#epCom').value.trim(), uuid = $('#epUuid').value.replace(/\s+/g, '').toUpperCase();
    if (folio && !motivo) return toast('Indica el motivo de la nota de crédito', true);
    if (uuid && !/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(uuid)) return toast('El folio fiscal debe tener 36 caracteres, como viene en la nota de crédito (8-4-4-4-12)', true);
    $('#epGuardar').disabled = true;
    try {
      await pedir('editarPagoProv', { id: d.id, folioNC: folio, motivoNC: motivo, uuidNC: uuid, comentarios: com });
      toast('✔ Cambios guardados'); verPagoProv(d.id); if ($('#lPP')) buscarPagosProv();
    } catch (e) { if ($('#epGuardar')) $('#epGuardar').disabled = false; }
  }
  function pagosSinAdj() { $('#ppSinAdj').checked = true; buscarPagosProv(); }
  function listaCompras() {
    const ini = hoyISO().slice(0, 8) + '01';
    const pv = S.comprasProv;   // historial de un proveedor: todas las fechas
    $('#cCont').innerHTML = (pv ? `<div class="filtro-activo">📦 Mostrando solo las compras a <b>${esc(pv.nombre)}</b><button class="btn chico" onclick="App.quitarFiltroProv()">✕ Quitar filtro</button></div>` : '') +
      `<div class="tarjeta"><div class="fila"><label>Desde<input type="date" id="oDesde" value="${pv ? '' : ini}"></label><label>Hasta<input type="date" id="oHasta" value="${pv ? '' : hoyISO()}"></label>
      <label>Buscar<input id="oTxt" placeholder="Folio, proveedor o factura"></label><label class="check fijo"><input type="checkbox" id="oPend"> Pendientes (recibir / pagar)</label>
      <button class="btn primario fijo" onclick="App.buscarCompras()">Buscar</button></div></div><div class="espacio"></div><div id="lOC"></div>`;
    agregarMesAnio('oDesde', 'oHasta', buscarCompras, 'compras');
    buscarCompras();
  }
  function comprasDeProveedor(id, nombre) { cerrarModal(); S.comprasProv = { id: id, nombre: nombre || id }; ir('compras', true); }
  function quitarFiltroProv() { S.comprasProv = null; V.compras('lista'); }
  async function buscarCompras() {
    const nq = S.qCompras = (S.qCompras || 0) + 1;
    if ($('#lOC')) $('#lOC').innerHTML = '<div class="vacio">Buscando…</div>';
    try {
      let l = await pedir('listarCompras', { desde: $('#oDesde').value, hasta: $('#oHasta').value, texto: $('#oTxt').value, pendientes: $('#oPend').checked, idProveedor: S.comprasProv ? S.comprasProv.id : '' });
      if (nq !== S.qCompras || !$('#lOC')) return;
      if (S.soloSaldoOC) { l = l.filter(x => x.saldo > 0.009 && (x.conFactura !== undefined ? x.conFactura : !!String(x.factura || '').trim())); S.soloSaldoOC = false; }
      S.lista = l;
      // solo cuentan como compra las órdenes con factura o nota del proveedor
      const conF = x => x.conFactura !== undefined ? x.conFactura : !!String(x.factura || '').trim();
      const lf = l.filter(conF), sinF = l.filter(x => !conF(x) && !/CANCELADA/i.test(String(x.recibido)));
      const tot = lf.reduce((a, x) => a + x.total, 0), pag = lf.reduce((a, x) => a + x.pagado, 0), sal = lf.reduce((a, x) => a + Math.max(0, x.saldo), 0);
      const conSal = lf.filter(x => x.saldo > 0.009).length, porRec = l.filter(x => !/^(SI|CANCELADA)$/i.test(String(x.recibido))).length, totSinF = sinF.reduce((a, x) => a + x.total, 0);
      $('#lOC').innerHTML = `<div class="kpis">
        <div class="kpi" title="Solo órdenes con factura o nota del proveedor"><small>Compras del periodo</small><b>${$$(tot)}</b><span>${lf.length} ${lf.length === 1 ? 'orden con factura' : 'órdenes con factura'}${porRec ? ' · ' + porRec + ' por recibir' : ''}${sinF.length ? `<br>${sinF.length} sin factura (${$$(totSinF)}) no se cuentan` : ''}</span></div>
        <div class="kpi"><small>Pagado de esas compras</small><b>${$$(pag)}</b><span>${tot > 0 ? Math.round(pag / tot * 100) + ' % del total' : '—'}</span></div>
        <div class="kpi"><small>Por pagar del periodo</small><b>${$$(sal)}</b><span>${conSal} ${conSal === 1 ? 'orden' : 'órdenes'} con saldo</span></div>
        <div class="kpi kpi-clic" id="kCxP" onclick="App.verCxP()" title="Saldo de las órdenes con factura o nota del proveedor (todas las fechas)"><small>Cuentas por pagar (total)</small><b>…</b><span>calculando</span></div>
      </div>` + tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Proveedor', k: 'proveedor' }, { t: 'Factura / nota', h: x => x.factura ? esc(x.factura) + (x.nota ? `<br><small class="muted">nota ${esc(x.nota)}</small>` : '') : x.nota ? `<span class="muted">nota</span> ${esc(x.nota)}` : '' },
        { t: 'Destino', cls: 'ocultar-movil', h: x => esc(sucNom(x.suc)) }, { t: 'Total', num: 1, h: x => $$(x.total) }, { t: 'Saldo', num: 1, h: x => x.saldo > 0.009 ? `<b>${$$(x.saldo)}</b>` : '—' },
        { t: 'Recibida', h: x => `<span style="white-space:nowrap"><span class="etq ${String(x.recibido).toUpperCase() === 'SI' ? 'ok' : /CANCELADA/i.test(x.recibido) ? 'mal' : 'av'}">${esc(x.recibido || 'NO')}</span>` +
          (puede('compras') && !/^(SI|CANCELADA)$/i.test(String(x.recibido)) ? ` <button class="btn chico no-imprimir" title="Editar productos, cantidades, precios, lote y caducidad" onclick="event.stopPropagation();App.editarCompraId('${esc(x.id)}')">✏️ Editar</button>` : '') + '</span>' }], l, { clic: 'App.abrirCompra' });
      totalCxP();
    } catch (e) { if (nq === S.qCompras && $('#lOC')) $('#lOC').innerHTML = `<div class="vacio">${e.red ? 'Requiere conexión.' : 'No se pudo consultar: ' + esc(e.message || '')}</div>`; }
  }
  /** Cuentas por pagar a proveedores de TODAS las fechas. */
  async function totalCxP() {
    let r = S.cacheTot && S.cacheTot.cxp && Date.now() - S.cacheTot.cxp.t < 120000 ? S.cacheTot.cxp.r : null;
    if (!r) {
      try {
        const l = (await pedir('listarCompras', { pendientes: true }, true)).filter(x => x.saldo > 0.009 && (x.conFactura !== undefined ? x.conFactura : !!String(x.factura || '').trim())), hoy = hoyISO();
        const venc = l.filter(x => x.venc && isoDe(x.venc) && isoDe(x.venc) < hoy);
        r = { total: l.reduce((a, x) => a + x.saldo, 0), n: l.length, vencido: venc.reduce((a, x) => a + x.saldo, 0) };
        S.cacheTot = S.cacheTot || {}; S.cacheTot.cxp = { t: Date.now(), r: r };
      } catch (e) { const el = $('#kCxP'); if (el) el.querySelector('span').textContent = 'requiere conexión'; return; }
    }
    const el = $('#kCxP'); if (!el) return;
    el.querySelector('b').textContent = $$(r.total);
    el.querySelector('span').innerHTML = r.n + (r.n === 1 ? ' orden' : ' órdenes') + (r.vencido > 0.009 ? ` · <b class="txt-mal">vencido ${$$(r.vencido)}</b>` : ' · nada vencido');
  }
  function verCxP() {
    $('#oDesde').value = ''; $('#oHasta').value = ''; $('#oPend').checked = true; S.soloSaldoOC = true;
    buscarCompras();
  }
  /** Encabezado de la orden de compra: datos completos del proveedor y entrega / condiciones (como en la nota de venta). */
  function lineasProv(pv, d) {
    pv = pv || {};
    const et = (c, t) => !t ? c : String(t).indexOf(c) === 0 ? t : c + ' – ' + t;
    const dom = [pv.calle, pv.colonia, pv.localidad && pv.localidad !== pv.municipio ? pv.localidad : '', pv.municipio, pv.estado].filter(Boolean).join(', ');
    return { nombre: pv.razon || pv.nombre || d.proveedor || '', comercial: pv.nombre && pv.razon && pv.nombre !== pv.razon ? pv.nombre : '', rfc: pv.rfc || d.rfc || '',
      regimen: pv.regimen ? et(pv.regimen, pv.regimenTxt) : '', dom: dom, cp: pv.cp || '',
      tels: [pv.tel ? 'Tel. ' + pv.tel : '', pv.cel && pv.cel !== pv.tel ? 'Cel. ' + pv.cel : ''].filter(Boolean).join(' · '), email: pv.email || '', web: pv.web || '',
      contacto: [pv.contacto, pv.celContacto ? 'Cel. ' + pv.celContacto : '', pv.emailContacto].filter(Boolean).join(' · '),
      cred: (d.dias || pv.credito) ? 'Crédito ' + (d.dias || pv.credito) + ' días' : 'Contado' };
  }
  function htmlProvOC(d) {
    const p = lineasProv(d.prov, d), s = sucDe(d.suc);
    return `<div class="oc-cajas"><div class="oc-caja"><div class="oc-banda">PROVEEDOR</div><div class="oc-cuerpo">
        <b class="oc-nom">${esc(p.nombre)}</b>${p.comercial ? '<br>' + esc(p.comercial) : ''}${p.rfc ? `<br>RFC <b>${esc(p.rfc)}</b>` : ''}${p.regimen ? '<br>Régimen fiscal: ' + esc(p.regimen) : ''}
        ${p.dom ? '<br>' + esc(p.dom) : ''}${p.cp ? '<br>C.P. ' + esc(p.cp) : ''}${p.tels ? '<br>' + esc(p.tels) : ''}${p.email ? '<br>' + esc(p.email) : ''}${p.web ? '<br>' + esc(p.web) : ''}
        ${p.contacto ? `<br><span class="muted">Contacto de ventas:</span> ${esc(p.contacto)}` : ''}</div></div>
      <div class="oc-caja"><div class="oc-banda">ENTREGAR EN</div><div class="oc-cuerpo"><b class="oc-nom">${esc(s.nombre || '')}</b>${s.direccion ? '<br>' + esc(s.direccion) : ''}${s.tel ? '<br>Tel. ' + esc(s.tel) : ''}
        <div class="oc-cond"><span class="muted">Condiciones:</span> ${esc(p.cred)}${d.venc ? '<br><span class="muted">Vence:</span> ' + esc(d.venc) : ''}<br><span class="muted">Estado:</span> ${String(d.recibido).toUpperCase() === 'SI' ? 'Recibida' : /CANCELADA/i.test(d.recibido) ? '<b class="txt-mal">CANCELADA</b>' : 'Pendiente de recibir'}</div></div></div></div>`;
  }
  async function verCompra(id) {
    let d; try { d = await pedir('detalleCompra', { ID_O_Compra: id }); } catch (e) { return; }
    S.ultimaCompra = d;
    const pend = d.lineas.filter(l => !l.registrado);
    modal('Orden ' + d.folio, `<div class="imprimible"><div class="nota">
      <div class="enc"><div><div class="doc-logos">${logoHtml()}${fotoSucDoc(d.suc)}</div><div>Destino: ${esc(sucNom(d.suc))}</div></div><div style="text-align:right"><b>ORDEN DE COMPRA</b><div style="font-size:18px">${esc(d.folio)}</div><div>${esc(d.fecha)}</div>
        <div style="margin-top:4px">Factura: <b>${d.factura ? esc(d.factura) : '<span style="color:#b97300">sin capturar</span>'}</b></div>${d.nota ? `<div>Nota del proveedor: <b>${esc(d.nota)}</b></div>` : ''}${d.uuid ? `<div style="font-size:10px;color:#666">Folio fiscal: ${esc(d.uuid)}</div>` : ''}</div></div>
      ${htmlProvOC(d)}
      ${tabla([{ t: 'Cant.', num: 1, h: x => nf(x.cant) }, { t: 'Producto', k: 'nombre' }, { t: 'Lote', h: x => x.registrado ? esc(x.lote) : x.lote && x.lote !== 'SIN LOTE' ? esc(x.lote) + ' <small class="muted">(por confirmar)</small>' : '<span class="muted">al recibir</span>' }, { t: 'Cad.', h: x => esc(x.cad || '') }, { t: 'Costo', num: 1, h: x => $$(x.precio) }, { t: 'Importe', num: 1, h: x => $$((x.sub || x.cant * x.precio) - (x.desc || 0)) }, { t: 'IVA $', num: 1, h: x => $$(x.iva || 0) }, { t: 'Total', num: 1, h: x => `<b>${$$(x.total)}</b>` }], d.lineas)}
      <div class="totales" style="margin-top:10px"><div><span>Subtotal</span><span>${$$(d.sub)}</span></div>${d.descEsp ? `<div><span>Descuento especial</span><span>−${$$(d.descEsp)}</span></div>` : ''}${d.descPP ? `<div><span>Descuento pronto pago</span><span>−${$$(d.descPP)}</span></div>` : ''}<div><span>IVA</span><span>${$$(d.iva)}</span></div>${d.flete ? `<div><span>Flete</span><span>${$$(d.flete)}</span></div>` : ''}
      <div class="gran"><span>Total</span><span>${$$(d.total)}</span></div><div><span>Pagado</span><span>${$$(d.pagado)}</span></div><div><b>Saldo</b><b>${$$(d.saldo)}</b></div></div>
      ${tablaPagosOC(d)}</div></div>
      ${d.cancelada ? `<div class="tarjeta" style="margin-top:12px;border-color:var(--mal)"><b class="txt-mal">🚫 Orden cancelada.</b> <span class="muted">${esc(d.obs || '')}</span></div>` : ''}
      ${pend.length && !d.cancelada && puede('compras') ? `<div class="tarjeta no-imprimir" style="margin-top:12px"><h3>Recibir mercancía en ${esc(sucNom(d.suc))}</h3><p class="muted peq" style="margin:0 0 8px">Captura el lote y la caducidad de cada producto, como vienen en la factura del proveedor.</p>
        ${pend.map(l => `<div class="fila" data-det="${esc(l.idDet)}" style="margin-bottom:6px"><div style="flex:2 1 200px"><b>${esc(l.nombre)}</b> × ${nf(l.cant)}</div>
          ${(prod(l.prod) || {}).usaLote === false ? '<small class="muted">Sin lote</small>' : `<label>Lote *<input data-k="Lote" value="${esc(l.lote === 'SIN LOTE' ? '' : l.lote)}"></label><label>Caducidad${(prod(l.prod) || {}).usaCad === false ? '' : ' *'}<input type="date" data-k="F_Caducidad" value="${isoDe(l.cad)}"></label>`}</div>`).join('')}
        <div class="acciones"><button class="btn primario" onclick="App.recibirCompra('${d.id}')">✔ Recibir en inventario</button></div></div>` : ''}
      ${bloqueArch('ocNota', d.id)}${bloqueArch('ocFactura', d.id)}${bloqueArch('ocGuia', d.id)}${bloqueArch('ocFirma', d.id)}
      <div class="acciones no-imprimir"><button class="btn" onclick="App.imprimir()">🖨️ Imprimir</button><button class="btn" onclick="App.pdfCompra('${d.id}')" title="Solo cantidad, producto y categoría: sin costos">📄 PDF para proveedor</button>${puede('ver_costos') ? `<button class="btn" onclick="App.pdfCompra('${d.id}', true)" title="Con costos, descuentos, IVA y totales (no se manda al proveedor)">📄 PDF interno</button>` : ''}
      ${puede('compras') && !d.cancelada ? `<button class="btn" onclick="App.formFacturaCompra('${d.id}')">🧾 ${d.factura || d.nota ? 'Editar' : 'Capturar'} factura / nota</button>` : ''}
      ${puede('compras') && d.editable ? `<button class="btn" onclick="App.editarCompra()">✏️ Editar orden</button><button class="btn peligro" onclick="App.cancelarCompra('${d.id}')">🚫 Cancelar orden</button>` : ''}
      ${d.saldo > 0.009 && puede('pagos_proveedor') ? `<button class="btn" onclick="App.formNotaCredito('${d.id}',${d.saldo})">🧾 Nota de crédito</button><button class="btn primario" onclick="App.formPagoProv('${d.id}',${d.saldo})">Registrar pago</button>` : ''}</div>`);
  }
  /** Carga la orden (sin recibir) en el formulario para editarla. */
  function editarCompra() {
    const d = S.ultimaCompra; if (!d || !d.editable) return;
    if (S.oc && S.oc.lineas && S.oc.lineas.length && S.oc.editId !== d.id && !confirm('Tienes otra orden en captura. ¿Dejarla y editar la ' + d.folio + '?')) return;
    S.oc = { editId: d.id, folio: d.folio, prov: d.idProv, suc: d.suc, factura: d.factura, nota: d.nota || '', fecha: d.fechaISO || hoyISO(), dias: d.dias, descEsp: d.descEspPct || 0, descPP: d.descPPPct || 0,
      flete: d.flete || 0, recibido: false, actCosto: false, obs: d.obs || '', pago: 0,
      lineas: d.lineas.filter(l => l.prod).map(l => ({ id: l.prod, cant: l.cant, precio: l.precio, desc: l.descPct || 0, lote: l.lote && l.lote !== 'SIN LOTE' ? l.lote : '', cad: l.cad ? isoDe(l.cad) : '' })) };
    cerrarModal(); ir('compras', true); V.compras('nueva');
  }
  /** Desde el listado: trae la orden y la abre en el formulario de edición. */
  async function editarCompraId(id) {
    let d; try { d = await pedir('detalleCompra', { ID_O_Compra: id }); } catch (e) { return; }
    S.ultimaCompra = d;
    if (!d.editable) return toast(d.porQueNo || 'Esta orden ya no se puede editar', true);
    editarCompra();
  }
  async function cancelarCompra(id) {
    const d = S.ultimaCompra || {};
    const m = prompt('¿Por qué cancelas la orden ' + (d.folio || '') + '? (ej. el proveedor no surtió, se pidió por error)'); if (m === null) return;
    if (!m.trim()) return toast('Escribe el motivo', true);
    try { const r = await pedir('cancelarCompra', { ID_O_Compra: id, motivo: m.trim() }); toast('✔ Orden ' + r.folio + ' cancelada'); S.cacheTot = {}; if (S.oc && S.oc.editId === id) S.oc = null; verCompra(id); if ($('#lOC')) buscarCompras(); } catch (e) {}
  }
  /** Pagos y notas de crédito de la orden, separados y con totales. */
  function tablaPagosOC(d) {
    const l = d.pagos || []; if (!l.length) return '';
    const nc = l.filter(x => x.esNC), pg = l.filter(x => !x.esNC), sum = a => a.reduce((t, x) => t + (Number(x.monto) || 0), 0);
    const lnk = x => x.id && puede('pagos_proveedor') ? ` <a class="no-imprimir" href="#" title="Ver ${x.esNC ? 'la nota de crédito' : 'el pago'} y sus archivos" onclick="App.verPagoProv('${x.id}');return false">${x.adj ? '📎' + x.adj : '🧾'}</a>` : '';
    const t = (tit, a, cols) => a.length ? `<div style="margin-top:14px;break-inside:avoid"><b>${tit}</b><div class="tabla-cont" style="margin-top:6px"><table><thead><tr><th>Fecha</th>${cols[0]}<th class="num">Importe</th></tr></thead><tbody>
      ${a.map(x => `<tr><td>${esc(x.fecha)}${lnk(x)}</td>${cols[1](x)}<td class="num">${$$(x.monto)}</td></tr>`).join('')}
      <tr><td colspan="${cols[2]}"><b>Total</b></td><td class="num"><b>${$$(sum(a))}</b></td></tr></tbody></table></div></div>` : '';
    return t('Pagos realizados', pg, ['<th>Comentarios</th>', x => `<td>${esc(x.comentarios || '')}</td>`, 2]) +
      t('Notas de crédito', nc, ['<th>Folio N/C</th><th>Motivo</th>', x => `<td><b>${esc(x.nc || '—')}</b>${x.uuidNC ? `<br><small class="muted" style="font-size:10px">${esc(x.uuidNC)}</small>` : ''}</td><td>${esc(x.motivoNC || x.comentarios || '')}</td>`, 3]);
  }
  const MOTIVOS_NC = ['Pronto pago', 'Devolución', 'Bonificación', 'Descuento comercial', 'Producto dañado o caducado', 'Otro'];
  function formNotaCredito(id, saldo) {
    const d = S.ultimaCompra || {};
    S.ncArch = {};
    modal('🧾 Nota de crédito · Orden ' + (d.folio || ''), `<p class="muted" style="margin-top:0">${esc(d.proveedor || '')} · saldo de la orden <b>${$$(saldo)}</b>. La nota de crédito reduce el saldo como un pago.</p>
      <div class="fact-bloque"><h4>🧾 XML de la nota de crédito (opcional)</h4><p class="muted" style="margin:0 0 6px;font-size:13px">Si eliges el XML, lleno el folio, el monto y el UUID por ti.</p>
        <label class="btn chico" style="cursor:pointer">Elegir XML<input type="file" id="ncXml" accept=".xml,text/xml,application/xml" style="display:none" onchange="App.leerXmlNC(this)"></label> <span id="ncXmlInfo" class="muted"></span></div>
      <div class="rejilla"><label>Folio de la N/C *<input id="ncFolio" placeholder="Ej. NC 1234"></label>
        <label>Motivo *<select id="ncMotivo" onchange="document.getElementById('ncOtroL').style.display=this.value==='Otro'?'':'none'">${MOTIVOS_NC.map(m => `<option>${m}</option>`).join('')}</select></label>
        <label id="ncOtroL" style="display:none">Especifica<input id="ncOtro" placeholder="Motivo"></label>
        <label>% (opcional)<input type="number" id="ncPct" placeholder="Ej. 6" oninput="App.ncPorcentaje(${Number(d.total) || 0})"></label>
        <label>Monto $ *<input type="number" id="ncMonto" step="0.01"></label>
        <label style="grid-column:1/-1">Folio fiscal (UUID, opcional)<input id="ncUuid" placeholder="XXXXXXXX-XXXX-…"></label>
        <label style="grid-column:1/-1">PDF de la nota de crédito (opcional)<input type="file" id="ncPdf" accept="application/pdf"></label></div>
      <div class="acciones"><button class="btn" onclick="App.abrirCompraId('${id}')">Volver</button><button class="btn primario" onclick="App.guardarNotaCredito('${id}',${saldo})">Guardar nota de crédito</button></div>`);
  }
  function ncPorcentaje(total) { const p = Number($('#ncPct').value) || 0; if (p > 0 && total > 0) $('#ncMonto').value = (Math.round(total * p) / 100).toFixed(2); }
  /** Lee el CFDI de egreso (tipo E) y llena folio, monto y UUID. */
  async function leerXmlNC(input) {
    const f = input.files && input.files[0], info = $('#ncXmlInfo'); S.ncArch = S.ncArch || {}; S.ncArch.xml = '';
    if (!f) { info.textContent = ''; return; }
    try {
      const uri = await leerXml(f); S.ncArch.xml = uri;
      const txt = await f.text(), doc = new DOMParser().parseFromString(txt, 'application/xml');
      const all = n => Array.from(doc.getElementsByTagName('*')).filter(e => e.localName === n);
      const c = all('Comprobante')[0], tf = all('TimbreFiscalDigital')[0];
      if (!c) throw new Error('No parece un CFDI');
      const g = k => c.getAttribute(k) || '', folio = [g('Serie'), g('Folio')].filter(String).join(' ');
      if (folio && !$('#ncFolio').value) $('#ncFolio').value = folio;
      if (g('Total')) $('#ncMonto').value = Number(g('Total')).toFixed(2);
      if (tf && tf.getAttribute('UUID')) $('#ncUuid').value = tf.getAttribute('UUID');
      const rel = all('CfdiRelacionado').map(e => e.getAttribute('UUID')).filter(Boolean);
      const em = all('Emisor')[0];
      info.innerHTML = `✔ ${esc(f.name)}${g('TipoDeComprobante') && g('TipoDeComprobante') !== 'E' ? ' · <b class="txt-mal">ojo: no es tipo Egreso (E)</b>' : ''}${em ? ' · ' + esc(em.getAttribute('Nombre') || em.getAttribute('Rfc') || '') : ''}${rel.length ? ' · relaciona ' + rel.length + ' factura(s)' : ''}`;
    } catch (e) { info.textContent = e.message || 'No se pudo leer el XML'; }
  }
  async function guardarNotaCredito(id, saldo) {
    const motivo = $('#ncMotivo').value === 'Otro' ? $('#ncOtro').value.trim() : $('#ncMotivo').value + ($('#ncPct').value ? ' ' + $('#ncPct').value + '%' : '');
    const monto = Number($('#ncMonto').value) || 0, folio = $('#ncFolio').value.trim();
    if (!folio) return toast('Captura el folio de la nota de crédito', true);
    if (!motivo) return toast('Indica el motivo', true);
    if (monto <= 0) return toast('Captura el monto', true);
    if (monto > saldo + 0.01) return toast('El monto excede el saldo de la orden (' + $$(saldo) + ')', true);
    let pdf = ''; const fp = $('#ncPdf') && $('#ncPdf').files[0];
    if (fp) { try { pdf = await leerComprobante(fp); if (!/^data:application\/pdf/.test(pdf)) throw new Error('El archivo de la N/C debe ser PDF'); } catch (e) { return toast(e.message, true); } }
    const xml = (S.ncArch || {}).xml || '', idP = uid();
    try {
      const r = await pedir('guardarNotaCreditoProv', { ID_Pago_Proveedor: idP, ID_O_Compra: id, folio: folio, motivo: motivo, monto: monto, uuid: $('#ncUuid').value.trim() });
      S.cacheTot = {}; let msg = '✔ Nota de crédito registrada. Saldo ' + $$(r.saldo), mal = 0;
      for (const u of [pdf, xml]) { if (!u) continue; try { await pedir('subirAdjuntoPago', { id: r.id || idP, dataUri: u, nc: true }); } catch (e) { mal++; } }
      if (pdf || xml) msg += mal ? ' · ' + mal + ' archivo(s) no se pudieron subir: agrégalos desde la nota de crédito' : ' · archivos adjuntos';
      toast(msg); verCompra(id); if ($('#lOC')) buscarCompras(); if ($('#lPP')) buscarPagosProv();
    } catch (e) {}
  }
  function formFacturaCompra(id) {
    const d = S.ultimaCompra || {};
    modal('Factura y nota del proveedor · ' + (d.folio || ''), `<p class="muted" style="margin-top:0">La nota de venta o remisión del proveedor se puede capturar antes de que llegue la factura fiscal; con cualquiera de las dos la orden ya cuenta como compra. La foto o PDF de la nota se adjunta abajo, en la orden.</p>
      <div class="rejilla"><label>Serie y folio de la nota de venta / remisión<input id="fcNota" value="${esc(d.nota || '')}" placeholder="Ej. REM-10636"></label>
      <label>Serie y folio de la factura<input id="fcFac" value="${esc(d.factura || '')}" placeholder="Ej. B 1558"></label>
      <label>Folio fiscal (UUID, opcional)<input id="fcUuid" value="${esc(d.uuid || '')}" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"></label></div>
      <div class="acciones"><button class="btn" onclick="App.abrirCompraId('${id}')">Volver</button><button class="btn primario" onclick="App.guardarFacturaCompra('${id}')">Guardar</button></div>`);
  }
  async function guardarFacturaCompra(id) {
    try { await pedir('editarFacturaCompra', { ID_O_Compra: id, No_Factura: $('#fcFac').value, Folio_Fiscal: $('#fcUuid').value, No_Nota: $('#fcNota').value }); toast('✔ Guardado'); S.cacheTot = {}; verCompra(id); if ($('#lOC')) buscarCompras(); } catch (e) {}
  }
  async function recibirCompra(id) {
    const v = (r, k) => { const el = r.querySelector('[data-k=' + k + ']'); return el ? el.value.trim() : ''; };
    const lineas = Array.from(document.querySelectorAll('[data-det]')).map(r => ({ ID_Detalle_O_Compra: r.dataset.det, Lote: v(r, 'Lote'), F_Caducidad: v(r, 'F_Caducidad'), _r: r }));
    const falta = lineas.find(l => (l._r.querySelector('[data-k=Lote]') && !l.Lote) || (l._r.querySelector('[data-k=F_Caducidad]') && /\*/.test(l._r.querySelector('[data-k=F_Caducidad]').parentNode.textContent) && !l.F_Caducidad));
    if (falta) { const el = !falta.Lote ? falta._r.querySelector('[data-k=Lote]') : falta._r.querySelector('[data-k=F_Caducidad]'); el.focus(); return toast('Captura el lote y la caducidad de ' + falta._r.querySelector('b').textContent, true); }
    lineas.forEach(l => delete l._r);
    try { const r = await pedir('recibirCompra', { ID_O_Compra: id, lineas: lineas }); toast(r.renglones ? '✔ ' + r.renglones + ' productos ingresados al inventario' + (r.yaRegistrados ? ' (' + r.yaRegistrados + ' ya estaban)' : '') : '✔ Esos productos ya estaban en el inventario: no se duplicó nada'); refrescarStock(); buscarCompras();
      const f = await capturarFirma({ titulo: 'Firma de quien recibió la mercancía', verbo: 'recibe', nombreObl: false, opcional: true, omitirTxt: 'Omitir firma' });
      if (f && f.png && await subirFirma('ocFirma', id, f)) toast('✔ Firma guardada');
      verCompra(id); } catch (e) {}
  }
  function formPagoProv(id, saldo) {
    const cat = D().catalogos;
    modal('Pago a proveedor', `<div class="rejilla"><label>Monto $<input type="number" id="ppMonto" value="${saldo}"></label>
      <label>Forma de pago<select id="ppForma">${opts(cat.formasPago, '3')}</select></label><label>Cuenta<select id="ppBanco">${opts(cat.bancos, '')}</select></label>
      <label style="grid-column:1/-1">Comentarios<input id="ppCom"></label>
      <label style="grid-column:1/-1">Comprobante (foto y/o PDF, opcional — puedes elegir ambos)<input type="file" id="ppArch" multiple accept="image/&#42;,application/pdf"></label></div>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.guardarPagoProv('${id}')">Guardar pago</button></div>`);
  }
  async function guardarPagoProv(id) {
    let adjs;
    try { adjs = await leerComprobantes($('#ppArch')); } catch (e) { return toast(e.message || 'No se pudo leer el comprobante', true); }
    const idPago = uid();
    try { const r = await pedir('guardarPagoProv', { ID_O_Compra: id, ID_Pago_Proveedor: idPago, monto: Number($('#ppMonto').value), forma: $('#ppForma').value, banco: $('#ppBanco').value, comentarios: $('#ppCom').value });
      S.cacheTot = {}; let msg = '✔ Pago registrado. Saldo ' + $$(r.saldo);
      if (adjs.length) { try { for (const u of adjs) await pedir('subirAdjuntoPago', { id: r.id || idPago, dataUri: u }); msg += adjs.length > 1 ? ' · foto y PDF adjuntos' : ' · comprobante adjunto'; } catch (e) { msg += ' · un comprobante no se pudo subir: agrégalo desde Pagos a proveedores'; } }
      toast(msg); cerrarModal(); if ($('#lOC')) buscarCompras(); if ($('#lPP')) buscarPagosProv(); } catch (e) {}
  }
  /** Precio para la orden de compra: el de la compra más reciente (con ese proveedor si ya se le compró; si no, con cualquiera);
      si nunca se ha comprado, el costo de lista. */
  function costoCompra(id, prov) {
    const p = prod(id) || {}; let u = null, otro = false;
    if (prov && p.uc && p.uc[4] === prov) u = p.uc; else if (prov && p.ucp && p.ucp[prov]) u = p.ucp[prov]; else { u = p.uc; otro = !!(prov && u); }
    if (u && u[0] > 0) return { precio: u[0], desc: u[1] || 0, ref: { f: u[2] || '', oc: u[3] || '', otro: otro } };
    return { precio: p.costo || 0, desc: 0, ref: null };
  }
  function lineaCompra(id, cant, prov) { const c = costoCompra(id, prov); return { id: id, cant: cant, precio: c.precio, desc: c.desc, lote: '', cad: '', auto: true, ref: c.ref }; }
  function nuevaCompra() {
    if (!S.oc) S.oc = { prov: '', suc: sucTrabajo(), factura: '', fecha: hoyISO(), dias: '', descEsp: 0, descPP: 0, flete: 0, recibido: false, actCosto: true, obs: '', lineas: [], pago: 0 };
    const o = S.oc, cat = D().catalogos, ed = !!o.editId;
    $('#cCont').innerHTML = (ed ? `<div class="tarjeta" style="border-color:var(--marca);background:var(--marca-suave, #eef7f1)"><div class="fila"><div style="flex:3 1 260px">✏️ Editando la orden <b>${esc(o.folio)}</b> (aún no recibida): cantidades, precios, descuentos y, si ya los tienes por la nota o cotización del proveedor, lote y caducidad. Folio, sucursal, factura y pagos se conservan.</div><button class="btn fijo chico" onclick="App.salirEdicionCompra()">Salir sin guardar</button></div></div>` : '') + (o.cfdi ? `<div class="tarjeta" style="border-color:var(--marca)"><div class="fila"><div style="flex:3 1 260px">🧾 Orden desde la <b>factura ${esc(o.cfdi.factura)}</b> (total ${$$(o.cfdi.total)}). Al guardarla queda ligada con su XML y PDF.
      ${o.cfdi.sin.length ? `<br><b style="color:var(--aviso)">Agrega con el buscador estos productos que no reconocí:</b><ul class="peq" style="margin:4px 0 0 18px">${o.cfdi.sin.map(l => `<li>${esc(l.desc)}${l.noId ? ' <small class="muted">(' + esc(l.noId) + ')</small>' : ''} · ${nf(l.cant)} × ${$$(l.precio)}</li>`).join('')}</ul>` : ''}</div>
      <button class="btn fijo chico" onclick="App.quitarCfdiOc()">Desligar</button></div></div>` : '') + (o.req ? `<div class="tarjeta" style="border-color:var(--aviso);background:var(--aviso-suave)"><div class="fila"><div style="flex:3 1 260px">📑 Faltantes de la <b>requisición ${esc(o.req.folio)}</b>: la orden queda ligada a ella.</div><button class="btn fijo chico" onclick="App.quitarReqOc()">Desligar</button></div></div>` : '') +
      `<div class="tarjeta"><div class="folio-fila"><div class="folio" id="ocFolio"></div></div><div class="rejilla">
      <label>Proveedor *<select id="ocProv">${opts((D().proveedores || []).filter(p => p.activo), o.prov, 'Selecciona…')}</select></label>
      <label>Sucursal destino<select id="ocSuc" ${ed ? 'disabled' : ''}>${optsSuc(o.suc)}</select></label>
      <label>Nota / remisión del proveedor<input id="ocNota" value="${esc(o.nota || '')}" placeholder="Serie y folio"></label>
      <label>No. factura<input id="ocFac" value="${esc(o.factura)}" ${ed ? 'disabled title="Se edita con 🧾 Editar factura en la orden"' : ''}></label><label>Fecha<input type="date" id="ocFecha" value="${o.fecha}"></label>
      <label>Días de crédito<input type="number" id="ocDias" value="${o.dias}" placeholder="Del proveedor"></label>
      <label>Desc. especial %<input type="number" id="ocDE" value="${o.descEsp}"></label><label>Desc. pronto pago %<input type="number" id="ocPP" value="${o.descPP}"></label>
      <label>Flete $<input type="number" id="ocFlete" value="${o.flete}"></label>
      ${ed ? '' : `<label class="check"><input type="checkbox" id="ocRec" ${o.recibido ? 'checked' : ''}> Mercancía ya recibida (entra al inventario y pide lote y caducidad)</label>`}
      <label class="check"><input type="checkbox" id="ocCosto" ${o.actCosto ? 'checked' : ''}> Actualizar costo del producto</label>
      <label style="grid-column:1/-1">Observaciones<input id="ocObs" value="${esc(o.obs)}"></label></div></div>
      <div class="tarjeta"><div class="buscador buscador-prod"><input id="ocProd" enterkeyhint="search" placeholder="🔍 Agregar producto…" autocomplete="off"></div><div class="espacio"></div><div class="doc-lineas" id="ocLineas"></div></div>
      <div class="tarjeta">${ed ? '' : `<div class="fila"><label>Pagar ahora $<input type="number" id="ocPago" value="${o.pago}"></label><label>Forma<select id="ocForma">${opts(cat.formasPago, '3')}</select></label><label>Cuenta<select id="ocBanco">${opts(cat.bancos, '')}</select></label></div>`}
      <div class="totales" id="ocTot" style="margin-top:12px"></div><div class="acciones">${ed ? '<button class="btn" onclick="App.salirEdicionCompra()">Salir sin guardar</button>' : '<button class="btn peligro" onclick="App.limpiarCompra()">Descartar</button>'}<button class="btn primario" id="ocGuardar" onclick="App.guardarCompra()">💾 ${ed ? 'Guardar cambios' : 'Guardar orden'}</button></div></div>`;
    const bind = (id, k, tipo) => { const el = $(id); el.oninput = el.onchange = e => { o[k] = tipo === 'c' ? e.target.checked : tipo === 'n' ? Number(e.target.value) || 0 : e.target.value; totalesCompra(); }; };
    bind('#ocProv', 'prov'); bind('#ocSuc', 'suc'); bind('#ocFac', 'factura'); bind('#ocNota', 'nota'); bind('#ocFecha', 'fecha'); bind('#ocDias', 'dias'); bind('#ocDE', 'descEsp', 'n'); bind('#ocPP', 'descPP', 'n');
    if (ed) $('#ocFolio').innerHTML = `<span class="folio-et">Orden de Compra · serie y folio</span><b>${esc(o.folio)}</b><small>editando (el folio no cambia)</small>`;
    else { $('#ocSuc').addEventListener('change', () => mostrarFolio('ocFolio', o.suc, 'Orden de Compra')); mostrarFolio('ocFolio', o.suc, 'Orden de Compra'); }
    bind('#ocFlete', 'flete', 'n'); bind('#ocCosto', 'actCosto', 'c'); bind('#ocObs', 'obs');
    if (!ed) { bind('#ocPago', 'pago', 'n'); $('#ocRec').onchange = e => { o.recibido = e.target.checked; pintarLineasCompra(); }; }
    buscador($('#ocProd'), { fuente: fuenteProductos(o.suc, null, false), limpiar: true, alElegir: x => { o.lineas.push(lineaCompra(x.id, 1, o.prov)); pintarLineasCompra(); } });
    // al cambiar de proveedor, los precios que puso la app se toman de la última compra con ese proveedor
    $('#ocProv').addEventListener('change', () => { let n = 0; o.lineas.forEach(l => { if (!l.auto) return; const c = costoCompra(l.id, o.prov); if (c.precio !== l.precio || c.desc !== l.desc) n++; Object.assign(l, { precio: c.precio, desc: c.desc, ref: c.ref }); }); if (n) { pintarLineasCompra(); toast(n + ' precio(s) tomados de la última compra con este proveedor'); } });
    pintarLineasCompra();
  }
  function pintarLineasCompra() {
    const o = S.oc, cont = $('#ocLineas');
    cont.innerHTML = !o.lineas.length ? '<div class="vacio">Agrega productos</div>' :
      `<div class="linea cab"><div>Producto</div><div>${o.recibido ? 'Lote y caducidad *' : 'Lote y caducidad (opcional)'}</div><div>Cant.</div><div>Costo</div><div>Desc %</div><div class="num">Importe</div><div></div></div>` +
      o.lineas.map((l, i) => { const p = prod(l.id) || {}; return `<div class="linea" data-i="${i}"><div class="nom"><b>${esc(p.nombre)}</b><small>${esc(l.id)}</small></div>
        <div style="display:flex;gap:4px">${p.usaLote === false ? '<small class="muted">Sin lote</small>' : `<input data-f="lote" placeholder="${o.recibido ? 'Lote' : 'Lote (si ya lo sabes)'}" title="${o.recibido ? '' : 'Opcional: si la nota o cotización del proveedor ya trae lote y caducidad. Se confirman al recibir.'}" value="${esc(l.lote || '')}"><input type="date" data-f="cad" value="${esc(l.cad || '')}">`}</div>
        <div><input type="number" data-f="cant" value="${l.cant}"></div><div><input type="number" data-f="precio" step="0.01" value="${l.precio}">${l.auto && l.ref ? `<small class="muted" data-ult style="display:block;white-space:nowrap" title="Precio de la compra más reciente${l.ref.oc ? ' (' + esc(l.ref.oc) + ')' : ''}${l.ref.otro ? ', con otro proveedor' : ''}">últ. ${esc(l.ref.f)}${l.ref.otro ? ' · otro prov.' : ''}</small>` : ''}</div><div><input type="number" data-f="desc" value="${l.desc}"></div>
        <div class="num" data-imp></div><div><button class="icono" data-del>✕</button></div></div>`; }).join('');
    cont.oninput = cont.onchange = e => { const f = e.target.dataset.f, row = e.target.closest('[data-i]'); if (!f || !row) return; const l = o.lineas[+row.dataset.i]; l[f] = (f === 'lote' || f === 'cad') ? e.target.value : Number(e.target.value) || 0; if ((f === 'precio' || f === 'desc') && l.auto) { l.auto = false; const h = row.querySelector('[data-ult]'); if (h) h.remove(); } totalesCompra(); };
    cont.onclick = e => { if (e.target.closest('[data-del]')) { o.lineas.splice(+e.target.closest('[data-i]').dataset.i, 1); pintarLineasCompra(); } };
    totalesCompra();
  }
  function totalesCompra() {
    const o = S.oc; let sub = 0, iva = 0;
    const de = o.descEsp / 100, pp = o.descPP / 100;
    document.querySelectorAll('#ocLineas .linea[data-i]').forEach(r => {
      const l = o.lineas[+r.dataset.i], p = prod(l.id) || {};
      const s = l.cant * l.precio, d = s * l.desc / 100; sub += s - d; iva += (s - d) * (1 - de) * (1 - pp) * (p.iva || 0);
      r.querySelector('[data-imp]').textContent = $$(s - d);
    });
    const dE = sub * de, dP = (sub - dE) * pp, tot = sub - dE - dP + iva + (o.flete || 0);
    $('#ocTot').innerHTML = `<div><span>Subtotal</span><span>${$$(sub)}</span></div>${dE ? `<div><span>Desc. especial</span><span>−${$$(dE)}</span></div>` : ''}${dP ? `<div><span>Pronto pago</span><span>−${$$(dP)}</span></div>` : ''}<div><span>IVA</span><span>${$$(iva)}</span></div><div class="gran"><span>Total</span><span>${$$(tot)}</span></div>`;
  }
  function limpiarCompra() { if (confirm('¿Descartar la orden?')) { S.oc = null; nuevaCompra(); } }
  function salirEdicionCompra() { const id = S.oc && S.oc.editId; if (S.oc && !confirm('¿Salir sin guardar los cambios?')) return; S.oc = null; V.compras('lista'); if (id) verCompra(id); }
  async function guardarCompra() {
    const o = S.oc;
    if (!o.prov) return toast('Selecciona el proveedor', true);
    if (!o.lineas.length) return toast('Agrega productos', true);
    if (o.recibido && !o.editId) {
      const f = o.lineas.find(l => { const p = prod(l.id) || {}; return p.usaLote !== false && (!String(l.lote || '').trim() || (p.usaCad !== false && !l.cad)); });
      if (f) return toast('Captura el lote y la caducidad de ' + ((prod(f.id) || {}).nombre || f.id) + ' (o desmarca "Mercancía ya recibida" y recíbela después)', true);
    }
    if (o.editId) {
      try {
        const r = await pedir('editarCompra', { ID_O_Compra: o.editId, ID_Proveedor: o.prov, Fecha: o.fecha, D_credito: o.dias, descEspecial: o.descEsp, descPP: o.descPP, Flete: o.flete,
          actualizarCosto: o.actCosto, Observaciones: o.obs, No_Nota: o.nota || '', lineas: o.lineas.map(l => ({ ID_Producto: l.id, Cantidad: l.cant, Precio: l.precio, Desc_pct: l.desc, Lote: l.lote || '', F_Caducidad: l.cad || '' })) });
        toast('✔ Orden ' + r.folio + ' actualizada'); S.oc = null; S.cacheTot = {}; if (o.actCosto) refrescarDatos(true).catch(() => {}); V.compras('lista'); verCompra(r.ID_O_Compra);
      } catch (e) {}
      return;
    }
    try {
      const r = await pedir('guardarCompra', { ID_O_Compra: uid(), ID_Proveedor: o.prov, Suc_Destino: o.suc, No_Factura: o.factura, No_Nota: o.nota || '', Fecha: o.fecha, D_credito: o.dias,
        descEspecial: o.descEsp, descPP: o.descPP, Flete: o.flete, Recibido: o.recibido, actualizarCosto: o.actCosto, Observaciones: o.obs,
        lineas: o.lineas.map(l => ({ ID_Producto: l.id, Cantidad: l.cant, Precio: l.precio, Desc_pct: l.desc, Lote: l.lote || '', F_Caducidad: l.cad || '' })), cfdiUuid: o.cfdi ? o.cfdi.uuid : '',
        pago: o.pago > 0 ? { monto: o.pago, forma: $('#ocForma').value, banco: $('#ocBanco').value } : null, ID_Requisicion: o.req ? o.req.id : '' });
      toast('✔ Orden ' + r.folio + ' guardada' + (o.req ? ' · ligada a la requisición ' + o.req.folio : '')); S.oc = null; S.cacheTot = {}; refrescarStock(); if (o.actCosto) refrescarDatos(true).catch(() => {}); V.compras('lista');
    } catch (e) {}
  }


  /* ---------- ANÁLISIS DE COMPRAS (producto por producto, proveedor y mes) ---------- */
  const MESES_C = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const fechaTxt = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '';
  const mesTxt = k => { const [y, m] = String(k).split('-'); return MESES_C[Number(m) - 1] + ' ' + y; };
  V.anCompras = () => {
    const h = hoyISO();
    if (!S.fan) S.fan = { desde: h.slice(0, 4) + '-01-01', hasta: h, prov: '', cat: '', texto: '', suc: '', solo: false, tab: 'prod', orden: 'importe' };
    const f = S.fan, cats = [...new Set((D().productos || []).map(p => p.categoria || 'Sin categoría'))].sort().map(c => ({ id: c, nombre: c }));
    $('#vista').innerHTML = `<div class="tarjeta no-imprimir"><div class="fila">
      <label>Desde<input type="date" id="anDesde" value="${f.desde}"></label><label>Hasta<input type="date" id="anHasta" value="${f.hasta}"></label>
      <label>Proveedor<select id="anProv">${opts((D().proveedores || []).slice().sort((a, b) => String(a.nombre).localeCompare(b.nombre)), f.prov, 'Todos')}</select></label>
      <label>Categoría<select id="anCat">${opts(cats, f.cat, 'Todas')}</select></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="anSuc">${optsSuc(f.suc, false, 'Todas')}</select></label>` : ''}
      <label>Producto<input id="anTxt" placeholder="Nombre, clave o laboratorio" value="${esc(f.texto)}"></label>
      <label class="check fijo"><input type="checkbox" id="anSolo" ${f.solo ? 'checked' : ''}> Solo con factura o nota</label>
      <button class="btn primario fijo" onclick="App.cargarAnCompras()">Buscar</button><button class="btn fijo" onclick="App.excelAnCompras()">⬇️ Excel</button></div></div>
      <div class="espacio"></div><div id="anRes"><div class="vacio">Cargando…</div></div>`;
    $('#anTxt').onkeydown = e => { if (e.key === 'Enter') cargarAnCompras(); };
    ['#anProv', '#anCat', '#anSuc', '#anSolo'].forEach(k => { if ($(k)) $(k).onchange = cargarAnCompras; });
    agregarMesAnio('anDesde', 'anHasta', cargarAnCompras);
    cargarAnCompras();
  };
  async function cargarAnCompras() {
    const f = S.fan; f.desde = $('#anDesde').value; f.hasta = $('#anHasta').value; f.prov = $('#anProv').value; f.cat = $('#anCat').value; f.texto = $('#anTxt').value.trim();
    f.suc = $('#anSuc') ? $('#anSuc').value : ''; f.solo = $('#anSolo').checked;
    const nq = S.qAn = (S.qAn || 0) + 1; $('#anRes').innerHTML = '<div class="vacio">Calculando…</div>';
    let r; try { r = await pedir('analisisCompras', { desde: f.desde, hasta: f.hasta, idProveedor: f.prov, categoria: f.cat, texto: f.texto, sucursal: f.suc, soloFactura: f.solo }); }
    catch (e) { if (nq === S.qAn && $('#anRes')) $('#anRes').innerHTML = `<div class="vacio">${e.red ? 'El análisis requiere conexión.' : esc(e.message || 'No se pudo calcular')}</div>`; return; }
    if (nq !== S.qAn || !$('#anRes')) return;
    S.an = r; pintarAnCompras();
  }
  function pintarAnCompras() {
    const r = S.an, f = S.fan, t = r.totales, vi = r.verImp; if (!r || !$('#anRes')) return;
    S.charts.forEach(c => c.destroy()); S.charts = [];
    const ord = (a, b) => f.orden === 'piezas' ? b.piezas - a.piezas : f.orden === 'ordenes' ? b.ordenes - a.ordenes : f.orden === 'nombre' ? String(a.nombre).localeCompare(b.nombre) : ((b.importe || 0) - (a.importe || 0) || b.piezas - a.piezas);
    const tb = (id, n) => `<button class="${f.tab === id ? 'activo' : ''}" onclick="App.tabAnCompras('${id}')">${n}</button>`;
    const bon = x => x.bonif ? `<br><small class="muted">+${nf(x.bonif)} bonif.</small>` : '';
    let cuerpo = '';
    if (f.tab === 'prod') {
      S.anLista = r.productos.slice().sort(ord);
      cuerpo = `<div class="fila" style="margin-bottom:8px"><span class="muted peq" style="flex:1">${nf(r.productos.length)} productos · toca uno para ver cada compra, precios por proveedor y por mes</span>
        <label class="fijo">Ordenar por<select onchange="App.ordenAnCompras(this.value)">${[['importe', 'Importe'], ['piezas', 'Piezas'], ['ordenes', 'Órdenes'], ['nombre', 'Nombre']].filter(o => vi || o[0] !== 'importe').map(o => `<option value="${o[0]}" ${f.orden === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></label></div>` +
        tabla([{ t: '#', num: 1, h: x => S.anLista.indexOf(x) + 1 }, { t: 'Producto', h: x => `<b>${esc(x.nombre)}</b><br><small class="muted">${esc(x.id)} · ${esc(x.cat)}${x.lab ? ' · ' + esc(x.lab) : ''}</small>` },
          { t: 'Piezas', num: 1, h: x => nf(x.piezas) + bon(x) }]
          .concat(vi ? [{ t: 'Importe', num: 1, h: x => `<b>${$$(x.importe)}</b>` }, { t: 'Precio prom.', num: 1, h: x => x.pProm !== null ? $$(x.pProm) : '—' },
            { t: 'Mín – máx', num: 1, cls: 'ocultar-movil', h: x => x.pMin !== null ? (x.pMin === x.pMax ? $$(x.pMin) : $$(x.pMin) + ' – ' + $$(x.pMax)) : '—' }] : [])
          .concat([{ t: 'Última compra', cls: 'ocultar-movil', h: x => x.ult ? `${vi && x.ult.p !== null ? '<b>' + $$(x.ult.p) + '</b> · ' : ''}${esc(x.ult.f)}<br><small class="muted">${esc(x.ult.prov)}</small>` : '—' },
            { t: 'Prov.', num: 1, cls: 'ocultar-movil', h: x => x.nProv }, { t: 'Órdenes', num: 1, h: x => x.ordenes }]), S.anLista, { clic: 'App.anProducto', vacio: 'No hay compras con esos filtros' });
    } else if (f.tab === 'prov') {
      S.anListaProv = r.proveedores.slice().sort(ord);
      cuerpo = tabla([{ t: 'Proveedor', h: x => `<b>${esc(x.nombre)}</b>` }, { t: 'Productos', num: 1, h: x => x.productos }, { t: 'Piezas', num: 1, h: x => nf(x.piezas) + bon(x) }]
        .concat(vi ? [{ t: 'Importe', num: 1, h: x => `<b>${$$(x.importe)}</b>` }, { t: '% del total', num: 1, h: x => t.importe ? (x.importe / t.importe * 100).toFixed(1) + '%' : '—' }] : [])
        .concat([{ t: 'Órdenes', num: 1, h: x => x.ordenes }]), S.anListaProv, { clic: 'App.anProveedor', vacio: 'No hay compras con esos filtros' });
    } else {
      cuerpo = tabla([{ t: 'Mes', h: x => `<b>${mesTxt(x.mes)}</b>` }, { t: 'Piezas', num: 1, h: x => nf(x.piezas) + bon(x) }].concat(vi ? [{ t: 'Importe', num: 1, h: x => `<b>${$$(x.importe)}</b>` }] : [])
        .concat([{ t: 'Órdenes', num: 1, h: x => x.ordenes }]), r.meses.slice().reverse(), { vacio: 'No hay compras con esos filtros' });
    }
    const top = r.productos.slice().sort((a, b) => vi ? (b.importe || 0) - (a.importe || 0) : b.piezas - a.piezas).slice(0, 10);
    $('#anRes').innerHTML = `<div class="kpis">
      ${vi ? `<div class="kpi"><small>Comprado (sin IVA)</small><b>${$$(t.importe)}</b><span>${t.ordenes} ${t.ordenes === 1 ? 'orden' : 'órdenes'}</span></div>` : ''}
      <div class="kpi"><small>Piezas compradas</small><b>${nf(t.piezas)}</b><span>${t.bonif ? '+' + nf(t.bonif) + ' bonificadas' : 'sin bonificaciones'}</span></div>
      <div class="kpi"><small>Productos distintos</small><b>${nf(t.productos)}</b><span>${t.proveedores} ${t.proveedores === 1 ? 'proveedor' : 'proveedores'}</span></div>
      ${r.meses.length ? `<div class="kpi"><small>Promedio mensual</small><b>${vi ? $$(t.importe / r.meses.length) : nf(t.piezas / r.meses.length)}</b><span>${r.meses.length} ${r.meses.length === 1 ? 'mes' : 'meses'} con compras</span></div>` : ''}
      </div>
      ${r.meses.length ? `<div class="rejilla-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">
        <div class="tarjeta"><h3 style="margin-top:0">${vi ? 'Compras' : 'Piezas'} por mes</h3><div class="grafica" style="height:240px"><canvas id="gAnMes"></canvas></div></div>
        <div class="tarjeta"><h3 style="margin-top:0">Los 10 más comprados</h3><div class="grafica" style="height:240px"><canvas id="gAnTop"></canvas></div></div></div>` : ''}
      <div class="tarjeta"><div class="pestanas" style="margin-bottom:10px">${tb('prod', '💊 Por producto')}${tb('prov', '🏭 Por proveedor')}${tb('mes', '📅 Por mes')}</div>${cuerpo}</div>`;
    if (r.meses.length) {
      const val = x => vi ? x.importe : x.piezas;
      grafica('gAnMes', { type: 'bar', data: { labels: r.meses.map(x => mesTxt(x.mes)), datasets: [{ data: r.meses.map(val), backgroundColor: css('--s1'), borderRadius: 4, maxBarThickness: 30 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => vi ? $$(c.raw) : nf(c.raw) + ' pzs' } } }, scales: { y: { ticks: { callback: vi ? tickMoneda : v => nf(v) } }, x: { grid: { display: false } } } } });
      grafica('gAnTop', { type: 'bar', data: { labels: top.map(x => x.nombre), datasets: [{ data: top.map(val), backgroundColor: css('--s2'), borderRadius: 4, maxBarThickness: 22 }] },
        options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => vi ? $$(c.raw) : nf(c.raw) + ' pzs' } } },
          scales: { x: { ticks: { callback: vi ? tickMoneda : v => nf(v) } }, y: { grid: { display: false }, ticks: { autoSkip: false, callback: function (v) { const l = this.getLabelForValue(v); return l.length > 26 ? l.slice(0, 25) + '…' : l; } } } } } });
    }
  }
  function tabAnCompras(t) { S.fan.tab = t; pintarAnCompras(); }
  function ordenAnCompras(o) { S.fan.orden = o; pintarAnCompras(); }
  function anProveedor(i) { const x = S.anListaProv[i]; if (!x || !x.id) return; S.fan.prov = x.id; S.fan.tab = 'prod'; $('#anProv').value = x.id; cargarAnCompras(); }
  async function anProducto(i) {
    const x = S.anLista[i]; if (!x) return; const f = S.fan, vi = S.an.verImp;
    modal('📊 ' + x.nombre, '<div class="vacio">Cargando compras…</div>');
    let r; try { r = await pedir('analisisCompras', { desde: f.desde, hasta: f.hasta, idProveedor: f.prov, categoria: f.cat, texto: '', sucursal: f.suc, soloFactura: f.solo, producto: x.id }); } catch (e) { return; }
    const p = r.productos.find(y => y.id === x.id) || x, l = r.lineas;
    const porMes = {}; l.forEach(y => { const m = porMes[y.mes] = porMes[y.mes] || { mes: y.mes, piezas: 0, bonif: 0, importe: 0 }; if (y.bonif) m.bonif += y.cant; else { m.piezas += y.cant; m.importe += y.importe || 0; } });
    modal('📊 ' + p.nombre, `<p class="muted" style="margin-top:0">${esc(p.id)} · ${esc(p.cat)}${p.lab ? ' · ' + esc(p.lab) : ''} · del ${esc(fechaTxt(f.desde))} al ${esc(fechaTxt(f.hasta))}</p>
      <div class="kpis"><div class="kpi"><small>Piezas</small><b>${nf(p.piezas)}</b><span>${p.bonif ? '+' + nf(p.bonif) + ' bonificadas' : p.ordenes + ' órdenes'}</span></div>
        ${vi ? `<div class="kpi"><small>Importe</small><b>${$$(p.importe)}</b><span>sin IVA</span></div><div class="kpi"><small>Precio promedio</small><b>${p.pProm !== null ? $$(p.pProm) : '—'}</b><span>${p.pMin !== null ? 'de ' + $$(p.pMin) + ' a ' + $$(p.pMax) : ''}</span></div>` : ''}
        ${p.ult ? `<div class="kpi"><small>Última compra</small><b>${vi && p.ult.p !== null ? $$(p.ult.p) : esc(p.ult.f)}</b><span>${esc(p.ult.f)} · ${esc(p.ult.prov)}</span></div>` : ''}</div>
      ${p.provs && p.provs.length > 0 ? `<h4>Por proveedor</h4>` + tabla([{ t: 'Proveedor', k: 'n' }, { t: 'Piezas', num: 1, h: y => nf(y.piezas) }].concat(vi ? [{ t: 'Importe', num: 1, h: y => $$(y.importe) }, { t: 'Precio prom.', num: 1, h: y => y.pProm !== null ? $$(y.pProm) : '—' }] : []), p.provs) : ''}
      <h4>Por mes</h4>` + tabla([{ t: 'Mes', h: y => mesTxt(y.mes) }, { t: 'Piezas', num: 1, h: y => nf(y.piezas) + (y.bonif ? ' <small class="muted">+' + nf(y.bonif) + ' bonif.</small>' : '') }].concat(vi ? [{ t: 'Importe', num: 1, h: y => $$(y.importe) }, { t: 'Precio prom.', num: 1, h: y => y.piezas ? $$(y.importe / y.piezas) : '—' }] : []),
        Object.values(porMes).sort((a, b) => b.mes.localeCompare(a.mes))) +
      `<h4>Cada compra</h4>` + tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Orden', h: y => `<a href="#" onclick="App.abrirCompraId('${esc(y.idOC)}');return false">${esc(y.folio)}</a>` }, { t: 'Proveedor', k: 'proveedor' },
        { t: 'Cant.', num: 1, h: y => nf(y.cant) + (y.bonif ? ' <span class="etq">bonif.</span>' : '') }].concat(vi ? [{ t: 'Precio', num: 1, h: y => $$(y.precio) + (y.desc ? '<br><small class="muted">−' + y.desc + '%</small>' : '') }, { t: 'Importe', num: 1, h: y => $$(y.importe) }] : [])
        .concat([{ t: 'Lote', cls: 'ocultar-movil', h: y => y.recibido ? esc(y.lote) : '<span class="muted">por recibir</span>' }]), l, { vacio: 'Sin compras en el periodo' }));
  }
  async function excelAnCompras() {
    const r = S.an, f = S.fan; if (!r) return toast('Primero busca', true);
    const vi = r.verImp, prov = f.prov ? ((D().proveedores || []).find(p => p.id === f.prov) || {}).nombre : 'Todos';
    const sub = ['Del ' + fechaTxt(f.desde) + ' al ' + fechaTxt(f.hasta) + ' · proveedor: ' + prov + (f.cat ? ' · categoría: ' + f.cat : '') + (f.texto ? ' · producto: ' + f.texto : ''), 'Importes sin IVA' + (f.solo ? ' · solo órdenes con factura o nota' : ''), hoyTxt()];
    toast('Armando Excel…');
    try {
      const blob = await excelLocal('compras', [
        { nombre: 'Por producto', titulo: 'Compras por producto', sub: sub, resumen: [['Piezas', r.totales.piezas, 'num'], ['Bonificadas', r.totales.bonif, 'num']].concat(vi ? [['Importe', r.totales.importe, 'mon']] : []).concat([['Productos', r.totales.productos, 'num']]),
          cols: [{ t: 'Clave', w: 12 }, { t: 'Producto', w: 40 }, { t: 'Categoría', w: 18 }, { t: 'Laboratorio', w: 18 }, { t: 'Piezas', w: 10, fmt: 'num', suma: 1 }, { t: 'Bonificadas', w: 11, fmt: 'num', suma: 1 }]
            .concat(vi ? [{ t: 'Importe', w: 14, fmt: 'mon', suma: 1 }, { t: 'Precio prom.', w: 13, fmt: 'mon' }, { t: 'Precio mín.', w: 12, fmt: 'mon' }, { t: 'Precio máx.', w: 12, fmt: 'mon' }] : [])
            .concat([{ t: 'Última compra', w: 13 }, { t: 'Último proveedor', w: 22 }, { t: 'Proveedores', w: 11, fmt: 'num' }, { t: 'Órdenes', w: 10, fmt: 'num', suma: 1 }]),
          filas: r.productos.map(x => ({ v: [x.id, x.nombre, x.cat, x.lab, x.piezas, x.bonif].concat(vi ? [x.importe, x.pProm, x.pMin, x.pMax] : []).concat([x.ult ? x.ult.f : '', x.ult ? x.ult.prov : '', x.nProv, x.ordenes]) })) },
        { nombre: 'Por proveedor', titulo: 'Compras por proveedor', sub: sub, cols: [{ t: 'Proveedor', w: 34 }, { t: 'Productos', w: 11, fmt: 'num' }, { t: 'Piezas', w: 11, fmt: 'num', suma: 1 }, { t: 'Bonificadas', w: 11, fmt: 'num', suma: 1 }]
            .concat(vi ? [{ t: 'Importe', w: 15, fmt: 'mon', suma: 1 }] : []).concat([{ t: 'Órdenes', w: 10, fmt: 'num', suma: 1 }]),
          filas: r.proveedores.map(x => ({ v: [x.nombre, x.productos, x.piezas, x.bonif].concat(vi ? [x.importe] : []).concat([x.ordenes]) })) },
        { nombre: 'Por mes', titulo: 'Compras por mes', sub: sub, cols: [{ t: 'Mes', w: 14 }, { t: 'Piezas', w: 11, fmt: 'num', suma: 1 }, { t: 'Bonificadas', w: 11, fmt: 'num', suma: 1 }].concat(vi ? [{ t: 'Importe', w: 15, fmt: 'mon', suma: 1 }] : []).concat([{ t: 'Órdenes', w: 10, fmt: 'num', suma: 1 }]),
          filas: r.meses.map(x => ({ v: [mesTxt(x.mes), x.piezas, x.bonif].concat(vi ? [x.importe] : []).concat([x.ordenes]) })) }]);
      entregarArchivo(blob, 'Análisis de compras ' + f.desde + ' a ' + f.hasta + '.xlsx', 'Excel de compras');
    } catch (e) { toast('No se pudo armar el Excel: ' + (e.message || e), true); }
  }

  /* ---------- TRASPASOS ---------- */
  V.traspasos = (tab) => {
    tab = tab || S.tabTr || 'lista'; S.tabTr = tab;
    const tb = (id, n) => `<button class="${tab === id ? 'activo' : ''}" onclick="App.vistaTraspasos('${id}')">${n}</button>`;
    $('#vista').innerHTML = `<div class="pestanas">${tb('lista', 'Traspasos')}${tb('tienda', 'Por tienda')}${tb('nuevo', '+ Nuevo traspaso')}</div><div id="tCont"></div>`;
    if (tab !== 'nuevo') {
      const h = hoyISO();
      if (!S.ftr) S.ftr = { desde: h.slice(0, 8) + '01', hasta: h, hastaHoy: h, origen: '', destino: '', texto: '', sucursal: '' };
      alDia(S.ftr);
      const f = S.ftr, todas = (D().sucursales || []);
      $('#tCont').innerHTML = `<div class="tarjeta no-imprimir"><div class="fila">
        <label>Desde<input type="date" id="ftDesde" value="${f.desde}"></label><label>Hasta<input type="date" id="ftHasta" value="${f.hasta}"></label>
        ${U().todasSucursales ? `<label>Sucursal (origen o destino)<select id="ftSuc">${opts(todas, f.sucursal || '', 'Todas')}</select></label>` : ''}
        <label>Origen<select id="ftOri">${opts(todas, f.origen, 'Todas')}</select></label><label>Destino<select id="ftDes">${opts(todas, f.destino, 'Todas')}</select></label>
        <label>Buscar<input id="ftTxt" placeholder="Folio o quien recibió" value="${esc(f.texto)}"></label>
        <button class="btn primario fijo" onclick="App.cargarTraspasos()">Buscar</button>
        <button class="btn fijo" onclick="App.pdfReporteTraspasos()">📄 Reporte PDF</button></div></div><div class="espacio"></div><div id="trRes"><div class="vacio">Cargando…</div></div>`;
      $('#ftTxt').onkeydown = e => { if (e.key === 'Enter') cargarTraspasos(); };
      agregarMesAnio('ftDesde', 'ftHasta', cargarTraspasos, 'traspasos');
      if ($('#ftSuc')) $('#ftSuc').onchange = cargarTraspasos;
      cargarTraspasos();
      return;
    }
    if (!S.tr) S.tr = { ori: sucTrabajo(), des: '', recibio: '', com: '', lineas: [], paq: '', guia: '', flete: '' };
    const t = S.tr;
    $('#tCont').innerHTML = (t.req ? `<div class="tarjeta" style="border-color:var(--aviso);background:var(--aviso-suave)"><div class="fila"><div style="flex:3 1 260px">📑 Surtiendo la <b>requisición ${esc(t.req.folio)}</b>: al registrar el traspaso se marca lo surtido.</div><button class="btn fijo chico" onclick="App.quitarReqTr()">Desligar</button></div></div>` : '') +
      `<div class="tarjeta"><div class="folio-fila"><div class="folio" id="trFolio"></div></div><div class="rejilla"><label>Origen<select id="trOri">${optsSuc(t.ori)}</select></label>
      <label>Destino<select id="trDes">${opts((D().sucursales || []).filter(s => s.id !== t.ori), t.des, 'Selecciona…')}</select></label>
      <label>Recibe<input id="trRec" value="${esc(t.recibio)}"></label><label>Comentarios<input id="trCom" value="${esc(t.com)}"></label>
      <label>Método de envío *<select id="trPaq">${opts(paqueterias(), t.paq, 'Selecciona…')}</select></label>
      <label>No. de guía<input id="trGuia" value="${esc(t.guia)}" placeholder="Si va por paquetería"></label>
      ${verImpC() ? `<label>Costo de flete $<input type="number" id="trFlete" step="0.01" min="0" value="${esc(t.flete)}" placeholder="Costo estimado o real"></label>` : ''}</div></div>
      <div class="tarjeta"><div class="buscador buscador-prod"><input id="trProd" enterkeyhint="search" placeholder="🔍 Agregar producto con existencia en origen…" autocomplete="off"></div><div class="espacio"></div><div class="doc-lineas" id="trLineas"></div>
      <div class="acciones"><button class="btn peligro" onclick="App.limpiarTraspaso()">Descartar</button><button class="btn primario" id="trGuardar" onclick="App.guardarTraspaso()">🚚 Registrar traspaso</button></div></div>`;
    $('#trOri').onchange = e => { t.ori = e.target.value; t.lineas = []; V.traspasos('nuevo'); };
    mostrarFolio('trFolio', t.ori, 'Traspaso');
    $('#trDes').onchange = e => { t.des = e.target.value; pintarLineasTr(); }; $('#trRec').oninput = e => t.recibio = e.target.value; $('#trCom').oninput = e => t.com = e.target.value;
    $('#trPaq').onchange = e => t.paq = e.target.value; $('#trGuia').oninput = e => t.guia = e.target.value; if ($('#trFlete')) $('#trFlete').oninput = e => t.flete = e.target.value;
    buscador($('#trProd'), { fuente: q => fuenteProductos(t.ori, null, false)(q).filter(x => existencia(x.id, t.ori) > 0), limpiar: true, alElegir: x => { t.lineas.push({ id: x.id, cant: 1, lote: '' }); pintarLineasTr(); } });
    pintarLineasTr();
  };
  function pintarLineasTr() {
    const t = S.tr, cont = $('#trLineas'), ep = puede('precio_editar') && verImpC();
    const listaDes = ((D().sucursales || []).find(s => s.id === t.des) || {}).lista;
    // de una sucursal a Matriz: la lista de precios que le corresponde a la sucursal que regresa el producto
    const aMatriz = !!t.des && esMatriz(t.des) && !esMatriz(t.ori);
    const listaOri = ((D().sucursales || []).find(s => s.id === t.ori) || {}).lista;
    const pLista = id => { const p = prod(id) || { precios: {} }; const l = aMatriz ? listaOri : listaDes; return (l && p.precios[l]) || p.costo || 0; };
    // IVA del renglón en pesos (precio de la lista de la tienda destino o el capturado × tasa del producto)
    const verIva = verImpC(), ivaTr = l => { if (!verIva || !t.des) return ''; const pu = l.precio !== undefined && l.precio !== '' ? Number(l.precio) || 0 : pLista(l.id);
      return $$(Math.round(Math.round((l.cant || 0) * pu * 100) / 100 * ((prod(l.id) || {}).iva || 0) * 100) / 100); };
    cont.innerHTML = (aMatriz && t.lineas.length ? `<p class="muted" style="font-size:13px;margin:0 0 6px">↩️ <b>A Matriz:</b> el producto regresa con la lista de precios de ${esc(sucNom(t.ori))}${listaOri ? ' (' + esc(listaOri) + ')' : ''}.</p>` : '') + (!t.lineas.length ? '<div class="vacio">Agrega productos</div>' :
      `<div class="linea cab"><div>Producto</div><div>Lote</div><div>Cant.</div><div>${ep ? 'Precio' : ''}</div><div class="num">${verIva ? 'IVA $' : ''}</div><div class="num">Exist. origen</div><div></div></div>` +
      t.lineas.map((l, i) => { const p = prod(l.id) || {}; return `<div class="linea" data-i="${i}"><div class="nom"><b>${esc(p.nombre)}</b><small>${esc(l.id)}${porLlegarHtml(l.id, t.ori)}</small></div>
        <div><select data-f="lote"><option value="">Auto (caduca primero)</option>${lotes(l.id, t.ori).map(x => `<option value="${esc(x.k)}" ${x.k === l.lote ? 'selected' : ''}>${esc(x.l)} · ${esc(x.c)} · ${nf(x.q)}</option>`).join('')}</select></div>
        <div><input type="number" data-f="cant" value="${l.cant}"></div>
        <div>${ep ? `<input type="number" data-f="precio" step="0.01" value="${l.precio !== undefined && l.precio !== '' ? l.precio : ''}" placeholder="${t.des ? pLista(l.id) : 'Elige destino'}" inputmode="decimal"><span data-ref>${l.precio !== undefined && l.precio !== '' ? refPrecio(pLista(l.id), l.precio) : ''}</span>` : ''}</div><div class="num" data-iva title="IVA del renglón">${ivaTr(l)}</div>
        <div class="num">${nf(existencia(l.id, t.ori))}</div><div class="lin-btns">${ep ? '<button class="icono" data-regalo title="Sin cargo ($0.01)">🎁</button>' : ''}<button class="icono" data-del>✕</button></div></div>`; }).join(''));
    cont.oninput = cont.onchange = e => { const f = e.target.dataset.f, row = e.target.closest('[data-i]'); if (!f || !row) return; const l = t.lineas[+row.dataset.i];
      if (f === 'lote') l.lote = e.target.value; else if (f === 'precio') { l.precio = e.target.value === '' ? '' : Number(e.target.value) || 0; row.querySelector('[data-ref]').innerHTML = l.precio === '' ? '' : refPrecio(pLista(l.id), l.precio); } else l[f] = Number(e.target.value) || 0;
      const ci = row.querySelector('[data-iva]'); if (ci) ci.textContent = ivaTr(l); };
    cont.onclick = e => { const row = e.target.closest('[data-i]'); if (!row) return;
      if (e.target.closest('[data-del]')) { t.lineas.splice(+row.dataset.i, 1); pintarLineasTr(); }
      else if (e.target.closest('[data-regalo]')) { t.lineas[+row.dataset.i].precio = 0.01; pintarLineasTr(); } };
  }
  /** Historial de traspasos de una sucursal (sale o entra), todas las fechas. */
  function traspasosDeSucursal(id) { S.ftr = { desde: '', hasta: '', origen: '', destino: '', texto: '', sucursal: id }; S.tabTr = 'lista'; ir('traspasos', true); }
  function leerFiltrosTr() {
    S.ftr = marcarHoy({ desde: $('#ftDesde').value, hasta: $('#ftHasta').value, origen: $('#ftOri').value, destino: $('#ftDes').value, texto: $('#ftTxt').value.trim(), sucursal: $('#ftSuc') ? $('#ftSuc').value : '' });
    return S.ftr;
  }
  async function cargarTraspasos() {
    const f = leerFiltrosTr(), nq = S.qTr = (S.qTr || 0) + 1;
    $('#trRes').innerHTML = '<div class="vacio">Cargando…</div>';
    let r; try { r = await pedir('reporteTraspasos', f); } catch (e) { if (nq === S.qTr && $('#trRes')) $('#trRes').innerHTML = `<div class="vacio">${e.red ? 'Requiere conexión.' : 'No se pudo consultar: ' + esc(e.message || '')}</div>`; return; }
    if (nq !== S.qTr) return;
    S.repTr = r;
    pintarTraspasos();
  }
  function pintarTraspasos() {
    const r = S.repTr, verC = puede('ver_costos'), imp = r && r.totales.valor !== null;
    if (!r || !$('#trRes')) return;
    const tot = `<div class="kpis">
      <div class="kpi"><small>Traspasos</small><b>${nf(r.totales.docs)}</b><span>${esc(S.ftr.desde)} a ${esc(S.ftr.hasta)}</span></div>
      <div class="kpi"><small>Piezas</small><b>${nf(r.totales.piezas)}</b><span></span></div>
      ${imp ? `<div class="kpi"><small>Valor de traspaso</small><b>${$$(r.totales.valor)}</b><span>precio de la lista de la tienda destino</span></div>` : ''}
      ${verC ? `<div class="kpi"><small>${U().costoLista ? 'A costo de lista' : 'A costo real'}</small><b>${$$(r.totales.costo)}</b><span>${U().costoLista ? 'precio costo de la lista' : 'costo de compra de los lotes'}</span></div>` : ''}
      ${imp && r.totales.flete !== undefined ? `<div class="kpi"><small>Costo de fletes</small><b>${$$(r.totales.flete)}</b><span>${r.totales.sinEnvio ? `<span class="txt-mal">${nf(r.totales.sinEnvio)} sin envío capturado</span>` : 'paquetería de los traspasos'}</span></div>` : ''}</div>`;
    if (S.tabTr === 'tienda') {
      $('#trRes').innerHTML = tot + `<div class="tarjeta"><h3>Por tienda</h3>` + tabla([{ t: 'Tienda', h: x => `<b>${esc(sucNom(x.suc))}</b>` },
        { t: 'Envió', num: 1, h: x => nf(x.envDocs) }, { t: 'Pzs enviadas', num: 1, h: x => nf(x.envPzs) }].concat(imp ? [{ t: verC ? 'Enviado (costo)' : 'Enviado ($)', num: 1, h: x => $$(verC ? x.envCosto : x.envValor) }] : []).concat([
        { t: 'Recibió', num: 1, h: x => nf(x.recDocs) }, { t: 'Pzs recibidas', num: 1, h: x => nf(x.recPzs) }]).concat(imp ? [{ t: verC ? 'Recibido (costo)' : 'Recibido ($)', num: 1, h: x => $$(verC ? x.recCosto : x.recValor) }] : []),
        r.porTienda) + `</div><div class="tarjeta"><h3>Productos más traspasados</h3>` + tabla([{ t: 'Producto', h: x => `<b>${esc(x.nombre)}</b><br><small class="muted">${esc(x.prod)}</small>` },
        { t: 'Traspasos', num: 1, h: x => nf(x.docs) }, { t: 'Piezas', num: 1, h: x => nf(x.pzs) }], r.porProducto) + '</div>';
      return;
    }
    S.lista = r.docs;
    $('#trRes').innerHTML = tot + tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` },
      { t: 'Origen', h: x => esc(sucNom(x.origen)) }, { t: 'Destino', h: x => esc(sucNom(x.destino)) }, { t: 'Renglones', num: 1, cls: 'ocultar-movil', h: x => nf(x.renglones) },
      { t: 'Piezas', num: 1, h: x => nf(x.piezas) }].concat(imp ? [{ t: 'Valor', num: 1, h: x => $$(x.valor) }] : []).concat(verC ? [{ t: U().costoLista ? 'Costo lista' : 'Costo real', num: 1, cls: 'ocultar-movil', h: x => $$(x.costo) }] : [])
      .concat([{ t: 'Envío', cls: 'ocultar-movil', h: x => x.envio ? `${esc(x.envio)}${x.guia ? `<br><small class="muted">Guía ${esc(x.guia)}</small>` : ''}` : (x.editable ? '<span class="etq av">Sin capturar</span>' : '<span class="muted">—</span>') }])
      .concat(imp ? [{ t: 'Flete', num: 1, cls: 'ocultar-movil', h: x => x.flete !== null && x.flete !== undefined ? $$(x.flete) : '<span class="muted">—</span>' }] : [])
      .concat([{ t: 'Recibió', k: 'recibio', cls: 'ocultar-movil' }]), r.docs, { clic: 'App.abrirTraspaso', vacio: 'Sin traspasos en el periodo' });
  }
  function pdfReporteTraspasos() {
    const f = leerFiltrosTr();
    generarPdf('pdfReporteTraspasos', f, { asunto: 'Reporte de traspasos', texto: 'Interés Veterinario — Reporte de traspasos ' + f.desde + ' a ' + f.hasta, volver: "App.cerrarModal()" });
  }
  function limpiarTraspaso() { S.tr = null; V.traspasos('nuevo'); }
  async function guardarTraspaso() {
    const t = S.tr;
    if (!t.des) return toast('Selecciona el destino', true);
    if (!t.lineas.length) return toast('Agrega productos', true);
    if (!t.paq) { toast('Indica el método de envío (o "Entrega física")', true); const s = $('#trPaq'); if (s) s.focus(); return; }
    try {
      const r = await pedir('guardarTraspaso', { Sucursal_Origen: t.ori, Sucursal_Destino: t.des, Recibio: t.recibio, Comentarios: t.com,
        ID_Flete: t.paq, No_Guia: t.guia, Costo_flete: t.flete, ID_Requisicion: t.req ? t.req.id : '', lineas: t.lineas.map(l => ({ ID_Producto: l.id, Cantidad: l.cant, lote: l.lote, Precio: l.precio !== undefined && l.precio !== '' ? l.precio : '' })) });
      toast('✔ Traspaso ' + r.folio + ' registrado' + (r.requisicion ? ' · requisición ' + r.requisicion.folio + ': ' + r.requisicion.estado.toLowerCase() + (r.requisicion.nueva ? '; lo pendiente (' + nf(r.requisicion.nueva.piezas) + ' pzs) pasó a la ' + r.requisicion.nueva.folio : '') : '')); S.tr = null; refrescarStock(); S.tabTr = 'lista'; V.traspasos('lista');
    } catch (e) {}
  }
  async function verTraspaso(folio) {
    try { const d = await pedir('detalleTraspaso', { folio: folio });
      const pzs = d.lineas.reduce((t, x) => t + x.cant, 0), imp = d.total !== null;
      let sub = 0, iva = 0;
      const filas = d.lineas.map((l, i) => { const im = imp ? Math.round(l.cant * (l.precio || 0) * 100) / 100 : 0, iv = imp ? (l.iva !== null && l.iva !== undefined ? l.iva : Math.round(im * (l.tasa || 0) * 100) / 100) : 0; sub += im; iva += iv;
        return `<tr class="${i % 2 ? 'par' : ''}"><td class="num"><b>${nf(l.cant)}</b></td><td>${esc(l.nombre)}${l.lab ? `<small>${esc(l.lab)}</small>` : ''}</td><td class="nowrap">${esc(l.lote)}<small>${esc(l.cad)}</small></td>
          ${imp ? `<td class="num">${$$(l.precio)}</td><td class="num">${$$(im)}</td><td class="num">${$$(iv)}</td><td class="num"><b>${$$(im + iv)}</b></td>` : ''}</tr>`; }).join('');
      const flete = imp && d.flete !== null && d.flete !== undefined ? d.flete : 0, total = Math.round((sub + iva + flete) * 100) / 100;
      const sd = (D().sucursales || []).find(x => x.id === d.origen) || {};
      modal('Traspaso ' + d.folio, `<div class="imprimible"><div class="tr-doc">${window.LOGO ? `<img class="tr-marca" src="${window.LOGO}" alt="">` : ''}
        <div class="tr-enc"><div class="tr-emp">${logoHtml()}${fotoSucDoc(d.origen)}<div><b>Interés Veterinario</b><small>${esc([sd.direccion, sd.tel ? 'Tel. ' + sd.tel : '', sd.email].filter(Boolean).join(' · '))}</small></div></div>
          <div class="tr-folio"><small>TRASPASO ENTRE ALMACENES</small><b>${esc(d.folio)}</b><span>${esc(d.fecha)}${d.hora ? ' · ' + esc(d.hora) : ''}</span></div></div>
        <div class="tr-ruta"><div class="tr-linea"></div>
          <div class="tr-punto"><i class="o"></i><small>ALMACÉN ORIGEN</small><b>${esc(String(d.origenNombre || '').toUpperCase())}</b><span>Sale ${esc(d.fecha)}${d.hora ? ' ' + esc(d.hora) : ''}</span></div>
          <div class="tr-punto envio"><small>ENVÍO</small><b>${esc(d.envio || 'Sin indicar')}</b><span>${d.guia ? 'Guía ' + esc(d.guia) : ''}</span></div>
          <div class="tr-punto"><i class="d"></i><small>ALMACÉN DESTINO</small><b>${esc(String(d.destinoNombre || '').toUpperCase())}</b><span>${d.recibio ? 'Recibe ' + esc(d.recibio) : ''}</span></div></div>
        <div class="tabla-cont"><table class="tr-tabla"><thead><tr><th class="num">Cant.</th><th>Producto</th><th>Lote / Cad.</th>${imp ? '<th class="num">Precio</th><th class="num">Importe</th><th class="num">IVA $</th><th class="num">Total</th>' : ''}</tr></thead><tbody>${filas}${imp ? `<tr class="res-total"><td colspan="4" class="num"><b>Suma de los productos</b></td><td class="num"><b>${$$(sub)}</b></td><td class="num"><b>${$$(iva)}</b></td><td class="num"><b>${$$(sub + iva)}</b></td></tr>` : ''}</tbody></table></div>
        <div class="tr-pie"><div class="muted"><b>${nf(pzs)} piezas</b> · ${d.lineas.length} productos${d.comentarios ? `<br><b>Comentarios:</b> ${esc(d.comentarios)}` : ''}</div>
          ${imp ? `<table class="tr-tot"><tr><td>Subtotal</td><td class="num">${$$(sub)}</td></tr><tr><td>IVA</td><td class="num">${$$(iva)}</td></tr><tr><td>Flete</td><td class="num">${$$(flete)}</td></tr><tr class="total"><td>TOTAL</td><td class="num">${$$(total)}</td></tr></table>` : ''}</div>
        <div class="tr-firmas"><div><span></span><b>Entregó</b><small>Almacén ${esc(d.origenNombre)}</small></div><div><span></span><b>Transportista</b><small>${esc([d.envio, d.guia].filter(Boolean).join(' · ') || '—')}</small></div><div><span></span><b>Recibió</b><small>${d.recibio ? esc(d.recibio) + ' · ' : ''}Almacén ${esc(d.destinoNombre)}</small></div></div>
      </div></div>
        ${d.id ? bloqueArch('trGuia', d.id) + bloqueArch('trFirma', d.id) : ''}
        <div class="acciones no-imprimir">${d.editable ? `<button class="btn" onclick="App.formEditarTraspaso()">✏️ Editar envío y datos</button>` : ''}<button class="btn" onclick="App.imprimir()">🖨️ Imprimir</button><button class="btn primario" onclick="App.pdfTraspaso('${esc(d.folio)}')">📄 PDF para enviar</button></div>`);
      S.trDet = d; } catch (e) {}
  }
  const verImpC = () => { const per = U().permisos || {}; return per.ver_importes !== undefined ? !!per.ver_importes : U().rol !== 'Almacenista'; };
  const paqueterias = () => { const l = (D().catalogos || {}).paqueterias || []; return l.length ? l : [{ id: ENVIO_DEFAULT, nombre: 'Entrega física' }]; };
  function formEditarTraspaso() {
    const d = S.trDet; if (!d) return;
    const paqs = paqueterias(), actual = (paqs.find(x => norm(x.nombre).trim() === norm(d.envio).trim()) || {}).id || '';
    modal('Editar traspaso ' + d.folio, `<p class="muted" style="margin-top:0">${esc(d.origenNombre)} → ${esc(d.destinoNombre)} · ${esc(d.fecha)}. Los productos y cantidades no cambian (ya se movió el inventario).</p>
      <div class="rejilla">
        <label>Método de envío *<select id="etPaq">${opts(paqs, actual, 'Selecciona…')}</select></label>
        <label>No. de guía<input id="etGuia" value="${esc(d.guia || '')}"></label>
        ${verImpC() ? `<label>Costo de flete $<input type="number" id="etFlete" step="0.01" min="0" value="${d.flete !== null && d.flete !== undefined ? d.flete : ''}"></label>` : ''}
        <label>Recibió<input id="etRec" value="${esc(d.recibio || '')}"></label>
        <label style="grid-column:1/-1">Comentarios<input id="etCom" value="${esc(d.comentarios || '')}"></label>
      </div>
      <div class="acciones"><button class="btn" onclick="App.verTraspaso('${esc(d.folio)}')">Volver</button><button class="btn primario" onclick="App.guardarEdicionTraspaso()">Guardar</button></div>`);
  }
  async function guardarEdicionTraspaso() {
    const d = S.trDet, paq = $('#etPaq').value;
    if (!paq) return toast('Indica el método de envío', true);
    const prm = { ID_Traspaso: d.id, folio: d.folio, ID_Flete: paq, No_Guia: $('#etGuia').value, Recibio: $('#etRec').value, Comentarios: $('#etCom').value };
    if ($('#etFlete')) prm.Costo_flete = $('#etFlete').value;
    try { await pedir('editarTraspaso', prm); toast('✔ Traspaso ' + d.folio + ' actualizado'); verTraspaso(d.folio); if ($('#trRes')) cargarTraspasos(); } catch (e) {}
  }
  function pdfTraspaso(folio) { generarPdf('pdfTraspaso', { folio: folio }, { asunto: 'Traspaso ' + folio, texto: 'Interés Veterinario — Traspaso ' + folio, volver: `App.verTraspaso('${folio}')` }); }

  /* ---------- REQUISICIONES DE TRASPASO (como una cotización, pero entre sucursales) ---------- */
  const REQ_ETQ = { Abierta: 'av', Parcial: 'av', Surtida: 'ok', 'Surtida parcial': 'ok', Cerrada: '', Cancelada: 'mal' };
  const etqReq = e => `<span class="etq ${REQ_ETQ[e] || ''}">${esc(e)}</span>`;
  /** Logotipo de la sucursal para su cuadro (Matriz = logotipo general), sin fondo. */
  const logoSucCaja = id => esMatriz(id) || !((D().sucursales || []).find(o => o.id === id) || {}).foto ? (window.LOGO ? `<img src="${window.LOGO}" alt="">` : '') : fotoSucDoc(id);
  const reqMatriz = () => ((D().sucursales || []).find(s => esMatriz(s.id)) || {}).id || 'SUC_MAT_1';
  const reqNueva = () => { const sol = sucTrabajo(); let sur = reqMatriz(); if (sur === sol) sur = ((D().sucursales || []).find(s => s.id !== sol) || {}).id || '';
    return { sol: sol, sur: sur, com: '', req: '', lineas: [] }; };
  const guardarBorradorReq = () => LS.set('borrador_req', S.rq);
  V.requisiciones = (tab) => {
    tab = tab || S.tabReq || 'lista'; S.tabReq = tab;
    const tb = (id, n) => `<button class="${tab === id ? 'activo' : ''}" onclick="App.vistaReq('${id}')">${n}</button>`;
    const barra = `<div class="pestanas">${tb('lista', 'Requisiciones')}${tb('nueva', S.rq && S.rq.editId ? '✏️ Editando ' + esc(S.rq.editFolio) : '+ Nueva requisición')}</div>`;
    if (tab === 'nueva') return editorReq(barra);
    const h = hoyISO();
    if (!S.freq) S.freq = { desde: h.slice(0, 8) + '01', hasta: h, hastaHoy: h, estado: '', texto: '', sucursal: '' };
    const f = alDia(S.freq);
    $('#vista').innerHTML = barra + `<div class="tarjeta no-imprimir"><div class="fila">
      <label>Desde<input type="date" id="rqDesde" value="${f.desde}"></label><label>Hasta<input type="date" id="rqHasta" value="${f.hasta}"></label>
      ${U().todasSucursales ? `<label>Sucursal (solicita o surte)<select id="rqSuc">${opts(D().sucursales || [], f.sucursal || '', 'Todas')}</select></label>` : ''}
      <label>Estado<select id="rqEst">${opts([['Abierta', 'Abiertas'], ['Surtida', 'Surtidas'], ['Surtida parcial', 'Surtidas en parte (pendiente en otra)'], ['Cerrada', 'Cerradas'], ['Cancelada', 'Canceladas']], f.estado, 'Todas')}</select></label>
      <label>Buscar<input id="rqTxt" placeholder="Folio, producto o comentario" value="${esc(f.texto)}"></label>
      <button class="btn primario fijo" onclick="App.cargarReq()">Buscar</button></div></div><div class="espacio"></div><div id="lReq"><div class="vacio">Cargando…</div></div>`;
    $('#rqTxt').onkeydown = e => { if (e.key === 'Enter') cargarReq(); };
    $('#rqEst').onchange = cargarReq; if ($('#rqSuc')) $('#rqSuc').onchange = cargarReq;
    agregarMesAnio('rqDesde', 'rqHasta', cargarReq);
    cargarReq();
  };
  async function cargarReq() {
    S.freq = marcarHoy({ desde: $('#rqDesde').value, hasta: $('#rqHasta').value, estado: $('#rqEst').value, texto: $('#rqTxt').value.trim(), sucursal: $('#rqSuc') ? $('#rqSuc').value : '' });
    let r; try { r = await pedir('listarRequisiciones', S.freq); } catch (e) { if ($('#lReq')) $('#lReq').innerHTML = '<div class="vacio">Consultar requisiciones requiere conexión.</div>'; return; }
    if (!$('#lReq')) return;
    S.lista = r.requisiciones; const k = r.kpi;
    $('#lReq').innerHTML = `<div class="kpis">
      <div class="kpi"><small>Requisiciones</small><b>${nf(k.total)}</b><span>${nf(k.surtidas)} surtidas</span></div>
      <div class="kpi"><small>Por surtir</small><b>${nf(k.abiertas + k.parciales)}</b><span>${nf(k.abiertas)} abiertas · ${nf(k.parciales)} en parte</span></div>
      <div class="kpi"><small>Piezas pendientes</small><b>${nf(k.pzsPendientes)}</b><span>de las requisiciones abiertas</span></div></div>` +
      tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Solicita', h: x => esc(sucNom(x.solicita)) }, { t: 'Surte', h: x => esc(sucNom(x.surte)) },
        { t: 'Productos', num: 1, cls: 'ocultar-movil', h: x => nf(x.renglones) }, { t: 'Piezas', num: 1, h: x => nf(x.piezas) },
        { t: 'Pendiente', num: 1, h: x => x.pendiente ? `<b>${nf(x.pendiente)}</b>` : '—' }, { t: 'Estado', h: x => etqReq(x.estado) + (x.requerida && x.pendiente ? `<br><small class="muted">para el ${esc(x.requerida)}</small>` : '') },
        { t: 'Traspasos / OC', cls: 'ocultar-movil', h: x => esc([x.traspasos, x.ocs].filter(Boolean).join(' · ')) || '—' }], r.requisiciones, { clic: 'App.abrirReq', vacio: 'Sin requisiciones en el periodo' });
  }
  function editorReq(barra) {
    if (!S.rq) S.rq = LS.get('borrador_req', null) || reqNueva();
    if ((D().permitidas || []).indexOf(S.rq.sol) < 0) S.rq = reqNueva();
    const v = S.rq, ed = !!v.editId, sucs = D().sucursales || [];
    $('#vista').innerHTML = barra + `
      ${ed ? `<div class="tarjeta" style="border-color:var(--aviso);background:var(--aviso-suave)"><div class="fila"><div style="flex:3 1 260px">✏️ <b>Editando la requisición ${esc(v.editFolio)}</b></div><button class="btn fijo" onclick="App.limpiarReq()">Salir sin guardar</button></div></div>` : ''}
      <div class="tarjeta"><div class="folio-fila"><div class="folio" id="rqFolio">${ed ? `<span class="folio-et">Requisición · editando</span><b>${esc(v.editFolio)}</b><small>${esc(sucNom(v.sol))}</small>` : ''}</div></div>
        <div class="rejilla">
        <label>Sucursal que solicita<select id="rqSol" ${ed ? 'disabled' : ''}>${optsSuc(v.sol)}</select></label>
        <label>Sucursal que surte *<select id="rqSur">${opts(sucs.filter(s => s.id !== v.sol), v.sur, 'Selecciona…')}</select></label>
        <label>Se requiere para<input type="date" id="rqReq" value="${esc(v.req || '')}"></label>
        <label>Comentarios<input id="rqCom" value="${esc(v.com)}" placeholder="Ej. surtir antes del sábado"></label></div></div>
      <div class="tarjeta"><div class="buscador buscador-prod"><input id="rqProd" enterkeyhint="search" placeholder="🔍 Agregar producto: clave, nombre, laboratorio o categoría…" autocomplete="off"></div>
        <div class="espacio"></div><div class="doc-lineas" id="rqLineas"></div><div class="muted" id="rqRes" style="margin-top:8px"></div>
        <div class="acciones"><button class="btn peligro" onclick="App.limpiarReq()">${ed ? 'Salir sin guardar' : 'Descartar'}</button>
        <button class="btn primario" id="rqGuardar" onclick="App.guardarReq()">${ed ? '💾 Guardar cambios' : '💾 Guardar requisición'}</button></div></div>`;
    if (!ed) { $('#rqSol').onchange = e => { v.sol = e.target.value; if (v.sur === v.sol) v.sur = ''; guardarBorradorReq(); V.requisiciones('nueva'); }; mostrarFolio('rqFolio', v.sol, 'Requisicion'); }
    $('#rqSur').onchange = e => { v.sur = e.target.value; guardarBorradorReq(); pintarLineasReq(); };
    $('#rqReq').onchange = e => { v.req = e.target.value; guardarBorradorReq(); };
    $('#rqCom').oninput = e => { v.com = e.target.value; guardarBorradorReq(); };
    buscador($('#rqProd'), { fuente: q => fuenteProductos(v.sur || v.sol, null, false)(q), limpiar: true, alElegir: x => {
      const ya = v.lineas.find(l => l.id === x.id); if (ya) ya.cant = (Number(ya.cant) || 0) + 1; else v.lineas.push({ id: x.id, cant: 1, nota: '' });
      guardarBorradorReq(); pintarLineasReq();
      setTimeout(() => { const ins = document.querySelectorAll('#rqLineas [data-f=cant]'); if (ins.length) ins[ins.length - 1].focus(); }, 30); } });
    pintarLineasReq();
  }
  function pintarLineasReq() {
    const v = S.rq, cont = $('#rqLineas'); if (!cont) return;
    const eSur = id => v.sur ? existencia(id, v.sur) : 0;
    cont.innerHTML = !v.lineas.length ? '<div class="vacio">Agrega los productos que necesitas</div>' :
      `<div class="linea cab"><div>Producto</div><div>Nota</div><div>Cant.</div><div class="num">Exist. ${esc(v.sur ? sucNom(v.sur) : 'surte')}</div><div class="num">Faltante</div><div class="num">Exist. ${esc(sucNom(v.sol))}</div><div></div></div>` +
      v.lineas.map((l, i) => { const p = prod(l.id) || { nombre: l.id }, ex = eSur(l.id), falta = Math.max(0, (Number(l.cant) || 0) - ex), otras = existOtras(l.id, v.sur);
        return `<div class="linea" data-i="${i}"><div class="nom"><b>${esc(p.nombre)}</b><small>${esc(l.id)}${p.lab ? ' · ' + esc(p.lab) : ''}</small>${otras ? `<small class="muted">${esc(otras)}</small>` : ''}</div>
          <div><input data-f="nota" value="${esc(l.nota || '')}" placeholder="Opcional"></div>
          <div><input type="number" data-f="cant" min="0" step="any" value="${l.cant}" inputmode="decimal"></div>
          <div class="num">${v.sur ? nf(ex) : '—'}</div><div class="num" data-falta>${falta ? `<b class="error">${nf(falta)}</b>` : '<span class="txt-ok">✔</span>'}</div>
          <div class="num">${nf(existencia(l.id, v.sol))}</div><div class="lin-btns"><button class="icono" data-del title="Quitar">✕</button></div></div>`; }).join('');
    const resumen = () => { const pz = v.lineas.reduce((a, l) => a + (Number(l.cant) || 0), 0), fal = v.lineas.reduce((a, l) => a + Math.max(0, (Number(l.cant) || 0) - eSur(l.id)), 0);
      $('#rqRes').innerHTML = v.lineas.length ? `<b>${nf(pz)}</b> piezas · ${v.lineas.length} productos${v.sur ? ` · ${fal ? `<span class="txt-mal">faltan ${nf(fal)} piezas en ${esc(sucNom(v.sur))} (se pueden pasar a orden de compra)</span>` : `<span class="txt-ok">${esc(sucNom(v.sur))} tiene existencia de todo</span>`}` : ''}` : ''; };
    cont.oninput = cont.onchange = e => { const f = e.target.dataset.f, row = e.target.closest('[data-i]'); if (!f || !row) return; const l = v.lineas[+row.dataset.i];
      if (f === 'nota') l.nota = e.target.value; else { l.cant = Number(e.target.value) || 0; const fa = Math.max(0, l.cant - eSur(l.id)); row.querySelector('[data-falta]').innerHTML = fa ? `<b class="error">${nf(fa)}</b>` : '<span class="txt-ok">✔</span>'; resumen(); }
      guardarBorradorReq(); };
    cont.onclick = e => { const row = e.target.closest('[data-i]'); if (!row || !e.target.closest('[data-del]')) return; v.lineas.splice(+row.dataset.i, 1); guardarBorradorReq(); pintarLineasReq(); };
    resumen();
  }
  function limpiarReq() {
    if (S.rq && S.rq.lineas.length && !confirm(S.rq.editId ? '¿Salir sin guardar los cambios?' : '¿Descartar la requisición en captura?')) return;
    const eraEd = !!(S.rq && S.rq.editId);
    S.rq = reqNueva(); guardarBorradorReq(); V.requisiciones(eraEd ? 'lista' : 'nueva');
  }
  async function guardarReq() {
    const v = S.rq;
    if (!v.sur) return toast('Selecciona la sucursal que surte', true);
    if (!v.lineas.length) return toast('Agrega productos', true);
    if (v.lineas.some(l => !(Number(l.cant) > 0))) return toast('Revisa las cantidades', true);
    $('#rqGuardar').disabled = true;
    try {
      const r = await pedir('guardarRequisicion', { ID_Requisicion: v.editId || v.nuevoId || (v.nuevoId = uid()), nueva: !v.editId, Suc_Solicita: v.sol, Suc_Surte: v.sur,
        Fecha_Requerida: v.req || '', Comentarios: v.com, lineas: v.lineas.map(l => ({ ID_Producto: l.id, Cantidad: l.cant, Nota: l.nota || '' })) });
      toast('✔ Requisición ' + r.folio + ' guardada · ' + nf(r.piezas) + ' piezas');
      S.rq = reqNueva(); guardarBorradorReq(); S.tabReq = 'lista';
      if (S.freq && S.freq.hasta && S.freq.hasta < hoyISO()) { S.freq.hasta = hoyISO(); S.freq.hastaHoy = S.freq.hasta; }
      V.requisiciones('lista'); verReq(r.id);
    } catch (e) { if (e.red) toast('Guardar la requisición requiere conexión (quedó en tu borrador)', true); if ($('#rqGuardar')) $('#rqGuardar').disabled = false; }
  }
  async function verReq(id) {
    let d; try { d = await pedir('detalleRequisicion', { id: id }); } catch (e) { return; }
    S.ultimaReq = d;
    const provs = {}; d.lineas.filter(l => l.falta > 0).forEach(l => { const k = l.prov ? l.prov.id : ''; (provs[k] = provs[k] || { n: l.prov ? l.prov.n : 'Sin proveedor registrado', l: [] }).l.push(l); });
    const puedeTr = d.activa && puede('traspasos') && d.tot.aTraspasar > 0, puedeOc = d.activa && puede('compras') && d.tot.falta > 0;
    modal('Requisición ' + d.folio, `<div class="imprimible">
      <div class="fila" style="justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div><b style="font-size:17px">Interés Veterinario</b><div class="muted" style="margin-top:4px">Pidió ${esc(d.solicito || '—')} · ${esc(d.fecha)}${d.hora ? ' ' + esc(d.hora) : ''}</div></div>
        <div style="text-align:right"><b>REQUISICIÓN DE TRASPASO</b><div style="font-size:18px">${esc(d.folio)}</div><div>${etqReq(d.estado)}</div>${d.requerida ? `<div class="fact-enc">Se requiere el ${esc(d.requerida)}</div>` : ''}</div></div>
      <div class="rq-cajas">
        <div class="rq-caja solicita"><div class="rq-logo">${logoSucCaja(d.solicita)}</div><div><small>Solicita</small><b>${esc(d.solicitaNombre)}</b><span>${nf(d.tot.piezas)} piezas · ${d.lineas.length} productos</span></div></div>
        <div class="rq-caja surte"><div class="rq-logo">${logoSucCaja(d.surte)}</div><div><small>Surte</small><b>${esc(d.surteNombre)}</b><span>surtido ${nf(d.tot.surtido)}${d.tot.pend ? ' · pendiente ' + nf(d.tot.pend) : ''}</span></div></div></div>
      ${d.vieneDe || d.continuaEn ? `<div class="rq-liga">${d.vieneDe ? `Viene de la requisición <a href="#" onclick="App.verReq('${esc(d.vieneId)}');return false"><b>${esc(d.vieneDe)}</b></a> (lo que quedó pendiente). ` : ''}${d.continuaEn ? `✔ Cerrada con el traspaso. Lo pendiente pasó a la requisición <a href="#" onclick="App.verReq('${esc(d.continuaId)}');return false"><b>${esc(d.continuaEn)}</b></a>.` : ''}</div>` : ''}
      ${d.activa ? `<div class="kpis" style="margin-top:12px">
        <div class="kpi"><small>Se puede traspasar</small><b>${nf(d.tot.aTraspasar)}</b><span>con la existencia de ${esc(d.surteNombre)}</span></div>
        <div class="kpi"><small>Faltante (comprar)</small><b class="${d.tot.falta ? 'error' : ''}">${nf(d.tot.falta)}</b><span>${d.tot.falta ? 'piezas que no hay en ' + esc(d.surteNombre) : 'hay existencia de todo'}</span></div></div>` : ''}
      <div class="tabla-cont"><table><thead><tr><th>Producto</th><th class="num">Solicitado</th><th class="num">Surtido</th><th class="num">Pendiente</th><th class="num">Exist. ${esc(d.surteNombre)}</th><th class="num">Faltante</th><th class="ocultar-movil">Otras sucursales</th><th class="ocultar-movil">Proveedor sugerido</th></tr></thead><tbody>
      ${d.lineas.map(l => `<tr><td><b>${esc(l.nombre)}</b><br><small>${esc([l.prod, l.lab].filter(Boolean).join(' · '))}${l.nota ? ' · ' + esc(l.nota) : ''}</small></td><td class="num"><b>${nf(l.cant)}</b></td><td class="num">${nf(l.surtido)}</td><td class="num">${l.pend ? nf(l.pend) : '—'}</td>
        <td class="num">${nf(l.exOri)}</td><td class="num">${l.falta ? `<b class="error">${nf(l.falta)}</b>` : '—'}</td>
        <td class="ocultar-movil"><small>${esc(l.otras.map(o => sucNom(o.s) + ' ' + nf(o.q)).join(' · ')) || '—'}</small></td><td class="ocultar-movil"><small>${l.falta ? esc(l.prov ? l.prov.n : 'Sin proveedor registrado') : ''}</small></td></tr>`).join('')}
      </tbody></table></div>
      ${d.importes ? `<h4 style="margin:14px 0 6px">Valor de la requisición <small class="muted">(precio de traspaso: lista de ${esc(d.listaNombre || d.solicitaNombre)}, cantidades solicitadas)</small></h4>` + tabla([{ t: 'Cant.', num: 1, h: x => nf(x.cant) }, { t: 'Producto', h: x => esc(x.nombre) }, { t: 'Precio', num: 1, h: x => $$(x.precio) }, { t: 'Importe', num: 1, h: x => $$(x.importe) }, { t: 'IVA $', num: 1, h: x => $$(x.iva) }, { t: 'Total', num: 1, h: x => `<b>${$$(x.importe + x.iva)}</b>` }], d.lineas) +
        `<div class="totales" style="margin-top:8px"><div><span>Subtotal</span><span>${$$(d.importes.sub)}</span></div><div><span>IVA</span><span>${$$(d.importes.iva)}</span></div><div class="gran"><span>Total</span><span>${$$(d.importes.total)}</span></div></div>` : ''}
      ${d.comentarios ? `<p><small><b>Comentarios:</b> ${esc(d.comentarios)}</small></p>` : ''}${d.motivo && !d.continuaEn ? `<p><small><b>${d.estado === 'Cancelada' ? 'Cancelación' : 'Cierre'}:</b> ${esc(d.motivo)}</small></p>` : ''}
      ${d.traspasos.length || d.ocs.length ? `<p class="muted"><small>${d.traspasos.length ? 'Traspasos: <b>' + d.traspasos.map(esc).join(', ') + '</b>' : ''}${d.traspasos.length && d.ocs.length ? ' · ' : ''}${d.ocs.length ? 'Órdenes de compra: <b>' + d.ocs.map(esc).join(', ') + '</b>' : ''}</small></p>` : ''}</div>
      ${puedeOc ? `<div class="tarjeta no-imprimir" style="margin-top:10px"><h3>📦 Faltantes a orden de compra</h3><p class="muted" style="margin-top:0">Se arma la orden con lo que no hay en ${esc(d.surteNombre)}, por proveedor (el de su última compra).</p>
        <div class="acciones" style="justify-content:flex-start">${Object.keys(provs).map(k => `<button class="btn" onclick="App.reqAOrden('${esc(k)}')">📦 ${esc(provs[k].n)} · ${nf(provs[k].l.reduce((a, l) => a + l.falta, 0))} pzs</button>`).join('')}</div></div>` : ''}
      <div class="acciones no-imprimir">
        <button class="btn" onclick="App.pdfReq('${d.id}')">📄 PDF</button>
        ${puedeTr ? `<button class="btn primario" onclick="App.reqATraspaso()">🚚 Armar traspaso (${nf(d.tot.aTraspasar)} pzs)</button>` : ''}
        ${d.editable ? `<button class="btn" onclick="App.editarReq()">✏️ Editar</button>` : ''}
        ${d.traspasos.length && puede('traspasos') ? d.traspasos.map(f => `<button class="btn" onclick="App.verTraspaso('${esc(f)}')">🚚 ${esc(f)}</button>`).join('') : ''}
        ${(d.estado === 'Cerrada' || d.estado === 'Cancelada') && !d.continuaEn ? `<button class="btn" onclick="App.reabrirReq('${d.id}')">↩️ Reabrir</button>` : ''}${d.continuaEn && d.continuaId ? `<button class="btn primario" onclick="App.verReq('${esc(d.continuaId)}')">📑 Ver ${esc(d.continuaEn)} (pendiente)</button>` : ''}
        ${d.activa ? `<button class="btn peligro" onclick="App.cancelarReq('${d.id}')">${d.tot.surtido ? 'Cerrar (ya no surtir lo pendiente)' : 'Cancelar'}</button>` : ''}
      </div>`);
  }
  function pdfReq(id) { const d = S.ultimaReq || {}; generarPdf('pdfRequisicion', { id: id }, { asunto: 'Requisición ' + (d.folio || ''), texto: 'Interés Veterinario — Requisición de traspaso ' + (d.folio || ''), volver: `App.verReq('${id}')` }); }
  function editarReq() {
    const d = S.ultimaReq; if (!d) return;
    if (S.rq && S.rq.lineas.length && S.rq.editId !== d.id && !confirm('Tienes una requisición en captura que se va a descartar. ¿Continuar?')) return;
    const iso = t => { const m = String(t || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
    S.rq = { editId: d.id, editFolio: d.folio, sol: d.solicita, sur: d.surte, com: d.comentarios, req: iso(d.requerida), lineas: d.lineas.map(l => ({ id: l.prod, cant: l.cant, nota: l.nota })) };
    guardarBorradorReq(); cerrarModal(); S.tabReq = 'nueva'; ir('requisiciones', true);
  }
  function reqATraspaso() {
    const d = S.ultimaReq; if (!d) return;
    if ((D().permitidas || []).indexOf(d.surte) < 0) return toast('El traspaso lo registra ' + d.surteNombre + ' (la sucursal que surte)', true);
    const l = d.lineas.filter(x => x.aTraspasar > 0);
    if (S.tr && S.tr.lineas && S.tr.lineas.length && !confirm('Ya tienes un traspaso en captura. ¿Reemplazarlo?')) return;
    S.tr = { ori: d.surte, des: d.solicita, recibio: '', com: 'Requisición ' + d.folio + (d.comentarios ? ' · ' + d.comentarios : ''), lineas: l.map(x => ({ id: x.prod, cant: x.aTraspasar, lote: '' })),
      paq: '', guia: '', flete: '', req: { id: d.id, folio: d.folio } };
    cerrarModal(); S.tabTr = 'nuevo'; ir('traspasos', true);
    toast('Traspaso armado con ' + l.length + ' productos de la requisición ' + d.folio + '. Revisa lotes y método de envío.');
  }
  function reqAOrden(prov) {
    const d = S.ultimaReq; if (!d) return;
    const l = d.lineas.filter(x => x.falta > 0 && (x.prov ? x.prov.id : '') === prov);
    if (!l.length) return;
    if (S.oc && S.oc.lineas && S.oc.lineas.length && !confirm('Ya tienes una orden de compra en captura. ¿Reemplazarla con los faltantes?')) return;
    const pv = (D().proveedores || []).find(p => p.id === prov);
    const suc = (D().permitidas || []).indexOf(d.surte) >= 0 ? d.surte : sucTrabajo();
    S.oc = { prov: pv ? prov : '', suc: suc, factura: '', fecha: hoyISO(), dias: pv ? pv.credito : '', descEsp: 0, descPP: 0, flete: 0, recibido: false, actCosto: false,
      obs: 'Faltantes de la requisición ' + d.folio, lineas: l.map(x => lineaCompra(x.prod, x.falta, pv ? prov : '')), pago: 0,
      req: { id: d.id, folio: d.folio } };
    cerrarModal(); ir('compras', true); V.compras('nueva');
    toast('Orden armada con ' + l.length + ' faltantes' + (pv ? '' : ' (elige el proveedor)') + '. Revísala y guárdala (queda pendiente de recibir).');
  }
  async function cancelarReq(id) {
    const d = S.ultimaReq || {}, cerrar = d.tot && d.tot.surtido > 0;
    const motivo = prompt(cerrar ? 'Motivo para cerrar (lo pendiente ya no se surtirá):' : 'Motivo de la cancelación:'); if (motivo === null) return;
    try { const r = await pedir('cancelarRequisicion', { id: id, motivo: motivo }); toast('Requisición ' + (r.estado === 'Cerrada' ? 'cerrada' : 'cancelada')); verReq(id); if ($('#lReq')) cargarReq(); } catch (e) {}
  }
  async function reabrirReq(id) {
    if (!confirm('¿Reabrir la requisición?')) return;
    try { await pedir('reabrirRequisicion', { id: id }); toast('Requisición reabierta'); verReq(id); if ($('#lReq')) cargarReq(); } catch (e) {}
  }

  /* ---------- AJUSTES Y MERMAS ---------- */
  V.ajustes = (tab) => {
    tab = tab || S.tabAj || 'hist'; S.tabAj = tab;
    const tb = (id, n) => `<button class="${tab === id ? 'activo' : ''}" onclick="App.vistaAjustes('${id}')">${n}</button>`;
    const barra = `<div class="pestanas">${tb('hist', '📚 Historial')}${tb('nuevo', '+ Nuevo ajuste o merma')}</div>`;
    return tab === 'hist' ? ajHistorial(barra) : ajNuevo(barra);
  };
  function ajNuevo(barra) {
    const tipos = [];
    if (puede('mermas')) tipos.push(['Merma', '🗑️ Merma (caducado, dañado…)']);
    if (puede('ajustes')) { tipos.push(['Salida', '➖ Ajuste de salida']); tipos.push(['Entrada', '➕ Ajuste de entrada']); }
    if (!S.aj) S.aj = { tipo: tipos[0][0], suc: sucTrabajo(), motivo: '', lineas: [] };
    const a = S.aj;
    $('#vista').innerHTML = barra + `<div class="tarjeta"><div class="folio-fila"><div class="folio" id="ajFolio"></div></div><div class="rejilla"><label>Tipo<select id="ajTipo">${opts(tipos, a.tipo)}</select></label>
      <label>Sucursal<select id="ajSuc">${optsSuc(a.suc)}</select></label>
      <label>Motivo *<input id="ajMot" list="ajMotivos" value="${esc(a.motivo)}"><datalist id="ajMotivos"><option>Caducado</option><option>Dañado</option><option>Pérdida</option><option>Ajuste por conteo físico</option><option>Muestra médica</option><option>Inventario inicial</option></datalist></label></div></div>
      <div class="tarjeta"><div class="buscador buscador-prod"><input id="ajProd" enterkeyhint="search" placeholder="🔍 Agregar producto…" autocomplete="off"></div><div class="espacio"></div><div class="doc-lineas" id="ajLineas"></div>
      <div class="acciones"><button class="btn peligro" onclick="App.limpiarAjuste()">Descartar</button><button class="btn primario" id="ajGuardar" onclick="App.guardarAjuste()">💾 Registrar</button></div></div>`;
    $('#ajTipo').onchange = e => { a.tipo = e.target.value; a.lineas = []; V.ajustes(); };
    $('#ajSuc').onchange = e => { a.suc = e.target.value; a.lineas = []; V.ajustes(); };
    mostrarFolio('ajFolio', a.suc, a.tipo === 'Merma' ? 'Merma' : 'Ajuste');
    $('#ajMot').oninput = e => a.motivo = e.target.value;
    buscador($('#ajProd'), { fuente: q => fuenteProductos(a.suc, null, false)(q).filter(x => a.tipo === 'Entrada' || existencia(x.id, a.suc) > 0), limpiar: true,
      alElegir: x => { a.lineas.push({ id: x.id, cant: 1, lote: '', nlote: '', cad: '' }); pintarLineasAj(); } });
    pintarLineasAj();
  };
  /* Historial de ajustes y mermas */
  const ETQ_AJ = { merma: '<span class="etq mal">🗑️ Merma</span>', salida: '<span class="etq av">➖ Ajuste salida</span>', entrada: '<span class="etq ok">➕ Ajuste entrada</span>' };
  function ajHistorial(barra) {
    const tipos = [['', 'Todos']].concat(puede('mermas') ? [['merma', 'Mermas']] : []).concat(puede('ajustes') ? [['salida', 'Ajustes de salida'], ['entrada', 'Ajustes de entrada']] : []);
    $('#vista').innerHTML = barra + `<div class="tarjeta"><div class="fila">
      <label>Desde<input type="date" id="ahDesde" value="${hoyISO().slice(0, 8) + '01'}"></label><label>Hasta<input type="date" id="ahHasta" value="${hoyISO()}"></label>
      ${U().todasSucursales ? `<label>Sucursal<select id="ahSuc">${optsSuc('', false, 'Todas')}</select></label>` : ''}
      <label>Tipo<select id="ahTipo">${opts(tipos, '')}</select></label>
      <label>Buscar<input id="ahTxt" placeholder="Folio, producto, lote o motivo"></label>
      <button class="btn primario fijo" onclick="App.buscarAjustes()">Buscar</button></div></div>
      <div class="espacio"></div><div id="lAj"></div>`;
    $('#ahTxt').onkeydown = e => { if (e.key === 'Enter') buscarAjustes(); };
    $('#ahTipo').onchange = buscarAjustes;
    agregarMesAnio('ahDesde', 'ahHasta', buscarAjustes);
    buscarAjustes();
  }
  async function buscarAjustes() {
    try {
      const r = await pedir('historialAjustes', { desde: $('#ahDesde').value, hasta: $('#ahHasta').value, sucursal: $('#ahSuc') ? $('#ahSuc').value : '', tipo: $('#ahTipo').value, texto: $('#ahTxt').value });
      if (!$('#lAj')) return;
      const R = r.resumen, vc = r.verCosto; S.lista = r.docs;
      const k = (t, x, extra) => `<div class="kpi"><small>${t}</small><b>${vc && x.importe !== null ? $$(x.importe) : nf(x.piezas) + ' pzs'}</b><span>${x.docs} ${x.docs === 1 ? 'registro' : 'registros'}${vc ? ' · ' + nf(x.piezas) + ' pzs' : ''}${extra || ''}</span></div>`;
      $('#lAj').innerHTML = `<div class="kpis">${r.verMermas ? k('🗑️ Mermas', R.merma) : ''}${r.verAjustes ? k('➖ Ajustes de salida', R.salida) + k('➕ Ajustes de entrada', R.entrada) : ''}
        ${r.motivosMerma.length ? `<div class="kpi"><small>Principal motivo de merma</small><b style="font-size:17px">${esc(r.motivosMerma[0].motivo)}</b><span>${vc ? $$(r.motivosMerma[0].valor) : nf(r.motivosMerma[0].valor) + ' pzs'}${r.motivosMerma[1] ? ' · luego ' + esc(r.motivosMerma[1].motivo) : ''}</span></div>` : ''}</div>
        ${r.total > r.docs.length ? `<p class="muted">Se muestran los ${r.docs.length} más recientes de ${r.total}. Acota las fechas para ver el resto.</p>` : ''}` + tabla([
        { t: 'Fecha', h: x => esc(x.fecha) + (x.hora ? `<br><small class="muted">${esc(x.hora)}</small>` : '') }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Tipo', h: x => ETQ_AJ[x.clase] },
        { t: 'Sucursal', cls: 'ocultar-movil', h: x => esc(sucNom(x.suc)) },
        { t: 'Productos', h: x => esc(x.productos.slice(0, 2).join(', ')) + (x.productos.length > 2 ? ` <small class="muted">+${x.productos.length - 2}</small>` : '') },
        { t: 'Piezas', num: 1, h: x => `<b>${nf(x.piezas)}</b>` }].concat(vc ? [{ t: 'Importe', num: 1, h: x => $$(x.importe) }] : []).concat([
        { t: 'Motivo', cls: 'ocultar-movil', k: 'motivo' }, { t: 'Usuario', cls: 'ocultar-movil', k: 'usuario' }]), r.docs, { clic: 'App.abrirAjuste', vacio: 'No hay ajustes ni mermas en ese periodo' });
    } catch (e) { if ($('#lAj')) $('#lAj').innerHTML = '<div class="vacio">Consultar el historial requiere conexión.</div>'; }
  }
  function verAjuste(i) {
    const d = S.lista[i]; if (!d) return;
    const vc = d.importe !== null && d.importe !== undefined;
    const titulo = d.clase === 'merma' ? 'MERMA' : d.clase === 'entrada' ? 'AJUSTE DE ENTRADA' : 'AJUSTE DE SALIDA';
    modal(titulo + ' ' + d.folio, `<div class="imprimible"><div class="nota"><div class="enc"><div><div class="doc-logos">${logoHtml()}${fotoSucDoc(d.suc)}</div><div>${esc(sucNom(d.suc))}</div></div>
      <div style="text-align:right"><b>${titulo}</b><div style="font-size:18px">${esc(d.folio)}</div><div>${esc(d.fecha)}${d.hora ? ' ' + esc(d.hora) : ''}</div></div></div>
      <p><b>Motivo:</b> ${esc(d.motivo || '—')}${d.usuario ? ` · <span class="muted">Registró: ${esc(d.usuario)}</span>` : ''}</p>
      ${tabla([{ t: 'Cant.', num: 1, h: x => nf(x.cant) }, { t: 'Clave', k: 'prod' }, { t: 'Producto', k: 'nombre' }, { t: 'Lote', k: 'lote' }, { t: 'Cad.', k: 'cad' }]
        .concat(vc ? [{ t: 'Costo', num: 1, h: x => $$(x.costo) }, { t: 'Importe', num: 1, h: x => $$(x.total) }] : []), d.lineas, { vacio: 'Este folio no tiene renglones de detalle' })}
      <p style="text-align:right;margin-top:8px"><b>${nf(d.piezas)} piezas</b>${vc ? ` · <b>Total ${$$(d.importe)}</b>` : ''}</p>
      <div style="display:flex;justify-content:space-around;margin-top:40px;text-align:center"><div>_____________________<br><small>Registró</small></div><div>_____________________<br><small>Autorizó</small></div></div></div></div>
      <div class="acciones no-imprimir"><button class="btn" onclick="App.imprimir()">🖨️ Imprimir</button></div>`);
  }
  function pintarLineasAj() {
    const a = S.aj, cont = $('#ajLineas'), ent = a.tipo === 'Entrada';
    cont.innerHTML = !a.lineas.length ? '<div class="vacio">Agrega productos</div>' :
      `<div class="linea cab"><div>Producto</div><div>${ent ? 'Lote nuevo o existente' : 'Lote'}</div><div>Cant.</div><div></div><div></div><div class="num">Existencia</div><div></div></div>` +
      a.lineas.map((l, i) => { const p = prod(l.id) || {}; const ls = lotes(l.id, a.suc);
        const loteHtml = p.usaLote === false ? '<small class="muted">Sin lote</small>' : ent ?
          `<div style="display:flex;gap:4px;flex-wrap:wrap"><select data-f="lote"><option value="">Lote nuevo →</option>${ls.map(x => `<option value="${esc(x.k)}" ${x.k === l.lote ? 'selected' : ''}>${esc(x.l)} · ${esc(x.c)}</option>`).join('')}</select>${l.lote ? '' : `<input data-f="nlote" placeholder="Lote" value="${esc(l.nlote)}"><input type="date" data-f="cad" value="${esc(l.cad)}">`}</div>` :
          `<select data-f="lote"><option value="">Auto (caduca primero)</option>${ls.map(x => `<option value="${esc(x.k)}" ${x.k === l.lote ? 'selected' : ''}>${esc(x.l)} · ${esc(x.c)} · ${nf(x.q)}</option>`).join('')}</select>`;
        return `<div class="linea" data-i="${i}"><div class="nom"><b>${esc(p.nombre)}</b><small>${esc(l.id)}</small></div><div>${loteHtml}</div>
        <div><input type="number" data-f="cant" value="${l.cant}"></div><div></div><div></div><div class="num">${nf(existencia(l.id, a.suc))}</div><div><button class="icono" data-del>✕</button></div></div>`; }).join('');
    cont.oninput = e => { const f = e.target.dataset.f, row = e.target.closest('[data-i]'); if (!f || !row) return; a.lineas[+row.dataset.i][f] = f === 'cant' ? Number(e.target.value) || 0 : e.target.value; };
    cont.onchange = e => { cont.oninput(e); if (e.target.dataset.f === 'lote' && ent) pintarLineasAj(); };
    cont.onclick = e => { if (e.target.closest('[data-del]')) { a.lineas.splice(+e.target.closest('[data-i]').dataset.i, 1); pintarLineasAj(); } };
  }
  function limpiarAjuste() { S.aj = null; V.ajustes(); }
  async function guardarAjuste() {
    const a = S.aj;
    if (!a.motivo) return toast('Indica el motivo', true);
    if (!a.lineas.length) return toast('Agrega productos', true);
    const lineas = a.lineas.map(l => ({ ID_Producto: l.id, Cantidad: l.cant, lote: l.lote, Lote: l.nlote, F_Caducidad: l.cad }));
    try {
      if (a.tipo === 'Merma') {
        const p = { ID_Sucursal: a.suc, Motivo: a.motivo, lineas: lineas };
        try { const r = await pedir('guardarMerma', p); toast('✔ Merma registrada: ' + r.folios.join(', ')); }
        catch (e) { if (!e.red) throw e; encolar('guardarMerma', p, 'Merma (' + a.motivo + ')'); toast('📴 Merma guardada en el dispositivo'); }
      } else {
        const r = await pedir('guardarAjuste', { ID_Sucursal: a.suc, Tipo_Ajuste: a.tipo, Motivo: a.motivo, lineas: lineas });
        toast('✔ Ajuste ' + r.folio + ' registrado');
      }
      S.aj = null; refrescarStock(); S.tabAj = 'hist'; V.ajustes('hist');
    } catch (e) {}
  }


  /* ---------- CONTEO FÍSICO (inventario físico vs sistema) ---------- */
  V.conteo = async () => {
    if (S.ctoId) return abrirConteo(S.ctoId);
    const ps = D().productos || [];
    const cats = [...new Set(ps.map(p => p.categoria).filter(Boolean))].sort(), labs = [...new Set(ps.map(p => p.lab).filter(Boolean))].sort();
    $('#vista').innerHTML = `<div class="tarjeta"><h3>Nuevo conteo físico</h3>
      <p class="muted">Se toma la existencia del sistema por lote al iniciar. Cuenten lo que hay en anaquel y capturen la cantidad; al cerrar, la app compara contra el sistema, genera el reporte PDF y, si lo autorizas, hace los ajustes. Para un conteo exacto, evita vender o traspasar productos del alcance mientras se cuenta.</p>
      <div class="rejilla"><label>Sucursal<select id="cnSuc">${optsSuc(sucTrabajo())}</select></label>
      <label>Categoría<select id="cnCat">${opts(cats.map(c => [c, c]), '', 'Todas')}</select></label><label>Laboratorio<select id="cnLab">${opts(labs.map(c => [c, c]), '', 'Todos')}</select></label>
      <label>Responsable<input id="cnResp" value="${esc(U().nombre)}"></label><label>Comentarios<input id="cnCom" placeholder="Ej. Conteo de cierre de mes"></label></div>
      <div class="acciones"><button class="btn primario" onclick="App.crearConteo()">📋 Iniciar conteo</button></div></div>
      <div class="tarjeta"><h3>Conteos</h3><div id="cnLista"><div class="vacio">Cargando…</div></div></div>`;
    try {
      const l = await pedir('listarConteos', {}, true); S.lista = l;
      const verC = puede('ver_costos');
      $('#cnLista').innerHTML = tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Sucursal', h: x => esc(sucNom(x.suc)) },
        { t: 'Alcance', k: 'alcance', cls: 'ocultar-movil' }, { t: 'Estatus', h: x => `<span class="etq ${x.estatus === 'Abierto' ? 'av' : x.estatus === 'Cancelado' ? 'mal' : 'ok'}">${esc(x.estatus)}</span>` },
        { t: 'Contados', num: 1, h: x => x.estatus === 'Abierto' ? '—' : nf(x.contados) + ' / ' + nf(x.renglones) },
        { t: 'Faltante', num: 1, h: x => x.faltPzs ? `<span class="error">${nf(x.faltPzs)} pzs${verC && x.faltVal !== null ? '<br>' + $$(x.faltVal) : ''}</span>` : '—' },
        { t: 'Sobrante', num: 1, h: x => x.sobPzs ? `${nf(x.sobPzs)} pzs${verC && x.sobVal !== null ? '<br>' + $$(x.sobVal) : ''}` : '—' }], l, { clic: 'App.abrirConteoI', vacio: 'Aún no hay conteos' });
    } catch (e) { $('#cnLista').innerHTML = '<div class="vacio">Requiere conexión.</div>'; }
  };
  async function crearConteo() {
    const p = { ID_Sucursal: $('#cnSuc').value, categoria: $('#cnCat').value, laboratorio: $('#cnLab').value, Responsable: $('#cnResp').value, Comentarios: $('#cnCom').value };
    if (!confirm('¿Iniciar el conteo de ' + sucNom(p.ID_Sucursal) + (p.categoria ? ' · ' + p.categoria : '') + (p.laboratorio ? ' · ' + p.laboratorio : '') + '?')) return;
    try { const r = await pedir('crearConteo', p); toast('✔ Conteo ' + r.folio + ' iniciado (' + r.renglones + ' renglones)'); abrirConteo(r.id); } catch (e) {}
  }
  const ctoDraftKey = id => 'cto_' + id;
  async function abrirConteo(id) {
    S.ctoId = id;
    let d;
    try { d = await pedir('detalleConteo', { id: id }); } catch (e) { if (e.red && S.cto && S.cto.id === id) d = S.cto; else { S.ctoId = null; return; } }
    // Lo capturado en este dispositivo que aún no se envía
    const draft = LS.get(ctoDraftKey(id), {});
    d.lineas.forEach(l => { if (draft[l.id]) { l.fisico = draft[l.id].fisico; l.nota = draft[l.id].nota; l.pend = true; } });
    S.cto = d;
    if (S.ctoCiegas === undefined) S.ctoCiegas = !puede('ajustes');
    S.ctoFiltro = S.ctoFiltro || 'todos';
    pintarConteo();
  }
  function pintarConteo() {
    const d = S.cto, abierto = d.estatus === 'Abierto', verC = puede('ver_costos');
    const contados = d.lineas.filter(l => l.fisico !== null && l.fisico !== '').length, pend = d.lineas.filter(l => l.pend).length;
    const r = d.resumen;
    $('#vista').innerHTML = `<div class="tarjeta"><div class="folio-fila"><div class="folio">${esc(d.folio)}</div>
      <span class="etq ${abierto ? 'av' : d.estatus === 'Cancelado' ? 'mal' : 'ok'}">${esc(d.estatus)}</span></div>
      <p><b>${esc(d.sucNombre)}</b> · ${esc(d.alcance)} · inició ${esc(d.fecha)} ${esc(d.hora)} · responsable ${esc(d.responsable || '')}${d.cierre ? ' · cerró ' + esc(d.cerradoPor || '') + ' el ' + esc(d.cierre) : ''}${d.ajustes ? ' · ajustes ' + esc(d.ajustes) : ''}</p>
      ${abierto && d.movsDesde ? `<p class="error">⚠️ Ha habido ${d.movsDesde} movimiento(s) de estos productos en la sucursal desde que inició el conteo. Al cerrar se compara contra la existencia de ese momento.</p>` : ''}
      ${abierto ? `<div class="progreso"><div id="ctBarra" style="width:${d.lineas.length ? contados / d.lineas.length * 100 : 0}%"></div></div><p class="muted" id="ctAvance">${avanceConteo()}</p>` :
        `<div class="kpis"><div class="kpi"><small>Contados</small><b>${nf(r.contados)} / ${nf(r.renglones)}</b><span>${nf(r.coinciden)} coinciden · exactitud ${r.contados ? (r.coinciden / r.contados * 100).toFixed(1) : 0}%</span></div>
         <div class="kpi"><small>Faltante</small><b class="error">${nf(r.faltPzs)} pzs</b><span>${verC && r.faltVal !== null ? $$(r.faltVal) + (U().costoLista ? ' a costo de lista' : ' a costo real') : ''}</span></div>
         <div class="kpi"><small>Sobrante</small><b>${nf(r.sobPzs)} pzs</b><span>${verC && r.sobVal !== null ? $$(r.sobVal) + (U().costoLista ? ' a costo de lista' : ' a costo real') : ''}</span></div>
         ${verC ? `<div class="kpi"><small>Diferencia neta</small><b>${$$(r.sobVal - r.faltVal)}</b><span></span></div>` : ''}</div>`}
      <div class="acciones">
        <button class="btn" onclick="App.salirConteo()">← Conteos</button><button class="btn" onclick="App.excelConteo()">📊 Exportar a Excel</button>
        ${abierto ? `<button class="btn" onclick="App.pdfConteo(true)">🖨️ Hoja para contar (PDF)</button><button class="btn" onclick="App.formEncontrado()">+ Producto encontrado</button>
          <button class="btn primario" onclick="App.guardarConteo()">💾 Guardar avance</button><button class="btn primario" onclick="App.formCerrarConteo()">✔ Cerrar conteo</button>
          <button class="btn peligro" onclick="App.cancelarConteo()">Cancelar conteo</button>${contados === 0 && !pend ? '<button class="btn peligro" onclick="App.eliminarConteo()">🗑️ Eliminar conteo</button>' : ''}` :
          `<button class="btn primario" onclick="App.pdfConteo(false,false)">📄 Reporte PDF (diferencias)</button><button class="btn" onclick="App.pdfConteo(false,true)">📄 Reporte completo</button>
           ${d.estatus === 'Cerrado' && puede('ajustes') && (r.faltPzs || r.sobPzs) ? '<button class="btn peligro" onclick="App.ajustarConteo()">⚖️ Aplicar ajustes al inventario</button>' : ''}
           ${d.estatus === 'Cancelado' && !d.lineas.some(l => l.fisico !== null && l.fisico !== '') ? '<button class="btn peligro" onclick="App.eliminarConteo()">🗑️ Eliminar conteo</button>' : ''}`}
      </div></div>
      <div class="tarjeta no-imprimir"><div class="fila"><label>Buscar<input id="ctTxt" placeholder="Producto, clave o lote" value="${esc(S.ctoTxt || '')}"></label>
        <label>Mostrar<select id="ctFil">${opts(abierto ? [['todos', 'Todos'], ['pend', 'Por contar'], ['cont', 'Contados']].concat(S.ctoCiegas ? [] : [['dif', 'Con diferencia']]) :
          [['dif', 'Con diferencia'], ['todos', 'Todos'], ['sin', 'Sin contar']], S.ctoFiltro)}</select></label>
        ${abierto ? `<label class="check fijo"><input type="checkbox" id="ctCiegas" ${S.ctoCiegas ? 'checked' : ''}> A ciegas (sin ver el sistema)</label>` : ''}</div></div>
      <div id="ctLineas"></div>`;
    if (!abierto && S.ctoFiltro === 'pend') S.ctoFiltro = 'dif';
    $('#ctTxt').oninput = e => { S.ctoTxt = e.target.value; pintarLineasConteo(); };
    $('#ctFil').onchange = e => { S.ctoFiltro = e.target.value; pintarLineasConteo(); };
    if ($('#ctCiegas')) $('#ctCiegas').onchange = e => { S.ctoCiegas = e.target.checked; pintarConteo(); };
    pintarLineasConteo();
  }
  function pintarLineasConteo() {
    const d = S.cto, abierto = d.estatus === 'Abierto', ciegas = abierto && S.ctoCiegas, txt = S.ctoTxt || '', f = S.ctoFiltro, verC = puede('ver_costos');
    const vacio = v => v === null || v === '' || v === undefined;
    const dif = l => abierto ? (vacio(l.fisico) ? null : l.fisico - l.ini) : l.dif;
    const ls = d.lineas.map((l, i) => Object.assign({ i: i }, l)).filter(l => (!txt || coincide(l.prod + ' ' + l.nombre + ' ' + l.lote, txt)) &&
      (f === 'todos' || (f === 'pend' && vacio(l.fisico)) || (f === 'cont' && !vacio(l.fisico)) || (f === 'sin' && vacio(l.fisico)) || (f === 'dif' && dif(l) !== null && Math.abs(dif(l)) > 1e-9)));
    if (!abierto) {
      $('#ctLineas').innerHTML = tabla([{ t: 'Producto', h: l => `<b>${esc(l.nombre)}</b><br><small class="muted">${esc(l.prod)}${l.agregado ? ' · agregado' : ''}</small>` }, { t: 'Lote', k: 'lote' }, { t: 'Cad.', k: 'cad' },
        { t: 'Sistema', num: 1, h: l => nf(l.cierre !== null ? l.cierre : l.ini) }, { t: 'Contado', num: 1, h: l => vacio(l.fisico) ? '<span class="muted">sin contar</span>' : nf(l.fisico) },
        { t: 'Diferencia', num: 1, h: l => l.dif === null ? '' : `<b class="${l.dif < 0 ? 'error' : ''}">${l.dif > 0 ? '+' : ''}${nf(l.dif)}</b>` }]
        .concat(verC ? [{ t: 'Valor', num: 1, h: l => l.valor === null ? '' : $$(l.valor) }] : []).concat([{ t: 'Nota', k: 'nota', cls: 'ocultar-movil' }]), ls, { vacio: f === 'dif' ? 'Sin diferencias ✔' : 'Sin renglones' });
      return;
    }
    let cat = null;
    $('#ctLineas').innerHTML = !ls.length ? '<div class="vacio">Sin renglones</div>' : '<div class="tarjeta conteo">' + ls.map(l => {
      const enc = l.cat !== cat ? `<div class="conteo-cat">${esc(l.cat || 'Sin categoría')}</div>` : ''; cat = l.cat;
      const df = dif(l);
      return enc + `<div class="conteo-fila ${vacio(l.fisico) ? '' : 'hecho'}" data-i="${l.i}">
        <div class="nom"><b>${esc(l.nombre)}</b><small>${esc(l.prod)} · Lote <b>${esc(l.lote)}</b> · Cad. ${esc(l.cad)}${l.agregado ? ' · agregado' : ''}${l.pend ? ' · <span class="error">sin enviar</span>' : ''}</small></div>
        ${ciegas ? '' : `<div class="sis"><small>Sistema</small><b>${nf(l.ini)}</b></div>`}
        <div class="cnt"><input type="number" inputmode="decimal" min="0" step="any" data-f="fisico" placeholder="Contado" value="${vacio(l.fisico) ? '' : l.fisico}"></div>
        ${ciegas ? '' : `<div class="dif ${df === null ? '' : df < 0 ? 'error' : df > 0 ? 'mas' : 'ok'}">${df === null ? '' : (df > 0 ? '+' : '') + nf(df)}</div>`}
        <div class="nota"><input data-f="nota" placeholder="Nota" value="${esc(l.nota || '')}"></div></div>`;
    }).join('') + '</div>';
    const cont = $('#ctLineas');
    cont.oninput = e => {
      const row = e.target.closest('[data-i]'), fld = e.target.dataset.f; if (!row || !fld) return;
      const l = S.cto.lineas[+row.dataset.i];
      if (fld === 'fisico') l.fisico = e.target.value === '' ? null : Number(e.target.value); else l.nota = e.target.value;
      l.pend = true;
      const draft = LS.get(ctoDraftKey(S.cto.id), {}); draft[l.id] = { fisico: l.fisico, nota: l.nota }; LS.set(ctoDraftKey(S.cto.id), draft);
      row.classList.toggle('hecho', l.fisico !== null);
      if ($('#ctAvance')) $('#ctAvance').innerHTML = avanceConteo();
      const dEl = row.querySelector('.dif'); if (dEl) { const x = l.fisico === null ? null : l.fisico - l.ini; dEl.textContent = x === null ? '' : (x > 0 ? '+' : '') + nf(x); dEl.className = 'dif ' + (x === null ? '' : x < 0 ? 'error' : x > 0 ? 'mas' : 'ok'); }
    };
    cont.onkeydown = e => { if (e.key === 'Enter' && e.target.dataset.f === 'fisico') { const ins = [...cont.querySelectorAll('[data-f=fisico]')]; const n = ins[ins.indexOf(e.target) + 1]; if (n) n.focus(); } };
  }
  function avanceConteo() {
    const ls = S.cto.lineas, c = ls.filter(l => l.fisico !== null && l.fisico !== '').length, p = ls.filter(l => l.pend).length;
    if ($('#ctBarra')) $('#ctBarra').style.width = (ls.length ? c / ls.length * 100 : 0) + '%';
    return nf(c) + ' de ' + nf(ls.length) + ' renglones contados' + (p ? ' · <b>' + p + ' sin enviar</b> (guardados en este dispositivo)' : '');
  }
  const pendientesConteo = () => S.cto.lineas.filter(l => l.pend).map(l => ({ id: l.id, fisico: l.fisico, nota: l.nota || '' }));
  async function guardarConteo(silencio) {
    const lineas = pendientesConteo();
    if (!lineas.length) { if (!silencio) toast('No hay cambios por enviar'); return true; }
    try {
      await pedir('guardarConteo', { id: S.cto.id, lineas: lineas });
      LS.del(ctoDraftKey(S.cto.id)); S.cto.lineas.forEach(l => l.pend = false);
      if (!silencio) toast('✔ Avance guardado (' + lineas.length + ' renglones)');
      pintarConteo(); return true;
    } catch (e) { if (e.red) toast('📴 Sin conexión: lo capturado quedó guardado en este dispositivo', true); return false; }
  }
  function formEncontrado() {
    modal('Producto encontrado', `<p class="muted">Para productos o lotes que encontraste en anaquel y que no aparecen en la lista.</p>
      <div class="buscador buscador-prod"><input id="ceProd" enterkeyhint="search" placeholder="🔍 Producto…" autocomplete="off"></div><div id="ceSel" class="espacio"></div>
      <div class="rejilla"><label>Lote<input id="ceLote"></label><label>Caducidad<input type="date" id="ceCad"></label><label>Cantidad contada<input type="number" id="ceCant" min="0" step="any"></label></div>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.agregarEncontrado()">Agregar</button></div>`);
    buscador($('#ceProd'), { fuente: fuenteProductos(S.cto.suc, null, false), alElegir: x => { S.ceProd = x.id; $('#ceSel').innerHTML = `<b>${esc((prod(x.id) || {}).nombre || x.id)}</b>`; $('#ceProd').value = ''; } });
  }
  async function agregarEncontrado() {
    if (!S.ceProd) return toast('Elige el producto', true);
    const x = { ID_Producto: S.ceProd, Lote: $('#ceLote').value.trim(), F_Caducidad: $('#ceCad').value, fisico: Number($('#ceCant').value) || 0 };
    if (!(await guardarConteo(true))) return;
    try { await pedir('guardarConteo', { id: S.cto.id, nuevas: [x] }); S.ceProd = null; cerrarModal(); toast('✔ Agregado'); abrirConteo(S.cto.id); } catch (e) {}
  }
  function formCerrarConteo() {
    const sin = S.cto.lineas.filter(l => l.fisico === null || l.fisico === '').length;
    modal('Cerrar conteo ' + S.cto.folio, `<p>Al cerrar se compara lo contado contra la existencia actual del sistema y ya no se puede capturar.</p>
      ${sin ? `<p><b>${nf(sin)}</b> renglones no tienen cantidad capturada. ¿Qué hacemos con ellos?</p>
        <label class="check"><input type="radio" name="ccSin" value="no" checked> No tomarlos en cuenta (no se contaron)</label>
        <label class="check"><input type="radio" name="ccSin" value="cero"> Tomarlos como 0 piezas (no hay en anaquel → faltante)</label>` : '<p>Todos los renglones están contados ✔</p>'}
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Volver</button><button class="btn primario" onclick="App.cerrarConteo()">✔ Cerrar conteo</button></div>`);
  }
  async function cerrarConteo() {
    const r = document.querySelector('input[name=ccSin]:checked');
    const sinCero = r ? r.value === 'cero' : false;
    try {
      const d = await pedir('cerrarConteo', { id: S.cto.id, lineas: pendientesConteo(), sinCapturaCero: sinCero });
      LS.del(ctoDraftKey(S.cto.id)); cerrarModal(); S.cto = d; S.ctoFiltro = 'dif'; toast('✔ Conteo cerrado'); pintarConteo();
    } catch (e) {}
  }
  async function cancelarConteo() {
    const m = prompt('Motivo de la cancelación del conteo:'); if (m === null) return;
    try { await pedir('cancelarConteo', { id: S.cto.id, motivo: m }); LS.del(ctoDraftKey(S.cto.id)); toast('Conteo cancelado'); salirConteo(); } catch (e) {}
  }
  async function eliminarConteo() {
    const d = S.cto;
    if (!confirm('¿Eliminar definitivamente el conteo ' + d.folio + '?\nNo tiene ninguna pieza capturada; se borrará de la lista de conteos.')) return;
    try { await pedir('eliminarConteo', { id: d.id }); LS.del(ctoDraftKey(d.id)); toast('🗑️ Conteo ' + d.folio + ' eliminado'); salirConteo(); } catch (e) {}
  }
  async function ajustarConteo() {
    const r = S.cto.resumen;
    if (!confirm('Se registrará una SALIDA por ajuste de ' + nf(r.faltPzs) + ' piezas y una ENTRADA por ajuste de ' + nf(r.sobPzs) + ' piezas para que el sistema quede igual a lo contado. ¿Continuar?')) return;
    try {
      let x;
      try { x = await pedir('ajustarConteo', { id: S.cto.id }); }
      catch (e) { if (e.red || !/movimientos después del cierre/.test(e.message) || !confirm(e.message + '\n\n¿Ajustar de todos modos?')) throw e; x = await pedir('ajustarConteo', { id: S.cto.id, forzar: true }); }
      toast('✔ Ajustes registrados: ' + x.folios.join(', ')); refrescarStock(); abrirConteo(S.cto.id);
    } catch (e) {}
  }
  function pdfConteo(hoja, todo) {
    const d = S.cto;
    generarPdf('pdfConteo', { id: d.id, hoja: !!hoja, todo: !!todo }, { asunto: (hoja ? 'Hoja de conteo ' : 'Inventario físico ') + d.folio,
      texto: 'Interés Veterinario — ' + (hoja ? 'Hoja de conteo ' : 'Reporte de inventario físico ') + d.folio + ' · ' + d.sucNombre, volver: 'App.cerrarModal()' });
  }
  function salirConteo() { S.ctoId = null; S.cto = null; V.conteo(); }

  /* ---------- INVENTARIO ---------- */
  V.inventario = (tab) => {
    tab = tab || S.tabInv || 'exist'; S.tabInv = tab;
    const t = (id, n) => `<button class="${tab === id ? 'activo' : ''}" onclick="App.vistaInventario('${id}')">${n}</button>`;
    $('#vista').innerHTML = `<div class="pestanas">${t('exist', 'Existencias')}${t('cad', 'Caducidades')}${t('mov', 'Movimientos')}${t('kardex', 'Kardex')}</div><div id="iCont"></div>`;
    ({ exist: invExist, cad: invCad, mov: invMov, kardex: invKardex })[tab]();
  };
  function invExist() {
    const cats = [...new Set((D().productos || []).map(p => p.categoria).filter(Boolean))].sort();
    $('#iCont').innerHTML = `<div class="tarjeta"><div class="fila"><label>Sucursal<select id="ieSuc">${U().todasSucursales ? optsSuc(sucFiltro(), false, 'Todas') : optsSuc(sucTrabajo())}</select></label>
      <label>Buscar<input id="ieTxt" placeholder="Producto, clave, laboratorio"></label><label>Categoría<select id="ieCat">${opts(cats.map(c => [c, c]), '', 'Todas')}</select></label>
      <label class="check fijo"><input type="checkbox" id="ieMin"> Bajo mínimo</label><button class="btn fijo" onclick="App.actualizarStock()">⟳ Actualizar</button><button class="btn fijo" onclick="App.excelInventario()">📊 Exportar a Excel</button></div></div><div class="espacio"></div><div id="ieRes"></div>`;
    ['#ieSuc', '#ieTxt', '#ieCat', '#ieMin'].forEach(s => enlazarFiltro(s, pintarExist));
    pintarExist();
  }
  function pintarExist() {
    const suc = $('#ieSuc').value, txt = $('#ieTxt').value, cat = $('#ieCat').value, min = $('#ieMin').checked, verC = puede('ver_costos');
    const g = {};
    (D().stock || []).forEach(s => {
      if (suc && s.s !== suc) return;
      const k = s.p + '|' + (suc ? s.s : '');
      if (!g[k]) g[k] = { p: s.p, s: suc ? s.s : '', q: 0, lotes: 0, cad: null };
      g[k].q += s.q; if (s.q > 0) { g[k].lotes++; const f = fechaDe(s.c); if (f && (!g[k].cad || f < g[k].cad)) g[k].cad = f; }
    });
    let filas = Object.values(g).map(x => { const p = prod(x.p) || { nombre: x.p }; return Object.assign(x, { prod: p }); })
      .filter(x => (!txt || coincide(x.p + ' ' + x.prod.nombre + ' ' + x.prod.lab, txt)) && (!cat || x.prod.categoria === cat) && (!min || x.q < (x.prod.min || 0)) && Math.abs(x.q) > 0.0001)
      .sort((a, b) => { const qa = a.q > 0.0001 ? a.q : 0, qb = b.q > 0.0001 ? b.q : 0; return (qa > 0 && qb > 0) ? (qb - qa || String(a.prod.nombre).localeCompare(b.prod.nombre)) : (qa > 0 || qb > 0) ? (qa > 0 ? -1 : 1) : String(a.prod.nombre).localeCompare(b.prod.nombre); });
    S.lista = filas;
    const valor = verC ? filas.reduce((t, x) => t + x.q * (x.prod.costo || 0), 0) : 0;
    $('#ieRes').innerHTML = `<p class="muted">${filas.length} productos · ${nf(filas.reduce((t, x) => t + x.q, 0))} unidades${verC ? ' · Valor a costo ' + $$(valor) : ''}</p>` +
      tabla([{ t: 'Clave', k: 'p' }, { t: 'Producto', h: x => esc(x.prod.nombre) }, { t: 'Sucursal', cls: 'ocultar-movil', h: x => esc(x.s ? sucNom(x.s) : 'Todas') },
        { t: 'Lotes', num: 1, k: 'lotes' }, { t: 'Próx. caducidad', h: x => x.cad ? x.cad.toLocaleDateString('es-MX') : '—' },
        { t: 'Existencia', num: 1, h: x => `<b class="${x.q < 0 ? 'error' : ''}">${nf(x.q)}</b> ${x.prod.min && x.q < x.prod.min ? '<span class="etq av">Bajo mín.</span>' : ''}` }]
        .concat(verC ? [{ t: 'Valor', num: 1, h: x => $$(x.q * (x.prod.costo || 0)) }] : []), filas.slice(0, 1500), { clic: 'App.abrirExistencia' });
  }
  function verLotes(i) {
    const x = S.lista[i];
    const ls = (D().stock || []).filter(s => s.p === x.p && (!x.s || s.s === x.s) && Math.abs(s.q) > 0).sort((a, b) => (fechaDe(a.c) || 9e15) - (fechaDe(b.c) || 9e15));
    modal(x.prod.nombre, tabla([{ t: 'Sucursal', h: s => esc(sucNom(s.s)) }, { t: 'Lote', k: 'l' }, { t: 'Caducidad', k: 'c' },
      { t: 'Días', num: 1, h: s => { const d = diasA(s.c); return d === null ? '—' : `<span class="etq ${d < 0 ? 'mal' : d <= 120 ? 'av' : 'ok'}">${d}</span>`; } }, { t: 'Existencia', num: 1, h: s => nf(s.q) }], ls) +
      `<div class="acciones"><button class="btn" onclick="App.kardexDe('${esc(x.p)}')">Ver kardex</button></div>`);
  }
  function invCad() {
    const dias = (D().config || {}).diasCaducidad || 120;
    $('#iCont').innerHTML = `<div class="tarjeta"><div class="fila"><label>Sucursal<select id="icSuc">${U().todasSucursales ? optsSuc('', false, 'Todas') : optsSuc(sucTrabajo())}</select></label>
      <label>Días hacia adelante<input type="number" id="icDias" value="${dias}"></label></div></div><div class="espacio"></div><div id="icRes"></div>`;
    const pintar = () => {
      const suc = $('#icSuc').value, n = Number($('#icDias').value) || 0;
      const l = (D().stock || []).filter(s => s.q > 0 && (!suc || s.s === suc) && diasA(s.c) !== null && diasA(s.c) <= n).sort((a, b) => diasA(a.c) - diasA(b.c));
      $('#icRes').innerHTML = tabla([{ t: 'Producto', h: s => esc((prod(s.p) || {}).nombre || s.p) }, { t: 'Sucursal', h: s => esc(sucNom(s.s)) }, { t: 'Lote', k: 'l' }, { t: 'Caducidad', k: 'c' },
        { t: 'Días', num: 1, h: s => `<span class="etq ${diasA(s.c) < 0 ? 'mal' : 'av'}">${diasA(s.c) < 0 ? 'Caducado ' + (-diasA(s.c)) : diasA(s.c)}</span>` }, { t: 'Existencia', num: 1, h: s => nf(s.q) }], l, { vacio: 'Sin lotes por caducar' });
    };
    $('#icSuc').onchange = pintar; $('#icDias').oninput = pintar; pintar();
  }
  function invMov() {
    const ini = hoyISO().slice(0, 8) + '01';
    $('#iCont').innerHTML = `<div class="tarjeta"><div class="fila"><label>Desde<input type="date" id="imDesde" value="${ini}"></label><label>Hasta<input type="date" id="imHasta" value="${hoyISO()}"></label>
      <label>Sucursal<select id="imSuc">${U().todasSucursales ? optsSuc(sucFiltro(), false, 'Todas') : optsSuc(sucTrabajo())}</select></label>
      <label>Tipo<select id="imTipo">${opts(['Nota de Venta', 'Orden de Compra', 'Traspaso', 'Merma', 'Entrada por ajuste', 'Salida por ajuste', 'Entrada por Devolución', 'Conversión'].map(x => [x, x]), '', 'Todos')}</select></label>
      <button class="btn primario fijo" id="imBtn">Buscar</button></div></div><div class="espacio"></div><div id="imRes"></div>`;
    $('#imBtn').onclick = async () => {
      try { const l = await pedir('listarMovimientos', { desde: $('#imDesde').value, hasta: $('#imHasta').value, sucursal: $('#imSuc').value, tipo: $('#imTipo').value });
        $('#imRes').innerHTML = tabla([{ t: 'Fecha', h: m => esc(m.fecha + ' ' + m.hora) }, { t: 'Referencia', k: 'ref' }, { t: 'Tipo', k: 'tipo' }, { t: 'Producto', k: 'nombre' },
          { t: 'Sucursal', h: m => esc(sucNom(m.suc)) }, { t: 'Lote', k: 'lote' }, { t: 'Cant.', num: 1, h: m => `<b style="color:${m.cant < 0 ? 'var(--peligro)' : 'var(--ok)'}">${m.cant > 0 ? '+' : ''}${nf(m.cant)}</b>` }, { t: 'Usuario', k: 'usuario' }], l);
      } catch (e) { $('#imRes').innerHTML = '<div class="vacio">Requiere conexión.</div>'; }
    };
    $('#imBtn').onclick();
  }
  function invKardex(idProd) {
    $('#iCont').innerHTML = `<div class="tarjeta"><div class="fila"><label style="flex:3 1 260px">Producto<div class="buscador"><input id="ikProd" placeholder="Buscar producto" autocomplete="off" value="${idProd ? esc((prod(idProd) || {}).nombre) : ''}"></div></label>
      <label>Sucursal<select id="ikSuc">${U().todasSucursales ? optsSuc(sucFiltro(), false, 'Todas') : optsSuc(sucTrabajo())}</select></label></div></div><div class="espacio"></div><div id="ikRes"></div>`;
    let sel = idProd;
    const cargar = async () => { if (!sel) return; try { const l = await pedir('kardex', { producto: sel, sucursal: $('#ikSuc').value });
      $('#ikRes').innerHTML = tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Referencia', k: 'ref' }, { t: 'Movimiento', k: 'tipo' }, { t: 'Sucursal', h: m => esc(sucNom(m.suc)) }, { t: 'Lote', k: 'lote' }, { t: 'Cad.', k: 'cad' },
        { t: 'Cant.', num: 1, h: m => `<span style="color:${m.cant < 0 ? 'var(--peligro)' : 'var(--ok)'}">${m.cant > 0 ? '+' : ''}${nf(m.cant)}</span>` }, { t: 'Saldo', num: 1, h: m => `<b>${nf(m.saldo)}</b>` }, { t: 'Usuario', k: 'usuario' }], l); } catch (e) {} };
    buscador($('#ikProd'), { fuente: fuenteProductos(null, null, false), alElegir: x => { sel = x.id; cargar(); } });
    $('#ikSuc').onchange = cargar; cargar();
  }


  /* ---------- SERIE Y FOLIO EN PANTALLA ---------- */
  async function mostrarFolio(idEl, suc, tipo) {
    const el = document.getElementById(idEl); if (!el) return;
    const local = ((D().folios || {})[suc] || {})[tipo];
    const pintar = (txt, nota) => { if (el.isConnected) el.innerHTML = `<span class="folio-et">${esc(tipo)} · serie y folio</span><b>${esc(txt || '—')}</b><small>${esc(nota || '')}</small>`; };
    pintar(local, S.online ? 'consultando…' : 'sin conexión: se confirma al sincronizar');
    try {
      const f = await call('folioSiguiente', { sucursal: suc, tipo: tipo });
      pintar(f.texto, 'siguiente disponible en ' + sucNom(suc));
      S.datos.folios = S.datos.folios || {}; S.datos.folios[suc] = S.datos.folios[suc] || {}; S.datos.folios[suc][tipo] = f.texto; LS.set('datos', S.datos);
    } catch (e) { pintar(local, e.red ? 'sin conexión: se confirma al sincronizar' : e.message); }
  }

  /* ---------- LISTA DE PRECIOS (por perfil, por cliente, comparativo) ---------- */
  V.precios = () => {
    const ps = D().productos || [], cat = D().catalogos || {};
    const cats = [...new Set(ps.map(p => p.categoria).filter(Boolean))].sort(), labs = [...new Set(ps.map(p => p.lab).filter(Boolean))].sort();
    const f = S.fPrecios || (S.fPrecios = { modo: 'lista', lista: 'Publico', cli: null, cat: '', lab: '', labs: [], txt: '', grupo: 'categoria', exist: false, iva: false, marc: {}, solo: false, selNom: '', titulo: '', subtitulo: '', sucDatos: '' });
    f.labs = f.labs || []; f.marc = f.marc || {}; f.sucDatos = f.sucDatos || sucTrabajo();
    const nMarc = Object.keys(f.marc).filter(k => f.marc[k]).length, sels = S.selsLP || [];
    f.sel = (f.sel || LS.get('listasSel', null) || cat.listas.slice()).filter(x => cat.listas.indexOf(x) >= 0);
    const c = f.cli ? cliente(f.cli) : null;
    const b = (m, t) => `<button class="${f.modo === m ? 'activo' : ''}" data-modo="${m}">${t}</button>`;
    $('#vista').innerHTML = `<div class="tarjeta no-imprimir">
      <div class="pestanas" style="margin-bottom:12px">${b('lista', 'Por perfil de cliente')}${b('cliente', 'Por cliente')}${b('todas', 'Comparar todas las listas')}</div>
      <div class="fila">
        ${f.modo === 'lista' ? `<label>Perfil / lista de precios<select id="lpLista">${opts(cat.listas.map(x => [x, x]), f.lista)}</select></label>` : ''}
        ${f.modo === 'cliente' ? `<label style="flex:2 1 260px">Cliente<div class="buscador"><input id="lpCli" placeholder="Buscar por nombre, razón social, RFC…" autocomplete="off" value="${c ? esc(c.razon || c.nombre) : ''}"></div></label>` : ''}
        <label>Categoría<select id="lpCat">${opts(cats.map(x => [x, x]), f.cat, 'Todas')}</select></label>
        <label>Laboratorio<select id="lpLab">${opts([['', 'Todos']].concat(labs.map(x => [x, x])).concat([['__varios', 'Varios laboratorios…']]), f.lab)}</select></label>
        <label>Producto<input id="lpTxt" value="${esc(f.txt)}" placeholder="Clave o nombre"></label>
        <label>Agrupar por<select id="lpGrupo">${opts([['categoria', 'Categoría'], ['lab', 'Laboratorio'], ['', 'Sin agrupar']], f.grupo)}</select></label>
      </div>
      ${f.modo === 'todas' ? `<div style="margin-top:12px"><span class="muted" style="font-size:12.5px;font-weight:500">Listas a mostrar e imprimir</span>
        <div class="fila" style="margin-top:6px;gap:6px 14px">${cat.listas.map(x => `<label class="check fijo"><input type="checkbox" data-lista="${esc(x)}" ${f.sel.indexOf(x) >= 0 ? 'checked' : ''}> ${esc(x)}</label>`).join('')}
        <button class="btn chico fijo" data-todas="1">Todas</button><button class="btn chico fijo" data-todas="0">Ninguna</button></div></div>` : ''}
      ${f.lab === '__varios' ? `<div style="margin-top:12px"><span class="muted" style="font-size:12.5px;font-weight:500">Laboratorios a incluir</span>
        <div class="fila" style="margin-top:6px;gap:6px 14px">${labs.map(x => `<label class="check fijo"><input type="checkbox" data-lab="${esc(x)}" ${f.labs.indexOf(x) >= 0 ? 'checked' : ''}> ${esc(x)}</label>`).join('')}</div></div>` : ''}
      <div class="lp-sel">
        <span><b id="lpNMarc">${nMarc}</b> productos marcados</span>
        <button class="btn chico fijo" data-marcar="1">Marcar los visibles</button><button class="btn chico fijo" data-marcar="0">Desmarcar todo</button>
        <label class="check fijo"><input type="checkbox" id="lpSolo" ${f.solo ? 'checked' : ''}> Mostrar e imprimir solo los marcados</label>
        <span class="lp-sel-guardadas"><select id="lpSelNom">${opts(sels.map(x => [x.nombre, x.nombre + ' (' + x.ids.length + ')']), f.selNom, 'Selecciones guardadas…')}</select>
        <button class="btn chico fijo" id="lpGuardarSel" title="Guardar los marcados con un nombre">💾 Guardar</button>${f.selNom ? '<button class="btn chico fijo" id="lpBorrarSel" title="Borrar la selección guardada">🗑️</button>' : ''}</span>
      </div>
      <div class="fila lp-titulos">
        <label style="flex:2 1 260px">Título de la impresión<input id="lpTitulo" value="${esc(f.titulo)}" placeholder="${esc(lpTituloAuto())}" maxlength="90"></label>
        <label style="flex:2 1 220px">Subtítulo (opcional)<input id="lpSubtitulo" value="${esc(f.subtitulo)}" placeholder="Ej. Vigencia octubre 2026 · Precios por pieza" maxlength="120"></label>
        <label>Datos de contacto de<select id="lpSucDatos">${opts((D().sucursales || []).map(x => [x.id, x.nombre]), f.sucDatos)}</select></label>
      </div>
      <div class="fila" style="margin-top:10px">
        <label class="check fijo"><input type="checkbox" id="lpIva" ${f.iva ? 'checked' : ''}> Mostrar precio con IVA</label>
        <label class="check fijo"><input type="checkbox" id="lpExist" ${f.exist ? 'checked' : ''}> Solo con existencia en ${sucFiltro() ? esc(sucNom(sucFiltro())) : 'alguna sucursal'}</label>
        <button class="btn fijo" onclick="App.imprimir()">🖨️ Imprimir / PDF</button>
      </div></div><div class="espacio"></div><div id="lpRes" class="imprimible"></div>`;
    document.querySelectorAll('[data-modo]').forEach(x => x.onclick = () => { f.modo = x.dataset.modo; V.precios(); });
    const bind = (id, k, chk) => { const el = $(id); if (!el) return; el.oninput = el.onchange = () => { f[k] = chk ? el.checked : el.value; pintarPrecios(); }; };
    bind('#lpLista', 'lista'); bind('#lpCat', 'cat'); bind('#lpTxt', 'txt'); bind('#lpGrupo', 'grupo'); bind('#lpIva', 'iva', 1); bind('#lpExist', 'exist', 1); bind('#lpSolo', 'solo', 1);
    $('#lpLab').onchange = () => { f.lab = $('#lpLab').value; V.precios(); };
    $('#lpTitulo').oninput = () => { f.titulo = $('#lpTitulo').value; document.querySelectorAll('#lpRes .lp-tit').forEach(t => t.textContent = f.titulo.trim() || lpTituloAuto()); };
    $('#lpSubtitulo').oninput = () => { f.subtitulo = $('#lpSubtitulo').value; document.querySelectorAll('#lpRes .lp-subtit').forEach(t => { t.textContent = f.subtitulo.trim(); t.style.display = f.subtitulo.trim() ? '' : 'none'; }); };
    $('#lpSucDatos').onchange = () => { f.sucDatos = $('#lpSucDatos').value; pintarPrecios(); };
    document.querySelectorAll('[data-lab]').forEach(x => x.onchange = () => { const n = x.dataset.lab; f.labs = f.labs.filter(l => l !== n).concat(x.checked ? [n] : []); pintarPrecios(); });
    document.querySelectorAll('[data-marcar]').forEach(x => x.onclick = () => { if (x.dataset.marcar === '1') lpFiltrados().forEach(p => f.marc[p.id] = 1); else { f.marc = {}; f.solo = false; $('#lpSolo').checked = false; } pintarPrecios(); });
    $('#lpSelNom').onchange = () => lpCargarSel($('#lpSelNom').value);
    $('#lpGuardarSel').onclick = lpGuardarSel;
    if ($('#lpBorrarSel')) $('#lpBorrarSel').onclick = lpBorrarSel;
    if (!S.selsLP) pedir('selListaPrecios', {}, true).then(l => { S.selsLP = l || []; if ($('#lpSelNom') && S.selsLP.length) V.precios(); }).catch(() => { S.selsLP = []; });
    const guardarSel = () => { LS.set('listasSel', f.sel); pintarPrecios(); };
    document.querySelectorAll('[data-lista]').forEach(x => x.onchange = () => { const n = x.dataset.lista; f.sel = cat.listas.filter(l => l === n ? x.checked : f.sel.indexOf(l) >= 0); guardarSel(); });
    document.querySelectorAll('[data-todas]').forEach(x => x.onclick = () => { f.sel = x.dataset.todas === '1' ? cat.listas.slice() : []; document.querySelectorAll('[data-lista]').forEach(c => c.checked = x.dataset.todas === '1'); guardarSel(); });
    if ($('#lpCli')) buscador($('#lpCli'), { fuente: fuenteClientes, alElegir: x => { f.cli = x.id; pintarPrecios(); } });
    pintarPrecios();
  };
  function pintarPrecios() {
    const f = S.fPrecios, listas = D().catalogos.listas, suc = sucFiltro();
    const c = f.modo === 'cliente' && f.cli ? cliente(f.cli) : null;
    if (f.modo === 'cliente' && !c) { $('#lpRes').innerHTML = '<div class="vacio">Busca un cliente para ver sus precios</div>'; return; }
    const lista = f.modo === 'cliente' ? (listas.indexOf(c.lista) >= 0 ? c.lista : 'Publico') : f.lista;
    const cols = f.modo === 'todas' ? listas.filter(x => (f.sel || listas).indexOf(x) >= 0) : [lista];
    if (!cols.length) { $('#lpRes').innerHTML = '<div class="vacio">Marca al menos una lista para ver e imprimir</div>'; return; }
    const precio = (p, x) => f.iva ? p.precios[x] * (1 + (p.iva || 0)) : p.precios[x];
    const gk = p => f.grupo === 'lab' ? (p.lab || 'Sin laboratorio') : f.grupo === 'categoria' ? (p.categoria || 'Sin categoría') : '';
    const l = lpFiltrados().filter(p => !f.solo || f.marc[p.id])
      .sort((ex => (a, b) => gk(a).localeCompare(gk(b)) || ex(a, b))(porExistencia(mapaExist(suc), p => p.id, p => p.nombre)));
    const titulo = (f.titulo || '').trim() || lpTituloAuto();
    const sub = [f.modo === 'cliente' ? 'Perfil ' + lista + ' · crédito ' + c.credito + ' días' : (f.modo === 'todas' ? '' : 'Lista ' + lista), f.cat, f.lab === '__varios' ? f.labs.join(', ') : f.lab, f.iva ? 'Precios con IVA incluido' : 'Precios más IVA donde aplique', l.length + ' productos'].filter(Boolean).join(' · ');
    const otra = f.grupo === 'lab' ? 'Categoría' : 'Laboratorio';
    const sd = (D().sucursales || []).find(x => x.id === f.sucDatos) || (D().sucursales || []).find(x => x.id === suc) || {};
    const contacto = [sd.direccion, sd.tel ? 'Tel. ' + sd.tel : '', sd.email].filter(Boolean);
    const enc = `<div class="lp-enc">
        <div class="lp-enc-emp">${window.LOGO ? `<img src="${window.LOGO}" alt="Interés Veterinario" class="lp-logo">` : '<b class="lp-emp-nom">Interés Veterinario</b>'}
          <div class="lp-emp-datos"><b>Interés Veterinario</b>${sd.nombre ? '<span>Sucursal ' + esc(sd.nombre) + '</span>' : ''}${contacto.map(x => '<span>' + esc(x) + '</span>').join('')}</div></div>
        <div class="lp-enc-tit"><div class="lp-tit">${esc(titulo)}</div><div class="lp-subtit" ${(f.subtitulo || '').trim() ? '' : 'style="display:none"'}>${esc((f.subtitulo || '').trim())}</div>
          <div class="lp-meta">${esc(sub)}</div><div class="lp-meta">Fecha de impresión: <span class="lp-fecha">${esc(fechaLarga())}</span></div></div>
      </div>`;
    const pie = `<div class="lp-pie">Precios en moneda nacional (MXN), sujetos a cambio sin previo aviso y a disponibilidad de inventario. · Interés Veterinario${sd.tel ? ' · Tel. ' + esc(sd.tel) : ''}</div>`;
    const nc = 7 + cols.length;
    let html = `<div class="tabla-cont"><table class="lp-tabla"><thead><tr class="lp-solo-imp"><th colspan="${nc}" class="lp-celda-enc">${enc}</th></tr><tr class="lp-cols"><th class="no-imprimir"></th><th>Clave</th><th>Producto</th><th class="ocultar-movil">Unidad</th><th class="ocultar-movil">${otra}</th><th class="ocultar-movil">IVA</th>${cols.map(x => `<th class="num">${esc(x)}</th>`).join('')}<th class="num no-imprimir">Exist.</th></tr></thead><tbody>`;
    let g = null; S.lpGrupos = [];
    const todos = f.solo ? l : lpFiltrados();
    l.forEach(p => {
      if (f.grupo && gk(p) !== g) {
        g = gk(p); const ids = todos.filter(x => gk(x) === g).map(x => x.id), k = S.lpGrupos.push(ids) - 1, n = ids.filter(id => f.marc[id]).length;
        html += `<tr class="grupo"><td colspan="${7 + cols.length}"><label class="lp-grupo no-imprimir" onclick="event.stopPropagation()"><input type="checkbox" ${n === ids.length ? 'checked' : ''} ${n && n < ids.length ? 'data-mixto="1"' : ''} onchange="App.lpMarcarGrupo(${k}, this.checked)"></label>${esc(g)} <small>(${l.filter(x => gk(x) === g).length}${n ? '<span class="no-imprimir"> · ' + n + ' marcados</span>' : ''})</small></td></tr>`;
      }
      html += `<tr class="clic" onclick="App.verPreciosProducto('${esc(p.id)}')"><td class="no-imprimir"><span class="lp-marca"><input type="checkbox" ${f.marc[p.id] ? 'checked' : ''} onclick="event.stopPropagation();App.lpMarcar('${esc(p.id)}', this.checked)">${imgMini(p)}</span></td><td>${esc(p.id)}</td><td><b>${esc(p.nombre)}</b></td><td class="ocultar-movil">${esc(p.unidad)}</td>
        <td class="ocultar-movil">${esc(f.grupo === 'lab' ? p.categoria : p.lab)}</td><td class="ocultar-movil">${p.iva ? 'Con IVA' : 'Exento'}</td>
        ${cols.map(x => `<td class="num">${p.precios[x] ? (cols.length === 1 ? '<b>' + $$(precio(p, x)) + '</b>' : $$(precio(p, x))) : '—'}</td>`).join('')}
        <td class="num no-imprimir">${nf(existencia(p.id, suc))}</td></tr>`;
    });
    html += `</tbody><tfoot><tr class="lp-solo-imp"><td colspan="${nc}" class="lp-celda-pie">${pie}</td></tr></tfoot></table></div>`;
    if ($('#lpNMarc')) $('#lpNMarc').textContent = Object.keys(f.marc).filter(k => f.marc[k]).length;
    $('#lpRes').innerHTML = `<div class="no-imprimir">${enc}</div>` + (l.length ? html : '<div class="vacio">Sin productos con esos filtros</div>') + `<div class="no-imprimir">${pie}</div>`;
    document.querySelectorAll('#lpRes [data-mixto]').forEach(x => x.indeterminate = true);
    activarMinis($('#lpRes'));
  }
  function lpFiltrados() {
    const f = S.fPrecios, suc = sucFiltro(), labs = f.lab === '__varios' ? f.labs : f.lab ? [f.lab] : [];
    return (D().productos || []).filter(p => p.activo && (!f.cat || p.categoria === f.cat) && (!labs.length || labs.indexOf(p.lab) >= 0) &&
      (!f.txt || coincide(p.id + ' ' + p.nombre, f.txt)) && (!f.exist || existencia(p.id, suc) > 0));
  }
  /* Lista de precios: arma hojas tamaño carta ya separadas, cada una con encabezado, renglón de columnas y pie
     (Safari no repite el encabezado/pie de las tablas al imprimir, así que no dependemos de eso). */
  function lpPaginar(src) {
    const limpiar = el => { el.querySelectorAll('.no-imprimir').forEach(e => e.remove()); el.removeAttribute('onclick'); el.classList.remove('clic'); return el; };
    const encH = src.querySelector('th.lp-celda-enc').innerHTML, pieH = src.querySelector('td.lp-celda-pie').innerHTML;
    const colsTr = limpiar(src.querySelector('tr.lp-cols').cloneNode(true));
    const filas = [...src.querySelectorAll('.lp-tabla > tbody > tr')].map(tr => limpiar(tr.cloneNode(true)));
    const M = document.createElement('div'); M.className = 'lp-paginas lp-medir'; document.body.appendChild(M);
    M.innerHTML = `<div class="lp-pagina"><div class="lp-p-enc">${encH}</div><table class="lp-p-tabla"><thead></thead><tbody></tbody></table>
      <div class="lp-p-pie">${pieH}<span class="lp-p-num">Página 00 de 00</span></div></div>`;
    M.querySelectorAll('.lp-fecha').forEach(e => e.textContent = fechaLarga());
    const pag = M.querySelector('.lp-pagina'), thead = M.querySelector('thead'), tbody = M.querySelector('tbody');
    thead.appendChild(colsTr.cloneNode(true));
    filas.forEach(f => tbody.appendChild(f));
    const anchos = [...thead.querySelectorAll('th')].map(x => x.getBoundingClientRect().width), tot = anchos.reduce((a, b) => a + b, 0) || 1;
    const alto = filas.map(f => f.getBoundingClientRect().height);
    pag.style.height = 'auto';
    const fijo = pag.getBoundingClientRect().height - tbody.getBoundingClientRect().height;
    pag.style.height = '';
    const disp = pag.getBoundingClientRect().height - fijo - 16;
    const encEl = M.querySelector('.lp-p-enc').innerHTML;
    M.remove();
    // reparto en hojas: no deja un título de grupo solo al final y repite el grupo "(continúa)" al cambiar de hoja
    const hojas = []; let hoja = [], usado = 0, grupo = null;
    const nueva = () => { hojas.push(hoja); hoja = []; usado = 0; if (grupo !== null) { hoja.push({ g: grupo, cont: 1 }); usado += alto[grupo]; } };
    filas.forEach((f, i) => {
      const esGrupo = f.classList.contains('grupo');
      const necesita = alto[i] + (esGrupo && i + 1 < filas.length ? alto[i + 1] : 0);
      if (hoja.length && usado + necesita > disp && !(hoja.length === 1 && hoja[0].cont)) { if (esGrupo) grupo = null; nueva(); }
      if (esGrupo) grupo = i;
      hoja.push({ i: i }); usado += alto[i];
    });
    if (hoja.length) hojas.push(hoja);
    const cols = '<colgroup>' + anchos.map(w => `<col style="width:${(w / tot * 100).toFixed(2)}%">`).join('') + '</colgroup>';
    const filaHtml = x => {
      if (!x.cont) return filas[x.i].outerHTML;
      const c = filas[x.g].cloneNode(true), sm = c.querySelector('small'); if (sm) sm.textContent = '(continúa)'; return c.outerHTML;
    };
    return '<div class="lp-paginas">' + hojas.map((h, k) => `<div class="lp-pagina"><div class="lp-p-enc">${encEl}</div>
      <table class="lp-p-tabla lp-fija">${cols}<thead>${colsTr.outerHTML}</thead><tbody>${h.map(filaHtml).join('')}</tbody></table>
      <div class="lp-p-pie">${pieH}<span class="lp-p-num">Página ${k + 1} de ${hojas.length}</span></div></div>`).join('') + '</div>';
  }
  const fechaLarga = () => new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
  function lpTituloAuto() {
    const f = S.fPrecios, listas = (D().catalogos || {}).listas || [], c = f.modo === 'cliente' && f.cli ? cliente(f.cli) : null;
    if (f.modo === 'cliente') return c ? 'Lista de precios para ' + (c.razon || c.nombre) : 'Lista de precios';
    if (f.modo === 'todas') { const cols = listas.filter(x => (f.sel || listas).indexOf(x) >= 0); return cols.length === 1 ? 'Lista de precios ' + cols[0] : 'Lista de precios'; }
    return 'Lista de precios ' + f.lista;
  }
  function lpMarcarGrupo(k, on) { const f = S.fPrecios; (S.lpGrupos[k] || []).forEach(id => f.marc[id] = on ? 1 : 0); pintarPrecios(); }
  function lpMarcar(id, on) { S.fPrecios.marc[id] = on ? 1 : 0; pintarPrecios(); }
  function lpCargarSel(nombre) {
    const f = S.fPrecios, x = (S.selsLP || []).find(s => s.nombre === nombre);
    f.selNom = x ? x.nombre : '';
    if (x) { f.marc = {}; x.ids.forEach(id => f.marc[id] = 1); f.solo = true; Object.assign(f, x.filtros || {}, { marc: f.marc, solo: true, selNom: x.nombre, txt: '', cat: '', lab: '', labs: [], exist: false }); }
    V.precios();
  }
  async function lpGuardarSel() {
    const f = S.fPrecios, ids = Object.keys(f.marc).filter(k => f.marc[k]);
    if (!ids.length) return toast('Primero marca los productos que quieres guardar');
    const nombre = prompt('Nombre de la selección (' + ids.length + ' productos):', f.selNom || '');
    if (!nombre || !nombre.trim()) return;
    try {
      const r = await pedir('guardarSelListaPrecios', { nombre: nombre, ids: ids, filtros: { modo: f.modo, lista: f.lista, sel: f.sel, grupo: f.grupo, iva: f.iva, titulo: f.titulo, subtitulo: f.subtitulo, sucDatos: f.sucDatos } });
      toast('✔ Selección "' + r.nombre + '" ' + (r.reemplazada ? 'actualizada' : 'guardada') + ' (' + r.productos + ' productos)');
      S.selsLP = await pedir('selListaPrecios', {}, true); f.selNom = r.nombre; V.precios();
    } catch (e) {}
  }
  async function lpBorrarSel() {
    const f = S.fPrecios; if (!f.selNom || !confirm('¿Borrar la selección guardada "' + f.selNom + '"? Los productos no se modifican.')) return;
    try { await pedir('borrarSelListaPrecios', { nombre: f.selNom }); S.selsLP = await pedir('selListaPrecios', {}, true); f.selNom = ''; V.precios(); toast('Selección borrada'); } catch (e) {}
  }
  function verPreciosProducto(id) {
    const p = prod(id), f = S.fPrecios || {}, c = f.modo === 'cliente' && f.cli ? cliente(f.cli) : null;
    const marca = c ? c.lista : (f.modo === 'lista' ? f.lista : '');
    const filas = D().catalogos.listas.map(x => ({ l: x, v: p.precios[x] }));
    const exist = sucsPermitidas().map(s => ({ s: s.nombre, q: existencia(id, s.id) })).filter(x => x.q);
    const cols = [{ t: 'Lista', h: x => x.l === marca ? `<b>${esc(x.l)}</b> <span class="etq ok">${c ? 'Lista del cliente' : 'Seleccionada'}</span>` : esc(x.l) },
      { t: 'Sin IVA', num: 1, h: x => x.v ? $$(x.v) : '—' }, { t: 'Con IVA', num: 1, h: x => x.v ? $$(x.v * (1 + (p.iva || 0))) : '—' }];
    if (puede('ver_utilidades') && p.costo) cols.push({ t: 'Margen', num: 1, h: x => x.v ? ((x.v - p.costo) / x.v * 100).toFixed(1) + '%' : '—' });
    modal(p.nombre, `${bloqueFoto(p)}<p class="muted">${esc(p.id)} · ${esc(p.unidad)} · ${esc(p.categoria || '')} · ${esc(p.lab || '')} · ${p.iva ? 'Con IVA' : 'Exento de IVA'}${p.especies ? ' · ' + esc(p.especies) : ''}</p>
      ${tabla(cols, filas)}<h4 style="margin:14px 0 8px">Existencias</h4>${tabla([{ t: 'Sucursal', k: 's' }, { t: 'Existencia', num: 1, h: x => nf(x.q) }], exist, { vacio: 'Sin existencia' })}
      ${puede('ventas') ? `<div class="acciones"><button class="btn primario" onclick="App.venderProducto('${esc(id)}')">🛒 Agregar a una venta</button></div>` : ''}`);
    cargarFotoGrande(id);
  }
  function venderProducto(id) {
    cerrarModal();
    const f = S.fPrecios || {};
    if (!S.venta) S.venta = ventaNueva();
    ir('venta');
    if (f.modo === 'cliente' && f.cli && !S.venta.cli) elegirClienteVenta(f.cli);
    agregarLineaVenta(id);
  }


  /* ---------- FOTOS DE PRODUCTOS ---------- */
  S.fotos = {};
  let colaFotos = [], timerFotos = null, obsFotos = null;
  const imgMini = p => p && p.foto ? `<img class="mini" data-mini="${esc(p.id)}" alt="">` : '<span class="mini sin-foto">📦</span>';
  function pedirMinis() {
    const ids = [...new Set(colaFotos)].filter(id => S.fotos[id] === undefined).slice(0, 40); colaFotos = colaFotos.filter(id => ids.indexOf(id) < 0 && S.fotos[id] === undefined);
    if (!ids.length) return;
    ids.forEach(id => S.fotos[id] = null);
    pedir('fotosMini', { ids: ids }, true).then(r => { recibirMinis(r); guardarFotosLocal(); })
      .catch(() => ids.forEach(id => delete S.fotos[id])).finally(() => { if (colaFotos.length) timerFotos = setTimeout(pedirMinis, 50); });
  }
  function pintarMini(id) {
    document.querySelectorAll(`img[data-mini="${CSS.escape(id)}"]`).forEach(im => { if (S.fotos[id]) im.src = S.fotos[id]; else im.replaceWith(Object.assign(document.createElement('span'), { className: 'mini sin-foto', textContent: '📦' })); });
  }
  function activarMinis(cont) {
    if (!cont) return;
    if (!obsFotos) obsFotos = new IntersectionObserver(ents => ents.forEach(e => { if (!e.isIntersecting) return; obsFotos.unobserve(e.target); const id = e.target.dataset.mini;
      if (S.fotos[id]) e.target.src = S.fotos[id]; else if (S.fotos[id] === undefined) { colaFotos.push(id); clearTimeout(timerFotos); timerFotos = setTimeout(pedirMinis, 120); } }), { rootMargin: '200px' });
    cont.querySelectorAll('img[data-mini]').forEach(im => { if (S.fotos[im.dataset.mini]) im.src = S.fotos[im.dataset.mini]; else obsFotos.observe(im); });
  }
  /* Miniaturas guardadas en el equipo (IndexedDB): se descargan todas en segundo plano al entrar y con "Actualizar para ruta",
     así aparecen al momento (y sin señal). Cualquier miniatura que se dibuje en pantalla se llena sola (MutationObserver). */
  const FOTOS_DIAS = 7;
  /** Respuesta de fotosMini. '#grande' = la miniatura de Drive pesa mucho: se baja una vez, se reduce aquí y se guarda en el servidor para los demás equipos. */
  let colaGrandes = [], bajandoGrandes = false;
  function recibirMinis(r) {
    let n = 0;
    Object.keys(r).forEach(id => { if (r[id] === '#grande') { if (colaGrandes.indexOf(id) < 0) colaGrandes.push(id); return; } S.fotos[id] = r[id] || ''; pintarMini(id); n++; });
    if (colaGrandes.length) procesarGrandes();
    return n;
  }
  function reducirUri(uri, max) {
    return new Promise((res, rej) => { const im = new Image(); im.onerror = () => rej(new Error('img')); im.onload = () => {
      const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', .82)); }; im.src = uri; });
  }
  async function procesarGrandes() {
    if (bajandoGrandes) return; bajandoGrandes = true;
    try {
      while (colaGrandes.length && S.token && navigator.onLine !== false) {
        const id = colaGrandes.shift();
        try {
          const r = await pedir('miniGrande', { id: id }, true);
          if (!r.uri) { S.fotos[id] = ''; pintarMini(id); continue; }
          const mini = /^data:/.test(r.uri) ? await reducirUri(r.uri, 200) : r.uri;
          S.fotos[id] = mini; pintarMini(id); guardarFotosLocal();
          if (/^data:image\/jpeg/.test(mini)) pedir('guardarMiniProducto', { id: id, dataUri: mini }, true).catch(() => {});
        } catch (e) { if (navigator.onLine === false) { colaGrandes.unshift(id); break; } }
      }
    } finally { bajandoGrandes = false; }
  }
  async function cargarFotosLocal() {
    try { const f = await KV.get('fotos'); if (f && f.m) { Object.keys(f.m).forEach(id => { if (S.fotos[id] == null && f.m[id] != null) S.fotos[id] = f.m[id]; }); S.fotosT = f.t || 0; pintarTodasMinis(); } } catch (e) {}
  }
  function guardarFotosLocal() {
    const m = {}; Object.keys(S.fotos).forEach(id => { if (typeof S.fotos[id] === 'string') m[id] = S.fotos[id]; });
    KV.set('fotos', { t: S.fotosT || Date.now(), m: m });
  }
  function pintarTodasMinis(raiz) {
    (raiz || document).querySelectorAll('img[data-mini]').forEach(im => { const id = im.dataset.mini; if (S.fotos[id]) { if (im.src !== S.fotos[id]) im.src = S.fotos[id]; } else if (S.fotos[id] === '') pintarMini(id); });
  }
  /** Descarga (40 por envío) las miniaturas que faltan; con `renovar` vuelve a bajar todas (cambios de foto). */
  async function descargarFotos(renovar, avance) {
    if (S.bajandoFotos || !S.token || navigator.onLine === false) return 0;
    S.bajandoFotos = true; let n = 0;
    try {
      const prods = (D().productos || []).filter(p => p.foto);
      const ids = prods.map(p => p.id).filter(id => renovar || !S.fotos[id]);   // '' = antes no se pudo: se vuelve a intentar
      for (let i = 0; i < ids.length; i += 40) {
        if (navigator.onLine === false || !S.token) break;
        if (avance) avance(i, ids.length);
        const lote = ids.slice(i, i + 40);
        try { const r = await pedir('fotosMini', { ids: lote }, true); n += recibirMinis(r); guardarFotosLocal(); }
        catch (e) { break; }
      }
      if (renovar && n) { S.fotosT = Date.now(); guardarFotosLocal(); }
    } finally { S.bajandoFotos = false; }
    return n;
  }
  function fotosAlEntrar() {
    const viejas = !S.fotosT || Date.now() - S.fotosT > FOTOS_DIAS * 86400e3;
    senalFuerte().then(ok => { if (ok) descargarFotos(viejas && Object.keys(S.fotos).length > 0); }).catch(() => {});
  }
  try {
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue;
      const ims = n.matches && n.matches('img[data-mini]') ? [n] : (n.querySelectorAll ? [...n.querySelectorAll('img[data-mini]')] : []);
      ims.forEach(im => { const id = im.dataset.mini; if (S.fotos[id]) im.src = S.fotos[id]; else if (S.fotos[id] === undefined) { colaFotos.push(id); clearTimeout(timerFotos); timerFotos = setTimeout(pedirMinis, 150); } }); } })
      .observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
  const bloqueFoto = p => p && p.foto ? `<div class="foto-prod" data-grande="${esc(p.id)}"><span class="muted">Cargando foto…</span></div>` : '';
  async function cargarFotoGrande(id) {
    const el = document.querySelector(`[data-grande="${CSS.escape(id)}"]`); if (!el) return;
    try { const r = await pedir('fotoProducto', { id: id }, true); el.innerHTML = r.uri ? `<img src="${r.uri}" alt="">` : `<span class="muted">${r.falta ? 'No se encontró la imagen ' + esc(r.falta) : 'Sin foto'}</span>`; }
    catch (e) { el.innerHTML = S.fotos[id] ? `<img src="${S.fotos[id]}" alt="">` : '<span class="muted">Foto no disponible sin conexión</span>'; }
  }
  function reducirImagen(file, max, conAlfa) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onerror = rej; fr.onload = () => { const im = new Image(); im.onerror = rej; im.onload = () => {
      const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      const x = c.getContext('2d'); if (conAlfa) { x.drawImage(im, 0, 0, c.width, c.height); return res(c.toDataURL('image/png')); }   // logotipos PNG: se conserva lo transparente
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', .85)); }; im.src = fr.result; }; fr.readAsDataURL(file); });
  }
  async function fotoNuevaPrev(input) {
    const f = input.files && input.files[0]; if (!f) return;
    try { const uri = await reducirImagen(f, 600); $('#fotoEdit').innerHTML = `<img src="${uri}" alt="">`; } catch (e) { toast('No se pudo leer la imagen', true); input.value = ''; }
  }
  async function subirFoto(id, input) {
    const f = input.files && input.files[0]; if (!f) return;
    try {
      const uri = await reducirImagen(f, 1000);
      await pedir('subirFotoProducto', { id: id, dataUri: uri });
      toast('✔ Foto guardada'); delete S.fotos[id]; guardarFotosLocal(); const p = prod(id); if (p) p.foto = 1;
      const el = document.querySelector(`[data-grande="${CSS.escape(id)}"]`) || document.querySelector('#fotoEdit');
      if (el) el.innerHTML = `<img src="${uri}" alt="">`;
    } catch (e) { if (!e.message) toast('No se pudo leer la imagen', true); }
  }

  /* ---------- PRODUCTOS ---------- */
  V.productos = (tab) => {
    tab = tab || S.tabProd || 'cat'; if (tab === 'lista' || (tab === 'margen' && !puede('analisis_precios'))) tab = 'cat'; S.tabProd = tab;
    $('#vista').innerHTML = `<div id="pCont"></div>`;
    if (S.vista === 'productos') pintarSubnav();
    ({ cat: prodCatalogo, margen: prodMargen, port: prodPortafolio })[tab]();
  };
  /* ---------- ACTUALIZAR PRECIOS DESDE LA MATRIZ (hoja "Matriz Precios Venta y CRM Int Vet") ---------- */
  V.matriz = () => {
    $('#vista').innerHTML = `<div class="tarjeta"><h3 style="margin-top:0">Actualizar precios desde la Matriz</h3>
      <p class="muted" style="margin:4px 0 10px">Lee la hoja <b>Matriz Precios Venta y CRM Int Vet</b> (una pestaña por laboratorio) y compara cada producto por su <b>código = ID_Producto</b> contra los precios que tiene hoy la app.
      Nada cambia hasta que presiones <b>Aplicar</b>, y cada cambio queda guardado en el historial.</p>
      <div class="acciones" style="justify-content:flex-start;margin:0"><button class="btn primario" onclick="App.leerMatriz()">📥 Leer la Matriz</button>
      <button class="btn" onclick="App.verHistPrecios()">🕘 Historial de cambios de precio</button></div></div><div id="mzCont"></div>`;
    if (S.mz) pintarMatriz();
  };
  async function leerMatriz() {
    $('#mzCont').innerHTML = '<div class="vacio">Leyendo la Matriz… puede tardar unos segundos.</div>';
    try {
      const r = await pedir('matrizPreview', {});
      if (!$('#mzCont')) return;
      S.mz = r; S.mzSel = {}; S.mzAlta = {}; S.mzCampos = S.mzCampos || r.campos.map(c => c.campo); S.mzVer = S.mzVer || 'cambios'; S.mzLab = ''; S.mzTxt = '';
      r.filas.forEach(f => { if (f.existe && f.cambios && !f.alertas.some(a => /repetido/.test(a))) S.mzSel[f.id] = 1; });
      pintarMatriz();
    } catch (e) { if ($('#mzCont')) $('#mzCont').innerHTML = '<div class="vacio">No se pudo leer la Matriz.</div>'; }
  }
  const mzCamb = f => S.mz.campos.filter(c => S.mzCampos.indexOf(c.campo) >= 0 && f.existe && f.nuevo[c.campo] !== undefined && Math.abs(f.nuevo[c.campo] - (f.actual[c.campo] || 0)) > 0.004).length;
  function mzVisibles() {
    const t = (S.mzTxt || '').toLowerCase();
    return S.mz.filas.filter(f => (!S.mzLab || f.lab === S.mzLab) && (!t || (f.id + ' ' + f.nombre + ' ' + f.nombreMatriz).toLowerCase().indexOf(t) >= 0) &&
      (S.mzVer === 'todos' || (S.mzVer === 'cambios' && mzCamb(f) > 0) || (S.mzVer === 'alertas' && f.alertas.length) || (S.mzVer === 'noexisten' && !f.existe)));
  }
  function pintarMatriz() {
    const r = S.mz, R = r.resumen, vis = mzVisibles(), labs = r.hojas.map(h => h.lab);
    const selIds = Object.keys(S.mzSel).filter(id => S.mzSel[id]), selF = r.filas.filter(f => S.mzSel[f.id]);
    const nAlta = Object.keys(S.mzAlta || {}).filter(id => S.mzAlta[id]).length, visNuevos = vis.filter(f => !f.existe && !mzRep(f));
    const nCamb = selF.reduce((t, f) => t + mzCamb(f), 0);
    const avisos = r.hojas.filter(h => h.avisos.length);
    const campos = r.campos.filter(c => S.mzCampos.indexOf(c.campo) >= 0);
    const celda = (f, c) => {
      const n = f.nuevo[c.campo], a = f.actual[c.campo];
      if (n === undefined) return '<span class="muted">—</span>';
      if (!f.existe) return `<b>${$$(n)}</b>`;
      const d = a ? (n - a) / a : null, igual = Math.abs(n - (a || 0)) <= 0.004;
      return igual ? `<span class="muted">${$$(n)}</span>` : `<b>${$$(n)}</b><br><small class="${d !== null && Math.abs(d) > 0.25 ? 'txt-mal' : 'muted'}">${$$(a || 0)}${d !== null ? ' · ' + (d > 0 ? '+' : '') + Math.round(d * 1000) / 10 + ' %' : ''}</small>`;
    };
    const kpi = (t, n, sub, ver) => `<div class="kpi${ver ? ' kpi-clic' : ''}" ${ver ? `onclick="App.mzFiltro('ver','${ver}')"` : ''}><small>${t}</small><b>${nf(n)}</b><span>${sub}</span></div>`;
    $('#mzCont').innerHTML = `${avisos.length ? `<div class="tarjeta" style="border-color:var(--aviso)"><b>⚠️ Revisa estas pestañas de la Matriz:</b>${avisos.map(h => `<div class="muted" style="font-size:13px;margin-top:4px"><b>${esc(h.nombre)}:</b> ${h.avisos.map(esc).join(' · ')}</div>`).join('')}</div>` : ''}
      <div class="kpis">${kpi('Productos en la Matriz', R.enMatriz, r.hojas.length + ' laboratorios', 'todos')}${kpi('Con precios diferentes', R.conCambios, 'a los de la app', 'cambios')}
        ${kpi('Con alertas', R.conAlertas, 'revisar antes de aplicar', 'alertas')}${kpi('No existen en Productos', R.noExisten, 'código sin alta en la app', 'noexisten')}
        <div class="kpi kpi-clic" onclick="App.mzSinMatriz()"><small>Productos sin precio en la Matriz</small><b>${nf(R.sinMatriz)}</b><span>activos en la app</span></div></div>
      <div class="tarjeta"><div style="font-size:13px;margin-bottom:6px"><b>Listas que se van a actualizar</b> <span class="muted">(desmarca las que no quieras tocar)</span></div>
        <div class="mz-listas">${r.campos.map(c => `<label class="check"><input type="checkbox" ${S.mzCampos.indexOf(c.campo) >= 0 ? 'checked' : ''} onchange="App.mzCampo('${c.campo}', this.checked)"> ${esc(c.t)} <small class="muted">(col. ${c.col})</small></label>`).join('')}</div>
        <div class="fila" style="margin-top:10px"><label>Laboratorio<select onchange="App.mzFiltro('lab', this.value)">${opts([['', 'Todos']].concat(labs.map(l => [l, l])), S.mzLab)}</select></label>
          <label>Mostrar<select onchange="App.mzFiltro('ver', this.value)">${opts([['cambios', 'Solo con cambios'], ['todos', 'Todos'], ['alertas', 'Con alertas'], ['noexisten', 'No existen en Productos']], S.mzVer)}</select></label>
          <label>Buscar<input id="mzTxt" value="${esc(S.mzTxt || '')}" placeholder="Clave o nombre"></label></div></div>
      <div class="mz-barra"><span><b>${selIds.length}</b> productos seleccionados · <b>${nCamb}</b> precios por cambiar</span>
        <span class="acciones" style="margin:0"><button class="btn chico" onclick="App.mzSelTodo(1)">Seleccionar los ${vis.filter(f => f.existe).length} visibles</button><button class="btn chico" onclick="App.mzSelTodo(0)">Quitar selección</button>
        <button class="btn primario" ${nCamb ? '' : 'disabled'} onclick="App.mzAplicar()">✔ Aplicar ${nCamb} cambios</button></span></div>
      ${R.noExisten ? `<div class="mz-barra"><span><b>${nAlta}</b> códigos nuevos marcados para dar de alta en Productos</span>
        <span class="acciones" style="margin:0">${visNuevos.length ? `<button class="btn chico" onclick="App.mzAltaTodo(1)">Marcar los ${visNuevos.length} nuevos visibles</button>` : `<button class="btn chico" onclick="App.mzFiltro('ver','noexisten')">Ver los ${R.noExisten} nuevos</button>`}
        ${nAlta ? '<button class="btn chico" onclick="App.mzAltaTodo(0)">Quitar</button>' : ''}<button class="btn primario" ${nAlta ? '' : 'disabled'} onclick="App.mzAltaForm()">➕ Dar de alta ${nAlta}</button></span></div>` : ''}
      ${vis.length > 400 ? `<p class="muted">Se muestran 400 de ${vis.length}; filtra por laboratorio para ver el resto.</p>` : ''}` + tabla([
        { t: '', h: f => f.existe ? `<input type="checkbox" ${S.mzSel[f.id] ? 'checked' : ''} onclick="event.stopPropagation();App.mzSel('${esc(f.id)}', this.checked)">`
          : mzRep(f) ? '' : `<input type="checkbox" title="Dar de alta" ${S.mzAlta[f.id] ? 'checked' : ''} onclick="event.stopPropagation();App.mzAltaSel('${esc(f.id)}', this.checked)">` },
        { t: 'Clave', h: f => `<b>${esc(f.id)}</b><br><small class="muted">${esc(f.lab)} · fila ${f.fila}</small>` },
        { t: 'Producto', h: f => `<div style="min-width:190px">${esc(f.nombre)}${f.presentacion && f.nombre.toLowerCase().indexOf(f.presentacion.toLowerCase()) < 0 ? ` <small class="muted">· ${esc(f.presentacion)}</small>` : ''}` +
          (f.alertas.length ? `<div style="margin-top:3px">${f.alertas.map(a => `<span class="etq ${/No existe|repetido|debajo/.test(a) ? 'mal' : 'av'}" style="margin:1px 2px 1px 0;font-size:11px">${esc(a)}</span>`).join('')}</div>` : '') + '</div>' }]
        .concat(campos.map(c => ({ t: c.t, num: 1, h: f => celda(f, c) }))),
        vis.slice(0, 400), { vacio: 'Nada que mostrar con esos filtros' });
    const tx = $('#mzTxt'); if (tx) tx.onkeydown = e => { if (e.key === 'Enter') App.mzFiltro('txt', tx.value); };
  }
  function mzFiltro(k, v) { if (k === 'lab') S.mzLab = v; if (k === 'ver') S.mzVer = v; if (k === 'txt') S.mzTxt = v; pintarMatriz(); }
  function mzCampo(c, on) { S.mzCampos = S.mzCampos.filter(x => x !== c).concat(on ? [c] : []); pintarMatriz(); }
  function mzSel(id, on) { S.mzSel[id] = on ? 1 : 0; pintarMatriz(); }
  function mzSelTodo(on) { if (on) mzVisibles().filter(f => f.existe && !f.alertas.some(a => /repetido/.test(a))).forEach(f => S.mzSel[f.id] = 1); else S.mzSel = {}; pintarMatriz(); }
  async function mzAplicar() {
    const ids = Object.keys(S.mzSel).filter(id => S.mzSel[id]);
    const n = S.mz.filas.filter(f => S.mzSel[f.id]).reduce((t, f) => t + mzCamb(f), 0);
    const nom = S.mz.campos.filter(c => S.mzCampos.indexOf(c.campo) >= 0).map(c => c.t).join(', ');
    if (!confirm(`¿Actualizar ${n} precios de ${ids.length} productos?\nListas: ${nom}\n\nQueda registrado en el historial.`)) return;
    try {
      const r = await pedir('matrizAplicar', { ids: ids, campos: S.mzCampos });
      toast(`✔ ${r.cambios} precios actualizados en ${r.productos} productos` + (r.omitidosRepetidos && r.omitidosRepetidos.length ? ` · ${r.omitidosRepetidos.length} omitidos por código repetido` : ''));
      await refrescarDatos(true).catch(() => {});
      leerMatriz();
    } catch (e) {}
  }
  const mzRep = f => f.alertas.some(a => /repetido/.test(a));
  function mzAltaSel(id, on) { S.mzAlta[id] = on ? 1 : 0; pintarMatriz(); }
  function mzAltaTodo(on) { if (on) mzVisibles().filter(f => !f.existe && !mzRep(f)).forEach(f => S.mzAlta[f.id] = 1); else S.mzAlta = {}; pintarMatriz(); }
  function mzLabSugerido(hoja, lab) {
    const c = {}; S.mz.filas.forEach(f => { if (f.hoja === hoja && f.existe && f.labCat) c[f.labCat] = (c[f.labCat] || 0) + 1; });
    const k = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
    return k || lab;
  }
  function mzAltaForm() {
    const l = S.mz.filas.filter(f => S.mzAlta[f.id] && !f.existe && !mzRep(f));
    if (!l.length) return;
    const ps = D().productos || [], cats = [...new Set(ps.map(p => p.categoria).filter(Boolean))].sort(), labs = [...new Set(ps.map(p => p.lab).filter(Boolean).concat(l.map(f => mzLabSugerido(f.hoja, f.lab))))].sort();
    const tasas = (D().catalogos || {}).tasasIva || [['T_Ex', 'Exento']];
    const nom = f => f.presentacion && f.nombreMatriz.toLowerCase().indexOf(f.presentacion.toLowerCase()) < 0 ? f.nombreMatriz + ', ' + f.presentacion : f.nombreMatriz;
    const dl = (id, ops) => `<datalist id="${id}">${ops.map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
    modal('Dar de alta ' + l.length + ' productos desde la Matriz', `<p class="muted">Se crean <b>activos</b>, unidad <b>Pieza</b>, con control de lote y caducidad, y con todos los precios de la Matriz.
      Revisa el nombre, el laboratorio, la categoría y el <b>IVA</b>. Lo demás (registro, dosis, foto…) lo completas después en el Catálogo.</p>
      ${dl('mzDlLab', labs)}${dl('mzDlCat', cats)}
      <div class="fila" style="margin:8px 0"><label>Categoría para todos<input id="mzCatTodos" list="mzDlCat" placeholder="Elige o escribe"></label>
        <label>IVA para todos<select id="mzIvaTodos">${opts(tasas, '', '—')}</select></label><button class="btn fijo" onclick="App.mzAltaTodos()">Aplicar a todos</button></div>
      <div class="tabla-cont"><table><thead><tr><th>Clave</th><th>Nombre</th><th>Laboratorio</th><th>Categoría</th><th>IVA</th><th class="num">Aliado</th></tr></thead><tbody>
      ${l.map(f => `<tr data-alta="${esc(f.id)}"><td><b>${esc(f.id)}</b><br><small class="muted">${esc(f.lab)} · fila ${f.fila}</small></td>
        <td><input data-c="nombre" value="${esc(nom(f))}" style="min-width:170px"></td>
        <td><input data-c="lab" list="mzDlLab" value="${esc(mzLabSugerido(f.hoja, f.lab))}" style="min-width:115px"></td>
        <td><input data-c="categoria" list="mzDlCat" placeholder="Categoría" style="min-width:115px"></td>
        <td><select data-c="tasa" style="min-width:110px">${opts(tasas, 'T_Ex')}</select></td><td class="num">${f.nuevo.Precio_Aliado ? $$(f.nuevo.Precio_Aliado) : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.mzAltaGuardar()">➕ Dar de alta ${l.length}</button></div>`);
  }
  function mzAltaTodos() {
    const c = $('#mzCatTodos').value, t = $('#mzIvaTodos').value;
    document.querySelectorAll('[data-alta]').forEach(tr => { if (c) tr.querySelector('[data-c=categoria]').value = c; if (t) tr.querySelector('[data-c=tasa]').value = t; });
  }
  async function mzAltaGuardar() {
    const ps = D().productos || [];
    const canon = (v, pk) => { v = String(v || '').replace(/\s+/g, ' ').trim(); const ex = [...new Set(ps.map(x => x[pk]).filter(Boolean))].find(x => norm(x).trim() === norm(v)); return ex || v; };
    const l = [...document.querySelectorAll('[data-alta]')].map(tr => { const g = k => tr.querySelector('[data-c=' + k + ']').value;
      return { id: tr.dataset.alta, nombre: g('nombre').trim(), lab: canon(g('lab'), 'lab'), categoria: canon(g('categoria'), 'categoria'), tasa: g('tasa') }; });
    const sinNom = l.filter(x => !x.nombre); if (sinNom.length) return toast('Falta el nombre de ' + sinNom.map(x => x.id).join(', '));
    const conIva = l.filter(x => x.tasa !== 'T_Ex').length;
    if (!confirm('¿Dar de alta ' + l.length + ' productos en el catálogo?' + (conIva ? '\n' + conIva + ' con IVA.' : '\nTodos exentos de IVA.'))) return;
    try {
      const r = await pedir('matrizAltas', { productos: l });
      cerrarModal();
      toast('✔ ' + r.creados.length + ' productos dados de alta' + (r.omitidos.length ? ' · ' + r.omitidos.length + ' omitidos: ' + r.omitidos.join('; ') : ''));
      S.mzAlta = {};
      await refrescarDatos(true).catch(() => {});
      leerMatriz();
    } catch (e) {}
  }
  function mzSinMatriz() {
    const l = S.mz.sinMatriz;
    modal('Productos activos sin precio en la Matriz (' + l.length + ')', `<p class="muted">Estos productos están dados de alta en la app pero su clave no aparece en ninguna pestaña de la Matriz. Revisa si la clave está escrita igual en los dos lugares.</p>` +
      tabla([{ t: 'Clave', h: x => `<b>${esc(x.id)}</b>` }, { t: 'Producto', k: 'nombre' }, { t: 'Laboratorio', k: 'lab' }], l, { vacio: 'Todos los productos activos están en la Matriz 🎉' }));
  }
  async function verHistPrecios() {
    try {
      const l = await pedir('historialPrecios', {});
      modal('Historial de cambios de precio', tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Clave', h: x => `<b>${esc(x.id)}</b>` }, { t: 'Producto', k: 'producto' }, { t: 'Lista', k: 'lista' },
        { t: 'Antes', num: 1, h: x => $$(x.antes) }, { t: 'Después', num: 1, h: x => `<b>${$$(x.despues)}</b>` }, { t: '%', num: 1, h: x => x.pct === null ? '—' : (x.pct > 0 ? '+' : '') + x.pct + ' %' },
        { t: 'Usuario', cls: 'ocultar-movil', k: 'usuario' }, { t: 'Origen', cls: 'ocultar-movil', k: 'origen' }], l, { vacio: 'Todavía no hay cambios registrados' }));
    } catch (e) {}
  }

  function filtrosProd(extra) {
    const ps = D().productos || [];
    const cats = [...new Set(ps.map(p => p.categoria).filter(Boolean))].sort(), labs = [...new Set(ps.map(p => p.lab).filter(Boolean))].sort();
    return `<div class="tarjeta no-imprimir"><div class="fila"><label>Buscar<input id="pfTxt" placeholder="Clave o nombre"></label>
      <label>Categoría<select id="pfCat">${opts(cats.map(c => [c, c]), '', 'Todas')}</select></label><label>Laboratorio<select id="pfLab">${opts(labs.map(c => [c, c]), '', 'Todos')}</select></label>
      <label>Estado<select id="pfAct"><option value="SI">Activos</option><option value="NO">Inactivos</option><option value="">Todos</option></select></label>${extra || ''}</div></div><div class="espacio"></div>`;
  }
  function prodFiltrados() {
    const txt = $('#pfTxt').value, cat = $('#pfCat').value, lab = $('#pfLab').value, act = $('#pfAct').value;
    return (D().productos || []).filter(p => (!txt || coincide(p.id + ' ' + p.nombre, txt)) && (!cat || p.categoria === cat) && (!lab || p.lab === lab) && (!act || (act === 'SI') === p.activo))
      .sort(porExistencia(mapaExist(sucFiltro()), p => p.id, p => p.nombre));
  }
  const enlazarFiltros = fn => ['#pfTxt', '#pfCat', '#pfLab', '#pfAct', '#pfLista'].forEach(s => enlazarFiltro(s, fn));
  function prodCatalogo() {
    $('#pCont').innerHTML = filtrosProd(puede('productos_editar') ? '<button class="btn primario fijo" onclick="App.formProducto(null)">+ Nuevo producto</button>' : '') + '<div id="pRes"></div>';
    const pintar = () => { const l = prodFiltrados(); S.lista = l; const suc = sucFiltro();
      $('#pRes').innerHTML = `<p class="muted">${l.length} productos</p>` + tabla([{ t: '', h: p => imgMini(p) }, { t: 'Clave', k: 'id' }, { t: 'Producto', h: p => `<b>${esc(p.nombre)}</b>` }, { t: 'Unidad', k: 'unidad', cls: 'ocultar-movil' },
        { t: 'Categoría', k: 'categoria', cls: 'ocultar-movil' }, { t: 'Laboratorio', k: 'lab', cls: 'ocultar-movil' }, { t: 'P. Público', num: 1, h: p => $$(p.precios.Publico) },
        { t: suc ? 'Exist. ' + sucNom(suc) : 'Exist. total', num: 1, h: p => nf(existencia(p.id, suc)) }, { t: 'Estado', h: p => `<span class="etq ${p.activo ? 'ok' : 'mal'}">${p.activo ? 'Activo' : 'Inactivo'}</span>` }], l.slice(0, 1000), { clic: 'App.abrirProducto' });
      activarMinis($('#pRes')); };
    enlazarFiltros(pintar); pintar();
  }
  /* ---------- PORTAFOLIO DE PRODUCTOS: datos técnicos, fichas y PDF para clientes (sin precios) ---------- */
  /* ---- Presentaciones: el mismo producto en distintos tamaños se muestra una sola vez ----
   *  "DORACIDE, Frasco de 50 ml." + "DORACIDE, Frasco de 500 ml." → DORACIDE · "Frascos de 50 y 500 ml." */
  function presentacionesDe_(nombre) {
    const s = String(nombre || '').replace(/\s+/g, ' ').trim(), i = s.indexOf(',');
    let base = i >= 0 ? s.slice(0, i) : s, pres = i >= 0 ? s.slice(i + 1).trim() : '';
    const m = base.match(/^(.*?\S)\s+(\d+(?:[.,]\d+)?\s*(?:ml|lts?|l|kgs?|grs?|g|mg)\.?)$/i);   // "SOLFOS-T 20 L"
    if (m && m[1].length >= 2) { base = m[1]; if (!pres) pres = m[2]; }
    return { base: base.replace(/[\s.,*-]+$/, '').trim(), pres: pres.replace(/^[\s,]+/, '') };
  }
  function claveGrupo_(lab, nombre) {
    return String(lab || '').toUpperCase() + '|' + presentacionesDe_(nombre).base.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[®*™]/g, '').replace(/\s+/g, ' ').trim();
  }
  const UNI_ = { ml: ['ml', 'v', 1], l: ['L', 'v', 1000], lt: ['L', 'v', 1000], lts: ['L', 'v', 1000], g: ['g', 'm', 1], gr: ['g', 'm', 1], grs: ['g', 'm', 1], kg: ['kg', 'm', 1000], kgs: ['kg', 'm', 1000], mg: ['mg', 'm', 0.001] };
  function plural_(w) { const p = w.split(' '); p[0] = /[aeiouáéó]$/i.test(p[0]) ? p[0] + 's' : p[0] + 'es'; return p.join(' '); }
  function y_(a) { return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' y ' + a[a.length - 1]; }
  const may_ = t => t.charAt(0).toUpperCase() + t.slice(1);
  /** Junta las presentaciones: "Frascos de 50, 100 y 200 ml.", "Cajas con 60 y 180 caps."; las que no se parecen van en renglones. */
  function resumenPresentaciones_(lista) {
    const ps = []; lista.forEach(x => { const t = String(x || '').trim().replace(/\.+$/, ''); if (t && ps.indexOf(t) < 0) ps.push(t); });
    if (!ps.length) return '';
    const cubos = {}, orden = [], sueltas = [];
    ps.forEach(p => {
      const m = p.match(/^(?:(.*?)\s+(de|con)\s+)?(\d+(?:[.,]\d+)?)\s*([a-zA-Záéíóú]+)\.?$/);
      if (!m) { sueltas.push(p); return; }
      const k = UNI_[m[4].toLowerCase()] || [m[4], 'w:' + m[4].toLowerCase(), 1], cont = (m[1] || '').trim();
      const key = cont.toLowerCase() + '|' + k[1];
      if (!cubos[key]) { cubos[key] = { cont: cont, con: m[2] || 'de', l: [] }; orden.push(key); }
      cubos[key].l.push({ n: m[3].replace(',', '.'), u: k[0], o: Number(m[3].replace(',', '.')) * k[2] });
    });
    const lineas = orden.map(key => {
      const c = cubos[key], l = c.l.sort((a, b) => a.o - b.o);
      if (l.length === 1) return (c.cont ? may_(c.cont) + ' ' + c.con + ' ' : '') + l[0].n + ' ' + l[0].u;
      const partes = []; l.forEach(a => { const g = partes[partes.length - 1]; if (g && g.u === a.u) g.n.push(a.n); else partes.push({ u: a.u, n: [a.n] }); });
      const tam = partes.length === 1 ? y_(partes[0].n) + ' ' + partes[0].u : y_(partes.map(g => y_(g.n) + ' ' + g.u));
      return (c.cont ? plural_(may_(c.cont)) + ' ' + c.con + ' ' : '') + tam;
    }).concat(sueltas.map(may_));
    return lineas.length === 1 ? lineas[0] + '.' : lineas.map(t => '• ' + t + '.').join('\n');
  }
  /** Tarjetas del portafolio en la app: [{ base, pres, rep, miembros }] (productos del catálogo de la app). */
    function agruparPortafolio(l) {
      const m = {}, out = [];
      l.forEach(p => { const k = claveGrupo_(p.lab, p.nombre); if (!m[k]) { m[k] = { base: presentacionesDe_(p.nombre).base, miembros: [] }; out.push(m[k]); } m[k].miembros.push(p); });
      out.forEach(t => { t.pres = resumenPresentaciones_(t.miembros.map(p => presentacionesDe_(p.nombre).pres || p.unidad)); t.rep = t.miembros.find(p => p.foto) || t.miembros[0]; });
      return out;
    }
  function prodPortafolio() {
    const ps = D().productos || [];
    const cats = [...new Set(ps.map(p => p.categoria).filter(Boolean))].sort(), labs = [...new Set(ps.map(p => p.lab).filter(Boolean))].sort();
    const C = S.catPdf = S.catPdf || { labs: [], cats: [], ids: {} }; C.ids = C.ids || {};
    const chips = (arr, k) => `<div class="chips">${arr.map(x => `<label class="chip${C[k].indexOf(x) >= 0 ? ' on' : ''}"><input type="checkbox" data-c="${k}" value="${esc(x)}" ${C[k].indexOf(x) >= 0 ? 'checked' : ''}>${esc(x)}</label>`).join('')}</div>`;
    $('#pCont').innerHTML = `<div class="tarjeta no-imprimir port-guardados" id="cpGuardados"></div><div class="tarjeta no-imprimir cat-pdf">
        <div class="cat-pdf-enc"><div><h3 style="margin:0">📄 Portafolio de productos en PDF</h3><p class="muted" style="margin:2px 0 0;font-size:13px">Para compartir con tus clientes: con tu logotipo, datos técnicos e imagen sin fondo de cada producto. <b>No lleva precios.</b></p></div>
        <button class="btn primario fijo" onclick="App.pdfCatalogo()">📄 Generar portafolio</button></div>
        <div class="muted cat-pdf-sub">Laboratorios <span id="cpNL"></span> <a href="#" data-todo="labs">todos</a> · <a href="#" data-nada="labs">ninguno</a></div>${chips(labs, 'labs')}
        <div class="muted cat-pdf-sub">Categorías <span id="cpNC"></span> <a href="#" data-todo="cats">todas</a> · <a href="#" data-nada="cats">ninguna</a></div>${chips(cats, 'cats')}
        <div class="cat-pdf-sub"><span class="muted">Productos elegidos:</span> <b id="cpNP">0</b> <a href="#" id="cpVerSel">ver</a> · <a href="#" id="cpQuitarSel">quitar todos</a></div>
        <p class="cat-pdf-res" id="cpCuenta"></p></div>` +
      filtrosProd(`<label class="check fijo"><input type="checkbox" id="pfFicha"> Solo con ficha técnica</label><label class="check fijo"><input type="checkbox" id="pfElegidos"> Solo elegidos</label>
        <button class="btn chico fijo" id="pfMarcar">☑️ Elegir los visibles</button>`) + '<div id="pRes"></div>';
    const enPdf = () => { const ids = Object.keys(C.ids).filter(k => C.ids[k]), filtro = C.labs.length || C.cats.length;
      return ps.filter(p => p.activo && (C.ids[p.id] || ((filtro || !ids.length) && (!C.labs.length || C.labs.indexOf(p.lab) >= 0) && (!C.cats.length || C.cats.indexOf(p.categoria) >= 0)))); };
    S.portEnPdf = enPdf;
    pintarPortafolios(true);
    const cuenta = () => { const l = enPdf(), nG = agruparPortafolio(l).length, nP = Object.keys(C.ids).filter(k => C.ids[k]).length;
      $('#cpCuenta').innerHTML = `El PDF llevará <b>${nG}</b> ${nG === 1 ? 'producto' : 'productos'}${l.length > nG ? ' <span class="muted">(' + l.length + ' presentaciones juntas)</span>' : ''}${nG > PORT_LOTE ? ' <span class="muted">· se arma por partes; puede tardar unos minutos</span>' : ''}` +
        `<span class="muted"> · ${!C.labs.length && !C.cats.length && !nP ? 'todo el portafolio activo' : [C.labs.length ? C.labs.length + ' laboratorio(s)' : '', C.cats.length ? C.cats.length + ' categoría(s)' : '', nP ? nP + ' elegido(s) a mano' : ''].filter(Boolean).join(' + ')}</span>`;
      $('#cpNL').textContent = C.labs.length ? '(' + C.labs.length + ')' : ''; $('#cpNC').textContent = C.cats.length ? '(' + C.cats.length + ')' : ''; $('#cpNP').textContent = nP; };
    const box = $('#pCont .cat-pdf');
    box.addEventListener('change', e => { const c = e.target.dataset.c; if (!c) return; const v = e.target.value; C[c] = C[c].filter(x => x !== v); if (e.target.checked) C[c].push(v); e.target.parentNode.classList.toggle('on', e.target.checked); cuenta(); });
    box.addEventListener('click', e => {
      if (e.target.id === 'cpVerSel') { e.preventDefault(); $('#pfElegidos').checked = true; pintar(); return; }
      if (e.target.id === 'cpQuitarSel') { e.preventDefault(); C.ids = {}; cuenta(); pintar(); return; }
      const a = e.target.closest('[data-todo],[data-nada]'); if (!a) return; e.preventDefault(); const k = a.dataset.todo || a.dataset.nada, todo = !!a.dataset.todo;
      C[k] = todo ? (k === 'labs' ? labs : cats).slice() : []; box.querySelectorAll(`[data-c="${k}"]`).forEach(i => { i.checked = todo; i.parentNode.classList.toggle('on', todo); }); cuenta(); });
    const pintar = () => {
      const fi = $('#pfFicha').checked, el = $('#pfElegidos').checked;
      const l = prodFiltrados().filter(p => (!fi || p.ficha) && (!el || C.ids[p.id])).sort((a, b) => String(a.lab || '').localeCompare(String(b.lab || '')) || a.nombre.localeCompare(b.nombre));
      const T = agruparPortafolio(l); S.lista = T.map(t => t.rep); S.portTarj = T;
      const nf2 = T.filter(t => t.miembros.some(p => p.ficha)).length;
      $('#pRes').innerHTML = `<p class="muted">${T.length} productos${l.length > T.length ? ' (' + l.length + ' presentaciones)' : ''} · ${nf2} con ficha técnica${T.length > 300 ? ' · se muestran los primeros 300: usa los filtros' : ''}</p><div class="port-grid">${T.slice(0, 300).map((t, i) => { const p = t.rep, todos = t.miembros.every(m => C.ids[m.id]); return `
        <div class="port-card${todos ? ' elegido' : ''}" onclick="App.abrirProducto(${i})">
          <label class="port-sel" onclick="event.stopPropagation()" title="Incluir en el PDF"><input type="checkbox" data-pid="${esc(t.miembros.map(m => m.id).join(','))}" ${todos ? 'checked' : ''}></label>
          ${p.foto ? `<img class="port-img" data-mini="${esc(p.id)}" alt="">` : '<span class="port-img sin-foto">📦</span>'}
          <div class="port-txt"><b>${esc(t.base || p.nombre)}</b><small class="muted">${esc(t.miembros.map(m => m.id).join(', '))}</small>
          ${t.pres ? `<small class="port-pres">📦 ${esc(t.pres).replace(/\n/g, '<br>')}</small>` : ''}
          <small>${esc([p.lab, p.categoria].filter(Boolean).join(' · '))}</small>${p.especies ? `<small class="muted">🐾 ${esc(p.especies)}</small>` : ''}
          <div class="port-etq">${p.registro ? `<span class="etq">Reg. ${esc(p.registro)}</span>` : ''}${(t.miembros.find(m => m.ficha)) ? `<button class="etq ok" onclick="event.stopPropagation();App.verFicha('${esc(t.miembros.find(m => m.ficha).id)}')">📑 Ficha técnica</button>` : '<span class="etq av">Sin ficha</span>'}${t.miembros.some(m => m.activo) ? '' : '<span class="etq mal">Inactivo</span>'}</div></div></div>`; }).join('')}</div>`;
      activarMinis($('#pRes'));
    };
    $('#pRes').addEventListener('change', e => { const v = e.target.dataset && e.target.dataset.pid; if (!v) return; v.split(',').forEach(id => { if (e.target.checked) C.ids[id] = true; else delete C.ids[id]; }); e.target.closest('.port-card').classList.toggle('elegido', e.target.checked); cuenta(); });
    $('#pfMarcar').onclick = () => { (S.portTarj || []).slice(0, 300).forEach(t => t.miembros.forEach(p => C.ids[p.id] = true)); cuenta(); pintar(); };
    enlazarFiltros(pintar); enlazarFiltro('#pfFicha', pintar); enlazarFiltro('#pfElegidos', pintar); cuenta(); pintar();
  }
  async function verFicha(id) {
    try { const r = await pedir('archivos', { tipo: 'prodFicha', id: id }); const a = r.archivos || [], act = a.find(x => x.actual) || a[0];
      if (!act) return toast('Este producto aún no tiene ficha técnica', true); verArch('prodFicha', id, act.id); } catch (e) {}
  }
  /** Quita el fondo liso de la foto (relleno desde los bordes), recorta y la deja sobre blanco. Regresa JPG o '' si no conviene. */
  function quitarFondo(uri) {
    return new Promise(res => {
      const im = new Image();
      im.onerror = () => res('');
      im.onload = () => {
        try {
          const k = Math.min(1, 640 / Math.max(im.width, im.height)), w = Math.max(1, Math.round(im.width * k)), h = Math.max(1, Math.round(im.height * k));
          const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0, w, h);
          const d = x.getImageData(0, 0, w, h), px = d.data, N = w * h;
          // color de fondo: mediana de los bordes
          const borde = []; for (let i = 0; i < w; i++) { borde.push(i, (h - 1) * w + i); } for (let j = 0; j < h; j++) { borde.push(j * w, j * w + w - 1); }
          const med = ch => { const v = borde.map(q => px[q * 4 + ch]).sort((a, b) => a - b); return v[v.length >> 1]; };
          const bg = [med(0), med(1), med(2)];
          const dist = (q, r, g, b) => { const a = q * 4; return Math.hypot(px[a] - r, px[a + 1] - g, px[a + 2] - b); };
          const lisos = borde.filter(q => dist(q, bg[0], bg[1], bg[2]) < 40).length / borde.length;
          const fuera = new Uint8Array(N);
          if (lisos >= 0.6) {                    // fondo liso: se "inunda" desde los bordes
            const T = 42, pila = [];
            borde.forEach(q => { if (!fuera[q] && dist(q, bg[0], bg[1], bg[2]) < T) { fuera[q] = 1; pila.push(q); } });
            while (pila.length) {
              const q = pila.pop(), qx = q % w, a = q * 4;
              const vec = [qx > 0 ? q - 1 : -1, qx < w - 1 ? q + 1 : -1, q - w, q + w];
              for (const n of vec) {
                if (n < 0 || n >= N || fuera[n]) continue;
                const db = dist(n, bg[0], bg[1], bg[2]), dn = dist(n, px[a], px[a + 1], px[a + 2]);
                if (db < T || (dn < 9 && db < T * 1.9)) { fuera[n] = 1; pila.push(n); }   // sigue sombras y degradados suaves
              }
            }
          }
          let x0 = w, y0 = h, x1 = -1, y1 = -1, quedan = 0;
          for (let q = 0; q < N; q++) if (!fuera[q]) { quedan++; const qx = q % w, qy = (q / w) | 0; if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy; }
          if (quedan < N * 0.03 || x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; fuera.fill(0); }       // no se distinguió el producto: se deja completa
          for (let q = 0; q < N; q++) if (fuera[q]) { const a = q * 4; px[a] = px[a + 1] = px[a + 2] = 255; }
            else {                                   // borde suave: mezcla con blanco los pixeles pegados al fondo
              const qx = q % w; let f = 0; if (qx > 0 && fuera[q - 1]) f++; if (qx < w - 1 && fuera[q + 1]) f++; if (q >= w && fuera[q - w]) f++; if (q + w < N && fuera[q + w]) f++;
              if (f) { const a = q * 4, t = 0.18 * f; px[a] += (255 - px[a]) * t; px[a + 1] += (255 - px[a + 1]) * t; px[a + 2] += (255 - px[a + 2]) * t; }
            }
          x.putImageData(d, 0, 0);
          const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04), cw = x1 - x0 + 1 + 2 * m, chh = y1 - y0 + 1 + 2 * m;
          const s2 = Math.min(1, 420 / Math.max(cw, chh)), o = document.createElement('canvas'); o.width = Math.round(cw * s2); o.height = Math.round(chh * s2);
          const ox = o.getContext('2d'); ox.fillStyle = '#fff'; ox.fillRect(0, 0, o.width, o.height);
          ox.imageSmoothingQuality = 'high'; ox.drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, m * s2, m * s2, (x1 - x0 + 1) * s2, (y1 - y0 + 1) * s2);
          res(o.toDataURL('image/jpeg', 0.88));
        } catch (e) { res(''); }
      };
      im.src = uri;
    });
  }
  /** Prepara (una sola vez por foto) las imágenes sin fondo de los productos del PDF. */
  async function prepararSinFondo(ids, aviso) {
    let pend = [];
    for (let i = 0; i < ids.length; i += 300) { const r = await pedir('sinFondoPendientes', { ids: ids.slice(i, i + 300) }, true); pend = pend.concat(r.pendientes || []); }
    let hechos = 0;
    const uno = async id => {
      try { const f = await pedir('fotoProducto', { id: id }, true); if (f.uri && /^data:/.test(f.uri)) { const u = await quitarFondo(f.uri); if (u) await pedir('subirSinFondo', { id: id, dataUri: u }, true); } } catch (e) {}
      hechos++; aviso(hechos, pend.length);
    };
    const cola = pend.slice(); const trab = Array.from({ length: Math.min(3, cola.length) }, async () => { while (cola.length) await uno(cola.shift()); });
    await Promise.all(trab);
    return pend.length;
  }

  /* =====================================================================================
   *  DOCUMENTOS EN EL EQUIPO (sin conexión): PDF con jsPDF y Excel con ExcelJS.
   *  Las librerías se bajan una vez con señal y quedan guardadas en el equipo (IndexedDB).
   * ===================================================================================== */
  const CDN = 'https:' + '//cdnjs.cloudflare.com/ajax/libs/';
  const LIBS = {
    jspdf: { url: CDN + 'jspdf/2.5.1/jspdf.umd.min.js', ok: () => window.jspdf && window.jspdf.jsPDF ? window.jspdf : null },
    exceljs: { url: CDN + 'exceljs/4.4.0/exceljs.min.js', ok: () => window.ExcelJS || null }
  };
  async function textoLib(n) {
    const L = LIBS[n];
    try { const t = await fetch(L.url, { mode: 'cors' }).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }); if (t.length > 1000) { KV.set('lib_' + n, t); return t; } } catch (e) {}
    const g = await KV.get('lib_' + n); if (g) return g;
    throw new Error('Esta función necesita conexión la primera vez; ábrela una vez con señal');
  }
  function libLocal(n) {
    const L = LIBS[n], ya = L.ok(); if (ya) return Promise.resolve(ya);
    return L.p || (L.p = (async () => {
      const t = await textoLib(n);
      const sc = document.createElement('script'); sc.textContent = t; document.head.appendChild(sc);
      const r = L.ok(); if (!r) throw new Error('No se pudo cargar ' + n);
      return r;
    })().catch(e => { L.p = null; throw e; }));
  }
  /** Con señal: deja guardadas en el equipo las librerías que falten (sin cargarlas). */
  async function guardarLibs() {
    if (navigator.onLine === false || typeof indexedDB === 'undefined') return;
    for (const n of Object.keys(LIBS)) { try { if (!(await KV.get('lib_' + n))) await textoLib(n); } catch (e) {} }
    precargarVisor();
  }
  /** Imagen (logo / foto de sucursal) → { data PNG, w, h } para el PDF y el Excel. */
  function imgDatos(src) {
    return new Promise(res => {
      if (!src) return res(null);
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); res({ data: c.toDataURL('image/png'), w: c.width, h: c.height }); } catch (e) { res(null); } };
      im.onerror = () => res(null); im.src = src;
    });
  }
  async function logoDoc() { return S.logoDoc || (S.logoDoc = await imgDatos(window.LOGO)); }
  function fotoSucDatos(id) {
    const x = (D().sucursales || []).find(o => o.id === id); if (!x || !x.foto || esMatriz(id)) return Promise.resolve(null);
    const u = (LS.get('minisSucPng', {}) || {})[id] || (LS.get('minisSuc', {}) || {})[id] || ((S.minis || {}).sucFoto || {})[id];
    return imgDatos(u);
  }
  const txtPdf = s => String(s === null || s === undefined ? '' : s).replace(/[−–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/•/g, '·').replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '').trim();

  /**
   * PDF profesional a partir de una especificación:
   * { titulo, folio, fecha, extra:[líneas], suc:{id,nombre,direccion,tel,email}, izq:[líneas (1a en negritas)], der:[líneas],
   *   cols:[{t, w (fracción), num}], filas:[[celdas]], suma:[celdas] | null, totales:[[etiqueta, valor, negritas]], letras, notas:[líneas], firmas:[títulos], archivo }
   */
  async function pdfLocal(sp) {
    const { jsPDF } = await libLocal('jspdf');
    const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = 612, H = 792, M = 36, AN = W - 2 * M, VERDE = [31, 111, 74], GRIS = [92, 98, 88], LINEA = [214, 220, 210];
    const color = c => pdf.setTextColor(c[0], c[1], c[2]);
    const fuente = (t, n) => { pdf.setFont('helvetica', t || 'normal'); pdf.setFontSize(n || 9); };
    // --- encabezado
    let y = M, xLogo = M;
    const logo = await logoDoc(), fs = sp.suc && sp.suc.id ? await fotoSucDatos(sp.suc.id) : null;
    if (logo) { const h = 50, w = Math.min(170, h * logo.w / logo.h); pdf.addImage(logo.data, 'PNG', M, y, w, h); xLogo = M + w + 10; }
    if (fs) { const h = 46, w = Math.min(90, h * fs.w / fs.h); pdf.addImage(fs.data, 'PNG', xLogo, y + 2, w, h); }
    if (!logo) { fuente('bold', 16); color(VERDE); pdf.text('Interés Veterinario', M, y + 20); }
    let yl = y + 60; fuente('normal', 8); color(GRIS);
    const sucTxt = [sp.suc && sp.suc.nombre, sp.suc && sp.suc.direccion].filter(Boolean).join(' · ');
    if (sucTxt) { pdf.splitTextToSize(txtPdf(sucTxt), 300).forEach(l => { pdf.text(l, M, yl); yl += 10; }); }
    const contacto = [sp.suc && sp.suc.tel ? 'Tel. ' + sp.suc.tel : '', sp.suc && sp.suc.email].filter(Boolean).join(' · ');
    if (contacto) { pdf.text(txtPdf(contacto), M, yl); yl += 10; }
    let yr = y + 12; fuente('bold', 12); color(VERDE); pdf.text(txtPdf(sp.titulo), W - M, yr, { align: 'right' });
    yr += 18; fuente('bold', 16); color([27, 29, 24]); pdf.text(txtPdf(sp.folio || ''), W - M, yr, { align: 'right' });
    yr += 13; fuente('normal', 9); color(GRIS); if (sp.fecha) { pdf.text(txtPdf(sp.fecha), W - M, yr, { align: 'right' }); yr += 11; }
    fuente('normal', 8); (sp.extra || []).filter(Boolean).forEach(l => { pdf.text(txtPdf(l), W - M, yr, { align: 'right' }); yr += 10; });
    y = Math.max(yl, yr) + 4; pdf.setDrawColor(VERDE[0], VERDE[1], VERDE[2]); pdf.setLineWidth(1.2); pdf.line(M, y, W - M, y); y += 14;
    // --- bloques cliente / datos
    let y1 = y, y2 = y;
    (sp.izq || []).filter(Boolean).forEach((l, i) => { fuente(i ? 'normal' : 'bold', i ? 8.5 : 10.5); color(i ? GRIS : [27, 29, 24]); pdf.splitTextToSize(txtPdf(l), AN * 0.58).forEach(s => { pdf.text(s, M, y1); y1 += i ? 10.5 : 13; }); });
    fuente('normal', 8.5); color(GRIS);
    (sp.der || []).filter(Boolean).forEach(l => { pdf.splitTextToSize(txtPdf(l), AN * 0.4).forEach(s => { pdf.text(s, W - M, y2, { align: 'right' }); y2 += 10.5; }); });
    y = Math.max(y1, y2) + 6;
    // --- tabla
    const cols = sp.cols || [], tf = cols.reduce((a, c) => a + c.w, 0), anchos = cols.map(c => AN * c.w / tf);
    const encab = () => {
      pdf.setFillColor(243, 245, 242); pdf.setDrawColor(LINEA[0], LINEA[1], LINEA[2]); pdf.setLineWidth(0.6); pdf.rect(M, y, AN, 18, 'FD');
      fuente('bold', 8); color(GRIS); let x = M;
      cols.forEach((c, i) => { pdf.text(txtPdf(c.t), c.num ? x + anchos[i] - 4 : x + 4, y + 12, { align: c.num ? 'right' : 'left' }); x += anchos[i]; });
      y += 18;
    };
    const fila = (celdas, o) => {
      o = o || {}; fuente(o.bold ? 'bold' : 'normal', 8.5);
      const ls = celdas.map((v, i) => cols[i].num ? [txtPdf(v)] : pdf.splitTextToSize(txtPdf(v), anchos[i] - 8));
      const h = Math.max(...ls.map(l => l.length)) * 10.5 + 7;
      if (y + h > H - 54) { pdf.addPage(); y = M; encab(); fuente(o.bold ? 'bold' : 'normal', 8.5); }
      if (o.zebra) { pdf.setFillColor(250, 251, 249); pdf.rect(M, y, AN, h, 'F'); }
      if (o.suma) { pdf.setFillColor(237, 243, 239); pdf.rect(M, y, AN, h, 'F'); pdf.setDrawColor(150, 165, 150); pdf.setLineWidth(0.8); pdf.line(M, y, W - M, y); }
      color([27, 29, 24]); let x = M;
      ls.forEach((l, i) => { l.forEach((s, k) => pdf.text(s, cols[i].num ? x + anchos[i] - 4 : x + 4, y + 11 + k * 10.5, { align: cols[i].num ? 'right' : 'left' })); x += anchos[i]; });
      y += h; pdf.setDrawColor(LINEA[0], LINEA[1], LINEA[2]); pdf.setLineWidth(0.4); pdf.line(M, y, W - M, y);
    };
    if (cols.length) {
      encab(); (sp.filas || []).forEach((f, i) => fila(f, { zebra: i % 2 === 1 }));
      if (sp.suma) fila(sp.suma, { bold: true, suma: true });
      pdf.setDrawColor(LINEA[0], LINEA[1], LINEA[2]); pdf.setLineWidth(0.6); y += 8;
    }
    // --- totales (derecha) y letras (izquierda)
    const tot = (sp.totales || []).filter(Boolean);
    if (tot.length || sp.letras) {
      const altoTot = tot.length * 15 + 10; if (y + altoTot > H - 54) { pdf.addPage(); y = M; }
      let yt = y + 4; const xT = W - M - 230;
      tot.forEach(t => {
        if (t[2]) { pdf.setDrawColor(150, 165, 150); pdf.setLineWidth(0.8); pdf.line(xT, yt - 4, W - M, yt - 4); fuente('bold', 11.5); yt += 3; } else fuente('normal', 9);
        color(t[2] ? [27, 29, 24] : GRIS); pdf.text(txtPdf(t[0]), xT, yt + 7); color([27, 29, 24]); pdf.text(txtPdf(typeof t[1] === 'number' ? $$(t[1]) : t[1]), W - M, yt + 7, { align: 'right' }); yt += t[2] ? 18 : 15;
      });
      if (sp.letras) { fuente('italic', 8); color(GRIS); pdf.splitTextToSize('(' + txtPdf(sp.letras) + ')', AN - 250).forEach((s, k) => pdf.text(s, M, y + 11 + k * 10)); }
      y = Math.max(yt, y + 24) + 6;
    }
    // --- notas y firmas
    fuente('normal', 8); color(GRIS);
    (sp.notas || []).filter(Boolean).forEach(n => pdf.splitTextToSize(txtPdf(n), AN).forEach(s => { if (y > H - 60) { pdf.addPage(); y = M; } pdf.text(s, M, y); y += 10; }));
    const fir = (sp.firmas || []).filter(Boolean);
    if (fir.length) {
      y += 44; if (y > H - 70) { pdf.addPage(); y = M + 50; }
      const anc = AN / fir.length; pdf.setDrawColor(120, 125, 118); pdf.setLineWidth(0.6);
      fir.forEach((f, i) => { const cx = M + anc * i + anc / 2; pdf.line(cx - 90, y, cx + 90, y); fuente('normal', 8); color(GRIS); pdf.text(txtPdf(f), cx, y + 11, { align: 'center' }); });
    }
    // --- pie en cada página
    const n = pdf.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      pdf.setPage(i); fuente('normal', 7); color([140, 146, 136]);
      pdf.text(txtPdf('Interés Veterinario' + (sp.pie ? ' · ' + sp.pie : '')), M, H - 22); pdf.text('Página ' + i + ' de ' + n, W - M, H - 22, { align: 'right' });
    }
    pdf.setProperties({ title: txtPdf(sp.titulo + ' ' + (sp.folio || '')), author: 'Interés Veterinario' });
    return new Uint8Array(pdf.output('arraybuffer'));
  }

  /* ---- especificaciones por documento (a partir del mismo detalle que muestra la app) ---- */
  const nn = v => v === null || v === undefined ? '' : nf(v);
  const lineasImp = (ls, conLote, conDesc) => {
    const cols = [{ t: 'Cant.', w: 0.6, num: 1 }, { t: 'Producto', w: conLote ? 2.8 : 3.8 }].concat(conLote ? [{ t: 'Lote', w: 0.9 }, { t: 'Cad.', w: 1.05 }] : [])
      .concat([{ t: 'Precio unit.', w: 0.95, num: 1 }]).concat(conDesc ? [{ t: 'Descuento', w: 0.85, num: 1 }] : []).concat([{ t: 'Importe', w: 1, num: 1 }, { t: 'IVA $', w: 0.8, num: 1 }, { t: 'Total', w: 1, num: 1 }]);
    let sI = 0, sV = 0, sT = 0, sD = 0;
    const filas = ls.map(l => { sI += l.importe; sV += l.iva; sT += l.total; sD += l.desc || 0;
      return [nn(l.cant), l.nombre].concat(conLote ? [l.lote || '', l.cad || ''] : []).concat([$$(l.precio)]).concat(conDesc ? [l.desc ? '-' + $$(l.desc) : ''] : []).concat([$$(l.importe), $$(l.iva), $$(l.total)]); });
    const suma = ['', 'Suma de los productos'].concat(conLote ? ['', ''] : []).concat(['']).concat(conDesc ? [sD ? '-' + $$(sD) : ''] : []).concat([$$(sI), $$(sV), $$(sT)]);
    return { cols: cols, filas: filas, suma: ls.length ? suma : null };
  };
  const r2c = n => Math.round((Number(n) || 0) * 100) / 100;
  const sucDoc = s => s ? { id: s.id, nombre: s.nombre, direccion: s.direccion, tel: s.tel, email: s.email } : null;
  const sucDe = id => { const x = (D().sucursales || []).find(o => o.id === id) || {}; return { id: id, nombre: x.nombre || sucNom(id), direccion: x.direccion, tel: x.tel, email: x.email }; };
  const fiscalTxt = f => f ? [f.cp ? 'C.P. ' + f.cp : '', f.regimen ? 'Régimen ' + f.regimen : '', f.uso ? 'Uso CFDI ' + f.uso : ''].filter(Boolean).join(' · ') : '';
  const DOC_LOCAL = {
    pdfNota: { det: p => ['detalleVenta', { ID_Venta: p.ID_Venta }], ult: 'ultimaVenta', key: p => p.ID_Venta, map: d => {
      const ls = d.lineas.filter(l => l.cant > 0).map(l => { const imp = r2c((l.sub !== undefined && l.sub !== null ? l.sub : l.cant * l.precio) - (l.desc || 0)); const iva = l.iva !== undefined && l.iva !== null ? l.iva : Math.max(0, r2c((l.total || 0) - imp));
        return { cant: l.cant, nombre: l.nombre, lote: l.lote, cad: l.cad, precio: l.precio, importe: imp, iva: iva, total: l.total !== undefined ? l.total : r2c(imp + iva) }; });
      const t = lineasImp(ls, true, false);
      return Object.assign(t, { titulo: 'NOTA DE VENTA', folio: d.folio, fecha: d.fecha, extra: (d.facturas || []).map(f => 'Factura ' + f.sf + (f.uuid ? ' · ' + f.uuid : '')).concat(d.estatus ? [d.estatus === 'Pendiente' ? 'Pendiente de entrega' : d.estatus] : []),
        suc: sucDoc(d.sucursal), izq: [d.razon || d.cliente, d.razon && d.razon !== d.cliente ? d.cliente : '', d.rfc ? 'RFC ' + d.rfc : '', d.domicilio, fiscalTxt(d.fiscal)],
        der: ['Crédito: ' + (d.dias || 0) + ' días' + (d.venc ? ' · Vence ' + d.venc : ''), 'Vendedor: ' + (d.vendedor || ''), 'Envío: ' + (d.envio || 'Entrega física') + (d.guia ? ' · Guía ' + d.guia : '')],
        totales: [['Subtotal', d.sub], d.desc ? ['Descuento', '-' + $$(d.desc)] : null, d.descPC ? ['Pronto pago', '-' + $$(d.descPC)] : null, ['IVA (suma de los productos)', d.iva], d.flete ? ['Flete', d.flete] : null,
          ['Total', d.total, true], ['Pagado', d.cobrado || 0], ['Saldo', d.saldo || 0]],
        letras: d.letras, notas: [d.comentarios], firmas: ['Recibí de conformidad'], archivo: 'Nota ' + d.folio + ' ' + (d.razon || d.cliente || '') }); } },
    pdfCotizacion: { det: p => ['detalleCotizacion', { id: p.id }], ult: 'ultimaCot', key: p => p.id, map: d => {
      const ls = d.lineas.map(l => ({ cant: l.cant, nombre: l.nombre + (l.unidad ? ' (' + l.unidad + ')' : ''), lote: l.lote, cad: l.cad, precio: l.precioLista, desc: l.desc, importe: l.importe, iva: l.ivaMonto, total: l.total }));
      const t = lineasImp(ls, ls.some(l => l.lote || l.cad), ls.some(l => l.desc));
      return Object.assign(t, { titulo: 'COTIZACIÓN', folio: d.folio, fecha: d.fecha, extra: [d.vigencia ? 'Vigente hasta ' + d.vigencia : ''], suc: sucDoc(d.sucursal),
        izq: [d.razon || d.cliente, d.razon && d.razon !== d.cliente ? d.cliente : '', d.rfc ? 'RFC ' + d.rfc : '', d.domicilio, fiscalTxt(d.fiscal)], der: ['Atendió: ' + (d.vendedor || '')],
        totales: [['Subtotal', d.sub], d.desc ? ['Descuento', '-' + $$(d.desc)] : null, ['IVA (suma de los productos)', d.iva], ['Total', d.total, true]], letras: d.letras,
        notas: [d.obs, 'Cotización válida por ' + (d.vigenciaDias || 15) + ' días' + (d.vigencia ? ' (hasta el ' + d.vigencia + ')' : '') + '. Precios en pesos mexicanos; sujetos a existencias y a cambio sin previo aviso después de la vigencia.'],
        archivo: 'Cotizacion ' + d.folio + ' ' + (d.razon || d.cliente || '') }); } },
    pdfTraspaso: { det: p => ['detalleTraspaso', { folio: p.folio }], ult: 'trDet', key: p => p.folio, map: d => {
      const imp = d.total !== null && d.total !== undefined;
      let t;
      if (imp) t = lineasImp(d.lineas.map(l => { const im = r2c(l.cant * (l.precio || 0)); return { cant: l.cant, nombre: l.nombre, lote: l.lote, cad: l.cad, precio: l.precio || 0, importe: im, iva: l.iva || 0, total: r2c(im + (l.iva || 0)) }; }), true, false);
      else t = { cols: [{ t: 'Cant.', w: 0.7, num: 1 }, { t: 'Producto', w: 4 }, { t: 'Lote', w: 1.1 }, { t: 'Caducidad', w: 1 }], filas: d.lineas.map(l => [nn(l.cant), l.nombre, l.lote || '', l.cad || '']),
        suma: ['' + nf(d.lineas.reduce((a, l) => a + l.cant, 0)), 'Piezas', '', ''] };
      const sub = imp ? d.lineas.reduce((a, l) => a + r2c(l.cant * (l.precio || 0)), 0) : 0, iva = imp ? d.lineas.reduce((a, l) => a + (l.iva || 0), 0) : 0;
      return Object.assign(t, { titulo: 'TRASPASO', folio: d.folio, fecha: d.fecha + (d.hora ? ' ' + d.hora : ''), suc: sucDe(d.origen),
        izq: ['De ' + (d.origenNombre || sucNom(d.origen)) + ' a ' + (d.destinoNombre || sucNom(d.destino)), d.responsable ? 'Responsable: ' + d.responsable : ''],
        der: [d.envio ? 'Envío: ' + d.envio : '', d.guia ? 'Guía ' + d.guia : '', d.recibio ? 'Recibió: ' + d.recibio : ''],
        totales: imp ? [['Subtotal', r2c(sub)], ['IVA (suma de los productos)', r2c(iva)], d.flete ? ['Flete', d.flete] : null, ['Total', r2c(sub + iva + (d.flete || 0)), true]] : [],
        notas: [d.comentarios], firmas: ['Entrega', 'Recibe'], archivo: 'Traspaso ' + d.folio }); } },
    pdfRequisicion: { det: p => ['detalleRequisicion', { id: p.id }], ult: 'ultimaReq', key: p => p.id, map: d => {
      const imp = !!d.importes;
      const t = { cols: [{ t: 'Solicitado', w: 0.9, num: 1 }, { t: 'Surtido', w: 0.8, num: 1 }, { t: 'Producto', w: 3.6 }, { t: 'Laboratorio', w: 1.3 }].concat(imp ? [{ t: 'Importe', w: 1, num: 1 }, { t: 'IVA $', w: 0.8, num: 1 }, { t: 'Total', w: 1, num: 1 }] : []),
        filas: d.lineas.map(l => [nn(l.cant), nn(l.surtido || 0), l.nombre + (l.unidad ? ' (' + l.unidad + ')' : ''), l.lab || ''].concat(imp ? [$$(l.importe), $$(l.iva), $$(r2c(l.importe + l.iva))] : [])) };
      t.suma = [nf(d.lineas.reduce((a, l) => a + l.cant, 0)), nf(d.lineas.reduce((a, l) => a + (l.surtido || 0), 0)), 'Suma de los productos', ''].concat(imp ? [$$(d.importes.sub), $$(d.importes.iva), $$(d.importes.total)] : []);
      return Object.assign(t, { titulo: 'REQUISICIÓN DE TRASPASO', folio: d.folio, fecha: d.fecha + (d.hora ? ' ' + d.hora : ''), extra: [d.estado, d.requerida ? 'Se requiere para el ' + d.requerida : ''], suc: sucDe(d.solicita),
        izq: ['Solicita: ' + (d.solicitaNombre || ''), 'Surte: ' + (d.surteNombre || ''), d.solicito ? 'Pidió: ' + d.solicito : ''],
        totales: imp ? [['Subtotal', d.importes.sub], ['IVA (suma de los productos)', d.importes.iva], ['Valor de la requisición', d.importes.total, true]] : [],
        notas: [d.comentarios], firmas: ['Solicita', 'Surte'], archivo: 'Requisicion ' + d.folio }); } },
    pdfCompra: { det: p => ['detalleCompra', { ID_O_Compra: p.ID_O_Compra }], ult: 'ultimaCompra', key: p => p.ID_O_Compra, map: (d, prm) => {
      if (!prm.conCostos) {   // versión para el proveedor: sin costos
        const pz = d.lineas.reduce((a, l) => a + l.cant, 0);
        return { titulo: 'ORDEN DE COMPRA', folio: d.folio, fecha: d.fecha, extra: [d.factura ? 'Factura ' + d.factura : ''], suc: sucDe(d.suc),
          izq: (p => ['Proveedor: ' + p.nombre, p.comercial, p.rfc ? 'RFC ' + p.rfc : '', [p.dom, p.cp ? 'C.P. ' + p.cp : ''].filter(Boolean).join(' · '), [p.tels, p.email].filter(Boolean).join(' · '), p.contacto ? 'Contacto de ventas: ' + p.contacto : ''])(lineasProv(d.prov, d)),
          der: ['Entregar en: ' + sucNom(d.suc), sucDe(d.suc).direccion || '', lineasProv(d.prov, d).cred],
          cols: [{ t: 'Cantidad', w: 0.9, num: 1 }, { t: 'Clave', w: 1.1 }, { t: 'Producto', w: 4 }, { t: 'Categoría', w: 1.6 }],
          filas: d.lineas.map(l => [nn(l.cant), l.prod || '', l.nombre, l.cat || ((prod(l.prod) || {}).categoria || '')]),
          suma: [nf(pz), '', 'Total de piezas · ' + d.lineas.length + ' producto(s)', ''], totales: [], notas: [d.obs], firmas: ['Elaboró', 'Recibió (proveedor)'], archivo: 'Orden de compra ' + d.folio };
      }
      const ls = d.lineas.map(l => ({ cant: l.cant, nombre: l.nombre, lote: l.lote, cad: l.cad, precio: l.precio, desc: l.desc, importe: r2c((l.sub || l.cant * l.precio) - (l.desc || 0)), iva: l.iva || 0, total: l.total }));
      const t = lineasImp(ls, ls.some(l => l.lote || l.cad), ls.some(l => l.desc));
      return Object.assign(t, { titulo: 'ORDEN DE COMPRA', folio: d.folio, fecha: d.fecha, extra: [d.factura ? 'Factura ' + d.factura : '', d.uuid ? 'Folio fiscal: ' + d.uuid : ''], suc: sucDe(d.suc),
        izq: (p => ['Proveedor: ' + p.nombre, p.comercial, p.rfc ? 'RFC ' + p.rfc : '', p.regimen ? 'Régimen fiscal: ' + p.regimen : '', [p.dom, p.cp ? 'C.P. ' + p.cp : ''].filter(Boolean).join(' · '),
          [p.tels, p.email].filter(Boolean).join(' · '), p.contacto ? 'Contacto de ventas: ' + p.contacto : ''])(lineasProv(d.prov, d)),
        der: ['Entregar en: ' + sucNom(d.suc), sucDe(d.suc).direccion || '', lineasProv(d.prov, d).cred + (d.venc ? ' · Vence ' + d.venc : ''), String(d.recibido).toUpperCase() === 'SI' ? 'Recibida' : 'Pendiente de recibir'],
        totales: [['Subtotal', d.sub], d.descEsp ? ['Descuento especial', '-' + $$(d.descEsp)] : null, d.descPP ? ['Descuento pronto pago', '-' + $$(d.descPP)] : null, ['IVA (suma de los productos)', d.iva],
          d.flete ? ['Flete', d.flete] : null, ['Total', d.total, true], ['Pagado', d.pagado || 0], ['Saldo', d.saldo || 0]], letras: d.letras, notas: [d.obs], firmas: ['Elaboró', 'Recibió'], archivo: 'Orden de compra ' + d.folio }); } },
    pdfDevolucion: { det: p => ['detalleDevolucion', { id: p.id }], ult: 'ultimaDev', key: p => p.id, map: d => {
      const ver = d.total !== null;
      const t = ver ? lineasImp(d.lineas.map(l => ({ cant: l.cant, nombre: l.nombre, lote: l.lote, cad: l.cad, precio: l.precio, desc: l.desc, importe: r2c(l.sub - (l.desc || 0)), iva: l.iva, total: l.total })), true, d.lineas.some(l => l.desc))
        : { cols: [{ t: 'Cant.', w: 0.7, num: 1 }, { t: 'Producto', w: 4 }, { t: 'Lote', w: 1.1 }, { t: 'Caducidad', w: 1 }], filas: d.lineas.map(l => [nn(l.cant), l.nombre, l.lote || '', l.cad || '']) };
      return Object.assign(t, { titulo: 'DEVOLUCIÓN', folio: d.folio, fecha: d.fecha + (d.hora ? ' ' + d.hora : ''), extra: ['Nota de venta ' + d.nota], suc: sucDoc(d.sucursal),
        izq: [d.cliente, d.rfc ? 'RFC ' + d.rfc : '', d.domicilio, 'Motivo: ' + (d.motivo || '')], der: [d.facturas ? 'Factura: ' + d.facturas : 'Nota sin factura', d.docTipo || '', d.uuid ? 'Folio fiscal: ' + d.uuid : ''],
        totales: ver ? [['Subtotal', d.sub], d.desc ? ['Descuentos', '-' + $$(d.desc)] : null, ['IVA (suma de los productos)', d.iva], d.flete ? ['Flete', d.flete] : null, ['Total devuelto', d.total, true], d.reembolso ? ['Reembolso', d.reembolso] : null] : [],
        notas: [d.reembolsoForma ? 'Forma de reembolso: ' + d.reembolsoForma : '', 'Las ' + nf(d.piezas) + ' piezas devueltas regresaron al inventario.'], firmas: ['Entrega (cliente)', 'Recibe'], archivo: 'Devolucion ' + d.folio }); } },
    pdfCobro: { det: p => ['detalleCobro', { ID_Cobranza: p.ID_Cobranza }], ult: 'ultimoCobro', key: p => p.ID_Cobranza, map: d => ({
      titulo: 'COMPROBANTE DE PAGO', folio: d.folio, fecha: d.fecha, suc: sucDoc(d.sucursal), izq: ['Recibimos de: ' + (d.razon || d.cliente), d.rfc ? 'RFC ' + d.rfc : ''], der: ['La cantidad de ' + $$(d.monto)],
      cols: [{ t: 'Concepto', w: 3.2 }, { t: 'Forma de pago', w: 1.4 }, { t: 'Banco / cuenta', w: 1.4 }, { t: 'Importe', w: 1, num: 1 }],
      filas: [['Pago ' + (d.totalPagos > 1 ? d.numPago + ' de ' + d.totalPagos + ' ' : '') + 'a la nota de venta ' + d.folioNota + (d.fechaNota ? ' del ' + d.fechaNota : '') + (d.nota ? '. ' + d.nota : ''), d.forma || '', d.banco || '', $$(d.monto)]],
      totales: [['Importe pagado', d.monto, true], d.saldoDespues !== undefined ? ['Saldo de la nota', Math.max(0, d.saldoDespues || 0)] : null], letras: d.letras, firmas: ['Recibió'], archivo: 'Comprobante ' + d.folio }) }
  };
  /** PDF sin conexión: se arma en el equipo con los datos que ya tiene (lo que se ve en pantalla o la última copia guardada). */
  async function pdfSinConexion(accion, params, info, aviso) {
    const L = DOC_LOCAL[accion]; if (!L) return toast('Este PDF necesita conexión', true);
    cargando(true);
    try {
      const k = L.key(params), u = S[L.ult];
      let d = u && k && (u.id === k || u.folio === k) ? u : null;
      if (!d) { const [a, p] = L.det(params); d = await call(a, p); }
      const sp = L.map(d, params || {}); sp.pie = aviso === false ? '' : 'Generado en el equipo';
      const bytes = await pdfLocal(sp);
      verPdf(bytes, sp.archivo, { texto: info && info.texto, cel: info && info.cel });
      if (aviso !== false) toast('📄 PDF hecho en el equipo, sin conexión. Compártelo con 📤');
    } catch (e) { toast(e.red ? 'No hay una copia guardada de este documento en el equipo (ábrelo una vez con señal)' : (e.message || 'No se pudo hacer el PDF'), true); }
    finally { cargando(false); }
  }
  /** PDF de un documento que solo existe en el equipo (venta o cotización capturada sin señal). */
  async function pdfDeDatos(tipo, d) {
    cargando(true);
    try { const sp = DOC_LOCAL[tipo].map(d); sp.pie = 'Folio provisional: se asigna al sincronizar'; verPdf(await pdfLocal(sp), sp.archivo); }
    catch (e) { toast(e.message || 'No se pudo hacer el PDF', true); } finally { cargando(false); }
  }

  /* ---------------- EXCEL con diseño profesional ---------------- */
  /**
   * hojas: [{ nombre, titulo, sub:[líneas], resumen:[[etiqueta, valor, fmt]], cols:[{t, w, fmt:'txt'|'num'|'mon'|'fecha', suma}], filas:[{v:[...], tono:'mal'|'av'|'ok'|'gris'}] }]
   */
  async function excelLocal(archivo, hojas) {
    const ExcelJS = await libLocal('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Interés Veterinario'; wb.created = new Date();
    const logo = await logoDoc(); const idLogo = logo ? wb.addImage({ base64: logo.data, extension: 'png' }) : null;
    const VERDE = 'FF1F6F4A', CLARO = 'FFEFF5F1', BORDE = { style: 'thin', color: { argb: 'FFD5DDD6' } };
    const TONO = { mal: { font: 'FFB3261E', fill: 'FFFCE8E6' }, av: { font: 'FF8A5A00', fill: 'FFFFF4D6' }, ok: { font: 'FF1F6F4A' }, gris: { font: 'FF8A918C' } };
    const FMT = { num: '#,##0.##;[Red]-#,##0.##', mon: '"$"#,##0.00;[Red]-"$"#,##0.00', fecha: 'dd/mm/yyyy' };
    hojas.forEach(h => {
      const ws = wb.addWorksheet(h.nombre.slice(0, 31), { views: [{ showGridLines: false }], properties: { tabColor: { argb: VERDE } } });
      const nc = h.cols.length, ultCol = ws.getColumn(nc).letter;
      h.cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.w || 14; });
      // encabezado con logo
      ws.getRow(1).height = 30; ws.getRow(2).height = 18; ws.getRow(3).height = 16;
      if (idLogo !== null) ws.addImage(idLogo, { tl: { col: 0.1, row: 0.15 }, ext: { width: Math.round(46 * logo.w / logo.h), height: 46 } });
      const c0 = nc >= 4 ? 3 : 1;
      ws.mergeCells(1, c0, 1, nc); const t = ws.getCell(1, c0); t.value = h.titulo; t.font = { name: 'Calibri', size: 16, bold: true, color: { argb: VERDE } }; t.alignment = { vertical: 'middle' };
      ws.mergeCells(2, c0, 2, nc); const s = ws.getCell(2, c0); s.value = (h.sub || [])[0] || ''; s.font = { size: 10, color: { argb: 'FF5C6258' } };
      ws.mergeCells(3, c0, 3, nc); const s2 = ws.getCell(3, c0); s2.value = (h.sub || []).slice(1).join('  ·  '); s2.font = { size: 9, italic: true, color: { argb: 'FF8A918C' } };
      let r = 5;
      // resumen: dos datos por renglón, cada uno en una celda combinada "Etiqueta  valor"
      if (h.resumen && h.resumen.length) {
        const mitad = Math.max(1, Math.floor(nc / 2));
        for (let i = 0; i < h.resumen.length; i += 2) {
          [h.resumen[i], h.resumen[i + 1]].forEach((x, j) => { if (!x) return;
            const c1 = j ? mitad + 1 : 1, c2 = j ? nc : mitad; if (c2 > c1) ws.mergeCells(r, c1, r, c2);
            const cell = ws.getCell(r, c1), val = x[2] === 'mon' ? $$(x[1]) : x[2] === 'num' ? nf(x[1]) : String(x[1] === null || x[1] === undefined ? '' : x[1]);
            cell.value = { richText: [{ text: x[0] + ':  ', font: { size: 10, color: { argb: 'FF5C6258' } } }, { text: val, font: { size: 10, bold: true, color: { argb: 'FF1B1D18' } } }] };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLARO } }; cell.border = { top: BORDE, bottom: BORDE, left: BORDE, right: BORDE }; cell.alignment = { vertical: 'middle', indent: 1 }; });
          ws.getRow(r).height = 18; r++;
        }
        r++;
      }
      const filaEnc = r;
      const he = ws.getRow(r); he.values = h.cols.map(c => c.t); he.height = 30;
      he.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERDE } };
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; c.border = { top: BORDE, bottom: BORDE, left: BORDE, right: BORDE }; });
      r++;
      const ini = r;
      h.filas.forEach((f, i) => {
        const row = ws.getRow(r); row.values = f.v;
        row.eachCell({ includeEmpty: true }, (c, j) => { const col = h.cols[j - 1]; if (!col) return;
          c.border = { top: BORDE, bottom: BORDE, left: BORDE, right: BORDE }; c.font = { size: 10, color: f.tono && TONO[f.tono] ? { argb: TONO[f.tono].font } : undefined, italic: f.tono === 'gris' };
          if (f.tono && TONO[f.tono] && TONO[f.tono].fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TONO[f.tono].fill } };
          else if (i % 2) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAF8' } };
          if (FMT[col.fmt]) c.numFmt = FMT[col.fmt];
          c.alignment = { vertical: 'top', horizontal: col.fmt === 'num' || col.fmt === 'mon' ? 'right' : col.fmt === 'fecha' ? 'center' : 'left', wrapText: col.fmt === 'txt' || !col.fmt }; });
        r++;
      });
      const fin = r - 1;
      if (h.cols.some(c => c.suma) && h.filas.length) {
        const row = ws.getRow(r);
        h.cols.forEach((c, i) => { const cell = row.getCell(i + 1);
          if (c.suma) { const L = ws.getColumn(i + 1).letter; cell.value = { formula: `SUBTOTAL(9,${L}${ini}:${L}${fin})`, result: h.filas.reduce((a, f) => a + (Number(f.v[i]) || 0), 0) }; cell.numFmt = FMT[c.fmt] || FMT.num; cell.alignment = { horizontal: 'right' }; }
          cell.font = { bold: true, size: 10 }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEBE2' } }; cell.border = { top: { style: 'medium', color: { argb: VERDE } }, bottom: BORDE }; });
        row.getCell(1).value = 'Totales'; r++;
      }
      ws.autoFilter = { from: { row: filaEnc, column: 1 }, to: { row: Math.max(filaEnc, fin), column: nc } };
      ws.views = [{ state: 'frozen', ySplit: filaEnc, showGridLines: false }];
      ws.pageSetup = { orientation: nc > 7 ? 'landscape' : 'portrait', paperSize: 1, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: filaEnc + ':' + filaEnc,
        margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } };
      ws.headerFooter = { oddFooter: '&L&8Interés Veterinario&C&8' + String(h.titulo).replace(/&/g, '&&') + '&R&8Página &P de &N' };
      r += 1; ws.getCell(r, 1).value = 'Generado el ' + new Date().toLocaleString('es-MX') + ' · ' + (U().nombre || ''); ws.getCell(r, 1).font = { size: 8, italic: true, color: { argb: 'FF8A918C' } };
    });
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  /** Entrega un archivo hecho en el equipo: ventana con Compartir (WhatsApp, correo, Archivos) y Descargar. */
  function entregarArchivo(blob, nombre, que) {
    S.archivoListo = { blob: blob, nombre: nombre };
    const comp = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File([blob], nombre, { type: blob.type })] }));
    modal(que || 'Archivo listo', `<p>📊 <b>${esc(nombre)}</b> · ${tamTxt(blob.size)}</p>
      <p class="muted">${comp ? 'Toca <b>Compartir</b> para mandarlo por WhatsApp o correo a tus sucursales, o guárdalo en Archivos.' : 'Descárgalo y envíalo por WhatsApp o correo a tus sucursales.'}</p>
      <div class="acciones" style="justify-content:flex-start">${comp ? '<button class="btn primario" onclick="App.compartirArchivo()">📤 Compartir</button>' : ''}
        <a class="btn ${comp ? '' : 'primario'}" href="${URL.createObjectURL(blob)}" download="${esc(nombre)}">⬇️ Descargar</a><button class="btn" onclick="App.cerrarModal()">Cerrar</button></div>`);
  }
  async function compartirArchivo() {
    const x = S.archivoListo; if (!x) return;
    try { await navigator.share({ files: [new File([x.blob], x.nombre, { type: x.blob.type })], title: x.nombre }); } catch (e) { if (e && e.name !== 'AbortError') toast('No se pudo compartir; usa Descargar', true); }
  }
  const fechaXl = s => { const f = fechaDe(s); return f && !isNaN(f) ? f : (s || ''); };
  const hoyTxt = () => new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' });
  /** Inventario (con los filtros de la pantalla): existencias por producto y lotes con caducidad. */
  async function excelInventario() {
    cargando(true);
    try {
      const suc = $('#ieSuc') ? $('#ieSuc').value : '', txt = $('#ieTxt') ? $('#ieTxt').value : '', cat = $('#ieCat') ? $('#ieCat').value : '', min = $('#ieMin') && $('#ieMin').checked;
      const verC = puede('ver_costos'), hoyD = new Date(); hoyD.setHours(0, 0, 0, 0);
      const ok = p => (!txt || coincide(p.id + ' ' + p.nombre + ' ' + p.lab, txt)) && (!cat || p.categoria === cat);
      const g = {}, lotes = [];
      (D().stock || []).forEach(s => {
        if (suc && s.s !== suc) return; const p = prod(s.p) || { id: s.p, nombre: s.p }; if (!ok(p) || Math.abs(s.q) < 0.0001) return;
        const k = s.p + '|' + s.s; if (!g[k]) g[k] = { p: p, s: s.s, q: 0, lotes: 0, cad: null };
        g[k].q += s.q; const f = fechaDe(s.c); if (s.q > 0) { g[k].lotes++; if (f && (!g[k].cad || f < g[k].cad)) g[k].cad = f; }
        lotes.push({ s: s, p: p, f: f });
      });
      let ex = Object.values(g).filter(x => !min || x.q < (x.p.min || 0)).sort((a, b) => sucNom(a.s).localeCompare(sucNom(b.s)) || String(a.p.nombre).localeCompare(b.p.nombre));
      const varias = !suc && new Set(ex.map(x => x.s)).size > 1;
      const colsE = [{ t: 'Clave', w: 13 }, { t: 'Producto', w: 42 }, { t: 'Laboratorio', w: 18 }, { t: 'Categoría', w: 16 }].concat(varias ? [{ t: 'Sucursal', w: 16 }] : [])
        .concat([{ t: 'Lotes', w: 8, fmt: 'num' }, { t: 'Próx. caducidad', w: 14, fmt: 'fecha' }, { t: 'Existencia', w: 12, fmt: 'num', suma: 1 }, { t: 'Mínimo', w: 10, fmt: 'num' }, { t: 'Estado', w: 16 }])
        .concat(verC ? [{ t: U().costoLista ? 'Costo lista' : 'Costo', w: 13, fmt: 'mon' }, { t: 'Valor', w: 15, fmt: 'mon', suma: 1 }] : []);
      const filasE = ex.map(x => { const est = x.q <= 0 ? 'Sin existencia' : x.p.min && x.q < x.p.min ? 'Bajo mínimo' : 'OK';
        return { tono: x.q <= 0 ? 'mal' : est === 'Bajo mínimo' ? 'av' : '', v: [x.p.id, x.p.nombre, x.p.lab || '', x.p.categoria || ''].concat(varias ? [sucNom(x.s)] : [])
          .concat([x.lotes, x.cad || '', r2c(x.q), x.p.min || 0, est]).concat(verC ? [x.p.costo || 0, r2c(x.q * (x.p.costo || 0))] : []) }; });
      const lt = lotes.filter(x => x.s.q > 0 && (!min || (g[x.s.p + '|' + x.s.s] && g[x.s.p + '|' + x.s.s].q < (x.p.min || 0))))
        .sort((a, b) => (a.f || 9e15) - (b.f || 9e15) || String(a.p.nombre).localeCompare(b.p.nombre));
      const colsL = (varias ? [{ t: 'Sucursal', w: 16 }] : []).concat([{ t: 'Clave', w: 13 }, { t: 'Producto', w: 42 }, { t: 'Lote', w: 14 }, { t: 'Caducidad', w: 13, fmt: 'fecha' }, { t: 'Días para caducar', w: 11, fmt: 'num' },
        { t: 'Piezas', w: 10, fmt: 'num', suma: 1 }, { t: 'Estado', w: 18 }]).concat(verC ? [{ t: 'Valor', w: 15, fmt: 'mon', suma: 1 }] : []);
      const filasL = lt.map(x => { const dias = x.f ? Math.round((x.f - hoyD) / 86400000) : null;
        const est = dias === null ? 'Sin caducidad' : dias < 0 ? 'Caducado' : dias <= 90 ? 'Por caducar (90 días)' : dias <= 180 ? 'Vigilar (180 días)' : 'Vigente';
        return { tono: dias === null ? 'gris' : dias < 0 ? 'mal' : dias <= 90 ? 'av' : '', v: (varias ? [sucNom(x.s.s)] : []).concat([x.p.id, x.p.nombre, x.s.l || '', x.f || x.s.c || '', dias === null ? '' : dias, r2c(x.s.q), est])
          .concat(verC ? [r2c(x.s.q * (x.p.costo || 0))] : []) }; });
      const donde = suc ? sucNom(suc) : 'Todas las sucursales', filtro = [txt ? 'Búsqueda: ' + txt : '', cat ? 'Categoría: ' + cat : '', min ? 'Solo bajo mínimo' : ''].filter(Boolean).join(' · ');
      const pzs = ex.reduce((a, x) => a + x.q, 0), val = verC ? ex.reduce((a, x) => a + x.q * (x.p.costo || 0), 0) : null;
      const resumen = [['Productos', ex.length, 'num'], ['Piezas en existencia', r2c(pzs), 'num'], ['Bajo mínimo', ex.filter(x => x.q > 0 && x.p.min && x.q < x.p.min).length, 'num'],
        ['Lotes caducados', filasL.filter(f => f.tono === 'mal').length, 'num']].concat(verC ? [['Valor del inventario' + (U().costoLista ? ' (costo de lista)' : ''), r2c(val), 'mon']] : []);
      const blob = await excelLocal('', [
        { nombre: 'Existencias', titulo: 'Inventario · ' + donde, sub: ['Existencias al ' + hoyTxt(), filtro], resumen: resumen, cols: colsE, filas: filasE },
        { nombre: 'Lotes y caducidades', titulo: 'Lotes y caducidades · ' + donde, sub: ['Al ' + hoyTxt() + ' · ordenado por caducidad', filtro], cols: colsL, filas: filasL }]);
      entregarArchivo(blob, 'Inventario ' + donde.replace(/[\\/:*?"<>|]+/g, '-') + ' ' + hoyISO() + '.xlsx', 'Inventario en Excel');
    } catch (e) { toast(e.message || 'No se pudo hacer el Excel', true); } finally { cargando(false); }
  }
  /** Conteo físico: resumen + renglones con sistema, físico y diferencia. */
  async function excelConteo() {
    const d = S.cto; if (!d) return;
    cargando(true);
    try {
      const verC = d.lineas.some(l => l.costo !== null && l.costo !== undefined) || (d.resumen && d.resumen.faltVal !== null && d.resumen.faltVal !== undefined);
      const abierto = d.estatus === 'Abierto', r = d.resumen || {};
      const cols = [{ t: 'Clave', w: 13 }, { t: 'Producto', w: 40 }, { t: 'Laboratorio', w: 16 }, { t: 'Categoría', w: 15 }, { t: 'Lote', w: 13 }, { t: 'Caducidad', w: 12 },
        { t: 'Sistema', w: 10, fmt: 'num', suma: 1 }, { t: 'Físico', w: 10, fmt: 'num', suma: 1 }, { t: 'Diferencia', w: 11, fmt: 'num', suma: 1 }]
        .concat(verC ? [{ t: 'Costo', w: 12, fmt: 'mon' }, { t: 'Valor diferencia', w: 15, fmt: 'mon', suma: 1 }] : []).concat([{ t: 'Estado', w: 14 }, { t: 'Nota', w: 26 }]);
      const filas = d.lineas.slice().sort((a, b) => String(a.nombre).localeCompare(b.nombre)).map(l => {
        const dif = l.dif !== null && l.dif !== undefined ? l.dif : (l.fisico !== null && l.fisico !== undefined ? r2c(l.fisico - l.ini) : null);
        const est = l.fisico === null || l.fisico === undefined ? 'Sin contar' : dif < 0 ? 'Faltante' : dif > 0 ? 'Sobrante' : 'Coincide';
        return { tono: est === 'Sin contar' ? 'gris' : est === 'Faltante' ? 'mal' : est === 'Sobrante' ? 'av' : 'ok',
          v: [l.prod, l.nombre, l.lab || '', l.cat || '', l.lote || '', fechaXl(l.cad), l.ini, l.fisico === null || l.fisico === undefined ? '' : l.fisico, dif === null ? '' : dif]
            .concat(verC ? [l.costo || 0, l.valor !== null && l.valor !== undefined ? l.valor : (dif === null ? '' : r2c(dif * (l.costo || 0)))] : []).concat([est + (l.agregado ? ' (encontrado)' : ''), l.nota || '']) }; });
      // en un conteo abierto el resumen se calcula con lo capturado hasta ahora
      const cnt = d.lineas.filter(l => l.fisico !== null && l.fisico !== undefined), difs = cnt.map(l => r2c(l.fisico - l.ini));
      const falt = -difs.filter(x => x < 0).reduce((a, x) => a + x, 0), sob = difs.filter(x => x > 0).reduce((a, x) => a + x, 0);
      const fVal = -cnt.reduce((a, l, i) => a + (difs[i] < 0 ? difs[i] * (l.costo || 0) : 0), 0), sVal = cnt.reduce((a, l, i) => a + (difs[i] > 0 ? difs[i] * (l.costo || 0) : 0), 0);
      const resumen = [['Folio', d.folio], ['Estatus', d.estatus], ['Fecha', d.fecha + (d.hora ? ' ' + d.hora : '')], ['Responsable', d.responsable || ''],
        ['Renglones', d.lineas.length, 'num'], ['Contados', cnt.length, 'num'], ['Coinciden', difs.filter(x => !x).length, 'num'], ['Sin contar', d.lineas.length - cnt.length, 'num'],
        ['Faltante (piezas)', abierto ? r2c(falt) : r.faltPzs || 0, 'num'], ['Sobrante (piezas)', abierto ? r2c(sob) : r.sobPzs || 0, 'num']]
        .concat(verC ? [['Faltante ($)', abierto || r.faltVal === null || r.faltVal === undefined ? r2c(fVal) : r.faltVal, 'mon'], ['Sobrante ($)', abierto || r.sobVal === null || r.sobVal === undefined ? r2c(sVal) : r.sobVal, 'mon']] : []);
      const blob = await excelLocal('', [{ nombre: 'Conteo físico', titulo: 'Inventario físico ' + d.folio + ' · ' + (d.sucNombre || sucNom(d.suc)),
        sub: [(d.alcance || '') + (abierto ? ' · conteo en curso' : d.cierre ? ' · cerrado el ' + d.cierre : ''), d.comentarios || ''], resumen: resumen, cols: cols, filas: filas }]);
      entregarArchivo(blob, 'Conteo ' + d.folio + ' ' + (d.sucNombre || '') + '.xlsx', 'Conteo físico en Excel');
    } catch (e) { toast(e.message || 'No se pudo hacer el Excel', true); } finally { cargando(false); }
  }

  /* ---------- VISOR DE PDF DENTRO DE LA APP ----------
   * iPhone / iPad (Safari) no abren un PDF guardado en el equipo en otra pestaña ("WebKitBlobResource 1").
   * Aquí se dibuja cada página con pdf.js, dentro de la app, y funciona sin señal. Solo se dibujan las páginas
   * cercanas a la pantalla (las lejanas se liberan) para no agotar la memoria del iPhone con portafolios grandes.
   */
  const PDFJS_V = '3.11.174', PDFJS_URL = 'https:' + '//cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_V + '/';
  /** Texto de un archivo del visor: de internet (y se guarda en el equipo) o, sin señal, la copia guardada. */
  async function textoVisor(arch) {
    try { const t = await fetch(PDFJS_URL + arch, { mode: 'cors' }).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }); if (t.length > 1000) { KV.set('pdfjs_' + arch, t); return t; } } catch (e) {}
    const g = await KV.get('pdfjs_' + arch); if (g) return g;
    throw new Error('El visor de PDF necesita conexión la primera vez; ábrelo una vez con señal');
  }
  function cargarPdfJs() {
    if (window.pdfjsLib && S.pdfjsWorker) return Promise.resolve(window.pdfjsLib);
    return S.pdfjsP || (S.pdfjsP = (async () => {
      const [main, worker] = await Promise.all([textoVisor('pdf.min.js'), textoVisor('pdf.worker.min.js')]);
      if (!window.pdfjsLib) { const sc = document.createElement('script'); sc.textContent = main; document.head.appendChild(sc); }
      const L = window.pdfjsLib; if (!L) throw new Error('No se pudo cargar el visor de PDF');
      const u = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
      try { L.GlobalWorkerOptions.workerPort = new Worker(u); } catch (e) { L.GlobalWorkerOptions.workerSrc = u; }
      S.pdfjsWorker = 1;
      return L;
    })().catch(e => { S.pdfjsP = null; throw e; }));
  }
  /** Precarga el visor (con señal) y lo deja guardado en el equipo para abrir PDFs sin conexión. */
  function precargarVisor() { if (navigator.onLine !== false) cargarPdfJs().catch(() => {}); }
  async function verPdf(bytesOBlob, nombre, extra) {
    extra = extra || {};
    let el = $('#visorPdf');
    if (!el) { el = document.createElement('section'); el.id = 'visorPdf'; el.className = 'visor-pdf'; document.body.appendChild(el); }
    const comp = !!(navigator.canShare && window.File);
    el.innerHTML = `<div class="vp-barra"><button class="icono" onclick="App.cerrarVisor()" aria-label="Cerrar">✕</button>
      <div class="vp-tit"><b>${esc(nombre)}</b><small id="vpInfo">Abriendo…</small></div>
      <button class="icono" onclick="App.zoomVisor(-1)" aria-label="Alejar">−</button><button class="icono" onclick="App.zoomVisor(1)" aria-label="Acercar">+</button>
      ${comp ? '<button class="btn chico" onclick="App.compartirVisor()">📤</button>' : ''}${extra.url && navigator.onLine !== false ? `<a class="btn chico" target="_blank" href="${esc(extra.url)}">Drive</a>` : ''}</div>
      <div class="vp-hojas" id="vpHojas"></div>`;
    el.classList.remove('oculto'); document.body.classList.add('con-visor');
    const blob = bytesOBlob instanceof Blob ? bytesOBlob : new Blob([bytesOBlob], { type: 'application/pdf' });
    S.visor = { blob: blob, nombre: /\.pdf$/i.test(nombre) ? nombre : nombre + '.pdf', zoom: 1, doc: null };
    try {
      const L = await cargarPdfJs();
      const datos = new Uint8Array(await blob.arrayBuffer());
      const doc = await L.getDocument({ data: datos, isEvalSupported: false }).promise;
      if (!S.visor || el.classList.contains('oculto')) { doc.destroy(); return; }
      S.visor.doc = doc;
      const p1 = await doc.getPage(1), vp1 = p1.getViewport({ scale: 1 });
      S.visor.ratio = vp1.height / vp1.width;
      $('#vpInfo').textContent = doc.numPages + ' páginas';
      armarHojasVisor();
    } catch (e) {
      $('#vpHojas').innerHTML = `<div class="vacio" style="color:#fff">${esc(e.message || 'No se pudo abrir el PDF')}<br><br>${comp ? '<button class="btn" onclick="App.compartirVisor()">📤 Abrir con otra app</button>' : ''}</div>`;
      const i = $('#vpInfo'); if (i) i.textContent = '';
    }
  }
  function armarHojasVisor() {
    const V = S.visor, cont = $('#vpHojas'); if (!V || !V.doc || !cont) return;
    if (V.obs) V.obs.disconnect();
    const ancho = Math.min(cont.clientWidth - 16, 900) * V.zoom;
    cont.innerHTML = Array.from({ length: V.doc.numPages }, (_, i) => `<div class="vp-hoja" data-p="${i + 1}" style="width:${ancho}px;height:${Math.round(ancho * V.ratio)}px"><span>${i + 1}</span></div>`).join('');
    V.obs = new IntersectionObserver(ents => ents.forEach(en => en.isIntersecting ? pintarHojaVisor(en.target) : soltarHojaVisor(en.target)), { root: cont, rootMargin: '150% 0px' });
    cont.querySelectorAll('.vp-hoja').forEach(h => V.obs.observe(h));
  }
  async function pintarHojaVisor(h) {
    const V = S.visor; if (!V || !V.doc || h.dataset.ok) return; h.dataset.ok = '1';
    try {
      const pg = await V.doc.getPage(Number(h.dataset.p)), w = h.clientWidth, dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = pg.getViewport({ scale: w / pg.getViewport({ scale: 1 }).width * dpr });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      if (!h.dataset.ok) return; h.innerHTML = ''; h.appendChild(c);
    } catch (e) { delete h.dataset.ok; }
  }
  function soltarHojaVisor(h) { if (!h.dataset.ok) return; delete h.dataset.ok; const c = h.querySelector('canvas'); if (c) { c.width = c.height = 0; } h.innerHTML = '<span>' + h.dataset.p + '</span>'; }
  function zoomVisor(d) { const V = S.visor; if (!V || !V.doc) return; V.zoom = Math.max(1, Math.min(3, V.zoom + d * 0.5)); armarHojasVisor(); }
  /** Cierra el visor de PDF generado (#visorPdf) y el de archivos adjuntos (#visor): antes eran dos funciones con el mismo nombre y la de adjuntos no cerraba. */
  function cerrarVisor() {
    const va = $('#visor'); if (va) { va.classList.add('oculto'); va.innerHTML = ''; }
    const el = $('#visorPdf'); if (el) { el.classList.add('oculto'); el.innerHTML = ''; } document.body.classList.remove('con-visor');
    if (S.visor) { if (S.visor.obs) S.visor.obs.disconnect(); if (S.visor.doc) S.visor.doc.destroy(); } S.visor = null;
  }
  async function compartirVisor() {
    const V = S.visor; if (!V) return;
    const f = new File([V.blob], V.nombre, { type: 'application/pdf' });
    try { if (navigator.canShare && navigator.canShare({ files: [f] })) return await navigator.share({ files: [f], title: V.nombre }); } catch (e) { if (e && e.name === 'AbortError') return; }
    toast('Este equipo no permite compartir el archivo desde aquí; usa el botón Drive o 💬 Enlace', true);
  }
  const PORT_LOTE = 60;            // productos por parte del PDF (los portafolios grandes se arman por partes y se unen aquí)
  function cargarPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https:' + '\/\/cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
      sc.onload = () => window.PDFLib ? res(window.PDFLib) : rej(new Error('No se pudo cargar el unidor de PDF')); sc.onerror = () => rej(new Error('No se pudo cargar el unidor de PDF (revisa la conexión)')); document.head.appendChild(sc); });
  }
  const b64aBytes = b => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  function bytesAB64(u) { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); }
  async function pdfCatalogo() {
    const C = S.catPdf || { labs: [], cats: [], ids: {} }, l = S.portEnPdf ? S.portEnPdf() : [];
    if (!l.length) return toast('No hay productos en la selección', true);
    if (await revisarVersion(true)) return;
    const ids = Object.keys(C.ids || {}).filter(k => C.ids[k]), sel = { labs: C.labs, cats: C.cats, ids: ids };
    const nT = agruparPortafolio(l).length;
    const t = [C.labs.join(', '), C.cats.join(', ')].filter(Boolean).join(' · ') || (ids.length ? 'Selección de productos' : 'Portafolio completo');
    const info = { asunto: 'Portafolio de productos Interés Veterinario — ' + t, texto: 'Le comparto nuestro portafolio de productos (' + t + '):', volver: "App.vistaProductos('port')" };
    modal('📄 Portafolio de productos', `<p><b>${nT}</b> productos · ${esc(t)}</p><p id="cpProg" class="muted">Revisando imágenes…</p><div class="barra-prog"><div id="cpBarra" style="width:3%"></div></div>
      <p class="muted" style="font-size:12px;margin-top:10px">No cierres esta ventana mientras se arma el PDF.</p>`);
    const prog = (txt, pct) => { const e = $('#cpProg'), b = $('#cpBarra'); if (e) e.textContent = txt; if (b && pct !== undefined) b.style.width = Math.round(pct) + '%'; };
    let lista;
    try { lista = await pedir('portafolioIds', sel); } catch (e) { return cerrarModal(); }
    const fotoDe = {}; (D().productos || []).forEach(p => fotoDe[p.id] = p.foto);
    try {
      await prepararSinFondo(lista.reps.filter(id => fotoDe[id]), (n, tot) => prog('Quitando el fondo de las imágenes: ' + n + ' de ' + tot + ' (solo la primera vez)…', 3 + 27 * n / Math.max(1, tot)));
    } catch (e) { if (e.red) return; }
    const n = lista.grupos.length, SEC = lista.secciones || [];
    // ---- por partes: portada (+ "Acerca de…"), índice y cada categoría en hoja nueva; luego se numeran las hojas
    const comun = { parte: true, todosLabs: lista.todosLabs, todosCats: lista.todosCats, total: n, titulo: lista.titulo };
    const trozos = []; SEC.forEach((s, si) => { for (let i = 0; i < s.grupos.length; i += PORT_LOTE) trozos.push({ si: si, orden: [].concat.apply([], s.grupos.slice(i, i + PORT_LOTE)), nCat: s.n }); });
    try {
      const PL = await cargarPdfLib(), cargar = async b => PL.PDFDocument.load(b64aBytes(b));
      prog('Armando la portada…', 31);
      const portada = await cargar((await pedir('pdfCatalogo', Object.assign({ tipo: 'portada', labs: C.labs, cats: C.cats, ids: ids }, comun))).b64);
      const cuerpos = new Array(trozos.length); let hechos = 0;
      for (let k = 0; k < trozos.length; k += 3) {          // de 3 en 3 al mismo tiempo
        await Promise.all(trozos.slice(k, k + 3).map(async (t, q) => {
          const r = await pedir('pdfCatalogo', Object.assign({ tipo: 'cuerpo', orden: t.orden, nCat: t.nCat, pie: k + q === trozos.length - 1 }, comun));
          cuerpos[k + q] = await cargar(r.b64); hechos++; prog('Armando el PDF: ' + hechos + ' de ' + trozos.length + ' partes…', 33 + 45 * hechos / trozos.length);
        }));
      }
      // páginas de cada categoría → índice (si el índice ocupa más de una hoja, se recalcula)
      const pagSec = SEC.map(() => 0); trozos.forEach((t, k) => pagSec[t.si] += cuerpos[k].getPageCount());
      let nIdx = 1, idx = null;
      for (let vuelta = 0; vuelta < 3; vuelta++) {
        let pag = portada.getPageCount() + nIdx + 1;
        const items = SEC.map((s, si) => { const x = { lab: s.lab, cat: s.cat, n: s.n, pag: pag }; pag += pagSec[si]; return x; });
        prog('Armando el índice…', 80);
        idx = await cargar((await pedir('pdfCatalogo', Object.assign({ tipo: 'indice', indice: items }, comun))).b64);
        if (idx.getPageCount() === nIdx) break; nIdx = idx.getPageCount();
      }
      prog('Uniendo las partes…', 84);
      const doc = await PL.PDFDocument.create();
      for (const src of [portada, idx].concat(cuerpos)) (await doc.copyPages(src, src.getPageIndices())).forEach(pg => doc.addPage(pg));
      // número de página (menos en la portada)
      const fuente = await doc.embedFont(PL.StandardFonts.Helvetica), gris = PL.rgb(0.42, 0.45, 0.4);
      doc.getPages().forEach((pg, i) => { if (!i) return; const t = String(i + 1), w = fuente.widthOfTextAtSize(t, 9);
        pg.drawText(t, { x: pg.getWidth() - 34 - w, y: 20, size: 9, font: fuente, color: gris }); });
      doc.setTitle('Portafolio de productos — Interés Veterinario'); doc.setAuthor('Interés Veterinario');
      const bytes = await doc.save(), nombre = (/^Portafolio/.test(lista.titulo) ? '' : 'Portafolio ') + String(lista.titulo).slice(0, 60) + ' ' + hoyISO();
      const local = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      // guardar en Drive: pedazos de 3 MB (múltiplos de 3 bytes para poder pegar el base64)
      prog('Guardando en tu Drive…', 90);
      let r = null;
      try {
        const T = 3 * 1024 * 1024, ses = uid(), nP = Math.ceil(bytes.length / T);
        for (let k = 0; k < nP; k++) { await pedir('subirPdfParte', { sesion: ses, i: k, b64: bytesAB64(bytes.subarray(k * T, (k + 1) * T)) }); prog('Guardando en tu Drive… ' + (k + 1) + ' de ' + nP, 90 + 9 * (k + 1) / nP); }
        r = await pedir('unirPdfPartes', { sesion: ses, n: nP, nombre: nombre, productos: n });
      } catch (e) { r = null; }
      const msg = info.texto + (r ? '\n' + r.url : '');
      modal('PDF listo', `<p>📄 <b>${esc(nombre)}.pdf</b> · ${n} productos · ${(bytes.length / 1048576).toFixed(1)} MB</p>
        <p class="muted">${r ? 'Quedó guardado en tu Drive, carpeta “Interés Veterinario - PDF / Portafolios”.' : 'No se pudo guardar en Drive; descárgalo y compártelo desde tu equipo.'}</p>
        <div class="acciones" style="justify-content:flex-start">
          <button class="btn primario" onclick="App.verPdfLocal()">👁️ Ver</button><a class="btn" href="${local}" download="${esc(nombre)}.pdf">⬇️ Descargar</a>
          ${r ? `<a class="btn" href="${esc(r.url)}" target="_blank">📄 Abrir en Drive</a>
          <a class="btn" target="_blank" href="${WA_BASE}?text=${encodeURIComponent(msg)}">💬 WhatsApp</a>
          <a class="btn" target="_blank" href="mailto:?subject=${encodeURIComponent(info.asunto)}&body=${encodeURIComponent(msg)}">✉️ Correo</a>` : ''}
          ${navigator.canShare ? `<button class="btn" onclick="App.compartirPdfLocal()">📤 Compartir</button>` : ''}
          <button class="btn" onclick="${info.volver}">Volver</button></div>`);
      S.pdfLocal = { bytes: bytes, nombre: nombre + '.pdf' };
      // queda guardado en este equipo y en la lista de "Mis portafolios" (para compartirlo al instante, aun sin conexión)
      try { await PDFDB.poner({ id: r && r.id ? r.id : 'local-' + uid(), nombre: nombre, fecha: Date.now(), tam: bytes.length, url: r ? r.url : '', blob: new Blob([bytes], { type: 'application/pdf' }) });
        if (r && r.id) { const l = LS.get('portafoliosSrv', []).filter(x => x.id !== r.id); l.unshift({ id: r.id, nombre: nombre, fecha: Date.now(), tam: bytes.length, url: r.url }); LS.set('portafoliosSrv', l); }
        pintarPortafolios(); } catch (e) {}
    } catch (e) { if (!e.red) toast(e.message || 'No se pudo armar el PDF', true); cerrarModal(); }
  }
  /* ---------- MIS PORTAFOLIOS: los PDF generados quedan en Drive y también en el equipo (IndexedDB) para abrirlos y compartirlos sin conexión ---------- */
  const PDFDB = (() => {
    let db = null;
    const abrir = () => db ? Promise.resolve(db) : new Promise((ok, mal) => { const r = indexedDB.open('iv_portafolios', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pdfs', { keyPath: 'id' }); r.onsuccess = () => { db = r.result; ok(db); }; r.onerror = () => mal(r.error); });
    const tx = (modo, fn) => abrir().then(d => new Promise((ok, mal) => { const t = d.transaction('pdfs', modo), st = t.objectStore('pdfs'), q = fn(st); t.oncomplete = () => ok(q && q.result); t.onerror = () => mal(t.error); }));
    return { todos: () => tx('readonly', st => st.getAll()).catch(() => []), uno: id => tx('readonly', st => st.get(id)), poner: o => tx('readwrite', st => st.put(o)), quitar: id => tx('readwrite', st => st.delete(id)) };
  })();
  const tamTxt = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  async function pintarPortafolios(sincronizar) {
    if (S.online) precargarVisor();
    const el = $('#cpGuardados'); if (!el) return;
    const loc = await PDFDB.todos(), enEq = {}; loc.forEach(x => enEq[x.id] = x);
    const srv = LS.get('portafoliosSrv', []), ids = {}, lista = [];
    srv.concat(loc).forEach(x => { if (ids[x.id]) return; ids[x.id] = 1; lista.push({ id: x.id, nombre: x.nombre, fecha: x.fecha, tam: x.tam, url: x.url || (enEq[x.id] || {}).url || '', local: !!enEq[x.id] }); });
    lista.sort((a, b) => b.fecha - a.fecha);
    const nLoc = lista.filter(x => x.local).length, admin = U().rol === 'Administrador';
    el.innerHTML = `<div class="cat-pdf-enc"><div><h3 style="margin:0">📁 Mis portafolios</h3><p class="muted" style="margin:2px 0 0;font-size:13px">Listos para compartir al instante. Los que dicen <b>📱 En este equipo</b> se abren y comparten aun sin conexión.</p></div>
        ${S.online && lista.some(x => !x.local) ? `<button class="btn fijo" onclick="App.bajarPortafolios(true)">📥 Guardar todos en este equipo</button>` : ''}</div>
      <p class="muted" id="cpGuardEst" style="margin:6px 0 0;font-size:12.5px">${lista.length ? `${lista.length} portafolios · ${nLoc} en este equipo` : 'Aún no hay portafolios: genera uno abajo y quedará aquí.'}</p>
      ${lista.length ? `<div class="port-lista">${lista.map(x => `<div class="port-item">
        <div class="port-ico">📄</div>
        <div class="port-info"><b>${esc(x.nombre)}</b><small>${new Date(x.fecha).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}${x.tam ? ' · ' + tamTxt(x.tam) : ''} · ${x.local ? '<span class="txt-ok">📱 En este equipo</span>' : '☁️ En Drive'}</small></div>
        <div class="port-acc">
          ${x.local ? `<button class="btn primario chico" onclick="App.compartirPortafolio('${esc(x.id)}')">📤 Compartir</button><button class="btn chico" onclick="App.abrirPortafolio('${esc(x.id)}')">Abrir</button>`
            : `${S.online ? `<button class="btn chico" onclick="App.bajarPortafolio('${esc(x.id)}')">📥 Guardar en el equipo</button>` : ''}${x.url ? `<a class="btn chico" href="${esc(x.url)}" target="_blank">Abrir en Drive</a>` : ''}`}
          ${x.url ? `<a class="btn chico" target="_blank" href="${WA_BASE}?text=${encodeURIComponent('Le comparto nuestro portafolio de productos Interés Veterinario: ' + x.nombre + '\n' + x.url)}">💬 Enlace</a>` : ''}
          ${x.local ? `<button class="icono" title="Quitar de este equipo (sigue en Drive)" onclick="App.quitarPortafolioLocal('${esc(x.id)}')">✕</button>` : admin && S.online ? `<button class="icono" title="Quitar de la lista (se mueve a Archivos quitados)" onclick="App.quitarPortafolioDrive('${esc(x.id)}')">🗂️</button>` : ''}
        </div></div>`).join('')}</div>` : ''}`;
    if (sincronizar && S.online) {
      try { const r = await pedir('listarPortafolios', {}, true); LS.set('portafoliosSrv', r.map(x => ({ id: x.id, nombre: x.nombre, fecha: x.fecha, tam: x.tam, url: x.url })));
        await pintarPortafolios(false); bajarPortafolios(false); } catch (e) {}
    }
  }
  /** Baja al equipo los portafolios que faltan (los 20 más recientes, hasta 30 MB cada uno). */
  async function bajarPortafolios(todos) {
    if (S.bajandoPort || !S.online) return; S.bajandoPort = true;
    try {
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
      const loc = await PDFDB.todos(), ya = {}; loc.forEach(x => ya[x.id] = 1);
      const faltan = LS.get('portafoliosSrv', []).filter(x => !ya[x.id] && (!x.tam || x.tam < 30 * 1048576)).slice(0, todos ? 200 : 5);   // en automático solo los 5 más recientes
      for (let i = 0; i < faltan.length; i++) { if (!S.online) break; const e = $('#cpGuardEst'); if (e) e.textContent = 'Guardando en este equipo: ' + (i + 1) + ' de ' + faltan.length + '…'; await bajarPortafolio(faltan[i].id, true); await new Promise(r => setTimeout(r, 800)); }
    } finally { S.bajandoPort = false; pintarPortafolios(); }
  }
  async function bajarPortafolio(id, callado) {
    const x = LS.get('portafoliosSrv', []).find(o => o.id === id); if (!x) return;
    try {
      const partes = []; let ini = 0, total = 1;
      while (ini < total) { const r = await pedir('bajarPortafolio', { id: id, ini: ini, tam: 3145728 }, true); total = r.total; const b = b64aBytes(r.b64); partes.push(b); ini += b.length; if (!b.length) break; }
      await PDFDB.poner({ id: id, nombre: x.nombre, fecha: x.fecha, tam: total, url: x.url, blob: new Blob(partes, { type: 'application/pdf' }) });
      if (!callado) { toast('✔ Guardado en este equipo'); pintarPortafolios(); }
    } catch (e) { if (!callado) toast('No se pudo guardar en el equipo' + (e.message ? ': ' + e.message : ''), true); }
  }
  async function compartirPortafolio(id) {
    const x = await PDFDB.uno(id); if (!x) return toast('Ese portafolio ya no está en este equipo', true);
    const f = new File([x.blob], x.nombre + '.pdf', { type: 'application/pdf' });
    try { if (navigator.canShare && navigator.canShare({ files: [f] })) return await navigator.share({ files: [f], title: x.nombre }); } catch (e) { if (e && e.name === 'AbortError') return; }
    if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) { verPdf(x.blob, x.nombre, { url: x.url }); return toast('Aquí no se puede compartir el archivo directo: usa 💬 Enlace o ábrelo en Drive', true); }
    const a = document.createElement('a'); a.href = URL.createObjectURL(x.blob); a.download = x.nombre + '.pdf'; document.body.appendChild(a); a.click(); a.remove();
    toast('Este equipo no permite compartir directo: se descargó el PDF');
  }
  async function abrirPortafolio(id) {
    const x = await PDFDB.uno(id); if (!x) return toast('Ese portafolio ya no está en este equipo', true);
    verPdf(x.blob, x.nombre, { url: x.url });
  }
  async function quitarPortafolioLocal(id) { if (!confirm('¿Quitarlo de este equipo? Sigue guardado en tu Drive.')) return; await PDFDB.quitar(id); pintarPortafolios(); }
  async function quitarPortafolioDrive(id) {
    if (!confirm('¿Quitar este portafolio de la lista? No se borra: se mueve a la carpeta "Archivos quitados" de Portafolios.')) return;
    try { await pedir('quitarPortafolio', { id: id }); LS.set('portafoliosSrv', LS.get('portafoliosSrv', []).filter(x => x.id !== id)); toast('Portafolio quitado de la lista'); pintarPortafolios(); } catch (e) {}
  }
  async function compartirPdfLocal() {
    const x = S.pdfLocal; if (!x) return;
    try { const f = new File([x.bytes], x.nombre, { type: 'application/pdf' }); if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: x.nombre }); else toast('Este equipo no permite compartir archivos; usa Descargar', true); } catch (e) {}
  }

  async function prodMargen() {
    const listas = (D().catalogos || {}).listas || [];
    $('#pCont').innerHTML = filtrosProd(`<label>Margen sobre<select id="pfBase"><option value="real">Costo real de compra</option><option value="lista">Costo de lista</option></select></label>
      <label class="check fijo"><input type="checkbox" id="pfBajo"> Solo con margen bajo (&lt;10%)</label>`) + '<div id="pNota" class="muted"></div><div id="pRes"><div class="vacio">Calculando costos reales…</div></div>';
    let CR = S.costosReales && Date.now() - S.costosRealesT < 600000 ? S.costosReales : null;
    if (U().costoLista) CR = null;
    else if (!CR) { S.costosRealesT = Date.now(); try { CR = S.costosReales = await pedir('costosReales', {}); } catch (e) { CR = null; } }
    if (!CR) $('#pfBase').value = 'lista', $('#pfBase').disabled = true;
    $('#pNota').innerHTML = CR
      ? `<p><b>Costo real</b> = lo pagado en compras (con descuentos) ÷ todas las piezas recibidas, incluidas las bonificadas (a $0, $0.01 … $0.10), + ${(CR.flete * 100).toFixed(0)}% de flete. Promedio de los últimos ${CR.meses} meses, sin IVA.
         <b>Colchón</b> = cuánto está tu costo de lista arriba del costo real. Margen = (precio − costo) / precio. <span class="etq mal">rojo</span> &lt; 10% · <span class="etq av">ámbar</span> &lt; 20%.</p>`
      : (U().costoLista ? '<p>Margen calculado con el precio costo de la lista de precios.</p>' : '<p>Sin conexión: se muestra el margen con el costo de lista.</p>');
    const cr = p => CR && CR.productos[p.id] ? CR.productos[p.id] : null;
    const base = p => $('#pfBase').value === 'real' && cr(p) && cr(p).costoReal ? cr(p).costoReal : (p.costo || 0);
    const mg = (p, l) => p.precios[l] ? (p.precios[l] - base(p)) / p.precios[l] * 100 : null;
    const pintar = () => {
      const bajo = $('#pfBajo').checked;
      const l = prodFiltrados().filter(p => !bajo || listas.some(x => { const m = mg(p, x); return m !== null && m < 10; }));
      const cols = [{ t: 'Producto', h: p => `<b>${esc(p.nombre)}</b><br><small class="muted">${esc(p.id)}</small>` }, { t: 'Costo lista', num: 1, h: p => $$(p.costo) }];
      if (CR) cols.push(
        { t: 'Costo real', num: 1, h: p => { const c = cr(p); if (!c) return '<span class="muted">sin compras</span>';
          if (!c.costoReal) return '<span class="etq av">solo bonificación</span>';
          return `<b>${$$(c.costoReal)}</b><br><small class="muted">últ. ${$$(c.ultimoCosto)} · ${esc(c.ultimaCompra)}${c.bonificadas ? '<br>' + nf(c.bonificadas) + ' de ' + nf(c.piezas) + ' pzs bonif.' : ''}</small>`; } },
        { t: 'Colchón', num: 1, h: p => { const c = cr(p); if (!c || !c.costoReal || !p.costo) return '<span class="muted">—</span>';
          const d = (p.costo - c.costoReal) / c.costoReal * 100; return `<span class="etq ${d < 0 ? 'mal' : 'ok'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</span>`; } });
      $('#pRes').innerHTML = `<p class="muted">${l.length} productos</p>` + tabla(cols.concat(listas.map(x => ({ t: x, num: 1, h: p => { const m = mg(p, x); if (m === null) return '<span class="muted">—</span>';
          return `${$$(p.precios[x])}<br><span class="etq ${m < 10 ? 'mal' : m < 20 ? 'av' : 'ok'}">${m.toFixed(1)}%</span>`; } }))), l.slice(0, 800), { clic: 'App.abrirProducto' });
    };
    enlazarFiltros(pintar); $('#pfBajo').onchange = pintar; $('#pfBase').onchange = pintar; pintar();
  }
  async function formProducto(i) {
    const p = i === null ? null : S.lista[i];
    const editar = puede('productos_editar');
    let full = {};
    if (p) { try { full = await pedir('registro', { tabla: 'producto', id: p.id }); } catch (e) { full = { ID_Producto: p.id, Prod_Nombre: p.nombre }; } }
    const cat = D().catalogos, listas = D().productos || [];
    const cats = [...new Set(listas.map(x => x.categoria).filter(Boolean))].sort(), labs = [...new Set(listas.map(x => x.lab).filter(Boolean))].sort();
    if (!editar) {
      modal(p.nombre, `${bloqueFoto(p)}<p><b>${esc(p.id)}</b> · ${esc(p.unidad)} · ${esc(p.categoria)} · ${esc(p.lab)} · Reg. ${esc(full.No_Registro || '')}</p>
        ${['Descripcion', 'Indicaciones', 'Especies', 'Dosis', 'Tiempo_retiro', 'Advertencias'].filter(k => full[k]).map(k => `<h4 style="margin-top:12px">${k.replace('_', ' ')}</h4><p style="white-space:pre-wrap">${esc(full[k])}</p>`).join('')}
        <h4 style="margin-top:12px">Precios</h4>${tabla([{ t: 'Lista', k: 'l' }, { t: 'Precio', num: 1, h: x => $$(x.v) }], Object.keys(p.precios).map(k => ({ l: k, v: p.precios[k] })))}${bloqueArch('prodFicha', p.id)}`);
      cargarFotoGrande(p.id);
      return;
    }
    const campos = [
      { k: 'ID_Producto', t: 'Clave', req: 1, dis: !!p }, { k: 'Prod_Nombre', t: 'Nombre', req: 1, ancho: 1 },
      { k: 'Unidad_Venta', t: 'Unidad de venta', tipo: 'select', ops: ['Pieza', 'Caja', 'Saco', 'Cubeta', 'Bolsa', 'KG', 'Litro'].map(x => [x, x]) },
      { k: 'Piezas_por_Unidad', t: 'Piezas por unidad', tipo: 'number' }, { k: 'TASA_IVA', t: 'IVA', tipo: 'select', ops: cat.tasasIva },
      { k: 'Categoria', t: 'Categoría', tipo: 'lista', ops: cats, ph: 'Elige o escribe una nueva' }, { k: 'Laboratorio', t: 'Laboratorio', tipo: 'lista', ops: labs, ph: 'Elige o escribe uno nuevo' },
      { k: 'No_Registro', t: 'No. registro' }, { k: 'Stock_Minimo', t: 'Stock mínimo', tipo: 'number' },
      { k: 'Precio_Costo', t: 'Costo $', tipo: 'number' }, { k: 'Precio_Publico', t: 'Público $', tipo: 'number' }, { k: 'Precio_Subdistribuidor', t: 'Subdistribuidor $', tipo: 'number' },
      { k: 'Precio_Socio', t: 'Socio $', tipo: 'number' }, { k: 'Precio_Aliado', t: 'Aliado $', tipo: 'number' }, { k: 'AGL', t: 'AGL $', tipo: 'number' },
      { k: 'Precio_Farmacia', t: 'Farmacia $', tipo: 'number' }, { k: 'Precio_Ganadero', t: 'Ganadero $', tipo: 'number' }, { k: 'Comisionista', t: 'Comisionista $', tipo: 'number' },
      { k: 'Activo', t: 'Estado', tipo: 'select', ops: [['SI', 'Activo'], ['NO', 'Inactivo (baja)']] }, { k: 'Usa_Lote', t: 'Controla lote', tipo: 'check' }, { k: 'Usa_Caducidad', t: 'Controla caducidad', tipo: 'check' },
      { k: 'Especies', t: 'Especies', ancho: 1 }, { k: 'Descripcion', t: 'Descripción / fórmula', tipo: 'textarea', ancho: 1 }, { k: 'Indicaciones', t: 'Indicaciones', tipo: 'textarea', ancho: 1 },
      { k: 'Dosis', t: 'Dosis', tipo: 'textarea', ancho: 1 }, { k: 'Tiempo_retiro', t: 'Tiempo de retiro' }, { k: 'Advertencias', t: 'Advertencias', tipo: 'textarea', ancho: 1 }];
    const ini = p ? full : { Activo: 'SI', Unidad_Venta: 'Pieza', Piezas_por_Unidad: 1, TASA_IVA: 'T_Ex', Usa_Lote: true, Usa_Caducidad: true };
    S.formIni = ini;
    modal(p ? 'Editar ' + p.nombre : 'Nuevo producto', `${p ? `<div class="foto-editar"><div class="foto-prod" id="fotoEdit" data-grande="${esc(p.id)}">${p.foto ? '<span class="muted">Cargando foto…</span>' : '<span class="muted">Sin foto</span>'}</div>
      <label class="btn">📷 ${p.foto ? 'Cambiar foto' : 'Agregar foto'}<input type="file" accept="image/&#42;" style="display:none" onchange="App.subirFoto('${esc(p.id)}', this)"></label></div>`
      : `<div class="foto-editar"><div class="foto-prod" id="fotoEdit"><span class="muted">Sin foto</span></div>
      <label class="btn">📷 Agregar foto<input type="file" id="fotoNueva" accept="image/&#42;" style="display:none" onchange="App.fotoNuevaPrev(this)"></label></div>`}<div id="fProd">${formulario(campos, ini)}</div>${p ? bloqueArch('prodFicha', p.id) : ''}
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.guardarProducto(${p ? 'false' : 'true'})">Guardar</button></div>`);
    if (p && p.foto) cargarFotoGrande(p.id);
  }
  async function guardarProducto(nuevo) {
    const f = leerForm($('#fProd'));
    const nuevos = [];
    [['Categoria', 'categoria', 'la categoría'], ['Laboratorio', 'lab', 'el laboratorio']].forEach(([k, pk, t]) => {
      const v = String(f[k] || '').replace(/\s+/g, ' ').trim(); f[k] = v; if (!v) return;
      const ex = [...new Set((D().productos || []).map(x => x[pk]).filter(Boolean))].find(x => norm(x).trim() === norm(v));
      if (ex) f[k] = ex; else nuevos.push(t + ' nuevo "' + v + '"');
    });
    if (nuevos.length && !confirm('Se dará de alta ' + nuevos.join(' y ') + '. ¿Continuar?')) return;
    const datos = nuevo ? f : soloCambios(S.formIni, f);
    if (!nuevo && !Object.keys(datos).length) return cerrarModal();
    datos.ID_Producto = nuevo ? f.ID_Producto : S.formIni.ID_Producto; datos.nuevo = nuevo;
    const foto = nuevo && $('#fotoNueva') && $('#fotoNueva').files[0];
    try {
      await pedir('guardarProducto', datos); toast('✔ Producto guardado');
      if (foto) { try { await pedir('subirFotoProducto', { id: datos.ID_Producto, dataUri: await reducirImagen(foto, 1000) }); toast('✔ Producto y foto guardados'); } catch (e) { toast('El producto se guardó, pero la foto no. Agrégala desde Editar.', true); } }
      cerrarModal(); await refrescarDatos(true); V.productos();
    } catch (e) {}
  }

  /* ---------- CLIENTES ---------- */
  V.clientes = () => {
    $('#vista').innerHTML = `<div class="tarjeta"><div class="fila"><label>Buscar<input id="clTxt" placeholder="Nombre, razón social, rancho, RFC, localidad, teléfono"></label>
      <label>Lista<select id="clLista">${opts(((D().catalogos || {}).listas || []).map(x => [x, x]), '', 'Todas')}</select></label>
      <label>Estado<select id="clSt"><option value="Activo">Activos</option><option value="Inactivo">Inactivos</option><option value="">Todos</option></select></label>
      ${puede('clientes_editar') ? '<button class="btn primario fijo" onclick="App.formCliente(null)">+ Nuevo cliente</button>' : ''}</div></div><div class="espacio"></div><div id="clRes"></div>`;
    const pintar = () => { const txt = $('#clTxt').value, li = $('#clLista').value, st = $('#clSt').value;
      const l = (D().clientes || []).filter(c => (!txt || coincide(c.nombre + ' ' + c.razon + ' ' + (c.rancho || '') + ' ' + c.rfc + ' ' + c.localidad + ' ' + c.municipio + ' ' + c.cel, txt)) && (!li || c.lista === li) && (!st || (c.status || 'Activo') === st))
        .sort((a, b) => (a.razon || a.nombre).localeCompare(b.razon || b.nombre));
      S.lista = l;
      $('#clRes').innerHTML = `<p class="muted">${l.length} clientes</p>` + tabla([{ t: 'Cliente', h: c => `<div class="con-avatar">${avatar('cliFoto', c.id, c.foto, c.razon || c.nombre)}<div><b>${esc(c.razon || c.nombre)}</b>${c.razon && c.razon !== c.nombre ? '<br><small class="muted">' + esc(c.nombre) + '</small>' : ''}${c.rancho ? '<br><small class="muted">🐄 ' + esc(c.rancho) + '</small>' : ''}${c.csf ? ' <span title="Tiene constancia de situación fiscal">🧾</span>' : ''}</div></div>` },
        { t: 'Lista', k: 'lista' }, { t: 'Crédito', num: 1, h: c => c.credito + ' d' }, { t: 'Localidad', cls: 'ocultar-movil', h: c => esc([c.localidad || c.municipio, c.estado].filter(Boolean).join(', ')) },
        { t: 'Teléfono', cls: 'ocultar-movil', k: 'cel' }, { t: 'Clasif.', k: 'clasif', cls: 'ocultar-movil' }, { t: 'Estado', h: c => `<span class="etq ${c.status === 'Inactivo' ? 'mal' : 'ok'}">${esc(c.status || 'Activo')}</span>` }], l, { clic: 'App.abrirCliente' }); cargarAvatares($('#clRes')); };
    ['#clTxt', '#clLista', '#clSt'].forEach(s => enlazarFiltro(s, pintar)); pintar();
  };
  async function formCliente(i, desdeVenta, nombreIni) {
    const c = i === null ? null : S.lista[i];
    let full = c ? { ID_Cliente: c.id, Nombre_cliente: c.nombre, Razon_social: c.razon, RFC: c.rfc, Lista_de_Precios: c.lista, D_Credito: c.credito, Celular: c.cel, Status: c.status } : {};
    if (c) { try { full = await pedir('registro', { tabla: 'cliente', id: c.id }, true); } catch (e) {} }
    const cat = D().catalogos, comercial = U().rol === 'Administrador' || U().rol === 'Gerente';
    const campos = [
      { k: 'Nombre_cliente', t: 'Nombre del cliente', req: 1 }, { k: 'Razon_social', t: 'Razón social' }, { k: 'Nombre_Rancho', t: 'Nombre del rancho' }, { k: 'RFC', t: 'RFC' },
      { k: 'Regimen_Fiscal', t: 'Régimen fiscal', tipo: 'select', ops: cat.regimen, vacio: '' }, { k: 'Uso_CFDI', t: 'Uso CFDI', tipo: 'select', ops: cat.usoCfdi, vacio: '' }, { k: 'C.P.', t: 'C.P.' },
      { k: 'Lista_de_Precios', t: 'Lista de precios', tipo: 'select', ops: cat.listas.map(x => [x, x]), dis: !comercial }, { k: 'D_Credito', t: 'Días de crédito', tipo: 'number', dis: !comercial },
      { k: 'Clasificacion', t: 'Clasificación', tipo: 'select', ops: ['AAA', 'AA', 'A', 'B', 'C'].map(x => [x, x]), vacio: '' }, { k: 'Tipo', t: 'Tipo', tipo: 'select', ops: ['Productor', 'Farmacia', 'Clínica', 'MVZ', 'Distribuidor', 'Público'].map(x => [x, x]), vacio: '' },
      { k: 'Nicho Mercado', t: 'Nicho de mercado (puedes elegir varios)', tipo: 'multi', ops: NICHOS, ancho: 1 }, { k: 'Celular', t: 'Celular', tipo: 'tel' }, { k: 'e-mail', t: 'Correo', tipo: 'email' }, { k: 'Tel_Fijo', t: 'Tel. fijo' },
      { k: 'Calle', t: 'Calle' }, { k: 'Colonia', t: 'Colonia' }, { k: 'Municipio/Delegación', t: 'Municipio' }, { k: 'Localidad', t: 'Localidad' }, { k: 'Estado', t: 'Estado' }, { k: 'Ruta', t: 'Ruta' },
      { k: 'Ubicacion_trabajo/rancho', t: 'Ubicación rancho (lat, long)' }, { k: 'Enc_Compras', t: 'Encargado de compras' }, { k: 'Tel_Enc_Compras', t: 'Tel. compras' },
      { k: 'Enc_Pagos', t: 'Encargado de pagos' }, { k: 'Tel_Enc_Pagos', t: 'Tel. pagos' }, { k: 'Potencial', t: 'Potencial' },
      { k: 'ID_Sucursal', t: 'Sucursal', tipo: 'select', ops: D().sucursales, dis: !U().todasSucursales }, { k: 'Vendedor', t: 'Vendedor', tipo: 'select', ops: D().vendedores, vacio: '', dis: !comercial },
      { k: 'Status', t: 'Estado', tipo: 'select', ops: [['Activo', 'Activo'], ['Inactivo', 'Inactivo (baja)'], ['Prospecto', 'Prospecto']] },
      { k: 'Comentarios', t: 'Comentarios', tipo: 'textarea', ancho: 1 }];
    const ini = c ? full : { Lista_de_Precios: 'Publico', D_Credito: 0, Status: 'Activo', ID_Sucursal: sucTrabajo(), Vendedor: U().id };
    // alta desde el buscador de venta/cotización: el nombre que se escribió (o un RFC / teléfono) ya va capturado
    const formVals = Object.assign({}, ini); const nq = String(nombreIni || '').trim();
    if (!c && nq) { if (/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i.test(nq)) formVals.RFC = nq.toUpperCase(); else if (/^[\d\s\-+()]{7,}$/.test(nq)) formVals.Celular = nq; else formVals.Nombre_cliente = nq.toUpperCase(); }
    S.formIni = ini; S.formDesdeVenta = desdeVenta === true ? 'venta' : desdeVenta || '';
    const bloqueado = !!c && U().rol !== 'Administrador';
    if (bloqueado) campos.forEach(x => x.dis = true);
    modal(c ? (c.razon || c.nombre) : 'Nuevo cliente', `${bloqueado ? `<div class="aviso-cand">🔒 <b>Solo el administrador puede modificar clientes.</b> Si necesitas cambiar algún dato de este cliente, <b>solicita autorización</b> al administrador.</div>` : ''}<div class="arch-par">${c ? bloqueArch('cliFoto', c.id) + bloqueArch('cliCsf', c.id) : bloqueArchNuevo('cliFoto', 'cliFotoN') + bloqueArchNuevo('cliCsf', 'cliCsfN')}</div><div id="fCli">${formulario(campos, formVals)}</div>
      <div class="acciones">${c && puede('ventas') ? `<button class="btn" onclick="App.ventasDeCliente('${esc(c.id)}','${esc(String(c.razon || c.nombre || '').replace(/'/g, ''))}')">🧾 Ver sus ventas</button>` : ''}
      ${c && puede('ventas') ? `<button class="btn" onclick="App.venderA('${c.id}')">🛒 Venderle</button>` : ''}
      <button class="btn" onclick="${c ? `App.verCliente(${i})` : 'App.cerrarModal()'}">${c ? '← Volver a la ficha' : 'Cancelar'}</button>${puede('clientes_editar') && !bloqueado ? `<button class="btn primario" onclick="App.guardarCliente()">Guardar</button>` : ''}</div>`);
  }
  /** Ficha de información del cliente (solo lectura). Editar: administrador. Eliminar: dueño. */
  async function verCliente(i) {
    const c = S.lista[i]; if (!c) return;
    S.cliIdx = i;
    let r = null; try { r = await pedir('registro', { tabla: 'cliente', id: c.id }, true); } catch (e) {}
    const x = r || { Nombre_cliente: c.nombre, Razon_social: c.razon, Nombre_Rancho: c.rancho, RFC: c.rfc, Lista_de_Precios: c.lista, D_Credito: c.credito, Celular: c.cel,
      'e-mail': c.email, Calle: c.calle, Colonia: c.colonia, Localidad: c.localidad, 'Municipio/Delegación': c.municipio, Estado: c.estado, Clasificacion: c.clasif, Tipo: c.tipo,
      'Nicho Mercado': c.nicho, Status: c.status, ID_Sucursal: c.suc, Vendedor: c.vendedor, Comentarios: c.comentarios, Regimen_Fiscal: c.regimen, Uso_CFDI: c.uso, 'C.P.': c.cp };
    const cat = D().catalogos || {}, nomCat = (l, v) => { const o = (l || []).find(z => String(z.id) === String(v)); return o ? o.nombre : (v || ''); };
    const vend = (D().vendedores || []).find(v => String(v.id) === String(x.Vendedor));
    const dato = (t, v, ancho) => { const s = v === undefined || v === null ? '' : String(v).trim(); return s ? `<div class="fc-dato${ancho ? ' ancho' : ''}"><small>${esc(t)}</small><span>${esc(s)}</span></div>` : ''; };
    const tel = v => { const n = String(v || '').replace(/\D/g, ''); return n ? `<a href="tel:${n}">${esc(v)}</a>` : ''; };
    const datoHtml = (t, html) => html ? `<div class="fc-dato"><small>${esc(t)}</small><span>${html}</span></div>` : '';
    const seccion = (tit, cont) => cont.replace(/\s/g, '') ? `<div class="fc-sec"><h4>${tit}</h4><div class="fc-rejilla">${cont}</div></div>` : '';
    const nichos = String(x['Nicho Mercado'] || '').split(',').map(z => z.trim()).filter(Boolean);
    const dir = [x.Calle, x.Colonia, x.Localidad, x['Municipio/Delegación'], x.Estado, x['C.P.'] ? 'C.P. ' + x['C.P.'] : ''].filter(z => String(z || '').trim()).join(', ');
    const ubic = String(x['Ubicacion_trabajo/rancho'] || '').trim();
    const st = x.Status || 'Activo', admin = U().rol === 'Administrador', dueno = puede('dueno');
    modal(x.Razon_social || x.Nombre_cliente || 'Cliente', `<div class="ficha-cli">
      <div class="fc-cab"><div><h3>${esc(x.Razon_social || x.Nombre_cliente || '')}</h3>
        ${x.Razon_social && x.Nombre_cliente && x.Razon_social !== x.Nombre_cliente ? `<div>${esc(x.Nombre_cliente)}</div>` : ''}
        ${x.Nombre_Rancho ? `<div class="muted">🐄 ${esc(x.Nombre_Rancho)}</div>` : ''}
        <div class="fc-etqs"><span class="etq ${st === 'Inactivo' ? 'mal' : 'ok'}">${esc(st)}</span>${x.Lista_de_Precios ? `<span class="etq">Lista ${esc(x.Lista_de_Precios)}</span>` : ''}<span class="etq">Crédito ${Number(x.D_Credito) || 0} días</span>${x.Clasificacion ? `<span class="etq">Clasif. ${esc(x.Clasificacion)}</span>` : ''}</div></div></div>
      <div class="arch-par">${bloqueArch('cliFoto', c.id)}${bloqueArch('cliCsf', c.id)}</div>
      ${seccion('🧾 Datos fiscales', dato('RFC', x.RFC) + dato('Régimen fiscal', nomCat(cat.regimen, x.Regimen_Fiscal)) + dato('Uso CFDI', nomCat(cat.usoCfdi, x.Uso_CFDI)) + dato('C.P.', x['C.P.']))}
      ${seccion('📞 Contacto', datoHtml('Celular', tel(x.Celular)) + datoHtml('Tel. fijo', tel(x.Tel_Fijo)) + dato('Correo', x['e-mail']) + dato('Encargado de compras', [x.Enc_Compras, x.Tel_Enc_Compras].filter(Boolean).join(' · ')) + dato('Encargado de pagos', [x.Enc_Pagos, x.Tel_Enc_Pagos].filter(Boolean).join(' · ')))}
      ${seccion('📍 Dirección', dato('Domicilio', dir, 1) + dato('Ruta', x.Ruta) + (ubic ? datoHtml('Ubicación del rancho', `<a target="_blank" rel="noopener" href="https:${'\/\/'}www.google.com/maps?q=${encodeURIComponent(ubic)}">Ver en mapa</a>`) : ''))}
      ${seccion('🐂 Comercial', dato('Tipo', x.Tipo) + dato('Potencial', x.Potencial) + dato('Sucursal', sucNom(x.ID_Sucursal)) + dato('Vendedor', vend ? vend.nombre : x.Vendedor) +
        (nichos.length ? `<div class="fc-dato ancho"><small>Nicho de mercado</small><span class="multi-sel">${nichos.map(n => `<span class="chip-op on">${esc(n)}</span>`).join('')}</span></div>` : ''))}
      ${x.Comentarios ? seccion('📝 Comentarios', dato('', x.Comentarios, 1)) : ''}
      ${puede('seguimiento') ? `<div class="fc-sec"><h4>🤝 Seguimiento</h4><div id="fcSeg" data-id="${esc(c.id)}"><span class="muted">Cargando…</span></div>
        <div class="acciones izq"><button class="btn chico" onclick="App.formVisita({idCliente:'${esc(c.id)}'})">📅 Programar visita</button><button class="btn chico" onclick="App.formVisita({idCliente:'${esc(c.id)}', realizada:1})">✅ Registrar visita</button><button class="btn chico" onclick="App.visitasDeCliente('${esc(c.id)}')">📋 Sus visitas</button>
        ${puede('recetas') ? `<button class="btn chico" onclick="App.recetasDeCliente('${esc(c.id)}')">💊 Sus recetas</button>` : ''}</div></div>` : puede('recetas') ? `<div class="acciones izq"><button class="btn chico" onclick="App.recetasDeCliente('${esc(c.id)}')">💊 Sus recetas</button></div>` : ''}
      ${!admin ? '<p class="muted" style="margin-top:10px">🔒 Solo el administrador puede editar o eliminar clientes. Si algún dato está mal, solicita autorización.</p>' : ''}
      <div class="acciones">
        ${puede('seguimiento') || puede('recetas') || puede('ventas') ? `<button class="btn primario" onclick="App.historiaCliente('${esc(c.id)}')">📖 Historia clínica</button>` : ''}
        ${puede('ventas') ? `<button class="btn" onclick="App.ventasDeCliente('${esc(c.id)}','${esc(String(x.Razon_social || x.Nombre_cliente || '').replace(/'/g, ''))}')">🧾 Ver sus ventas</button><button class="btn" onclick="App.venderA('${esc(c.id)}')">🛒 Venderle</button>` : ''}
        ${puede('cobranza') ? `<button class="btn" onclick="App.verEdoCta('${esc(c.id)}')">📊 Estado de cuenta</button>` : ''}
        ${dueno ? `<button class="btn peligro" onclick="App.eliminarCliente('${esc(c.id)}')">🗑️ Eliminar</button>` : ''}
        ${admin ? `<button class="btn primario" onclick="App.formCliente(${i})">✏️ Editar</button>` : ''}
      </div></div>`);
    if (puede('seguimiento')) cargarSegFicha(c.id);
  }
  async function eliminarCliente(id) {
    const c = (D().clientes || []).find(z => z.id === id) || {};
    if (!confirm('¿Eliminar al cliente "' + (c.razon || c.nombre || id) + '"?\n\nSolo se puede si no tiene notas, cobros ni cotizaciones. Se guarda una copia en la hoja APP_Clientes_Eliminados.')) return;
    try {
      await pedir('eliminarCliente', { id: id });
      D().clientes = (D().clientes || []).filter(z => z.id !== id); LS.set('datos', S.datos);
      toast('✔ Cliente eliminado (copia en APP_Clientes_Eliminados)'); cerrarModal(); if (S.vista === 'clientes') V.clientes();
    } catch (e) {
      if (e.message && /dalo de baja/.test(e.message) && U().rol === 'Administrador' && (c.status || 'Activo') !== 'Inactivo' && confirm(e.message + '\n\n¿Quieres darlo de baja ahora (Estado: Inactivo)?')) {
        try { await pedir('guardarCliente', { ID_Cliente: id, Status: 'Inactivo' }); c.status = 'Inactivo'; LS.set('datos', S.datos); toast('✔ Cliente dado de baja'); cerrarModal(); if (S.vista === 'clientes') V.clientes(); } catch (e2) {}
      }
    }
  }
  async function guardarCliente() {
    const f = leerForm($('#fCli')), ini = S.formIni;
    const nuevo = !ini.ID_Cliente;
    if (!f.Nombre_cliente) return toast('Captura el nombre', true);
    const datos = nuevo ? f : soloCambios(ini, f);
    if (!nuevo && !Object.keys(datos).length) { const k = (S.lista || []).findIndex(z => z.id === ini.ID_Cliente); return S.vista === "clientes" && k >= 0 ? verCliente(k) : cerrarModal(); }
    datos.ID_Cliente = ini.ID_Cliente || uid();
    const local = { id: datos.ID_Cliente, nombre: f.Nombre_cliente, razon: f.Razon_social || f.Nombre_cliente, rancho: f.Nombre_Rancho || '', nicho: f['Nicho Mercado'] || '', rfc: f.RFC, lista: f.Lista_de_Precios || 'Publico', credito: Number(f.D_Credito) || 0,
      cel: f.Celular, localidad: f.Localidad, municipio: f['Municipio/Delegación'], estado: f.Estado, calle: f.Calle, colonia: f.Colonia, status: f.Status || 'Activo', suc: f.ID_Sucursal };
    const aplicarLocal = () => { const arr = D().clientes; const k = arr.findIndex(x => x.id === local.id); if (k >= 0) Object.assign(arr[k], local); else arr.push(local); LS.set('datos', S.datos); };
    const conArch = nuevo && [['cliFoto', '#cliFotoN'], ['cliCsf', '#cliCsfN']].some(x => $(x[1]) && $(x[1])._uri);
    try { await pedir('guardarCliente', datos); aplicarLocal(); toast('✔ Cliente guardado' + (conArch ? await subirArchNuevos([['cliFoto', '#cliFotoN'], ['cliCsf', '#cliCsfN']], datos.ID_Cliente) : '')); }
    catch (e) { if (!e.red) return; encolar('guardarCliente', datos, 'Cliente ' + local.nombre); aplicarLocal(); toast('📴 Cliente guardado en el dispositivo' + (conArch ? '. La foto y la constancia se adjuntan con conexión, desde la ficha del cliente.' : '')); }
    cerrarModal();
    if (S.formDesdeVenta === 'venta' && S.vista === 'venta') elegirClienteVenta(local.id);
    else if (S.formDesdeVenta === 'cot' && S.vista === 'cotizaciones' && S.cot) elegirClienteCot(local.id);
    else if (S.vista === 'clientes') { V.clientes(); const k = (S.lista || []).findIndex(z => z.id === local.id); if (!nuevo && k >= 0) verCliente(k); }
  }
  /** Historial completo de ventas de un cliente (todas las fechas y sucursales, por su ID). */
  function ventasDeCliente(id, nombre) { cerrarModal(); S.ventasCli = { id: id, nombre: nombre || id }; S.tabVen = 'notas'; ir('ventas', true); }
  function quitarFiltroCliente() { S.ventasCli = null; V.ventas('notas'); }
  /** Ventas de una sucursal (todas las fechas). */
  function ventasDeSucursal(id) { cerrarModal(); S.ventasCli = null; S.ventasSuc = id; S.tabVen = 'notas'; ir('ventas', true); }
  function venderA(id) { cerrarModal(); if (!S.venta) S.venta = ventaNueva(); ir('venta'); elegirClienteVenta(id); }

  /* ---------- SEGUIMIENTO DE CLIENTES: por atender, visitas y recetas (hojas Visita, Recetas, Detalle_Recetas) ---------- */
  const SEG_EST = { 'Toca comprar': ['🟢', 'ok'], 'Atrasado': ['🟠', 'av'], 'Dormido': ['🔴', 'mal'], 'Perdido': ['⚫', 'mal'], 'Al día': ['✔️', ''], 'Sin compras': ['—', ''] };
  const VIS_MOTIVOS = ['Presentación', 'Seguimiento', 'Toma de pedido', 'Entrega de cotización', 'Cobranza', 'Entrega', 'Asesoría técnica', 'Capacitación', 'Prospección', 'Otro'];
  const VIS_SIN_PEDIDO = ['Tiene inventario', 'Precio', 'Compra a otro proveedor', 'Sin dinero / crédito', 'No estaba', 'Lo pensará', 'Otro'];
  const RX_ESPECIES = ['Bovino', 'Equino', 'Ovino', 'Caprino', 'Porcino', 'Ave', 'Canino', 'Felino', 'Otro'];
  const esJefe = () => U().rol === 'Administrador' || U().rol === 'Gerente';
  const etqSeg = e => `<span class="etq ${(SEG_EST[e] || [])[1] || ''}">${(SEG_EST[e] || [''])[0]} ${esc(e)}</span>`;
  const hace = n => n === null || n === undefined ? '—' : n === 0 ? 'hoy' : n === 1 ? 'ayer' : 'hace ' + n + ' días';
  const telWa = cel => { const t = String(cel || '').replace(/\D/g, '').slice(-10); return t ? '52' + t : ''; };
  const sumaDias = (iso, n) => { const d = new Date((iso || hoyISO()) + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  function fichaCliente(id) {
    S.lista = D().clientes || []; const i = S.lista.findIndex(c => c.id === id);
    if (i < 0) return toast('Ese cliente no está en este dispositivo (actualiza los datos)', true);
    verCliente(i);
  }

  /* ----- Por atender ----- */
  V.seguimiento = () => {
    if (!puede('seguimiento')) return ir('recetas', true);
    const f = S.fSeg = S.fSeg || { estado: 'pendientes', suc: '', vend: '', q: '' };
    $('#vista').innerHTML = `<div class="tarjeta"><div class="fila">
        ${U().todasSucursales ? `<label>Sucursal<select id="sgSuc">${optsSuc(f.suc, true, 'Todas')}</select></label>` : ''}
        ${esJefe() ? `<label>Vendedor<select id="sgVend">${opts((D().vendedores || []).filter(v => U().todasSucursales || v.suc === U().sucursal).map(v => [v.id, v.nombre]), f.vend, 'Todos')}</select></label>` : ''}
        <label style="flex:2 1 220px">Buscar<input id="sgQ" value="${esc(f.q)}" placeholder="Cliente, rancho, localidad o producto"></label>
        <button class="btn fijo" onclick="App.cargarSeguimiento()">⟳ Actualizar</button></div>
        <p class="muted" style="margin:8px 0 0;font-size:13px">Con su historial de compras calculamos <b>cada cuántos días compra</b> cada cliente y qué productos le toca reponer. Atiende primero 🟢 a los que ya les toca y 🟠 a los atrasados, antes de que se duerman.</p></div>
      <div id="sgRes"><div class="vacio">Calculando…</div></div>`;
    if ($('#sgSuc')) $('#sgSuc').onchange = e => { f.suc = e.target.value; cargarSeguimiento(); };
    if ($('#sgVend')) $('#sgVend').onchange = e => { f.vend = e.target.value; cargarSeguimiento(); };
    $('#sgQ').oninput = e => { f.q = e.target.value; pintarSeguimiento(); };
    const k = f.suc + '|' + f.vend;
    if (S.seg && S.seg._k === k && Date.now() - S.seg._t < 600000) pintarSeguimiento(); else cargarSeguimiento();
  };
  async function cargarSeguimiento() {
    const f = S.fSeg; if (!f) return;
    if ($('#sgRes')) $('#sgRes').innerHTML = '<div class="vacio">Calculando…</div>';
    let r; try { r = await pedir('seguimiento', { suc: f.suc, vendedor: f.vend }, true); }
    catch (e) { if ($('#sgRes')) $('#sgRes').innerHTML = `<div class="vacio">${e.red ? 'Requiere conexión.' : esc(e.message)}</div>`; return; }
    r._k = f.suc + '|' + f.vend; r._t = Date.now(); S.seg = r;
    if ($('#sgRes')) pintarSeguimiento();
  }
  function segEstado(e) { S.fSeg.estado = e; S.fSeg.max = 0; pintarSeguimiento(); }
  function pintarSeguimiento() {
    const r = S.seg, f = S.fSeg, el = $('#sgRes'); if (!r || !el) return;
    const pend = ['Toca comprar', 'Atrasado', 'Dormido'];
    let l = r.clientes.filter(c => f.estado === 'todos' || (f.estado === 'pendientes' ? pend.indexOf(c.estado) >= 0 : c.estado === f.estado));
    if (f.q) l = l.filter(c => coincide([c.razon, c.nombre, c.rancho, c.localidad, c.nicho, c.toca.map(t => t.n).join(' ')].join(' '), f.q));
    const k = r.kpi, chip = (e, t, sub) => `<button class="kpi kpi-clic ${f.estado === e ? 'activo' : ''}" onclick="App.segEstado('${e}')"><small>${t}</small><b>${nf((k[e] || { n: 0 }).n)}</b><span>${sub || ''}</span></button>`;
    const sub = e => (k[e] && k[e].mensual) ? $$(k[e].mensual) + ' al mes' : '';
    const max = f.max || 60, vis = l.slice(0, max);
    el.innerHTML = `<div class="kpis sg-kpis">${chip('Toca comprar', '🟢 Les toca comprar', sub('Toca comprar'))}${chip('Atrasado', '🟠 Atrasados', sub('Atrasado'))}${chip('Dormido', '🔴 Dormidos', sub('Dormido'))}${chip('Perdido', '⚫ Perdidos', '+180 días sin comprar')}${chip('Al día', '✔️ Al día', '')}</div>
      <div class="pestanas sg-filtro"><button class="${f.estado === 'pendientes' ? 'activo' : ''}" onclick="App.segEstado('pendientes')">Por atender (${(k['Toca comprar'].n + k['Atrasado'].n + k['Dormido'].n)})</button><button class="${f.estado === 'todos' ? 'activo' : ''}" onclick="App.segEstado('todos')">Todos (${r.clientes.length})</button></div>
      ${!l.length ? '<div class="vacio">Nadie en esta lista. 👍</div>' : vis.map(segCard).join('')}
      ${l.length > max ? `<div class="acciones"><button class="btn" onclick="App.segMas()">Ver más (${l.length - max} restantes)</button></div>` : ''}`;
  }
  function segMas() { S.fSeg.max = (S.fSeg.max || 60) + 60; pintarSeguimiento(); }
  function segCard(c) {
    const nom = c.razon || c.nombre, otro = c.razon && c.nombre && c.razon !== c.nombre ? c.nombre : '';
    const msg = 'Hola ' + (c.nombre || nom).split(' ')[0] + ', le saluda ' + U().nombre + ' de Interés Veterinario. ' +
      (c.toca.length ? '¿Le apoyamos con su reposición de ' + c.toca.slice(0, 3).map(t => t.n).join(', ') + '?' : '¿Cómo va todo en el rancho? ¿Le apoyamos con algún producto?');
    const wa = telWa(c.cel), q = esc(c.id);
    return `<div class="sg-card">
      <div class="sg-cab">${etqSeg(c.estado)}<div class="sg-nom" onclick="App.fichaCliente('${q}')"><b>${esc(nom)}</b>${otro ? `<small>${esc(otro)}</small>` : ''}
        <small class="muted">${[c.rancho ? '🐄 ' + c.rancho : '', c.localidad, c.nicho, U().todasSucursales ? sucNom(c.suc) : ''].filter(Boolean).map(esc).join(' · ')}</small></div></div>
      <div class="sg-datos">
        <div><small>Última compra</small><b>${hace(c.sin)}</b><span>${esc(c.ult)}</span></div>
        <div><small>Compra cada</small><b>${c.cada ? c.cada + ' días' : '—'}</b><span>${c.esperado ? 'tocaba ' + esc(c.esperado) : ''}</span></div>
        <div><small>Promedio</small><b>${$$(c.mensual)}</b><span>al mes · ${c.compras12} compras/año</span></div>
        <div><small>Visita</small><b>${c.proxVisita ? '📅 ' + esc(c.proxVisita) : c.hVisita !== null ? hace(c.hVisita) : 'Nunca'}</b><span>${c.proxVisita ? 'programada' : c.ultVisita ? 'última ' + esc(c.ultVisita) : 'sin visitas'}</span></div>
        ${c.vencido > 0.009 ? `<div><small>Saldo vencido</small><b class="error">${$$(c.vencido)}</b><span>de ${$$(c.saldo)}</span></div>` : ''}
      </div>
      ${c.toca.length ? `<div class="sg-toca"><small>Le toca reponer:</small> ${c.toca.map(t => `<span class="chip-op on" title="Lo compra cada ${t.cada} días; la última vez fue hace ${t.hace}">${esc(t.n)} <small>cada ${t.cada} d · hace ${t.hace}</small></span>`).join('')}</div>` : ''}
      <div class="acciones izq">
        ${wa ? `<a class="btn chico" target="_blank" rel="noopener" href="${WA_BASE}${wa}?text=${encodeURIComponent(msg)}">💬 WhatsApp</a><a class="btn chico" href="tel:${wa.slice(2)}">📞 Llamar</a>` : ''}
        <button class="btn chico" onclick="App.formVisita({idCliente:'${q}'})">📅 Programar visita</button>
        <button class="btn chico" onclick="App.formVisita({idCliente:'${q}', realizada:1})">✅ Registrar visita</button>
        ${puede('ventas') ? `<button class="btn chico" onclick="App.venderA('${q}')">🛒 Venderle</button>` : ''}
      </div></div>`;
  }

  /* ---------- 🎯 RADAR COMERCIAL: a quién atender hoy, embudo de cotizaciones, recuperados y equipo ---------- */
  V.radar = () => {
    if (!puede('seguimiento')) return ir('recetas', true);
    const f = S.fRad = S.fRad || { suc: '', vend: '' };
    $('#vista').innerHTML = `<div class="tarjeta rd-filtros"><div class="fila">
        ${U().todasSucursales ? `<label>Sucursal<select id="rdSuc">${optsSuc(f.suc, true, 'Todas')}</select></label>` : ''}
        ${esJefe() ? `<label>Vendedor<select id="rdVend">${opts((D().vendedores || []).filter(v => U().todasSucursales || v.suc === U().sucursal).map(v => [v.id, v.nombre]), f.vend, 'Todos')}</select></label>` : ''}
        <div style="flex:3 1 240px" class="muted peq">Todo sale de tu historial de ventas, visitas y cotizaciones: no hay que capturar nada.</div>
        <button class="btn fijo" onclick="App.cargarRadar()">⟳ Actualizar</button></div></div>
      <div id="rdRes"><div class="vacio">🎯 Calculando el radar…</div></div>`;
    if ($('#rdSuc')) $('#rdSuc').onchange = e => { f.suc = e.target.value; cargarRadar(); };
    if ($('#rdVend')) $('#rdVend').onchange = e => { f.vend = e.target.value; cargarRadar(); };
    const k = f.suc + '|' + f.vend;
    if (S.radar && S.radar._k === k && Date.now() - S.radar._t < 600000) pintarRadar(); else cargarRadar();
  };
  async function cargarRadar() {
    const f = S.fRad; if (!f) return;
    const k = f.suc + '|' + f.vend;
    let r; try { r = await pedir('radar', { suc: f.suc, vendedor: f.vend }, true); }
    catch (e) {
      const g = LS.get('radar', null);
      if (e.red && g && g._k === k) { S.radar = g; S.radar._viejo = 1; return pintarRadar(); }
      if ($('#rdRes')) $('#rdRes').innerHTML = `<div class="vacio">${e.red ? 'El radar necesita conexión la primera vez.' : esc(e.message)}</div>`; return;
    }
    r._k = k; r._t = Date.now(); S.radar = r; LS.set('radar', r);
    if ($('#rdRes')) pintarRadar();
  }
  const rdCorto = n => String(n || '').split(',')[0].trim();
  function rdMsgPedido(c) {
    const quien = (c.nombre || c.razon || '').split(' ')[0];
    const lista = c.pedido.slice(0, 5).map(p => p.q + ' ' + rdCorto(p.n)).join(', ');
    return 'Hola ' + quien + ', le saluda ' + U().nombre.split(' ')[0] + ' de Interés Veterinario. ' +
      (lista ? 'Ya le toca su reposición: ' + lista + '. ¿Se lo preparo para enviárselo?' : 'Hace tiempo no le surtimos, ¿cómo va todo? ¿Le apoyamos con algo?');
  }
  function rdPlanCard(c, i) {
    const nom = c.razon || c.nombre, wa = telWa(c.cel), q = esc(c.id), r = S.radar;
    const pct = c.cada ? Math.min(100, Math.round(c.sin / (c.cada * 3) * 100)) : 0;
    return `<div class="rd-card">
      <div class="rd-top"><span class="rd-n">${i + 1}</span><div class="rd-nom" onclick="App.fichaCliente('${q}')"><b>${esc(nom)}</b>
        <small class="muted">${[c.rancho ? '🐄 ' + c.rancho : '', c.localidad, esJefe() && c.vendedor ? '👤 ' + c.vendedor : '', U().todasSucursales ? sucNom(c.suc) : ''].filter(Boolean).map(esc).join(' · ')}</small></div>${etqSeg(c.estado)}</div>
      <div class="rd-ritmo"><div class="rd-r1"><span>${c.cada ? `Compra cada <b>${c.cada} días</b> · lleva <b>${c.sin}</b> sin comprar` : `Lleva <b>${c.sin} días</b> sin comprar`}</span>${r.dinero && c.mensual ? `<span class="rd-din">${$$(c.mensual)}<small>/mes</small></span>` : ''}</div>
        ${c.cada ? `<div class="rd-barra" title="La raya es cuando le tocaba comprar"><i class="${c.estado === 'Toca comprar' ? 'ok' : c.estado === 'Atrasado' ? 'av' : 'mal'}" style="width:${pct}%"></i><em></em></div>` : ''}</div>
      ${c.pedido.length ? `<div class="rd-pedido"><small>🧺 Su pedido habitual</small>${c.pedido.map(p => `<span title="Lo compra cada ${p.cada} días · la última vez hace ${p.hace}"><b>${nf(p.q)}</b> ${esc(rdCorto(p.n))}</span>`).join('')}</div>` : ''}
      ${c.vencido ? `<div class="rd-aviso">⚠️ Tiene saldo vencido de ${$$(c.vencido)}: conviene cobrar antes de surtir.</div>` : ''}
      <div class="acciones izq">
        ${wa ? `<a class="btn chico primario" target="_blank" rel="noopener" href="${WA_BASE}${wa}?text=${encodeURIComponent(rdMsgPedido(c))}">💬 WhatsApp</a>` : ''}
        ${c.pedido.length && puede('cotizaciones') ? `<button class="btn chico" onclick="App.pedidoHabitual('${q}','cot')">📝 Cotizarle su pedido</button>` : ''}
        ${puede('ventas') ? `<button class="btn chico" onclick="App.pedidoHabitual('${q}','venta')">🛒 ${c.pedido.length ? 'Venderle su pedido' : 'Venderle'}</button>` : ''}
        ${wa ? `<a class="btn chico" href="tel:${wa.slice(2)}">📞</a>` : ''}
        <button class="btn chico" onclick="App.formVisita({idCliente:'${q}', realizada:1})" title="Registrar que ya lo atendiste (sale del plan)">✅ Atendido</button>
      </div></div>`;
  }
  function pintarRadar() {
    const r = S.radar, el = $('#rdRes'); if (!r || !el) return;
    const s = r.resumen, e = r.embudo, din = r.dinero;
    const alDia = Math.max(0, s.activos - s.toca - s.atrasados - s.dormidos);
    const seg = (n, cls, t) => n ? `<i class="${cls}" style="flex:${n}" title="${t}: ${n}"></i>` : '';
    const mx = Math.max(1, ...e.etapas.map(x => din ? x.monto || 0 : x.n));
    const hero = `<div class="rd-hero">
        <div class="rd-h-main"><small>💰 ${din ? 'Venta mensual en juego' : 'Clientes por atender'}</small><b>${din ? $$(s.enJuego) : nf(s.porAtender)}</b>
          <span>${nf(s.porAtender)} clientes por atender: ${nf(s.toca)} les toca, ${nf(s.atrasados)} atrasados y ${nf(s.dormidos)} dormidos${din ? ' · ' + $$(s.enJuego * 12) + ' al año' : ''}</span>
          <div class="rd-salud" title="Salud de tu cartera activa">${seg(alDia, 'ok', 'Al día')}${seg(s.toca, 'ok2', 'Les toca')}${seg(s.atrasados, 'av', 'Atrasados')}${seg(s.dormidos, 'mal', 'Dormidos')}</div>
          <small class="rd-leyenda"><i class="ok"></i>Al día ${s.alDiaPct !== null ? s.alDiaPct + '%' : ''} <i class="ok2"></i>Les toca <i class="av"></i>Atrasados <i class="mal"></i>Dormidos</small></div>
        <div class="rd-h-stats">
          <div><small>🏆 Recuperados · 30 días</small><b>${din ? $$(r.recuperados.monto) : nf(r.recuperados.n)}</b><span>${r.recuperados.n === 1 ? '1 cliente volvió' : nf(r.recuperados.n) + ' clientes volvieron'}</span></div>
          <div><small>📝 Cotizaciones abiertas</small><b>${din ? $$(e.abiertas.monto) : nf(e.abiertas.n)}</b><span>${nf(e.abiertas.n)} por cerrar</span></div>
          <div><small>🎯 Cierre de cotizaciones</small><b>${e.conversion !== null ? e.conversion + '%' : '—'}</b><span>${e.cerradas ? 'de ' + nf(e.cerradas) + ' cerradas en 90 días' : 'sin cotizaciones cerradas'}</span></div>
          <div><small>🧊 Sin atender</small><b>${nf(s.sinAtender)}</b><span>${nf(s.enAgenda)} en agenda · ${nf(s.atendidos)} visitados · ${nf(s.conCot)} con cotización</span></div>
        </div></div>${r._viejo ? `<div class="aviso-cand">📴 Sin conexión: es el radar que se calculó a las ${new Date(r._t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}.</div>` : ''}`;
    const plan = `<div class="tarjeta"><h3>🎯 Tu plan de hoy</h3>
        <p class="muted peq" style="margin-top:-4px">Los clientes con <b>más dinero en juego</b> que nadie ha atendido: sin visita en los últimos 5 días, sin visita programada y sin cotización abierta. Al atenderlos salen de aquí.</p>
        ${r.plan.length ? `<div class="rd-grid">${r.plan.map(rdPlanCard).join('')}</div>` : '<div class="vacio">🎉 Todos tus clientes por atender ya tienen algo en marcha.</div>'}
        ${s.sinAtender > r.plan.length ? `<div class="acciones izq"><button class="btn chico" onclick="App.ir('seguimiento',true)">Ver los ${nf(s.porAtender)} por atender →</button></div>` : ''}</div>`;
    const emb = `<div class="tarjeta"><h3>📈 Embudo de cotizaciones <small class="muted">· últimos 90 días</small></h3>
        <div class="rd-emb">${e.etapas.map(x => { const v = din ? x.monto || 0 : x.n; return `<div class="rd-et"><span>${esc(x.t)}</span><div><i class="${x.tono}" style="width:${Math.max(x.n ? 3 : 0, Math.round(v / mx * 100))}%"></i></div><b>${nf(x.n)}${din ? ' · ' + $$(x.monto) : ''}</b></div>`; }).join('')}</div>
        <p class="muted peq">${e.conversion !== null ? `Cierras <b>${e.conversion}%</b> de las cotizaciones que se resuelven` : 'Aún no hay cotizaciones resueltas'}${din && e.vendido ? ` · vendido desde cotización: <b>${$$(e.vendido)}</b>` : ''}${e.canceladas ? ` · ${nf(e.canceladas)} ${e.canceladas === 1 ? 'perdida' : 'perdidas'}` : ''}.</p>
        ${e.enfriando.length ? `<h4 style="margin:14px 0 6px">🧊 Se están enfriando: dales seguimiento hoy</h4>${e.enfriando.map(c => { const wa = telWa(c.cel);
          const msg = 'Hola ' + (c.nombre || c.cliente).split(' ')[0] + ', le saluda ' + U().nombre.split(' ')[0] + ' de Interés Veterinario. ¿Pudo revisar la cotización ' + c.folio + '? Con gusto le ajusto cantidades o precios para cerrarla.';
          return `<div class="rd-fila"><div><b>${esc(c.cliente)}</b><small class="muted">${esc(c.folio)} · ${esc(c.fecha)} · hace ${c.edad} días${c.vendedor && esJefe() ? ' · ' + esc(c.vendedor) : ''}</small></div>
            <span class="etq ${c.estado === 'Vencida' ? 'mal' : 'av'}">${c.estado === 'Vencida' ? 'Vencida' : 'Abierta'}</span>${din ? `<b class="num">${$$(c.total)}</b>` : ''}
            <div class="lin-btns">${wa ? `<a class="btn chico" target="_blank" rel="noopener" href="${WA_BASE}${wa}?text=${encodeURIComponent(msg)}" title="Dar seguimiento por WhatsApp">💬</a>` : ''}${c.estado === 'Vencida' && puede('cotizaciones') ? `<button class="btn chico" title="Renovar / reabrir" onclick="App.reabrirCot('${esc(c.id)}')">🔄</button>` : ''}${puede('cotizaciones') ? `<button class="btn chico" title="Se perdió" onclick="App.cancelarCot('${esc(c.id)}')">❌</button>` : ''}<button class="btn chico" onclick="App.verCot('${esc(c.id)}')">Ver</button></div></div>`; }).join('')}` : ''}</div>`;
    const pe = r.perdidas, pmx = pe ? Math.max(1, ...pe.motivos.map(m => din ? m.monto || 0 : m.n)) : 1;
    const perd = pe ? `<div class="tarjeta"><h3>💔 ¿Por qué se pierden las ventas? <small class="muted">· últimos 90 días</small></h3>
        ${!pe.n ? '<div class="vacio">No se ha perdido ninguna cotización en 90 días. 👏</div>' : `
        <p class="muted peq" style="margin-top:-4px"><b>${nf(pe.n)}</b> ${pe.n === 1 ? 'cotización' : 'cotizaciones'}${din ? ' por <b>' + $$(pe.monto) + '</b>' : ''} no se ${pe.n === 1 ? 'vendió' : 'vendieron'}.${pe.sinClasificar ? ` ${nf(pe.sinClasificar)} vencieron sin que nadie dijera por qué: ábrelas desde "Se están enfriando" y márcalas con ❌ o 🔄.` : ''}</p>
        <div class="rd-emb">${pe.motivos.map(m => { const v = din ? m.monto || 0 : m.n, venc = /^Vencida/.test(m.t), sin = /^Sin motivo/.test(m.t);
          return `<div class="rd-et"><span>${venc ? '⌛' : sin ? '❔' : COT_MOT_ICO[m.t] || '✏️'} ${esc(m.t)}</span><div><i class="${venc || sin ? '' : 'mal'}" style="width:${Math.max(3, Math.round(v / pmx * 100))}%;${venc || sin ? 'opacity:.45' : ''}"></i></div><b>${nf(m.n)}${din ? ' · ' + $$(m.monto) : ''}</b></div>`; }).join('')}</div>
        ${pe.productos.length ? `<h4 style="margin:12px 0 6px">Productos que más se quedan sin vender</h4>${pe.productos.map(x => `<div class="rd-fila"><div><b>${esc(rdCorto(x.n))}</b><small class="muted">en ${nf(x.veces)} cotizaci${x.veces === 1 ? 'ón' : 'ones'} · ${nf(x.piezas)} piezas</small></div>${din ? `<b class="num">${$$(x.monto)}</b>` : ''}</div>`).join('')}` : ''}`}</div>` : '';
    const rec = `<div class="tarjeta"><h3>🏆 Recuperados en 30 días</h3>
        ${r.recuperados.lista.length ? r.recuperados.lista.map(c => `<div class="rd-fila"><div><b>${esc(c.nombre)}</b><small class="muted">Volvió el ${esc(c.ult)} después de <b>${c.dias} días</b> (compraba cada ${c.antes})${c.vendedor && esJefe() ? ' · ' + esc(c.vendedor) : ''}</small></div>${din ? `<b class="num ok-txt">${$$(c.monto)}</b>` : ''}</div>`).join('')
          : '<div class="vacio">Aquí aparecen los clientes que vuelven a comprar después de una pausa mayor a su costumbre.</div>'}</div>`;
    const eq = r.equipo && r.equipo.length ? `<div class="tarjeta"><h3>👥 Tu equipo</h3>${tabla([{ t: 'Vendedor', k: 'nombre' }, { t: 'Clientes', num: 1, h: x => nf(x.clientes) }, { t: 'Al día', num: 1, h: x => x.alDiaPct === null ? '—' : x.alDiaPct + '%' },
        { t: 'Por atender', num: 1, h: x => nf(x.porAtender) }].concat(din ? [{ t: 'En juego / mes', num: 1, h: x => $$(x.enJuego) }] : [])
        .concat([{ t: 'Recuperados', num: 1, h: x => nf(x.recup) + (din && x.recupMonto ? ' · ' + $$(x.recupMonto) : '') }, { t: 'Cotiz. abiertas', num: 1, h: x => nf(x.cotAb) + (din && x.cotAbMonto ? ' · ' + $$(x.cotAbMonto) : '') },
          { t: 'Cierre', num: 1, h: x => x.conversion === null ? '—' : x.conversion + '%' }]), r.equipo)}</div>` : '';
    el.innerHTML = hero + plan + `<div class="rejilla-2">${emb}${perd}</div>` + rec + eq;
  }
  /** Del radar: cotización o venta nueva con el pedido habitual del cliente (sus productos y la cantidad que suele llevar) a su lista de precios. */
  function pedidoHabitual(id, modo) {
    const c = ((S.radar || {}).plan || []).find(x => x.id === id), cl = cliente(id); if (!c || !cl) return;
    const listas = (D().catalogos || {}).listas || [], lista = cl.lista && listas.indexOf(cl.lista) >= 0 ? cl.lista : 'Publico';
    const lineas = c.pedido.filter(p => prod(p.id)).map(p => ({ id: p.id, cant: p.q, precio: (prod(p.id).precios || {})[lista] || 0, desc: 0, lote: '' }));
    if (modo === 'cot') {
      if (S.cot && S.cot.lineas && S.cot.lineas.length && !confirm('Tienes una cotización en captura que se va a reemplazar. ¿Continuar?')) return;
      const v = cotNueva(); v.cli = id; v.lista = lista; v.obs = ''; v.lineas = lineas.map(l => ({ id: l.id, cant: l.cant, precio: l.precio, desc: 0 }));
      S.cot = v; LS.set('borrador_cot', v); S.tabCot = 'nueva'; ir('cotizaciones', true);
    } else {
      if (S.venta && S.venta.lineas && S.venta.lineas.length && !confirm('Tienes una venta en captura que se va a reemplazar. ¿Continuar?')) return;
      S.venta = ventaNueva(); S.venta.lineas = lineas; ir('venta'); elegirClienteVenta(id);
    }
    if (lineas.length) toast('🧺 Pedido habitual cargado: revisa cantidades y existencias');
  }

  /* ---------- 🏆 METAS Y COMISIONES ---------- */
  const MT_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const mtMesTxt = k => k ? MT_MES[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4) : '';
  const mtMesCorto = k => MT_MES[+k.slice(5, 7) - 1].slice(0, 3);
  V.metas = () => {
    if (!puede('seguimiento')) return ir('recetas', true);
    const f = S.fMeta = S.fMeta || { mes: '', suc: '' };
    $('#vista').innerHTML = `<div class="tarjeta"><div class="fila">
        <label>Mes<input type="month" id="mtMes" value="${esc(f.mes || hoyISO().slice(0, 7))}"></label>
        ${U().todasSucursales ? `<label>Sucursal<select id="mtSuc">${optsSuc(f.suc, true, 'Todas')}</select></label>` : ''}
        <div style="flex:3 1 240px" class="muted peq">Venta neta sin IVA (la misma de Inicio). La comisión se calcula sobre lo vendido o lo cobrado, según la regla de cada vendedor.</div>
        <button class="btn fijo" onclick="App.cargarMetas()">⟳ Actualizar</button></div></div><div id="mtRes"><div class="vacio">🏆 Calculando…</div></div>`;
    $('#mtMes').onchange = e => { f.mes = e.target.value; cargarMetas(); };
    if ($('#mtSuc')) $('#mtSuc').onchange = e => { f.suc = e.target.value; cargarMetas(); };
    cargarMetas();
  };
  async function cargarMetas() {
    const f = S.fMeta; if (!f) return;
    let r; try { r = await pedir('metas', { mes: f.mes, suc: f.suc }, true); }
    catch (e) { const g = LS.get('metas', null); if (e.red && g && g.mes === (f.mes || g.mesActual)) { S.metas = g; return pintarMetas(); }
      if ($('#mtRes')) $('#mtRes').innerHTML = `<div class="vacio">${e.red ? 'Requiere conexión.' : esc(e.message)}</div>`; return; }
    S.metas = r; LS.set('metas', r); if ($('#mtRes')) pintarMetas();
  }
  /** esperado: % del mes transcurrido (verde si va al ritmo o mejor, ámbar si va hasta 15 puntos abajo, rojo si más). */
  function anillo(pct, tam, txt, esperado) {
    const r = 42, c = 2 * Math.PI * r, p = pct === null ? 0 : Math.max(0, Math.min(100, pct)), ref = esperado === undefined ? 100 : esperado;
    const cls = pct === null ? '' : pct >= 100 || pct >= ref ? 'ok' : pct >= ref - 15 ? 'av' : 'mal';
    return `<svg class="mt-anillo ${cls}" width="${tam}" height="${tam}" viewBox="0 0 100 100" role="img" aria-label="${pct === null ? 'sin meta' : pct + '%'}"><circle cx="50" cy="50" r="${r}" class="fondo"/><circle cx="50" cy="50" r="${r}" class="val" stroke-dasharray="${(c * p / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>
      <text x="50" y="${txt ? 49 : 56}" text-anchor="middle" class="pct">${pct === null ? '—' : pct + '%'}</text>${txt ? `<text x="50" y="66" text-anchor="middle" class="sub">${esc(txt)}</text>` : ''}</svg>`;
  }
  function mtCard(v, i, r) {
    const din = r.dinero, m = v.meta, esperado = r.diasMes ? Math.round(r.transcurridos / r.diasMes * 100) : 0, actual = r.mes === r.mesActual;
    const med = v.avance !== null && i < 3 && r.vendedores.length > 1 ? ['🥇', '🥈', '🥉'][i] : '';
    const ritmo = v.avance === null || !actual ? '' : v.avance >= esperado ? `<span class="etq ok">▲ ${v.avance - esperado} pts arriba del ritmo</span>` : `<span class="etq av">▼ ${esperado - v.avance} pts abajo del ritmo</span>`;
    const hmx = Math.max(1, ...v.historia.map(h => Math.max(h.venta || 0, h.meta || 0)));
    return `<div class="mt-card${v.yo ? ' yo' : ''}">
      <div class="mt-top">${anillo(v.avance, 92, m ? 'de la meta' : 'sin meta', actual ? esperado : 100)}<div class="mt-nom"><b>${med} ${esc(v.nombre)}</b><small class="muted">${esc(sucNom(v.suc))}${v.yo ? ' · tú' : ''}</small>
        ${m ? `<div class="mt-venta">${din ? `<b>${$$(v.venta)}</b> <small>de ${$$(m.venta)}</small>` : `<b>${v.avance}%</b>`}</div>${ritmo}` : `<div class="mt-venta">${din ? `<b>${$$(v.venta)}</b> <small>vendido</small>` : ''}</div>`}</div>
        ${r.puedeDefinir ? `<button class="btn chico fijo" onclick="App.formMeta('${esc(v.id)}')">⚙️ ${m ? 'Meta' : 'Definir meta'}</button>` : ''}</div>
      ${m && m.venta ? `<div class="mt-barra" title="La raya marca dónde deberías ir hoy (${esperado}% del mes)"><i class="${v.avance >= 100 ? 'ok' : v.avance >= esperado ? 'ok2' : 'av'}" style="width:${Math.min(100, v.avance)}%"></i>${actual ? `<em style="left:${esperado}%"></em>` : ''}</div>` : ''}
      <div class="mt-datos">
        ${m && m.venta && actual ? `<div><small>Al cierre, a este ritmo</small><b>${din ? $$(v.proyeccion) : ''} <span class="${v.proyPct >= 100 ? 'ok-txt' : 'error'}">${v.proyPct}%</span></b></div>
          <div><small>${v.falta ? 'Te faltan' : '¡Meta lograda!'}</small><b>${v.falta ? (din ? $$(v.falta) : '') + (r.restan ? ` <span class="muted">· ${din ? $$(v.porDia) : ''}/día en ${r.restan} d</span>` : '') : '🎉'}</b></div>` : ''}
        <div><small>Clientes que compraron</small><b>${nf(v.clientes)}${m && m.clientes ? ` <span class="muted">de ${nf(m.clientes)}</span>` : ''}</b></div>
        <div><small>Notas · ticket</small><b>${nf(v.notas)}${din ? ` <span class="muted">· ${$$(v.ticket)}</span>` : ''}</b></div>
        <div><small>Visitas realizadas</small><b>${nf(v.visitas)}</b></div>
        <div><small>Cotizaciones vendidas</small><b>${nf(v.cotVend)} <span class="muted">de ${nf(v.cotEm)}</span></b></div>
      </div>
      ${m && m.comision !== null && din ? `<div class="mt-com"><div><small>💰 Comisión ${actual ? 'ganada hasta hoy' : 'del mes'}</small><b>${$$(v.comision)}</b><span class="muted">${m.comision}% de lo ${m.base === 'Cobrado' ? 'cobrado' : 'vendido'}${m.bono ? ` · +${m.bono}% de bono al llegar a la meta` : ''}${v.conBono ? ' <span class="etq ok">🎉 bono ganado</span>' : ''}</span></div>
        ${actual && v.comisionProy !== null ? `<div><small>Si sigue así</small><b>${$$(v.comisionProy)}</b></div>` : ''}</div>` : ''}
      <div class="mt-hist" title="Últimos 6 meses: barra = venta · raya = meta">${v.historia.map(h => `<div><span><i style="height:${Math.round((h.venta || 0) / hmx * 100)}%" class="${h.pct === null ? '' : h.pct >= 100 ? 'ok' : 'av'}"></i>${h.meta ? `<em style="bottom:${Math.round(h.meta / hmx * 100)}%"></em>` : ''}</span><small>${mtMesCorto(h.mes)}${h.pct !== null ? '<br>' + h.pct + '%' : ''}</small></div>`).join('')}</div>
    </div>`;
  }
  function pintarMetas() {
    const r = S.metas, el = $('#mtRes'); if (!r || !el) return;
    const e = r.equipo, varios = r.vendedores.length > 1, esperado = r.diasMes ? Math.round(r.transcurridos / r.diasMes * 100) : 0;
    const hero = varios || r.puedeDefinir ? `<div class="mt-hero">${anillo(e.avance, 120, 'del equipo', r.mes === r.mesActual ? esperado : 100)}<div><small>🏆 ${esc(mtMesTxt(r.mes))}${r.mes === r.mesActual ? ` · día ${r.transcurridos} de ${r.diasMes} (deberían ir en ${esperado}%)` : ''}</small>
        <b>${r.dinero ? $$(e.venta) : (e.avance !== null ? e.avance + '%' : '—')}</b><span>${e.meta ? (r.dinero ? 'de una meta de ' + $$(e.meta) : 'de la meta del equipo') : 'Aún no hay metas definidas para este mes'}${e.comisiones !== null && r.dinero ? ' · comisiones a pagar: <b>' + $$(e.comisiones) + '</b>' : ''}</span></div></div>` : '';
    el.innerHTML = hero + (r.vendedores.length ? `<div class="mt-grid">${r.vendedores.map((v, i) => mtCard(v, i, r)).join('')}</div>`
      : '<div class="vacio">No hay vendedores con ventas, visitas o metas en este mes.</div>');
  }
  function formMeta(id) {
    const r = S.metas, v = r && r.vendedores.find(x => x.id === id); if (!v) return;
    const m = v.meta || {}, hist = v.historia.filter(h => h.mes < r.mesActual && h.venta).slice(-3);
    const sug = hist.length ? Math.round(hist.reduce((t, h) => t + h.venta, 0) / hist.length * 1.1 / 1000) * 1000 : 0;
    modal('🏆 Meta de ' + v.nombre, `<div class="rejilla-2" style="gap:10px">
        <label>Meta de venta del mes (sin IVA)<input type="number" id="fmVenta" min="0" step="1000" value="${m.venta || ''}" placeholder="${sug || ''}">${sug ? `<small class="muted">Sugerida: ${$$(sug)} (promedio de ${hist.length} mes${hist.length === 1 ? '' : 'es'} + 10 %) · <a href="#" onclick="$('#fmVenta').value=${sug};return false">usar</a></small>` : ''}</label>
        <label>Meta de clientes que le compran<input type="number" id="fmCli" min="0" step="1" value="${m.clientes || ''}"></label>
        <label>Comisión %<input type="number" id="fmCom" min="0" max="50" step="0.1" value="${m.comision !== undefined && m.comision !== null ? m.comision : ''}" placeholder="Ej. 3"></label>
        <label>Se calcula sobre<select id="fmBase"><option value="Vendido" ${m.base !== 'Cobrado' ? 'selected' : ''}>Lo vendido en el mes</option><option value="Cobrado" ${m.base === 'Cobrado' ? 'selected' : ''}>Lo cobrado en el mes (sin IVA)</option></select></label>
        <label>Bono extra al llegar a su meta (%)<input type="number" id="fmBono" min="0" max="50" step="0.1" value="${m.bono || ''}" placeholder="Ej. 1"></label>
        <label>Aplica para<select id="fmMes"><option value="">Todos los meses</option><option value="${esc(r.mes)}" ${m.soloEsteMes ? 'selected' : ''}>Solo ${esc(mtMesTxt(r.mes))}</option></select></label></div>
      <p class="muted peq">La comisión nunca se calcula sobre la utilidad. "Solo este mes" manda sobre la de todos los meses.</p>
      <div class="acciones">${v.meta ? `<button class="btn peligro" onclick="App.guardarMeta('${esc(id)}', true)">Quitar esta meta</button>` : ''}<button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.guardarMeta('${esc(id)}')">Guardar</button></div>`);
  }
  async function guardarMeta(id, quitar) {
    const r = S.metas, mesSel = quitar ? ((r.vendedores.find(x => x.id === id) || {}).meta || {}).soloEsteMes ? r.mes : '' : $('#fmMes').value;
    if (quitar && !confirm('¿Quitar la meta' + (mesSel ? ' de ' + mtMesTxt(mesSel) : ' de todos los meses') + '?')) return;
    const p = quitar ? { idVendedor: id, mes: mesSel, quitar: 1 } : { idVendedor: id, mes: mesSel, metaVenta: $('#fmVenta').value, metaClientes: $('#fmCli').value, comisionPct: $('#fmCom').value || 0, base: $('#fmBase').value, bonoPct: $('#fmBono').value || 0 };
    if (!quitar && !(Number(p.metaVenta) > 0) && !(Number(p.metaClientes) > 0)) return toast('Captura la meta de venta o de clientes', true);
    try { await pedir('guardarMeta', p); toast(quitar ? 'Meta quitada' : '✔ Meta guardada'); cerrarModal(); cargarMetas(); } catch (e) {}
  }

  /* ---------- 📊 DASHBOARD: análisis y comparativos por año (cliente, producto, proveedor, categoría, sucursal, vendedor) ---------- */
  const TB_COL = ['#1f6f4a', '#2a78d6', '#d95926', '#8e44ad', '#c79a00', '#199e70', '#6b7280', '#b03a6b'];
  const TB_TABS = [['resumen', '📈 Resumen por año'], ['clientes', '👥 Clientes'], ['productos', '💊 Productos'], ['proveedores', '🏭 Proveedores'], ['categorias', '🏷️ Categorías'], ['sucursales', '🏬 Sucursales'], ['vendedores', '👤 Vendedores']];
  const TB_TIPO = { clientes: 'cliente', productos: 'producto', proveedores: 'proveedor', categorias: 'categoria', sucursales: 'sucursal', vendedores: 'vendedor' };
  const MES3 = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  V.tablero = (tab) => {
    const f = S.fTb = S.fTb || { tab: 'resumen', suc: '', a: '', b: '', met: '', q: '', filtro: '', orden: 'a', aFecha: true };
    if (tab) f.tab = tab;
    $('#vista').innerHTML = `<div class="tarjeta"><div class="fila">
        ${U().todasSucursales ? `<label>Sucursal<select id="tbSuc">${optsSuc(f.suc, true, 'Todas')}</select></label>` : ''}
        <div class="tb-anios"><small>Años a comparar <span class="muted">(toca para elegir varios; el más reciente es el principal)</span></small><div class="multi-sel" id="tbAnios"></div></div>
        <label id="tbFechaL" class="fijo" style="align-self:flex-end;display:flex;gap:6px;align-items:center;white-space:nowrap"><input type="checkbox" id="tbFecha" ${f.aFecha ? 'checked' : ''} style="width:auto"> A la misma fecha</label>
        <button class="btn fijo" onclick="App.cargarTablero(true)">⟳ Actualizar</button></div>
        <p class="muted peq" style="margin:8px 0 0">Venta neta sin IVA (igual que Inicio). Compras: órdenes con factura o nota del proveedor. Toca cualquier renglón para ver su detalle mes a mes de cada año.</p></div>
      <div class="pestanas" id="tbTabs"></div><div id="tbRes"><div class="vacio">📊 Reuniendo todos tus años…</div></div>`;
    if ($('#tbSuc')) $('#tbSuc').onchange = e => { f.suc = e.target.value; cargarTablero(true); };
    $('#tbFecha').onchange = e => { f.aFecha = e.target.checked; pintarTablero(); };
    cargarTablero();
  };
  async function cargarTablero(forzar) {
    const f = S.fTb; if (!f) return;
    if (!forzar && S.tb && S.tb._suc === f.suc && Date.now() - S.tb._t < 900000) return pintarTablero();
    if ($('#tbRes')) $('#tbRes').innerHTML = '<div class="vacio">📊 Reuniendo todos tus años…</div>';
    let r; try { r = await pedir('analisis', { sucursal: f.suc }, true); }
    catch (e) { if ($('#tbRes')) $('#tbRes').innerHTML = `<div class="vacio">${e.red ? 'El Dashboard necesita conexión la primera vez.' : /desconocida/i.test(e.message) ? '📊 El Dashboard se activa en cuanto se publique la actualización del servidor (156).' : esc(e.message)}</div>`; return; }
    r._suc = f.suc; r._t = Date.now(); S.tb = r;
    const an = r.anios.slice().reverse();
    f.sel = (f.sel || []).filter(y => an.indexOf(+y) >= 0);
    if (!f.sel.length) f.sel = an.slice(0, 2).map(String);
    tbFijarAB(); pintarTablero();
  }
  /** Años elegidos (más reciente primero): el principal (a) es el más reciente y b el que le sigue. */
  const tbSel = () => (S.fTb.sel || []).slice().sort((x, y) => y - x);
  function tbFijarAB() { const f = S.fTb, l = tbSel(); f.a = l[0]; f.b = l[1] || l[0]; }
  function tbAnio(y) {
    const f = S.fTb, y2 = String(y), i = f.sel.indexOf(y2);
    if (i >= 0) { if (f.sel.length === 1) return toast('Deja al menos un año', true); f.sel.splice(i, 1); } else f.sel.push(y2);
    tbFijarAB(); pintarTablero();
  }
  /** Meses que cuentan: con "a la misma fecha" y el año elegido es el actual, solo enero → mes actual en los dos años. */
  function tbMeses() { const f = S.fTb, hoy = new Date(); return f.aFecha && +f.a === hoy.getFullYear() ? hoy.getMonth() + 1 : 12; }
  function tbVar(a, b, malSiSube) {
    if (!b && !a) return '<span class="muted">—</span>'; if (!b) return '<span class="etq ok">nuevo</span>'; if (!a) return '<span class="etq mal">sin venta</span>';
    const p = (a - b) / Math.abs(b) * 100, bien = malSiSube ? p <= 0 : p >= 0;
    return `<span class="etq ${Math.abs(p) < 0.05 ? '' : bien ? 'ok' : 'mal'}">${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p).toFixed(1)}%</span>`;
  }
  function pintarTablero() {
    const r = S.tb, f = S.fTb, el = $('#tbRes'); if (!r || !el) return;
    S.charts.forEach(c => c.destroy()); S.charts = [];
    const an = r.anios.slice().reverse(), colA = y => TB_COL[(r.anios.length - 1 - r.anios.indexOf(+y)) % TB_COL.length];
    $('#tbAnios').innerHTML = an.map(y => { const on = f.sel.indexOf(String(y)) >= 0; return `<button class="chip-op ${on ? 'on' : ''}" onclick="App.tbAnio(${y})" style="${on ? `border-color:${colA(y)};box-shadow:inset 0 -3px 0 ${colA(y)}` : ''}">${on ? '✔ ' : ''}${y}${y === new Date().getFullYear() ? ' <small>(en curso)</small>' : ''}</button>`; }).join('');
    $('#tbFechaL').style.display = +f.a === new Date().getFullYear() && f.sel.length > 1 ? '' : 'none';
    const tabs = TB_TABS.filter(([k]) => k !== 'proveedores' || r.verCompras).filter(([k]) => k !== 'sucursales' || r.sucursales);
    if (!tabs.some(t => t[0] === f.tab)) f.tab = 'resumen';
    $('#tbTabs').innerHTML = tabs.map(([k, t]) => `<button class="${f.tab === k ? 'activo' : ''}" onclick="App.tbTab('${k}')">${t}</button>`).join('');
    if (!r.anios.length) { el.innerHTML = '<div class="vacio">Aún no hay ventas registradas.</div>'; return; }
    if (f.tab === 'resumen') return pintarTbResumen(el);
    pintarTbEntidad(el, f.tab);
  }
  function tbTab(k) { const f = S.fTb; f.tab = k; f.q = ''; f.filtro = ''; f.orden = 'a'; f.met = ''; pintarTablero(); }
  function pintarTbResumen(el) {
    const r = S.tb, f = S.fTb, din = r.dinero, nm = tbMeses();
    const A = r.anual.find(x => String(x.anio) === String(f.a)) || r.anual[r.anual.length - 1], B = r.anual.find(x => String(x.anio) === String(f.b));
    const FK = { v: 'ventas', c: 'compras', u: 'utilidad', mer: 'mermas' }, corte = tbCorte();
    const suma = (x, k) => !x ? 0 : corte && x.fecha ? (x.fecha[FK[k]] || 0) : x.meses.slice(0, nm).reduce((t, m) => t + (m[k] || 0), 0);
    const cuenta = (x) => !x ? 0 : corte && x.fecha ? x.fecha.notas : x.meses.slice(0, nm).reduce((t, m) => t + m.n, 0);
    const vA = suma(A, 'v'), vB = suma(B, 'v'), uA = suma(A, 'u'), uB = suma(B, 'u'), nA = cuenta(A), nB = cuenta(B);
    const sel = tbSel(), anu = y => r.anual.find(x => String(x.anio) === String(y));
    // una tarjeta: el año principal y, debajo, cada año elegido con el cambio del principal contra él
    const tileM = (t, fx, fmt, mal) => { const v = sel.map(y => fx(anu(y))); return `<div class="kpi"><small>${t} · ${sel[0]}</small><b>${fmt(v[0])}</b><span class="tb-cmps">${sel.slice(1).map((y, i) => `<span>${tbVar(v[0], v[i + 1], mal)} vs ${y}: ${fmt(v[i + 1])}</span>`).join('') || '<span class="muted">elige otro año para comparar</span>'}</span></div>`; };
    const tile = (t, a, b, fmt, mal, fx) => tileM(t, fx, fmt, mal);
    const per = corte ? `del 1 de enero al ${r.corte} de cada año` : 'año completo';
    const cli = X => !X ? 0 : corte && X.fecha ? X.fecha.clientes : X.clientes;
    const margenTile = () => { const m = sel.map(y => { const X = anu(y), v = suma(X, 'v'); return v ? suma(X, 'u') / v * 100 : null; });
      return `<div class="kpi"><small>Margen bruto · ${sel[0]}</small><b>${m[0] !== null ? m[0].toFixed(1) + '%' : '—'}</b><span class="tb-cmps">${sel.slice(1).map((y, i) => { const d = m[0] !== null && m[i + 1] !== null ? m[0] - m[i + 1] : null; return `<span>${d === null ? '' : (Math.abs(d) < 0.05 ? '<span class="etq">= igual</span>' : `<span class="etq ${d >= 0 ? 'ok' : 'mal'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pts</span>`)} vs ${y}: ${m[i + 1] !== null ? m[i + 1].toFixed(1) + '%' : '—'}</span>`; }).join('')}</span></div>`; };
    const html = `<div class="tarjeta"><h3>📅 ${sel[0]}${sel.length > 1 ? ' contra ' + sel.slice(1).join(', ') : ''} <small class="muted">· ${per}</small></h3><div class="kpis" style="margin:0">
        ${din ? tileM('Ventas netas', X => suma(X, 'v'), $$) : tileM('Notas de venta', X => cuenta(X), nf)}
        ${r.verUtil ? tileM('Utilidad bruta', X => suma(X, 'u'), $$) + margenTile() : ''}
        ${r.verCompras && din ? tileM('Compras', X => suma(X, 'c'), $$, true) : ''}
        ${din ? tileM('Mermas', X => suma(X, 'mer'), $$, true) : ''}
        ${din ? tileM('Notas de venta', X => cuenta(X), nf) + tileM('Ticket promedio', X => cuenta(X) ? suma(X, 'v') / cuenta(X) : 0, $$) : ''}
        ${tileM('Clientes que compraron', cli, nf)}
      </div></div>
      <div class="rejilla-2"><div class="tarjeta"><h3>📈 Ventas mes a mes, año con año</h3><div class="grafica" style="height:300px"><canvas id="tbG1"></canvas></div></div>
        <div class="tarjeta"><h3>📊 Totales por año</h3><div class="grafica" style="height:300px"><canvas id="tbG2"></canvas></div></div></div>
      ${r.verUtil ? `<div class="rejilla-2"><div class="tarjeta"><h3>💰 Utilidad bruta mes a mes</h3><div class="grafica" style="height:260px"><canvas id="tbG3"></canvas></div></div>
        <div class="tarjeta"><h3>📐 Margen bruto mes a mes</h3><div class="grafica" style="height:260px"><canvas id="tbG4"></canvas></div></div></div>` : ''}
      ${r.verCompras && din ? `<div class="tarjeta"><h3>📦 Compras contra ventas, mes a mes (${f.a})</h3><div class="grafica" style="height:260px"><canvas id="tbG5"></canvas></div></div>` : ''}
      <div class="tarjeta"><h3>🗓️ Resumen de cada año</h3><div class="tabla-cont"><table><thead><tr><th>Año</th>${din ? '<th class="num">Ventas</th><th class="num">Crecimiento</th>' : ''}${r.verUtil ? '<th class="num">Utilidad</th><th class="num">Margen</th>' : ''}${r.verCompras && din ? '<th class="num">Compras</th>' : ''}${din ? '<th class="num">Mermas</th>' : ''}<th class="num">Notas</th>${din ? '<th class="num">Ticket</th>' : ''}<th class="num">Clientes</th></tr></thead><tbody>
        ${r.anual.slice().reverse().map((x, i, l) => { const prev = l[i + 1]; return `<tr><td><b>${x.anio}</b>${x.anio === new Date().getFullYear() ? ' <small class="muted">(en curso)</small>' : ''}</td>${din ? `<td class="num">${$$(x.ventas)}</td><td class="num">${prev ? tbVar(x.ventas, prev.ventas) : '—'}</td>` : ''}${r.verUtil ? `<td class="num">${$$(x.utilidad)}</td><td class="num">${x.margen !== null ? x.margen + '%' : '—'}</td>` : ''}${r.verCompras && din ? `<td class="num">${$$(x.compras)}</td>` : ''}${din ? `<td class="num">${$$(x.mermas)}</td>` : ''}<td class="num">${nf(x.notas)}</td>${din ? `<td class="num">${x.notas ? $$(x.ventas / x.notas) : '—'}</td>` : ''}<td class="num">${nf(x.clientes)}</td></tr>`; }).join('')}
      </tbody></table></div><p class="muted peq">El crecimiento compara año completo contra año completo; el año en curso todavía no está completo (arriba lo comparas a la misma fecha).</p></div>`;
    el.innerHTML = html;
    const anios = r.anual.map(x => x.anio), col = y => TB_COL[(anios.length - 1 - anios.indexOf(y)) % TB_COL.length];
    const lineas = k => r.anual.filter(x => sel.indexOf(String(x.anio)) >= 0).map(x => ({ label: String(x.anio), data: x.meses.map((m, i) => x.anio === new Date().getFullYear() && i > new Date().getMonth() ? null : (k === 'margen' ? (m.v ? Math.round(m.u / m.v * 1000) / 10 : null) : m[k])),
      borderColor: col(x.anio), backgroundColor: col(x.anio), tension: .3, borderWidth: x.anio === +f.a ? 3.5 : 2, pointRadius: x.anio === +f.a ? 3 : 1.5, spanGaps: false }));
    const ejeY = k => ({ beginAtZero: true, ticks: { callback: k === 'margen' ? v => v + '%' : din ? tickMoneda : v => v } });
    const tip = k => ({ callbacks: { label: c => c.dataset.label + ': ' + (k === 'margen' ? c.parsed.y + '%' : din ? $$(c.parsed.y) : nf(c.parsed.y)) } });
    grafica('tbG1', { type: 'line', data: { labels: MES3, datasets: lineas(din ? 'v' : 'n') }, options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { tooltip: tip('v') }, scales: { y: ejeY('v') } } });
    const anS = r.anual.filter(x => sel.indexOf(String(x.anio)) >= 0), totK = (x, k) => corte ? (x.fecha || {})[k] : x[k];
    const ds2 = [{ label: 'Ventas', data: anS.map(x => totK(x, 'ventas')), backgroundColor: '#1f6f4a' }];
    if (r.verCompras) ds2.push({ label: 'Compras', data: anS.map(x => totK(x, 'compras')), backgroundColor: '#2a78d6' });
    if (r.verUtil) ds2.push({ label: 'Utilidad', data: anS.map(x => totK(x, 'utilidad')), backgroundColor: '#c79a00' });
    grafica('tbG2', { type: 'bar', data: { labels: anS.map(x => String(x.anio) + (corte ? ' al ' + r.corte : '')), datasets: din ? ds2 : [{ label: 'Notas', data: anS.map(x => totK(x, 'notas')), backgroundColor: '#1f6f4a' }] }, options: { maintainAspectRatio: false, plugins: { tooltip: tip('v') }, scales: { y: ejeY('v') } } });
    if (r.verUtil) {
      grafica('tbG3', { type: 'line', data: { labels: MES3, datasets: lineas('u') }, options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { tooltip: tip('u') }, scales: { y: ejeY('u') } } });
      grafica('tbG4', { type: 'line', data: { labels: MES3, datasets: lineas('margen') }, options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { tooltip: tip('margen') }, scales: { y: { ticks: { callback: v => v + '%' } } } } });
    }
    if (r.verCompras && din) grafica('tbG5', { type: 'bar', data: { labels: MES3, datasets: [{ label: 'Ventas ' + f.a, data: A.meses.map(m => m.v), backgroundColor: '#1f6f4a' }, { label: 'Compras ' + f.a, data: A.meses.map(m => m.c), backgroundColor: '#2a78d6' }] }, options: { maintainAspectRatio: false, plugins: { tooltip: tip('v') }, scales: { y: ejeY('v') } } });
  }
  /** valor de una entidad en un año con la métrica elegida (v venta · q piezas · u utilidad · c compras) */
  const tbCorte = () => { const f = S.fTb; return !!(f && f.aFecha && +f.a === new Date().getFullYear()); };
  const tbVal = (x, y, m) => { const z = (tbCorte() && x.f ? x.f : x.y)[y]; return z ? (z[m] || 0) : 0; };
  function tbMetricas(tab) {
    const r = S.tb, m = [];
    if (tab === 'proveedores') return [['c', 'Compras $']];
    if (r.dinero) m.push(['v', 'Venta $']);
    if (tab === 'productos' || tab === 'categorias') m.push(['q', 'Piezas vendidas']);
    if (r.verUtil && tab !== 'proveedores') m.push(['u', 'Utilidad $']);
    if (tab === 'productos' && r.verCompras && r.dinero) m.push(['c', 'Compras $']);
    if (!m.length) m.push(['q', 'Piezas']);
    return m;
  }
  function pintarTbEntidad(el, tab) {
    const r = S.tb, f = S.fTb, mets = tbMetricas(tab);
    if (!f.met || !mets.some(m => m[0] === f.met)) f.met = mets[0][0];
    const met = f.met, esDin = met !== 'q', fmt = v => esDin ? $$(v) : nf(v);
    const lista = r[tab] || [], a = f.a, b = f.b;
    const totA = lista.reduce((t, x) => t + tbVal(x, a, met), 0), totB = lista.reduce((t, x) => t + tbVal(x, b, met), 0);
    const rk = y => { const m = {}; lista.filter(x => tbVal(x, y, met) > 0).sort((p, q) => tbVal(q, y, met) - tbVal(p, y, met)).forEach((x, i) => m[x.id] = i + 1); return m; };
    const rA = rk(a), rB = rk(b);
    let l = lista.filter(x => tbVal(x, a, met) || tbVal(x, b, met));
    if (f.q) l = l.filter(x => coincide(x.n + ' ' + (x.cat || '') + ' ' + (x.lab || '') + ' ' + x.id, f.q));
    if (f.filtro === 'crecen') l = l.filter(x => tbVal(x, a, met) > tbVal(x, b, met) && tbVal(x, b, met) > 0);
    if (f.filtro === 'caen') l = l.filter(x => tbVal(x, a, met) < tbVal(x, b, met) && tbVal(x, a, met) > 0);
    if (f.filtro === 'nuevos') l = l.filter(x => tbVal(x, a, met) > 0 && !tbVal(x, b, met));
    if (f.filtro === 'perdidos') l = l.filter(x => tbVal(x, b, met) > 0 && !tbVal(x, a, met));
    const dif = x => tbVal(x, a, met) - tbVal(x, b, met), pct = x => tbVal(x, b, met) ? dif(x) / tbVal(x, b, met) : (tbVal(x, a, met) ? 9e9 : 0);
    const ord = { a: (p, q) => tbVal(q, a, met) - tbVal(p, a, met), b: (p, q) => tbVal(q, b, met) - tbVal(p, b, met), dif: (p, q) => dif(q) - dif(p), difm: (p, q) => dif(p) - dif(q), pct: (p, q) => pct(q) - pct(p), n: (p, q) => p.n.localeCompare(q.n) };
    l.sort(ord[f.orden] || ord.a);
    const nuevos = lista.filter(x => tbVal(x, a, met) > 0 && !tbVal(x, b, met)).length, perdidos = lista.filter(x => tbVal(x, b, met) > 0 && !tbVal(x, a, met)).length;
    const nombre = { clientes: 'Cliente', productos: 'Producto', proveedores: 'Proveedor', categorias: 'Categoría', sucursales: 'Sucursal', vendedores: 'Vendedor' }[tab];
    const plural = { clientes: 'Clientes', productos: 'Productos', proveedores: 'Proveedores', categorias: 'Categorías', sucursales: 'Sucursales', vendedores: 'Vendedores' }[tab];
    const th = (k, t, num) => `<th class="${num ? 'num' : ''} ordenable" onclick="App.tbOrden('${k}')">${t}${f.orden === k ? ' ▾' : ''}</th>`;
    const top = lista.filter(x => tbVal(x, a, met) > 0).sort(ord.a).slice(0, 15);
    el.innerHTML = `<div class="tarjeta"><div class="fila">
        ${mets.length > 1 ? `<label>Medir por<select id="tbMet">${mets.map(([k, t]) => `<option value="${k}" ${k === met ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}
        <label style="flex:2 1 220px">Buscar<input id="tbQ" value="${esc(f.q)}" placeholder="${nombre}${tab === 'productos' ? ', laboratorio o categoría' : ''}"></label>
        <label>Mostrar<select id="tbFil">${[['', 'Todos'], ['crecen', '▲ Crecen'], ['caen', '▼ Caen'], ['nuevos', '✨ Nuevos en ' + a], ['perdidos', '⚠️ Ya no en ' + a]].map(([k, t]) => `<option value="${k}" ${k === f.filtro ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <button class="btn fijo" onclick="App.tbCsv('${tab}')">⬇️ Excel (CSV)</button></div>
        <div class="kpis" style="margin:10px 0 0"><div class="kpi"><small>Total ${a}${tbCorte() ? ' al ' + r.corte : ''}</small><b>${fmt(totA)}</b><span class="tb-cmps">${tbSel().slice(1).map(y => { const t = lista.reduce((s2, x) => s2 + tbVal(x, y, met), 0); return `<span>${tbVar(totA, t, tab === 'proveedores')} vs ${y}: ${fmt(t)}</span>`; }).join('')}</span></div>
          <div class="kpi"><small>${plural} con movimiento en ${a}${tbCorte() ? ' (al ' + r.corte + ')' : ''}</small><b>${nf(Object.keys(rA).length)}</b><span>${b}: ${nf(Object.keys(rB).length)}</span></div>
          <div class="kpi kpi-clic" onclick="App.tbFiltro('nuevos')"><small>✨ Nuevos en ${a}</small><b>${nf(nuevos)}</b><span>no estaban en ${b}</span></div>
          <div class="kpi kpi-clic" onclick="App.tbFiltro('perdidos')"><small>⚠️ Ya no aparecen en ${a}</small><b>${nf(perdidos)}</b><span>sí estaban en ${b}</span></div></div></div>
      <div class="rejilla-2"><div class="tarjeta"><h3>🏆 Top 15 de ${a}${tbSel().length > 1 ? ' contra ' + tbSel().slice(1).join(', ') : ''}</h3><div class="grafica" style="height:${Math.max(260, top.length * (10 + 11 * tbSel().length) + 60)}px"><canvas id="tbE1"></canvas></div></div>
        <div class="tarjeta"><h3>🥧 Participación en ${a}</h3><div class="grafica" style="height:${Math.max(260, top.length * 26 + 60)}px"><canvas id="tbE2"></canvas></div></div></div>
      <div class="tarjeta"><div class="tabla-cont"><table class="tb-tabla"><thead><tr><th class="num">#</th>${th('n', nombre)}${th('a', a, 1)}${tbSel().slice(1).map((y, i) => i === 0 ? th('b', y, 1) : `<th class="num">${y}</th>`).join('')}${th('dif', 'Diferencia vs ' + b, 1)}${th('pct', 'Cambio vs ' + b, 1)}<th class="num">Participación</th><th class="num">Lugar en ${b}</th></tr></thead><tbody>
        ${l.slice(0, 500).map(x => { const va = tbVal(x, a, met), vb = tbVal(x, b, met), d = va - vb;
          return `<tr class="clic" onclick="App.tbDetalle('${tab}','${esc(String(x.id)).replace(/'/g, '&#39;')}')"><td class="num muted">${rA[x.id] || '—'}</td><td><b>${esc(tab === 'productos' ? String(x.n).split(',')[0] : x.n)}</b>${tab === 'productos' ? `<small class="muted"> ${esc(String(x.n).split(',').slice(1).join(',').trim())}${x.cat ? ' · ' + esc(x.cat) : ''}</small>` : ''}</td>
            <td class="num">${fmt(va)}</td>${tbSel().slice(1).map(y => `<td class="num muted">${fmt(tbVal(x, y, met))}</td>`).join('')}<td class="num ${d > 0 ? 'ok-txt' : d < 0 ? 'error' : ''}">${d > 0 ? '+' : ''}${fmt(d)}</td><td class="num">${tbVar(va, vb, tab === 'proveedores')}</td>
            <td class="num">${totA ? (va / totA * 100).toFixed(1) + '%' : '—'}</td><td class="num muted">${rB[x.id] ? '#' + rB[x.id] : '—'}</td></tr>`; }).join('') || `<tr><td colspan="${7 + tbSel().length}" class="vacio">Sin resultados</td></tr>`}
      </tbody></table></div>${l.length > 500 ? `<p class="muted peq">Se muestran 500 de ${nf(l.length)}; usa el buscador o descarga el CSV.</p>` : ''}</div>`;
    if ($('#tbMet')) $('#tbMet').onchange = e => { f.met = e.target.value; pintarTablero(); };
    $('#tbQ').oninput = e => { f.q = e.target.value; clearTimeout(S.tbQT); S.tbQT = setTimeout(() => { pintarTablero(); const i = $('#tbQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 350); };
    $('#tbFil').onchange = e => { f.filtro = e.target.value; pintarTablero(); };
    const etq = x => { const t = tab === 'productos' ? String(x.n).split(',')[0] : x.n; return t.length > 28 ? t.slice(0, 27) + '…' : t; };
    const tipF = { callbacks: { label: c => c.dataset.label + ': ' + fmt(c.parsed.x !== undefined && c.chart.config.type === 'bar' ? c.parsed.x : c.parsed) } };
    const colE = y => TB_COL[(r.anios.length - 1 - r.anios.indexOf(+y)) % TB_COL.length];
    grafica('tbE1', { type: 'bar', data: { labels: top.map(etq), datasets: tbSel().map((y, i) => ({ label: y, data: top.map(x => tbVal(x, y, met)), backgroundColor: i === 0 ? colE(y) : colE(y) + 'aa' })) },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { tooltip: tipF }, scales: { x: { beginAtZero: true, ticks: { callback: esDin ? tickMoneda : v => v } } }, onClick: (e, els) => { if (els[0]) tbDetalle(tab, top[els[0].index].id); } } });
    const ot = Math.max(0, totA - top.slice(0, 8).reduce((t, x) => t + tbVal(x, a, met), 0));
    grafica('tbE2', { type: 'doughnut', data: { labels: top.slice(0, 8).map(etq).concat(ot > 0 ? ['Otros'] : []), datasets: [{ data: top.slice(0, 8).map(x => tbVal(x, a, met)).concat(ot > 0 ? [ot] : []), backgroundColor: TB_COL.concat(['#9ca3af']) }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'right' }, tooltip: { callbacks: { label: c => c.label + ': ' + fmt(c.parsed) + (totA ? ' (' + (c.parsed / totA * 100).toFixed(1) + '%)' : '') } } } } });
  }
  function tbOrden(k) { const f = S.fTb; f.orden = f.orden === k && k === 'dif' ? 'difm' : k; pintarTablero(); }
  function tbFiltro(k) { S.fTb.filtro = S.fTb.filtro === k ? '' : k; pintarTablero(); }
  async function tbDetalle(tab, id) {
    const r = S.tb, f = S.fTb, x = (r[tab] || []).find(z => String(z.id) === String(id)); if (!x) return;
    const tipo = TB_TIPO[tab], mets = tbMetricas(tab), din = r.dinero;
    modal('📊 ' + x.n, `<div class="tabla-cont"><table><thead><tr><th>Año</th>${mets.map(m => `<th class="num">${m[1]}</th>`).join('')}<th class="num">Crecimiento</th>${tab === 'productos' && r.verCompras ? '<th class="num">Piezas compradas</th>' : ''}</tr></thead><tbody>
        ${r.anios.slice().reverse().map((y, i, l) => `<tr><td><b>${y}</b></td>${mets.map(m => `<td class="num">${m[0] === 'q' ? nf(tbVal(x, y, 'q')) : $$(tbVal(x, y, m[0]))}</td>`).join('')}<td class="num">${l[i + 1] ? tbVar(tbVal(x, y, mets[0][0]), tbVal(x, l[i + 1], mets[0][0]), tab === 'proveedores') : '—'}</td>${tab === 'productos' && r.verCompras ? `<td class="num">${nf(tbVal(x, y, 'qc'))}</td>` : ''}</tr>`).join('')}
      </tbody></table></div><h4 style="margin:14px 0 6px">Mes a mes, año con año</h4><div class="grafica" style="height:280px"><canvas id="tbD1"></canvas></div>
      <div class="acciones">${tab === 'clientes' && cliente(id) ? `<button class="btn" onclick="App.cerrarModal();App.fichaCliente('${esc(id)}')">👤 Ficha del cliente</button>` : ''}<button class="btn" onclick="App.cerrarModal()">Cerrar</button></div>`);
    let d; try { d = await pedir('analisis', { sucursal: f.suc, detalle: { tipo: tipo, id: id } }, true); } catch (e) { const c = $('#tbD1'); if (c) c.parentElement.innerHTML = '<div class="vacio">El detalle mes a mes necesita conexión.</div>'; return; }
    const k = tab === 'proveedores' ? 'c' : din ? 'v' : 'q', anios = d.anios, col = y => TB_COL[(anios.length - 1 - anios.indexOf(y)) % TB_COL.length], hoy = new Date();
    if (!$('#tbD1')) return;
    grafica('tbD1', { type: 'line', data: { labels: MES3, datasets: d.serie.filter(s => tbSel().indexOf(String(s.anio)) >= 0).map(s => ({ label: String(s.anio), data: s.meses.map((m, i) => s.anio === hoy.getFullYear() && i > hoy.getMonth() ? null : m[k]), borderColor: col(s.anio), backgroundColor: col(s.anio), tension: .3, borderWidth: String(s.anio) === String(f.a) ? 3.5 : 2 })) },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { tooltip: { callbacks: { label: c => c.dataset.label + ': ' + (k === 'q' ? nf(c.parsed.y) : $$(c.parsed.y)) } } }, scales: { y: { beginAtZero: true, ticks: { callback: k === 'q' ? v => v : tickMoneda } } } } });
  }
  function tbCsv(tab) {
    const r = S.tb, f = S.fTb, mets = tbMetricas(tab), q = v => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
    const cab = ['Clave', 'Nombre'].concat(tab === 'productos' ? ['Categoría', 'Laboratorio'] : []).concat(...r.anios.map(y => mets.map(m => m[1] + ' ' + y)));
    const filas = (r[tab] || []).map(x => [x.id, x.n].concat(tab === 'productos' ? [x.cat || '', x.lab || ''] : []).concat(...r.anios.map(y => mets.map(m => tbVal(x, y, m[0])))));
    const csv = '﻿' + [cab].concat(filas).map(fl => fl.map(q).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'Dashboard ' + tab + ' por año.csv'; a.click();
  }

  /* ----- Visitas ----- */
  V.visitas = () => {
    const f = S.fVis = alDia(S.fVis || { desde: sumaDias(hoyISO(), -7), hasta: sumaDias(hoyISO(), 60), hastaHoy: '', vend: '', estado: '' });
    $('#vista').innerHTML = `<div class="tarjeta"><div class="fila">
        <label>Desde<input type="date" id="vsDesde" value="${f.desde}"></label><label>Hasta<input type="date" id="vsHasta" value="${f.hasta}"></label>
        ${esJefe() ? `<label>Vendedor<select id="vsVend">${opts((D().vendedores || []).filter(v => U().todasSucursales || v.suc === U().sucursal).map(v => [v.id, v.nombre]), f.vend, 'Todos')}</select></label>` : ''}
        <label>Estado<select id="vsEst">${opts([['Programada', 'Programadas'], ['Vencida', 'Vencidas (no se hicieron)'], ['Realizada', 'Realizadas'], ['Cancelada', 'Canceladas']], f.estado, 'Todas')}</select></label>
        <button class="btn primario fijo" onclick="App.cargarVisitas()">Buscar</button></div>
        <div class="acciones izq" style="margin-top:10px"><button class="btn primario" onclick="App.formVisita({})">📅 Programar visita</button><button class="btn" onclick="App.formVisita({realizada:1})">✅ Registrar visita</button>${U().rol === 'Administrador' ? '<button class="btn" onclick="App.sincronizarCalendario()">🗓️ Pasar agenda a Google Calendar</button>' : ''}<button class="btn" onclick="App.suscribirCalendario()">🍏 Ver en el Calendario de mi Mac / iPhone</button></div></div>
      <div id="vsRes"><div class="vacio">Cargando…</div></div>`;
    ['vsDesde', 'vsHasta', 'vsVend', 'vsEst'].forEach(id => { const e = $('#' + id); if (e) e.onchange = cargarVisitas; });
    cargarVisitas();
  };
  async function cargarVisitas() {
    const f = S.fVis; if (!f || !$('#vsDesde')) return;
    f.desde = $('#vsDesde').value; f.hasta = $('#vsHasta').value; f.vend = $('#vsVend') ? $('#vsVend').value : ''; f.estado = $('#vsEst').value; marcarHoy(f);
    let r; try { r = await pedir('listarVisitas', { desde: f.desde, hasta: f.hasta, vendedor: f.vend, estado: f.estado }, true); }
    catch (e) { if ($('#vsRes')) $('#vsRes').innerHTML = `<div class="vacio">${e.red ? 'Consultar visitas requiere conexión (puedes registrar visitas sin conexión).' : esc(e.message)}</div>`; return; }
    if (!$('#vsRes')) return;
    const k = r.kpi, kpi = (t, v, s) => `<div class="kpi"><small>${t}</small><b>${v}</b><span>${s || ''}</span></div>`;
    const ag = r.visitas.filter(v => !v.realizada && !v.cancelada).sort((a, b) => isoDe(a.fecha).localeCompare(isoDe(b.fecha)));
    const hechas = r.visitas.filter(v => v.realizada || v.cancelada);
    S.visAg = ag; S.visHechas = hechas;
    const cols = [{ t: 'Fecha', h: v => `<b>${esc(v.fecha)}</b>` }, { t: 'Cliente', h: v => `${esc(v.cliente)}${v.tipo === 'Prospecto' ? ' <span class="etq">Prospecto</span>' : ''}` },
      { t: 'Motivo', cls: 'ocultar-movil', h: v => esc(v.motivoVisita) + (v.cotizacion ? `<br><small class="muted">📝 ${esc(v.cotizacion.folio)}</small>` : '') },
      { t: 'Estado', h: v => `<span class="etq ${v.estado === 'Realizada' ? 'ok' : v.estado === 'Vencida' ? 'mal' : v.estado === 'Cancelada' ? '' : 'av'}">${esc(v.estado)}</span>` },
      { t: 'Resultado', h: v => v.realizada ? (v.venta ? `🧾 ${esc(v.venta.folio)}${puede('ver_importes') ? ' · ' + $$(v.venta.total) : ''}` : v.pedido ? '🧾 Pedido' : `<span class="muted">${esc(v.motivo || 'Sin pedido')}</span>`) + (v.cobranzaMonto ? ` · 💵 ${$$(v.cobranzaMonto)}` : '') + (v.fotos ? ` · 📷${v.fotos}` : '') : '' }]
      .concat(esJefe() ? [{ t: 'Vendedor', cls: 'ocultar-movil', h: v => esc(v.vendedor) }] : []);
    $('#vsRes').innerHTML = `<div class="kpis">${kpi('Programadas', nf(k.programadas), k.vencidas ? `<span class="error">${k.vencidas} vencidas</span>` : 'por hacer')}${kpi('Realizadas', nf(k.realizadas), '')}
        ${kpi('Con pedido', nf(k.conPedido), k.realizadas ? Math.round(k.conPedido / k.realizadas * 100) + ' % de efectividad' : '')}${puede('ver_importes') ? kpi('Vendido en visitas', $$(k.vendido), '') : ''}${k.cobrado !== null ? kpi('Cobrado en visitas', $$(k.cobrado), '') : ''}</div>
      ${ag.length ? `<div class="tarjeta"><h3>📅 Agenda</h3>${tabla(cols, ag, { clic: 'App.abrirVisita' })}</div>` : ''}
      <div class="tarjeta"><h3>✅ Realizadas</h3>${tabla(cols, hechas, { clic: 'App.abrirVisitaR', vacio: 'Sin visitas realizadas en el periodo' })}</div>
      ${r.porVendedor.length ? `<div class="tarjeta"><h3>👥 Por vendedor</h3>${tabla([{ t: 'Vendedor', k: 'vendedor' }, { t: 'Visitas', num: 1, h: x => nf(x.visitas) }, { t: 'Con pedido', num: 1, h: x => nf(x.pedidos) + ' (' + Math.round(x.pedidos / x.visitas * 100) + ' %)' }].concat(puede('ver_importes') ? [{ t: 'Vendido', num: 1, h: x => $$(x.vendido) }] : []), r.porVendedor)}</div>` : ''}`;
  }

  /** o: { id (editar), idCliente, realizada } */
  async function formVisita(o) {
    o = o || {};
    let d = null;
    if (o.id) { try { d = await pedir('detalleVisita', { id: o.id }); } catch (e) { return; } }
    const realizada = o.realizada !== undefined ? !!o.realizada : d ? d.realizada : false;
    const idc = d ? d.idCliente : o.idCliente || '', c = idc ? cliente(idc) : null;
    const segC = S.seg && S.seg.clientes ? S.seg.clientes.find(x => x.id === idc) : null;
    const fecha = d && !(o.realizada && !d.realizada) ? isoDe(d.fecha) : realizada ? hoyISO() : sumaDias(hoyISO(), 1);
    const cada = Math.min(60, (segC && segC.cada) || 15);
    S.visForm = { id: d ? d.id : uid() + uid(), nueva: !d, cli: idc, ubic: d ? d.ubicacion : '', cot: d && d.cotizacion ? d.cotizacion.id : (o.idCot || ''), cada: cada, eraRealizada: !!(d && d.realizada) };
    const mot = d ? d.motivoVisita : o.idCot ? 'Entrega de cotización' : (realizada ? 'Toma de pedido' : 'Seguimiento');
    const prox = d && d.proxIni ? isoDe(d.proxIni) : sumaDias(realizada ? fecha : hoyISO(), cada);
    modal(d ? 'Visita · ' + (d.cliente || '') : '📅 Nueva visita', `<div id="fVis" class="form-vis">
      <div class="fila">
        <label style="flex:3 1 260px">Cliente<div class="buscador"><input id="vsCli" placeholder="Buscar cliente…" autocomplete="off" value="${c ? esc(c.razon || c.nombre) : ''}" ${d && d.idCliente ? 'disabled' : ''}></div></label>
        <label class="check fijo" style="align-self:end"><input type="checkbox" id="vsProsp" ${d && !d.idCliente ? 'checked' : ''} ${d ? 'disabled' : ''}> Es prospecto</label></div>
      <label id="vsProspN" class="${d && !d.idCliente ? '' : 'oculto'}">Nombre del prospecto / rancho<input id="vsNom" value="${d && !d.idCliente ? esc(d.cliente) : ''}" placeholder="Nombre y rancho del posible cliente"></label>
      <div class="fila"><label>Fecha<input type="date" id="vsFecha" value="${fecha}"></label><label style="max-width:140px">Hora<input type="time" id="vsHora" value="${esc((d && d.hora) || '09:00')}"></label>
        <label style="flex:2 1 220px">Motivo<input id="vsMot" list="vsMotL" value="${esc(mot)}" placeholder="Elige de la lista o escribe el motivo" autocomplete="off"><datalist id="vsMotL">${VIS_MOTIVOS.map(m => `<option value="${esc(m)}">`).join('')}</datalist></label></div>
      <label>Objetivo de la visita / notas<textarea id="vsObj" rows="2" placeholder="Qué quieres lograr: llevarle la cotización, revisar el hato, cobrar la nota…">${d ? esc(d.objetivo || '') : ''}</textarea></label>
      ${puede('cotizaciones') ? `<div class="fc-sec" id="vsCotSec"><h4>📝 Cotización a entregar</h4><div id="vsCots"><span class="muted">${idc ? 'Cargando cotizaciones del cliente…' : 'Elige el cliente para ver sus cotizaciones.'}</span></div></div>` : ''}
      <label class="vs-real ${realizada ? 'on' : ''}"><input type="checkbox" id="vsRealCk" ${realizada ? 'checked' : ''}> <span><b>✅ Ya se realizó esta visita</b><br><small class="muted">Márcalo para capturar el resultado, el pedido, la cobranza y la próxima visita.</small></span></label>
      <div id="vsRealSec" class="${realizada ? '' : 'oculto'}">
        <label>¿Qué pasó en la visita?<textarea id="vsRes2" rows="3" placeholder="Acuerdos, necesidades del rancho, productos que le interesan…">${d ? esc(d.resultado) : ''}</textarea></label>
        <div class="fila"><label class="check fijo"><input type="checkbox" id="vsPed" ${d && d.pedido ? 'checked' : ''}> Hubo pedido / venta</label>
          <label id="vsSinL" class="${d && d.pedido ? 'oculto' : ''}">¿Por qué no compró?<select id="vsSin">${opts(VIS_SIN_PEDIDO, d ? d.motivo : '', '—')}</select></label></div>
        <div class="fila"><label class="check fijo"><input type="checkbox" id="vsCob" ${d && d.cobranza ? 'checked' : ''}> Cobró</label>
          <label id="vsCobL" class="${d && d.cobranza ? '' : 'oculto'}">Monto cobrado<input type="number" id="vsCobM" step="0.01" min="0" inputmode="decimal" value="${d && d.cobranzaMonto ? d.cobranzaMonto : ''}"></label></div>
        <div class="fila"><label>Próxima visita<input type="date" id="vsProx" value="${prox}"></label><label>A más tardar<input type="date" id="vsProxF" value="${d && d.proxFin ? isoDe(d.proxFin) : ''}"></label></div>
        <p class="muted" style="margin:0;font-size:13px">${segC && segC.cada ? `Este cliente compra cada ${segC.cada} días. ` : ''}Al guardar se programa la próxima visita en tu agenda y en el calendario.</p>
        <div class="acciones izq"><button class="btn chico" type="button" onclick="App.ubicVisita()">📍 Guardar mi ubicación</button><span id="vsUbic" class="muted" style="font-size:13px">${d && d.ubicacion ? 'Ubicación guardada' : ''}</span></div>
        <p class="muted" style="font-size:13px">📷 Las fotos se agregan al guardar.</p>
      </div>
      <p id="vsCalAviso" class="muted ${realizada ? 'oculto' : ''}" style="font-size:13px;margin:4px 0 0">📅 Se agenda en Google Calendar con recordatorios: <b id="vsRecs"></b>.</p>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" id="vsGuardar" onclick="App.guardarVisita()">💾 Guardar</button></div></div>`);
    if (!(d && d.idCliente)) buscador($('#vsCli'), { fuente: fuenteClientes, alElegir: x => { S.visForm.cli = x.id; S.visForm.cot = ''; cotsVisita(); } });
    $('#vsCli').addEventListener('input', () => { if (S.visForm.cli) { S.visForm.cli = ''; S.visForm.cot = ''; cotsVisita(); } });
    $('#vsProsp').onchange = e => { $('#vsProspN').classList.toggle('oculto', !e.target.checked); $('#vsCli').disabled = e.target.checked; if (e.target.checked) { S.visForm.cli = ''; $('#vsCli').value = ''; S.visForm.cot = ''; } if ($('#vsCotSec')) $('#vsCotSec').classList.toggle('oculto', e.target.checked); };
    if (idc) cotsVisita();
    $('#vsPed').onchange = e => $('#vsSinL').classList.toggle('oculto', e.target.checked);
    $('#vsCob').onchange = e => $('#vsCobL').classList.toggle('oculto', !e.target.checked);
    const pintaRecs = () => { const r = recordatoriosVisita($('#vsFecha').value); $('#vsRecs').textContent = r.length ? r.map(x => x + (x === 1 ? ' día' : ' días')).join(' y ') + ' antes' : 'el mismo día'; };
    $('#vsRealCk').onchange = e => {
      const on = e.target.checked;
      $('#vsRealSec').classList.toggle('oculto', !on); $('#vsCalAviso').classList.toggle('oculto', on); e.target.closest('.vs-real').classList.toggle('on', on);
      if (on) {
        if ($('#vsFecha').value > hoyISO()) $('#vsFecha').value = hoyISO();
        if (!S.visForm.eraRealizada && !(d && d.proxIni)) $('#vsProx').value = sumaDias($('#vsFecha').value, S.visForm.cada);
        const m = $('#vsMot'); if (m.value === 'Seguimiento' && !d) m.value = 'Toma de pedido';
        setTimeout(() => $('#vsRes2').focus(), 50);
      }
      pintaRecs();
    };
    $('#vsFecha').onchange = e => { if ($('#vsRealCk').checked && !S.visForm.eraRealizada) $('#vsProx').value = sumaDias(e.target.value, S.visForm.cada); pintaRecs(); };
    pintaRecs();
  }
  /** Recordatorios (días antes) igual que en el servidor: ≥30 días → 30 y 15; ≥15 → 15; menos → 8 y 3 (los que quepan); si no, 1. */
  function recordatoriosVisita(iso) {
    const n = Math.round((new Date((iso || hoyISO()) + 'T12:00:00') - new Date(hoyISO() + 'T12:00:00')) / 86400000);
    let r = n >= 30 ? [30, 15] : n >= 15 ? [15] : [8, 3].filter(x => x < n);
    if (!r.length && n >= 2) r = [1];
    return r;
  }
  /** Cotizaciones del cliente para elegir la que se entregará en la visita */
  async function cotsVisita() {
    const el = $('#vsCots'), F = S.visForm; if (!el || !F) return;
    if (!F.cli) { el.innerHTML = '<span class="muted">Elige el cliente para ver sus cotizaciones.</span>'; return; }
    const cli = F.cli; el.innerHTML = '<span class="muted">Cargando cotizaciones del cliente…</span>';
    let r; try { r = await pedir('listarCotizaciones', { idCliente: cli }, true); } catch (e) { const x = $('#vsCots'); if (x) x.innerHTML = `<span class="muted">${e.red ? 'Las cotizaciones se consultan con conexión.' : esc(e.message)}</span>`; return; }
    if (!$('#vsCots') || S.visForm !== F || F.cli !== cli) return;
    const l = r.cotizaciones.filter(c => c.estado !== 'Cancelada' && (c.estado !== 'Vendida' || c.id === F.cot)).slice(0, 15);
    S.visCots = l;
    $('#vsCots').innerHTML = !l.length ? '<span class="muted">Este cliente no tiene cotizaciones abiertas.</span>' :
      `<div class="vs-cots">${[{ id: '', folio: 'Ninguna' }].concat(l).map(c => `<label class="vs-cot ${c.id === F.cot ? 'on' : ''}"><input type="radio" name="vsCot" value="${esc(c.id)}" ${c.id === F.cot ? 'checked' : ''}>
        <span><b>${esc(c.folio)}</b>${c.id ? ` · ${esc(c.fecha)} · ${puede('ver_importes') ? $$(c.total) + ' · ' : ''}${c.renglones} producto${c.renglones === 1 ? '' : 's'}<br><small class="${c.estado === 'Vencida' ? 'error' : 'muted'}">${esc(c.estado)}${c.estado === 'Abierta' ? ' · vence ' + esc(c.vigencia) : ''}</small>` : ''}</span></label>`).join('')}</div>`;
    $('#vsCots').querySelectorAll('input[name=vsCot]').forEach(i => i.onchange = () => {
      F.cot = i.value; $('#vsCots').querySelectorAll('.vs-cot').forEach(x => x.classList.toggle('on', x.querySelector('input').checked));
      const m = $('#vsMot'); if (F.cot && m && (!m.value.trim() || VIS_MOTIVOS.indexOf(m.value) >= 0)) m.value = 'Entrega de cotización';
    });
  }
  function ubicVisita() {
    if (!navigator.geolocation) return toast('Este dispositivo no da la ubicación', true);
    $('#vsUbic').textContent = 'Obteniendo ubicación…';
    navigator.geolocation.getCurrentPosition(p => { S.visForm.ubic = p.coords.latitude.toFixed(5) + ',' + p.coords.longitude.toFixed(5); const e = $('#vsUbic'); if (e) e.textContent = '📍 ' + S.visForm.ubic; },
      () => { const e = $('#vsUbic'); if (e) e.textContent = 'No se pudo obtener (revisa el permiso de ubicación)'; }, { enableHighAccuracy: true, timeout: 15000 });
  }
  async function guardarVisita() {
    const F = S.visForm, prosp = $('#vsProsp').checked, realizada = $('#vsRealCk').checked;
    if (!prosp && !F.cli && !$('#vsCli').disabled) return toast('Elige el cliente de la lista (o marca "Es prospecto")', true);
    if (prosp && !$('#vsNom').value.trim()) return toast('Escribe el nombre del prospecto', true);
    const p = { ID_Visita: F.id, nueva: F.nueva, Fecha: $('#vsFecha').value, hora: $('#vsHora').value, motivoVisita: $('#vsMot').value.trim(), realizada: !!realizada, objetivo: $('#vsObj').value.trim() };
    if (realizada && p.Fecha > hoyISO()) return toast('Una visita realizada no puede tener fecha futura', true);
    if ($('#vsCots')) p.idCotizacion = prosp ? '' : (F.cot || '');
    if (F.nueva) { p.ID_Cliente = prosp ? '' : F.cli; p.Nombre_cliente = prosp ? $('#vsNom').value.trim() : ''; p.tipo = prosp ? 'Prospecto' : 'Activo'; }
    if (realizada) {
      Object.assign(p, { resultado: $('#vsRes2').value.trim(), pedido: $('#vsPed').checked, motivo: $('#vsPed').checked ? '' : $('#vsSin').value,
        cobranza: $('#vsCob').checked, cobranzaMonto: $('#vsCob').checked ? Number($('#vsCobM').value) || 0 : 0, proxIni: $('#vsProx').value, proxFin: $('#vsProxF').value });
      if (F.ubic) p.ubicacion = F.ubic;
      if (!p.resultado && !p.pedido) return toast('Anota qué pasó en la visita', true);
    }
    $('#vsGuardar').disabled = true;
    const nom = prosp ? p.Nombre_cliente : ((cliente(F.cli) || {}).razon || (cliente(F.cli) || {}).nombre || '');
    try {
      const r = await pedir('guardarVisita', p);
      const cal = r.calendario || {};
      toast((realizada ? '✔ Visita registrada' + (r.proxima ? ' · próxima visita en tu agenda' : '') : '✔ Visita programada') +
        (cal.error ? ' · ⚠️ No se pudo agendar en Google Calendar: ' + cal.error : cal.ok && cal.recordatorios ? ' · 📅 en Google Calendar' : ''), !!cal.error);
      if (S.seg) S.seg._t = 0;
      if (S.fVis) { const fp = realizada && p.proxIni ? p.proxIni : p.Fecha; if (fp > S.fVis.hasta) S.fVis.hasta = fp; if (p.Fecha < S.fVis.desde) S.fVis.desde = p.Fecha; if ($('#vsHasta')) { $('#vsHasta').value = S.fVis.hasta; $('#vsDesde').value = S.fVis.desde; } }
      if (S.vista === 'visitas') cargarVisitas();
      if (realizada) verVisita(F.id); else cerrarModal();
    } catch (e) {
      if (!e.red) { if ($('#vsGuardar')) $('#vsGuardar').disabled = false; return; }
      encolar('guardarVisita', p, (realizada ? 'Visita a ' : 'Visita programada a ') + nom);
      toast('📴 Visita guardada en el dispositivo; se enviará al volver la conexión'); cerrarModal();
    }
  }
  async function verVisita(id) {
    let d; try { d = await pedir('detalleVisita', { id: id }); } catch (e) { return; }
    S.ultimaVis = d;
    const dato = (t, v) => v ? `<div class="fc-dato"><small>${t}</small><span>${v}</span></div>` : '';
    const wa = telWa(d.cel), q = esc(d.id);
    modal('Visita ' + d.fecha, `<div class="ficha-cli">
      <div class="fc-cab"><div><h3>${esc(d.cliente)}</h3><div class="fc-etqs"><span class="etq ${d.estado === 'Realizada' ? 'ok' : d.estado === 'Vencida' ? 'mal' : 'av'}">${esc(d.estado)}</span>${d.tipo ? `<span class="etq">${esc(d.tipo)}</span>` : ''}${d.motivoVisita ? `<span class="etq">${esc(d.motivoVisita)}</span>` : ''}</div></div></div>
      <div class="fc-rejilla">${dato('Fecha', esc(d.fecha))}${dato('Vendedor', esc(d.vendedor))}
        ${d.realizada ? dato('Pedido', d.venta ? `<a href="#" onclick="App.verVentaId('${esc(d.venta.id)}');return false">🧾 ${esc(d.venta.folio)}</a>${puede('ver_importes') ? ' · ' + $$(d.venta.total) : ''}` : d.pedido ? 'Sí' : 'No' + (d.motivo ? ' — ' + esc(d.motivo) : '')) : ''}
        ${d.cobranza ? dato('Cobró', $$(d.cobranzaMonto)) : ''}${d.proxIni ? dato('Próxima visita', esc(d.proxIni) + (d.proxFin ? ' a ' + esc(d.proxFin) : '')) : ''}
        ${d.ubicacion ? dato('Ubicación', `<a target="_blank" rel="noopener" href="https:${'\/\/'}www.google.com/maps?q=${encodeURIComponent(d.ubicacion)}">📍 Ver en mapa</a>`) : ''}
        ${d.cancelada ? dato('Cancelación', esc(d.motivo)) : ''}
        ${!d.realizada && !d.cancelada ? dato('Calendario', d.evento ? '📅 En Google Calendar' + (d.recordatorios && d.recordatorios.length ? ' · avisos ' + d.recordatorios.join(' y ') + ' días antes' : '') : '<span class="muted">No está en Google Calendar</span>') : ''}</div>
      ${d.objetivo ? `<div class="fc-sec"><h4>🎯 Objetivo</h4><p style="white-space:pre-wrap;margin:0">${esc(d.objetivo)}</p></div>` : ''}
      ${d.cotizacion ? `<div class="fc-sec"><h4>📝 Cotización a entregar</h4><div class="fila" style="align-items:center"><div style="flex:1 1 200px"><b>${esc(d.cotizacion.folio)}</b> · ${esc(d.cotizacion.fecha)}${puede('ver_importes') ? ' · ' + $$(d.cotizacion.total) : ''} <span class="etq ${d.cotizacion.estado === 'Vendida' ? 'ok' : d.cotizacion.estado === 'Abierta' ? 'av' : ''}">${esc(d.cotizacion.estado)}</span></div>
        ${puede('cotizaciones') ? `<button class="btn chico fijo" onclick="App.verCot('${esc(d.cotizacion.id)}')">Ver cotización${d.cotizacion.estado === 'Abierta' ? ' / convertir en venta' : ''}</button>` : ''}</div></div>` : ''}
      ${d.resultado ? `<div class="fc-sec"><h4>📝 Qué pasó</h4><p style="white-space:pre-wrap;margin:0">${esc(d.resultado)}</p></div>` : ''}
      ${!d.idCliente && !d.cancelada ? `<div class="aviso-cand">🌱 <b>Prospecto.</b> ${d.puedeAlta ? 'Dalo de alta como cliente para venderle y llevar su historia clínica; se le ligan sus visitas y recetas.' : 'Pide al administrador que lo dé de alta como cliente para venderle.'}
        ${d.puedeAlta ? `<div class="acciones izq"><button class="btn primario chico" onclick="App.formAltaProspecto('visita')">➕ Dar de alta como cliente</button></div>` : ''}</div>` : ''}
      ${!d.cancelada ? segIntegra('visita', d) : ''}
      ${d.realizada ? `<div class="arch-par">${bloqueArch('visFoto', d.id)}</div>` : ''}
      <div class="acciones">
        ${wa ? `<a class="btn" target="_blank" rel="noopener" href="${WA_BASE}${wa}">💬 WhatsApp</a>` : ''}
        ${d.idCliente ? `<button class="btn" onclick="App.fichaCliente('${esc(d.idCliente)}')">👤 Ficha del cliente</button><button class="btn" onclick="App.historiaCliente('${esc(d.idCliente)}')">📖 Historia clínica</button>` : ''}
        ${!d.realizada && !d.cancelada ? `<button class="btn" onclick="App.icsVisita('${q}')">📲 Agregar a mi calendario</button>` : ''}
        ${d.puedeEditar && !d.realizada && !d.cancelada ? `<button class="btn peligro" onclick="App.cancelarVisita('${q}')">Cancelar visita</button><button class="btn" onclick="App.formVisita({id:'${q}'})">📅 Cambiar fecha</button><button class="btn primario" onclick="App.formVisita({id:'${q}', realizada:1})">✅ Registrar resultado</button>` : ''}
        ${d.puedeEditar && d.realizada ? `<button class="btn" onclick="App.formVisita({id:'${q}'})">✏️ Editar</button>` : ''}
      </div></div>`);
  }
  /** Descarga un .ics para el calendario de este equipo (Mac / iPhone / Outlook) con sus alarmas. */
  async function icsVisita(id) {
    let r; try { r = await pedir('icsVisita', { id: id }); } catch (e) { return; }
    const url = URL.createObjectURL(new Blob([r.ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = r.nombre; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('📲 Abre el archivo para agregar la visita a tu calendario');
  }
  /** Enlace para suscribir el Calendario de Mac / iPhone (se actualiza solo con todas las visitas del usuario). */
  async function suscribirCalendario() {
    let r; try { r = await pedir('enlaceCalendario', {}); } catch (e) { return; }
    S.enlaceCal = r.url;
    modal('🍏 Visitas en el Calendario de tu Mac / iPhone', `<p>Suscribe tu Calendario a este enlace <b>una sola vez</b>: ahí aparecerán solas todas tus visitas programadas (y las que se programen después), con sus avisos de ${'30 y 15'}, 15 u ${'8 y 3'} días antes.</p>
      <div class="fila" style="align-items:center"><input id="cfIcs" readonly value="${esc(r.webcal)}" style="flex:1 1 260px;font-size:13px" onclick="this.select()"><button class="btn fijo" onclick="App.copiarEnlaceCal()">📋 Copiar</button></div>
      <div class="acciones izq"><a class="btn primario" href="${esc(r.webcal)}" target="_blank" rel="noopener">📲 Suscribirme ahora</a></div>
      <div class="fc-sec"><h4>En la Mac</h4><ol style="margin:0;padding-left:20px;line-height:1.6"><li>Copia el enlace.</li><li>Abre la app <b>Calendario</b> → menú <b>Archivo → Nueva suscripción a calendario…</b></li><li>Pega el enlace y presiona <b>Suscribirse</b>.</li><li>En “Actualizar” elige <b>Cada 15 minutos</b>, guarda en <b>iCloud</b> (así sale también en tu iPhone) y deja desmarcado “Eliminar alertas”.</li></ol></div>
      <div class="fc-sec"><h4>En el iPhone / iPad</h4><p style="margin:0">Toca <b>📲 Suscribirme ahora</b> (o pega el enlace en Safari) y confirma <b>Suscribirse</b>. Si ya lo hiciste en la Mac con iCloud, no hace falta.</p></div>
      <p class="muted" style="font-size:13px">El enlace es personal: muestra las visitas que tú puedes ver en la app. No lo compartas. Google Calendar se sigue llenando solo, por separado.</p>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cerrar</button></div>`);
  }
  function copiarEnlaceCal() {
    const i = $('#cfIcs'); if (!i) return;
    i.select();
    const ok = () => toast('📋 Enlace copiado');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(i.value).then(ok, () => { try { document.execCommand('copy'); ok(); } catch (e) { toast('Selecciona el enlace y cópialo', true); } });
    else { try { document.execCommand('copy'); ok(); } catch (e) { toast('Selecciona el enlace y cópialo', true); } }
  }
  async function sincronizarCalendario() {
    if (!confirm('¿Agendar en Google Calendar todas las visitas programadas que aún no estén? (con sus recordatorios)')) return;
    try { const r = await pedir('sincronizarCalendario', {}); toast('📅 ' + r.creados + ' visitas agendadas' + (r.errores ? ' · ' + r.errores + ' con error' : '')); cargarVisitas(); } catch (e) {}
  }
  async function cancelarVisita(id) {
    const m = prompt('¿Por qué se cancela la visita?'); if (m === null) return;
    try { await pedir('guardarVisita', { ID_Visita: id, cancelar: true, motivoCancelar: m }); toast('Visita cancelada'); cerrarModal(); if (S.vista === 'visitas') cargarVisitas(); if (S.seg) S.seg._t = 0; } catch (e) {}
  }
  async function visitasDeCliente(id) {
    let r; try { r = await pedir('listarVisitas', { idCliente: id }); } catch (e) { return; }
    S.visHechas = r.visitas; const c = cliente(id) || {};
    modal('Visitas · ' + (c.razon || c.nombre || ''), tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Motivo', k: 'motivoVisita' }, { t: 'Estado', k: 'estado' },
      { t: 'Resultado', h: v => esc((v.venta ? '🧾 ' + v.venta.folio + ' · ' : '') + (v.resultado || v.motivo || '')).slice(0, 140) }, { t: 'Vendedor', cls: 'ocultar-movil', k: 'vendedor' }], r.visitas, { clic: 'App.abrirVisitaR', vacio: 'Sin visitas registradas' }) +
      `<div class="acciones"><button class="btn" onclick="App.fichaCliente('${esc(id)}')">← Ficha</button><button class="btn primario" onclick="App.formVisita({idCliente:'${esc(id)}'})">📅 Programar visita</button></div>`);
  }

  /* ----- Integración: visita ↔ receta ↔ venta · alta de prospectos · historia clínica ----- */
  /** Bloque dentro de la visita o la receta: recetas de la visita, venta relacionada y accesos directos. */
  function segIntegra(tipo, d) {
    const esVis = tipo === 'visita', q = esc(d.id), cli = d.idCliente;
    let h = '';
    if (esVis && puede('recetas')) h += `<div class="fc-sec"><h4>💊 Recetas de esta visita</h4>${d.recetas && d.recetas.length ? `<div class="int-lista">${d.recetas.map(r => `<a href="#" class="int-item" onclick="App.verReceta('${esc(r.id)}');return false">℞ <b>${esc(r.folio)}</b> ${esc([r.especie, r.animal].filter(Boolean).join(' · '))}${r.diagnostico ? ` <span class="muted">— ${esc(r.diagnostico)}</span>` : ''}</a>`).join('')}</div>` : '<p class="muted" style="margin:0">Aún no hay recetas de esta visita.</p>'}
      <div class="acciones izq"><button class="btn chico" onclick="App.rxDesdeVisita()">💊 Hacer receta</button></div></div>`;
    if (!esVis) h += `<div class="fc-sec"><h4>🔗 Relacionado</h4><div class="fc-rejilla">
      <div class="fc-dato"><small>Surtir en</small><span>${d.sucCompra ? '🏬 ' + esc(sucNom(d.sucCompra)) : '<span class="muted">Sin indicar</span>'}</span></div>
      ${d.visita ? `<div class="fc-dato"><small>Visita</small><span><a href="#" onclick="App.verVisita('${esc(d.visita.id)}');return false">📅 ${esc(d.visita.fecha)}${d.visita.motivo ? ' · ' + esc(d.visita.motivo) : ''}</a></span></div>` : ''}</div></div>`;
    const v = d.venta;
    if (esVis && !d.realizada && !v) return h;
    h += `<div class="fc-sec"><h4>🧾 Venta relacionada</h4>${v ? `<p style="margin:0"><a href="#" onclick="App.verVentaId('${esc(v.id)}');return false"><b>🧾 ${esc(v.folio)}</b></a>${v.fecha ? ' · ' + esc(v.fecha) : ''}${puede('ver_importes') && v.total !== null && v.total !== undefined ? ' · ' + $$(v.total) : ''}</p>` : `<p class="muted" style="margin:0">${cli ? 'Sin venta relacionada.' : 'Da de alta al cliente para poder relacionar su venta.'}</p>`}
      ${cli ? `<div class="acciones izq">${(esVis ? d.puedeEditar : true) ? `<button class="btn chico" onclick="App.formLigarVenta('${tipo}')">🔗 ${v ? 'Cambiar venta' : 'Relacionar una venta'}</button>` : ''}${!v && puede('ventas') ? `<button class="btn chico" onclick="App.${esVis ? 'venderDesdeVisita()' : `rxAVenta('${q}')`}">🛒 Hacer la venta</button>` : ''}</div>` : ''}</div>`;
    return h;
  }
  /** Elegir la venta del cliente que corresponde a la visita / receta (las más cercanas a su fecha primero). */
  async function formLigarVenta(tipo) {
    const d = tipo === 'visita' ? S.ultimaVis : S.ultimaRx; if (!d || !d.idCliente) return;
    let r; try { r = await pedir('ventasParaLigar', { idCliente: d.idCliente, fecha: isoDe(d.fecha) }); } catch (e) { return; }
    const actual = d.venta ? d.venta.id : '';
    S.ligar = { tipo: tipo, id: d.id };
    const volver = tipo === 'visita' ? `App.verVisita('${esc(d.id)}')` : `App.verReceta('${esc(d.id)}')`;
    modal('🔗 Relacionar venta', `<p class="muted" style="margin-top:0">Ventas de <b>${esc((cliente(d.idCliente) || {}).razon || d.cliente || d.propietario || '')}</b> cercanas al ${esc(d.fecha)}.</p>
      ${r.ventas.length ? `<div class="vs-cots">${[{ id: '', folio: 'Sin venta relacionada' }].concat(r.ventas).map(x => `<label class="vs-cot ${x.id === actual ? 'on' : ''}"><input type="radio" name="lgVta" value="${esc(x.id)}" ${x.id === actual ? 'checked' : ''}>
        <span><b>${esc(x.folio)}</b>${x.id ? ` · ${esc(x.fecha)}${x.total !== null ? ' · ' + $$(x.total) : ''}<br><small class="muted">${esc(sucNom(x.suc))}${x.dif === 0 ? ' · mismo día' : ' · ' + x.dif + (x.dif === 1 ? ' día' : ' días') + ' de diferencia'}</small>` : ''}</span></label>`).join('')}</div>` : '<div class="vacio">Este cliente no tiene ventas cerca de esa fecha.</div>'}
      <div class="acciones"><button class="btn" onclick="${volver}">Volver</button>${r.ventas.length ? '<button class="btn primario" id="lgGuardar" onclick="App.guardarLigaVenta()">💾 Guardar</button>' : ''}</div>`);
    document.querySelectorAll('input[name=lgVta]').forEach(i => i.onchange = () => document.querySelectorAll('.vs-cot').forEach(x => x.classList.toggle('on', x.querySelector('input').checked)));
  }
  async function guardarLigaVenta() {
    const L = S.ligar, i = document.querySelector('input[name=lgVta]:checked'); if (!L || !i) return toast('Elige una venta', true);
    $('#lgGuardar').disabled = true;
    try { await pedir('ligarVenta', { tipo: L.tipo, id: L.id, idVenta: i.value }); toast(i.value ? '✔ Venta relacionada' : '✔ Se quitó la venta'); if (S.vista === 'visitas') cargarVisitas(); L.tipo === 'visita' ? verVisita(L.id) : verReceta(L.id); }
    catch (e) { if ($('#lgGuardar')) $('#lgGuardar').disabled = false; }
  }
  /** Venta que sale de la visita: al guardarla queda relacionada con la visita. */
  function venderDesdeVisita() {
    const d = S.ultimaVis; if (!d || !d.idCliente) return;
    if (S.venta && S.venta.lineas && S.venta.lineas.length && !confirm('Tienes una venta en captura que se va a reemplazar. ¿Continuar?')) return;
    S.venta = ventaNueva(); S.venta.ligar = { visita: d.id }; S.venta.comentarios = 'Visita ' + d.fecha;
    cerrarModal(); ir('venta'); elegirClienteVenta(d.idCliente); guardarBorrador();
    toast('🔗 Al guardarla, la venta quedará relacionada con la visita del ' + d.fecha);
  }
  /** Alta de un prospecto como cliente desde su visita o su receta (se le ligan sus visitas y recetas). */
  function formAltaProspecto(tipo) {
    const d = tipo === 'visita' ? S.ultimaVis : S.ultimaRx; if (!d) return;
    const nom = tipo === 'visita' ? d.cliente : d.propietario;
    S.alta = { tipo: tipo, id: d.id, nombre: nom };
    const volver = tipo === 'visita' ? `App.verVisita('${esc(d.id)}')` : `App.verReceta('${esc(d.id)}')`;
    modal('➕ Dar de alta como cliente', `<p class="muted" style="margin-top:0">Se crea el cliente y se le ligan <b>sus visitas y recetas</b> registradas como prospecto con el nombre “${esc(nom)}”. Los datos fiscales, la lista de precios y el crédito los completa el administrador después.</p>
      <div id="fAlta"><div class="fila"><label style="flex:2 1 220px">Nombre del cliente *<input id="alNom" value="${esc(nom || '')}"></label><label style="flex:2 1 200px">Nombre del rancho<input id="alRancho"></label></div>
      <div class="fila"><label>Celular<input id="alCel" inputmode="tel" value="${esc(d.cel || '')}"></label><label>Correo<input id="alMail" type="email"></label>
        <label>Tipo<select id="alTipo">${opts(['Productor', 'Farmacia', 'Clínica', 'MVZ', 'Distribuidor', 'Público'], 'Productor')}</select></label></div>
      <div class="fila"><label>Localidad<input id="alLoc"></label><label>Municipio<input id="alMun"></label><label>Estado<input id="alEdo" value="Chiapas"></label></div>
      <div class="fila"><label>Sucursal<select id="alSuc" ${U().todasSucursales ? '' : 'disabled'}>${optsSuc(sucTrabajo(), true)}</select></label></div></div>
      <div class="acciones"><button class="btn" onclick="${volver}">Cancelar</button><button class="btn primario" id="alGuardar" onclick="App.guardarAltaProspecto()">✔ Dar de alta</button></div>`);
  }
  async function guardarAltaProspecto() {
    const A = S.alta, g = s => $(s).value.trim(); if (!A) return;
    if (!g('#alNom')) return toast('Escribe el nombre del cliente', true);
    const idc = uid();
    const datos = { ID_Cliente: idc, Nombre_cliente: g('#alNom'), Razon_social: g('#alNom'), Nombre_Rancho: g('#alRancho'), Celular: g('#alCel'), 'e-mail': g('#alMail'), Tipo: $('#alTipo').value,
      Localidad: g('#alLoc'), 'Municipio/Delegación': g('#alMun'), Estado: g('#alEdo'), ID_Sucursal: $('#alSuc').value || sucTrabajo(), Lista_de_Precios: 'Publico', D_Credito: 0, Status: 'Activo', Vendedor: U().id };
    const p = { cliente: datos, nombreProspecto: A.nombre, idVisita: A.tipo === 'visita' ? A.id : '', idReceta: A.tipo === 'receta' ? A.id : '' };
    const local = { id: idc, nombre: datos.Nombre_cliente, razon: datos.Razon_social, rancho: datos.Nombre_Rancho, cel: datos.Celular, lista: 'Publico', credito: 0, status: 'Activo', suc: datos.ID_Sucursal,
      localidad: datos.Localidad, municipio: datos['Municipio/Delegación'], estado: datos.Estado, rfc: '' };
    const aplicarLocal = () => { const arr = D().clientes = D().clientes || []; if (!arr.some(x => x.id === idc)) arr.push(local); LS.set('datos', S.datos); };
    $('#alGuardar').disabled = true;
    try {
      const r = await pedir('altaProspecto', p); aplicarLocal();
      toast('✔ ' + datos.Nombre_cliente + ' dado de alta como cliente' + (r.visitas || r.recetas ? ' · se ligaron ' + r.visitas + ' visita(s) y ' + r.recetas + ' receta(s)' : ''));
      if (S.seg) S.seg._t = 0; if (S.vista === 'visitas') cargarVisitas(); if (S.vista === 'recetas') cargarRecetas();
      A.tipo === 'visita' ? verVisita(A.id) : verReceta(A.id);
    } catch (e) {
      if (!e.red) { if ($('#alGuardar')) $('#alGuardar').disabled = false; return; }
      encolar('altaProspecto', p, 'Alta de cliente ' + datos.Nombre_cliente); aplicarLocal();
      toast('📴 Cliente guardado en el dispositivo; sus visitas y recetas se ligan al volver la conexión'); cerrarModal();
    }
  }
  /** Historia clínica: visitas, recetas (pacientes y diagnósticos), ventas y cotizaciones del cliente en una sola línea de tiempo. */
  const HC_ICO = { visita: ['📅', 'Visita'], receta: ['💊', 'Receta'], venta: ['🧾', 'Venta'], cotizacion: ['📝', 'Cotización'] };
  async function historiaCliente(id) {
    let r; try { r = await pedir('historialCliente', { id: id }, true); } catch (e) { if (e.red) toast('La historia clínica se consulta con conexión', true); return; }
    S.hc = r; S.hcFiltro = '';
    const c = r.cliente, R = r.resumen, kpi = (t, v, s) => `<div class="kpi"><small>${t}</small><b>${v}</b><span>${s || ''}</span></div>`;
    modal('📖 Historia clínica · ' + (c.razon || c.nombre), `<div class="imprimible"><div class="hc-cab"><h3 style="margin:0">${esc(c.razon || c.nombre)}</h3>${c.razon && c.nombre && c.razon !== c.nombre ? `<div>${esc(c.nombre)}</div>` : ''}${c.rancho ? `<div class="muted">🐄 ${esc(c.rancho)}</div>` : ''}</div>
      <div class="kpis">${kpi('📅 Visitas', nf(R.visitas), R.ultVisita ? 'última ' + esc(R.ultVisita) : '')}${kpi('💊 Recetas', nf(R.recetas), R.ultReceta ? 'última ' + esc(R.ultReceta) : '')}${kpi('🧾 Ventas', nf(R.ventas), R.ultCompra ? 'última ' + esc(R.ultCompra) : '')}${R.cotizaciones ? kpi('📝 Cotizaciones', nf(R.cotizaciones), '') : ''}</div>
      ${r.pacientes.length ? `<div class="fc-sec"><h4>🐄 Pacientes</h4>${tabla([{ t: 'Paciente', h: x => `<b>${esc([x.especie, x.animal].filter(Boolean).join(' · ') || 'Sin identificar')}</b>${x.raza ? `<br><small class="muted">${esc(x.raza)}</small>` : ''}` },
        { t: 'Recetas', num: 1, h: x => nf(x.recetas) }, { t: 'Última', k: 'ult' }, { t: 'Diagnósticos', h: x => esc(x.diagnosticos.join(' · ') || x.ultDx) }], r.pacientes)}</div>` : ''}
      <div class="pestanas no-imprimir" id="hcFil">${[['', 'Todo'], ['visita', '📅 Visitas'], ['receta', '💊 Recetas'], ['venta', '🧾 Ventas'], ['cotizacion', '📝 Cotizaciones']].map(x => `<button class="${x[0] === '' ? 'activo' : ''}" onclick="App.filtroHC('${x[0]}')">${x[1]}</button>`).join('')}</div>
      <div id="hcEv"></div></div>
      <div class="acciones no-imprimir"><button class="btn" onclick="App.fichaCliente('${esc(id)}')">👤 Ficha</button><button class="btn" onclick="App.imprimir()">🖨️ Imprimir</button>
        ${puede('seguimiento') ? `<button class="btn" onclick="App.formVisita({idCliente:'${esc(id)}', realizada:1})">✅ Registrar visita</button>` : ''}
        ${puede('recetas') ? `<button class="btn" onclick="App.formRecetaCli('${esc(id)}')">💊 Nueva receta</button>` : ''}
        ${puede('ventas') ? `<button class="btn primario" onclick="App.venderA('${esc(id)}')">🛒 Venderle</button>` : ''}</div>`);
    pintarHC();
  }
  function filtroHC(t) { S.hcFiltro = t; document.querySelectorAll('#hcFil button').forEach((b, i) => b.classList.toggle('activo', ['', 'visita', 'receta', 'venta', 'cotizacion'][i] === t)); pintarHC(); }
  function pintarHC() {
    const el = $('#hcEv'), r = S.hc; if (!el || !r) return;
    const l = r.eventos.filter(e => !S.hcFiltro || e.tipo === S.hcFiltro);
    const abrir = e => e.tipo === 'visita' ? `App.verVisita('${esc(e.id)}')` : e.tipo === 'receta' ? `App.verReceta('${esc(e.id)}')` : e.tipo === 'venta' ? `App.verVentaId('${esc(e.id)}')` : `App.verCot('${esc(e.id)}')`;
    el.innerHTML = !l.length ? '<div class="vacio">Sin registros</div>' : `<div class="hc-linea">${l.map(e => `<div class="hc-ev hc-${e.tipo}" onclick="${abrir(e)}">
      <div class="hc-ico">${HC_ICO[e.tipo][0]}</div><div class="hc-cuerpo"><div class="hc-tit"><b>${esc(e.titulo)}</b>${e.estado ? ` <span class="etq">${esc(e.estado)}</span>` : ''}<span class="hc-fecha">${esc(e.fecha)}</span></div>
      ${e.paciente ? `<div>🐄 ${esc(e.paciente)}</div>` : ''}${e.diagnostico || e.motivo ? `<div>🩺 ${esc(e.diagnostico || e.motivo)}</div>` : ''}
      ${e.tratamientos && e.tratamientos.length ? `<div class="muted">℞ ${esc(e.tratamientos.slice(0, 3).join(' · ').slice(0, 220))}</div>` : ''}
      ${e.detalle ? `<div class="muted" style="white-space:pre-wrap">${esc(String(e.detalle).slice(0, 300))}</div>` : ''}
      <div class="hc-ligas">${e.recetas && e.recetas.length ? '💊 ' + esc(e.recetas.join(', ')) + ' ' : ''}${e.venta ? '🧾 ' + esc(e.venta) + ' ' : ''}${e.surtir ? '🏬 Surtir en ' + esc(e.surtir) + ' ' : ''}${e.vendedor ? '👤 ' + esc(e.vendedor) : ''}${e.elaboro ? '👤 ' + esc(e.elaboro) : ''}</div></div></div>`).join('')}</div>`;
  }

  /* ----- Recetas ----- */
  async function cfgRx() { if (!S.rxCfg) { try { S.rxCfg = await pedir('configReceta', {}, true); } catch (e) { S.rxCfg = { vigencia: 15, especies: RX_ESPECIES, maxT: 8 }; } } return S.rxCfg; }
  V.recetas = () => {
    const f = S.fRx = alDia(S.fRx || { desde: hoyISO().slice(0, 8) + '01', hasta: hoyISO(), hastaHoy: hoyISO(), q: '' });
    $('#vista').innerHTML = `<div class="tarjeta"><div class="fila">
        <label>Desde<input type="date" id="rxDesde" value="${f.desde}"></label><label>Hasta<input type="date" id="rxHasta" value="${f.hasta}"></label>
        <label>Surtir en<select id="rxSucF">${optsSuc(f.suc || '', true, 'Todas')}</select></label>
        <label style="flex:2 1 220px">Buscar<input id="rxQ" value="${esc(f.q)}" placeholder="Folio, propietario, animal, diagnóstico o medicamento"></label>
        <button class="btn primario fijo" onclick="App.formReceta()">💊 Nueva receta</button></div></div>
      <div id="rxRes"><div class="vacio">Cargando…</div></div>`;
    ['rxDesde', 'rxHasta', 'rxSucF'].forEach(id => $('#' + id).onchange = cargarRecetas);
    $('#rxQ').oninput = e => { f.q = e.target.value; pintarRecetas(); };
    cargarRecetas();
  };
  async function cargarRecetas() {
    const f = S.fRx; if (!$('#rxDesde')) return;
    f.desde = $('#rxDesde').value; f.hasta = $('#rxHasta').value; f.suc = $('#rxSucF') ? $('#rxSucF').value : ''; marcarHoy(f);
    try { S.rxLista = (await pedir('listarRecetas', { desde: f.desde, hasta: f.hasta, sucCompra: f.suc }, true)).recetas; }
    catch (e) { if ($('#rxRes')) $('#rxRes').innerHTML = `<div class="vacio">${e.red ? 'Consultar recetas requiere conexión.' : esc(e.message)}</div>`; return; }
    pintarRecetas();
  }
  function pintarRecetas() {
    const el = $('#rxRes'); if (!el || !S.rxLista) return;
    const f = S.fRx, l = S.rxLista.filter(r => !f.q || coincide([r.folio, r.propietario, r.animal, r.especie, r.diagnostico, r.motivo, r.tratamientos.map(t => t.texto).join(' ')].join(' '), f.q));
    S.rxVis = l;
    el.innerHTML = tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', h: r => `<b>${esc(r.folio)}</b>` }, { t: 'Propietario', h: r => esc(r.propietario) },
      { t: 'Paciente', cls: 'ocultar-movil', h: r => esc([r.especie, r.animal ? '#' + r.animal : '', r.raza].filter(Boolean).join(' · ')) },
      { t: 'Diagnóstico', h: r => esc(r.diagnostico || r.motivo) }, { t: 'Surtir en', cls: 'ocultar-movil', h: r => r.sucCompra ? esc(sucNom(r.sucCompra)) : '<span class="muted">—</span>' },
      { t: 'Liga', cls: 'ocultar-movil', h: r => (r.idVisita ? '📅' : '') + (r.idVenta ? '🧾' : '') + (!r.idCliente ? ' <span class="etq">Prospecto</span>' : '') }, { t: 'Vigencia', h: r => `<span class="etq ${r.vigente ? 'ok' : ''}">${r.vigente ? 'Vigente' : 'Vencida'}</span><br><small class="muted">${esc(r.validez)}</small>` }],
      l, { clic: 'App.abrirReceta', vacio: 'Sin recetas en el periodo' });
  }
  async function verReceta(id) {
    let d; try { d = await pedir('detalleReceta', { id: id }); } catch (e) { return; }
    S.ultimaRx = d;
    const dato = (t, v) => v ? `<div class="fc-dato"><small>${t}</small><span>${esc(v)}</span></div>` : '';
    const prods = d.tratamientos.filter(t => t.prod && prod(t.prod));
    const puedeEd = U().rol === 'Administrador' || d.elaboro === U().nombre;
    modal('Receta ' + d.folio, `<div class="ficha-cli">
      <div class="fc-cab"><div><h3>℞ ${esc(d.folio)} · ${esc(d.propietario)}</h3><div class="fc-etqs"><span class="etq ${d.vigente ? 'ok' : ''}">${d.vigente ? 'Vigente hasta ' : 'Venció el '}${esc(d.validez)}</span><span class="etq">${esc(d.fecha)}</span>${d.elaboro ? `<span class="etq">Elaboró ${esc(d.elaboro)}</span>` : ''}</div></div></div>
      <div class="fc-sec"><h4>🐄 Paciente</h4><div class="fc-rejilla">${dato('Especie', d.especie)}${dato('Nombre / ID', d.animal)}${dato('Raza / cruza', d.raza)}${dato('Edad', d.edad)}${dato('Sexo', d.sexo)}${dato('Peso', d.peso)}${dato('Color', d.color)}${dato('Celular', d.cel)}</div></div>
      ${d.motivo || d.diagnostico ? `<div class="fc-sec"><h4>🩺 Consulta</h4><div class="fc-rejilla">${dato('Motivo', d.motivo)}${dato('Diagnóstico', d.diagnostico)}</div></div>` : ''}
      <div class="fc-sec"><h4>💊 Tratamiento</h4><ol class="rx-lista">${d.tratamientos.map(t => `<li>${t.conNombre ? `<b>${esc(t.nombre)}</b><br>` : ''}${esc(t.texto)}</li>`).join('')}</ol>${d.obs ? `<p class="muted">${esc(d.obs)}</p>` : ''}</div>
      ${!d.idCliente ? `<div class="aviso-cand">🌱 <b>Sin cliente.</b> ${d.puedeAlta ? 'Da de alta al propietario como cliente para venderle y llevar su historia clínica.' : 'Pide al administrador que dé de alta al propietario como cliente.'}
        ${d.puedeAlta ? `<div class="acciones izq"><button class="btn primario chico" onclick="App.formAltaProspecto('receta')">➕ Dar de alta como cliente</button></div>` : ''}</div>` : ''}
      ${segIntegra('receta', d)}
      <div class="arch-par">${d.firma ? bloqueArch('recFirma', d.id) : ''}${d.pdfAnterior ? bloqueArch('recPdf', d.id) : ''}</div>
      ${!d.cfg.cedula ? `<p class="muted" style="font-size:13px">ℹ️ Falta capturar el nombre y la cédula del MVZ que firma las recetas${U().rol === 'Administrador' ? ' (en Configuración)' : ''}.</p>` : ''}
      <div class="acciones">
        <button class="btn primario" onclick="App.pdfReceta('${esc(d.id)}')">📄 PDF para enviar</button>
        ${prods.length && puede('cotizaciones') ? `<button class="btn" onclick="App.rxACotizacion('${esc(d.id)}')">📝 Cotizar sus medicamentos</button>` : ''}
        ${prods.length && puede('ventas') && d.idCliente ? `<button class="btn" onclick="App.rxAVenta('${esc(d.id)}')">🛒 Venderle</button>` : ''}
        ${d.idCliente ? `<button class="btn" onclick="App.historiaCliente('${esc(d.idCliente)}')">📖 Historia clínica</button>` : ''}
        <button class="btn" onclick="App.formReceta('${esc(d.id)}', 1)">📋 Duplicar</button>
        ${puedeEd ? `<button class="btn" onclick="App.formReceta('${esc(d.id)}')">✏️ Editar</button>` : ''}
      </div></div>`);
  }
  function pdfReceta(id) {
    const d = S.ultimaRx || {};
    generarPdf('pdfReceta', { id: id }, { cel: d.cel, asunto: 'Receta ' + (d.folio || ''), texto: 'Interés Veterinario — Receta ' + (d.folio || '') + ' (' + (d.propietario || '') + ')', volver: `App.verReceta('${id}')` });
  }
  function rxLineas(d) { return d.tratamientos.filter(t => t.prod && prod(t.prod)).map(t => t.prod).filter((x, i, a) => a.indexOf(x) === i); }
  function rxACotizacion(id) {
    const d = S.ultimaRx; if (!d || d.id !== id) return;
    if (S.cot && S.cot.lineas.length && !confirm('Tienes una cotización en captura que se va a reemplazar. ¿Continuar?')) return;
    const v = cotNueva(), c = d.idCliente ? cliente(d.idCliente) : null, listas = (D().catalogos || {}).listas || [];
    if (c) { v.cli = c.id; v.lista = c.lista && listas.indexOf(c.lista) >= 0 ? c.lista : 'Publico'; }
    v.obs = 'Receta ' + d.folio;
    v.lineas = rxLineas(d).map(p => ({ id: p, cant: 1, precio: (prod(p).precios || {})[v.lista] || 0, desc: 0 }));
    S.cot = v; LS.set('borrador_cot', v); cerrarModal(); S.tabCot = 'nueva'; ir('cotizaciones');
  }
  function rxAVenta(id) {
    const d = S.ultimaRx; if (!d || d.id !== id) return;
    if (S.venta && S.venta.lineas.length && !confirm('Tienes una venta en captura que se va a reemplazar. ¿Continuar?')) return;
    S.venta = ventaNueva(); S.venta.ligar = { receta: d.id, visita: d.idVisita || '' };
    if (d.sucCompra && d.sucCompra !== S.venta.suc) { if ((D().permitidas || []).indexOf(d.sucCompra) >= 0) S.venta.suc = d.sucCompra; else toast('La receta se canalizó a ' + sucNom(d.sucCompra), true); }
    cerrarModal(); ir('venta');
    if (d.idCliente && cliente(d.idCliente)) elegirClienteVenta(d.idCliente);
    rxLineas(d).forEach(p => agregarLineaVenta(p));
    S.venta.comentarios = 'Receta ' + d.folio; guardarBorrador(); V.venta();
    toast('🔗 Al guardarla, la venta quedará relacionada con la receta ' + d.folio + (d.idVisita ? ' y su visita' : ''));
  }
  /** o (opcional): { idVisita, idCliente, propietario, cel } — receta que sale de una visita */
  async function formReceta(id, duplicar, o) {
    const cfg = await cfgRx();
    let d = null; o = o || {};
    if (id) { try { d = await pedir('detalleReceta', { id: id }); } catch (e) { return; } }
    const nueva = !d || !!duplicar;
    const cli0 = d ? d.idCliente : o.idCliente || '';
    S.rx = { id: nueva ? uid() + uid() : d.id, nueva: nueva, cli: cli0, lineas: d ? d.tratamientos.map(t => ({ prod: t.prod, texto: t.texto })) : [{ prod: '', texto: '' }], firma: '',
      visita: o.idVisita || (d && !duplicar ? d.idVisita || '' : ''), suc: (d && d.sucCompra) || (cli0 && (cliente(cli0) || {}).suc) || sucTrabajo() };
    const c = S.rx.cli ? cliente(S.rx.cli) : null, v = (k, def) => d && d[k] !== undefined ? esc(d[k]) : (def || '');
    modal(nueva ? '💊 Nueva receta' : 'Editar receta ' + d.folio, `<div id="fRx" class="form-rx">
      ${S.rx.visita ? `<p class="muted" style="margin:0 0 8px;font-size:13px">📅 Receta de la visita${S.ultimaVis && S.ultimaVis.id === S.rx.visita ? ' del ' + esc(S.ultimaVis.fecha) : ''}: quedará relacionada con ella.</p>` : ''}
      <div class="fc-sec"><h4>Propietario</h4>
        <label>Cliente (opcional; si es prospecto, déjalo vacío y escribe el propietario)<div class="buscador"><input id="rxCli" placeholder="Buscar cliente…" autocomplete="off" value="${c ? esc(c.razon || c.nombre) : ''}"></div></label>
        <div class="fila"><label style="flex:2 1 200px">Propietario<input id="rxProp" value="${v('propietario', c ? esc(c.nombre) : esc(o.propietario || ''))}"></label><label>Celular<input id="rxCel" inputmode="tel" value="${v('cel', c ? esc(c.cel || '') : esc(o.cel || ''))}"></label></div>
        <label>🏬 Surtir en la sucursal<select id="rxSuc">${optsSuc(S.rx.suc, true)}</select></label></div>
      <div class="fc-sec"><h4>Paciente</h4><div class="fila">
        <label>Especie<select id="rxEsp">${opts(cfg.especies || RX_ESPECIES, d ? d.especie : 'Bovino')}</select></label><label>Nombre / arete<input id="rxAni" value="${v('animal')}"></label>
        <label>Raza / cruza<input id="rxRaza" value="${v('raza')}"></label></div><div class="fila">
        <label>Edad<input id="rxEdad" value="${v('edad')}" placeholder="2 años"></label><label>Sexo<select id="rxSexo">${opts(['Hembra', 'Macho'], d ? d.sexo : '', '—')}</select></label>
        <label>Peso (kg)<input id="rxPeso" value="${v('peso')}" inputmode="decimal"></label><label>Color<input id="rxColor" value="${v('color')}"></label></div></div>
      <div class="fc-sec"><h4>Consulta</h4><div class="fila"><label style="flex:1 1 220px">Motivo de consulta<input id="rxMot" value="${v('motivo')}"></label><label style="flex:1 1 220px">Diagnóstico<input id="rxDx" value="${v('diagnostico')}"></label></div></div>
      <div class="fc-sec"><h4>℞ Tratamiento</h4><div id="rxLin"></div>
        <button class="btn chico" type="button" id="rxMasT" onclick="App.rxMas()">➕ Agregar tratamiento</button>
        <label style="margin-top:8px">Observaciones<input id="rxObs" value="${v('obs')}" placeholder="Tiempo de retiro, recomendaciones de manejo…"></label>
        <label style="max-width:180px">Vigencia (días)<input type="number" id="rxVig" min="1" max="90" value="${cfg.vigencia || 15}"></label></div>
      <div class="fc-sec"><h4>✍️ Firma ${!nueva && d.firma ? '<small class="muted">(ya tiene firma; firma de nuevo solo si quieres cambiarla)</small>' : ''}</h4>
        <canvas id="rxFirma" class="firma-pad" width="600" height="180"></canvas>
        <div class="acciones izq"><button class="btn chico" type="button" onclick="App.rxLimpiarFirma()">Borrar firma</button></div></div>
      <div class="acciones"><button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" id="rxGuardar" onclick="App.guardarReceta()">💾 Guardar receta</button></div></div>`);
    buscador($('#rxCli'), { fuente: fuenteClientes, alElegir: x => { S.rx.cli = x.id; const cc = cliente(x.id) || {}; if (!$('#rxProp').value.trim() || nueva) $('#rxProp').value = cc.nombre || cc.razon || ''; if (!$('#rxCel').value.trim()) $('#rxCel').value = cc.cel || ''; if (cc.suc && !S.rx.sucTocada) $('#rxSuc').value = cc.suc; } });
    $('#rxSuc').onchange = () => { S.rx.sucTocada = true; };
    $('#rxCli').addEventListener('input', e => { if (!e.target.value.trim()) S.rx.cli = ''; });
    pintarRxLineas(); padFirma($('#rxFirma'));
  }
  /** En la receta va el medicamento sin la presentación: "Ceftiofur 5%, Frasco de 100 ml." → "Ceftiofur 5%". */
  const nombreRx = n => { const t = String(n || '').trim(), i = t.indexOf(','); return (i > 0 ? t.slice(0, i) : t).replace(/[.\s]+$/, '').trim(); };
  function pintarRxLineas() {
    const cont = $('#rxLin'); if (!cont) return;
    cont.innerHTML = S.rx.lineas.map((l, i) => { const p = l.prod ? prod(l.prod) : null; return `<div class="rx-lin" data-i="${i}"><b>${i + 1}.</b><div class="rx-campos">
      <div class="buscador"><input data-prod placeholder="Medicamento del catálogo (opcional)" autocomplete="off" value="${p ? esc(nombreRx(p.nombre)) : ''}"></div>
      <textarea data-t rows="2" placeholder="Dosis, vía, frecuencia y días. Ej. 1 ml por cada 10 kg, intramuscular, cada 24 h por 3 días">${esc(l.texto)}</textarea></div>
      <button class="icono" type="button" title="Quitar" data-del>✕</button></div>`; }).join('');
    cont.querySelectorAll('.rx-lin').forEach(row => {
      const i = +row.dataset.i, l = S.rx.lineas[i], inp = row.querySelector('[data-prod]'), ta = row.querySelector('[data-t]');
      buscador(inp, { fuente: q => fuenteProductos(sucTrabajo(), '', true)(q), alElegir: x => { l.prod = x.id; const n = nombreRx((prod(x.id) || {}).nombre || x.t); inp.value = n; if (!ta.value.trim()) { ta.value = n + '. '; l.texto = ta.value; } ta.focus(); } });
      inp.addEventListener('input', () => { if (!inp.value.trim()) l.prod = ''; });
      ta.oninput = () => { l.texto = ta.value; };
      row.querySelector('[data-del]').onclick = () => { S.rx.lineas.splice(i, 1); if (!S.rx.lineas.length) S.rx.lineas.push({ prod: '', texto: '' }); pintarRxLineas(); };
    });
    if ($('#rxMasT')) $('#rxMasT').disabled = S.rx.lineas.length >= ((S.rxCfg && S.rxCfg.maxT) || 8);
  }
  function rxMas() { if (S.rx.lineas.length < ((S.rxCfg && S.rxCfg.maxT) || 8)) { S.rx.lineas.push({ prod: '', texto: '' }); pintarRxLineas(); const t = document.querySelectorAll('#rxLin [data-prod]'); if (t.length) t[t.length - 1].focus(); } }
  /** Panel de firma: dedo, mouse o Apple Pencil (pointer events), nítido en pantallas Retina, sin mover la página. */
  /* ---------- MÓVIL: barra fija con el total y el botón Guardar (venta, cotización, compra, traspaso, ajuste) ---------- */
  const BARRAS_DOC = [['#vGuardar', '#vTot', '#vLineas'], ['#cGuardar', '#cTot', '#cLineas'], ['#ocGuardar', '#ocTot', '#ocLineas'], ['#trGuardar', '', '#trLineas'], ['#ajGuardar', '', '#ajLineas']];
  const barraDoc = { btn: null };
  function revisarBarraDoc() {
    const def = BARRAS_DOC.find(d => $(d[0]) && $(d[0]).closest('#vista'));
    if (!def) { quitarBarraDoc(); return; }
    const btn = $(def[0]); if (barraDoc.btn === btn) return actBarraDoc();
    quitarBarraDoc();
    const b = document.createElement('div'); b.id = 'barraDoc'; b.className = 'barra-doc oculta';
    b.innerHTML = '<div class="bd-info"><small></small><b></b></div><button class="btn primario"></button>';
    b.querySelector('button').onclick = () => { const x = barraDoc.btn; if (x && !x.disabled) x.click(); };
    document.body.appendChild(b);
    Object.assign(barraDoc, { btn: btn, tot: def[1], lin: def[2], el: b, visible: false });
    barraDoc.io = new IntersectionObserver(e => { barraDoc.visible = e[0].isIntersecting; actBarraDoc(); }); barraDoc.io.observe(btn);
    actBarraDoc();
  }
  function actBarraDoc() {
    const B = barraDoc, b = B.el; if (!b || !B.btn) return;
    if (!document.body.contains(B.btn)) return quitarBarraDoc();
    const n = document.querySelectorAll(B.lin + ' .linea:not(.cab)').length;
    const g = B.tot && $(B.tot) && $(B.tot).querySelector('.gran span:last-child, .gran b:last-child');
    b.querySelector('small').textContent = n ? n + (n === 1 ? ' producto' : ' productos') : 'Sin productos';
    b.querySelector('b').textContent = g ? g.textContent : '';
    const bt = b.querySelector('button'); bt.textContent = B.btn.textContent.trim(); bt.disabled = B.btn.disabled;
    b.classList.toggle('oculta', B.visible || !n || !$('#modal').classList.contains('oculto'));
  }
  function quitarBarraDoc() { if (barraDoc.io) barraDoc.io.disconnect(); if (barraDoc.el) barraDoc.el.remove(); Object.assign(barraDoc, { btn: null, el: null, io: null }); }
  let tBarraDoc = 0;
  function iniciarBarraDoc() {
    const mo = new MutationObserver(() => { clearTimeout(tBarraDoc); tBarraDoc = setTimeout(revisarBarraDoc, 120); });
    const v = $('#vista'); if (v) mo.observe(v, { childList: true, subtree: true, characterData: true });
    const m = $('#modal'); if (m) new MutationObserver(() => actBarraDoc()).observe(m, { attributes: true, attributeFilter: ['class'] });
  }
  /* ---------- MÓVIL: al agregar un producto, el buscador queda a la vista y listo para el siguiente ---------- */
  function iniciarBuscadorMovil() {
    document.addEventListener('focusin', e => {
      const i = e.target; if (!i.matches || !i.matches('.buscador-prod input')) return;
      if (window.innerWidth <= 700) setTimeout(() => { try { i.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (er) {} }, 250);
    });
  }
  function padFirma(cv) {
    if (!cv || cv._pad) return; cv._pad = 1;
    const r0 = cv.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
    if (r0.width > 0 && r0.height > 0) { cv.width = Math.round(r0.width * dpr); cv.height = Math.round(r0.height * dpr); }
    const x = cv.getContext('2d'), base = 2.2 * (cv.width / Math.max(1, r0.width || cv.width));
    x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#1a2a6c'; x.lineWidth = base;
    let pinta = false, ult = null;
    const pos = e => { const r = cv.getBoundingClientRect(), t = e.touches ? e.touches[0] : e; return [(t.clientX - r.left) * cv.width / r.width, (t.clientY - r.top) * cv.height / r.height]; };
    const ini = e => { pinta = true; ult = pos(e); x.beginPath(); x.moveTo(ult[0], ult[1]); if (e.pointerId !== undefined && cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (er) {} } e.preventDefault(); };
    const mov = e => {
      if (!pinta) return; e.preventDefault();
      const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      (pts.length ? pts : [e]).forEach(ev => {
        const p = pos(ev), m = [(ult[0] + p[0]) / 2, (ult[1] + p[1]) / 2];
        x.lineWidth = ev.pointerType === 'pen' && ev.pressure ? base * (0.5 + ev.pressure) : base;
        x.quadraticCurveTo(ult[0], ult[1], m[0], m[1]); x.stroke(); x.beginPath(); x.moveTo(m[0], m[1]); ult = p;
      });
      cv._firmado = true;
    };
    const fin = () => { pinta = false; ult = null; };
    if (window.PointerEvent) {
      cv.addEventListener('pointerdown', ini); cv.addEventListener('pointermove', mov); cv.addEventListener('pointerup', fin); cv.addEventListener('pointercancel', fin);
      cv.addEventListener('touchstart', e => e.preventDefault(), { passive: false }); cv.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    } else {
      cv.addEventListener('mousedown', ini); cv.addEventListener('mousemove', mov); window.addEventListener('mouseup', fin);
      cv.addEventListener('touchstart', ini, { passive: false }); cv.addEventListener('touchmove', mov, { passive: false }); cv.addEventListener('touchend', fin);
    }
  }
  /** Firma de recibido a pantalla completa (iPhone / iPad). Resuelve { png, nombre }, { omitida: true } o null (cancelar). */
  function capturarFirma(o) {
    o = o || {};
    return new Promise(res => {
      const capa = document.createElement('div'); capa.className = 'firma-capa';
      capa.innerHTML = `<div class="firma-caja"><div class="firma-enc"><b>✍️ ${esc(o.titulo || 'Firma')}</b><button class="btn chico" data-a="x">✕</button></div>
        ${o.nombre !== false ? `<label class="firma-nom">Nombre de quien ${esc(o.verbo || 'recibe')}<input id="fmNom" value="${esc(o.nombreIni || '')}" autocomplete="off"></label>` : ''}
        <div class="firma-zona"><canvas class="firma-pad firma-grande"></canvas><span class="firma-guia">Firme aquí</span></div>
        <div class="acciones"><button class="btn" data-a="b">🧽 Borrar</button>${o.opcional ? `<button class="btn" data-a="o">${esc(o.omitirTxt || 'Continuar sin firma')}</button>` : ''}<button class="btn primario" data-a="g">✔ ${esc(o.okTxt || 'Guardar firma')}</button></div></div>`;
      document.body.appendChild(capa); document.body.classList.add('sin-scroll');
      const cv = capa.querySelector('canvas'); requestAnimationFrame(() => padFirma(cv));
      const cerrar = v => { capa.remove(); document.body.classList.remove('sin-scroll'); res(v); };
      capa.addEventListener('click', e => {
        const a = e.target.closest('[data-a]'); if (!a) return;
        if (a.dataset.a === 'x') cerrar(null);
        else if (a.dataset.a === 'o') cerrar({ omitida: true, nombre: capa.querySelector('#fmNom') ? capa.querySelector('#fmNom').value.trim() : '' });
        else if (a.dataset.a === 'b') { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); cv._firmado = false; }
        else if (a.dataset.a === 'g') {
          if (!cv._firmado) return toast('Falta la firma', true);
          const nom = capa.querySelector('#fmNom') ? capa.querySelector('#fmNom').value.trim() : '';
          if (o.nombre !== false && o.nombreObl !== false && !nom) return toast('Escribe el nombre de quien ' + (o.verbo || 'recibe'), true);
          cerrar({ png: firmaPng(cv), nombre: nom });
        }
      });
    });
  }
  /** PNG recortado a la firma y reducido (máx. 900 px de ancho) para que pese poco. */
  function firmaPng(cv) {
    const w = cv.width, h = cv.height, d = cv.getContext('2d').getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 <= x0) return cv.toDataURL('image/png');
    const m = 12; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w, x1 + m); y1 = Math.min(h, y1 + m);
    const k = Math.min(1, 900 / (x1 - x0)), c2 = document.createElement('canvas'); c2.width = Math.round((x1 - x0) * k); c2.height = Math.round((y1 - y0) * k);
    c2.getContext('2d').drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, c2.width, c2.height);
    return c2.toDataURL('image/png');
  }
  const FIRMA_INFO = { ventaFirma: { titulo: 'Firma de recibido', verbo: 'recibe' }, ocFirma: { titulo: 'Firma de recepción de mercancía', verbo: 'recibe' }, trFirma: { titulo: 'Firma de recibido del traspaso', verbo: 'recibe' } };
  async function subirFirma(tipo, id, f) {
    try { await pedir('subirArchivo', { tipo: tipo, id: id, dataUri: f.png, recibio: f.nombre || '' }); return true; }
    catch (e) { if (e.red) toast('Sin conexión: la firma no se guardó; captúrala al reconectar', true); return false; }
  }
  async function firmaArch(tipo, id) {
    const f = await capturarFirma(Object.assign({}, FIRMA_INFO[tipo], { nombreObl: tipo !== 'ocFirma' })); if (!f || !f.png) return;
    toast('Guardando firma…');
    if (await subirFirma(tipo, id, f)) { toast('✔ Firma guardada'); cargarArch(tipo, id); }
  }
  function rxLimpiarFirma() { const cv = $('#rxFirma'); if (cv) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); cv._firmado = false; } }
  async function guardarReceta() {
    const R = S.rx, g = s => $(s).value.trim();
    const ts = R.lineas.map(l => ({ texto: String(l.texto || '').trim(), prod: l.prod || '' })).filter(t => t.texto);
    if (!g('#rxProp')) return toast('Escribe el nombre del propietario', true);
    if (!ts.length) return toast('Escribe al menos un tratamiento', true);
    const cv = $('#rxFirma');
    const p = { ID_Receta: R.id, nueva: R.nueva, ID_Cliente: R.cli, propietario: g('#rxProp'), cel: g('#rxCel'), especie: $('#rxEsp').value, animal: g('#rxAni'), raza: g('#rxRaza'),
      edad: g('#rxEdad'), sexo: $('#rxSexo').value, peso: g('#rxPeso'), color: g('#rxColor'), motivo: g('#rxMot'), diagnostico: g('#rxDx'), obs: g('#rxObs'),
      vigencia: Number($('#rxVig').value) || 15, tratamientos: ts, firma: cv && cv._firmado ? cv.toDataURL('image/png') : '', idVisita: R.visita || '', sucCompra: $('#rxSuc').value };
    $('#rxGuardar').disabled = true;
    try { const r = await pedir('guardarReceta', p); toast('✔ Receta ' + r.folio + ' guardada'); if (S.vista === 'recetas') cargarRecetas(); verReceta(R.id); }
    catch (e) {
      if (!e.red) { if ($('#rxGuardar')) $('#rxGuardar').disabled = false; return; }
      encolar('guardarReceta', p, 'Receta para ' + p.propietario); toast('📴 Receta guardada en el dispositivo; el folio se asigna al sincronizar'); cerrarModal();
    }
  }
  async function recetasDeCliente(id) {
    let r; try { r = await pedir('listarRecetas', { idCliente: id }); } catch (e) { return; }
    S.rxVis = r.recetas; const c = cliente(id) || {};
    modal('Recetas · ' + (c.razon || c.nombre || ''), tabla([{ t: 'Fecha', k: 'fecha' }, { t: 'Folio', k: 'folio' }, { t: 'Paciente', h: x => esc([x.especie, x.animal].filter(Boolean).join(' · ')) }, { t: 'Diagnóstico', h: x => esc(x.diagnostico || x.motivo) }], r.recetas, { clic: 'App.abrirReceta', vacio: 'Sin recetas' }) +
      `<div class="acciones"><button class="btn" onclick="App.fichaCliente('${esc(id)}')">← Ficha</button><button class="btn primario" onclick="App.formRecetaCli('${esc(id)}')">💊 Nueva receta</button></div>`);
  }
  async function formRecetaCli(id) { const c = cliente(id) || {}; await formReceta(null, null, { idCliente: id, propietario: c.nombre || c.razon || '', cel: c.cel || '' }); }
  function rxDesdeVisita() { const d = S.ultimaVis; if (!d) return; formReceta(null, null, { idVisita: d.id, idCliente: d.idCliente, propietario: d.cliente, cel: d.cel }); }
  async function guardarCfgReceta() {
    const g = s => $(s).value.trim();
    try { S.rxCfg = Object.assign(S.rxCfg || {}, await pedir('guardarConfigReceta', { mvz: g('#cfMvz'), cedula: g('#cfCed'), titulo: g('#cfTit'), leyenda: g('#cfLey'), vigencia: g('#cfVig') })); toast('✔ Datos de la receta guardados'); } catch (e) {}
  }
  async function cargarCfgReceta() {
    const el = $('#cfRx'); if (!el) return;
    S.rxCfg = null; const c = await cfgRx(); if (!$('#cfRx')) return;
    $('#cfRx').innerHTML = `<div class="fila"><label style="flex:2 1 240px">Nombre del MVZ que firma<input id="cfMvz" value="${esc(c.mvz || '')}" placeholder="MVZ José Manuel López Orozco"></label><label>Cédula profesional<input id="cfCed" value="${esc(c.cedula || '')}"></label></div>
      <div class="fila"><label style="flex:2 1 240px">Título / especialidad<input id="cfTit" value="${esc(c.titulo || '')}"></label><label>Vigencia (días)<input type="number" id="cfVig" min="1" max="90" value="${c.vigencia || 15}"></label></div>
      <label>Leyenda al pie de la receta<input id="cfLey" value="${esc(c.leyenda || '')}" placeholder="Medicamento de uso veterinario. Respete dosis, vía y tiempos de retiro."></label>
      <div class="acciones"><button class="btn primario" onclick="App.guardarCfgReceta()">💾 Guardar</button></div>`;
  }
  /** Bloque de seguimiento dentro de la ficha del cliente */
  async function cargarSegFicha(id) {
    const el = $('#fcSeg'); if (!el) return;
    let r; try { r = await pedir('seguimiento', { idCliente: id }, true); } catch (e) { const x = $('#fcSeg'); if (x) x.innerHTML = `<span class="muted">${e.red ? 'Disponible con conexión' : ''}</span>`; return; }
    const c = r.clientes[0], x = $('#fcSeg'); if (!x || x.dataset.id !== id) return;
    if (!c) { x.innerHTML = '<span class="muted">Sin datos</span>'; return; }
    x.innerHTML = `<div class="fc-rejilla"><div class="fc-dato"><small>Estado</small><span>${etqSeg(c.estado)}</span></div>
      <div class="fc-dato"><small>Última compra</small><span>${c.ult ? esc(c.ult) + ' (' + hace(c.sin) + ')' : 'Sin compras en 2 años'}</span></div>
      ${c.cada ? `<div class="fc-dato"><small>Compra cada</small><span>${c.cada} días</span></div>` : ''}
      ${c.mensual ? `<div class="fc-dato"><small>Promedio mensual</small><span>${$$(c.mensual)}</span></div>` : ''}
      <div class="fc-dato"><small>Visitas</small><span>${c.proxVisita ? '📅 Próxima ' + esc(c.proxVisita) : c.ultVisita ? 'Última ' + esc(c.ultVisita) : 'Sin visitas'}</span></div></div>
      ${c.toca.length ? `<div class="sg-toca"><small>Le toca reponer:</small> ${c.toca.map(t => `<span class="chip-op on">${esc(t.n)} <small>cada ${t.cada} d</small></span>`).join('')}</div>` : ''}`;
  }

  /* ---------- PEDIDO SUGERIDO (Compras) ---------- */
  const PED_DEF = { dias: 90, entrega: 7, cobertura: 30, seguridad: 7, horizonte: 180 };
  V.pedido = () => {
    const pp = Object.assign({}, PED_DEF, LS.get('pedidoParams', {}) || {});
    const num = (id, t, v, ayuda) => `<label title="${esc(ayuda)}">${t}<input type="number" id="${id}" min="0" value="${v}"></label>`;
    $('#vista').innerHTML = `<div class="tarjeta no-imprimir"><h3>🛒 Pedido sugerido y riesgo de caducidad</h3>
      <p class="muted">Se calcula al momento con lo que se vendió, lo que hay en cada sucursal (por lote y caducidad) y lo que ya viene en órdenes de compra. Cambia los días y presiona <b>Calcular</b>.</p>
      <div class="fila">
        <label title="Con cuántos días de venta se calcula el promedio diario">Venta base<select id="pdDias">${[30, 60, 90, 120, 180, 365].map(d => `<option value="${d}" ${+pp.dias === d ? 'selected' : ''}>Últimos ${d} días</option>`).join('')}</select></label>
        ${num('pdEnt', 'Días de entrega del proveedor', pp.entrega, 'Lo que tarda en llegar la mercancía desde que pides')}
        ${num('pdCob', 'Días que quiero cubrir', pp.cobertura, 'Para cuántos días de venta quieres tener producto con cada pedido')}
        ${num('pdSeg', 'Días de seguridad', pp.seguridad, 'Colchón por si se vende más o el proveedor se tarda')}
        ${num('pdHor', 'Revisar caducidades a (días)', pp.horizonte, 'Lotes que caducan dentro de estos días')}
        <button class="btn primario fijo" onclick="App.calcularPedido()">Calcular</button></div>
      <details style="margin-top:8px"><summary class="muted" style="cursor:pointer">¿Cómo se calcula?</summary><div class="muted" style="font-size:13px;line-height:1.5;margin-top:6px">
        <b>Venta diaria</b> = piezas vendidas en el periodo ÷ días (sin notas canceladas). ·
        <b>Existencia útil</b> = existencia − caducado − lo que <u>no se alcanzará a vender</u> antes de caducar (surtiendo primero lo que caduca antes). ·
        <b>Objetivo</b> (stock máximo) = venta diaria × (entrega + días a cubrir + seguridad). ·
        <b>Comprometido</b> (al 100 %) = lo pendiente de surtir de las requisiciones abiertas o parciales (en la sucursal que pide) + las piezas de las cotizaciones abiertas y vigentes. ·
        <b>Sugerido</b> = objetivo + comprometido − existencia útil − lo que ya viene en camino. ·
        Antes de comprar se proponen <b>traspasos</b> de las sucursales con sobrante a las que les falta; la <b>compra global</b> es lo que sigue faltando.
        <b>ABC</b>: A = productos que hacen el 80 % de la venta (cuídalos, que nunca falten), B = siguiente 15 %, C = resto (compra justo lo necesario).
        <b>80/20</b>: sucursales y clientes que concentran el 80 % de lo vendido de ese producto en los últimos 12 meses.</div></details></div>
      <div id="pdRes"><div class="vacio">Presiona Calcular.</div></div>`;
    if (S.ped) pintarPedido(); else calcularPedido();
  };
  /** Piezas comprometidas: requisiciones pendientes + cotizaciones abiertas (con sus folios). */
  const compTxt = g => !(g.req || g.cot) ? '—' : `<b>${nf((g.req || 0) + (g.cot || 0))}</b><br><small class="muted">${g.req ? nf(g.req) + ' req.' : ''}${g.req && g.cot ? ' · ' : ''}${g.cot ? nf(g.cot) + ' cot.' : ''}</small>${g.docs && g.docs.length ? `<br><small class="muted" title="${esc(g.docs.join(', '))}">${esc(g.docs.slice(0, 2).join(', '))}${g.docs.length > 2 ? '…' : ''}</small>` : ''}`;
  async function calcularPedido() {
    const p = { dias: +$('#pdDias').value, entrega: +$('#pdEnt').value, cobertura: +$('#pdCob').value, seguridad: +$('#pdSeg').value, horizonte: +$('#pdHor').value };
    LS.set('pedidoParams', p);
    $('#pdRes').innerHTML = '<div class="vacio">Calculando… (puede tardar unos segundos)</div>';
    try { S.ped = await pedir('pedidoSugerido', p); } catch (e) { if ($('#pdRes')) $('#pdRes').innerHTML = `<div class="vacio">${e.red ? 'Requiere conexión.' : esc(e.message || 'No se pudo calcular')}</div>`; return; }
    S.ped.comprarEdit = {}; if ($('#pdRes')) pintarPedido();   // si ya se cambió de pantalla, se pinta al volver
  }
  const pdNom = id => ((S.ped && S.ped.productos[id]) || {}).n || id;
  const pdLab = id => ((S.ped && S.ped.productos[id]) || {}).lab || '';
  const pdSuc = id => ((S.ped && S.ped.sucursales.find(s => s.id === id)) || {}).nombre || sucNom(id);
  const etqAbc = a => a && a !== '-' ? `<span class="etq abc-${a}" title="Clase ${a}">${a}</span>` : '';
  const tendTxt = t => t === null || t === undefined ? '' : t >= 1.25 ? `<span class="etq ok" title="El último mes vende ${Math.round((t - 1) * 100)} % más que el promedio">▲ ${Math.round((t - 1) * 100)}%</span>` : t <= 0.75 ? `<span class="etq av" title="El último mes vende ${Math.round((1 - t) * 100)} % menos que el promedio">▼ ${Math.round((1 - t) * 100)}%</span>` : '';
  function pintarPedido() {
    const r = S.ped; if (!r || !$('#pdRes')) return;
    const tab = S.pedTab || 'compra';
    const comprar = r.global.filter(g => g.comprar > 0), tot = comprar.reduce((a, g) => a + (g.costo || 0), 0);
    const piezasTr = r.traspasos.reduce((a, t) => a + t.q, 0), valRz = r.riesgo.reduce((a, x) => a + (x.valor || 0), 0), cadN = r.riesgo.filter(x => x.dias < 0).length;
    const sinRot = r.global.filter(g => g.sinRot);
    const tb = (id, n) => `<button class="${tab === id ? 'activo' : ''}" onclick="App.pedTab('${id}')">${n}</button>`;
    $('#pdRes').innerHTML = `<div class="kpis">
      <div class="kpi kpi-clic" onclick="App.pedTab('compra')"><small>Compra sugerida</small><b>${r.verCostos ? $$(tot) : nf(comprar.reduce((a, g) => a + g.comprar, 0)) + ' piezas'}</b><span>${nf(comprar.length)} productos${r.verCostos ? ' · ' + nf(comprar.reduce((a, g) => a + g.comprar, 0)) + ' piezas' : ''}</span></div>
      <div class="kpi kpi-clic" onclick="App.pedTab('traspasos')"><small>Antes de comprar: traspasos</small><b>${nf(r.traspasos.length)}</b><span>${nf(piezasTr)} piezas que ya tienes en otra sucursal</span></div>
      <div class="kpi kpi-clic" onclick="App.pedTab('riesgo')"><small>Riesgo de caducidad</small><b>${r.verCostos ? $$(valRz) : nf(r.riesgo.length) + ' lotes'}</b><span>${nf(r.riesgo.length)} lotes · ${nf(cadN)} ya caducados</span></div>
      <div class="kpi kpi-clic" onclick="App.pedTab('sinrot')"><small>Sin venta en ${r.params.dias} días</small><b>${nf(sinRot.length)}</b><span>productos con existencia que no se movieron</span></div></div>
      <div class="pestanas no-imprimir">${tb('compra', '🛒 Compra global')}${tb('suc', '🏬 Por sucursal')}${tb('traspasos', '🔁 Traspasos sugeridos')}${tb('riesgo', '⏳ Riesgo de caducidad (80/20)')}${tb('sinrot', '💤 Sin rotación')}</div>
      <div id="pdTab"></div>
      <p class="muted" style="font-size:12px;margin-top:8px">Calculado el ${esc(r.fecha)} con venta de los últimos ${r.params.dias} días · entrega ${r.params.entrega} + cubrir ${r.params.cobertura} + seguridad ${r.params.seguridad} días.</p>`;
    ({ compra: pdCompra, suc: pdPorSuc, traspasos: pdTraspasos, riesgo: pdRiesgo, sinrot: pdSinRot })[tab]();
  }
  function pedTab(t) { S.pedTab = t; pintarPedido(); }

  // --- Compra global agrupada por proveedor ---
  function pdCompra() {
    const r = S.ped, f = S.pdF || (S.pdF = { txt: '', abc: '', solo: true });
    const filas = r.global.filter(g => (!f.solo || g.comprar > 0 || (r.comprarEdit[g.p] > 0)) && (!f.abc || g.abc === f.abc) && (!f.txt || coincide(pdNom(g.p) + ' ' + pdLab(g.p) + ' ' + g.p + ' ' + g.provN, f.txt)));
    const grupos = {};
    filas.forEach(g => { const k = g.prov || '_' + (pdLab(g.p) || 'Sin proveedor'); (grupos[k] = grupos[k] || { prov: g.prov, n: g.provN || pdLab(g.p) || 'Sin proveedor', l: [] }).l.push(g); });
    const cant = g => r.comprarEdit[g.p] !== undefined ? r.comprarEdit[g.p] : g.comprar;
    $('#pdTab').innerHTML = `<div class="tarjeta no-imprimir"><div class="fila"><label>Buscar<input id="pdTxt" value="${esc(f.txt)}" placeholder="Producto, laboratorio o proveedor"></label>
      <label>Clase<select id="pdAbc">${opts([['A', 'A (80 % de la venta)'], ['B', 'B'], ['C', 'C']], f.abc, 'Todas')}</select></label>
      <label class="check fijo"><input type="checkbox" id="pdSolo" ${f.solo ? 'checked' : ''}> Solo lo que hay que comprar</label>
      <button class="btn fijo" onclick="App.imprimir()">🖨️ Imprimir</button></div></div>` +
      (Object.keys(grupos).length ? Object.keys(grupos).sort((a, b) => grupos[b].l.reduce((s, g) => s + (g.costo || 0), 0) - grupos[a].l.reduce((s, g) => s + (g.costo || 0), 0)).map(k => {
        const G = grupos[k], sub = G.l.reduce((s, g) => s + cant(g) * (g.cu || 0), 0);
        return `<div class="tarjeta"><div class="pd-prov"><h3>${esc(G.n)}</h3><span class="muted">${G.l.length} productos${r.verCostos ? ' · ' + $$(sub) : ''}</span>
          ${G.prov && puede('compras') ? `<button class="btn primario chico no-imprimir" onclick="App.pedidoAOrden('${esc(G.prov)}')">📦 Crear orden de compra</button>` : ''}</div>` +
          tabla([{ t: 'Producto', h: g => `<b>${esc(pdNom(g.p))}</b> ${etqAbc(g.abc)}<br><small class="muted">${esc(g.p)} · ${esc(pdLab(g.p))}</small>` },
            { t: 'Venta / día', num: 1, h: g => nf(g.dd) + ' ' + tendTxt(g.tend) }, { t: 'Útil', num: 1, h: g => nf(g.util) + (g.rz || g.cad ? `<br><small class="error">${nf(g.rz + g.cad)} no se venden</small>` : '') },
            { t: 'En camino', num: 1, cls: 'ocultar-movil', h: g => g.tr ? nf(g.tr) : '—' }, { t: 'Objetivo', num: 1, cls: 'ocultar-movil', h: g => nf(g.obj) },
            { t: 'Comprometido', num: 1, h: g => compTxt(g) },
            { t: 'Traspasos', num: 1, cls: 'ocultar-movil', h: g => g.traspaso ? nf(g.traspaso) : '—' },
            { t: 'Comprar', num: 1, h: g => `<input type="number" min="0" class="pd-cant" data-p="${esc(g.p)}" value="${cant(g)}">` },
            ...(r.verCostos ? [{ t: 'Costo', num: 1, h: g => $$(cant(g) * (g.cu || 0)) }] : [])], G.l.sort((a, b) => (b.costo || 0) - (a.costo || 0) || a.abc.localeCompare(b.abc))) + '</div>';
      }).join('') : '<div class="vacio">No hay nada que comprar con estos parámetros ✔</div>');
    const re = () => { S.pdF = { txt: $('#pdTxt').value, abc: $('#pdAbc').value, solo: $('#pdSolo').checked }; pdCompra(); };
    $('#pdTxt').onchange = re; $('#pdAbc').onchange = re; $('#pdSolo').onchange = re;
    $('#pdTab').oninput = e => { if (e.target.classList.contains('pd-cant')) r.comprarEdit[e.target.dataset.p] = Math.max(0, Number(e.target.value) || 0); };
  }
  function pedidoAOrden(prov) {
    const r = S.ped, l = r.global.filter(g => g.prov === prov).map(g => ({ g: g, q: r.comprarEdit[g.p] !== undefined ? r.comprarEdit[g.p] : g.comprar })).filter(x => x.q > 0);
    if (!l.length) return toast('No hay piezas para pedir a este proveedor', true);
    if (S.oc && S.oc.lineas && S.oc.lineas.length && !confirm('Ya tienes una orden de compra en captura. ¿Reemplazarla con este pedido?')) return;
    const pv = (D().proveedores || []).find(p => p.id === prov);
    S.oc = { prov: prov, suc: 'SUC_MAT_1', factura: '', fecha: hoyISO(), dias: pv ? pv.credito : '', descEsp: 0, descPP: 0, flete: 0, recibido: false, actCosto: false,
      obs: 'Pedido sugerido ' + r.fecha, lineas: l.map(x => lineaCompra(x.g.p, x.q, prov)), pago: 0 };
    ir('compras', true); V.compras('nueva');
    toast('Orden armada con ' + l.length + ' productos. Revísala y guárdala (queda como pendiente de recibir).');
  }

  // --- Detalle por sucursal ---
  function pdPorSuc() {
    const r = S.ped; S.pdSuc = S.pdSuc || (r.sucursales.find(s => s.id === sucTrabajo()) || r.sucursales[0] || {}).id;
    const f = r.filas.filter(x => x.s === S.pdSuc && (x.sug > 0 || x.ex > 0 || x.vd > 0)).sort((a, b) => b.sug - a.sug || b.dd - a.dd);
    $('#pdTab').innerHTML = `<div class="tarjeta no-imprimir"><div class="fila"><label>Sucursal<select id="pdSucSel">${opts(r.sucursales, S.pdSuc)}</select></label>
      <span class="muted">${f.filter(x => x.sug > 0).length} productos por surtir · ${nf(f.reduce((a, x) => a + x.sug, 0))} piezas</span></div></div>` +
      tabla([{ t: 'Producto', h: x => `<b>${esc(pdNom(x.p))}</b><br><small class="muted">${esc(x.p)} · ${esc(pdLab(x.p))}</small>` },
        { t: `Vendido ${r.params.dias} d`, num: 1, h: x => nf(x.vd) }, { t: 'Venta / día', num: 1, h: x => nf(x.dd) },
        { t: 'Existencia', num: 1, h: x => nf(x.ex) + (x.cad ? `<br><small class="error">${nf(x.cad)} caducado</small>` : '') + (x.rz ? `<br><small class="error">${nf(x.rz)} no se alcanza a vender</small>` : '') },
        { t: 'En camino', num: 1, cls: 'ocultar-movil', h: x => x.tr ? nf(x.tr) : '—' }, { t: 'Le alcanza', num: 1, h: x => x.dias === null ? '—' : `<span class="etq ${x.dias < 7 ? 'mal' : x.dias < 20 ? 'av' : 'ok'}">${nf(x.dias)} días</span>` },
        { t: 'Objetivo', num: 1, cls: 'ocultar-movil', h: x => nf(x.obj) }, { t: 'Comprometido', num: 1, h: x => compTxt(x) }, { t: 'Surtir', num: 1, h: x => x.sug ? `<b>${nf(x.sug)}</b>` : '—' },
        { t: 'Últ. venta', cls: 'ocultar-movil', k: 'ult' }], f, { vacio: 'Sin movimientos en esta sucursal' });
    $('#pdSucSel').onchange = e => { S.pdSuc = e.target.value; pdPorSuc(); };
  }

  // --- Traspasos sugeridos (sobrantes de una sucursal que cubren faltantes de otra) ---
  function pdTraspasos() {
    const r = S.ped, rutas = {};
    r.traspasos.forEach(t => { const k = t.de + '>' + t.a; (rutas[k] = rutas[k] || { de: t.de, a: t.a, l: [] }).l.push(t); });
    $('#pdTab').innerHTML = Object.keys(rutas).length ? Object.keys(rutas).map(k => { const R = rutas[k];
      return `<div class="tarjeta"><div class="pd-prov"><h3>${esc(pdSuc(R.de))} → ${esc(pdSuc(R.a))}</h3><span class="muted">${R.l.length} productos · ${nf(R.l.reduce((a, t) => a + t.q, 0))} piezas</span>
        ${puede('traspasos') ? `<button class="btn primario chico no-imprimir" onclick="App.pedidoATraspaso('${esc(R.de)}','${esc(R.a)}')">🚚 Armar traspaso</button>` : ''}</div>` +
        tabla([{ t: 'Producto', h: t => `<b>${esc(pdNom(t.p))}</b><br><small class="muted">${esc(t.p)} · ${esc(pdLab(t.p))}</small>` }, { t: 'Piezas', num: 1, h: t => `<b>${nf(t.q)}</b>` }], R.l) + '</div>'; }).join('')
      : '<div class="vacio">No hay sobrantes que convenga mover entre sucursales.</div>';
  }
  function pedidoATraspaso(de, a) {
    const l = S.ped.traspasos.filter(t => t.de === de && t.a === a);
    if (S.tr && S.tr.lineas && S.tr.lineas.length && !confirm('Ya tienes un traspaso en captura. ¿Reemplazarlo?')) return;
    S.tr = { ori: de, des: a, recibio: '', com: 'Traspaso sugerido ' + S.ped.fecha, lineas: l.map(t => ({ id: t.p, cant: t.q, lote: '' })), paq: '', guia: '', flete: '' };
    S.tabTr = 'nuevo'; ir('traspasos', true);
    toast('Traspaso armado: revisa lotes y método de envío antes de guardarlo.');
  }

  // --- Riesgo de caducidad con 80/20 ---
  function pdRiesgo() {
    const r = S.ped, f = S.pdR || (S.pdR = { suc: '', tipo: '' });
    const l = S.pdRL = r.riesgo.filter(x => (!f.suc || x.s === f.suc) && (!f.tipo || (f.tipo === 'cad' ? x.dias < 0 : x.dias >= 0)));
    const wa = (c, x) => { const tel = String(c.cel || '').replace(/\D/g, '').slice(-10); if (!tel) return ''; const msg = 'Hola, le saluda Interés Veterinario. Tenemos disponible ' + pdNom(x.p) + ' con precio especial. ¿Le interesa que se lo apartemos?';
      return `<a class="btn chico" target="_blank" rel="noopener" href="${WA_BASE}52${tel}?text=${encodeURIComponent(msg)}">💬</a>`; };
    $('#pdTab').innerHTML = `<div class="tarjeta no-imprimir"><div class="fila"><label>Sucursal<select id="pdRSuc">${opts(r.sucursales, f.suc, 'Todas')}</select></label>
      <label>Mostrar<select id="pdRTipo">${opts([['prox', 'Por caducar'], ['cad', 'Ya caducados']], f.tipo, 'Todos')}</select></label></div>
      <p class="muted" style="margin:8px 0 0;font-size:13px">Lotes que <b>no se alcanzarán a vender</b> antes de su caducidad al ritmo actual de esa sucursal (o que ya caducaron). Para cada uno: a qué sucursal conviene mandarlo y quiénes concentran el 80 % de la compra de ese producto.</p></div>` +
      (l.length ? l.map((x, i) => `<div class="tarjeta pd-rz ${x.dias < 0 ? 'cad' : x.dias <= 60 ? 'urg' : ''}">
        <div class="pd-rz-cab"><div><b>${esc(pdNom(x.p))}</b><br><small class="muted">${esc(x.p)} · ${esc(pdLab(x.p))} · ${esc(pdSuc(x.s))} · lote ${esc(x.l)}</small></div>
          <span class="etq ${x.dias < 0 ? 'mal' : x.dias <= 60 ? 'av' : ''}">${x.dias < 0 ? 'Caducó hace ' + nf(-x.dias) + ' días' : 'Caduca en ' + nf(x.dias) + ' días'} · ${esc(x.c)}</span></div>
        <div class="pd-rz-num"><span>Existencia <b>${nf(x.q)}</b></span><span>Alcanza a vender <b>${nf(x.vend)}</b> <small class="muted">(${nf(x.dd)}/día)</small></span><span class="error">En riesgo <b>${nf(x.rz)}</b>${x.valor !== null ? ' · ' + $$(x.valor) : ''}</span></div>
        <div class="pd-accion">👉 <b>${esc(x.accion)}</b>${x.traspasarA ? ` (${nf(x.traspasarA.q)} piezas, ahí se venden a tiempo)` : ''}
          <span class="pd-acc-btns no-imprimir">${x.dias >= 0 && puede('traspasos') ? `<button class="btn chico" onclick="App.riesgoATraspaso(${i})">🚚 Armar traspaso</button>` : ''}${x.dias < 0 && puede('mermas') ? `<button class="btn chico" onclick="App.riesgoAMerma(${i})">⚖️ Registrar merma</button>` : ''}</span></div>
        <div class="pd-80"><div><small class="muted">Sucursales que más lo venden (80 %)</small><div class="multi-sel">${(x.sucTop || []).length ? x.sucTop.map(s => `<span class="chip-op ${s.s === x.s ? '' : 'on'}">${esc(pdSuc(s.s))} · ${s.pct}%</span>`).join('') : '<span class="muted">Sin ventas en 12 meses</span>'}</div></div>
        ${x.cliTop ? `<div><small class="muted">Clientes que más lo compran (80 %)</small>${x.cliTop.length ? `<div class="pd-cli">${x.cliTop.map(c => `<div><span>${esc(c.n)}</span><small class="muted">${c.pct}% · ${nf(c.q)} pzs · últ. ${esc(c.ult)}</small>${wa(c, x)}</div>`).join('')}</div>` : '<div class="muted">Sin clientes registrados</div>'}</div>` : ''}</div></div>`).join('')
        : '<div class="vacio">No hay lotes en riesgo con estos filtros ✔</div>');
    const re = () => { S.pdR = { suc: $('#pdRSuc').value, tipo: $('#pdRTipo').value }; pdRiesgo(); };
    $('#pdRSuc').onchange = re; $('#pdRTipo').onchange = re;
  }

  const claveLote = x => { const st = (D().stock || []).find(o => o.p === x.p && o.s === x.s && String(o.l) === String(x.l) && String(o.c) === String(x.c)); return st ? st.k : ''; };
  function riesgoATraspaso(i) {
    const x = (S.pdRL || [])[i]; if (!x) return;
    if (S.tr && S.tr.lineas && S.tr.lineas.length && !confirm('Ya tienes un traspaso en captura. ¿Reemplazarlo?')) return;
    S.tr = { ori: x.s, des: x.traspasarA ? x.traspasarA.s : '', recibio: '', com: 'Lote ' + x.l + ' por caducar (' + x.c + ')', lineas: [{ id: x.p, cant: x.traspasarA ? x.traspasarA.q : Math.ceil(x.rz), lote: claveLote(x) }], paq: '', guia: '', flete: '' };
    S.tabTr = 'nuevo'; ir('traspasos', true); toast('Traspaso armado con el lote ' + x.l + '. Revisa destino y envío antes de guardarlo.');
  }
  function riesgoAMerma(i) {
    const x = (S.pdRL || [])[i]; if (!x) return;
    if (S.aj && S.aj.lineas && S.aj.lineas.length && !confirm('Ya tienes un ajuste en captura. ¿Reemplazarlo?')) return;
    S.aj = { tipo: 'Merma', suc: x.s, motivo: 'Caducado (lote ' + x.l + ', ' + x.c + ')', lineas: [{ id: x.p, cant: x.q, lote: claveLote(x), nlote: '', cad: '' }] };
    S.tabAj = 'nuevo'; ir('ajustes', true); toast('Merma armada con el lote caducado. Revísala y guárdala.');
  }

  // --- Sin rotación ---
  function pdSinRot() {
    const r = S.ped, l = r.global.filter(g => g.sinRot).sort((a, b) => b.ex - a.ex);
    const porSuc = p => r.filas.filter(x => x.p === p && x.ex > 0).map(x => esc(pdSuc(x.s)) + ' ' + nf(x.ex)).join(' · ');
    $('#pdTab').innerHTML = `<p class="muted">Productos con existencia que no se vendieron en los últimos ${r.params.dias} días. Candidatos a promoción, devolución al proveedor o traspaso; no se vuelven a comprar mientras no se muevan.</p>` +
      tabla([{ t: 'Producto', h: g => `<b>${esc(pdNom(g.p))}</b><br><small class="muted">${esc(g.p)} · ${esc(pdLab(g.p))}</small>` }, { t: 'Existencia', num: 1, h: g => nf(g.ex) },
        { t: 'Dónde está', h: g => `<small>${porSuc(g.p)}</small>` }, ...(r.verCostos ? [{ t: 'Valor', num: 1, h: g => $$(g.ex * (g.cu || 0)) }] : [])], l, { vacio: 'Todo tuvo venta ✔' });
  }

  /* ---------- PROVEEDORES ---------- */
  V.proveedores = () => {
    const nIn = (D().proveedores || []).filter(p => !p.activo).length;
    $('#vista').innerHTML = `<div class="tarjeta"><div class="fila"><label>Buscar<input id="pvTxt" placeholder="Nombre o RFC"></label>
      <label>Estado<select id="pvEst"><option value="SI">Activos</option><option value="NO">Inactivos${nIn ? ' (' + nIn + ')' : ''}</option><option value="">Todos</option></select></label>
      <button class="btn primario fijo" onclick="App.formProveedor(null)">+ Nuevo proveedor</button></div>
      ${nIn ? `<p class="muted" style="margin:8px 0 0;font-size:13px">Hay ${nIn} ${nIn === 1 ? 'proveedor inactivo' : 'proveedores inactivos'}: no aparecen en compras ni en los documentos. Para volver a usar uno, elige <b>Inactivos</b> y tócale <b>Activar</b>.</p>` : ''}</div><div class="espacio"></div><div id="pvRes"></div>`;
    const pintar = () => { const t = $('#pvTxt').value, est = $('#pvEst').value; const l = (D().proveedores || []).filter(p => (!est || (est === 'SI') === !!p.activo) && (!t || coincide(p.nombre + ' ' + p.razon + ' ' + p.rfc, t))); S.lista = l;
      $('#pvRes').innerHTML = tabla([{ t: 'Proveedor', h: p => `<div class="con-avatar">${avatar('provLogo', p.id, p.logo, p.nombre)}<b>${esc(p.nombre)}</b></div>` }, { t: 'RFC', k: 'rfc' }, { t: 'Contacto', k: 'contacto' }, { t: 'Teléfono', k: 'tel' }, { t: 'Crédito', num: 1, h: p => p.credito + ' d' },
        { t: 'Estado', h: p => p.activo ? '<span class="etq ok">Activo</span>' : `<span class="etq mal">Inactivo</span>${puede('proveedores') ? ` <button class="btn chico" onclick="event.stopPropagation();App.activarProveedor('${esc(p.id)}')">✅ Activar</button>` : ''}` }], l, { clic: 'App.abrirProveedor', vacio: $('#pvEst').value === 'NO' ? 'No hay proveedores inactivos' : 'Sin proveedores' }); cargarAvatares($('#pvRes')); };
    $('#pvTxt').oninput = pintar; $('#pvEst').onchange = pintar; pintar();
  };
  async function formProveedor(i) {
    const p = i === null ? null : S.lista[i];
    let full = {};
    if (p) { try { full = await pedir('registro', { tabla: 'proveedor', id: p.id }); } catch (e) { return; } }
    const campos = [{ k: 'Nombre_Empresa', t: 'Nombre comercial', req: 1 }, { k: 'Razon_social', t: 'Razón social' }, { k: 'RFC', t: 'RFC' }, { k: 'Regimen_Fiscal', t: 'Régimen fiscal', tipo: 'select', ops: D().catalogos.regimen, vacio: '' },
      { k: 'D_Credito', t: 'Días de crédito', tipo: 'number' }, { k: 'Gerente', t: 'Gerente' }, { k: 'Celular', t: 'Celular' }, { k: 'Telefono', t: 'Teléfono' }, { k: 'e-mail_empresa', t: 'Correo empresa' },
      { k: 'Enc_Ventas', t: 'Ejecutivo de ventas' }, { k: 'Cel_Enc_Ventas', t: 'Cel. ventas' }, { k: 'e-mail_Ventas', t: 'Correo ventas' }, { k: 'Calle', t: 'Calle' }, { k: 'Colonia', t: 'Colonia' },
      { k: 'C.P.', t: 'C.P.' }, { k: 'Localidad', t: 'Localidad' }, { k: 'Estado', t: 'Estado' }, { k: 'Banco', t: 'Banco' }, { k: 'CLABE', t: 'CLABE' }, { k: 'No_CTA.', t: 'No. cuenta' },
      { k: 'Activo', t: 'Estado', tipo: 'select', ops: [['SI', 'Activo'], ['NO', 'Inactivo (no se muestra en compras ni documentos)']] }];
    S.formIni = p ? full : { Activo: 'SI', D_Credito: 0 };
    modal(p ? p.nombre : 'Nuevo proveedor', `<div class="arch-par">${p ? bloqueArch('provLogo', p.id) : bloqueArchNuevo('provLogo', 'provLogoN')}</div><div id="fProv">${formulario(campos, S.formIni)}</div><div class="acciones">${p && puede('compras') ? `<button class="btn" onclick="App.comprasDeProveedor('${esc(p.id)}','${esc(String(p.nombre || '').replace(/'/g, ''))}')">📦 Ver sus compras</button>` : ''}<button class="btn" onclick="App.cerrarModal()">Cancelar</button><button class="btn primario" onclick="App.guardarProveedor()">Guardar</button></div>`);
  }
  async function activarProveedor(id) {
    const p = (D().proveedores || []).find(x => x.id === id); if (!p) return;
    if (!confirm('¿Activar a ' + p.nombre + '? Volverá a aparecer en compras y documentos.')) return;
    try { await pedir('guardarProveedor', { ID_Proveedor: id, Activo: 'SI' }); toast('✔ ' + p.nombre + ' activado'); D().proveedores = await pedir('listarProveedores', {}, true); LS.set('datos', S.datos); V.proveedores(); } catch (e) {}
  }
  async function guardarProveedor() {
    const f = leerForm($('#fProv')), ini = S.formIni;
    const datos = ini.ID_Proveedor ? soloCambios(ini, f) : f;
    datos.ID_Proveedor = ini.ID_Proveedor;
    try { const r = await pedir('guardarProveedor', datos); toast('✔ Proveedor guardado' + (!ini.ID_Proveedor && r && r.ID_Proveedor ? await subirArchNuevos([['provLogo', '#provLogoN']], r.ID_Proveedor) : '')); cerrarModal(); D().proveedores = await pedir('listarProveedores', {}, true); LS.set('datos', S.datos); V.proveedores(); } catch (e) {}
  }

  /* ---------- CONFIGURACIÓN ---------- */
  V.config = async () => {
    const u = U();
    setTimeout(() => { CQ.contar().then(n => { const x = $('#cqNum'); if (x) x.textContent = n || 0; }); cargarSucsCfg(); }, 0);
    $('#vista').innerHTML = `<div class="tarjeta"><h3>Mi sesión</h3><p>${esc(u.nombre)} · <b>${esc(u.rolNombre || u.rol)}</b> · ${esc(u.correo)}<br>Sucursal: ${esc(sucNom(u.sucursal))} · Acceso: ${u.todasSucursales ? 'todas las sucursales' : 'solo su sucursal'}</p>
      <p class="muted">Datos guardados en este dispositivo: ${(D().productos || []).length} productos, ${(D().clientes || []).length} clientes, ${(D().stock || []).length} lotes. Última actualización: ${D().servidor ? new Date(D().servidor).toLocaleString('es-MX') : '—'}</p>
      <div class="fila"><button class="btn fijo" onclick="App.recargar()">⟳ Recargar datos del servidor</button><button class="btn fijo" onclick="App.salir()">Cerrar sesión</button></div></div>
      <div class="tarjeta"><h3>Operaciones pendientes de sincronizar (${S.cola.length})</h3>${tabla([{ t: 'Capturada', k: 'creado' }, { t: 'Operación', k: 'desc' }, { t: 'Error', h: o => o.error ? `<span class="error">${esc(o.error)}</span>` : 'En espera' },
        { t: '', h: o => `<button class="btn chico peligro" onclick="App.descartarOp('${o.opId}')">Descartar</button>` }], S.cola.slice().reverse(), { vacio: 'Todo sincronizado ✔' })}
      ${S.cola.length ? '<div class="acciones"><button class="btn primario" onclick="App.sincronizar(true)">Sincronizar ahora</button></div>' : ''}</div>
      <div class="tarjeta"><h3>Consultas guardadas para usar sin conexión</h3><p class="muted">La app guarda en este dispositivo las consultas que haces (ventas, cotizaciones, seguimiento, visitas, cobranza, recetas…) y cada 3 horas actualiza las principales. Sin señal, verás la última copia guardada. Se borran al cerrar sesión.</p>
        <p>Consultas guardadas: <b id="cqNum">…</b> · Última actualización automática: <b>${LS.get('precarga_' + (u.id || ''), 0) ? new Date(LS.get('precarga_' + (u.id || ''), 0)).toLocaleString('es-MX') : 'pendiente'}</b></p>
        <div class="fila"><button class="btn fijo" onclick="App.precargarAhora()">⬇ Guardar información ahora</button></div></div>
      <div class="tarjeta"><h3>Mis permisos</h3><p class="muted">Los permisos por rol se editan en la hoja <b>APP_Permisos</b> (SI / NO). Usuarios, roles y contraseñas en <b>Catalogo_Vendedor</b>.</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${Object.keys(u.permisos).map(k => `<span class="etq ${u.permisos[k] ? 'ok' : 'mal'}">${esc(k)}</span>`).join('')}</div></div>
      ${puede('dueno') ? `<div class="tarjeta"><h3>🏷️ Logotipo de la empresa</h3><p class="muted">Se usa en el menú de la app y en todos los PDF (notas, cotizaciones, compras, traspasos, estados de cuenta, listas de precios), también como marca de agua. Usa de preferencia un PNG con fondo transparente. El logotipo anterior no se borra: se guarda en la carpeta "_versiones anteriores (no usar)".</p>
        <div class="logo-prev"><div><small class="muted">Actual</small><div class="logo-caja">${window.LOGO ? `<img src="${window.LOGO}" alt="">` : '<span class="muted">Sin logotipo</span>'}</div></div><div id="lgNuevo" class="logo-prev"></div></div>
        <div class="acciones"><label class="btn">📁 Elegir nuevo logotipo<input type="file" accept="image/png,image/jpeg" style="display:none" onchange="App.prepararLogo(this)"></label><span id="lgAcc" style="display:contents"></span></div></div>` : ''}
      ${u.rol === 'Administrador' && puede('recetas') ? `<div class="tarjeta"><h3>💊 Datos para las recetas</h3><p class="muted">Aparecen al pie de cada receta en PDF, junto a la firma.</p><div id="cfRx"><span class="muted">Cargando…</span></div></div>` : ''}
      <div class="tarjeta"><h3>🏬 Sucursales</h3><p class="muted">${u.rol === 'Administrador' ? 'Toca una sucursal para poner o cambiar su foto (carpeta Sucursal_Images). Los demás datos se editan en la hoja Catalogo_Sucursal.' : 'Datos de tu sucursal.'}</p><div id="cfSucs"></div></div>
      ${u.rol === 'Administrador' ? `<div class="tarjeta"><h3>👥 Vendedores y usuarios</h3><p class="muted">Foto de cada vendedor (carpeta Vendedor_Images). Los demás datos se editan en la hoja Catalogo_Vendedor.</p><div id="cfVend"><span class="muted">Cargando…</span></div></div>` : ''}
      ${puede('configuracion') ? `<div class="tarjeta"><h3>Pagos y saldos de las notas</h3><p class="muted">La app calcula lo pagado y el saldo de cada nota sumando sus cobros de la hoja Cobranza (relacionados por ID_Venta). Aquí puedes ver qué notas tienen guardado en Nota_Venta un pagado o saldo distinto y corregirlas.</p>
        <div class="fila"><button class="btn fijo" onclick="App.revisarSaldos(false)">Revisar notas</button></div><div id="cfSaldos" style="margin-top:12px"></div></div>` : ''}
      ${puede('dueno') ? `<div class="tarjeta"><h3>🔒 Grupos de gasto (hoja Egresos CFDI)</h3><p class="muted">Define en qué grupo cae cada factura de egreso. Las reglas por <b>Emisor</b> (el nombre contiene el texto) tienen prioridad sobre las de <b>Categoría</b>. Para Inversión puedes fijar la tasa de depreciación anual (vacío = vehículos 25 %, cómputo 30 %, otros 10 %). Operación se resta cada mes; Financiero va en su propio renglón; Inversión no se resta del mes; Excluir no se toma en cuenta.</p>
        <div class="fila"><button class="btn fijo" onclick="App.cargarGrupos()">Ver / editar grupos</button></div><div id="cfGrupos" style="margin-top:12px"></div></div>` : ''}
      ${puede('configuracion') ? `<div class="tarjeta"><h3>Registros de inventario</h3><p class="muted">Busca renglones de compras, ventas y traspasos que ya tienen su movimiento en <b>Movimientos_Inventario</b> pero aún dicen <i>Mov_Registrado = FALSE</i>, y órdenes o notas que ya deberían estar como recibidas / entregadas. La app nunca vuelve a meter al inventario un renglón que ya tiene movimiento.</p>
        <div class="fila"><button class="btn fijo" onclick="App.repararRegistros(false)">Revisar registros</button></div><div id="cfReg" style="margin-top:12px"></div></div>` : ''}
      ${puede('dueno') ? tarjetaVentaSinExist() : ''}
      ${puede('configuracion') ? '<div class="tarjeta"><h3>Folios por sucursal</h3><p class="muted">Último número usado. El siguiente documento tomará el número + 1 (la app nunca repite un folio ya existente).</p><div id="cfFol"></div></div>' : ''}`;
    if (u.rol === 'Administrador') cargarVendedores();
    if (u.rol === 'Administrador' && puede('recetas')) cargarCfgReceta();
    if (puede('configuracion')) {
      try { const f = await pedir('folios', {}, true);
        f.sort((a, b) => (a.suc + a.tipo).localeCompare(b.suc + b.tipo));
        $('#cfFol').innerHTML = tabla([{ t: 'Sucursal', h: x => esc(sucNom(x.suc)) }, { t: 'Documento', k: 'tipo' },
          { t: 'Último', h: x => `<input type="number" style="width:110px" value="${x.ultimo}" onchange="App.guardarFolio('${esc(x.suc)}','${esc(x.tipo)}',this.value)">` }], f);
      } catch (e) { $('#cfFol').innerHTML = '<div class="vacio">Requiere conexión</div>'; }
    }
  };
  async function revisarSaldos(aplicar) {
    if (aplicar && !confirm('¿Corregir en Nota_Venta el pagado y el saldo de estas notas según sus cobros?')) return;
    try {
      const r = await pedir('revisarSaldos', { aplicar: aplicar });
      if (aplicar) { toast('✔ ' + r.corregidas + ' notas corregidas'); return revisarSaldos(false); }
      $('#cfSaldos').innerHTML = !r.diferencias.length ? '<div class="vacio">Todas las notas coinciden con sus cobros ✔</div>' :
        `<p><b>${r.diferencias.length}</b> notas no coinciden:</p>` + tabla([{ t: 'Nota', h: x => `<b>${esc(x.folio)}</b>` }, { t: 'Cliente', k: 'cliente' }, { t: 'Estatus', h: x => etqEstatus(x.estatus) },
          { t: 'Total', num: 1, h: x => $$(x.total) }, { t: 'Pagado en la nota', num: 1, h: x => $$(x.cobradoHoja) }, { t: 'Pagado real (Cobranza)', num: 1, h: x => `<b>${$$(x.cobradoReal)}</b>` },
          { t: 'Saldo en la nota', num: 1, h: x => $$(x.saldoHoja) }, { t: 'Saldo real', num: 1, h: x => `<b>${$$(x.saldoReal)}</b>` }], r.diferencias) +
        `<div class="acciones"><button class="btn primario" onclick="App.revisarSaldos(true)">Corregir ${r.diferencias.length} notas</button></div>`;
    } catch (e) {}
  }
  async function cargarGrupos() {
    try { S.grupos = await pedir('gruposGasto', {}); } catch (e) { return; }
    pintarGrupos();
  }
  function pintarGrupos() {
    const g = S.grupos;
    $('#cfGrupos').innerHTML = `<div class="tabla-cont"><table><thead><tr><th>Tipo</th><th>Emisor contiene / Categoría</th><th>Grupo</th><th>Depreciación % anual</th><th title="Pagos que cubren varios meses (seguro anual): se reparten en partes iguales">Repartir en meses</th><th>Nota</th><th></th></tr></thead><tbody>
      ${g.filas.map((f, i) => `<tr data-i="${i}"><td><select data-f="tipo">${opts([['Emisor', 'Emisor'], ['Categoria', 'Categoría']], f.tipo)}</select></td>
        <td><input data-f="valor" value="${esc(f.valor)}"></td><td><select data-f="grupo">${opts(g.grupos.map(x => [x, x]), f.grupo)}</select></td>
        <td>${f.grupo === 'Inversión' ? `<input type="number" data-f="tasa" style="width:80px" placeholder="auto" value="${f.tasa === '' || f.tasa === undefined ? '' : f.tasa}">` : '<small class="muted">—</small>'}</td>
        <td>${f.grupo !== 'Inversión' && f.grupo !== 'Excluir' ? `<input type="number" data-f="meses" style="width:70px" min="0" max="60" placeholder="—" value="${f.meses || ''}">` : '<small class="muted">—</small>'}</td>
        <td><input data-f="nota" value="${esc(f.nota || '')}"></td><td><button class="icono" data-del>✕</button></td></tr>`).join('')}</tbody></table></div>
      <p class="muted" style="margin-top:6px">"Repartir en meses": para pagos que cubren varios meses (p. ej. un seguro anual = 12): el gasto se reparte en partes iguales desde el mes de la factura, en lugar de cargarse completo en un solo mes.</p>
      <div class="acciones"><button class="btn" onclick="App.agregarGrupo()">+ Agregar regla</button><button class="btn primario" onclick="App.guardarGrupos()">Guardar</button></div>`;
    const t = $('#cfGrupos');
    t.oninput = e => { const r = e.target.closest('[data-i]'), f = e.target.dataset.f; if (r && f) S.grupos.filas[+r.dataset.i][f] = e.target.value; };
    t.onchange = e => { t.oninput(e); if (e.target.dataset.f === 'grupo') pintarGrupos(); };
    t.onclick = e => { if (e.target.closest('[data-del]')) { S.grupos.filas.splice(+e.target.closest('[data-i]').dataset.i, 1); pintarGrupos(); } };
  }
  function agregarGrupo() { S.grupos.filas.push({ tipo: 'Emisor', valor: '', grupo: 'Operación', nota: '' }); pintarGrupos(); }
  async function guardarGrupos() {
    try { const r = await pedir('guardarGruposGasto', { filas: S.grupos.filas }); toast('✔ ' + r.reglas + ' reglas guardadas'); cargarGrupos(); } catch (e) {}
  }
  async function repararRegistros(aplicar) {
    if (aplicar && !confirm('¿Marcar estos renglones como ya registrados? No se crea ningún movimiento nuevo.')) return;
    try {
      const r = await pedir('repararRegistros', { aplicar: aplicar });
      if (aplicar) { toast('✔ Registros corregidos'); return repararRegistros(false); }
      const grupos = [['Renglones de compra', r.comprasRenglones], ['Renglones de venta', r.ventasRenglones], ['Renglones de traspaso', r.traspasosRenglones],
        ['Órdenes por marcar como recibidas', r.ordenesPorMarcarRecibidas], ['Notas por marcar como entregadas', r.notasPorMarcarEntregadas]];
      const total = grupos.reduce((t, g) => t + g[1].length, 0);
      $('#cfReg').innerHTML = !total ? '<div class="vacio">Todo en orden ✔</div>' :
        grupos.filter(g => g[1].length).map(g => `<p><b>${g[0]} (${g[1].length})</b><br><small class="muted">${g[1].slice(0, 40).map(esc).join(' · ')}${g[1].length > 40 ? ' …' : ''}</small></p>`).join('') +
        `<div class="acciones"><button class="btn primario" onclick="App.repararRegistros(true)">Corregir ${total}</button></div>`;
    } catch (e) {}
  }
  async function guardarFolio(suc, tipo, n) { try { await pedir('guardarFolio', { ID_Sucursal: suc, Tipo_Documento: tipo, Ultimo_Numero: n }, true); toast('Folio actualizado'); } catch (e) { toast(e.message, true); } }
  function descartarOp(id) { if (!confirm('¿Descartar esta operación? No se enviará al servidor.')) return; S.cola = S.cola.filter(o => o.opId !== id); LS.set('cola', S.cola); pintarCola(); V.config(); }
  async function recargar() { try { await refrescarDatos(); toast('Datos actualizados'); ir(S.vista); } catch (e) {} }

  /* ---------------- impresión ---------------- */
  // Copia el documento visible a una zona propia y solo esa se imprime (sin fondo oscuro ni páginas extra).
  function imprimir() {
    const enModal = !$('#modal').classList.contains('oculto');
    const src = (enModal ? $('#modalCuerpo') : $('#vista')).querySelector('.imprimible');
    if (!src) return window.print();
    let z = $('#zonaImpresion');
    if (!z) { z = document.createElement('div'); z.id = 'zonaImpresion'; document.body.appendChild(z); }
    if (src.querySelector('.lp-tabla')) { z.innerHTML = lpPaginar(src); window.print(); return; }
    z.innerHTML = src.innerHTML;
    z.querySelectorAll('.no-imprimir').forEach(e => e.remove());
    z.querySelectorAll('.lp-fecha').forEach(e => e.textContent = fechaLarga());
    window.print();
  }
  window.addEventListener('afterprint', () => { const z = $('#zonaImpresion'); if (z) z.innerHTML = ''; });

  /* ---------------- arranque ---------------- */
  async function iniciar() {
    await cargarLocal(); await cargarFotosLocal();
    if (window.LOGO) { const l = $('#lgLogo'); if (l) l.innerHTML = `<img src="${window.LOGO}" alt="Interés Veterinario">`; const n = $('#lgNombre'); if (n) n.style.display = 'none'; }
    window.addEventListener('online', () => { marcarRed(true); RED.fuerte = null; setTimeout(() => sincronizar(), 2500); });
    try { if (navigator.connection) navigator.connection.addEventListener('change', () => { RED.fuerte = null; if (S.cola.length) sincronizar(); }); } catch (e) {}
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !S.token) return;
      pintarBienvEstado(); sincronizar();
      if (S.datos && Date.now() - (S.datos._t || 0) > 30 * 60000) senalFuerte().then(ok => { if (ok) refrescarDatos(true).then(pintarBienvEstado).catch(() => {}); });
    });
    setInterval(() => { if (S.token && S.cola.length && navigator.onLine !== false) sincronizar(); }, 30000);
    window.addEventListener('offline', () => marcarRed(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarModal(); });
    try { iniciarBarraDoc(); iniciarBuscadorMovil(); } catch (e) {}
    setInterval(() => { if (S.token && navigator.onLine) { sincronizar(); if (['venta', 'inventario'].indexOf(S.vista) < 0) refrescarStock(); precargar(); } }, 90000);
    window.addEventListener('online', () => { const el = $('#avisoCache'); if (el && !el.classList.contains('oculto')) el.querySelector('span').innerHTML = '🟢 <b>Ya hay conexión.</b> Toca “Actualizar” para ver la información al momento.'; setTimeout(precargar, 15000); });
    if (S.token && S.datos) {
      mostrarApp();
      refrescarDatos(true).then(() => { pintarMenu(); pintarBienvEstado(); sincronizar(); renovarSesion(); setTimeout(precargar, 20000); setTimeout(revisarMinisSuc, 8000); setTimeout(fotosAlEntrar, 4000); }).catch(() => {});
    } else {
      $('#login').classList.remove('oculto'); avisarNativoLogin(); revisarVersionApp();
    }
  }
  /* Puente con la app nativa (Xcode / WKWebView). La app nativa puede pedir la contraseña guardada en Contraseñas de Apple
     (ASAuthorizationPasswordProvider) y entregarla con window.IVNativo.login(usuario, contraseña). Cuando aparece la
     pantalla de entrada se le avisa con el mensaje { tipo: 'login' } al handler "iv" (window.webkit.messageHandlers.iv). */
  function avisarNativoLogin() { try { const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iv; if (h) h.postMessage({ tipo: 'login' }); } catch (e) {} }
  window.IVNativo = { version: 1, login: (u, p) => { const a = $('#lgUser'), b = $('#lgPass'); if (!a || !b) return false; a.value = u || ''; b.value = p || ''; if (u && p) entrar({ preventDefault() {} }); return true; } };
  document.addEventListener('DOMContentLoaded', iniciar);

  /* ---------------- API pública (para onclick) ---------------- */
  return {
    precargarAhora, vistaActual: () => S.vista, verSucCfg, guardarVentaSinExist,
    imprimir, revisarSaldos, repararRegistros, cargarGrupos, agregarGrupo, guardarGrupos, entrar, salir, ir, irTab, menu, cambiarSuc, cerrarModal, sincronizar, recargar, descartarOp, guardarFolio, cargarDashboard, verGastosCat, vistaGastos: t => V.gastos(t), cargarGastos, filtrarCatGasto, pdfGastos, formFacturasGasto, subirFacturasGasto, correoGastos, revisarCorreoGastos, verPdfGasto, clasificarGasto, guardarClasif, gastoACompra, asignarSucGastos, cargarSucursales, verSucursal,
    pintarFactNota, asignarFactNota, quitarFactNota, montoFactNota, subirXmlNota, subFact, cargarFacturacion, abrirFactura: i => verFactura(S.lista[i].id), verFactura, agregarNotaFactura, formSubirFactura, subirFactura, importarFacturas,
    vistaCot: t => V.cotizaciones(t), cargarCotizaciones, abrirCot: i => verCotizacion(S.lista[i].id), verCot: verCotizacion, pendienteCot, pdfCot, editarCot, cotAVenta, quitarCotVenta, cancelarCot, reabrirCot, ligarCot, limpiarCot, guardarCot,
    limpiarVenta, guardarVenta, abrirVenta: i => verVenta(S.lista[i].id), vistaVentas: t => V.ventas(t), buscarEdoCta, filtrarTramo, abrirEdoCta: i => verEdoCta(S.lista[i].idCliente), verEdoCta, pdfEdoCta, recordatorioEC, buscarUtilidad, abrirUtilidad: i => verUtilidad(S.lista[i].id), verVentaId: id => verVenta(id), cancelarVenta,
    formCancelarLinea, cancelarLinea, entregarVenta, formEnvio, guardarEnvio, formCobro, guardarCobro, buscarVentas, buscarCobros, abrirCobro: i => verCobro(S.lista[i].id), verCobro, verAdjCob, subirAdjCob, quitarAdjCob, verAdj, subirAdj, quitarAdj, volverAdj: (t, id) => ADJ[t].volver(id), pdfNota, pdfCobro, editarNota,
    vistaCompras: t => V.compras(t), buscarCompras, actualizarApp, buscarPagosProv, verPagoProv, formEditarPago, guardarEdicionPago, abrirPagoProv: i => verPagoProv(S.lista[i].id), pagosSinAdj, verCxP, verCxC, abrirCompra: i => verCompra(S.lista[i].id), abrirCompraId: verCompra, formFacturaCompra, guardarFacturaCompra, recibirCompra, editarCompra, editarCompraId, cancelarCompra, salirEdicionCompra, formPagoProv, guardarPagoProv, formNotaCredito, ncPorcentaje, leerXmlNC, guardarNotaCredito, limpiarCompra, guardarCompra,
    logoTransparente,
    pdfCompra: (id, conCostos) => { const d = S.ultimaCompra || {}; generarPdf('pdfCompra', conCostos ? { ID_O_Compra: id, conCostos: true } : { ID_O_Compra: id }, { asunto: 'Orden de compra ' + (d.folio || ''), texto: 'Interés Veterinario — Orden de compra ' + (d.folio || ''), volver: `App.abrirCompraId('${id}')` }); },
    bajarPortafolios, bajarPortafolio, compartirPortafolio, abrirPortafolio, quitarPortafolioLocal, quitarPortafolioDrive,
    excelInventario, excelConteo, compartirArchivo, pdfNotaOffline: () => S.notaOff && pdfDeDatos('pdfNota', S.notaOff), pdfCotOffline: () => S.cotOff && pdfDeDatos('pdfCotizacion', S.cotOff),
    bienvenida, bienvIr, salirBienv, prepararRuta, cerrarVisor, zoomVisor, compartirVisor, verPdfLocal: () => { const x = S.pdfLocal; if (x) verPdf(x.bytes, x.nombre); },
    subDev, cargarDev, nuevaDevolucion, buscarNotaDev, elegirNotaDevI: i => elegirNotaDev(S.devRes[i].id), abrirDev: i => verDev(S.lista[i].id), verDev, pdfDev, guardarDev, cancelarCapturaDev,
    vistaReq: t => V.requisiciones(t), cargarReq, abrirReq: i => verReq(S.lista[i].id), verReq, pdfReq, editarReq, reqATraspaso, reqAOrden, cancelarReq, reabrirReq, limpiarReq, guardarReq, quitarReqTr: () => { if (S.tr) { delete S.tr.req; V.traspasos('nuevo'); } }, quitarReqOc: () => { if (S.oc) { delete S.oc.req; V.compras('nueva'); } }, quitarCfdiOc: () => { if (S.oc) { delete S.oc.cfdi; V.compras('nueva'); } }, cargarAnCompras, tabAnCompras, ordenAnCompras, anProducto, anProveedor, excelAnCompras, ligarCfdi, sumaCfdi, aplicarRep, cambiarOrdenesCfdi, sumaCfdiCambio, guardarCambioCfdi, descartarCfdi, verPdfCfdi, ocDesdeCfdi,
    vistaTraspasos: t => V.traspasos(t), abrirTraspaso: i => verTraspaso(S.lista[i].folio), verTraspaso, pdfTraspaso, formEditarTraspaso, guardarEdicionTraspaso, cargarTraspasos, pdfReporteTraspasos, limpiarTraspaso, guardarTraspaso,
    limpiarAjuste, guardarAjuste, crearConteo, abrirConteoI: i => abrirConteo(S.lista[i].id), guardarConteo: () => guardarConteo(false), formEncontrado, agregarEncontrado,
    vistaAjustes: t => V.ajustes(t), buscarAjustes, abrirAjuste: verAjuste, formCerrarConteo, cerrarConteo, cancelarConteo, eliminarConteo, ajustarConteo, pdfConteo, salirConteo, vistaInventario: t => V.inventario(t), abrirExistencia: verLotes,
    actualizarStock: async () => { await refrescarStock(); pintarExist(); toast('Existencias actualizadas'); },
    kardexDe: id => { cerrarModal(); S.tabInv = 'kardex'; V.inventario('kardex'); invKardex(id); },
    vistaProductos: t => V.productos(t), leerMatriz, mzFiltro, mzCampo, mzSel, mzSelTodo, mzAltaSel, mzAltaTodo, mzAltaForm, mzAltaTodos, mzAltaGuardar, mzAplicar, mzSinMatriz, verHistPrecios, subirFoto, fotoNuevaPrev, abrirProducto: i => formProducto(i), formProducto, verFicha, pdfCatalogo, compartirPdfLocal, firmaArch, guardarProducto,
    calcularPedido, pedTab, pedidoAOrden, pedidoATraspaso, riesgoATraspaso, riesgoAMerma,
    quitarFiltroCliente, quitarFiltroProv, ventasDeSucursal, comprasDeProveedor, traspasosDeSucursal,
    cargarRadar, pedidoHabitual, tbAnio, cargarTablero, tbTab, tbOrden, tbFiltro, tbDetalle, tbCsv, compProductos, compCsv, cargarMetas, formMeta, guardarMeta, motCotElegir, motCotGuardar, reabrirCotOk, abrirCliente: i => verCliente(i), verCliente, eliminarCliente, formCliente, guardarCliente, ventasDeCliente, venderA,
    abrirProveedor: i => formProveedor(i), formProveedor, guardarProveedor, activarProveedor,
    multiSel, verArch, subirArch, quitarArch, cerrarVisor, prevArchNuevo, cargarVendedores, fotoVendedor, prepararLogo, cancelarLogo, guardarLogo, verPreciosProducto, lpMarcar, lpMarcarGrupo, venderProducto,
    cargarSeguimiento, segEstado, segMas, fichaCliente, cargarVisitas, formVisita, ubicVisita, guardarVisita, verVisita, cancelarVisita, visitasDeCliente, icsVisita, sincronizarCalendario, suscribirCalendario, copiarEnlaceCal,
    abrirVisita: i => verVisita(S.visAg[i].id), abrirVisitaR: i => verVisita(S.visHechas[i].id),
    compartirPdf,
    rxDesdeVisita, formLigarVenta, guardarLigaVenta, venderDesdeVisita, formAltaProspecto, guardarAltaProspecto, historiaCliente, filtroHC,
    formReceta, verReceta, pdfReceta, rxACotizacion, rxAVenta, rxMas, rxLimpiarFirma, guardarReceta, recetasDeCliente, formRecetaCli, guardarCfgReceta, abrirReceta: i => verReceta(S.rxVis[i].id)
  };
})();
