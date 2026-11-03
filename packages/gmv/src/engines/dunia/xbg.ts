// Модели Dunia (Far Cry 2): .xbg (геометрия) и .xbm (материал) — один контейнер «HSEM» (MESH):
//   u32 «MESH», u16 версия 0x2a, u16, u32 хеш, …, u32 [0x1c] число корневых чанков; чанк — u32 тег (байты наоборот),
//   u32 1, u32 полный размер, u32 размер своих данных, u32 число детей; дети идут перед своими данными.
// Чанки .xbg:
//   RMTL — материалы: u32 n, u32 0, n × (u32 длина, путь .xbm, 0);
//   NODE — узлы: u32 n, u32 0, n × (i32 первый ребёнок, i32 следующий, i32 родитель, кватернион xyzw, позиция, масштаб,
//          i32, f32, f32, u32 длина, имя, 0, u32 хеш);
//   SKID — части: u32 n, n × (u32 хеш, u16 LOD, u16 узел);  SKND — части: u32 n, n × (f32 дистанция, сфера f32×4,
//          рамка f32×6, u32 LOD, u32, u32 длина, имя «…_LOD0», 0), детский CLUS — по части: u32 k, k × кластер
//          (u16 материал, u16 треугольников ×2, u16 индексов, u16 шаг, u16 вершин, u16 формат, u16×48 — узлы для костей вершин);
//   LODS — геометрия: u32 число LOD, на LOD: f32 дистанция, u32 буферов, буферы (u32 формат, u32 шаг, u32 вершин,
//          u32 смещение в данных вершин LOD), u32 число примитивов, примитивы по 7×u32 (буфер, часть, кластер в части,
//          первый индекс, последняя вершина в буфере, смещение первой вершины в байтах, 0), u32 байт вершин +
//          выравнивание до 16 (по файлу), вершины всех буферов, u32 индексов + выравнивание, u16 индексы (от начала буфера);
//   PCMP / UCMP — распаковка позиций / UV: f32 сдвиг, f32 множитель (значение = s16 · множитель + сдвиг).
// Вершина 16 байт (0x008a, трава): позиция, UV, цвет — нормали считаются по треугольникам.
// Вершина 32 байта (формат 0x0bca): позиция s16×3 + s16 (1), UV s16×2, UV2 s16×2, нормаль u8×4 (BGRA), цвет u8×4,
//   касательная, бинормаль. 40 байт (0x0bda, скин): позиция, UV, UV2, веса u8×4, кости u8×4 (номер в таблице кластера),
//   нормаль, цвет, касательная, бинормаль. Треугольники — по часовой (D3D): при чтении меняем порядок.
// Материал .xbm: тот же контейнер, чанк DMTL: 5 байт, u32+имя, u32+шейдер, u32 n, n × (u32+путь .xbt, u32+слот), числа.
//   Слоты цвета по шейдерам: Generic/Weapon/Vehicle/Hair/Leaf — DiffuseTexture1, Skin — SkinTexture, Cloth — FabricTexture.
// Система координат — Z вверх, метры.
import { boundsOf, computeNormals, skinnedBounds } from '../../core/geometry';
import { compose, mulCol, rigidInv } from '../../core/math';
import type { LoadContext } from '../../core/plugin';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { Archive, Mesh, Model, NodeMotion, VFile } from '../../core/types';
import { buildMabMotion, matQuat, parseMab, parseSkeleton, type DuniaSkelBone } from './mab';

interface Chunk { tag: string; at: number; size: number; data: number; dsize: number; kids: Chunk[] }

export function readChunks(u: Uint8Array): Chunk[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 0x20 || dv.getUint32(0, true) !== 0x4d455348) throw new Error('Не модель Dunia (нет «MESH»)');
  const walk = (p: number, end: number, depth: number): Chunk[] => {
    const out: Chunk[] = [];
    while (p + 20 <= end) {
      const tag = String.fromCharCode(u[p + 3]!, u[p + 2]!, u[p + 1]!, u[p]!), size = dv.getUint32(p + 8, true), dsize = dv.getUint32(p + 12, true), nk = dv.getUint32(p + 16, true);
      if (size < 20 || p + size > end || dsize > size - 20 || depth > 8) throw new Error(`XBG: чанк ${tag} повреждён`);
      const data = p + size - dsize;
      out.push({ tag, at: p, size, data, dsize, kids: nk ? walk(p + 20, data, depth + 1) : [] });
      p += size;
    }
    return out;
  };
  return walk(0x20, u.length, 0);
}

