require('dotenv').config();

const express = require('express');
const { startWhatsApp } = require('./whatsapp');
const { extractData } = require('./gemini');
const { appendRow } = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;

let appState = { qr: null, connected: false, processed: 0, lastError: null };

app.get('/', (req, res) => {
  if (appState.connected) {
    res.send(`
      <html><head><title>Conciliacion Bot</title>
      <meta http-equiv="refresh" content="10">
      <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;text-align:center;background:#111;color:#fff;}
      .status{background:#22c55e;color:#000;padding:12px 24px;border-radius:8px;font-size:18px;display:inline-block;margin:20px 0;}
      .stats{background:#222;padding:20px;border-radius:8px;margin:20px 0;text-align:left;}
      .stats p{margin:8px 0;font-size:16px;}</style></head>
      <body>
        <h1>Conciliacion Bot</h1>
        <div class="status">Conectado a WhatsApp</div>
        <div class="stats">
          <p>Comprobantes procesados: <strong>${appState.processed}</strong></p>
          <p>${appState.lastError ? 'Ultimo error: ' + appState.lastError : 'Sin errores'}</p>
        </div>
        <p style="color:#888">Esta pagina se actualiza automaticamente</p>
      </body></html>
    `);
  } else if (appState.qr) {
    res.send(`
      <html><head><title>Conciliacion Bot - Escanear QR</title>
      <meta http-equiv="refresh" content="5">
      <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;text-align:center;background:#111;color:#fff;}
      img{background:#fff;padding:20px;border-radius:12px;}</style></head>
      <body>
        <h1>Conciliacion Bot</h1>
        <p>Escaneá este QR con WhatsApp</p>
        <p style="color:#888">WhatsApp > Dispositivos vinculados > Vincular dispositivo</p>
        <img src="${appState.qr}" />
      </body></html>
    `);
  } else {
    res.send(`
      <html><head><title>Conciliacion Bot</title>
      <meta http-equiv="refresh" content="3">
      <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;text-align:center;background:#111;color:#fff;}</style></head>
      <body>
        <h1>Conciliacion Bot</h1>
        <p>Conectando...</p>
      </body></html>
    `);
  }
});

async function handleComprobante(sock, from, imageBuffer, mimeType, senderInfo) {
  try {
    await sock.sendMessage(from, { text: 'Procesando comprobante...' });

    const data = await extractData(imageBuffer, mimeType);

    if (data.error) {
      await sock.sendMessage(from, { text: `No pude procesar: ${data.error}` });
      return;
    }

    await appendRow(data, senderInfo);
    appState.processed++;

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
    console.error('Falta GROQ_API_KEY en .env');
    process.exit(1);
  }
  if (!process.env.GOOGLE_SHEETS_ID) {
    console.error('Falta GOOGLE_SHEETS_ID en .env');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Web corriendo en puerto ${PORT}`);
  });

  await startWhatsApp(handleComprobante, appState);
}

main();
