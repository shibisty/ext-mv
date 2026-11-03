// Уровни Far Cry 2 (Dunia). Мир — worlds/<мир>: сетка секторов 64×64 м (большие миры — 80×80 секторов, 25 карт по 16×16),
// generated/<мир>.game.xml — описание (сетка, карты, слои ландшафта), generated/entitylibrary.fcb — архетипы объектов.
// Имён у файлов секторов в архиве нет (не находятся по хешу), поэтому они узнаются по содержимому среди файлов мира
// (участок .dat до <мир>.sectorsdep.fcb, см. fat.ts):
//   ландшафт сектора — «R\x10\x00\xE9», u32 7, u32 размер, …, u32 номер сектора (0x14; x = номер % ширина, y = номер / ширина),
//     f32 мин./макс. высоты (0x1C, 0x20), 4 байта — номера слоёв ландшафта (0x24, по списку Layers в game.xml),
//     f32 уровень воды сектора (0x3C; 0 — воды нет; материал воды — путь .mlm с 0x44),
//     с 0x250 — 65×65 вершин по 4 байта (строки по Y, шаг 1 м): u16 высота·128, u8 освещённость, u8 маска слоёв
//     (бит k младшей тетрады — слой слота k в вершине; 255 — слот пуст): нижний занятый слот — основа, слоты выше
//     накладываются с прозрачностью по вершинам (переход между слоями — на одну клетку);
//   объекты сектора — .fcb с корнем WorldSector (Id, X, Y): слои миссий → Entity (hidPos, hidAngles в градусах;
//     модель — значение 0xBF9B3A5C компонента CGraphicComponent или его object; hidMeshName — список видимых частей кита;
//     у объектов-архетипов (0x346AAB33 = «OA_Buildings.Buildings.ShantyShelter01») — модель из entitylibrary.fcb по hidName).
import { boundsOf } from '../../core/geometry';
import { LevelBuilder, markerMesh } from '../../core/levelbuilder';
import { compose } from '../../core/math';
import type { LoadContext } from '../../core/plugin';
import type { Archive, Mesh, Model, VFile } from '../../core/types';
import { duniaApi, LEVEL_MARK, type DuniaArchiveApi, type DuniaWorld, type FatRef, type LevelSpec } from './fat';
import { fcbFind, fcbHash, fcbString, fcbVec3, parseFcb, type FcbObject } from './fcb';
import { xmlElements } from './rml';
import { isRealTree, parseRealTree, realTreeMeshes, type RealTree } from './realtree';
import { bakeBindPose, kitHiddenParts, parseXbg, parseXbm, xbgMeshes, type Xbg, type XbmMaterial } from './xbg';

const SECTOR = 64, GRID = 65, TER_MAGIC = 0xe9001052;
/** Бюджет треугольников объектов карты (сверх — дальние LOD у самых тяжёлых моделей). */
const TRI_BUDGET = 4_000_000;
/** Малый мир (сетевые карты): файлов в блоке ландшафта меньше — объекты ищутся по всему миру. */
const SMALL_WORLD = 12_000;
/** Коллекции: уровень LOD и бюджет треугольников (сверх — равномерное прореживание). */
const COLLECTION_LOD = 1, COLLECTION_BUDGET = 3_000_000;
/** Детерминированный случайный поток (mulberry32): прореживание одинаково при каждом открытии. */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const H = {
  Entity: fcbHash('Entity'), WorldSector: fcbHash('WorldSector'), hidName: fcbHash('hidName'), hidPos: fcbHash('hidPos'), hidAngles: fcbHash('hidAngles'),
  hidMeshName: fcbHash('hidMeshName'), X: fcbHash('X'), Y: fcbHash('Y'), model: 0xbf9b3a5c, archetype: 0x346aab33, layer: 0x494c09f2, layerName: 0xc56f9204,
};

export interface TerrainLayer { name: string; texture: string; normal: string; tiling: number }

/** Слои ландшафта и сетка мира из game.xml. */
export function worldDescriptor(u: Uint8Array): { layers: TerrainLayer[]; countX: number; countY: number } {
  const layers: TerrainLayer[] = [];
  // ширина мира в секторах = секторов на карту × карт (GridMapSectors × GridWorldMaps)
  let sx = 0, sy = 0, mx = 1, my = 1, inLayers = -1;
  for (const el of xmlElements(u)) {
    if (el.name === 'GridMapSectors' && !sx) { sx = +el.attrs.CountX! || 0; sy = +el.attrs.CountY! || 0; }
    if (el.name === 'GridWorldMaps') { mx = +el.attrs.CountX! || 1; my = +el.attrs.CountY! || 1; }
    if (el.name === 'Layers') { inLayers = el.depth; continue; }
    if (inLayers >= 0 && el.depth <= inLayers) inLayers = -1;
    if (inLayers >= 0 && el.depth === inLayers + 1 && el.name === 'Layer') {
      layers.push({ name: (el.attrs.Name ?? '').trim(), texture: el.attrs.Texture ?? '', normal: el.attrs.NormalMap ?? '', tiling: +el.attrs.Tiling! || 20 });
    }
  }
  return { layers, countX: sx * mx, countY: sy * my };
}

export interface TerrainSector { id: number; min: number; max: number; layers: number[]; height: Float32Array; mask: Uint8Array; water: number }

/** Ландшафт сектора (см. заголовок файла). */
export function parseTerrainSector(u: Uint8Array): TerrainSector {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 0x250 + GRID * GRID * 4 || dv.getUint32(0, true) !== TER_MAGIC) throw new Error('Не ландшафт сектора Far Cry 2');
  const height = new Float32Array(GRID * GRID), mask = new Uint8Array(GRID * GRID);
  for (let i = 0; i < GRID * GRID; i++) { height[i] = dv.getUint16(0x250 + i * 4, true) / 128; mask[i] = u[0x250 + i * 4 + 3]!; }
  const water = dv.getFloat32(0x3c, true);
  return { id: dv.getUint32(0x14, true), min: dv.getFloat32(0x1c, true), max: dv.getFloat32(0x20, true), layers: [u[0x24]!, u[0x25]!, u[0x26]!, u[0x27]!], height, mask, water: Number.isFinite(water) && water > 0 ? water : 0 };
}

