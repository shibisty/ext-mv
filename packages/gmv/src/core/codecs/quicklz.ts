// QuickLZ 1.5 (уровень 3), распаковка. 4A Engine (Metro 2033) сжимает им файлы архивов .vfs.
// Блок: байт флагов (бит 0 — сжато, бит 1 — длинный заголовок 9 байт, биты 2–3 — уровень), размер блока с заголовком,
// размер данных; затем 32-битные «слова управления» (бит = совпадение, старший бит — граница слова) и данные.
const BITLUT = [4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0];

/** Размеры блока по заголовку: [длина заголовка, размер блока с заголовком, размер данных]. */
export function quicklzHeader(src: Uint8Array, p = 0): [number, number, number] {
  const f = src[p]!, long = (f & 2) !== 0, rd = (o: number) => (long ? (src[o]! | (src[o + 1]! << 8) | (src[o + 2]! << 16) | (src[o + 3]! << 24)) >>> 0 : src[o]!);
  return long ? [9, rd(p + 1), rd(p + 5)] : [3, rd(p + 1), rd(p + 2)];
}

/** Распаковать один блок QuickLZ, начиная с p, в out с позиции op. Возвращает число записанных байт. */
export function quicklzBlock(src: Uint8Array, p: number, out: Uint8Array, op: number): number {
  const f = src[p]!, [hl, csize, dsize] = quicklzHeader(src, p);
  if (op + dsize > out.length) throw new Error('QuickLZ: выход за границы буфера');
  if (!(f & 1)) { out.set(src.subarray(p + hl, p + hl + dsize), op); return dsize; }
  const level = (f >> 2) & 3;
  if (level !== 3) throw new Error(`QuickLZ: уровень ${level} не поддерживается (нужен 3)`);
  const end = p + csize, start = op, last = op + dsize - 1, lastMatchStart = last - 6 - 4;
  let s = p + hl, d = op, cword = 1;
  const r32 = (o: number) => (src[o]! | (src[o + 1]! << 8) | (src[o + 2]! << 16) | (src[o + 3]! << 24)) >>> 0;
  for (;;) {
    if (cword === 1) { cword = r32(s); s += 4; }
    if (cword & 1) {
      const fetch = s + 4 <= end ? r32(s) : (src[s]! | ((src[s + 1] ?? 0) << 8) | ((src[s + 2] ?? 0) << 16)) >>> 0;
      cword >>>= 1;
      let offset: number, len: number;
      if ((fetch & 3) === 0) { offset = (fetch & 0xff) >>> 2; len = 3; s += 1; }
      else if ((fetch & 2) === 0) { offset = (fetch & 0xffff) >>> 2; len = 3; s += 2; }
      else if ((fetch & 1) === 0) { offset = (fetch & 0xffff) >>> 6; len = ((fetch >>> 2) & 15) + 3; s += 2; }
      else if ((fetch & 127) !== 3) { offset = (fetch >>> 7) & 0x1ffff; len = ((fetch >>> 2) & 0x1f) + 2; s += 3; }
      else { offset = fetch >>> 15; len = ((fetch >>> 7) & 255) + 3; s += 4; }
      const from = d - offset;
      if (from < start || offset === 0) throw new Error('QuickLZ: ссылка за начало данных');
      for (let k = 0; k < len; k++) out[d + k] = out[from + k]!;
      d += len;
    } else if (d < lastMatchStart) {
      const n = BITLUT[cword & 0xf]!;
      for (let k = 0; k < n; k++) out[d + k] = src[s + k]!;
      cword >>>= n; d += n; s += n;
    } else {
      while (d <= last) {
        if (cword === 1) { s += 4; cword = 0x80000000; }
        out[d++] = src[s++]!;
        cword >>>= 1;
      }
      return dsize;
    }
    if (s > end + 4) throw new Error('QuickLZ: поток повреждён');
  }
}

/** Распаковать цепочку блоков QuickLZ до размера size. */
export function quicklzDecompress(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let p = 0, op = 0;
  while (op < size && p < src.length) {
    const [, csize] = quicklzHeader(src, p);
    op += quicklzBlock(src, p, out, op);
    p += csize;
  }
  if (op !== size) throw new Error(`QuickLZ: распаковано ${op} из ${size} байт`);
  return out;
}
