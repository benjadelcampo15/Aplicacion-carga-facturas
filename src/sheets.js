const crypto = require('crypto');
const { google } = require('googleapis');
const { aNumero } = require('./parser');

const HOJA_ERRORES = 'Errores';
const HEADERS_ERRORES = ['Timestamp', 'Remitente', 'Telefono', 'Motivo', 'Archivo', 'Tipo'];

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

const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO',
  'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

// La fecha del modelo/parser viene como YYYY-MM-DD. Se valida en serio porque de
// esto sale en que pestaña de mes se escribe: un mes equivocado descoloca la
// conciliacion.
function partesFecha(fechaISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fechaISO || '').trim());
  if (!m) return null;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return { anio, mes, dia };
}

// La pestaña se llama por el mes de la transferencia: "JULIO 2026".
function nombrePestania(fechaISO) {
  const p = partesFecha(fechaISO);
  if (!p) throw new Error(`No pude determinar el mes del comprobante (fecha "${fechaISO}")`);
  return `${MESES[p.mes - 1]} ${p.anio}`;
}

function fechaARgentina(fechaISO) {
  const p = partesFecha(fechaISO);
  if (!p) return String(fechaISO || '');
  const dd = String(p.dia).padStart(2, '0');
  const mm = String(p.mes).padStart(2, '0');
  return `${dd}/${mm}/${p.anio}`;
}

// La columna Banco de la planilla usa nombres cortos en mayuscula (SANTANDER,
// NACION, SUPERVIELLE). El modelo devuelve variantes ("Banco Nación", "Santander
// Río"), asi que se mapean las conocidas para que la columna ESTADO las cruce
// bien; el resto queda en mayuscula sin acentos.
const BANCOS_CANONICOS = [
  [/santander/i, 'SANTANDER'],
  [/naci[oó]n/i, 'NACION'],
  [/supervielle/i, 'SUPERVIELLE'],
  [/galicia/i, 'GALICIA'],
  [/macro/i, 'MACRO'],
  [/brubank/i, 'BRUBANK'],
  [/ual[aá]/i, 'UALA'],
  [/mercado\s*pago/i, 'MERCADO PAGO'],
  [/naranja/i, 'NARANJA X'],
  [/bbva|frances/i, 'BBVA'],
  [/provincia/i, 'PROVINCIA'],
  [/ciudad/i, 'CIUDAD'],
  [/credicoop/i, 'CREDICOOP'],
];

function bancoNormalizado(banco) {
  const texto = String(banco || '').trim();
  if (!texto) return '';

  for (const [patron, canonico] of BANCOS_CANONICOS) {
    if (patron.test(texto)) return canonico;
  }

  return texto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^banco\s+/i, '')
    .toUpperCase();
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


// Arma la fila A-H de la planilla de choferes. I y J (ESTADO y CONTROL) no se
// tocan: son formulas de la planilla. E (CUIT) queda vacia, se carga a mano. El
// chofer es el nombre del contacto de WhatsApp; el N° Cliente lo manda el chofer
// en un mensaje aparte, asi que puede venir vacio y completarse despues.
function filaComprobante(data, senderInfo, numeroCliente = '') {
  const monto = aNumero(data.monto);
  return [
    fechaARgentina(data.fecha),          // A Fecha
    data.referencia || '',               // B Transferencia
    bancoNormalizado(data.banco_origen), // C Banco
    numeroCliente || '',                 // D N° Cliente
    '',                                  // E CUIT / DNI
    monto === null ? (data.monto || '') : monto, // F Monto (numero)
    senderInfo?.name || '',              // G Chofer
    data.nombre_origen || '',            // H Titular banco
  ];
}

// Escribe el N° Cliente (columna D) en una fila ya cargada, cuando el numero
// llega despues del comprobante.
async function actualizarNumeroCliente({ pestania, fila }, numeroCliente) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${pestania}!D${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[numeroCliente]] },
  });
  console.log(`N° Cliente ${numeroCliente} puesto en "${pestania}" fila ${fila}`);
}

async function appendRow(data, senderInfo, numeroCliente = '') {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const pestania = nombrePestania(data.fecha);
  const fila = filaComprobante(data, senderInfo, numeroCliente);

  // Se ubica la primera fila libre leyendo la columna A, en vez de dejar que la
  // API "adivine" la tabla: asi no depende de como esten armadas las columnas
  // con formulas de la planilla, y se escribe solo A-H sin pisar I ni J.
  let ocupadas;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${pestania}!A:A`,
    });
    ocupadas = (res.data.values || []).length;
  } catch (err) {
    if (/Unable to parse range/i.test(err.message)) {
      throw new Error(`Falta la pestaña "${pestania}" en la planilla`);
    }
    throw err;
  }

  const numeroFila = ocupadas + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${pestania}!A${numeroFila}:H${numeroFila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [fila] },
  });

  console.log(`Fila ${numeroFila} agregada a "${pestania}":`, fila);
  return { pestania, fila: numeroFila };
}

module.exports = {
  appendRow,
  actualizarNumeroCliente,
  filaComprobante,
  nombrePestania,
  fechaARgentina,
  bancoNormalizado,
  normalizarPrivateKey,
  diagnosticoPrivateKey,
  validarCredenciales,
  appendError,
  leerErrores,
  HOJA_ERRORES,
};
