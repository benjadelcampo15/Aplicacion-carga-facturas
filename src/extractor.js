const { GoogleGenAI } = require('@google/genai');
const pdfParse = require('pdf-parse');
const { renderizarPrimeraPagina } = require('./pdf');
const { parsearComprobante } = require('./parser');
const { extraerJSON } = require('./json');

// Se prueban en orden. Un modelo "lite" o preview se satura y devuelve 503
// ("high demand"), y ahi se cae al siguiente en vez de perder el comprobante.
// El primero es el mas estable; los demas son respaldo por si ese se cae.
const MODELOS = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
];

// Perezoso: creado al importar, el modulo revienta si falta la key antes de que
// index.js llegue a avisar cual falta.
let cliente = null;
function gemini() {
  if (!cliente) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    cliente = new GoogleGenAI({ apiKey });
  }
  return cliente;
}

const EXTRACTION_PROMPT = `Analizá este comprobante de pago bancario argentino.
Extraé los siguientes datos y devolvelos SOLO como JSON válido, sin texto adicional ni markdown ni bloques de código:

{
  "monto": (número, sin signo de pesos ni puntos de miles, usar punto como decimal. Ej: 45000.50),
  "fecha": (formato YYYY-MM-DD),
  "tipo_operacion": (transferencia / deposito / pago / otro),
  "nombre_origen": (nombre o razón social de quien paga),
  "cbu_origen": (CBU/CVU/alias si es visible, sino null),
  "banco_origen": (nombre del banco si es visible, sino null),
  "referencia": (número de referencia/comprobante si es visible, sino null),
  "concepto": (concepto o descripción si es visible, sino null)
}

Si no es un comprobante de pago, devolvé exactamente:
{"error": "No es un comprobante válido o no se puede leer"}`;

function extractImageFromPdf(pdfBuffer) {
  // Buscar JPEG
  const jpegStart = Buffer.from([0xFF, 0xD8, 0xFF]);
  const jpegEnd = Buffer.from([0xFF, 0xD9]);
  let startIdx = pdfBuffer.indexOf(jpegStart);
  if (startIdx !== -1) {
    const endIdx = pdfBuffer.indexOf(jpegEnd, startIdx);
    if (endIdx !== -1) {
      return { buffer: pdfBuffer.subarray(startIdx, endIdx + 2), mime: 'image/jpeg' };
    }
  }

  // Buscar PNG
  const pngStart = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
  const pngEnd = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
  startIdx = pdfBuffer.indexOf(pngStart);
  if (startIdx !== -1) {
    const endIdx = pdfBuffer.indexOf(pngEnd, startIdx);
    if (endIdx !== -1) {
      return { buffer: pdfBuffer.subarray(startIdx, endIdx + 8), mime: 'image/png' };
    }
  }

  return null;
}

// gemini-2.5-flash piensa antes de contestar y ese pensamiento consume tokens y
// tiempo. thinkingBudget 0 lo apaga: para leer un comprobante alcanza y es mas
// rapido. Si con eso sale incompleto se reintenta con pensamiento dinamico
// (-1), que ayuda en los comprobantes mas cargados. responseMimeType obliga a
// que la respuesta sea un JSON, sin markdown ni texto alrededor.
const SIN_PENSAR = {
  temperature: 0,
  responseMimeType: 'application/json',
  thinkingConfig: { thinkingBudget: 0 },
  maxOutputTokens: 1024,
};

const PENSANDO = {
  temperature: 0,
  responseMimeType: 'application/json',
  thinkingConfig: { thinkingBudget: -1 },
  maxOutputTokens: 4096,
};

const INTENTOS = 4;
const ESPERA_POR_DEFECTO_MS = 20000;
const ESPERA_MAXIMA_MS = 90000;

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cuando la cuota se agota, la respuesta dice cuanto falta para que se libere.
// Gemini lo manda como "retryDelay": "34s" en el detalle del error; se respeta
// eso antes de inventar un backoff.
function esperaTrasRateLimit(err) {
  if (err?.status !== 429) return null;

  // La cabecera retry-after es el valor estandar y tiene prioridad. Groq la
  // manda; Gemini no, y ahi el tiempo viene en el detalle del error.
  const cabecera = Number(err.headers?.['retry-after']);
  if (Number.isFinite(cabecera) && cabecera > 0) {
    return Math.min(cabecera * 1000 + 1000, ESPERA_MAXIMA_MS);
  }

  const texto = err.message || '';
  // Gemini: "retryDelay":"34s"  ·  Groq (en el texto): "try again in 34s"
  const match = /retryDelay"?\s*:?\s*"?(\d+(?:\.\d+)?)s/i.exec(texto)
    || /try again in ([\d.]+)s/i.exec(texto);
  if (match) {
    return Math.min(Number(match[1]) * 1000 + 1000, ESPERA_MAXIMA_MS);
  }

  return ESPERA_POR_DEFECTO_MS;
}

