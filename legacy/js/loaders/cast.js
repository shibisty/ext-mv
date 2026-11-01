// Cast (.cast, DTZxPorter): контейнер моделей/анимаций/материалов. Основной формат выгрузки Greyhound / Wraith / Legion для Call of Duty и др.
import { NodeSkeleton } from './assimp.js';
import { computeBounds } from './common.js';

const fcc = (s) => ((s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0);
const ID = { model: fcc('modl'), mesh: fcc('mesh'), skel: fcc('skel'), bone: fcc('bone'), matl: fcc('matl'), file: fcc('file'), anim: fcc('anim'), curve: fcc('curv') };
const TYPES = { 0x62: [Uint8Array, 1, 1], 0x68: [Uint16Array, 2, 1], 0x69: [Int32Array, 4, 1], 0x6c: [BigUint64Array, 8, 1], 0x66: [Float32Array, 4, 1], 0x64: [Float64Array, 8, 1],
  0x3276: [Float32Array, 4, 2], 0x3376: [Float32Array, 4, 3], 0x3476: [Float32Array, 4, 4] };

export function parseCast(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
  if (buf.byteLength < 16 || dv.getUint32(0, true) !== 0x74736163) throw new Error('Не Cast (нет сигнатуры «cast»)');
  const nRoots = dv.getUint32(8, true); let p = 16;
  const prop = () => {
    const type = dv.getUint16(p, true), nameLen = dv.getUint16(p + 2, true), count = dv.getUint32(p + 4, true); p += 8;
    const name = dec.decode(u8.subarray(p, p + nameLen)); p += nameLen;
    let value;
    if (type === 0x73) { const list = []; for (let i = 0; i < count; i++) { let q = p; while (q < u8.length && u8[q]) q++; list.push(dec.decode(u8.subarray(p, q))); p = q + 1; } value = count === 1 ? list[0] : list; }
    else {
      const t = TYPES[type]; if (!t) throw new Error('Cast: неизвестный тип свойства 0x' + type.toString(16));
      const n = count * t[2], bytes = n * t[1]; value = new t[0](buf.slice(p, p + bytes)); p += bytes;
    }
    return { name, value };
  };
  const node = () => {
    const id = dv.getUint32(p, true), hash = dv.getBigUint64(p + 8, true).toString(), nProps = dv.getUint32(p + 16, true), nKids = dv.getUint32(p + 20, true); p += 24;
    const props = {}; for (let i = 0; i < nProps; i++) { const q = prop(); props[q.name] = q.value; }
    const kids = []; for (let i = 0; i < nKids; i++) kids.push(node());
    return { id, hash, props, kids };
  };
  const roots = []; for (let i = 0; i < nRoots; i++) roots.push(node());
  return roots;
}

const num = (props, key, def) => { const v = props[key]; return v === undefined ? def : (typeof v === 'string' ? v : (v.length ? Number(v[0]) : def)); };
const qmat = ([w, x, y, z], t, s = [1, 1, 1]) => {
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const R = [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)], m = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[r * 3 + c] * s[c];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1; return m;
};
const mulCol = (a, b) => { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const rigidInv = (M) => {
  const o = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = M[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(M[r * 4] * M[12] + M[r * 4 + 1] * M[13] + M[r * 4 + 2] * M[14]);
  o[15] = 1; return o;
};
const xyzw = (a, i = 0) => [a[i * 4 + 3], a[i * 4], a[i * 4 + 1], a[i * 4 + 2]];   // cast: x,y,z,w -> [w,x,y,z]

function normals(pos, idx) {
  const nv = pos.length / 3, nor = new Float32Array(nv * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const o of [a, b, c]) { nor[o] += x; nor[o + 1] += y; nor[o + 2] += z; }
  }
  for (let k = 0; k < nv; k++) { const l = Math.hypot(nor[k * 3], nor[k * 3 + 1], nor[k * 3 + 2]) || 1; nor[k * 3] /= l; nor[k * 3 + 1] /= l; nor[k * 3 + 2] /= l; }
  return nor;
}
const walk = (n, f) => { f(n); n.kids.forEach((k) => walk(k, f)); };

export function convertCast(roots) {
  let model = null; for (const r of roots) for (const k of r.kids) if (k.id === ID.model) { model = k; break; }
  if (!model) { const hasAnim = roots.some((r) => r.kids.some((k) => k.id === ID.anim)); throw Object.assign(new Error(hasAnim ? 'Это файл анимации Cast (не модель)' : 'В Cast нет модели'), { motionOnly: hasAnim }); }
  const skelNode = model.kids.find((k) => k.id === ID.skel), boneNodes = skelNode ? skelNode.kids.filter((k) => k.id === ID.bone) : [];
  // кости: локальные трансформы + мировой bind (offset)
  const n = boneNodes.length, world = new Array(n), local = new Array(n), memo = new Array(n).fill(false), bones = boneNodes.map((b, i) => {
    let par = num(b.props, 'p', -1); if (par < 0 || par >= n || par === i) par = -1;
    return { name: String(b.props.n || `bone${i}`), parent: par, props: b.props };
  });
  const calc = (i) => {
    if (memo[i]) return; memo[i] = true; const b = bones[i], pr = b.props;
    if (b.parent >= 0) calc(b.parent);
    const pw = b.parent >= 0 ? world[b.parent] : null, sc = pr.s && pr.s.length >= 3 ? [pr.s[0], pr.s[1], pr.s[2]] : [1, 1, 1];
    if (pr.lp && pr.lr) local[i] = qmat(xyzw(pr.lr), [pr.lp[0], pr.lp[1], pr.lp[2]], sc);
    if (pr.wp && pr.wr) world[i] = qmat(xyzw(pr.wr), [pr.wp[0], pr.wp[1], pr.wp[2]]);
    if (!world[i]) world[i] = pw ? mulCol(pw, local[i] || qmat([1, 0, 0, 0], [0, 0, 0])) : (local[i] || qmat([1, 0, 0, 0], [0, 0, 0]));
    if (!local[i]) local[i] = pw ? mulCol(rigidInv(pw), world[i]) : world[i];
  };
  for (let i = 0; i < n; i++) calc(i);
  const nodes = bones.map((b, i) => ({ name: b.name, parent: b.parent, local: local[i], offset: rigidInv(world[i]) }));
  // материалы
  const mats = new Map();
  for (const m of model.kids.filter((k) => k.id === ID.matl)) {
    const files = m.kids.filter((k) => k.id === ID.file).map((f) => ({ slot: String(f.props.n || ''), path: String(f.props.p || '') }));
    const pick = files.find((f) => /albedo|diffuse|basecolor|base_color|color/i.test(f.slot)) || files[0];
    mats.set(m.hash, { name: String(m.props.n || ''), tex: pick ? pick.path : '' });
  }
  const meshes = [];
  for (const m of model.kids.filter((k) => k.id === ID.mesh)) {
    const pr = m.props; if (!pr.vp || !pr.f) continue;
    const nv = pr.vp.length / 3, pos = Float32Array.from(pr.vp), idx = Array.from(pr.f), uv = new Float32Array(nv * 2);
    if (pr.u0 && pr.u0.length >= nv * 2) uv.set(pr.u0.subarray(0, nv * 2));
    const nor = pr.vn && pr.vn.length >= nv * 3 ? Float32Array.from(pr.vn) : normals(pos, idx);
    const bone = new Float32Array(nv * 4), weight = new Float32Array(nv * 4), mi = num(pr, 'mi', 0);
    if (n && pr.wb && pr.wv && mi > 0) {
      for (let v = 0; v < nv; v++) {
        const l = []; for (let k = 0; k < mi; k++) { const w = pr.wv[v * mi + k], b = Number(pr.wb[v * mi + k]); if (w > 0 && b < n) l.push([b, w]); }
        l.sort((a, b) => b[1] - a[1]); const top = l.slice(0, 4), sum = top.reduce((s, x) => s + x[1], 0) || 1;
        if (!top.length) weight[v * 4] = 1; else top.forEach(([b, w], k) => { bone[v * 4 + k] = b; weight[v * 4 + k] = w / sum; });
      }
    } else for (let v = 0; v < nv; v++) weight[v * 4] = 1;
    const mat = pr.m ? mats.get(pr.m[0].toString()) : null;
    meshes.push({ name: String(pr.n || `mesh ${meshes.length}`), texture: mat ? mat.tex : '', shader: mat ? mat.name : '', vertexCount: nv, pos, nor, uv, bone, weight,
      indices: nv > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx), skinned: true });
  }
  if (!meshes.length) throw new Error('В Cast-модели нет мешей');
  let sk = null, bounds;
  if (n) { sk = new NodeSkeleton(nodes); bounds = computeBounds(sk, meshes); }
  else { const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; for (const m of meshes) for (let i = 0; i < m.pos.length; i++) { const k = i % 3; if (m.pos[i] < min[k]) min[k] = m.pos[i]; if (m.pos[i] > max[k]) max[k] = m.pos[i]; } bounds = { min, max }; }
  const tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0), byName = new Map(bones.map((b, i) => [b.name.toLowerCase(), i]));
  return { meshes, skeleton: sk, motions: [], bounds, flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, features: { zUp: true },
    info: [`Cast: «${model.props.n || 'model'}», мешей ${meshes.length}, треугольников ${tris}, костей ${n}, материалов ${mats.size}`, n ? 'Анимации: .cast с анимацией — кнопкой «+ анимация» или кликом в списке' : 'Статичная модель'],
    loadMotions: n ? async (file) => convertCastAnim(parseCast(await file.arrayBuffer()), byName, nodes) : undefined };
}

