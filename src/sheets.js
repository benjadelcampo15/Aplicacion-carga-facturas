const { google } = require('googleapis');

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function appendRow(data, senderInfo) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const row = [
    new Date().toISOString(),
    data.fecha || '',
    data.tipo_operacion || '',
    data.nombre_origen || '',
    data.monto || '',
    data.cbu_origen || '',
    data.banco_origen || '',
    data.referencia || '',
    data.concepto || '',
    senderInfo?.name || '',
    senderInfo?.number || '',
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Hoja 1!A:K',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row],
    },
  });

  console.log('Fila agregada al Sheet:', row);
}

module.exports = { appendRow };
