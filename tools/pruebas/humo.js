/**
 * Prueba de humo de la app (se corre antes de cada publicación y en GitHub Actions):
 * abre la app con datos de prueba, entra a cada sección y falla si aparece un error del programa
 * (función o variable que no existe, error de sintaxis, botón que llama algo que no está).
 * Uso: node tools/pruebas/humo.js   (desde la raíz del repositorio)
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const RAIZ = path.resolve(__dirname, '..', '..'), PUERTO = 8799;
const TIPOS = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
const VISTAS = ['inicio', 'venta', 'pos', 'ventas', 'cotizaciones', 'cobranza', 'caja', 'clientes', 'seguimiento', 'productos', 'inventario', 'precios', 'compras',
  'proveedores', 'traspasos', 'requisiciones', 'ajustes', 'conteo', 'gastos', 'sucursales', 'reuniones', 'recetas', 'pedido', 'resumen', 'config'];
const GRAVE = /(ReferenceError|SyntaxError|is not defined|App\.\w+ is not a function|before initialization|has already been declared)/;
const usuario = { id: 'u1', nombre: 'USUARIO PRUEBA', rol: 'Administrador', rolNombre: 'Administrador', sucursal: 'SUC_1', todasSucursales: true, permisos: {} };
['dashboard', 'ver_costos', 'ver_utilidades', 'ver_importes', 'ventas', 'compras', 'inventario', 'clientes', 'cotizaciones', 'seguimiento', 'equipo', 'dueno', 'bancos', 'listas_precios',
  'cobranza', 'traspasos', 'mermas', 'ajustes', 'inventario_fisico', 'configuracion', 'proveedores', 'facturacion', 'productos_editar', 'clientes_editar', 'pagos_proveedor', 'requisiciones', 'devoluciones', 'recetas']
  .forEach(k => usuario.permisos[k] = true);
const bootstrap = { user: usuario, servidor: new Date().toISOString(), sucursales: [{ id: 'SUC_1', nombre: 'Matriz', serie: 'MAT', tipo: 'Matriz', lista: 'Publico' }], permitidas: ['SUC_1'],
  productos: [{ id: 'P1', nombre: 'PRODUCTO DE PRUEBA, Frasco de 100 ml', precios: { Publico: 100 }, iva: 0.16, cat: 'Prueba', lab: 'LAB' }], clientes: [{ id: 'C1', nombre: 'CLIENTE DE PRUEBA', razon: 'CLIENTE DE PRUEBA', lista: 'Publico' }],
  proveedores: [], stock: [], porLlegar: [], vendedores: [], catalogos: { formasPago: [], metodosPago: [], bancos: [], usoCfdi: [], regimen: [], tasasIva: [], paqueterias: [], listas: ['Publico'], listaBase: '', margenMin: 0 },
  folios: {}, config: { diasCaducidad: 120, ventaSinExist: {}, rxCats: [] } };

const srv = http.createServer((q, r) => {
  let f = decodeURIComponent(q.url.split('?')[0]); if (f === '/') f = '/index.html';
  const p = path.join(RAIZ, f); if (!p.startsWith(RAIZ) || !fs.existsSync(p)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': TIPOS[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r);
}).listen(PUERTO);

(async () => {
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(d => { localStorage.setItem('iv_token', JSON.stringify('prueba')); localStorage.setItem('iv_datos', JSON.stringify(d)); localStorage.setItem('iv_novVista', '999999'); }, bootstrap);
  await ctx.route(/script\.google\.com/, async r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    const acc = (body.args || [])[1]; const data = acc === 'bootstrap' ? bootstrap : acc === 'ping' ? { t: Date.now() } : {};
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: body.fn === 'api' ? data : '' }) });
  });
  await ctx.route(/fonts\.|jsdelivr|unpkg/, r => r.abort());
  const pg = await ctx.newPage(), errores = [];
  let vista = 'arranque';
  pg.on('pageerror', e => { if (GRAVE.test(e.message)) errores.push(vista + ': ' + e.message); });
  await pg.goto('http://localhost:' + PUERTO + '/index.html'); await pg.waitForTimeout(3000);
  for (const v of VISTAS) { vista = v; try { await pg.evaluate(x => App.ir(x), v); } catch (e) { if (GRAVE.test(e.message)) errores.push(v + ': ' + e.message); } await pg.waitForTimeout(700); }
  // todos los onclick="App.x(...)" deben existir
  const usados = Array.from(new Set((fs.readFileSync(path.join(RAIZ, 'app.js'), 'utf8').match(/App\.([a-zA-Z_]\w*)\(/g) || []).map(x => x.slice(4, -1))));
  const faltan = await pg.evaluate(l => l.filter(n => typeof App[n] !== 'function'), usados);
  if (faltan.length) errores.push('botones que llaman funciones inexistentes: App.' + faltan.join(', App.'));
  await b.close(); srv.close();
  if (errores.length) { console.error('❌ Prueba de humo: ' + errores.length + ' error(es)\n' + Array.from(new Set(errores)).join('\n')); process.exit(1); }
  console.log('✅ Prueba de humo: ' + VISTAS.length + ' secciones sin errores del programa');
})().catch(e => { console.error('❌ ' + e.message); srv.close(); process.exit(1); });
