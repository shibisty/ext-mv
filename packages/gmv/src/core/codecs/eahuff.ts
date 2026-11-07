// EA Huffman (семейство 0x30FB: Refpack-эпоха, NFS Underground…World — блоки «HUFF»). Каноничный код, числа в
// «getnum»-кодировке, символ-«подсказка» (clue) для повторов и литералов; 0x32FB — дельта, 0x34FB — двойная дельта.
// Порядок битов — старший первым.

export function eaHuff(src: Uint8Array): Uint8Array {
  let pos = 0;
  const bit = (): number => { const i = pos >> 3; const b = i < src.length ? (src[i]! >> (7 - (pos & 7))) & 1 : 0; pos++; return b; };
  const bits = (n: number): number => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
  const getnum = (): number => {
    if (bit()) return bits(2);
    let z = 1;
    while (!bit()) { if (++z > 30) throw new Error('HUFF: поток повреждён'); }
    const n = z + 2;
    return bits(n) + (1 << n) - 4;
  };
  const type = bits(16);
  let ulen: number;
  if (type & 0x8000) { if (type & 0x100) bits(32); ulen = bits(32); }
  else { if (type & 0x100) bits(24); ulen = bits(24); }
  const clue = bits(8);
  // длины кодов: на каждом уровне — число кодов этой длины
  const first: number[] = [], cnt: number[] = [], offs: number[] = [];
  let base = 0, numchars = 0, n = 1;
  for (;;) {
    base *= 2; first[n] = base; offs[n] = base - numchars;
    const c = getnum(); numchars += c; base += c; cnt[n] = c;
    if (n > 32) throw new Error('HUFF: таблица кодов повреждена');
    const done = c !== 0 && (((base << (16 - n)) & 0xffff) === 0);
    n++;
    if (done) break;
  }
  const maxBits = n - 1;
  // символы в порядке кодов: «прыжки» по ещё не занятым байтам
  const used = new Uint8Array(256), order: number[] = [];
  let last = -1;
  for (let i = 0; i < numchars; i++) {
    let leap = getnum() + 1, guard = 0;
    for (;;) { last = (last + 1) & 255; if (!used[last]) leap--; if (leap === 0) break; if (++guard > 1 << 20) throw new Error('HUFF: неверный список символов'); }
    used[last] = 1; order.push(last);
  }
  const out = new Uint8Array(ulen);
  let op = 0;
  const limitBits = src.length * 8 + 64;
  while (op < ulen && pos <= limitBits) {
    let len = 1, v = bit();
    while (!(cnt[len] && v >= first[len]! && v < first[len]! + cnt[len]!)) {
      len++; v = v * 2 + bit();
      if (len > maxBits) throw new Error('HUFF: неверный код');
    }
    const sym = order[v - offs[len]!]!;
    if (sym !== clue) { out[op++] = sym; continue; }
    const run = getnum();
    if (run) { const p = op ? out[op - 1]! : 0; for (let i = 0; i < run && op < ulen; i++) out[op++] = p; continue; }
    if (bit() === 0) { out[op++] = bits(8); continue; }
    break;
  }
  if (type === 0x32fb || type === 0xb2fb) { let s = 0; for (let i = 0; i < ulen; i++) { s = (s + out[i]!) & 255; out[i] = s; } }
  else if (type === 0x34fb || type === 0xb4fb) { let s = 0, t = 0; for (let i = 0; i < ulen; i++) { s = (s + out[i]!) & 255; t = (t + s) & 255; out[i] = t; } }
  return out;
}
