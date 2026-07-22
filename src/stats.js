const { leerFilas } = require('./sheets');

const ZONA = 'America/Argentina/Buenos_Aires';
const CACHE_MS = 30000;
const DIAS_GRAFICO = 14;
const ULTIMAS_CARGAS = 10;

// Columnas del Sheet: A Timestamp, B Fecha, C Tipo, D Origen, E Monto,
// F CBU, G Banco, H Referencia, I Concepto, J Remitente, K Telefono, L Clave,
// M Conciliado.
const COL = { TIMESTAMP: 0, FECHA: 1, ORIGEN: 3, MONTO: 4, REMITENTE: 9, CONCILIADO: 12 };

const ESTADOS = ['conciliado', 'pendiente', 'no_concilia'];

let cache = { datos: null, expira: 0 };

// El Timestamp se guarda en UTC pero el corte del dia tiene que ser el de
// Argentina, si no las cargas de la noche caen en el dia siguiente.
function diaLocal(iso) {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return null;
  return fecha.toLocaleDateString('en-CA', { timeZone: ZONA });
}

function hoyLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
}

function aMonto(valor) {
  const numero = Number(String(valor ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numero) ? numero : 0;
}

// Todavia no hay nada contra que conciliar: no cruzamos con extractos ni con
// facturas. Hasta que la columna M del Sheet se empiece a llenar, el estado es
// inventado y la web lo tiene que mostrar como tal.
function leerConciliado(fila) {
  const crudo = String(fila[COL.CONCILIADO] ?? '').trim().toLowerCase();
  if (!crudo) return null;

  if (['si', 'sí', 'ok', 'conciliado', 'true', '1'].includes(crudo)) return 'conciliado';
  if (['no', 'no concilia', 'false', '0'].includes(crudo)) return 'no_concilia';
  return 'pendiente';
}

// Determinista a proposito: si fuera al azar, el numero cambiaria en cada
// refresco de la pagina y se notaria que no es real recien despues de mirarlo
// dos veces.
function estadoSimulado(fila) {
  const semilla = String(fila[COL.TIMESTAMP] ?? '') + String(fila[COL.MONTO] ?? '');
  let hash = 0;
  for (let i = 0; i < semilla.length; i++) {
    hash = (hash * 31 + semilla.charCodeAt(i)) % 100;
  }
  if (hash < 62) return 'conciliado';
  if (hash < 85) return 'pendiente';
  return 'no_concilia';
}

function ultimosDias(cantidad) {
  const dias = [];
  const ahora = new Date();
  for (let i = cantidad - 1; i >= 0; i--) {
    const dia = new Date(ahora.getTime() - i * 24 * 60 * 60 * 1000);
    dias.push(dia.toLocaleDateString('en-CA', { timeZone: ZONA }));
  }
  return dias;
}

function agregar(filas) {
  const porDia = new Map();
  let montoTotal = 0;

  const conciliacion = {
    conciliado: { cantidad: 0, monto: 0 },
    pendiente: { cantidad: 0, monto: 0 },
    no_concilia: { cantidad: 0, monto: 0 },
  };
  // Si ninguna fila trae dato propio, todo lo que se muestra es inventado.
  let algunoReal = false;

  for (const fila of filas) {
    const dia = diaLocal(fila[COL.TIMESTAMP]);
    const monto = aMonto(fila[COL.MONTO]);
    montoTotal += monto;

    const real = leerConciliado(fila);
    if (real) algunoReal = true;
    const estado = real || estadoSimulado(fila);
    conciliacion[estado].cantidad++;
    conciliacion[estado].monto += monto;

    if (!dia) continue;
    const acumulado = porDia.get(dia) || { cargas: 0, monto: 0 };
    acumulado.cargas++;
    acumulado.monto += monto;
    porDia.set(dia, acumulado);
  }

  const hoy = hoyLocal();
  const serie = ultimosDias(DIAS_GRAFICO).map((dia) => ({
    dia,
    cargas: porDia.get(dia)?.cargas || 0,
    monto: porDia.get(dia)?.monto || 0,
  }));

  const ultimas = filas
    .slice(-ULTIMAS_CARGAS)
    .reverse()
    .map((fila) => ({
      timestamp: fila[COL.TIMESTAMP] || '',
      fecha: fila[COL.FECHA] || '',
      origen: fila[COL.ORIGEN] || '',
      monto: aMonto(fila[COL.MONTO]),
      remitente: fila[COL.REMITENTE] || '',
      conciliado: leerConciliado(fila) || estadoSimulado(fila),
    }));

  return {
    totalCargas: filas.length,
    montoTotal,
    hoy: porDia.get(hoy) || { cargas: 0, monto: 0 },
    serie,
    ultimas,
    diasActivos: porDia.size,
    conciliacion,
    conciliacionSimulada: filas.length > 0 && !algunoReal,
  };
}

async function getStats() {
  if (cache.datos && Date.now() < cache.expira) return cache.datos;

  const filas = await leerFilas();
  const datos = agregar(filas);

  cache = { datos, expira: Date.now() + CACHE_MS };
  return datos;
}

function invalidarCache() {
  cache = { datos: null, expira: 0 };
}

module.exports = { getStats, invalidarCache, agregar, ESTADOS };
