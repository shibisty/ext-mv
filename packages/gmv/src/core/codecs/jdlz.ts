// EA JDLZ (Need for Speed: Underground…World): LZ77 с двумя потоками флагов. Заголовок 16 байт:
// «JDLZ», 0x02 0x10 0 0, u32 размер распакованных, u32 размер сжатых.

export function jdlz(src: Uint8Array): Uint8Array {
  if (src[0] !== 0x4a || src[1] !== 0x44 || src[2] !== 0x4c || src[3] !== 0x5a) throw new Error('JDLZ: нет сигнатуры');
  const outLen = (src[8]! | (src[9]! << 8) | (src[10]! << 16) | (src[11]! << 24)) >>> 0;
  const out = new Uint8Array(outLen);
  let f1 = 1, f2 = 1, ip = 16, op = 0;
  while (ip < src.length && op < outLen) {
    if (f1 === 1) f1 = src[ip++]! | 0x100;
    if (f2 === 1) f2 = src[ip++]! | 0x100;
    if (f1 & 1) {
      const a = src[ip]!, b = src[ip + 1]!;
      let len: number, dist: number;
      if (f2 & 1) { len = (b | ((a & 0xf0) << 4)) + 3; dist = (a & 0x0f) + 1; }
      else { dist = (b | ((a & 0xe0) << 3)) + 17; len = (a & 0x1f) + 3; }
      ip += 2;
      if (dist > op) throw new Error('JDLZ: неверное смещение');
      for (let i = 0; i < len && op < outLen; i++, op++) out[op] = out[op - dist]!;
      f2 >>>= 1;
    } else out[op++] = src[ip++]!;
    f1 >>>= 1;
  }
  return out;
}
