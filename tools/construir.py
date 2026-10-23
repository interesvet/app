#!/usr/bin/env python3
"""
Construye la app instalable (PWA) a partir de los mismos archivos de la app de Apps Script
(Index.html, Estilos.html, App.html) para que exista UNA sola fuente de la pantalla.

Uso:  python3 tools/construir.py /ruta/a/la/carpeta/de/apps-script
Genera en la raíz del repositorio: index.html, estilos.css, app.js, sw.js (con versión nueva).
"""
import sys, os, re, hashlib, json, datetime

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RAIZ, '..', 'app')
leer = lambda n: open(os.path.join(SRC, n), encoding='utf-8').read()

index, estilos, app = leer('Index.html'), leer('Estilos.html'), leer('App.html')
css = re.sub(r'^\s*<style>\s*|\s*</style>\s*$', '', estilos.strip())
js = re.sub(r'^\s*<script>\s*|\s*</script>\s*$', '', app.strip())
open(os.path.join(RAIZ, 'estilos.css'), 'w', encoding='utf-8').write(css + '\n' + open(os.path.join(RAIZ, 'tools', 'pwa.css'), encoding='utf-8').read())
open(os.path.join(RAIZ, 'app.js'), 'w', encoding='utf-8').write(js + '\n')

cabeza_pwa = """  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#1f6f4a">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Interés Vet">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" type="image/png" href="icons/favicon.png">
  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
  <link rel="stylesheet" href="estilos.css">"""
h = index.replace('<base target="_top">\n', '').replace('  <base target="_top">\n', '')
h = h.replace("<?!= include('Estilos'); ?>", cabeza_pwa.strip())
h = h.replace("<script>window.LOGO = '<?!= logoDataUri() ?>';</script>",
              '<script src="config.js"></script>\n  <script src="shim.js"></script>')
h = h.replace("<?!= include('App'); ?>", '<script src="app.js"></script>\n  <script src="pwa.js"></script>')
assert '<?' not in h, 'Quedó una etiqueta de plantilla de Apps Script en Index.html'
open(os.path.join(RAIZ, 'index.html'), 'w', encoding='utf-8').write(h)

# versión = huella de todos los archivos que se guardan en el teléfono
ARCH = ['index.html', 'estilos.css', 'app.js', 'config.js', 'shim.js', 'pwa.js', 'manifest.webmanifest', 'logo.png',
        'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon.png']
hsh = hashlib.sha1()
for a in ARCH: hsh.update(open(os.path.join(RAIZ, a), 'rb').read())
version = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-6))).strftime('%Y%m%d-%H%M') + '-' + hsh.hexdigest()[:8]   # hora de Mérida / CDMX
sw = open(os.path.join(RAIZ, 'tools', 'sw.plantilla.js'), encoding='utf-8').read()
sw = sw.replace('__VERSION__', version).replace('__ARCHIVOS__', json.dumps(['./'] + ARCH))
open(os.path.join(RAIZ, 'sw.js'), 'w', encoding='utf-8').write(sw)
print('Listo. Versión', version)
