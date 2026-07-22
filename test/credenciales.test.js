const crypto = require('crypto');
const { normalizarPrivateKey, diagnosticoPrivateKey, validarCredenciales } = require('../src/sheets');

const checks = [];
function check(nombre, ok) {
  checks.push([nombre, ok]);
}

// Clave real, para que la prueba sea que OpenSSL la parsea, no que el string
// tenga la pinta correcta.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function openSSLLaAcepta(clave) {
  try {
    crypto.createPrivateKey(normalizarPrivateKey(clave));
    return true;
  } catch {
    return false;
  }
}

// Cada variante es una forma real en que la clave llega rota segun donde se
// pegue: el .env, el panel de Railway, un campo de una sola linea, etc.
const variantes = {
  'tal cual (saltos reales)': privateKey,
  'saltos como \\n literal': privateKey.replace(/\n/g, '\\n'),
  'entre comillas dobles': `"${privateKey.replace(/\n/g, '\\n')}"`,
  'entre comillas simples': `'${privateKey.replace(/\n/g, '\\n')}'`,
  'saltos convertidos en espacios': privateKey.replace(/\n/g, ' '),
  'saltos perdidos del todo': privateKey.replace(/\n/g, ''),
  'saltos de Windows': privateKey.replace(/\n/g, '\r\n'),
  'con espacios alrededor': `   ${privateKey}   `,
  'lineas mal cortadas': privateKey.replace(/\n/g, '\n  '),
  'comillas y espacios juntos': `  "${privateKey.replace(/\n/g, '\\n')}"  `,
  // El caso que aparecio en produccion: el valor llega doble-escapado, el
  // reemplazo de \n deja barras invertidas colgadas dentro del base64.
  'doble escapado (\\\\n)': privateKey.replace(/\n/g, '\\\\n'),
  'barras invertidas sueltas': privateKey.replace(/\n/g, '\\'),
  'mezcla de \\r\\n escapados': privateKey.replace(/\n/g, '\\r\\n'),
};

for (const [nombre, variante] of Object.entries(variantes)) {
  check(`OpenSSL parsea: ${nombre}`, openSSLLaAcepta(variante));
}

// La clave reconstruida tiene que ser la misma, no una que solo parsea.
const original = crypto.createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'pem' });
const reconstruida = crypto
  .createPrivateKey(normalizarPrivateKey(privateKey.replace(/\n/g, '')))
  .export({ type: 'pkcs8', format: 'pem' });
check('la clave reconstruida es identica a la original', original === reconstruida);

check('no revienta con undefined', normalizarPrivateKey(undefined) === '');

// El diagnostico tiene que nombrar el problema, no repetir el error de OpenSSL.
check('clave sana no reporta problemas', diagnosticoPrivateKey(privateKey) === null);
check('clave entrecomillada no reporta problemas',
  diagnosticoPrivateKey(privateKey.replace(/\n/g, '\\n')) === null);
check('sin bloque PEM avisa que falta BEGIN/END',
  /bloque PEM completo/.test(diagnosticoPrivateKey('cualquier cosa') || ''));
check('truncada avisa que esta truncada',
  /truncada/.test(diagnosticoPrivateKey(
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----') || ''));
check('cuerpo con basura avisa que no es base64',
  /base64/.test(diagnosticoPrivateKey(
    `-----BEGIN PRIVATE KEY-----\n${'!@#$%'.repeat(300)}\n-----END PRIVATE KEY-----`) || ''));

// El mensaje tiene que nombrar los caracteres que sobran, no decir "no es
// base64" y dejarte adivinando.
const conBasura = diagnosticoPrivateKey(
  `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(1600)}!?\n-----END PRIVATE KEY-----`) || '';
check('el diagnostico lista los caracteres sobrantes',
  conBasura.includes('"!"') && conBasura.includes('"?"'));
check('el doble escapado ya no llega al diagnostico',
  diagnosticoPrivateKey(privateKey.replace(/\n/g, '\\\\n')) === null);
check('el diagnostico nunca incluye la clave',
  !JSON.stringify(Object.values(variantes).map(diagnosticoPrivateKey))
    .includes(privateKey.split('\n')[1]));

function validarCon(env) {
  const previo = { ...process.env };
  Object.assign(process.env, env);
  try {
    validarCredenciales();
    return null;
  } catch (err) {
    return err.message;
  } finally {
    process.env = previo;
  }
}

const base = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'x@y.iam.gserviceaccount.com',
  GOOGLE_SHEETS_ID: 'abc123',
  GOOGLE_PRIVATE_KEY: privateKey,
};

check('credenciales validas pasan', validarCon(base) === null);
check('credenciales entrecomilladas pasan',
  validarCon({ ...base, GOOGLE_PRIVATE_KEY: `"${privateKey.replace(/\n/g, '\\n')}"` }) === null);
check('falta el email y lo dice por nombre',
  /GOOGLE_SERVICE_ACCOUNT_EMAIL/.test(
    validarCon({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: '' }) || ''));
check('clave rota se explica al arrancar',
  /GOOGLE_PRIVATE_KEY:/.test(validarCon({ ...base, GOOGLE_PRIVATE_KEY: 'rota' }) || ''));

// El bug real: los valores del .env.example llegaron a produccion sin
// reemplazar, y el error hablaba de base64 en vez de decir esto.
const conEjemplo = validarCon({ ...base, GOOGLE_SHEETS_ID: 'id_del_google_sheet' }) || '';
check('detecta el ID de ejemplo',
  /valor de ejemplo/.test(conEjemplo) && conEjemplo.includes('GOOGLE_SHEETS_ID'));
check('detecta la clave de ejemplo',
  /valor de ejemplo/.test(validarCon({
    ...base,
    GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntu_key_aqui\n-----END PRIVATE KEY-----',
  }) || ''));
check('detecta el email de ejemplo',
  /valor de ejemplo/.test(validarCon({
    ...base,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'tu_service_account@proyecto.iam.gserviceaccount.com',
  }) || ''));
const variasDeEjemplo = validarCon({
  ...base,
  GOOGLE_SHEETS_ID: 'id_del_google_sheet',
  GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntu_key_aqui\n-----END PRIVATE KEY-----',
}) || '';
check('nombra todas las variables de ejemplo juntas',
  variasDeEjemplo.includes('GOOGLE_SHEETS_ID')
  && variasDeEjemplo.includes('GOOGLE_PRIVATE_KEY'));

let fallos = 0;
for (const [nombre, ok] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
