// Ресурсы RAGE (GTA V, RDR2-PC не поддерживается): заголовок RSC7 + raw deflate.
// После распаковки — системный сегмент, затем графический. Указатели: 0x5xxxxxxx — системный, 0x6xxxxxxx — графический.
import { inflateRaw } from '../../core/codecs/zlib';

export const RSC7 = 0x37435352;

/** Размер сегмента по флагам (как в заголовке RPF/RSC7). */
export function sizeFromFlags(f: number): number {
  const s = ((f >>> 27) & 1) + (((f >>> 26) & 1) << 1) + (((f >>> 25) & 1) << 2) + (((f >>> 24) & 1) << 3) +
    (((f >>> 17) & 0x7f) << 4) + (((f >>> 11) & 0x3f) << 5) + (((f >>> 7) & 0xf) << 6) + (((f >>> 5) & 3) << 7) + (((f >>> 4) & 1) << 8);
  return (0x200 << (f & 0xf)) * s;
}

export class Resource {
  readonly dv: DataView;
  constructor(readonly u8: Uint8Array, readonly version: number, readonly sysSize: number) {
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  /** Указатель (u64) по смещению -> смещение в данных; 0 — null. */
  ptr(at: number): number {
    const lo = this.dv.getUint32(at, true);
    if (!lo) return 0;
    const seg = lo >>> 28, off = lo & 0x0fffffff;
    if (seg === 5) return off;
    if (seg === 6) return this.sysSize + off;
    throw new Error(`RAGE: странный указатель 0x${lo.toString(16)} по смещению 0x${at.toString(16)}`);
  }
  u8at(at: number) { return this.u8[at]!; }
  u16(at: number) { return this.dv.getUint16(at, true); }
  u32(at: number) { return this.dv.getUint32(at, true); }
  f32(at: number) { return this.dv.getFloat32(at, true); }
  str(at: number): string {
    if (!at) return '';
    const e = this.u8.indexOf(0, at);
    let s = '';
    for (let i = at; i < (e < 0 ? this.u8.length : e); i++) s += String.fromCharCode(this.u8[i]!);
    return s;
  }
  /** Список указателей «pointer, count u16, capacity u16» по смещению. */
  ptrList(at: number): number[] {
    const p = this.ptr(at), n = this.u16(at + 8), out: number[] = [];
    for (let i = 0; i < n && p; i++) out.push(this.ptr(p + i * 8));
    return out;
  }
}

export async function openResource(buf: ArrayBuffer): Promise<Resource> {
  const h = new DataView(buf);
  if (buf.byteLength < 16 || h.getUint32(0, true) !== RSC7) {
    if (buf.byteLength >= 4 && h.getUint32(0, true) === 0x38435352) throw new Error('RSC8 (GTA V Enhanced, Gen9) пока не поддержан — нужен файл для обычной версии (RSC7)');
    throw new Error('Не ресурс RAGE (нет RSC7) — возможно, файл из зашифрованного RPF; извлеките его через OpenIV/CodeWalker');
  }
  const version = h.getUint32(4, true), sys = sizeFromFlags(h.getUint32(8, true)), gfx = sizeFromFlags(h.getUint32(12, true));
  const data = await inflateRaw(new Uint8Array(buf, 16));
  if (data.length < sys) throw new Error(`RAGE: распаковано ${data.length} байт, ожидалось не меньше ${sys}`);
  void gfx;
  return new Resource(data, version, sys);
}

/** Хэш Jenkins one-at-a-time (joaat), как в RAGE: имена в нижнем регистре. */
export function joaat(s: string): number {
  let h = 0;
  for (const ch of s.toLowerCase()) {
    h = (h + ch.charCodeAt(0)) | 0;
    h = (h + (h << 10)) | 0;
    h ^= h >>> 6;
  }
  h = (h + (h << 3)) | 0;
  h ^= h >>> 11;
  h = (h + (h << 15)) | 0;
  return h >>> 0;
}
