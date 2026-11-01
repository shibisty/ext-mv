// id Tech 1–4: Quake MDL, Quake II MD2, Quake III MD3 (покадровая анимация вершин), Doom 3 / Quake 4 MD5 (скелет + .md5anim).
import { NodeSkeleton } from './assimp.js';
import { computeBounds } from './common.js';

const cstr = (u8, a, n) => { let s = ''; for (let i = 0; i < n && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; };

function computeNormals(pos, idx) {
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
const boundsOf = (meshes) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) for (let i = 0; i < m.pos.length; i++) { const k = i % 3; if (m.pos[i] < min[k]) min[k] = m.pos[i]; if (m.pos[i] > max[k]) max[k] = m.pos[i]; }
  return { min, max };
};
// Группировка кадров в анимации по имени без хвостовых цифр (stand01, stand02 -> stand)
function groupMotions(names, fps) {
  const out = [];
  names.forEach((n, i) => {
    const base = n.replace(/\d+$/, '') || n, last = out[out.length - 1];
    if (last && last.name === base) { last.count++; last.duration = last.count / fps; }
    else out.push({ name: base, start: i, count: 1, fps, duration: 1 / fps });
  });
  return out.filter((m) => m.count > 1).length ? out : [{ name: 'все кадры', start: 0, count: names.length, fps, duration: names.length / fps }];
}
function makeAnimate(meshes) {
  return (motion, t, loop) => {
    let f0 = 0, f1 = 0, a = 0;
    if (motion) {
      const n = motion.count; let fr = t * motion.fps;
      fr = loop ? ((fr % n) + n) % n : Math.min(Math.max(fr, 0), n - 1);
      const i = Math.floor(fr); a = fr - i; f0 = motion.start + i; f1 = motion.start + (loop ? (i + 1) % n : Math.min(i + 1, n - 1));
    }
    for (const m of meshes) {
      for (const [dst, src] of [[m.pos, m.frames.pos], [m.nor, m.frames.nor]]) { const A = src[f0], B = src[f1]; for (let k = 0; k < dst.length; k++) dst[k] = A[k] + (B[k] - A[k]) * a; }
    }
  };
}
function frameModel(meshes, names, fps, info, extra = {}) {
  const motions = names.length > 1 ? groupMotions(names, fps) : [];
  return { meshes, skeleton: null, motions, bounds: boundsOf(meshes), flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, info, features: { zUp: true }, animate: makeAnimate(meshes), ...extra };
}
function frameMesh(name, texture, uv, indices, framePos) {
  const nv = uv.length / 2, nors = framePos.map((p) => computeNormals(p, indices));
  return { name, texture, shader: '', vertexCount: nv, pos: Float32Array.from(framePos[0]), nor: Float32Array.from(nors[0]), uv, bone: new Float32Array(nv * 4), weight: new Float32Array(nv * 4),
    indices: nv > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices), skinned: false, dynamic: true, frames: { pos: framePos, nor: nors } };
}

// ---------- Quake II: MD2 ----------
export function loadMd2(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.getUint32(0, true) !== 0x32504449 || dv.getInt32(4, true) !== 8) throw new Error('Не MD2 (IDP2 v8)');
  const I = (o) => dv.getInt32(o, true), skinW = I(8), skinH = I(12), frameSize = I(16), nSkins = I(20), nXyz = I(24), nSt = I(28), nTris = I(32), nFrames = I(40);
  const oSkins = I(44), oSt = I(48), oTris = I(52), oFrames = I(56);
  const map = new Map(), xyzOf = [], stOf = [], indices = [];
  for (let t = 0; t < nTris; t++) for (let c = 0; c < 3; c++) {
    const xi = dv.getUint16(oTris + t * 12 + c * 2, true), si = dv.getUint16(oTris + t * 12 + 6 + c * 2, true), key = xi + si * 65536;
    let v = map.get(key); if (v === undefined) { v = xyzOf.length; map.set(key, v); xyzOf.push(xi); stOf.push(si); }
    indices.push(v);
  }
  const nv = xyzOf.length, uv = new Float32Array(nv * 2);
  for (let v = 0; v < nv; v++) { uv[v * 2] = dv.getInt16(oSt + stOf[v] * 4, true) / skinW; uv[v * 2 + 1] = dv.getInt16(oSt + stOf[v] * 4 + 2, true) / skinH; }
  const framePos = [], names = [];
  for (let f = 0; f < nFrames; f++) {
    const b = oFrames + f * frameSize, sc = [dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)], tr = [dv.getFloat32(b + 12, true), dv.getFloat32(b + 16, true), dv.getFloat32(b + 20, true)];
    names.push(cstr(u8, b + 24, 16));
    const pos = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) { const o = b + 40 + xyzOf[v] * 4; for (let k = 0; k < 3; k++) pos[v * 3 + k] = u8[o + k] * sc[k] + tr[k]; }
    framePos.push(pos);
  }
  const skin = nSkins ? cstr(u8, oSkins, 64) : '';
  const m = frameMesh('md2', skin, uv, indices, framePos);
  return frameModel([m], names, 10, [`Quake II MD2: вершин ${nv}, треугольников ${nTris}, кадров ${nFrames}`, skin ? `Скин: ${skin}` : 'Скин не указан (выберите текстуру вручную)']);
}

