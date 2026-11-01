// RenderWare DFF (GTA III / Vice City / San Andreas, PC). Кадры -> NodeSkeleton, геометрия по материалам (BinMesh PLG), Skin PLG + HAnim.
import { NodeSkeleton } from './assimp.js';
import { computeBounds } from './common.js';
import { chunks, cstr } from '../rw/chunks.js';

const T = { STRUCT: 1, EXT: 3, MATERIAL: 7, MATLIST: 8, FRAMELIST: 0x0e, GEOMETRY: 0x0f, CLUMP: 0x10, ATOMIC: 0x14, GEOLIST: 0x1a, SKIN: 0x116, HANIM: 0x11e, BINMESH: 0x50e, FRAMENAME: 0x253f2fe };
const HIDDEN = /(_dam|_vlo)$/i;

function parseFrames(buf, fl) {
  const kids = chunks(buf, fl.start, fl.end), st = kids.find((k) => k.type === T.STRUCT), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const n = dv.getUint32(st.start, true), frames = []; let p = st.start + 4;
  for (let i = 0; i < n; i++, p += 56) {
    const f = []; for (let k = 0; k < 12; k++) f.push(dv.getFloat32(p + k * 4, true));
    frames.push({ m: f, parent: dv.getInt32(p + 48, true), name: '', hanim: null });
  }
  const exts = kids.filter((k) => k.type === T.EXT);
  exts.forEach((e, i) => {
    if (!frames[i]) return;
    for (const c of chunks(buf, e.start, e.end)) {
      if (c.type === T.FRAMENAME) frames[i].name = cstr(u8, c.start, c.end);
      else if (c.type === T.HANIM) {
        const nodeId = dv.getInt32(c.start + 4, true), num = dv.getUint32(c.start + 8, true), h = [];
        if (num > 0) for (let k = 0; k < num; k++) h.push({ nodeId: dv.getInt32(c.start + 20 + k * 12, true) });
        frames[i].hanim = { nodeId, hierarchy: h };
      }
    }
  });
  return frames;
}

function parseMaterials(buf, ml, ver) {
  const kids = chunks(buf, ml.start, ml.end), st = kids.find((k) => k.type === T.STRUCT), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const n = dv.getUint32(st.start, true), links = []; for (let i = 0; i < n; i++) links.push(dv.getInt32(st.start + 4 + i * 4, true));
  const parsed = kids.filter((k) => k.type === T.MATERIAL).map((m) => {
    const mk = chunks(buf, m.start, m.end), s = mk.find((k) => k.type === T.STRUCT);
    const color = [u8[s.start + 4] / 255, u8[s.start + 5] / 255, u8[s.start + 6] / 255], textured = dv.getUint32(s.start + 12, true);
    let tex = '';
    if (textured) {
      const t = mk.find((k) => k.type === 6);
      if (t) { const strs = chunks(buf, t.start, t.end).filter((k) => k.type === 2); if (strs[0]) tex = cstr(u8, strs[0].start, strs[0].end).toLowerCase(); }
    }
    return { color, tex };
  });
  let next = 0; const out = [];
  for (let i = 0; i < n; i++) out.push(links[i] < 0 ? parsed[next++] || { color: [0.7, 0.7, 0.7], tex: '' } : out[links[i]] || { color: [0.7, 0.7, 0.7], tex: '' });
  return out;
}

function parseSkin(buf, c, nv) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), nb = u8[c.start], used = u8[c.start + 1];
  let p = c.start + 4 + used; const need = nv * 20 + nb * 64;
  if (p + need > c.end) return null;
  const bones = u8.slice(p, p + nv * 4); p += nv * 4;
  const weights = new Float32Array(nv * 4); for (let i = 0; i < nv * 4; i++) weights[i] = dv.getFloat32(p + i * 4, true); p += nv * 16;
  const inv = []; for (let b = 0; b < nb; b++) { const m = new Float64Array(16); for (let k = 0; k < 16; k++) m[k] = dv.getFloat32(p + b * 64 + k * 4, true); inv.push(m); }
  return { nb, bones, weights, inv };
}

