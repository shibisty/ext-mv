// Парсер X-Ray OGF (v4) и OMF. Без внешних зависимостей.
import type { Bounds, XrayMotion, XrayTrack } from '../../core/types';

export const OGF = {
  HEADER: 1, TEXTURE: 2, VERTICES: 3, INDICES: 4, CHILDREN: 9, S_BONE_NAMES: 13, S_MOTIONS: 14,
  S_SMPARAMS: 15, S_IKDATA: 16, S_USERDATA: 17, S_DESC: 18, S_MOTION_REFS0: 19, S_MOTION_REFS1: 20,
} as const;
const TYPE_NAMES = ['NORMAL', 'HIERRARHY', 'PROGRESSIVE', 'SKELETON_ANIM', 'SKELETON_GEOMDEF_PM', 'SKELETON_GEOMDEF_ST',
  'LOD', 'TREE_ST', 'PARTICLE_EFFECT', 'PARTICLE_GROUP', 'SKELETON_RIGID', 'TREE_PM'];
export const FPS = 30;

export interface OgfChunk { id: number; comp: boolean; offset: number; size: number }
export interface OgfBone { name: string; parent: number; rot: number[]; pos: number[] }
export interface OgfMesh {
  texture: string; shader: string; vertexCount: number;
  pos: Float32Array; nor: Float32Array; uv: Float32Array; bone: Float32Array; weight: Float32Array;
  indices: Uint16Array; skinned: boolean; stride: number; name?: string;
}
export interface OgfModel {
  info: { type: string; tris: number; ikOk: boolean; motionRefs: string[]; desc: { source: string; tool: string; owner?: string } | null };
  meshes: OgfMesh[]; bones: OgfBone[]; motions: XrayMotion[]; bounds: Bounds;
}

class Reader {
  readonly dv: DataView;
  readonly u8: Uint8Array;
  constructor(buf: ArrayBuffer, public pos: number, public end: number) { this.dv = new DataView(buf); this.u8 = new Uint8Array(buf); }
  byte() { return this.dv.getUint8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  skip(n: number) { this.pos += n; }
  get eof() { return this.pos >= this.end; }
  stringz() { let s = ''; while (this.pos < this.end) { const c = this.u8[this.pos++]!; if (!c) break; s += String.fromCharCode(c); } return s; }
}

export function readChunks(buf: ArrayBuffer, start: number, end: number): OgfChunk[] {
  const dv = new DataView(buf), list: OgfChunk[] = [];
  let p = start;
  while (p + 8 <= end) {
    const raw = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > end) break;
    list.push({ id: raw & 0x7fffffff, comp: (raw & 0x80000000) !== 0, offset: p + 8, size });
    p += 8 + size;
  }
  return list;
}

function readHeader(buf: ArrayBuffer, c: OgfChunk) {
  const r = new Reader(buf, c.offset, c.offset + c.size);
  const version = r.byte(), type = r.byte(), shader = r.u16();
  const bmin = [r.f32(), r.f32(), r.f32()], bmax = [r.f32(), r.f32(), r.f32()];
  return { version, type, shader, bmin, bmax };
}

