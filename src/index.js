require('dotenv').config();

const { startWhatsApp } = require('./whatsapp');
const { extractData } = require('./extractor');
const { appendRow, actualizarNumeroCliente, validarCredenciales } = require('./sheets');
const { crearApp } = require('./web');
const { crearCola } = require('./cola');
const { guardarFallido } = require('./errores');
const { crearVinculador } = require('./clientes');

const PORT = process.env.PORT || 3000;

const appState = {
  qr: null,
  connected: false,
  processed: 0,
  enCola: 0,
  fallidos: 0,
  ultimos: [],
  lastError: null,
};

const cola = crearCola();
const vinculador = crearVinculador();

// Comprobantes de cada chat que estan en la cola o procesandose. Sirve para no
// contestarle "mandame el comprobante" a alguien que ya lo mando.
const enProceso = new Map();

function sumarEnProceso(chat, delta) {
  const ahora = (enProceso.get(chat) || 0) + delta;
  if (ahora > 0) enProceso.set(chat, ahora);
  else enProceso.delete(chat);
}

// Un cliente puede mandar diez comprobantes de golpe. Se encolan y se procesan
// de a uno; si se atienden en paralelo se agota la cuota del modelo y se pierden.
async function handleComprobante(sock, from, imageBuffer, mimeType, senderInfo, epigrafe) {
  sumarEnProceso(from, 1);
  const { posicion, promesa } = cola.encolar(
    () => procesarComprobante(sock, from, imageBuffer, mimeType, senderInfo, epigrafe),
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
    sumarEnProceso(from, -1);
    appState.enCola = cola.largo;
  }
}

// Si una llamada se cuelga sin devolver ni fallar, la cola queda trabada para
// siempre y no se procesa ni un comprobante mas. Cada paso tiene su limite: al
// vencerse tira error, se guarda el comprobante como fallido y la cola sigue.
const LIMITE_MODELO_MS = 3 * 60 * 1000;
const LIMITE_PLANILLA_MS = 45 * 1000;

function conLimite(promesa, ms, queHacia) {
  let temporizador;
  const vencimiento = new Promise((_, rechazar) => {
    temporizador = setTimeout(
      () => rechazar(new Error(`Se colgó ${queHacia} (más de ${Math.round(ms / 1000)}s)`)),
      ms,
    );
  });
  return Promise.race([promesa, vencimiento]).finally(() => clearTimeout(temporizador));
}

async function procesarComprobante(sock, from, imageBuffer, mimeType, senderInfo, epigrafe) {
  try {
    const data = await conLimite(
      extractData(imageBuffer, mimeType), LIMITE_MODELO_MS, 'leyendo el comprobante',
    );

    if (data.error) {
      await sock.sendMessage(from, { text: `No pude procesar: ${data.error}` });
      return;
    }

    // El numero de cliente puede venir en el epigrafe de la foto o en un mensaje
    // aparte que ya llego. Si todavia no llego, se carga vacio y se recuerda la
    // fila para completarla cuando llegue.
    const numeroCliente = vinculador.numeroParaComprobante(from, epigrafe);

    // Se escribe siempre; los repetidos los marca la columna CONTROL de la
    // planilla, no el bot.
    const ubicacion = await conLimite(
      appendRow(data, senderInfo, numeroCliente || ''),
      LIMITE_PLANILLA_MS, 'escribiendo en la planilla',
    );
    appState.processed++;

    // Para ver en el dashboard que se cargo, sin tener que abrir la planilla.
    appState.ultimos.unshift({
      hora: new Date().toISOString(),
      monto: data.monto,
      fecha: data.fecha,
      banco: data.banco_origen || '',
      chofer: senderInfo?.name || '',
      cliente: numeroCliente || '',
      pestania: ubicacion.pestania,
      fila: ubicacion.fila,
    });
    appState.ultimos = appState.ultimos.slice(0, 10);

    if (!numeroCliente) vinculador.comprobanteSinNumero(from, ubicacion);

    const summary = [
      'Comprobante registrado:',
      `  Monto: $${data.monto}`,
      `  Fecha: ${data.fecha}`,
      `  Origen: ${data.nombre_origen}`,
      numeroCliente ? `  Cliente: ${numeroCliente}` : '  (mandá el N° de cliente)',
      data.referencia ? `  Ref: ${data.referencia}` : null,
    ].filter(Boolean).join('\n');

    await sock.sendMessage(from, { text: summary });
    console.log(`Comprobante procesado de ${from}`);

  } catch (err) {
    console.error('Error procesando comprobante:', err.message);
    appState.lastError = err.message;

    // Se guarda el archivo original: sin esto el comprobante se pierde y hay
    // que ir a pedirselo de nuevo a quien lo mando.
    await guardarFallido({
      buffer: imageBuffer,
      mimeType,
      senderInfo,
      motivo: err.message,
    });
    appState.fallidos++;

    await sock.sendMessage(from, { text: mensajeDeError(err) });
  }
}

// El chofer manda el N° de cliente en un mensaje aparte. Si ya hay un
// comprobante suyo esperando, se le completa la columna; si no, queda anotado
// para el proximo. Todo por chat: el numero de un chofer no toca lo de otro.
async function handleTexto(sock, from, texto, senderInfo) {
  const resultado = vinculador.texto(from, texto);
  if (!resultado) return;

  const { numero, ubicacion, guardado } = resultado;

  if (guardado) {
    // Puede haber un comprobante suyo todavia en la cola: decirle "mandame el
    // comprobante" cuando ya lo mando confunde.
    const esperando = enProceso.get(from) || 0;
    await sock.sendMessage(from, {
      text: esperando
        ? `Anotado el cliente ${numero}, lo pongo en el comprobante que estoy procesando.`
        : `Anotado el cliente ${numero}. Mandame el comprobante.`,
    });
    return;
  }

  try {
    await actualizarNumeroCliente(ubicacion, numero);
    await sock.sendMessage(from, {
      text: `Listo, le puse el cliente ${numero} al último comprobante.`,
    });
  } catch (err) {
    console.error('No pude escribir el N° de cliente:', err.message);
    appState.lastError = err.message;
    await sock.sendMessage(from, {
      text: `No pude cargar el cliente ${numero}. Avisá para completarlo a mano.`,
    });
  }
  console.log(`N° cliente ${numero} de ${senderInfo?.name || from}`);
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
  if (err.message.includes('Falta la pestaña')) {
    return 'Recibí tu comprobante y lo guardé, pero todavía no está creada la '
      + 'hoja de este mes en la planilla. Se va a cargar en cuanto la creen.';
  }
  return 'Hubo un error procesando el comprobante. Intentá de nuevo.';
}

async function main() {
  console.log('Iniciando servicio de conciliación...');

  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.error('Falta GEMINI_API_KEY');
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

  Object.assign(control, await startWhatsApp({
    onComprobante: handleComprobante,
    onTexto: handleTexto,
    appState,
  }));
}

main();
