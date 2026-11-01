// NIF (NetImmerse/Gamebryo) 20.2.0.7: Fallout 3 / New Vegas, Skyrim LE, Skyrim SE. Статическая геометрия + иерархия узлов + текстуры.
// Каждый блок имеет размер в заголовке, поэтому разбор геометрии проверяется: он обязан закончиться ровно на границе блока.
import { half } from '../../core/binary';
import { computeNormals, emptyBounds, makeIndices, stripToTris, sumTris, sumVerts } from '../../core/geometry';
import { identity, mulCol } from '../../core/math';
import { skinnedBounds } from '../../core/geometry';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { Mesh, Model, Motion } from '../../core/types';
import { parseSequences } from './kf';

class R {
  readonly dv: DataView;
  readonly u8: Uint8Array;
  constructor(buf: ArrayBuffer, public pos: number, public end: number) { this.dv = new DataView(buf); this.u8 = new Uint8Array(buf); }
  b() { return this.dv.getUint8(this.pos++); }
  w() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  d() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  f() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  skip(n: number) { this.pos += n; }
  ascii(n: number) { let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(this.u8[this.pos + k]!); this.pos += n; return s; }
}

interface Block { type: string; start: number; end: number }
export interface NifHeader { version: string; bsver: number; userVersion: number; blocks: Block[]; strings: string[]; roots: number[] }
interface AV { name: string; flags: number; t: number[]; rot: number[]; scale: number; props: number[] }
interface Geom { nv: number; pos: Float32Array; nor: Float32Array | null; uv: Float32Array; tris: number[] }

