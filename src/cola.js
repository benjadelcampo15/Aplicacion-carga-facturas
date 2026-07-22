// Los comprobantes se procesan de a uno. Groq permite ~8000 tokens por minuto
// y cada imagen consume ~3700, asi que atender varios en paralelo garantiza
// chocar contra el limite y perder comprobantes.
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
