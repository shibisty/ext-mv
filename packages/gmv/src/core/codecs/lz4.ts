// LZ4: блок и frame-формат (BSA v105, Skyrim SE). Собственная реализация без зависимостей.

/** Распаковать один LZ4-блок из src[sp..ep) в dst начиная с dp. Возвращает новый dp. */
export function lz4Block(src: Uint8Array, sp: number, ep: number, dst: Uint8Array, dp: number): number {
  while (sp < ep) {
    const token = src[sp++]!;
    let lit = token >> 4;
    if (lit === 15) { let b: number; do { b = src[sp++]!; lit += b; } while (b === 255); }
    for (let i = 0; i < lit; i++) dst[dp++] = src[sp++]!;
    if (sp >= ep) break;
    const off = src[sp]! | (src[sp + 1]! << 8);
    sp += 2;
    let ml = token & 15;
    if (ml === 15) { let b: number; do { b = src[sp++]!; ml += b; } while (b === 255); }
    ml += 4;
    let mp = dp - off;
    if (off === 0 || mp < 0) throw new Error('LZ4: неверное смещение');
    for (let i = 0; i < ml; i++) dst[dp++] = dst[mp++]!;
  }
  return dp;
}

/** Распаковать LZ4 frame (сигнатура 0x184D2204) известного размера. */
export function lz4Frame(src: Uint8Array, outSize: number): Uint8Array {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (dv.getUint32(0, true) !== 0x184d2204) throw new Error('LZ4: нет сигнатуры кадра');
  const flg = src[4]!;
  let p = 6;
  if (flg & 0x08) p += 8; // размер содержимого
  if (flg & 0x01) p += 4; // id словаря
  p += 1; // контрольная сумма заголовка
  const blockSum = !!(flg & 0x10), out = new Uint8Array(outSize);
  let dp = 0;
  for (;;) {
    const bs = dv.getUint32(p, true);
    p += 4;
    if (bs === 0) break;
    const raw = (bs & 0x80000000) !== 0, len = bs & 0x7fffffff;
    if (raw) { out.set(src.subarray(p, p + len), dp); dp += len; }
    else dp = lz4Block(src, p, p + len, out, dp);
    p += len + (blockSum ? 4 : 0);
  }
  return dp === outSize ? out : out.subarray(0, dp);
}
