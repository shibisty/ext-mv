// Уровень Metro 2033 (4A): maps/<уровень>/level + level.geom_pc. Устроен как скомпилированный уровень X-Ray:
// level: 1 версия (16), 2 шейдеры (u16 число; «шейдер», «текстура», «материал», 4 байта флагов), 3 визуалы, 8 секторы;
// визуал: 0x15 — [формат, начало и число вершин, начало и число индексов], 1 — заголовок (u16 версия, u16 шейдер, AABB, сфера);
// level.geom_pc: 9 — вершины (32 байта: позиция, нормаль/касательная/бинормаль D3DCOLOR, UV × 1024 и лайтмап в short), 10 — индексы u16.
// Система координат — как у X-Ray: левосторонняя, Y вверх, внешняя нормаль = (b − a) × (c − a) (сверено с нормалями вершин).
import { boundsOf } from '../../core/geometry';
import { decodeDDS } from '../../core/images/dds';
import type { LoadContext } from '../../core/plugin';
import type { TextureLibrary, TextureSource } from '../../core/textures';
import type { EngineMaps } from '../../core/plugin';
import type { DecodedImage, Mesh, Model, VFile } from '../../core/types';
import { ddsFromPieces } from './texture';

const STRIDE = 32;
interface Chunk { id: number; data: Uint8Array }
function chunks(u: Uint8Array): Chunk[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out: Chunk[] = [];
  for (let p = 0; p + 8 <= u.length;) {
    const id = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > u.length) break;
    out.push({ id, data: u.subarray(p + 8, p + 8 + size) });
    p += 8 + size;
  }
  return out;
}
const dvOf = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.byteLength);

export interface MetroShader { shader: string; texture: string; material: string; flags: number }

export function parseShaders(u: Uint8Array): MetroShader[] {
  const n = dvOf(u).getUint16(0, true), out: MetroShader[] = [];
  let p = 2;
  const sz = () => { let s = ''; while (p < u.length && u[p]) s += String.fromCharCode(u[p++]!); p++; return s; };
  for (let i = 0; i < n && p < u.length; i++) { const shader = sz(), texture = sz(), material = sz(); out.push({ shader, texture, material, flags: dvOf(u).getUint32(p, true) }); p += 4; }
  return out;
}

