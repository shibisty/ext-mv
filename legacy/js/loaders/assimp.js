// Загрузчик через assimpjs (WASM): файл -> 'assjson' -> внутренняя модель.
// Положите lib/assimpjs-all.js + lib/assimpjs-all.wasm (или assimpjs.js/.wasm) из npm-пакета assimpjs (dist/).
const TPS_DEFAULT = 25;
const ident = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
const toCol = (a) => { const o = new Float64Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = a[r * 4 + c]; return o; };
function mulCol(a, b, o) { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } }

function matToTRS(M) {
  const sx0 = Math.hypot(M[0], M[1], M[2]), sy = Math.hypot(M[4], M[5], M[6]), sz = Math.hypot(M[8], M[9], M[10]);
  const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]);
  const sx = det < 0 ? -sx0 : sx0, s = [sx || 1, sy || 1, sz || 1];
  const r = (row, col) => M[col * 4 + row] / s[col];
  const r00 = r(0, 0), r01 = r(0, 1), r02 = r(0, 2), r10 = r(1, 0), r11 = r(1, 1), r12 = r(1, 2), r20 = r(2, 0), r21 = r(2, 1), r22 = r(2, 2);
  const tr = r00 + r11 + r22; let w, x, y, z;
  if (tr > 0) { const k = Math.sqrt(tr + 1) * 2; w = k / 4; x = (r21 - r12) / k; y = (r02 - r20) / k; z = (r10 - r01) / k; }
  else if (r00 > r11 && r00 > r22) { const k = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (r21 - r12) / k; x = k / 4; y = (r01 + r10) / k; z = (r02 + r20) / k; }
  else if (r11 > r22) { const k = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (r02 - r20) / k; x = (r01 + r10) / k; y = k / 4; z = (r12 + r21) / k; }
  else { const k = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (r10 - r01) / k; x = (r02 + r20) / k; y = (r12 + r21) / k; z = k / 4; }
  return { t: [M[12], M[13], M[14]], q: [w, x, y, z], s };
}
function compose(t, q, s, o) {
  const [w, x, y, z] = q, xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const R = [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 4 + r] = R[r * 3 + c] * s[c];
  o[3] = o[7] = o[11] = 0; o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1;
}
function seg(keys, t) {
  const last = keys.length - 1;
  if (last <= 0 || t <= keys[0][0]) return [0, 0, 0];
  if (t >= keys[last][0]) return [last, last, 0];
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid][0] <= t) lo = mid; else hi = mid; }
  return [lo, hi, (t - keys[lo][0]) / (keys[hi][0] - keys[lo][0] || 1)];
}
function sampleVec(keys, t) { const [i, j, a] = seg(keys, t), A = keys[i][1], B = keys[j][1]; return [A[0] + (B[0] - A[0]) * a, A[1] + (B[1] - A[1]) * a, A[2] + (B[2] - A[2]) * a]; }
function sampleQuat(keys, t) {
  const [i, j, a] = seg(keys, t), A = keys[i][1]; let B = keys[j][1];
  if (A[0] * B[0] + A[1] * B[1] + A[2] * B[2] + A[3] * B[3] < 0) B = B.map((v) => -v);
  const q = A.map((v, k) => v + (B[k] - v) * a), l = Math.hypot(...q) || 1; return q.map((v) => v / l);
}

export class NodeSkeleton {
  constructor(nodes) {
    const n = this.n = nodes.length; this.nodes = nodes; this.parent = nodes.map((x) => x.parent);
    nodes.forEach((nd) => { nd.rest = matToTRS(nd.local); });
    this.world = new Float32Array(16 * n); this.skin = new Float32Array(16 * n);
    const view = (a) => Array.from({ length: n }, (_, i) => a.subarray(16 * i, 16 * i + 16));
    this.worldV = view(this.world); this.skinV = view(this.skin);
    this.w64 = Array.from({ length: n }, () => new Float64Array(16)); this.tmp = new Float64Array(16); this.tmp2 = new Float64Array(16);
  }
  pose(motion, time, loop) {
    let tick = 0;
    if (motion) { const d = motion.duration; const tt = loop ? (d > 0 ? ((time % d) + d) % d : 0) : Math.min(Math.max(time, 0), d); tick = tt * motion.tps; }
    for (let i = 0; i < this.n; i++) {
      const nd = this.nodes[i], ch = motion && motion.chan.get(i); let L = nd.local;
      if (ch) { compose(ch.pos ? sampleVec(ch.pos, tick) : nd.rest.t, ch.rot ? sampleQuat(ch.rot, tick) : nd.rest.q, ch.scl ? sampleVec(ch.scl, tick) : nd.rest.s, this.tmp); L = this.tmp; }
      const W = this.w64[i];
      if (nd.parent < 0) W.set(L); else mulCol(this.w64[nd.parent], L, W);
      this.worldV[i].set(W);
      if (nd.offset) { mulCol(W, nd.offset, this.tmp2); this.skinV[i].set(this.tmp2); } else this.skinV[i].set(W);
    }
  }
}

