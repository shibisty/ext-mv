// VPK Troika (Vampire: The Masquerade – Bloodlines): packNNN.vpk — данные подряд, каталог в конце файла.
// Хвост 9 байт: u32 число файлов, u32 смещение каталога, u8 версия (0). Запись: u32 длина имени, имя, u32 смещение, u32 размер.
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface TroikaEntry extends ArchiveEntry { offset: number; length: number }

export const TROIKA_VPK_RE = /^pack\d{3}\.vpk$/i;

export async function openTroikaVpk(file: BlobFile): Promise<Archive> {
  if (file.size < 9) throw new Error(`${file.name}: не VPK`);
  const tail = new DataView(await file.slice(file.size - 9).arrayBuffer());
  const count = tail.getUint32(0, true), dirOff = tail.getUint32(4, true);
  if (dirOff > file.size - 9 || count > 1e6) throw new Error(`${file.name}: не VPK Troika`);
  const dir = await readRange(file, dirOff, file.size - 9), dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength), entries: TroikaEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 4 > dir.length) throw new Error(`${file.name}: каталог VPK обрезан`);
    const n = dv.getUint32(p, true); p += 4;
    if (n > 1024 || p + n + 8 > dir.length) throw new Error(`${file.name}: каталог VPK повреждён`);
    let name = '';
    for (let k = 0; k < n; k++) { const c = dir[p + k]!; if (c) name += String.fromCharCode(c); }
    p += n;
    const offset = dv.getUint32(p, true), length = dv.getUint32(p + 4, true); p += 8;
    if (offset + length > dirOff) continue;
    entries.push({ path: normPath(name).replace(/^\/+/, ''), size: length, offset, length });
  }
  return createArchive<TroikaEntry>({
    name: file.name, kind: 'vpk', version: 0, entries,
    read: (e) => readRange(file, e.offset, e.offset + e.length),
  });
}
