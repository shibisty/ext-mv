import { describe, expect, it } from 'vitest';
import { objectMeshes, parseObject } from '../src/engines/xray/object';
import { writeObject } from '../src/engines/xray/write-object';
import { parseIni, placeMesh, sceneObjects, sceneRotation } from '../src/engines/xray/scene';
import { sceneEuler, writeScene } from '../src/engines/xray/write-scene';
import { levelModel, splitShader } from '../src/engines/xray/level';
import { Bin } from './helpers/bin';

const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Куб 1×1×1: по 4 вершины на грань (жёсткие рёбра), обход — внешняя нормаль (b − a) × (c − a). */
function cube() {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const faces = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]]];
  for (const [n, a, b] of faces) {
    const base = pos.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) pos.push(0.5 * (n![k]! + s! * a![k]! + t! * b![k]!));
      nor.push(...n!); uv.push((s! + 1) / 2, (t! + 1) / 2);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nor, uv, idx };
}

describe('X-Ray SDK: .object, сцена, скомпилированный уровень', () => {
  it('.object: запись -> чтение сохраняет геометрию, жёсткие рёбра, UV-швы и поверхности', () => {
    const c = cube(), surf = c.idx.map((_, i) => (i < 18 ? 0 : 1)).filter((_, i) => i % 3 === 0);
    const out = writeObject({ surfaces: [{ name: 'стена', texture: 'wall\\стена_01' }, { name: 'pol', texture: 'floor\\floor_01', twoSided: true }], meshes: [{ name: 'cube', pos: c.pos, nor: c.nor, uv: c.uv, indices: c.idx, surface: surf }] });
    const o = parseObject(ab(out));
    expect(o.version).toBe(0x10);
    expect(o.surfaces.map((s) => [s.name, s.texture, s.flags])).toEqual([['стена', 'wall\\стена_01', 0], ['pol', 'floor\\floor_01', 1]]);
    expect(o.meshes[0]!.points.length / 3).toBe(24); // разные нормали — разные точки
    const ms = objectMeshes(o);
    expect(ms.map((m) => m.indices.length / 3)).toEqual([6, 6]);
    for (const m of ms) for (let v = 0; v < m.pos.length / 3; v++) {
      // нормаль угла — нормаль своей грани куба: ось, по которой вершина лежит на ±0.5
      const n = [m.nor[v * 3]!, m.nor[v * 3 + 1]!, m.nor[v * 3 + 2]!], ax = n.findIndex((x) => Math.abs(x) > 0.99);
      expect(ax).toBeGreaterThanOrEqual(0);
      expect(m.pos[v * 3 + ax]! * Math.sign(n[ax]!)).toBeCloseTo(0.5);
    }
  });

  it('.object: гладкая поверхность без нормалей — рёбра по углу, UV-разрыв в «поли»-карте', () => {
    // два треугольника в плоскости с разными UV у общей вершины
    const pos = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1], uv = [0, 0, 1, 0, 1, 1, 0.5, 0.5, 1, 1, 0, 1];
    const o = parseObject(ab(writeObject({ surfaces: [{ name: 's', texture: 't' }], meshes: [{ name: 'm', pos, uv, indices: [0, 2, 1, 3, 5, 4], surface: 0 }] })));
    expect(o.meshes[0]!.points.length / 3).toBe(4);
    expect(o.meshes[0]!.vmaps.map((v) => [v.poly, v.vertices.length])).toEqual([[false, 4], [true, 1]]);
    const m = objectMeshes(o)[0]!;
    const corners = Array.from(m.indices).map((v) => [m.uv[v * 2], m.uv[v * 2 + 1]]);
    expect(corners).toEqual([[0, 0], [1, 1], [1, 0], [0.5, 0.5], [0, 1], [1, 1]]);
    for (let v = 0; v < m.nor.length / 3; v++) expect(m.nor[v * 3 + 1]).toBeCloseTo(1); // (b−a)×(c−a) для такого обхода
  });

  it('сцена: углы part-файла <-> матрица, запись .level и scene_object.part читается обратно', () => {
    for (const rot of [[0.3, -1.2, 0.7], [0, 1.283445, 0], [1.5102, -1.570796, 1.570796], [-0.4, 2.9, -2.2]]) {
      const R = sceneRotation(rot), back = sceneRotation(sceneEuler(R));
      R.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 6));
    }
    const R = sceneRotation([0.1, 0.8, -0.3]);
    const files = writeScene({ name: 'metro_test', objects: [{ name: 'tunnel_0000', reference: 'gmv\\metro\\tunnel', position: [10, 2, -5], matrix: R, scale: [1, 2, 1] }] });
    expect([...files.keys()]).toEqual(['metro_test.level', 'metro_test/scene_object.part']);
    const level = parseIni(new TextDecoder('windows-1251').decode(files.get('metro_test.level')));
    const part = parseIni(new TextDecoder('windows-1251').decode(files.get('metro_test/scene_object.part')));
    expect(level.get('guid')).toEqual(part.get('guid'));
    expect(level.get('level_options')!.get('level_path')).toBe('metro_test');
    const [ref] = sceneObjects(part);
    expect(ref!.reference).toBe('gmv\\metro\\tunnel');
    const placed = placeMesh({ name: '', surface: undefined, pos: Float32Array.of(1, 0, 0), nor: Float32Array.of(0, 1, 0), uv: new Float32Array(2), indices: new Uint32Array(0) }, ref!);
    expect(placed.pos[0]).toBeCloseTo(10 + R[0]!, 5);
    expect(placed.pos[1]).toBeCloseTo(2 + R[1]!, 5);
    expect(placed.pos[2]).toBeCloseTo(-5 + R[2]!, 5);
  });

  it('скомпилированный уровень: буферы level.geom, GCONTAINER, шейдер «шейдер/текстура,лайтмап», UV в SHORT2', () => {
    const chunk = (b: Bin, id: number, body: Bin) => { b.u32(id).u32(body.length).bytes(body.toU8()); };
    const geom = new Bin();
    chunk(geom, 1, new Bin().u16(14).u16(0));
    const vb = new Bin().u32(1);
    // объявление: позиция float3, нормаль D3DCOLOR, касательная, бинормаль, tc0 SHORT2, конец
    for (const [off, type, usage] of [[0, 2, 0], [12, 4, 3], [16, 4, 6], [20, 4, 7], [24, 6, 5]]) vb.u16(0).u16(off!).u8(type!).u8(0).u8(usage!).u8(0);
    vb.u16(0xff).u16(0).u8(17).u8(0).u8(0).u8(0).u32(3);
    for (const [x, y, z, u, v] of [[0, 0, 0, 0, 0], [1, 0, 0, 1024, 0], [0, 0, 1, 0, 2048]]) vb.f32s(x!, y!, z!).u8(127).u8(255).u8(127).u8(0).u32(0).u32(0).i16(u!).i16(v!);
    chunk(geom, 9, vb);
    chunk(geom, 10, new Bin().u32(1).u32(3).u16(0).u16(2).u16(1));
    const lvl = new Bin();
    chunk(lvl, 1, new Bin().u16(14).u16(0));
    chunk(lvl, 2, new Bin().u32(2).cstr('').cstr('default/floor\\floor_01,lmap#1_1'));
    const vis = new Bin(), v0 = new Bin();
    chunk(v0, 21, new Bin().u32(0).u32(0).u32(3).u32(0).u32(0).u32(3));
    chunk(v0, 1, new Bin().u8(4).u8(0).u16(1).f32s(0, 0, 0, 1, 1, 1, 0, 0, 0, 1));
    chunk(vis, 0, v0);
    chunk(lvl, 3, vis);
    const m = levelModel(lvl.toU8(), geom.toU8(), 'test');
    expect(m.meshes).toHaveLength(1);
    expect(m.meshes[0]!.texture).toBe('floor\\floor_01');
    expect(Array.from(m.meshes[0]!.uv)).toEqual([0, 0, 1, 0, 0, 2]);
    expect(m.meshes[0]!.nor[1]).toBeCloseTo(1, 1);
    expect(splitShader('def_shaders\\lmap/terrain\\t_x,lmap#2_1')).toEqual(['def_shaders\\lmap', 'terrain\\t_x']);
  });
});

