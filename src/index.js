require('dotenv').config();

const { startWhatsApp } = require('./whatsapp');
const { extractData } = require('./extractor');
const { appendRow, buildClave, buscarDuplicado, validarCredenciales } = require('./sheets');
const { invalidarCache } = require('./stats');
const { crearApp } = require('./web');
const { crearCola } = require('./cola');

const PORT = process.env.PORT || 3000;

const appState = {
  qr: null,
  connected: false,
  processed: 0,
  duplicados: 0,
  enCola: 0,
  lastError: null,
};

const cola = crearCola();

// Un cliente puede mandar diez comprobantes de golpe. Se encolan y se procesan
// de a uno; si se atienden en paralelo se agota la cuota de Groq y se pierden.
async function handleComprobante(sock, from, imageBuffer, mimeType, senderInfo) {
  const { posicion, promesa } = cola.encolar(
    () => procesarComprobante(sock, from, imageBuffer, mimeType, senderInfo),
  );
  appState.enCola = cola.largo;

  await sock.sendMessage(from, {
    text: posicion === 0
      ? 'Procesando comprobante...'
      : `Recibido. Hay ${posicion} comprobante${posicion > 1 ? 's' : ''} antes que este, `
        + 'ya te aviso cuando lo cargue.',
  });

  try {
    await promesa;
  } finally {
    appState.enCola = cola.largo;
  }
}

async function procesarComprobante(sock, from, imageBuffer, mimeType, senderInfo) {
  try {
    const data = await extractData(imageBuffer, mimeType);

    if (data.error) {
      await sock.sendMessage(from, { text: `No pude procesar: ${data.error}` });
      return;
    }

    if (await buscarDuplicado(buildClave(data))) {
      appState.duplicados++;
      await sock.sendMessage(from, {
        text: `Este comprobante ya estaba cargado (${data.nombre_origen} - $${data.monto}). No lo dupliqué.`,
      });
      console.log(`Duplicado ignorado de ${from}`);
      return;
    }

    await appendRow(data, senderInfo);
    appState.processed++;
    invalidarCache();

    const summary = [
      'Comprobante registrado:',
      `  Monto: $${data.monto}`,
      `  Fecha: ${data.fecha}`,
      `  Origen: ${data.nombre_origen}`,
      data.referencia ? `  Ref: ${data.referencia}` : null,
      data.banco_origen ? `  Banco: ${data.banco_origen}` : null,
    ].filter(Boolean).join('\n');

    await sock.sendMessage(from, { text: summary });
    console.log(`Comprobante procesado de ${from}`);

  } catch (err) {
    console.error('Error procesando comprobante:', err.message);
    appState.lastError = err.message;
    await sock.sendMessage(from, { text: mensajeDeError(err) });
  }
}

// Cada error necesita una accion distinta de quien mando el comprobante: si le
// decimos "intentá de nuevo" a un rate limit, reintenta al toque y empeora.
function mensajeDeError(err) {
  if (err.message.includes('No se pudo extraer')) {
    return 'No pude leer este PDF. Mandame una foto o captura de pantalla del comprobante.';
  }
  if (err.status === 429) {
    return 'Estamos al límite de procesamiento en este momento. '
      + 'Reenviame este comprobante en un par de minutos.';
  }
  if (err.message.includes('No se obtuvo JSON')) {
    return 'No pude leer los datos de esta imagen. Probá con una foto más nítida '
      + 'o una captura de pantalla.';
  }
  return 'Hubo un error procesando el comprobante. Intentá de nuevo.';
}

async function main() {
  console.log('Iniciando servicio de conciliación...');

  if (!process.env.GROQ_API_KEY) {
    console.error('Falta GROQ_API_KEY');
    process.exit(1);
  }

  // No cortamos el proceso: si las credenciales estan mal, la web es el unico
  // lugar donde se puede ver por que. Cortar solo deja a Railway reiniciando.
  try {
    validarCredenciales();
  } catch (err) {
    console.error('Credenciales de Google mal configuradas:', err.message);
    appState.lastError = err.message;
  }

  // La web tiene que estar arriba antes de conectar: es donde se ve el QR.
  const control = {
    reiniciar: async () => { throw new Error('el servicio todavía está arrancando'); },
  };

  crearApp(appState, control).listen(PORT, () => {
    console.log(`Web corriendo en puerto ${PORT}`);
  });

  Object.assign(control, await startWhatsApp(handleComprobante, appState));
}

main();
