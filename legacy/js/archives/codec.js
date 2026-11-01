// zlib (BSA v103/v104) через DecompressionStream; LZ4 frame (BSA v105, Skyrim SE) — собственная реализация.
export async function inflateZlib(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function lz4Block(src, sp, ep, dst, dp) {
  while (sp < ep) {
    const token = src[sp++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[sp++]; lit += b; } while (b === 255); }
    for (let i = 0; i < lit; i++) dst[dp++] = src[sp++];
    if (sp >= ep) break;
    const off = src[sp] | (src[sp + 1] << 8); sp += 2;
    let ml = token & 15;
    if (ml === 15) { let b; do { b = src[sp++]; ml += b; } while (b === 255); }
    ml += 4;
    let mp = dp - off;
    if (off === 0 || mp < 0) throw new Error('LZ4: неверное смещение');
    for (let i = 0; i < ml; i++) dst[dp++] = dst[mp++];
  }
  return dp;
}

export function lz4Frame(src, outSize) {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (dv.getUint32(0, true) !== 0x184d2204) throw new Error('LZ4: нет сигнатуры кадра');
  const flg = src[4]; let p = 6;
  if (flg & 0x08) p += 8;       // размер содержимого
  if (flg & 0x01) p += 4;       // id словаря
  p += 1;                        // контрольная сумма заголовка
  const blockSum = !!(flg & 0x10), out = new Uint8Array(outSize); let dp = 0;
  for (;;) {
    const bs = dv.getUint32(p, true); p += 4;
    if (bs === 0) break;
    const raw = (bs & 0x80000000) !== 0, len = bs & 0x7fffffff;
    if (raw) { out.set(src.subarray(p, p + len), dp); dp += len; }
    else dp = lz4Block(src, p, p + len, out, dp);
    p += len + (blockSum ? 4 : 0);
  }
  return dp === outSize ? out : out.subarray(0, dp);
}
