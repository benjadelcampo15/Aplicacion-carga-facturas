// Empareja el numero de cliente con el comprobante. El chofer los manda en
// mensajes distintos (la foto y el numero), en cualquier orden, asi que hay que
// juntarlos. Todo se guarda POR CHAT: el numero de un chofer nunca se aparea con
// la foto de otro, porque cada chofer es un chat distinto de WhatsApp.

// Cuanto vive un pendiente sin aparearse. Pasado esto, un numero suelto no se
// pega a una foto vieja de hace rato.
const VENTANA_MS = 5 * 60 * 1000;

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

  // Un texto es un numero de cliente si es basicamente solo digitos (hasta 6),
  // con un "cliente" opcional adelante. "hola" o "gracias" no lo son.
  function numeroDeCliente(texto) {
    const m = /^\s*(?:cliente|cli|n[°º]?)?\s*:?\s*(\d{1,6})\s*$/i.exec(String(texto || ''));
    return m ? m[1] : null;
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
