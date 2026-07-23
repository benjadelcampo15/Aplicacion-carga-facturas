// Prueba un comprobante local y muestra que datos se extraerian, sin WhatsApp
// y sin escribir en el Sheet.
//
//   npm run probar -- "C:/ruta/comprobante.pdf"
//   npm run probar -- carpeta-con-comprobantes
//   npm run probar -- comprobante.pdf --texto     muestra el texto del PDF
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { parsearComprobante } = require('../src/parser');

const EXTENSIONES = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function archivosDe(entrada) {
  if (fs.statSync(entrada).isDirectory()) {
    return fs.readdirSync(entrada)
      .filter((n) => EXTENSIONES[path.extname(n).toLowerCase()])
      .map((n) => path.join(entrada, n));
  }
  return [entrada];
}

function mostrar(datos) {
  const campos = ['monto', 'fecha', 'tipo_operacion', 'nombre_origen',
    'cbu_origen', 'banco_origen', 'referencia', 'concepto'];
  for (const campo of campos) {
    const valor = datos[campo];
    const texto = valor === null || valor === undefined || valor === ''
      ? '\x1b[90m(vacío)\x1b[0m'
      : valor;
    console.log(`    ${campo.padEnd(16)} ${texto}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verTexto = args.includes('--texto');
  const entrada = args.find((a) => !a.startsWith('--'));

  if (!entrada) {
    console.log('\nUso:  npm run probar -- "ruta/al/comprobante.pdf"');
    console.log('      npm run probar -- carpeta');
    console.log('      npm run probar -- archivo.pdf --texto\n');
    process.exit(1);
  }

  const archivos = archivosDe(entrada);
  console.log(`\nProbando ${archivos.length} archivo(s)\n`);

  let conParser = 0;
  let conIA = 0;
  let fallados = 0;

  for (const archivo of archivos) {
    const nombre = path.basename(archivo);
    const buffer = fs.readFileSync(archivo);
    const extension = path.extname(archivo).toLowerCase();
    console.log(`\x1b[1m${nombre}\x1b[0m  (${(buffer.length / 1024).toFixed(0)} KB)`);

    if (extension !== '.pdf') {
      console.log('    \x1b[33mimagen -> va al modelo de visión (necesita GROQ_API_KEY)\x1b[0m');
      conIA++;
      console.log('');
      continue;
    }

    const pdfParse = require('pdf-parse');
    const pdf = await pdfParse(buffer).catch(() => ({ text: '' }));
    const texto = (pdf.text || '').trim();

    if (verTexto) {
      console.log('\x1b[90m--- texto extraído ---\x1b[0m');
      console.log(texto || '(sin texto)');
      console.log('\x1b[90m----------------------\x1b[0m');
    }

    if (texto.length <= 20) {
      console.log(`    \x1b[33mPDF sin texto (${texto.length} caracteres) -> se renderiza y va a visión\x1b[0m`);
      conIA++;
      console.log('');
      continue;
    }

    const datos = parsearComprobante(texto);
    if (datos) {
      console.log('    \x1b[32mparseado sin IA\x1b[0m');
      mostrar(datos);
      conParser++;
    } else {
      console.log(`    \x1b[33mel parser no alcanzó (${texto.length} caracteres de texto) -> iría al modelo\x1b[0m`);
      console.log('    \x1b[90mcorré con --texto para ver qué trae el PDF\x1b[0m');
      fallados++;
    }
    console.log('');
  }

  if (archivos.length > 1) {
    console.log('---');
    console.log(`  sin IA        : ${conParser}`);
    console.log(`  necesitan IA  : ${conIA}`);
    console.log(`  parser falló  : ${fallados}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('\nSe cayó:', err.message, '\n');
  process.exit(1);
});