// ---------- Quake III: MD3 ----------
export function loadMd3(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.getUint32(0, true) !== 0x33504449 || dv.getInt32(4, true) !== 15) throw new Error('Не MD3 (IDP3 v15)');
  const nFrames = dv.getInt32(76, true), nTags = dv.getInt32(80, true), nSurf = dv.getInt32(84, true), oSurf = dv.getInt32(100, true);
  const meshes = []; let off = oSurf, tris = 0;
  for (let s = 0; s < nSurf; s++) {
    const I = (o) => dv.getInt32(off + o, true), name = cstr(u8, off + 4, 64), nF = I(72), nSh = I(76), nV = I(80), nT = I(84), oT = I(88), oSh = I(92), oSt = I(96), oX = I(100), end = I(104);
    const idx = []; for (let k = 0; k < nT * 3; k++) idx.push(dv.getInt32(off + oT + k * 4, true));
    const uv = new Float32Array(nV * 2); for (let k = 0; k < nV * 2; k++) uv[k] = dv.getFloat32(off + oSt + k * 4, true);
    const framePos = [];
    for (let f = 0; f < nF; f++) {
      const p = new Float32Array(nV * 3);
      for (let v = 0; v < nV; v++) { const o = off + oX + (f * nV + v) * 8; for (let k = 0; k < 3; k++) p[v * 3 + k] = dv.getInt16(o + k * 2, true) / 64; }
      framePos.push(p);
    }
    meshes.push(frameMesh(name || `surface ${s}`, nSh ? cstr(u8, off + oSh, 64) : '', uv, idx, framePos)); tris += nT;
    off += end;
  }
  if (!meshes.length) throw new Error('В MD3 нет поверхностей');
  const names = Array.from({ length: nFrames }, () => ''); 
  const model = frameModel(meshes, names, 15, [`Quake III MD3: поверхностей ${meshes.length}, треугольников ${tris}, кадров ${nFrames}, тегов ${nTags}`, 'Теги (привязка частей игрока/оружия) не используются.']);
  if (nFrames > 1) model.motions = [{ name: 'все кадры', start: 0, count: nFrames, fps: 15, duration: nFrames / 15 }];
  return model;
}

// ---------- Quake: MDL ----------
export function loadMdl(buf, palette) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.getUint32(0, true) !== 0x4f504449 || dv.getInt32(4, true) !== 6) throw new Error('Не MDL (IDPO v6)');
  const F = (o) => dv.getFloat32(o, true), I = (o) => dv.getInt32(o, true);
  const sc = [F(8), F(12), F(16)], tr = [F(20), F(24), F(28)], nSkins = I(48), sw = I(52), sh = I(56), nV = I(60), nT = I(64), nF = I(68);
  let p = 84, skin = null;
  for (let i = 0; i < nSkins; i++) {
    const group = I(p); p += 4;
    if (group === 0) { if (!skin) skin = u8.slice(p, p + sw * sh); p += sw * sh; }
    else { const n = I(p); p += 4 + n * 4; if (!skin) skin = u8.slice(p, p + sw * sh); p += n * sw * sh; }
  }
  const st = []; for (let i = 0; i < nV; i++, p += 12) st.push({ seam: I(p), s: I(p + 4), t: I(p + 8) });
  const tris = []; for (let i = 0; i < nT; i++, p += 16) tris.push({ front: I(p), v: [I(p + 4), I(p + 8), I(p + 12)] });
  const map = new Map(), vOf = [], uvArr = [], indices = [];
  for (const t of tris) for (const vi of t.v) {
    const back = !t.front && st[vi].seam, key = vi * 2 + (back ? 1 : 0); let v = map.get(key);
    if (v === undefined) { v = vOf.length; map.set(key, v); vOf.push(vi); uvArr.push((st[vi].s + (back ? sw / 2 : 0) + 0.5) / sw, (st[vi].t + 0.5) / sh); }
    indices.push(v);
  }
  const frames = [], names = [];
  const readFrame = (q) => { names.push(cstr(u8, q + 8, 16)); const pos = new Float32Array(vOf.length * 3); for (let v = 0; v < vOf.length; v++) for (let k = 0; k < 3; k++) pos[v * 3 + k] = u8[q + 24 + vOf[v] * 4 + k] * sc[k] + tr[k]; frames.push(pos); return q + 24 + nV * 4; };
  for (let f = 0; f < nF; f++) {
    const type = I(p); p += 4;
    if (type === 0) p = readFrame(p);
    else { const n = I(p); p += 4 + 8 + n * 4; for (let k = 0; k < n; k++) p = readFrame(p); }
  }
  const m = frameMesh('mdl', '', Float32Array.from(uvArr), indices, frames);
  const rgba = new Uint8Array(sw * sh * 4);
  if (skin) for (let i = 0; i < sw * sh; i++) { const c = skin[i]; if (palette) { rgba[i * 4] = palette[c * 3]; rgba[i * 4 + 1] = palette[c * 3 + 1]; rgba[i * 4 + 2] = palette[c * 3 + 2]; } else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = c; rgba[i * 4 + 3] = 255; }
  m.image = { width: sw, height: sh, rgba };
  return frameModel([m], names, 10, [`Quake MDL: вершин ${vOf.length}, треугольников ${nT}, кадров ${frames.length}`, palette ? 'Палитра: gfx/palette.lmp' : 'Палитра Quake не найдена (откройте pak0.pak) — текстура в градациях серого']);
}

