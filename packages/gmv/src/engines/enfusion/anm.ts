// Анимации Enfusion (.anm): «FORM»/«ANIM» → «SET7» → HEAD + DATA (размеры big-endian, без выравнивания).
// HEAD: u16 кадров, u16 частота (кадр/с), u16 костей, u16 размер таблицы имён, имена (\0), затем по 32 байта на кость:
//   u16 ключей позиции, u16 ключей поворота, u32 флаги, f32 min/шаг позиции, f32 min/шаг поворота, f32 min/шаг масштаба.
// DATA, по костям подряд: [кадры ключей позиции u16 — если ключей меньше, чем кадров] [позиции 3×u16] [кадры ключей
//   поворота] [повороты 4×u16 (x, y, z, w)]; значение = min + шаг·q (квантование общее на компоненты).
// Переносы и повороты — локальные, в тех же осях, что кости XOB (проверено на позе привязки персонажа).
// Флаги кости (u32 после числа ключей): бит 0x00010000 — аддитивная дорожка (смещение от позы привязки: перенос 0 и
// единичный поворот = «без изменений»); так записаны слои дыхания, жесты, бинокль — спина, шея, голова поверх основной
// анимации. Абсолютной их применять нельзя: кость падает в начало родителя и меш растягивается.
// Разобрано по файлам игры.
import { identity, matToTRS, quatMat, rigidInv, mulCol } from '../../core/math';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { Keys, NodeChannel, NodeMotion } from '../../core/types';
import type { XobHead } from './xob';

const tag4 = (u: Uint8Array, p: number) => String.fromCharCode(u[p]!, u[p + 1]!, u[p + 2]!, u[p + 3]!);
const be32 = (u: Uint8Array, p: number) => ((u[p]! << 24) | (u[p + 1]! << 16) | (u[p + 2]! << 8) | u[p + 3]!) >>> 0;

export interface AnmTrack { name: string; pos: Keys<number[]>; rot: Keys<number[]>; flags: number; additive: boolean }
export interface Anm { frames: number; fps: number; tracks: AnmTrack[] }

export function parseAnm(u: Uint8Array): Anm {
  if (tag4(u, 0) !== 'FORM' || tag4(u, 8) !== 'ANIM') throw new Error('Не анимация Enfusion (нет FORM/ANIM)');
  let head: { off: number; size: number } | null = null, data: { off: number; size: number } | null = null;
  const walk = (p: number, end: number, depth: number) => {
    while (p + 8 <= end) {
      const t = tag4(u, p), size = be32(u, p + 4);
      if (t === 'HEAD' && !head) head = { off: p + 8, size };
      else if (t === 'DATA' && !data) data = { off: p + 8, size };
      else if (/^SET\d$/.test(t) && depth < 2) walk(p + 8, p + 8 + size, depth + 1);
      p += 8 + size;
    }
  };
  walk(12, u.length, 0);
  if (!head || !data) throw new Error('ANM: нет HEAD/DATA');
  const H = head as { off: number; size: number }, D = data as { off: number; size: number };
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const frames = dv.getUint16(H.off, true), fps = dv.getUint16(H.off + 2, true) || 30, nb = dv.getUint16(H.off + 4, true), ss = dv.getUint16(H.off + 6, true);
  const names = new TextDecoder().decode(u.subarray(H.off + 8, H.off + 8 + ss)).split('\0');
  const tracks: AnmTrack[] = [];
  let e = H.off + 8 + ss, p = D.off;
  const end = D.off + D.size;
  for (let i = 0; i < nb; i++, e += 32) {
    const na = dv.getUint16(e, true), nr = dv.getUint16(e + 2, true), flags = dv.getUint32(e + 4, true);
    const pm = dv.getFloat32(e + 8, true), ps = dv.getFloat32(e + 12, true), rm = dv.getFloat32(e + 16, true), rs = dv.getFloat32(e + 20, true);
    const times = (n: number): number[] => {
      if (n >= frames) return Array.from({ length: n }, (_, k) => k);
      const t: number[] = [];
      for (let k = 0; k < n; k++) t.push(dv.getUint16(p + k * 2, true));
      p += n * 2;
      return t;
    };
    if (p > end) throw new Error('ANM: данные обрезаны');
    const tp = times(na), pos: Keys<number[]> = [];
    for (let k = 0; k < na; k++, p += 6) pos.push([tp[k]!, [pm + ps * dv.getUint16(p, true), pm + ps * dv.getUint16(p + 2, true), pm + ps * dv.getUint16(p + 4, true)]]);
    const tr = times(nr), rot: Keys<number[]> = [];
    for (let k = 0; k < nr; k++, p += 8) {
      const q = [0, 2, 4, 6].map((o) => rm + rs * dv.getUint16(p + o, true));
      const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
      rot.push([tr[k]!, [q[3]! / l, q[0]! / l, q[1]! / l, q[2]! / l]]); // [w, x, y, z] — порядок core/math
    }
    tracks.push({ name: names[i] ?? `кость ${i}`, pos, rot, flags, additive: (flags & 0x10000) !== 0 });
  }
  if (p > end) throw new Error('ANM: данные обрезаны');
  return { frames, fps, tracks };
}

