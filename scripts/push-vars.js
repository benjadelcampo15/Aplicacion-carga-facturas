// Copia las credenciales del .env local a Railway.
//
//   npm run push:vars
//
// Usa la CLI de Railway pasando el valor por stdin desde Node, sin pasar por
// el shell: asi no hay comillas, saltos ni tuberias que deformen la clave,
// que es exactamente como se rompio la primera vez.
require('dotenv').config();

const { spawn } = require('child_process');

const VARIABLES = ['GOOGLE_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GROQ_API_KEY'];

// Valores de relleno del .env.example: si alguno llega a Railway, el servicio
// arranca roto y el error no dice que la variable es de mentira.
const PLACEHOLDERS = [
  'id_del_google_sheet',
  'tu_key_aqui',
  'tu_api_key_de_groq',
  'tu_service_account@proyecto.iam.gserviceaccount.com',
];

function esPlaceholder(valor) {
  return PLACEHOLDERS.some((relleno) => valor.includes(relleno));
}

function setear(nombre, valor) {
  return new Promise((resolve, reject) => {
    const hijo = spawn('railway', ['variable', 'set', nombre, '--stdin', '--skip-deploys'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let error = '';
    hijo.stderr.on('data', (chunk) => { error += chunk; });
    hijo.on('error', reject);
    hijo.on('close', (codigo) => {
      if (codigo === 0) resolve();
      else reject(new Error(error.trim() || `railway salio con codigo ${codigo}`));
    });

    hijo.stdin.write(valor);
    hijo.stdin.end();
  });
}

async function main() {
  console.log('\nCopiando credenciales del .env local a Railway...\n');

  const faltantes = VARIABLES.filter((nombre) => !process.env[nombre]);
  if (faltantes.length) {
    console.error(`Faltan en tu .env local: ${faltantes.join(', ')}\n`);
    process.exit(1);
  }

  const falsas = VARIABLES.filter((nombre) => esPlaceholder(process.env[nombre]));
  if (falsas.length) {
    console.error(`Tu .env local tiene valores de ejemplo en: ${falsas.join(', ')}`);
    console.error('Cargá los valores reales antes de copiarlos a Railway.\n');
    process.exit(1);
  }

  for (const nombre of VARIABLES) {
    const valor = process.env[nombre];
    try {
      await setear(nombre, valor);
      console.log(`  OK    ${nombre} (${valor.length} caracteres)`);
    } catch (err) {
      console.log(`  FALLA ${nombre}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\nListo. Ahora verificá con:\n\n  railway run npm run check:sheets\n');
}

main().catch((err) => {
  console.error('\nSe cayo:', err.message, '\n');
  process.exit(1);
});
