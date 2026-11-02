// Скелеты и анимации Survarium (Vostok).
// animations/skeletons/*.skeleton — двоичный конфиг: вложенные таблицы = иерархия костей (поле «mask» — не кость).
// <модель>.skinned_model/render/bind_pose — u16 число костей, затем [имя с нулём, f32×3 позиция, f32×3 углы Эйлера, f32×3 масштаб]
//   в пространстве модели; порядок костей = номера костей в вершинах.
// animations/…/*.b-spline + *.bones_names (конфиг: массив имён костей): u16 число костей, u16, таблица смещений (по 8 байт на канал),
//   затем каналы подряд — 9 на кость (позиция x,y,z, углы x,y,z, масштаб x,y,z), канал = [u32 n, n × (f32 узел, f32 значение)]:
//   кубический B-сплайн с узлами (последний узел повторяется ещё 3 раза), значение последней пары — заглушка −1e9. Время — кадры, 30 в секунду.
// Значения анимации — в пространстве родителя.
import { compose, mulCol, rigidInv } from '../../core/math';
import type { SkeletonNode } from '../../core/skeleton';
import type { NodeChannel, NodeMotion } from '../../core/types';
import { parseVostokConfig, type CfgTable, type CfgValue } from './model';

export const FPS = 30;

/** Углы Эйлера: R = Rz(−z)·Ry(−y)·Rx(−x) — подобрано по анимациям персонажей (стопы на полу, руки симметричны). */
let EULER = (typeof process !== 'undefined' && process.env?.VOSTOK_EULER) || 'zyx-';

const qmul = (a: number[], b: number[]) => [
  a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]! - a[3]! * b[3]!,
  a[0]! * b[1]! + a[1]! * b[0]! + a[2]! * b[3]! - a[3]! * b[2]!,
  a[0]! * b[2]! - a[1]! * b[3]! + a[2]! * b[0]! + a[3]! * b[1]!,
  a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]! + a[3]! * b[0]!,
];

/** Кватернион [w,x,y,z] из углов Эйлера. */
export function eulerQuat(x: number, y: number, z: number): number[] {
  const sign = EULER.endsWith('-') ? -1 : 1, ang = { x: x * sign, y: y * sign, z: z * sign };
  let q = [1, 0, 0, 0];
  for (const ax of EULER.replace('-', '')) {
    const a = ang[ax as 'x' | 'y' | 'z'] / 2, c = Math.cos(a), s = Math.sin(a);
    q = qmul(q, ax === 'x' ? [c, s, 0, 0] : ax === 'y' ? [c, 0, s, 0] : [c, 0, 0, s]);
  }
  return q;
}

export interface VostokBone { name: string; parent: number }

export function parseSkeleton(u: Uint8Array): VostokBone[] {
  const out: VostokBone[] = [];
  const walk = (t: CfgTable, parent: number) => {
    for (const [k, v] of Object.entries(t)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      out.push({ name: k, parent });
      walk(v as CfgTable, out.length - 1);
    }
  };
  walk(parseVostokConfig(u), -1);
  return out;
}

export interface BindBone { name: string; pos: number[]; euler: number[]; scale: number[] }

export function parseBindPose(u: Uint8Array): BindBone[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), n = dv.getUint16(0, true), out: BindBone[] = [];
  let p = 2;
  for (let i = 0; i < n; i++) {
    let name = '';
    while (p < u.length && u[p]) name += String.fromCharCode(u[p++]!);
    p++;
    if (p + 36 > u.length) throw new Error('bind_pose обрезан');
    const f = Array.from({ length: 9 }, (_, k) => dv.getFloat32(p + k * 4, true));
    out.push({ name, pos: f.slice(0, 3), euler: f.slice(3, 6), scale: f.slice(6, 9) });
    p += 36;
  }
  return out;
}

const boneMatrix = (b: { pos: number[]; euler: number[] }) => {
  const m = new Float64Array(16);
  compose(b.pos, eulerQuat(b.euler[0]!, b.euler[1]!, b.euler[2]!), [1, 1, 1], m);
  return m;
};

/** Узлы скелета для NodeSkeleton: локальные матрицы из мировых bind_pose, offset = обратная мировая. */
export function skeletonNodes(bones: VostokBone[], bind: BindBone[]): SkeletonNode[] {
  const byName = new Map(bind.map((b) => [b.name, b]));
  const world = bones.map((b) => { const bb = byName.get(b.name); return bb ? boneMatrix(bb) : null; });
  // кости без bind_pose (корень object_movement) — мировая = родительская
  for (let i = 0; i < bones.length; i++) if (!world[i]) { const p = bones[i]!.parent; world[i] = p >= 0 ? world[p]! : (() => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; })(); }
  return bones.map((b, i) => ({
    name: b.name,
    parent: b.parent,
    local: b.parent >= 0 ? mulCol(rigidInv(world[b.parent]!), world[i]!) : world[i]!,
    offset: rigidInv(world[i]!),
  }));
}

