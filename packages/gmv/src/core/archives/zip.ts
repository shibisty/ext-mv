// ZIP (pk3/pk4 id Tech, .pak CryEngine, .zip): читается центральный каталог, данные — по требованию (store / deflate).
import { normPath } from '../binary';
import { inflateRaw } from '../codecs/zlib';
import type { Archive, ArchiveEntry, BlobFile } from '../types';
import { createArchive, readRange } from './common';

interface ZipEntry extends ArchiveEntry { method: number; comp: number; off: number }

export async function openZip(file: BlobFile): Promise<Archive> {
  const tailLen = Math.min(file.size, 65557), tail = await readRange(file, file.size - tailLen, file.size);
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tdv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error(`${file.name}: не ZIP (нет конца каталога)`);
  const cdSize = tdv.getUint32(e + 12, true), cdOff = tdv.getUint32(e + 16, true);
  if (cdOff === 0xffffffff) throw new Error(`${file.name}: ZIP64 не поддерживается`);
  const u8 = await readRange(file, cdOff, cdOff + cdSize), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), entries: ZipEntry[] = [];
  for (let p = 0; p + 46 <= u8.length && dv.getUint32(p, true) === 0x02014b50;) {
    const method = dv.getUint16(p + 10, true), comp = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    let n = '';
    for (let i = 0; i < nl; i++) n += String.fromCharCode(u8[p + 46 + i]!);
    if (!n.endsWith('/')) entries.push({ path: normPath(n), method, comp, size, off });
    p += 46 + nl + xl + cl;
  }
  return createArchive<ZipEntry>({
    name: file.name,
    kind: 'zip',
    version: 0,
    entries,
    async read(en) {
      const lh = new DataView(await file.slice(en.off, en.off + 30).arrayBuffer());
      const start = en.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const data = await readRange(file, start, start + en.comp);
      if (en.method === 0) return data;
      if (en.method === 8) return inflateRaw(data);
      throw new Error('метод сжатия ZIP ' + en.method + ' не поддерживается');
    },
  });
}
