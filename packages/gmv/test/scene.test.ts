import { describe, expect, it } from 'vitest';
import { createRegistry, type ExportContext, type Model } from '../src/index';
import { allEngines } from '../src/engines/index';
import { applyPlacement, instanceAt, pickRay, rotatePlacement, sceneLeaves, sceneTree, translatePlacement, visibleIndices } from '../src/core/scene';
import { exportObj } from '../src/core/writers/obj';

/** Сцена: меш «пол» (квадрат 10×10 в XZ на y=0) и меш объектов с двумя экземплярами треугольника-прототипа. */
function scene(): Model {
  const proto = { pos: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), nor: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), uv: new Float32Array(6), indices: Uint32Array.of(0, 1, 2) };
  const floor = { name: 'пол', texture: 'floor', vertexCount: 4, pos: Float32Array.of(-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5), nor: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0), uv: new Float32Array(8), bone: new Float32Array(16), weight: new Float32Array(16), indices: Uint32Array.of(0, 2, 1, 0, 3, 2), skinned: false };
  const objs = { name: 'объекты', texture: 'box', vertexCount: 6, pos: new Float32Array(18), nor: new Float32Array(18), uv: new Float32Array(12), bone: new Float32Array(24), weight: new Float32Array(24), indices: new Uint32Array(6), skinned: false };
  const pose = (x: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];
  const m: Model = {
    meshes: [floor, objs], skeleton: null, motions: [], bounds: { min: [-5, 0, -5], max: [5, 1, 5] }, info: [],
    instances: {
      meshes: [1], protos: [{ name: 'static/tri', parts: [{ mesh: 1, ...proto }] }],
      placements: [
        { proto: 0, name: 'a', pose: pose(2, 0), group: 'STATICPROP', ranges: [{ mesh: 1, part: 0, vStart: 0, vCount: 3, iStart: 0, iCount: 3 }] },
        { proto: 0, name: 'b', pose: pose(-2, 1), group: 'O_ENTITY', ranges: [{ mesh: 1, part: 0, vStart: 3, vCount: 3, iStart: 3, iCount: 3 }] },
      ],
    },
  };
  applyPlacement(m, 0); applyPlacement(m, 1);
  return m;
}

