const { google } = require('googleapis');
const { normalizarPrivateKey } = require('../src/sheets');
const ID = '1OrSiMU55VHT4YhONUOJwsMOID3TLCI9XzRUZ_Xu6rck';
(async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: normalizarPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ID,
    ranges: ['JULIO 2026!A1:J2', 'JULIO 2026!A:A', 'Santander!A1:F2', 'Nación!A1:F2', 'Supervielle!A1:F2'],
  });
  const v = res.data.valueRanges;
  console.log('JULIO encabezados:', JSON.stringify(v[0].values?.[0] || []));
  console.log('JULIO fila 2     :', JSON.stringify(v[0].values?.[1] || []));
  console.log('JULIO filas en A :', v[1].values?.length || 0, '-> bot escribe en', (v[1].values?.length || 0) + 1);
  console.log('Santander f1     :', JSON.stringify(v[2].values?.[0] || []));
  console.log('Santander f2     :', JSON.stringify(v[2].values?.[1] || []));
  console.log('Nacion f1        :', JSON.stringify(v[3].values?.[0] || []));
  console.log('Supervielle f1   :', JSON.stringify(v[4].values?.[0] || []));
})().catch((e) => console.error('ERROR:', e.message));
