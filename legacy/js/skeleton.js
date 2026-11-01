import { FPS } from './ogf-parser.js';
const Q = 1 / 32767;

function mulRow(a, b, o) { // строки-векторы: сначала a, затем b
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
    o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
}
function rigidInv(a, o) {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 4 + c] = a[c * 4 + r];
  for (let c = 0; c < 3; c++) o[12 + c] = -(a[12] * a[c * 4] + a[13] * a[c * 4 + 1] + a[14] * a[c * 4 + 2]);
  o[3] = o[7] = o[11] = 0; o[15] = 1;
}
function eulerLocal(rot, pos, o, transpose) { // Fmatrix::setXYZi(x,y,z) = setHPB(-y,-x,z)
  const h = -rot[1], p = -rot[0], b = rot[2];
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p), sb = Math.sin(b), cb = Math.cos(b);
  const cc = ch * cb, cs = ch * sb, sc = sh * cb, ss = sh * sb;
  const m = [cc - sp * ss, cs + sp * sc, -cp * sh, -cp * sb, cp * cb, sp, sc + sp * cs, ss - sp * cc, cp * ch];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 4 + c] = transpose ? m[c * 3 + r] : m[r * 3 + c];
  o[3] = o[7] = o[11] = 0; o[12] = pos[0]; o[13] = pos[1]; o[14] = pos[2]; o[15] = 1;
}
function quatLocal(x, y, z, w, tx, ty, tz, o) { // Fmatrix::rotation(Fquaternion) + translate_over
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  o[0] = 1 - 2 * (yy + zz); o[1] = 2 * (xy - wz); o[2] = 2 * (xz + wy); o[3] = 0;
  o[4] = 2 * (xy + wz); o[5] = 1 - 2 * (xx + zz); o[6] = 2 * (yz - wx); o[7] = 0;
  o[8] = 2 * (xz - wy); o[9] = 2 * (yz + wx); o[10] = 1 - 2 * (xx + yy); o[11] = 0;
  o[12] = tx; o[13] = ty; o[14] = tz; o[15] = 1;
}
function trackLocal(t, f0, f1, a, invQ, o) {
  const R = t.rot; let x, y, z, w;
  if (R.length === 4) { x = R[0] * Q; y = R[1] * Q; z = R[2] * Q; w = R[3] * Q; }
  else {
    const i = f0 * 4, j = f1 * 4;
    const x0 = R[i] * Q, y0 = R[i + 1] * Q, z0 = R[i + 2] * Q, w0 = R[i + 3] * Q;
    let x1 = R[j] * Q, y1 = R[j + 1] * Q, z1 = R[j + 2] * Q, w1 = R[j + 3] * Q;
    if (x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1 < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; }
    x = x0 + (x1 - x0) * a; y = y0 + (y1 - y0) * a; z = z0 + (z1 - z0) * a; w = w0 + (w1 - w0) * a;
  }
  const l = Math.hypot(x, y, z, w) || 1; x /= l; y /= l; z /= l; w /= l;
  if (invQ) { x = -x; y = -y; z = -z; }
  const T = t.trans; let tx, ty, tz;
  if (T.length === 3) { tx = T[0]; ty = T[1]; tz = T[2]; }
  else { const i = f0 * 3, j = f1 * 3; tx = T[i] + (T[j] - T[i]) * a; ty = T[i + 1] + (T[j + 1] - T[i + 1]) * a; tz = T[i + 2] + (T[j + 2] - T[i + 2]) * a; }
  quatLocal(x, y, z, w, tx, ty, tz, o);
}

export class Skeleton {
  constructor(bones, transposeBind = false) {
    const n = this.n = bones.length;
    this.parent = bones.map((b) => b.parent);
    const order = [], seen = new Uint8Array(n);
    const visit = (i) => { if (seen[i]) return; seen[i] = 1; if (this.parent[i] >= 0) visit(this.parent[i]); order.push(i); };
    for (let i = 0; i < n; i++) visit(i);
    this.order = order;
    const mk = () => new Float32Array(16 * n), view = (arr) => Array.from({ length: n }, (_, i) => arr.subarray(16 * i, 16 * i + 16));
    this.bindLocal = mk(); this.bindWorld = mk(); this.invBind = mk(); this.world = mk(); this.skin = mk();
    this.bindLocalV = view(this.bindLocal); this.bindWorldV = view(this.bindWorld); this.invV = view(this.invBind);
    this.worldV = view(this.world); this.skinV = view(this.skin);
    this.scratch = new Float32Array(16);
    for (const i of order) {
      eulerLocal(bones[i].rot, bones[i].pos, this.bindLocalV[i], transposeBind);
      const p = this.parent[i];
      if (p < 0) this.bindWorldV[i].set(this.bindLocalV[i]); else mulRow(this.bindLocalV[i], this.bindWorldV[p], this.bindWorldV[i]);
      rigidInv(this.bindWorldV[i], this.invV[i]);
    }
    this.skin.set(new Float32Array(16 * n).map((_, k) => (k % 16) % 5 === 0 ? 1 : 0));
    this.world.set(this.bindWorld);
  }