export function metroLevelModel(level: Uint8Array, geom: Uint8Array, name: string): Model {
  const top = chunks(level), g = chunks(geom);
  const ver = top.find((c) => c.id === 1), sh = top.find((c) => c.id === 2), vis = top.find((c) => c.id === 3), vb = g.find((c) => c.id === 9), ib = g.find((c) => c.id === 10);
  if (!sh || !vis || !vb || !ib) throw new Error('Не уровень 4A: нет шейдеров, визуалов или буферов level.geom_pc');
  const shaders = parseShaders(sh.data), V = dvOf(vb.data), I = dvOf(ib.data), nv = vb.data.length / STRIDE, ni = ib.data.length / 2;
  const groups = new Map<number, { pos: number[]; nor: number[]; uv: number[]; uv2: number[]; idx: number[] }>();
  let used = 0, bad = 0, hier = 0;
  for (const v of chunks(vis.data)) {
    const sub = chunks(v.data), gc = sub.find((c) => c.id === 0x15), hd = sub.find((c) => c.id === 1);
    if (!gc || !hd) { hier++; continue; }
    const d = dvOf(gc.data), [voff, vcnt, ioff, icnt] = [4, 8, 12, 16].map((o) => d.getUint32(o, true)) as [number, number, number, number];
    const si = dvOf(hd.data).getUint16(2, true);
    if (voff + vcnt > nv || ioff + icnt > ni) { bad++; continue; }
    let gr = groups.get(si);
    if (!gr) groups.set(si, (gr = { pos: [], nor: [], uv: [], uv2: [], idx: [] }));
    const base = gr.pos.length / 3;
    for (let i = 0; i < vcnt; i++) {
      const o = (voff + i) * STRIDE;
      gr.pos.push(V.getFloat32(o, true), V.getFloat32(o + 4, true), V.getFloat32(o + 8, true));
      const nx = (V.getUint8(o + 14) / 255) * 2 - 1, ny = (V.getUint8(o + 13) / 255) * 2 - 1, nz = (V.getUint8(o + 12) / 255) * 2 - 1, l = Math.hypot(nx, ny, nz) || 1;
      gr.nor.push(nx / l, ny / l, nz / l);
      gr.uv.push(V.getInt16(o + 24, true) / 1024, V.getInt16(o + 26, true) / 1024);
      // UV карты освещения: s16 / 32768 по всей карте level.lmap_pc
      gr.uv2.push(V.getInt16(o + 28, true) / 32768, V.getInt16(o + 30, true) / 32768);
    }
    for (let i = 0; i < icnt; i++) gr.idx.push(base + I.getUint16((ioff + i) * 2, true));
    used++;
  }
  const meshes: Mesh[] = [...groups].map(([si, gr]) => {
    const s = shaders[si], n = gr.pos.length / 3;
    return {
      name: `${s?.texture || '?'} · ${s?.material ?? ''}`, texture: s?.texture ?? '', shader: s?.shader, material: s?.material, vertexCount: n,
      pos: Float32Array.from(gr.pos), nor: Float32Array.from(gr.nor), uv: Float32Array.from(gr.uv), uv2: Float32Array.from(gr.uv2),
      alphaTest: /aref|wallmark|alpha/i.test(s?.shader ?? '') || undefined,
      bone: new Float32Array(n * 4), weight: new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), indices: Uint32Array.from(gr.idx), skinned: false,
    };
  }).filter((m) => m.indices.length);
  const version = ver ? dvOf(ver.data).getUint32(0, true) : 0;
  const info = [
    `Уровень 4A (Metro 2033, версия ${version}): ${name}`,
    `Визуалов с геометрией ${used}, узлов иерархии ${hier}${bad ? `, пропущено ${bad}` : ''}; шейдеров ${shaders.length}`,
    `Мешей (по шейдерам) ${meshes.length}, вершин ${meshes.reduce((a, m) => a + m.vertexCount, 0)}, треугольников ${meshes.reduce((a, m) => a + m.indices.length / 3, 0)}`,
  ];
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true, info };
}

export async function loadMetroLevel(main: VFile, ctx: LoadContext): Promise<Model> {
  const geom = await ctx.sibling('level.geom_pc');
  if (!geom) throw new Error('Рядом с level нет level.geom_pc');
  const dir = (main.path ?? '').split('/').slice(-2, -1)[0] ?? main.name;
  const model = metroLevelModel(new Uint8Array(await main.arrayBuffer()), new Uint8Array(geom), dir);
  // карта освещения: 4096 × 4096, 1 байт (яркость); занята верхняя часть — UV уровня указывают в неё
  const lm = await ctx.sibling('level.lmap_pc');
  if (lm && lm.byteLength === 4096 * 4096) {
    model.lightmap = { width: 4096, height: 4096, data: new Uint8Array(lm), scale: 2.5 };
    model.info.push('Освещение: карта level.lmap_pc (4096×4096)');
  }
  const bin = await ctx.sibling('level.bin');
  if (!bin) { model.info.push('Нет level.bin — объекты уровня не показаны'); return model; }
  try {
    const path = main.path ?? '', i = path.toLowerCase().lastIndexOf('maps/'), root = (i >= 0 ? path.slice(0, i) : '') + 'meshes/';
    const { placeLevelObjects } = await import('./objects');
    const r = await placeLevelObjects(new Uint8Array(bin), (rel) => ctx.readPath(root + rel));
    const base = model.meshes.length;
    model.meshes.push(...r.meshes);
    model.instances = {
      meshes: r.instances.meshes.map((i) => i + base),
      protos: r.instances.protos.map((p) => ({ ...p, parts: p.parts.map((x) => ({ ...x, mesh: x.mesh + base })) })),
      placements: r.instances.placements.map((pl) => ({ ...pl, ranges: pl.ranges?.map((x) => ({ ...x, mesh: x.mesh + base })) })),
    };
    model.bounds = boundsOf(model.meshes);
    model.info.push(...r.info);
  } catch (e) {
    model.info.push(`level.bin: ${(e as Error).message}`);
  }
  return model;
}

