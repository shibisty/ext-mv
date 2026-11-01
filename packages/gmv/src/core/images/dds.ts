// DDS: DXT1/3/5 (BC1–3), DX10 (BC1–3, RGBA8/BGRA8), несжатые 16/24/32 бит с масками.
import type { DecodedImage } from '../types';

/** 1 — DXT1, 3 — DXT3, 5 — DXT5. */
export type DxtKind = 1 | 3 | 5;

function maskInfo(m: number): { s: number; max: number } {
  if (!m) return { s: 0, max: 0 };
  let s = 0;
  while (!((m >>> s) & 1)) s++;
  let b = 0;
  while ((m >>> (s + b)) & 1) b++;
  return { s, max: 2 ** b - 1 };
}

const cc = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

export function decodeDDS(buf: ArrayBuffer): DecodedImage {
  const dv = new DataView(buf);
  if (buf.byteLength < 128 || dv.getUint32(0, true) !== 0x20534444) throw new Error('Не DDS файл');
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
  const pfFlags = dv.getUint32(80, true), fourCC = dv.getUint32(84, true), bits = dv.getUint32(88, true);
  let off = 128, kind = 0;
  if (pfFlags & 4) {
    if (fourCC === cc('DXT1')) kind = 1;
    else if (fourCC === cc('DXT2') || fourCC === cc('DXT3')) kind = 3;
    else if (fourCC === cc('DXT4') || fourCC === cc('DXT5')) kind = 5;
    else if (fourCC === cc('DX10')) {
      const f = dv.getUint32(128, true);
      off = 148;
      if (f === 71 || f === 72) kind = 1;
      else if (f === 74 || f === 75) kind = 3;
      else if (f === 77 || f === 78) kind = 5;
      else if (f === 28 || f === 29) kind = -1;
      else if (f === 87 || f === 91) kind = -2;
      else throw new Error('Неподдерживаемый DXGI формат DDS: ' + f);
    } else throw new Error('Неподдерживаемый fourCC DDS');
  }
  if (kind > 0) return { width: w, height: h, rgba: decodeDXT(dv, off, w, h, kind as DxtKind) };
  const out = new Uint8Array(w * h * 4);
  if (kind === -1 || kind === -2) {
    for (let i = 0; i < w * h; i++) {
      const o = off + i * 4;
      const r = dv.getUint8(o), g = dv.getUint8(o + 1), b = dv.getUint8(o + 2), a = dv.getUint8(o + 3);
      out.set(kind === -1 ? [r, g, b, a] : [b, g, r, a], i * 4);
    }
    return { width: w, height: h, rgba: out };
  }
  const bpp = bits >> 3;
  if (bpp === 1) {
    // 8 бит: яркость (L8, DDPF_LUMINANCE — карты блеска MudRunner) или только альфа (A8)
    const alphaOnly = !(pfFlags & 0x20000) && !(pfFlags & 0x40) && !!(pfFlags & 0x2);
    for (let i = 0; i < w * h; i++) { const v = dv.getUint8(off + i); out.set(alphaOnly ? [255, 255, 255, v] : [v, v, v, 255], i * 4); }
    return { width: w, height: h, rgba: out };
  }
  if (![2, 3, 4].includes(bpp)) throw new Error('Неподдерживаемый несжатый DDS (' + bits + ' бит)');
  const rm = dv.getUint32(92, true), gm = dv.getUint32(96, true), bm = dv.getUint32(100, true), am = pfFlags & 1 ? dv.getUint32(104, true) : 0;
  const R = maskInfo(rm), G = maskInfo(gm), B = maskInfo(bm), A = maskInfo(am);
  const sc = (v: number, m: { s: number; max: number }) => (m.max ? Math.round((((v >>> m.s) & m.max) * 255) / m.max) : 255);
  for (let i = 0; i < w * h; i++) {
    let px = 0;
    for (let k = 0; k < bpp; k++) px |= dv.getUint8(off + i * bpp + k) << (8 * k);
    out[i * 4] = sc(px & rm, R);
    out[i * 4 + 1] = sc(px & gm, G);
    out[i * 4 + 2] = sc(px & bm, B);
    out[i * 4 + 3] = A.max ? sc(px & am, A) : 255;
  }
  return { width: w, height: h, rgba: out };
}

/** Распаковка блоков DXT1/3/5 в RGBA. */
export function decodeDXT(dv: DataView, off: number, w: number, h: number, kind: DxtKind): Uint8Array {
  const out = new Uint8Array(w * h * 4), bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  const cr = [0, 0, 0, 0], cg = [0, 0, 0, 0], cb = [0, 0, 0, 0], ca = [255, 255, 255, 255], al = new Uint8Array(16);
  let p = off;
  const c565 = (c: number) => [(((c >> 11) & 31) * 255) / 31 | 0, (((c >> 5) & 63) * 255) / 63 | 0, ((c & 31) * 255) / 31 | 0];
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      if (kind === 3) {
        for (let i = 0; i < 8; i++) { const b = dv.getUint8(p + i); al[2 * i] = (b & 15) * 17; al[2 * i + 1] = (b >> 4) * 17; }
        p += 8;
      } else if (kind === 5) {
        const a0 = dv.getUint8(p), a1 = dv.getUint8(p + 1), lut = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) for (let i = 1; i <= 6; i++) lut[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
        else { for (let i = 1; i <= 4; i++) lut[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0; lut[6] = 0; lut[7] = 255; }
        const lo = dv.getUint32(p + 2, true), hi = dv.getUint16(p + 6, true);
        for (let i = 0; i < 16; i++) {
          const bit = i * 3;
          let idx: number;
          if (bit <= 29) idx = (lo >>> bit) & 7;
          else if (bit === 30) idx = ((lo >>> 30) | (hi << 2)) & 7;
          else idx = (hi >>> (bit - 32)) & 7;
          al[i] = lut[idx]!;
        }
        p += 8;
      }
      const c0 = dv.getUint16(p, true), c1 = dv.getUint16(p + 2, true), bits = dv.getUint32(p + 4, true);
      p += 8;
      const k0 = c565(c0), k1 = c565(c1);
      for (let k = 0; k < 3; k++) {
        const arr = [cr, cg, cb][k]!;
        arr[0] = k0[k]!; arr[1] = k1[k]!;
        if (kind > 1 || c0 > c1) { arr[2] = (2 * k0[k]! + k1[k]!) / 3 | 0; arr[3] = (k0[k]! + 2 * k1[k]!) / 3 | 0; }
        else { arr[2] = (k0[k]! + k1[k]!) >> 1; arr[3] = 0; }
      }
      ca[3] = kind === 1 && c0 <= c1 ? 0 : 255;
      for (let py = 0; py < 4; py++)
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= w || y >= h) continue;
          const idx = (bits >>> (2 * (py * 4 + px))) & 3, o = (y * w + x) * 4;
          out[o] = cr[idx]!; out[o + 1] = cg[idx]!; out[o + 2] = cb[idx]!;
          out[o + 3] = kind === 1 ? ca[idx]! : al[py * 4 + px]!;
        }
    }
  return out;
}