function matName(scene, mi) {
  for (const p of scene.materials?.[mi]?.properties || []) if (p.key === '?mat.name' && typeof p.value === 'string') return p.value;
  return '';
}
function texOf(scene, mi) {
  const props = scene.materials?.[mi]?.properties || [];
  for (const p of props) if (p.key === '$tex.file' && (p.semantic === 1 || p.semantic === 12) && typeof p.value === 'string') return p.value;
  return '';
}

export function convertScene(scene) {
  const nodes = [], inst = [];
  (function walk(nd, parent) {
    const idx = nodes.length;
    nodes.push({ name: nd.name, parent, local: toCol(nd.transformation || ident()), offset: null });
    for (const m of nd.meshes || []) inst.push({ m, node: idx });
    for (const c of nd.children || []) walk(c, idx);
  })(scene.rootnode, -1);
  const byName = new Map(); nodes.forEach((x, i) => { if (!byName.has(x.name)) byName.set(x.name, i); });
  for (const sm of scene.meshes || []) for (const b of sm.bones || []) {
    const ni = byName.get(b.name);
    if (ni !== undefined && !nodes[ni].offset && b.offsetmatrix) nodes[ni].offset = toCol(b.offsetmatrix);
  }
  const meshes = [];
  for (const it of inst) {
    const sm = scene.meshes[it.m], V = sm.vertices || [], n = V.length / 3;
    if (!n) continue;
    const tris = [];
    for (const f of sm.faces || []) for (let k = 1; k + 1 < f.length; k++) tris.push(f[0], f[k], f[k + 1]);
    if (!tris.length) continue;
    const indices = n > 65535 ? Uint32Array.from(tris) : Uint16Array.from(tris);
    const pos = Float32Array.from(V), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    if (sm.normals && sm.normals.length === n * 3) nor.set(sm.normals);
    else {
      for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const o of [a, b, c]) { nor[o] += nx; nor[o + 1] += ny; nor[o + 2] += nz; }
      }
    }
    const tc = sm.texturecoords?.[0], nc = sm.numuvcomponents?.[0] || 2;
    if (tc) for (let i = 0; i < n; i++) { uv[i * 2] = tc[i * nc]; uv[i * 2 + 1] = 1 - tc[i * nc + 1]; }
    const bone = new Float32Array(n * 4), weight = new Float32Array(n * 4);
    let rigid = -1; const getRigid = () => { if (rigid < 0) { rigid = nodes.length; nodes.push({ name: '#rigid', parent: it.node, local: ident(), offset: null }); } return rigid; };
    if (sm.bones && sm.bones.length) {
      const inf = Array.from({ length: n }, () => []);
      for (const b of sm.bones) { const ni = byName.get(b.name); if (ni === undefined) continue; for (const [v, w] of b.weights || []) if (v < n && w > 0) inf[v].push([ni, w]); }
      for (let v = 0; v < n; v++) {
        const l = inf[v].sort((p, q) => q[1] - p[1]).slice(0, 4), sum = l.reduce((s, x) => s + x[1], 0);
        if (!l.length) { bone[v * 4] = getRigid(); weight[v * 4] = 1; continue; }
        l.forEach(([ni, w], k) => { bone[v * 4 + k] = ni; weight[v * 4 + k] = w / sum; });
      }
    } else { const r = getRigid(); for (let v = 0; v < n; v++) { bone[v * 4] = r; weight[v * 4] = 1; } }
    const nrm = (a) => { for (let i = 0; i < n; i++) { const l = Math.hypot(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]) || 1; a[i * 3] /= l; a[i * 3 + 1] /= l; a[i * 3 + 2] /= l; } }; nrm(nor);
    meshes.push({ name: sm.name || `mesh ${it.m}`, texture: texOf(scene, sm.materialindex), material: matName(scene, sm.materialindex), shader: '', vertexCount: n, pos, nor, uv, bone, weight, indices, skinned: true });
  }
  if (!meshes.length) throw new Error('В сцене нет геометрии');
  const sk = new NodeSkeleton(nodes);
  const motions = (scene.animations || []).map((a, i) => {
    const tps = a.tickspersecond > 0 ? a.tickspersecond : TPS_DEFAULT, chan = new Map();
    let maxT = 0;
    for (const c of a.channels || []) {
      const ni = byName.get(c.name ?? c.nodename); if (ni === undefined) continue;
      const ch = { pos: c.positionkeys?.length ? c.positionkeys : null, rot: c.rotationkeys?.length ? c.rotationkeys : null, scl: c.scalingkeys?.length ? c.scalingkeys : null };
      for (const k of [ch.pos, ch.rot, ch.scl]) if (k) maxT = Math.max(maxT, k[k.length - 1][0]);
      chan.set(ni, ch);
    }
    return { name: a.name || `anim ${i}`, tps, chan, duration: (a.duration > 0 ? a.duration : maxT) / tps || 1 / tps };
  });
  sk.pose(null, 0, false);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) for (let v = 0; v < m.vertexCount; v++) {
    const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2], o = [0, 0, 0];
    for (let k = 0; k < 4; k++) { const w = m.weight[v * 4 + k]; if (!w) continue; const M = sk.skinV[m.bone[v * 4 + k]];
      o[0] += w * (M[0] * x + M[4] * y + M[8] * z + M[12]); o[1] += w * (M[1] * x + M[5] * y + M[9] * z + M[13]); o[2] += w * (M[2] * x + M[6] * y + M[10] * z + M[14]); }
    for (let k = 0; k < 3; k++) { if (o[k] < min[k]) min[k] = o[k]; if (o[k] > max[k]) max[k] = o[k]; }
  }
  const verts = meshes.reduce((a, m) => a + m.vertexCount, 0), tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  return { meshes, skeleton: sk, motions, bounds: { min, max }, flipZ: false,
    info: [`Мешей: ${meshes.length}, вершин: ${verts}, треугольников: ${tris}`, `Узлов/костей: ${sk.n}`, `Анимаций: ${motions.length}`], features: { zUp: true } };
}

