// Анимации Dunia (Far Cry 2) .mab — разобрано по файлам игры (заголовок и упаковка кватернионов — как в заметках
// PY-DuniaAnimationExtractor для Far Cry 3; раскладка разделов Far Cry 2, маски костей и блоки ключей — по образцам).
//   0x00: u8 0x4c (Far Cry 2), u8 0, u8 версия (2 — 15 ключей/с, 3 — 30), u8 0; u32 CRC; 8 байт.
//   0x10: четыре маски костей по 160 бит (5 × u32): 0 — постоянный поворот, 1 — анимированный поворот,
//         2 — постоянное смещение, 3 — анимированное смещение. Номер бита — номер кости в списке O2BM модели.
//   0x84: f32 длительность (с); 0x88: 10 × u32 смещений разделов (от 0x10): 0 — смещение корня по ключам, 1 — поворот
//         корня по ключам, 2 — постоянные повороты, 3 — повороты по ключам, 4 — постоянные смещения, 5 — смещения по ключам,
//         дальше — события (PlaySound…) и прочее.
//   Корень: u16 1, u16 ключей, u32; затем ключи (кватернион 6 байт / f32×3).
//   Постоянные: u32 n, u32 0, n × (кватернион 6 байт / f32×3) — по костям маски в порядке битов.
//   Смещения по ключам: u16 дорожек, u16 ключей, u32; по дорожке — все ключи f32×3.
//   Повороты по ключам: u16 дорожек, u16 ключей, u32; u32 смещения блоков (по 8 ключей; последнее — конец);
//     блок: первый ключ блока у всех дорожек (6 байт), по байту-маске на дорожку (бит k — есть ключ 8·b+1+k),
//     выравнивание до 2, затем по дорожкам их ключи по маске. Пропущенные ключи — интерполяция.
//   Кватернион 6 байт: три u16, компонента = (v & 0x7fff) · 4.315969e-5 − 0.7071068, четвёртая — из нормы;
//     старшие биты первых двух слов — какая компонента пропущена (как «три меньших»).
import type { NodeChannel, NodeMotion } from '../../core/types';

const K = 4.315969e-5, H = 0.7071068;

/** Кватернион из 6 байт -> [w, x, y, z]. */
export function unpackQuat(a: number, b: number, c: number): number[] {
  const f1 = (a & 0x7fff) * K - H, f2 = (b & 0x7fff) * K - H, f3 = (c & 0x7fff) * K - H;
  const f4 = Math.sqrt(Math.max(0, 1 - f1 * f1 - f2 * f2 - f3 * f3));
  const A = a >> 15, B = b >> 15;
  // (x, y, z, w)
  const q = A === 0 && B === 1 ? [f1, f2, f4, f3] : A === 1 && B === 1 ? [f1, f2, f3, f4] : A === 1 ? [f1, f4, f2, f3] : [f4, f1, f2, f3];
  return [q[3]!, q[0]!, q[1]!, q[2]!];
}

export interface MabAnim {
  version: number; duration: number; rate: number; keys: number;
  rootRot: number[][] | null; rootPos: number[][] | null;
  constRot: Map<number, number[]>; rotKeys: Map<number, number[][]>;
  constPos: Map<number, number[]>; posKeys: Map<number, number[][]>;
}

const maskBits = (dv: DataView, at: number): number[] => {
  const out: number[] = [];
  for (let w = 0; w < 5; w++) { const v = dv.getUint32(at + w * 4, true); for (let b = 0; b < 32; b++) if (v & (1 << b)) out.push(w * 32 + b); }
  return out;
};

const nlerp = (a: number[], b: number[], t: number) => {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!, s = d < 0 ? -1 : 1;
  const q = a.map((v, i) => v + (s * b[i]! - v) * t), l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
};