/**
 * Слой вершины: старший установленный бит младшей тетрады маски, чей слот занят (верхний нарисованный слой);
 * пустой слот — 255; без бит (край сектора) — первый занятый слот.
 */
export function vertexLayer(mask: number, slots: readonly number[]): number {
  for (let k = 3; k >= 0; k--) if (mask & (1 << k) && slots[k] !== 255) return slots[k]!;
  for (const s of slots) if (s !== 255) return s;
  return -1;
}

/**
 * Углы объекта (градусы) -> кватернион [w, x, y, z]: R = Rz(z)·Ry(y)·Rx(x) (сначала X, затем Y, затем Z — рыскание).
 * Проверено по объектам на склонах: ось «вверх» объекта совпадает с нормалью земли (см. тест уровней).
 */
export function anglesQuat(a: readonly number[]): number[] {
  const h = (d: number) => (d * Math.PI) / 360;
  const qx = [Math.cos(h(a[0]!)), Math.sin(h(a[0]!)), 0, 0], qy = [Math.cos(h(a[1]!)), 0, Math.sin(h(a[1]!)), 0], qz = [Math.cos(h(a[2]!)), 0, 0, Math.sin(h(a[2]!))];
  return qmul(qmul(qz, qy), qx);
}
const qmul = (a: number[], b: number[]) => [
  a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]! - a[3]! * b[3]!,
  a[0]! * b[1]! + a[1]! * b[0]! + a[2]! * b[3]! - a[3]! * b[2]!,
  a[0]! * b[2]! - a[1]! * b[3]! + a[2]! * b[0]! + a[3]! * b[1]!,
  a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]! + a[3]! * b[0]!,
];

/** Объект уровня: модель, видимые части (пусто — все), поза. */
export interface LevelEntity { name: string; model: string; parts: string[]; pos: number[]; angles: number[]; layer: string; archetype?: string }

const modelOf = (e: FcbObject): string | undefined => {
  const walk = (o: FcbObject, d: number): string | undefined => {
    const v = fcbString(o.values.get(H.model));
    if (v) return v;
    if (d > 6) return undefined;
    for (const c of o.children) { if (c.type === H.Entity) continue; const r = walk(c, d + 1); if (r) return r; }
    return undefined;
  };
  return walk(e, 0);
};
const meshNamesOf = (e: FcbObject): string[] => {
  for (const o of fcbFind(e, fcbHash('object'))) { const s = fcbString(o.values.get(H.hidMeshName)); if (s && s.includes(';')) return s.split(';').filter(Boolean); }
  return [];
};

/** Архетипы entitylibrary.fcb: hidName -> модель и части. */
export function entityLibrary(root: FcbObject): Map<string, { model: string; parts: string[] }> {
  const out = new Map<string, { model: string; parts: string[] }>();
  for (const e of fcbFind(root, H.Entity)) {
    const n = fcbString(e.values.get(H.hidName)), m = modelOf(e);
    if (n && m && !out.has(n)) out.set(n, { model: m, parts: meshNamesOf(e) });
  }
  return out;
}

/** Объекты сектора (WorldSector) с моделями; архетипы — по библиотеке. */
export interface LevelMarker { kind: 'particle' | 'light'; name: string; pos: number[] }
const PARTICLES = fcbHash('CNewParticlesComponent'), LIGHT = fcbHash('CDynamicLightComponent'), PARTICLE_NAME = 0x1943b130;

export function sectorEntities(root: FcbObject, lib: Map<string, { model: string; parts: string[] }>): { list: LevelEntity[]; noModel: number; unknownArchetype: Set<string>; markers: LevelMarker[] } {
  const list: LevelEntity[] = [], unknownArchetype = new Set<string>(), markers: LevelMarker[] = [];
  let noModel = 0;
  const visit = (o: FcbObject, layer: string) => {
    if (o.type === H.layer) layer = fcbString(o.values.get(H.layerName)) ?? layer;
    if (o.type === H.Entity) {
      const pos = fcbVec3(o.values.get(H.hidPos));
      const arch = fcbString(o.values.get(H.archetype));
      let model = modelOf(o), parts = meshNamesOf(o);
      if (!model && arch) { const L = lib.get(arch); if (L) { model = L.model; if (!parts.length) parts = L.parts; } else unknownArchetype.add(arch); }
      if (pos && model) list.push({ name: fcbString(o.values.get(H.hidName)) ?? arch ?? 'entity', model, parts, pos, angles: fcbVec3(o.values.get(H.hidAngles)) ?? [0, 0, 0], layer, ...(arch ? { archetype: arch } : {}) });
      else if (pos) {
        noModel++;
        // без модели: метки частиц (имя эффекта) и динамического света
        const name = fcbString(o.values.get(H.hidName)) ?? 'entity';
        const pc = fcbFind(o, PARTICLES)[0];
        if (pc) markers.push({ kind: 'particle', name: fcbString(pc.values.get(PARTICLE_NAME)) ?? name, pos });
        else if (fcbFind(o, LIGHT).length) markers.push({ kind: 'light', name, pos });
      }
    }
    for (const c of o.children) visit(c, layer);
  };
  visit(root, 'main');
  return { list, noModel, unknownArchetype, markers };
}

