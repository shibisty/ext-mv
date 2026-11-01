// LZSS Bohemia Interactive (PBO «Cprs», несжатые форматы PAA, старые ODOL): окно 4096, заполнено пробелами, старт 4078.

/**
 * @param signed — контрольная сумма по знаковым байтам (так в PAA).
 * @returns { data, end } — распакованные байты и позиция за контрольной суммой.
 */
export function lzssDecompress(src: Uint8Array, sp: number, size: number, signed = false): { data: Uint8Array; end: number } {
  const out = new Uint8Array(size), win = new Uint8Array(4096).fill(0x20);
  let ip = sp, op = 0, wp = 4078, flags = 0, sum = 0;
  const put = (b: number) => { out[op++] = b; win[wp] = b; wp = (wp + 1) & 0xfff; sum = (sum + (signed ? (b << 24) >> 24 : b)) | 0; };
  while (op < size) {
    flags >>= 1;
    if (!(flags & 0x100)) { if (ip >= src.length) throw new Error('LZSS: обрыв данных'); flags = src[ip++]! | 0xff00; }
    if (flags & 1) { put(src[ip++]!); continue; }
    const a = src[ip++]!, b = src[ip++]!;
    const pos = wp - (a | ((b & 0xf0) << 4)), len = (b & 0x0f) + 3;
    if (op + len > size) throw new Error('LZSS: переполнение');
    for (let k = 0; k < len; k++) put(win[(pos + k) & 0xfff]!);
  }
  if (ip + 4 <= src.length) {
    const stored = (src[ip]! | (src[ip + 1]! << 8) | (src[ip + 2]! << 16) | (src[ip + 3]! << 24)) | 0;
    if (stored !== sum) throw new Error('LZSS: контрольная сумма не совпала');
  }
  return { data: out, end: ip + 4 };
}
