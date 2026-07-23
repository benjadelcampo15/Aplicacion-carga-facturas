// Saca el JSON de la respuesta del modelo.
//
// qwen3.6 es un modelo de razonamiento: antes de contestar emite un bloque
// <think> donde piensa en voz alta, y ahi adentro suele escribir un borrador
// del JSON. Buscar con /\{[\s\S]*\}/ agarra desde la llave del borrador hasta
// la del JSON final, y el resultado no parsea. Esa era la causa de los
// "No se obtuvo JSON válido".

const CAMPOS_ESPERADOS = [
  'monto', 'fecha', 'tipo_operacion', 'nombre_origen',
  'cbu_origen', 'banco_origen', 'referencia', 'concepto', 'error',
];

function sinRazonamiento(texto) {
  return String(texto || '')
    // El cierre puede faltar si la respuesta se corto por max_tokens.
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<think>[\s\S]*$/i, ' ')
    .replace(/<\/think>/gi, ' ');
}

function sinCercas(texto) {
  return texto.replace(/```(?:json)?/gi, ' ');
}

// Recorre el texto y devuelve cada objeto con llaves balanceadas. Cuenta llaves
// respetando strings y escapes: una llave dentro de un valor no tiene que
// cerrar el objeto.
function objetosBalanceados(texto) {
  const encontrados = [];

  for (let i = 0; i < texto.length; i++) {
    if (texto[i] !== '{') continue;

    let profundidad = 0;
    let enString = false;
    let escapado = false;

    for (let j = i; j < texto.length; j++) {
      const c = texto[j];

      if (escapado) { escapado = false; continue; }
      if (c === '\\') { escapado = true; continue; }
      if (c === '"') { enString = !enString; continue; }
      if (enString) continue;

      if (c === '{') profundidad++;
      else if (c === '}') {
        profundidad--;
        if (profundidad === 0) {
          encontrados.push(texto.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }

  return encontrados;
}

function pareceComprobante(objeto) {
  if (!objeto || typeof objeto !== 'object' || Array.isArray(objeto)) return false;
  return CAMPOS_ESPERADOS.some((campo) => campo in objeto);
}

// Devuelve el objeto del comprobante, o null si no hay ninguno utilizable.
function extraerJSON(respuesta) {
  const limpio = sinCercas(sinRazonamiento(respuesta));

  // Lo mas comun: la respuesta entera es el JSON.
  try {
    const directo = JSON.parse(limpio.trim());
    if (pareceComprobante(directo)) return directo;
  } catch { /* sigue abajo */ }

  const candidatos = objetosBalanceados(limpio);

  // De atras para adelante: si quedo algun borrador, la conclusion es la ultima.
  for (let i = candidatos.length - 1; i >= 0; i--) {
    try {
      const objeto = JSON.parse(candidatos[i]);
      if (pareceComprobante(objeto)) return objeto;
    } catch { /* prueba el siguiente */ }
  }

  return null;
}

module.exports = { extraerJSON, objetosBalanceados, sinRazonamiento };