/**
 * Коллекции сектора (CCollectionComponent у CSectorEntity — камни, мусор, растительность, расставленные кистью редактора):
 * 0x114CFEE7 — набор (рамка 0x17E7C62E–0x2BEAF977), его данные 0xA18C8484: 0x89C8C095 — хеши путей моделей (как имена
 * в .fat), 0x58AD43E2 — число групп каждой модели, 0x798C33D5 — группы (u8 число экземпляров, далее номер первого),
 * 0xB0484974 — центры и радиусы групп; экземпляры: 0xD28100C0 — u16 x, u16 y (дециметры), 0x8E2752CA — f32 z,
 * 0x98C678BD — u32 (младшие 16 бит — поворот вокруг Z, полный круг = 65536; старшие — не разобраны), 0x9D1CAE67 — цвета.
 * Все массивы — u32 число, затем элементы.
 */
export function sectorCollections(root: FcbObject): Array<{ hash: number; pos: number[]; yaw: number }> {
  const out: Array<{ hash: number; pos: number[]; yaw: number }> = [];
  for (const set of fcbFind(root, 0x114cfee7)) {
    const d = set.children.find((c) => c.type === 0xa18c8484);
    if (!d) continue;
    const arr = (k: number) => { const v = d.values.get(k); if (!v || v.length < 4) return null; const dv = new DataView(v.buffer, v.byteOffset, v.byteLength); const n = dv.getUint32(0, true); return n * 4 + 4 <= v.length ? { dv, n } : null; };
    const models = arr(0x89c8c095), counts = arr(0x58ad43e2), groups = arr(0x798c33d5), xy = arr(0xd28100c0), zs = arr(0x8e2752ca), rot = arr(0x98c678bd);
    if (!models || !counts || !groups || !xy || !zs || counts.n !== models.n) continue;
    let g = 0;
    for (let m = 0; m < models.n; m++) {
      const hash = models.dv.getUint32(4 + m * 4, true), ng = counts.dv.getUint32(4 + m * 4, true);
      for (let k = 0; k < ng && g < groups.n; k++, g++) {
        const gv = groups.dv.getUint32(4 + g * 4, true), cnt = gv & 0xff, first = gv >>> 8;
        for (let i = first; i < first + cnt && i < xy.n && i < zs.n; i++) {
          const x = xy.dv.getUint16(4 + i * 4, true) / 10, y = xy.dv.getUint16(6 + i * 4, true) / 10, z = zs.dv.getFloat32(4 + i * 4, true);
          const yaw = rot && i < rot.n ? ((rot.dv.getUint32(4 + i * 4, true) & 0xffff) / 65536) * 360 : 0;
          out.push({ hash, pos: [x, y, z], yaw });
        }
      }
    }
  }
  return out;
}

/** Чтение многих записей параллельно (по n за раз). */
async function mapLimit<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const i = k++; out[i] = await f(items[i]!); } }));
  return out;
}

/** Шаг сетки ландшафта (м): степень двойки, чтобы вершин было не больше бюджета. */
export const terrainStep = (w: number, h: number, budget = 520_000) => {
  let s = 1;
  while ((Math.floor((w * SECTOR) / s) + 1) * (Math.floor((h * SECTOR) / s) + 1) > budget && s < SECTOR) s *= 2;
  return s;
};

