const { extraerJSON, objetosBalanceados } = require('../src/json');

const checks = [];
function check(nombre, ok, detalle) {
  checks.push([nombre, ok, detalle]);
}

function igual(nombre, obtenido, esperado) {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  check(nombre, ok, ok ? '' : `obtuvo ${JSON.stringify(obtenido)}`);
}

// Respuesta real de qwen3.6 sobre un comprobante de Uala, recortada. El modelo
// razona en un bloque <think> y ahi adentro escribe un borrador del JSON: la
// regex greedy agarraba desde la llave del borrador hasta la del JSON final.
const CON_RAZONAMIENTO = `
<think>
The user wants me to extract data from a bank transfer receipt.

3.  **Construct JSON:**
    \`\`\`json
    {
      "monto": 99999,
      "fecha": "1999-01-01",
      "tipo_operacion": "borrador",
      "nombre_origen": "Borrador Que No Va",
      "cbu_origen": null,
      "banco_origen": "Uala",
      "referencia": "BORRADOR",
      "concepto": "VAR"
    }
    \`\`\`

4.  **Final Review:** Check against constraints. No markdown, valid JSON.
</think>

{
  "monto": 30755,
  "fecha": "2026-07-21",
  "tipo_operacion": "transferencia",
  "nombre_origen": "Gustavo Gabriel Salina",
  "cbu_origen": null,
  "banco_origen": "Ualá",
  "referencia": "3D5W612EW6JLRYQG2GXYVR",
  "concepto": "VAR"
}
`;

// Lo que hacia el codigo viejo, para confirmar que el caso es real.
const viejo = (texto) => {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};

check('el metodo viejo falla con este caso', viejo(CON_RAZONAMIENTO) === null);

const conRazonamiento = extraerJSON(CON_RAZONAMIENTO);
check('ahora si lo extrae', conRazonamiento !== null);
igual('toma el monto final, no el del borrador', conRazonamiento?.monto, 30755);
igual('toma el nombre final', conRazonamiento?.nombre_origen, 'Gustavo Gabriel Salina');
igual('toma la referencia final', conRazonamiento?.referencia, '3D5W612EW6JLRYQG2GXYVR');
igual('respeta los null', conRazonamiento?.cbu_origen, null);

// --- Otras formas en que puede venir la respuesta ---
const limpio = '{"monto": 100, "fecha": "2026-01-01"}';
igual('JSON pelado', extraerJSON(limpio)?.monto, 100);

igual('JSON en bloque markdown',
  extraerJSON('```json\n{"monto": 200, "fecha": "2026-01-02"}\n```')?.monto, 200);

igual('JSON con texto antes y despues',
  extraerJSON('Aca van los datos:\n{"monto": 300, "fecha": "2026-01-03"}\nEspero que sirva.')?.monto, 300);

igual('think sin cerrar (respuesta cortada)',
  extraerJSON('<think>estaba pensando y me cortaron')?.monto, undefined);

igual('el objeto de error tambien se reconoce',
  extraerJSON('{"error": "No es un comprobante válido o no se puede leer"}')?.error,
  'No es un comprobante válido o no se puede leer');

// Una llave dentro de un string no puede cortar el objeto.
igual('llaves dentro de un valor',
  extraerJSON('{"monto": 400, "concepto": "pago {urgente}", "fecha": "2026-01-04"}')?.concepto,
  'pago {urgente}');

igual('comillas escapadas en un valor',
  extraerJSON('{"monto": 500, "nombre_origen": "Juan \\"El Rapido\\" Perez"}')?.nombre_origen,
  'Juan "El Rapido" Perez');

// --- Cuando no hay nada utilizable ---
check('respuesta vacia', extraerJSON('') === null);
check('respuesta sin JSON', extraerJSON('No pude leer la imagen, perdon.') === null);
check('null', extraerJSON(null) === null);
check('JSON roto', extraerJSON('{"monto": 100, "fecha":') === null);
// Un objeto valido pero que no es un comprobante no sirve como respuesta.
check('objeto ajeno', extraerJSON('{"foo": "bar"}') === null);

// --- El escaneo de llaves ---
igual('cuenta los objetos sueltos',
  objetosBalanceados('{"a":1} texto {"b":2}').length, 2);
igual('los objetos anidados cuentan como uno',
  objetosBalanceados('{"a":{"b":{"c":1}}}').length, 1);

let fallos = 0;
for (const [nombre, ok, detalle] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}${detalle ? ` -> ${detalle}` : ''}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