function parseGeometry(buf, gc, ver) {
  const kids = chunks(buf, gc.start, gc.end), st = kids.find((k) => k.type === T.STRUCT), dv = new DataView(buf);
  let p = st.start; const flags = dv.getUint32(p, true), nt = dv.getUint32(p + 4, true), nv = dv.getUint32(p + 8, true), nm = dv.getUint32(p + 12, true);
  p += 16; if (ver < 0x34000) p += 12;
  if (flags & 0x01000000) throw new Error('нативная (консольная) геометрия не поддерживается');
  if (flags & 8) p += nv * 4;
  let nuv = (flags >>> 16) & 0xff; if (!nuv) nuv = (flags & 4) ? 1 : (flags & 0x80) ? 2 : 0;
  const uv = new Float32Array(nv * 2);
  for (let s = 0; s < nuv; s++) { if (s === 0) for (let k = 0; k < nv * 2; k++) uv[k] = dv.getFloat32(p + k * 4, true); p += nv * 8; }
  const tris = [], triMat = [];
  for (let k = 0; k < nt; k++, p += 8) { const a = dv.getUint16(p, true), b = dv.getUint16(p + 2, true), m = dv.getUint16(p + 4, true), c = dv.getUint16(p + 6, true); tris.push(b, a, c); triMat.push(m); }
  if (nm < 1) throw new Error('нет morph target с вершинами');
  p += 16; const hasV = dv.getUint32(p, true), hasN = dv.getUint32(p + 4, true); p += 8;
  if (!hasV) throw new Error('в геометрии нет вершин');
  const pos = new Float32Array(nv * 3); for (let k = 0; k < nv * 3; k++) pos[k] = dv.getFloat32(p + k * 4, true); p += nv * 12;
  let nor = null; if (hasN) { nor = new Float32Array(nv * 3); for (let k = 0; k < nv * 3; k++) nor[k] = dv.getFloat32(p + k * 4, true); }
  if (!nor) {
    nor = new Float32Array(nv * 3);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
      for (const o of [a, b, c]) { nor[o] += x; nor[o + 1] += y; nor[o + 2] += z; }
    }
    for (let k = 0; k < nv; k++) { const l = Math.hypot(nor[k * 3], nor[k * 3 + 1], nor[k * 3 + 2]) || 1; nor[k * 3] /= l; nor[k * 3 + 1] /= l; nor[k * 3 + 2] /= l; }
  }
  const ml = kids.find((k) => k.type === T.MATLIST), mats = ml ? parseMaterials(buf, ml, ver) : [];
  let bin = null, skin = null;
  const ext = kids.find((k) => k.type === T.EXT);
  if (ext) for (const c of chunks(buf, ext.start, ext.end)) {
    if (c.type === T.BINMESH) {
      const strip = dv.getUint32(c.start, true) & 1, n = dv.getUint32(c.start + 4, true); let q = c.start + 12; const meshes = [];
      for (let i = 0; i < n && q + 8 <= c.end; i++) { const cnt = dv.getUint32(q, true), mat = dv.getUint32(q + 4, true); q += 8; const idx = new Uint32Array(cnt); for (let k = 0; k < cnt; k++) idx[k] = dv.getUint32(q + k * 4, true); q += cnt * 4; meshes.push({ mat, idx }); }
      bin = { strip, meshes };
    } else if (c.type === T.SKIN) { try { skin = parseSkin(buf, c, nv); } catch (e) { skin = null; } }
  }
  return { nv, pos, nor, uv, tris, triMat, mats, bin, skin };
}

const stripToTris = (idx) => { const o = []; for (let k = 2; k < idx.length; k++) { const a = idx[k - 2], b = idx[k - 1], c = idx[k]; if (a === b || b === c || a === c) continue; if (k & 1) o.push(a, c, b); else o.push(a, b, c); } return o; };

