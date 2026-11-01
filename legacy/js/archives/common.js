import { stripExt } from './bsa.js';
const IMG = /\.(dds|tga|png|jpe?g|pcx|bmp)$/;
// Общая обвязка архива: индекс путей, индекс текстур (по пути без расширения), «файл-подобные» объекты.
export function buildArchive(name, version, entries, readData) {
  const index = new Map(), byKey = new Map();
  for (const e of entries) { e.file = null; index.set(e.path, e); if (IMG.test(e.path)) byKey.set(stripExt(e.path), e); }
  const arch = {
    name, version, entries, index, byKey, read: readData,
    fileOf(e) {
      if (!e.file) e.file = { name: e.path.split('/').pop(), path: e.path, archive: arch, arrayBuffer: async () => { const d = await readData(e); return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength); } };
      return e.file;
    },
  };
  return arch;
}
