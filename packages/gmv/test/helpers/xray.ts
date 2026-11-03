// Синтетика X-Ray: упаковщик LZHUF (жадный поиск совпадений + то же адаптивное дерево, что у распаковщика)
// и архив .db (чанки [header], данные, сжатая таблица файлов).
import { Bin } from './bin';
import { socEncode } from '../../src/engines/xray/soc-key';

const N = 4096, F = 60, THRESHOLD = 2, N_CHAR = 256 - THRESHOLD + F, T = N_CHAR * 2 - 1, R = T - 1, MAX_FREQ = 0x4000;

export function lzhufCompress(data: Uint8Array): Uint8Array {
  const freq = new Uint32Array(T + 1), prnt = new Int32Array(T + N_CHAR), son = new Int32Array(T);
  for (let i = 0; i < N_CHAR; i++) { freq[i] = 1; son[i] = i + T; prnt[i + T] = i; }
  for (let i = 0, j = N_CHAR; j <= R; i += 2, j++) { freq[j] = freq[i]! + freq[i + 1]!; son[j] = i; prnt[i] = prnt[i + 1] = j; }
  freq[T] = 0xffff; prnt[R] = 0;
  const reconst = () => {
    let j = 0;
    for (let i = 0; i < T; i++) if (son[i]! >= T) { freq[j] = (freq[i]! + 1) >> 1; son[j] = son[i]!; j++; }
    for (let i = 0, jj = N_CHAR; jj < T; i += 2, jj++) {
      const f = (freq[jj] = freq[i]! + freq[i + 1]!);
      let k = jj - 1;
      while (f < freq[k]!) k--;
      k++;
      freq.copyWithin(k + 1, k, jj); freq[k] = f;
      son.copyWithin(k + 1, k, jj); son[k] = i;
    }
    for (let i = 0; i < T; i++) { const k = son[i]!; if (k >= T) prnt[k] = i; else prnt[k] = prnt[k + 1] = i; }
  };
  const update = (ch: number) => {
    if (freq[R] === MAX_FREQ) reconst();
    let c = prnt[ch + T]!;
    do {
      const k = ++freq[c]!;
      let l = c + 1;
      if (k > freq[l]!) {
        while (k > freq[++l]!);
        l--;
        freq[c] = freq[l]!; freq[l] = k;
        const i = son[c]!; prnt[i] = l; if (i < T) prnt[i + 1] = l;
        const j = son[l]!; son[l] = i; prnt[j] = c; if (j < T) prnt[j + 1] = c;
        son[c] = j; c = l;
      }
    } while ((c = prnt[c]!) !== 0);
  };
  const out: number[] = [data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff, (data.length >>> 24) & 0xff];
  let putbuf = 0, putlen = 0;
  const putcode = (l: number, c: number) => { // c — старшие l бит 16-битного слова
    for (let b = 0; b < l; b++) {
      putbuf = (putbuf << 1) | ((c >> (15 - b)) & 1); putlen++;
      if (putlen === 8) { out.push(putbuf & 0xff); putbuf = 0; putlen = 0; }
    }
  };
  const encodeChar = (c: number) => {
    const bits: number[] = [];
    let k = prnt[c + T]!;
    do { bits.push(k & 1); } while ((k = prnt[k]!) !== R);
    bits.reverse().forEach((b) => putcode(1, b << 15));
    update(c);
  };
  // коды старших 6 бит позиции: 1×3, 3×4, 8×5, 12×6, 24×7, 16×8 бит, канонически по возрастанию первого байта
  const pLen: number[] = [], pCode: number[] = [];
  { let first = 0; [[3, 1], [4, 3], [5, 8], [6, 12], [7, 24], [8, 16]].forEach(([len, n]) => { for (let k = 0; k < n!; k++) { pLen.push(len!); pCode.push(first); first += 1 << (8 - len!); } }); }
  const encodePosition = (p: number) => { const i = p >> 6; putcode(pLen[i]!, pCode[i]! << 8); putcode(6, (p & 0x3f) << 10); };
  for (let o = 0; o < data.length;) {
    let best = 0, bestS = 0;
    for (let s = Math.max(0, o - (N - F - 1)); s < o; s++) {
      let l = 0;
      while (l < F && o + l < data.length && data[s + l] === data[o + l]) l++;
      if (l > best) { best = l; bestS = s; }
    }
    if (best > THRESHOLD) { encodeChar(255 - THRESHOLD + best); encodePosition((o - bestS - 1) & (N - 1)); o += best; }
    else encodeChar(data[o++]!);
  }
  if (putlen) out.push((putbuf << (8 - putlen)) & 0xff);
  return Uint8Array.from(out);
}