export function parseHeader(buf: ArrayBuffer): NifHeader {
  const u8 = new Uint8Array(buf);
  let e = 0;
  while (e < 128 && e < u8.length && u8[e] !== 10) e++;
  let line = '';
  for (let k = 0; k < e; k++) line += String.fromCharCode(u8[k]!);
  const m = /(Gamebryo|NetImmerse).*Version\s+(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(line);
  if (!m) throw new Error('Не NIF файл');
  const vs = `${m[2]}.${m[3]}.${m[4]}.${m[5]}`;
  const version = (((+m[2]!) << 24) | ((+m[3]!) << 16) | ((+m[4]!) << 8) | +m[5]!) >>> 0;
  if (version !== 0x14020007) throw new Error(`NIF версии ${vs} пока не поддерживается (нужна 20.2.0.7: Fallout 3/NV, Skyrim, Skyrim SE). Oblivion/Morrowind — следующая часть.`);
  const r = new R(buf, e + 1, buf.byteLength);
  r.d();
  if (r.b() === 0) throw new Error('Big-endian NIF не поддерживается');
  const userVersion = r.d(), numBlocks = r.d();
  let bsver = 0;
  if (userVersion >= 3) {
    bsver = r.d();
    r.skip(r.b()); // автор
    if (bsver > 130) r.d();
    if (bsver < 131) r.skip(r.b()); // process script
    r.skip(r.b()); // export script
    if (bsver >= 103) r.skip(r.b()); // max filepath
  }
  const nTypes = r.w(), types: string[] = [];
  for (let k = 0; k < nTypes; k++) types.push(r.ascii(r.d()));
  const typeIdx: number[] = [];
  for (let k = 0; k < numBlocks; k++) typeIdx.push(r.w() & 0x7fff);
  const sizes: number[] = [];
  for (let k = 0; k < numBlocks; k++) sizes.push(r.d());
  const nStr = r.d();
  r.d();
  const strings: string[] = [];
  for (let k = 0; k < nStr; k++) strings.push(r.ascii(r.d()));
  r.skip(4 * r.d());
  const blocks: Block[] = [];
  let p = r.pos;
  for (let k = 0; k < numBlocks; k++) { blocks.push({ type: types[typeIdx[k]!]!, start: p, end: p + sizes[k]! }); p += sizes[k]!; }
  let roots: number[] = [];
  try { const f = new R(buf, p, buf.byteLength), n = f.d(); for (let k = 0; k < n; k++) roots.push(f.i()); } catch { /* без футера */ }
  if (!roots.length) roots = [0];
  return { version: vs, bsver, userVersion, blocks, strings, roots };
}

// ---------- блоки ----------
function readAV(r: R, h: NifHeader): AV {
  const nameIdx = r.d(), ne = r.d();
  r.skip(ne * 4);
  r.i();
  const flags = h.bsver <= 26 ? r.w() : r.d();
  const t = [r.f(), r.f(), r.f()], rot: number[] = [];
  for (let k = 0; k < 9; k++) rot.push(r.f());
  const scale = r.f(), props: number[] = [];
  if (h.bsver <= 34) { const n = r.d(); for (let k = 0; k < n; k++) props.push(r.i()); }
  r.i();
  return { name: nameIdx < h.strings.length ? h.strings[nameIdx]! : '', flags, t, rot, scale, props };
}
function parseNode(buf: ArrayBuffer, h: NifHeader, blk: Block) {
  const r = new R(buf, blk.start, blk.end), av = readAV(r, h), n = r.d(), kids: number[] = [];
  for (let k = 0; k < n; k++) kids.push(r.i());
  return { ...av, kids };
}
function parseShape(buf: ArrayBuffer, h: NifHeader, blk: Block) {
  const r = new R(buf, blk.start, blk.end), av = readAV(r, h);
  const data = r.i(), skin = r.i(), nm = r.d();
  r.skip(nm * 8 + 5);
  let shader = -1;
  if (h.bsver > 34) { shader = r.i(); r.i(); }
  return { ...av, data, skin, shader };
}

function geomVariant(buf: ArrayBuffer, blk: Block, strips: boolean, group: boolean, uvMode: number): Geom | null {
  try {
    const r = new R(buf, blk.start, blk.end);
    if (group) r.d();
    const nv = r.w();
    r.skip(2);
    if (!r.b() || nv === 0) return null;
    const pos = new Float32Array(nv * 3);
    for (let k = 0; k < nv * 3; k++) pos[k] = r.f();
    const flags = r.w(), hasN = r.b();
    let nor: Float32Array | null = null;
    if (hasN) { nor = new Float32Array(nv * 3); for (let k = 0; k < nv * 3; k++) nor[k] = r.f(); if (flags & 0x1000) r.skip(nv * 24); }
    r.skip(16);
    if (r.b()) r.skip(nv * 16);
    const nUV = uvMode === 0 ? flags & 0x3f : flags & 1;
    const uv = new Float32Array(nv * 2);
    for (let s = 0; s < nUV; s++) for (let k = 0; k < nv; k++) { const u = r.f(), v = r.f(); if (s === 0) { uv[k * 2] = u; uv[k * 2 + 1] = v; } }
    r.skip(2);
    r.i();
    let tris: number[] = [];
    if (!strips) {
      const nt = r.w(), np = r.d(), has = r.b();
      if (has) { if (np !== nt * 3) return null; for (let k = 0; k < np; k++) tris.push(r.w()); }
      const mg = r.w();
      for (let k = 0; k < mg; k++) r.skip(r.w() * 2);
    } else {
      r.w();
      const ns = r.w(), lens: number[] = [];
      for (let k = 0; k < ns; k++) lens.push(r.w());
      const has = r.b();
      if (has) for (const L of lens) { const pts: number[] = []; for (let k = 0; k < L; k++) pts.push(r.w()); tris = tris.concat(stripToTris(pts)); }
    }
    if (r.pos !== blk.end) return null;
    for (const t of tris) if (t >= nv) return null;
    return { nv, pos, nor, uv, tris };
  } catch { return null; }
}
function parseGeomData(buf: ArrayBuffer, blk: Block, strips: boolean): Geom | null {
  for (const group of [true, false]) for (const uvMode of [0, 1]) { const g = geomVariant(buf, blk, strips, group, uvMode); if (g) return g; }
  return null;
}

function parseBSTriShape(buf: ArrayBuffer, h: NifHeader, blk: Block) {
  const r = new R(buf, blk.start, blk.end), av = readAV(r, h);
  r.skip(16);
  if (h.bsver === 155) r.skip(24);
  const skin = r.i();
  const shader = r.i();
  r.i();
  const lo = r.d(), hi = r.d(), nt = h.bsver >= 130 ? r.d() : r.w(), nv = r.w(), size = r.d();
  if (!size || !nv) return { ...av, skin, shader, geom: null };
  const stride = (lo & 0xf) * 4, off = (a: number) => ((lo >>> (4 + 4 * a)) & 0xf) * 4, attrs = (hi >>> 12) & 0x7ff; // биты 44..54 u64
  const full = h.bsver === 100 || (attrs & 0x400) !== 0, hasUV = (attrs & 2) !== 0, hasN = (attrs & 8) !== 0;
  const dv = r.dv, base = r.pos, pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let k = 0; k < nv; k++) {
    const o = base + k * stride;
    for (let c = 0; c < 3; c++) pos[k * 3 + c] = full ? dv.getFloat32(o + c * 4, true) : half(dv.getUint16(o + c * 2, true));
    if (hasUV) { const q = o + off(1); uv[k * 2] = half(dv.getUint16(q, true)); uv[k * 2 + 1] = half(dv.getUint16(q + 2, true)); }
    if (hasN) { const q = o + off(3); for (let c = 0; c < 3; c++) nor[k * 3 + c] = (dv.getUint8(q + c) / 255) * 2 - 1; }
  }
  r.pos = base + nv * stride;
  const tris: number[] = [];
  for (let k = 0; k < nt * 3; k++) tris.push(r.w());
  return { ...av, skin, shader, geom: { nv, pos, nor: hasN ? nor : null, uv, tris } as Geom };
}

