// BSA (TES4-формат): Oblivion v103, Fallout 3 / New Vegas / Skyrim LE v104, Skyrim SE v105.
import { ascii, normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import { inflateZlib } from '../../core/codecs/zlib';
import { lz4Frame } from '../../core/codecs/lz4';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface BsaEntry extends ArchiveEntry { off: number; size: number; compressed: boolean }

export async function openBsa(file: BlobFile): Promise<Archive> {
  const h = new DataView(await file.slice(0, 36).arrayBuffer());
  if (h.byteLength < 36 || h.getUint32(0, true) !== 0x00415342) throw new Error(`${file.name}: не BSA (TES4+)`);
  const version = h.getUint32(4, true), dirOff = h.getUint32(8, true), flags = h.getUint32(12, true);
  const folderCount = h.getUint32(16, true), fileCount = h.getUint32(20, true), totalFolderName = h.getUint32(24, true), totalFileName = h.getUint32(28, true);
  if (![103, 104, 105].includes(version)) throw new Error(`${file.name}: версия BSA ${version} не поддерживается`);
  if (!(flags & 1) || !(flags & 2)) throw new Error(`${file.name}: в архиве нет имён папок/файлов`);
  const rec = version === 105 ? 24 : 16;
  const size = folderCount * rec + totalFolderName + folderCount + fileCount * 16 + totalFileName;
  const u8 = await readRange(file, dirOff, dirOff + size), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const counts: number[] = [];
  for (let i = 0; i < folderCount; i++) { counts.push(dv.getUint32(p + 8, true)); p += rec; }
  const files: Array<{ dir: string; size: number; off: number }> = [];
  for (let i = 0; i < folderCount; i++) {
    const len = u8[p]!;
    const dir = ascii(u8, p + 1, p + len); // len включает завершающий 0
    p += 1 + len;
    for (let j = 0; j < counts[i]!; j++) { files.push({ dir, size: dv.getUint32(p + 8, true), off: dv.getUint32(p + 12, true) }); p += 16; }
  }
  const defaultComp = !!(flags & 4), embed = !!(flags & 0x100) && version !== 103;
  const entries: BsaEntry[] = [];
  for (const f of files) {
    let q = p;
    while (u8[q] !== 0 && q < u8.length) q++;
    const name = ascii(u8, p, q);
    p = q + 1;
    entries.push({ path: normPath(f.dir ? f.dir + '\\' + name : name), off: f.off, size: f.size & 0x3fffffff, compressed: defaultComp !== !!(f.size & 0x40000000) });
  }
  return createArchive<BsaEntry>({
    name: file.name,
    kind: 'bsa',
    version,
    entries,
    async read(e) {
      const u = await readRange(file, e.off, e.off + e.size);
      let o = embed ? 1 + u[0]! : 0;
      if (!e.compressed) return u.subarray(o);
      const orig = new DataView(u.buffer, u.byteOffset).getUint32(o, true);
      o += 4;
      return version === 105 ? lz4Frame(u.subarray(o), orig) : inflateZlib(u.subarray(o));
    },
  });
}