/** Меши ландшафта области: по мешу на слой (треугольник — по слою его угла), UV — плитка слоя (Tiling повторов на сектор). */
export function terrainMeshes(spec: { x0: number; y0: number; w: number; h: number }, sectors: Map<number, TerrainSector>, widthInSectors: number, layers: TerrainLayer[], step: number): Mesh[] {
  const NX = (spec.w * SECTOR) / step + 1, NY = (spec.h * SECTOR) / step + 1, n = NX * NY;
  // по вершине: высота, слой основы и слои слотов 1..3 сектора с битом маски (-1 — слоя нет)
  const hgt = new Float32Array(n).fill(NaN), base = new Int16Array(n).fill(-1), over = [1, 2, 3].map(() => new Int16Array(n).fill(-1));
  for (let gy = 0; gy < NY; gy++) {
    for (let gx = 0; gx < NX; gx++) {
      const mx = gx * step, my = gy * step; // метры от угла области
      let sx = Math.floor(mx / SECTOR), sy = Math.floor(my / SECTOR);
      if (sx >= spec.w) sx = spec.w - 1;
      if (sy >= spec.h) sy = spec.h - 1;
      const s = sectors.get((spec.y0 + sy) * widthInSectors + spec.x0 + sx);
      if (!s) continue;
      const lx = mx - sx * SECTOR, ly = my - sy * SECTOR, k = ly * GRID + lx, g = gy * NX + gx, m = s.mask[k]!;
      hgt[g] = s.height[k]!;
      // основа — нижний занятый слот; выше — слоты 1..3, где стоит бит маски (наложение с прозрачностью по вершинам)
      const b0 = s.layers.findIndex((l) => l !== 255);
      base[g] = b0 >= 0 ? s.layers[b0]! : -1;
      for (let j = 1; j <= 3; j++) if (j > b0 && m & (1 << j) && s.layers[j] !== 255) over[j - 1]![g] = s.layers[j]!;
    }
  }
  // нормали по соседям
  const nor = new Float32Array(n * 3);
  const at = (x: number, y: number, d: number) => { const v = hgt[Math.min(NY - 1, Math.max(0, y)) * NX + Math.min(NX - 1, Math.max(0, x))]!; return Number.isNaN(v) ? d : v; };
  for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    const c = hgt[y * NX + x]!; if (Number.isNaN(c)) continue;
    const dx = (at(x + 1, y, c) - at(x - 1, y, c)) / (2 * step), dy = (at(x, y + 1, c) - at(x, y - 1, c)) / (2 * step), l = Math.hypot(dx, dy, 1);
    nor[(y * NX + x) * 3] = -dx / l; nor[(y * NX + x) * 3 + 1] = -dy / l; nor[(y * NX + x) * 3 + 2] = 1 / l;
  }
  const meshes: Mesh[] = [], local = new Int32Array(n);
  const ox = spec.x0 * SECTOR, oy = spec.y0 * SECTOR;
  const valid = (g: number) => !Number.isNaN(hgt[g]!) && !Number.isNaN(hgt[g + 1]!) && !Number.isNaN(hgt[g + NX]!) && !Number.isNaN(hgt[g + NX + 1]!);
  /** Меш слоя L по клеткам take(g); alpha — прозрачность вершины (слой поверх основы). */
  const emit = (L: number, name: string, take: (g: number) => boolean, alpha?: (g: number) => number) => {
    local.fill(-1);
    const P: number[] = [], U: number[] = [], N: number[] = [], A: number[] = [], I: number[] = [];
    const layer = layers[L], rep = (layer?.tiling ?? 20) / SECTOR;
    const vi = (x: number, y: number) => {
      const g = y * NX + x;
      let v = local[g]!;
      if (v < 0) {
        v = local[g] = P.length / 3;
        const wx = ox + x * step, wy = oy + y * step;
        P.push(wx, wy, hgt[g]!); N.push(nor[g * 3]!, nor[g * 3 + 1]!, nor[g * 3 + 2]!); U.push(wx * rep, wy * rep);
        if (alpha) A.push(alpha(g));
      }
      return v;
    };
    for (let y = 0; y + 1 < NY; y++) for (let x = 0; x + 1 < NX; x++) {
      const g = y * NX + x;
      if (!take(g) || !valid(g)) continue;
      const a = vi(x, y), b = vi(x + 1, y), c = vi(x, y + 1), d = vi(x + 1, y + 1);
      I.push(a, b, d, a, d, c);
    }
    if (!I.length) return;
    const nv = P.length / 3;
    meshes.push({
      name, texture: layer?.texture ?? '', normalMap: layer?.normal || undefined,
      vertexCount: nv, pos: Float32Array.from(P), nor: Float32Array.from(N), uv: Float32Array.from(U), bone: new Float32Array(0), weight: new Float32Array(0),
      indices: nv > 65535 ? Uint32Array.from(I) : Uint16Array.from(I), skinned: false, ...(layer ? {} : { color: [0.45, 0.42, 0.36] }), ...(alpha ? { vertexAlpha: Float32Array.from(A) } : {}),
    });
  };
  const label = (L: number) => layers[L]?.name || (L < 0 ? 'без слоя' : `слой ${L}`);
  // основа: клетка — по слою основы её угла
  for (const L of [...new Set(base)].sort((a, b) => a - b)) emit(L, `Ландшафт · ${label(L)}`, (g) => base[g] === L);
  // слоты 1..3 по порядку (выше — позже): клетка, где у любого угла есть этот слой; прозрачность угла — есть ли слой в нём
  over.forEach((o, j) => {
    for (const L of [...new Set(o)].filter((l) => l >= 0).sort((a, b) => a - b)) {
      emit(L, `Ландшафт · ${label(L)} (наложение ${j + 1})`, (g) => o[g] === L || o[g + 1] === L || o[g + NX] === L || o[g + NX + 1] === L, (g) => (o[g] === L ? 1 : 0));
    }
  });
  return meshes;
}

/** Вода: по сектору с уровнем воды — клетки сетки, где земля ниже уровня, плоскостью на уровне; полупрозрачная. */
export function waterMesh(spec: { x0: number; y0: number; w: number; h: number }, sectors: Map<number, TerrainSector>, widthInSectors: number, step: number): Mesh | null {
  const P: number[] = [], I: number[] = [];
  const cells = SECTOR / step;
  for (let sy = 0; sy < spec.h; sy++) for (let sx = 0; sx < spec.w; sx++) {
    const s = sectors.get((spec.y0 + sy) * widthInSectors + spec.x0 + sx);
    if (!s || !s.water || s.min >= s.water) continue;
    const ox = (spec.x0 + sx) * SECTOR, oy = (spec.y0 + sy) * SECTOR, L = s.water;
    for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
      let lo = Infinity;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) lo = Math.min(lo, s.height[(cy + dy) * step * GRID + (cx + dx) * step]!);
      if (lo >= L) continue;
      const v = P.length / 3, x = ox + cx * step, y = oy + cy * step;
      P.push(x, y, L, x + step, y, L, x, y + step, L, x + step, y + step, L);
      I.push(v, v + 1, v + 3, v, v + 3, v + 2);
    }
  }
  if (!I.length) return null;
  const nv = P.length / 3, nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) { nor[i * 3 + 2] = 1; uv[i * 2] = P[i * 3]! / 8; uv[i * 2 + 1] = P[i * 3 + 1]! / 8; }
  return { name: 'Вода', texture: '', color: [0.16, 0.3, 0.36], vertexCount: nv, pos: Float32Array.from(P), nor, uv, bone: new Float32Array(0), weight: new Float32Array(0),
    indices: nv > 65535 ? Uint32Array.from(I) : Uint16Array.from(I), skinned: false, vertexAlpha: new Float32Array(nv).fill(0.7) };
}

const isTerrainSize = (s: number) => s >= 23536 && s <= 26000 && (s - 23536) % 12 === 0;

/** Указатель мира: файлы мира, ландшафт по номеру сектора, файлы объектов (WorldSector) по X, Y. Строится один раз на архив. */
interface WorldIndex { files: FatRef[]; terrain: Map<number, FatRef>; terrainEnd: number; objects?: Promise<Map<number, FatRef[]>>; full?: boolean }
interface TerrainGroup { start: number; terrain: Map<number, FatRef>; end: number }
const indexCache = new WeakMap<DuniaArchiveApi, Map<string, Promise<WorldIndex>>>();
const groupCache = new WeakMap<DuniaArchiveApi, Map<unknown, Promise<TerrainGroup[]>>>();

