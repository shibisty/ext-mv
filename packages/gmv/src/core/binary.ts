// Мелкие помощники чтения двоичных данных.

/** ASCII-строка до нуля или до n байт. */
export function cstr(u8: Uint8Array, start: number, maxLen: number): string {
  let s = '';
  for (let i = 0; i < maxLen && u8[start + i]; i++) s += String.fromCharCode(u8[start + i]!);
  return s;
}

/** ASCII-строка в диапазоне [a, b) до первого нуля. */
export function cstrRange(u8: Uint8Array, a: number, b: number): string {
  let s = '';
  for (let i = a; i < b && u8[i]; i++) s += String.fromCharCode(u8[i]!);
  return s;
}

/** ASCII в диапазоне [a, b) без остановки на нуле. */
export function ascii(u8: Uint8Array, a: number, b: number): string {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]!);
  return s;
}

/** Четыре символа как little-endian uint32. */
export const fourCC = (s: string): number =>
  (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;

/** IEEE 754 half -> number. */
export function half(x: number): number {
  const s = x & 0x8000 ? -1 : 1, e = (x >> 10) & 31, f = x & 1023;
  if (e === 0) return s * 5.960464477539063e-8 * f;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Копия содержимого Uint8Array как отдельный ArrayBuffer. */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** Первые n байт файла (для автоопределения). */
export async function readHead(file: Blob | { arrayBuffer(): Promise<ArrayBuffer> }, n = 64): Promise<Uint8Array> {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return new Uint8Array(await file.slice(0, n).arrayBuffer());
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf, 0, Math.min(n, buf.byteLength));
}

/** Совпадают ли первые байты с ASCII-сигнатурой. */
export function hasMagic(head: Uint8Array, magic: string, offset = 0): boolean {
  if (head.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (head[offset + i] !== magic.charCodeAt(i)) return false;
  return true;
}

export const u32le = (u8: Uint8Array, o: number): number =>
  u8.length >= o + 4 ? (u8[o]! | (u8[o + 1]! << 8) | (u8[o + 2]! << 16) | (u8[o + 3]! << 24)) >>> 0 : -1;

export const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};
export const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
export const stripExt = (p: string): string => p.replace(/\.[^./]+$/, '');
export const baseName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;

const decoder = new TextDecoder();
export const decodeText = (data: Uint8Array | ArrayBuffer): string => decoder.decode(data);