let ajsP = null;
const loadScript = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('нет ' + src)); document.head.append(s); });
function getAssimp() {
  if (ajsP) return ajsP;
  ajsP = (async () => {
    const base = new URL('../../lib/', import.meta.url);
    if (!globalThis.assimpjs) {
      let ok = false;
      for (const n of ['assimpjs-all', 'assimpjs']) { try { await loadScript(new URL(n + '.js', base).href); ok = true; break; } catch (e) { /* пробуем следующий */ } }
      if (!ok) throw new Error('assimpjs не найден. Скопируйте assimpjs-all.js и assimpjs-all.wasm (или assimpjs.js/.wasm) из npm-пакета assimpjs/dist в папку lib/ расширения и перезагрузите его.');
    }
    return globalThis.assimpjs({ locateFile: (f) => new URL(f, base).href });
  })();
  ajsP.catch(() => { ajsP = null; });
  return ajsP;
}

export async function load(files, main) {
  const ajs = await getAssimp();
  const fl = new ajs.FileList();
  const ordered = [main, ...files.filter((f) => f !== main)];
  for (const f of ordered) fl.AddFile(f.name, new Uint8Array(await f.arrayBuffer()));
  const res = ajs.ConvertFileList(fl, 'assjson');
  if (!res.IsSuccess() || res.FileCount() === 0) throw new Error('assimp не смог прочитать файл (' + res.GetErrorCode() + ')');
  const scene = JSON.parse(new TextDecoder().decode(res.GetFile(0).GetContent()));
  return convertScene(scene);
}