// ---------- скининг: NiSkinInstance / BSDismemberSkinInstance -> NiSkinData + NiSkinPartition ----------
/** NiTransform (поворот 3×3, перенос, масштаб) -> column-major матрица, как localMatrix. */
function readTransform(r: R): Float64Array {
  const rot: number[] = [];
  for (let k = 0; k < 9; k++) rot.push(r.f());
  const t = [r.f(), r.f(), r.f()], scale = r.f();
  return localMatrix({ t, rot, scale });
}
export interface NifSkin {
  /** Блоки-узлы костей (Ptr). */
  bones: number[];
  root: number;
  /** Общее смещение кожи (NiSkinData.Skin Transform). */
  overall: Float64Array;
  /** Смещение кожи от кости в bind-позе, по костям. */
  boneT: Float64Array[];
  /** Веса из NiSkinData: по костям список [вершина, вес] (пусто, если веса только в разбиении). */
  weights: Array<Array<[number, number]>>;
  partitions: SkinPart[];
  /** BSDismemberSkinInstance: часть тела каждого разбиения (100–299 — «мясные» заглушки расчленения). */
  bodyParts: number[];
}
interface SkinPart { nv: number; bones: number[]; map: number[] | null; weights: Float32Array | null; nw: number; tris: number[]; boneIdx: Uint8Array | null }

function parseSkinData(buf: ArrayBuffer, blk: Block) {
  const r = new R(buf, blk.start, blk.end), overall = readTransform(r), nb = r.d(), hasW = r.b();
  const boneT: Float64Array[] = [], weights: Array<Array<[number, number]>> = [];
  for (let b = 0; b < nb; b++) {
    boneT.push(readTransform(r));
    r.skip(16); // ограничивающая сфера
    const nv = r.w(), list: Array<[number, number]> = [];
    if (hasW) for (let k = 0; k < nv; k++) { const v = r.w(); list.push([v, r.f()]); }
    weights.push(list);
  }
  if (r.pos !== blk.end) throw new Error('NiSkinData: размер не сошёлся');
  return { overall, boneT, weights };
}

