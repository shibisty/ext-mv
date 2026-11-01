// Парсер X-Ray OGF (v4) / OMF. Без внешних зависимостей.
export const OGF = { HEADER:1, TEXTURE:2, VERTICES:3, INDICES:4, CHILDREN:9, S_BONE_NAMES:13, S_MOTIONS:14,
  S_SMPARAMS:15, S_IKDATA:16, S_USERDATA:17, S_DESC:18, S_MOTION_REFS0:19, S_MOTION_REFS1:20 };
const TYPE_NAMES = ['NORMAL','HIERRARHY','PROGRESSIVE','SKELETON_ANIM','SKELETON_GEOMDEF_PM','SKELETON_GEOMDEF_ST',
  'LOD','TREE_ST','PARTICLE_EFFECT','PARTICLE_GROUP','SKELETON_RIGID','TREE_PM'];
export const FPS = 30;

class Reader {
  constructor(buf, pos, end) { this.dv = new DataView(buf); this.u8 = new Uint8Array(buf); this.pos = pos; this.end = end; }
  byte() { return this.dv.getUint8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  skip(n) { this.pos += n; }
  get eof() { return this.pos >= this.end; }
  stringz() { let s = ''; while (this.pos < this.end) { const c = this.u8[this.pos++]; if (!c) break; s += String.fromCharCode(c); } return s; }
}

export function readChunks(buf, start, end) {
  const dv = new DataView(buf), list = [];
  let p = start;
  while (p + 8 <= end) {
    const raw = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > end) break;
    list.push({ id: raw & 0x7fffffff, comp: (raw & 0x80000000) !== 0, offset: p + 8, size });
    p += 8 + size;
  }
  return list;
}

function readHeader(buf, c) {
  const r = new Reader(buf, c.offset, c.offset + c.size);
  const version = r.byte(), type = r.byte(), shader = r.u16();
  const bmin = [r.f32(), r.f32(), r.f32()], bmax = [r.f32(), r.f32(), r.f32()];
  return { version, type, shader, bmin, bmax };
}

function parseGeometry(buf, vtx, idx, tex, nBones) {
  const dv = new DataView(buf);
  const fmt = dv.getUint32(vtx.offset, true), n = dv.getUint32(vtx.offset + 4, true), base = vtx.offset + 8;
  const stride = n ? Math.floor((vtx.size - 8) / n) : 0;
  if (![32, 60, 64, 70, 72, 76].includes(stride))
    throw new Error(`Неподдерживаемый формат вершин 0x${fmt.toString(16)} (stride ${stride})`);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const bone = new Float32Array(n * 4), wt = new Float32Array(n * 4);
  const f = (o) => dv.getFloat32(o, true), h = (o) => dv.getUint16(o, true);
  const cl = (b) => Math.min(b, Math.max(0, nBones - 1));
  for (let i = 0; i < n; i++) {
    const o = base + i * stride;
    let P, N, UV, bi = [0, 0, 0, 0], w = [1, 0, 0, 0];
    if (stride === 32) { P = o; N = o + 12; UV = o + 24; }
    else if (stride === 60) { P = o; N = o + 12; UV = o + 48; bi[0] = dv.getUint32(o + 56, true); }
    else if (stride === 64) { bi[0] = h(o); bi[1] = h(o + 2); P = o + 4; N = o + 16; UV = o + 56; const w1 = f(o + 52); w = [1 - w1, w1, 0, 0]; }
    else if (stride === 70 || stride === 72) { bi = [h(o), h(o + 2), h(o + 4), 0]; P = o + 6; N = o + 18; UV = o + 62; const a = f(o + 54), b = f(o + 58); w = [1 - a - b, a, b, 0]; }
    else { bi = [h(o), h(o + 2), h(o + 4), h(o + 6)]; P = o + 8; N = o + 20; UV = o + 68; const a = f(o + 56), b = f(o + 60), c = f(o + 64); w = [1 - a - b - c, a, b, c]; }
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = f(P + 4 * k); nor[i * 3 + k] = f(N + 4 * k); }
    uv[i * 2] = f(UV); uv[i * 2 + 1] = f(UV + 4);
    for (let k = 0; k < 4; k++) { bone[i * 4 + k] = cl(bi[k]); wt[i * 4 + k] = w[k]; }
  }
  const ic = dv.getUint32(idx.offset, true), indices = new Uint16Array(ic);
  for (let i = 0; i < ic; i++) indices[i] = dv.getUint16(idx.offset + 4 + i * 2, true);
  let texture = '', shader = '';
  if (tex) { const r = new Reader(buf, tex.offset, tex.offset + tex.size); texture = r.stringz(); shader = r.stringz(); }
  return { texture, shader, vertexCount: n, pos, nor, uv, bone, weight: wt, indices, skinned: stride !== 32, stride };
}