// El modelo a veces devuelve texto en vez de JSON. Reintentar sobre el MISMO
// modelo suele alcanzar. El rate limit (429) tambien, respetando la espera. Los
// 5xx NO se reintentan aca: significan que el modelo esta caido, asi que
// conviene cambiar de modelo en vez de insistir con el mismo.
function esReintentable(err) {
  return err?.status === 429
    || /No se obtuvo JSON válido/.test(err?.message || '');
}

// El modelo esta saturado o caido: no sirve insistir, hay que probar otro.
function modeloCaido(err) {
  return err?.status >= 500
    || /UNAVAILABLE|overloaded|high demand/i.test(err?.message || '');
}

// esperar se puede reemplazar en los tests: si no, la suite se pasa un minuto
// durmiendo esperas de rate limit de verdad.
async function conReintentos(descripcion, fn, { esperar = dormir } = {}) {
  let ultimo;

  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      return await fn();
    } catch (err) {
      ultimo = err;
      if (!esReintentable(err) || intento === INTENTOS) break;

      const espera = esperaTrasRateLimit(err) ?? 2000 * intento;
      console.log(
        `${descripcion}: intento ${intento} fallo (${err.status || err.message}). `
        + `Reintento en ${Math.round(espera / 1000)}s`,
      );
      await esperar(espera);
    }
  }

  throw ultimo;
}

// Sin monto o sin fecha no se puede ni conciliar ni deduplicar, asi que vale la
// pena gastar una segunda llamada razonando antes de darlo por perdido.
function estaCompleto(datos) {
  return Boolean(datos && (datos.error || (datos.monto && datos.fecha)));
}

// Primero sin pensar, que es mas rapido; si sale incompleto se reintenta
// pensando. Ambos pasos sobre el MISMO modelo, con sus reintentos.
async function extraerConUnModelo(descripcion, modelo, partes) {
  const rapido = await conReintentos(
    `${descripcion} (${modelo})`, () => pedirGemini(modelo, partes, SIN_PENSAR),
  ).catch((err) => {
    if (modeloCaido(err)) throw err; // que lo agarre el fallback de modelo
    console.log(`${descripcion}: sin pensar no salió (${err.message})`);
    return null;
  });

  if (estaCompleto(rapido)) return rapido;

  console.log(`${descripcion}: reintentando con razonamiento...`);
  return conReintentos(`${descripcion} (${modelo}) pensando`, () => pedirGemini(modelo, partes, PENSANDO));
}

// Prueba los modelos en orden. Si uno esta caido o saturado (503), pasa al
// siguiente en vez de perder el comprobante. Un error que no es de
// disponibilidad (ej. imagen ilegible) corta: cambiar de modelo no ayudaria.
async function extraerConModelo(descripcion, partes) {
  let ultimo;
  for (const modelo of MODELOS) {
    try {
      return await extraerConUnModelo(descripcion, modelo, partes);
    } catch (err) {
      ultimo = err;
      if (modeloCaido(err)) {
        console.log(`${descripcion}: ${modelo} no disponible (${err.status}), pruebo otro modelo`);
        continue;
      }
      throw err;
    }
  }
  throw ultimo;
}

