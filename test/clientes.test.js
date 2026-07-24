const { crearVinculador, VENTANA_MS } = require('../src/clientes');

const checks = [];
function check(nombre, ok, detalle) {
  checks.push([nombre, ok, detalle]);
}
function igual(nombre, obtenido, esperado) {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  check(nombre, ok, ok ? '' : `obtuvo ${JSON.stringify(obtenido)}`);
}

const CHOFER_A = '5491111111@s.whatsapp.net';
const CHOFER_B = '5492222222@s.whatsapp.net';

// --- Que cuenta como numero de cliente ---
const v0 = crearVinculador();
igual('numero pelado', v0.numeroDeCliente('3640'), '3640');
igual('con espacios', v0.numeroDeCliente('  3640  '), '3640');
igual('con la palabra cliente', v0.numeroDeCliente('cliente 3640'), '3640');
igual('con dos puntos', v0.numeroDeCliente('cliente: 3640'), '3640');
igual('un saludo no es numero', v0.numeroDeCliente('hola'), null);
igual('gracias no es numero', v0.numeroDeCliente('gracias!'), null);
igual('texto con numero adentro no cuenta', v0.numeroDeCliente('llegue a las 3640 de la calle'), null);
igual('demasiados digitos no cuenta', v0.numeroDeCliente('30707873678'), null);
igual('vacio no cuenta', v0.numeroDeCliente(''), null);

// --- Numero DESPUES de la foto ---
const v1 = crearVinculador();
igual('sin numero previo, el comprobante va vacio',
  v1.numeroParaComprobante(CHOFER_A, ''), null);
v1.comprobanteSinNumero(CHOFER_A, { pestania: 'JULIO 2026', fila: 5 });
const despues = v1.texto(CHOFER_A, '3640');
igual('el numero encuentra el comprobante que esperaba',
  despues.ubicacion, { pestania: 'JULIO 2026', fila: 5, ts: despues.ubicacion.ts });
igual('y trae el numero', despues.numero, '3640');

// --- Numero ANTES de la foto ---
const v2 = crearVinculador();
const antes = v2.texto(CHOFER_A, '3789');
check('sin comprobante esperando, el numero queda guardado', antes.guardado === true);
igual('el comprobante que llega despues lo toma',
  v2.numeroParaComprobante(CHOFER_A, ''), '3789');
igual('y no se usa dos veces', v2.numeroParaComprobante(CHOFER_A, ''), null);

// --- El epigrafe manda sobre todo ---
const v3 = crearVinculador();
v3.texto(CHOFER_A, '1111');
igual('si la foto trae el numero en el epigrafe, gana ese',
  v3.numeroParaComprobante(CHOFER_A, '2222'), '2222');
igual('y el que estaba guardado sigue disponible',
  v3.numeroParaComprobante(CHOFER_A, ''), '1111');

// --- DOS CHOFERES A LA VEZ: no se pueden mezclar ---
const v4 = crearVinculador();
v4.comprobanteSinNumero(CHOFER_A, { pestania: 'JULIO 2026', fila: 10 });
v4.comprobanteSinNumero(CHOFER_B, { pestania: 'JULIO 2026', fila: 11 });

const numeroDeA = v4.texto(CHOFER_A, '100');
const numeroDeB = v4.texto(CHOFER_B, '200');

igual('el numero del chofer A va a la fila del chofer A', numeroDeA.ubicacion.fila, 10);
igual('el numero del chofer B va a la fila del chofer B', numeroDeB.ubicacion.fila, 11);
igual('con el numero correcto para A', numeroDeA.numero, '100');
igual('con el numero correcto para B', numeroDeB.numero, '200');

// Y al reves: un numero guardado de un chofer no lo agarra el otro.
const v5 = crearVinculador();
v5.texto(CHOFER_A, '555');
igual('el comprobante del chofer B no toma el numero del A',
  v5.numeroParaComprobante(CHOFER_B, ''), null);
igual('el del chofer A si lo toma', v5.numeroParaComprobante(CHOFER_A, ''), '555');

// --- Varios comprobantes seguidos: se aparean en orden ---
const v6 = crearVinculador();
v6.comprobanteSinNumero(CHOFER_A, { pestania: 'JULIO 2026', fila: 20 });
v6.comprobanteSinNumero(CHOFER_A, { pestania: 'JULIO 2026', fila: 21 });
igual('el primer numero va al primer comprobante',
  v6.texto(CHOFER_A, '1').ubicacion.fila, 20);
igual('el segundo al segundo', v6.texto(CHOFER_A, '2').ubicacion.fila, 21);

// --- La ventana de tiempo ---
let reloj = 0;
const v7 = crearVinculador({ ahora: () => reloj });
v7.texto(CHOFER_A, '999');
reloj += VENTANA_MS + 1000;
igual('un numero viejo ya no se pega a una foto nueva',
  v7.numeroParaComprobante(CHOFER_A, ''), null);

let reloj2 = 0;
const v8 = crearVinculador({ ahora: () => reloj2 });
v8.comprobanteSinNumero(CHOFER_A, { pestania: 'JULIO 2026', fila: 30 });
reloj2 += VENTANA_MS + 1000;
check('un numero que llega tardisimo no completa una fila vieja',
  v8.texto(CHOFER_A, '888').guardado === true);

let fallos = 0;
for (const [nombre, ok, detalle] of checks) {
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}${detalle ? ` -> ${detalle}` : ''}`);
}
console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
process.exit(fallos ? 1 : 0);
