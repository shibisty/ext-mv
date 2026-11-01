// BC7 (BPTC): распаковка блоков 4×4 в RGBA8. Режимы 0–7 по спецификации Direct3D 11.

const PART2 = [
  0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000,
  0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce, 0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c,
  0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa, 0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
  0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336, 0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22,
];
// 3 подмножества: индекс подмножества для каждого пикселя (2 бита), 64 разбиения
const PART3 = [
  0xaa685050, 0x6a5a5040, 0x5a5a4200, 0x5450a0a8, 0xa5a50000, 0xa0a05050, 0x5555a0a0, 0x5a5a5050, 0xaa550000, 0xaa555500, 0xaaaa5500, 0x90909090, 0x94949494, 0xa4a4a4a4, 0xa9a59450, 0x2a0a4250,
  0xa5945040, 0x0a425054, 0xa5a5a500, 0x55a0a0a0, 0xa8a85454, 0x6a6a4040, 0xa4a45000, 0x1a1a0500, 0x0050a4a4, 0xaaa59090, 0x14696914, 0x69691400, 0xa08585a0, 0xaa821414, 0x50a4a450, 0x6a5a0200,
  0xa9a58000, 0x5090a0a8, 0xa8a09050, 0x24242424, 0x00aa5500, 0x24924924, 0x24499224, 0x50a50a50, 0x500aa550, 0xaaaa4444, 0x66660000, 0xa5a0a5a0, 0x50a050a0, 0x69286928, 0x44aaaa44, 0x66666600,
  0xaa444444, 0x54a854a8, 0x95809580, 0x96969600, 0xa85454a8, 0x80959580, 0xaa141414, 0x96960000, 0xaaaa1414, 0xa05050a0, 0xa0a5a5a0, 0x96000000, 0x40804080, 0xa9a8a9a8, 0xaaaaaa44, 0x2a4a5254,
];
const ANCHOR2 = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15];
const ANCHOR3A = [3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3];
const ANCHOR3B = [15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8];
const W2 = [0, 21, 43, 64], W3 = [0, 9, 18, 27, 37, 46, 55, 64], W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const WT = [W2, W2, W3, W4] as const;
const weights = (bits: number) => (bits === 2 ? W2 : bits === 3 ? W3 : W4);
void WT;

// параметры режимов: подмножества, биты разбиения, вращения, выбора индекса, цвета, альфы, P-биты (ep/shared), индексов, индексов2
const MODES = [
  { ns: 3, pb: 4, rb: 0, isb: 0, cb: 4, ab: 0, epb: 1, spb: 0, ib: 3, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 6, ab: 0, epb: 0, spb: 1, ib: 3, ib2: 0 },
  { ns: 3, pb: 6, rb: 0, isb: 0, cb: 5, ab: 0, epb: 0, spb: 0, ib: 2, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 7, ab: 0, epb: 1, spb: 0, ib: 2, ib2: 0 },
  { ns: 1, pb: 0, rb: 2, isb: 1, cb: 5, ab: 6, epb: 0, spb: 0, ib: 2, ib2: 3 },
  { ns: 1, pb: 0, rb: 2, isb: 0, cb: 7, ab: 8, epb: 0, spb: 0, ib: 2, ib2: 2 },
  { ns: 1, pb: 0, rb: 0, isb: 0, cb: 7, ab: 7, epb: 1, spb: 0, ib: 4, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 5, ab: 5, epb: 1, spb: 0, ib: 2, ib2: 0 },
];

function decodeBlock(src: Uint8Array, off: number, out: Uint8Array /* 64 */): void {
  let bit = 0;
  const get = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) { const b = bit + i; v |= ((src[off + (b >> 3)]! >> (b & 7)) & 1) << i; }
    bit += n;
    return v;
  };
  let mode = 0;
  while (mode < 8 && !get(1)) mode++;
  if (mode >= 8) { out.fill(0); return; }
  const m = MODES[mode]!;
  const part = get(m.pb), rot = get(m.rb), isel = get(m.isb);
  const ns = m.ns, ne = ns * 2;
  const ep: number[][] = Array.from({ length: ne }, () => [0, 0, 0, 255]);
  for (let c = 0; c < 3; c++) for (let e = 0; e < ne; e++) ep[e]![c] = get(m.cb);
  if (m.ab) for (let e = 0; e < ne; e++) ep[e]![3] = get(m.ab);
  // P-биты
  if (m.epb) { for (let e = 0; e < ne; e++) { const p = get(1); for (let c = 0; c < 4; c++) if (c < 3 || m.ab) ep[e]![c] = (ep[e]![c]! << 1) | p; } }
  else if (m.spb) { for (let s = 0; s < ns; s++) { const p = get(1); for (const e of [s * 2, s * 2 + 1]) for (let c = 0; c < 3; c++) ep[e]![c] = (ep[e]![c]! << 1) | p; } }
  // расширение до 8 бит
  const cbits = m.cb + (m.epb || m.spb ? 1 : 0), abits = m.ab ? m.ab + (m.epb ? 1 : 0) : 0;
  for (const e of ep) {
    for (let c = 0; c < 3; c++) e[c] = (e[c]! << (8 - cbits)) | (e[c]! >> (2 * cbits - 8));
    e[3] = abits ? (e[3]! << (8 - abits)) | (e[3]! >> (2 * abits - 8)) : 255;
  }
  const subset = (i: number) => (ns === 1 ? 0 : ns === 2 ? (PART2[part]! >> i) & 1 : (PART3[part]! >> (i * 2)) & 3);
  const anchor = (i: number) => i === 0 || (ns === 2 && i === ANCHOR2[part]) || (ns === 3 && (i === ANCHOR3A[part] || i === ANCHOR3B[part]));
  const idx = new Uint8Array(16), idx2 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) idx[i] = get(anchor(i) ? m.ib - 1 : m.ib);
  if (m.ib2) for (let i = 0; i < 16; i++) idx2[i] = get(i === 0 ? m.ib2 - 1 : m.ib2);
  for (let i = 0; i < 16; i++) {
    const s = subset(i), e0 = ep[s * 2]!, e1 = ep[s * 2 + 1]!;
    let ci = idx[i]!, ai = idx[i]!, cw = weights(m.ib), aw = weights(m.ib);
    if (m.ib2) { if (isel) { ci = idx2[i]!; cw = weights(m.ib2); } else { ai = idx2[i]!; aw = weights(m.ib2); } }
    const o = i * 4;
    for (let c = 0; c < 3; c++) out[o + c] = ((64 - cw[ci]!) * e0[c]! + cw[ci]! * e1[c]! + 32) >> 6;
    out[o + 3] = ((64 - aw[ai]!) * e0[3]! + aw[ai]! * e1[3]! + 32) >> 6;
    if (rot) { const t = out[o + 3]!; out[o + 3] = out[o + rot - 1]!; out[o + rot - 1] = t; }
  }
}

/** Распаковать BC7 (w×h) начиная с off. */
export function decodeBC7(src: Uint8Array, off: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4), blk = new Uint8Array(64), bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      decodeBlock(src, off + (by * bw + bx) * 16, blk);
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
        if (x < w && y < h) out.set(blk.subarray(i * 4, i * 4 + 4), (y * w + x) * 4);
      }
    }
  return out;
}
