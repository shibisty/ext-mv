// Словарь текстур RAGE (.ytd и встроенный в drawable): DXT1/3/5, ATI1/ATI2 (BC4/BC5), BC7, A8R8G8B8, L8, A8.
import { decodeDXT } from '../../core/images/dds';
import { decodeBC7 } from '../../core/images/bc7';
import type { DecodedImage } from '../../core/types';
import type { Resource } from './rsc';

const FOURCC = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
const DXT1 = FOURCC('DXT1'), DXT3 = FOURCC('DXT3'), DXT5 = FOURCC('DXT5'), ATI1 = FOURCC('ATI1'), ATI2 = FOURCC('ATI2'), BC7 = FOURCC('BC7 ');

/** Блок «альфа DXT5» (BC4): 8 байт -> 16 значений. */
function bc4Block(u8: Uint8Array, p: number, out: Uint8Array) {
  const a0 = u8[p]!, a1 = u8[p + 1]!, lut = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) for (let i = 1; i <= 6; i++) lut[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
  else { for (let i = 1; i <= 4; i++) lut[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0; lut[6] = 0; lut[7] = 255; }
  let bits = 0, nb = 0, q = p + 2;
  for (let i = 0; i < 16; i++) {
    if (nb < 3) { bits |= u8[q++]! << nb; nb += 8; }
    out[i] = lut[bits & 7]!;
    bits >>>= 3; nb -= 3;
  }
}
export function decodeBC45(u8: Uint8Array, off: number, w: number, h: number, two: boolean): Uint8Array {
  const out = new Uint8Array(w * h * 4), r = new Uint8Array(16), g = new Uint8Array(16), bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  let p = off;
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      bc4Block(u8, p, r); p += 8;
      if (two) { bc4Block(u8, p, g); p += 8; }
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
        if (x >= w || y >= h) continue;
        const o = (y * w + x) * 4;
        if (two) { out[o] = r[i]!; out[o + 1] = g[i]!; const nx = r[i]! / 127.5 - 1, ny = g[i]! / 127.5 - 1; out[o + 2] = Math.round((Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.5 + 0.5) * 255); }
        else out[o] = out[o + 1] = out[o + 2] = r[i]!;
        out[o + 3] = 255;
      }
    }
  return out;
}

export interface RageTexture extends DecodedImage { name: string; format: string }

const fmtName = (f: number) => (f > 0xffff ? String.fromCharCode(f & 255, (f >> 8) & 255, (f >> 16) & 255, f >>> 24).trim() : `D3DFMT ${f}`);

/** Декодировать текстуру по смещению (Texture, 0x90 байт). maxSide — предел размера (берётся подходящий мип). */
export function decodeTexture(r: Resource, t: number, maxSide = 2048): RageTexture {
  const name = r.str(r.ptr(t + 0x28));
  let w = r.u16(t + 0x50), h = r.u16(t + 0x52);
  const fmt = r.u32(t + 0x58), levels = Math.max(1, r.u8at(t + 0x5d));
  let p = r.ptr(t + 0x70);
  if (!p) throw new Error(`${name}: нет данных`);
  const block = fmt === DXT1 || fmt === ATI1 ? 8 : fmt === DXT3 || fmt === DXT5 || fmt === ATI2 || fmt === BC7 ? 16 : 0;
  const bpp = fmt === 21 || fmt === 22 || fmt === 32 ? 4 : fmt === 50 || fmt === 28 ? 1 : 0;
  if (!block && !bpp) throw new Error(`${name}: формат ${fmtName(fmt)} не поддержан`);
  const size = (a: number, b: number) => (block ? Math.max(1, (a + 3) >> 2) * Math.max(1, (b + 3) >> 2) * block : a * b * bpp);
  for (let l = 1; l < levels && Math.max(w, h) > maxSide; l++) { p += size(w, h); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
  if (p + size(w, h) > r.u8.length) throw new Error(`${name}: данные за пределами ресурса`);
  let rgba: Uint8Array;
  if (fmt === DXT1 || fmt === DXT3 || fmt === DXT5) rgba = decodeDXT(new DataView(r.u8.buffer, r.u8.byteOffset + p), 0, w, h, fmt === DXT1 ? 1 : fmt === DXT3 ? 3 : 5);
  else if (fmt === ATI1 || fmt === ATI2) rgba = decodeBC45(r.u8, p, w, h, fmt === ATI2);
  else if (fmt === BC7) rgba = decodeBC7(r.u8, p, w, h);
  else {
    rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      if (bpp === 4) {
        const b = r.u8[p + i * 4]!, g = r.u8[p + i * 4 + 1]!, rr = r.u8[p + i * 4 + 2]!, a = r.u8[p + i * 4 + 3]!;
        if (fmt === 32) { rgba[i * 4] = b; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = rr; } else { rgba[i * 4] = rr; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; }
        rgba[i * 4 + 3] = fmt === 22 ? 255 : a;
      } else { const v = r.u8[p + i]!; if (fmt === 28) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = v; } else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; } }
    }
  }
  return { name, width: w, height: h, rgba, format: fmtName(fmt) };
}

/** Все текстуры словаря по смещению (TextureDictionary: 0x30 — список текстур). */
export function readTextureDictionary(r: Resource, at = 0): { textures: RageTexture[]; errors: string[] } {
  const textures: RageTexture[] = [], errors: string[] = [];
  for (const t of r.ptrList(at + 0x30)) {
    if (!t) continue;
    try { textures.push(decodeTexture(r, t)); } catch (e) { errors.push((e as Error).message); }
  }
  return { textures, errors };
}
