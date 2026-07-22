// Prueba las credenciales de Google contra el Sheet real, sin levantar
// WhatsApp. Sirve para no tener que deployar en cada intento.
//
//   npm run check:sheets                 usa el .env local
//   railway run npm run check:sheets     usa las variables de Railway
require('dotenv').config();

const { validarCredenciales, leerFilas, normalizarPrivateKey } = require('../src/sheets');

function ok(texto) {
  console.log(`  OK    ${texto}`);
}

function fallo(texto) {
  console.log(`  FALLA ${texto}`);
}

async function main() {
  console.log('\nChequeando credenciales de Google...\n');

  console.log(`  Cuenta : ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '(sin definir)'}`);
  console.log(`  Sheet  : ${process.env.GOOGLE_SHEETS_ID || '(sin definir)'}`);

  const clave = normalizarPrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  const lineas = clave ? clave.split('\n').length : 0;
  console.log(`  Clave  : ${clave.length} caracteres, ${lineas} lineas\n`);

  try {
    validarCredenciales();
    ok('la private key tiene forma de PEM valido');
  } catch (err) {
    fallo(err.message);
    console.log('\nNo sigo: hay que arreglar la variable antes de probar el Sheet.\n');
    process.exit(1);
  }

  try {
    const filas = await leerFilas();
    ok(`OpenSSL acepto la clave y Google respondio`);
    ok(`el Sheet tiene ${filas.length} filas de datos`);
    console.log('\nTodo en orden.\n');
  } catch (err) {
    fallo(`Google rechazo la consulta: ${err.message}`);

    if (/DECODER|unsupported/i.test(err.message)) {
      console.log('\n  La clave sigue sin parsear. Copiá de nuevo el campo private_key');
      console.log('  del JSON de la service account, sin escaparlo.\n');
    } else if (/permission|403|forbidden/i.test(err.message)) {
      console.log('\n  La clave esta bien, pero la cuenta no tiene acceso al Sheet.');
      console.log('  Compartilo con el email de arriba como Editor.\n');
    } else if (/not found|404/i.test(err.message)) {
      console.log('\n  GOOGLE_SHEETS_ID no corresponde a ningun Sheet accesible.\n');
    } else if (/Unable to parse range/i.test(err.message)) {
      console.log('\n  La pestaña del Sheet no se llama "Hoja 1". Renombrala o');
      console.log('  cambia SHEET_NAME en src/sheets.js.\n');
    } else {
      console.log('');
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nEl chequeo se cayo:', err.message, '\n');
  process.exit(1);
});
