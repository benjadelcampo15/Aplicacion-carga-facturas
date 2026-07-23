// Extrae los datos de un comprobante bancario argentino leyendo el texto, sin
// pasar por el modelo. Es determinista, gratis, instantaneo y no consume cuota
// de Groq, que es lo que dispara el rate limit cuando entra un lote.
//
// Es conservador a proposito: si no encuentra monto y fecha con confianza,
// devuelve null y el llamador cae al modelo. Estos datos van a una planilla de
// plata, asi que es preferible pasar el trabajo a la IA antes que escribir un
// dato inventado.

const BANCOS = [
  'Santander', 'Galicia', 'BBVA', 'Frances', 'Nacion', 'Provincia', 'Macro',
  'ICBC', 'HSBC', 'Supervielle', 'Patagonia', 'Credicoop', 'Ciudad', 'Comafi',
  'Itau', 'Hipotecario', 'Banco del Sol', 'Bica', 'Columbia', 'Julio',
  'Brubank', 'Uala', 'Mercado Pago', 'Naranja X', 'Personal Pay', 'Lemon',
  'Belo', 'Prex', 'Cuenta DNI', 'Reba', 'Openbank', 'Astropay', 'Fiwind',
];

// Palabras que marcan el lado receptor. Si aparecen junto a un dato, ese dato
// NO es del que paga: confundir origen con destino ensucia la conciliacion.
const DESTINO = /destino|destinatario|beneficiari|acredit|para:|receptor|cr[eé]dito/i;

