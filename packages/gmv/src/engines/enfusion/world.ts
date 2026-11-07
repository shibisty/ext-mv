// Миры Enfusion (worlds/<мир>/<мир>.ent): ландшафт (.terr + тайлы .ttile с высотами и цветом _supertexture.edds),
// объекты — экземпляры префабов, дороги, реки, озёра и провода ЛЭП из двоичного .ent («EBIN»).
// EBIN v1: u16 строк, u16 ссылок; строки {u16 длина, символы} — имена классов и ключей; ссылки — u64 GUID ресурсов
// (путь — по resourceDatabase.rdb рядом с архивами). Дальше дерево сущностей:
//   сущность = 0x0D u16 класс [0x43 u16 имя] [0x0D 01 00 05 u16 префаб] тело;
//   группа  = 0x0D <$grp> 0x0D u16 класс [0x0D 01 00 05 u16 префаб] 0x0E u32 размер, внутри — тела ([0x43 имя]) подряд;
//   тело    = 0x0E u32 размер + 3 байта, свойства «0x0D u16 ключ, u8 тип, значение» и в конце, если есть,
//             блок детей «0x0E u32 размер» с сущностями (их coords/angles — относительно родителя).
// Типы значений: 01 — u32 (перечисление), 02 — 8 байт, 05 — u16 (ссылка на GUID), 06 — f32, 07 — vec2, 08 — vec3, 09 — vec4,
// 0B — bool, 0C/43 — строка u16; 0E — список объектов «0x0D u16 класс, 0x44 u64 id | 0x45 u16, тело» либо блок данных;
// 0x0D — объект с классом (u16 класс, 0x44/0x45, тело); 0x44 / 0x45 — объект без класса.
// Разобрано по файлам игры.
import { boundsOf, sumTris } from '../../core/geometry';
import { LevelBuilder } from '../../core/levelbuilder';
import type { LoadContext } from '../../core/plugin';
import type { Archive, ArchiveEntry, DecodedImage, Mesh, Model, TerrainLayers, VFile } from '../../core/types';
import { decodeEdds } from './edds';
import { enfTextures, loadTexture, parseEmat } from './emat';
import { enfusionPath, readPakEntry, readPakHead, type PakEntry } from './pak';
import { collectParts, quatMat, slotMat } from './prefab';
import { parseXobHead, xobChunks, xobMeshes } from './xob';
import { ebF32, ebU, ebVec, splineMeshes, type Ebin, type EbinEntity, type EbinInstance, type EbinObj, type EbinVal } from './splines';
export type { Ebin, EbinEntity, EbinInstance, EbinObj, EbinVal } from './splines';

const tag4 = (u: Uint8Array, p: number) => String.fromCharCode(u[p]!, u[p + 1]!, u[p + 2]!, u[p + 3]!);
const be32 = (u: Uint8Array, p: number) => ((u[p]! << 24) | (u[p + 1]! << 16) | (u[p + 2]! << 8) | u[p + 3]!) >>> 0;

const FIX: Record<number, number> = { 0x01: 4, 0x02: 8, 0x03: 1, 0x04: 2, 0x05: 2, 0x06: 4, 0x07: 8, 0x08: 12, 0x09: 16, 0x0a: 8, 0x0b: 1 };

const mul4 = (a: Float64Array, b: Float64Array): Float64Array => {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!; o[c * 4 + r] = s; }
  return o;
};
const IDENT = (): Float64Array => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };

