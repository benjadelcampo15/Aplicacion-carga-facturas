const express = require('express');
const { getStats } = require('./stats');
const { listarErrores, leerArchivo } = require('./errores');

const ZONA = 'America/Argentina/Buenos_Aires';

const pesos = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

// Los nombres salen del comprobante via modelo, asi que no son confiables.
function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function diaCorto(iso) {
  const [, mes, dia] = iso.split('-');
  return `${dia}/${mes}`;
}

function horaLocal(iso) {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  return fecha.toLocaleString('es-AR', {
    timeZone: ZONA,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ESTILOS = `
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:32px 20px;
    background:#0b0b0d;color:#e8e8ea;line-height:1.5}
  .wrap{max-width:820px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between;
    flex-wrap:wrap;gap:12px;margin-bottom:28px}
  h1{font-size:22px;margin:0;font-weight:600}
  h2{font-size:14px;margin:0 0 14px;font-weight:600;color:#9b9ba3;
    text-transform:uppercase;letter-spacing:.06em}
  .pill{padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600}
  .pill.on{background:#132e1e;color:#4ade80;border:1px solid #1c4430}
  .pill.off{background:#2e1616;color:#f87171;border:1px solid #4a2020}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
    gap:12px;margin-bottom:32px}
  .card{background:#141417;border:1px solid #232328;border-radius:10px;padding:16px}
  .card .label{font-size:12px;color:#8b8b93;margin-bottom:6px}
  .card .value{font-size:26px;font-weight:600;letter-spacing:-.02em}
  .card .value.sm{font-size:20px}
  .card.hoy{border-color:#2b4a35}
  .card.hoy .value{color:#4ade80}
  .card.pend{border-color:#574a12}
  .card.pend .value{color:#fbbf24}
  .card .sub{font-size:12px;color:#8b8b93;margin-top:4px}
  section{margin-bottom:32px}
  .chart{display:flex;align-items:flex-end;gap:5px;height:150px;
    padding:12px;background:#141417;border:1px solid #232328;border-radius:10px}
  .bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;
    align-items:center;gap:6px;height:100%}
  .bar .fill{width:100%;background:#3f6cd4;border-radius:3px 3px 0 0;min-height:2px;
    transition:height .2s}
  .bar.hoy .fill{background:#4ade80}
  .bar .n{font-size:11px;color:#c8c8d0;font-weight:600}
  .bar .d{font-size:10px;color:#6e6e78;white-space:nowrap}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-weight:600;color:#8b8b93;font-size:11px;
    text-transform:uppercase;letter-spacing:.05em;padding:0 10px 8px}
  td{padding:10px;border-top:1px solid #1e1e23}
  td.monto{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  th.monto{text-align:right}
  .vacio{padding:28px;text-align:center;color:#6e6e78;background:#141417;
    border:1px solid #232328;border-radius:10px}
  .err{background:#2a1a1a;border:1px solid #4a2020;color:#fca5a5;
    padding:14px;border-radius:10px;margin-bottom:24px;font-size:13px}
  footer{color:#5c5c66;font-size:12px;text-align:center;margin-top:8px}
  .acciones{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}
  .acciones form{margin:0}
  .btn{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;
    cursor:pointer;background:#1c1c21;color:#e8e8ea;border:1px solid #303038}
  .btn:hover{background:#26262d}
  .btn.riesgo{color:#fca5a5;border-color:#4a2020}
  .btn.riesgo:hover{background:#2a1a1a}
  .demo{display:flex;align-items:center;gap:10px;background:#2a2410;
    border:1px solid #574a12;color:#fbbf24;padding:12px 14px;border-radius:10px;
    margin-bottom:14px;font-size:13px}
  .demo strong{font-weight:700;letter-spacing:.04em}
  .conc{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .conc .card .value{font-size:24px}
  .conc .card.si .value{color:#4ade80}
  .conc .card.pend .value{color:#fbbf24}
  .conc .card.no .value{color:#f87171}
  .conc .card .sub{font-size:12px;color:#8b8b93;margin-top:4px;
    font-variant-numeric:tabular-nums}
  .simulado .card{border-style:dashed;opacity:.85}
  .tag{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;
    letter-spacing:.05em;vertical-align:middle;margin-left:6px}
  .tag.si{background:#132e1e;color:#4ade80}
  .tag.pend{background:#2a2410;color:#fbbf24}
  .tag.no{background:#2e1616;color:#f87171}
  .link{color:#7aa2f7;text-decoration:none;font-weight:600}
  .link:hover{text-decoration:underline}
  td.motivo{color:#fca5a5;font-size:12px;max-width:320px}
`;

function layout(titulo, refresco, cuerpo) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title>
<meta http-equiv="refresh" content="${refresco}">
<style>${ESTILOS}</style></head>
<body><div class="wrap">${cuerpo}</div></body></html>`;
}

const CONFIRMA_DESVINCULAR = 'Esto borra la sesión de WhatsApp y vas a tener que '
  + 'escanear un QR nuevo. ¿Seguir?';

// Reemplazan al "matar el proceso y volver a levantarlo".
function acciones() {
  return `<div class="acciones">
    <form method="post" action="/reconectar">
      <button class="btn" type="submit">Reconectar</button>
    </form>
    <form method="post" action="/nueva-sesion"
      onsubmit="return confirm('${CONFIRMA_DESVINCULAR}')">
      <button class="btn riesgo" type="submit">Desvincular y generar QR nuevo</button>
    </form>
  </div>`;
}

function grafico(serie) {
  const max = Math.max(...serie.map((d) => d.cargas), 1);
  const hoy = serie[serie.length - 1]?.dia;

  const barras = serie.map((d) => `
    <div class="bar ${d.dia === hoy ? 'hoy' : ''}" title="${esc(d.dia)}: ${d.cargas} cargas">
      <span class="n">${d.cargas || ''}</span>
      <div class="fill" style="height:${(d.cargas / max) * 100}%"></div>
      <span class="d">${diaCorto(d.dia)}</span>
    </div>`).join('');

  return `<div class="chart">${barras}</div>`;
}

const ETIQUETA = {
  conciliado: { texto: 'Concilia', clase: 'si' },
  pendiente: { texto: 'Pendiente', clase: 'pend' },
  no_concilia: { texto: 'No concilia', clase: 'no' },
};

function conciliacion(stats) {
  const { conciliacion: c, conciliacionSimulada } = stats;
  const total = c.conciliado.cantidad + c.pendiente.cantidad + c.no_concilia.cantidad;
  const porcentaje = (n) => (total ? Math.round((n / total) * 100) : 0);

  const aviso = conciliacionSimulada ? `
    <div class="demo">
      <strong>DATOS SIMULADOS</strong>
      <span>Todavía no se cruza contra extractos ni facturas. Estos números son
      inventados y no representan conciliaciones reales.</span>
    </div>` : '';

  const tarjeta = (clase, titulo, dato) => `
    <div class="card ${clase}">
      <div class="label">${titulo}</div>
      <div class="value">${dato.cantidad}</div>
      <div class="sub">${porcentaje(dato.cantidad)}% · ${pesos.format(dato.monto)}</div>
    </div>`;

  return `${aviso}
    <div class="conc ${conciliacionSimulada ? 'simulado' : ''}">
      ${tarjeta('si', 'Concilian', c.conciliado)}
      ${tarjeta('pend', 'Pendientes', c.pendiente)}
      ${tarjeta('no', 'No concilian', c.no_concilia)}
    </div>`;
}

function tablaErrores(errores) {
  if (!errores.length) {
    return '<div class="vacio">No hay comprobantes con error</div>';
  }

  const filas = errores.map((e) => {
    const archivo = e.disponible
      ? `<a class="link" href="/errores/${encodeURIComponent(e.archivo)}" target="_blank">Ver</a>`
      : '<span style="color:#5c5c66">no disponible</span>';

    return `
    <tr>
      <td>${esc(horaLocal(e.timestamp))}</td>
      <td>${esc(e.remitente) || '<span style="color:#5c5c66">sin dato</span>'}</td>
      <td class="motivo">${esc(e.motivo)}</td>
      <td>${archivo}</td>
    </tr>`;
  }).join('');

  return `<table>
    <thead><tr><th>Cuándo</th><th>Lo mandó</th><th>Motivo</th><th>Archivo</th></tr></thead>
    <tbody>${filas}</tbody></table>`;
}

function tabla(ultimas) {
  if (!ultimas.length) {
    return '<div class="vacio">Todavía no hay comprobantes cargados</div>';
  }

  const filas = ultimas.map((c) => {
    const etiqueta = ETIQUETA[c.conciliado] || ETIQUETA.pendiente;
    return `
    <tr>
      <td>${esc(horaLocal(c.timestamp))}</td>
      <td>${esc(c.origen) || '<span style="color:#5c5c66">sin dato</span>'}
        <span class="tag ${etiqueta.clase}">${etiqueta.texto}</span></td>
      <td style="color:#8b8b93">${esc(c.remitente)}</td>
      <td class="monto">${pesos.format(c.monto)}</td>
    </tr>`;
  }).join('');

  return `<table>
    <thead><tr><th>Cargado</th><th>Origen</th><th>Lo mandó</th>
    <th class="monto">Monto</th></tr></thead>
    <tbody>${filas}</tbody></table>`;
}

function dashboard(appState, stats, error, errores = []) {
  const promedio = stats && stats.diasActivos
    ? (stats.totalCargas / stats.diasActivos).toFixed(1)
    : '0';

  const aviso = error
    ? `<div class="err">No pude leer el Sheet: ${esc(error)}</div>`
    : '';

  const contenido = stats ? `
    <div class="cards">
      <div class="card hoy">
        <div class="label">Cargas hoy</div>
        <div class="value">${stats.hoy.cargas}</div>
      </div>
      <div class="card hoy">
        <div class="label">Monto hoy</div>
        <div class="value sm">${pesos.format(stats.hoy.monto)}</div>
      </div>
      <div class="card">
        <div class="label">Total cargas</div>
        <div class="value">${stats.totalCargas}</div>
      </div>
      <div class="card">
        <div class="label">Monto total</div>
        <div class="value sm">${pesos.format(stats.montoTotal)}</div>
      </div>
      <div class="card">
        <div class="label">Promedio por día activo</div>
        <div class="value">${promedio}</div>
      </div>
      <div class="card">
        <div class="label">Duplicados ignorados</div>
        <div class="value">${appState.duplicados}</div>
      </div>
      <div class="card ${appState.enCola ? 'pend' : ''}">
        <div class="label">En cola</div>
        <div class="value">${appState.enCola || 0}</div>
        ${appState.enCola ? '<div class="sub">esperando al modelo</div>' : ''}
      </div>
    </div>

    <section>
      <h2>Conciliación</h2>
      ${conciliacion(stats)}
    </section>

    <section>
      <h2>Últimos 14 días</h2>
      ${grafico(stats.serie)}
    </section>

    <section>
      <h2>Últimas cargas</h2>
      ${tabla(stats.ultimas)}
    </section>

    <section>
      <h2>Comprobantes con error${errores.length ? ` (${errores.length})` : ''}</h2>
      ${tablaErrores(errores)}
    </section>
  ` : '';

  const cuerpo = `
    <header>
      <h1>Conciliación de comprobantes</h1>
      <span class="pill ${appState.connected ? 'on' : 'off'}">
        ${appState.connected ? 'WhatsApp conectado' : 'Desconectado'}
      </span>
    </header>
    ${acciones()}
    ${aviso}
    ${contenido}
    <footer>Se actualiza solo cada 15s${appState.lastError ? ` · último error: ${esc(appState.lastError)}` : ''}</footer>`;

  return layout('Conciliación de comprobantes', 15, cuerpo);
}

function pantallaQR(qr) {
  return layout('Escanear QR', 5, `
    <header><h1>Conciliación de comprobantes</h1></header>
    ${acciones()}
    <div style="text-align:center">
      <p>Escaneá este QR con WhatsApp</p>
      <p style="color:#8b8b93;font-size:14px">
        WhatsApp &gt; Dispositivos vinculados &gt; Vincular dispositivo</p>
      <img src="${esc(qr)}" alt="Código QR"
        style="background:#fff;padding:16px;border-radius:12px;max-width:100%">
      <p style="color:#6e6e78;font-size:13px;margin-top:20px">
        Si escaneaste y quedó trabado, tocá "Desvincular y generar QR nuevo".</p>
    </div>`);
}

function pantallaConectando() {
  return layout('Conectando', 3, `
    <header><h1>Conciliación de comprobantes</h1></header>
    ${acciones()}
    <div class="vacio">Conectando con WhatsApp...</div>`);
}

const arranque = new Date().toISOString();

function crearApp(appState, control) {
  const app = express();

  // El reinicio corta la conexion y vuelve a levantarla; hacerlo dos veces a la
  // vez deja sockets peleandose por las mismas credenciales.
  let reiniciando = false;

  async function manejarReinicio(res, borrarSesion) {
    if (reiniciando) return res.redirect('/');

    reiniciando = true;
    try {
      await control.reiniciar({ borrarSesion });
    } catch (err) {
      console.error('Error reiniciando:', err.message);
      appState.lastError = `No pude reiniciar: ${err.message}`;
    } finally {
      reiniciando = false;
    }
    res.redirect('/');
  }

  app.post('/reconectar', (req, res) => manejarReinicio(res, false));
  app.post('/nueva-sesion', (req, res) => manejarReinicio(res, true));

  app.get('/', async (req, res) => {
    if (!appState.connected) {
      return res.send(appState.qr ? pantallaQR(appState.qr) : pantallaConectando());
    }

    // Si el Sheet falla igual mostramos la pagina: el estado de la conexion
    // es lo mas importante y no depende de Google.
    try {
      const [stats, errores] = await Promise.all([
        getStats(),
        listarErrores().catch(() => []),
      ]);
      res.send(dashboard(appState, stats, null, errores));
    } catch (err) {
      console.error('Error leyendo stats:', err.message);
      res.send(dashboard(appState, null, err.message));
    }
  });

  // El nombre viene de una celda del Sheet y termina en una ruta del disco:
  // leerArchivo lo valida antes de tocar el filesystem.
  app.get('/errores/:archivo', async (req, res) => {
    const contenido = await leerArchivo(req.params.archivo);
    if (!contenido) return res.status(404).send('No encontrado');

    const extension = req.params.archivo.split('.').pop().toLowerCase();
    const tipos = {
      jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf',
    };
    res.type(tipos[extension] || 'application/octet-stream').send(contenido);
  });

  app.get('/health', (req, res) => {
    res.json({
      connected: appState.connected,
      processed: appState.processed,
      duplicados: appState.duplicados,
      enCola: appState.enCola,
      fallidos: appState.fallidos,
      // Para saber que version esta corriendo sin tener que deducirlo de los
      // logs. Railway lo inyecta solo en los deploys desde GitHub.
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA || 'desconocido').slice(0, 7),
      arrancado: arranque,
    });
  });

  return app;
}

module.exports = { crearApp, dashboard, pantallaQR, pantallaConectando };
