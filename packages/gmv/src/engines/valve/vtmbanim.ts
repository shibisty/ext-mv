// VTMB (MDL v2531): кости, анимации и «include»-модели с общими анимациями (models/character/shared/…).
// Кость — 160 байт: имя @0 (отн.), родитель @4, позиция @32, кватернион xyzw @44, масштаб позиции @60, поворота @72 (4),
// poseToBone 3×4 @88. Описание анимации — 72 байта: имя @0, fps @4, кадров @12, данные @48 (от начала описания).
// Данные: на каждую кость 32 байта — float, 7 смещений (от начала записи) RLE-потоков (как в GoldSrc): x, y, z позиции
// (значение × масштаб + позиция покоя) и x, y, z, w кватерниона (значение × масштаб, абсолютный). Нет потоков — поза покоя.
import { cstr } from '../../core/binary';
import { quatMat } from '../../core/math';
import type { SkeletonNode } from '../../core/skeleton';
import type { NodeChannel, NodeMotion } from '../../core/types';

export interface VBone { name: string; parent: number; pos: number[]; q: number[]; ps: number[]; rs: number[]; poseToBone: number[]; flags: number }

export function vtmbBones(buf: ArrayBuffer): VBone[] {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), I = (o: number) => dv.getInt32(o, true), F = (o: number) => dv.getFloat32(o, true);
  const n = I(240), ob = I(244), out: VBone[] = [];
  if (n <= 0 || n > 512 || ob + n * 160 > buf.byteLength) return out;
  for (let i = 0; i < n; i++) {
    const o = ob + i * 160, f = (k: number, c: number) => Array.from({ length: c }, (_, j) => F(o + k + j * 4));
    out.push({ name: cstr(u8, o + I(o), 64), parent: I(o + 4), pos: f(32, 3), q: f(44, 4), ps: f(60, 3), rs: f(72, 4), poseToBone: f(88, 12), flags: I(o + 136) });
  }
  return out;
}

/** Узлы скелета: локальная поза покоя и обратная bind-матрица из poseToBone (3×4 по строкам). */
export function vtmbNodes(bones: VBone[]): SkeletonNode[] {
  return bones.map((b) => {
    const P = b.poseToBone, off = new Float64Array(16);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) off[c * 4 + r] = P[r * 4 + c]!;
    off[15] = 1;
    return { name: b.name, parent: b.parent, local: quatMat([b.q[3]!, b.q[0]!, b.q[1]!, b.q[2]!], b.pos), offset: off };
  });
}

/** Движение корня: кадр конца отрезка и накопленное смещение к нему (в системе анимации, до поворота корня). */
export interface VMove { end: number; pos: number[] }
/** flags: 0x1 — цикл, 0x10 — дельта (кватернионы и смещения прибавляются к базовой позе). */
export interface VAnimDesc { name: string; fps: number; frames: number; data: number; moves: VMove[]; flags: number; index: number }

export function vtmbAnimList(buf: ArrayBuffer): VAnimDesc[] {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), I = (o: number) => dv.getInt32(o, true);
  const n = I(264), oa = I(268), out: VAnimDesc[] = [];
  if (n <= 0 || n > 10000 || oa + n * 72 > buf.byteLength) return out;
  for (let k = 0; k < n; k++) {
    const o = oa + k * 72, frames = I(o + 12), fps = dv.getFloat32(o + 4, true) || 30;
    if (frames <= 0 || frames > 100000) continue;
    // движения (@16 число, @20 смещение): 44 байта — конечный кадр, флаги, v0, v1, угол, вектор, накопленная позиция
    const nm = I(o + 16), mo = o + I(o + 20), moves: VMove[] = [];
    if (nm > 0 && nm < 4096 && mo > 0 && mo + nm * 44 <= buf.byteLength)
      for (let j = 0; j < nm; j++) { const e = mo + j * 44; moves.push({ end: I(e), pos: [0, 1, 2].map((k) => dv.getFloat32(e + 32 + k * 4, true)) }); }
    out.push({ name: cstr(u8, o + I(o), 128).replace(/^@/, ''), fps, frames, data: o + I(o + 48), moves, flags: I(o + 8), index: k });
  }
  return out;
}

/** Значение кадра из RLE-потока mstudioanimvalue_t. */
function animValue(u8: Uint8Array, dv: DataView, p: number, frame: number): number {
  let k = frame;
  for (let guard = 0; guard < 10000 && p + 2 <= u8.length; guard++) {
    const valid = u8[p]!, total = u8[p + 1]!;
    if (!total) return 0;
    if (k < total) return dv.getInt16(p + 2 + 2 * Math.min(k, valid - 1), true);
    k -= total; p += 2 + 2 * valid;
  }
  return 0;
}

// кватернионы [x, y, z, w]
const qmul = (a: number[], b: number[]): number[] => [
  a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!, a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
  a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!, a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!];
const qinv = (a: number[]): number[] => [-a[0]!, -a[1]!, -a[2]!, a[3]!];
/** Поворот корня в анимациях хранится без −90° вокруг Z, который studiomdl добавил к позе покоя. */
const ROOT_FIX = [0, 0, -Math.SQRT1_2, Math.SQRT1_2];

