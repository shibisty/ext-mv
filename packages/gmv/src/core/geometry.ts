// Общая геометрия: нормали, границы, индексы.
import type { Bounds, Mesh, SkeletonRuntime } from './types';

/** Сглаженные нормали по треугольникам (взвешены площадью). */
export function computeNormals(pos: ArrayLike<number>, idx: ArrayLike<number>): Float32Array {
  const nor = new Float32Array(pos.length);
  accumulateNormals(pos, idx, nor);
  normalize3(nor);
  return nor;
}

export function accumulateNormals(pos: ArrayLike<number>, idx: ArrayLike<number>, nor: Float32Array): void {
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
    const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!;
    const vx = pos[c]! - pos[a]!, vy = pos[c + 1]! - pos[a + 1]!, vz = pos[c + 2]! - pos[a + 2]!;
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const o of [a, b, c]) { nor[o] += x; nor[o + 1] += y; nor[o + 2] += z; }
  }
}

export function normalize3(a: Float32Array): void {
  for (let k = 0; k < a.length; k += 3) {
    const l = Math.hypot(a[k]!, a[k + 1]!, a[k + 2]!) || 1;
    a[k] /= l; a[k + 1] /= l; a[k + 2] /= l;
  }
}

/** Индексный буфер минимальной ширины. */
export function makeIndices(vertexCount: number, list: ArrayLike<number>): Uint16Array | Uint32Array {
  return vertexCount > 65535 ? Uint32Array.from(list) : Uint16Array.from(list);
}

export function emptyBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

/** Границы по сырым позициям вершин. */
export function boundsOf(meshes: ReadonlyArray<{ pos: ArrayLike<number> }>): Bounds {
  const b = emptyBounds();
  for (const m of meshes) extendBounds(b, m.pos);
  return b;
}

export function extendBounds(b: Bounds, pos: ArrayLike<number>): void {
  for (let i = 0; i < pos.length; i++) {
    const k = i % 3, v = pos[i]!;
    if (v < b.min[k]!) b.min[k] = v;
    if (v > b.max[k]!) b.max[k] = v;
  }
}

/** Границы модели в bind-позе: к вершинам применяются skin-матрицы скелета. */
export function skinnedBounds(sk: SkeletonRuntime, meshes: readonly Mesh[]): Bounds {
  sk.pose(null, 0, false);
  const { min, max } = emptyBounds();
  for (const m of meshes)
    for (let v = 0; v < m.vertexCount; v++) {
      const x = m.pos[v * 3]!, y = m.pos[v * 3 + 1]!, z = m.pos[v * 3 + 2]!, o = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const w = m.weight[v * 4 + k]!;
        if (!w) continue;
        const M = sk.skinV[m.bone[v * 4 + k]!]!;
        o[0] += w * (M[0]! * x + M[4]! * y + M[8]! * z + M[12]!);
        o[1] += w * (M[1]! * x + M[5]! * y + M[9]! * z + M[13]!);
        o[2] += w * (M[2]! * x + M[6]! * y + M[10]! * z + M[14]!);
      }
      for (let k = 0; k < 3; k++) {
        if (o[k]! < min[k]!) min[k] = o[k]!;
        if (o[k]! > max[k]!) max[k] = o[k]!;
      }
    }
  return { min, max };
}

/** Треугольники из полосы (strip) с чередованием обхода и пропуском вырожденных. */
export function stripToTris(idx: ArrayLike<number>): number[] {
  const o: number[] = [];
  for (let k = 2; k < idx.length; k++) {
    const a = idx[k - 2]!, b = idx[k - 1]!, c = idx[k]!;
    if (a === b || b === c || a === c) continue;
    if (k & 1) o.push(a, c, b); else o.push(a, b, c);
  }
  return o;
}

export const sumTris = (meshes: readonly Mesh[]): number => meshes.reduce((a, m) => a + m.indices.length / 3, 0);
export const sumVerts = (meshes: readonly Mesh[]): number => meshes.reduce((a, m) => a + m.vertexCount, 0);