function partitionVariant(buf: ArrayBuffer, blk: Block, tail: number): SkinPart[] | null {
  try {
    const r = new R(buf, blk.start, blk.end), n = r.d(), out: SkinPart[] = [];
    for (let p = 0; p < n; p++) {
      const nv = r.w(), nt = r.w(), nb = r.w(), ns = r.w(), nw = r.w(), bones: number[] = [];
      for (let k = 0; k < nb; k++) bones.push(r.w());
      let map: number[] | null = null, weights: Float32Array | null = null, boneIdx: Uint8Array | null = null;
      if (r.b()) { map = []; for (let k = 0; k < nv; k++) map.push(r.w()); }
      if (r.b()) { weights = new Float32Array(nv * nw); for (let k = 0; k < nv * nw; k++) weights[k] = r.f(); }
      const lens: number[] = [];
      for (let k = 0; k < ns; k++) lens.push(r.w());
      let tris: number[] = [];
      if (r.b()) {
        if (ns) for (const L of lens) { const pts: number[] = []; for (let k = 0; k < L; k++) pts.push(r.w()); tris = tris.concat(stripToTris(pts)); }
        else for (let k = 0; k < nt * 3; k++) tris.push(r.w());
      }
      if (r.b()) { boneIdx = r.u8.slice(r.pos, r.pos + nv * nw); r.skip(nv * nw); }
      r.skip(tail);
      if (r.pos > blk.end) return null;
      out.push({ nv, bones, map, weights, nw, tris, boneIdx });
    }
    return r.pos === blk.end ? out : null;
  } catch { return null; }
}

export function parseSkin(buf: ArrayBuffer, h: NifHeader, idx: number): NifSkin {
  const blk = h.blocks[idx];
  if (!blk || !/SkinInstance$/.test(blk.type)) throw new Error('нет NiSkinInstance');
  const r = new R(buf, blk.start, blk.end), data = r.i(), part = r.i(), root = r.i(), nb = r.d(), bones: number[] = [];
  for (let k = 0; k < nb; k++) bones.push(r.i());
  const bodyParts: number[] = [];
  if (blk.type === 'BSDismemberSkinInstance') { const n = r.d(); for (let k = 0; k < n; k++) { r.w(); bodyParts.push(r.w()); } }
  const db = h.blocks[data];
  if (!db || db.type !== 'NiSkinData') throw new Error('нет NiSkinData');
  const sd = parseSkinData(buf, db);
  if (sd.boneT.length !== nb) throw new Error('число костей в NiSkinData и NiSkinInstance не совпадает');
  let partitions: SkinPart[] = [];
  const pb = h.blocks[part];
  // Skyrim (BS > 34) добавляет в конец каждого разбиения 2 байта; SSE хранит вершины в самом разбиении — не поддержано
  if (pb && pb.type === 'NiSkinPartition') partitions = partitionVariant(buf, pb, 0) ?? partitionVariant(buf, pb, 2) ?? [];
  return { bones, root, overall: sd.overall, boneT: sd.boneT, weights: sd.weights, partitions, bodyParts };
}

/** По 4 кости на вершину (индексы — номера костей скина), веса нормированы. */
function skinWeights(skin: NifSkin, nv: number): { bone: Uint16Array; weight: Float32Array } | null {
  const lists: Array<Array<[number, number]>> = Array.from({ length: nv }, () => []);
  let any = false;
  for (const p of skin.partitions) {
    if (!p.weights || !p.boneIdx) { any = false; break; }
    for (let v = 0; v < p.nv; v++) {
      const gv = p.map ? p.map[v]! : v;
      if (gv >= nv) continue;
      lists[gv] = [];
      for (let k = 0; k < p.nw; k++) { const w = p.weights[v * p.nw + k]!; if (w > 0) lists[gv]!.push([p.bones[p.boneIdx[v * p.nw + k]!]!, w]); }
      any = true;
    }
  }
  if (!any) {
    for (const l of lists) l.length = 0;
    skin.weights.forEach((list, b) => { for (const [v, w] of list) if (v < nv && w > 0) { lists[v]!.push([b, w]); any = true; } });
  }
  if (!any) return null;
  const bone = new Uint16Array(nv * 4), weight = new Float32Array(nv * 4);
  for (let v = 0; v < nv; v++) {
    const l = lists[v]!.sort((a, b) => b[1] - a[1]).slice(0, 4), s = l.reduce((a, x) => a + x[1], 0) || 1;
    l.forEach(([b, w], k) => { bone[v * 4 + k] = b; weight[v * 4 + k] = w / s; });
  }
  return { bone, weight };
}