class R {
  readonly dv: DataView;
  constructor(readonly u: Uint8Array, public p: number) { this.dv = new DataView(u.buffer, u.byteOffset, u.byteLength); }
  u8() { return this.u[this.p++]!; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  str() {
    const n = this.u32();
    if (n > 4096 || this.p + n > this.u.length) throw new Error(`Dunia: строка длиной ${n} на ${this.p - 4}`);
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u[this.p + i]!); this.p += n + 1; return s;
  }
  align16() { this.p = (this.p + 15) & ~15; }
}

export interface XbgNode { name: string; parent: number; rot: number[]; pos: number[]; scale: number[] }
export interface XbgCluster { mat: number; tris: number; palette: number[] }
export interface XbgPrim { buffer: number; part: number; cluster: number; firstIndex: number; lastVertex: number; firstVertex: number }
/** Вершинный буфер LOD: формат, шаг, число вершин, смещение в общих данных вершин LOD. */
export interface XbgBuffer { format: number; stride: number; vcount: number; base: number }
export interface XbgLod { dist: number; buffers: XbgBuffer[]; prims: XbgPrim[]; vAt: number; iAt: number; icount: number }
export interface Xbg {
  materials: string[]; nodes: XbgNode[]; parts: Array<{ name: string; lod: number; node: number }>; clusters: XbgCluster[][];
  lods: XbgLod[]; pcmp: [number, number]; ucmp: [number, number]; u: Uint8Array;
  /** Кости анимации (O2BM): обратные bind-матрицы (column-major) по порядку костей. */
  o2bm: Float64Array[];
}