export function parseEbin(u: Uint8Array): Ebin {
  if (tag4(u, 0) !== 'EBIN') throw new Error('Не мир Enfusion (нет EBIN)');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), dec = new TextDecoder('latin1');
  const u16 = (q: number) => dv.getUint16(q, true), u32 = (q: number) => dv.getUint32(q, true);
  const ns = u16(8), ng = u16(10);
  let p = 12;
  const strings: string[] = [];
  for (let i = 0; i < ns; i++) { const n = u16(p); strings.push(dec.decode(u.subarray(p + 2, p + 2 + n))); p += 2 + n; }
  const guids: bigint[] = [];
  for (let i = 0; i < ng; i++, p += 8) guids.push(dv.getBigUint64(p, true));
  const S = (i: number) => strings[i] ?? `#${i}`, kGrp = strings.indexOf('$grp'), kCol = strings.indexOf(':');
  // «: ссылка» — наследование от префаба (номер GUID); номер строки «:» в разных файлах разный
  const isRef = (q: number) => kCol >= 0 && u[q] === 0x0d && u16(q + 1) === kCol && u[q + 3] === 5;
  const entities: EbinEntity[] = [];
  const fail = (q: number, what: string): never => { throw new Error(`EBIN: ${what} @${q}`); };

  const object = (q: number, cls: string): { obj: EbinObj; end: number } => {
    const st = u[q]!;
    // класс строкой прямо в объекте (0x43 u16 имя) — когда его нет в таблице строк
    if (st === 0x43) { const n = u16(q + 1); cls = dec.decode(u.subarray(q + 3, q + 3 + n)); q += 3 + n; }
    else q += st === 0x44 ? 9 : st === 0x45 ? 3 : st === 0x0e ? 0 : fail(q, `объект ${st}`);
    if (isRef(q)) q += 6;
    // «+ { … }» и подобные: блок с массивом значений (0x80 | тип, u32 число, значения) — без тела объекта
    if (u[q] === 0x0e && u[q + 5]! >= 0x80) return { obj: { cls, props: new Map() }, end: q + 1 + u32(q + 1) };
    if (u[q] !== 0x0e) return { obj: { cls, props: new Map() }, end: q };
    const b = body(q, -1);
    return { obj: { cls, props: b.props }, end: b.end };
  };
  // тело: свойства и, если parent ≥ −1 и встретился блок детей, — дочерние сущности
  const body = (q: number, owner: number): { props: Map<string, EbinVal>; end: number } => {
    if (u[q] !== 0x0e) fail(q, 'нет тела');
    const end = q + 1 + u32(q + 1), props = new Map<string, EbinVal>();
    let r = q + 8;
    while (r < end) {
      if (u[r] === 0x0e) { // дети
        const cend = r + 1 + u32(r + 1);
        let c = r + 5;
        while (c < cend) c = entity(c, owner);
        r = cend; continue;
      }
      if (u[r] !== 0x0d) fail(r, 'свойство');
      const key = S(u16(r + 1)), ty = u[r + 3]!;
      r += 4;
      if (FIX[ty]) { props.set(key, u.subarray(r, r + FIX[ty]!)); r += FIX[ty]!; }
      else if (ty >= 0x80) { // массив значений: u32 число, значения (строки — с u16 длиной)
        const n = u32(r), el = ty & 0x7f;
        r += 4;
        if (FIX[el]) r += n * FIX[el]!;
        else if (el === 0x0c || el === 0x43) for (let k = 0; k < n; k++) r += 2 + u16(r);
        else fail(r, `массив типа ${el}`);
      }
      else if (ty === 0x0c || ty === 0x43) { const n = u16(r); props.set(key, u.subarray(r + 2, r + 2 + n)); r += 2 + n; }
      else if (ty === 0x0e) {
        const bend = r + u32(r);
        let s = r + 4;
        if (s + 4 <= bend && u[s] === 0x0d && (u[s + 3] === 0x44 || u[s + 3] === 0x45 || u[s + 3] === 0x43 || u[s + 3] === 0x0e)) {
          const list: EbinObj[] = [];
          while (s < bend) { if (u[s] !== 0x0d) fail(s, 'элемент'); const o = object(s + 3, S(u16(s + 1))); list.push(o.obj); s = o.end; }
          props.set(key, list);
        } else props.set(key, u.subarray(r + 4, bend));
        r = bend;
      } else if (ty === 0x0d) { const o = object(r + 2, S(u16(r))); props.set(key, o.obj); r = o.end; }
      else if (ty === 0x44 || ty === 0x45) { const o = object(r - 1, ''); props.set(key, o.obj); r = o.end; }
      else fail(r, `тип ${ty} (${key})`);
    }
    return { props, end };
  };
  const place = (props: Map<string, EbinVal>, parent: number): Float64Array => {
    const m = slotMat(ebVec(props.get('coords')), ebVec(props.get('angles')));
    const sc = ebF32(props.get('scale'));
    if (sc && Number.isFinite(sc) && sc > 0 && sc !== 1) for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = m[c * 4 + r]! * sc;
    return parent >= 0 ? mul4(entities[parent]!.world, m) : m;
  };
  const one = (q: number, cls: string, name: string, ref: number, parent: number): number => {
    const idx = entities.length;
    entities.push({ cls, name, ref, props: new Map(), parent, world: IDENT() });
    // coords нужны до детей: тело разбирается целиком, дети получают мир родителя после
    const b = body(q, idx);
    const e = entities[idx]!;
    e.props = b.props; e.world = place(b.props, parent);
    for (let k = idx + 1; k < entities.length; k++) { const c = entities[k]!; if (c.parent === idx) fixWorld(k); }
    return b.end;
  };
  const fixWorld = (k: number): void => {
    const c = entities[k]!;
    c.world = place(c.props, c.parent);
    for (let j = k + 1; j < entities.length; j++) if (entities[j]!.parent === k) fixWorld(j);
  };
  const entity = (q: number, parent: number): number => {
    if (u[q] !== 0x0d) fail(q, 'сущность');
    let cls = u16(q + 1);
    q += 3;
    if (cls === kGrp) {
      cls = u16(q + 1); q += 3;
      let ref = -1;
      if (isRef(q)) { ref = u16(q + 4); q += 6; }
      const gend = q + 1 + u32(q + 1);
      q += 5;
      while (q < gend) {
        let name = '', r2 = ref;
        if (u[q] === 0x43) { const n = u16(q + 1); name = dec.decode(u.subarray(q + 3, q + 3 + n)); q += 3 + n; }
        if (isRef(q)) { r2 = u16(q + 4); q += 6; }
        q = one(q, S(cls), name, r2, parent);
      }
      return gend;
    }
    let name = '', ref = -1;
    if (u[q] === 0x43) { const n = u16(q + 1); name = dec.decode(u.subarray(q + 3, q + 3 + n)); q += 3 + n; }
    if (isRef(q)) { ref = u16(q + 4); q += 6; }
    return one(q, S(cls), name, ref, parent);
  };
  // неизвестная конструкция — оставляем разобранное до неё (обычно это почти весь мир)
  let error: string | undefined;
  let safe = 0;
  try { while (p < u.length) { p = entity(p, -1); safe = entities.length; } }
  catch (e) { if (!safe) throw e; error = (e as Error).message; entities.length = safe; }
  const instances: EbinInstance[] = [];
  entities.forEach((e, i) => {
    if (e.ref < 0 || e.ref >= guids.length) return;
    const sc = ebF32(e.props.get('scale'));
    instances.push({ ref: e.ref, coords: ebVec(e.props.get('coords')), angles: ebVec(e.props.get('angles')), scale: sc && sc > 0 && Number.isFinite(sc) ? sc : 1, world: e.world, entity: i });
  });
  return { strings, guids, entities, instances, error };
}

/** resourceDatabase.rdb: записи «путь\0, u32 тип (6 — файл), u16, u64 GUID» → GUID → путь. */
export function parseRdb(u: Uint8Array, out = new Map<bigint, string>()): Map<bigint, string> {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), dec = new TextDecoder('latin1');
  for (let i = 8; i + 15 < u.length; i++) {
    if (u[i] !== 0 || u[i + 1] !== 6 || u[i + 2] !== 0 || u[i + 3] !== 0 || u[i + 4] !== 0 || u[i + 5] !== 0 || u[i + 6] !== 0) continue;
    // имя заканчивается на i; его длина (с \0) записана u32 перед ним
    let s = i - 1;
    while (s > 0 && u[s - 1] !== 0 && i - s < 300) s--;
    for (let k = s; k < i - 1; k++) {
      if (k >= 4 && dv.getUint32(k - 4, true) === i - k + 1) { out.set(dv.getBigUint64(i + 7, true), dec.decode(u.subarray(k, i))); break; }
    }
    i += 14;
  }
  return out;
}

// ---------- ландшафт ----------
interface Terr { verts: number; cell: number; hScale: number; hOffset: number }
function parseTerr(u: Uint8Array): Terr {
  if (tag4(u, 0) !== 'FORM' || tag4(u, 8) !== 'TERR') throw new Error('Не ландшафт Enfusion (нет FORM/TERR)');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  for (let p = 12; p + 8 <= u.length; p += 8 + be32(u, p + 4)) if (tag4(u, p) === 'HEAD') {
    return { verts: dv.getUint32(p + 8, true), cell: dv.getFloat32(p + 24, true), hScale: dv.getFloat32(p + 28, true), hOffset: dv.getFloat32(p + 32, true) };
  }
  throw new Error('TERR: нет HEAD');
}
function tileHeights(u: Uint8Array): { n: number; h: Uint16Array } | null {
  if (tag4(u, 0) !== 'FORM' || tag4(u, 8) !== 'TERR') return null;
  for (let p = 12; p + 8 <= u.length; p += 8 + be32(u, p + 4)) if (tag4(u, p) === 'HGHT') {
    const size = be32(u, p + 4), n = Math.round(Math.sqrt(size / 2));
    const h = new Uint16Array(n * n), dv = new DataView(u.buffer, u.byteOffset + p + 8, size);
    for (let i = 0; i < n * n; i++) h[i] = dv.getUint16(i * 2, true);
    return { n, h };
  }
  return null;
}

