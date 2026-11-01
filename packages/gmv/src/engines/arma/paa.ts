// PAA/PAC (текстуры Arma/DayZ/OFP): тип u16, теги «GGAT», палитра, мипмапы (u16 w, u16 h, u24 размер).
// DXT1–5: бит 0x8000 ширины — данные сжаты LZO. ARGB4444/1555/8888, AI88: LZSS, если размер меньше ожидаемого.
import { decodeDXT, type DxtKind } from '../../core/images/dds';
import { lzo1xDecompress } from '../../core/codecs/lzo';
import type { DecodedImage } from '../../core/types';
import { lzssDecompress } from './lzss';

const TYPES: Record<number, { name: string; dxt?: DxtKind; bpp?: number }> = {
  0xff01: { name: 'DXT1', dxt: 1 }, 0xff02: { name: 'DXT2', dxt: 3 }, 0xff03: { name: 'DXT3', dxt: 3 }, 0xff04: { name: 'DXT4', dxt: 5 }, 0xff05: { name: 'DXT5', dxt: 5 },
  0x4444: { name: 'ARGB4444', bpp: 2 }, 0x1555: { name: 'ARGB1555', bpp: 2 }, 0x8888: { name: 'ARGB8888', bpp: 4 }, 0x8080: { name: 'AI88', bpp: 2 },
};

export interface PaaInfo { type: string; mips: Array<{ w: number; h: number; off: number; size: number; lzo: boolean }>; avgColor?: number }

export function paaInfo(u8: Uint8Array): PaaInfo {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const t = TYPES[dv.getUint16(0, true)];
  if (!t) throw new Error(`PAA: неизвестный тип 0x${dv.getUint16(0, true).toString(16)}`);
  let p = 2, avgColor: number | undefined;
  while (p + 12 <= u8.length && u8[p] === 0x47 && u8[p + 1] === 0x47 && u8[p + 2] === 0x41 && u8[p + 3] === 0x54) { // GGAT
    const tag = String.fromCharCode(u8[p + 4]!, u8[p + 5]!, u8[p + 6]!, u8[p + 7]!), len = dv.getUint32(p + 8, true);
    if (tag === 'CGVA' && len >= 4) avgColor = dv.getUint32(p + 12, true);
    p += 12 + len;
  }
  p += 2 + 3 * dv.getUint16(p, true); // палитра
  const mips: PaaInfo['mips'] = [];
  while (p + 4 <= u8.length) {
    let w = dv.getUint16(p, true);
    const h = dv.getUint16(p + 2, true);
    if (!w && !h) break;
    const lzo = !!(w & 0x8000);
    w &= 0x7fff;
    const size = u8[p + 4]! | (u8[p + 5]! << 8) | (u8[p + 6]! << 16);
    mips.push({ w, h, off: p + 7, size, lzo });
    p += 7 + size;
  }
  return { type: t.name, mips, avgColor };
}

/** Декодировать PAA: берётся наибольший мип не крупнее maxSide (экономия памяти на 4K-текстурах). */
export function decodePaa(buf: ArrayBuffer, maxSide = 2048): DecodedImage {
  const u8 = new Uint8Array(buf), info = paaInfo(u8), t = TYPES[new DataView(buf).getUint16(0, true)]!;
  const mip = info.mips.find((m) => Math.max(m.w, m.h) <= maxSide) ?? info.mips[info.mips.length - 1];
  if (!mip) throw new Error('PAA: нет мипмапов');
  const { w, h } = mip;
  if (t.dxt) {
    const need = Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * (t.dxt === 1 ? 8 : 16);
    let data = u8.subarray(mip.off, mip.off + mip.size);
    if (mip.lzo) { const out = new Uint8Array(need); lzo1xDecompress(u8, mip.off, out); data = out; }
    return { width: w, height: h, rgba: decodeDXT(new DataView(data.buffer, data.byteOffset, data.byteLength), 0, w, h, t.dxt) };
  }
  const need = w * h * t.bpp!;
  const data = lzssDecompress(u8, mip.off, need, true).data; // несжатые форматы в PAA всегда упакованы LZSS
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r = 0, g = 0, b = 0, a = 255;
    if (t.bpp === 4) { b = data[i * 4]!; g = data[i * 4 + 1]!; r = data[i * 4 + 2]!; a = data[i * 4 + 3]!; }
    else {
      const v = data[i * 2]! | (data[i * 2 + 1]! << 8);
      if (t.name === 'ARGB4444') { b = (v & 15) * 17; g = ((v >> 4) & 15) * 17; r = ((v >> 8) & 15) * 17; a = ((v >> 12) & 15) * 17; }
      else if (t.name === 'ARGB1555') { b = ((v & 31) * 255) / 31; g = (((v >> 5) & 31) * 255) / 31; r = (((v >> 10) & 31) * 255) / 31; a = v & 0x8000 ? 255 : 0; }
      else { r = g = b = v & 255; a = v >> 8; } // AI88
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width: w, height: h, rgba };
}
