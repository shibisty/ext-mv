// NIF (NetImmerse/Gamebryo) 20.2.0.7: Fallout 3 / New Vegas, Skyrim LE, Skyrim SE. Статическая геометрия + иерархия узлов + текстуры.
// Каждый блок имеет размер в заголовке, поэтому разбор геометрии проверяется: он обязан закончиться ровно на границе блока.
import { NodeSkeleton } from './assimp.js';

class R {
  constructor(buf, pos, end) { this.dv = new DataView(buf); this.u8 = new Uint8Array(buf); this.pos = pos; this.end = end; }
  b() { return this.dv.getUint8(this.pos++); }
  w() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  d() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  f() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  skip(n) { this.pos += n; }
  ascii(n) { let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(this.u8[this.pos + k]); this.pos += n; return s; }
}

export function parseHeader(buf) {
  const u8 = new Uint8Array(buf); let e = 0; while (e < 128 && u8[e] !== 10) e++;
  let line = ''; for (let k = 0; k < e; k++) line += String.fromCharCode(u8[k]);
  const m = /(Gamebryo|NetImmerse).*Version\s+(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(line);
  if (!m) throw new Error('Не NIF файл');
  const vs = `${m[2]}.${m[3]}.${m[4]}.${m[5]}`;
  const version = (((+m[2]) << 24) | ((+m[3]) << 16) | ((+m[4]) << 8) | +m[5]) >>> 0;
  if (version !== 0x14020007) throw new Error(`NIF версии ${vs} пока не поддерживается (нужна 20.2.0.7: Fallout 3/NV, Skyrim, Skyrim SE). Oblivion/Morrowind — следующая часть.`);
  const r = new R(buf, e + 1, buf.byteLength);
  r.d();
  if (r.b() === 0) throw new Error('Big-endian NIF не поддерживается');
  const userVersion = r.d(), numBlocks = r.d();
  let bsver = 0;
  if (userVersion >= 3) {
    bsver = r.d(); r.skip(r.b());                 // автор
    if (bsver > 130) r.d();
    if (bsver < 131) r.skip(r.b());               // process script
    r.skip(r.b());                                // export script
    if (bsver >= 103) r.skip(r.b());              // max filepath
  }
  const nTypes = r.w(), types = [];
  for (let k = 0; k < nTypes; k++) types.push(r.ascii(r.d()));
  const typeIdx = []; for (let k = 0; k < numBlocks; k++) typeIdx.push(r.w() & 0x7fff);
  const sizes = []; for (let k = 0; k < numBlocks; k++) sizes.push(r.d());
  const nStr = r.d(); r.d();
  const strings = []; for (let k = 0; k < nStr; k++) strings.push(r.ascii(r.d()));
  r.skip(4 * r.d());
  const blocks = []; let p = r.pos;
  for (let k = 0; k < numBlocks; k++) { blocks.push({ type: types[typeIdx[k]], start: p, end: p + sizes[k] }); p += sizes[k]; }
  let roots = [];
  try { const f = new R(buf, p, buf.byteLength), n = f.d(); for (let k = 0; k < n; k++) roots.push(f.i()); } catch (e2) { /* без футера */ }
  if (!roots.length) roots = [0];
  return { version: vs, bsver, userVersion, blocks, strings, roots };
}

// ---------- блоки ----------
function readAV(r, h) {
  const nameIdx = r.d(), ne = r.d(); r.skip(ne * 4); r.i();
  const flags = h.bsver <= 26 ? r.w() : r.d();
  const t = [r.f(), r.f(), r.f()], rot = []; for (let k = 0; k < 9; k++) rot.push(r.f());
  const scale = r.f(), props = [];
  if (h.bsver <= 34) { const n = r.d(); for (let k = 0; k < n; k++) props.push(r.i()); }
  r.i();
  return { name: nameIdx < h.strings.length ? h.strings[nameIdx] : '', flags, t, rot, scale, props };
}
function parseNode(buf, h, blk) {
  const r = new R(buf, blk.start, blk.end), av = readAV(r, h), n = r.d(), kids = [];
  for (let k = 0; k < n; k++) kids.push(r.i());
  return { ...av, kids };
}
function parseShape(buf, h, blk) {
  const r = new R(buf, blk.start, blk.end), av = readAV(r, h);
  const data = r.i(), skin = r.i(), nm = r.d(); r.skip(nm * 8 + 5);
  let shader = -1;
  if (h.bsver > 34) { shader = r.i(); r.i(); }
  return { ...av, data, skin, shader };
}

function geomVariant(buf, blk, strips, group, uvMode) {
  try {
    const r = new R(buf, blk.start, blk.end);
    if (group) r.d();
    const nv = r.w(); r.skip(2);
    if (!r.b() || nv === 0) return null;
    const pos = new Float32Array(nv * 3); for (let k = 0; k < nv * 3; k++) pos[k] = r.f();
    const flags = r.w(), hasN = r.b();
    let nor = null;
    if (hasN) { nor = new Float32Array(nv * 3); for (let k = 0; k < nv * 3; k++) nor[k] = r.f(); if (flags & 0x1000) r.skip(nv * 24); }
    r.skip(16);
    if (r.b()) r.skip(nv * 16);
    const nUV = uvMode === 0 ? (flags & 0x3f) : (flags & 1);
    const uv = new Float32Array(nv * 2);
    for (let s = 0; s < nUV; s++) for (let k = 0; k < nv; k++) { const u = r.f(), v = r.f(); if (s === 0) { uv[k * 2] = u; uv[k * 2 + 1] = v; } }
    r.skip(2); r.i();
    const tris = [];
    if (!strips) {
      const nt = r.w(), np = r.d(), has = r.b();
      if (has) { if (np !== nt * 3) return null; for (let k = 0; k < np; k++) tris.push(r.w()); }
      const mg = r.w(); for (let k = 0; k < mg; k++) r.skip(r.w() * 2);
    } else {
      r.w(); const ns = r.w(), lens = []; for (let k = 0; k < ns; k++) lens.push(r.w());
      const has = r.b();
      if (has) for (const L of lens) { const pts = []; for (let k = 0; k < L; k++) pts.push(r.w());
        for (let k = 2; k < L; k++) { const a = pts[k - 2], b = pts[k - 1], c = pts[k]; if (a === b || b === c || a === c) continue; if (k & 1) tris.push(a, c, b); else tris.push(a, b, c); } }
    }
    if (r.pos !== blk.end) return null;
    for (const t of tris) if (t >= nv) return null;
    return { nv, pos, nor, uv, tris };
  } catch (e) { return null; }
}
function parseGeomData(buf, blk, strips) {
  for (const group of [true, false]) for (const uvMode of [0, 1]) { const g = geomVariant(buf, blk, strips, group, uvMode); if (g) return g; }
  return null;
}

const half = (x) => { const s = x & 0x8000 ? -1 : 1, e = (x >> 10) & 31, f = x & 1023; return e === 0 ? s * 5.960464477539063e-8 * f : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024); };
function parseBSTriShape(buf, h, blk) {
  const r = new R(buf, blk.start, blk.end), av = readAV(r, h);
  r.skip(16); if (h.bsver === 155) r.skip(24);
  const skin = r.i(), shader = r.i(); r.i();
  const lo = r.d(), hi = r.d(), nt = h.bsver >= 130 ? r.d() : r.w(), nv = r.w(), size = r.d();
  if (!size || !nv) return { ...av, shader, geom: null };
  const stride = (lo & 0xf) * 4, off = (a) => ((lo >>> (4 + 4 * a)) & 0xf) * 4, attrs = (hi >>> 12) & 0x7ff;   // биты 44..54 u64
  const full = h.bsver === 100 || (attrs & 0x400) !== 0, hasUV = (attrs & 2) !== 0, hasN = (attrs & 8) !== 0;
  const dv = r.dv, base = r.pos, pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let k = 0; k < nv; k++) {
    const o = base + k * stride;
    for (let c = 0; c < 3; c++) pos[k * 3 + c] = full ? dv.getFloat32(o + c * 4, true) : half(dv.getUint16(o + c * 2, true));
    if (hasUV) { const q = o + off(1); uv[k * 2] = half(dv.getUint16(q, true)); uv[k * 2 + 1] = half(dv.getUint16(q + 2, true)); }
    if (hasN) { const q = o + off(3); for (let c = 0; c < 3; c++) nor[k * 3 + c] = dv.getUint8(q + c) / 255 * 2 - 1; }
  }
  r.pos = base + nv * stride;
  const tris = []; for (let k = 0; k < nt * 3; k++) tris.push(r.w());
  return { ...av, shader, geom: { nv, pos, nor: hasN ? nor : null, uv, tris } };
}

