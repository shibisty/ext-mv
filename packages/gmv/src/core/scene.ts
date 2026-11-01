// Сцена модели для интерфейса: дерево слоёв, видимость и поворот экземпляров, выбор треугольника лучом.
import { tr } from './i18n';
import type { InstancePlacement, Model } from './types';

export interface SceneNode {
  id: string;
  name: string;
  /** group — папка; mesh — меш модели; instance — экземпляр объекта сцены. */
  kind: 'group' | 'mesh' | 'instance';
  mesh?: number;
  instance?: number;
  /** Подпись справа (число треугольников, модель экземпляра). */
  note?: string;
  children?: SceneNode[];
}

const tris = (model: Model, i: number) => Math.floor(model.meshes[i]!.indices.length / 3);

/**
 * Дерево слоёв: для сцены с экземплярами — «Геометрия» (меши без экземпляров) и «Объекты» по группам (классам);
 * для обычной модели — меши.
 */
export function sceneTree(model: Model): SceneNode[] {
  const inst = model.instances, instMeshes = new Set(inst?.meshes ?? []);
  const meshNode = (i: number): SceneNode => ({ id: `m${i}`, name: model.meshes[i]!.name || tr('scene.mesh', { i }), kind: 'mesh', mesh: i, note: tr('scene.tris', { n: tris(model, i) }) });
  const plain = model.meshes.map((_, i) => i).filter((i) => !instMeshes.has(i));
  if (!inst?.placements.length) return [{ id: 'model', name: tr('scene.model'), kind: 'group', note: tr('scene.meshes', { n: plain.length }), children: plain.map(meshNode) }];
  const groups = new Map<string, number[]>();
  inst.placements.forEach((p, i) => { const g = p.group || tr('scene.otherObjects'); (groups.get(g) ?? groups.set(g, []).get(g)!).push(i); });
  const protoTris = (p: InstancePlacement) => inst.protos[p.proto]!.parts.reduce((a, x) => a + Math.floor(x.indices.length / 3), 0);
  return [
    { id: 'geom', name: tr('scene.geometry'), kind: 'group', note: tr('scene.meshes', { n: plain.length }), children: plain.map(meshNode) },
    {
      id: 'objects', name: tr('scene.objects'), kind: 'group', note: String(inst.placements.length),
      children: [...groups].sort((a, b) => b[1].length - a[1].length).map(([g, list]) => ({
        id: `g:${g}`, name: g, kind: 'group' as const, note: String(list.length),
        children: list.map((i) => {
          const p = inst.placements[i]!, proto = inst.protos[p.proto]!;
          return { id: `i${i}`, name: p.name, kind: 'instance' as const, instance: i, note: `${proto.name.split('/').pop()} · ${tr('scene.tris', { n: protoTris(p) })}` };
        }),
      })),
    },
  ];
}

/** Все узлы-листья под узлом (меши и экземпляры). */
export function sceneLeaves(n: SceneNode): SceneNode[] {
  return n.kind === 'group' ? (n.children ?? []).flatMap(sceneLeaves) : [n];
}

/**
 * Переписать вершины и индексы экземпляра в слитых мешах по его позе (после поворота).
 * Возвращает изменённые диапазоны вершин — их нужно перезалить в рендерер.
 */
export function applyPlacement(model: Model, index: number): Array<{ mesh: number; vStart: number; vCount: number; iStart: number; iCount: number }> {
  const inst = model.instances, p = inst?.placements[index];
  if (!inst || !p?.ranges) return [];
  const M = p.pose, proto = inst.protos[p.proto]!;
  const det = M[0]! * (M[5]! * M[10]! - M[6]! * M[9]!) - M[1]! * (M[4]! * M[10]! - M[6]! * M[8]!) + M[2]! * (M[4]! * M[9]! - M[5]! * M[8]!);
  for (const r of p.ranges) {
    const part = proto.parts[r.part], m = model.meshes[r.mesh];
    if (!part || !m) continue;
    for (let v = 0; v < r.vCount; v++) {
      const x = part.pos[v * 3]!, y = part.pos[v * 3 + 1]!, z = part.pos[v * 3 + 2]!, o = (r.vStart + v) * 3;
      m.pos[o] = x * M[0]! + y * M[4]! + z * M[8]! + M[12]!;
      m.pos[o + 1] = x * M[1]! + y * M[5]! + z * M[9]! + M[13]!;
      m.pos[o + 2] = x * M[2]! + y * M[6]! + z * M[10]! + M[14]!;
      const a = part.nor[v * 3]!, b = part.nor[v * 3 + 1]!, c = part.nor[v * 3 + 2]!;
      const nx = a * M[0]! + b * M[4]! + c * M[8]!, ny = a * M[1]! + b * M[5]! + c * M[9]!, nz = a * M[2]! + b * M[6]! + c * M[10]!, l = Math.hypot(nx, ny, nz) || 1;
      m.nor[o] = nx / l; m.nor[o + 1] = ny / l; m.nor[o + 2] = nz / l;
    }
    for (let t = 0; t + 2 < r.iCount; t += 3) {
      const a = part.indices[t]!, b = part.indices[t + 1]!, c = part.indices[t + 2]!, o = r.iStart + t;
      m.indices[o] = r.vStart + a;
      m.indices[o + 1] = r.vStart + (det < 0 ? c : b);
      m.indices[o + 2] = r.vStart + (det < 0 ? b : c);
    }
  }
  return p.ranges.map((r) => ({ mesh: r.mesh, vStart: r.vStart, vCount: r.vCount, iStart: r.iStart, iCount: r.iCount }));
}

