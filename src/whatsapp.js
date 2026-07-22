const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

async function startWhatsApp(onReceiveImage, appState) {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('QR generado, abrí la web para escanearlo');
      appState.qr = await QRCode.toDataURL(qr);
      appState.connected = false;
    }

    if (connection === 'close') {
      appState.connected = false;
      appState.qr = null;
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log('Conexion cerrada. Reconectando...');
        startWhatsApp(onReceiveImage, appState);
      } else {
        console.log('Sesion cerrada. Eliminá la carpeta auth_info y escaneá de nuevo.');
      }
    }

    if (connection === 'open') {
      console.log('Conectado a WhatsApp');
      appState.connected = true;
      appState.qr = null;
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

      if (imageMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const mimeType = imageMessage.mimetype || 'image/jpeg';
          console.log(`Imagen recibida de ${senderName} (${senderNumber})`);
          await onReceiveImage(sock, from, buffer, mimeType, senderInfo);
        } catch (err) {
          console.error('Error descargando imagen:', err.message);
        }
      } else if (documentMessage) {
        const mimeType = documentMessage.mimetype || '';
        if (mimeType === 'application/pdf' || mimeType.includes('pdf')) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            console.log(`PDF recibido de ${senderName} (${senderNumber})`);
            await onReceiveImage(sock, from, buffer, mimeType, senderInfo);
          } catch (err) {
            console.error('Error descargando PDF:', err.message);
          }
        }
      }
    }
  });

  return sock;
}

module.exports = { startWhatsApp };
