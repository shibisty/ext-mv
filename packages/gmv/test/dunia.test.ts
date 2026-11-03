import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { lzo1xDecompress } from '../src/core/codecs/lzo';
import { duniaHash, namesFromResourceXml, parseFat } from '../src/engines/dunia/fat';
import { parseXbg, parseXbm } from '../src/engines/dunia/xbg';
import { decodeXbt } from '../src/engines/dunia/xbt';
import { file } from './helpers/bin';
import { makeDdsDxt1 } from './helpers/fixtures';
import { fc2Hash, lzoRepeat, makeFat, makeXbg, makeXbm, makeXbt } from './helpers/dunia';

const MAT = 'graphics\\_materials\\test-m-1.xbm', TEX = 'graphics\\_textures\\box_d.xbt', MODEL = 'graphics\\objects\\box.xbg';

describe('Dunia (Far Cry 2)', () => {
  it('хеш имени — CRC-32 пути в нижнем регистре с «\\»; .fat: размеры, схема, смещение', () => {
    expect(duniaHash('graphics/Weapons/AK47.xbg')).toBe(fc2Hash('graphics\\weapons\\ak47.xbg'));
    const { fat } = makeFat([{ path: 'a.txt', data: new Uint8Array(5) }, { path: 'b.txt', data: new Uint8Array(9) }]);
    const es = parseFat(fat);
    expect(es.map((e) => [e.size, e.scheme, e.csize, e.off])).toEqual([[5, 0, 5, 0], [9, 0, 9, 8]]);
    expect(() => parseFat(new Uint8Array(16))).toThrow(/FAT2/);
  });

  it('LZO-поток с повторами распаковывается; обрезанный поток — ошибка, а не зацикливание', () => {
    const { packed, plain } = lzoRepeat('<root>\n', '<CGeometryResource ID="x.xbg" />\n', 5000);
    const out = new Uint8Array(plain.length);
    lzo1xDecompress(packed, 0, out);
    expect(out).toEqual(plain);
    expect(() => lzo1xDecompress(packed.subarray(0, 60), 0, new Uint8Array(plain.length))).toThrow(/LZO/);
    // любой обрыв (в том числе посреди хвостовых литералов, где позиция становилась NaN) — ошибка, а не зацикливание
    let thrown = 0;
    for (let n = 1; n < packed.length; n++) { try { lzo1xDecompress(packed.subarray(0, n), 0, new Uint8Array(plain.length)); } catch { thrown++; } }
    expect(thrown).toBeGreaterThan(packed.length - 6); // без маркера конца, но с полным выходом — допустимо
    const t = Uint8Array.from([20, 65, 66, 67]); // 3 литерала (состояние 3), затем конец входа
    expect(() => lzo1xDecompress(t, 0, new Uint8Array(16))).toThrow(/LZO/);
  });

  it('XML-список ресурсов: пути из ID', () => {
    expect(namesFromResourceXml('<root><CGeometryResource ID="graphics\\a.xbg" crc_ID="1"><CMaterialResource ID="m.xbm" crc_ID="2" /></CGeometryResource></root>')).toEqual(['graphics\\a.xbg', 'm.xbm']);
  });

  it('материал .xbm и модель .xbg: части, кластеры, LOD, распаковка позиций', () => {
    const m = parseXbm(makeXbm('BOXMAT', 'Generic', { DiffuseTexture1: TEX, NormalTexture1: 'n.xbt' }));
    expect(m).toEqual({ name: 'BOXMAT', shader: 'Generic', textures: { DiffuseTexture1: TEX, NormalTexture1: 'n.xbt' } });
    const x = parseXbg(makeXbg(MAT));
    expect(x.materials).toEqual([MAT]);
    expect(x.parts).toEqual([{ name: 'BOX_LOD0', lod: 0, node: 0 }]);
    expect(x.clusters[0]![0]!.tris).toBe(2);
    expect(x.lods.map((l) => [l.buffers.map((b) => [b.stride, b.vcount, b.base]), l.icount, l.prims.length])).toEqual([[[[32, 4, 0]], 6, 1]]);
    expect(x.pcmp[1]).toBeCloseTo(1 / 1024);
  });

  it('.xbt: заголовок TBX + DDS', () => {
    const img = decodeXbt(makeXbt(makeDdsDxt1(8, 4)).slice().buffer);
    expect([img.width, img.height]).toEqual([8, 4]);
  });

  it('сессия: папка с .fat/.dat, имена из XML-списка (LZO), модель с материалом и текстурой', async () => {
    const chunk = `<CGeometryResource ID="${MODEL}" crc_ID="1"><CMaterialResource ID="${MAT}" crc_ID="2" /></CGeometryResource>\n`;
    const xml = lzoRepeat('<root>\n', chunk, 300 * 1024);
    const { fat, dat } = makeFat([
      { path: 'worlds\\generated\\list.xml', data: xml.plain, packed: xml.packed },
      { path: MODEL, data: makeXbg(MAT) },
      { path: MAT, data: makeXbm('BOXMAT', 'Generic', { DiffuseTexture1: TEX }) },
      { path: TEX, data: makeXbt(makeDdsDxt1(4, 4)) },
    ]);
    const s = new ViewerSession(createRegistry(allEngines), 'farcry2');
    await s.addArchives([file(fat, 'worlds.fat'), file(dat, 'worlds.dat')]);
    const a = s.archives[0]!;
    expect(a.kind).toBe('dunia-fat');
    expect(a.entries.map((e) => e.path)).toEqual(['graphics/_materials/test-m-1.xbm', 'graphics/objects/box.xbg']);
    expect(a.lookup(TEX)).not.toBeNull(); // нет в списке, но доступен по ссылке
    const m = (await s.loadModel([a.fileOf(a.lookup(MODEL)!)]))!;
    expect(m.meshes.map((x) => [x.name, x.texture])).toEqual([['BOX · BOXMAT', TEX]]);
    const me = m.meshes[0]!;
    expect(Array.from(me.pos.subarray(3, 6))).toEqual([1, 0, 0]);
    expect(Array.from(me.indices)).toEqual([0, 1, 2, 0, 2, 3]); // порядок треугольников развёрнут против часовой
    expect(me.nor[2]).toBeCloseTo(1, 1);
    expect(m.defaultZUp).toBe(true);
    const t = await s.resolveTexture(0);
    expect(t.image?.width).toBe(4);
  });

  it('«Папка игры»: .fat открываются сами, .dat находятся рядом (по относительному пути)', async () => {
    const { fat, dat } = makeFat([{ path: MODEL, data: makeXbg(MAT) }]);
    const p = makeFat([{ path: MAT, data: makeXbm('BOXMAT', 'Generic', {}) }]);
    const s = new ViewerSession(createRegistry(allEngines), 'farcry2');
    const folder = s.addFolder([file(fat, 'worlds.fat', 'FC2/Data_Win32/worlds/worlds.fat'), file(dat, 'worlds.dat', 'FC2/Data_Win32/worlds/worlds.dat'),
      file(p.fat, 'patch.fat', 'FC2/Data_Win32/patch.fat'), file(p.dat, 'patch.dat', 'FC2/Data_Win32/patch.dat')]);
    expect(await s.openFolderArchives(folder)).toBe(1);
    const a = s.archives.find((x) => x.kind === 'dunia-fat')!;
    expect(a.lookup(MODEL)).not.toBeNull();
    expect(a.lookup(MAT)).not.toBeNull();
  });
});

