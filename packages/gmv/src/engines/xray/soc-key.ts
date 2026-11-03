// Таблицы файлов архивов «Тени Чернобыля» (gamedata.db*) зашифрованы простым шифром движка (trivial_encryptor xrCore):
// подстановка байта по таблице 256 + XOR с потоком генератора random32 (seed = 0x08088405·seed + 1, значение — старшие
// биты произведения на диапазон). Таблица подстановки строится перестановками от своего зерна, поток — от другого.
// Ключи (два зерна) в просмотрщик не встроены: они ищутся в исполняемом файле игры пользователя (XR_3DA.exe) —
// перебираются 32-битные значения его разделов данных, а верный ключ узнаётся по тому, что таблица файлов архива после
// расшифровки распаковывается LZHUF и разбирается без ошибок. Число перестановок — из небольшого набора степеней двойки.
import { lzhufDecompress } from '../../core/codecs/lzhuf';

export interface SocKey { tableSeed: number; encryptSeed: number; iterations: number }

/** Генератор random32 движка. */
function random32(seed: number): (range: number) => number {
  let s = seed >>> 0;
  return (range) => { s = (Math.imul(0x08088405, s) + 1) >>> 0; return range === 256 ? s >>> 24 : Math.floor((s * range) / 4294967296); };
}

/** Обратная таблица подстановки (alphabet_back) для зерна и числа перестановок. */
export function socAlphabetBack(tableSeed: number, iterations: number): Uint8Array {
  // random(256) = старший байт нового состояния (u64(seed)·256 >> 32)
  const a = new Uint8Array(256);
  let s = tableSeed >>> 0;
  for (let i = 0; i < 256; i++) a[i] = i;
  for (let i = 0; i < iterations; i++) {
    s = (Math.imul(0x08088405, s) + 1) >>> 0;
    const j = s >>> 24;
    let k: number;
    do { s = (Math.imul(0x08088405, s) + 1) >>> 0; k = s >>> 24; } while (j === k);
    const t = a[j]!; a[j] = a[k]!; a[k] = t;
  }
  const b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) b[a[i]!] = i;
  return b;
}

export function socDecode(key: SocKey, src: Uint8Array, back = socAlphabetBack(key.tableSeed, key.iterations)): Uint8Array {
  const out = new Uint8Array(src.length), r = random32(key.encryptSeed);
  for (let i = 0; i < src.length; i++) out[i] = back[src[i]! ^ (r(256) & 255)]!;
  return out;
}

/** Обратное к socDecode (для тестов: синтетические зашифрованные архивы). */
export function socEncode(key: SocKey, src: Uint8Array): Uint8Array {
  const back = socAlphabetBack(key.tableSeed, key.iterations), a = new Uint8Array(256), r = random32(key.encryptSeed), out = new Uint8Array(src.length);
  for (let i = 0; i < 256; i++) a[back[i]!] = i;
  for (let i = 0; i < src.length; i++) out[i] = a[src[i]!]! ^ (r(256) & 255);
  return out;
}

/** 32-битные значения (с шагом 4) из неисполняемых разделов PE-файла: кандидаты в зёрна. */
export function peDataWords(exe: Uint8Array): Uint32Array {
  const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength), out = new Set<number>();
  if (exe.length < 0x40 || dv.getUint16(0, true) !== 0x5a4d) return new Uint32Array(0);
  const pe = dv.getUint32(0x3c, true);
  if (pe + 24 > exe.length || dv.getUint32(pe, true) !== 0x4550) return new Uint32Array(0);
  const ns = dv.getUint16(pe + 6, true), opt = dv.getUint16(pe + 20, true);
  // сначала изменяемые данные (.data — там глобальные объекты), затем константы (.rdata)
  const order = Array.from({ length: ns }, (_, k) => k).sort((a, b) => {
    const w = (k: number) => (pe + 24 + opt + k * 40 + 40 <= exe.length && dv.getUint32(pe + 24 + opt + k * 40 + 36, true) & 0x80000000 ? 0 : 1);
    return w(a) - w(b);
  });
  for (const k of order) {
    const o = pe + 24 + opt + k * 40;
    if (o + 40 > exe.length) break;
    const name = String.fromCharCode(...exe.subarray(o, o + 8)).replace(/\0+$/, ''), raw = dv.getUint32(o + 16, true), ptr = dv.getUint32(o + 20, true), ch = dv.getUint32(o + 36, true);
    // данные: инициализированные (0x40), не код (0x20000000 — исполняемый); ресурсы и релокации пропускаются
    if (ch & 0x20000000 || !(ch & 0x40) || name === '.rsrc' || name === '.reloc') continue;
    for (let p = ptr; p + 4 <= Math.min(exe.length, ptr + raw); p += 4) { const v = dv.getUint32(p, true); if (v > 0xffff) out.add(v); }
  }
  return Uint32Array.from(out);
}