export function parseMab(u: Uint8Array): MabAnim {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 0xb0 || u[0] !== 0x4c) throw new Error(`Анимация Dunia: версия 0x${(u[0] ?? 0).toString(16)} не поддерживается (нужна 0x4c — Far Cry 2)`);
  const version = u[2]!, sec = Array.from({ length: 10 }, (_, i) => { const o = dv.getUint32(0x88 + i * 4, true); return o ? o + 0x10 : 0; });
  const masks = [0, 1, 2, 3].map((m) => maskBits(dv, 0x10 + m * 20));
  const duration = dv.getFloat32(0x84, true);
  const q6 = (o: number) => unpackQuat(dv.getUint16(o, true), dv.getUint16(o + 2, true), dv.getUint16(o + 4, true));
  const v3 = (o: number) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
  const check = (o: number, n: number) => { if (o + n > u.length) throw new Error('.mab: раздел за концом файла'); };
  if (!sec[3]) throw new Error('.mab: нет поворотов по ключам');
  const nb = dv.getUint16(sec[3], true), keys = dv.getUint16(sec[3] + 2, true);
  if (nb !== masks[1]!.length) throw new Error(`.mab: дорожек ${nb}, а в маске ${masks[1]!.length}`);
  // ключей в секунду: по длительности (близкое к 15/30 — округляется), без неё — по версии (2 — 15, 3 — 30)
  const raw = duration > 0 && keys > 1 ? (keys - 1) / duration : version >= 3 ? 30 : 15;
  const rate = [15, 30].find((r) => Math.abs(raw - r) < r * 0.02) ?? raw;
  const anim: MabAnim = { version, duration, rate, keys, rootRot: null, rootPos: null, constRot: new Map(), rotKeys: new Map(), constPos: new Map(), posKeys: new Map() };
  // корень
  if (sec[1]) { const n = dv.getUint16(sec[1] + 2, true); check(sec[1] + 8, n * 6); anim.rootRot = Array.from({ length: n }, (_, k) => q6(sec[1]! + 8 + k * 6)); }
  if (sec[0]) { const n = dv.getUint16(sec[0] + 2, true); check(sec[0] + 8, n * 12); anim.rootPos = Array.from({ length: n }, (_, k) => v3(sec[0]! + 8 + k * 12)); }
  // постоянные
  if (sec[2]) { const n = dv.getUint32(sec[2], true); check(sec[2] + 8, n * 6); masks[0]!.slice(0, n).forEach((b, i) => anim.constRot.set(b, q6(sec[2]! + 8 + i * 6))); }
  if (sec[4]) { const n = dv.getUint32(sec[4], true); check(sec[4] + 8, n * 12); masks[2]!.slice(0, n).forEach((b, i) => anim.constPos.set(b, v3(sec[4]! + 8 + i * 12))); }
  if (sec[5]) {
    const nt = dv.getUint16(sec[5], true), nk = dv.getUint16(sec[5] + 2, true);
    check(sec[5] + 8, nt * nk * 12);
    masks[3]!.slice(0, nt).forEach((b, t) => anim.posKeys.set(b, Array.from({ length: nk }, (_, k) => v3(sec[5]! + 8 + (t * nk + k) * 12))));
  }
  // повороты по ключам: блоки по 8
  const nblk = nb ? Math.ceil(keys / 8) : 0; // без анимированных поворотов (только постоянные позы) блоков нет
  check(sec[3] + 8, (nblk + 1) * 4);
  const offs = Array.from({ length: nblk + 1 }, (_, i) => dv.getUint32(sec[3]! + 8 + i * 4, true));
  const tracks: Array<Array<number[] | null>> = Array.from({ length: nb }, () => new Array(keys).fill(null));
  for (let bi = 0; bi < nblk; bi++) {
    let p = sec[3] + offs[bi]!;
    check(p, nb * 7);
    for (let t = 0; t < nb; t++) if (bi * 8 < keys) tracks[t]![bi * 8] = q6(p + t * 6);
    p += nb * 6;
    const mask = u.subarray(p, p + nb);
    p += nb; p += p & 1;
    for (let t = 0; t < nb; t++) {
      for (let k = 0; k < 8; k++) {
        if (!(mask[t]! & (1 << k))) continue;
        check(p, 6);
        const key = bi * 8 + 1 + k;
        if (key < keys) tracks[t]![key] = q6(p);
        p += 6;
      }
    }
  }
  tracks.forEach((tr, t) => {
    // пропуски: интерполяция между соседними ключами (последний — держится)
    let last = -1;
    for (let k = 0; k < keys; k++) {
      if (!tr[k]) continue;
      if (last >= 0 && k - last > 1) for (let j = last + 1; j < k; j++) tr[j] = nlerp(tr[last]!, tr[k]!, (j - last) / (k - last));
      last = k;
    }
    for (let k = last + 1; k < keys && last >= 0; k++) tr[k] = tr[last]!;
    if (last >= 0) anim.rotKeys.set(masks[1]![t]!, tr as number[][]);
  });
  return anim;
}

