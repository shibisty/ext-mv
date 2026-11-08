// EA Black Box (Need for Speed: World; формат тот же у Underground 2 / Most Wanted / Carbon в части чанков):
// чанки {u32 id, u32 size} (бит 0x80000000 — контейнер), блоки сжатия 0x55441122 (JDLZ / HUFF / без сжатия),
// пакеты текстур TPK (0xB3300000) и геометрия машин (0x80134000 → объекты 0x80134010).
import { eaHuff } from '../../core/codecs/eahuff';
import { jdlz } from '../../core/codecs/jdlz';
import { decodeDXT } from '../../core/images/dds';
import type { DecodedImage } from '../../core/types';

export const BB_GEOMETRY = 0x80134000, BB_TPK = 0xb3300000, LZC_MAGIC = 0x66113388, BLOCK_MAGIC = 0x55441122;

export interface BbChunk { id: number; off: number; size: number }

/** Чанки одного уровня: off — начало данных. */
export function bbChunks(u: Uint8Array, off: number, end: number): BbChunk[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out: BbChunk[] = [];
  let p = off;
  while (p + 8 <= end) {
    const id = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > end) break;
    out.push({ id, off: p + 8, size });
    p += 8 + size;
  }
  return out;
}

/** Все чанки с id (в глубину, только через контейнеры). */
export function bbFind(u: Uint8Array, off: number, end: number, id: number, depth = 6, out: BbChunk[] = []): BbChunk[] {
  for (const c of bbChunks(u, off, end)) {
    if (c.id === id) out.push(c);
    else if ((c.id & 0x80000000) && depth > 0 && c.size >= 8) bbFind(u, c.off, c.off + c.size, id, depth - 1, out);
  }
  return out;
}

/** Пропустить выравнивание 0x11 в начале данных чанка. */
export function skipPad(u: Uint8Array, off: number, end: number): number {
  while (off + 4 <= end && u[off] === 0x11 && u[off + 1] === 0x11 && u[off + 2] === 0x11 && u[off + 3] === 0x11) off += 4;
  return off;
}

/** Объект из блоков сжатия {0x55441122, распакованный размер, размер блока с заголовком 24, смещение вывода, …}. */
export function bbBlocks(u: Uint8Array, off: number, csize: number, usize: number): Uint8Array {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (off + 24 > u.length || dv.getUint32(off, true) !== BLOCK_MAGIC) return u.slice(off, off + usize);
  const out = new Uint8Array(usize), end = Math.min(u.length, off + csize);
  let p = off;
  while (p + 24 <= end && dv.getUint32(p, true) === BLOCK_MAGIC) {
    const us = dv.getUint32(p + 4, true), cs = dv.getUint32(p + 8, true), oo = dv.getUint32(p + 12, true);
    if (cs < 24 || p + cs > u.length) throw new Error('Black Box: блок сжатия выходит за файл');
    const blk = u.subarray(p + 24, p + cs);
    const m = String.fromCharCode(blk[0]!, blk[1]!, blk[2]!, blk[3]!);
    const dec = m === 'JDLZ' ? jdlz(blk) : m === 'HUFF' ? eaHuff(blk.subarray(16)) : blk.subarray(0, us);
    out.set(dec.subarray(0, Math.max(0, Math.min(dec.length, usize - oo))), oo);
    p += cs;
  }
  return out;
}

/** Файлы .lzc (GLOBAL/*.lzc, CARS/GlobalC.lzc): {0x66113388, распакованный размер, …} + блоки. */
export function unLzc(u: Uint8Array): Uint8Array {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 16 || dv.getUint32(0, true) !== LZC_MAGIC) return u;
  return bbBlocks(u, 16, u.length - 16, dv.getUint32(4, true));
}

/** Хеш имён Black Box: h = h·33 + c, начало 0xFFFFFFFF. */
export function binHash(s: string): number {
  let h = 0xffffffff;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return h;
}

// ---------- текстуры (TPK) ----------
export interface BbTexture { hash: number; name: string; width: number; height: number; fourcc: number; pack: string; data: () => Uint8Array }

const FOURCC = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
export const FCC = { DXT1: FOURCC('DXT1'), DXT3: FOURCC('DXT3'), DXT5: FOURCC('DXT5'), ATI2: FOURCC('ATI2'), ATI1: FOURCC('ATI1') } as const;

const cstr = (u: Uint8Array, off: number, max: number): string => { let s = ''; for (let i = 0; i < max && u[off + i]; i++) s += String.fromCharCode(u[off + i]!); return s; };

