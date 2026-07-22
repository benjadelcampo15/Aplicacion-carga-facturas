const { dashboard, pantallaQR } = require('../src/web');
const { agregar } = require('../src/stats');

// Los nombres y montos los escribe un modelo leyendo una imagen que manda
// cualquiera por WhatsApp, asi que tienen que salir escapados si o si.
const ts = new Date().toISOString();
const img = '<img src=x onerror=alert(1)>';
const script = '"><script>alert(2)</script>';

const filas = [[ts, ts.slice(0, 10), 'transferencia', img, '1000', '', '', '', '', script, '', 'k']];
const html = dashboard(
  { connected: true, duplicados: 0, lastError: img },
  agregar(filas),
  script,
);
const qr = pantallaQR('data:image/png;base64,AAA" onerror="alert(3)');
const vacio = agregar([]);

const checks = [
  ['origen no se inyecta crudo', !html.includes('<img src=x')],
  ['remitente no se inyecta crudo', !html.includes('<script>alert(2)')],
  ['origen aparece escapado', html.includes('&lt;img src=x onerror=alert(1)&gt;')],
  ['remitente aparece escapado', html.includes('&lt;script&gt;alert(2)&lt;/script&gt;')],
  ['src del QR no rompe el atributo', !qr.includes('onerror="alert(3)"')],
  ['sheet vacio no explota', vacio.totalCargas === 0 && vacio.serie.length === 14],
  ['sheet vacio no divide por cero', vacio.hoy.cargas === 0 && vacio.diasActivos === 0],
  ['monto con formato raro no rompe el total',
    agregar([[ts, '', '', '', '$ 1.000,50', '', '', '', '', '', '', '']]).montoTotal >= 0],
];

let fallos = 0;
for (const [nombre, ok] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