/** Смещение корня на кадре f: линейно внутри отрезков движения. */
function moveAt(moves: VMove[], f: number): number[] {
  let prevEnd = 0, prev = [0, 0, 0];
  for (const m of moves) {
    if (f <= m.end) { const t = m.end > prevEnd ? (f - prevEnd) / (m.end - prevEnd) : 1; return [0, 1, 2].map((k) => prev[k]! + (m.pos[k]! - prev[k]!) * t); }
    prevEnd = m.end; prev = m.pos;
  }
  return prev;
}

/**
 * Анимация из файла buf (его кости src) на скелет с именами target.
 * Особенности v2531: поворот корня — без −90° по Z (добавляем); кости с флагом 0x2 (Bip01 Spine1) анимированы
 * в системе корня, а не родителя — переводим в локальную через повороты промежуточных костей этого же кадра.
 */
export function decodeVtmbAnim(buf: ArrayBuffer, d: VAnimDesc, src: VBone[], target: Map<string, number>): NodeMotion {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), chan = new Map<number, NodeChannel>(), n = src.length;
  interface Tr { offs: number[]; hasPos: boolean; hasRot: boolean }
  const tr: Tr[] = src.map((_, i) => {
    const rec = d.data + i * 32;
    if (rec + 32 > buf.byteLength) return { offs: [], hasPos: false, hasRot: false };
    const offs = Array.from({ length: 7 }, (_, k) => dv.getInt32(rec + 4 + k * 4, true));
    return { offs, hasPos: offs.slice(0, 3).some((x) => x), hasRot: offs.slice(3).some((x) => x) };
  });
  const pos: Array<Array<[number, number[]]>> = src.map(() => []), rot: Array<Array<[number, number[]]>> = src.map(() => []);
  const local: number[][] = new Array(n), delta = (d.flags & 0x10) !== 0;
  for (let f = 0; f < d.frames; f++) {
    for (let i = 0; i < n; i++) {
      const b = src[i]!, t = tr[i]!, rec = d.data + i * 32;
      const v = (k: number) => (t.offs[k] ? animValue(u8, dv, rec + t.offs[k]!, f) : 0);
      if (delta) {
        // дельта: смещение и поворот относительно базовой позы, без поправок корня и Spine1
        // смещение записано как «покой + значение × масштаб» (≈ 0 у неподвижных); компонент без потока — 0
        if (t.hasPos) pos[i]!.push([f, [0, 1, 2].map((k) => (t.offs[k] ? b.pos[k]! + v(k) * b.ps[k]! : 0))]);
        let q = [0, 0, 0, 1];
        if (t.hasRot) { q = [0, 1, 2, 3].map((k) => v(3 + k) * b.rs[k]!); const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1; q = q.map((x) => x / l); }
        local[i] = q;
        continue;
      }
      if (t.hasPos || (b.parent < 0 && d.moves.length)) {
        const p = [0, 1, 2].map((k) => b.pos[k]! + v(k) * b.ps[k]!);
        if (b.parent < 0 && d.moves.length) { const m = moveAt(d.moves, f); p[0]! += m[1]!; p[1]! -= m[0]!; p[2]! += m[2]!; } // поворот −90° по Z
        pos[i]!.push([f, p]);
      }
      let q = b.q;
      if (t.hasRot) {
        q = [0, 1, 2, 3].map((k) => v(3 + k) * b.rs[k]!);
        const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
        q = q.map((x) => x / l);
        if (b.parent < 0) q = qmul(ROOT_FIX, q);
      }
      local[i] = q;
    }
    for (let i = 0; i < n; i++) {
      if (delta || !(src[i]!.flags & 2) || !tr[i]!.hasRot || src[i]!.parent < 0) continue;
      // поворот относительно корня: снимаем повороты предков ниже корня
      let chain = [0, 0, 0, 1], j = src[i]!.parent;
      while (j >= 0 && src[j]!.parent >= 0) { chain = qmul(local[j]!, chain); j = src[j]!.parent; }
      local[i] = qmul(qinv(chain), local[i]!);
    }
    for (let i = 0; i < n; i++) if (tr[i]!.hasRot) { const q = local[i]!; rot[i]!.push([f, [q[3]!, q[0]!, q[1]!, q[2]!]]); }
  }
  src.forEach((b, i) => {
    const ti = target.get(b.name.toLowerCase()), t = tr[i]!;
    const hasPos = t.hasPos || (b.parent < 0 && d.moves.length > 0);
    if (ti === undefined || (!hasPos && !t.hasRot)) return;
    chan.set(ti, { pos: hasPos ? pos[i]! : null, rot: t.hasRot ? rot[i]! : null, scl: null });
  });
  return { kind: 'node', name: d.name, tps: d.fps, chan, duration: Math.max(1, d.frames - 1) / d.fps, frames: d.frames };
}

