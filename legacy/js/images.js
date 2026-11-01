// Загрузка текстур: DDS (DXT1/3/5, BC1-3, несжатые RGB/RGBA) декодируется в RGBA; PNG/JPG/BMP/WebP — через браузер.
export async function loadImage(file) {
  if (file.decoded) return file.decoded;   // уже декодированная текстура (например, из TXD)
  const buf = await file.arrayBuffer();
  if (/\.dds$/i.test(file.name)) return decodeDDS(buf);
  if (/\.tga$/i.test(file.name)) return decodeTGA(buf);
  if (/\.vtf$/i.test(file.name)) return decodeVTF(buf);
  if (/\.pcx$/i.test(file.name)) return decodePCX(buf);
  const bitmap = await createImageBitmap(new Blob([buf]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

function maskInfo(m) {
  if (!m) return { s: 0, max: 0 };
  let s = 0; while (!((m >>> s) & 1)) s++;
  let b = 0; while ((m >>> (s + b)) & 1) b++;
  return { s, max: (2 ** b) - 1 };
}

export function decodeDDS(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error('Не DDS файл');
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
  const pfFlags = dv.getUint32(80, true), fourCC = dv.getUint32(84, true), bits = dv.getUint32(88, true);
  let off = 128, kind = 0;
  const cc = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
  if (pfFlags & 4) {
    if (fourCC === cc('DXT1')) kind = 1;
    else if (fourCC === cc('DXT2') || fourCC === cc('DXT3')) kind = 3;
    else if (fourCC === cc('DXT4') || fourCC === cc('DXT5')) kind = 5;
    else if (fourCC === cc('DX10')) {
      const f = dv.getUint32(128, true); off = 148;
      if (f === 71 || f === 72) kind = 1; else if (f === 74 || f === 75) kind = 3; else if (f === 77 || f === 78) kind = 5;
      else if (f === 28 || f === 29) kind = -1; else if (f === 87 || f === 91) kind = -2;
      else throw new Error('Неподдерживаемый DXGI формат DDS: ' + f);
    } else throw new Error('Неподдерживаемый fourCC DDS');
  }
  if (kind > 0) return { width: w, height: h, rgba: decodeDXT(dv, off, w, h, kind) };
  const out = new Uint8Array(w * h * 4);
  if (kind === -1 || kind === -2) {
    for (let i = 0; i < w * h; i++) { const o = off + i * 4; const r = dv.getUint8(o), g = dv.getUint8(o + 1), b = dv.getUint8(o + 2), a = dv.getUint8(o + 3);
      out.set(kind === -1 ? [r, g, b, a] : [b, g, r, a], i * 4); }
    return { width: w, height: h, rgba: out };
  }
  const bpp = bits >> 3;
  if (![2, 3, 4].includes(bpp)) throw new Error('Неподдерживаемый несжатый DDS (' + bits + ' бит)');
  const R = maskInfo(dv.getUint32(92, true)), G = maskInfo(dv.getUint32(96, true)), B = maskInfo(dv.getUint32(100, true));
  const A = maskInfo(pfFlags & 1 ? dv.getUint32(104, true) : 0);
  const rm = dv.getUint32(92, true), gm = dv.getUint32(96, true), bm = dv.getUint32(100, true), am = dv.getUint32(104, true);
  for (let i = 0; i < w * h; i++) {
    let px = 0; for (let k = 0; k < bpp; k++) px |= dv.getUint8(off + i * bpp + k) << (8 * k);
    const sc = (v, m) => m.max ? Math.round((((v >>> m.s) & m.max) * 255) / m.max) : 255;
    out[i * 4] = sc(px & rm, R); out[i * 4 + 1] = sc(px & gm, G); out[i * 4 + 2] = sc(px & bm, B); out[i * 4 + 3] = A.max ? sc(px & am, A) : 255;
  }
  return { width: w, height: h, rgba: out };
}

export function decodeDXT(dv, off, w, h, kind) {
  const out = new Uint8Array(w * h * 4), bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  const cr = [0, 0, 0, 0], cg = [0, 0, 0, 0], cb = [0, 0, 0, 0], ca = [255, 255, 255, 255], al = new Uint8Array(16);
  let p = off;
  const c565 = (c) => [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (kind === 3) {
      for (let i = 0; i < 8; i++) { const b = dv.getUint8(p + i); al[2 * i] = (b & 15) * 17; al[2 * i + 1] = (b >> 4) * 17; }
      p += 8;
    } else if (kind === 5) {
      const a0 = dv.getUint8(p), a1 = dv.getUint8(p + 1), lut = [a0, a1, 0, 0, 0, 0, 0, 0];
      if (a0 > a1) for (let i = 1; i <= 6; i++) lut[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
      else { for (let i = 1; i <= 4; i++) lut[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0; lut[6] = 0; lut[7] = 255; }
      const lo = dv.getUint32(p + 2, true), hi = dv.getUint16(p + 6, true);
      for (let i = 0; i < 16; i++) {
        const bit = i * 3; let idx;
        if (bit <= 29) idx = (lo >>> bit) & 7; else if (bit === 30) idx = ((lo >>> 30) | (hi << 2)) & 7; else idx = (hi >>> (bit - 32)) & 7;
        al[i] = lut[idx];
      }
      p += 8;
    }
    const c0 = dv.getUint16(p, true), c1 = dv.getUint16(p + 2, true), bits = dv.getUint32(p + 4, true); p += 8;
    const k0 = c565(c0), k1 = c565(c1);
    for (let k = 0; k < 3; k++) {
      const arr = [cr, cg, cb][k];
      arr[0] = k0[k]; arr[1] = k1[k];
      if (kind > 1 || c0 > c1) { arr[2] = (2 * k0[k] + k1[k]) / 3 | 0; arr[3] = (k0[k] + 2 * k1[k]) / 3 | 0; }
      else { arr[2] = (k0[k] + k1[k]) >> 1; arr[3] = 0; }
    }
    ca[3] = (kind === 1 && c0 <= c1) ? 0 : 255;
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px, y = by * 4 + py; if (x >= w || y >= h) continue;
      const idx = (bits >>> (2 * (py * 4 + px))) & 3, o = (y * w + x) * 4;
      out[o] = cr[idx]; out[o + 1] = cg[idx]; out[o + 2] = cb[idx]; out[o + 3] = kind === 1 ? ca[idx] : al[py * 4 + px];
    }
  }
  return out;
}

// ---- TGA (id Tech 3/4): truecolor / gray / colormap, RLE ----
export function decodeTGA(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  const idLen = u8[0], cmType = u8[1], type = u8[2], cmLen = dv.getUint16(5, true), cmBits = u8[7];
  const w = dv.getUint16(12, true), h = dv.getUint16(14, true), bpp = u8[16], top = (u8[17] & 0x20) !== 0;
  if (![1, 2, 3, 9, 10, 11].includes(type) || !w || !h) throw new Error('TGA: неподдерживаемый тип ' + type);
  let p = 18 + idLen, pal = null; const cmBytes = cmBits >> 3;
  if (cmType === 1) { pal = u8.subarray(p, p + cmLen * cmBytes); p += cmLen * cmBytes; }
  const bp = bpp >> 3, raw = new Uint8Array(w * h * bp), rle = type >= 9;
  if (!rle) raw.set(u8.subarray(p, p + raw.length));
  else for (let i = 0; i < raw.length;) {
    const c = u8[p++], n = (c & 0x7f) + 1;
    if (c & 0x80) { for (let k = 0; k < n && i < raw.length; k++) for (let b = 0; b < bp; b++) raw[i++] = u8[p + b]; p += bp; }
    else for (let k = 0; k < n * bp && i < raw.length; k++) raw[i++] = u8[p++];
  }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dy = top ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * bp, d = (dy * w + x) * 4; let r, g, b, a = 255;
      if (pal) { const q = raw[s] * cmBytes; b = pal[q]; g = pal[q + 1]; r = pal[q + 2]; if (cmBytes === 4) a = pal[q + 3]; }
      else if (bp === 1) r = g = b = raw[s];
      else if (bp === 2) { const v = raw[s] | (raw[s + 1] << 8); r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31; }
      else { b = raw[s]; g = raw[s + 1]; r = raw[s + 2]; if (bp === 4) a = raw[s + 3]; }
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    }
  }
  return { width: w, height: h, rgba: out };
}

// ---- PCX (Quake II): 8 бит с палитрой в конце или 24 бит (3 плоскости) ----
export function decodePCX(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (u8[0] !== 10 || u8[2] !== 1 || u8[3] !== 8) throw new Error('PCX: неподдерживаемый формат');
  const w = dv.getUint16(8, true) - dv.getUint16(4, true) + 1, h = dv.getUint16(10, true) - dv.getUint16(6, true) + 1, planes = u8[65], bpl = dv.getUint16(66, true);
  const line = planes * bpl, data = new Uint8Array(line * h); let p = 128;
  for (let i = 0; i < data.length && p < u8.length;) {
    let c = u8[p++], n = 1;
    if ((c & 0xc0) === 0xc0) { n = c & 0x3f; c = u8[p++]; }
    while (n-- > 0 && i < data.length) data[i++] = c;
  }
  const out = new Uint8Array(w * h * 4), pal = planes === 1 && u8[u8.length - 769] === 12 ? u8.subarray(u8.length - 768) : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = (y * w + x) * 4; let r, g, b;
    if (planes === 1) { const v = data[y * line + x]; if (pal) { r = pal[v * 3]; g = pal[v * 3 + 1]; b = pal[v * 3 + 2]; } else r = g = b = v; }
    else { r = data[y * line + x]; g = data[y * line + bpl + x]; b = data[y * line + 2 * bpl + x]; }
    out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255;
  }
  return { width: w, height: h, rgba: out };
}

// ---- VTF (Source): старшее разрешение, первый кадр; форматы DXT1/3/5, BGRA/RGBA/BGR/RGB 8888/888, 565, I8, IA88 ----
const VTF_BYTES = { 0: 4, 1: 4, 2: 3, 3: 3, 4: 2, 5: 1, 6: 2, 7: 1, 8: 1, 11: 4, 12: 4, 16: 4, 17: 2, 18: 2, 19: 2, 21: 2, 22: 2 };
function vtfSize(fmt, w, h) {
  if (fmt === 13 || fmt === 20) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * 8;
  if (fmt === 14 || fmt === 15) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * 16;
  if (!(fmt in VTF_BYTES)) throw new Error('VTF: формат ' + fmt + ' не поддерживается');
  return w * h * VTF_BYTES[fmt];
}
export function decodeVTF(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.getUint32(0, true) !== 0x00465456) throw new Error('Не VTF');
  const headerSize = dv.getUint32(12, true), w = dv.getUint16(16, true), h = dv.getUint16(18, true), flags = dv.getUint32(20, true), frames = dv.getUint16(24, true) || 1;
  const fmt = dv.getInt32(52, true), mips = u8[56] || 1, lowFmt = dv.getInt32(57, true), lw = u8[61], lh = u8[62];
  let p = headerSize; if (lowFmt >= 0 && lw && lh) p += vtfSize(lowFmt, lw, lh);
  const faces = (flags & 0x4000) ? 6 : 1;
  for (let m = mips - 1; m >= 1; m--) p += vtfSize(fmt, Math.max(1, w >> m), Math.max(1, h >> m)) * frames * faces;
  const out = new Uint8Array(w * h * 4);
  if (fmt === 13 || fmt === 20 || fmt === 14 || fmt === 15) return { width: w, height: h, rgba: decodeDXT(dv, p, w, h, fmt === 14 ? 3 : fmt === 15 ? 5 : 1) };
  const bp = VTF_BYTES[fmt];
  for (let i = 0; i < w * h; i++) {
    const o = p + i * bp; let r = 0, g = 0, b = 0, a = 255;
    switch (fmt) {
      case 0: r = u8[o]; g = u8[o + 1]; b = u8[o + 2]; a = u8[o + 3]; break;
      case 1: a = u8[o]; b = u8[o + 1]; g = u8[o + 2]; r = u8[o + 3]; break;
      case 2: r = u8[o]; g = u8[o + 1]; b = u8[o + 2]; break;
      case 3: b = u8[o]; g = u8[o + 1]; r = u8[o + 2]; break;
      case 11: a = u8[o]; r = u8[o + 1]; g = u8[o + 2]; b = u8[o + 3]; break;
      case 12: b = u8[o]; g = u8[o + 1]; r = u8[o + 2]; a = u8[o + 3]; break;
      case 16: b = u8[o]; g = u8[o + 1]; r = u8[o + 2]; break;
      case 4: { const v = dv.getUint16(o, true); r = (v >> 11) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; b = (v & 31) * 255 / 31; break; }
      case 17: { const v = dv.getUint16(o, true); b = (v >> 11) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; r = (v & 31) * 255 / 31; break; }
      case 5: case 7: r = g = b = u8[o]; break;
      case 8: a = u8[o]; break;
      case 6: r = g = b = u8[o]; a = u8[o + 1]; break;
      default: throw new Error('VTF: формат ' + fmt + ' не поддерживается');
    }
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return { width: w, height: h, rgba: out };
}