function sinAcentos(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function limpiar(texto) {
  return String(texto || '').replace(/\s+/g, ' ').trim();
}

// "$ 5.200,00" -> 5200.00 . El formato argentino usa punto de miles y coma
// decimal, al reves que el ingles.
function aNumero(crudo) {
  if (!crudo) return null;

  let texto = String(crudo).replace(/[^\d.,-]/g, '');
  if (!texto) return null;

  const ultimaComa = texto.lastIndexOf(',');
  const ultimoPunto = texto.lastIndexOf('.');

  if (ultimaComa > ultimoPunto) {
    // Coma decimal: 5.200,00
    texto = texto.replace(/\./g, '').replace(',', '.');
  } else if (ultimoPunto > ultimaComa) {
    // Punto decimal solo si deja 1 o 2 decimales; si no son miles: 5.200
    const decimales = texto.length - ultimoPunto - 1;
    texto = decimales <= 2 ? texto.replace(/,/g, '') : texto.replace(/[.,]/g, '');
  } else {
    texto = texto.replace(/[.,]/g, '');
  }

  const numero = Number(texto);
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

function aFechaISO(dia, mes, anio) {
  let a = Number(anio);
  if (a < 100) a += 2000;

  const d = Number(dia);
  const m = Number(mes);
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12 && a >= 2000 && a <= 2100)) return null;

  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function buscarFecha(texto) {
  // dd/mm/yyyy en cualquiera de sus separadores. Argentina siempre dia primero.
  const numerica = /(\b[0-3]?\d)[/\-.]([01]?\d)[/\-.](\d{2,4})\b/.exec(texto);
  if (numerica) {
    const iso = aFechaISO(numerica[1], numerica[2], numerica[3]);
    if (iso) return iso;
  }

  const MESES = {
    ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
    jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
  };
  const textual = /(\b[0-3]?\d)\s+de\s+([a-z]{3})[a-z]*\.?\s+(?:de\s+)?(\d{4})/i
    .exec(sinAcentos(texto));
  if (textual) {
    const mes = MESES[textual[2].toLowerCase()];
    if (mes) return aFechaISO(textual[1], mes, textual[3]);
  }

  return null;
}

// Los comprobantes traen varios numeros (monto, comision, saldo). Se prefiere
// el que esta junto a una etiqueta de importe; el mayor suelto es el ultimo
// recurso.
function buscarMonto(texto) {
  const plano = sinAcentos(texto);

  const etiquetas = [
    /monto\s*(?:debitado|transferido|de la transferencia|enviado|total)?\s*[:\s]*\$?\s*([\d.,]+)/i,
    /importe\s*(?:total|enviado|transferido)?\s*[:\s]*\$?\s*([\d.,]+)/i,
    /dinero\s+enviado\s*[:\s]*\$?\s*([\d.,]+)/i,
    /total\s*(?:transferido|enviado)?\s*[:\s]*\$?\s*([\d.,]+)/i,
    /valor\s*[:\s]*\$?\s*([\d.,]+)/i,
    /(?:transferiste|enviaste|pagaste)\s*\$?\s*([\d.,]+)/i,
  ];

  for (const patron of etiquetas) {
    const match = patron.exec(plano);
    const monto = match && aNumero(match[1]);
    if (monto) return conCentavosSueltos(plano, match, monto);
  }

  // Sin etiqueta: el importe mas grande con formato de pesos.
  const sueltos = [...plano.matchAll(/(?:\$|ARS)\s*([\d.]+,\d{2}|[\d.,]+)/g)]
    .map((m) => {
      const monto = aNumero(m[1]);
      return monto ? conCentavosSueltos(plano, m, monto) : null;
    })
    .filter(Boolean);

  return sueltos.length ? Math.max(...sueltos) : null;
}

// Varios comprobantes muestran los centavos en chico, y al extraer el texto
// caen en la linea de abajo:  "$ 107.467" / "00". Sin esto, "$ 5.200" / "50"
// se leeria como 5200 en vez de 5200,50.
function conCentavosSueltos(texto, match, monto) {
  if (!Number.isInteger(monto)) return monto;

  const finDelMatch = match.index + match[0].length;
  const siguiente = /^\s*\n\s*(\d{2})\s*(?:\n|$)/.exec(texto.slice(finDelMatch));
  if (!siguiente) return monto;

  return Number(`${monto}.${siguiente[1]}`);
}

// Desde el arranque de la linea donde cae una posicion. Acotar el contexto a la
// linea evita que la etiqueta del campo anterior contamine: en un comprobante
// "CUIT destino" viene justo arriba de "Nombre remitente", y mirando N
// caracteres hacia atras el remitente parecia ser del destino.
function lineaDe(texto, posicion) {
  const inicio = texto.lastIndexOf('\n', posicion) + 1;
  const fin = texto.indexOf('\n', posicion);
  return texto.slice(inicio, fin === -1 ? texto.length : fin);
}

// Devuelve lo que sigue a una etiqueta, saltando dos puntos y saltos de linea:
// segun como se extraiga el PDF, el valor cae en la misma linea o en la de
// abajo.
function valorDeEtiqueta(texto, etiquetas, { excluirDestino = true } = {}) {
  for (const etiqueta of etiquetas) {
    const patron = new RegExp(
      `${etiqueta}\\s*:?\\s*\\n?\\s*([^\\n]{2,80})`,
      'i',
    );
    const match = patron.exec(texto);
    if (!match) continue;

    if (excluirDestino && DESTINO.test(lineaDe(texto, match.index))) continue;

    const valor = limpiar(match[1]).replace(/^[:\-–]\s*/, '');
    if (valor) return valor;
  }
  return null;
}

function buscarNombreOrigen(texto) {
  const valor = valorDeEtiqueta(texto, [
    'nombre\\s+(?:del\\s+)?remitente',
    'remitente',
    'ordenante',
    'titular\\s+(?:de\\s+la\\s+)?cuenta\\s+origen',
    'cuenta\\s+origen',
    'nombre\\s+(?:y\\s+apellido\\s+)?(?:del\\s+)?origen',
    'origen',
    'de\\s*\\n',
    'desde',
    'enviado\\s+por',
    'pagador',
  ]);

  if (!valor) return null;

  // Un CBU o CUIT suelto no es un nombre.
  if (/^\d[\d\s-]*$/.test(valor)) return null;
  return valor;
}

function buscarCbuOrigen(texto) {
  // El CBU/CVU son 22 digitos. Solo sirve si NO es el del destino: la etiqueta
  // esta en la misma linea del numero o en la de arriba.
  for (const match of texto.matchAll(/\b(\d{22})\b/g)) {
    const propia = lineaDe(texto, match.index);
    const inicioPropia = texto.lastIndexOf('\n', match.index) + 1;
    const anterior = inicioPropia > 1 ? lineaDe(texto, inicioPropia - 2) : '';

    if (!DESTINO.test(propia) && !DESTINO.test(anterior)) return match[1];
  }

  const alias = valorDeEtiqueta(texto, ['alias\\s+origen', 'alias\\s+remitente']);
  return alias || null;
}

function buscarBanco(texto) {
  const plano = sinAcentos(texto);
  for (const banco of BANCOS) {
    const patron = new RegExp(`\\b${sinAcentos(banco).replace(/\s+/g, '\\s+')}\\b`, 'i');
    const match = patron.exec(plano);
    if (!match) continue;

    const contexto = plano.slice(Math.max(0, match.index - 50), match.index + 20);
    if (DESTINO.test(contexto)) continue;
    return banco;
  }
  return null;
}

function buscarReferencia(texto) {
  const valor = valorDeEtiqueta(texto, [
    'id\\s*op\\.?',
    'n[°ºo]?\\s*de\\s*operaci[oó]n',
    'n[uú]mero\\s+de\\s+operaci[oó]n',
    'c[oó]digo\\s+de\\s+(?:operaci[oó]n|transferencia)',
    'n[°ºo]?\\s*de\\s*comprobante',
    'comprobante\\s*n[°ºo]?',
    'n[uú]mero\\s+de\\s+control',
    'n[°ºo]?\\s*de\\s*control',
    'referencia',
    'identificador',
    'transacci[oó]n',
    'operaci[oó]n',
  ], { excluirDestino: false });

  if (!valor) return null;

  const limpio = valor.replace(/[^\w-]/g, '');
  // Descarta capturas basura tipo "de transferencia".
  return /\d/.test(limpio) && limpio.length >= 4 ? limpio : null;
}

function buscarConcepto(texto) {
  const valor = valorDeEtiqueta(texto, ['concepto', 'motivo', 'referencia\\s+del\\s+pago', 'detalle'],
    { excluirDestino: false });
  return valor && valor.length <= 60 ? valor : null;
}

function buscarTipo(texto) {
  const plano = sinAcentos(texto).toLowerCase();
  if (/transferencia|transferiste|enviaste/.test(plano)) return 'transferencia';
  if (/dep[oó]sito|deposito/.test(plano)) return 'deposito';
  if (/pago/.test(plano)) return 'pago';
  return 'otro';
}

// Devuelve los mismos campos que el modelo, o null si no hay confianza. Monto y
// fecha son obligatorios: sin alguno de los dos no se puede conciliar ni
// deduplicar, y adivinar seria peor que pasarle el trabajo a la IA.
function parsearComprobante(texto) {
  const crudo = String(texto || '');
  if (crudo.trim().length < 20) return null;

  const monto = buscarMonto(crudo);
  const fecha = buscarFecha(crudo);
  if (!monto || !fecha) return null;

  return {
    monto,
    fecha,
    tipo_operacion: buscarTipo(crudo),
    nombre_origen: buscarNombreOrigen(crudo),
    cbu_origen: buscarCbuOrigen(crudo),
    banco_origen: buscarBanco(crudo),
    referencia: buscarReferencia(crudo),
    concepto: buscarConcepto(crudo),
    _fuente: 'parser',
  };
}

module.exports = {
  parsearComprobante,
  aNumero,
  buscarFecha,
  buscarMonto,
  buscarReferencia,
  buscarNombreOrigen,
  buscarCbuOrigen,
};
