// Скелет X-Ray: углы bind-позы из IK-данных, анимации — квантованные кватернионы (row-vector матрицы, как в движке).
import type { Mesh, Motion, SkeletonRuntime, XrayMotion, XrayTrack } from '../../core/types';
import { FPS, type OgfBone } from './ogf';

const Q = 1 / 32767;
type M16 = Float32Array;

function mulRow(a: M16, b: M16, o: M16): void { // строки-векторы: сначала a, затем b
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      o[r * 4 + c] = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]! + a[r * 4 + 3]! * b[12 + c]!;
}
function rigidInv(a: M16, o: M16): void {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 4 + c] = a[c * 4 + r]!;
  for (let c = 0; c < 3; c++) o[12 + c] = -(a[12]! * a[c * 4]! + a[13]! * a[c * 4 + 1]! + a[14]! * a[c * 4 + 2]!);
  o[3] = o[7] = o[11] = 0; o[15] = 1;
}
function eulerLocal(rot: number[], pos: number[], o: M16, transpose: boolean): void {
  // Fmatrix::setXYZi(x, y, z) = setHPB(−y, −x, −z): для вектора-строки сначала поворот вокруг Z, затем X, затем Y
  // (крен, тангаж, курс). Проверено по скинингу ЗП: длины рёбер меша в анимациях сохраняются только при таком порядке.
  const cx = Math.cos(rot[0]!), sx = Math.sin(rot[0]!), cy = Math.cos(rot[1]!), sy = Math.sin(rot[1]!), cz = Math.cos(rot[2]!), sz = Math.sin(rot[2]!);
  const m = [cz * cy + sz * sx * sy, sz * cx, -cz * sy + sz * sx * cy, -sz * cy + cz * sx * sy, cz * cx, sz * sy + cz * sx * cy, cx * sy, -sx, cx * cy];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 4 + c] = transpose ? m[c * 3 + r]! : m[r * 3 + c]!;
  o[3] = o[7] = o[11] = 0; o[12] = pos[0]!; o[13] = pos[1]!; o[14] = pos[2]!; o[15] = 1;
}
function quatLocal(x: number, y: number, z: number, w: number, tx: number, ty: number, tz: number, o: M16): void { // Fmatrix::rotation(Fquaternion) + translate_over
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  o[0] = 1 - 2 * (yy + zz); o[1] = 2 * (xy - wz); o[2] = 2 * (xz + wy); o[3] = 0;
  o[4] = 2 * (xy + wz); o[5] = 1 - 2 * (xx + zz); o[6] = 2 * (yz - wx); o[7] = 0;
  o[8] = 2 * (xz - wy); o[9] = 2 * (yz + wx); o[10] = 1 - 2 * (xx + yy); o[11] = 0;
  o[12] = tx; o[13] = ty; o[14] = tz; o[15] = 1;
}
function trackLocal(t: XrayTrack, f0: number, f1: number, a: number, invQ: boolean, o: M16): void {
  const R = t.rot;
  let x: number, y: number, z: number, w: number;
  if (R.length === 4) { x = R[0]! * Q; y = R[1]! * Q; z = R[2]! * Q; w = R[3]! * Q; }
  else {
    const i = f0 * 4, j = f1 * 4;
    const x0 = R[i]! * Q, y0 = R[i + 1]! * Q, z0 = R[i + 2]! * Q, w0 = R[i + 3]! * Q;
    let x1 = R[j]! * Q, y1 = R[j + 1]! * Q, z1 = R[j + 2]! * Q, w1 = R[j + 3]! * Q;
    if (x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1 < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; }
    x = x0 + (x1 - x0) * a; y = y0 + (y1 - y0) * a; z = z0 + (z1 - z0) * a; w = w0 + (w1 - w0) * a;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  x /= l; y /= l; z /= l; w /= l;
  if (invQ) { x = -x; y = -y; z = -z; }
  const T = t.trans;
  let tx: number, ty: number, tz: number;
  if (T.length === 3) { tx = T[0]!; ty = T[1]!; tz = T[2]!; }
  else { const i = f0 * 3, j = f1 * 3; tx = T[i]! + (T[j]! - T[i]!) * a; ty = T[i + 1]! + (T[j + 1]! - T[i + 1]!) * a; tz = T[i + 2]! + (T[j + 2]! - T[i + 2]!) * a; }
  quatLocal(x, y, z, w, tx, ty, tz, o);
}

export class XraySkeleton implements SkeletonRuntime {
  readonly n: number;
  readonly parent: number[];
  readonly order: number[];
  readonly bindLocal: Float32Array; readonly bindWorld: Float32Array; readonly invBind: Float32Array;
  readonly world: Float32Array; readonly skin: Float32Array;
  readonly bindLocalV: M16[]; readonly bindWorldV: M16[]; readonly invV: M16[]; readonly worldV: M16[]; readonly skinV: M16[];
  private readonly scratch = new Float32Array(16);
  bindVariant = '';
  bindErr: [number, number] = [0, 0];

  constructor(bones: OgfBone[], readonly transposeBind = false) {
    const n = (this.n = bones.length);
    this.parent = bones.map((b) => b.parent);
    const order: number[] = [], seen = new Uint8Array(n);
    const visit = (i: number) => { if (seen[i]) return; seen[i] = 1; if (this.parent[i]! >= 0) visit(this.parent[i]!); order.push(i); };
    for (let i = 0; i < n; i++) visit(i);
    this.order = order;
    const mk = () => new Float32Array(16 * n), view = (arr: Float32Array) => Array.from({ length: n }, (_, i) => arr.subarray(16 * i, 16 * i + 16));
    this.bindLocal = mk(); this.bindWorld = mk(); this.invBind = mk(); this.world = mk(); this.skin = mk();
    this.bindLocalV = view(this.bindLocal); this.bindWorldV = view(this.bindWorld); this.invV = view(this.invBind);
    this.worldV = view(this.world); this.skinV = view(this.skin);
    for (const i of order) {
      eulerLocal(bones[i]!.rot, bones[i]!.pos, this.bindLocalV[i]!, transposeBind);
      const p = this.parent[i]!;
      if (p < 0) this.bindWorldV[i]!.set(this.bindLocalV[i]!); else mulRow(this.bindLocalV[i]!, this.bindWorldV[p]!, this.bindWorldV[i]!);
      rigidInv(this.bindWorldV[i]!, this.invV[i]!);
    }
    for (let k = 0; k < 16 * n; k++) this.skin[k] = (k % 16) % 5 === 0 ? 1 : 0;
    this.world.set(this.bindWorld);
  }

  /** Матрица кости по углам setXYZi и позиции — в той же трактовке, что bind-поза (для анимаций SDK). */
  local(rot: number[], pos: number[], o: Float32Array): void { eulerLocal(rot, pos, o, this.transposeBind); }

  /** Выбор варианта трактовки углов: вершины должны лежать рядом со своими костями. */
  static auto(bones: OgfBone[], meshes: readonly Mesh[]): XraySkeleton {
    const a = new XraySkeleton(bones, false);
    if (!a.n) return a;
    const b = new XraySkeleton(bones, true);
    const err = (s: XraySkeleton) => {
      let e = 0, c = 0;
      for (const m of meshes) {
        if (!m.skinned) continue;
        const step = Math.max(1, Math.floor(m.vertexCount / 1500));
        for (let v = 0; v < m.vertexCount; v += step) {
          let bi = m.bone[v * 4]!, bw = m.weight[v * 4]!;
          for (let k = 1; k < 4; k++) if (m.weight[v * 4 + k]! > bw) { bw = m.weight[v * 4 + k]!; bi = m.bone[v * 4 + k]!; }
          const W = s.bindWorldV[bi]!;
          e += Math.hypot(m.pos[v * 3]! - W[12]!, m.pos[v * 3 + 1]! - W[13]!, m.pos[v * 3 + 2]! - W[14]!);
          c++;
        }
      }
      return c ? e / c : 0;
    };
    const ea = err(a), eb = err(b);
    const s = eb < ea * 0.98 ? b : a;
    s.bindVariant = s === b ? 'B (транспонированный)' : 'A';
    s.bindErr = [ea, eb];
    return s;
  }

  pose(motion: Motion | null, time: number, loop: boolean, invQ = false): void {
    if (!this.n) return;
    const m = motion && motion.kind === 'xray' ? motion : null;
    // кадры основной анимации и слоёв (у каждого своя длина; слои всегда по кругу)
    const frame = (x: XrayMotion, lp: boolean): [number, number, number] => {
      const F = x.frames;
      let fr = time * FPS;
      fr = lp ? ((fr % F) + F) % F : Math.min(Math.max(fr, 0), F - 1);
      const f0 = Math.floor(fr);
      return [f0, lp ? (f0 + 1) % F : Math.min(f0 + 1, F - 1), fr - f0];
    };
    const list: Array<[XrayMotion, number, number, number]> = m ? [[m, ...frame(m, loop)], ...(m.layers ?? []).map((x): [XrayMotion, number, number, number] => [x, ...frame(x, true)])] : [];
    for (const i of this.order) {
      const L = this.scratch;
      let done = false;
      for (const [x, f0, f1, a] of list) { const tr = x.tracks[i]; if (tr) { trackLocal(tr, f0, f1, a, invQ, L); done = true; break; } }
      if (!done) L.set(this.bindLocalV[i]!);
      const p = this.parent[i]!;
      if (p < 0) this.worldV[i]!.set(L); else mulRow(L, this.worldV[p]!, this.worldV[i]!);
      mulRow(this.invV[i]!, this.worldV[i]!, this.skinV[i]!);
    }
  }

  /** Автоподбор знака кватерниона: у верного варианта длины рёбер меша почти не меняются. */
  detectInvert(meshes: readonly Mesh[], motion: XrayMotion): boolean {
    const s0 = this.motionError(meshes, motion, false), s1 = this.motionError(meshes, motion, true);
    return s1 < s0 * 0.9;
  }

  /** Искажение меша анимацией: средняя относительная ошибка длин рёбер на трёх кадрах (0 — рёбра не тянутся). */
  motionError(meshes: readonly Mesh[], motion: XrayMotion, inv: boolean): number {
    const edges: Array<[Mesh, number, number]> = [];
    for (const m of meshes) {
      if (!m.skinned) continue;
      const tc = m.indices.length / 3, step = Math.max(1, Math.floor(tc / 1500));
      for (let t = 0; t < tc; t += step) edges.push([m, m.indices[t * 3]!, m.indices[t * 3 + 1]!]);
    }
    if (!edges.length) return 0;
    const sk = (m: Mesh, v: number, o: number[]) => {
      const x = m.pos[v * 3]!, y = m.pos[v * 3 + 1]!, z = m.pos[v * 3 + 2]!;
      o[0] = o[1] = o[2] = 0;
      for (let k = 0; k < 4; k++) {
        const w = m.weight[v * 4 + k]!;
        if (!w) continue;
        const M = this.skinV[m.bone[v * 4 + k]!]!;
        o[0] += w * (x * M[0]! + y * M[4]! + z * M[8]! + M[12]!); o[1] += w * (x * M[1]! + y * M[5]! + z * M[9]! + M[13]!); o[2] += w * (x * M[2]! + y * M[6]! + z * M[10]! + M[14]!);
      }
    };
    const A = [0, 0, 0], B = [0, 0, 0];
    const score = (inv: boolean) => {
      let d = 0, l = 0;
      for (const fr of [0, Math.floor(motion.frames / 2), motion.frames - 1]) {
        this.pose(motion, fr / FPS, false, inv);
        for (const [m, a, b] of edges) {
          sk(m, a, A); sk(m, b, B);
          const l1 = Math.hypot(A[0]! - B[0]!, A[1]! - B[1]!, A[2]! - B[2]!);
          const l0 = Math.hypot(m.pos[a * 3]! - m.pos[b * 3]!, m.pos[a * 3 + 1]! - m.pos[b * 3 + 1]!, m.pos[a * 3 + 2]! - m.pos[b * 3 + 2]!);
          d += Math.abs(l1 - l0); l += l0;
        }
      }
      return d / (l || 1);
    };
    return score(inv);
  }
}

