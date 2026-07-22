require('dotenv').config();
const { google } = require('googleapis');

async function createSheet() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const spreadsheet = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: 'Conciliacion - Comprobantes' },
      sheets: [{
        properties: { title: 'Hoja 1' },
      }],
    },
  });

  const spreadsheetId = spreadsheet.data.spreadsheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Hoja 1!A1:M1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        'Timestamp', 'Fecha', 'Tipo', 'Origen', 'Monto', 'CBU', 'Banco',
        'Referencia', 'Concepto', 'Remitente', 'Telefono', 'Clave', 'Conciliado',
      ]],
    },
  });

  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      type: 'user',
      role: 'writer',
      emailAddress: 'benjadelcampo15@gmail.com',
    },
  });

  console.log('Sheet creado!');
  console.log('ID:', spreadsheetId);
  console.log('URL: https://docs.google.com/spreadsheets/d/' + spreadsheetId);
}

createSheet().catch(console.error);