import { buildMabMotion, parseMab, parseSkeleton, unpackQuat } from '../src/engines/dunia/mab';
import { kitHiddenParts, reparentNodes, skeletonCandidates } from '../src/engines/dunia/xbg';
import { makeMab, makeSkeleton, packQuat } from './helpers/dunia';

const rz = (deg: number) => [Math.cos((deg * Math.PI) / 360), 0, 0, Math.sin((deg * Math.PI) / 360)];
const near = (a: number[], b: number[], eps = 2e-3) => { const d = a.reduce((s, v, i) => s + v * b[i]!, 0); return Math.abs(Math.abs(d) - 1) < eps; };

describe('Dunia: анимации .mab', () => {
  it('кватернион 6 байт: опущенная компонента по старшим битам двух слов, все четыре случая', () => {
    for (const q of [[0.9, 0.3, 0.2, 0.1], [0.1, 0.9, 0.3, 0.2], [0.2, 0.1, 0.9, 0.3], [0.3, 0.2, 0.1, 0.9]]) {
      const l = Math.hypot(...q), n = q.map((v) => v / l);
      expect(near(unpackQuat(...packQuat(n)), n)).toBe(true);
    }
  });

  it('разделы: постоянные и ключевые повороты по блокам из 8, пропуски интерполируются, смещения; маски -> кости', () => {
    const keys = Array.from({ length: 10 }, (_, k) => rz(k * 10));
    const holes = keys.map((q, k) => (k === 3 ? null : q)); // ключ 3 пропущен — интерполяция между 20° и 40°
    const u = makeMab({ keys: 10, duration: 0.6, constRot: [[0, rz(90)]], rotKeys: [[1, keys], [40, holes]], constPos: [[2, [0, 0, 5]]], posKeys: [[0, keys.map((_, k) => [k, 0, 0])]] });
    const a = parseMab(u);
    expect([a.keys, a.rate]).toEqual([10, 15]);
    expect(near(a.constRot.get(0)!, rz(90))).toBe(true);
    expect(a.rotKeys.get(1)!.every((q, k) => near(q, rz(k * 10)))).toBe(true);
    expect(near(a.rotKeys.get(40)![3]!, rz(30))).toBe(true);
    expect(a.constPos.get(2)).toEqual([0, 0, 5]);
    expect(a.posKeys.get(0)![7]).toEqual([7, 0, 0]);
    // без ключевых поворотов (только позы) — тоже читается
    expect(parseMab(makeMab({ keys: 4, duration: 0.2, constRot: [[0, rz(0)]] })).rotKeys.size).toBe(0);
  });

  it('движение: кости -> узлы, у корня — перевод в пространство родителя-узла', () => {
    const a = parseMab(makeMab({ keys: 2, duration: 1 / 15, rotKeys: [[0, [rz(0), rz(90)]]], posKeys: [[0, [[0, 0, 1], [0, 0, 2]]]] }));
    const C = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1]); // родитель на высоте 1
    const m = buildMabMotion('t', a, [5], new Map([[0, C]]));
    const ch = m.chan.get(5)!;
    expect(ch.pos![1]![1].map((v) => +v.toFixed(3))).toEqual([0, 0, 1]);
    expect(near(ch.rot![1]![1], rz(90))).toBe(true);
  });

  it('движение корня: таз сдвигается и поворачивается относительно первого ключа', () => {
    const a = parseMab(makeMab({ keys: 3, duration: 2 / 15, constRot: [[0, rz(0)]], constPos: [[0, [0, 0, 1]]],
      rootPos: [[5, 5, 0], [5, 6, 0], [5, 7, 0]], rootRot: [rz(0), rz(0), rz(90)] }));
    expect(a.rootPos!.length).toBe(3);
    const m = buildMabMotion('t', a, [2], new Map(), { bone: 0, rot: rz(0), pos: [0, 0, 1] });
    const ch = m.chan.get(2)!;
    expect(ch.pos!.map(([, p]) => p.map((v) => +v.toFixed(3)))).toEqual([[0, 0, 1], [0, 1, 1], [0, 2, 1]]);
    expect(near(ch.rot![2]![1], rz(90))).toBe(true);
    // без движения корня — свои ключи кости как есть
    const still = buildMabMotion('t', parseMab(makeMab({ keys: 2, duration: 1 / 15, constPos: [[0, [0, 0, 1]]], rootPos: [[1, 1, 0], [1, 1, 0]] })), [2], new Map(), { bone: 0, rot: rz(0), pos: [0, 0, 1] });
    expect(still.chan.get(2)!.pos).toEqual([[0, [0, 0, 1]]]);
  });

  it('кит персонажа: одна голова и глаза к ней, тело её расы, руки под верх, «без шапки», DUMMY скрыт', () => {
    const parts = ['P_MERC_CAUCASIANHEAD01', 'P_MERC_NUBIANHEAD02', 'P_MERC_EYESCAUCASIANHEAD01', 'P_MERC_EYESNUBIANHEAD02',
      'P_MERC_CAUCASIAN_BEATER_ARMS', 'P_MERC_CAUCASIAN_SHIRT_ARMS', 'P_MERC_NUBIAN_BEATER_ARMS', 'P_MERC_UB_BEATER01', 'P_MERC_UB_SHIRT02',
      'P_MERC_HAT01', 'P_MERC_NOHAT', 'P_MERC_DUMMY', 'P_MERC_BOOT01', 'P_MERC_BOOT02'];
    const h = kitHiddenParts(parts);
    const shown = parts.filter((n) => !h.has(n));
    expect(shown).toEqual(['P_MERC_CAUCASIANHEAD01', 'P_MERC_EYESCAUCASIANHEAD01', 'P_MERC_CAUCASIAN_BEATER_ARMS', 'P_MERC_UB_BEATER01', 'P_MERC_NOHAT', 'P_MERC_BOOT01']);
    expect(kitHiddenParts(['BODY', 'HEAD']).size).toBe(0); // не кит
  });

  it('скелет .skeleton: имена (у корня за именем флаг), родители, позы; переподвешивание с сохранением bind-позы', () => {
    const sk = parseSkeleton(makeSkeleton([
      { name: 'Pelvis', parent: -1, rot: [1, 0, 0, 0], pos: [0, 0, 0] },
      { name: 'L Thigh', parent: 0, rot: [1, 0, 0, 0], pos: [0, 0.1, 0] },
      { name: 'L Knee', parent: 1, rot: [1, 0, 0, 0], pos: [0.4, 0, 0] },
    ]));
    expect(sk.map((b) => [b.name, b.parent])).toEqual([['Pelvis', -1], ['L Thigh', 0], ['L Knee', 1]]);
    expect(sk[1]!.pos.map((v) => +v.toFixed(3))).toEqual([0, 0.1, 0]);
    const I = (t: number[]) => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...t, 1]);
    const nodes = [{ name: 'Pelvis', parent: -1, local: I([0, 0, 1]), offset: I([0, 0, -1]) }, { name: 'L Thigh', parent: 0, local: I([0, 0.1, 0]), offset: I([0, -0.1, -1]) }, { name: 'L Knee', parent: 0, local: I([0.4, 0.1, 0]), offset: I([-0.4, -0.1, -1]) }];
    const r = reparentNodes(nodes, new Map([['l knee', 'l thigh']]));
    expect(r[2]!.parent).toBe(1);
    expect(Array.from(r[2]!.local).slice(12, 15).map((v) => +v.toFixed(3))).toEqual([0.4, 0, 0]);
    expect(skeletonCandidates('graphics/actors/x/jack.xbg', true)).toContain('graphics\\characters\\_common\\pelvis_ref.skeleton');
    expect(skeletonCandidates('graphics/characters/animals/zebra/zebra.xbg')[0]).toBe('graphics\\characters\\animals\\zebra\\zebra_ref.skeleton');
  });

  it('сессия: скиновая модель находит скелет, список анимаций из папки скелета, поворот кости двигает вершины', async () => {
    const MODEL2 = 'graphics\\characters\\test\\thing.xbg';
    const { fat, dat } = makeFat([
      { path: MODEL2, data: makeXbg(MAT, { skinned: true }) },
      { path: MAT, data: makeXbm('BOXMAT', 'Generic', {}) },
      { path: 'graphics\\characters\\test\\hips_ref.skeleton', data: makeSkeleton([{ name: 'Bone', parent: -1, rot: [1, 0, 0, 0], pos: [0, 0, 0] }]) },
      { path: 'graphics\\characters\\test\\animations\\turn.mab', data: makeMab({ keys: 2, duration: 1 / 15, rotKeys: [[0, [rz(0), rz(90)]]] }) },
      { path: 'list.xml', data: new TextEncoder().encode(`<root><CAnimationResource ID="graphics\\characters\\test\\animations\\turn.mab" /><CGeometryResource ID="${MODEL2}" /></root>`) },
    ]);
    const s = new ViewerSession(createRegistry(allEngines), 'farcry2');
    await s.addArchives([file(fat, 'worlds.fat'), file(dat, 'worlds.dat')]);
    const a = s.archives[0]!;
    const m = (await s.loadModel([a.fileOf(a.lookup(MODEL2)!)]))!;
    expect(m.skeleton).not.toBeNull();
    expect(m.info.join('\n')).toMatch(/Скелет анимаций: test\\hips_ref\.skeleton \(1 костей\)/);
    // список: .mab из папки скелета (имена — из XML-списка; здесь список мал, поэтому запись найдена через lookup)
    const mot = await m.loadMotions!(a.fileOf(a.lookup('graphics\\characters\\test\\animations\\turn.mab')!));
    m.skeleton!.pose(mot[0]!, 1 / 15, false);
    const M = m.skeleton!.skinV[1]!; // узел «Bone»
    const x = M[0]! * 1 + M[12]!, y = M[1]! * 1 + M[13]!;
    expect([+x.toFixed(3), +y.toFixed(3)]).toEqual([0, 1]); // (1,0,0) повёрнута на 90° вокруг Z
  });
});

