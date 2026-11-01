// TGA: truecolor / grayscale / colormap, с RLE и без; ориентация по биту 5 дескриптора.
import type { DecodedImage } from '../types';

export function decodeTGA(buf: ArrayBuffer): DecodedImage {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (buf.byteLength < 18) throw new Error('TGA: файл слишком короткий');
  const idLen = u8[0]!, cmType = u8[1]!, type = u8[2]!, cmLen = dv.getUint16(5, true), cmBits = u8[7]!;
  const w = dv.getUint16(12, true), h = dv.getUint16(14, true), bpp = u8[16]!, top = (u8[17]! & 0x20) !== 0;
  if (![1, 2, 3, 9, 10, 11].includes(type) || !w || !h) throw new Error('TGA: неподдерживаемый тип ' + type);
  let p = 18 + idLen, pal: Uint8Array | null = null;
  const cmBytes = cmBits >> 3;
  if (cmType === 1) { pal = u8.subarray(p, p + cmLen * cmBytes); p += cmLen * cmBytes; }
  const bp = bpp >> 3, raw = new Uint8Array(w * h * bp), rle = type >= 9;
  if (!rle) raw.set(u8.subarray(p, p + raw.length));
  else
    for (let i = 0; i < raw.length;) {
      const c = u8[p++]!, n = (c & 0x7f) + 1;
      if (c & 0x80) { for (let k = 0; k < n && i < raw.length; k++) for (let b = 0; b < bp; b++) raw[i++] = u8[p + b]!; p += bp; }
      else for (let k = 0; k < n * bp && i < raw.length; k++) raw[i++] = u8[p++]!;
    }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dy = top ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * bp, d = (dy * w + x) * 4;
      let r: number, g: number, b: number, a = 255;
      if (pal) { const q = raw[s]! * cmBytes; b = pal[q]!; g = pal[q + 1]!; r = pal[q + 2]!; if (cmBytes === 4) a = pal[q + 3]!; }
      else if (bp === 1) r = g = b = raw[s]!;
      else if (bp === 2) { const v = raw[s]! | (raw[s + 1]! << 8); r = (((v >> 10) & 31) * 255) / 31; g = (((v >> 5) & 31) * 255) / 31; b = ((v & 31) * 255) / 31; }
      else { b = raw[s]!; g = raw[s + 1]!; r = raw[s + 2]!; if (bp === 4) a = raw[s + 3]!; }
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    }
  }
  return { width: w, height: h, rgba: out };
}
