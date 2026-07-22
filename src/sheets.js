const { google } = require('googleapis');

const SHEET_NAME = 'Hoja 1';

// Claves ya escritas por este proceso. Cierra la ventana de carrera entre el
// chequeo contra el Sheet y el append, cuando entran dos comprobantes juntos.
const clavesEnProceso = new Set();

const CABECERA_PEM = '-----BEGIN PRIVATE KEY-----';

// dotenv saca las comillas del .env, pero los paneles tipo Railway guardan el
// valor tal cual se pega. Si quedan, OpenSSL falla con
// "DECODER routines::unsupported", que no dice nada sobre la causa real.
function normalizarPrivateKey(bruta) {
  let clave = String(bruta ?? '').trim();

  const entrecomillada = (c) => clave.length > 1 && clave.startsWith(c) && clave.endsWith(c);
  if (entrecomillada('"') || entrecomillada("'")) {
    clave = clave.slice(1, -1);
  }

  // Segun como se haya pegado, los saltos vienen como \n literal o reales.
  return clave.replace(/\\n/g, '\n').trim();
}

function validarCredenciales() {
  const faltantes = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SHEETS_ID']
    .filter((nombre) => !process.env[nombre]);

  if (faltantes.length) {
    throw new Error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
  }

  if (!normalizarPrivateKey(process.env.GOOGLE_PRIVATE_KEY).startsWith(CABECERA_PEM)) {
    throw new Error(
      `GOOGLE_PRIVATE_KEY no arranca con "${CABECERA_PEM}". `
      + 'Revisá que este completa y sin comillas alrededor.',
    );
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
  validarCredenciales,
};
