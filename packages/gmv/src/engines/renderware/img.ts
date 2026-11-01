// IMG: v1 (GTA III / Vice City: .dir + .img) и v2 (San Andreas: «VER2»). Размеры и смещения — в секторах по 2048 байт.
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

const SECTOR = 2048;
const name24 = (u8: Uint8Array, a: number) => { let s = ''; for (let i = 0; i < 24 && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]!); return s.toLowerCase(); };
interface ImgEntry extends ArchiveEntry { off: number; size: number }

export async function openImg(imgFile: BlobFile, dirFile?: BlobFile | null): Promise<Archive> {
  const head = await readRange(imgFile, 0, 8);
  const v2 = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!) === 'VER2';
  const entries: ImgEntry[] = [];
  if (v2) {
    const count = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
    const u8 = await readRange(imgFile, 8, 8 + count * 32), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0; i < count; i++) {
      const o = i * 32, streaming = dv.getUint16(o + 4, true), inArch = dv.getUint16(o + 6, true);
      entries.push({ path: name24(u8, o + 8), off: dv.getUint32(o, true) * SECTOR, size: (inArch || streaming) * SECTOR });
    }
  } else {
    if (!dirFile) throw new Error(`${imgFile.name}: для IMG v1 (GTA III/VC) выберите вместе с ним одноимённый .dir`);
    const u8 = new Uint8Array(await dirFile.arrayBuffer()), dv = new DataView(u8.buffer);
    for (let o = 0; o + 32 <= u8.length; o += 32)
      entries.push({ path: name24(u8, o + 8), off: dv.getUint32(o, true) * SECTOR, size: dv.getUint32(o + 4, true) * SECTOR });
  }
  return createArchive<ImgEntry>({
    name: imgFile.name, kind: 'img', version: v2 ? 2 : 1, entries,
    read: (e) => readRange(imgFile, e.off, e.off + e.size),
    textureKeys: () => [],
  });
}
