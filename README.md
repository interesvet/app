# Interés Veterinario — app instalable

App de ventas, inventario, clientes y seguimiento de **Interés Veterinario**, instalable en iPhone, iPad, Android y Mac.

- Dirección: **https://app.interesveterinario.com**
- Datos: siguen en Google Sheets; el servidor es la implementación de Apps Script (`config.js` → `IV_API`).
- La pantalla (`app.js`, `estilos.css`, `index.html`) se genera con `tools/construir.py` desde los mismos
  archivos de la app de Apps Script (Index.html, Estilos.html, App.html): una sola fuente.
- `shim.js` traduce `google.script.run` a llamadas `fetch` al servidor (`doPost`).
- `sw.js` guarda la app en el dispositivo para abrir al instante y sin señal; avisa cuando hay versión nueva.

No contiene datos de clientes ni contraseñas: todo eso vive en Google Sheets y se consulta con la sesión del usuario.