/** Ландшафт среди записей: номер сектора — в начале файла (частичная распаковка). */
async function terrainOf(api: DuniaArchiveApi, files: FatRef[]): Promise<Array<{ ref: FatRef; id: number }>> {
  const refs = files.filter((r) => isTerrainSize(r.fe.size));
  const heads = await mapLimit(refs, 16, async (r) => { try { return await api.readRef(r, 0x18); } catch { return null; } });
  const out: Array<{ ref: FatRef; id: number }> = [];
  heads.forEach((h, i) => {
    if (!h || h.length < 0x18) return;
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    if (dv.getUint32(0, true) === TER_MAGIC && dv.getUint32(4, true) === 7) out.push({ ref: refs[i]!, id: dv.getUint32(0x14, true) });
  });
  return out;
}

/** Блоки ландшафта .dat по порядку: новый блок — когда номер сектора повторяется (миры пишутся подряд). */
function terrainGroups(api: DuniaArchiveApi, dat: FatRef['dat']): Promise<TerrainGroup[]> {
  let m = groupCache.get(api);
  if (!m) { m = new Map(); groupCache.set(api, m); }
  let p = m.get(dat);
  if (!p) {
    p = (async () => {
      const groups: TerrainGroup[] = [];
      let cur: TerrainGroup | null = null;
      for (const t of await terrainOf(api, api.datRefs(dat))) {
        if (!cur || cur.terrain.has(t.id)) { cur = { start: t.ref.fe.off, terrain: new Map(), end: 0 }; groups.push(cur); }
        cur.terrain.set(t.id, t.ref);
        cur.end = t.ref.fe.off;
      }
      return groups;
    })();
    m.set(dat, p);
  }
  return p;
}

/**
 * Указатель мира. Обычно файлы мира — участок .dat между .sectorsdep.fcb предыдущего мира и своим (worlds.dat). Если там
 * нет ландшафта или номера секторов повторяются (dlc1.dat: сначала сектора всех миров, потом их именованные файлы), k-й блок ландшафта .dat — k-го мира
 * по порядку .sectorsdep.fcb, а файлы мира — от начала его блока до начала следующего.
 */
export function worldIndex(api: DuniaArchiveApi, world: DuniaWorld): Promise<WorldIndex> {
  let m = indexCache.get(api);
  if (!m) { m = new Map(); indexCache.set(api, m); }
  let p = m.get(world.name);
  if (!p) {
    p = (async () => {
      let files = world.files();
      const own = await terrainOf(api, files);
      let terrain = new Map(own.map((t) => [t.id, t.ref]));
      if (!terrain.size || terrain.size < own.length) { // нет ландшафта или в участке несколько миров
        const groups = await terrainGroups(api, world.dat);
        const worlds = api.duniaWorlds().filter((w) => w.dat === world.dat).sort((x, y) => x.end - y.end);
        const k = worlds.findIndex((w) => w.name === world.name);
        if (groups.length === worlds.length && k >= 0) {
          const g = groups[k]!, next = groups[k + 1]?.start ?? Infinity;
          terrain = g.terrain;
          files = api.datRefs(world.dat).filter((r) => r.fe.off >= g.start && r.fe.off < next);
        }
      }
      let terrainEnd = 0;
      for (const r of terrain.values()) terrainEnd = Math.max(terrainEnd, r.fe.off);
      return { files, terrain, terrainEnd };
    })();
    m.set(world.name, p);
  }
  return p;
}

/**
 * Файлы объектов мира: .fcb с корнем WorldSector. У больших миров — после блока ландшафта (объекты слоёв миссий; рядом
 * с ландшафтом — только сектора-коллекции растительности), у малых — вперемешку с ландшафтом. X, Y — первые значения
 * корня, читаются из начала файла.
 */
export function worldObjects(api: DuniaArchiveApi, world: DuniaWorld, idx: WorldIndex): Promise<Map<number, FatRef[]>> {
  idx.objects ??= (async () => {
    // по порядку в .dat; блок объектов кончается перед ресурсами мира (модели, текстуры, звук) — после 2 пустых
    // порций подряд чтение останавливается. У малых миров (сетевые карты) объекты лежат вперемешку с ландшафтом —
    // у них просматривается весь мир, у больших — сначала после ландшафта.
    const out = new Map<number, FatRef[]>();
    const scan = async (cand: FatRef[]) => {
      const CHUNK = 2048;
      let empty = 0, found = 0;
      for (let i = 0; i < cand.length && empty < 2; i += CHUNK) {
        const part = cand.slice(i, i + CHUNK);
        const heads = await mapLimit(part, 32, async (r) => { try { return await api.readRef(r, 64); } catch { return null; } });
        let here = 0;
        heads.forEach((h, k) => {
          const xy = h && worldSectorXY(h);
          if (!xy) return;
          const key = xy[1] * 65536 + xy[0];
          let l = out.get(key);
          if (!l) { l = []; out.set(key, l); }
          l.push(part[k]!);
          here++;
        });
        found += here;
        empty = here || !found ? 0 : empty + 1;
      }
      return found;
    };
    const files = idx.files.filter((r) => r.fe.size >= 64);
    const before = files.filter((r) => r.fe.off <= idx.terrainEnd && !isTerrainSize(r.fe.size)), after = files.filter((r) => r.fe.off > idx.terrainEnd);
    if (before.length < SMALL_WORLD) { await scan([...before, ...after]); idx.full = true; }
    else if (!(await scan(after))) { await scan(before); idx.full = true; }
    return out;
  })();
  return idx.objects;
}