const qmul = (p: number[], q: number[]) => [
  p[0]! * q[0]! - p[1]! * q[1]! - p[2]! * q[2]! - p[3]! * q[3]!, p[0]! * q[1]! + p[1]! * q[0]! + p[2]! * q[3]! - p[3]! * q[2]!,
  p[0]! * q[2]! - p[1]! * q[3]! + p[2]! * q[0]! + p[3]! * q[1]!, p[0]! * q[3]! + p[1]! * q[2]! - p[2]! * q[1]! + p[3]! * q[0]!,
];

/** Кватернион [w,x,y,z] поворотной части матрицы (column-major). */
export function matQuat(m: ArrayLike<number>): number[] {
  const m00 = m[0]!, m11 = m[5]!, m22 = m[10]!, tr = m00 + m11 + m22;
  let q: number[];
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [s / 4, (m[6]! - m[9]!) / s, (m[8]! - m[2]!) / s, (m[1]! - m[4]!) / s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [(m[6]! - m[9]!) / s, s / 4, (m[4]! + m[1]!) / s, (m[8]! + m[2]!) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m[8]! - m[2]!) / s, (m[4]! + m[1]!) / s, s / 4, (m[9]! + m[6]!) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m[1]! - m[4]!) / s, (m[8]! + m[2]!) / s, (m[9]! + m[6]!) / s, s / 4]; }
  const l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
}

/**
 * Анимация для узлов модели: bones[i] — узел для кости i (список O2BM). fix — для костей, чей родитель в модели не кость
 * (таз): матрица C = (мировая поза родителя)⁻¹ · T, переводящая позу кости из кадра анимации в пространство родителя-узла.
 */
export function buildMabMotion(name: string, a: MabAnim, bones: readonly number[], fix: ReadonlyMap<number, ArrayLike<number>> = new Map(),
  root?: { bone: number; rot: number[]; pos: number[] }): NodeMotion {
  const chan = new Map<number, NodeChannel>();
  const get = (b: number) => { const n = bones[b]; if (n === undefined || n < 0) return null; let c = chan.get(n); if (!c) { c = { pos: null, rot: null, scl: null }; chan.set(n, c); } return c; };
  const rotOf = (b: number, q: number[]) => { const C = fix.get(b); return C ? qmul(matQuat(C), q) : q; };
  const posOf = (b: number, p: number[]) => { const C = fix.get(b); return C ? [0, 1, 2].map((i) => C[i]! * p[0]! + C[4 + i]! * p[1]! + C[8 + i]! * p[2]! + C[12 + i]!) : p; };
  for (const [b, q] of a.constRot) { const c = get(b); if (c) c.rot = [[0, rotOf(b, q)]]; }
  for (const [b, list] of a.rotKeys) { const c = get(b); if (c) c.rot = list.map((q, k) => [k, rotOf(b, q)]); }
  for (const [b, v] of a.constPos) { const c = get(b); if (c) c.pos = [[0, posOf(b, v)]]; }
  for (const [b, list] of a.posKeys) { const c = get(b); if (c) c.pos = list.map((p, k) => [k, posOf(b, p)]); }
  // движение корня: D(k) = M(0)⁻¹ · M(k) (в осях первого ключа: персонаж стартует на месте и идёт «вперёд»),
  // кость-корень скелета (таз) = D(k) · своя поза
  const n = Math.max(a.rootPos?.length ?? 0, a.rootRot?.length ?? 0);
  if (root && n > 1 && bones[root.bone] !== undefined && bones[root.bone]! >= 0) {
    const r0 = a.rootRot?.[0] ?? [1, 0, 0, 0], p0 = a.rootPos?.[0] ?? [0, 0, 0], inv0 = conj(r0);
    let moves = false;
    const D = Array.from({ length: n }, (_, k) => {
      const rk = a.rootRot?.[k] ?? r0, pk = a.rootPos?.[k] ?? p0;
      const q = qmul(inv0, rk), t = qrot(inv0, pk.map((v, i) => v - p0[i]!));
      if (Math.abs(q[0]!) < 0.9999 || Math.hypot(...t) > 1e-3) moves = true;
      return { q, t };
    });
    if (moves) {
      const b = root.bone, keys = Math.max(n, a.keys);
      const rotK = (k: number) => a.rotKeys.get(b)?.[Math.min(k, a.keys - 1)] ?? a.constRot.get(b) ?? root.rot;
      const posK = (k: number) => a.posKeys.get(b)?.[Math.min(k, a.keys - 1)] ?? a.constPos.get(b) ?? root.pos;
      const c = get(b)!;
      c.rot = []; c.pos = [];
      for (let k = 0; k < keys; k++) {
        const d = D[Math.min(k, n - 1)]!, pp = qrot(d.q, posK(k)).map((v, i) => v + d.t[i]!);
        c.rot.push([k, rotOf(b, qmul(d.q, rotK(k)))]);
        c.pos.push([k, posOf(b, pp)]);
      }
    }
  }
  return { kind: 'node', name, tps: a.rate, chan, duration: a.duration, frames: a.keys };
}

