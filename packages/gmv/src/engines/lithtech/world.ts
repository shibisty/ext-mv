// Уровни LithTech Jupiter EX (F.E.A.R. Online): Game/worlds/…/<карта>.wld + .wldclnt + .wldmsh, префабы .inst. Разобрано по файлам игры.
//
// .wldclnt «WLDC» v126: 10×u32 (с 0x08): [0x08] объектов WorldModel, [0x0c] групп и [0x10] записей статической геометрии,
//   [0x14] экземпляров префабов, [0x20] областей; с 0x30 области: u32 1, u32 число материалов, u16 + путь .wldmsh,
//   u32 0, материалы u16 + путь .mat (номер материала секции .wldmsh — номер в этом списке);
//   затем экземпляры префабов: f32×3 мин., f32×3 макс., f32×3 позиция, кватернион x,y,z,w, 3×u32, u16 + путь .inst.
// .wldmsh — тот же «MESH», что у моделей, в координатах мира; у нескольких секций общий участок вершин
//   (первое поле секции — первая вершина участка; индексы — от начала участка).
// .inst «PRFB» v1: u32 1, u32 хеш, u32, u32 секций, u32 объявлений вершин, u32, u32, u32 элементов, u32 размер данных,
//   u32 материалов, u32 байт вершин, u32 байт индексов; с 0x34 — вершины и индексы u16; сразу за ними (без выравнивания) — объявления вершин
//   и секции как в «MESH», материалы — строки с нулём (выравнивание 4 от начала списка).
import { boundsOf } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import { compose } from '../../core/math';
import type { InstancedScene, Mesh, Model, PlacementRange, VFile } from '../../core/types';
import { applyMaterials, readAny } from './load';
import { parseMesh, sectionMesh, type LtMeshData } from './model';

export interface WldRegion { mesh: string; mats: string[] }
export interface WldInstance { path: string; pos: [number, number, number]; rot: [number, number, number, number] }
export interface WldClient { regions: WldRegion[]; instances: WldInstance[] }

export function parseWldClient(u: Uint8Array): WldClient {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 0x30 || String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'WLDC') throw new Error('Не файл уровня LithTech (нет «WLDC»)');
  let p = 0x30;
  const str = () => {
    const n = dv.getUint16(p, true);
    if (p + 2 + n > u.length) throw new Error('.wldclnt: строка за концом файла');
    const s = String.fromCharCode(...u.subarray(p + 2, p + 2 + n));
    p += 2 + n;
    return s;
  };
  const regions: WldRegion[] = [];
  for (let r = 0, n = dv.getUint32(0x20, true); r < n; r++) {
    const nm = dv.getUint32(p + 4, true);
    p += 8;
    const mesh = str();
    p += 4;
    if (nm > 100000) throw new Error('.wldclnt: неверное число материалов');
    const mats: string[] = [];
    for (let k = 0; k < nm; k++) mats.push(str());
    regions.push({ mesh, mats });
  }
  const instances: WldInstance[] = [], nInst = dv.getUint32(0x14, true);
  while (p + 66 <= u.length && instances.length < nInst) {
    const n = dv.getUint16(p + 64, true);
    if (!n || n > 260 || p + 66 + n > u.length) break;
    const s = u.subarray(p + 66, p + 66 + n);
    if (!s.every((c) => c >= 32 && c < 127)) break;
    const f = (k: number) => dv.getFloat32(p + k * 4, true);
    const rot: [number, number, number, number] = [f(9), f(10), f(11), f(12)];
    if (Math.abs(Math.hypot(...rot) - 1) > 0.01) break;
    instances.push({ path: String.fromCharCode(...s), pos: [f(6), f(7), f(8)], rot });
    p += 66 + n;
  }
  return { regions, instances };
}

export interface LtPrefab { mesh: LtMeshData; mats: string[] }