export function parseXbg(u: Uint8Array): Xbg {
  const chunks = readChunks(u);
  const find = (t: string, list = chunks): Chunk | undefined => { for (const c of list) { if (c.tag === t) return c; const k = find(t, c.kids); if (k) return k; } return undefined; };
  const x: Xbg = { materials: [], nodes: [], parts: [], clusters: [], lods: [], pcmp: [0, 1 / 32768], ucmp: [0, 1 / 32768], u, o2bm: [] };
  const rm = find('RMTL');
  if (rm) { const r = new R(u, rm.data), n = r.u32(); r.u32(); for (let i = 0; i < n; i++) x.materials.push(r.str()); }
  const nd = find('NODE');
  if (nd) {
    const r = new R(u, nd.data), n = r.u32(); r.u32();
    for (let i = 0; i < n; i++) {
      r.i32(); r.i32(); const parent = r.i32();
      const q = [r.f32(), r.f32(), r.f32(), r.f32()], pos = [r.f32(), r.f32(), r.f32()], scale = [r.f32(), r.f32(), r.f32()];
      r.i32(); r.f32(); r.f32();
      const name = r.str(); r.u32();
      x.nodes.push({ name, parent, rot: [q[3]!, q[0]!, q[1]!, q[2]!], pos, scale });
    }
  }
  const sk = find('SKND'), sid = find('SKID');
  const partNode: number[] = [];
  if (sid) { const r = new R(u, sid.data), n = r.u32(); for (let i = 0; i < n; i++) { r.u32(); r.u16(); const nd2 = r.u16(); partNode.push(nd2 === 0xffff ? -1 : nd2); } }
  if (sk) {
    const r = new R(u, sk.data), n = r.u32();
    for (let i = 0; i < n; i++) { r.p += 44; const lod = r.u32(); r.u32(); x.parts.push({ name: r.str(), lod, node: partNode[i] ?? -1 }); }
    const cl = sk.kids.find((k) => k.tag === 'CLUS');
    if (cl) {
      const r2 = new R(u, cl.data);
      for (let i = 0; i < n && r2.p < cl.data + cl.dsize; i++) {
        const k = r2.u32(), list: XbgCluster[] = [];
        for (let j = 0; j < k; j++) {
          const mat = r2.u16(), tris = r2.u16(); r2.p += 10;
          const palette: number[] = [];
          for (let b = 0; b < 48; b++) palette.push(r2.u16());
          list.push({ mat, tris, palette });
        }
        x.clusters.push(list);
      }
    }
  }
  const ld = find('LODS');
  if (!ld) throw new Error('XBG: нет геометрии (LODS)');
  {
    const r = new R(u, ld.data), n = r.u32();
    for (let l = 0; l < n; l++) {
      const dist = r.f32(), nb = r.u32(), buffers: XbgBuffer[] = [];
      for (let b = 0; b < nb; b++) buffers.push({ format: r.u32(), stride: r.u32(), vcount: r.u32(), base: r.u32() });
      const np = r.u32(), prims: XbgPrim[] = [];
      for (let i = 0; i < np; i++) {
        const buffer = r.u32(), part = r.u32(), cluster = r.u32(), firstIndex = r.u32(), lastVertex = r.u32(), voff = r.u32(); r.u32();
        const bf = buffers[buffer];
        if (!bf) throw new Error('XBG: примитив ссылается на несуществующий буфер');
        prims.push({ buffer, part, cluster, firstIndex, lastVertex, firstVertex: (voff - bf.base) / bf.stride });
      }
      const vb = r.u32(); r.align16(); const vAt = r.p; r.p += vb;
      const ic = r.u32(); r.align16(); const iAt = r.p; r.p += ic * 2;
      if (r.p > ld.data + ld.dsize || vb !== buffers.reduce((s2, b) => s2 + b.vcount * b.stride, 0)) throw new Error('XBG: буфер LOD повреждён');
      x.lods.push({ dist, buffers, prims, vAt, iAt, icount: ic });
    }
  }
  const ob = find('O2BM');
  if (ob && ob.dsize >= 4) {
    const dv2 = new DataView(u.buffer, u.byteOffset, u.byteLength), n = dv2.getUint32(ob.data, true);
    if (4 + n * 64 <= ob.dsize) for (let i = 0; i < n; i++) x.o2bm.push(Float64Array.from({ length: 16 }, (_, k) => dv2.getFloat32(ob.data + 4 + i * 64 + k * 4, true)));
  }
  const cmp = (t: string): [number, number] | null => { const c = find(t); if (!c || c.dsize < 8) return null; const dv = new DataView(u.buffer, u.byteOffset + c.data, 8); return [dv.getFloat32(0, true), dv.getFloat32(4, true)]; };
  x.pcmp = cmp('PCMP') ?? x.pcmp;
  x.ucmp = cmp('UCMP') ?? x.ucmp;
  return x;
}

export interface XbmMaterial { name: string; shader: string; textures: Record<string, string> }

export function parseXbm(u: Uint8Array): XbmMaterial {
  const c = readChunks(u).find((k) => k.tag === 'DMTL');
  if (!c) throw new Error('XBM: нет чанка DMTL');
  const r = new R(u, c.data + 5);
  const name = r.str(), shader = r.str(), n = r.u32(), textures: Record<string, string> = {};
  for (let i = 0; i < n && i < 64; i++) { const path = r.str(), slot = r.str(); if (path) textures[slot] = path; }
  return { name, shader, textures };
}

/**
 * «Киты» персонажей (merc_kit, мультиплеерные классы, female_civilian_kit): все сменные части лежат в одной модели.
 * По умолчанию видна одна часть на слот (голова и глаза к ней, тело её расы, волосы, верх, низ, обувь; «без шапки»,
 * «без очков», «без снаряжения», если такие есть), «DUMMY…» скрыты. Возвращает имена частей, которые скрыть.
 */
