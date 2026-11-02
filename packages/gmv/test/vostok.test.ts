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