/** X, Y из начала .fcb с корнем WorldSector (иначе null). */
export function worldSectorXY(h: Uint8Array): [number, number] | null {
  if (h.length < 24) return null;
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  if (dv.getUint32(0, true) !== 0x4643626e) return null;
  let p = 16;
  if (h[p]! >= 0xfe) p += 4;
  p++;
  if (dv.getUint32(p, true) !== H.WorldSector) return null;
  p += 4;
  let n = h[p++]!;
  if (n >= 0xfe) return null;
  let x = -1, y = -1;
  for (; n > 0 && p + 5 <= h.length; n--) {
    const k = dv.getUint32(p, true), sz = h[p + 4]!;
    p += 5;
    if (sz >= 0xfe || p + sz > h.length) break;
    if (sz === 4 && k === H.X) x = dv.getUint32(p, true);
    if (sz === 4 && k === H.Y) y = dv.getUint32(p, true);
    p += sz;
  }
  return x >= 0 && y >= 0 ? [x, y] : null;
}

export async function loadDuniaLevel(text: string, main: VFile, ctx: LoadContext): Promise<Model> {
  const spec = JSON.parse(text.slice(LEVEL_MARK.length)) as LevelSpec;
  const arc = main.archive ?? ctx.archives.find((a) => duniaApi(a)) ?? null;
  const api = duniaApi(arc);
  const world = api?.duniaWorld(spec.world);
  if (!arc || !api || !world) throw new Error('Уровень Far Cry 2 открывается из архивов игры (папка Data_Win32)');
  const desc = worldDescriptor(await api.readRef(world.gameXml));
  const width = desc.countX || spec.x0 + spec.w;
  const idx = await worldIndex(api, world);
  const sectors = new Map<number, TerrainSector>();
  const want: FatRef[] = [];
  for (let y = spec.y0; y < spec.y0 + spec.h; y++) for (let x = spec.x0; x < spec.x0 + spec.w; x++) { const r = idx.terrain.get(y * width + x); if (r) want.push(r); }
  await mapLimit(want, 8, async (r) => { try { const s = parseTerrainSector(await api.readRef(r)); sectors.set(s.id, s); } catch { /* повреждён */ } });
  const step = terrainStep(spec.w, spec.h);
  const terrain = terrainMeshes(spec, sectors, width, desc.layers, step);
  const water = waterMesh(spec, sectors, width, step);
  if (water) terrain.push(water);

  const B = new LevelBuilder();
  const info = [`Far Cry 2 (Dunia): ${spec.world} · ${spec.name} — сектора ${spec.x0}…${spec.x0 + spec.w - 1} × ${spec.y0}…${spec.y0 + spec.h - 1} (${spec.w * 64}×${spec.h * 64} м)`,
    `Ландшафт: секторов ${sectors.size} из ${spec.w * spec.h}, сетка ${step} м, слоёв ${terrain.length}`];
  let shown = 0;
  if (!spec.terrainOnly) {
    const objs = await worldObjects(api, world, idx);
    const refs: FatRef[] = [];
    const inReg = (x: number, y: number) => x >= spec.x0 && x < spec.x0 + spec.w && y >= spec.y0 && y < spec.y0 + spec.h;
    for (let y = spec.y0; y < spec.y0 + spec.h; y++) for (let x = spec.x0; x < spec.x0 + spec.w; x++) refs.push(...(objs.get(y * 65536 + x) ?? []));
    if (!idx.full && want.length) {
      // большой мир: сектора-коллекции лежат в блоке ландшафта рядом со своим ландшафтом (порядок Мортона по картам)
      const lo = Math.min(...want.map((r) => r.fe.off)), hi = Math.max(...want.map((r) => r.fe.off));
      const cand = idx.files.filter((r) => r.fe.off > lo - 65536 && r.fe.off < hi + 65536 && r.fe.size >= 64 && !isTerrainSize(r.fe.size));
      const heads = await mapLimit(cand, 32, async (r) => { try { return await api.readRef(r, 64); } catch { return null; } });
      heads.forEach((h, i) => { const xy = h && worldSectorXY(h); if (xy && inReg(xy[0], xy[1]) && !refs.includes(cand[i]!)) refs.push(cand[i]!); });
    }
    shown = await placeEntities(arc, api, world.name, refs, B, (s) => info.push(s));
  } else info.push('Весь мир — только ландшафт; объекты — на картах worlds/…/maps/*.fc2level');
  const meshes = [...B.build(), ...terrain];
  if (!meshes.length) throw new Error('В области уровня нет секторов');
  if (!shown && !spec.terrainOnly) info.push('Объекты не найдены');
  info.push(water ? `Вода: по уровню сектора (${[...new Set([...sectors.values()].map((x) => x.water).filter(Boolean))].slice(0, 5).join(', ')} м), полупрозрачная плоскость там, где земля ниже` : 'Воды в области нет');
  info.push('Не показаны: небо; деревья RealTree — приближённо');
  return { meshes, instances: B.scene, skeleton: null, motions: [], bounds: boundsOf(meshes), info, defaultZUp: true };
}