const conj = (q: number[]) => [q[0]!, -q[1]!, -q[2]!, -q[3]!];
const qrot = (q: number[], v: number[]) => qmul(qmul(q, [0, v[0]!, v[1]!, v[2]!]), conj(q)).slice(1);

/**
 * Скелет анимаций .skeleton («LKS\0» — SKL наоборот; u32 0x12, u32 хеш скелета, u32 7, u16 число костей, u16).
 * Запись: u32 хеш скелета, u32 7, кватернион xyzw, позиция f32×3, f32, u16 номер, u16 родитель (0xffff — корень),
 * u16 первый ребёнок, u16 следующий, флаги (у костей-«твистов» — ещё ведущая кость и доля), u32 хеш имени, u32 длина,
 * имя, 0, хвост. Номер кости в масках .mab — номер записи. Записи ищутся по метке «хеш скелета + 7».
 */
export interface DuniaSkelBone { name: string; parent: number; rot: number[]; pos: number[] }

export function parseSkeleton(u: Uint8Array): DuniaSkelBone[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 28 || String.fromCharCode(u[2]!, u[1]!, u[0]!) !== 'SKL') throw new Error('Не скелет Dunia (нет «SKL»)');
  const n = dv.getUint16(16, true), key = dv.getUint32(8, true), out: DuniaSkelBone[] = [];
  let p = 0x14;
  const isKey = (o: number) => o + 8 <= u.length && dv.getUint32(o, true) === key && dv.getUint32(o + 4, true) === 7;
  for (let i = 0; i < n; i++) {
    while (p < u.length && !isKey(p)) p++;
    if (p + 58 > u.length) throw new Error('.skeleton: записей меньше, чем объявлено');
    const f = (k: number) => dv.getFloat32(p + 8 + k * 4, true);
    const parent = dv.getUint16(p + 42, true);
    // имя: u32 длина, печатные символы (за ними — 0, у корня — флаги)
    let name = '';
    for (let o = p + 50; o + 4 < Math.min(u.length, p + 80); o++) {
      const len = dv.getUint32(o, true);
      if (len < 1 || len > 64 || o + 4 + len >= u.length || (u[o + 4 + len]! >= 32 && u[o + 4 + len]! < 127)) continue;
      let ok = true, s = '';
      for (let k = 0; k < len && ok; k++) { const c = u[o + 4 + k]!; ok = c >= 32 && c < 127; s += String.fromCharCode(c); }
      if (ok) { name = s; break; }
    }
    out.push({ name, parent: parent === 0xffff ? -1 : parent, rot: [f(3), f(0), f(1), f(2)], pos: [f(4), f(5), f(6)] });
    p += 58;
  }
  return out;
}
