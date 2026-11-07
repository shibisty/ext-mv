// Текстуры Enfusion (.edds): заголовок DDS (+ DX10), затем таблица мипов от меньшего к большему: {«COPY» | «LZ4 », u32 размер},
// затем данные в том же порядке. «LZ4 »: u32 распакованный размер, затем блоки {u24 размер, u8 признак последнего}; словарь —
// весь предыдущий вывод (блоки по 64 КБ). Форматы: BC1–BC5, BC7, RGBA8/BGRA8/BGRX8, несжатые по маскам.
import { lz4Block } from '../../core/codecs/lz4';
import { decodeBC7 } from '../../core/images/bc7';
import { decodeDDS, decodeDXT } from '../../core/images/dds';
import type { DecodedImage } from '../../core/types';
import { decodeBC45 } from '../rage/texture';

const DDS = 0x20534444, DX10 = 0x30315844;

/** Цепочка LZ4 Enfusion: блоки {u24 размер, u8 флаг (бит 7 — последний)}, вывод подряд. Возвращает позицию после цепочки. */
export function lz4Chain(src: Uint8Array, p: number, out: Uint8Array, flagMask = 0x80): number {
  let dp = 0;
  for (let guard = 0; guard < 1 << 16; guard++) {
    if (p + 4 > src.length) throw new Error('LZ4: цепочка обрезана');
    const size = src[p]! | (src[p + 1]! << 8) | (src[p + 2]! << 16), flag = src[p + 3]!;
    p += 4;
    dp = lz4Block(src, p, p + size, out, dp);
    p += size;
    if (flag & flagMask) break;
  }
  if (dp !== out.length) throw new Error(`LZ4: распаковано ${dp} из ${out.length} байт`);
  return p;
}

interface Mip { kind: 'COPY' | 'LZ4 '; size: number; off: number; level: number }

/** Декодировать .edds; maxSide — предел стороны (берётся наибольший подходящий мип). */
/** Сколько байт от начала файла нужно для мипа ≤ maxSide (мипы лежат от меньшего к большему); null — не EDDS. */
export function eddsBytesNeeded(u: Uint8Array, maxSide: number): number | null {
  if (u.length < 152) return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (dv.getUint32(0, true) !== DDS) return null;
  const H = dv.getUint32(12, true), W = dv.getUint32(16, true), count = Math.max(1, dv.getUint32(28, true));
  let p = dv.getUint32(80, true) & 4 && dv.getUint32(84, true) === DX10 ? 148 : 128;
  const sizes: number[] = [];
  for (let i = 0; i < count && p + 8 <= u.length; i++) {
    const t = String.fromCharCode(u[p]!, u[p + 1]!, u[p + 2]!, u[p + 3]!);
    if (t !== 'COPY' && t !== 'LZ4 ') break;
    sizes.push(dv.getUint32(p + 4, true)); p += 8;
  }
  if (!sizes.length || sizes.length < count) return null;
  let end = p;
  for (let i = 0; i < sizes.length; i++) {
    end += sizes[i]!;
    const level = count - 1 - i;
    if (Math.max(W >> level, H >> level) <= maxSide && (i + 1 === sizes.length || Math.max(W >> (level - 1), H >> (level - 1)) > maxSide)) return end;
  }
  return end;
}

export function decodeEdds(buf: ArrayBuffer, maxSide = 2048): DecodedImage {
  const u = new Uint8Array(buf), dv = new DataView(buf);
  if (u.length < 128 || dv.getUint32(0, true) !== DDS) throw new Error('Не EDDS (нет сигнатуры DDS)');
  const H = dv.getUint32(12, true), W = dv.getUint32(16, true), count = Math.max(1, dv.getUint32(28, true));
  const pfFlags = dv.getUint32(80, true), fourCC = dv.getUint32(84, true);
  let p = 128, dxgi = 0;
  if (pfFlags & 4 && fourCC === DX10) { dxgi = dv.getUint32(128, true); p = 148; }
  const hdrEnd = p;
  // таблица мипов: от меньшего (уровень count-1) к большему (0)
  const mips: Mip[] = [];
  for (let i = 0; i < count; i++) {
    const t = String.fromCharCode(u[p]!, u[p + 1]!, u[p + 2]!, u[p + 3]!);
    if (t !== 'COPY' && t !== 'LZ4 ') break;
    mips.push({ kind: t, size: dv.getUint32(p + 4, true), off: 0, level: 0 });
    p += 8;
  }
  if (!mips.length) throw new Error('EDDS: нет таблицы мипов');
  mips.forEach((m, i) => { m.off = p; p += m.size; m.level = count - 1 - i; });
  let pick = mips[mips.length - 1]!;
  for (let i = mips.length - 1; i >= 0; i--) { const m = mips[i]!; pick = m; if (Math.max(W >> m.level, H >> m.level) <= maxSide) break; }
  const w = Math.max(1, W >> pick.level), h = Math.max(1, H >> pick.level);
  let data: Uint8Array;
  if (pick.kind === 'COPY') data = u.subarray(pick.off, pick.off + pick.size);
  else {
    const usize = dv.getUint32(pick.off, true);
    data = new Uint8Array(usize);
    lz4Chain(u, pick.off + 4, data, 0xff);
  }
  const dd = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const img = (rgba: Uint8Array): DecodedImage => ({ width: w, height: h, rgba });
  if (dxgi) {
    switch (dxgi) {
      case 71: case 72: return img(decodeDXT(dd, 0, w, h, 1));
      case 74: case 75: return img(decodeDXT(dd, 0, w, h, 3));
      case 77: case 78: return img(decodeDXT(dd, 0, w, h, 5));
      case 80: case 81: return img(decodeBC45(data, 0, w, h, false));
      case 83: case 84: return img(decodeBC45(data, 0, w, h, true));
      case 98: case 99: return img(decodeBC7(data, 0, w, h));
      case 28: case 29: return img(data.slice(0, w * h * 4));
      case 87: case 88: case 91: case 93: {
        const out = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) { out[i * 4] = data[i * 4 + 2]!; out[i * 4 + 1] = data[i * 4 + 1]!; out[i * 4 + 2] = data[i * 4]!; out[i * 4 + 3] = dxgi === 88 || dxgi === 93 ? 255 : data[i * 4 + 3]!; }
        return img(out);
      }
      default: throw new Error(`EDDS: формат DXGI ${dxgi} не поддерживается`);
    }
  }
  // без DX10: собираем обычный DDS из заголовка и выбранного мипа
  const dds = new Uint8Array(hdrEnd + data.length);
  dds.set(u.subarray(0, hdrEnd)); dds.set(data, hdrEnd);
  const ddv = new DataView(dds.buffer);
  ddv.setUint32(12, h, true); ddv.setUint32(16, w, true); ddv.setUint32(28, 1, true);
  return decodeDDS(dds.buffer);
}