/** Список материалов поверхности ландшафта (.terr MATS): u16, затем {u32 длина, «{GUID}путь.emat\0»}. */
export function parseTerrMats(u: Uint8Array): string[] {
  if (tag4(u, 0) !== 'FORM' || tag4(u, 8) !== 'TERR') return [];
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), dec = new TextDecoder('latin1'), out: string[] = [];
  for (let p = 12; p + 8 <= u.length; p += 8 + be32(u, p + 4)) if (tag4(u, p) === 'MATS') {
    const end = p + 8 + be32(u, p + 4);
    for (let q = p + 10; q + 4 <= end;) { const n = dv.getUint32(q, true); if (q + 4 + n > end) break; out.push(dec.decode(u.subarray(q + 4, q + 4 + n)).replace(/\0+$/, '')); q += 4 + n; }
  }
  return out;
}

/**
 * Карта материалов тайла (TMAT): блоки «BMAT» по 64×64 текселя (u32 BE размер; u16 bx, bz — номер блока в мире;
 * u16 N, N×u16 материалы .terr), дальше квадродерево: u16 узлов, u16 корень, по 4 кода на узел, u16 «сырых» листьев,
 * u32 их текселей, биты (ceil(log2 N) на тексель, младший бит первым, строки сверху вниз). Код: 0x8000|v — лист
 * с материалом v, 0x4000|i — сырой лист i, иначе — узел. Порядок детей: (0,0), (1,0), (0,1), (1,1).
 * onBlock получает номер блока и 4096 номеров материалов .terr.
 */
/** Для отладки: сообщения о повреждённых блоках. */
export let tmatDebug: ((bx: number, bz: number, n: number, msg: string) => void) | null = null;
export const setTmatDebug = (f: typeof tmatDebug): void => { tmatDebug = f; };
export function decodeTmat(u: Uint8Array, onBlock: (bx: number, bz: number, ids: Uint8Array) => void): void {
  if (tag4(u, 0) !== 'FORM' || tag4(u, 8) !== 'TERR') return;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let off = -1, end = 0;
  for (let p = 12; p + 8 <= u.length; p += 8 + be32(u, p + 4)) if (tag4(u, p) === 'TMAT') { off = p + 8; end = off + be32(u, p + 4); }
  if (off < 0) return;
  for (let q = off; q + 8 <= end;) {
    if (tag4(u, q) !== 'BMAT') break;
    const size = be32(u, q + 4), b = q + 8;
    q = b + size;
    const bx = dv.getUint16(b, true), bz = dv.getUint16(b + 2, true), n = dv.getUint16(b + 4, true);
    const mats: number[] = [];
    for (let k = 0; k < n; k++) mats.push(dv.getUint16(b + 6 + k * 2, true));
    const ids = new Uint8Array(4096).fill(mats[0] ?? 0);
    if (n > 1) try {
      let r = b + 6 + n * 2;
      const nNodes = dv.getUint16(r, true), root = dv.getUint16(r + 2, true), codes = r + 4;
      r = codes + nNodes * 8;
      // без сырых листьев хвоста (u16 + u32) нет — блок кончается на кодах
      const nRaw = r + 6 <= q ? dv.getUint16(r, true) : 0;
      const raw = r + 6, bpi = Math.ceil(Math.log2(n)), leaves: Array<[number, number, number]> = [];
      const walk = (code: number, x: number, z: number, s: number, depth: number): void => {
        if (code & 0x8000) { const v = mats[code & 0x7fff] ?? mats[0]!; for (let j = 0; j < s; j++) ids.fill(v, (z + j) * 64 + x, (z + j) * 64 + x + s); }
        else if (code & 0x4000) leaves[code & 0x3fff] = [x, z, s];
        else if (code < nNodes && depth < 7 && s > 1) { const h = s >> 1; for (let k = 0; k < 4; k++) walk(dv.getUint16(codes + (code * 4 + k) * 2, true), x + (k & 1) * h, z + (k >> 1) * h, h, depth + 1); }
      };
      walk(root, 0, 0, 64, 0);
      let bit = 0;
      for (let li = 0; li < nRaw; li++) {
        const L = leaves[li];
        if (!L) break;
        const [x, z, s] = L;
        for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
          let v = 0;
          for (let k = 0; k < bpi; k++, bit++) { const by = raw + (bit >> 3); if (by < q) v |= ((u[by]! >> (bit & 7)) & 1) << k; }
          ids[(z + j) * 64 + x + i] = mats[v] ?? mats[0]!;
        }
      }
    } catch (e) { if (tmatDebug) tmatDebug(bx, bz, n, (e as Error).message); }
    onBlock(bx, bz, ids);
  }
}

const findEntry = (ctx: LoadContext, pred: (p: string) => boolean): { a: Archive; e: ArchiveEntry } | null => {
  for (const a of ctx.archives) for (const e of a.entries) if (pred(e.path)) return { a, e };
  return null;
};

/** Высота показанного ландшафта (та же сетка, что у мешей; билинейно) — по ней ложатся дороги и вода. */
export type HeightAt = (x: number, z: number) => number | null;