export function convertDff(buf) {
  const clump = chunks(buf, 0, buf.byteLength).find((c) => c.type === T.CLUMP);
  if (!clump) throw new Error('Не DFF: нет Clump');
  const ver = clump.ver, kids = chunks(buf, clump.start, clump.end);
  const fl = kids.find((k) => k.type === T.FRAMELIST), gl = kids.find((k) => k.type === T.GEOLIST);
  if (!fl || !gl) throw new Error('В DFF нет списка кадров или геометрий');
  const frames = parseFrames(buf, fl), notes = [];
  const geos = chunks(buf, gl.start, gl.end).filter((k) => k.type === T.GEOMETRY).map((g, i) => { try { return parseGeometry(buf, g, ver); } catch (e) { notes.push(`геометрия #${i}: ${e.message}`); return null; } });
  const nodes = frames.map((f) => { const m = new Float64Array(16); for (let k = 0; k < 3; k++) { m[k] = f.m[k]; m[4 + k] = f.m[3 + k]; m[8 + k] = f.m[6 + k]; m[12 + k] = f.m[9 + k]; } m[15] = 1; return { name: f.name, parent: f.parent, local: m, offset: null }; });
  const hroot = frames.find((f) => f.hanim && f.hanim.hierarchy.length);
  const boneFrame = hroot ? hroot.hanim.hierarchy.map((h) => frames.findIndex((f) => f.hanim && f.hanim.nodeId === h.nodeId)) : [];
  const meshes = [], dv = new DataView(buf);
  let skinned = 0;
  for (const a of kids.filter((k) => k.type === T.ATOMIC)) {
    const st = chunks(buf, a.start, a.end).find((k) => k.type === T.STRUCT), fi = dv.getUint32(st.start, true), gi = dv.getUint32(st.start + 4, true);
    const g = geos[gi], fr = frames[fi]; if (!g || !fr || HIDDEN.test(fr.name)) continue;
    const bone = new Float32Array(g.nv * 4), weight = new Float32Array(g.nv * 4);
    const useSkin = g.skin && boneFrame.length && g.skin.nb <= boneFrame.length;
    if (useSkin) {
      skinned++;
      g.skin.inv.forEach((m, b) => { const nf = boneFrame[b]; if (nf >= 0 && !nodes[nf].offset) nodes[nf].offset = m; });
      for (let v = 0; v < g.nv * 4; v++) { const nf = boneFrame[g.skin.bones[v]]; bone[v] = nf >= 0 ? nf : fi; weight[v] = g.skin.weights[v]; }
    } else for (let v = 0; v < g.nv; v++) { bone[v * 4] = fi; weight[v * 4] = 1; }
    let subs;
    if (g.bin) subs = g.bin.meshes.map((m) => ({ mat: m.mat, tris: g.bin.strip ? stripToTris(m.idx) : Array.from(m.idx) }));
    else { const by = new Map(); g.triMat.forEach((mi, t) => { if (!by.has(mi)) by.set(mi, []); by.get(mi).push(g.tris[t * 3], g.tris[t * 3 + 1], g.tris[t * 3 + 2]); }); subs = [...by].map(([mat, tris]) => ({ mat, tris })); }
    for (const s of subs) {
      if (!s.tris.length) continue;
      const mat = g.mats[s.mat] || { color: [0.7, 0.72, 0.76], tex: '' };
      meshes.push({ name: `${fr.name || 'frame ' + fi}${subs.length > 1 ? ' #' + s.mat : ''}`, texture: mat.tex, color: mat.color, shader: '', vertexCount: g.nv, pos: g.pos, nor: g.nor, uv: g.uv, bone, weight,
        indices: g.nv > 65535 ? Uint32Array.from(s.tris) : Uint16Array.from(s.tris), skinned: true });
    }
  }
  if (!meshes.length) throw new Error('В DFF не найдено геометрии' + (notes.length ? ' (' + notes.join('; ') + ')' : ''));
  const sk = new NodeSkeleton(nodes), bounds = computeBounds(sk, meshes);
  const verts = meshes.reduce((a, m) => a + m.vertexCount, 0), tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  const info = [`RenderWare 0x${ver.toString(16)}, кадров: ${frames.length}`, `Мешей: ${meshes.length}, вершин (с повторами): ${verts}, треугольников: ${tris}`,
    skinned ? `Скин: ${skinned} геом., костей: ${boneFrame.length} (анимации IFP — следующая часть)` : 'Без скелета'];
  if (notes.length) info.push('Замечания:', ...notes.map((n) => ' • ' + n));
  return { meshes, skeleton: sk, motions: [], bounds, flipZ: false, defaultZUp: true, cameraYaw: Math.PI, info, features: { zUp: true } };
}

export async function load(files, main) { return convertDff(await main.arrayBuffer()); }
