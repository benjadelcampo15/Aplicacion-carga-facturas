const Groq = require('groq-sdk');
const pdfParse = require('pdf-parse');
const { renderizarPrimeraPagina } = require('./pdf');
const { parsearComprobante } = require('./parser');

// Perezoso: creado al importar, el modulo revienta si falta la key antes de que
// index.js llegue a avisar cual falta.
let cliente = null;
function groq() {
  if (!cliente) cliente = new Groq({ apiKey: process.env.GROQ_API_KEY });
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

const INTENTOS = 4;
const ESPERA_POR_DEFECTO_MS = 20000;
const ESPERA_MAXIMA_MS = 90000;

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Groq dice exactamente cuanto falta para que se libere la cuota, tanto en la
// cabecera retry-after como en el texto del error. Respetarlo es mejor que
// inventar un backoff.
function esperaTrasRateLimit(err) {
  if (err?.status !== 429) return null;

  const cabecera = Number(err.headers?.['retry-after']);
  if (Number.isFinite(cabecera) && cabecera > 0) {
    return Math.min(cabecera * 1000 + 1000, ESPERA_MAXIMA_MS);
  }

  const enElTexto = /try again in ([\d.]+)s/i.exec(err.message || '');
  if (enElTexto) {
    return Math.min(Number(enElTexto[1]) * 1000 + 1000, ESPERA_MAXIMA_MS);
  }

  return ESPERA_POR_DEFECTO_MS;
}

// El modelo a veces devuelve texto en vez de JSON. Reintentar suele alcanzar,
// y es preferible a descartarle el comprobante a alguien.
function esReintentable(err) {
  return err?.status === 429
    || err?.status >= 500
    || /No se obtuvo JSON válido/.test(err?.message || '');
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

async function extractWithVision(imageBuffer, mimeType) {
  return conReintentos('vision', () => pedirVision(imageBuffer, mimeType));
}

async function pedirVision(imageBuffer, mimeType) {
  const base64Image = imageBuffer.toString('base64');

  const result = await groq().chat.completions.create({
    model: 'qwen/qwen3.6-27b',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: EXTRACTION_PROMPT },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 1024,
  });

  const responseText = result.choices[0]?.message?.content || '';
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No se obtuvo JSON válido');
  return JSON.parse(jsonMatch[0]);
}

async function extractWithText(text) {
  return conReintentos('texto', () => pedirTexto(text));
}

async function pedirTexto(text) {
  const result = await groq().chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'user',
        content: EXTRACTION_PROMPT + '\n\nTexto del comprobante:\n' + text,
      },
    ],
    temperature: 0,
    max_tokens: 1024,
  });

  const responseText = result.choices[0]?.message?.content || '';
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No se obtuvo JSON válido');
  return JSON.parse(jsonMatch[0]);
}

async function extractData(imageBuffer, mimeType) {
  if (mimeType === 'application/pdf' || mimeType.includes('pdf')) {
    const pdf = await pdfParse(imageBuffer).catch(() => ({ text: '' }));
    const text = (pdf.text || '').trim();

    if (text && text.length > 20) {
      // El parser no gasta cuota de Groq, es instantaneo y siempre devuelve lo
      // mismo para el mismo comprobante. Solo se cae al modelo si no logra
      // sacar los datos con confianza.
      const parseado = parsearComprobante(text);
      if (parseado) {
        console.log(`PDF con texto, extraído sin IA (monto ${parseado.monto}, ${parseado.fecha})`);
        return parseado;
      }

      console.log('PDF con texto, el parser no alcanzó: usando el modelo...');
      return await extractWithText(text);
    }

    // El PDF es una imagen. Renderizamos la pagina y la mandamos a vision:
    // es lo unico que funciona cuando la imagen viene comprimida adentro.
    console.log('PDF sin texto, renderizando la página...');
    try {
      const render = await renderizarPrimeraPagina(imageBuffer);
      if (render.paginas > 1) {
        console.log(`El PDF tiene ${render.paginas} páginas, se usa la primera`);
      }
      return await extractWithVision(render.buffer, render.mime);
    } catch (err) {
      console.error('No se pudo renderizar el PDF:', err.message);
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

module.exports = { extractData, esperaTrasRateLimit, esReintentable, conReintentos };