import { exportXraySdk } from '../src/engines/xray/export';
import { writeZip } from '../src/core/writers/zip';
import { openZip } from '../src/core/archives/zip';
import { decodeDDS } from '../src/core/images/dds';
import { encodeDdsRgba } from '../src/core/writers/dds';
import type { Model } from '../src/index';

describe('Выгрузка в X-Ray SDK', () => {
  it('правосторонняя Z-вверх модель: оси, обход, поверхности, текстуры, сцена; ZIP читается', async () => {
    const c = cube(), n = c.pos.length / 3;
    // куб, поднятый на 2 по Z (вверх) и сдвинутый на 3 по Y (вперёд в Z-вверх системе)
    const pos = c.pos.map((v, i) => v + (i % 3 === 2 ? 2 : i % 3 === 1 ? 3 : 0));
    const model: Model = {
      meshes: [{ name: 'Box', texture: 'textures/Box Wood.png', vertexCount: n, pos: Float32Array.from(pos), nor: Float32Array.from(c.nor), uv: Float32Array.from(c.uv), bone: new Float32Array(n * 4), weight: new Float32Array(n * 4), indices: Uint32Array.from(c.idx), skinned: false }],
      skeleton: null, motions: [], bounds: { min: [0, 0, 0], max: [1, 1, 1] }, defaultZUp: true, info: [],
    };
    const rgba = new Uint8Array(4 * 4 * 4).fill(200);
    const { files, report } = await exportXraySdk(model, { name: 'Test Map', texture: async () => ({ name: 'Box Wood.png', image: { width: 4, height: 4, rgba } }) });
    expect([...files.keys()].sort()).toEqual(['gamedata/textures/gmv/test_map/box_wood.dds', 'gamedata/textures/gmv/test_map/box_wood.thm', 'rawdata/levels/test_map.level', 'rawdata/levels/test_map/scene_object.part', 'rawdata/objects/gmv/test_map/test_map.object']);
    expect(report[0]).toMatch(/Объектов \.object: 1/);
    const o = parseObject(ab(files.get('rawdata/objects/gmv/test_map/test_map.object')!));
    expect(o.surfaces[0]!.texture).toBe('gmv\\test_map\\box_wood');
    const [m] = objectMeshes(o);
    // Z-вверх (x, y, z) -> Y-вверх (x, z, −y) -> зеркало Z X-Ray: (x, z, y). Центр куба (0, 3, 2) -> (0, 2, 3)
    const ctr = [0, 1, 2].map((k) => { let s = 0; for (let v = 0; v < m!.pos.length / 3; v++) s += m!.pos[v * 3 + k]!; return s / (m!.pos.length / 3); });
    expect(ctr[0]).toBeCloseTo(0); expect(ctr[1]).toBeCloseTo(2); expect(ctr[2]).toBeCloseTo(3);
    // нормали наружу: от центра к вершине
    for (let v = 0; v < m!.pos.length / 3; v++) {
      const d = [0, 1, 2].map((k) => m!.pos[v * 3 + k]! - ctr[k]!);
      expect(d[0]! * m!.nor[v * 3]! + d[1]! * m!.nor[v * 3 + 1]! + d[2]! * m!.nor[v * 3 + 2]!).toBeGreaterThan(0);
    }
    const dds = decodeDDS(ab(files.get('gamedata/textures/gmv/test_map/box_wood.dds')!));
    expect([dds.width, dds.height, dds.rgba![0]]).toEqual([4, 4, 200]);
    const zip = writeZip(files), a = await openZip(new File([zip as BlobPart], 'x.zip'));
    expect(a.entries.length).toBe(5);
    expect(await a.read(a.lookup('rawdata/levels/test_map.level')!)).toEqual(files.get('rawdata/levels/test_map.level'));
  });

  it('DDS без сжатия: цепочка mip-уровней до 1×1', () => {
    const img = { width: 8, height: 2, rgba: new Uint8Array(8 * 2 * 4).fill(255) };
    const u = encodeDdsRgba(img), dv = new DataView(u.buffer);
    expect(dv.getUint32(28, true)).toBe(4); // 8×2, 4×1, 2×1, 1×1
    expect(u.length).toBe(128 + (16 + 4 + 2 + 1) * 4);
  });
});
