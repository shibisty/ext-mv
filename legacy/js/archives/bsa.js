// BSA (TES4-формат): Oblivion v103, Fallout 3 / New Vegas / Skyrim LE v104, Skyrim SE v105.
import { inflateZlib, lz4Frame } from './codec.js';

const ascii = (u8, a, b) => { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; };
export const normPath = (p) => p.replace(/\\/g, '/').toLowerCase();
export const stripExt = (p) => p.replace(/\.[^./]+$/, '');

export async function openBsa(file) {
  const h = new DataView(await file.slice(0, 36).arrayBuffer());
  if (h.getUint32(0, true) !== 0x00415342) throw new Error(`${file.name}: не BSA (TES4+)`);
  const version = h.getUint32(4, true), dirOff = h.getUint32(8, true), flags = h.getUint32(12, true);
  const folderCount = h.getUint32(16, true), fileCount = h.getUint32(20, true), totalFolderName = h.getUint32(24, true), totalFileName = h.getUint32(28, true);
  if (![103, 104, 105].includes(version)) throw new Error(`${file.name}: версия BSA ${version} не поддерживается`);
  if (!(flags & 1) || !(flags & 2)) throw new Error(`${file.name}: в архиве нет имён папок/файлов`);
  const rec = version === 105 ? 24 : 16;
  const size = folderCount * rec + totalFolderName + folderCount + fileCount * 16 + totalFileName;
  const buf = await file.slice(dirOff, dirOff + size).arrayBuffer(), dv = new DataView(buf), u8 = new Uint8Array(buf);
  let p = 0; const counts = [];
  for (let i = 0; i < folderCount; i++) { counts.push(dv.getUint32(p + 8, true)); p += rec; }
  const files = [];
  for (let i = 0; i < folderCount; i++) {
    const len = u8[p]; const dir = ascii(u8, p + 1, p + len); p += 1 + len;   // len включает завершающий 0
    for (let j = 0; j < counts[i]; j++) { files.push({ dir, size: dv.getUint32(p + 8, true), off: dv.getUint32(p + 12, true) }); p += 16; }
  }
  const defaultComp = !!(flags & 4), embed = !!(flags & 0x100) && version !== 103;
  const entries = [], index = new Map(), byKey = new Map();
  for (const f of files) {
    let q = p; while (u8[q] !== 0) q++;
    const name = ascii(u8, p, q); p = q + 1;
    const path = normPath(f.dir ? f.dir + '\\' + name : name);
    const e = { path, off: f.off, size: f.size & 0x3fffffff, compressed: defaultComp !== !!(f.size & 0x40000000), file: null };
    entries.push(e); index.set(path, e);
    if (/\.(dds|tga|png)$/.test(path)) byKey.set(stripExt(path), e);
  }
  const arch = {
    name: file.name, version, entries, index, byKey,
    async read(e) {
      const u = new Uint8Array(await file.slice(e.off, e.off + e.size).arrayBuffer());
      let o = embed ? 1 + u[0] : 0;
      if (!e.compressed) return u.subarray(o);
      const orig = new DataView(u.buffer, u.byteOffset).getUint32(o, true); o += 4;
      return version === 105 ? lz4Frame(u.subarray(o), orig) : inflateZlib(u.subarray(o));
    },
    // «файл-подобный» объект (name + arrayBuffer), совместимый с загрузчиками и loadImage
    fileOf(e) {
      if (!e.file) e.file = { name: e.path.split('/').pop(), path: e.path, arrayBuffer: async () => { const d = await arch.read(e); return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength); } };
      return e.file;
    },
  };
  return arch;
}
