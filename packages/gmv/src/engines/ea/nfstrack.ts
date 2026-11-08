// Need for Speed: World — трасса (TRACKS/L5RA.BUN + STREAML5RA_*.BUN). Город разбит на секции потоковой загрузки:
// номерные файлы STREAML5RA_<N>.BUN — секции со списками объектов (0x80134000, тот же формат, что у машин) и группами
// расстановки (0x80034100: SceneryInfo 72 байта — имя и хеши объекта трёх LOD, SceneryInstance 96 байт — габариты,
// позиция, поворот 3×3 и номер SceneryInfo); файлы с хешем в имени (STREAML5RA_0x<хеш>.BUN) — общие пакеты текстур TPK,
// библиотеки объектов и секции 20000+. Объекты «CHOP» нарезаны прямо в мировых координатах (экземпляр в начале координат),
// остальные (столбы, урны, деревья) расставлены экземплярами. Мир — Z вверх, единицы — метры.
import { boundsOf, sumTris, sumVerts } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { Archive, ArchiveEntry, DecodedImage, Mesh, Model, VFile } from '../../core/types';
import { BB_TPK, bbChunks, bbFind, decodeBbTexture, readTpks, skipPad, unLzc, type BbTexture } from './blackbox';
import { objectName, parseObject, type NfsPart } from './nfsgeom';

export interface SceneryInfo { name: string; solids: number[]; radius: number }
export interface SceneryInst { info: number; /** поворот 3×3 по строкам (локальные оси X, Y, Z в мире) и перенос */ m: Float32Array; min: number[]; max: number[]; flags: number }
export interface SceneryGroup { infos: SceneryInfo[]; insts: SceneryInst[] }
export interface TrackObject { hash: number; name: string; data: Uint8Array }
export interface TrackScan { objects: Map<number, TrackObject>; groups: SceneryGroup[] }

const INFO_SIZE = 72, INST_SIZE = 96;
const cstr = (u: Uint8Array, off: number, max: number): string => { let s = ''; for (let i = 0; i < max && u[off + i]; i++) s += String.fromCharCode(u[off + i]!); return s; };

/** Хеш объекта: заголовок 0x134011 (после выравнивания) @16. */
function objectHash(o: Uint8Array): number {
  const obj = bbChunks(o, 0, o.length).find((c) => c.id === 0x80134010);
  const hdr = obj && bbChunks(o, obj.off, obj.off + obj.size).find((c) => c.id === 0x134011);
  if (!hdr) return 0;
  const p = skipPad(o, hdr.off, hdr.off + hdr.size);
  return new DataView(o.buffer, o.byteOffset, o.byteLength).getUint32(p + 16, true);
}

/** Объекты и группы расстановки одного файла секции. */
export function scanTrack(u: Uint8Array, wantObjects = true): TrackScan {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const objects = new Map<number, TrackObject>(), groups: SceneryGroup[] = [];
  const top = bbChunks(u, 0, u.length);
  for (const c of top) {
    if (c.id === 0x80134000 && wantObjects) {
      for (const oc of bbFind(u, c.off, c.off + c.size, 0x80134010, 1)) {
        const data = u.subarray(oc.off - 8, oc.off + oc.size), hash = objectHash(data);
        if (hash && !objects.has(hash)) objects.set(hash, { hash, name: objectName(data), data });
      }
    } else if (c.id === 0x80034100) {
      const kids = bbChunks(u, c.off, c.off + c.size);
      const ic = kids.find((k) => k.id === 0x34102), nc = kids.find((k) => k.id === 0x34103);
      if (!ic || !nc) continue;
      const infos: SceneryInfo[] = [], insts: SceneryInst[] = [];
      for (let p = skipPad(u, ic.off, ic.off + ic.size); p + INFO_SIZE <= ic.off + ic.size; p += INFO_SIZE)
        infos.push({ name: cstr(u, p, 24), solids: [dv.getUint32(p + 24, true), dv.getUint32(p + 28, true), dv.getUint32(p + 32, true)], radius: dv.getFloat32(p + 56, true) });
      for (let p = skipPad(u, nc.off, nc.off + nc.size); p + INST_SIZE <= nc.off + nc.size; p += INST_SIZE) {
        const m = new Float32Array(12);
        for (let k = 0; k < 9; k++) m[k] = dv.getFloat32(p + 44 + k * 4, true);
        for (let k = 0; k < 3; k++) m[9 + k] = dv.getFloat32(p + 32 + k * 4, true);
        const info = dv.getUint32(p + 84, true);
        if (info >= infos.length || !m.every(Number.isFinite)) continue;
        insts.push({ info, m, min: [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)], max: [dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true)], flags: dv.getUint32(p + 12, true) });
      }
      groups.push({ infos, insts });
    }
  }
  return { objects, groups };
}