function collectMeshes(buf, chunks, out, nBones) {
  const find = (id) => chunks.find((c) => c.id === id);
  const vtx = find(OGF.VERTICES), idx = find(OGF.INDICES);
  if (vtx && idx) {
    if (vtx.comp || idx.comp) throw new Error('Сжатые (LZ) чанки геометрии не поддерживаются');
    out.push(parseGeometry(buf, vtx, idx, find(OGF.TEXTURE), nBones));
  }
  const ch = find(OGF.CHILDREN);
  if (ch) {
    if (ch.comp) throw new Error('Сжатый чанк CHILDREN не поддерживается');
    for (const s of readChunks(buf, ch.offset, ch.offset + ch.size))
      collectMeshes(buf, readChunks(buf, s.offset, s.offset + s.size), out, nBones);
  }
}

function parseBoneNames(buf, c) {
  const attempt = (withCount) => {
    const r = new Reader(buf, c.offset, c.offset + c.size);
    const count = withCount ? r.u32() : Infinity, out = [];
    while (!r.eof && out.length < count) { const name = r.stringz(), parentName = r.stringz(); r.skip(60); out.push({ name, parentName }); }
    if (r.pos !== r.end || (withCount && out.length !== count)) return null;
    return out;
  };
  const list = attempt(true) || attempt(false);
  if (!list) throw new Error('Не удалось разобрать S_BONE_NAMES');
  const map = new Map(list.map((b, i) => [b.name.toLowerCase(), i]));
  return list.map((b) => ({ name: b.name, parent: b.parentName ? (map.has(b.parentName.toLowerCase()) ? map.get(b.parentName.toLowerCase()) : -1) : -1, rot: [0, 0, 0], pos: [0, 0, 0] }));
}

function parseIK(buf, c, bones) {
  const attempt = (friction) => {
    const r = new Reader(buf, c.offset, c.offset + c.size), out = [];
    for (let i = 0; i < bones.length; i++) {
      if (r.pos + 4 > r.end) return null;
      r.u32(); r.stringz(); r.skip(112 + 4 + 48 + 8 + 12 + (friction ? 4 : 0));
      if (r.pos + 24 > r.end) return null;
      const rot = [r.f32(), r.f32(), r.f32()], pos = [r.f32(), r.f32(), r.f32()];
      r.skip(16);
      out.push({ rot, pos });
    }
    return r.pos === r.end ? out : null;
  };
  const res = attempt(true) || attempt(false);
  if (res) res.forEach((d, i) => { bones[i].rot = d.rot; bones[i].pos = d.pos; });
  return !!res;
}

// ---- Анимации ----
function readTracks(buf, start, end, frames, n) {
  const dv = new DataView(buf), tracks = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    if (p + 1 > end) return null;
    const flags = dv.getUint8(p++), t = {};
    if (flags & 2) {
      if (p + 8 > end) return null;
      t.rot = new Int16Array(4); for (let k = 0; k < 4; k++) t.rot[k] = dv.getInt16(p + 2 * k, true);
      p += 8;
    } else {
      if (p + 4 + frames * 8 > end) return null;
      p += 4; t.rot = new Int16Array(frames * 4);
      for (let k = 0; k < frames * 4; k++) t.rot[k] = dv.getInt16(p + 2 * k, true);
      p += frames * 8;
    }
    if (flags & 1) {
      const wide = (flags & 4) !== 0, bytes = frames * 3 * (wide ? 2 : 1);
      if (p + 4 + bytes + 24 > end) return null;
      p += 4;
      const raw = new Float32Array(frames * 3), kp = p;
      for (let k = 0; k < frames * 3; k++) raw[k] = wide ? dv.getInt16(kp + 2 * k, true) : dv.getInt8(kp + k);
      p += bytes;
      const sz = [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)];
      const ini = [dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true)];
      p += 24;
      for (let k = 0; k < frames * 3; k++) raw[k] = raw[k] * sz[k % 3] + ini[k % 3];
      t.trans = raw;
    } else {
      if (p + 12 > end) return null;
      t.trans = new Float32Array([dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]);
      p += 12;
      t.constT = true;
    }
    tracks.push(t);
  }
  return { tracks, p };
}

