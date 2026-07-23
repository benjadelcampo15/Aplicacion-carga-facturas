// Los comprobantes se procesan de a uno. El plan gratis de Gemini limita las
// requests por minuto, asi que atender varios en paralelo cuando entra un lote
// choca contra ese tope; en serie se espera el rate limit y no se pierde nada.
function crearCola() {
  const pendientes = [];
  let trabajando = false;
  let enCurso = 0;

  async function drenar() {
    if (trabajando) return;
    trabajando = true;

    while (pendientes.length) {
      const { tarea, resolver, rechazar } = pendientes.shift();
      enCurso = 1;
      try {
        resolver(await tarea());
      } catch (err) {
        rechazar(err);
      }
      enCurso = 0;
    }

    trabajando = false;
  }

  return {
    // Devuelve tambien cuantos habia esperando al momento de encolar, para
    // poder avisarle a la persona que su comprobante no se perdio.
    encolar(tarea) {
      const posicion = pendientes.length + enCurso;
      const promesa = new Promise((resolver, rechazar) => {
        pendientes.push({ tarea, resolver, rechazar });
      });
      drenar();
      return { posicion, promesa };
    },

    get largo() {
      return pendientes.length + enCurso;
    },
  };
}

module.exports = { crearCola };