function textureSets(buf, h) {
  const map = new Map();
  h.blocks.forEach((b, i) => {
    if (b.type !== 'BSShaderTextureSet') return;
    try { const r = new R(buf, b.start, b.end), n = r.d(), list = []; for (let k = 0; k < n; k++) list.push(r.ascii(r.d())); map.set(i, list); } catch (e) { /* пропуск */ }
  });
  return map;
}
function findTexture(buf, h, sets, propIdx) {
  for (const pi of propIdx) {
    const b = h.blocks[pi]; if (!b) continue;
    const dv = new DataView(buf);
    for (const pass of [0, 1]) for (let o = b.start; o + 4 <= b.end; o++) {
      if (((o - b.start) % 4 === 0) !== (pass === 0)) continue;
      const v = dv.getInt32(o, true);
      if (sets.has(v)) return sets.get(v)[0] || '';
    }
  }
  return '';
}

const NODE_SKIP = /^(editormarker|markerx|collisiongeom)/i;
const SHAPES = new Set(['NiTriShape', 'NiTriStrips', 'BSLODTriShape', 'BSSegmentedTriShape']);
const BS_SHAPES = new Set(['BSTriShape', 'BSDynamicTriShape', 'BSMeshLODTriShape', 'BSSubIndexTriShape']);
const ident = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function localMatrix(av) { const m = ident(); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 4 + r] = av.rot[r * 3 + c] * av.scale; m[12] = av.t[0]; m[13] = av.t[1]; m[14] = av.t[2]; return m; }

