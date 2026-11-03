// Текстуры Dunia (Far Cry 2) .xbt: «TBX\0», u32 версия 0x0b, u32 смещение DDS (размер заголовка), u32 2, 12 байт,
// путь «…_mip0.xbt» (если старший уровень лежит отдельным файлом) — и обычный DDS (DXT1/DXT5, мипы).
import { decodeDDS } from '../../core/images/dds';
import type { DecodedImage } from '../../core/types';

export function xbtDds(buf: ArrayBuffer): ArrayBuffer {
  const dv = new DataView(buf);
  if (buf.byteLength < 0x20 || dv.getUint32(0, true) !== 0x00584254) throw new Error('Не текстура Dunia (нет «TBX»)');
  const off = dv.getUint32(8, true);
  if (off + 128 > buf.byteLength || dv.getUint32(off, true) !== 0x20534444) throw new Error('XBT: нет DDS после заголовка');
  return buf.slice(off);
}

export const decodeXbt = (buf: ArrayBuffer): DecodedImage => decodeDDS(xbtDds(buf));