export function kitHiddenParts(names: readonly string[]): Set<string> {
  const parts = [...new Set(names)], hidden = new Set<string>();
  const heads = parts.filter((n) => /HEAD/.test(n) && !/EYES|ROOT/.test(n));
  if (heads.length < 2 && !parts.some((n) => /DUMMY/.test(n))) return hidden; // не кит
  const key = (n: string) => n.replace(/^P_[A-Z]+_/, '').replace(/_LOD\d+$/, '').replace(/_/g, '');
  const head = heads.find((n) => /CAUCASIANHEAD01/.test(n)) ?? heads[0];
  const race = head && /NUBIAN/.test(head) ? 'NUBIAN' : 'CAUCASIAN';
  const choose = (list: string[], prefer: RegExp[] = []) => {
    if (list.length < 2) return;
    let keep = list[0]!;
    for (const re of prefer) { const f = list.find((n) => re.test(n)); if (f) { keep = f; break; } }
    for (const n of list) if (n !== keep) hidden.add(n);
  };
  for (const n of parts) if (/DUMMY/.test(n)) hidden.add(n);
  for (const n of heads) if (n !== head) hidden.add(n);
  if (head) for (const n of parts.filter((x) => /EYES/.test(x))) if (key(n).replace(/^EYES/, '') !== key(head)) hidden.add(n);
  const rest = parts.filter((n) => !hidden.has(n) && !heads.includes(n) && !/EYES/.test(n));
  const slot = (re: RegExp, not?: RegExp) => rest.filter((n) => re.test(n) && !(not && not.test(n)));
  const top = slot(/_UB_|DRESS/); // TOP_BODY — тело с руками, не одежда
  choose(top);
  const topKept = top.find((n) => !hidden.has(n)) ?? '';
  const armsStyle = /BEATER/.test(topKept) ? 'BEATER' : /VEST/.test(topKept) ? 'LONGVEST' : 'SHIRT';
  // тело: своей расы; руки — под верх
  for (const re of [/_ARMS$/, /BCHEST/, /_LEGS$/]) {
    const list = slot(re);
    choose(list, re.source === '_ARMS$' ? [new RegExp(`${race}_${armsStyle}_ARMS`), new RegExp(race)] : [new RegExp(race)]);
  }
  choose(slot(/HAIR/), [race === 'NUBIAN' ? /AFRO/ : /CAUC/]);
  choose(slot(/HAT|CAP\d|BEANIE|BANDANA/), [/NOHAT/]);
  choose(slot(/GLASS|GOGGLE/), [/NOGLASS/]);
  choose(slot(/_LB_.*(PANT|JEANS|SKIRT)|LEGS_.*SKIRT/));
  choose(slot(/BOOT/));
  choose(slot(/GEAR|BACKPACK|STRAPS|LEATHER_VEST|TACTICAL_VEST|FLACK_JACKET|VESTSPORT/), [/NOGEAR/]);
  for (const j of ['BRACELET', 'NECKLACE']) choose(slot(new RegExp(j)));
  return hidden;
}

/** Раскладка вершины по шагу: смещение нормали (−1 — нет, считается по треугольникам), веса/кости с 16. */
const LAYOUT: Record<number, { normal: number; skin: boolean }> = { 16: { normal: -1, skin: false }, 32: { normal: 16, skin: false }, 40: { normal: 24, skin: true } };

/** Шейдеры листвы, травы и волос — вырезание по альфе. */
const ALPHA_SHADERS = new Set(['Leaf', 'BigLeaf', 'Grass', 'Hair', 'Decal']);

const slotOf = (t: Record<string, string>, ...keys: string[]) => { for (const k of keys) if (t[k]) return t[k]; return undefined; };

/**
 * Кости анимации -> узлы. Кость i списка O2BM — узел, чья мировая поза совпадает с позой кости с точностью до общего
 * преобразования T (у животных T = 1; у людей кости O2BM — от таза в начале координат, повернуты на 90° вокруг Z).
 * T ищется перебором узла для кости 0. В списке нет «…Nub», корня и частей, поэтому номера не совпадают с NODE.
 * Возвращает узлы (−1 — не найден) и T (кадр анимации -> мир модели).
 */
export function o2bmNodes(x: Xbg): { nodes: number[]; frame: Float64Array } {
  const N = xbgSkeletonNodes(x.nodes).map((s) => rigidInv(s.offset!));
  const O = x.o2bm.map((m) => rigidInv(m));
  const id: Float64Array = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (!O.length) return { nodes: [], frame: id };
  const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[12]! - b[12]!, a[13]! - b[13]!, a[14]! - b[14]!) + Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((k) => a[k]! - b[k]!));
  const match = (T: ArrayLike<number>, limit: number) => {
    const out: number[] = [];
    for (const o of O) {
      const w = mulCol(T, o);
      let bj = -1, bd = 0.02;
      N.forEach((n, j) => { const d = dist(n, w); if (d < bd) { bd = d; bj = j; } });
      out.push(bj);
      if (out.length >= limit && out.every((v) => v < 0)) break;
    }
    return out;
  };
  // быстрый путь: кадры совпадают
  let best: { n: number; nodes: number[]; frame: Float64Array } = { n: -1, nodes: [], frame: id };
  const direct = match(id, O.length);
  best = { n: direct.filter((j) => j >= 0).length, nodes: direct, frame: id };
  if (best.n < O.length) {
    N.forEach((n, c) => {
      const T = mulCol(n, rigidInv(O[0]!));
      const probe = match(T, 8);
      if (probe.length < O.length && probe.every((v) => v < 0)) return;
      const nodes = probe.length === O.length ? probe : match(T, O.length), k = nodes.filter((j) => j >= 0).length;
      if (k > best.n) best = { n: k, nodes, frame: T };
    });
  }
  return { nodes: best.nodes, frame: best.frame };
}