/** Слои TerrainMaterial: BCRMap (до 512 px, приводится к 512×512), ScaleUV — период, SatMapBlend — подкраска, DetailMaxDistance. */
async function terrainLayers(ctx: LoadContext, paths: string[], info: string[]): Promise<TerrainLayers | undefined> {
  const S = 512, SM = 256, images: DecodedImage[] = [], normals: DecodedImage[] = [], middle: DecodedImage[] = [];
  const period: number[] = [], tint: number[] = [], mean: Array<[number, number, number]> = [], names: string[] = [];
  const midPeriod: number[] = [], midBlend: number[] = [], midMean: Array<[number, number, number]> = [];
  let fade = 0, bad = 0, haveN = 0, haveM = 0;
  // приведение к size×size (ближайший пиксель) и средний цвет
  const fit = (img: DecodedImage | null, size: number, fill: [number, number, number, number]): { img: DecodedImage; mean: [number, number, number] } | null => {
    const px = new Uint8Array(size * size * 4), m: [number, number, number] = [0, 0, 0];
    if (!img?.rgba) { for (let i = 0; i < px.length; i += 4) px.set(fill, i); return null; }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const si = (Math.floor((y * img.height) / size) * img.width + Math.floor((x * img.width) / size)) * 4, di = (y * size + x) * 4;
      px[di] = img.rgba[si]!; px[di + 1] = img.rgba[si + 1]!; px[di + 2] = img.rgba[si + 2]!; px[di + 3] = img.rgba[si + 3]!;
      m[0] += px[di]!; m[1] += px[di + 1]!; m[2] += px[di + 2]!;
    }
    for (let c = 0; c < 3; c++) m[c] = m[c]! / (size * size * 255);
    return { img: { width: size, height: size, rgba: px, name: img.name }, mean: m };
  };
  for (const path of paths) {
    let props = new Map<string, string>(), ref: string | undefined = path;
    for (let guard = 0; ref && guard < 4; guard++) { // наследование материала
      const u = await ctx.readPath(enfusionPath(ref)).catch(() => null);
      if (!u) break;
      const e = parseEmat(new TextDecoder().decode(u));
      props = new Map([...e.props, ...props]);
      ref = props.has('BCRMap') ? undefined : e.parent;
    }
    const tex = async (k: string, size: number) => (props.get(k) ? await loadTexture(props.get(k), ctx, size).catch(() => null) : null);
    const b = fit(await tex('BCRMap', S), S, [128, 128, 128, 255]);
    if (b) { b.img.rgba!.forEach((_, i, a) => { if (i % 4 === 3) a[i] = 255; }); images.push(b.img); mean.push(b.mean); }
    else { bad++; images.push({ width: S, height: S, rgba: new Uint8Array(S * S * 4).fill(128) }); mean.push([0.5, 0.5, 0.5]); }
    const n = fit(await tex('NHOMap', S), S, [128, 128, 128, 255]);
    if (n) haveN++;
    normals.push(n?.img ?? { width: S, height: S, rgba: new Uint8Array(S * S * 4).map((_, i) => (i % 4 === 3 ? 255 : 128)) });
    const mb = Math.min(1, Math.max(0, Number(props.get('MiddleBCRBlend') ?? 0) * 0.5));
    const md = mb > 0 ? fit(await tex('BCRMiddleMap', SM), SM, [128, 128, 128, 255]) : null;
    if (md) haveM++;
    middle.push(md?.img ?? { width: SM, height: SM, rgba: new Uint8Array(SM * SM * 4).fill(128) });
    midMean.push(md?.mean ?? [0.5, 0.5, 0.5]);
    midBlend.push(md ? mb : 0);
    midPeriod.push(Number(props.get('MiddleScaleUV') ?? 75) || 75);
    period.push(Number(props.get('ScaleUV') ?? 4) || 4);
    tint.push(Math.min(1, Math.max(0, Number(props.get('SatMapBlend') ?? 0.5))));
    names.push(path.replace(/^.*\//, '').replace(/\.emat$/i, ''));
    fade = Math.max(fade, Number(props.get('DetailMaxDistance') ?? 0) || 0);
  }
  if (bad) info.push(`Поверхности ландшафта: у ${bad} слоёв не загрузилась текстура`);
  if (!images.length) return undefined;
  info.push(`Слои ландшафта: нормали у ${haveN}, средний масштаб у ${haveM} из ${images.length}`);
  return { images, period, tint, mean, fade: Math.max(60, fade || 150), names, normals: haveN ? normals : undefined, middle: haveM ? middle : undefined, midPeriod, midBlend, midMean };
}

async function terrainMeshes(ctx: LoadContext, worldDir: string, step: number, info: string[], out?: { heightAt?: HeightAt; min?: number; size?: number; layers?: TerrainLayers }): Promise<Mesh[]> {
  const terr = findEntry(ctx, (p) => p.startsWith(worldDir) && p.endsWith('.terr'));
  if (!terr) { info.push('Ландшафт: .terr не найден'); return []; }
  const T = parseTerr(await terr.a.read(terr.e));
  // шаг сетки: наименьшая степень двойки, при которой ландшафт не больше 1,2 млн треугольников
  if (!step) { step = 1; while (2 * ((T.verts - 1) / step) ** 2 > 1_200_000 && step < 64) step *= 2; }
  const tdir = terr.e.path.replace(/[^/]*$/, '') + '.data/', stem = terr.e.path.replace(/^.*\//, '').replace(/\.terr$/, '');
  const terrBytes = await terr.a.read(terr.e), matPaths = parseTerrMats(terrBytes);
  const first = terr.a.lookup(`${tdir}${stem}_0.ttile`), tu0 = first ? await terr.a.read(first) : null, th0 = tu0 ? tileHeights(tu0) : null;
  if (!th0) { info.push('Ландшафт: тайлы .ttile не найдены'); return []; }
  const q = th0.n - 1, tps = Math.max(1, Math.round((T.verts - 1) / q)), m = Math.floor(q / step) + 1, G = tps * (m - 1) + 1;
  // цветовая карта: всего ~16 млн пикселей на мир (Arland — 256 px на тайл, Everon — 64), тайлы сводятся в блоки
  // до 16×16 блоков на мир, у блока — одна текстура (меньше мешей и вызовов отрисовки)
  let side = 256;
  while (side > 32 && tps * tps * side * side > 16_777_216) side >>= 1;
  const k = Math.max(1, Math.ceil(tps / 16)), nb = Math.ceil(tps / k);
  const grid = new Float32Array(G * G).fill(NaN), atlases: Array<Uint8Array | null> = new Array(nb * nb).fill(null);
  // карта материалов (TMAT): блоки 64×64 текселя, тайл — bpt×bpt блоков; всего до ~32 млн текселей (шаг f)
  let bpt = 0;
  if (tu0 && matPaths.length) { let c = 0; decodeTmat(tu0, () => { c++; }); bpt = Math.round(Math.sqrt(c)); }
  const TT = bpt * 64;
  let fdn = 1;
  while (TT && tps * tps * (TT / fdn) ** 2 > 33_554_432 && fdn < 16) fdn *= 2;
  const IW = TT ? (k * TT) / fdn : 0, indexMaps: Array<Uint8Array | null> = new Array(nb * nb).fill(null);
  const layerOf = new Map<number, number>(), layerMats: number[] = [];
  let minH = Infinity, loaded = 0;
  for (let t = 0; t < tps * tps; t++) {
    const e = t ? terr.a.lookup(`${tdir}${stem}_${t}.ttile`) : first;
    const tu = !e ? null : t ? await terr.a.read(e) : tu0, th = !tu ? null : t ? tileHeights(tu) : th0;
    if (!th || th.n !== th0.n) continue;
    const tx = t % tps, tz = Math.floor(t / tps);
    if (TT && tu) decodeTmat(tu, (bx, bz, ids) => {
      const gx = bx * 64, gz = bz * 64, B = Math.floor(bz / bpt / k) * nb + Math.floor(bx / bpt / k);
      if (B < 0 || B >= nb * nb) return;
      let im = indexMaps[B];
      if (!im) indexMaps[B] = im = new Uint8Array(IW * IW);
      const ox = gx - Math.floor(bx / bpt / k) * k * TT, oz = gz - Math.floor(bz / bpt / k) * k * TT;
      for (let j = 0; j < 64; j += fdn) for (let i = 0; i < 64; i += fdn) {
        const g = ids[j * 64 + i]!;
        let L = layerOf.get(g);
        if (L === undefined) { L = layerMats.length < 32 ? layerMats.length : 0; if (layerMats.length < 32) { layerOf.set(g, L); layerMats.push(g); } }
        im[((oz + j) / fdn) * IW + (ox + i) / fdn] = L;
      }
    });
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const h = th.h[Math.min(q, j * step) * th.n + Math.min(q, i * step)]! * T.hScale + T.hOffset;
      grid[(tz * (m - 1) + j) * G + tx * (m - 1) + i] = h;
      if (h < minH) minH = h;
    }
    loaded++;
    const st = terr.a.lookup(`${tdir}${stem}_${t}_supertexture.edds`);
    if (!st) continue;
    try {
      const img = decodeEdds((await terr.a.read(st)).slice().buffer, side), px = img.rgba;
      if (!px) continue;
      const bi = Math.floor(tz / k) * nb + Math.floor(tx / k), W = k * side;
      let at = atlases[bi];
      if (!at) { at = new Uint8Array(W * W * 4); for (let x = 0; x < at.length; x += 4) { at[x] = 107; at[x + 1] = 115; at[x + 2] = 84; at[x + 3] = 255; } atlases[bi] = at; }
      const ox = (tx % k) * side, oy = (tz % k) * side;
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const sx = Math.min(img.width - 1, Math.floor((x * img.width) / side)), sy = Math.min(img.height - 1, Math.floor((y * img.height) / side));
        const si = (sy * img.width + sx) * 4, di = ((oy + y) * W + ox + x) * 4;
        at[di] = px[si]!; at[di + 1] = px[si + 1]!; at[di + 2] = px[si + 2]!; at[di + 3] = 255;
      }
    } catch { /* без цвета */ }
  }
  const { computeNormals } = await import('../../core/geometry');
  const meshes: Mesh[] = [], cs = step * T.cell;
  for (let bz = 0; bz < nb; bz++) for (let bx = 0; bx < nb; bx++) {
    const tx0 = bx * k, tz0 = bz * k, kx = Math.min(k, tps - tx0), kz = Math.min(k, tps - tz0);
    const mx = kx * (m - 1) + 1, mz = kz * (m - 1) + 1, gx0 = tx0 * (m - 1), gz0 = tz0 * (m - 1);
    const pos = new Float32Array(mx * mz * 3), uv = new Float32Array(mx * mz * 2), idx: number[] = [];
    for (let j = 0; j < mz; j++) for (let i = 0; i < mx; i++) {
      const v = j * mx + i, h = grid[(gz0 + j) * G + gx0 + i]!;
      pos[v * 3] = (gx0 + i) * cs; pos[v * 3 + 1] = Number.isFinite(h) ? h : 0; pos[v * 3 + 2] = (gz0 + j) * cs;
      // строка изображения = строка высот (сверху вниз); блок в атласе k×k тайлов
      uv[v * 2] = i / ((m - 1) * k); uv[v * 2 + 1] = j / ((m - 1) * k);
    }
    for (let j = 0; j < mz - 1; j++) for (let i = 0; i < mx - 1; i++) {
      if (!Number.isFinite(grid[(gz0 + j) * G + gx0 + i]!)) continue;
      const a = j * mx + i, b = a + 1, c = a + mx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    if (!idx.length) continue;
    const ind = new Uint32Array(idx), at = atlases[bz * nb + bx];
    const mesh: Mesh = { name: `Ландшафт · блок ${bx},${bz}`, texture: '', vertexCount: mx * mz, pos, nor: computeNormals(pos, ind), uv, bone: new Float32Array(0), weight: new Float32Array(0), indices: ind, skinned: false, color: [0.42, 0.45, 0.33] };
    if (at) { const W = k * side; mesh.image = { width: W, height: W, rgba: at, name: `${stem} supertexture ${bx},${bz}` } as DecodedImage; mesh.texture = mesh.image.name!; delete mesh.color; }
    const im = indexMaps[bz * nb + bx];
    if (im) mesh.terrainIndex = { width: IW, height: IW, data: im };
    meshes.push(mesh);
  }
  if (out && layerMats.length) {
    const t0 = Date.now();
    out.layers = await terrainLayers(ctx, layerMats.map((g) => matPaths[g] ?? ''), info);
    info.push(`Поверхности ландшафта: ${layerMats.length} слоёв, карта ${(TT / fdn) || 0} текселей на тайл (${(((th0.n - 1) * T.cell * fdn) / TT).toFixed(1)} м на тексель), ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  }
  if (out) {
    const g = grid, n = G;
    out.heightAt = (x, z) => {
      const fx = x / cs, fz = z / cs, i = Math.floor(fx), j = Math.floor(fz);
      if (i < 0 || j < 0 || i >= n - 1 || j >= n - 1) return null;
      const a = g[j * n + i]!, b = g[j * n + i + 1]!, c = g[(j + 1) * n + i]!, d = g[(j + 1) * n + i + 1]!, u = fx - i, v = fz - j;
      const h = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
      return Number.isFinite(h) ? h : null;
    };
    out.min = minH; out.size = (n - 1) * cs;
  }
  info.push(`Ландшафт: ${T.verts}×${T.verts} вершин, шаг ${T.cell} м (${((T.verts - 1) * T.cell / 1000).toFixed(1)} км), тайлов ${loaded}, показан с шагом ${cs} м, цвет — ${side} px на тайл, блоков ${meshes.length}`);
  return meshes;
}

// ---------- объекты ----------
// мелкие повторяющиеся объекты: растительность, камни, сорняки, мусор — самый простой LOD и прореживание по бюджету
const VEG = /prefabs\/(vegetation|rocks|clutter)\/|\/vegetation\/|weeds|debris|stump|brickpile|rubble|grass/i;

/**
 * Сгенерированная растительность и камни мира (<мир>.wst, FORM «WSTR»): VERS; PREF — пути префабов (u32 длина + строка
 * с \0); HEAD — i32 границы (мин. x, z, макс. x, z), u16 ячеек по X и Z, u32 размер ячейки, затем по ячейке 16 байт
 * {u32 номер, u32 групп, u32 экземпляров, u32 смещение в файле}; GRID — ячейки: группы {u32 конец (номер экземпляра),
 * u32 префаб}, экземпляры по 36 байт {позиция 3×f32, масштаб f32, кватернион x, y, z, w f32, u32 флаги}.
 * Разобрано по файлам игры (Everon — 1,1 млн экземпляров).
 */
export interface Wst { prefabs: string[]; /** по 8 чисел на экземпляр: x, y, z, масштаб, кватернион */ data: Float32Array; prefab: Uint16Array }
export function parseWst(u: Uint8Array): Wst {
  if (tag4(u, 0) !== 'FORM' || tag4(u, 8) !== 'WSTR') throw new Error('Не .wst (нет FORM/WSTR)');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), dec = new TextDecoder('latin1');
  const ch = new Map<string, { off: number; size: number }>();
  for (let p = 12; p + 8 <= u.length; p += 8 + be32(u, p + 4)) ch.set(tag4(u, p), { off: p + 8, size: be32(u, p + 4) });
  const pref = ch.get('PREF'), head = ch.get('HEAD');
  if (!pref || !head) throw new Error('WST: нет PREF/HEAD');
  const prefabs: string[] = [];
  for (let q = pref.off; q + 4 <= pref.off + pref.size;) { const n = dv.getUint32(q, true); prefabs.push(dec.decode(u.subarray(q + 4, q + 4 + n)).replace(/\0+$/, '')); q += 4 + n; }
  const cells: Array<[number, number, number]> = [];
  let total = 0;
  for (let q = head.off + 24; q + 16 <= head.off + head.size; q += 16) {
    const ng = dv.getUint32(q + 4, true), ni = dv.getUint32(q + 8, true), off = dv.getUint32(q + 12, true);
    if (off + ng * 8 + ni * 36 > u.length) continue;
    cells.push([ng, ni, off]); total += ni;
  }
  const data = new Float32Array(total * 8), prefab = new Uint16Array(total);
  let k = 0;
  for (const [ng, ni, off] of cells) {
    let start = 0;
    const base = off + ng * 8;
    for (let g = 0; g < ng; g++) {
      const end = Math.min(ni, dv.getUint32(off + g * 8, true)), pi = dv.getUint32(off + g * 8 + 4, true);
      for (let i = start; i < end; i++, k++) {
        const r = base + i * 36;
        for (let c = 0; c < 8; c++) data[k * 8 + c] = dv.getFloat32(r + c * 4, true);
        prefab[k] = pi;
      }
      start = end;
    }
  }
  return { prefabs, data: data.subarray(0, k * 8), prefab: prefab.subarray(0, k) };
}
/** Матрица экземпляра .wst (столбцы). */
function wstMat(d: Float32Array, i: number): Float64Array {
  const o = i * 8, s = d[o + 3]! > 0 ? d[o + 3]! : 1, m = quatMat([d[o + 4]!, d[o + 5]!, d[o + 6]!, d[o + 7]!], [d[o]!, d[o + 1]!, d[o + 2]!]);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = m[c * 4 + r]! * s;
  return m;
}

export async function loadEnfusionWorld(main: VFile, ctx: LoadContext): Promise<Model> {
  const u = new Uint8Array(await main.arrayBuffer());
  const info: string[] = [], path = (main.path ?? main.name).toLowerCase();
  let worldDir = path.replace(/[^/]*$/, '');
  const eb = parseEbin(u);
  // GUID → путь: resourceDatabase.rdb всех аддонов («Папка игры»)
  const rdb = new Map<bigint, string>();
  for (const a of ctx.archives) for (const e of a.entries) if (/resourcedatabase\.rdb$/i.test(e.path)) parseRdb(await a.read(e), rdb);
  // сцена-надстройка (SubScene с Parent — сценарии, GM_*, CAH_*): сначала родительский мир, поверх — её сущности
  const layers: Ebin[] = [eb];
  for (let cur = eb, guard = 0; guard < 4; guard++) {
    const sub = cur.entities[0], r = sub?.cls === 'SubScene' ? ebU(sub.props.get('Parent')) : null;
    const pp = r !== null ? rdb.get(cur.guids[r]!) : undefined;
    if (!pp) break;
    const pu = await ctx.readPath(pp.toLowerCase()).catch(() => null);
    if (!pu) { info.push(`Родительский мир ${pp} не найден — показана только надстройка`); break; }
    cur = parseEbin(pu); layers.unshift(cur); worldDir = pp.toLowerCase().replace(/[^/]*$/, '');
    info.push(`Надстройка над миром ${pp}: показаны оба`);
  }
  for (const l of layers) if (l.error) info.push(`Разбор мира остановлен на неизвестной конструкции (${l.error}) — показано разобранное до неё`);
  const ter: { heightAt?: HeightAt; min?: number; size?: number; layers?: TerrainLayers } = {};
  let tTerrain = Date.now();
  const terrain = await terrainMeshes(ctx, worldDir, 0, info, ter);
  tTerrain = Date.now() - tTerrain;
  if (!rdb.size) info.push('Объекты не расставлены: нет resourceDatabase.rdb (откройте «Папку игры» Arma Reforger целиком)');
  // префабы (по пути) и их экземпляры во всех слоях
  // экземпляр: матрица из .ent или номер в данных .wst (матрица считается при расстановке — их до миллиона)
  const byRef = new Map<string, Array<Float64Array | number>>();
  let nEnt = 0, nInst = 0;
  for (const l of layers) {
    nEnt += l.entities.length; nInst += l.instances.length;
    for (const it of l.instances) {
      if (!it.coords && l.entities[it.entity]!.parent < 0) continue;
      const p = rdb.get(l.guids[it.ref]!);
      if (!p || !/\.et$/i.test(p)) continue;
      let list = byRef.get(p);
      if (!list) byRef.set(p, list = []);
      list.push(it.world);
    }
  }
  let wst: Wst | null = null;
  const wstPath = path.replace(/\.ent$/, '.wst'), baseWst = layers.length > 1 ? null : wstPath;
  for (const cand of [baseWst, worldDir + worldDir.replace(/\/$/, '').replace(/^.*\//, '') + '.wst'].filter((x): x is string => !!x)) {
    const wu = await ctx.readPath(cand).catch(() => null);
    if (!wu) continue;
    try {
      wst = parseWst(wu);
      for (let i = 0; i < wst.prefab.length; i++) {
        const p = enfusionPath(wst.prefabs[wst.prefab[i]!] ?? '');
        if (!/\.et$/i.test(p)) continue;
        let list = byRef.get(p);
        if (!list) byRef.set(p, list = []);
        list.push(i);
      }
      nInst += wst.prefab.length;
      info.push(`Сгенерированная растительность (${cand.replace(/^.*\//, '')}): ${wst.prefab.length} экземпляров ${wst.prefabs.length} префабов`);
    } catch (e) { info.push(`${cand}: ${(e as Error).message}`); }
    break;
  }
  const B = new LevelBuilder(), prev = { ...enfTextures };
  enfTextures.limit = 256; enfTextures.lite = true;
  let placed = 0, thinned = 0, failed = 0;
  // объекты рисуются экземплярами (модель префаба — одна копия), предел — ради частоты кадров; большим картам больше
  const BUDGET = ((ter.size ?? 0) > 8000 ? 7_000_000 : 4_500_000) - sumTris(terrain);
  const protos: Array<{ ref: string; path: string; veg: boolean; pi: number; parts: Mesh[]; tris: number; r: number }> = [];
  // 1) части префабов и треугольники их LOD
  type PartInfo = { xob: string; world: ArrayLike<number>; remap: Map<string, string>; lods: number[] };
  const plan: Array<{ ref: string; path: string; veg: boolean; n: number; parts: PartInfo[]; r: number }> = [];
  // треугольники LOD — по модели один раз (у многих префабов общие модели)
  const lodCache = new Map<string, number[] | null>(), radiusOf = new Map<string, number>();
  const lodsOf = async (xob: string): Promise<number[] | null> => {
    const key = enfusionPath(xob);
    if (lodCache.has(key)) return lodCache.get(key)!;
    // заголовок модели — в начале файла: читаем 256 КБ, если не хватило — целиком
    let v: number[] | null = null;
    for (const a of ctx.archives) {
      const e = a.kind === 'enfusion-pak' ? (a.lookup(key) as PakEntry | null) : null;
      if (!e) continue;
      try {
        let xu = await readPakHead(e, 262144), h = xobChunks(xu).get('HEAD');
        if (!h || h.off + h.size > xu.length) { xu = await readPakEntry(e); h = xobChunks(xu).get('HEAD'); }
        if (h) { const hd = parseXobHead(xu, h.off); v = hd.lods.map((l) => l.sections.reduce((s, x) => s + x.tris, 0)); radiusOf.set(key, hd.radius); }
      } catch { v = null; }
      break;
    }
    if (v === null && !lodCache.has(key)) {
      const xu = await ctx.readPath(key).catch(() => null), h = xu ? xobChunks(xu).get('HEAD') : undefined;
      const hd = xu && h ? parseXobHead(xu, h.off) : null;
      v = hd ? hd.lods.map((l) => l.sections.reduce((s, x) => s + x.tris, 0)) : null;
      if (hd) radiusOf.set(key, hd.radius);
    }
    lodCache.set(key, v);
    return v;
  };
  const time = { t: Date.now(), plan: 0, mesh: 0, splines: 0, terrain: tTerrain };
  for (const r of byRef.keys()) {
    const p = r;
    try {
      const parts: PartInfo[] = [];
      for (const part of await collectParts(p, ctx, {}, [], undefined, false)) {
        if (part.hidden) continue;
        const lods = await lodsOf(part.xob);
        if (!lods?.length) continue;
        parts.push({ xob: part.xob, world: part.world, remap: part.remap, lods });
      }
      const rad = Math.max(0.1, ...parts.map((pt) => radiusOf.get(enfusionPath(pt.xob)) ?? 1));
      if (parts.length) plan.push({ ref: r, path: p, veg: VEG.test(p), n: byRef.get(r)!.length, parts, r: rad });
    } catch { failed++; }
  }
  time.plan = Date.now() - time.t; time.t = Date.now();
  // 2) предел треугольников на экземпляр — по размеру: k·радиус² (дома подробнее, мелочь проще), от 20 до 8000;
  // k подбирается так, чтобы строения и предметы заняли 70 % бюджета; мелочь — простейший LOD, прореживается в остаток
  const lodFor = (lods: number[], cap: number) => { for (let i = 0; i < lods.length; i++) if (lods[i]! <= cap) return i; return lods.length - 1; };
  const OBJ_BUDGET = BUDGET * 0.7;
  const capOf = (x: { r: number }, k: number) => Math.min(8000, Math.max(20, k * x.r * x.r));
  const cost = (k: number) => plan.reduce((s, x) => s + (x.veg ? 0 : x.n * x.parts.reduce((t, pt) => t + pt.lods[lodFor(pt.lods, capOf(x, k))]!, 0)), 0);
  let lo = Math.log(1e-3), hi = Math.log(1e5);
  if (cost(Math.exp(hi)) > OBJ_BUDGET) { for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (cost(Math.exp(mid)) > OBJ_BUDGET) hi = mid; else lo = mid; } } else lo = hi;
  const kCap = Math.exp(lo), cap = (x: { r: number }) => capOf(x, kCap);
  info.push(`Предел на экземпляр — по размеру: ${Math.round(capOf({ r: 10 }, kCap))} треугольников у дома (радиус 10 м), ${Math.round(capOf({ r: 2 }, kCap))} у предмета 2 м (LOD подобраны по бюджету ${Math.round(BUDGET / 1e6)} млн)`);
  // 3) меши выбранных LOD (одна модель с тем же LOD и материалами — один раз)
  const meshCache = new Map<string, Mesh[]>();
  try {
    for (const x of plan) {
      const meshes: Mesh[] = [];
      try {
        for (const pt of x.parts) {
          const lod = x.veg ? lodFor(pt.lods, 300) : lodFor(pt.lods, cap(x)), key = `${enfusionPath(pt.xob)}|${lod}|${[...pt.remap].join(',')}`;
          let ms = meshCache.get(key);
          if (!ms) {
            const xu = await ctx.readPath(enfusionPath(pt.xob));
            if (!xu) continue;
            ms = (await xobMeshes(xu, ctx, pt.remap, lod)).meshes.filter((m) => !m.defaultHidden);
            meshCache.set(key, ms);
          }
          for (const m of ms) meshes.push(transformMesh(m, pt.world));
        }
      } catch { failed++; continue; }
      if (!meshes.length) continue;
      const name = x.path.replace(/^.*\//, '').replace(/\.et$/i, ''), veg = x.veg;
      const pi = B.proto(name, meshes, veg ? 'veg' : 'obj', (m) => (veg ? 'растительность · ' : 'объекты · ') + m.texture.replace(/^.*\//, ''));
      protos.push({ ref: x.ref, path: name, veg, pi, parts: meshes, tris: meshes.reduce((s, m) => s + m.indices.length / 3, 0), r: x.r });
    }
  } finally { enfTextures.limit = prev.limit; enfTextures.lite = prev.lite; }
  // бюджет по приоритету: строения → прочие объекты → растительность и камни; группа, не влезающая в свою долю
  // остатка, равномерно прореживается (у Everon только низкие LOD береговых скал — миллионы треугольников)
  const STRUCT = /prefabs\/structures\//i;
  // мебель и интерьеры (отдельные префабы внутри домов) снаружи не видны — они в «прочих»
  // группы: 0 — строения, 1 — крупные предметы (радиус ≥ 3 м), 2 — мелкие предметы, 3 — растительность и камни
  const cls = (x: { veg: boolean; path: string; ref: string; r: number }) => (x.veg ? 3 : STRUCT.test(x.ref) && !/furniture|interior/i.test(x.ref) ? 0 : x.r >= 3 ? 1 : 2);
  const sum = [0, 0, 0, 0];
  for (const x of protos) sum[cls(x)] += x.tris * byRef.get(x.ref)!.length;
  const strideOf = [1, 1, 1, 1];
  let rest = BUDGET;
  for (const c of [0, 1, 2, 3]) {
    const share = c === 3 ? rest : rest * (c === 0 ? 0.8 : 0.6);
    strideOf[c] = sum[c]! > share && share > 0 ? Math.ceil(sum[c]! / share) : sum[c]! > 0 && share <= 0 ? 1000 : 1;
    rest = Math.max(BUDGET * 0.05, rest - sum[c]! / strideOf[c]!);
  }
  const stride = strideOf[3]!;
  for (const pr of protos) {
    const list = byRef.get(pr.ref)!, st = strideOf[cls(pr)]!;
    for (let k = 0; k < list.length; k += st) {
      const it = list[k]!;
      B.place(pr.pi, pr.parts, typeof it === 'number' ? wstMat(wst!.data, it) : it, `${pr.path} #${k}`, pr.veg ? 'растительность' : 'объекты');
      placed++;
    }
    thinned += list.length - Math.ceil(list.length / st);
  }
  if (strideOf[0]! > 1 || strideOf[1]! > 1 || strideOf[2]! > 1) info.push(`Не влезло в бюджет: строения прорежены в ${strideOf[0]} раз(а), крупные предметы — в ${strideOf[1]}, мелкие — в ${strideOf[2]}`);
  const heavy = protos.map((x) => ({ n: x.path, t: x.tris * byRef.get(x.ref)!.length / strideOf[cls(x)]! })).sort((a, b) => b.t - a.t).slice(0, 5);
  info.push(`Больше всего треугольников: ${heavy.map((h) => `${h.n} ${Math.round(h.t / 1000)} тыс.`).join(', ')}`);
  time.mesh = Date.now() - time.t; time.t = Date.now();
  const objects = B.build();
  // дороги, реки, озёра, провода
  let splines: Mesh[] = [];
  try {
    const st = { roads: 0, rivers: 0, lakes: 0, cables: 0 };
    for (const l of layers) {
      const r = await splineMeshes(l, (ref) => rdb.get(l.guids[ref]!), ctx, ter.heightAt);
      splines.push(...r.meshes);
      st.roads += r.stats.roads; st.rivers += r.stats.rivers; st.lakes += r.stats.lakes; st.cables += r.stats.cables;
    }
    time.splines = Date.now() - time.t;
    info.push(`Дороги: ${st.roads} сплайнов, реки: ${st.rivers}, озёра: ${st.lakes}, провода ЛЭП: ${st.cables} пролётов`);
  } catch (e) { info.push(`Дороги и вода не построены: ${(e as Error).message}`); }
  // море: острова Enfusion окружены дном ниже нуля — уровень моря 0
  if (ter.size && ter.min !== undefined && ter.min < -1) {
    const S = ter.size, E = S * 0.5;
    splines.push({ name: 'вода · море (уровень 0)', texture: '', vertexCount: 4, pos: new Float32Array([-E, 0, -E, S + E, 0, -E, -E, 0, S + E, S + E, 0, S + E]), nor: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uv: new Float32Array(8), bone: new Float32Array(0), weight: new Float32Array(0), indices: new Uint32Array([0, 2, 1, 1, 2, 3, 0, 1, 2, 1, 3, 2]), skinned: false, color: [0.13, 0.24, 0.3] });
  }
  const meshes = [...terrain, ...splines, ...objects];
  if (!meshes.length) throw new Error('В мире не найдено ни ландшафта, ни объектов');
  info.unshift(`Enfusion мир ${main.name}: сущностей ${nEnt}, экземпляров префабов ${nInst} (префабов ${byRef.size}), поставлено ${placed}${thinned ? `, растительность прорежена в ${stride} раз(а) — не поставлено ${thinned}` : ''}${failed ? `, не загрузились ${failed} префабов` : ''}; треугольников ${sumTris(meshes)}`);
  info.push('Объекты — по LOD попроще и с текстурами до 256 px; отдельные префабы открываются в полном качестве.');
  info.push(`Время: ландшафт ${(time.terrain / 1000).toFixed(1)} с, префабы ${(time.plan / 1000).toFixed(1)} с, модели ${(time.mesh / 1000).toFixed(1)} с, дороги и вода ${(time.splines / 1000).toFixed(1)} с`);
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(terrain.length ? terrain : meshes), flipZ: true, info, instances: B.scene, terrainLayers: ter.layers };
}

function transformMesh(m: Mesh, w: ArrayLike<number>): Mesh {
  if (Array.from(w).every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9)) return m;
  const pos = new Float32Array(m.pos.length), nor = new Float32Array(m.nor.length);
  for (let i = 0; i < m.pos.length; i += 3) {
    const x = m.pos[i]!, y = m.pos[i + 1]!, z = m.pos[i + 2]!;
    pos[i] = w[0]! * x + w[4]! * y + w[8]! * z + w[12]!; pos[i + 1] = w[1]! * x + w[5]! * y + w[9]! * z + w[13]!; pos[i + 2] = w[2]! * x + w[6]! * y + w[10]! * z + w[14]!;
    const a = m.nor[i]!, b = m.nor[i + 1]!, c = m.nor[i + 2]!;
    nor[i] = w[0]! * a + w[4]! * b + w[8]! * c; nor[i + 1] = w[1]! * a + w[5]! * b + w[9]! * c; nor[i + 2] = w[2]! * a + w[6]! * b + w[10]! * c;
  }
  return { ...m, pos, nor };
}