// ---------- индекс файлов трассы: где лежит объект и текстура ----------
export interface TrackIndex { obj: Map<number, ArchiveEntry>; tex: Map<number, ArchiveEntry>; scen: Set<ArchiveEntry> }
type Reader = (e: ArchiveEntry, off: number, n: number) => Promise<Uint8Array>;

function readerOf(arc: Archive): Reader {
  return async (e, off, n) => {
    const b = arc.blobOf?.(e);
    if (b) return new Uint8Array(await b.slice(off, Math.min(b.size, off + n)).arrayBuffer());
    const all = await arc.read(e);
    return all.subarray(off, off + n);
  };
}

/**
 * Заголовки файла: верхние чанки (по 8 байт) и начала нужных — список хешей текстур TPK (0x33310002) и хешей объектов
 * списка (0x134003). Читается не больше нескольких килобайт на файл.
 */
export async function indexTrackFile(read: Reader, e: ArchiveEntry, size: number, out: TrackIndex): Promise<void> {
  const HEAD = 32768;
  let buf = await read(e, 0, Math.min(size, HEAD)), base = 0, p = 0;
  const at = async (off: number, n: number): Promise<Uint8Array> => {
    if (off >= base && off + n <= base + buf.length) return buf.subarray(off - base, off - base + n);
    buf = await read(e, off, Math.max(n, Math.min(HEAD, size - off))); base = off;
    return buf.subarray(0, n);
  };
  for (let guard = 0; p + 8 <= size && guard < 4096; guard++) {
    const h = await at(p, 8), dv = new DataView(h.buffer, h.byteOffset, 8), id = dv.getUint32(0, true), sz = dv.getUint32(4, true);
    if (p + 8 + sz > size) break;
    if (id === 0x80034100) out.scen.add(e);
    else if (id === BB_TPK || id === 0x80134000) {
      const n = Math.min(sz, 16384), u = await at(p + 8, n), uv = new DataView(u.buffer, u.byteOffset, u.byteLength);
      if (id === BB_TPK) {
        for (const c of bbFind(u, 0, u.length, 0x33310002, 2))
          for (let k = 0; k + 8 <= c.size; k += 8) { const t = uv.getUint32(c.off + k, true); if (!out.tex.has(t)) out.tex.set(t, e); }
      } else {
        for (const c of bbFind(u, 0, u.length, 0x134003, 2))
          for (let k = skipPad(u, c.off, c.off + c.size); k + 8 <= c.off + c.size; k += 8) { const o = uv.getUint32(k, true); if (o && !out.obj.has(o)) out.obj.set(o, e); }
      }
    }
    p += 8 + sz;
  }
}

