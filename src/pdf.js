// Muchos comprobantes llegan como PDF que por dentro es una sola imagen, sin
// una letra de texto. Buscar un JPEG o PNG en los bytes crudos no alcanza:
// adentro del PDF la imagen suele estar comprimida con FlateDecode y no tiene
// los marcadores que uno buscaria. La unica forma confiable es renderizar la
// pagina y mandar esa imagen a vision, igual que si fuera una foto.

// Lado mas largo de la imagen que le mandamos al modelo. Los comprobantes se
// leen comodos a este tamaño, y agrandarlo solo gasta cuota de tokens.
const LADO_MAXIMO = 1600;

let pdfjsCargado = null;

// pdfjs 6 es ESM y el proyecto es CommonJS, asi que va por import dinamico. Se
// cachea porque cargarlo tarda bastante y se usa en cada PDF.
async function cargarPdfjs() {
  if (!pdfjsCargado) {
    pdfjsCargado = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsCargado;
}

async function renderizarPrimeraPagina(pdfBuffer) {
  const pdfjs = await cargarPdfjs();
  const { createCanvas } = require('@napi-rs/canvas');

  const tarea = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    // Sin esto pdfjs evalua contenido del PDF, que viene de terceros.
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const documento = await tarea.promise;

  try {
    const pagina = await documento.getPage(1);

    const medida = pagina.getViewport({ scale: 1 });
    const escala = LADO_MAXIMO / Math.max(medida.width, medida.height);
    const viewport = pagina.getViewport({ scale: Math.min(escala, 4) });

    const canvas = createCanvas(viewport.width, viewport.height);
    const contexto = canvas.getContext('2d');

    // El PDF puede no traer fondo propio y el canvas arranca transparente, que
    // al pasar a PNG queda negro sobre negro.
    contexto.fillStyle = '#ffffff';
    contexto.fillRect(0, 0, viewport.width, viewport.height);

    await pagina.render({ canvasContext: contexto, viewport, canvas }).promise;

    return {
      buffer: canvas.toBuffer('image/png'),
      mime: 'image/png',
      paginas: documento.numPages,
    };
  } finally {
    // Sin esto quedan colgados los workers internos de pdfjs.
    await tarea.destroy().catch(() => {});
  }
}

module.exports = { renderizarPrimeraPagina, LADO_MAXIMO };
