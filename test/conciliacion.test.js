const { agregar } = require('../src/stats');
const { dashboard } = require('../src/web');

const checks = [];
function check(nombre, ok, detalle) {
  checks.push([nombre, ok, detalle]);
}

function igual(nombre, obtenido, esperado) {
  const ok = obtenido === esperado;
  check(nombre, ok, ok ? '' : `obtuvo ${obtenido}, esperaba ${esperado}`);
}

const ts = (dias) => new Date(Date.now() - dias * 86400000).toISOString();

// Fila con 13 columnas: la M es el estado de conciliacion.
function fila(monto, conciliado = '', dias = 0) {
  const t = ts(dias);
  return [t, t.slice(0, 10), 'transferencia', 'Alguien', String(monto),
    '', '', String(monto), '', 'Benja', '549110', `k${monto}`, conciliado];
}

const appState = { connected: true, duplicados: 0, lastError: null };

// --- Sin dato propio: todo simulado ---
// Las filas se arman una sola vez: en el Sheet el timestamp de una fila ya
// escrita no cambia, que es lo que hace estable al estado simulado.
const filasSinDato = [fila(1000), fila(2000), fila(3000)];
const sinDato = agregar(filasSinDato);
check('marca la conciliacion como simulada', sinDato.conciliacionSimulada === true);
check('los tres estados suman el total',
  sinDato.conciliacion.conciliado.cantidad
  + sinDato.conciliacion.pendiente.cantidad
  + sinDato.conciliacion.no_concilia.cantidad === 3);

// Si cambiara en cada refresco de la pagina, el numero inventado pasaria por
// real hasta que alguien lo mirara dos veces.
const otraVez = agregar(filasSinDato);
check('el estado simulado es estable entre llamadas',
  JSON.stringify(sinDato.conciliacion) === JSON.stringify(otraVez.conciliacion));

// Y tiene que repartir, no mandar todo a un solo estado.
const muchas = agregar(Array.from({ length: 60 }, (_, i) => fila(1000 + i * 137, '', i % 14)));
const repartidos = ['conciliado', 'pendiente', 'no_concilia']
  .filter((e) => muchas.conciliacion[e].cantidad > 0);
check('el estado simulado usa los tres valores', repartidos.length === 3);

// --- Con dato propio: manda el Sheet ---
const conDato = agregar([
  fila(1000, 'si'), fila(2000, 'no'), fila(3000, 'pendiente'), fila(4000, 'SÍ'),
]);
check('deja de estar simulada si hay dato real', conDato.conciliacionSimulada === false);
check('lee "si" como conciliado', conDato.conciliacion.conciliado.cantidad === 2);
check('lee "no" como no concilia', conDato.conciliacion.no_concilia.cantidad === 1);
check('lo que no reconoce queda pendiente', conDato.conciliacion.pendiente.cantidad === 1);
check('acumula el monto por estado', conDato.conciliacion.conciliado.monto === 5000);

// --- Montos formateados por Google ---
// El Sheet devuelve las celdas segun la configuracion regional de la planilla,
// asi que los montos llegan como texto formateado y no como numero. Leerlos mal
// hacia que el total del dashboard quedara mil veces mas chico.
function filaConMonto(monto) {
  const t = ts(0);
  return [t, t.slice(0, 10), 'transferencia', 'Alguien', monto,
    '', '', 'ref', '', 'Benja', '549110', 'k', ''];
}

const formateados = agregar([
  filaConMonto('66.842'),
  filaConMonto('$66.842,00'),
  filaConMonto('$263,485.00'),
  filaConMonto('1.234.567'),
  filaConMonto(66842),
]);
igual('suma bien los montos formateados',
  formateados.montoTotal, 66842 + 66842 + 263485 + 1234567 + 66842);

igual('el monto de hoy tambien',
  formateados.hoy.monto, 66842 + 66842 + 263485 + 1234567 + 66842);

// --- Sheet vacio ---
const vacio = agregar([]);
check('sheet vacio no se marca como simulado', vacio.conciliacionSimulada === false);
check('sheet vacio deja los tres estados en cero',
  vacio.conciliacion.conciliado.cantidad === 0
  && vacio.conciliacion.pendiente.cantidad === 0
  && vacio.conciliacion.no_concilia.cantidad === 0);

// --- La web tiene que avisar que es mentira ---
const htmlSimulado = dashboard(appState, sinDato, null);
check('el dashboard muestra el cartel de simulado',
  htmlSimulado.includes('DATOS SIMULADOS'));
check('el cartel explica que no se cruza contra nada',
  /no se cruza contra extractos/.test(htmlSimulado));
check('las tarjetas simuladas se distinguen visualmente',
  htmlSimulado.includes('class="conc simulado"'));

const htmlReal = dashboard(appState, conDato, null);
check('sin simulacion no aparece el cartel', !htmlReal.includes('DATOS SIMULADOS'));
check('sin simulacion las tarjetas son normales', htmlReal.includes('class="conc "'));

check('la tabla etiqueta cada carga', htmlReal.includes('class="tag si"'));
check('el dashboard muestra la seccion', htmlSimulado.includes('Conciliación'));

let fallos = 0;
for (const [nombre, ok, detalle] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}${detalle ? ` -> ${detalle}` : ''}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