const indexCache = new WeakMap<Archive, Map<string, Promise<TrackIndex>>>();
/** Индекс всех файлов трассы в папке (кэш на открытую папку). */
function trackIndex(arc: Archive, files: ArchiveEntry[], key: string): Promise<TrackIndex> {
  let m = indexCache.get(arc);
  if (!m) { m = new Map(); indexCache.set(arc, m); }
  let p = m.get(key);
  if (!p) {
    p = (async () => {
      const out: TrackIndex = { obj: new Map(), tex: new Map(), scen: new Set() }, read = readerOf(arc);
      let i = 0;
      const next = async (): Promise<void> => {
        while (i < files.length) {
          const e = files[i++]!, size = e.size ?? arc.blobOf?.(e)?.size ?? 0;
          if (size) try { await indexTrackFile(read, e, size, out); } catch { /* файл не читается */ }
        }
      };
      await Promise.all(Array.from({ length: 8 }, next));
      return out;
    })();
    m.set(key, p);
  }
  return p;
}

// ---------- сборка модели ----------
interface Batch { tex: number; normal: number; pos: Float32Array; nor: Float32Array; uv: Float32Array; shade: Uint8Array; idx: Uint32Array; nv: number; ni: number }
const BATCH_VERTS = 1 << 20;

class Batches {
  readonly list: Batch[] = [];
  private open = new Map<string, Batch>();
  tris = 0;
  bad = 0;
  /** tex — цвет, normal — карта нормалей (0 — нет): меши по паре текстур. */
  add(tex: number, normal: number, sub: NfsPart['subs'][number], m: Float32Array | null, shade = true): void {
    const n = sub.pos.length / 3, key = `${tex}:${normal}`;
    // испорченные вершины (неверно угаданный формат буфера) раздули бы габариты города до 1e38
    for (let k = 0; k < sub.pos.length; k++) { const v = sub.pos[k]!; if (!(v > -1e6 && v < 1e6)) { this.bad++; return; } }
    let b = this.open.get(key);
    if (!b || b.nv + n > BATCH_VERTS || b.ni + sub.indices.length > BATCH_VERTS * 3) {
      if (b) this.shrink(b);
      const cap = Math.max(n, 4096);
      b = { tex, normal, pos: new Float32Array(cap * 3), nor: new Float32Array(cap * 3), uv: new Float32Array(cap * 2), shade: new Uint8Array(cap * 4), idx: new Uint32Array(Math.max(sub.indices.length, 8192)), nv: 0, ni: 0 };
      this.open.set(key, b); this.list.push(b);
    }
    this.grow(b, n, sub.indices.length);
    const P = sub.pos, N = sub.nor, o = b.nv * 3;
    for (let k = 0; k < n; k++) {
      const x = P[k * 3]!, y = P[k * 3 + 1]!, z = P[k * 3 + 2]!, nx = N[k * 3]!, ny = N[k * 3 + 1]!, nz = N[k * 3 + 2]!;
      if (m) {
        // строки поворота — локальные оси: мир = x·R0 + y·R1 + z·R2 + T
        b.pos[o + k * 3] = x * m[0]! + y * m[3]! + z * m[6]! + m[9]!;
        b.pos[o + k * 3 + 1] = x * m[1]! + y * m[4]! + z * m[7]! + m[10]!;
        b.pos[o + k * 3 + 2] = x * m[2]! + y * m[5]! + z * m[8]! + m[11]!;
        let ax = nx * m[0]! + ny * m[3]! + nz * m[6]!, ay = nx * m[1]! + ny * m[4]! + nz * m[7]!, az = nx * m[2]! + ny * m[5]! + nz * m[8]!;
        const l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
        b.nor[o + k * 3] = ax; b.nor[o + k * 3 + 1] = ay; b.nor[o + k * 3 + 2] = az;
      } else {
        b.pos[o + k * 3] = x; b.pos[o + k * 3 + 1] = y; b.pos[o + k * 3 + 2] = z;
        b.nor[o + k * 3] = nx; b.nor[o + k * 3 + 1] = ny; b.nor[o + k * 3 + 2] = nz;
      }
    }
    b.uv.set(sub.uv, b.nv * 2);
    if (sub.shade && shade) {
      // смягчаем: у игры к запечённому свету добавляется своё освещение — без этого тени выходят чёрными
      const src = sub.shade, dst = b.shade, o4 = b.nv * 4;
      for (let k = 0; k < src.length; k++) dst[o4 + k] = (k & 3) === 3 ? 255 : Math.round(45 + src[k]! * 0.65);
    } else b.shade.fill(128, b.nv * 4, (b.nv + n) * 4);
    // зеркальный экземпляр (отрицательный определитель) — меняем обход граней
    const flip = m ? m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!) < 0 : false;
    for (let k = 0; k < sub.indices.length; k += 3) {
      const a = sub.indices[k]! + b.nv, c1 = sub.indices[k + 1]! + b.nv, c2 = sub.indices[k + 2]! + b.nv;
      b.idx[b.ni + k] = a; b.idx[b.ni + k + 1] = flip ? c2 : c1; b.idx[b.ni + k + 2] = flip ? c1 : c2;
    }
    b.nv += n; b.ni += sub.indices.length; this.tris += sub.indices.length / 3;
  }
  private grow(b: Batch, nv: number, ni: number): void {
    if ((b.nv + nv) * 3 > b.pos.length) {
      const cap = Math.min(BATCH_VERTS, Math.max(b.nv + nv, b.pos.length / 3 * 2)) * 3;
      for (const k of ['pos', 'nor'] as const) { const a = new Float32Array(cap); a.set(b[k].subarray(0, b.nv * 3)); b[k] = a; }
      const u = new Float32Array(cap / 3 * 2); u.set(b.uv.subarray(0, b.nv * 2)); b.uv = u;
      const c = new Uint8Array(cap / 3 * 4); c.set(b.shade.subarray(0, b.nv * 4)); b.shade = c;
    }
    if (b.ni + ni > b.idx.length) { const a = new Uint32Array(Math.max(b.ni + ni, b.idx.length * 2)); a.set(b.idx.subarray(0, b.ni)); b.idx = a; }
  }
  private shrink(b: Batch): void {
    b.pos = b.pos.slice(0, b.nv * 3); b.nor = b.nor.slice(0, b.nv * 3); b.uv = b.uv.slice(0, b.nv * 2); b.shade = b.shade.slice(0, b.nv * 4); b.idx = b.idx.slice(0, b.ni);
  }
  finish(): Batch[] { for (const b of this.open.values()) this.shrink(b); this.open.clear(); return this.list; }
}