/** q·r (кватернионы [w, x, y, z]). */
const qmul = (q: readonly number[], r: readonly number[]): number[] => [
  q[0]! * r[0]! - q[1]! * r[1]! - q[2]! * r[2]! - q[3]! * r[3]!,
  q[0]! * r[1]! + q[1]! * r[0]! + q[2]! * r[3]! - q[3]! * r[2]!,
  q[0]! * r[2]! - q[1]! * r[3]! + q[2]! * r[0]! + q[3]! * r[1]!,
  q[0]! * r[3]! + q[1]! * r[2]! - q[2]! * r[1]! + q[3]! * r[0]!,
];

/**
 * Анимация для скелета: каналы по именам костей; ключи — в кадрах (tps = частота). Аддитивные дорожки сводятся
 * к абсолютным: перенос привязки + смещение, поворот привязки · поворот дорожки (нужен скелет).
 */
export function anmMotion(a: Anm, name: string, boneIndex: Map<string, number>, sk?: NodeSkeleton): NodeMotion {
  const chan = new Map<number, NodeChannel>();
  for (const t of a.tracks) {
    const i = boneIndex.get(t.name.toLowerCase());
    if (i === undefined) continue;
    let pos: Keys<number[]> | null = t.pos.length ? t.pos : null, rot: Keys<number[]> | null = t.rot.length ? t.rot : null;
    const add = t.additive ? { pos, rot } : undefined;
    if (t.additive) {
      const node = sk?.nodes[i];
      if (!node) continue;
      const b = matToTRS(node.local);
      pos = pos ? pos.map(([k, v]) => [k, [b.t[0]! + v[0]!, b.t[1]! + v[1]!, b.t[2]! + v[2]!]]) : null;
      rot = rot ? rot.map(([k, v]) => [k, qmul(b.q, v)]) : null;
    }
    chan.set(i, add ? { pos, rot, scl: null, add } : { pos, rot, scl: null });
  }
  return { kind: 'node', name, tps: a.fps, chan, duration: Math.max(1, a.frames - 1) / a.fps, frames: a.frames };
}

const wxyz = (q: readonly number[]) => [q[3]!, q[0]!, q[1]!, q[2]!];

/** Скелет XOB: родители из ссылок «ребёнок / брат», локальные матрицы из переноса и кватерниона, bind — мировая поза. */
export function xobSkeleton(h: XobHead): NodeSkeleton {
  const n = h.bones.length, parent = new Array<number>(n).fill(-1), NONE = 0xffff;
  for (let i = 0; i < n; i++) {
    const c = h.bones[i]!.child;
    for (let k = c, g = 0; k !== NONE && k < n && g < 4096; g++) { parent[k] = i; k = h.bones[k]!.next; }
  }
  const world: Float64Array[] = new Array(n);
  const order: number[] = [], seen = new Uint8Array(n);
  const visit = (i: number) => { if (seen[i]) return; seen[i] = 1; if (parent[i]! >= 0) visit(parent[i]!); order.push(i); };
  for (let i = 0; i < n; i++) visit(i);
  for (const i of order) {
    const b = h.bones[i]!, l = quatMat(wxyz(b.q), b.t);
    world[i] = parent[i]! >= 0 ? mulCol(world[parent[i]!]!, l) : l;
  }
  // NodeSkeleton считает позу по порядку номеров: родитель должен идти раньше (у XOB кости в прямом обходе дерева)
  if (parent.some((p, i) => p >= i)) throw new Error('XOB: порядок костей не подходит для скелета');
  const nodes: SkeletonNode[] = h.bones.map((b, i) => ({ name: b.name, parent: parent[i]!, local: quatMat(wxyz(b.q), b.t), offset: rigidInv(world[i] ?? identity()) }));
  const sk = new NodeSkeleton(nodes);
  sk.pose(null, 0, false);
  return sk;
}
