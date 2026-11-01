import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { evalExpr, evalNumber, parseJbeam } from '../src/engines/beamng/jbeam';
import { readMaterialsCs, readMaterialsJson, type MaterialTex } from '../src/engines/beamng/vehicle';
import { parseCollada } from '../src/engines/collada/collada';
import { file } from './helpers/bin';
import { makeDdsDxt1 } from './helpers/fixtures';

/** Треугольник в узле; translate — смещение узла. */
const daeNode = (name: string, mat: string, t: [number, number, number]) => `
  <node id="${name}" name="${name}"><translate>${t.join(' ')}</translate>
    <instance_geometry url="#g"><bind_material><technique_common><instance_material symbol="m" target="#${mat}"/></technique_common></bind_material></instance_geometry></node>`;
const DAE = `<?xml version="1.0"?><COLLADA><asset><up_axis>Z_UP</up_axis></asset>
<library_materials><material id="body" name="body"/><material id="rim" name="rim"/></library_materials>
<library_geometries><geometry id="g"><mesh>
  <source id="p"><float_array id="pa" count="9">0 0 0 0.1 0 0 0 0 0.1</float_array><technique_common><accessor source="#pa" count="3" stride="3"/></technique_common></source>
  <vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
  <triangles material="m" count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles>
</mesh></geometry></library_geometries>
<library_visual_scenes><visual_scene id="s">${daeNode('car_body', 'body', [0, 0, 0.5])}${daeNode('car_wheel', 'rim', [0.7, -1.3, 0.3])}${daeNode('unused', 'body', [9, 9, 9])}</visual_scene></library_visual_scenes>
</COLLADA>`;

// главная деталь со слотом колеса; колесо «из игры» отсутствует -> подставится деталь мода с тем же slotType
const JBEAM = `{
  "car": { "slotType": "main",
    "variables": [["name","type","unit","category","default","min","max","title","description"], ["$track","range","m","s",0.1,0,1,"t","d"]],
    "slots": [["type","default","description"], ["wheel_F","wheel_game","Колёса", {"nodeOffset":{"x":"$=$track*2","y":0,"z":0.05}}]],
    "flexbodies": [["mesh","[group]:","nonFlexMaterials"], ["car_body", ["body"]]] // комментарий
  }
  "car_wheel_mod": { "slotType": "wheel_F",
    "flexbodies": [["mesh","[group]:"], {"deformGroup":""}, ["car_wheel", ["wheel"], [], {"pos":{"x":0,"y":0,"z":0}, "rot":{"x":0,"y":0,"z":0}, "scale":{"x":1,"y":1,"z":1}}]]
  }
}`;
const PC = `{"format":2,"mainPartName":"car","model":"car","parts":{"wheel_F":"wheel_game"},"vars":{"$track":0.2},"paints":[{"baseColor":[0.5,0.1,0.1,1]}]}`;
const MATS = `{"body":{"name":"body","mapTo":"body","Stages":[{"baseColorMap":"/vehicles/common/null.dds","baseColorFactor":[0.2,0.3,0.4,1]},null]},
  "rim":{"name":"rim","mapTo":"rim","Stages":[{"colorMap":"/vehicles/car/rim_d.dds"}]}}`;

describe('jbeam', () => {
  it('JSON с комментариями и без запятых', () => {
    const j = parseJbeam('{ "a": [1 2 3] /* c */ "b": {"x": nil, "y": -inf} // x\n "c": true, }') as Record<string, unknown>;
    expect(j.a).toEqual([1, 2, 3]);
    expect(j.b).toEqual({ x: null, y: -Infinity });
    expect(j.c).toBe(true);
  });
  it('выражения $= (case, математика, переменные)', () => {
    const vars = new Map<string, number | null>([['$trackoffset_F', 0.5]]);
    expect(evalExpr('case($trackwidth_F == nil, $trackoffset_F+0.25, $trackwidth_F)', vars)).toBe(0.75);
    expect(evalExpr('2^3 - max(1, 4) / 2 + abs(-1)', vars)).toBe(7);
    expect(evalExpr('$trackoffset_F > 0.4 and 1 or 2', vars)).toBe(1);
    expect(evalNumber('$=clamp($trackoffset_F * 4, 0, 1)', vars)).toBe(1);
    expect(evalNumber('$missing', vars, 3)).toBe(3);
  });
});