export function parsePrefab(u: Uint8Array): LtPrefab {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 0x34 || String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'PRFB') throw new Error('Не префаб LithTech (нет «PRFB»)');
  const h = (k: number) => dv.getUint32(4 + k * 4, true);
  const dataSize = h(8), nMats = h(9), vb = h(10), ib = h(11);
  const vAt = 0x34, iAt = vAt + vb;
  // хвост — сразу за индексами (размер данных в заголовке выровнен на 4)
  let t = iAt + ib;
  if (vb + ib > dataSize || t + 8 > u.length) throw new Error('.inst: данные выходят за конец файла');
  const decls: LtMeshData['decls'] = [];
  const nd = dv.getUint32(t, true);
  t += 4;
  if (nd > 64) throw new Error('.inst: неверное число объявлений вершин');
  for (let k = 0; k < nd; k++) {
    const n = dv.getUint32(t, true);
    t += 4;
    if (t + n * 4 > u.length) throw new Error('.inst: объявления вершин обрезаны');
    const els = [];
    for (let e = 0; e < n; e++, t += 4) els.push({ type: u[t + 1]!, usage: u[t + 2]!, index: u[t + 3]! });
    decls.push(els);
  }
  const ns = dv.getUint32(t, true);
  t += 4;
  const sections: LtMeshData['sections'] = [];
  for (let k = 0; k < ns; k++, t += 36) {
    if (t + 36 > u.length) throw new Error('.inst: таблица секций обрезана');
    const w = (m: number) => dv.getUint32(t + m * 4, true);
    sections.push({ vcount: w(1), istart: w(2), vstart: w(3), tris: w(4), material: w(5), palCount: w(6), palOff: w(7), decl: w(8) });
  }
  // строки материалов выровнены на 4 от начала списка
  const mats: string[] = [], s0 = t;
  for (let k = 0; k < nMats && t < u.length; k++) {
    let s = '';
    while (t < u.length && u[t]) s += String.fromCharCode(u[t++]!);
    if (/[^\x20-\x7e]/.test(s)) break; // число в заголовке бывает больше, чем строк
    t = s0 + ((t - s0 + 4) & ~3);
    mats.push(s);
  }
  return { mesh: { sections, decls, palettes: new Uint8Array(0), u, vAt, iAt }, mats };
}

interface Group { mat: string; pos: number[]; nor: number[]; uv: number[]; idx: number[] }

/** Секции с UV (без теней), сгруппированные по пути материала. */
function sectionParts(mesh: LtMeshData, mats: readonly string[]): Array<{ mat: string; m: Mesh; k: number }> {
  const out: Array<{ mat: string; m: Mesh; k: number }> = [];
  for (let k = 0; k < mesh.sections.length; k++) {
    const sm = sectionMesh(mesh, k, undefined);
    if (!sm) continue;
    const mat = mats[sm.material] ?? `#${sm.material}`;
    if (/shadowvolume/i.test(mat)) continue;
    out.push({ mat, m: sm.mesh, k });
  }
  return out;
}

const boxOf = (p: Float32Array) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { const v = p[i + a]!; if (v < b[a]!) b[a] = v; if (v > b[a + 3]!) b[a + 3] = v; }
  return b;
};

/**
 * Секции статической геометрии: в .wldclnt у каждой — запись [f32×6 рамка в координатах мира, u32, u32 номер секции области]
 * (таблицы групп разобраны не до конца, поэтому записи ищутся по совпадению рамки с рамкой секции). Остальные секции —
 * объекты WorldModel (двери, окна, вентиляторы…) в своих координатах.
 */
export function findStaticSections(u: Uint8Array, boxes: ReadonlyArray<ReadonlyMap<number, number[]>>): Set<string> {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out = new Set<string>();
  const near = (v: number, w: number) => Math.abs(v - w) <= 0.01 + Math.abs(w) * 1e-5;
  for (let o = 0x30; o + 32 <= u.length; o++) {
    const k = dv.getUint32(o + 28, true);
    if (k > 0xffff) continue;
    for (let r = 0; r < boxes.length; r++) {
      const b = boxes[r]!.get(k);
      if (!b || out.has(`${r}:${k}`)) continue;
      let ok = true;
      for (let a = 0; a < 6 && ok; a++) ok = near(dv.getFloat32(o + a * 4, true), b[a]!);
      if (ok) out.add(`${r}:${k}`);
    }
  }
  return out;
}