function parseGeometry(buf: ArrayBuffer, vtx: OgfChunk, idx: OgfChunk, tex: OgfChunk | undefined, nBones: number): OgfMesh {
  const dv = new DataView(buf);
  const fmt = dv.getUint32(vtx.offset, true), n = dv.getUint32(vtx.offset + 4, true), base = vtx.offset + 8;
  const stride = n ? Math.floor((vtx.size - 8) / n) : 0;
  if (![32, 60, 64, 70, 72, 76].includes(stride)) throw new Error(`Неподдерживаемый формат вершин 0x${fmt.toString(16)} (stride ${stride})`);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const bone = new Float32Array(n * 4), wt = new Float32Array(n * 4);
  const f = (o: number) => dv.getFloat32(o, true), h = (o: number) => dv.getUint16(o, true);
  const cl = (b: number) => Math.min(b, Math.max(0, nBones - 1));
  for (let i = 0; i < n; i++) {
    const o = base + i * stride;
    let P: number, N: number, UV: number, bi = [0, 0, 0, 0], w = [1, 0, 0, 0];
    if (stride === 32) { P = o; N = o + 12; UV = o + 24; }
    else if (stride === 60) { P = o; N = o + 12; UV = o + 48; bi[0] = dv.getUint32(o + 56, true); }
    else if (stride === 64) { bi[0] = h(o); bi[1] = h(o + 2); P = o + 4; N = o + 16; UV = o + 56; const w1 = f(o + 52); w = [1 - w1, w1, 0, 0]; }
    // 3L/4L (ЧН/ЗП): в файле веса первых костей, вес последней — остаток (как в Vertices3W/4W движка)
    else if (stride === 70 || stride === 72) { bi = [h(o), h(o + 2), h(o + 4), 0]; P = o + 6; N = o + 18; UV = o + 62; const a = f(o + 54), b = f(o + 58); w = [a, b, 1 - a - b, 0]; }
    else { bi = [h(o), h(o + 2), h(o + 4), h(o + 6)]; P = o + 8; N = o + 20; UV = o + 68; const a = f(o + 56), b = f(o + 60), c = f(o + 64); w = [a, b, c, 1 - a - b - c]; }
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = f(P + 4 * k); nor[i * 3 + k] = f(N + 4 * k); }
    uv[i * 2] = f(UV); uv[i * 2 + 1] = f(UV + 4);
    for (let k = 0; k < 4; k++) { bone[i * 4 + k] = cl(bi[k]!); wt[i * 4 + k] = w[k]!; }
  }
  const ic = dv.getUint32(idx.offset, true), indices = new Uint16Array(ic);
  for (let i = 0; i < ic; i++) indices[i] = dv.getUint16(idx.offset + 4 + i * 2, true);
  let texture = '', shader = '';
  if (tex) { const r = new Reader(buf, tex.offset, tex.offset + tex.size); texture = r.stringz(); shader = r.stringz(); }
  return { texture, shader, vertexCount: n, pos, nor, uv, bone, weight: wt, indices, skinned: stride !== 32, stride };
}

function collectMeshes(buf: ArrayBuffer, chunks: OgfChunk[], out: OgfMesh[], nBones: number): void {
  const find = (id: number) => chunks.find((c) => c.id === id);
  const vtx = find(OGF.VERTICES), idx = find(OGF.INDICES);
  if (vtx && idx) {
    if (vtx.comp || idx.comp) throw new Error('Сжатые (LZ) чанки геометрии не поддерживаются');
    out.push(parseGeometry(buf, vtx, idx, find(OGF.TEXTURE), nBones));
  }
  const ch = find(OGF.CHILDREN);
  if (ch) {
    if (ch.comp) throw new Error('Сжатый чанк CHILDREN не поддерживается');
    for (const s of readChunks(buf, ch.offset, ch.offset + ch.size)) collectMeshes(buf, readChunks(buf, s.offset, s.offset + s.size), out, nBones);
  }
}

function parseBoneNames(buf: ArrayBuffer, c: OgfChunk): OgfBone[] {
  const attempt = (withCount: boolean) => {
    const r = new Reader(buf, c.offset, c.offset + c.size);
    const count = withCount ? r.u32() : Infinity, out: Array<{ name: string; parentName: string }> = [];
    while (!r.eof && out.length < count) { const name = r.stringz(), parentName = r.stringz(); r.skip(60); out.push({ name, parentName }); }
    if (r.pos !== r.end || (withCount && out.length !== count)) return null;
    return out;
  };
  const list = attempt(true) ?? attempt(false);
  if (!list) throw new Error('Не удалось разобрать S_BONE_NAMES');
  const map = new Map(list.map((b, i) => [b.name.toLowerCase(), i]));
  return list.map((b) => ({ name: b.name, parent: b.parentName ? map.get(b.parentName.toLowerCase()) ?? -1 : -1, rot: [0, 0, 0], pos: [0, 0, 0] }));
}