// кватернионы ключей — [w, x, y, z]
const qmulW = (a: number[], b: number[]): number[] => [
  a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]! - a[3]! * b[3]!, a[0]! * b[1]! + a[1]! * b[0]! + a[2]! * b[3]! - a[3]! * b[2]!,
  a[0]! * b[2]! - a[1]! * b[3]! + a[2]! * b[0]! + a[3]! * b[1]!, a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]! + a[3]! * b[0]!];
const keyAt = <T>(keys: Array<[number, T]> | null | undefined, f: number): T | null => {
  if (!keys || !keys.length) return null;
  const last = keys[keys.length - 1]![0], ff = last > 0 ? f % (last + 1) : 0;
  let best = keys[0]!;
  for (const k of keys) { if (k[0] <= ff) best = k; else break; }
  return best[1];
};

/**
 * Слой поверх базы (кадры базы — по кругу): `fill` — частичная анимация (…_layer: рука, верх тела) поверх стойки,
 * `add` — дельта (…_delta: отдача, покачивание оружия) прибавляется к базе. rest — поза покоя целевого скелета.
 */
export function vtmbCompose(base: NodeMotion, top: NodeMotion, mode: 'fill' | 'add', rest: Array<{ t: number[]; q: number[] }>): NodeMotion {
  const chan = new Map<number, NodeChannel>(), frames = top.frames ?? Math.round(top.duration * top.tps) + 1;
  const bones = new Set([...base.chan.keys(), ...top.chan.keys()]);
  for (const i of bones) {
    const b = base.chan.get(i), t = top.chan.get(i);
    if (mode === 'fill') { chan.set(i, t ?? b!); continue; }
    if (!t) { chan.set(i, b!); continue; }
    const r = rest[i] ?? { t: [0, 0, 0], q: [1, 0, 0, 0] }, pos: Array<[number, number[]]> = [], rot: Array<[number, number[]]> = [];
    for (let f = 0; f < frames; f++) {
      const bp = keyAt(b?.pos as Array<[number, number[]]> | null, f) ?? r.t, bq = keyAt(b?.rot as Array<[number, number[]]> | null, f) ?? r.q;
      const dp = keyAt(t.pos as Array<[number, number[]]> | null, f), dq = keyAt(t.rot as Array<[number, number[]]> | null, f);
      pos.push([f, dp ? [bp[0]! + dp[0]!, bp[1]! + dp[1]!, bp[2]! + dp[2]!] : bp]);
      rot.push([f, dq ? qmulW(bq, dq) : bq]);
    }
    chan.set(i, { pos, rot, scl: null });
  }
  return { ...top, chan };
}

/** Пути include-моделей (общие анимации): число @404, таблица @408 по 116 байт, имя — смещение от записи. */
export function vtmbIncludes(buf: ArrayBuffer): string[] {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), n = dv.getInt32(404, true), o = dv.getInt32(408, true), out: string[] = [];
  if (n <= 0 || n > 64 || o <= 0 || o + n * 116 > buf.byteLength) return out;
  for (let k = 0; k < n; k++) {
    const e = o + k * 116, p = e + dv.getInt32(e, true);
    if (p > 0 && p < buf.byteLength) out.push(cstr(u8, p, 256).toLowerCase().replace(/\\/g, '/'));
  }
  return out;
}

/**
 * Последовательности (764 байта): имя @0, активность @4, флаги @8, сетка анимаций @56 (anim[i·8 + j], i — по первому
 * параметру), размеры сетки @572/@576, номера параметров позы @580/@584, их значения на краях @588/@592 и @596/@600.
 * Параметры позы — @384/@388, по 20 байт: имя, флаги, начало, конец, цикл. Пример: walk — 9 анимаций по move_yaw −180…180.
 */
export interface VSeq { name: string; cols: number; rows: number; anims: number[]; params: Array<{ name: string; start: number; end: number }> }

export function vtmbSeqList(buf: ArrayBuffer): VSeq[] {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), I = (o: number) => dv.getInt32(o, true), F = (o: number) => dv.getFloat32(o, true);
  const n = I(272), os = I(276), np = I(384), op = I(388), out: VSeq[] = [];
  if (n <= 0 || n > 10000 || os <= 0 || os + n * 764 > buf.byteLength) return out;
  const pose: string[] = [];
  if (np > 0 && np < 64 && op > 0 && op + np * 20 <= buf.byteLength) for (let k = 0; k < np; k++) { const e = op + k * 20; pose.push(cstr(u8, e + I(e), 64)); }
  for (let k = 0; k < n; k++) {
    const o = os + k * 764, cols = I(o + 572), rows = I(o + 576);
    if (cols < 1 || rows < 1 || cols > 16 || rows > 8 || cols * rows < 2) continue;
    const anims: number[] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) anims.push(I(o + 56 + (i * 8 + j) * 4));
    const params = [0, 1].filter((a) => (a ? rows : cols) > 1).map((a) => ({ name: pose[I(o + 580 + a * 4)] ?? `параметр ${a + 1}`, start: F(o + 588 + a * 4), end: F(o + 596 + a * 4) }));
    out.push({ name: cstr(u8, o + I(o), 128), cols, rows, anims, params });
  }
  return out;
}