function toMeshes(groups: Iterable<Group>, prefix: string): Mesh[] {
  return [...groups].map((g) => {
    const n = g.pos.length / 3, weight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) weight[i * 4] = 1;
    return {
      name: `${prefix}${g.mat.split('\\').pop()?.replace(/\.mat$/i, '') || '?'}`, texture: '', material: g.mat, vertexCount: n,
      pos: Float32Array.from(g.pos), nor: Float32Array.from(g.nor), uv: Float32Array.from(g.uv), bone: new Float32Array(n * 4), weight,
      indices: n > 65535 ? Uint32Array.from(g.idx) : Uint16Array.from(g.idx), skinned: false,
    };
  });
}

export async function loadLithtechWorld(main: VFile, ctx: LoadContext): Promise<Model> {
  const path = main.path ?? main.name;
  const clu = await readAny(ctx, path.replace(/\.(wld|wldmsh|wldsrvr|wldclnt)$/i, '.wldclnt'), main);
  if (!clu) throw new Error('Не найден .wldclnt уровня — откройте папку игры (Game/worlds/…) целиком');
  const cl = parseWldClient(clu);
  const info = ['LithTech Jupiter EX (F.E.A.R. Online): уровень', `Областей: ${cl.regions.length}, экземпляров префабов: ${cl.instances.length}`];
  // геометрия областей
  const world = new Map<string, Group>(), movable = new Map<string, Group>();
  let tris = 0, movTris = 0;
  const missingMesh: string[] = [], regionParts: Array<Array<{ mat: string; m: Mesh; k: number }>> = [];
  for (const r of cl.regions) {
    const mu = await readAny(ctx, r.mesh, main);
    if (!mu) { missingMesh.push(r.mesh); regionParts.push([]); continue; }
    regionParts.push(sectionParts(parseMesh(mu), r.mats));
  }
  // статическая геометрия против подвижных объектов: если записи нашлись хотя бы для половины секций
  const boxes = regionParts.map((list) => new Map(list.map((p) => [p.k, boxOf(p.m.pos)] as const)));
  const found = findStaticSections(clu, boxes), total = regionParts.reduce((n, l) => n + l.length, 0);
  const split = found.size >= total / 2;
  const add = (to: Map<string, Group>, mat: string, m: Mesh) => {
    let g = to.get(mat);
    if (!g) to.set(mat, (g = { mat, pos: [], nor: [], uv: [], idx: [] }));
    const base = g.pos.length / 3;
    for (let i = 0; i < m.pos.length; i++) { g.pos.push(m.pos[i]!); g.nor.push(m.nor[i]!); }
    for (let i = 0; i < m.uv.length; i++) g.uv.push(m.uv[i]!);
    for (let i = 0; i < m.indices.length; i++) g.idx.push(base + m.indices[i]!);
  };
  regionParts.forEach((list, r) => {
    for (const { mat, m, k } of list) {
      // без записи и у начала координат — объект в своих координатах; без записи, но на своём месте (поезд, небо) — остаётся
      const b = boxes[r]!.get(k)!, local = Math.hypot((b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2) < 1500;
      if (split && local && !found.has(`${r}:${k}`)) { add(movable, mat, m); movTris += m.indices.length / 3; } else { add(world, mat, m); tris += m.indices.length / 3; }
    }
  });
  if (missingMesh.length) info.push(`Не найдена геометрия: ${missingMesh.slice(0, 3).join(', ')}${missingMesh.length > 3 ? '…' : ''}`);
  info.push(`Геометрия уровня: ${tris} треугольников, ${world.size} материалов`);
  if (movTris) info.push(`Подвижные объекты (двери, окна, вентиляторы…): ${movTris} треугольников — в своих координатах, без позиции на карте; скрыты, включаются в слоях`);
  const meshes = [...toMeshes(world.values(), ''), ...toMeshes(movable.values(), 'WorldModel · ').map((m) => ({ ...m, defaultHidden: true }))];
  // префабы
  const instances: InstancedScene = { meshes: [], protos: [], placements: [] };
  const groups = new Map<string, Group>(), protoOf = new Map<string, number>(), protoParts = new Map<number, Array<{ mat: string; m: Mesh }>>();
  const missingInst = new Set<string>();
  let placed = 0;
  const gi = (mat: string) => [...groups.keys()].indexOf(mat);
  for (const inst of cl.instances) {
    let pi = protoOf.get(inst.path);
    if (pi === undefined) {
      const iu = await readAny(ctx, inst.path, main);
      let parts: Array<{ mat: string; m: Mesh }> = [];
      if (iu) { try { const pf = parsePrefab(iu); parts = sectionParts(pf.mesh, pf.mats); } catch { parts = []; } }
      if (!parts.length) { missingInst.add(inst.path); protoOf.set(inst.path, -1); continue; }
      pi = instances.protos.length;
      protoOf.set(inst.path, pi);
      for (const p of parts) if (!groups.has(p.mat)) groups.set(p.mat, { mat: p.mat, pos: [], nor: [], uv: [], idx: [] });
      instances.protos.push({ name: inst.path, parts: parts.map((p) => ({ mesh: gi(p.mat), pos: p.m.pos, nor: p.m.nor, uv: p.m.uv, indices: Uint32Array.from(p.m.indices) })) });
      protoParts.set(pi, parts);
    }
    if (pi < 0) continue;
    const M = new Float64Array(16);
    compose(inst.pos, [inst.rot[3], inst.rot[0], inst.rot[1], inst.rot[2]], [1, 1, 1], M);
    const ranges: PlacementRange[] = [];
    for (const [partIndex, p] of protoParts.get(pi)!.entries()) {
      const g = groups.get(p.mat)!, base = g.pos.length / 3, n = p.m.vertexCount;
      ranges.push({ mesh: gi(p.mat), part: partIndex, vStart: base, vCount: n, iStart: g.idx.length, iCount: p.m.indices.length });
      for (let i = 0; i < n; i++) {
        const x = p.m.pos[i * 3]!, y = p.m.pos[i * 3 + 1]!, z = p.m.pos[i * 3 + 2]!;
        g.pos.push(x * M[0]! + y * M[4]! + z * M[8]! + M[12]!, x * M[1]! + y * M[5]! + z * M[9]! + M[13]!, x * M[2]! + y * M[6]! + z * M[10]! + M[14]!);
        const nx = p.m.nor[i * 3]!, ny = p.m.nor[i * 3 + 1]!, nz = p.m.nor[i * 3 + 2]!;
        g.nor.push(nx * M[0]! + ny * M[4]! + nz * M[8]!, nx * M[1]! + ny * M[5]! + nz * M[9]!, nx * M[2]! + ny * M[6]! + nz * M[10]!);
        g.uv.push(p.m.uv[i * 2]!, p.m.uv[i * 2 + 1]!);
      }
      for (let i = 0; i < p.m.indices.length; i++) g.idx.push(base + p.m.indices[i]!);
    }
    instances.placements.push({ proto: pi, name: inst.path.split('\\').pop()!.replace(/\.inst$/i, ''), pose: Array.from(M), group: inst.path.split('\\').slice(1, -1).join('/') || 'prefabs', ranges });
    placed++;
  }
  const objMeshes = toMeshes(groups.values(), 'префабы · ');
  instances.meshes = objMeshes.map((_, i) => meshes.length + i);
  for (const pr of instances.protos) for (const part of pr.parts) part.mesh += meshes.length;
  for (const pl of instances.placements) for (const r of pl.ranges ?? []) r.mesh += meshes.length;
  info.push(`Префабов показано: ${placed} (моделей ${instances.protos.length})${missingInst.size ? `, не найдено: ${missingInst.size} (${[...missingInst].slice(0, 3).join(', ')}${missingInst.size > 3 ? '…' : ''})` : ''}`);
  const all = [...meshes, ...objMeshes];
  if (!all.length) throw new Error('В уровне нет геометрии с текстурными координатами');
  const missing = await applyMaterials(all, (m) => m.material, main, ctx);
  if (missing.length) info.push(`Не найдены материалы: ${missing.length} (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''})`);
  return { meshes: all, instances: instances.placements.length ? instances : undefined, skeleton: null, motions: [], bounds: boundsOf(all), info, flipZ: true };
}
