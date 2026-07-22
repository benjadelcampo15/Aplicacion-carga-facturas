const { google } = require('googleapis');

const SHEET_NAME = 'Hoja 1';

// Claves ya escritas por este proceso. Cierra la ventana de carrera entre el
// chequeo contra el Sheet y el append, cuando entran dos comprobantes juntos.
const clavesEnProceso = new Set();

const PEM = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/;

// La clave viaja mal de mil formas segun donde se pegue: dotenv le saca las
// comillas al .env pero Railway las guarda; los saltos pueden llegar como \n
// literal, como saltos reales, convertidos en espacios, o directamente
// perdidos. En todos esos casos OpenSSL tira el mismo
// "DECODER routines::unsupported", que no dice nada.
//
// En vez de parchear caso por caso, reconstruimos el PEM: nos quedamos con el
// cuerpo, le sacamos todo el espacio en blanco y lo re-partimos en lineas de
// 64, que es como tiene que estar.
function normalizarPrivateKey(bruta) {
  let clave = String(bruta ?? '').trim();

  const entrecomillada = (c) => clave.length > 1 && clave.startsWith(c) && clave.endsWith(c);
  if (entrecomillada('"') || entrecomillada("'")) {
    clave = clave.slice(1, -1);
  }

  clave = clave.replace(/\\[nr]/g, '\n').trim();

  const partes = clave.match(PEM);
  if (!partes) return clave;

  const [, tipo, cuerpo] = partes;
  // Ademas del espacio en blanco sacamos barras invertidas sueltas: aparecen
  // cuando el valor viene doble-escapado (\\n en vez de \n) y el reemplazo de
  // arriba deja la barra colgada. Una barra nunca es parte de un base64.
  const limpio = cuerpo.replace(/[\s\\]+/g, '');
  const lineas = limpio.match(/.{1,64}/g) || [];

  return `-----BEGIN ${tipo}-----\n${lineas.join('\n')}\n-----END ${tipo}-----\n`;
}

// Describe la forma de la clave sin exponerla, para poder diagnosticar desde
// la web sin que el secreto aparezca en pantalla ni en los logs.
function diagnosticoPrivateKey(bruta) {
  const original = String(bruta ?? '');
  const partes = normalizarPrivateKey(original).match(PEM);

  if (!partes) {
    return `no encontre un bloque PEM completo (largo: ${original.length}). `
      + 'Revisá que esten las lineas BEGIN y END y que no este cortada.';
  }

  const cuerpo = partes[2].replace(/\s+/g, '');

  const sobrantes = [...new Set(cuerpo.replace(/[A-Za-z0-9+/=]/g, ''))];
  if (sobrantes.length) {
    // Los caracteres que sobran no son secretos y son justo lo que hace falta
    // saber para entender como se rompio el valor al pegarlo.
    const listado = sobrantes.map((c) => JSON.stringify(c)).join(', ');
    return `al cuerpo le sobran estos caracteres que no son base64: ${listado}. `
      + 'Copiá de nuevo el campo private_key del JSON, sin escaparlo.';
  }

  // Una clave RSA de 2048 bits en PKCS#8 ronda los 1600 caracteres.
  if (cuerpo.length < 1000) {
    return `el cuerpo tiene solo ${cuerpo.length} caracteres, parece truncada.`;
  }
  return null;
}

// Textos de relleno del .env.example. Copiarlos a produccion sin reemplazar
// es facil, y el error que sale despues habla de claves invalidas en vez de
// decir que la variable nunca se cargo.
const PLACEHOLDERS = [
  'id_del_google_sheet',
  'tu_key_aqui',
  'tu_api_key_de_groq',
  'tu_service_account@proyecto.iam.gserviceaccount.com',
];

function validarCredenciales() {
  const requeridas = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SHEETS_ID'];
  const faltantes = requeridas.filter((nombre) => !process.env[nombre]);

  if (faltantes.length) {
    throw new Error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
  }

  const falsas = requeridas.filter((nombre) => PLACEHOLDERS.some(
    (relleno) => process.env[nombre].includes(relleno),
  ));
  if (falsas.length) {
    throw new Error(
      `Estas variables tienen el valor de ejemplo del .env.example, no el real: ${falsas.join(', ')}`,
    );
  }

  const problema = diagnosticoPrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  if (problema) {
    throw new Error(`GOOGLE_PRIVATE_KEY: ${problema}`);
  }
}

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: normalizarPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function normalizar(valor) {
  return String(valor ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizarMonto(monto) {
  const numero = Number(monto);
  return Number.isFinite(numero) ? numero.toFixed(2) : normalizar(monto);
}

// Dos comprobantes son el mismo si comparten referencia y monto. Muchos
// comprobantes vienen sin referencia, así que ahí caemos a fecha+monto+origen.
function buildClave(data) {
  const monto = normalizarMonto(data.monto);
  const referencia = normalizar(data.referencia).replace(/[^a-z0-9]/g, '');

  if (referencia) {
    return `ref:${referencia}|${monto}`;
  }
  return `alt:${normalizar(data.fecha)}|${monto}|${normalizar(data.nombre_origen)}`;
}

async function buscarDuplicado(clave) {
  if (clavesEnProceso.has(clave)) return true;

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${SHEET_NAME}!L:L`,
  });

  const claves = (res.data.values || []).flat();
  return claves.includes(clave);
}

// Devuelve las filas de datos (sin el header) tal como estan en el Sheet.
async function leerFilas() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${SHEET_NAME}!A:L`,
  });

  const filas = res.data.values || [];
  return filas.slice(1);
}

async function appendRow(data, senderInfo) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const clave = buildClave(data);

  const row = [
    new Date().toISOString(),
    data.fecha || '',
    data.tipo_operacion || '',
    data.nombre_origen || '',
    data.monto || '',
    data.cbu_origen || '',
    data.banco_origen || '',
    data.referencia || '',
    data.concepto || '',
    senderInfo?.name || '',
    senderInfo?.number || '',
    clave,
  ];

  clavesEnProceso.add(clave);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${SHEET_NAME}!A:L`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row],
      },
    });
  } catch (err) {
    clavesEnProceso.delete(clave);
    throw err;
  }

  console.log('Fila agregada al Sheet:', row);
}

module.exports = {
  appendRow,
  buildClave,
  buscarDuplicado,
  leerFilas,
  normalizarPrivateKey,
  diagnosticoPrivateKey,
  validarCredenciales,
};