/** Каналы B-сплайна: на каждый канал — узлы и контрольные значения. */
export interface Spline { knots: number[]; ctrl: number[] }

export function parseBSpline(u: Uint8Array): { bones: number; channels: Spline[] } {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), nb = dv.getUint16(0, true), nch = nb * 9;
  // данные начинаются после таблицы: первая запись — смещение первого канала (от байта 4)
  let p = 4 + dv.getUint32(4, true);
  // в некоторых файлах между таблицей и данными есть заполнение: ищем первую запись с правдоподобным n
  const ok = (q: number) => q + 4 <= u.length && (() => { const n = dv.getUint32(q, true); return n >= 1 && n < 100000 && q + 4 + n * 8 <= u.length && dv.getFloat32(q + 4 + (n - 1) * 8 + 4, true) === -1e9; })();
  if (!ok(p)) { p = 4 + nch * 8; while (p < u.length && !ok(p)) p += 4; }
  const channels: Spline[] = [];
  for (let c = 0; c < nch; c++) {
    if (!ok(p)) throw new Error(`.b-spline: канал ${c} повреждён`);
    const n = dv.getUint32(p, true), knots: number[] = [], ctrl: number[] = [];
    for (let k = 0; k < n; k++) { knots.push(dv.getFloat32(p + 4 + k * 8, true)); if (k < n - 1) ctrl.push(dv.getFloat32(p + 8 + k * 8, true)); }
    const last = knots[knots.length - 1]!;
    knots.push(last, last, last);
    channels.push({ knots, ctrl });
    p += 4 + n * 8;
  }
  return { bones: nb, channels };
}

/** Значение кубического B-сплайна (де Бур) в момент t. */
export function evalSpline(s: Spline, t: number): number {
  const { knots: U, ctrl: P } = s, n = P.length;
  if (n === 1) return P[0]!;
  const lo = U[3]!, hi = U[n]!;
  t = Math.min(Math.max(t, lo), hi);
  let k = 3;
  while (k < n - 1 && t >= U[k + 1]!) k++;
  const d = [0, 1, 2, 3].map((j) => P[Math.min(Math.max(k - 3 + j, 0), n - 1)]!);
  for (let r = 1; r <= 3; r++) {
    for (let j = 3; j >= r; j--) {
      const i = k - 3 + j, den = U[i + 4 - r]! - U[i]!;
      const a = den > 0 ? (t - U[i]!) / den : 0;
      d[j] = (1 - a) * d[j - 1]! + a * d[j]!;
    }
  }
  return d[3]!;
}

export function boneNames(u: Uint8Array): string[] {
  const root = parseVostokConfig(u), arr = root.bones_names as CfgValue[] | undefined;
  return Array.isArray(arr) ? arr.map(String) : [];
}

/** Анимация в узлы скелета (по именам костей), ключи по кадрам. */
export function buildMotion(name: string, spline: Uint8Array, names: string[], bones: VostokBone[]): NodeMotion {
  const { bones: nb, channels } = parseBSpline(spline);
  if (names.length && names.length !== nb) throw new Error(`.b-spline: ${nb} костей, в bones_names ${names.length}`);
  const index = new Map(bones.map((b, i) => [b.name, i]));
  let end = 0;
  for (const c of channels) end = Math.max(end, c.knots[c.knots.length - 1]!);
  const frames = Math.max(1, Math.round(end));
  const chan = new Map<number, NodeChannel>();
  for (let b = 0; b < nb; b++) {
    const node = index.get(names[b] ?? '');
    if (node === undefined) continue;
    const c = channels.slice(b * 9, b * 9 + 9), pos: Array<[number, number[]]> = [], rot: Array<[number, number[]]> = [], scl: Array<[number, number[]]> = [];
    for (let f = 0; f <= frames; f++) {
      const v = c.map((s) => evalSpline(s, f));
      pos.push([f, v.slice(0, 3)]);
      rot.push([f, eulerQuat(v[3]!, v[4]!, v[5]!)]);
      scl.push([f, v.slice(6, 9)]);
    }
    chan.set(node, { pos, rot, scl });
  }
  return { kind: 'node', name, tps: FPS, chan, duration: frames / FPS, frames: frames + 1 };
}