/** Повернуть экземпляр вокруг вертикали модели (ось Y) через его начало координат: R' = R·Ry(угол). */
export function rotatePlacement(model: Model, index: number, angle: number): ReturnType<typeof applyPlacement> {
  const p = model.instances?.placements[index];
  if (!p) return [];
  const c = Math.cos(angle), s = Math.sin(angle), M = p.pose;
  for (let row = 0; row < 3; row++) {
    const x = M[row * 4]!, z = M[row * 4 + 2]!;
    // строка × Ry: x' = x·c − z·s, z' = x·s + z·c
    M[row * 4] = x * c - z * s;
    M[row * 4 + 2] = x * s + z * c;
  }
  return applyPlacement(model, index);
}

/** Сдвинуть экземпляр на (dx, dy, dz) в координатах модели. */
export function translatePlacement(model: Model, index: number, d: ArrayLike<number>): ReturnType<typeof applyPlacement> {
  const p = model.instances?.placements[index];
  if (!p) return [];
  p.pose[12] = p.pose[12]! + d[0]!; p.pose[13] = p.pose[13]! + d[1]!; p.pose[14] = p.pose[14]! + d[2]!;
  return applyPlacement(model, index);
}

/** Индексы меша без скрытых экземпляров (для экспорта и выбора). */
export function visibleIndices(model: Model, mesh: number): Uint32Array {
  const src = model.meshes[mesh]!.indices, hidden = model.instances?.placements.filter((p) => p.hidden && p.ranges?.some((r) => r.mesh === mesh));
  if (!hidden?.length) return Uint32Array.from(src);
  const mask = new Uint8Array(src.length);
  for (const p of hidden) for (const r of p.ranges!) if (r.mesh === mesh) mask.fill(1, r.iStart, r.iStart + r.iCount);
  const out: number[] = [];
  for (let i = 0; i + 2 < src.length; i += 3) if (!mask[i]) out.push(src[i]!, src[i + 1]!, src[i + 2]!);
  return Uint32Array.from(out);
}

/** Экземпляр, которому принадлежит треугольник (по первому индексу треугольника), или −1. */
export function instanceAt(model: Model, mesh: number, index: number): number {
  const pl = model.instances?.placements;
  if (!pl) return -1;
  for (let i = 0; i < pl.length; i++) for (const r of pl[i]!.ranges ?? []) if (r.mesh === mesh && index >= r.iStart && index < r.iStart + r.iCount) return i;
  return -1;
}

export interface RayHit { mesh: number; /** Номер первого индекса треугольника. */ index: number; t: number }

/**
 * Ближайший треугольник на луче (в координатах модели, без скелетной позы).
 * skip — меши, которые не участвуют (скрытые); clipY — срез сверху (по высоте в координатах модели, если задано).
 */
export function pickRay(model: Model, origin: ArrayLike<number>, dir: ArrayLike<number>, opts: { skip?: (mesh: number) => boolean; indices?: (mesh: number) => ArrayLike<number>; clip?: (x: number, y: number, z: number) => boolean } = {}): RayHit | null {
  const [ox, oy, oz] = [origin[0]!, origin[1]!, origin[2]!], [dx, dy, dz] = [dir[0]!, dir[1]!, dir[2]!];
  let best: RayHit | null = null, bestT = Infinity;
  model.meshes.forEach((m, mi) => {
    if (opts.skip?.(mi)) return;
    const P = m.pos, I = opts.indices?.(mi) ?? m.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3;
      if (a === b && b === c) continue; // скрытый (вырожденный) треугольник
      const ax = P[a]!, ay = P[a + 1]!, az = P[a + 2]!;
      const e1x = P[b]! - ax, e1y = P[b + 1]! - ay, e1z = P[b + 2]! - az, e2x = P[c]! - ax, e2y = P[c + 1]! - ay, e2z = P[c + 2]! - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det, tx = ox - ax, ty = oy - ay, tz = oz - az, u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (d <= 0 || d >= bestT) continue;
      if (opts.clip && opts.clip(ox + dx * d, oy + dy * d, oz + dz * d)) continue;
      bestT = d; best = { mesh: mi, index: t, t: d };
    }
  });
  return best;
}