  // Выбор варианта трактовки углов: вершины должны лежать рядом со своими костями.
  static auto(bones, meshes) {
    const a = new Skeleton(bones, false);
    if (!a.n) return a;
    const b = new Skeleton(bones, true);
    const err = (s) => {
      let e = 0, c = 0;
      for (const m of meshes) {
        if (!m.skinned) continue;
        const step = Math.max(1, Math.floor(m.vertexCount / 1500));
        for (let v = 0; v < m.vertexCount; v += step) {
          let bi = m.bone[v * 4], bw = m.weight[v * 4];
          for (let k = 1; k < 4; k++) if (m.weight[v * 4 + k] > bw) { bw = m.weight[v * 4 + k]; bi = m.bone[v * 4 + k]; }
          const W = s.bindWorldV[bi];
          e += Math.hypot(m.pos[v * 3] - W[12], m.pos[v * 3 + 1] - W[13], m.pos[v * 3 + 2] - W[14]); c++;
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

  pose(motion, time, loop, invQ) {
    if (!this.n) return;
    let f0 = 0, f1 = 0, a = 0;
    if (motion) {
      const F = motion.frames; let fr = time * FPS;
      fr = loop ? ((fr % F) + F) % F : Math.min(Math.max(fr, 0), F - 1);
      f0 = Math.floor(fr); a = fr - f0; f1 = loop ? (f0 + 1) % F : Math.min(f0 + 1, F - 1);
    }
    for (const i of this.order) {
      const tr = motion && motion.tracks[i], L = this.scratch;
      if (tr) trackLocal(tr, f0, f1, a, invQ, L); else L.set(this.bindLocalV[i]);
      const p = this.parent[i];
      if (p < 0) this.worldV[i].set(L); else mulRow(L, this.worldV[p], this.worldV[i]);
      mulRow(this.invV[i], this.worldV[i], this.skinV[i]);
    }
  }

  // Автоподбор знака кватерниона: у верного варианта длины рёбер меша почти не меняются.
  detectInvert(meshes, motion) {
    const edges = [];
    for (const m of meshes) {
      if (!m.skinned) continue;
      const tc = m.indices.length / 3, step = Math.max(1, Math.floor(tc / 1500));
      for (let t = 0; t < tc; t += step) edges.push([m, m.indices[t * 3], m.indices[t * 3 + 1]]);
    }
    if (!edges.length) return false;
    const sk = (m, v, o) => {
      const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2]; o[0] = o[1] = o[2] = 0;
      for (let k = 0; k < 4; k++) {
        const w = m.weight[v * 4 + k]; if (!w) continue;
        const M = this.skinV[m.bone[v * 4 + k]];
        o[0] += w * (x * M[0] + y * M[4] + z * M[8] + M[12]); o[1] += w * (x * M[1] + y * M[5] + z * M[9] + M[13]); o[2] += w * (x * M[2] + y * M[6] + z * M[10] + M[14]);
      }
    };
    const A = [0, 0, 0], B = [0, 0, 0], score = (inv) => {
      let d = 0, l = 0;
      for (const fr of [0, Math.floor(motion.frames / 2), motion.frames - 1]) {
        this.pose(motion, fr / FPS, false, inv);
        for (const [m, a, b] of edges) {
          sk(m, a, A); sk(m, b, B);
          const l1 = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
          const l0 = Math.hypot(m.pos[a * 3] - m.pos[b * 3], m.pos[a * 3 + 1] - m.pos[b * 3 + 1], m.pos[a * 3 + 2] - m.pos[b * 3 + 2]);
          d += Math.abs(l1 - l0); l += l0;
        }
      }
      return d / (l || 1);
    };
    const s0 = score(false), s1 = score(true);
    return s1 < s0 * 0.9;
  }
}
