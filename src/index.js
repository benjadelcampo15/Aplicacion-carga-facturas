require('dotenv').config();

const { startWhatsApp } = require('./whatsapp');
const { extractData } = require('./extractor');
const { appendRow, buildClave, buscarDuplicado, validarCredenciales } = require('./sheets');
const { invalidarCache } = require('./stats');
const { crearApp } = require('./web');

const PORT = process.env.PORT || 3000;

const appState = {
  qr: null,
  connected: false,
  processed: 0,
  duplicados: 0,
  lastError: null,
};

async function handleComprobante(sock, from, imageBuffer, mimeType, senderInfo) {
  try {
    await sock.sendMessage(from, { text: 'Procesando comprobante...' });

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
    console.error('Error procesando comprobante:', err);
    appState.lastError = err.message;
    const errorMsg = err.message.includes('No se pudo extraer')
      ? 'No pude leer este PDF. Por favor enviá una foto o captura de pantalla del comprobante en vez de PDF.'
      : 'Hubo un error procesando el comprobante. Intentá de nuevo.';
    await sock.sendMessage(from, { text: errorMsg });
  }
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
