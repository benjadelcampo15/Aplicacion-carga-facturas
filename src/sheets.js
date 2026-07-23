const crypto = require('crypto');
const { google } = require('googleapis');
const { aNumero } = require('./parser');

const SHEET_NAME = 'Hoja 1';
const HOJA_ERRORES = 'Errores';
const HEADERS_ERRORES = ['Timestamp', 'Remitente', 'Telefono', 'Motivo', 'Archivo', 'Tipo'];

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
function armarPem(tipo, cuerpo) {
  const lineas = cuerpo.match(/.{1,64}/g) || [];
  return `-----BEGIN ${tipo}-----\n${lineas.join('\n')}\n-----END ${tipo}-----\n`;
}

function openSSLLaAcepta(pem) {
  try {
    crypto.createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

function normalizarPrivateKey(bruta) {
  let clave = String(bruta ?? '').trim();

  const entrecomillada = (c) => clave.length > 1 && clave.startsWith(c) && clave.endsWith(c);
  if (entrecomillada('"') || entrecomillada("'")) {
    clave = clave.slice(1, -1);
  }

  const partes = clave.match(PEM);
  if (!partes) return clave.replace(/\\[nr]/g, '\n').trim();

  const [, tipo, cuerpo] = partes;

  // Una barra invertida seguida de "n" puede ser un salto escapado, o una barra
  // suelta pegada a una letra de la clave: "n" es base64 valido, asi que
  // mirando el texto no se distinguen. Probamos las dos lecturas y nos
  // quedamos con la que OpenSSL acepta, en vez de adivinar y comernos una letra.
  // El "\\+" cubre tanto \n como \\n: el valor puede venir escapado una vez o
  // dos segun cuantas capas de configuracion haya atravesado.
  const candidatos = [
    cuerpo.replace(/\\+[nr]/g, '').replace(/\s+/g, ''),
    cuerpo.replace(/[\s\\]+/g, ''),
  ];

  for (const candidato of candidatos) {
    const pem = armarPem(tipo, candidato);
    if (openSSLLaAcepta(pem)) return pem;
  }

  // Ninguna sirve: devolvemos la mas probable para que el diagnostico explique
  // que le pasa al cuerpo.
  return armarPem(tipo, candidatos[0]);
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
  'tu_api_key_de_gemini',
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

// Misma lectura que el resto: si el monto llega formateado, "66.842" tiene que
// dar sesenta y seis mil, no sesenta y seis. Si la clave se armara con el valor
// mal leido, el mismo comprobante daria claves distintas segun como llegue.
function normalizarMonto(monto) {
  const numero = aNumero(monto);
  return numero === null ? normalizar(monto) : numero.toFixed(2);
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

// La pestaña de errores se crea sola la primera vez que algo falla, para no
// obligar a tocar el Sheet a mano.
let erroresListos = false;

async function asegurarHojaErrores(sheets) {
  if (erroresListos) return;

  const libro = await sheets.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
  });
  const existe = libro.data.sheets
    .some((hoja) => hoja.properties.title === HOJA_ERRORES);

  if (!existe) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: HOJA_ERRORES } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${HOJA_ERRORES}!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS_ERRORES] },
    });
    console.log(`Pestaña "${HOJA_ERRORES}" creada en el Sheet`);
  }

  erroresListos = true;
}

async function appendError({ motivo, archivo, tipo, senderInfo }) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await asegurarHojaErrores(sheets);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${HOJA_ERRORES}!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        new Date().toISOString(),
        senderInfo?.name || '',
        senderInfo?.number || '',
        motivo || '',
        archivo || '',
        tipo || '',
      ]],
    },
  });
}

async function leerErrores() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${HOJA_ERRORES}!A:F`,
    });
    return (res.data.values || []).slice(1);
  } catch (err) {
    // Todavia no fallo nada, asi que la pestaña no existe. No es un error.
    if (/Unable to parse range/i.test(err.message)) return [];
    throw err;
  }
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
  appendError,
  leerErrores,
  HOJA_ERRORES,
};
