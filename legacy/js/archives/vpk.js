// VPK v1/v2 (Source 1, Source 2): каталог *_dir.vpk + части *_000.vpk (или всё в одном файле).
import { normPath } from './bsa.js';

export async function openVpk(dirFile, parts) {
  const head = new DataView(await dirFile.slice(0, 28).arrayBuffer());
  if (head.getUint32(0, true) !== 0x55aa1234) throw new Error(`${dirFile.name}: не VPK`);
  const version = head.getUint32(4, true), treeSize = head.getUint32(8, true);
  if (version !== 1 && version !== 2) throw new Error(`${dirFile.name}: версия VPK ${version} не поддерживается`);
  const headerSize = version === 2 ? 28 : 12;
  const tree = new Uint8Array(await dirFile.slice(headerSize, headerSize + treeSize).arrayBuffer()), tv = new DataView(tree.buffer);
  let p = 0; const str = () => { let s = ''; while (p < tree.length && tree[p]) s += String.fromCharCode(tree[p++]); p++; return s; };
  const entries = [], blank = (s) => (s === ' ' ? '' : s);
  for (;;) {
    const ext = str(); if (!ext) break;
    for (;;) {
      const dir = str(); if (!dir) break;
      for (;;) {
        const name = str(); if (!name) break;
        const crc = tv.getUint32(p, true), preload = tv.getUint16(p + 4, true), archive = tv.getUint16(p + 6, true), offset = tv.getUint32(p + 8, true), length = tv.getUint32(p + 12, true);
        p += 18;
        const d = blank(dir), path = normPath((d ? d + '/' : '') + blank(name) + (blank(ext) ? '.' + blank(ext) : ''));
        entries.push({ path, crc, preloadOff: p, preload, archive, offset, length, file: null }); p += preload;
      }
    }
  }
  const index = new Map(entries.map((e) => [e.path, e]));
  const arch = {
    name: dirFile.name, version, entries, index, byKey: new Map(),
    async read(e) {
      const pre = tree.subarray(e.preloadOff, e.preloadOff + e.preload); let data = new Uint8Array(0);
      if (e.length) {
        const src = e.archive === 0x7fff ? dirFile : parts.get(e.archive), base = e.archive === 0x7fff ? headerSize + treeSize : 0;
        if (!src) throw new Error(`нет части VPK №${e.archive} (выберите все файлы *_NNN.vpk вместе с *_dir.vpk)`);
        data = new Uint8Array(await src.slice(base + e.offset, base + e.offset + e.length).arrayBuffer());
      }
      if (!pre.length) return data;
      const out = new Uint8Array(pre.length + data.length); out.set(pre); out.set(data, pre.length); return out;
    },
    fileOf(e) {
      if (!e.file) e.file = { name: e.path.split('/').pop(), path: e.path, archive: arch, arrayBuffer: async () => { const d = await arch.read(e); return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength); } };
      return e.file;
    },
  };
  return arch;
}
