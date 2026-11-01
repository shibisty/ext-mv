// TXD (Texture Dictionary): GTA III / VC / SA на PC (D3D8/D3D9). Все текстуры декодируются в RGBA.
import { chunks, cstr } from './chunks.js';
import { decodeDXT } from '../images.js';

const FOURCC = { 0x31545844: 1, 0x33545844: 3, 0x35545844: 5 };
const mipBytes = (w, h, kind) => kind ? Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * (kind === 1 ? 8 : 16) : 0;

function decodeNative(buf, c) {
  const kids = chunks(buf, c.start, c.end), st = kids.find((k) => k.type === 1);
  if (!st) return null;
  const dv = new DataView(buf), u8 = new Uint8Array(buf); let p = st.start;
  const platform = dv.getUint32(p, true); p += 8;                       // platform, filter flags
  if (platform !== 8 && platform !== 9) throw new Error('платформа TXD ' + platform + ' не поддерживается (нужен PC D3D8/D3D9)');
  const name = cstr(u8, p, p + 32).toLowerCase(); p += 64;
  const raster = dv.getUint32(p, true); p += 4;
  const d3dFmt = dv.getUint32(p, true); p += 4;
  const w = dv.getUint16(p, true), h = dv.getUint16(p + 2, true), depth = u8[p + 4], mips = u8[p + 5], comp = u8[p + 7]; p += 8;
  let kind = FOURCC[d3dFmt] || ({ 1: 1, 2: 3, 3: 3, 4: 5, 5: 5 })[comp] || 0;
  const pal8 = (raster & 0x2000) !== 0, pal4 = (raster & 0x4000) !== 0;
  let palette = null;
  if (pal8) { palette = u8.subarray(p, p + 1024); p += 1024; } else if (pal4) { palette = u8.subarray(p, p + 64); p += 128; }
  if (!mips) return null;
  const size0 = dv.getUint32(p, true); p += 4;
  const out = new Uint8Array(w * h * 4);
  if (kind && size0 !== mipBytes(w, h, kind)) kind = 0;
  if (kind) return { name, width: w, height: h, rgba: decodeDXT(dv, p, w, h, kind) };
  const fmt = raster & 0xf00;
  for (let i = 0; i < w * h; i++) {
    let r = 0, g = 0, b = 0, a = 255;
    if (pal8) { const q = u8[p + i] * 4; r = palette[q]; g = palette[q + 1]; b = palette[q + 2]; a = palette[q + 3]; }
    else if (pal4) { const v = u8[p + (i >> 1)], q = ((i & 1) ? v >> 4 : v & 15) * 4; r = palette[q]; g = palette[q + 1]; b = palette[q + 2]; a = palette[q + 3]; }
    else if (fmt === 0x500 || fmt === 0x600) { const o = p + i * 4; b = u8[o]; g = u8[o + 1]; r = u8[o + 2]; a = fmt === 0x500 ? u8[o + 3] : 255; }
    else if (fmt === 0x100 || fmt === 0xa00) { const v = dv.getUint16(p + i * 2, true); r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31; a = fmt === 0x100 ? ((v >> 15) ? 255 : 0) : 255; }
    else if (fmt === 0x200) { const v = dv.getUint16(p + i * 2, true); r = (v >> 11) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; b = (v & 31) * 255 / 31; }
    else if (fmt === 0x300) { const v = dv.getUint16(p + i * 2, true); a = (v >> 12) * 17; r = ((v >> 8) & 15) * 17; g = ((v >> 4) & 15) * 17; b = (v & 15) * 17; }
    else if (fmt === 0x400) { r = g = b = u8[p + i]; }
    else throw new Error('неизвестный формат растра 0x' + raster.toString(16));
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return { name, width: w, height: h, rgba: out };
}

export function parseTxd(buf) {
  const top = chunks(buf, 0, buf.byteLength).find((c) => c.type === 0x16);
  if (!top) throw new Error('Не TXD (нет Texture Dictionary)');
  const list = [], errors = [];
  for (const c of chunks(buf, top.start, top.end)) {
    if (c.type !== 0x15) continue;
    try { const t = decodeNative(buf, c); if (t) list.push(t); } catch (e) { errors.push(e.message); }
  }
  return { textures: list, errors };
}
