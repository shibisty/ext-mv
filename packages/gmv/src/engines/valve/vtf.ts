// VTF (Source): старшее разрешение, первый кадр; форматы DXT1/3/5, BGRA/RGBA/BGR/RGB 8888/888, 565, I8, IA88, A8.
import { decodeDXT } from '../../core/images/dds';
import type { DecodedImage } from '../../core/types';

const VTF_BYTES: Record<number, number> = { 0: 4, 1: 4, 2: 3, 3: 3, 4: 2, 5: 1, 6: 2, 7: 1, 8: 1, 11: 4, 12: 4, 16: 4, 17: 2, 18: 2, 19: 2, 21: 2, 22: 2 };
function vtfSize(fmt: number, w: number, h: number): number {
  if (fmt === 13 || fmt === 20) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * 8;
  if (fmt === 14 || fmt === 15) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * 16;
  if (!(fmt in VTF_BYTES)) throw new Error('VTF: формат ' + fmt + ' не поддерживается');
  return w * h * VTF_BYTES[fmt]!;
}

export function decodeVTF(buf: ArrayBuffer): DecodedImage {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (buf.byteLength < 64 || dv.getUint32(0, true) !== 0x00465456) throw new Error('Не VTF');
  const headerSize = dv.getUint32(12, true), w = dv.getUint16(16, true), h = dv.getUint16(18, true), flags = dv.getUint32(20, true), frames = dv.getUint16(24, true) || 1;
  const fmt = dv.getInt32(52, true), mips = u8[56] || 1, lowFmt = dv.getInt32(57, true), lw = u8[61]!, lh = u8[62]!;
  let p = headerSize;
  if (lowFmt >= 0 && lw && lh) p += vtfSize(lowFmt, lw, lh);
  const faces = flags & 0x4000 ? 6 : 1;
  for (let m = mips - 1; m >= 1; m--) p += vtfSize(fmt, Math.max(1, w >> m), Math.max(1, h >> m)) * frames * faces;
  if (fmt === 13 || fmt === 20 || fmt === 14 || fmt === 15) return { width: w, height: h, rgba: decodeDXT(dv, p, w, h, fmt === 14 ? 3 : fmt === 15 ? 5 : 1) };
  const bp = VTF_BYTES[fmt];
  if (!bp) throw new Error('VTF: формат ' + fmt + ' не поддерживается');
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = p + i * bp;
    let r = 0, g = 0, b = 0, a = 255;
    switch (fmt) {
      case 0: r = u8[o]!; g = u8[o + 1]!; b = u8[o + 2]!; a = u8[o + 3]!; break;
      case 1: a = u8[o]!; b = u8[o + 1]!; g = u8[o + 2]!; r = u8[o + 3]!; break;
      case 2: r = u8[o]!; g = u8[o + 1]!; b = u8[o + 2]!; break;
      case 3: b = u8[o]!; g = u8[o + 1]!; r = u8[o + 2]!; break;
      case 11: a = u8[o]!; r = u8[o + 1]!; g = u8[o + 2]!; b = u8[o + 3]!; break;
      case 12: b = u8[o]!; g = u8[o + 1]!; r = u8[o + 2]!; a = u8[o + 3]!; break;
      case 16: b = u8[o]!; g = u8[o + 1]!; r = u8[o + 2]!; break;
      case 4: { const v = dv.getUint16(o, true); r = ((v >> 11) * 255) / 31; g = (((v >> 5) & 63) * 255) / 63; b = ((v & 31) * 255) / 31; break; }
      case 17: { const v = dv.getUint16(o, true); b = ((v >> 11) * 255) / 31; g = (((v >> 5) & 63) * 255) / 63; r = ((v & 31) * 255) / 31; break; }
      case 5: case 7: r = g = b = u8[o]!; break;
      case 8: a = u8[o]!; break;
      case 6: r = g = b = u8[o]!; a = u8[o + 1]!; break;
      default: throw new Error('VTF: формат ' + fmt + ' не поддерживается');
    }
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return { width: w, height: h, rgba: out };
}