async function extractWithVision(imageBuffer, mimeType) {
  return extraerConModelo('vision', [
    { text: EXTRACTION_PROMPT },
    { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
  ]);
}

async function extractWithText(text) {
  return extraerConModelo('texto', [
    { text: `${EXTRACTION_PROMPT}\n\nTexto del comprobante:\n${text}` },
  ]);
}

const PROMPT_BANCO = 'Este es un comprobante de pago bancario argentino. '
  + 'Respondé SOLO un JSON {"banco": "NOMBRE"} con el banco o billetera de quien '
  + 'PAGA, que suele estar como logo o marca arriba (ej. Galicia, Santander, '
  + 'Nación, Supervielle, Mercado Pago, BBVA, Macro). Si no se distingue, '
  + 'devolvé {"banco": null}.';

// Algunos PDF muestran el banco solo como logo (imagen). El parser lee texto,
// asi que no lo ve. Se renderiza el PDF y se le pide a la IA SOLO el banco. No
// se usa extraerJSON porque ese exige campos de comprobante (monto, fecha...) y
// esta respuesta trae solo {"banco": ...}; se lee el banco directo del texto.
async function bancoDesdeLogo(pdfBuffer) {
  let render;
  try {
    render = await renderizarPrimeraPagina(pdfBuffer);
  } catch (err) {
    console.error('No pude renderizar el PDF para leer el banco:', err.message);
    return null;
  }

  const partes = [
    { text: PROMPT_BANCO },
    { inlineData: { mimeType: render.mime, data: render.buffer.toString('base64') } },
  ];

  let ultimo;
  for (const modelo of MODELOS) {
    try {
      const respuesta = await gemini().models.generateContent({
        model: modelo, contents: partes, config: SIN_PENSAR,
      });
      const m = /"banco"\s*:\s*"([^"]+)"/i.exec(respuesta.text || '');
      return m ? m[1].trim() : null;
    } catch (err) {
      ultimo = err;
      if (modeloCaido(err)) {
        console.log(`banco: ${modelo} no disponible, pruebo otro modelo`);
        continue;
      }
      console.error('No pude leer el banco del logo:', err.message);
      return null;
    }
  }
  console.error('No pude leer el banco del logo:', ultimo?.message);
  return null;
}

async function pedirGemini(modelo, partes, config) {
  const respuesta = await gemini().models.generateContent({
    model: modelo,
    contents: partes,
    config,
  });

  const datos = extraerJSON(respuesta.text || '');
  if (!datos) throw new Error('No se obtuvo JSON válido');
  return datos;
}

async function extractData(imageBuffer, mimeType) {
  if (mimeType === 'application/pdf' || mimeType.includes('pdf')) {
    const pdf = await pdfParse(imageBuffer).catch(() => ({ text: '' }));
    const text = (pdf.text || '').trim();

    if (text && text.length > 20) {
      // El parser no gasta cuota de la API, es instantaneo y siempre devuelve
      // lo mismo para el mismo comprobante. Solo se cae al modelo si no logra
      // sacar los datos con confianza.
      const parseado = parsearComprobante(text);
      if (parseado) {
        // El banco suele estar como logo (imagen), que el parser no lee. Si
        // falta, se le pide a la IA solo ese dato, renderizando el PDF.
        if (!parseado.banco_origen) {
          const banco = await bancoDesdeLogo(imageBuffer);
          if (banco) parseado.banco_origen = banco;
        }
        console.log(`PDF con texto, extraído sin IA (monto ${parseado.monto}, `
          + `${parseado.fecha}, banco ${parseado.banco_origen || '—'})`);
        return parseado;
      }

      console.log('PDF con texto, el parser no alcanzó: usando el modelo...');
      return await extractWithText(text);
    }

    // El PDF es una imagen. Renderizamos la pagina y la mandamos a vision:
    // es lo unico que funciona cuando la imagen viene comprimida adentro.
    console.log('PDF sin texto, renderizando la página...');

    // El catch cubre solo el renderizado: si tambien envolviera la llamada al
    // modelo, un fallo de la IA se reportaria como "no se pudo renderizar" y
    // manda a buscar el problema al lugar equivocado.
    let render = null;
    try {
      render = await renderizarPrimeraPagina(imageBuffer);
    } catch (err) {
      console.error('No se pudo renderizar el PDF:', err.message);
    }

    if (render) {
      if (render.paginas > 1) {
        console.log(`El PDF tiene ${render.paginas} páginas, se usa la primera`);
      }
      return await extractWithVision(render.buffer, render.mime);
    }

    // Ultimo recurso para los PDFs que si traen un JPEG o PNG sin comprimir.
    console.log('Renderizado fallido, buscando imagen embebida...');
    const image = extractImageFromPdf(imageBuffer);
    if (image) {
      console.log(`Imagen ${image.mime} encontrada en PDF, usando visión...`);
      return await extractWithVision(image.buffer, image.mime);
    }

    throw new Error('No se pudo extraer contenido del PDF. Pedí que envíen una foto en vez de PDF.');
  }

  return await extractWithVision(imageBuffer, mimeType);
}

module.exports = {
  extractData,
  esperaTrasRateLimit,
  esReintentable,
  modeloCaido,
  conReintentos,
  EXTRACTION_PROMPT,
};
