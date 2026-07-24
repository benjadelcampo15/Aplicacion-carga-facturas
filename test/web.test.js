const { dashboard, pantallaQR } = require('../src/web');

const checks = [];
function check(nombre, ok) {
  checks.push([nombre, ok]);
}

// El remitente sale del nombre de WhatsApp y el motivo del error puede traer
// texto del comprobante: todo tiene que salir escapado.
const errores = [{
  timestamp: new Date().toISOString(),
  remitente: '<img src=x onerror=alert(1)>',
  motivo: '"><script>alert(2)</script>',
  archivo: '123-abcd.jpg',
  disponible: true,
}];

const appState = { connected: true, processed: 5, enCola: 2, fallidos: 1, lastError: null };
const html = dashboard(appState, errores);

check('muestra los procesados', html.includes('>5<'));
check('muestra la cola', html.includes('>2<'));
check('muestra los fallidos', html.includes('>1<'));
check('remitente no se inyecta crudo', !html.includes('<img src=x'));
check('motivo no se inyecta crudo', !html.includes('<script>alert(2)'));
check('remitente aparece escapado', html.includes('&lt;img src=x onerror=alert(1)&gt;'));
check('linkea el archivo disponible', html.includes('href="/errores/123-abcd.jpg"'));
check('muestra estado conectado', html.includes('WhatsApp conectado'));

const sinErrores = dashboard({ connected: false, processed: 0, enCola: 0, fallidos: 0 }, []);
check('sin errores muestra el mensaje vacio', sinErrores.includes('No hay comprobantes con error'));
check('desconectado se muestra', sinErrores.includes('Desconectado'));

const qr = pantallaQR('data:image/png;base64,AAA" onerror="alert(3)');
check('src del QR no rompe el atributo', !qr.includes('onerror="alert(3)"'));

let fallos = 0;
for (const [nombre, ok] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
