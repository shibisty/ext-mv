// LZHUF (LZSS + адаптивный Хаффман, схема Окумуры 1988): N = 4096, F = 60, порог 2.
// В xrCore перестройка дерева — при частоте корня 0x4000 (а не 0x8000, как в исходном LZHUF.C); проверено на архивах Чистого неба.
// В X-Ray так сжаты чанки с флагом 0x80000000 (заголовки архивов .db, части level-файлов). Вход: u32 размер + поток бит.
const N = 4096, F = 60, THRESHOLD = 2, N_CHAR = 256 - THRESHOLD + F, T = N_CHAR * 2 - 1, R = T - 1, MAX_FREQ = 0x4000;

// таблицы декодирования старших 6 бит позиции: коды длиной 3..8 бит (1, 3, 8, 12, 24, 16 кодов)
const D_CODE = new Uint8Array(256), D_LEN = new Uint8Array(256);
{
  let i = 0, code = 0;
  [[3, 1], [4, 3], [5, 8], [6, 12], [7, 24], [8, 16]].forEach(([len, n]) => {
    for (let k = 0; k < n!; k++, code++) for (let r = 0; r < 1 << (8 - len!); r++) { D_CODE[i] = code; D_LEN[i] = len!; i++; }
  });
}

/** Распаковать LZHUF. outSize — если размер известен заранее (иначе берётся из первых 4 байт). */
export function lzhufDecompress(src: Uint8Array, outSize?: number): Uint8Array {
  let ip = 0;
  const size = outSize ?? (src[0]! | (src[1]! << 8) | (src[2]! << 16) | (src[3]! << 24)) >>> 0;
  if (outSize === undefined) ip = 4;
  // зашифрованный или чужой поток даёт абсурдный размер: больше 64× сжатого считаем признаком шифрования
  if (size > Math.max(1 << 16, src.length * 64)) throw new Error(`LZHUF: неправдоподобный размер ${size} (данные зашифрованы или повреждены)`);
  const out = new Uint8Array(size);
  const freq = new Uint32Array(T + 1), prnt = new Int32Array(T + N_CHAR), son = new Int32Array(T);
  for (let i = 0; i < N_CHAR; i++) { freq[i] = 1; son[i] = i + T; prnt[i + T] = i; }
  for (let i = 0, j = N_CHAR; j <= R; i += 2, j++) { freq[j] = freq[i]! + freq[i + 1]!; son[j] = i; prnt[i] = prnt[i + 1] = j; }
  freq[T] = 0xffff; prnt[R] = 0;

  let getbuf = 0, getlen = 0;
  const fill = () => { while (getlen <= 8) { getbuf = (getbuf | ((ip < src.length ? src[ip++]! : 0) << (8 - getlen))) & 0xffff; getlen += 8; } };
  const bit = () => { fill(); const i = getbuf; getbuf = (getbuf << 1) & 0xffff; getlen--; return (i >> 15) & 1; };
  const byte = () => { fill(); const i = getbuf; getbuf = (getbuf << 8) & 0xffff; getlen -= 8; return (i >> 8) & 0xff; };

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
        const i = son[c]!;
        prnt[i] = l; if (i < T) prnt[i + 1] = l;
        const j = son[l]!;
        son[l] = i;
        prnt[j] = c; if (j < T) prnt[j + 1] = c;
        son[c] = j;
        c = l;
      }
    } while ((c = prnt[c]!) !== 0);
  };
  const decodeChar = () => { let c = son[R]!; while (c < T) c = son[c + bit()]!; c -= T; update(c); return c; };
  const decodePosition = () => {
    let i = byte();
    const c = D_CODE[i]! << 6;
    let j = D_LEN[i]! - 2;
    while (j--) i = (i << 1) + bit();
    return c | (i & 0x3f);
  };

  const text = new Uint8Array(N).fill(0x20);
  let r = N - F, o = 0;
  while (o < size) {
    const c = decodeChar();
    if (c < 256) { out[o++] = c; text[r] = c; r = (r + 1) & (N - 1); }
    else {
      const i = (r - decodePosition() - 1) & (N - 1), len = c - 255 + THRESHOLD;
      for (let k = 0; k < len && o < size; k++) { const b = text[(i + k) & (N - 1)]!; out[o++] = b; text[r] = b; r = (r + 1) & (N - 1); }
    }
  }
  return out;
}
