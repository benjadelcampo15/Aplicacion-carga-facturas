const { crearCola } = require('../src/cola');
const { esperaTrasRateLimit, esReintentable, conReintentos } = require('../src/extractor');

const checks = [];
function check(nombre, ok) {
  checks.push([nombre, ok]);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Error 429 estilo Groq: el tiempo de espera venia en la cabecera retry-after.
// Se mantiene por compatibilidad de la funcion que lo lee.
function error429(retryAfter) {
  const err = new Error('Rate limit reached for model `qwen/qwen3.6-27b` ... '
    + 'Please try again in 26.4825s. Need more tokens?');
  err.status = 429;
  err.headers = retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) };
  return err;
}

// Error 429 como lo tira Gemini: el detalle trae "retryDelay":"34s".
function error429Gemini(segundos) {
  const err = new Error(
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED",'
    + `"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"${segundos}s"}]}}`,
  );
  err.status = 429;
  return err;
}

async function main() {
  // --- La cola procesa de a uno ---
  const cola = crearCola();
  let simultaneas = 0;
  let maxSimultaneas = 0;
  const orden = [];

  const tarea = (n) => async () => {
    simultaneas++;
    maxSimultaneas = Math.max(maxSimultaneas, simultaneas);
    await dormir(20);
    orden.push(n);
    simultaneas--;
    return n;
  };

  const encoladas = [1, 2, 3, 4, 5].map((n) => cola.encolar(tarea(n)));
  check('la primera no espera', encoladas[0].posicion === 0);
  check('las siguientes reportan su lugar',
    encoladas.map((e) => e.posicion).join(',') === '0,1,2,3,4');

  await Promise.all(encoladas.map((e) => e.promesa));
  check('nunca corre mas de una a la vez', maxSimultaneas === 1);
  check('respeta el orden de llegada', orden.join(',') === '1,2,3,4,5');
  check('la cola queda vacia al terminar', cola.largo === 0);

  // Un error no puede frenar la cola: los que siguen tienen que procesarse.
  const cola2 = crearCola();
  const corridas = [];
  const a = cola2.encolar(async () => {
    corridas.push('a');
    throw new Error('se rompio');
  });
  const b = cola2.encolar(async () => {
    corridas.push('b');
    return 'b';
  });

  const resultadoA = await a.promesa.then(() => 'ok', (err) => err.message);
  const resultadoB = await b.promesa;

  check('el que falla rechaza su promesa', resultadoA === 'se rompio');
  check('el siguiente se procesa igual', resultadoB === 'b');
  check('un fallo no traba la cola',
    corridas.join(',') === 'a,b' && cola2.largo === 0);

  // --- Lectura del rate limit ---
  check('lee el retryDelay de Gemini', esperaTrasRateLimit(error429Gemini(34)) === 35000);
  check('usa la cabecera retry-after de Groq', esperaTrasRateLimit(error429(27)) === 28000);
  check('si no hay cabecera lee el texto del error',
    esperaTrasRateLimit(error429(undefined)) === 27482.5);
  check('recorta esperas absurdas', esperaTrasRateLimit(error429Gemini(600)) === 90000);
  check('un error que no es 429 no genera espera',
    esperaTrasRateLimit(Object.assign(new Error('otra cosa'), { status: 400 })) === null);

  // --- Que se reintenta y que no ---
  check('reintenta el rate limit', esReintentable(error429(1)) === true);
  check('reintenta errores del servidor',
    esReintentable(Object.assign(new Error('boom'), { status: 503 })) === true);
  check('reintenta cuando el modelo no devuelve JSON',
    esReintentable(new Error('No se obtuvo JSON válido')) === true);
  check('no reintenta un pedido invalido',
    esReintentable(Object.assign(new Error('mal'), { status: 400 })) === false);

  // --- El reintento efectivamente recupera ---
  // No dormimos de verdad, pero registramos cuanto se habria esperado.
  const esperas = [];
  const sinDormir = { esperar: async (ms) => { esperas.push(ms); } };

  let llamadas = 0;
  const recuperado = await conReintentos('prueba', async () => {
    llamadas++;
    if (llamadas < 3) throw error429(27);
    return 'listo';
  }, sinDormir);
  check('reintenta hasta que sale bien', recuperado === 'listo' && llamadas === 3);
  check('espera lo que pide Groq entre reintentos',
    esperas.join(',') === '28000,28000');

  let llamadasJson = 0;
  const conJson = await conReintentos('prueba', async () => {
    llamadasJson++;
    if (llamadasJson === 1) throw new Error('No se obtuvo JSON válido');
    return { monto: 100 };
  }, sinDormir);
  check('el JSON invalido se reintenta y recupera',
    conJson.monto === 100 && llamadasJson === 2);

  let llamadasFatal = 0;
  const fatal = await conReintentos('prueba', async () => {
    llamadasFatal++;
    throw Object.assign(new Error('pedido invalido'), { status: 400 });
  }, sinDormir).catch((err) => err);
  check('un error no reintentable corta de una',
    fatal.status === 400 && llamadasFatal === 1);

  // Cuatro intentos y se rinde: si no, un comprobante ilegible reintenta para
  // siempre y traba la cola de todos los demas.
  let llamadasEternas = 0;
  await conReintentos('prueba', async () => {
    llamadasEternas++;
    throw error429(27);
  }, sinDormir).catch(() => {});
  check('se rinde despues de 4 intentos', llamadasEternas === 4);

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
