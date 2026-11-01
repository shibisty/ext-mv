// Объекты уровня Metro 2033 из level.bin: пропсы, двери, вагоны, NPC — модели meshes/<visual>.model в позах из файла.
// level.bin = «levl», u32 размер, QuickLZ -> бинарный конфиг (см. config.ts). Поза — матрица 4×4 по строкам (вектор-строка × M).
// Объекты, прикреплённые к другим (parent_id ≠ 0xffff: оружие в руках, руки игрока), не показываются.
import { quicklzDecompress } from '../../core/codecs/quicklz';
import type { InstancedScene, Mesh, PlacementRange } from '../../core/types';
import { metroEntities, parseMetroConfig, type MetroEntity } from './config';
import { partsToMeshes, readMetroModel, type MetroPart } from './model';

export function unpackLevelBin(u: Uint8Array): Uint8Array {
  if (u.length >= 8 && u[0] === 0x6c && u[1] === 0x65 && u[2] === 0x76 && u[3] === 0x6c) { // «levl»
    const size = new DataView(u.buffer, u.byteOffset, u.byteLength).getUint32(4, true);
    return quicklzDecompress(u.subarray(8), size);
  }
  return u;
}

const SKIP = new Set(['PLAYERS_HANDS', 'PLAYERS_KNIFE', 'HANDS_FOR_DREZINA', 'PLAYER']);

export interface PlacedObjects { meshes: Mesh[]; info: string[]; entities: MetroEntity[]; instances: InstancedScene }

/** Объекты level.bin, собранные в меши по текстурам. read — файл относительно content/meshes/. */
export async function placeLevelObjects(bin: Uint8Array, read: (rel: string) => Promise<Uint8Array | null>): Promise<PlacedObjects> {
  const ents = metroEntities(parseMetroConfig(unpackLevelBin(bin)));
  const cache = new Map<string, MetroPart[] | null>(), missing = new Set<string>();
  const groups = new Map<string, { texture: string; shader: string; material: string; pos: number[]; nor: number[]; uv: number[]; idx: number[] }>();
  const protoOf = new Map<string, number>(), instances: InstancedScene = { meshes: [], protos: [], placements: [] };
  const groupIndex = (k: string) => [...groups.keys()].indexOf(k);
  let placed = 0, tris = 0, attached = 0;
  for (const e of ents) {
    if (!e.visual || !e.pose || SKIP.has(e.cls)) continue;
    if (e.parent !== 0xffff) { attached++; continue; }
    const key = e.visual.toLowerCase().replace(/\\/g, '/');
    let parts = cache.get(key);
    if (parts === undefined) {
      const u = await read(key + '.model');
      parts = null;
      if (u) {
        try { parts = (await readMetroModel(u, read)).parts; } catch { parts = null; }
      }
      if (!parts?.length) { missing.add(key); parts = null; }
      cache.set(key, parts);
    }
    if (!parts) continue;
    const M = e.pose;
    let pi = protoOf.get(key);
    if (pi === undefined) {
      pi = instances.protos.length;
      protoOf.set(key, pi);
      instances.protos.push({ name: key, parts: parts.map((p) => {
        const gk = `${p.texture}|${p.shader}|${p.material}`;
        if (!groups.has(gk)) groups.set(gk, { texture: p.texture, shader: p.shader, material: p.material, pos: [], nor: [], uv: [], idx: [] });
        return { mesh: groupIndex(gk), pos: Float32Array.from(p.pos), nor: Float32Array.from(p.nor), uv: Float32Array.from(p.uv), indices: Uint32Array.from(p.idx) };
      }) });
    }
    const ranges: PlacementRange[] = [];
    instances.placements.push({ proto: pi, name: e.name, pose: M.slice(0, 16), group: e.cls || 'прочее', ranges });
    for (const [partIndex, p] of parts.entries()) {
      const gk = `${p.texture}|${p.shader}|${p.material}`;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { texture: p.texture, shader: p.shader, material: p.material, pos: [], nor: [], uv: [], idx: [] }));
      const base = g.pos.length / 3, n = p.pos.length / 3;
      ranges.push({ mesh: groupIndex(gk), part: partIndex, vStart: base, vCount: n, iStart: g.idx.length, iCount: p.idx.length - (p.idx.length % 3) });
      for (let i = 0; i < n; i++) {
        const x = p.pos[i * 3]!, y = p.pos[i * 3 + 1]!, z = p.pos[i * 3 + 2]!;
        g.pos.push(x * M[0]! + y * M[4]! + z * M[8]! + M[12]!, x * M[1]! + y * M[5]! + z * M[9]! + M[13]!, x * M[2]! + y * M[6]! + z * M[10]! + M[14]!);
        const nx = p.nor[i * 3]!, ny = p.nor[i * 3 + 1]!, nz = p.nor[i * 3 + 2]!;
        const ax = nx * M[0]! + ny * M[4]! + nz * M[8]!, ay = nx * M[1]! + ny * M[5]! + nz * M[9]!, az = nx * M[2]! + ny * M[6]! + nz * M[10]!, l = Math.hypot(ax, ay, az) || 1;
        g.nor.push(ax / l, ay / l, az / l);
        g.uv.push(p.uv[i * 2]!, p.uv[i * 2 + 1]!);
      }
      // зеркальная поза (отрицательный определитель) меняет обход треугольников
      const det = M[0]! * (M[5]! * M[10]! - M[6]! * M[9]!) - M[1]! * (M[4]! * M[10]! - M[6]! * M[8]!) + M[2]! * (M[4]! * M[9]! - M[5]! * M[8]!);
      for (let i = 0; i + 2 < p.idx.length; i += 3) {
        if (det < 0) g.idx.push(base + p.idx[i]!, base + p.idx[i + 2]!, base + p.idx[i + 1]!);
        else g.idx.push(base + p.idx[i]!, base + p.idx[i + 1]!, base + p.idx[i + 2]!);
      }
      tris += p.idx.length / 3;
    }
    placed++;
  }
  // группы без треугольников (у прототипа без экземпляров их нет) не выбрасываются: номера мешей прототипов должны совпасть
  const meshes = partsToMeshes([...groups.values()], false, true).map((m) => ({ ...m, name: `объекты · ${m.texture || '?'}` }));
  instances.meshes = meshes.map((_, i) => i);
  const withVisual = ents.filter((e) => e.visual).length;
  const info = [
    `level.bin: объектов ${ents.length}, с моделью ${withVisual}; показано ${placed} (моделей ${[...cache.values()].filter(Boolean).length}, треугольников ${tris})`,
    ...(attached ? [`Прикреплённые к другим объектам (оружие, руки) не показаны: ${attached}`] : []),
    ...(missing.size ? [`Модели не найдены или не прочитаны: ${missing.size} (${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? '…' : ''})`] : []),
  ];
  return { meshes, info, entities: ents, instances };
}
