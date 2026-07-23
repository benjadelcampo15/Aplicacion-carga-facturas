const { parsearComprobante, aNumero, buscarFecha } = require('../src/parser');

const checks = [];
function check(nombre, ok, detalle) {
  checks.push([nombre, ok, detalle]);
}

function igual(nombre, obtenido, esperado) {
  const ok = obtenido === esperado;
  check(nombre, ok, ok ? '' : `obtuvo ${JSON.stringify(obtenido)}, esperaba ${JSON.stringify(esperado)}`);
}

// --- Conversion de importes ---
igual('monto con miles y decimales', aNumero('$ 5.200,00'), 5200);
igual('monto pegado al signo', aNumero('$45.000,50'), 45000.5);
igual('monto sin decimales', aNumero('$768.347'), 768347);
igual('monto chico', aNumero('$1.234,56'), 1234.56);
igual('monto de millones', aNumero('$375.139,61'), 375139.61);
igual('monto simple', aNumero('5200'), 5200);
igual('texto sin numero', aNumero('sin monto'), null);
igual('monto en cero se descarta', aNumero('$0,00'), null);

// --- Fechas ---
igual('fecha con barras', buscarFecha('Fecha 18/05/2026'), '2026-05-18');
igual('fecha con guiones', buscarFecha('01-12-2025'), '2025-12-01');
igual('fecha de dos digitos', buscarFecha('05/03/26'), '2026-03-05');
igual('fecha escrita', buscarFecha('18 de mayo de 2026'), '2026-05-18');
igual('dia primero, no mes', buscarFecha('12/07/2026'), '2026-07-12');

// --- Comprobante de Uala, con el layout exacto del PDF real ---
const uala = `
Comprobante de transferencia
Fecha y hora
18/05/2026 21:25 hs
Monto debitado
$5.200,00
Cuenta destino
Tobias Del Campo Baez
CBU destino
0000003100057030393118
CUIT destino
20420648155
Nombre remitente
Juan francisco Curia
Concepto
VAR
Id Op.
ORD6LEN8PXD4GRLYNM1Y30
`;

const u = parsearComprobante(uala);
check('Uala: lo parsea', u !== null);
igual('Uala: monto', u?.monto, 5200);
igual('Uala: fecha', u?.fecha, '2026-05-18');
// El error mas caro seria confundir quien paga con quien cobra.
igual('Uala: toma el remitente, no el destino', u?.nombre_origen, 'Juan francisco Curia');
igual('Uala: no toma el CBU destino como origen', u?.cbu_origen, null);
igual('Uala: referencia', u?.referencia, 'ORD6LEN8PXD4GRLYNM1Y30');
igual('Uala: concepto', u?.concepto, 'VAR');
igual('Uala: tipo', u?.tipo_operacion, 'transferencia');

// --- Homebanking clasico ---
const santander = `
Banco Santander Rio
Constancia de Transferencia
Fecha: 20/07/2026
Importe: $ 375.139,61
Cuenta origen
Titular de la cuenta origen: Silvia Rafaela Gallardo
CBU: 0720441220000000482990
Cuenta destino
Switch Company Sa
CBU destino: 0110599520000012345678
Numero de operacion: 424279 5675
Concepto: Varios
`;

const s = parsearComprobante(santander);
check('Santander: lo parsea', s !== null);
igual('Santander: monto', s?.monto, 375139.61);
igual('Santander: fecha', s?.fecha, '2026-07-20');
igual('Santander: banco', s?.banco_origen, 'Santander');
igual('Santander: CBU de origen, no el de destino',
  s?.cbu_origen, '0720441220000000482990');
igual('Santander: referencia', s?.referencia, '4242795675');

// --- Mercado Pago ---
const mp = `
Mercado Pago
Transferencia realizada
$ 66.842,00
21 de julio de 2026
De
CAROLINA LEILA CHAVARRIA PADILLA
CUIT/CUIL 27-11881142-8
Para
Switch Company Sa
Cuenta en Banco Santander
Numero de operacion 4244715675
`;

const m = parsearComprobante(mp);
check('Mercado Pago: lo parsea', m !== null);
igual('Mercado Pago: monto', m?.monto, 66842);
igual('Mercado Pago: fecha escrita', m?.fecha, '2026-07-21');
igual('Mercado Pago: referencia', m?.referencia, '4244715675');

// --- Casos donde tiene que rendirse y dejarselo a la IA ---
check('sin monto se rinde', parsearComprobante('Fecha: 20/07/2026\nHola') === null);
check('sin fecha se rinde', parsearComprobante('Importe: $ 5.000,00') === null);
check('texto vacio se rinde', parsearComprobante('') === null);
check('texto corto se rinde', parsearComprobante('hola') === null);
check('null se rinde', parsearComprobante(null) === null);
check('texto que no es comprobante se rinde',
  parsearComprobante('Estimado cliente, le informamos que su resumen esta disponible.') === null);

// Marca su origen, para poder distinguir en el Sheet que salio del parser.
igual('marca la fuente', u?._fuente, 'parser');

let fallos = 0;
for (const [nombre, ok, detalle] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}${detalle ? ` -> ${detalle}` : ''}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