/**
 * Иерархия как в скелете анимаций: вспомогательные кости (колени, локти) в модели висят на тазу, а в .skeleton — на
 * бедре/плече; без переподвешивания они не следуют за конечностью. Bind-поза сохраняется. parentOf — имя родителя по имени кости.
 */
export function reparentNodes(sn: SkeletonNode[], parentOf: ReadonlyMap<string, string>): SkeletonNode[] {
  const byName = new Map(sn.map((n, i) => [n.name.toLowerCase(), i]));
  const world: Float64Array[] = [];
  sn.forEach((n, i) => { world[i] = n.parent >= 0 ? mulCol(world[n.parent]!, n.local) : Float64Array.from(n.local); });
  return sn.map((n, i) => {
    const pn = parentOf.get(n.name.toLowerCase());
    const p = pn === undefined ? undefined : byName.get(pn);
    if (p === undefined || p === n.parent || p >= i) return n;
    return { ...n, parent: p, local: mulCol(rigidInv(world[p]!), world[i]!) };
  });
}

/**
 * Узлы скелета: позы узлов — в пространстве родителя. frame — кадр вершин скиновых мешей: у людей вершины записаны
 * в кадре костей O2BM (таз в начале координат), а узлы — в кадре модели; offset = (мировая bind-поза узла)⁻¹ · frame.
 */
export function xbgSkeletonNodes(nodes: XbgNode[], frame?: ArrayLike<number>): SkeletonNode[] {
  const local = nodes.map((n) => { const m = new Float64Array(16); compose(n.pos, n.rot, n.scale, m); return m; });
  const world: Float64Array[] = [];
  nodes.forEach((n, i) => { world[i] = n.parent >= 0 && n.parent < i ? mulCol(world[n.parent]!, local[i]!) : local[i]!; });
  return nodes.map((n, i) => ({ name: n.name, parent: n.parent >= 0 && n.parent < i ? n.parent : -1, local: local[i]!, offset: frame ? mulCol(rigidInv(world[i]!), frame) : rigidInv(world[i]!) }));
}

/**
 * Скелет анимаций модели: «<имя модели>_ref.skeleton» рядом, затем вверх по папкам — «hips_ref.skeleton»,
 * «pelvis_ref.skeleton», «_common\\pelvis_ref.skeleton»; для людей вне graphics\\characters (actors) — общий скелет людей.
 */
