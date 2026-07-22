const { crearApp } = require('../src/web');

const checks = [];
function check(nombre, ok) {
  checks.push([nombre, ok]);
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const llamadas = [];
  let demora = 0;
  let debeFallar = false;

  const appState = { connected: false, qr: null, processed: 0, duplicados: 0, lastError: null };
  const control = {
    async reiniciar(opciones) {
      llamadas.push(opciones);
      if (demora) await esperar(demora);
      if (debeFallar) throw new Error('socket roto');
    },
  };

  const server = crearApp(appState, control).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (ruta) => fetch(base + ruta, { method: 'POST', redirect: 'manual' });

  // Reconectar mantiene la sesion.
  let res = await post('/reconectar');
  check('reconectar redirige', res.status === 302 && res.headers.get('location') === '/');
  check('reconectar no borra la sesion', llamadas.at(-1)?.borrarSesion === false);

  // Nueva sesion la descarta.
  res = await post('/nueva-sesion');
  check('nueva-sesion redirige', res.status === 302);
  check('nueva-sesion borra la sesion', llamadas.at(-1)?.borrarSesion === true);

  // Dos reinicios simultaneos dejarian dos sockets peleando por auth_info.
  llamadas.length = 0;
  demora = 120;
  const [a, b] = await Promise.all([post('/reconectar'), post('/nueva-sesion')]);
  check('reinicio simultaneo se ignora', llamadas.length === 1);
  check('ambos responden redirect', a.status === 302 && b.status === 302);
  demora = 0;

  // Si el reinicio explota, la web tiene que seguir viva.
  debeFallar = true;
  res = await post('/reconectar');
  check('reinicio fallido no tira el server', res.status === 302);
  check('reinicio fallido queda registrado', /socket roto/.test(appState.lastError || ''));
  debeFallar = false;

  // El guard se libera despues del error.
  llamadas.length = 0;
  await post('/reconectar');
  check('se puede reintentar despues de un error', llamadas.length === 1);

  // Los botones tienen que estar donde se necesitan.
  const html = await (await fetch(base + '/')).text();
  check('pantalla de conexion muestra los botones',
    html.includes('action="/reconectar"') && html.includes('action="/nueva-sesion"'));
  check('desvincular pide confirmacion', html.includes('onsubmit="return confirm('));

  server.close();

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