async function placeEntities(arc: Archive, api: DuniaArchiveApi, worldName: string, sectorRefs: FatRef[], B: LevelBuilder, note: (s: string) => void): Promise<number> {
  // библиотека архетипов мира
  let lib = new Map<string, { model: string; parts: string[] }>();
  const le = arc.lookup(`worlds/${worldName}/generated/entitylibrary.fcb`);
  if (le) { try { lib = entityLibrary(parseFcb(await arc.read(le))); } catch { note('entitylibrary.fcb не прочитана'); } }
  const ents: LevelEntity[] = [], unknown = new Set<string>();
  let noModel = 0, sectorsWithObjects = 0, collected = 0;
  const markers: LevelMarker[] = [];
  await mapLimit(sectorRefs, 8, async (r) => {
    let root: FcbObject;
    try { root = parseFcb(await api.readRef(r)); } catch { return; }
    const s = sectorEntities(root, lib);
    if (s.list.length) sectorsWithObjects++;
    ents.push(...s.list); noModel += s.noModel; markers.push(...s.markers);
    for (const c of sectorCollections(root)) {
      const name = api.nameOfHash(c.hash);
      ents.push({ name: name?.split('\\').pop()?.replace(/\.xbg$/i, '') ?? `#${c.hash.toString(16)}`, model: `#${c.hash.toString(16).padStart(8, '0')}`, parts: [], pos: c.pos, angles: [0, 0, c.yaw], layer: 'collections' });
      collected++;
    }
    for (const a of s.unknownArchetype) unknown.add(a);
  });
  ents.sort((a, b) => a.name.localeCompare(b.name) || a.pos[0]! - b.pos[0]! || a.pos[1]! - b.pos[1]! || a.pos[2]! - b.pos[2]!);
  // модели: ближний LOD; если вместе больше бюджета треугольников — у самых «тяжёлых» (число × треугольники) дальний LOD
  // коллекции (трава, кусты, камни — сотни тысяч экземпляров на карту) — отдельно: LOD1 и прореживание до своего бюджета
  const counts = new Map<string, number>(), colCounts = new Map<string, number>();
  for (const e of ents) { const m = e.layer === 'collections' ? colCounts : counts; m.set(e.model.toLowerCase(), (m.get(e.model.toLowerCase()) ?? 0) + 1); }
  const parsedModels = new Map<string, { u: Uint8Array; x: Xbg } | null>();
  // модель по пути или по хешу (#xxxxxxxx — коллекции); не .xbg (RealTree-деревья .rtr) — пропускаются
  const realtrees = new Set<string>(), rtMeshes = new Map<string, Mesh[]>();
  // RealTree: приближённая сетка (ветви трубками, листва карточками) с материалами коры и листвы из .xbm
  const realTreeOf = async (t: RealTree): Promise<Mesh[]> => {
    const mats = await Promise.all(t.materials.map(async (m) => {
      const e = arc.lookup(m.replace(/\.mlm$/i, '.xbm'));
      try { return e ? { path: m, x: parseXbm(await arc.read(e)) } : null; } catch { return null; }
    }));
    const slot = (x: XbmMaterial | undefined, ...keys: string[]) => { for (const k of keys) if (x?.textures[k]) return x.textures[k]; return undefined; };
    const pick = (trunk: boolean) => {
      const m = mats.find((q) => q && /trunk|bark/i.test(q.x.shader + q.x.name) === trunk) ?? mats[trunk ? 0 : 1] ?? null;
      return { material: m?.path, texture: slot(m?.x, 'DiffuseTexture1', 'DiffuseTexture') ?? '', normal: slot(m?.x, 'NormalTexture1', 'NormalTexture') };
    };
    return realTreeMeshes(t, pick(true), pick(false));
  };
  const displayName = (k: string) => (k.startsWith('#') ? api.nameOfHash(parseInt(k.slice(1), 16)) ?? k : k);
  const readModel = async (k: string) => {
    if (k.startsWith('#')) { const r = api.refByHash(parseInt(k.slice(1), 16)); return r ? api.readRef(r) : null; }
    const e = arc.lookup(k);
    return e ? arc.read(e) : null;
  };
  await mapLimit([...new Set([...counts.keys(), ...colCounts.keys()])], 8, async (k) => {
    try {
      const u = await readModel(k);
      if (!u) { parsedModels.set(k, null); return; }
      if (String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'HSEM') {
        parsedModels.set(k, null);
        if (isRealTree(u)) { realtrees.add(k); try { rtMeshes.set(k, await realTreeOf(parseRealTree(u))); } catch { /* не разобран */ } }
        return;
      }
      parsedModels.set(k, { u, x: parseXbg(u) });
    } catch { parsedModels.set(k, null); }
  });
  const lodOf = new Map<string, number>();
  const trisOf = (k: string, l: number) => {
    const rt = rtMeshes.get(k);
    if (rt) return rt.reduce((n, m) => n + m.indices.length / 3, 0);
    const p = parsedModels.get(k), L = p?.x.lods[Math.min(l, (p?.x.lods.length ?? 1) - 1)];
    if (!p || !L) return 0;
    // как в xbgMeshes: без скрытых по умолчанию частей (повреждённые состояния, ночные фары)
    let n = 0;
    L.prims.forEach((pr, i) => { const name = p.x.parts[pr.part]?.name ?? ''; if (!/STATE0*[2-9]$|_N_/i.test(name.replace(/_LOD\d+$/i, ''))) n += ((L.prims[i + 1]?.firstIndex ?? L.icount) - pr.firstIndex) / 3; });
    return n;
  };
  let total = 0;
  for (const [k, n] of counts) total += n * trisOf(k, 0);
  const lodNote = total;
  if (total > TRI_BUDGET) {
    const order = [...counts].sort((a, b) => b[1] * trisOf(b[0], 0) - a[1] * trisOf(a[0], 0));
    for (const [k, n] of order) {
      if (total <= TRI_BUDGET) break;
      const p = parsedModels.get(k);
      if (!p || p.x.lods.length < 2) continue;
      const far = Math.min(2, p.x.lods.length - 1);
      total -= n * (trisOf(k, 0) - trisOf(k, far));
      lodOf.set(k, far);
    }
  }
  const colLod = (k: string) => Math.min(COLLECTION_LOD, (parsedModels.get(k)?.x.lods.length ?? 1) - 1);
  // бюджет делится поровну между моделями коллекций: редкие (камни, кусты) остаются целиком, прореживается массовое (трава)
  const colKeepOf = new Map<string, number>();
  let colTotal = 0;
  {
    const rows = [...colCounts].map(([k, n]) => ({ k, t: n * trisOf(k, colLod(k)) })).filter((r) => r.t > 0).sort((a, b) => a.t - b.t);
    let left = COLLECTION_BUDGET;
    rows.forEach((r, i) => { colTotal += r.t; const keep = Math.min(1, left / (rows.length - i) / r.t); colKeepOf.set(r.k, keep); left -= keep * r.t; });
  }
  const matCache = new Map<string, Promise<XbmMaterial | null>>();
  const protos = new Map<string, Promise<{ pi: number; parts: Mesh[] } | null>>();
  const missing = new Set<string>();
  let skinned = 0;
  const protoOf = (model: string, parts: string[], lod: number) => {
    const mk = model.toLowerCase(), key = `${mk}|${lod}|${parts.join(';')}`;
    let pr = protos.get(key);
    if (!pr) {
      pr = (async () => {
        const rt = rtMeshes.get(mk);
        if (rt?.length) return { pi: B.proto(displayName(model), rt, 'static', (m) => m.name), parts: rt };
        const p = parsedModels.get(mk);
        if (!p) { if (!realtrees.has(mk)) missing.add(model); return null; }
        try {
          const r = await xbgMeshes(p.u, arc, matCache, lod, p.x);
          // со скелетом (люди, животные) — в bind-позе; у кита без списка частей — один вариант на слот
          const all = r.skinned ? bakeBindPose(r.x, r.meshes) : r.meshes;
          if (r.skinned) skinned++;
          const want = new Set(parts.map((q) => q.toUpperCase()));
          const kit = want.size ? new Set<string>() : kitHiddenParts(all.map((m) => m.name.split(' · ')[0]!));
          const list = all.filter((m) => { const part = m.name.split(' · ')[0]!; return !m.defaultHidden && !kit.has(part) && (!want.size || want.has(part.toUpperCase())); });
          if (!list.length) return null;
          const label = (m: Mesh) => m.material?.split('\\').pop() || m.texture.split('\\').pop() || '?';
          return { pi: B.proto(displayName(model), list, 'static', label), parts: list };
        } catch { missing.add(model); return null; }
      })();
      protos.set(key, pr);
    }
    return pr;
  };
  let placed = 0, placedCol = 0, treeInst = 0;
  const treeMarks: Array<{ name: string; pos: number[] }> = [];
  const pick = rngOf(0x5eed);
  let thinned = 0;
  for (const e of ents) {
    const col = e.layer === 'collections', mk = e.model.toLowerCase();
    if (col && (colKeepOf.get(mk) ?? 1) < 1 && pick() >= colKeepOf.get(mk)!) { thinned++; continue; }
    const pr = await protoOf(e.model, e.parts, col ? colLod(mk) : lodOf.get(mk) ?? 0);
    if (!pr) { if (realtrees.has(e.model.toLowerCase())) { treeInst++; treeMarks.push({ name: e.name, pos: e.pos }); } continue; }
    const M = new Float64Array(16);
    compose(e.pos, anglesQuat(e.angles), [1, 1, 1], M);
    const path = displayName(e.model);
    const folder = path.startsWith('#') ? 'collections' : path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || 'graphics';
    B.place(pr.pi, pr.parts, M, e.name, e.layer === 'collections' ? `collections/${folder}` : folder);
    placed++;
    if (e.layer === 'collections') placedCol++;
  }
  // метки (скрыты; включаются в списке мешей): частицы, свет, деревья RealTree (их сетка строится движком — здесь только место)
  const mark = (list: Array<{ name: string; pos: number[] }>, label: string, color: number[], size: number, layer: string) => {
    if (!list.length) return;
    const m = markerMesh(label, size, color), pi = B.proto(label, [m], 'marker', () => label, true);
    for (const x of list) { const M = new Float64Array(16); compose(x.pos, [1, 0, 0, 0], [1, 1, 1], M); B.place(pi, [m], M, x.name, layer); }
  };
  mark(markers.filter((x) => x.kind === 'particle'), 'Метки · частицы', [0.3, 0.8, 1], 0.3, 'particle');
  mark(markers.filter((x) => x.kind === 'light'), 'Метки · свет', [1, 0.85, 0.3], 0.3, 'light');
  mark(treeMarks, 'Метки · деревья RealTree (не разобраны)', [0.25, 0.75, 0.2], 1.5, 'realtree');
  note(`Объекты: ${placed} из ${ents.length} с моделью (секторов с объектами ${sectorsWithObjects}, файлов секторов ${sectorRefs.length}; моделей ${[...protos.keys()].length}, треугольников ${B.tris})`);
  if (lodOf.size) note(`Дальний LOD у ${lodOf.size} моделей (ближние LOD всех объектов — ${Math.round(lodNote / 1e6 * 10) / 10} млн треугольников, бюджет ${TRI_BUDGET / 1e6} млн)`);
  if (collected) note(`Коллекции (трава, кусты, камни, мусор — кисть редактора), LOD${COLLECTION_LOD}: ${placedCol} из ${collected}${thinned ? ` (массовые модели прорежены: всего ${Math.round(colTotal / 1e5) / 10} млн треугольников, бюджет ${COLLECTION_BUDGET / 1e6} млн)` : ''}${realtrees.size ? `; деревья и кусты RealTree (.rtr): моделей ${realtrees.size}, приближённо — ветви трубками по узлам, листва карточками у концов ветвей (сетку игра строит сама)${treeInst ? `, не разобрано ${treeInst} экземпляров` : ''}` : ''}`);
  if (noModel) note(`Без модели (логика, точки, звук, частицы, свет): ${noModel}`);
  if (markers.length || treeMarks.length) note(`Метки (скрыты, включаются в списке мешей): частицы ${markers.filter((x) => x.kind === 'particle').length}, свет ${markers.filter((x) => x.kind === 'light').length}, деревья RealTree ${treeMarks.length}`);
  if (skinned) note(`Модели со скелетом (люди, животные) — в bind-позе: ${skinned}`);
  if (missing.size) note(`Модели не найдены: ${missing.size} (${[...missing].slice(0, 3).join(', ')}${missing.size > 3 ? '…' : ''})`);
  if (unknown.size) note(`Архетипы не найдены в entitylibrary.fcb: ${unknown.size} (${[...unknown].slice(0, 2).join(', ')})`);
  return placed;
}