export function convertNif(buf) {
  const h = parseHeader(buf), sets = textureSets(buf, h), nodes = [], meshes = [], seen = new Set(), notes = new Set();
  const addMesh = (name, g, tex, ni) => {
    const nv = g.nv, nor = g.nor ? Float32Array.from(g.nor) : new Float32Array(nv * 3);
    if (!g.nor) for (let t = 0; t < g.tris.length; t += 3) {
      const a = g.tris[t] * 3, b = g.tris[t + 1] * 3, c = g.tris[t + 2] * 3, P = g.pos;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
      for (const o of [a, b, c]) { nor[o] += x; nor[o + 1] += y; nor[o + 2] += z; }
    }
    for (let k = 0; k < nv; k++) { const l = Math.hypot(nor[k * 3], nor[k * 3 + 1], nor[k * 3 + 2]) || 1; nor[k * 3] /= l; nor[k * 3 + 1] /= l; nor[k * 3 + 2] /= l; }
    const bone = new Float32Array(nv * 4), weight = new Float32Array(nv * 4);
    for (let k = 0; k < nv; k++) { bone[k * 4] = ni; weight[k * 4] = 1; }
    meshes.push({ name, texture: tex, shader: '', vertexCount: nv, pos: g.pos, nor, uv: g.uv, bone, weight, indices: Uint16Array.from(g.tris), skinned: true });
  };
  const walk = (idx, parent) => {
    const blk = h.blocks[idx]; if (!blk || seen.has(idx)) return; seen.add(idx);
    const t = blk.type;
    try {
      if (/Node$/.test(t)) {
        const n = parseNode(buf, h, blk);
        if ((n.flags & 1) || NODE_SKIP.test(n.name)) return;
        const ni = nodes.push({ name: n.name, parent, local: localMatrix(n), offset: null }) - 1;
        const kids = (t === 'NiSwitchNode' || t === 'NiLODNode') ? n.kids.slice(0, 1) : n.kids;
        for (const k of kids) walk(k, ni);
      } else if (SHAPES.has(t)) {
        const s = parseShape(buf, h, blk);
        if ((s.flags & 1) || NODE_SKIP.test(s.name) || s.data < 0) return;
        const g = parseGeomData(buf, h.blocks[s.data], t === 'NiTriStrips');
        if (!g) { notes.add(`блок ${t} #${idx}: геометрия не разобрана`); return; }
        if (!g.tris.length) { notes.add(`${s.name || t}: треугольники только в NiSkinPartition (не поддержано)`); return; }
        const ni = nodes.push({ name: s.name, parent, local: localMatrix(s), offset: null }) - 1;
        addMesh(s.name || t, g, findTexture(buf, h, sets, h.bsver > 34 ? [s.shader] : s.props), ni);
      } else if (BS_SHAPES.has(t)) {
        const s = parseBSTriShape(buf, h, blk);
        if ((s.flags & 1) || NODE_SKIP.test(s.name) || !s.geom) return;
        const ni = nodes.push({ name: s.name, parent, local: localMatrix(s), offset: null }) - 1;
        addMesh(s.name || t, s.geom, findTexture(buf, h, sets, [s.shader]), ni);
      }
    } catch (e) { notes.add(`блок ${t} #${idx}: ${e.message}`); }
  };
  for (const r of h.roots) walk(r, -1);
  if (!meshes.length) throw new Error('В NIF не найдено поддерживаемой геометрии' + (notes.size ? ' (' + [...notes].join('; ') + ')' : ''));
  const sk = new NodeSkeleton(nodes); sk.pose(null, 0, false);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) { const M = sk.skinV[m.bone[0]]; for (let v = 0; v < m.vertexCount; v++) {
    const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2];
    const o = [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
    for (let k = 0; k < 3; k++) { if (o[k] < min[k]) min[k] = o[k]; if (o[k] > max[k]) max[k] = o[k]; } } }
  const verts = meshes.reduce((a, m) => a + m.vertexCount, 0), tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  const types = {}; h.blocks.forEach((b) => { types[b.type] = (types[b.type] || 0) + 1; });
  const info = [`NIF ${h.version}, BS version ${h.bsver}, блоков: ${h.blocks.length}`, `Мешей: ${meshes.length}, вершин: ${verts}, треугольников: ${tris}`,
    'Анимации (.kf) и скининг — следующая часть; модель показана в bind-позе.'];
  if (notes.size) info.push('Замечания:', ...[...notes].slice(0, 8).map((n) => ' • ' + n));
  return { meshes, skeleton: sk, motions: [], bounds: { min, max }, flipZ: false, defaultZUp: true, cameraYaw: Math.PI, info, features: { zUp: true }, _types: types };
}

export async function load(files, main) { return convertNif(await main.arrayBuffer()); }