import { fcbHash, parseFcb, fcbString, fcbVec3 } from '../src/engines/dunia/fcb';
import { parseRml, xmlElements } from '../src/engines/dunia/rml';
import { anglesQuat, waterMesh, sectorCollections, entityLibrary, parseTerrainSector, sectorEntities, terrainMeshes, terrainStep, vertexLayer, worldDescriptor, worldSectorXY } from '../src/engines/dunia/level';
import { fv, makeFcb, makeRealTree, makeRml, makeTerrain } from './helpers/dunia';
import { parseRealTree, realTreeMeshes } from '../src/engines/dunia/realtree';
import { Bin as BinT } from './helpers/bin';

const MODEL_KEY = 0xbf9b3a5c, ARCH_KEY = 0x346aab33;
const entity = (name: string, pos: number[], ang: number[], extra: FcbSpecT['values'] = [], kids: FcbSpecT[] = []): FcbSpecT =>
  ({ type: 'Entity', values: [['hidName', fv.str(name)], ['hidPos', fv.vec3(pos[0]!, pos[1]!, pos[2]!)], ['hidAngles', fv.vec3(ang[0]!, ang[1]!, ang[2]!)], ...extra], kids });
type FcbSpecT = Parameters<typeof makeFcb>[0];
const graphic = (model: string, parts = ''): FcbSpecT => ({ type: 'Components', kids: [{ type: 'CGraphicComponent', values: [[MODEL_KEY, fv.str(model)]], kids: parts ? [{ type: 'object', values: [['hidMeshName', fv.str(parts)]] }] : [] }] });
const gameXml = () => makeRml({ name: 'WorldDescriptor', kids: [
  { name: 'Grids', kids: [{ name: 'GridMapSectors', attrs: { CountX: '2', CountY: '1', Granularity: '64' } }, { name: 'GridWorldMaps', attrs: { CountX: '1', CountY: '1' }, kids: [{ name: 'Maps', kids: [{ name: 'Map', attrs: { Name: 'Levels\\T\\T.nomad', SectorOffsetX: '0', SectorOffsetY: '0', CountX: '2', CountY: '1' } }] }] }] },
  { name: 'Layers', kids: [{ name: 'Layer', attrs: { Name: 'Grass', Texture: 'graphics\\terrain\\grass_d.xbt', NormalMap: 'graphics\\terrain\\grass_n.xbt', Tiling: '32' } }, { name: 'Layer', attrs: { Name: 'Rock', Texture: 'graphics\\terrain\\rock_d.xbt', Tiling: '4' }, kids: [{ name: 'Variation' }] }] },
] });

