// Empareja el numero de cliente con el comprobante. El chofer los manda en
// mensajes distintos (la foto y el numero), en cualquier orden, asi que hay que
// juntarlos. Todo se guarda POR CHAT: el numero de un chofer nunca se aparea con
// la foto de otro, porque cada chofer es un chat distinto de WhatsApp.

// Cuanto vive un pendiente sin aparearse. El chofer no manda el numero al toque:
// puede tardar varios minutos, asi que la ventana es amplia. Pasado eso se
// descarta, para que un numero viejo no termine pegado a un comprobante de otro
// momento.
const VENTANA_MS = 30 * 60 * 1000;

function crearVinculador({ ahora = () => Date.now() } = {}) {
  // Por chat: numeros esperando una foto, y comprobantes (ya escritos) esperando
  // un numero. Se emparejan en orden de llegada (FIFO).
  const numerosPorChat = new Map();
  const comprobantesPorChat = new Map();

  function vigentes(mapa, chat) {
    const lista = (mapa.get(chat) || []).filter((e) => ahora() - e.ts < VENTANA_MS);
    if (lista.length) mapa.set(chat, lista);
    else mapa.delete(chat);
    return lista;
  }

  // El chofer manda el numero como se le ocurre: "3640", "cliente 3640",
  // "numero de cliente : 3640", "N° cliente 3640". Se sacan las palabras de
  // etiqueta y la puntuacion; si lo que queda son solo digitos, ese es el
  // numero. Si queda cualquier otra palabra ("hola", "llegue a las 3640 de la
  // calle"), no se toma: es preferible no cargar nada que cargar cualquier cosa.
  //
  // El tope de 10 digitos deja afuera un CUIT (11) y un numero de transferencia
  // (12), que son los que se podrian confundir con un numero de cliente.
  function numeroDeCliente(texto) {
    const limpio = String(texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(?:n|nro|no|num|numero|de|del|el|la|es|para|mi|su|cliente|cli|codigo|cod)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return /^\d{1,10}$/.test(limpio) ? limpio : null;
  }

  // Llega un comprobante. Si trae numero en el epigrafe, ese manda. Si no, se
  // busca un numero que haya llegado suelto. Devuelve el numero o null.
  function numeroParaComprobante(chat, epigrafe) {
    const delEpigrafe = numeroDeCliente(epigrafe);
    if (delEpigrafe) return delEpigrafe;

    const numeros = vigentes(numerosPorChat, chat);
    if (numeros.length) {
      const { numero } = numeros.shift();
      return numero;
    }
    return null;
  }

  // El comprobante se escribio sin numero: se recuerda su fila para que un
  // numero que llegue despues la complete.
  function comprobanteSinNumero(chat, ubicacion) {
    const lista = comprobantesPorChat.get(chat) || [];
    lista.push({ ...ubicacion, ts: ahora() });
    comprobantesPorChat.set(chat, lista);
  }

  // Llega un texto. Si es un numero de cliente y hay un comprobante esperando,
  // devuelve su ubicacion para completarla. Si no hay, guarda el numero para el
  // proximo comprobante. Devuelve { ubicacion } | { guardado: numero } | null.
  function texto(chat, contenido) {
    const numero = numeroDeCliente(contenido);
    if (!numero) return null;

    const comprobantes = vigentes(comprobantesPorChat, chat);
    if (comprobantes.length) {
      const ubicacion = comprobantes.shift();
      return { numero, ubicacion };
    }

    const lista = numerosPorChat.get(chat) || [];
    lista.push({ numero, ts: ahora() });
    numerosPorChat.set(chat, lista);
    return { numero, guardado: true };
  }

  return { numeroParaComprobante, comprobanteSinNumero, texto, numeroDeCliente };
}

module.exports = { crearVinculador, VENTANA_MS };
