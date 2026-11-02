import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { parseDbIndex } from '../src/engines/vostok/db';
import { parseConvertedModel, parseVostokConfig, parseVostokMaterial } from '../src/engines/vostok/model';
import { file } from './helpers/bin';
import { makeDdsDxt1 } from './helpers/fixtures';
import { makeConvertedModel, makeVostokConfig, makeVostokDb } from './helpers/vostok';

const quad = () => makeConvertedModel([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [[0, 0], [0x3c00, 0], [0x3c00, 0x3c00], [0, 0x3800]], [0, 1, 2, 0, 2, 3]);
const material = (albedo: string) => makeVostokConfig({ material: { instance: { base_material: 'default' }, g_stage: { effect: { t_albedo: { value: albedo }, t_normal: { value: albedo + '_nmap' } } } } });

describe('Vostok (Survarium)', () => {
  it('индекс .db: папки, файлы, ссылки и удаления', () => {
    const nodes = parseDbIndex(makeVostokDb({ 'a/b.txt': new Uint8Array([1, 2, 3]), 'a/c.txt': { link: 'a/b.txt' }, 'd.txt': 'deleted' }));
    expect(nodes.map((n) => [n.path, n.flags, n.size])).toEqual([['a/b.txt', 4, 3], ['a/c.txt', 0x204, 3], ['d.txt', 0x804, 0]]);
    expect(nodes[1]!.off).toBe(nodes[0]!.off);
  });

  it('двоичный конфиг, материал, converted_model', () => {
    expect(parseVostokConfig(makeVostokConfig({ a: { b: 'x', n: 5 }, s: 'y' }))).toEqual({ a: { b: 'x', n: 5 }, s: 'y' });
    expect(parseVostokMaterial(material('props/box'))).toEqual({ albedo: 'props/box', normal: 'props/box_nmap', smoothness: undefined, metalness: undefined });
    const g = parseConvertedModel(quad());
    expect([g.count, g.stride, Array.from(g.indices)]).toEqual([4, 28, [0, 1, 2, 0, 2, 3]]);
    expect(Array.from(g.uv)).toEqual([0, 0, 1, 0, 1, 1, 0, 0.5]);
  });

  it('сессия: обновления поверх основного .db, модель-папка, материал и текстура', async () => {
    const base = makeVostokDb({
      'models/props/box.model/render/box_s/converted_model': quad(),
      'models/props/box.model/render/lod1_box_s/converted_model': quad(),
      'models/props/box.model/settings': makeVostokConfig({ material_settings: { box_s: { material_name: 'props/box' } } }),
      'material_instances/props/box.material': material('props/old'),
      'textures/props/old.dds': new Uint8Array(makeDdsDxt1(4, 4)),
      'textures/props/gone.dds': new Uint8Array(makeDdsDxt1(4, 4)),
    });
    const patch = makeVostokDb({
      'material_instances/props/box.material': material('props/new'),
      'textures/props/new.dds': new Uint8Array(makeDdsDxt1(8, 8)),
      'textures/props/gone.dds': 'deleted',
    });
    const s = new ViewerSession(createRegistry(allEngines), 'survarium');
    await s.addArchives([file(base, 'resources.00.db'), file(patch, 'resources.01.db')]);
    expect(s.archives).toHaveLength(1);
    const a = s.archives[0]!;
    expect(a.lookup('textures/props/gone.dds')).toBeNull();
    const m = (await s.loadModel([a.fileOf(a.lookup('models/props/box.model')!)]))!;
    expect(m.meshes.map((x) => [x.name, x.texture, x.normalMap])).toEqual([['box_s', 'textures/props/new', 'textures/props/new_nmap']]);
    expect((await s.resolveTexture(0)).image?.width).toBe(8);
  });
});

import { buildMotion, evalSpline, parseBSpline, parseBindPose, parseSkeleton, skeletonNodes } from '../src/engines/vostok/anim';
import { makeBindPose, makeBSpline } from './helpers/vostok';

describe('Vostok: скелет и анимации', () => {
  const constant = (v: number, end = 10) => ({ knots: [0, 0, 0, 0, end], values: [v, v, v, v] });
  it('B-сплайн: постоянный и линейный каналы, границы', () => {
    const lin = { knots: [0, 0, 0, 0, 3], values: [0, 1, 2, 3] };
    const sp = parseBSpline(makeBSpline([...Array(8)].map(() => constant(0)).concat([lin])));
    expect(sp.bones).toBe(1);
    expect(evalSpline(sp.channels[0]!, 5)).toBe(0);
    for (const t of [0, 1, 1.5, 3]) expect(evalSpline(sp.channels[8]!, t)).toBeCloseTo(t, 6);
    expect(evalSpline(sp.channels[8]!, 10)).toBeCloseTo(3, 6);
  });

  it('скелет из конфига, bind_pose в пространстве модели, анимация по именам костей', () => {
    const bones = parseSkeleton(makeVostokConfig({ root: { arm: { hand: { mask: 1 } }, mask: 2 } }));
    expect(bones).toEqual([{ name: 'root', parent: -1 }, { name: 'arm', parent: 0 }, { name: 'hand', parent: 1 }]);
    const bind = parseBindPose(makeBindPose([{ name: 'arm', pos: [0, 1, 0] }, { name: 'hand', pos: [0, 1.5, 0] }]));
    const nodes = skeletonNodes(bones, bind);
    expect(Array.from(nodes[2]!.local).slice(12, 15)).toEqual([0, 0.5, 0]);
    // кость hand едет по X от 0 до 0.3 за 3 кадра
    const ch = [...Array(9)].map((_, i) => (i === 0 ? { knots: [0, 0, 0, 0, 3], values: [0, 0.1, 0.2, 0.3] } : constant(i >= 6 ? 1 : 0, 3)));
    const m = buildMotion('move', makeBSpline(ch), ['hand'], bones);
    expect([m.frames, m.duration]).toEqual([4, 0.1]);
    expect(m.chan.get(2)!.pos![3]![1][0]).toBeCloseTo(0.3, 6);
    expect(m.chan.has(0)).toBe(false);
  });
});

import { outfitEntries } from '../src/engines/vostok/db';
import { levelVisuals, parseVeg, vegInstances, vegLayers, wireMesh } from '../src/engines/vostok/level';
import { modelParts } from '../src/engines/vostok/model';
import { makeVeg } from './helpers/vostok';

describe('Vostok: комплекты персонажей и уровни', () => {
  it('комплект: торс и ноги одного размера, ботинки, руки, шлем и голова с шлемом', () => {
    const d = (n: string) => `models/character/human/bm/${n}.skinned_model`, h = (n: string) => `models/character/human/head/${n}.skinned_model`;
    const paths = new Set([d('bm_01_torso_s1'), d('bm_01_torso_s2'), d('bm_01_legs_s1'), d('bm_01_legs_s2'), d('bm_01_boot'), d('bm_01_hand'), d('bm_01_hand_hud'), d('bm_01_helmet'), h('head_default'), h('head_default_helmet')]);
    const o = outfitEntries(paths);
    expect([...o.keys()].sort()).toEqual(['models/character/human/bm/bm_01_s1.outfit', 'models/character/human/bm/bm_01_s2.outfit']);
    expect(o.get('models/character/human/bm/bm_01_s1.outfit')).toEqual([d('bm_01_torso_s1'), d('bm_01_legs_s1'), d('bm_01_boot'), d('bm_01_hand'), d('bm_01_helmet'), h('head_default_helmet')]);
  });

  it('уровень: render_visuals (модель, позиция, углы, масштаб), модель только с «lod0_» частями, поворот как у костей', async () => {
    const project = makeVostokConfig({
      project_name: 'test_level',
      render_visuals: [
        { model_name: 'props/box', position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { model_name: 'props/box', position: [0, 0, 5], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] },
        { model_name: 'level/terrain', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { model_name: 'props/missing', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ],
    });
    expect(levelVisuals(project).visuals.map((v) => [v.model, v.pos, v.scale[0]])).toEqual([['props/box', [10, 0, 0], 1], ['props/box', [0, 0, 5], 2], ['level/terrain', [0, 0, 0], 1], ['props/missing', [0, 0, 0], 1]]);
    const db = makeVostokDb({
      'projects/test_level/day/client_project': project,
      'models/props/box.model/render/box_s/converted_model': quad(),
      'models/level/terrain.model/render/lod0_t/converted_model': quad(),
      'models/level/terrain.model/render/lod1_t/converted_model': quad(),
    });
    const s = new ViewerSession(createRegistry(allEngines), 'survarium');
    await s.addArchives([file(db, 'resources.00.db')]);
    const a = s.archives[0]!;
    const m = (await s.loadModel([a.fileOf(a.lookup('projects/test_level/day.vlevel')!)]))!;
    expect(m.info.join('\n')).toMatch(/Объектов: 4, показано 3 \(моделей 2, треугольников 6\)[\s\S]*Модели не найдены: 1 \(props\/missing\)/);
    expect(m.instances?.placements.map((p) => p.name)).toEqual(['box', 'box', 'terrain']);
    // второй ящик: масштаб 2 и поворот вокруг Y на −90° (углы как у костей: R = Rz(−z)·Ry(−y)·Rx(−x)) — (1,0,0) -> (0,0,2)
    const p = m.meshes[0]!.pos, at = (v: number) => Array.from(p.subarray(v * 3, v * 3 + 3)).map((x) => +x.toFixed(3) + 0);
    expect(at(4 + 1)).toEqual([0, 0, 7]);
  });

  it('части LOD по settings/lod_hierrarchy: LOD0 + unassigned, неупомянутые — если не «lod»; без списка — по именам', async () => {
    const db = makeVostokDb({
      'models/a.model/render/a_orig/converted_model': quad(),
      'models/a.model/render/z_lod_1/converted_model': quad(),
      'models/a.model/render/z_lod_2/converted_model': quad(),
      'models/a.model/render/glass/converted_model': quad(),
      'models/a.model/render/lod1_extra/converted_model': quad(),
      'models/a.model/settings': makeVostokConfig({ lod_hierrarchy: { LOD0: { surfaces: ['a_orig'] }, LOD1: { surfaces: ['z_lod_1'] }, LOD2: { surfaces: ['z_lod_2'] }, unassigned: { surfaces: ['glass'] } } }),
    });
    const s = new ViewerSession(createRegistry(allEngines), 'survarium');
    await s.addArchives([file(db, 'resources.00.db')]);
    const a = s.archives[0]!, st = parseVostokConfig(await a.read(a.lookup('models/a.model/settings')!));
    expect(modelParts(a, 'models/a.model', st).map((p) => p.name).sort()).toEqual(['a_orig', 'glass']);
    expect(modelParts(a, 'models/a.model', st, 1).map((p) => p.name).sort()).toEqual(['glass', 'z_lod_1']);
    expect(modelParts(a, 'models/a.model', st, 5).map((p) => p.name).sort()).toEqual(['glass', 'z_lod_2']);
    expect(modelParts(a, 'models/a.model').map((p) => p.name).sort()).toEqual(['a_orig', 'glass', 'z_lod_1', 'z_lod_2']);
  });

  it('трава .veg: позиции и нормали, выбор модели по вероятностям, поворот к нормали, повторяемость', () => {
    const veg = parseVeg(makeVeg([[1, 2, 3], [4, 5, 6], [7, 8, 9]], [[0, 1, 0], [1, 0, 0], [0, 1, 0]]));
    expect(Array.from(veg.pos)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const [layer] = vegLayers([{ game_object_type: 'vegetation', is_enabled: 1, layers: [{ name: 'g', filename: 'vegetation/g.veg', random_dir: 0, random_scale: 0, use_face_normal: 1, visible: 1,
      model_def: [{ name: 'flora/a', probability: 0, scale: 2 }, { name: 'flora/b', probability: 1, scale: 0.5 }] }] }] as never);
    expect(layer!.models.map((m) => m.name)).toEqual(['flora/a', 'flora/b']);
    const list = vegInstances(layer!, veg.pos, veg.nor);
    expect(list.map((x) => x.model)).toEqual([1, 1, 1]); // вероятность 0 — модель не ставится
    const M = list[1]!.M;
    // масштаб 0.5, ось Y модели — по нормали (1,0,0), перенос — позиция
    expect([M[4], M[5], M[6]].map((v) => +v!.toFixed(4) + 0)).toEqual([0.5, 0, 0]);
    expect([M[12], M[13], M[14]]).toEqual([4, 5, 6]);
    expect(vegInstances(layer!, veg.pos, veg.nor).map((x) => Array.from(x.M))).toEqual(list.map((x) => Array.from(x.M)));
  });

  it('провод: крест из двух полос по точкам', () => {
    const w = wireMesh([[0, 0, 0], [0, -1, 1], [0, -1.5, 2]], 0.1)!;
    expect(w.vertexCount).toBe(12);
    expect(w.indices.length).toBe(2 * 2 * 2 * 6);
    expect(wireMesh([[0, 0, 0]], 0.1)).toBeNull();
  });

  it('уровень: трава, объект со скелетом, провод, метки света и частиц; вырезание по альфе из материала', async () => {
    const project = makeVostokConfig({
      project_name: 'veg_level',
      render_visuals: [{ model_name: 'props/box', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
      client_objects: [
        { game_object_type: 'vegetation', is_enabled: 1, layers: [{ name: 'green', filename: 'vegetation/green.veg', visible: 1, random_dir: 1, random_scale: 0.5, use_face_normal: 0, model_def: [{ name: 'flora/grass', probability: 1, scale: 1 }] }] },
        { game_object_type: 'skeleton_visual', is_enabled: 1, name: 'flag', model_name: 'fx/flag', position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { game_object_type: 'light', is_enabled: 1, name: 'lamp', position: [0, 3, 0] },
        { game_object_type: 'particle', is_enabled: 1, name: 'fly(1)', particle_name: 'fx/environment/fly', position: [1, 1, 1] },
        { game_object_type: 'light', is_enabled: 0, name: 'off', position: [0, 3, 0] },
        { game_object_type: 'wire_set', is_enabled: 1, name: 'w', wire_width: 0.05, points: [[0, 0, 0], [0, -1, 1]], position: [0, 5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ],
    });
    const db = makeVostokDb({
      'projects/veg_level/day/client_project': project,
      'projects/veg_level/vegetation/green.veg': makeVeg([[1, 0, 1], [2, 0, 2]], [[0, 1, 0], [0, 1, 0]]),
      'models/props/box.model/render/box_s/converted_model': quad(),
      'models/flora/grass.model/render/g/converted_model': quad(),
      'models/flora/grass.model/settings': makeVostokConfig({ material_settings: { g: { material_name: 'flora/grass' } } }),
      'material_instances/flora/grass.material': makeVostokConfig({ material: { instance: { base_material: 'grass' }, g_stage: { effect: { t_albedo: { value: 'flora/grass' }, use_alpha_test: { value: 1 } } } } }),
      'models/fx/flag.skinned_model/render/flag/converted_model': quad(),
    });
    const s = new ViewerSession(createRegistry(allEngines), 'survarium');
    await s.addArchives([file(db, 'resources.00.db')]);
    const a = s.archives[0]!;
    const m = (await s.loadModel([a.fileOf(a.lookup('projects/veg_level/day.vlevel')!)]))!;
    const info = m.info.join('\n');
    expect(info).toMatch(/Объекты со скелетом \(в bind-позе\): 1/);
    expect(info).toMatch(/Трава: 2 экземпляров/);
    expect(info).toMatch(/Провода: 1/);
    expect(info).toMatch(/источники света 1, частицы 1/);
    const groups = m.instances!.placements.map((p) => p.group);
    expect(groups).toEqual(['props', 'skeleton_visual/fx', 'wire_set', 'vegetation/green', 'vegetation/green', 'light', 'particle']);
    const grass = m.meshes.find((x) => x.name.startsWith('Трава'))!;
    expect(grass.alphaTest).toBe(true);
    expect(grass.vertexCount).toBe(8);
    const marks = m.meshes.filter((x) => x.name.startsWith('Метки'));
    expect(marks.map((x) => [x.name, x.defaultHidden])).toEqual([['Метки · свет', true], ['Метки · частицы', true]]);
    expect(m.instances!.placements.find((p) => p.group === 'particle')!.name).toBe('fx/environment/fly');
  });
});