describe('Dunia: уровни Far Cry 2', () => {
  it('.fcb: дерево, хеши имён, ссылка на прежнее значение и прежний объект', () => {
    const u = makeFcb({ type: 'WorldSector', values: [['Id', fv.u32(3)], ['X', fv.u32(1)], ['Y', fv.u32(2)]], kids: [entity('A', [1, 2, 3], [0, 0, 0])] });
    const r = parseFcb(u);
    expect(r.type).toBe(fcbHash('WorldSector'));
    expect(fcbString(r.children[0]!.values.get(fcbHash('hidName')))).toBe('A');
    expect(fcbVec3(r.children[0]!.values.get(fcbHash('hidPos')))).toEqual([1, 2, 3]);
    expect(worldSectorXY(u.subarray(0, 64))).toEqual([1, 2]);
    // ссылки: значение 0xFE + смещение назад, объект 0xFE + номер
    const b = [...makeFcb({ type: 'R', values: [['a', fv.str('xy')]], kids: [] })];
    b[16] = 2; // два ребёнка
    const at = b.length;
    b.push(0, ...new Uint8Array(new Uint32Array([fcbHash('K')]).buffer), 1, ...new Uint8Array(new Uint32Array([fcbHash('b')]).buffer));
    const valAt = b.length; b.push(0xfe, ...new Uint8Array(new Uint32Array([valAt - (16 + 1 + 4 + 1 + 4)]).buffer)); // ссылка на значение 'a'
    b.push(0xfe, 1, 0, 0, 0); // второй ребёнок — ссылка на объект №1
    const r2 = parseFcb(Uint8Array.from(b));
    expect(at).toBeGreaterThan(0);
    expect(fcbString(r2.children[0]!.values.get(fcbHash('b')))).toBe('xy');
    expect(r2.children[1]).toBe(r2.children[0]);
  });

  it('двоичный и текстовый XML: описание мира — сетка и слои ландшафта', () => {
    const u = gameXml();
    expect(parseRml(u).children[1]!.children[1]!.attrs.Name).toBe('Rock');
    const d = worldDescriptor(u);
    expect([d.countX, d.countY]).toEqual([2, 1]);
    expect(d.layers.map((l) => [l.name, l.tiling])).toEqual([['Grass', 32], ['Rock', 4]]);
    const t = new TextEncoder().encode('<WorldDescriptor>\n\t<Grids>\n\t\t<GridMapSectors CountX="8" CountY="8" />\n\t\t<GridWorldMaps CountX="2" CountY="1">\n\t\t</GridWorldMaps>\n\t</Grids>\n</WorldDescriptor>');
    expect(xmlElements(t).map((e) => [e.name, e.depth])).toEqual([['WorldDescriptor', 0], ['Grids', 1], ['GridMapSectors', 2], ['GridWorldMaps', 2]]);
    expect(worldDescriptor(t).countX).toBe(16);
  });

  it('ландшафт: высоты ·128 по строкам Y, основа и наложения слоёв по битам маски с прозрачностью по вершинам, плитка слоя', () => {
    const s = parseTerrainSector(makeTerrain(1, (x, y) => x * 0.5 + y, [0, 1, 255, 255], (x) => (x < 32 ? 1 : 3)));
    expect(s.id).toBe(1);
    expect(s.height[2 * 65 + 4]).toBe(4); // x 4, y 2
    expect([vertexLayer(1, s.layers), vertexLayer(3, s.layers), vertexLayer(4, s.layers), vertexLayer(0, [255, 7, 255, 255])]).toEqual([0, 1, 0, 7]);
    expect(terrainStep(16, 16)).toBe(2);
    expect(terrainStep(2, 1)).toBe(1);
    const sectors = new Map([[1, s]]);
    const ms = terrainMeshes({ x0: 1, y0: 0, w: 1, h: 1 }, sectors, 2, [{ name: 'Grass', texture: 'g.xbt', normal: '', tiling: 32 }, { name: 'Rock', texture: 'r.xbt', normal: '', tiling: 4 }], 1);
    // основа — Grass на всём секторе; Rock (слот 1, бит 1 при x ≥ 32) — наложение с прозрачностью: клетки x 31…63
    expect(ms.map((m) => m.name)).toEqual(['Ландшафт · Grass', 'Ландшафт · Rock (наложение 1)']);
    expect(ms.map((m) => m.indices.length / 3)).toEqual([64 * 64 * 2, 33 * 64 * 2]);
    const rock = ms[1]!;
    expect(ms[0]!.vertexAlpha).toBeUndefined();
    const alphaAt = (x: number) => rock.vertexAlpha![Array.from({ length: rock.vertexCount }, (_, i) => i).find((i) => rock.pos[i * 3] === 64 + x && rock.pos[i * 3 + 1] === 0)!];
    expect([alphaAt(31), alphaAt(32), alphaAt(40)]).toEqual([0, 1, 1]);
    const g = ms[0]!;
    expect([g.pos[0], g.pos[1], g.pos[2]]).toEqual([64, 0, 0]); // сектор x 1 — от 64 м
    expect(g.uv[0]).toBeCloseTo(32); // 64 м × 32 повтора / 64 м
    expect(g.nor[2]).toBeLessThan(1);
  });

  it('объекты сектора: модель из CGraphicComponent, части кита, архетип из библиотеки; углы — Z последним', () => {
    const lib = entityLibrary(parseFcb(makeFcb({ type: 'Root', kids: [{ type: 'Cat', kids: [entity('OA.Huts.Hut', [0, 0, 0], [0, 0, 0], [], [graphic('graphics\\hut.xbg')])] }] })));
    expect(lib.get('OA.Huts.Hut')?.model).toBe('graphics\\hut.xbg');
    const ws = parseFcb(makeFcb({ type: 'WorldSector', values: [['X', fv.u32(1)], ['Y', fv.u32(0)]], kids: [{ type: 0x494c09f2, values: [[0xc56f9204, fv.str('main')]], kids: [
      entity('Box_1', [70, 10, 5], [0, 0, 90], [], [graphic('graphics\\box.xbg', ';BOX;')]),
      entity('Hut_1', [80, 20, 5], [0, 0, 0], [[ARCH_KEY, fv.str('OA.Huts.Hut')]]),
      entity('Logic', [1, 1, 1], [0, 0, 0]),
      entity('Lost', [1, 1, 1], [0, 0, 0], [[ARCH_KEY, fv.str('OA.Nope')]]),
    ] }] }));
    const r = sectorEntities(ws, lib);
    expect(r.list.map((e) => [e.name, e.model, e.parts.join(','), e.layer])).toEqual([['Box_1', 'graphics\\box.xbg', 'BOX', 'main'], ['Hut_1', 'graphics\\hut.xbg', '', 'main']]);
    expect(r.noModel).toBe(2);
    expect([...r.unknownArchetype]).toEqual(['OA.Nope']);
    const q = anglesQuat([0, 0, 90]); // X -> Y
    expect(q[0]).toBeCloseTo(Math.SQRT1_2); expect(q[3]).toBeCloseTo(Math.SQRT1_2);
    const q2 = anglesQuat([90, 0, 90]); // сначала X, затем Z: ось Y -> Z (поворот X) -> остаётся Z
    const up = [2 * (q2[1]! * q2[2]! - q2[0]! * q2[3]!), 1 - 2 * (q2[1]! ** 2 + q2[3]! ** 2), 2 * (q2[2]! * q2[3]! + q2[0]! * q2[1]!)];
    expect(up.map((v) => Math.round(v) + 0)).toEqual([0, 0, 1]);
  });

  it('сессия: мир из файлов без имён — уровень *.fc2level, ландшафт по номерам секторов, объекты по WorldSector', async () => {
    const TERR = (id: number) => makeTerrain(id, () => 3, [0, 1, 255, 255], () => 1);
    const files = [
      { path: 'worlds\\tmpla\\anon\\t1', data: TERR(1) },
      { path: 'worlds\\tmpla\\anon\\t0', data: TERR(0) },
      { path: 'worlds\\tmpla\\anon\\junk', data: new Uint8Array(100) },
      { path: 'worlds\\tmpla\\anon\\ws1', data: makeFcb({ type: 'WorldSector', values: [['Id', fv.u32(1)], ['X', fv.u32(1)], ['Y', fv.u32(0)]], kids: [
        entity('Box_1', [70, 10, 3], [0, 0, 90], [], [graphic(MODEL)]),
        entity('Box_2', [80, 10, 3], [0, 0, 0], [[ARCH_KEY, fv.str('OA.Box')]]),
      ] }) },
      { path: 'worlds\\tmpla\\anon\\ws9', data: makeFcb({ type: 'WorldSector', values: [['Id', fv.u32(9)], ['X', fv.u32(9)], ['Y', fv.u32(9)]], kids: [entity('Far', [600, 600, 0], [0, 0, 0], [], [graphic(MODEL)])] }) },
      { path: 'worlds\\tmpla\\generated\\entitylibrary.fcb', data: makeFcb({ type: 'Root', kids: [entity('OA.Box', [0, 0, 0], [0, 0, 0], [], [graphic(MODEL)])] }) },
      { path: MODEL, data: makeXbg(MAT) },
      { path: MAT, data: makeXbm('BOXMAT', 'Generic', { DiffuseTexture1: TEX }) },
      { path: 'worlds\\tmpla\\generated\\tmpla.game.xml', data: gameXml() },
      { path: 'worlds\\tmpla\\generated\\tmpla.sectorsdep.fcb', data: makeFcb({ type: 'Deps' }) },
    ];
    const { fat, dat } = makeFat(files);
    const s = new ViewerSession(createRegistry(allEngines), 'farcry2');
    await s.addArchives([file(fat, 'worlds.fat'), file(dat, 'worlds.dat')]);
    const a = s.archives[0]!;
    expect(a.entries.map((e) => e.path)).toContain('worlds/tmpla/tmpla.fc2level');
    const m = (await s.loadModel([a.fileOf(a.lookup('worlds/tmpla/tmpla.fc2level')!)]))!;
    expect(m.info.join('\n')).toMatch(/секторов 2 из 2/);
    expect(m.info.join('\n')).toMatch(/Объекты: 2 из 2/);
    expect(m.instances!.placements.map((p) => p.name)).toEqual(['Box_1', 'Box_2']);
    const terrain = m.meshes.filter((x) => x.name.startsWith('Ландшафт'));
    expect(terrain.map((x) => x.texture)).toEqual(['graphics\\terrain\\grass_d.xbt']);
    expect(terrain[0]!.indices.length / 3).toBe(128 * 64 * 2);
    // Box_1 повёрнут на 90° вокруг Z: вершина (1, 0, 0) модели -> (70, 11, 3)
    const box = m.meshes.find((x) => x.texture === TEX)!;
    const pts = Array.from({ length: box.vertexCount }, (_, i) => [box.pos[i * 3]!, box.pos[i * 3 + 1]!, box.pos[i * 3 + 2]!].map((v) => Math.round(v * 100) / 100).join(','));
    expect(pts).toContain('70,11,3');
    expect(pts).toContain('81,10,3');
    expect(m.defaultZUp).toBe(true);
  });

  it('DLC: сначала ландшафт всех миров .dat, потом их файлы — k-й блок ландшафта принадлежит k-му миру', async () => {
    const T = (id: number, h: number) => makeTerrain(id, () => h, [0, 255, 255, 255], () => 1);
    const { fat, dat } = makeFat([
      { path: 'a/0', data: T(0, 5) }, { path: 'a/1', data: T(1, 5) },
      { path: 'b/0', data: T(0, 9) }, { path: 'b/1', data: T(1, 9) },
      { path: 'worlds\\mp_dlc02_lake\\generated\\mp_dlc02_lake.game.xml', data: gameXml() },
      { path: 'worlds\\mp_dlc02_lake\\generated\\mp_dlc02_lake.sectorsdep.fcb', data: makeFcb({ type: 'Deps' }) },
      { path: 'worlds\\mp_dlc04_bridge\\generated\\mp_dlc04_bridge.game.xml', data: gameXml() },
      { path: 'worlds\\mp_dlc04_bridge\\generated\\mp_dlc04_bridge.sectorsdep.fcb', data: makeFcb({ type: 'Deps' }) },
    ]);
    const s = new ViewerSession(createRegistry(allEngines), 'farcry2');
    await s.addArchives([file(fat, 'dlc1.fat'), file(dat, 'dlc1.dat')]);
    const a = s.archives[0]!;
    for (const [w, h] of [['mp_dlc02_lake', 5], ['mp_dlc04_bridge', 9]] as const) {
      const m = (await s.loadModel([a.fileOf(a.lookup(`worlds/${w}/${w}.fc2level`)!)]))!;
      expect(m.info.join('\n')).toMatch(/секторов 2 из 2/);
      expect(m.meshes[0]!.pos[2]).toBe(h);
    }
  });

  it('коллекции сектора: модели по хешу пути, группы, позиции в дециметрах, поворот вокруг Z; в уровне — по хешу без имени', async () => {
    const arr = (vals: number[], f: (b: InstanceType<typeof BinT>, v: number) => void) => { const b = new BinT().u32(vals.length); for (const v of vals) f(b, v); return b.toU8(); };
    const u32 = (b: InstanceType<typeof BinT>, v: number) => b.u32(v);
    const MH = fc2Hash(MODEL);
    const col = { type: 'CCollectionComponent', kids: [{ type: 0x114cfee7, values: [[0xe96c3cc5, fv.u32(5)]] as Array<[number, Uint8Array]>, kids: [{ type: 0xa18c8484, values: [
      [0x89c8c095, arr([MH], u32)], [0x58ad43e2, arr([2], u32)],
      [0x798c33d5, arr([(0 << 8) | 2, (2 << 8) | 1], u32)], // группа 1: 2 экземпляра с 0, группа 2: 1 с 2
      [0xb0484974, arr([0, 0, 0, 0, 0, 0, 0, 0], (b, v) => b.f32(v))],
      [0xd28100c0, arr([0, 1, 2], (b, i) => b.u16(700 + i * 10).u16(100))],
      [0x8e2752ca, arr([3, 3, 3], (b, v) => b.f32(v))],
      [0x98c678bd, arr([0, 16384, 0], u32)],
    ] as Array<[number, Uint8Array]> }] }] };
    const ws = makeFcb({ type: 'WorldSector', values: [['Id', fv.u32(1)], ['X', fv.u32(1)], ['Y', fv.u32(0)]], kids: [{ type: 'Entity', values: [['hidName', fv.str('SectorEntity_1')], ['hidPos', fv.vec3(96, 32, 0)]], kids: [{ type: 'Components', kids: [col] }] }] });
    const c = sectorCollections(parseFcb(ws));
    expect(c.map((x) => [x.hash, ...x.pos, x.yaw])).toEqual([[MH, 70, 10, 3, 0], [MH, 71, 10, 3, 90], [MH, 72, 10, 3, 0]]);
    const { fat, dat } = makeFat([
      { path: 'w/t0', data: makeTerrain(0, () => 3, [0, 255, 255, 255], () => 1) },
      { path: 'w/t1', data: makeTerrain(1, () => 3, [0, 255, 255, 255], () => 1) },
      { path: 'w/ws', data: ws },
      { path: MODEL, data: makeXbg(MAT) },
      { path: MAT, data: makeXbm('BOXMAT', 'Generic', { DiffuseTexture1: TEX }) },
      { path: 'worlds\\tmpla\\generated\\tmpla.game.xml', data: gameXml() },
      { path: 'worlds\\tmpla\\generated\\tmpla.sectorsdep.fcb', data: makeFcb({ type: 'Deps' }) },
    ]);
    const s2 = new ViewerSession(createRegistry(allEngines), 'farcry2');
    await s2.addArchives([file(fat, 'worlds.fat'), file(dat, 'worlds.dat')]);
    const a = s2.archives[0]!;
    const m = (await s2.loadModel([a.fileOf(a.lookup('worlds/tmpla/tmpla.fc2level')!)]))!;
    expect(m.info.join('\n')).toMatch(/Коллекции.*: 3 из 3/);
    expect(m.instances!.placements.map((p) => p.group)).toEqual(['collections/collections', 'collections/collections', 'collections/collections']);
  });

  it('уровень: модель со скелетом — в bind-позе (статикой), метки частиц и света скрыты', async () => {
    const SK = 'graphics\\characters\\test\\man.xbg';
    const ws = makeFcb({ type: 'WorldSector', values: [['Id', fv.u32(1)], ['X', fv.u32(1)], ['Y', fv.u32(0)]], kids: [
      entity('Man', [70, 10, 3], [0, 0, 0], [], [graphic(SK)]),
      entity('Smoke', [72, 10, 3], [0, 0, 0], [], [{ type: 'Components', kids: [{ type: 'CNewParticlesComponent', values: [[0x1943b130, fv.str('env.smoke')]] }] }]),
      entity('Lamp', [74, 10, 3], [0, 0, 0], [], [{ type: 'Components', kids: [{ type: 'CDynamicLightComponent' }] }]),
    ] });
    const { fat, dat } = makeFat([
      { path: 'w/t0', data: makeTerrain(0, () => 3, [0, 255, 255, 255], () => 1) },
      { path: 'w/t1', data: makeTerrain(1, () => 3, [0, 255, 255, 255], () => 1) },
      { path: 'w/ws', data: ws },
      { path: SK, data: makeXbg(MAT, { skinned: true }) },
      { path: MAT, data: makeXbm('BOXMAT', 'Generic', { DiffuseTexture1: TEX }) },
      { path: 'worlds\\tmpla\\generated\\tmpla.game.xml', data: gameXml() },
      { path: 'worlds\\tmpla\\generated\\tmpla.sectorsdep.fcb', data: makeFcb({ type: 'Deps' }) },
    ]);
    const s2 = new ViewerSession(createRegistry(allEngines), 'farcry2');
    await s2.addArchives([file(fat, 'worlds.fat'), file(dat, 'worlds.dat')]);
    const a = s2.archives[0]!;
    const m = (await s2.loadModel([a.fileOf(a.lookup('worlds/tmpla/tmpla.fc2level')!)]))!;
    const info = m.info.join('\n');
    expect(info).toMatch(/bind-позе: 1/);
    expect(info).toMatch(/частицы 1, свет 1/);
    const man = m.meshes.find((x) => x.texture === TEX)!;
    expect(man.skinned).toBe(false);
    expect(Math.min(...Array.from({ length: man.vertexCount }, (_, i) => man.pos[i * 3]!))).toBeGreaterThanOrEqual(69.9);
    const marks = m.meshes.filter((x) => x.name.startsWith('Метки'));
    expect(marks.map((x) => [x.name, x.defaultHidden])).toEqual([['Метки · частицы', true], ['Метки · свет', true]]);
    expect(m.instances!.placements.filter((p) => p.group === 'particle').map((p) => p.name)).toEqual(['env.smoke']);
  });

  it('RealTree: узлы -> ветви трубками, карточки листвы у концов ветвей; в уровне — по хешу из коллекции, материалы .mlm как .xbm', async () => {
    const BARK = 'graphics\\_materials\\test-bark.mlm', LEAF = 'graphics\\_materials\\test-leaf.mlm';
    const u = makeRealTree(BARK, LEAF);
    const t = parseRealTree(u);
    expect(t.path).toMatch(/RT_Test\.rta$/);
    expect(t.branches.map((b) => [b.pts.length, b.scale])).toEqual([[3, 1], [2, 0.5]]);
    expect(t.height).toBe(2);
    expect(t.materials).toEqual([BARK, LEAF]);
    const ms = realTreeMeshes(t, { texture: 'bark.xbt' }, { texture: 'leaf.xbt' });
    expect(ms.map((m) => [m.name, m.texture, m.indices.length / 3])).toEqual([['RealTree · ветви (приближённо)', 'bark.xbt', 4 * 2 * 3], ['RealTree · листва (приближённо)', 'leaf.xbt', 4]]);
    expect(ms[1]!.alphaTest).toBe(true);
    // в уровне: коллекция ссылается на дерево хешем пути
    const TREE = 'graphics\\vegetation\\test\\rt_test.rtr', TH = fc2Hash(TREE);
    const arr = (vals: number[], f: (b: InstanceType<typeof BinT>, v: number) => void) => { const b = new BinT().u32(vals.length); for (const v of vals) f(b, v); return b.toU8(); };
    const col = { type: 'CCollectionComponent', kids: [{ type: 0x114cfee7, kids: [{ type: 0xa18c8484, values: [
      [0x89c8c095, arr([TH], (b, v) => b.u32(v))], [0x58ad43e2, arr([1], (b, v) => b.u32(v))], [0x798c33d5, arr([1], (b, v) => b.u32(v))],
      [0xd28100c0, arr([0], (b) => b.u16(700).u16(100))], [0x8e2752ca, arr([3], (b, v) => b.f32(v))], [0x98c678bd, arr([0], (b, v) => b.u32(v))],
    ] as Array<[number, Uint8Array]> }] }] };
    const ws = makeFcb({ type: 'WorldSector', values: [['X', fv.u32(1)], ['Y', fv.u32(0)]], kids: [{ type: 'Entity', values: [['hidPos', fv.vec3(96, 32, 0)]], kids: [{ type: 'Components', kids: [col] }] }] });
    const { fat, dat } = makeFat([
      { path: 'w/t0', data: makeTerrain(0, () => 3, [0, 255, 255, 255], () => 1) },
      { path: 'w/t1', data: makeTerrain(1, () => 3, [0, 255, 255, 255], () => 1) },
      { path: 'w/ws', data: ws },
      { path: TREE, data: u },
      { path: BARK.replace('.mlm', '.xbm'), data: makeXbm('BARK', 'RealtreeTrunk', { DiffuseTexture1: 'graphics\\b_d.xbt' }) },
      { path: LEAF.replace('.mlm', '.xbm'), data: makeXbm('LEAF', 'RealtreeLeaf', { DiffuseTexture1: 'graphics\\l_d.xbt' }) },
      { path: 'worlds\\tmpla\\generated\\tmpla.game.xml', data: gameXml() },
      { path: 'worlds\\tmpla\\generated\\tmpla.sectorsdep.fcb', data: makeFcb({ type: 'Deps' }) },
    ]);
    const s2 = new ViewerSession(createRegistry(allEngines), 'farcry2');
    await s2.addArchives([file(fat, 'worlds.fat'), file(dat, 'worlds.dat')]);
    const a = s2.archives[0]!;
    const m = (await s2.loadModel([a.fileOf(a.lookup('worlds/tmpla/tmpla.fc2level')!)]))!;
    expect(m.info.join('\n')).toMatch(/RealTree \(\.rtr\): моделей 1, приближённо/);
    expect(m.meshes.filter((x) => x.name.startsWith('RealTree')).map((x) => x.texture).sort()).toEqual(['graphics\\b_d.xbt', 'graphics\\l_d.xbt']);
  });

  it('вода: уровень сектора (0x3C) — плоскость над клетками, где земля ниже; полупрозрачная', () => {
    const s = parseTerrainSector(makeTerrain(0, (x) => (x < 16 ? 1 : 10), [0, 255, 255, 255], () => 1, 5));
    expect(s.water).toBe(5);
    const w = waterMesh({ x0: 0, y0: 0, w: 1, h: 1 }, new Map([[0, s]]), 1, 1)!;
    expect(w.indices.length / 3).toBe(16 * 64 * 2); // клетки x 0…15 (угол x 16 — уже выше воды, но x 15 — ниже)
    expect(Array.from(new Set(Array.from({ length: w.vertexCount }, (_, i) => w.pos[i * 3 + 2])))).toEqual([5]);
    expect(w.vertexAlpha![0]).toBeCloseTo(0.7);
    expect(waterMesh({ x0: 0, y0: 0, w: 1, h: 1 }, new Map([[0, parseTerrainSector(makeTerrain(0, () => 1, [0, 255, 255, 255], () => 1))]]), 1, 1)).toBeNull();
  });
});