// Анимации Cast: curve = (имя кости, свойство rq/tx/ty/tz, кадры, значения). Поддержан абсолютный режим.
export function convertCastAnim(roots, byName, nodes) {
  const out = [];
  for (const r of roots) for (const a of r.kids.filter((k) => k.id === ID.anim)) {
    const fps = num(a.props, 'fr', 30) || 30, chan = new Map(), bag = new Map(); let maxF = 0;
    for (const c of a.kids.filter((k) => k.id === ID.curve)) {
      const bi = byName.get(String(c.props.nn || '').toLowerCase()); if (bi === undefined || !c.props.kb || !c.props.kv) continue;
      const kp = String(c.props.kp || ''), t = bag.get(bi) || { pos: new Map(), rot: new Map() }; bag.set(bi, t);
      for (let i = 0; i < c.props.kb.length; i++) {
        const f = Number(c.props.kb[i]); maxF = Math.max(maxF, f);
        if (kp === 'rq') t.rot.set(f, xyzw(c.props.kv, i));
        else if (kp === 'tx' || kp === 'ty' || kp === 'tz') { const v = t.pos.get(f) || [NaN, NaN, NaN]; v['xyz'.indexOf(kp[1])] = c.props.kv[i]; t.pos.set(f, v); }
      }
    }
    for (const [bi, t] of bag) {
      const rest = [nodes[bi].local[12], nodes[bi].local[13], nodes[bi].local[14]];
      const pos = [...t.pos].sort((x, y) => x[0] - y[0]).map(([f, v]) => [f, v.map((x, k) => (Number.isNaN(x) ? rest[k] : x))]);
      const rot = [...t.rot].sort((x, y) => x[0] - y[0]);
      chan.set(bi, { pos: pos.length ? pos : null, rot: rot.length ? rot : null, scl: null });
    }
    if (chan.size) out.push({ name: String(a.props.n || `anim ${out.length}`), tps: fps, chan, duration: (maxF + 1) / fps, frames: maxF + 1 });
  }
  return out;
}

export async function load(files, main) { return convertCast(parseCast(await main.arrayBuffer())); }
