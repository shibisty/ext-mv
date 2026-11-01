// Матрицы 4×4 column-major (как в WebGL), кватернионы [w, x, y, z].
export type Mat4 = Float64Array | Float32Array;

export function identity(): Float64Array {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a·b (column-major), результат в новом массиве. */
export function mulCol(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const o = new Float64Array(16);
  mulColInto(a, b, o);
  return o;
}

export function mulColInto(a: ArrayLike<number>, b: ArrayLike<number>, o: Mat4): void {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
}

/** Обратная к жёсткой матрице (поворот + перенос), column-major. */
export function rigidInv(M: ArrayLike<number>): Float64Array {
  const o = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = M[r * 4 + c]!;
  for (let r = 0; r < 3; r++) o[12 + r] = -(M[r * 4]! * M[12]! + M[r * 4 + 1]! * M[13]! + M[r * 4 + 2]! * M[14]!);
  o[15] = 1;
  return o;
}

/** Row-major -> column-major. */
export function transpose(a: ArrayLike<number>): Float64Array {
  const o = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = a[r * 4 + c]!;
  return o;
}

/** Матрица из кватерниона [w,x,y,z], переноса и масштаба (column-major). */
export function quatMat(q: ArrayLike<number>, t: ArrayLike<number>, s: ArrayLike<number> = [1, 1, 1]): Float64Array {
  const m = new Float64Array(16);
  compose(t, q, s, m);
  return m;
}

export function compose(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>, o: Mat4): void {
  const w = q[0]!, x = q[1]!, y = q[2]!, z = q[3]!;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const R = [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 4 + r] = R[r * 3 + c]! * s[c]!;
  o[3] = o[7] = o[11] = 0;
  o[12] = t[0]!; o[13] = t[1]!; o[14] = t[2]!; o[15] = 1;
}

export interface TRS { t: number[]; q: number[]; s: number[] }

/** Разложение матрицы на перенос, поворот, масштаб (с учётом отражения). */
export function matToTRS(M: ArrayLike<number>): TRS {
  const sx0 = Math.hypot(M[0]!, M[1]!, M[2]!), sy = Math.hypot(M[4]!, M[5]!, M[6]!), sz = Math.hypot(M[8]!, M[9]!, M[10]!);
  const det = M[0]! * (M[5]! * M[10]! - M[9]! * M[6]!) - M[4]! * (M[1]! * M[10]! - M[9]! * M[2]!) + M[8]! * (M[1]! * M[6]! - M[5]! * M[2]!);
  const sx = det < 0 ? -sx0 : sx0, s = [sx || 1, sy || 1, sz || 1];
  const r = (row: number, col: number) => M[col * 4 + row]! / s[col]!;
  const r00 = r(0, 0), r01 = r(0, 1), r02 = r(0, 2), r10 = r(1, 0), r11 = r(1, 1), r12 = r(1, 2), r20 = r(2, 0), r21 = r(2, 1), r22 = r(2, 2);
  const tr = r00 + r11 + r22;
  let w: number, x: number, y: number, z: number;
  if (tr > 0) { const k = Math.sqrt(tr + 1) * 2; w = k / 4; x = (r21 - r12) / k; y = (r02 - r20) / k; z = (r10 - r01) / k; }
  else if (r00 > r11 && r00 > r22) { const k = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (r21 - r12) / k; x = k / 4; y = (r01 + r10) / k; z = (r02 + r20) / k; }
  else if (r11 > r22) { const k = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (r02 - r20) / k; x = (r01 + r10) / k; y = k / 4; z = (r12 + r21) / k; }
  else { const k = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (r10 - r01) / k; x = (r02 + r20) / k; y = (r12 + r21) / k; z = k / 4; }
  return { t: [M[12]!, M[13]!, M[14]!], q: [w, x, y, z], s };
}

/** Отрезок ключей, в который попадает время t: [i, j, доля]. */
export function keySegment(keys: ReadonlyArray<readonly [number, unknown]>, t: number): [number, number, number] {
  const last = keys.length - 1;
  if (last <= 0 || t <= keys[0]![0]) return [0, 0, 0];
  if (t >= keys[last]![0]) return [last, last, 0];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]![0] <= t) lo = mid; else hi = mid;
  }
  return [lo, hi, (t - keys[lo]![0]) / (keys[hi]![0] - keys[lo]![0] || 1)];
}

export function sampleVec(keys: ReadonlyArray<readonly [number, ArrayLike<number>]>, t: number): number[] {
  const [i, j, a] = keySegment(keys, t), A = keys[i]![1], B = keys[j]![1];
  return [A[0]! + (B[0]! - A[0]!) * a, A[1]! + (B[1]! - A[1]!) * a, A[2]! + (B[2]! - A[2]!) * a];
}

/** Нормализованная линейная интерполяция кватернионов по кратчайшей дуге. */
export function sampleQuat(keys: ReadonlyArray<readonly [number, ArrayLike<number>]>, t: number): number[] {
  const [i, j, a] = keySegment(keys, t), A = Array.from(keys[i]![1]);
  let B = Array.from(keys[j]![1]);
  if (A[0]! * B[0]! + A[1]! * B[1]! + A[2]! * B[2]! + A[3]! * B[3]! < 0) B = B.map((v) => -v);
  const q = A.map((v, k) => v + (B[k]! - v) * a), l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
}
