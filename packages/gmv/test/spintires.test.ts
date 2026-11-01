import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { parseMeshCache } from '../src/engines/spintires/mesh';
import { parseXml, attrsOf, find, vec3 } from '../src/engines/spintires/xml';
import { file } from './helpers/bin';
import { makeDdsDxt1 } from './helpers/fixtures';
import { makeMeshCache } from './helpers/spintires';

const XML = '<CombineXMesh>\n\t<Material MeshParts="body" DiffuseMap="trucks/test__d.tga" Name="m1"/>\n</CombineXMesh>';
const ab = (u8: Uint8Array) => u8.slice().buffer;

describe('Spintires / MudRunner', () => {
  it('MeshCache: узлы, меш, матрица узла, пропуск коллизии', () => {
    const f = parseMeshCache(ab(makeMeshCache({ xml: XML, node: 'body', translate: [2, 0, 0] })));
    expect(f.nodes.map((n) => n.name)).toEqual(['body', 'cdt']);
    expect(f.materials[0]).toMatchObject({ parts: ['body'], diffuse: 'trucks/test__d.tga', name: 'm1' });
    const m = f.nodes[0]!.mesh!;
    expect(m.vertexCount).toBe(3);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
    expect(Array.from(m.uv)).toEqual([0, 0, 0.5, 0, 0, 0.5]);
    expect(f.nodes[0]!.world[12]).toBe(2);
    expect(f.snow).toBe(false);
  });
  it('SnowRunner: другая сигнатура, материал AlbedoMap', () => {
    const f = parseMeshCache(ab(makeMeshCache({ xml: XML.replace('DiffuseMap', 'AlbedoMap'), node: 'body', translate: [0, 0, 0], snow: true })));
    expect(f.snow).toBe(true);
    expect(f.materials[0]!.diffuse).toBe('trucks/test__d.tga');
  });
  it('XML классов: шаблоны и векторы', () => {
    const r = parseXml('<_templates><Wheel><Front HardpointOffsetY="-0.1" Torque="full"/></Wheel></_templates><!-- c --><Truck><Wheels><Wheel _template="Front" HardpointX="1.5" Torque="none"/></Wheels></Truck>');
    const w = find(find(r, 'Truck')!, 'Wheel')!;
    expect(attrsOf(w, r)).toMatchObject({ HardpointOffsetY: '-0.1', HardpointX: '1.5', Torque: 'none' });
    expect(vec3('(1; -2.5; 0.25)')).toEqual([1, -2.5, 0.25]);
  });
  it('папка мода: MeshCache без расширения в списке моделей, текстура из TextureCache, машина по XML', async () => {
    const s = new ViewerSession(createRegistry(allEngines), 'mudrunner');
    const truckXml = '<_templates><Wheel><W HardpointOffsetY="0"/></Wheel></_templates><Truck><Wheels HardpointDefaultY="0.5" HardpointDefaultZ="1"><Wheel _template="W" HardpointX="1"/><Wheel _template="W" RightSide="true" HardpointX="1"/></Wheels><TruckData><WheelsSets><WheelsSet><WheelType Type="w1" Wheels="0,1"/></WheelsSet></WheelsSets></TruckData><PhysicsModel Mesh="trucks/test"/></Truck>';
    const a = s.addFolder([
      file(makeMeshCache({ xml: XML, node: 'body', translate: [0, 0, 0] }), 'trucks_test', 'mod/Media/MeshCache/trucks_test'),
      file(makeMeshCache({ xml: XML.replace('body', 'tire'), node: 'tire', translate: [0, 0, 0] }), 'wheels_w1', 'mod/Media/MeshCache/wheels_w1'),
      file('<TruckWheel Mesh="wheels/w1" Radius="0.5"/>', 'w1.xml', 'mod/Media/classes/wheels/w1.xml'),
      file(truckXml, 'Test.xml', 'mod/Media/classes/trucks/Test.xml'),
      file(makeDdsDxt1(), 'trucks_test__d.dds', 'mod/Media/TextureCache/trucks_test__d.dds'),
    ]);
    const list = s.archiveModels().items.map((i) => i.entry.path);
    expect(list).toContain('mod/media/meshcache/trucks_test');
    expect(list).toContain('mod/media/classes/trucks/test.xml');
    const m = (await s.loadModel([a.fileOf(a.entries.find((e) => e.path.endsWith('meshcache/trucks_test'))!)]))!;
    expect(m.meshes).toHaveLength(1);
    expect((await s.resolveTexture(0)).ok).toBe(true);
    const t = (await s.loadModel([a.fileOf(a.entries.find((e) => e.path.endsWith('test.xml'))!)]))!;
    expect(t.meshes).toHaveLength(3);
    expect(t.info[0]).toMatch(/колёс 2/);
    const right = t.meshes[2]!; // правое колесо: зеркально, z = -1
    expect(right.pos[2]).toBeCloseTo(-1);
    expect(right.pos[1]).toBeCloseTo(0.5);
  });
});