export function skeletonCandidates(modelPath: string, human = false): string[] {
  const parts = modelPath.replace(/\//g, '\\').toLowerCase().split('\\'), stem = parts[parts.length - 1]!.replace(/\.xbg$/, '');
  const dirs = parts.slice(0, -1), out = [`${dirs.join('\\')}\\${stem}_ref.skeleton`];
  for (let n = dirs.length; n >= 2; n--) {
    const dir = dirs.slice(0, n).join('\\');
    out.push(`${dir}\\hips_ref.skeleton`, `${dir}\\pelvis_ref.skeleton`, `${dir}\\_common\\pelvis_ref.skeleton`);
  }
  if (human) out.push('graphics\\characters\\_common\\pelvis_ref.skeleton');
  return out;
}

/** Меши ближнего LOD модели .xbg (с материалами .xbm из архива); matCache — общий кэш материалов (для уровней). */
export async function xbgMeshes(u: Uint8Array, arc: Archive | null, matCache?: Map<string, Promise<XbmMaterial | null>>, lodIndex = 0, parsed?: Xbg) {
  const x = parsed ?? parseXbg(u), lod = x.lods[Math.min(lodIndex, x.lods.length - 1)];
  if (!lod) throw new Error('XBG: нет LOD');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  for (const b of lod.buffers) if (!LAYOUT[b.stride]) throw new Error(`XBG: вершина ${b.stride} байт (формат ${b.format.toString(16)}) пока не поддерживается`);
  const skinned = lod.buffers.some((b) => LAYOUT[b.stride]!.skin);
  const readMat = async (p: string) => {
    const e = arc?.lookup(p);
    if (!arc || !e) return null;
    try { return parseXbm(await arc.read(e)); } catch { return null; }
  };
  const mats = await Promise.all(x.materials.map((p) => {
    if (!matCache) return readMat(p);
    const k = p.toLowerCase();
    let r = matCache.get(k);
    if (!r) { r = readMat(p); matCache.set(k, r); }
    return r;
  }));
  const [po, ps] = x.pcmp, [uo, us] = x.ucmp;
  const meshes: Mesh[] = [];
  lod.prims.forEach((pr, k) => {
    const next = lod.prims[k + 1], end = next ? next.firstIndex : lod.icount;
    const cl = x.clusters[pr.part]?.[pr.cluster], v0 = pr.firstVertex, nv = pr.lastVertex - v0 + 1;
    const bf = lod.buffers[pr.buffer]!, L = LAYOUT[bf.stride]!;
    if (nv <= 0 || end <= pr.firstIndex) return;
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const bone = new Float32Array(nv * 4), weight = new Float32Array(nv * 4);
    for (let i = 0; i < nv; i++) {
      const o = lod.vAt + bf.base + (v0 + i) * bf.stride;
      for (let c = 0; c < 3; c++) pos[i * 3 + c] = dv.getInt16(o + c * 2, true) * ps + po;
      uv[i * 2] = dv.getInt16(o + 8, true) * us + uo; uv[i * 2 + 1] = dv.getInt16(o + 10, true) * us + uo;
      if (L.normal >= 0) { const n = o + L.normal; nor[i * 3] = u[n + 2]! / 127.5 - 1; nor[i * 3 + 1] = u[n + 1]! / 127.5 - 1; nor[i * 3 + 2] = u[n]! / 127.5 - 1; }
      if (L.skin && cl) {
        let sum = 0;
        for (let b = 0; b < 4; b++) { const w = u[o + 16 + b]! / 255; weight[i * 4 + b] = w; sum += w; bone[i * 4 + b] = cl.palette[u[o + 20 + b]!] ?? 0; }
        if (sum > 0) for (let b = 0; b < 4; b++) weight[i * 4 + b]! /= sum; else weight[i * 4] = 1;
      } else weight[i * 4] = 1;
    }
    const cnt = end - pr.firstIndex, indices = nv > 65535 ? new Uint32Array(cnt) : new Uint16Array(cnt);
    for (let t = 0; t + 2 < cnt; t += 3) {
      const a = lod.iAt + (pr.firstIndex + t) * 2;
      indices[t] = dv.getUint16(a, true) - v0; indices[t + 1] = dv.getUint16(a + 4, true) - v0; indices[t + 2] = dv.getUint16(a + 2, true) - v0;
    }
    for (let t = 0; t < cnt; t++) if (indices[t]! >= nv) throw new Error('XBG: индекс вне вершин примитива');
    const normals = L.normal >= 0 ? nor : computeNormals(pos, indices);
    const part = x.parts[pr.part], matPath = cl ? x.materials[cl.mat] : undefined, mat = cl ? mats[cl.mat] : null;
    const partName = (part?.name ?? `part${pr.part}`).replace(/_LOD\d+$/i, '');
    const tex = mat ? slotOf(mat.textures, 'DiffuseTexture1', 'SkinTexture', 'FabricTexture', 'DiffuseTexture', 'DiffuseTexture2') : undefined;
    const mesh: Mesh = {
      name: `${partName} · ${mat?.name ?? matPath?.split('\\').pop() ?? '?'}`,
      texture: tex ?? '', material: matPath, vertexCount: nv, pos, nor: normals, uv, bone, weight, indices, skinned: L.skin && !!cl,
    };
    if (mat) {
      const nm = slotOf(mat.textures, 'NormalTexture1', 'NormalTexture'), sp = slotOf(mat.textures, 'SpecularTexture1', 'SpecularTexture');
      if (nm) mesh.normalMap = nm;
      if (sp) mesh.surface = { specular: { map: sp, channel: 0 }, source: 'Far Cry 2 .xbm' };
      mesh.shader = mat.shader;
      if (ALPHA_SHADERS.has(mat.shader)) mesh.alphaTest = true;
    }
    // по умолчанию — целая машина днём: повреждённые состояния (…STATE02), ночные фары (…_N_…) и световые конусы скрыты
    if (/STATE0*[2-9]$/i.test(partName) || /_N_/i.test(partName) || /LIGHT(HALO|CONE|BEAM)/i.test(mat?.name ?? '')) mesh.defaultHidden = true;
    meshes.push(mesh);
  });
  if (!meshes.length) throw new Error('XBG: нет примитивов в ближнем LOD');
  return { x, lod, meshes, skinned, missing: x.materials.filter((_, i) => !mats[i]) };
}

/** Скиновые меши в bind-позе как статика (для уровней): вершины через матрицы скина узлов модели. */
export function bakeBindPose(x: Xbg, meshes: Mesh[]): Mesh[] {
  if (!x.nodes.length) return meshes;
  const sk = new NodeSkeleton(xbgSkeletonNodes(x.nodes, x.o2bm.length ? o2bmNodes(x).frame : undefined));
  sk.pose(null, 0, false);
  return meshes.map((m) => {
    if (!m.skinned) return m;
    const pos = new Float32Array(m.pos.length), nor = new Float32Array(m.nor.length);
    for (let v = 0; v < m.vertexCount; v++) {
      const px = m.pos[v * 3]!, py = m.pos[v * 3 + 1]!, pz = m.pos[v * 3 + 2]!, nx = m.nor[v * 3]!, ny = m.nor[v * 3 + 1]!, nz = m.nor[v * 3 + 2]!;
      let ws = 0;
      for (let k = 0; k < 4; k++) {
        const w = m.weight[v * 4 + k]!;
        if (!w) continue;
        const M = sk.skinV[m.bone[v * 4 + k]!];
        if (!M) continue;
        ws += w;
        for (let c = 0; c < 3; c++) {
          pos[v * 3 + c]! += w * (M[c]! * px + M[4 + c]! * py + M[8 + c]! * pz + M[12 + c]!);
          nor[v * 3 + c]! += w * (M[c]! * nx + M[4 + c]! * ny + M[8 + c]! * nz);
        }
      }
      if (!ws) { pos[v * 3] = px; pos[v * 3 + 1] = py; pos[v * 3 + 2] = pz; nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz; }
      const l = Math.hypot(nor[v * 3]!, nor[v * 3 + 1]!, nor[v * 3 + 2]!) || 1;
      for (let c = 0; c < 3; c++) nor[v * 3 + c]! /= l;
    }
    return { ...m, pos, nor, skinned: false, bone: new Float32Array(0), weight: new Float32Array(0) };
  });
}

export async function loadXbg(main: VFile, ctx: LoadContext): Promise<Model> {
  const arc = main.archive ?? ctx.archives.find((a) => a.kind === 'dunia-fat') ?? null;
  const { x, lod, meshes, skinned, missing } = await xbgMeshes(new Uint8Array(await main.arrayBuffer()), arc);
  const kitHidden = kitHiddenParts(meshes.map((m) => m.name.split(' · ')[0]!));
  for (const m of meshes) if (kitHidden.has(m.name.split(' · ')[0]!)) m.defaultHidden = true;
  let skeleton: NodeSkeleton | null = null, skel: { path: string; bones: DuniaSkelBone[] } | null = null;
  let frame: Float64Array | null = null;
  if (skinned && x.nodes.length) {
    frame = x.o2bm.length ? o2bmNodes(x).frame : null;
    let sn = xbgSkeletonNodes(x.nodes, frame ?? undefined);
    // скелет анимаций: иерархия вспомогательных костей и номера костей в .mab
    const mp = main.path ?? main.name;
    for (const c of arc ? skeletonCandidates(mp, x.nodes.some((n) => n.name === 'Pelvis')) : []) {
      const e = arc!.lookup(c);
      if (!e || !e.size) continue;
      try { skel = { path: c, bones: parseSkeleton(await arc!.read(e)) }; break; } catch { /* не скелет */ }
    }
    if (skel) {
      const bones = skel.bones;
      sn = reparentNodes(sn, new Map(bones.filter((b) => b.parent >= 0).map((b) => [b.name.toLowerCase(), bones[b.parent]!.name.toLowerCase()])));
    }
    skeleton = new NodeSkeleton(sn);
  }
  const info = [
    `Far Cry 2 (Dunia): ${main.name}`,
    `LOD: ${x.lods.length} (показан ближний, до ${lod.dist} м), примитивов ${lod.prims.length}, вершин ${lod.buffers.reduce((s2, b) => s2 + b.vcount, 0)}${skinned ? ', скин' : ''}`,
    `Узлов: ${x.nodes.length}, частей: ${new Set(lod.prims.map((p) => p.part)).size}, материалов: ${x.materials.length}`,
  ];
  if (kitHidden.size) info.push(`Кит персонажа: показан один вариант на слот, скрыто частей ${kitHidden.size} (включаются в списке мешей)`);
  if (missing.length) info.push(`Не найдены материалы: ${missing.slice(0, 3).map((m) => m.split('\\').pop()).join(', ')}${missing.length > 3 ? '…' : ''}`);
  if (skel) info.push(`Скелет анимаций: ${skel.path.split('\\').slice(-2).join('\\')} (${skel.bones.length} костей)`);
  const model: Model = { meshes, skeleton, motions: [], bounds: skeleton ? skinnedBounds(skeleton, meshes) : boundsOf(meshes), info, defaultZUp: true };
  if (skeleton && skel) attachMabMotions(model, skeleton, x, skel);
  return model;
}

/** Анимации .mab к модели: кости по именам из .skeleton, таз — из кадра анимации (Z вверх, земля) в пространство родителя-узла. */
function attachMabMotions(model: Model, sk: NodeSkeleton, x: Xbg, skel: { path: string; bones: DuniaSkelBone[] }): void {
  const byName = new Map(x.nodes.map((n, i) => [n.name.toLowerCase(), i]));
  const bones = skel.bones.map((b) => byName.get(b.name.toLowerCase()) ?? -1);
  // мировые bind-позы узлов (по иерархии скелета)
  const world: Float64Array[] = [];
  sk.nodes.forEach((n, i) => { world[i] = n.parent >= 0 ? mulCol(world[n.parent]!, n.local) : Float64Array.from(n.local); });
  const fix = new Map<number, Float64Array>();
  let root: { bone: number; rot: number[]; pos: number[] } | undefined;
  skel.bones.forEach((b, i) => {
    const n = bones[i]!;
    if (b.parent >= 0 || n < 0) return;
    const p = sk.nodes[n]!.parent;
    if (p >= 0) fix.set(i, rigidInv(world[p]!));
    // поза корня в кадре анимации — из модели (у людей кость таза в .skeleton стоит в начале координат)
    if (!root) root = { bone: i, rot: matQuat(world[n]!), pos: [world[n]![12]!, world[n]![13]!, world[n]![14]!] };
  });
  model.meta = { ...model.meta, duniaSkeleton: skel.path };
  model.loadMotions = async (file) => {
    const u = new Uint8Array(await file.arrayBuffer());
    return [buildMabMotion(file.name.replace(/\.mab$/i, ''), parseMab(u), bones, fix, root)];
  };
}

/** Анимации для модели (данные — при выборе): все .mab в папке скелета и глубже. */
export function listMabMotions(model: Model, archive: Archive): NodeMotion[] {
  const sp = model.meta?.duniaSkeleton as string | undefined;
  if (!sp || !model.loadMotions) return [];
  const dir = sp.replace(/\\/g, '/').toLowerCase().split('/').slice(0, -1).join('/') + '/';
  const out: NodeMotion[] = [];
  for (const e of archive.entries) {
    if (!e.path.endsWith('.mab') || !e.path.startsWith(dir)) continue;
    const rel = e.path.slice(dir.length).replace(/\.mab$/, '');
    out.push({ kind: 'node', name: rel, tps: 30, chan: new Map(), duration: 0, load: async () => (await model.loadMotions!(archive.fileOf(e)))[0]! } as NodeMotion);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

