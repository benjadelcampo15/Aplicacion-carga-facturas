require('dotenv').config();
const { google } = require('googleapis');
const { normalizarPrivateKey } = require('../src/sheets');

(async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: normalizarPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID });
  console.log('Planilla:', meta.data.properties.title);
  console.log('ID:', process.env.GOOGLE_SHEETS_ID);
  console.log('\nPestañas que hay AHORA:');
  for (const s of meta.data.sheets) console.log('  -', s.properties.title);
})().catch((e) => console.error('ERROR:', e.message));
