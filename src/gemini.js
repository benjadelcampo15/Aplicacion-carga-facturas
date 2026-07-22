const Groq = require('groq-sdk');
const pdfParse = require('pdf-parse');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

async function extractWithVision(imageBuffer, mimeType) {
  const base64Image = imageBuffer.toString('base64');

  const result = await groq.chat.completions.create({
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
  const result = await groq.chat.completions.create({
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
    const pdf = await pdfParse(imageBuffer);
    const text = pdf.text.trim();

    if (text && text.length > 20) {
      console.log('PDF con texto, usando extracción de texto...');
      return await extractWithText(text);
    }

    console.log('PDF sin texto, buscando imagen embebida...');
    const image = extractImageFromPdf(imageBuffer);
    if (image) {
      console.log(`Imagen ${image.mime} encontrada en PDF, usando visión...`);
      return await extractWithVision(image.buffer, image.mime);
    }

    throw new Error('No se pudo extraer contenido del PDF. Pedí que envíen una foto en vez de PDF.');
  }

  return await extractWithVision(imageBuffer, mimeType);
}

module.exports = { extractData };
