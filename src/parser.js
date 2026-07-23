// Extrae los datos de un comprobante bancario argentino leyendo el texto, sin
// pasar por el modelo. Es determinista, gratis, instantaneo y no consume cuota
// de la API, que es lo que se agota cuando entra un lote.
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

// "$ 5.200,00" -> 5200 . El punto y la coma cambian de rol segun de donde
// venga el valor: el formato argentino usa punto de miles y coma decimal, el
// yanqui al reves, y Google Sheets devuelve las celdas ya formateadas segun la
// configuracion regional de la planilla.
//
// No se puede decidir por el simbolo, entonces se decide por cuantos digitos
// quedan despues del ultimo separador: tres son miles (66.842 son sesenta y
// seis mil), uno o dos son centavos (66.84 son sesenta y seis con ochenta y
// cuatro). Los pesos no llevan tres decimales, asi que la regla no es ambigua.
function aNumero(crudo) {
  if (crudo === null || crudo === undefined || crudo === '') return null;

  // Un numero de verdad no necesita interpretacion.
  if (typeof crudo === 'number') {
    return Number.isFinite(crudo) && crudo > 0 ? crudo : null;
  }

  let texto = String(crudo).replace(/[^\d.,-]/g, '');
  if (!texto) return null;

  const ultimoSeparador = /[.,](\d+)$/.exec(texto);

  if (ultimoSeparador && ultimoSeparador[1].length <= 2) {
    // El ultimo separador son centavos; los anteriores son de miles.
    const corte = texto.length - ultimoSeparador[1].length - 1;
    texto = `${texto.slice(0, corte).replace(/[.,]/g, '')}.${ultimoSeparador[1]}`;
  } else {
    // Tres digitos o mas: todos los separadores son de miles.
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

  // Todas exigen el signo $ pegado al numero. Sin eso, en un PDF de dos
  // columnas la etiqueta "Importe" cruzaba el salto de linea y se llevaba el
  // "12" de "12:22 PM" como si fuera el monto.
  //
  // El orden importa: lo que se concilia es lo que llega a la cuenta, asi que
  // el importe transferido gana sobre el total, que incluye comisiones.
  const etiquetas = [
    /importe\s+a\s+transferir\s*[:\s]*\$\s*([\d.,]+)/i,
    /monto\s*(?:debitado|transferido|de la transferencia|enviado)?\s*[:\s]*\$\s*([\d.,]+)/i,
    /importe\s*(?:enviado|transferido)?\s*[:\s]*\$\s*([\d.,]+)/i,
    /dinero\s+enviado\s*[:\s]*\$\s*([\d.,]+)/i,
    /total\s*(?:transferido|enviado)?\s*[:\s]*\$\s*([\d.,]+)/i,
    /valor\s*[:\s]*\$\s*([\d.,]+)/i,
    /(?:transferiste|enviaste|pagaste)\s*\$\s*([\d.,]+)/i,
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

  // En un PDF de dos columnas la etiqueta "Referencia" puede quedar pegada al
  // CBU de destino. Un CBU o CVU son 22 digitos y nunca es un numero de
  // operacion.
  if (/^\d{22}$/.test(limpio)) return null;

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

// Un CBU son 22 digitos y un CUIT 11: leidos como importe dan cifras absurdas.
// Ningun comprobante de los que pasan por acá llega a mil millones de pesos.
const MONTO_MAXIMO = 1e9;

// Piso para no confiar en numeros sueltos que quedaron cerca de una etiqueta.
// Una transferencia de menos de cien pesos no existe en la practica, asi que un
// valor asi es casi siempre un numero mal leido. Si alguna vez pasa de verdad,
// el comprobante lo resuelve el modelo.
const MONTO_MINIMO = 100;

// Etiquetas que el extractor de texto a veces deja como si fueran el valor,
// cuando el dato real quedo en otra parte del PDF.
const PARECE_ETIQUETA = /^(cuenta|banco|titular|cbu|cvu|cuit|cuil|alias|referencia|concepto|motivo|importe|monto|fecha|destino|origen|destinatario|beneficiario|n[°ºo]|numero)\b/i;

function nombrePlausible(valor) {
  if (!valor) return null;
  // "Cuenta Destino:" es una etiqueta que quedo suelta, no un nombre.
  if (valor.endsWith(':')) return null;
  if (PARECE_ETIQUETA.test(valor)) return null;
  // "076-359085/8" es un numero de cuenta, no el nombre de nadie.
  if (!/[a-zA-ZáéíóúÁÉÍÓÚñÑ]{3}/.test(valor)) return null;
  // Un nombre no es mayormente digitos.
  if ((valor.replace(/\D/g, '').length / valor.length) > 0.4) return null;
  return valor;
}

function montoPlausible(monto) {
  if (!monto || monto < MONTO_MINIMO) return null;
  if (monto >= MONTO_MAXIMO) return null;
  return monto;
}

function textoPlausible(valor) {
  if (!valor) return null;
  if (valor.endsWith(':')) return null;
  if (PARECE_ETIQUETA.test(valor)) return null;
  return valor;
}

// Devuelve los mismos campos que el modelo, o null si no hay confianza. Monto y
// fecha son obligatorios: sin alguno de los dos no se puede conciliar ni
// deduplicar, y adivinar seria peor que pasarle el trabajo a la IA.
//
// Los campos que no pasan los controles se devuelven vacios en vez de con un
// dato dudoso; si lo que falla es el monto, se descarta el comprobante entero y
// lo resuelve el modelo. Escribir un importe equivocado en la planilla es mucho
// peor que gastar una llamada.
function parsearComprobante(texto) {
  const crudo = String(texto || '');
  if (crudo.trim().length < 20) return null;

  const monto = montoPlausible(buscarMonto(crudo));
  const fecha = buscarFecha(crudo);
  if (!monto || !fecha) return null;

  const nombre_origen = nombrePlausible(buscarNombreOrigen(crudo));
  const referencia = buscarReferencia(crudo);

  // Sin nombre ni referencia la fila no sirve para conciliar, y la clave de
  // duplicados queda solo en fecha+monto: dos personas distintas transfiriendo
  // lo mismo el mismo dia se pisarian. Mejor que lo intente el modelo.
  if (!nombre_origen && !referencia) return null;

  return {
    monto,
    fecha,
    tipo_operacion: buscarTipo(crudo),
    nombre_origen,
    cbu_origen: buscarCbuOrigen(crudo),
    banco_origen: buscarBanco(crudo),
    referencia,
    concepto: textoPlausible(buscarConcepto(crudo)),
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
