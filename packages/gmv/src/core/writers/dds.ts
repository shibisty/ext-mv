// DDS без сжатия (A8R8G8B8) с цепочкой mip-уровней (усреднение 2×2). Читается DirectX, движками и редакторами.
import type { DecodedImage } from '../types';

export function encodeDdsRgba(img: { width: number; height: number; rgba: Uint8Array }, mips = true): Uint8Array {
  const levels: Array<{ w: number; h: number; px: Uint8Array }> = [{ w: img.width, h: img.height, px: img.rgba }];
  while (mips) {
    const { w, h, px } = levels[levels.length - 1]!;
    if (w === 1 && h === 1) break;
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
      let s = 0, n = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const sx = Math.min(w - 1, x * 2 + dx!), sy = Math.min(h - 1, y * 2 + dy!); s += px[(sy * w + sx) * 4 + c]!; n++; }
      out[(y * nw + x) * 4 + c] = Math.round(s / n);
    }
    levels.push({ w: nw, h: nh, px: out });
  }
  const size = levels.reduce((a, l) => a + l.w * l.h * 4, 0), u = new Uint8Array(128 + size), dv = new DataView(u.buffer);
  dv.setUint32(0, 0x20534444, true); dv.setUint32(4, 124, true);
  dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x8 | (levels.length > 1 ? 0x20000 : 0), true); // CAPS|HEIGHT|WIDTH|PIXELFORMAT|PITCH|MIPMAPCOUNT
  dv.setUint32(12, img.height, true); dv.setUint32(16, img.width, true); dv.setUint32(20, img.width * 4, true);
  dv.setUint32(28, levels.length, true);
  dv.setUint32(76, 32, true); dv.setUint32(80, 0x41, true); dv.setUint32(88, 32, true); // RGB | ALPHAPIXELS, 32 бита
  dv.setUint32(92, 0x00ff0000, true); dv.setUint32(96, 0x0000ff00, true); dv.setUint32(100, 0x000000ff, true); dv.setUint32(104, 0xff000000, true);
  dv.setUint32(108, 0x1000 | (levels.length > 1 ? 0x400008 : 0), true); // TEXTURE | MIPMAP | COMPLEX
  let p = 128;
  for (const l of levels) for (let i = 0; i < l.w * l.h; i++) { u[p++] = l.px[i * 4 + 2]!; u[p++] = l.px[i * 4 + 1]!; u[p++] = l.px[i * 4]!; u[p++] = l.px[i * 4 + 3]!; }
  return u;
}

/** Есть ли в картинке полупрозрачные пиксели. */
export function hasAlpha(img: DecodedImage): boolean {
  const d = img.rgba;
  if (!d) return false;
  for (let i = 3; i < d.length; i += 16) if (d[i]! < 250) return true;
  return false;
}
