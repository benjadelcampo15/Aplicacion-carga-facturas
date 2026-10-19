const { google } = require('googleapis');
const { normalizarPrivateKey } = require('../src/sheets');
async function conReintento(fn, n = 4) {
  for (let i = 1; i <= n; i++) {
    try { return await fn(); }
    catch (e) { if (i === n) throw e; await new Promise(r => setTimeout(r, 2000 * i)); }
  }
}
(async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: normalizarPrivateKey(process.env.GOOGLE_PRIVATE_KEY) },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const ID = process.env.GOOGLE_SHEETS_ID;
  const comp = await conReintento(() => sheets.spreadsheets.values.get({ spreadsheetId: ID, range: 'COMPROBANTES!A:A' }));
  const filasComp = Math.max(0, (comp.data.values || []).length - 1);
  let filasErr = 0;
  try {
    const err = await conReintento(() => sheets.spreadsheets.values.get({ spreadsheetId: ID, range: 'Errores!A:A' }));
    filasErr = Math.max(0, (err.data.values || []).length - 1);
  } catch (e) {}
  console.log('Cargados en COMPROBANTES:', filasComp);
  console.log('Fallaron (hoja Errores):', filasErr);
})().catch(e => console.error('ERROR:', e.message));