const ITERATIONS = [2048, 1024, 4096, 512];

/**
 * Проверка ключа: сначала дёшево — первые байты (размер правдоподобен, первая запись таблицы: длина записи и начало имени),
 * затем целиком (check — разбор распакованной таблицы и границы записей).
 */
function tryKey(key: SocKey, back: Uint8Array, probe: Uint8Array, check: (table: Uint8Array) => boolean): boolean {
  // размер (первые 4 байта) — без выделения памяти
  let st = key.encryptSeed >>> 0, size = 0;
  for (let i = 0; i < 4; i++) { st = (Math.imul(0x08088405, st) + 1) >>> 0; size += back[probe[i]! ^ (st >>> 24)]! * 2 ** (8 * i); }
  if (size < 16 || size > 32 * probe.length + 1024) return false;
  try {
    // длина первой записи — по первым 16 распакованным байтам
    const pre = lzhufDecompress(socDecode(key, probe.subarray(0, Math.min(probe.length, 24)), back).subarray(4), Math.min(size, 16)), bs0 = pre[0]! | (pre[1]! << 8);
    if (bs0 < 16 || bs0 > 520 || (pre.length > 14 && (pre[14]! < 0x20 || pre[14]! > 0x7e))) return false;
    const head = socDecode(key, probe.subarray(0, Math.min(probe.length, 512)), back);
    // первые записи таблицы: u16 длина (16..520), имя из печатных символов; вторая запись — тоже правдоподобной длины
    const first = lzhufDecompress(head.subarray(4), Math.min(size, 600)), dv = new DataView(first.buffer);
    let q = 0;
    for (let rec = 0; rec < 2 && q + 2 <= first.length; rec++) {
      const bs = dv.getUint16(q, true);
      if (bs < 16 || bs > 520) return false;
      for (let k = q + 14; k < Math.min(first.length, q + 2 + bs - 4); k++) if (first[k]! < 0x20 || first[k]! > 0x7e) return false;
      q += 2 + bs;
    }
    return check(lzhufDecompress(socDecode(key, probe, back)));
  } catch { return false; }
}

/**
 * Найти ключ в исполняемом файле игры. probe — зашифрованная таблица файлов (чанк 1) любого архива, check — проверка
 * распакованной таблицы. Поиск: для каждого кандидата в зерно таблицы и числа перестановок известно, каким должен быть
 * 4-й байт потока (старший байт размера таблицы = 0), — кандидаты в зерно потока отбираются по нему и проверяются целиком.
 */
export function findSocKey(exe: Uint8Array, probe: Uint8Array, check: (table: Uint8Array) => boolean): SocKey | null {
  if (probe.length < 8) return null;
  const words = peDataWords(exe);
  // первые 4 байта потока для каждого кандидата в зерно потока: по 4-му — индекс
  const byK3 = new Map<number, number[]>();
  for (const w of words) {
    const r = random32(w);
    r(256); r(256); r(256);
    const k3 = r(256) & 255;
    let l = byK3.get(k3);
    if (!l) byK3.set(k3, (l = []));
    l.push(w);
  }
  for (const iterations of ITERATIONS) {
    for (const tableSeed of words) {
      const back = socAlphabetBack(tableSeed, iterations);
      // back[c3 ^ k3] = 0 → k3 = c3 ^ alphabet[0]
      let a0 = 0;
      for (let i = 0; i < 256; i++) if (back[i] === 0) { a0 = i; break; }
      for (const encryptSeed of byK3.get(probe[3]! ^ a0) ?? []) {
        if (encryptSeed === tableSeed) continue;
        const key = { tableSeed, encryptSeed, iterations };
        if (tryKey(key, back, probe, check)) return key;
      }
    }
  }
  return null;
}
