// PCX (Quake II): 8 бит с палитрой в конце файла или 24 бит (3 плоскости), RLE.
import type { DecodedImage } from '../types';

export function decodePCX(buf: ArrayBuffer): DecodedImage {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (u8[0] !== 10 || u8[2] !== 1 || u8[3] !== 8) throw new Error('PCX: неподдерживаемый формат');
  const w = dv.getUint16(8, true) - dv.getUint16(4, true) + 1, h = dv.getUint16(10, true) - dv.getUint16(6, true) + 1;
  const planes = u8[65]!, bpl = dv.getUint16(66, true);
  const line = planes * bpl, data = new Uint8Array(line * h);
  let p = 128;
  for (let i = 0; i < data.length && p < u8.length;) {
    let c = u8[p++]!, n = 1;
    if ((c & 0xc0) === 0xc0) { n = c & 0x3f; c = u8[p++]!; }
    while (n-- > 0 && i < data.length) data[i++] = c;
  }
  const out = new Uint8Array(w * h * 4);
  const pal = planes === 1 && u8[u8.length - 769] === 12 ? u8.subarray(u8.length - 768) : null;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      let r: number, g: number, b: number;
      if (planes === 1) {
        const v = data[y * line + x]!;
        if (pal) { r = pal[v * 3]!; g = pal[v * 3 + 1]!; b = pal[v * 3 + 2]!; } else r = g = b = v;
      } else { r = data[y * line + x]!; g = data[y * line + bpl + x]!; b = data[y * line + 2 * bpl + x]!; }
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255;
    }
  return { width: w, height: h, rgba: out };
}