function parseMotion(buf, s, nBones) {
  const r = new Reader(buf, s.offset, s.offset + s.size);
  const name = r.stringz(), frames = r.u32(), start = r.pos, end = s.offset + s.size;
  if (!frames || frames > 100000) return null;
  let res = readTracks(buf, start, end, frames, nBones);
  if (!res || res.p !== end) {
    res = null;
    for (let n = 1; n <= 1024 && !res; n++) { const t = readTracks(buf, start, end, frames, n); if (t && t.p === end) res = t; }
    if (!res) res = readTracks(buf, start, end, frames, nBones);
  }
  if (!res) return null;
  return { name, frames, tracks: res.tracks, duration: frames / FPS };
}

function parseMotionsChunk(buf, c, nBones) {
  const out = [];
  for (const s of readChunks(buf, c.offset, c.offset + c.size)) {
    if (s.id === 0) continue;
    try { const m = parseMotion(buf, s, nBones); if (m) out.push(m); } catch (e) { /* пропускаем битую анимацию */ }
  }
  return out;
}

export function parseOMF(buf, nBones) {
  const c = readChunks(buf, 0, buf.byteLength).find((x) => x.id === OGF.S_MOTIONS);
  if (!c) throw new Error('В файле нет чанка анимаций (S_MOTIONS)');
  return parseMotionsChunk(buf, c, nBones);
}

export function parseOGF(buf) {
  const top = readChunks(buf, 0, buf.byteLength);
  const hc = top.find((c) => c.id === OGF.HEADER);
  if (!hc) throw new Error('Не OGF файл: нет заголовка');
  const hdr = readHeader(buf, hc);
  if (hdr.version !== 4) throw new Error(`Поддерживается только OGF версии 4 (в файле v${hdr.version})`);
  const find = (id) => top.find((c) => c.id === id);

  const bnc = find(OGF.S_BONE_NAMES);
  const bones = bnc ? parseBoneNames(buf, bnc) : [];
  const ikc = find(OGF.S_IKDATA);
  const ikOk = ikc && bones.length ? parseIK(buf, ikc, bones) : false;

  const meshes = [];
  collectMeshes(buf, top, meshes, bones.length);
  if (!meshes.length) throw new Error(`Геометрия не найдена (тип модели: ${TYPE_NAMES[hdr.type] || hdr.type})`);

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (const m of meshes) {
    tris += m.indices.length / 3;
    for (let i = 0; i < m.pos.length; i++) { const k = i % 3; if (m.pos[i] < min[k]) min[k] = m.pos[i]; if (m.pos[i] > max[k]) max[k] = m.pos[i]; }
  }

  const motions = find(OGF.S_MOTIONS) ? parseMotionsChunk(buf, find(OGF.S_MOTIONS), bones.length) : [];

  let refs = [];
  try {
    const c19 = find(OGF.S_MOTION_REFS0), c20 = find(OGF.S_MOTION_REFS1);
    if (c19) refs = new Reader(buf, c19.offset, c19.offset + c19.size).stringz().split(',').map((s) => s.trim()).filter(Boolean);
    else if (c20) { const r = new Reader(buf, c20.offset, c20.offset + c20.size); const k = r.u32(); for (let i = 0; i < k; i++) refs.push(r.stringz()); }
  } catch (e) {}

  let desc = null;
  try {
    const d = find(OGF.S_DESC);
    if (d) { const r = new Reader(buf, d.offset, d.offset + d.size); desc = { source: r.stringz(), tool: r.stringz() }; r.u32(); desc.owner = r.stringz(); }
  } catch (e) {}

  return { info: { type: TYPE_NAMES[hdr.type] || String(hdr.type), tris, ikOk, motionRefs: refs, desc },
    meshes, bones, motions, bounds: { min, max } };
}
