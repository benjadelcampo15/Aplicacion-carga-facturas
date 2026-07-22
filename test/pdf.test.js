const fs = require('fs');
const path = require('path');
const { renderizarPrimeraPagina, LADO_MAXIMO } = require('../src/pdf');

const checks = [];
function check(nombre, ok) {
  checks.push([nombre, ok]);
}

// PDF de una sola pagina, sin texto y con la imagen comprimida: el caso que
// hoy falla. Se arma con pdfjs para no depender de un archivo con datos reales.
function pdfSinTexto() {
  // PDF minimo valido con un rectangulo dibujado, sin fuentes ni texto.
  const contenido = '1 0 0 RG 4 w 50 50 500 700 re S';
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R >>',
    `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const posiciones = [];
  objetos.forEach((cuerpo, i) => {
    posiciones.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${cuerpo}\nendobj\n`;
  });

  const inicioXref = pdf.length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  posiciones.forEach((pos) => {
    pdf += `${String(pos).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${inicioXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

async function main() {
  const render = await renderizarPrimeraPagina(pdfSinTexto());

  check('devuelve un PNG', render.mime === 'image/png');
  check('el buffer es un PNG de verdad',
    render.buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])));
  check('informa la cantidad de paginas', render.paginas === 1);
  check('el PNG tiene contenido', render.buffer.length > 1000);

  // El lado mas largo se ajusta al maximo: si no, un PDF grande se come la
  // cuota de tokens y vuelve a chocar contra el rate limit.
  const ancho = render.buffer.readUInt32BE(16);
  const alto = render.buffer.readUInt32BE(20);
  check('respeta el lado maximo', Math.max(ancho, alto) === LADO_MAXIMO);
  check('mantiene la proporcion de la pagina',
    Math.abs((ancho / alto) - (600 / 800)) < 0.01);

  // Renderizar dos veces seguidas: si pdfjs quedara a medio cerrar, la segunda
  // se cuelga o falla.
  const segundo = await renderizarPrimeraPagina(pdfSinTexto());
  check('se puede renderizar varias veces seguidas', segundo.buffer.length > 1000);

  // Un archivo que no es PDF tiene que fallar limpio, no colgar el proceso.
  const roto = await renderizarPrimeraPagina(Buffer.from('esto no es un pdf'))
    .then(() => null, (err) => err);
  check('un archivo invalido tira error en vez de colgarse', roto instanceof Error);

  // Si hay un PDF real a mano, lo probamos tambien. No se versiona.
  const real = path.join(__dirname, 'fixtures', 'comprobante.pdf');
  if (fs.existsSync(real)) {
    const salida = await renderizarPrimeraPagina(fs.readFileSync(real));
    check('renderiza un comprobante real', salida.buffer.length > 5000);
  }

  let fallos = 0;
  for (const [nombre, ok] of checks) {
    if (!ok) fallos++;
    console.log(`${ok ? 'PASS' : 'FALLA'}  ${nombre}`);
  }
  console.log(`\n${checks.length - fallos}/${checks.length} pasaron`);
  process.exit(fallos ? 1 : 0);
}

main().catch((err) => {
  console.error('El test se cayo:', err);
  process.exit(1);
});
