const { buildClave } = require('../src/sheets');

const casos = [
  ['mismo comprobante, monto con formato distinto', true,
    { referencia: '000123456', monto: 45000.5, fecha: '2026-07-20', nombre_origen: 'Juan Perez' },
    { referencia: '000123456', monto: '45000.50', fecha: '2026-07-20', nombre_origen: 'Juan Perez' }],

  ['misma ref con separadores/mayusculas', true,
    { referencia: 'REF-0012 3456', monto: 45000.5 },
    { referencia: 'ref0012-3456', monto: 45000.5 }],

  ['misma ref, monto distinto -> NO es duplicado', false,
    { referencia: '000123456', monto: 45000.5 },
    { referencia: '000123456', monto: 45000.6 }],

  ['sin ref: mismo dia/monto/origen con espacios y case', true,
    { referencia: null, monto: 12000, fecha: '2026-07-20', nombre_origen: 'Ana  GOMEZ ' },
    { referencia: '', monto: '12000.00', fecha: '2026-07-20', nombre_origen: 'ana gomez' }],

  ['sin ref: distinto origen -> NO es duplicado', false,
    { referencia: null, monto: 12000, fecha: '2026-07-20', nombre_origen: 'Ana Gomez' },
    { referencia: null, monto: 12000, fecha: '2026-07-20', nombre_origen: 'Luis Gomez' }],

  ['sin ref: distinta fecha -> NO es duplicado', false,
    { referencia: null, monto: 12000, fecha: '2026-07-20', nombre_origen: 'Ana Gomez' },
    { referencia: null, monto: 12000, fecha: '2026-07-21', nombre_origen: 'Ana Gomez' }],

  ['con ref vs sin ref, mismos datos -> NO colisiona', false,
    { referencia: '999', monto: 12000, fecha: '2026-07-20', nombre_origen: 'Ana Gomez' },
    { referencia: null, monto: 12000, fecha: '2026-07-20', nombre_origen: 'Ana Gomez' }],
];

let fallos = 0;
for (const [nombre, esperadoIgual, a, b] of casos) {
  const ka = buildClave(a);
  const kb = buildClave(b);
  const igual = ka === kb;
  const ok = igual === esperadoIgual;
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}`);
  if (!ok) console.log(`        A=${ka}\n        B=${kb}`);
}

console.log(`\nClaves de ejemplo:`);
console.log(' ', buildClave({ referencia: '000123456', monto: 45000.5 }));
console.log(' ', buildClave({ monto: 12000, fecha: '2026-07-20', nombre_origen: 'Ana Gomez' }));

console.log(`\n${casos.length - fallos}/${casos.length} pasaron`);
process.exit(fallos ? 1 : 0);