function textureSets(buf: ArrayBuffer, h: NifHeader): Map<number, string[]> {
  const map = new Map<number, string[]>();
  h.blocks.forEach((b, i) => {
    if (b.type !== 'BSShaderTextureSet') return;
    try { const r = new R(buf, b.start, b.end), n = r.d(), list: string[] = []; for (let k = 0; k < n; k++) list.push(r.ascii(r.d())); map.set(i, list); } catch { /* пропуск */ }
  });
  return map;
}
function findTexture(buf: ArrayBuffer, h: NifHeader, sets: Map<number, string[]>, propIdx: number[]): string {
  const dv = new DataView(buf);
  for (const pi of propIdx) {
    const b = h.blocks[pi];
    if (!b) continue;
    for (const pass of [0, 1])
      for (let o = b.start; o + 4 <= b.end; o++) {
        if (((o - b.start) % 4 === 0) !== (pass === 0)) continue;
        const v = dv.getInt32(o, true);
        if (sets.has(v)) return sets.get(v)![0] ?? '';
      }
  }
  return '';
}

/** Части тела BSDismemberSkinInstance: 100–113/200–213 (FO3/NV) и 130–161/230–261 (Skyrim) — заглушки срезов. */
const isCap = (part: number | undefined) => part !== undefined && part >= 100 && part < 300;
const NODE_SKIP = /^(editormarker|markerx|collisiongeom)/i;
const SHAPES = new Set(['NiTriShape', 'NiTriStrips', 'BSLODTriShape', 'BSSegmentedTriShape']);
const BS_SHAPES = new Set(['BSTriShape', 'BSDynamicTriShape', 'BSMeshLODTriShape', 'BSSubIndexTriShape']);
export function localMatrix(av: Pick<AV, 't' | 'rot' | 'scale'>): Float64Array {
  const m = identity();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 4 + r] = av.rot[r * 3 + c]! * av.scale;
  m[12] = av.t[0]!; m[13] = av.t[1]!; m[14] = av.t[2]!;
  return m;
}

/** Узлы скелета из отдельного skeleton.nif (все NiNode по иерархии). */
export function nifNodes(buf: ArrayBuffer): SkeletonNode[] {
  const h = parseHeader(buf), out: SkeletonNode[] = [], seen = new Set<number>();
  const walk = (idx: number, parent: number) => {
    const blk = h.blocks[idx];
    if (!blk || seen.has(idx) || !/Node$/.test(blk.type)) return;
    seen.add(idx);
    try {
      const n = parseNode(buf, h, blk), ni = out.push({ name: n.name, parent, local: localMatrix(n), offset: null }) - 1;
      for (const k of n.kids) walk(k, ni);
    } catch { /* пропуск */ }
  };
  for (const r of h.roots) walk(r, -1);
  return out;
}

interface PendingSkin { mesh: Mesh; skin: NifSkin; local: Uint16Array }
const near = (a: ArrayLike<number>, b: ArrayLike<number>) => { for (let k = 0; k < 16; k++) if (Math.abs(a[k]! - b[k]!) > 1e-3 * Math.max(1, Math.abs(b[k]!))) return false; return true; };

export interface NifOptions {
  /** skeleton.nif персонажа/существа: кости модели заменяются узлами скелета по имени (нужно для анимаций .kf). */
  skeleton?: ArrayBuffer | null;
  skeletonName?: string;
}

/**
 * Скининг Gamebryo: вершина кожи задана в пространстве корня скелета; матрица кости = Мир(кость) · Skin Transform(кость) · Skin Transform(общий).
 * В bind-позе это произведение равно миру корня скелета, поэтому смещение (offset) кости — Skin(кость)·Skin(общий).
 */