// ---------- Doom 3 / Quake 4: MD5 ----------
const JOINT = /^"([^"]+)"\s+(-?\d+)\s+\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s+\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)/;
const lines = (text) => text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
const quatW = (x, y, z) => -Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
const rotate = (q, v) => { // q = [w,x,y,z]
  const [w, x, y, z] = q, cx = y * v[2] - z * v[1] + w * v[0], cy = z * v[0] - x * v[2] + w * v[1], cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
};
function qmat(q, t) {
  const [w, x, y, z] = q, xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const R = [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)], m = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[r * 3 + c];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1; return m;
}
function rigidInv(M) {
  const o = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = M[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(M[r * 4] * M[12] + M[r * 4 + 1] * M[13] + M[r * 4 + 2] * M[14]);
  o[15] = 1; return o;
}
function mulCol(a, b) { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }

export function parseMd5mesh(text) {
  const L = lines(text), joints = [], meshes = [];
  for (let i = 0; i < L.length; i++) {
    if (/^joints\s*\{/.test(L[i])) { for (i++; i < L.length && L[i] !== '}'; i++) { const m = JOINT.exec(L[i]); if (m) joints.push({ name: m[1], parent: +m[2], pos: [+m[3], +m[4], +m[5]], q: [quatW(+m[6], +m[7], +m[8]), +m[6], +m[7], +m[8]] }); } }
    else if (/^mesh\s*\{/.test(L[i])) {
      const mesh = { shader: '', verts: [], tris: [], weights: [] };
      for (i++; i < L.length && L[i] !== '}'; i++) {
        const s = L[i]; let m;
        if ((m = /^shader\s+"([^"]*)"/.exec(s))) mesh.shader = m[1];
        else if ((m = /^vert\s+(\d+)\s+\(\s*(\S+)\s+(\S+)\s*\)\s+(\d+)\s+(\d+)/.exec(s))) mesh.verts[+m[1]] = { u: +m[2], v: +m[3], start: +m[4], count: +m[5] };
        else if ((m = /^tri\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(s))) mesh.tris[+m[1]] = [+m[2], +m[3], +m[4]];
        else if ((m = /^weight\s+(\d+)\s+(\d+)\s+(\S+)\s+\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)/.exec(s))) mesh.weights[+m[1]] = { joint: +m[2], bias: +m[3], pos: [+m[4], +m[5], +m[6]] };
      }
      meshes.push(mesh);
    }
  }
  if (!joints.length || !meshes.length) throw new Error('Не MD5mesh: нет joints/mesh');
  return { joints, meshes };
}

export function parseMd5anim(text, jointIndexByName) {
  const L = lines(text), num = (re) => { for (const l of L) { const m = re.exec(l); if (m) return +m[1]; } return 0; };
  const nFrames = num(/^numFrames\s+(\d+)/), fps = num(/^frameRate\s+(\d+)/) || 24;
  const hier = [], base = [], frames = [];
  for (let i = 0; i < L.length; i++) {
    const h = /^(hierarchy|bounds|baseframe|frame)\s*(\d*)\s*\{/.exec(L[i]); if (!h) continue;
    const vals = [];
    for (i++; i < L.length && L[i] !== '}'; i++) {
      if (h[1] === 'hierarchy') { const m = /^"([^"]+)"\s+(-?\d+)\s+(\d+)\s+(\d+)/.exec(L[i]); if (m) hier.push({ name: m[1], flags: +m[3], start: +m[4] }); }
      else if (h[1] === 'baseframe') { const m = /^\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)/.exec(L[i]); if (m) base.push({ p: [+m[1], +m[2], +m[3]], q: [+m[4], +m[5], +m[6]] }); }
      else if (h[1] === 'frame') for (const t of L[i].split(/\s+/)) vals.push(+t);
    }
    if (h[1] === 'frame') frames[+h[2]] = vals;
  }
  if (!hier.length || !frames.length) throw new Error('Не MD5anim: нет hierarchy/frame');
  const chan = new Map();
  hier.forEach((j, ji) => {
    const node = jointIndexByName.has(j.name.toLowerCase()) ? jointIndexByName.get(j.name.toLowerCase()) : ji, pos = [], rot = [];
    frames.forEach((vals, f) => {
      const p = base[ji].p.slice(), q = base[ji].q.slice(); let k = j.start;
      if (j.flags & 1) p[0] = vals[k++]; if (j.flags & 2) p[1] = vals[k++]; if (j.flags & 4) p[2] = vals[k++];
      if (j.flags & 8) q[0] = vals[k++]; if (j.flags & 16) q[1] = vals[k++]; if (j.flags & 32) q[2] = vals[k++];
      pos.push([f, p]); rot.push([f, [quatW(q[0], q[1], q[2]), q[0], q[1], q[2]]]);
    });
    chan.set(node, { pos, rot, scl: null });
  });
  return { fps, nFrames: frames.length, chan };
}

export function loadMd5(text) {
  const { joints, meshes: src } = parseMd5mesh(text);
  const abs = joints.map((j) => qmat(j.q, j.pos)), nodes = joints.map((j, i) => ({
    name: j.name, parent: j.parent, offset: rigidInv(abs[i]), local: j.parent >= 0 ? mulCol(rigidInv(abs[j.parent]), abs[i]) : abs[i],
  }));
  const meshes = src.map((s, mi) => {
    const nv = s.verts.length, pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), bone = new Float32Array(nv * 4), weight = new Float32Array(nv * 4);
    for (let v = 0; v < nv; v++) {
      const vt = s.verts[v]; uv[v * 2] = vt.u; uv[v * 2 + 1] = vt.v;
      const ws = s.weights.slice(vt.start, vt.start + vt.count); let p = [0, 0, 0];
      for (const w of ws) { const j = joints[w.joint], r = rotate(j.q, w.pos); for (let k = 0; k < 3; k++) p[k] += w.bias * (j.pos[k] + r[k]); }
      pos.set(p, v * 3);
      const top = ws.slice().sort((a, b) => b.bias - a.bias).slice(0, 4), sum = top.reduce((a, w) => a + w.bias, 0) || 1;
      top.forEach((w, k) => { bone[v * 4 + k] = w.joint; weight[v * 4 + k] = w.bias / sum; });
    }
    const idx = []; for (const t of s.tris) if (t) idx.push(t[0], t[1], t[2]);
    return { name: `mesh ${mi}`, texture: s.shader, shader: s.shader, vertexCount: nv, pos, nor: computeNormals(pos, idx), uv, bone, weight, indices: nv > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx), skinned: true };
  });
  const sk = new NodeSkeleton(nodes), bounds = computeBounds(sk, meshes), byName = new Map(joints.map((j, i) => [j.name.toLowerCase(), i]));
  const tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  return { meshes, skeleton: sk, motions: [], bounds, flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2,
    info: [`MD5mesh: костей ${joints.length}, мешей ${meshes.length}, треугольников ${tris}`, 'Анимации: .md5anim (из папки модели в pk4 подгружаются сами)'], features: { zUp: true },
    loadMotions: async (file) => {
      const a = parseMd5anim(new TextDecoder().decode(await file.arrayBuffer()), byName);
      return [{ name: file.name.replace(/\.[^.]+$/, ''), tps: a.fps, chan: a.chan, duration: a.nFrames / a.fps, frames: a.nFrames }];
    } };
}

// ---------- вход ----------
async function findInArchives(ctx, path) {
  for (const a of ctx?.archives || []) { const e = a.index.get(path); if (e) return a.read(e); }
  return null;
}
export async function load(files, main, ctx) {
  const ext = main.name.split('.').pop().toLowerCase();
  if (ext === 'md2') return loadMd2(await main.arrayBuffer());
  if (ext === 'md3') return loadMd3(await main.arrayBuffer());
  if (ext === 'md5mesh') return loadMd5(new TextDecoder().decode(await main.arrayBuffer()));
  if (ext === 'mdl') return loadMdl(await main.arrayBuffer(), await findInArchives(ctx, 'gfx/palette.lmp'));
  throw new Error('Неизвестный формат id Tech: .' + ext);
}