/**
 * Текстура 4A по имени («metal\\metal_list_drez»): куски textures/<имя>.2048/.1024/.512 -> DDS.
 * Для показа декодируется только кусок 512 (с mip-уровнями); полный DDS (для экспорта) собирается при чтении файла.
 */
export async function resolveMetroTexture(name: string, lib: TextureLibrary): Promise<TextureSource | null> {
  if (!name) return null;
  const base = 'textures/' + name.toLowerCase().replace(/\\/g, '/');
  const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  for (const a of lib.archives) {
    const sides = [2048, 1024, 512].filter((s) => a.lookup(`${base}.${s}`));
    if (!sides.length) continue;
    const small = sides[sides.length - 1]!, preview = ddsFromPieces([{ side: small, data: await a.read(a.lookup(`${base}.${small}`)!) }]);
    let full: Uint8Array | null = null;
    return {
      name: base.split('/').pop()! + '.dds', path: `${base}.dds`, decoded: decodeDDS(ab(preview)),
      arrayBuffer: async () => {
        if (!full) full = ddsFromPieces(await Promise.all(sides.map(async (side) => ({ side, data: await a.read(a.lookup(`${base}.${side}`)!) }))));
        return ab(full);
      },
    } as TextureSource;
  }
  return null;
}

/**
 * Карты по «<текстура>_bump» (Metro 2033): DXT5, альфа — высота, зелёный — сила блика, красный и синий пусты.
 * Нормали в касательном пространстве считаются из высоты (центральные разности с переносом по краям, Y как в DirectX);
 * поверхность PBR: R — AO 1, G — шероховатость (1 − 0.7 × блик), B — металл 0, A — блик.
 */
export async function resolveMetroMaps(texture: string, lib: TextureLibrary): Promise<EngineMaps | null> {
  if (!texture) return null;
  const src = await resolveMetroTexture(texture + '_bump', lib);
  return src?.decoded?.rgba ? metroBumpMaps(src.decoded) : null;
}

/** Нормали и поверхность из декодированной «_bump» (альфа — высота, зелёный — блик). */
export function metroBumpMaps(img: DecodedImage): EngineMaps | null {
  if (!img.rgba) return null;
  const { width: w, height: h, rgba: px } = img, n = w * h;
  const nor = new Uint8Array(n * 4), surf = new Uint8Array(n * 4);
  // сила рельефа: перепад высоты 0..1 на 1/64 ширины текстуры даёт наклон ~45°
  const k = w / 64, H = (x: number, y: number) => px[(((y + h) % h) * w + ((x + w) % w)) * 4 + 3]! / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * 0.5 * k, dy = (H(x, y + 1) - H(x, y - 1)) * 0.5 * k, l = Math.hypot(dx, dy, 1), o = (y * w + x) * 4;
    nor[o] = Math.round((-dx / l * 0.5 + 0.5) * 255); nor[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255); nor[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255); nor[o + 3] = 255;
    const g = px[o + 1]! / 255;
    surf[o] = 255; surf[o + 1] = Math.round((1 - 0.7 * g) * 255); surf[o + 2] = 0; surf[o + 3] = Math.round(g * 255);
  }
  return {
    normal: { image: { width: w, height: h, rgba: nor }, packing: 'rgb', label: `N ${w}×${h} (_bump)` },
    surface: { image: { width: w, height: h, rgba: surf }, label: 'PBR (_bump)' },
  };
}
