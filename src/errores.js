const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { appendError, leerErrores } = require('./sheets');

// En Railway el filesystem del container es efimero: DATA_DIR tiene que
// apuntar al volumen montado para que los comprobantes fallados sobrevivan al
// redeploy. Adentro conviven la sesion de WhatsApp y esta carpeta.
const DATA_DIR = process.env.DATA_DIR || './data';
const DIR_ERRORES = path.join(DATA_DIR, 'errores');

// Tope de archivos guardados. Son comprobantes con datos de gente, no tiene
// sentido acumularlos para siempre.
const MAXIMO_ARCHIVOS = 200;

const EXTENSIONES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function extensionDe(mimeType) {
  const limpio = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return EXTENSIONES[limpio] || 'bin';
}

// El nombre llega desde el Sheet y termina en una ruta del filesystem: si no se
// valida, un ".." en la celda deja leer cualquier archivo del container.
function esNombreSeguro(nombre) {
  return /^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(String(nombre || ''));
}

function rutaDe(nombre) {
  if (!esNombreSeguro(nombre)) return null;
  return path.join(DIR_ERRORES, nombre);
}

async function podar() {
  const archivos = await fs.readdir(DIR_ERRORES).catch(() => []);
  if (archivos.length <= MAXIMO_ARCHIVOS) return;

  const conFecha = await Promise.all(archivos.map(async (nombre) => {
    const stat = await fs.stat(path.join(DIR_ERRORES, nombre)).catch(() => null);
    return { nombre, ms: stat ? stat.mtimeMs : 0 };
  }));

  conFecha.sort((a, b) => a.ms - b.ms);

  const sobran = conFecha.slice(0, conFecha.length - MAXIMO_ARCHIVOS);
  for (const { nombre } of sobran) {
    await fs.unlink(path.join(DIR_ERRORES, nombre)).catch(() => {});
  }
  console.log(`Podados ${sobran.length} comprobantes fallados viejos`);
}

// Guarda el archivo que no se pudo procesar y lo anota en el Sheet. Nunca tira:
// si falla el guardado, el error original es lo que importa reportar.
async function guardarFallido({ buffer, mimeType, senderInfo, motivo }) {
  try {
    await fs.mkdir(DIR_ERRORES, { recursive: true });

    const nombre = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      + `.${extensionDe(mimeType)}`;

    await fs.writeFile(path.join(DIR_ERRORES, nombre), buffer);
    await podar();

    await appendError({ motivo, archivo: nombre, tipo: mimeType, senderInfo });
    invalidarCacheErrores();

    console.log(`Comprobante fallado guardado como ${nombre}`);
    return nombre;
  } catch (err) {
    console.error('No se pudo guardar el comprobante fallado:', err.message);
    return null;
  }
}

async function leerArchivo(nombre) {
  const ruta = rutaDe(nombre);
  if (!ruta) return null;
  return fs.readFile(ruta).catch(() => null);
}

// La pagina se auto-refresca cada 15s y leer los errores es una consulta a
// Google: sin cache, cada refresco tardaba varios segundos y le pegaba a la API
// todo el tiempo. Se invalida cuando se guarda un fallido, asi que un error
// nuevo aparece igual de rapido.
const CACHE_MS = 60000;

// Google a veces tarda o reintenta por dentro, y la pagina quedaba esperandolo
// minutos. El dashboard tiene que abrir siempre: si la lista no llega a tiempo,
// se muestra sin ella.
const TIMEOUT_MS = 4000;

let cache = { datos: null, expira: 0 };

function invalidarCacheErrores() {
  cache = { datos: null, expira: 0 };
}

// Cruza lo anotado en el Sheet con lo que sigue estando en disco: los archivos
// podados quedan listados pero sin link.
async function listarErrores(limite = 15) {
  if (cache.datos && Date.now() < cache.expira) return cache.datos;

  let temporizador;
  const seAcaboElTiempo = new Promise((resolve) => {
    temporizador = setTimeout(() => resolve(null), TIMEOUT_MS);
  });

  try {
    const datos = await Promise.race([
      leerListaErrores(limite).catch(() => null),
      seAcaboElTiempo,
    ]);

    if (datos === null) {
      // Se cachea corto igual: si Google esta lento, no tiene sentido
      // reintentarlo en cada refresco de la pagina.
      cache = { datos: [], expira: Date.now() + 15000 };
      return [];
    }

    cache = { datos, expira: Date.now() + CACHE_MS };
    return datos;
  } finally {
    clearTimeout(temporizador);
  }
}

async function leerListaErrores(limite) {
  const filas = await leerErrores();
  const enDisco = new Set(await fs.readdir(DIR_ERRORES).catch(() => []));

  return filas
    .slice(-limite)
    .reverse()
    .map(([timestamp, remitente, telefono, motivo, archivo, tipo]) => ({
      timestamp: timestamp || '',
      remitente: remitente || '',
      telefono: telefono || '',
      motivo: motivo || '',
      archivo: archivo || '',
      tipo: tipo || '',
      disponible: Boolean(archivo) && enDisco.has(archivo),
    }));
}

module.exports = {
  guardarFallido,
  leerArchivo,
  listarErrores,
  invalidarCacheErrores,
  esNombreSeguro,
  DATA_DIR,
  DIR_ERRORES,
};
