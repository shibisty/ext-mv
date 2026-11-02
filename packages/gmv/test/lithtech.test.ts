import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { parseLtarIndex } from '../src/engines/lithtech/ltar';
import { decodeTex, parseLtMaterial } from '../src/engines/lithtech/material';
import { parseGameDb } from '../src/engines/lithtech/gamedb';
import { parseMdl, parseMesh } from '../src/engines/lithtech/model';
import { buildLtMotion, trackOrder } from '../src/engines/lithtech/anim';
import { file } from './helpers/bin';
import { makeDdsDxt1 } from './helpers/fixtures';
import { makeAnim, makeGameDb, makeLtar, makeMat, makeMdl, makeMesh, makePrefab, makeSkelMdl, makeTex, makeWldClnt, type TestSection } from './helpers/lithtech';
import { parsePrefab, parseWldClient } from '../src/engines/lithtech/world';

const quad = (x: number, material: number, floatUv = false): TestSection => ({
  pos: [[x, 0, 0], [x + 1, 0, 0], [x + 1, 1, 0], [x, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], tris: [[0, 1, 2], [0, 2, 3]], material, floatUv,
});

describe('LithTech Jupiter EX (F.E.A.R. Online)', () => {
  it('LTAR: файлы по папкам, пути в нижнем регистре', () => {
    const idx = parseLtarIndex(makeLtar({ 'Models\\A.mdl': new Uint8Array([1]), 'Models\\Sub\\b.tex': new Uint8Array([2, 3]), 'root.txt': new Uint8Array([4]) }));
    expect(idx.files.map((f) => [f.path, f.size])).toEqual([['models/a.mdl', 1], ['models/sub/b.tex', 2], ['root.txt', 1]]);
  });

  it('TEXR -> DDS, LTMI -> шейдер, текстуры и числа', () => {
    expect(decodeTex(makeTex(makeDdsDxt1(8, 4)).slice().buffer).width).toBe(8);
    const m = parseLtMaterial(makeMat('shaders\\solid\\specular.fxo', { tDiffuseMap: 'a\\d.tex', tNormalMap: 'a\\n.tex' }));
    expect(m).toEqual({ shader: 'shaders\\solid\\specular.fxo', textures: { tDiffuseMap: 'a\\d.tex', tNormalMap: 'a\\n.tex' }, values: { k_fMaxSpecularPower: 64 } });
  });

  it('GADB: материалы модели прямо в записи и через _Structures/MaterialSets', () => {
    const db = parseGameDb(makeGameDb({ mdl: 'weapons\\g36\\g36.mdl', mats: ['w\\body.mat', 'w\\sight.mat'] }, { mdl: 'char\\guy.mdl', mats: ['c\\body.mat', 'c\\head.mat'] }));
    expect(db.modelMaterials.get('weapons/g36/g36.mdl')).toEqual(['w\\body.mat', 'w\\sight.mat']);
    expect(db.modelMaterials.get('char/guy.mdl')).toEqual(['c\\body.mat', 'c\\head.mat']);
  });

  it('MODL + MESH: узлы, ближний LOD без дальнего уровня и тени, s16- и float-UV', () => {
    const mdl = parseMdl(makeMdl('W\\g.mesh', 2, 2, 3));
    expect(mdl.nodes.map((n) => [n.name, n.parent, n.pos[1]])).toEqual([['Root', -1, 0], ['Gun', 0, 10]]);
    expect(mdl.meshPath).toBe('W\\g.mesh');
    expect(mdl.lod0).toEqual([0, 1, 3]);
    expect(mdl.sectionPiece.get(3)).toBe('shadow');
    const mesh = parseMesh(makeMesh([quad(0, 0), quad(2, 1, true), quad(4, 0)]));
    expect(mesh.sections.map((s) => [s.vcount, s.tris, s.material, s.decl])).toEqual([[4, 2, 0, 0], [4, 2, 1, 1], [4, 2, 0, 0], [3, 1, 3, 2]]);
  });

  it('сессия: модель из архива, материалы из базы, текстуры .tex; тень и дальний LOD не показываются', async () => {
    const arc = makeLtar({
      'WeaponsF\\G36\\g36.mdl': makeMdl('WeaponsF\\G36\\g36.mesh', 2, 2, 3),
      'WeaponsF\\G36\\g36.mesh': makeMesh([quad(0, 0), quad(2, 1, true), quad(4, 0)]),
      'WeaponsF\\G36\\mat\\body.mat': makeMat('shaders\\solid\\specular.fxo', { tDiffuseMap: 'weaponsf\\g36\\mat\\body_d.tex', tNormalMap: 'weaponsf\\g36\\mat\\body_n.tex', tSpecularMap: 'weaponsf\\g36\\mat\\body_s.tex' }),
      'WeaponsF\\G36\\mat\\sight.mat': makeMat('shaders\\solid\\alphatest.fxo', { tDiffuseMap: 'weaponsf\\g36\\mat\\sight_d.tex' }),
      'WeaponsF\\G36\\mat\\body_d.tex': makeTex(makeDdsDxt1(4, 4)),
      'WeaponsF\\G36\\mat\\sight_d.tex': makeTex(makeDdsDxt1(8, 8)),
      'Database\\Loki.gamedb': makeGameDb({ mdl: 'weaponsf\\g36\\g36.mdl', mats: ['weaponsf\\g36\\mat\\body.mat', 'weaponsf\\g36\\mat\\sight.mat'] }, { mdl: 'x.mdl', mats: ['y.mat'] }),
    });
    const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
    await s.addArchives([file(arc, 'models_00.arch01')]);
    const a = s.archives[0]!;
    const m = (await s.loadModel([a.fileOf(a.lookup('weaponsf/g36/g36.mdl')!)]))!;
    expect(m.meshes.map((x) => [x.name, x.texture, x.matId])).toEqual([
      ['body', 'weaponsf\\g36\\mat\\body_d.tex', 0],
      ['body', 'weaponsf\\g36\\mat\\sight_d.tex', 1],
    ]);
    expect(m.meshes[0]!.normalMap).toBe('weaponsf\\g36\\mat\\body_n.tex');
    expect(m.meshes[1]!.alphaTest).toBe(true);
    expect(Array.from(m.meshes[1]!.uv.subarray(0, 4))).toEqual([0, 0, 1, 0]);
    expect(m.flipZ).toBe(true);
    expect((await s.resolveTexture(1)).image?.width).toBe(8);
    expect(m.info.join('\n')).toMatch(/Материалы из базы игры: 2/);
    // открытие .mesh напрямую — через одноимённый .mdl
    const m2 = (await s.loadModel([a.fileOf(a.lookup('weaponsf/g36/g36.mesh')!)]))!;
    expect(m2.meshes).toHaveLength(2);
  });

  it('«Папка игры»: архивы *.arch01 внутри открываются сами', async () => {
    const arc = makeLtar({ 'Models\\a.tex': makeTex(makeDdsDxt1(4, 4)) });
    const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
    const folder = s.addFolder([file(arc, 'models_00.arch01', 'FEAR/models_00.arch01'), file('x', 'readme.txt', 'FEAR/readme.txt'), file('Jehzz@gmlq', 'a3.Arch01', 'FEAR/a3.Arch01')]);
    expect(await s.openFolderArchives(folder)).toBe(1);
    expect(s.archives.map((x) => x.kind)).toEqual(['folder', 'ltar']);
  });

  it('.anim: строки треков в порядке имён узлов, сначала анимированные треки, затем постоянные', () => {
    const mdl = parseMdl(makeSkelMdl(null, true));
    expect(mdl.nodes.map((n) => [n.name, n.parent, n.pos[1]])).toEqual([['Root', -1, 0], ['Arm', 0, 10]]);
    expect(mdl.anims).toEqual([{ name: 'walk', off: 0, times: [0, 1000] }]);
    expect(trackOrder(mdl.nodes)).toEqual([1, 0]);
    const m = buildLtMotion(mdl.anims[0]!, makeAnim(), trackOrder(mdl.nodes));
    expect(m.duration).toBe(1);
    expect(m.chan.get(0)!.pos).toEqual([[0, [0, 0, 10]]]);
    expect(m.chan.get(0)!.rot).toBeNull();
    const rot = m.chan.get(1)!.rot!;
    expect(rot.map(([t]) => t)).toEqual([0, 1000]);
    expect(rot[1]![1].map((x) => +x.toFixed(3))).toEqual([0.707, 0, 0, 0.707]);
  });

  it('сессия: скелет, палитра костей из .mesh, анимации из набора рядом (.mdl без геометрии)', async () => {
    const arc = makeLtar({
      'Char\\Guy\\guy.mdl': makeSkelMdl('Char\\Guy\\guy.mesh', false),
      'Char\\Guy\\guy.mesh': makeMesh([quad(0, 0)]),
      'Char\\Guy\\Anim\\3rd\\guy_base.mdl': makeSkelMdl(null, true),
      'Char\\Guy\\Anim\\3rd\\guy_base.anim': makeAnim(),
      'Char\\AI\\Global\\Male\\Anims\\ml_shared.mdl': makeSkelMdl(null, true),
      'Char\\AI\\Global\\Male\\Anims\\ml_shared.anim': makeAnim(),
    });
    const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
    await s.addArchives([file(arc, 'chars.arch01')]);
    const a = s.archives[0]!;
    const m = (await s.loadModel([a.fileOf(a.lookup('char/guy/guy.mdl')!)]))!;
    expect(m.skeleton?.n).toBe(2);
    // в .mesh палитра секции — [1] (вторая строка = Root)
    expect(m.meshes[0]!.bone[0]).toBe(0);
    expect(m.meshes[0]!.skinned).toBe(true);
    // анимации наборов рядом читаются при выборе
    expect(s.motions.map((x) => [x.name, x.duration, !!x.load])).toEqual([['ml_shared/walk', 1, true], ['guy_base/walk', 1, true]]);
    const walk = await s.motions[1]!.load!();
    expect(walk.name).toBe('guy_base/walk');
    m.skeleton!.pose(walk, 1, false);
    // Root сдвинут на (0, 0, 10), Arm повёрнут на 90° вокруг Z
    expect(Array.from(m.skeleton!.worldV[1]!.subarray(12, 15)).map((x) => +x.toFixed(3))).toEqual([0, 10, 10]);
    expect(+m.skeleton!.worldV[1]![1]!.toFixed(3)).toBe(1);
    // открытие набора анимаций при загруженной модели добавляет его анимации
    await s.loadModel([a.fileOf(a.lookup('char/guy/anim/3rd/guy_base.mdl')!)]);
    expect(s.motions).toHaveLength(3);
  });

  it('уровень: .wldclnt (области, материалы, префабы), .inst «PRFB»', () => {
    const cl = parseWldClient(makeWldClnt('worlds\\mp\\a.global.wldmsh', ['x\\a.mat', 'x\\b.mat'], [['prefabs\\p.inst', [100, 0, 0], [0, 0, 0, 1]]]));
    expect(cl.regions).toEqual([{ mesh: 'worlds\\mp\\a.global.wldmsh', mats: ['x\\a.mat', 'x\\b.mat'] }]);
    expect(cl.instances).toEqual([{ path: 'prefabs\\p.inst', pos: [100, 0, 0], rot: [0, 0, 0, 1] }]);
    const pf = parsePrefab(makePrefab('prefabs\\p\\p.mat'));
    expect(pf.mats).toEqual(['prefabs\\p\\p.mat']);
    expect(pf.mesh.sections).toHaveLength(1);
    expect(pf.mesh.decls[0]!.map((e) => e.usage)).toEqual([0, 1, 4]);
  });

  it('сессия: уровень из папки игры — геометрия .wldmsh по материалам, префабы из архива с позой', async () => {
    const folder = [
      file(new Uint8Array([0x57, 0x4c, 0x44, 0x50, 126, 0, 0, 0]), 'm.wld', 'FEAR/Game/Worlds/MP/m.wld'),
      file(makeWldClnt('worlds\\mp\\m.global.wldmsh', ['x\\a.mat', 'x\\b.mat', 'x\\c.mat', 'engine\\shadowvolume.mat'], [
        ['prefabs\\p.inst', [100, 0, 0], [0, 0, 0, 1]],
        ['prefabs\\p.inst', [0, 0, 100], [0, Math.SQRT1_2, 0, Math.SQRT1_2]],
        ['prefabs\\missing.inst', [0, 0, 0], [0, 0, 0, 1]],
      ]), 'm.wldclnt', 'FEAR/Game/Worlds/MP/m.wldclnt'),
      file(makeMesh([quad(0, 0), quad(2, 1, true), quad(4, 0)]), 'm.global.wldmsh', 'FEAR/Game/Worlds/MP/m.global.wldmsh'),
    ];
    const arc = makeLtar({
      'Prefabs\\p.inst': makePrefab('prefabs\\p\\p.mat'),
      'Prefabs\\p\\p.mat': makeMat('shaders\\solid\\specular.fxo', { tDiffuseMap: 'prefabs\\p\\p_d.tex' }),
      'X\\a.mat': makeMat('shaders\\solid\\specular.fxo', { tDiffuseMap: 'x\\a_d.tex' }),
    });
    const ss = new ViewerSession(createRegistry(allEngines), 'fear-online');
    ss.addFolder(folder);
    await ss.addArchives([file(arc, 'prefabs_00.arch01')]);
    const f = ss.archives.find((a) => a.kind === 'folder')!;
    const m = (await ss.loadModel([f.fileOf(f.entries.find((e) => e.path.endsWith('m.wld'))!)]))!;
    expect(m.info.join('\n')).toMatch(/Префабов показано: 2 \(моделей 1\), не найдено: 1/);
    // мир: материалы a (две секции слиты) и b; тень пропущена
    expect(m.meshes.map((x) => [x.name, x.texture, x.vertexCount])).toEqual([
      ['a', 'x\\a_d.tex', 8],
      ['b', '', 4],
      ['префабы · p', 'prefabs\\p\\p_d.tex', 6],
    ]);
    const p = m.meshes[2]!.pos;
    // первый экземпляр — сдвиг на 100 по X, второй — поворот на 90° вокруг Y: (10,0,0) -> (0,0,-10) + (0,0,100)
    expect(Array.from(p.subarray(3, 6)).map((x) => +x.toFixed(3))).toEqual([110, 0, 0]);
    expect(Array.from(p.subarray(12, 15)).map((x) => +x.toFixed(3))).toEqual([0, 0, 90]);
    expect(m.instances?.placements.map((x) => x.name)).toEqual(['p', 'p']);
    expect(m.instances?.meshes).toEqual([2]);
    expect(m.flipZ).toBe(true);
  });

  it('выбор всех архивов: файл, который не читается, пропускается, остальные открываются', async () => {
    const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
    const statuses: string[] = [];
    s.on('status', (x: { text: string }) => statuses.push(x.text));
    await s.addArchives([
      file('Jehzz@gmlq', 'a3.Arch01'),
      file(makeLtar({ 'Models\\a.tex': makeTex(makeDdsDxt1(4, 4)) }), 'models_00.arch01'),
      file(new Uint8Array([0x4c, 0x54, 0x41, 0x52, 3, 0, 0, 0]), 'broken.arch01'),
      file(makeLtar({ 'Models\\b.tex': makeTex(makeDdsDxt1(4, 4)) }), 'models_01.arch01'),
    ]);
    expect(s.archives.map((a) => a.name)).toEqual(['models_00.arch01', 'models_01.arch01']);
    expect(statuses.at(-1)).toMatch(/Архивов: 2; пропущено файлов: 2 \(a3\.Arch01: .*; broken\.arch01: /);
  });

  it('пустой слот материала в базе — кусок скрыт (маска игрока без маски)', async () => {
    const arc = makeLtar({
      'Char\\P\\p.mdl': makeMdl('Char\\P\\p.mesh', 2, 2, 3),
      'Char\\P\\p.mesh': makeMesh([quad(0, 0), quad(2, 1, true), quad(4, 0)]),
      'Char\\P\\body.mat': makeMat('shaders\\solid\\specular.fxo', { tDiffuseMap: 'char\\p\\body_d.tex' }),
      'Database\\Loki.gamedb': makeGameDb({ mdl: 'char\\p\\p.mdl', mats: ['char\\p\\body.mat', ''] }, { mdl: 'x.mdl', mats: ['y.mat'] }),
    });
    const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
    await s.addArchives([file(arc, 'char_00.arch01')]);
    const a = s.archives[0]!;
    const m = (await s.loadModel([a.fileOf(a.lookup('char/p/p.mdl')!)]))!;
    expect(m.meshes.map((x) => [x.matId, !!x.defaultHidden])).toEqual([[0, false], [1, true]]);
    expect(m.info.join('\n')).toMatch(/Скрыты куски без материала в базе/);
  });

  it('уровень: секции без записи статической геометрии — подвижные объекты (WorldModel), скрыты', async () => {
    const folder = [
      file(new Uint8Array([0x57, 0x4c, 0x44, 0x50, 126, 0, 0, 0]), 'w.wld', 'FEAR/Game/Worlds/MP/w.wld'),
      file(makeWldClnt('worlds\\mp\\w.global.wldmsh', ['x\\a.mat', 'x\\b.mat', 'x\\c.mat', 'engine\\shadowvolume.mat'], [],
        [[[2, 0, 0, 3, 1, 0], 1], [[4, 0, 0, 5, 1, 0], 2]]), 'w.wldclnt', 'FEAR/Game/Worlds/MP/w.wldclnt'),
      file(makeMesh([quad(0, 0), quad(2, 1, true), quad(4, 0)]), 'w.global.wldmsh', 'FEAR/Game/Worlds/MP/w.global.wldmsh'),
    ];
    const ss = new ViewerSession(createRegistry(allEngines), 'fear-online');
    const f = ss.addFolder(folder);
    const m = (await ss.loadModel([f.fileOf(f.entries.find((e) => e.path.endsWith('w.wld'))!)]))!;
    expect(m.meshes.map((x) => [x.name, x.vertexCount, !!x.defaultHidden])).toEqual([['b', 4, false], ['a', 4, false], ['WorldModel · a', 4, true]]);
    expect(m.info.join('\n')).toMatch(/Подвижные объекты .*: 2 треугольников/);
  });
});