/** TextureInfo: хеш @12, ширина @32, высота @36, имя @144 (u8 длина + символы), FourCC @192 у сжатых пакетов. */
function texInfo(u: Uint8Array, off: number): { hash: number; w: number; h: number; name: string; dataOff: number; dataSize: number } {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  return { hash: dv.getUint32(off + 12, true), w: dv.getUint32(off + 32, true), h: dv.getUint32(off + 36, true), dataSize: dv.getUint32(off + 24, true), dataOff: dv.getUint32(off + 80, true), name: cstr(u, off + 145, u[off + 144]!) };
}

/** Все текстуры пакетов TPK в буфере: сжатые (таблица 0x33310003, у машин) и обычные (0x33310004 + 0x33310005). */
export function readTpks(u: Uint8Array, out = new Map<number, BbTexture>()): Map<number, BbTexture> {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  for (const tpk of bbFind(u, 0, u.length, BB_TPK, 4)) {
    const kids = bbChunks(u, tpk.off, tpk.off + tpk.size);
    const head = kids.find((c) => c.id === 0xb3310000), body = kids.find((c) => c.id === 0xb3320000);
    if (!head) continue;
    const hk = bbChunks(u, head.off, head.off + head.size);
    const info = hk.find((c) => c.id === 0x33310001), pack = info ? cstr(u, info.off + 4, 28) : '';
    const comp = hk.find((c) => c.id === 0x33310003), plain = hk.find((c) => c.id === 0x33310004), fmts = hk.find((c) => c.id === 0x33310005);
    if (comp) {
      // {хеш, смещение блоков в файле, сжатый размер, распакованный (данные + TextureInfo 212), размер TextureInfo, …}
      for (let i = 0; i + 36 <= comp.size; i += 36) {
        const e = comp.off + i, hash = dv.getUint32(e, true), off = dv.getUint32(e + 4, true), cs = dv.getUint32(e + 8, true), us = dv.getUint32(e + 12, true), isz = dv.getUint32(e + 16, true);
        if (!us || isz > us || off + 24 > u.length || dv.getUint32(off, true) !== BLOCK_MAGIC) continue;
        let raw: Uint8Array | null = null;
        const get = () => (raw ??= bbBlocks(u, off, cs, us));
        // TextureInfo лежит в конце: распакуем один раз, чтобы узнать имя и размеры
        const all = get(), ti = texInfo(all, us - isz), fourcc = new DataView(all.buffer, all.byteOffset).getUint32(us - isz + 192, true);
        if (!out.has(hash)) out.set(hash, { hash, name: ti.name || hash.toString(16), width: ti.w, height: ti.h, fourcc, pack, data: () => get().subarray(0, us - isz) });
      }
    } else if (plain && body) {
      // данные — после выравнивания в 0x33320002; TextureInfo переменной длины (144 + 1 + длина имени)
      const dataChunk = bbChunks(u, body.off, body.off + body.size).find((c) => c.id === 0x33320002);
      if (!dataChunk) continue;
      const base = skipPad(u, dataChunk.off, dataChunk.off + dataChunk.size);
      let p = plain.off, k = 0;
      while (p + 145 <= plain.off + plain.size) {
        const ti = texInfo(u, p), len = u[p + 144]!;
        const fourcc = fmts && fmts.off + k * 32 + 16 <= fmts.off + fmts.size ? dv.getUint32(fmts.off + k * 32 + 12, true) : 0;
        const start = base + ti.dataOff, size = ti.dataSize;
        if (!out.has(ti.hash) && start + size <= u.length) out.set(ti.hash, { hash: ti.hash, name: ti.name, width: ti.w, height: ti.h, fourcc, pack, data: () => u.subarray(start, start + size) });
        p += 145 + len; k++;
      }
    }
  }
  return out;
}

