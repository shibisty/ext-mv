// CryEngine 1 (Far Cry, «CryTek» 0x744): синтетические файлы — узел с матрицей, меш в сантиметрах, материалы 0x746/0x745,
// флаг костей без связей (статика), анимация узла .cga, список анимаций .cal.
import { describe, expect, it } from 'vitest';
import { cry1Model, isCryTek, parseCal, parseCry1 } from '../src/engines/cryengine/cry1';

import { cryFile, ident, mesh, mtl, node, tri } from './helpers/cry1';

describe('CryEngine 1 (Far Cry)', () => {
  it('статика: сантиметры → метры, матрица узла, материал 0x746, UV снизу вверх', () => {
    const buf = cryFile([mtl('s_box(TemplModelCommon)/mat_default', 'Textures\\box.dds'), node('box', 3, 1, ident(200, 0, 0)), mesh(tri.pos, tri.faces, tri.uvs)]);
    expect(isCryTek(new Uint8Array(buf))).toBe(true);
    const m = cry1Model(buf, 'box.cgf');
    expect(m.meshes).toHaveLength(1);
    const g = m.meshes[0]!;
    expect(g.texture).toBe('Textures/box.dds');
    expect(g.shader).toBe('TemplModelCommon');
    expect(g.vertexCount).toBe(3);
    expect(Array.from(g.pos).map((v) => Math.round(v * 100) / 100)).toEqual([2, 0, 0, 3, 0, 0, 2, 0, 1]);
    expect(Array.from(g.uv)).toEqual([0, 1, 1, 1, 0, 0]);
    expect(g.alphaTest).toBeUndefined();
    expect(m.skeleton).toBeNull();
    expect(m.motions).toHaveLength(0);
  });

  it('старый материал 0x745, листва — вырезание по альфе; флаг костей без связей не мешает', () => {
    // после UV — цвета вершин (3 байта на вершину), а не связи с костями
    const buf = cryFile([mtl('s_jb(TemplPlants1)/mat_leaves', 'bush.dds', 0x745), node('bush', 3, 1, ident()), mesh(tri.pos, tri.faces, tri.uvs, new Uint8Array(9).fill(200), 1)]);
    const m = cry1Model(buf, 'bush.cgf');
    expect(m.meshes[0]!.texture).toBe('bush.dds');
    expect(m.meshes[0]!.alphaTest).toBe(true);
    // «GlossAlpha» — альфа как блеск, не прозрачность
    const g = cry1Model(cryFile([mtl('s(TemplBumpSpec_HP_GlossAlpha)', 'a.dds'), node('n', 3, 1, ident()), mesh(tri.pos, tri.faces, tri.uvs)]), 'g.cgf');
    expect(g.meshes[0]!.alphaTest).toBeUndefined();
  });

  it('NoDraw скрыт по умолчанию; анимация не файл модели', () => {
    const m = cry1Model(cryFile([mtl('hull(NoDraw)/mat_metal', ''), node('hull', 3, 1, ident()), mesh(tri.pos, tri.faces, tri.uvs)]), 'n.cgf');
    expect(m.meshes[0]!.defaultHidden).toBe(true);
    expect(() => cry1Model(cryFile([node('x', 3, 1, ident())], 0xffff0001), 'a.caf')).toThrow(/\.caf/);
    expect(() => parseCry1(new Uint8Array(32))).toThrow(/CryTek/);
  });

  it('.cga: контроллер узла (линейный 3) с меняющимися ключами — скелет из узлов и «анимация объекта»; один ключ — статика', () => {
    const ctrl = (keys: number[][]) => {
      const b = new Uint8Array(16 + keys.length * 16), dv = new DataView(b.buffer);
      dv.setInt32(0, 3, true); dv.setInt32(4, keys.length, true);
      keys.forEach((k, i) => { dv.setInt32(16 + i * 16, k[0]!, true); for (let j = 1; j < 4; j++) dv.setFloat32(16 + i * 16 + j * 4, k[j]!, true); });
      return { type: 0xcccc000d, ver: 0x826, id: 5, body: b };
    };
    const timing = (() => { const b = new Uint8Array(48), dv = new DataView(b.buffer); dv.setFloat32(0, 1 / 4800, true); dv.setInt32(4, 160, true); return { type: 0xcccc000e, ver: 0x918, id: 0, body: b }; })();
    const moving = cry1Model(cryFile([timing, mtl('m', 'a.dds'), node('door', 3, 1, ident(), [5, -1, -1]), mesh(tri.pos, tri.faces, tri.uvs), ctrl([[0, 0, 0, 0], [4800, 0, 0, 100]])]), 'door.cga');
    expect(moving.skeleton).not.toBeNull();
    expect(moving.motions).toHaveLength(1);
    expect(moving.motions[0]!.duration).toBeCloseTo(1, 3);
    const still = cry1Model(cryFile([timing, mtl('m', 'a.dds'), node('pipe', 3, 1, ident(), [5, -1, -1]), mesh(tri.pos, tri.faces, tri.uvs), ctrl([[0, 0, 0, 0]])]), 'pipe.cgf');
    expect(still.skeleton).toBeNull();
    expect(still.motions).toHaveLength(0);
  });

  it('.cal: имена и пути анимаций (комментарии и служебные строки пропускаются)', () => {
    const list = parseCal('// idle\r\nsidle\t\t=\thuman_male\\sidle_loop.caf\r\n#filepath = x\r\n$Include = other.cal\r\nrun = human_male\\srun_fwd.caf // бег\r\n');
    expect(list).toEqual([{ name: 'sidle', path: 'human_male/sidle_loop.caf' }, { name: 'run', path: 'human_male/srun_fwd.caf' }]);
  });
});

