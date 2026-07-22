const { normalizarPrivateKey, validarCredenciales } = require('../src/sheets');

const CUERPO = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQfake';
const PEM = `-----BEGIN PRIVATE KEY-----\n${CUERPO}\n-----END PRIVATE KEY-----\n`;
const PEM_ESCAPADO = `-----BEGIN PRIVATE KEY-----\\n${CUERPO}\\n-----END PRIVATE KEY-----\\n`;

const checks = [];
function check(nombre, ok) {
  checks.push([nombre, ok]);
}

const valida = (clave) => normalizarPrivateKey(clave).startsWith('-----BEGIN PRIVATE KEY-----')
  && normalizarPrivateKey(clave).includes('\n');

// Como queda al pegarla en el panel de Railway con las comillas del .env.
check('comillas dobles alrededor', valida(`"${PEM_ESCAPADO}"`));
check('comillas simples alrededor', valida(`'${PEM_ESCAPADO}'`));
check('saltos escapados sin comillas', valida(PEM_ESCAPADO));
check('saltos reales sin comillas', valida(PEM));
check('saltos reales con comillas', valida(`"${PEM}"`));
check('espacios alrededor', valida(`   ${PEM_ESCAPADO}   `));

check('los saltos escapados se convierten',
  normalizarPrivateKey(PEM_ESCAPADO).split('\n').length === 3);
check('no rompe una clave ya limpia',
  normalizarPrivateKey(PEM) === PEM.trim());
check('no revienta con undefined', normalizarPrivateKey(undefined) === '');

// La validacion tiene que explicar el problema, no tirar el error de OpenSSL.
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
  GOOGLE_PRIVATE_KEY: PEM_ESCAPADO,
};

check('credenciales validas pasan', validarCon(base) === null);
check('credenciales entrecomilladas pasan',
  validarCon({ ...base, GOOGLE_PRIVATE_KEY: `"${PEM_ESCAPADO}"` }) === null);
check('clave truncada avisa que no es PEM',
  /no arranca con/.test(validarCon({ ...base, GOOGLE_PRIVATE_KEY: CUERPO }) || ''));
check('falta el email y lo dice por nombre',
  /GOOGLE_SERVICE_ACCOUNT_EMAIL/.test(
    validarCon({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: '' }) || ''));

let fallos = 0;
for (const [nombre, ok] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
