// Скелет и анимации LithTech Jupiter EX (F.E.A.R. Online). Разобрано по файлам игры.
//
// Записи анимаций в .mdl (сразу после узлов): f32, затем на каждую анимацию 3×u32, [u32 имя, u32, u32 смещение в .anim, u32, u32,
//   u32 число ключей] и ключи u32 (младшие 24 бита — время в мс, старший байт — команда или 0xff).
// .anim: «ANIM», u32 1, u32 размер; блок анимации — с 12 + смещение:
//   u8 (число ключей − 1), 3×u8, u16 число постоянных треков, u16 число анимированных треков,
//   по 2 байта на узел (трек позиции, трек поворота; 0xff — нет: узел в bind-позе),
//   u16 × анимированных: смещения данных трека от начала блока,
//   таблица ключей: на каждый ключ анимации и каждый анимированный трек — (номер ключа трека, доля 0..255 до следующего),
//   постоянные треки по 6 байт, данные анимированных треков по 6 байт на ключ.
// Номера треков: сначала анимированные (0…), затем постоянные. Позиция — 3×s16 / 20, поворот — x,y,z s16 / 32767, w = √(1 − x² − y² − z²).
// Значения — в пространстве родителя. Порядок узлов в таблице — порядок их имён в таблице строк .mdl (не порядок узлов).
import { compose, mulCol, rigidInv } from '../../core/math';
import type { SkeletonNode } from '../../core/skeleton';
import type { NodeChannel, NodeMotion } from '../../core/types';
import type { LtAnimRec, LtNode } from './model';

const POS_SCALE = 1 / 20;

const nodeWorld = (n: LtNode) => {
  const m = new Float64Array(16);
  compose(n.pos, [n.rot[3], n.rot[0], n.rot[1], n.rot[2]], [1, 1, 1], m);
  return m;
};

/** Узлы скелета: позы в .mdl — в пространстве модели. */
export function ltSkeletonNodes(nodes: LtNode[]): SkeletonNode[] {
  const world = nodes.map(nodeWorld);
  return nodes.map((n, i) => ({
    name: n.name,
    parent: n.parent,
    local: n.parent >= 0 ? mulCol(rigidInv(world[n.parent]!), world[i]!) : world[i]!,
    offset: rigidInv(world[i]!),
  }));
}

export interface LtAnimBlock {
  nConst: number;
  nAnim: number;
  /** На узел (в порядке таблицы): [трек позиции, трек поворота], 255 — нет. */
  table: Array<[number, number]>;
  offs: number[];
  mapAt: number;
  constAt: number;
}

export function parseAnimBlock(ad: Uint8Array, off: number, nNodes: number, nKeys: number): LtAnimBlock {
  const dv = new DataView(ad.buffer, ad.byteOffset, ad.byteLength), b = 12 + off;
  if (b + 8 + nNodes * 2 > ad.length) throw new Error('.anim: блок анимации за концом файла');
  const nConst = dv.getUint16(b + 4, true), nAnim = dv.getUint16(b + 6, true);
  const table: Array<[number, number]> = [];
  for (let i = 0; i < nNodes; i++) table.push([ad[b + 8 + 2 * i]!, ad[b + 9 + 2 * i]!]);
  let p = b + 8 + 2 * nNodes;
  const offs: number[] = [];
  for (let k = 0; k < nAnim; k++, p += 2) offs.push(b + dv.getUint16(p, true));
  const mapAt = p, constAt = mapAt + nKeys * nAnim * 2;
  if (constAt + nConst * 6 > ad.length) throw new Error('.anim: таблица ключей за концом файла');
  return { nConst, nAnim, table, offs, mapAt, constAt };
}

const s16 = (dv: DataView, o: number) => [dv.getInt16(o, true), dv.getInt16(o + 2, true), dv.getInt16(o + 4, true)] as const;
const toPos = (v: readonly number[]) => v.map((x) => x * POS_SCALE);
const toQuat = (v: readonly number[]) => {
  const x = v[0]! / 32767, y = v[1]! / 32767, z = v[2]! / 32767;
  return [Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)), x, y, z];
};
const lerp = (a: number[], b: number[], t: number) => a.map((v, k) => v + (b[k]! - v) * t);
const nlerp = (a: number[], b: number[], t: number) => {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
  const q = a.map((v, k) => v + ((d < 0 ? -b[k]! : b[k]!) - v) * t), l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
};

/** Строки таблицы треков -> узлы .mdl: в порядке имён узлов в таблице строк. */
export function trackOrder(nodes: readonly LtNode[]): number[] {
  return nodes.map((_, i) => i).sort((a, b) => nodes[a]!.nameOff - nodes[b]!.nameOff);
}

/** То же для набора анимаций другого .mdl (sniper_base.mdl к sniper.mdl): узлы сопоставляются по именам, −1 — нет у модели. */
export function trackOrderFor(set: readonly LtNode[], model: readonly LtNode[]): { order: number[]; matched: number } {
  const byName = new Map(model.map((n, i) => [n.name.toLowerCase(), i]));
  let matched = 0;
  const order = trackOrder(set).map((k) => { const i = byName.get(set[k]!.name.toLowerCase()); if (i !== undefined) matched++; return i ?? -1; });
  return { order, matched };
}

/**
 * Анимация из .anim. order — узел модели для каждой строки таблицы (−1 — пропустить).
 */
export function buildLtMotion(rec: LtAnimRec, ad: Uint8Array, order: number[]): NodeMotion {
  const dv = new DataView(ad.buffer, ad.byteOffset, ad.byteLength), nk = rec.times.length;
  const blk = parseAnimBlock(ad, rec.off, order.length, nk);
  const end = (t: number) => (t + 1 < blk.nAnim ? blk.offs[t + 1]! : ad.length);
  const track = (t: number, conv: (v: readonly number[]) => number[], mix: typeof lerp): Array<[number, number[]]> => {
    if (t >= blk.nAnim) {
      const o = blk.constAt + 6 * (t - blk.nAnim);
      if (t - blk.nAnim >= blk.nConst) throw new Error(`.anim «${rec.name}»: трек ${t} вне списка`);
      return [[0, conv(s16(dv, o))]];
    }
    const base = blk.offs[t]!, count = Math.floor((end(t) - base) / 6), keys: Array<[number, number[]]> = [];
    const at = (i: number) => conv(s16(dv, base + 6 * Math.min(Math.max(i, 0), Math.max(count - 1, 0))));
    for (let k = 0; k < nk; k++) {
      const m = blk.mapAt + 2 * (k * blk.nAnim + t), i = ad[m]!, f = ad[m + 1]! / 255;
      keys.push([rec.times[k]!, f > 0 ? mix(at(i), at(i + 1), f) : at(i)]);
    }
    return keys;
  };
  const chan = new Map<number, NodeChannel>();
  blk.table.forEach(([tp, tr], s) => {
    const node = order[s];
    if (node === undefined || node < 0 || (tp === 255 && tr === 255)) return;
    chan.set(node, { pos: tp === 255 ? null : track(tp, toPos, lerp), rot: tr === 255 ? null : track(tr, toQuat, nlerp), scl: null });
  });
  const last = rec.times[nk - 1] ?? 0;
  return { kind: 'node', name: rec.name, tps: 1000, chan, duration: last / 1000, frames: nk };
}