/** Подходит ли файл как трасса NFS World: L5RA.BUN или STREAML5RA_*.BUN в TRACKS. */
export const NFS_TRACK_RE = /(^|\/)tracks\/(stream)?[a-z]\d[a-z]{2}(_[^/]*)?\.bun$/i;

/** Мип-уровень DXT/ATI не больше maxSide: подменяет данные и размеры текстуры. */
function mipTexture(t: BbTexture, maxSide: number): BbTexture {
  if (Math.max(t.width, t.height) <= maxSide) return t;
  const bs = t.fourcc === 0x31545844 || t.fourcc === 0x31495441 ? 8 : t.fourcc === 0x33545844 || t.fourcc === 0x35545844 || t.fourcc === 0x32495441 ? 16 : 0;
  let w = t.width, h = t.height, off = 0;
  const size = (a: number, b: number) => (bs ? Math.max(1, (a + 3) >> 2) * Math.max(1, (b + 3) >> 2) * bs : a * b * 4);
  const d = t.data();
  while (Math.max(w, h) > maxSide && off + size(w, h) + size(Math.max(1, w >> 1), Math.max(1, h >> 1)) <= d.length) { off += size(w, h); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
  if (!off) return t;
  return { ...t, width: w, height: h, data: () => d.subarray(off, off + size(w, h)) };
}

export interface TrackOptions { /** бюджет треугольников (город целиком) */ budget?: number; maxTex?: number }

export async function loadNfsTrack(main: VFile, ctx: LoadContext, opt: TrackOptions = {}): Promise<Model> {
  const t0 = Date.now();
  const path = main.path ?? main.name.toLowerCase(), dir = path.replace(/[^/]*$/, '');
  const base = /([a-z]\d[a-z]{2})(?:_[^/]*)?\.bun$/i.exec(path)?.[1]?.toLowerCase() ?? 'l5ra';
  const arc = main.archive ?? ctx.archives.find((a) => a.lookup(path));
  const info: string[] = [];
  const all = arc ? arc.entries.filter((e) => e.path.startsWith(dir) && e.path.slice(dir.length).startsWith(`stream${base}_`) && e.path.endsWith('.bun') && !e.path.slice(dir.length).includes('/')) : [];
  const numOf = (e: ArchiveEntry) => /_(\d+)\.bun$/.exec(e.path)?.[1];
  const city = !/^stream/i.test(main.name) && /\.bun$/i.test(main.name);
  if (city && !arc) throw new Error('Город NFS World собирается из файлов STREAM рядом с L5RA.BUN: откройте «Папку игры»');
  const maxTex = opt.maxTex ?? (city ? 128 : 512);

  // файлы, геометрия которых показывается
  let sections: Array<{ entry?: ArchiveEntry; u?: Uint8Array; label: string }>;
  // индекс: библиотеки (имя с хешем, номера 20000+) — всегда; у секции ещё и остальные номерные файлы (здания соседних секций)
  const index = arc && all.length ? await trackIndex(arc, all.filter((e) => city ? !numOf(e) || +numOf(e)! >= 20000 : e.path !== path), dir + base + (city ? '' : ':all')) : null;
  if (city) {
    const numbered = all.filter((e) => numOf(e) && +numOf(e)! < 20000);
    sections = [...numbered, ...[...index!.scen].filter((e) => !numbered.includes(e))].map((entry) => ({ entry, label: entry.path.slice(dir.length) }));
  } else sections = [{ u: new Uint8Array(await main.arrayBuffer()), label: main.name }];

  // проход 1: расстановка всех секций и где лежит каждый объект (с числом треугольников); буферы держим только у
  // одной секции — у города данные читаются вторым проходом по файлам
  interface Src { entry?: ArchiveEntry; u?: Uint8Array }
  const objSrc = new Map<number, { src: Src; tris: number }>(), wanted: Array<{ name: string; inst: SceneryInst; solid: number; chop: boolean; size: number; rank: number; ocean: boolean; lods: number[]; baked: boolean }> = [];
  const readFull = async (e: ArchiveEntry) => arc!.read(e);
  const noteObjects = (sc: TrackScan, src: Src) => { for (const [h, o] of sc.objects) if (!objSrc.has(h)) objSrc.set(h, { src, tris: objectTris(o.data) }); };
  let nInst = 0, nShadow = 0;
  for (const s of sections) {
    const u = s.u ?? await readFull(s.entry!);
    const sc = scanTrack(u, true);
    for (const g of sc.groups) for (const inst of g.insts) {
      const inf = g.infos[inst.info]!, solid = inf.solids[0]!;
      if (!solid) continue;
      nInst++;
      // тени (SHADOW_*, ShadowGeo) — тёмная накладка, рисуется игрой отдельно
      if (/^shadow|shadowgeo/i.test(inf.name)) { nShadow++; continue; }
      const chop = /_CHOP/i.test(inf.name) || (inst.m[9] === 0 && inst.m[10] === 0 && inst.m[11] === 0);
      const size = Math.max(inst.max[0]! - inst.min[0]!, inst.max[1]! - inst.min[1]!, inst.max[2]! - inst.min[2]!);
      // порядок под бюджет: нарезка мира, затем дальняя панорама (PAN_*: горизонт, океан), затем экземпляры по размеру
      wanted.push({ name: inf.name, inst, solid, chop, size, rank: chop ? 0 : /^pan_/i.test(inf.name) ? 1 : 2, ocean: /ocean/i.test(inf.name), lods: inf.solids, baked: /_CHOP|^TRN_/i.test(inf.name) });
    }
    noteObjects(sc, city ? { entry: s.entry } : { u });
  }
  // недостающие объекты — из библиотек (файлы с хешем в имени)
  const missingObj = new Set<number>();
  for (const w of wanted) if (!objSrc.has(w.solid)) for (const h of w.lods) if (h && !objSrc.has(h)) missingObj.add(h);
  if (index && missingObj.size) {
    const files = new Set<ArchiveEntry>();
    for (const h of missingObj) { const e = index.obj.get(h); if (e) files.add(e); }
    for (const e of files) {
      try { const u = await readFull(e); noteObjects(scanTrack(u), city ? { entry: e } : { u }); } catch { /* нет файла */ }
    }
  }
  // нет LOD A — берём любой найденный
  missingObj.clear();
  for (const w of wanted) if (!objSrc.has(w.solid)) { const h = w.lods.find((x) => x && objSrc.has(x)); if (h) w.solid = h; else missingObj.add(w.solid); }

  // город: экземпляры — самым простым LOD из трёх (C, затем B), если он есть
  let lowLod = 0;
  if (city) for (const w of wanted) {
    if (w.rank !== 2) continue;
    const h = [w.lods[2], w.lods[1]].find((x) => x && x !== w.solid && objSrc.has(x));
    if (h) { w.solid = h; lowLod++; }
  }
  // бюджет: сначала мировая нарезка (CHOP), затем экземпляры по размеру
  wanted.sort((a, b) => a.rank - b.rank || b.size - a.size);
  const budget = opt.budget ?? (city ? 7_000_000 : 20_000_000);
  const bySrc = new Map<Src, Array<{ inst: SceneryInst; solid: number; rank: number; ocean: boolean; baked: boolean }>>();
  let skippedBudget = 0, drawn = 0, planned = 0, demand = 0;
  const byRank = [0, 0, 0];
  for (const w of wanted) {
    const o = objSrc.get(w.solid);
    if (!o || !o.tris) continue;
    demand += o.tris; byRank[w.rank] = byRank[w.rank]! + o.tris;
    if (planned + o.tris > budget) { skippedBudget++; continue; }
    planned += o.tris; drawn++;
    if (!bySrc.has(o.src)) bySrc.set(o.src, []);
    bySrc.get(o.src)!.push(w);
  }
  // проход 2: геометрия по файлам
  // дальняя панорама (горы и острова на горизонте, PAN_*) — отдельными мешами, по умолчанию скрыта; океан виден
  const batches = new Batches(), panB = new Batches(), oceanB = new Batches(), texUsed = new Set<number>();
  for (const [src, list] of bySrc) {
    let sc: TrackScan;
    try { sc = scanTrack(src.u ?? await readFull(src.entry!)); } catch { continue; }
    const parts = new Map<number, NfsPart | null>();
    for (const w of list) {
      let p = parts.get(w.solid);
      if (p === undefined) {
        const o = sc.objects.get(w.solid);
        try { p = o ? parseObject(o.data, w.solid, o.name) : null; } catch { p = null; }
        parts.set(w.solid, p);
      }
      if (!p) continue;
      const m = w.inst.m, ident = m[0] === 1 && m[4] === 1 && m[8] === 1 && !m[9] && !m[10] && !m[11];
      const into = w.rank === 1 ? (w.ocean ? oceanB : panB) : batches;
      // запечённый свет — только у нарезки мира (у расставленных предметов цвет вершин значит другое: почти чёрный);
      // карты нормалей — только у секции (у города издали они почти не видны, а это ещё сотни пакетов)
      for (const s of p.subs) { const nrm = city ? 0 : s.normal ?? 0; into.add(s.texture, nrm, s, ident ? null : m, w.baked); texUsed.add(s.texture); if (nrm) texUsed.add(nrm); }
    }
  }
  const list = batches.finish(), panList = new Set(panB.finish()), oceanList = new Set(oceanB.finish());
  list.push(...oceanList, ...panList);

  // текстуры: пакеты TPK по индексу, затем общие текстуры игры
  const tex = new Map<number, BbTexture>();
  const gameRoot = dir.replace(/tracks\/$/i, '');
  if (index) {
    const files = new Set<ArchiveEntry>();
    for (const h of texUsed) { const e = index.tex.get(h); if (e) files.add(e); }
    for (const e of files) {
      try {
        const u = await readFull(e), got = readTpks(u);
        for (const [h, t] of got) if (texUsed.has(h) && !tex.has(h)) tex.set(h, mipTexture(t, maxTex));
      } catch { /* пакет не прочитан */ }
    }
  }
  if (!city && sections[0]!.u) for (const [h, t] of readTpks(sections[0]!.u)) if (!tex.has(h)) tex.set(h, mipTexture(t, maxTex));
  for (const p of ['global/globalb.lzc', 'global/ingamea.lzc']) {
    if ([...texUsed].every((h) => tex.has(h))) break;
    try { const u = await ctx.readPath(gameRoot + p); if (u) for (const [h, t] of readTpks(unLzc(u))) if (texUsed.has(h) && !tex.has(h)) tex.set(h, mipTexture(t, maxTex)); } catch { /* нет пакета */ }
  }
  const images = new Map<number, DecodedImage | null>(), failed = new Set<string>();
  const image = (h: number): DecodedImage | null => {
    if (images.has(h)) return images.get(h)!;
    const t = tex.get(h);
    let img: DecodedImage | null = null;
    if (t) try { img = decodeBbTexture(t); } catch (e) { failed.add((e as Error).message); }
    images.set(h, img);
    return img;
  };
  const meshes: Mesh[] = [], missingTex = new Set<number>();
  let nNormal = 0;
  for (const b of list) {
    const t = tex.get(b.tex), img = image(b.tex), name = t?.name ?? `0x${b.tex.toString(16).padStart(8, '0')}`;
    if (!t) missingTex.add(b.tex);
    const m: Mesh = {
      name, texture: name, vertexCount: b.nv, pos: b.pos, nor: b.nor, uv: b.uv, indices: b.nv > 65535 ? b.idx : Uint16Array.from(b.idx),
      bone: new Float32Array(0), weight: new Float32Array(0), skinned: false,
    };
    if (img) { m.image = img; if (hasAlpha(img)) m.alphaTest = true; } else m.color = [0.55, 0.55, 0.55];
    // карта нормалей — слот 1 подмеша (ATI2, …_N / _NOR / _NORMAL)
    const nt = b.normal ? tex.get(b.normal) : undefined;
    if (nt && /_N(OR(MAL)?)?$/i.test(nt.name)) { const ni = image(b.normal); if (ni) { m.normalImage = ni; m.normalMap = nt.name; nNormal++; } }
    // запечённый свет (цвет вершин): у части объектов его нет — тогда 128 (без изменений)
    if (b.shade.some((v, k) => (k & 3) !== 3 && Math.abs(v - 128) > 1)) m.vertexShade = b.shade;
    if (panList.has(b)) { m.name = `панорама · ${name}`; m.defaultHidden = true; }
    if (oceanList.has(b)) m.name = `океан · ${name}`;
    // спрайты эффектов (вспышки огней, SFX_*) — карточки без шейдера игры
    if (/^sfx_/i.test(name)) m.defaultHidden = true;
    meshes.push(m);
  }
  if (!meshes.length) throw new Error('NFS World: в файле трассы нет расставленных объектов');
  info.push(
    `Need for Speed: World — ${city ? `город ${base.toUpperCase()} целиком (${sections.length} секций)` : `секция ${main.name}`}: экземпляров ${nInst}, показано ${drawn}, мешей ${meshes.length}, вершин ${sumVerts(meshes)}, треугольников ${sumTris(meshes)}`,
    `Текстуры: найдено ${tex.size} из ${texUsed.size} ${nNormal ? ` (с картами нормалей; мешей с ними: ${nNormal})` : ''}, запечённый свет — цветом вершин${city ? `, уменьшены до ${maxTex} px` : ''}${missingTex.size ? `; нет ${missingTex.size} (показаны серым): ${[...missingTex].slice(0, 8).map((h) => h.toString(16).padStart(8, '0')).join(', ')}${missingTex.size > 8 ? '…' : ''}` : ''}`,
  );
  if (skippedBudget) info.push(`Бюджет ${(budget / 1e6).toFixed(0)} млн треугольников (вся расстановка — ${(demand / 1e6).toFixed(1)} млн: нарезка ${(byRank[0]! / 1e6).toFixed(1)}, панорама ${(byRank[1]! / 1e6).toFixed(1)}, экземпляры ${(byRank[2]! / 1e6).toFixed(1)}): пропущено мелких экземпляров ${skippedBudget}`);
  if (lowLod) info.push(`Упрощённые LOD у экземпляров: ${lowLod}`);
  if (nShadow) info.push(`Скрыта теневая геометрия (SHADOW_*): ${nShadow}`);
  if (batches.bad + panB.bad + oceanB.bad) info.push(`Пропущены подмеши с испорченными вершинами: ${batches.bad + panB.bad + oceanB.bad}`);
  if (panList.size) info.push('Дальняя панорама (горы и острова на горизонте, PAN_*) скрыта — включается в списке мешей');
  if (missingObj.size) {
    const names = [...new Set(wanted.filter((w) => missingObj.has(w.solid)).map((w) => w.name))];
    info.push(`Объекты не найдены: ${missingObj.size} (${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''})`);
  }
  if (failed.size) info.push(`Не декодированы: ${[...failed].slice(0, 4).join('; ')}`);
  if (!index && !city) info.push('Общие объекты и текстуры лежат в соседних файлах STREAM…_0x*.BUN: откройте «Папку игры», чтобы их подхватить');
  info.push(`Время загрузки: ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  return { meshes, skeleton: null, motions: [], bounds: robustBounds(meshes.some((m) => !m.defaultHidden && !m.name.startsWith('океан')) ? meshes.filter((m) => !m.defaultHidden && !m.name.startsWith('океан')) : meshes), flipZ: false, defaultZUp: true, cameraYaw: 0, info };
}

/** Треугольники объекта по таблице подмешей (без разбора вершин). */
export function objectTris(o: Uint8Array): number {
  const dv = new DataView(o.buffer, o.byteOffset, o.byteLength);
  let n = 0;
  for (const c of bbFind(o, 0, o.length, 0x134b02, 3))
    for (let p = skipPad(o, c.off, c.off + c.size); p + SUB_SIZE <= c.off + c.size; p += SUB_SIZE) n += dv.getUint32(p + 68, true) / 3;
  return Math.floor(n);
}
const SUB_SIZE = 116;

/** Габариты без редких выбросов (одиночные объекты в километрах от города): 0.2–99.8 % вершин по каждой оси. */
function robustBounds(meshes: Mesh[]): ReturnType<typeof boundsOf> {
  const full = boundsOf(meshes), n = meshes.reduce((a, m) => a + m.vertexCount, 0);
  if (n < 5000) return full;
  const step = Math.max(1, Math.floor(n / 200000)), ax: number[][] = [[], [], []];
  let k = 0;
  for (const m of meshes) for (let v = 0; v < m.vertexCount; v++, k++) if (k % step === 0) for (let c = 0; c < 3; c++) ax[c]!.push(m.pos[v * 3 + c]!);
  const min = [0, 0, 0], max = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = ax[c]!.sort((x, y) => x - y), lo = a[Math.floor(a.length * 0.002)]!, hi = a[Math.ceil(a.length * 0.998) - 1]!;
    min[c] = Math.max(full.min[c]!, lo); max[c] = Math.min(full.max[c]!, hi);
  }
  return { ...full, min, max } as ReturnType<typeof boundsOf>;
}

function hasAlpha(img: DecodedImage): boolean {
  const d = img.rgba;
  if (!d) return false;
  let n = 0;
  for (let i = 3; i < d.length; i += 16) if (d[i]! < 128) n++;
  return n > d.length / 16 * 0.02;
}
