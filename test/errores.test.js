const fs = require('fs');
const os = require('os');
const path = require('path');

// DATA_DIR se lee al importar el modulo, asi que se define antes.
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'errores-test-'));
process.env.DATA_DIR = TEMP;

const { esNombreSeguro, leerArchivo, DIR_ERRORES } = require('../src/errores');
const { dashboard } = require('../src/web');

const checks = [];
function check(nombre, ok) {
  checks.push([nombre, ok]);
}

const appState = { connected: true, duplicados: 0, enCola: 0, lastError: null };

async function main() {
  // --- Nombres de archivo ---
  // El nombre sale de una celda del Sheet, que alguien puede editar a mano.
  check('acepta un nombre normal', esNombreSeguro('1784749007-a1b2c3d4.jpg') === true);
  check('acepta pdf', esNombreSeguro('123-abcd.pdf') === true);

  const peligrosos = [
    '../../../etc/passwd',
    '..\\..\\windows\\system32\\config\\sam',
    '/etc/shadow',
    'archivo.jpg/../../../secreto',
    '....//....//etc/passwd',
    'con espacio.jpg',
    'sin-extension',
    '',
    null,
  ];
  const rechazados = peligrosos.filter((n) => esNombreSeguro(n) === false);
  check('rechaza todos los nombres peligrosos',
    rechazados.length === peligrosos.length);

  // No alcanza con la validacion: hay que confirmar que no lee nada afuera.
  fs.mkdirSync(DIR_ERRORES, { recursive: true });
  fs.writeFileSync(path.join(TEMP, 'secreto.txt'), 'esto no se tiene que poder leer');
  fs.writeFileSync(path.join(DIR_ERRORES, 'valido.jpg'), 'contenido de prueba');

  const fuga = await leerArchivo('../secreto.txt');
  check('no deja salir de la carpeta de errores', fuga === null);

  const fugaWin = await leerArchivo('..\\secreto.txt');
  check('tampoco con barras de Windows', fugaWin === null);

  const bueno = await leerArchivo('valido.jpg');
  check('si lee un archivo valido', bueno?.toString() === 'contenido de prueba');

  const inexistente = await leerArchivo('9999-aaaa.jpg');
  check('un archivo que no existe devuelve null', inexistente === null);

  // --- La seccion en el dashboard ---
  const sinErrores = dashboard(appState, []);
  check('sin errores muestra el mensaje vacio',
    sinErrores.includes('No hay comprobantes con error'));

  const errores = [
    {
      timestamp: new Date().toISOString(),
      remitente: 'Ana Gomez',
      motivo: 'No se pudo extraer contenido del PDF',
      archivo: '123-abcd.pdf',
      disponible: true,
    },
    {
      timestamp: new Date().toISOString(),
      remitente: '<img src=x onerror=alert(1)>',
      motivo: 'Rate limit',
      archivo: '124-efgh.jpg',
      disponible: false,
    },
  ];
  const conErrores = dashboard(appState, errores);

  check('lista los errores', conErrores.includes('No se pudo extraer contenido del PDF'));
  check('el disponible tiene link', conErrores.includes('href="/errores/123-abcd.pdf"'));
  check('el podado no tiene link',
    !conErrores.includes('href="/errores/124-efgh.jpg"')
    && conErrores.includes('no disponible'));
  check('cuenta cuantos hay en el titulo', conErrores.includes('Comprobantes con error (2)'));
  check('escapa el nombre del remitente',
    !conErrores.includes('<img src=x') && conErrores.includes('&lt;img src=x'));

  fs.rmSync(TEMP, { recursive: true, force: true });

  let fallos = 0;
  for (const [nombre, ok] of checks) {
    if (!ok) fallos++;
    console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}`);
  }
  console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
  process.exit(fallos ? 1 : 0);
}

main().catch((err) => {
  console.error('El test se cayo:', err);
  process.exit(1);
});
