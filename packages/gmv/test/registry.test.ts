import { describe, expect, it } from 'vitest';
import { createRegistry, defineEngine, Registry } from '../src/index';
import { allEngines } from '../src/engines/index';
import { file, vfile } from './helpers/bin';
import { makeMd2, makePak } from './helpers/fixtures';
import { makeZip } from './helpers/zip';

const reg = createRegistry(allEngines);
const enc = (s: string) => new TextEncoder().encode(s);
const head = (magic: string, extra: number[] = []) => new Uint8Array([...enc(magic), ...extra, ...new Array(64).fill(0)]);

describe('целостность реестра', () => {
  it('id уникальны, пресеты ссылаются на существующие форматы', () => {
    expect(new Set(reg.formats.map((f) => f.id)).size).toBe(reg.formats.length);
    expect(new Set(reg.games.map((g) => g.id)).size).toBe(reg.games.length);
    for (const g of reg.games) {
      expect(g.formats.length, g.id).toBeGreaterThan(0);
      for (const f of g.formats) expect(reg.format(f), `${g.id} -> ${f}`).toBeDefined();
      expect(reg.presetExtensions(g).length + g.formats.filter((f) => reg.format(f)?.pathPattern).length, g.id).toBeGreaterThan(0); // расширения или шаблон пути (уровни 4A, кэш MudRunner)
    }
    for (const f of reg.formats) {
      expect(f.extensions.length + (f.pathPattern ? 1 : 0), f.id).toBeGreaterThan(0); // расширение или шаблон пути
      for (const e of f.extensions) expect(e).toBe(e.toLowerCase());
    }
  });
  it('порядок пресетов как в прежнем списке', () => {
    expect(reg.games.slice(0, 3).map((g) => g.id)).toEqual(['stalker-soc', 'stalker-cs', 'stalker-cop']);
    expect(reg.games.map((g) => g.id)).toEqual(expect.arrayContaining(['fo3', 'gtasa', 'quake', 'doom3', 'source', 'source2', 'cod', 'nfs34', 'cryengine', 'assimp-auto', 'gltf']));
    expect(reg.games.at(-1)!.id).toBe('other');
  });
  it('повторный id плагина — ошибка, удаление движка', () => {
    const r = new Registry();
    const e = defineEngine({ id: 'x', title: 'X', formats: [{ id: 'f', title: 'F', engine: 'x', extensions: ['f'], load: async () => { throw new Error(); } }] });
    r.use(e);
    expect(() => r.use(defineEngine({ id: 'y', title: 'Y', formats: e.formats }))).toThrow(/уже зарегистрирован/);
    r.remove('x');
    expect(r.formats).toHaveLength(0);
  });
});

describe('автоопределение формата', () => {
  it('.mdl: Quake (IDPO) против Valve (IDST)', async () => {
    expect((await reg.detect(vfile(head('IDPO', [6, 0, 0, 0]), 'player.mdl')))!.format.id).toBe('idtech-mdl');
    expect((await reg.detect(vfile(head('IDST', [10, 0, 0, 0]), 'scientist.mdl')))!.format.id).toBe('valve-mdl');
    expect((await reg.detect(vfile(head('IDST', [48, 0, 0, 0]), 'barrel.mdl')))!.format.id).toBe('valve-mdl');
  });
  it('без расширения — по сигнатуре', async () => {
    const d = await reg.detect(file(makeMd2(), 'mystery'));
    expect(d!.format.id).toBe('idtech-md2');
    expect(d!.confidence).toBeGreaterThan(0.9);
  });
  it('сигнатура не совпала — формат исключается', async () => {
    expect(await reg.detect(file(enc('not a model at all'), 'x.fce'))).toBeNull();
    // .md2 без IDP2: собственный загрузчик исключён, остаётся мост assimp
    const d = await reg.detect(file(enc('not a model at all'), 'x.md2'));
    expect(d!.format.id).toBe('assimp');
    expect(d!.candidates.map((c) => c.format.id)).not.toContain('idtech-md2');
  });
  it('.dae: предпочтение пресета (HPL против assimp)', async () => {
    const f = vfile(enc('<?xml version="1.0"?><COLLADA>'), 'barrel.dae');
    expect((await reg.detect(f, ['hpl-dae']))!.format.id).toBe('hpl-dae');
    expect((await reg.detect(f, ['assimp']))!.format.id).toBe('assimp');
  });
  it('запись архива с одним кандидатом тоже проверяется по сигнатуре (Doom 3 .skin — не CryEngine)', async () => {
    expect(await reg.detect(vfile(enc('skin skins/elevator_door_dirty {\r\n'), 'skins.skin'))).toBeNull();
  });
  it('неизвестное расширение без сигнатуры', async () => {
    expect(await reg.detect(file(enc('hello'), 'readme.txt'))).toBeNull();
  });
});

describe('архивы и кодеки', () => {
  it('.pak: PACK (Quake) или ZIP (CryEngine)', async () => {
    expect((await reg.archiveFor(file(makePak({ a: enc('x') }), 'pak0.pak')))!.id).toBe('pak');
    expect((await reg.archiveFor(file(makeZip({ a: 'x' }), 'GameData.pak')))!.id).toBe('zip');
  });
  it('.pak с неузнанным началом — запасной вариант ZIP (как в v11)', async () => {
    expect((await reg.archiveFor(file(new Uint8Array([1, 2, 3, 4, 5]), 'odd.pak')))!.id).toBe('zip');
  });
  it('классификация файлов', () => {
    expect(reg.isArchive('gta3.dir')).toBe(true);
    expect(reg.isArchive('Meshes.BSA')).toBe(true);
    expect(reg.isImage('x.vtf')).toBe(true);
    expect(reg.isImage('x.png')).toBe(true);
    expect(reg.isImage('x.ogf')).toBe(false);
    expect(reg.dictionaryFor('infernus.txd')?.id).toBe('txd');
  });
});
