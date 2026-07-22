const { google } = require('googleapis');

const SHEET_NAME = 'Hoja 1';

// Claves ya escritas por este proceso. Cierra la ventana de carrera entre el
// chequeo contra el Sheet y el append, cuando entran dos comprobantes juntos.
const clavesEnProceso = new Set();

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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

module.exports = { appendRow, buildClave, buscarDuplicado };