export function convertNif(buf: ArrayBuffer, opts: NifOptions = {}): Model & { meta: { types: Record<string, number> } } {
  const h = parseHeader(buf), sets = textureSets(buf, h), nodes: SkeletonNode[] = [], meshes: Mesh[] = [], seen = new Set<number>(), notes = new Set<string>();
  const nodeOf = new Map<number, number>(), pending: PendingSkin[] = [];
  const makeMesh = (name: string, g: Geom, tex: string): Mesh => {
    const nv = g.nv, nor = g.nor ? Float32Array.from(g.nor) : computeNormals(g.pos, g.tris);
    if (g.nor) for (let k = 0; k < nv; k++) { const l = Math.hypot(nor[k * 3]!, nor[k * 3 + 1]!, nor[k * 3 + 2]!) || 1; nor[k * 3] /= l; nor[k * 3 + 1] /= l; nor[k * 3 + 2] /= l; }
    return { name, texture: tex, shader: '', vertexCount: nv, pos: g.pos, nor, uv: g.uv, bone: new Float32Array(nv * 4), weight: new Float32Array(nv * 4), indices: makeIndices(nv, g.tris), skinned: true };
  };
  const rigid = (m: Mesh, ni: number) => { for (let k = 0; k < m.vertexCount; k++) { m.bone[k * 4] = ni; m.weight[k * 4] = 1; } meshes.push(m); };
  const shapeNode = (name: string, parent: number, av: AV) => nodes.push({ name, parent, local: localMatrix(av), offset: null, helper: true }) - 1;
  const walk = (idx: number, parent: number, hidden: boolean) => {
    const blk = h.blocks[idx];
    if (!blk || seen.has(idx)) return;
    seen.add(idx);
    const t = blk.type;
    try {
      if (/Node$/.test(t)) {
        const n = parseNode(buf, h, blk);
        if (NODE_SKIP.test(n.name)) return;
        // скрытые узлы остаются в скелете (это могут быть кости), но их меши не показываются
        const ni = nodes.push({ name: n.name, parent, local: localMatrix(n), offset: null }) - 1;
        nodeOf.set(idx, ni);
        const kids = t === 'NiSwitchNode' || t === 'NiLODNode' ? n.kids.slice(0, 1) : n.kids;
        for (const k of kids) walk(k, ni, hidden || !!(n.flags & 1));
      } else if (SHAPES.has(t)) {
        const s = parseShape(buf, h, blk);
        if (hidden || s.flags & 1 || NODE_SKIP.test(s.name) || s.data < 0) return;
        const db = h.blocks[s.data];
        const g = db ? parseGeomData(buf, db, t === 'NiTriStrips') : null;
        if (!g) { notes.add(`блок ${t} #${idx}: геометрия не разобрана`); return; }
        const tex = findTexture(buf, h, sets, h.bsver > 34 ? [s.shader] : s.props);
        let skin: NifSkin | null = null;
        if (s.skin >= 0) try { skin = parseSkin(buf, h, s.skin); } catch (e) { notes.add(`${s.name || t}: скин не разобран (${(e as Error).message})`); }
        if (skin) {
          // заглушки расчленения (мясо на срезах) в целом теле не видны: их треугольники убираем
          const cap = skin.partitions.map((_, k) => isCap(skin!.bodyParts[k]));
          if (cap.some(Boolean) && skin.partitions.every((p) => p.tris.length)) g.tris = [];
          if (!g.tris.length) skin.partitions.forEach((p, k) => { if (!cap[k]) for (const v of p.tris) g.tris.push(p.map ? p.map[v]! : v); });
          if (!g.tris.length && cap.some(Boolean)) return;
        }
        if (!g.tris.length) { notes.add(`${s.name || t}: нет треугольников`); return; }
        const sw = skin ? skinWeights(skin, g.nv) : null;
        const ni = shapeNode(s.name, parent, s);
        if (skin && sw) pending.push({ mesh: makeMesh(s.name || t, g, tex), skin, local: sw.bone }), pending[pending.length - 1]!.mesh.weight.set(sw.weight);
        else rigid(makeMesh(s.name || t, g, tex), ni);
      } else if (BS_SHAPES.has(t)) {
        const s = parseBSTriShape(buf, h, blk);
        if (hidden || s.flags & 1 || NODE_SKIP.test(s.name)) return;
        if (!s.geom) { if (s.skin >= 0) notes.add(`${s.name || t}: вершины в NiSkinPartition (Skyrim SE) — пока не поддержано`); return; }
        rigid(makeMesh(s.name || t, s.geom, findTexture(buf, h, sets, [s.shader])), shapeNode(s.name, parent, s));
      }
    } catch (e) { notes.add(`блок ${t} #${idx}: ${(e as Error).message}`); }
  };
  for (const r of h.roots) walk(r, -1, false);

  // скелет: узлы skeleton.nif + узлы модели, которых в нём нет (по имени)
  let all = nodes, remap = nodes.map((_, i) => i), skelInfo = '';
  if (opts.skeleton && pending.length) {
    try {
      const sk = nifNodes(opts.skeleton), byName = new Map<string, number>();
      sk.forEach((n, i) => { if (n.name && !byName.has(n.name.toLowerCase())) byName.set(n.name.toLowerCase(), i); });
      all = sk.slice();
      remap = [];
      let matched = 0;
      nodes.forEach((n, i) => {
        const hit = !n.helper && n.name ? byName.get(n.name.toLowerCase()) : undefined;
        if (hit !== undefined) { remap.push(hit); matched++; return; }
        remap.push(all.push({ ...n, parent: n.parent >= 0 ? remap[n.parent]! : -1 }) - 1);
      });
      skelInfo = `Скелет: ${opts.skeletonName ?? 'skeleton.nif'} (${sk.length} узлов, совпало с моделью ${matched})`;
    } catch (e) { notes.add(`skeleton.nif: ${(e as Error).message}`); all = nodes; remap = nodes.map((_, i) => i); }
  }
  for (const m of meshes) for (let k = 0; k < m.vertexCount; k++) m.bone[k * 4] = remap[m.bone[k * 4]!]!;

  // кости скина: offset = Skin(кость)·Skin(общий); разные смещения у одной кости — служебный дочерний узел
  let skinned = 0;
  for (const p of pending) {
    const idx = p.skin.bones.map((bi, k) => {
      let ni = nodeOf.get(bi);
      if (ni === undefined) { notes.add(`кость #${bi} вне иерархии`); ni = 0; }
      const fin = remap[ni]!, off = mulCol(p.skin.boneT[k]!, p.skin.overall), nd = all[fin]!;
      if (!nd.offset) { nd.offset = off; return fin; }
      if (near(nd.offset, off)) return fin;
      return all.push({ name: `${nd.name} (bind)`, parent: fin, local: off, offset: null, helper: true }) - 1;
    });
    const m = p.mesh;
    for (let k = 0; k < m.vertexCount * 4; k++) m.bone[k] = idx[p.local[k]!] ?? 0;
    meshes.push(m);
    skinned++;
  }
  if (!meshes.length) throw new Error('В NIF не найдено поддерживаемой геометрии' + (notes.size ? ' (' + [...notes].join('; ') + ')' : ''));
  const sk = new NodeSkeleton(all);
  sk.pose(null, 0, false);
  const byName = nodeIndexByName(all);
  const motions: Motion[] = parseSequences(buf, byName, 'model');
  const types: Record<string, number> = {};
  h.blocks.forEach((b) => { types[b.type] = (types[b.type] ?? 0) + 1; });
  const info = [`NIF ${h.version}, BS version ${h.bsver}, блоков: ${h.blocks.length}`, `Мешей: ${meshes.length} (со скином ${skinned}), вершин: ${sumVerts(meshes)}, треугольников: ${sumTris(meshes)}`];
  if (skelInfo) info.push(skelInfo);
  else if (skinned) info.push('skeleton.nif не найден — анимации .kf применяются к костям самой модели.');
  if (notes.size) info.push('Замечания:', ...[...notes].slice(0, 8).map((n) => ' • ' + n));
  return {
    meshes, skeleton: sk, motions, bounds: skinnedBounds(sk, meshes), flipZ: false, defaultZUp: true, cameraYaw: Math.PI, info, meta: { types },
    loadMotions: async (file) => {
      const list = parseSequences(await file.arrayBuffer(), byName, file.name);
      if (!list.length) throw new Error(`${file.name}: в файле нет NiControllerSequence с костями этой модели`);
      return list;
    },
  };
}

function nodeIndexByName(nodes: SkeletonNode[]): Map<string, number> {
  const m = new Map<string, number>();
  nodes.forEach((n, i) => { if (n.name && !n.helper && !m.has(n.name.toLowerCase())) m.set(n.name.toLowerCase(), i); });
  return m;
}

/** Есть ли в файле скинованная геометрия (NiSkinInstance / BSDismemberSkinInstance). */
export function hasSkin(buf: ArrayBuffer): boolean {
  try { return parseHeader(buf).blocks.some((b) => /SkinInstance$/.test(b.type)); } catch { return false; }
}