function parseIK(buf: ArrayBuffer, c: OgfChunk, bones: OgfBone[]): boolean {
  const attempt = (friction: boolean) => {
    const r = new Reader(buf, c.offset, c.offset + c.size), out: Array<{ rot: number[]; pos: number[] }> = [];
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
  const res = attempt(true) ?? attempt(false);
  if (res) res.forEach((d, i) => { bones[i]!.rot = d.rot; bones[i]!.pos = d.pos; });
  return !!res;
}

// ---- Анимации ----
function readTracks(buf: ArrayBuffer, start: number, end: number, frames: number, n: number): { tracks: XrayTrack[]; p: number } | null {
  const dv = new DataView(buf), tracks: XrayTrack[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    if (p + 1 > end) return null;
    const flags = dv.getUint8(p++);
    let rot: Int16Array, trans: Float32Array, constT = false;
    if (flags & 2) {
      if (p + 8 > end) return null;
      rot = new Int16Array(4);
      for (let k = 0; k < 4; k++) rot[k] = dv.getInt16(p + 2 * k, true);
      p += 8;
    } else {
      if (p + 4 + frames * 8 > end) return null;
      p += 4;
      rot = new Int16Array(frames * 4);
      for (let k = 0; k < frames * 4; k++) rot[k] = dv.getInt16(p + 2 * k, true);
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
      for (let k = 0; k < frames * 3; k++) raw[k] = raw[k]! * sz[k % 3]! + ini[k % 3]!;
      trans = raw;
    } else {
      if (p + 12 > end) return null;
      trans = new Float32Array([dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]);
      p += 12;
      constT = true;
    }
    tracks.push({ rot, trans, constT });
  }
  return { tracks, p };
}

/** Описание анимации из S_SMPARAMS: флаги (esmFX = 1 — «эффект» на одну кость), часть тела или кость, номер анимации. */
export interface XrayMotionDef { name: string; flags: number; boneOrPart: number; motion: number; speed: number }
export interface XraySMParams { version: number; trackBones: string[]; parts: Array<{ name: string; bones: string[] }>; defs: XrayMotionDef[] }

/**
 * S_SMPARAMS: части тела, порядок треков и описания анимаций. Треки в S_MOTIONS идут по номеру m_idx,
 * а кость определяется по имени (как в motions_value::load движка), поэтому порядок костей модели и анимации может различаться.
 * Анимация части (ноги, торс, голова) управляет только костями своей части — остальные треки в файле не значимы.
 */
export function parseSMParams(buf: ArrayBuffer, c: OgfChunk): XraySMParams | null {
  try {
    const r = new Reader(buf, c.offset, c.offset + c.size), version = r.u16(), nParts = r.u16(), trackBones: string[] = [], parts: XraySMParams['parts'] = [];
    for (let p = 0; p < nParts; p++) {
      const part = { name: r.stringz(), bones: [] as string[] }, nb = r.u16();
      for (let b = 0; b < nb; b++) { const name = r.stringz(), idx = version === 1 ? trackBones.length : r.u32(); trackBones[idx] = name; part.bones.push(name); }
      parts.push(part);
    }
    if (r.pos > r.end) return null;
    const defs: XrayMotionDef[] = [];
    try {
      const n = r.u16();
      for (let k = 0; k < n && r.pos < r.end; k++) {
        const name = r.stringz(), flags = r.u32(), boneOrPart = r.u16(), motion = r.u16(), speed = r.f32();
        r.skip(12); // power, accrue, falloff
        if (version >= 4) { const nm = r.u32(); for (let i = 0; i < nm; i++) { while (r.pos < r.end && r.byte() !== 10); r.skip(8 * r.u32()); } } // метки: имя до «\r\n», интервалы
        defs.push({ name, flags, boneOrPart, motion, speed });
      }
      if (r.pos > r.end) defs.length = 0;
    } catch { defs.length = 0; /* описания анимаций необязательны */ }
    return { version, trackBones, parts, defs };
  } catch { return null; }
}

function parseMotion(buf: ArrayBuffer, s: OgfChunk, nTracks: number): XrayMotion | null {
  const r = new Reader(buf, s.offset, s.offset + s.size);
  const name = r.stringz(), frames = r.u32(), start = r.pos, end = s.offset + s.size;
  if (!frames || frames > 100000) return null;
  let res = readTracks(buf, start, end, frames, nTracks);
  if (!res || res.p !== end) {
    res = null;
    for (let n = 1; n <= 1024 && !res; n++) { const t = readTracks(buf, start, end, frames, n); if (t && t.p === end) res = t; }
    if (!res) res = readTracks(buf, start, end, frames, nTracks);
  }
  if (!res) return null;
  return { kind: 'xray', name, frames, tracks: res.tracks, duration: frames / FPS };
}

/** Анимации чанка S_MOTIONS; треки раскладываются по костям модели по именам из S_SMPARAMS (если есть). */
function parseMotionsChunk(buf: ArrayBuffer, c: OgfChunk, bones: readonly OgfBone[], params: XraySMParams | null): XrayMotion[] {
  const out: XrayMotion[] = [];
  const byName = new Map(bones.map((b, i) => [b.name.toLowerCase(), i]));
  const idx = (n: string | undefined) => byName.get((n ?? '').toLowerCase()) ?? -1;
  const map = params?.trackBones.length ? params.trackBones.map(idx) : null;
  const nTracks = map ? map.length : bones.length;
  const partBones = params?.parts.map((p) => new Set(p.bones.map(idx))) ?? [];
  const defOf = new Map(params?.defs.map((d) => [d.motion, d]) ?? []);
  for (const s of readChunks(buf, c.offset, c.offset + c.size)) {
    if (s.id === 0) continue;
    try {
      const m = parseMotion(buf, s, nTracks);
      if (!m) continue;
      if (map) { const t: XrayTrack[] = []; map.forEach((bi, k) => { if (bi >= 0 && m.tracks[k]) t[bi] = m.tracks[k]!; }); m.tracks = t; }
      // анимация одной части тела: остальные кости остаются в bind-позе (в игре их ведёт другая анимация)
      const def = defOf.get(s.id - 1);
      if (def) {
        const fx = (def.flags & 1) !== 0, only = fx ? new Set([def.boneOrPart]) : partBones[def.boneOrPart];
        if (only && only.size && (fx || partBones.length > 1)) {
          const t: XrayTrack[] = [];
          for (const bi of only) if (m.tracks[bi]) t[bi] = m.tracks[bi]!;
          m.tracks = t;
          m.part = fx ? 'эффект' : params!.parts[def.boneOrPart]!.name;
        }
      }
      out.push(m);
    } catch { /* пропускаем битую анимацию */ }
  }
  return out;
}

/** Внешние анимации .omf для модели с костями bones (сопоставление треков по именам костей). */
export function parseOMF(buf: ArrayBuffer, bones: readonly OgfBone[]): XrayMotion[] {
  const top = readChunks(buf, 0, buf.byteLength), c = top.find((x) => x.id === OGF.S_MOTIONS);
  if (!c) throw new Error('В файле нет чанка анимаций (S_MOTIONS)');
  const pc = top.find((x) => x.id === OGF.S_SMPARAMS);
  return parseMotionsChunk(buf, c, bones, pc ? parseSMParams(buf, pc) : null);
}

export function parseOGF(buf: ArrayBuffer): OgfModel {
  const top = readChunks(buf, 0, buf.byteLength);
  const hc = top.find((c) => c.id === OGF.HEADER);
  if (!hc) throw new Error('Не OGF файл: нет заголовка');
  const hdr = readHeader(buf, hc);
  if (hdr.version !== 4) throw new Error(`Поддерживается только OGF версии 4 (в файле v${hdr.version})`);
  const find = (id: number) => top.find((c) => c.id === id);

  const bnc = find(OGF.S_BONE_NAMES);
  const bones = bnc ? parseBoneNames(buf, bnc) : [];
  const ikc = find(OGF.S_IKDATA);
  const ikOk = ikc && bones.length ? parseIK(buf, ikc, bones) : false;

  const meshes: OgfMesh[] = [];
  collectMeshes(buf, top, meshes, bones.length);
  if (!meshes.length) throw new Error(`Геометрия не найдена (тип модели: ${TYPE_NAMES[hdr.type] ?? hdr.type})`);

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (const m of meshes) {
    tris += m.indices.length / 3;
    for (let i = 0; i < m.pos.length; i++) { const k = i % 3; if (m.pos[i]! < min[k]!) min[k] = m.pos[i]!; if (m.pos[i]! > max[k]!) max[k] = m.pos[i]!; }
  }

  const mc = find(OGF.S_MOTIONS);
  const pc = find(OGF.S_SMPARAMS);
  const motions = mc ? parseMotionsChunk(buf, mc, bones, pc ? parseSMParams(buf, pc) : null) : [];

  let refs: string[] = [];
  try {
    const c19 = find(OGF.S_MOTION_REFS0), c20 = find(OGF.S_MOTION_REFS1);
    if (c19) refs = new Reader(buf, c19.offset, c19.offset + c19.size).stringz().split(',').map((s) => s.trim()).filter(Boolean);
    else if (c20) { const r = new Reader(buf, c20.offset, c20.offset + c20.size); const k = r.u32(); for (let i = 0; i < k; i++) refs.push(r.stringz()); }
  } catch { /* необязательный чанк */ }

  let desc: OgfModel['info']['desc'] = null;
  try {
    const d = find(OGF.S_DESC);
    if (d) { const r = new Reader(buf, d.offset, d.offset + d.size); desc = { source: r.stringz(), tool: r.stringz() }; r.u32(); desc.owner = r.stringz(); }
  } catch { /* необязательный чанк */ }

  return { info: { type: TYPE_NAMES[hdr.type] ?? String(hdr.type), tris, ikOk, motionRefs: refs, desc }, meshes, bones, motions, bounds: { min, max } };
}
