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

// Cruza lo anotado en el Sheet con lo que sigue estando en disco: los archivos
// podados quedan listados pero sin link.
async function listarErrores(limite = 15) {
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
  esNombreSeguro,
  DATA_DIR,
  DIR_ERRORES,
};
