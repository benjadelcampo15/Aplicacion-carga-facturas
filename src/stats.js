const { leerFilas } = require('./sheets');

const ZONA = 'America/Argentina/Buenos_Aires';
const CACHE_MS = 30000;
const DIAS_GRAFICO = 14;
const ULTIMAS_CARGAS = 10;

// Columnas del Sheet: A Timestamp, B Fecha, C Tipo, D Origen, E Monto,
// F CBU, G Banco, H Referencia, I Concepto, J Remitente, K Telefono, L Clave.
const COL = { TIMESTAMP: 0, FECHA: 1, ORIGEN: 3, MONTO: 4, REMITENTE: 9 };

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

  for (const fila of filas) {
    const dia = diaLocal(fila[COL.TIMESTAMP]);
    const monto = aMonto(fila[COL.MONTO]);
    montoTotal += monto;

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
    }));

  return {
    totalCargas: filas.length,
    montoTotal,
    hoy: porDia.get(hoy) || { cargas: 0, monto: 0 },
    serie,
    ultimas,
    diasActivos: porDia.size,
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

module.exports = { getStats, invalidarCache, agregar };
