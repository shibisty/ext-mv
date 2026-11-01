// PAK (Quake / Quake II): «PACK», каталог из записей по 64 байта (имя[56], смещение, размер).
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface PakEntry extends ArchiveEntry { off: number; size: number }

export async function openPak(file: BlobFile): Promise<Archive> {
  const h = new DataView(await file.slice(0, 12).arrayBuffer());
  if (h.byteLength < 12 || h.getUint32(0, true) !== 0x4b434150) throw new Error(`${file.name}: не PAK (нет сигнатуры PACK)`);
  const dirOff = h.getUint32(4, true), dirLen = h.getUint32(8, true);
  const u8 = await readRange(file, dirOff, dirOff + dirLen), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), entries: PakEntry[] = [];
  for (let o = 0; o + 64 <= dirLen; o += 64) {
    let n = '';
    for (let i = 0; i < 56 && u8[o + i]; i++) n += String.fromCharCode(u8[o + i]!);
    entries.push({ path: normPath(n), off: dv.getUint32(o + 56, true), size: dv.getUint32(o + 60, true) });
  }
  return createArchive<PakEntry>({ name: file.name, kind: 'pak', version: 1, entries, read: (e) => readRange(file, e.off, e.off + e.size) });
}