/** LZO1X из одних литералов (до 238 байт): первый байт 17 + n, маркер конца 0x11 0 0. */
export function lzoLiterals(data: Uint8Array): Uint8Array {
  if (data.length < 4 || data.length > 238) throw new Error('lzoLiterals: 4..238 байт');
  return Uint8Array.from([17 + data.length, ...data, 0x11, 0, 0]);
}

/** Архив .db как у Чистого неба: [header], данные, сжатая таблица. files: путь -> содержимое (lzo — хранить сжатым). */
export function makeXrayDb(files: Array<{ path: string; data: Uint8Array; lzo?: boolean }>, dirs: string[] = []): Uint8Array {
  const b = new Bin(), hdr = '[header]\r\nauto_load = true\r\n';
  b.u32(0x29a).u32(hdr.length).ascii(hdr);
  b.u32(0);
  const sizeAt = b.pos;
  b.u32(0);
  const table = new Bin();
  const entry = (name: string, real: number, packed: number, off: number) => { table.u16(16 + name.length).u32(real).u32(packed).u32(0).ascii(name).u32(off); };
  for (const d of dirs) entry(d, 0, 0, 0);
  const start = b.pos;
  for (const f of files) {
    const stored = f.lzo ? lzoLiterals(f.data) : f.data;
    entry(f.path, f.data.length, stored.length, b.pos);
    b.bytes(stored);
  }
  b.patchU32(sizeAt, b.pos - start);
  const packed = lzhufCompress(table.toU8());
  b.u32(0x80000001).u32(packed.length).bytes(packed);
  return b.toU8();
}

/** Архив как у «Тени Чернобыля»: без [header], таблица сжата LZHUF и зашифрована (ключ — тестовый, не игровой). */
export function makeSocDb(files: Array<{ path: string; data: Uint8Array }>, key: { tableSeed: number; encryptSeed: number; iterations: number }): Uint8Array {
  const b = new Bin();
  b.u32(0);
  const sizeAt = b.pos;
  b.u32(0);
  const table = new Bin(), start = b.pos;
  table.u16(16 + 4).u32(0).u32(0).u32(0).ascii('dir\\').u32(0);
  for (const f of files) { table.u16(16 + f.path.length).u32(f.data.length).u32(f.data.length).u32(0).ascii(f.path).u32(b.pos); b.bytes(f.data); }
  b.patchU32(sizeAt, b.pos - start);
  const packed = socEncode(key, lzhufCompress(table.toU8()));
  b.u32(0x80000001).u32(packed.length).bytes(packed);
  return b.toU8();
}
/** Минимальный PE: раздел кода и раздел данных (.data) со значениями (среди них — зёрна ключа). */
export function makePe(dataWords: number[]): Uint8Array {
  const b = new Bin();
  b.u16(0x5a4d).zeros(0x3a).u32(0x40);
  b.u32(0x4550).u16(0x14c).u16(2).zeros(12).u16(0).u16(0); // заголовок: 2 раздела, без опционального
  const sec = (name: string, raw: number, ptr: number, ch: number) => { b.fixed(name, 8).u32(raw).u32(0).u32(raw).u32(ptr).zeros(12).u32(ch); };
  const textAt = 0x200, dataAt = 0x400;
  sec('.text', 0x200, textAt, 0x60000020);
  sec('.data', dataWords.length * 4, dataAt, 0xc0000040);
  b.seek(textAt); for (let i = 0; i < 128; i++) b.u32(0xdeadbeef ^ i * 7919); // в коде ключей нет
  b.seek(dataAt); for (const w of dataWords) b.u32(w);
  return b.toU8();
}