describe('сцена: слои, видимость, поворот, выбор лучом, экспорт', () => {
  it('дерево слоёв: геометрия и объекты по группам', () => {
    const t = sceneTree(scene());
    expect(t.map((n) => n.name)).toEqual(['Геометрия уровня', 'Объекты']);
    expect(t[1]!.children!.map((g) => [g.name, g.note])).toEqual([['STATICPROP', '1'], ['O_ENTITY', '1']]);
    expect(sceneLeaves(t[1]!).map((n) => [n.kind, n.instance])).toEqual([['instance', 0], ['instance', 1]]);
    const plain = sceneTree({ ...scene(), instances: undefined });
    expect(sceneLeaves(plain[0]!).map((n) => n.mesh)).toEqual([0, 1]);
  });

  it('экземпляры: вершины по позе, поворот вокруг Y, скрытые — без треугольников', () => {
    const m = scene();
    expect(Array.from(m.meshes[1]!.pos.subarray(0, 9))).toEqual([2, 0, 0, 3, 0, 0, 2, 1, 0]);
    expect(Array.from(m.meshes[1]!.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    const changed = rotatePlacement(m, 0, Math.PI / 2);
    expect(changed).toEqual([{ mesh: 1, vStart: 0, vCount: 3, iStart: 0, iCount: 3 }]);
    // (1, 0, 0) · Ry(90°): x' = x·cos − z·sin = 0, z' = x·sin + z·cos = 1 -> (2, 0, 1)
    const p = Array.from(m.meshes[1]!.pos.subarray(3, 6));
    expect(p[0]).toBeCloseTo(2); expect(p[2]).toBeCloseTo(1);
    translatePlacement(m, 1, [1, 0.5, 0]);
    expect(Array.from(m.meshes[1]!.pos.subarray(9, 12))).toEqual([-1, 0.5, 1]);
    expect(m.instances!.placements[1]!.pose.slice(12, 15)).toEqual([-1, 0.5, 1]);
    m.instances!.placements[1]!.hidden = true;
    expect(Array.from(visibleIndices(m, 1))).toEqual([0, 1, 2]);
    expect(Array.from(visibleIndices(m, 0))).toEqual([0, 2, 1, 0, 3, 2]);
    expect(instanceAt(m, 1, 3)).toBe(1);
    expect(instanceAt(m, 0, 0)).toBe(-1);
  });

  it('выбор лучом: ближайший треугольник, пропуск скрытых мешей и вырожденных треугольников, срез', () => {
    const m = scene();
    // сверху вниз в точку (2.2, ·, 0.2): сначала треугольник «a» (плоскость z = 0 — луч вдоль −Y её не пересекает), затем пол
    expect(pickRay(m, [0, 10, 0], [0, -1, 0])).toMatchObject({ mesh: 0, index: 0 });
    // вдоль −Z на высоте 0.2: треугольник «a» на z = 0
    const hit = pickRay(m, [2.2, 0.2, 10], [0, 0, -1])!;
    expect(hit).toMatchObject({ mesh: 1, index: 0 });
    expect(hit.t).toBeCloseTo(10);
    expect(pickRay(m, [2.2, 0.2, 10], [0, 0, -1], { skip: (i) => i === 1 })).toBeNull();
    const hidden = Uint32Array.of(0, 0, 0, 3, 4, 5);
    expect(pickRay(m, [2.2, 0.2, 10], [0, 0, -1], { indices: (i) => (i === 1 ? hidden : m.meshes[i]!.indices) })).toBeNull();
    expect(pickRay(m, [2.2, 0.2, 10], [0, 0, -1], { clip: (_x, y) => y > 0.1 })).toBeNull();
  });

  it('варианты экспорта: X-Ray SDK рекомендован для Metro и X-Ray, OBJ — для любых; поле «ссылками» только у сцен', () => {
    const reg = createRegistry(allEngines), m = scene();
    const forMetro = reg.exportersFor(m, 'metro');
    expect(forMetro[0]).toMatchObject({ exporter: { id: 'xray-sdk' }, recommended: true });
    expect(forMetro.map((x) => x.exporter.id)).toContain('obj');
    const forQuake = reg.exportersFor(m, 'idtech');
    expect(forQuake.every((x) => !x.recommended)).toBe(true);
    const inst = reg.exporters.find((x) => x.id === 'xray-sdk')!.fields.find((f) => f.id === 'instances')!;
    expect(inst.when!(m)).toBe(true);
    expect(inst.when!({ ...m, instances: undefined })).toBe(false);
  });

  it('OBJ: вершины, UV (v снизу), обход в правой системе, скрытые экземпляры не выгружаются', async () => {
    const m = { ...scene(), flipZ: true };
    m.instances!.placements[1]!.hidden = true;
    const reg = createRegistry(allEngines);
    const ctx: ExportContext = { preset: reg.games[0]!, sourceEngine: 'metro', baseName: 'Test Level', hidden: new Set([0]), texture: async () => ({ name: 'box.png', image: { width: 1, height: 1, rgba: Uint8Array.of(255, 0, 0, 255) } }) };
    const r = await exportObj(m, { name: '' }, ctx);
    expect(r.name).toBe('test_level_obj');
    const obj = new TextDecoder().decode(r.files.get('test_level.obj'));
    expect(obj).toContain('mtllib test_level.mtl');
    expect(obj.match(/^f /gm)).toHaveLength(1);
    expect(obj).toContain('v -2.00000 0.00000 -1.00000'); // экземпляр b (z = 1) после отражения Z
    expect(obj).toContain('f 1/1/1 3/3/3 2/2/2');
    expect(obj).toContain('vt 0.00000 1.00000');
    expect(new TextDecoder().decode(r.files.get('test_level.mtl'))).toContain('map_Kd textures/box_0.dds');
    expect(r.files.has('textures/box_0.dds')).toBe(true);
  });
});