/** Сжатая запись TPK (0x33310003): данные могут лежать вне пакета — в файле <хеш>.stp рядом (номера, винилы). */
export interface TpkEntry { hash: number; off: number; csize: number; usize: number; infoSize: number; pack: string }
export function tpkEntries(u: Uint8Array): TpkEntry[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out: TpkEntry[] = [];
  for (const tpk of bbFind(u, 0, u.length, BB_TPK, 4)) {
    const head = bbChunks(u, tpk.off, tpk.off + tpk.size).find((c) => c.id === 0xb3310000);
    if (!head) continue;
    const hk = bbChunks(u, head.off, head.off + head.size);
    const info = hk.find((c) => c.id === 0x33310001), pack = info ? cstr(u, info.off + 4, 28) : '';
    const comp = hk.find((c) => c.id === 0x33310003);
    if (comp) for (let i = 0; i + 36 <= comp.size; i += 36) {
      const e = comp.off + i;
      out.push({ hash: dv.getUint32(e, true), off: dv.getUint32(e + 4, true), csize: dv.getUint32(e + 8, true), usize: dv.getUint32(e + 12, true), infoSize: dv.getUint32(e + 16, true), pack });
    }
  }
  return out;
}
/** Текстура из внешнего файла .stp (блоки сжатия с начала файла: данные + TextureInfo в конце). */
export function stpTexture(e: TpkEntry, stp: Uint8Array): BbTexture {
  const all = bbBlocks(stp, 0, stp.length, e.usize), ti = texInfo(all, e.usize - e.infoSize);
  const fourcc = new DataView(all.buffer, all.byteOffset).getUint32(e.usize - e.infoSize + 192, true);
  return { hash: e.hash, name: ti.name || e.hash.toString(16), width: ti.w, height: ti.h, fourcc, pack: e.pack, data: () => all.subarray(0, e.usize - e.infoSize) };
}

/** BC4/BC5 (ATI1/ATI2): блок одного канала. */
function bc4Block(d: Uint8Array, p: number, dst: Uint8Array, ch: number, w: number, h: number, bx: number, by: number): void {
  const a0 = d[p]!, a1 = d[p + 1]!, lut = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) for (let i = 1; i <= 6; i++) lut[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
  else { for (let i = 1; i <= 4; i++) lut[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0; lut[6] = 0; lut[7] = 255; }
  let bitsLo = d[p + 2]! | (d[p + 3]! << 8) | (d[p + 4]! << 16), bitsHi = d[p + 5]! | (d[p + 6]! << 8) | (d[p + 7]! << 16);
  for (let i = 0; i < 16; i++) {
    let idx: number;
    if (i < 8) { idx = bitsLo & 7; bitsLo >>= 3; } else { idx = bitsHi & 7; bitsHi >>= 3; }
    const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
    if (x < w && y < h) dst[(y * w + x) * 4 + ch] = lut[idx]!;
  }
}

/** Картинка текстуры: DXT1/3/5, ATI2 (карта нормалей XY → RGB), ATI1, A8R8G8B8 (21). */
export function decodeBbTexture(t: BbTexture): DecodedImage {
  const d = t.data(), w = t.width, h = t.height, dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  if (t.fourcc === FCC.DXT1 || t.fourcc === FCC.DXT3 || t.fourcc === FCC.DXT5) {
    const need = bw * bh * (t.fourcc === FCC.DXT1 ? 8 : 16);
    if (d.length < need) throw new Error(`${t.name}: данные DXT обрезаны`);
    return { width: w, height: h, rgba: decodeDXT(dv, 0, w, h, t.fourcc === FCC.DXT1 ? 1 : t.fourcc === FCC.DXT3 ? 3 : 5), name: t.name };
  }
  const out = new Uint8Array(w * h * 4);
  if (t.fourcc === FCC.ATI2 || t.fourcc === FCC.ATI1) {
    const two = t.fourcc === FCC.ATI2, bs = two ? 16 : 8;
    if (d.length < bw * bh * bs) throw new Error(`${t.name}: данные ATI обрезаны`);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const p = (by * bw + bx) * bs;
      bc4Block(d, p, out, 0, w, h, bx, by);
      if (two) bc4Block(d, p + 8, out, 1, w, h, bx, by);
    }
    for (let i = 0; i < w * h; i++) {
      if (two) { const x = out[i * 4]! / 127.5 - 1, y = out[i * 4 + 1]! / 127.5 - 1; out[i * 4 + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255); }
      else out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4]!;
      out[i * 4 + 3] = 255;
    }
    return { width: w, height: h, rgba: out, name: t.name };
  }
  if (t.fourcc === 21 || (t.fourcc === 0 && d.length >= w * h * 4)) {
    for (let i = 0; i < w * h; i++) { out[i * 4] = d[i * 4 + 2]!; out[i * 4 + 1] = d[i * 4 + 1]!; out[i * 4 + 2] = d[i * 4]!; out[i * 4 + 3] = d[i * 4 + 3]!; }
    return { width: w, height: h, rgba: out, name: t.name };
  }
  throw new Error(`${t.name}: формат текстуры 0x${t.fourcc.toString(16)} не поддерживается`);
}