describe('Collada', () => {
  it('выбор узлов по имени, матрица узла в вершинах', () => {
    const all = parseCollada(DAE);
    expect(all.upAxis).toBe('Z_UP');
    expect(all.meshes.map((m) => m.nodeName)).toEqual(['car_body', 'car_wheel', 'unused']);
    const sel = parseCollada(DAE, { nodes: new Set(['CAR_WHEEL']) });
    expect(sel.meshes).toHaveLength(1);
    expect(Array.from(sel.meshes[0]!.pos.slice(0, 3))).toEqual([0.7, -1.3, 0.3].map(Math.fround));
    expect(sel.meshes[0]!.material).toBe('rim');
  });
});

describe('материалы BeamNG', () => {
  it('materials.json: заглушка null.dds -> множитель цвета; colorMap', () => {
    const out = new Map<string, MaterialTex>();
    readMaterialsJson(MATS, out);
    expect(out.get('body')).toEqual({ color: '', factor: [0.2, 0.3, 0.4] });
    expect(out.get('rim')?.color).toBe('/vehicles/car/rim_d.dds');
  });
  it('materials.cs: слой 0 раньше слоя 2', () => {
    const out = new Map<string, MaterialTex>();
    readMaterialsCs('singleton Material(car_glass)\n{\n  mapTo = "glass";\n  baseColorMap[2] = "/v/b.dds";\n  diffuseMap[0] = "/v/a.dds";\n};\n', out);
    expect(out.get('glass')?.color).toBe('/v/a.dds');
    expect(out.get('car_glass')?.color).toBe('/v/a.dds');
  });
});

describe('сборка машины по .pc', () => {
  it('детали, nodeOffset по стороне, подмена отсутствующей детали, материалы', async () => {
    const s = new ViewerSession(createRegistry(allEngines), 'beamng');
    const arch = s.addFolder([
      file(JBEAM, 'car.jbeam', 'mods/vehicles/car/car.jbeam'),
      file(DAE, 'car.dae', 'mods/vehicles/car/car.dae'),
      file(MATS, 'main.materials.json', 'mods/vehicles/car/main.materials.json'),
      file(PC, 'base.pc', 'mods/vehicles/car/base.pc'),
      file(makeDdsDxt1(), 'rim_d.dds', 'mods/vehicles/car/rim_d.dds'),
    ]);
    const pc = arch.entries.find((e) => e.path.endsWith('.pc'))!;
    const m = (await s.loadModel([arch.fileOf(pc)]))!;
    expect(m.meshes.map((x) => x.name)).toEqual(['car_body · car', 'car_wheel · car_wheel_mod']);
    const [body, wheel] = m.meshes as [typeof m.meshes[0], typeof m.meshes[0]];
    // тело — без смещения; цвет из baseColorFactor (карта — заглушка)
    expect(body.pos[2]).toBeCloseTo(0.5);
    expect(body.color).toEqual([0.2, 0.3, 0.4]);
    // колесо: x 0.7 + 2*0.2 наружу, z 0.3 + 0.05
    expect(wheel.pos[0]).toBeCloseTo(1.1);
    expect(wheel.pos[2]).toBeCloseTo(0.35);
    expect(wheel.texture).toBe('/vehicles/car/rim_d.dds');
    expect(m.info.join('\n')).toMatch(/wheel_game → car_wheel_mod/);
    expect(m.defaultZUp).toBe(true);
    const tex = await s.resolveTexture(1);
    expect(tex.ok).toBe(true);
    expect(tex.image?.width).toBe(4);
  });
  it('без .jbeam — понятная ошибка', async () => {
    const s = new ViewerSession(createRegistry(allEngines), 'beamng');
    const arch = s.addFolder([file(PC, 'base.pc', 'm/vehicles/car/base.pc')]);
    await s.loadModel([arch.fileOf(arch.entries[0]!)]);
    expect(String(s.lastFailure?.error ?? s.lastFailure)).toMatch(/jbeam/);
  });
});
