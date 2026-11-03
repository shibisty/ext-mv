// LZO1X (распаковка). Используется в PAA и ODOL (Arma), встречается и в других движках.
// Поток самоограничен: распаковка идёт до маркера конца, функция возвращает позицию за ним.

/**
 * Распаковать LZO1X из src начиная с sp в dst (размер известен заранее).
 * @returns позиция в src сразу за данными (за маркером конца).
 */
export function lzo1xDecompress(src: Uint8Array, sp: number, dst: Uint8Array): number {
  let ip = sp, op = 0, t = 0, m = 0;
  const end = dst.length;
  const fail = (msg: string): never => { throw new Error(`LZO: ${msg} (вход ${ip - sp}, выход ${op}/${end})`); };
  const lit = (n: number) => {
    if (!(op + n <= end && ip + n <= src.length)) fail('выход за границы при копировании литералов');
    dst.set(src.subarray(ip, ip + n), op); op += n; ip += n;
  };
  const copy = (from: number, n: number) => {
    if (from < 0) fail('ссылка назад за начало');
    if (op + n > end) fail('переполнение выхода');
    for (let k = 0; k < n; k++) dst[op++] = dst[from + k]!;
  };
  const longLen = (base: number) => { let n = 0; while (src[ip] === 0) { n += 255; ip++; if (ip >= src.length) fail('обрыв'); } return n + base + src[ip++]!; };

  // состояния: 0 — чтение инструкции, 1 — после первой серии литералов, 2 — совпадение (t уже прочитан), 3 — хвостовые литералы
  let state = 0;
  if (src[ip]! > 17) {
    t = src[ip++]! - 17;
    if (t < 4) state = 3;
    else { lit(t); state = 1; }
  }
  for (;;) {
    // без этого обрезанный поток зацикливается на undefined (ip/op становятся NaN — поэтому сравнение «не меньше»)
    if (!(ip < src.length) || !(op <= end)) fail('обрыв входа');
    if (state === 0) {
      t = src[ip++]!;
      if (t >= 16) { state = 2; continue; }
      if (t === 0) t = longLen(15);
      lit(t + 3);
      state = 1;
      continue;
    }
    if (state === 1) {
      t = src[ip++]!;
      if (t >= 16) { state = 2; continue; }
      m = op - 0x801 - (t >> 2) - (src[ip++]! << 2);
      copy(m, 3);
    } else if (state === 2) {
      if (t >= 64) {
        m = op - 1 - ((t >> 2) & 7) - (src[ip++]! << 3);
        copy(m, (t >> 5) + 1);
      } else if (t >= 32) {
        t &= 31;
        if (t === 0) t = longLen(31);
        m = op - 1 - ((src[ip]! | (src[ip + 1]! << 8)) >> 2);
        ip += 2;
        copy(m, t + 2);
      } else if (t >= 16) {
        m = op - ((t & 8) << 11);
        t &= 7;
        if (t === 0) t = longLen(7);
        m -= (src[ip]! | (src[ip + 1]! << 8)) >> 2;
        ip += 2;
        if (m === op) return ip; // конец потока
        m -= 0x4000;
        copy(m, t + 2);
      } else {
        m = op - 1 - (t >> 2) - (src[ip++]! << 2);
        copy(m, 2);
      }
    } else {
      // state 3: t литералов (1..3), затем сразу совпадение
      lit(t);
      t = src[ip++]!;
      state = 2;
      continue;
    }
    // после совпадения: младшие 2 бита предпоследнего байта — число литералов
    t = src[ip - 2]! & 3;
    if (t === 0) state = 0;
    else state = 3;
    if (ip >= src.length && op >= end) return ip;
  }
}
