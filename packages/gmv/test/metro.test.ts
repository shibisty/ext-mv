import { describe, expect, it } from 'vitest';
import { quicklzDecompress } from '../src/core/codecs/quicklz';
import { openVfi, parseVfi } from '../src/engines/metro/vfs';
import { metroLevelModel } from '../src/engines/metro/level';
import { ddsFromPieces, pieceFormat } from '../src/engines/metro/texture';
import { decodeDDS } from '../src/core/images/dds';
import { createRegistry } from '../src/index';
import { allEngines } from '../src/engines/index';
import { file } from './helpers/bin';
import { makeMetroConfig, makeMetroLevel, makeSkinnedModel, makeStaticModel, makeVfi, metroEntity, packLevelBin, quicklzCompress, IDENT } from './helpers/metro';
import { metroEntities, parseMetroConfig, cfgGet } from '../src/engines/metro/config';
import { metroModelFromData, readMetroModel } from '../src/engines/metro/model';
import { placeLevelObjects } from '../src/engines/metro/objects';
import { ViewerSession } from '../src/index';
import { exportXraySdk } from '../src/engines/xray/export';
import { applyPlacement } from '../src/core/scene';
import { objectMeshes, parseObject } from '../src/engines/xray/object';
import { parseIni, placeMesh, sceneObjects } from '../src/engines/xray/scene';

const enc = (s: string) => new TextEncoder().encode(s);

