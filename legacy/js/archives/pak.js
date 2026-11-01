// PAK (Quake / Quake II): «PACK», каталог из записей по 64 байта (имя[56], смещение, размер).
import { buildArchive } from './common.js';
import { normPath } from './bsa.js';

export async function openPak(file) {
  const h = new DataView(await file.slice(0, 12).arrayBuffer());
  if (h.getUint32(0, true) !== 0x4b434150) throw new Error(`${file.name}: не PAK (нет сигнатуры PACK)`);
  const dirOff = h.getUint32(4, true), dirLen = h.getUint32(8, true);
  const buf = await file.slice(dirOff, dirOff + dirLen).arrayBuffer(), dv = new DataView(buf), u8 = new Uint8Array(buf), entries = [];
  for (let o = 0; o + 64 <= dirLen; o += 64) {
    let n = ''; for (let i = 0; i < 56 && u8[o + i]; i++) n += String.fromCharCode(u8[o + i]);
    entries.push({ path: normPath(n), off: dv.getUint32(o + 56, true), size: dv.getUint32(o + 60, true) });
  }
  return buildArchive(file.name, 1, entries, async (e) => new Uint8Array(await file.slice(e.off, e.off + e.size).arrayBuffer()));
}
