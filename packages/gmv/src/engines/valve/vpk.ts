// VPK v1/v2 (Source 1, Source 2): каталог *_dir.vpk + части *_000.vpk (или всё в одном файле).
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface VpkEntry extends ArchiveEntry { crc: number; preloadOff: number; preload: number; archive: number; offset: number; length: number }

/** Имя части VPK: [база, 'dir' | номер] или null. */
export function vpkPart(name: string): [string, string] | null {
  const m = /^(.*)_(dir|\d{3})\.vpk$/i.exec(name);
  return m ? [m[1]!.toLowerCase(), m[2]!.toLowerCase()] : null;
}

export async function openVpk(dirFile: BlobFile, parts: Map<number, BlobFile>): Promise<Archive> {
  const head = new DataView(await dirFile.slice(0, 28).arrayBuffer());
  if (head.byteLength < 12 || head.getUint32(0, true) !== 0x55aa1234) throw new Error(`${dirFile.name}: не VPK`);
  const version = head.getUint32(4, true), treeSize = head.getUint32(8, true);
  if (version !== 1 && version !== 2) throw new Error(`${dirFile.name}: версия VPK ${version} не поддерживается`);
  const headerSize = version === 2 ? 28 : 12;
  const tree = await readRange(dirFile, headerSize, headerSize + treeSize), tv = new DataView(tree.buffer, tree.byteOffset, tree.byteLength);
  let p = 0;
  const str = () => { let s = ''; while (p < tree.length && tree[p]) s += String.fromCharCode(tree[p++]!); p++; return s; };
  const entries: VpkEntry[] = [], blank = (s: string) => (s === ' ' ? '' : s);
  for (;;) {
    const ext = str();
    if (!ext) break;
    for (;;) {
      const dir = str();
      if (!dir) break;
      for (;;) {
        const name = str();
        if (!name) break;
        const crc = tv.getUint32(p, true), preload = tv.getUint16(p + 4, true), archive = tv.getUint16(p + 6, true), offset = tv.getUint32(p + 8, true), length = tv.getUint32(p + 12, true);
        p += 18;
        const d = blank(dir), path = normPath((d ? d + '/' : '') + blank(name) + (blank(ext) ? '.' + blank(ext) : ''));
        entries.push({ path, crc, preloadOff: p, preload, archive, offset, length });
        p += preload;
      }
    }
  }
  return createArchive<VpkEntry>({
    name: dirFile.name, kind: 'vpk', version, entries,
    textureKeys: () => [],
    async read(e) {
      const pre = tree.subarray(e.preloadOff, e.preloadOff + e.preload);
      let data: Uint8Array = new Uint8Array(0);
      if (e.length) {
        const inDir = e.archive === 0x7fff, src = inDir ? dirFile : parts.get(e.archive), base = inDir ? headerSize + treeSize : 0;
        if (!src) throw new Error(`нет части VPK №${e.archive} (выберите все файлы *_NNN.vpk вместе с *_dir.vpk)`);
        data = await readRange(src, base + e.offset, base + e.offset + e.length);
      }
      if (!pre.length) return data;
      const out = new Uint8Array(pre.length + data.length);
      out.set(pre); out.set(data, pre.length);
      return out;
    },
  });
}