describe('4A Engine (Metro 2033)', () => {
  it('QuickLZ уровня 3: литералы, совпадения, хвост; несколько слов управления', () => {
    for (const s of ['abcabcabcabcabcabc-the-end-0123456789', 'x'.repeat(200) + 'tail-0123456789', 'короткий текст без повторов ' + '0123456789'.repeat(5)]) {
      const u = enc(s);
      expect(quicklzDecompress(quicklzCompress(u), u.length)).toEqual(u);
    }
  });

  it('.vfi + .vfs: имена с XOR, сжатые и несжатые файлы, «content\\\\» убирается из пути', async () => {
    const lvl = enc('level data '.repeat(20)), tex = new Uint8Array(64).fill(7);
    const { vfi, vfs } = makeVfi([{ path: 'content\\maps\\test\\level', data: lvl, compress: true }, { path: 'content\\textures\\floor\\floor_01.512', data: tex }]);
    expect(parseVfi(vfi)[0]!.files.map((f) => f.path)).toEqual(['content\\maps\\test\\level', 'content\\textures\\floor\\floor_01.512']);
    const reg = createRegistry(allEngines);
    expect((await reg.archiveFor(file(vfi, 'content.vfi')))?.id).toBe('metro-vfi');
    const a = await openVfi(file(vfi, 'content.vfi'), [file(vfs, 'data.vfs0')]);
    expect(a.entries.map((e) => e.path)).toEqual(['maps/test/level', 'textures/floor/floor_01.512']);
    expect(await a.read(a.lookup('maps/test/level')!)).toEqual(lvl);
    expect(await a.read(a.lookup('textures/floor/floor_01.512')!)).toEqual(tex);
    await expect(openVfi(file(vfi, 'content.vfi'), [])).rejects.toThrow(/data\.vfs0/);
  });

  it('уровень: визуал -> меш с текстурой шейдера, UV × 1024, нормаль из D3DCOLOR, левая система', () => {
    const { level, geom } = makeMetroLevel();
    const m = metroLevelModel(level, geom, 'test');
    expect(m.flipZ).toBe(true);
    expect(m.meshes).toHaveLength(1);
    const x = m.meshes[0]!;
    expect([x.texture, x.material]).toEqual(['concrete\\floor_01', 'materials\\concrete']);
    expect(Array.from(x.uv)).toEqual([0, 0, 2, 0, 2, 2, 0, 2]);
    expect(x.nor[1]).toBeCloseTo(1, 1);
    expect(Array.from(x.indices)).toEqual([0, 2, 1, 0, 3, 2]);
  });

  it('текстуры: формат по размеру куска, DDS из кусков 1024 + 512 (с mip-уровнями)', () => {
    const chain512 = (bpb: number) => { let t = 0; for (let w = 512; w >= 1; w >>= 1) t += Math.max(1, w / 4) ** 2 * bpb; return t; };
    expect(pieceFormat(512, chain512(8))).toEqual({ fourcc: 'DXT1', mips: 10 });
    expect(pieceFormat(512, chain512(16))).toEqual({ fourcc: 'DXT5', mips: 10 });
    expect(pieceFormat(1024, 256 * 256 * 8)).toEqual({ fourcc: 'DXT1', mips: 1 });
    const dds = ddsFromPieces([{ side: 512, data: new Uint8Array(chain512(8)) }, { side: 1024, data: new Uint8Array(256 * 256 * 8) }]);
    const dv = new DataView(dds.buffer);
    expect([dv.getUint32(12, true), dv.getUint32(28, true), String.fromCharCode(...dds.subarray(84, 88))]).toEqual([1024, 11, 'DXT1']);
    expect(decodeDDS(dds.buffer.slice(0) as ArrayBuffer).width).toBe(1024);
  });

  it('бинарный конфиг: поля по таблице строк, подсказки, тип-подсказка со значением, массив и секции', () => {
    const cfg = parseMetroConfig(makeMetroConfig([
      ['count_a', 'u32', 7],
      ['startup', 'section', [['envmap', 'texture, str_shared', null], ['envmap', 'stringz', 'env\\menu'], ['view_distance', 'fp32', 250]]],
      ['entities', 'array', [['count', 'u32', 2], metroEntity('box_0001', 'STATICPROP', 'static\\props\\box', IDENT), metroEntity('gun', 'WEAPON_AK_74', 'dynamic\\wpn\\ak', IDENT, 5)]],
    ]));
    expect(cfgGet(cfg.root, 'count_a')?.value).toBe(7);
    const st = cfgGet(cfg.root, 'startup')!.value as never[];
    expect(cfgGet(st, 'envmap')?.value).toBe('env\\menu');
    expect(cfgGet(st, 'view_distance')?.value).toBe(250);
    const es = metroEntities(cfg);
    expect(es.map((e) => [e.name, e.cls, e.visual, e.parent])).toEqual([['box_0001', 'STATICPROP', 'static\\props\\box', 0xffff], ['gun', 'WEAPON_AK_74', 'dynamic\\wpn\\ak', 5]]);
    expect(cfgGet(es[0]!.fields, 'backlight_ref')?.value).toBe(0xffff);
    expect(cfgGet(es[0]!.fields, 'dao_val')?.value).toBe(1);
  });

  it('модель: статика (позиция f32, UV f32) и скин (.mesh + .skeleton, кости по родителям, таблица костей меша)', async () => {
    const st = await readMetroModel(makeStaticModel(), async () => null);
    const sm = metroModelFromData(st, 'box');
    expect(sm.meshes[0]!.texture).toBe('props\\box');
    expect(Array.from(sm.meshes[0]!.pos)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(sm.meshes[0]!.uv)).toEqual([0, 0, 1, 0, 0, 1]);
    const { model, mesh, skeleton } = makeSkinnedModel(), files: Record<string, Uint8Array> = { 'dynamic/test/body.mesh': mesh, 'dynamic/test/rig.skeleton': skeleton };
    const d = await readMetroModel(model, async (rel) => files[rel] ?? null);
    expect(d.missing).toEqual([]);
    const m = metroModelFromData(d, 'rig'), x = m.meshes[0]!, sk = m.skeleton!;
    expect(x.skinned).toBe(true);
    expect(Array.from(x.pos)).toEqual([0, 1, 0, 1, 1, 0, 0, 2, 0]);
    expect(Array.from(x.uv)).toEqual([0.5, 1, 0.5, 1, 0.5, 1]);
    // скелет переупорядочен: root (0) раньше a_child (1); вершина 1 привязана к a_child
    expect(sk.parent).toEqual([-1, 0]);
    expect([x.bone[0], x.bone[4], x.bone[8]]).toEqual([0, 1, 0]);
    sk.pose(null, 0, false);
    expect(Array.from(sk.worldV[1]!.subarray(12, 15))).toEqual([1, 1, 0]);
    for (const s of sk.skinV) s.forEach((v, k) => expect(v).toBeCloseTo(k % 5 === 0 ? 1 : 0, 9));
  });

  it('объекты level.bin: модели по позам, прикреплённые пропускаются, зеркальная поза меняет обход', async () => {
    const shift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 5, 1], mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const bin = packLevelBin(makeMetroConfig([['entities', 'array', [['count', 'u32', 3],
      metroEntity('a', 'STATICPROP', 'static\\props\\box', shift), metroEntity('b', 'STATICPROP', 'static\\props\\box', mirror),
      metroEntity('c', 'WEAPON_AK_74', 'static\\props\\box', IDENT, 1), metroEntity('d', 'STATICPROP', 'static\\props\\none', IDENT)]]]));
    const box = makeStaticModel();
    const r = await placeLevelObjects(bin, async (rel) => (rel === 'static/props/box.model' ? box : null));
    expect(r.meshes).toHaveLength(1);
    const m = r.meshes[0]!;
    expect(Array.from(m.pos.subarray(0, 9))).toEqual([10, 0, 5, 11, 0, 5, 10, 1, 5]);
    expect(Array.from(m.pos.subarray(9, 18)).map((v) => v + 0)).toEqual([0, 0, 0, -1, 0, 0, 0, 1, 0]);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 3, 5, 4]);
    expect(r.info.join('\n')).toMatch(/показано 2/);
    expect(r.info.join('\n')).toMatch(/не показаны: 1/);
    expect(r.info.join('\n')).toMatch(/static\/props\/none/);
  });

  it('уровень из .vfi: геометрия + объекты level.bin; .model открывается с .mesh и .skeleton из архива', async () => {
    const { level, geom } = makeMetroLevel(), sk = makeSkinnedModel();
    const bin = packLevelBin(makeMetroConfig([['entities', 'array', [['count', 'u32', 1], metroEntity('a', 'STATICPROP', 'static\\props\\box', IDENT)]]]));
    const { vfi, vfs } = makeVfi([
      { path: 'content\\maps\\test\\level', data: level }, { path: 'content\\maps\\test\\level.geom_pc', data: geom, compress: true },
      { path: 'content\\maps\\test\\level.bin', data: bin }, { path: 'content\\meshes\\static\\props\\box.model', data: makeStaticModel(), compress: true },
      { path: 'content\\meshes\\dynamic\\test\\guy.model', data: sk.model }, { path: 'content\\meshes\\dynamic\\test\\body.mesh', data: sk.mesh },
      { path: 'content\\meshes\\dynamic\\test\\rig.skeleton', data: sk.skeleton },
    ]);
    const s = new ViewerSession(createRegistry(allEngines), 'metro2033');
    await s.addArchives([file(vfi, 'content.vfi'), file(vfs, 'data.vfs0')]);
    const a = s.archives[0]!;
    const lv = await s.loadModel([a.fileOf(a.lookup('maps/test/level')!)]);
    expect(lv?.meshes.map((m) => m.texture)).toEqual(['concrete\\floor_01', 'props\\box']);
    expect(lv?.info.join('\n')).toMatch(/level\.bin: объектов 1/);
    const guy = await s.loadModel([a.fileOf(a.lookup('meshes/dynamic/test/guy.model')!)]);
    expect(guy?.skeleton?.n).toBe(2);
    expect(guy?.meshes[0]!.texture).toBe('act\\body');
  });

  it('экспорт в X-Ray SDK: объекты level.bin — по .object на модель, в сцене ссылки с поворотом, масштабом и позицией', async () => {
    const c = Math.cos(0.7), sn = Math.sin(0.7), k = 2;
    // поворот вокруг Y с масштабом 2 (строки × 2), перенос (3, 1, -4); вторая поза — зеркальная
    const pose = [k * c, 0, -k * sn, 0, 0, k, 0, 0, k * sn, 0, k * c, 0, 3, 1, -4, 1], mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const bin = packLevelBin(makeMetroConfig([['entities', 'array', [['count', 'u32', 3],
      metroEntity('box_a', 'STATICPROP', 'static\\props\\box', pose), metroEntity('box_b', 'STATICPROP', 'static\\props\\box', IDENT), metroEntity('box_m', 'STATICPROP', 'static\\props\\box', mirror)]]]));
    const { level, geom } = makeMetroLevel();
    const { vfi, vfs } = makeVfi([{ path: 'content\\maps\\t\\level', data: level }, { path: 'content\\maps\\t\\level.geom_pc', data: geom }, { path: 'content\\maps\\t\\level.bin', data: bin }, { path: 'content\\meshes\\static\\props\\box.model', data: makeStaticModel() }]);
    const s = new ViewerSession(createRegistry(allEngines), 'metro2033');
    await s.addArchives([file(vfi, 'content.vfi'), file(vfs, 'data.vfs0')]);
    const a = s.archives[0]!, model = (await s.loadModel([a.fileOf(a.lookup('maps/t/level')!)]))!;
    expect(model.instances?.placements).toHaveLength(3);
    // диапазоны экземпляров в слитом меше: пересчёт по позе даёт те же вершины и индексы
    const om = model.meshes[model.instances!.meshes[0]!]!, pos0 = Array.from(om.pos), idx0 = Array.from(om.indices);
    for (let i = 0; i < 3; i++) applyPlacement(model, i);
    expect(Array.from(om.pos)).toEqual(pos0);
    expect(Array.from(om.indices)).toEqual(idx0);
    expect(model.instances!.placements.map((p) => p.group)).toEqual(['STATICPROP', 'STATICPROP', 'STATICPROP']);
    const { files, report } = await exportXraySdk(model, { name: 't', cell: 0 });
    const keys = [...files.keys()].filter((x) => x.endsWith('.object')).sort();
    expect(keys).toEqual(['rawdata/objects/gmv/t/props/box.object', 'rawdata/objects/gmv/t/t.object', 'rawdata/objects/gmv/t/t_mirrored.object']);
    const part = parseIni(new TextDecoder('windows-1251').decode(files.get('rawdata/levels/t/scene_object.part')));
    const refs = sceneObjects(part), ra = refs.find((r) => r.name === 'box_a')!;
    expect(refs.map((r) => r.reference).sort()).toEqual(['gmv\\t\\props\\box', 'gmv\\t\\props\\box', 'gmv\\t\\t', 'gmv\\t\\t_mirrored']);
    const proto = objectMeshes(parseObject(new Uint8Array(files.get('rawdata/objects/gmv/t/props/box.object')!).buffer as ArrayBuffer))[0]!;
    const placed = placeMesh(proto, ra);
    // вершина (1, 0, 0) модели -> (1, 0, 0)·M
    const v = [...Array(proto.pos.length / 3).keys()].find((i) => Math.abs(proto.pos[i * 3]! - 1) < 1e-6)!;
    expect(placed.pos[v * 3]).toBeCloseTo(3 + k * c, 4);
    expect(placed.pos[v * 3 + 1]).toBeCloseTo(1, 4);
    expect(placed.pos[v * 3 + 2]).toBeCloseTo(-4 - k * sn, 4);
    expect(report.join('\n')).toMatch(/Объекты уровня: 3 экземпляров, 1 моделей.*зеркальных 1/);
  });
});
