const fs = require('fs/promises');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const RECONEXION_BASE_MS = 1000;
const RECONEXION_MAX_MS = 60000;

// Baileys espera un logger tipo pino. Se le pasa uno que no escribe nada, para
// que en los logs del deploy queden solo los mensajes del bot.
const LOGGER_SILENCIOSO = {
  level: 'silent',
  child: () => LOGGER_SILENCIOSO,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

// En Railway el filesystem es efimero: DATA_DIR apunta al volumen montado, y
// adentro viven tanto la sesion de WhatsApp como los comprobantes fallados.
// AUTH_DIR sigue existiendo aparte para no romper instalaciones que ya lo usan.
const DATA_DIR = process.env.DATA_DIR || './data';
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_info');

async function startWhatsApp({ onComprobante, onTexto, appState }) {
  let intentos = 0;
  let reconexionPendiente = false;
  let timerReconexion = null;
  let sockActual = null;
  let reinicioEnCurso = false;

  function programarReconexion() {
    // 'close' puede dispararse mas de una vez por el mismo corte.
    if (reconexionPendiente) return;
    reconexionPendiente = true;

    const espera = Math.min(RECONEXION_BASE_MS * 2 ** intentos, RECONEXION_MAX_MS)
      + Math.floor(Math.random() * 1000);
    intentos++;

    console.log(`Conexion cerrada. Reintento ${intentos} en ${Math.round(espera / 1000)}s...`);

    timerReconexion = setTimeout(async () => {
      reconexionPendiente = false;
      try {
        await conectar();
      } catch (err) {
        console.error('Error reconectando:', err.message);
        programarReconexion();
      }
    }, espera);
  }

  // Equivale a apagar y volver a prender el proyecto, sin matar el proceso.
  // Con borrarSesion se descarta el pareo y WhatsApp manda un QR nuevo.
  async function reiniciar({ borrarSesion = false } = {}) {
    console.log(borrarSesion ? 'Reinicio manual: borrando sesion' : 'Reinicio manual');

    reinicioEnCurso = true;
    clearTimeout(timerReconexion);
    reconexionPendiente = false;
    intentos = 0;

    appState.connected = false;
    appState.qr = null;

    if (sockActual) {
      try {
        await sockActual.end(new Error('reinicio manual'));
      } catch (err) {
        console.error('Error cerrando el socket:', err.message);
      }
      sockActual = null;
    }

    // Recien despues de cerrar: si el socket sigue vivo puede reescribir las
    // credenciales apenas las borramos.
    if (borrarSesion) {
      await fs.rm(AUTH_DIR, { recursive: true, force: true });
    }

    reinicioEnCurso = false;
    await conectar();
  }

  async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      // Sin esto Baileys escribe cada evento interno, incluido el volcado del
      // historial de WhatsApp en payloads de cientos de KB. Los logs quedan
      // ilegibles y no se ve si el bot conecto o que fallo.
      logger: LOGGER_SILENCIOSO,
      // El bot solo necesita los mensajes que llegan de ahora en mas. Pedir el
      // historial completo tarda minutos y deja la conexion colgada en
      // "conectando" mientras se descarga.
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    sockActual = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('QR generado, abrí la web para escanearlo');
        appState.qr = await QRCode.toDataURL(qr);
        appState.connected = false;
      }

      if (connection === 'connecting') {
        console.log('WhatsApp: conectando...');
      }

      if (connection === 'close') {
        appState.connected = false;
        appState.qr = null;

        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log(`WhatsApp: conexión cerrada (motivo ${reason ?? 'desconocido'})`);

        // Un reinicio manual se encarga el mismo de reconectar.
        if (reinicioEnCurso) return;

        // Baileys destruye sus propios listeners al cerrar (end -> ev.destroy),
        // asi que el socket viejo no sigue escuchando: solo hay que reconectar.
        if (reason === DisconnectReason.loggedOut) {
          console.log('Sesion cerrada. Usá "Desvincular" en la web para escanear de nuevo.');
          appState.lastError = 'Sesión cerrada desde el teléfono. Desvinculá y escaneá de nuevo.';
          return;
        }
        programarReconexion();
      }

      if (connection === 'open') {
        console.log('Conectado a WhatsApp');
        appState.connected = true;
        appState.qr = null;
        intentos = 0;
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const from = msg.key.remoteJid;

        if (from.endsWith('@g.us')) continue;

        const senderName = msg.pushName || 'Desconocido';
        let senderNumber = from.replace('@s.whatsapp.net', '').replace('@lid', '');

        if (from.endsWith('@lid') && msg.key.participant) {
          senderNumber = msg.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
        }

        const senderInfo = { name: senderName, number: senderNumber };

        const imageMessage = msg.message?.imageMessage;
        const documentMessage = msg.message?.documentMessage;
        const texto = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '';

        if (imageMessage) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const mimeType = imageMessage.mimetype || 'image/jpeg';
            console.log(`Imagen recibida de ${senderName} (${senderNumber})`);
            // El epigrafe de la foto puede traer el numero de cliente.
            await onComprobante(sock, from, buffer, mimeType, senderInfo, imageMessage.caption || '');
          } catch (err) {
            console.error('Error descargando imagen:', err.message);
          }
        } else if (documentMessage) {
          const mimeType = documentMessage.mimetype || '';
          if (mimeType === 'application/pdf' || mimeType.includes('pdf')) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              console.log(`PDF recibido de ${senderName} (${senderNumber})`);
              await onComprobante(sock, from, buffer, mimeType, senderInfo, documentMessage.caption || '');
            } catch (err) {
              console.error('Error descargando PDF:', err.message);
            }
          }
        } else if (texto.trim()) {
          // Un mensaje de texto puede ser el numero de cliente de un comprobante.
          await onTexto(sock, from, texto, senderInfo);
        }
      }
    });

    return sock;
  }

  await conectar();
  return { reiniciar };
}

module.exports = { startWhatsApp };
