// EA BIGF: VIV (Need for Speed 3/4 car.viv) и .big. Заголовок: «BIGF», размер, число файлов (BE), смещение пула (BE);
// записи: смещение (BE), размер (BE), имя с нулём.
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface BigEntry extends ArchiveEntry { off: number; size: number }

export async function openBigf(file: BlobFile): Promise<Archive> {
  const head = new DataView(await file.slice(0, 16).arrayBuffer());
  if (head.byteLength < 16) throw new Error(`${file.name}: не BIGF/VIV`);
  const magic = String.fromCharCode(...[0, 1, 2, 3].map((i) => head.getUint8(i)));
  if (magic !== 'BIGF' && magic !== 'BIG4') throw new Error(`${file.name}: не BIGF/VIV`);
  const count = head.getUint32(8, false), pool = head.getUint32(12, false);
  if (!count || count > 200000) throw new Error(`${file.name}: странное число файлов (${count})`);
  const dirLen = Math.min(pool > 16 ? pool - 16 : count * 64, 16 * 1024 * 1024);
  const u8 = await readRange(file, 16, 16 + dirLen), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), entries: BigEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 9 <= u8.length; i++) {
    const off = dv.getUint32(p, false), size = dv.getUint32(p + 4, false);
    p += 8;
    let n = '';
    while (p < u8.length && u8[p]) n += String.fromCharCode(u8[p++]!);
    p++;
    entries.push({ path: normPath(n), off, size });
  }
  return createArchive<BigEntry>({ name: file.name, kind: 'bigf', version: 0, entries, read: (e) => readRange(file, e.off, e.off + e.size) });
}
