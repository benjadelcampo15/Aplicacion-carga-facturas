const {
  nombrePestania, fechaARgentina, bancoNormalizado, filaComprobante,
} = require('../src/sheets');

const checks = [];
function check(nombre, ok, detalle) {
  checks.push([nombre, ok, detalle]);
}
function igual(nombre, obtenido, esperado) {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  check(nombre, ok, ok ? '' : `obtuvo ${JSON.stringify(obtenido)}`);
}

// --- Pestaña por mes de la transferencia ---
igual('julio', nombrePestania('2026-07-22'), 'JULIO 2026');
igual('enero', nombrePestania('2026-01-05'), 'ENERO 2026');
igual('diciembre otro año', nombrePestania('2025-12-31'), 'DICIEMBRE 2025');
check('fecha invalida tira error',
  (() => { try { nombrePestania('no-es-fecha'); return false; } catch { return true; } })());
check('fecha vacia tira error',
  (() => { try { nombrePestania(''); return false; } catch { return true; } })());

// --- Fecha a formato argentino ---
igual('fecha DD/MM/YYYY', fechaARgentina('2026-07-22'), '22/07/2026');
igual('rellena con cero', fechaARgentina('2026-03-05'), '05/03/2026');

// --- Banco normalizado ---
igual('santander con rio', bancoNormalizado('Banco Santander Río'), 'SANTANDER');
igual('nacion con acento', bancoNormalizado('Banco Nación'), 'NACION');
igual('supervielle', bancoNormalizado('SUPERVIELLE'), 'SUPERVIELLE');
igual('galicia', bancoNormalizado('Banco Galicia'), 'GALICIA');
igual('uala con acento', bancoNormalizado('Ualá'), 'UALA');
igual('mercado pago', bancoNormalizado('Mercado Pago'), 'MERCADO PAGO');
igual('banco desconocido queda en mayuscula sin acento',
  bancoNormalizado('Banco Comafi'), 'COMAFI');
igual('vacio queda vacio', bancoNormalizado(null), '');

// --- La fila A-H que se escribe ---
const data = {
  fecha: '2026-07-22',
  referencia: '424279 5675',
  banco_origen: 'Banco Santander Río',
  monto: 66842,
  nombre_origen: 'Carolina Chavarria',
  cbu_origen: '0720441220000000482990',
  concepto: 'Varios',
  tipo_operacion: 'transferencia',
};
const fila = filaComprobante(data, { name: 'Villegas', number: '549110' });

igual('la fila tiene 8 columnas (A-H)', fila.length, 8);
igual('A = fecha argentina', fila[0], '22/07/2026');
igual('B = transferencia', fila[1], '424279 5675');
igual('C = banco normalizado', fila[2], 'SANTANDER');
igual('D = N° cliente vacio', fila[3], '');
igual('E = CUIT vacio', fila[4], '');
igual('F = monto como numero', fila[5], 66842);
igual('G = chofer del whatsapp', fila[6], 'Villegas');
igual('H = titular', fila[7], 'Carolina Chavarria');

// El monto puede llegar formateado como texto: tiene que salir numero real.
igual('monto formateado se convierte',
  filaComprobante({ ...data, monto: '66.842' }, {})[5], 66842);

let fallos = 0;
for (const [nombre, ok, detalle] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}${detalle ? ` -> ${detalle}` : ''}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