describe('Far Cry: уровни (.cry)', async () => {
  const { parseEditorXml, parsePrototypes, parseVegetation, objectMatrix, terrainMesh, waterMesh } = await import('../src/engines/cryengine/fc1level');
  it('редакторский XML: ландшафт, Brush, сущность с моделью в свойствах, прототип, растения; скрытые точки ИИ пропускаются', () => {
    const protos = parsePrototypes('<EntityPrototypeLibrary><EntityPrototype Class="BasicEntity" Id="{AA-BB}" Name="can"><Properties object_Model="Objects\\can.cgf" Mass="5"/></EntityPrototype></EntityPrototypeLibrary>');
    const xml = `<Level><Heightmap Height="512" UnitSize="4" WaterLevel="12" Width="512" />
      <VegetationMap><Objects><Object FileName="Objects\\palm.cgf" Hidden="0" Index="3" /></Objects></VegetationMap>
      <Objects>
        <Object Angles="0,0,90" Name="rock" Pos="10,20,30" Prefab="Objects\\rock.cgf" Scale="2,2,2" Type="Brush" Layer="L1" />
        <Object EntityClass="AnimObject" Name="harlan" Pos="1,2,3" Type="Entity" HiddenInGame="1" >
          <Properties Animation="default" fileModel="Objects\\characters\\harlan.cgf" ><attachmet1 boneName="weapon_bone" fileObject="" /></Properties>
        </Object>
        <Object Name="can1" Pos="5,5,5" Prototype="{aa-bb}" Type="PrototypeEntity" />
        <Object Name="p" Pos="0,0,0" Type="AIPoint" />
      </Objects><Library Name="Physicalized_Objects" /></Level>`;
    const ed = parseEditorXml(xml, protos);
    expect([ed.size, ed.unit, ed.water]).toEqual([512, 4, 12]);
    expect(ed.objects.map((o) => [o.type, o.model, o.hidden])).toEqual([['Brush', 'Objects\\rock.cgf', false], ['Entity', 'Objects\\characters\\harlan.cgf', true], ['PrototypeEntity', 'Objects\\can.cgf', false]]);
    expect(ed.vegetation.get(3)?.file).toBe('Objects\\palm.cgf');
    expect(ed.libraries).toEqual(['Physicalized_Objects']);
    // поворот на 90° вокруг Z, масштаб 2, перенос
    const M = objectMatrix([10, 20, 30], [0, 0, 90], [2, 2, 2]).map((v) => Math.round(v * 1000) / 1000 + 0);
    expect(M).toEqual([0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 10, 20, 30, 1]);
  });
  it('растения по 19 байт, ландшафт [x·N + y] ÷ 256, вода ниже уровня', () => {
    const b = new Uint8Array(38), dv = new DataView(b.buffer);
    [[100, 200, 17.5, 1.5, 3], [4, 8, 0, 1, 7]].forEach(([x, y, z, s, i], k) => { dv.setFloat32(k * 19, x!, true); dv.setFloat32(k * 19 + 4, y!, true); dv.setFloat32(k * 19 + 8, z!, true); dv.setFloat32(k * 19 + 12, s!, true); b[k * 19 + 16] = i!; });
    expect(parseVegetation(b)).toEqual([{ x: 100, y: 200, z: 17.5, s: 1.5, i: 3 }, { x: 4, y: 8, z: 0, s: 1, i: 7 }]);
    const N = 4, h = new Uint16Array(N * N);
    h[1 * N + 2] = 256 * 10; // x = 1, y = 2 → 10 м
    const t = terrainMesh(h, N, 2, 1, null);
    const v = 1 * (N + 1) + 2;
    expect([t.pos[v * 3], t.pos[v * 3 + 1], t.pos[v * 3 + 2]]).toEqual([2, 4, 10]);
    expect(waterMesh(h, N, 2, 5)).not.toBeNull();
    expect(waterMesh(new Uint16Array(N * N).fill(256 * 20), N, 2, 5)).toBeNull();
  });
});
