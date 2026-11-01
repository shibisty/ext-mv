import { describe, expect, it } from 'vitest';
import { openFolder, openZip } from '../src/index';
import { openBsa } from '../src/engines/gamebryo/bsa';
import { openPak } from '../src/engines/idtech/pak';
import { openBigf } from '../src/engines/ea/bigf';
import { openVpk, vpkPart } from '../src/engines/valve/vpk';
import { openImg } from '../src/engines/renderware/img';
import { file } from './helpers/bin';
import { makeBigf, makeBsa, makeImgV2, makePak, makeVpk } from './helpers/fixtures';
import { makeZip } from './helpers/zip';

const enc = (s: string) => new TextEncoder().encode(s);
// ZIP с двумя записями «a.txt»: makeZip принимает объект, поэтому собираем вручную склейкой имён
function makeDup(): Uint8Array {
  const z = makeZip({ 'a.txt': enc('old'), 'b.txt': enc('new') }, false);
  const s = Buffer.from(z).toString('latin1').split('b.txt').join('a.txt');
  return Uint8Array.from(Buffer.from(s, 'latin1'));
}
const text = async (p: Promise<ArrayBuffer>) => new TextDecoder().decode(await p);

describe('ZIP', () => {
  it.each([true, false])('центральный каталог и чтение (deflate=%s)', async (deflate) => {
    const a = await openZip(file(makeZip({ 'Models/Box.MD3': enc('model'), 'textures/box.tga': enc('tex'), 'dir/': enc('') }, deflate), 'pak0.pk3'));
    expect(a.entries.map((e) => e.path)).toEqual(['models/box.md3', 'textures/box.tga']);
    expect(await text(a.fileOf(a.lookup('models/box.md3')!).arrayBuffer())).toBe('model');
    expect(a.byKey.get('textures/box')?.path).toBe('textures/box.tga');
    expect(a.fileOf(a.entries[0]!).archive).toBe(a);
  });
  it('повторный путь: побеждает последняя запись', async () => {
    const a = await openZip(file(makeDup(), 'dup.zip'));
    expect(await text(a.fileOf(a.lookup('a.txt')!).arrayBuffer())).toBe('new');
  });
  it('не ZIP', async () => { await expect(openZip(file(enc('PACKxxxx'), 'x.pak'))).rejects.toThrow(/не ZIP/); });
});

describe('«Папка игры»', () => {
  it('поиск по суффиксу пути и ключи текстур', async () => {
    const a = openFolder([file('m', 'Box.mdl', 'Game/models/Box.mdl'), file('t', 'box.tga', 'Game/textures/box.tga')]);
    expect(a.name).toBe('Game');
    expect(a.lookup('models/box.mdl')?.path).toBe('game/models/box.mdl');
    expect(a.byKey.get('box')?.path).toBe('game/textures/box.tga');
    expect(a.byKey.get('textures/box')).toBeDefined();
    expect(a.byBase?.get('box.mdl')).toBeDefined();
    expect(a.fileOf(a.entries[0]!).name).toBe('Box.mdl');
    expect(await text(a.fileOf(a.entries[1]!).arrayBuffer())).toBe('t');
  });
});

describe('PAK / BIGF / VPK / IMG', () => {
  it('Quake PAK', async () => {
    const a = await openPak(file(makePak({ 'gfx/palette.lmp': new Uint8Array(768).fill(7), 'progs/Player.mdl': enc('IDPO') }), 'pak0.pak'));
    expect(a.entries.map((e) => e.path)).toEqual(['gfx/palette.lmp', 'progs/player.mdl']);
    expect((await a.read(a.entries[0]!))[100]).toBe(7);
  });
  it('EA BIGF (VIV)', async () => {
    const a = await openBigf(file(makeBigf({ 'car.fce': enc('fce!'), 'car00.tga': enc('tga') }), 'car.viv'));
    expect(a.entries.map((e) => e.path)).toEqual(['car.fce', 'car00.tga']);
    expect(await text(a.fileOf(a.entries[0]!).arrayBuffer())).toBe('fce!');
  });
  it('Valve VPK v1 (данные в *_dir.vpk)', async () => {
    const a = await openVpk(file(makeVpk({ 'models/props/box.mdl': enc('IDST'), 'materials/props/box.vmt': enc('vmt') }), 'pak01_dir.vpk'), new Map());
    expect(a.entries.map((e) => e.path).sort()).toEqual(['materials/props/box.vmt', 'models/props/box.mdl']);
    expect(await text(a.fileOf(a.lookup('materials/props/box.vmt')!).arrayBuffer())).toBe('vmt');
  });
  it('имена частей VPK', () => {
    expect(vpkPart('pak01_dir.vpk')).toEqual(['pak01', 'dir']);
    expect(vpkPart('PAK01_003.vpk')).toEqual(['pak01', '003']);
    expect(vpkPart('other.vpk')).toBeNull();
  });
  it('GTA IMG v2', async () => {
    const a = await openImg(file(makeImgV2({ 'Infernus.dff': enc('dff'), 'infernus.txd': enc('txd') }), 'gta3.img'));
    expect(a.version).toBe(2);
    expect(a.entries.map((e) => e.path)).toEqual(['infernus.dff', 'infernus.txd']);
    expect((await a.read(a.entries[0]!)).subarray(0, 3)).toEqual(enc('dff'));
  });
  it('GTA IMG v1 без .dir — понятная ошибка', async () => {
    await expect(openImg(file(new Uint8Array(16), 'gta3.img'))).rejects.toThrow(/\.dir/);
  });
});

describe('Bethesda BSA', () => {
  const files = { 'chair.nif': enc('Gamebryo File Format'), 'chair.dds': enc('DDS data') };
  it.each([[104, false], [104, true], [105, false], [105, true]] as const)('v%i, сжатие=%s', async (v, comp) => {
    const a = await openBsa(file(makeBsa(v, 'meshes\\furniture', files, comp), 'Meshes.bsa'));
    expect(a.version).toBe(v);
    expect(a.entries.map((e) => e.path)).toEqual(['meshes/furniture/chair.nif', 'meshes/furniture/chair.dds']);
    expect(await text(a.fileOf(a.entries[0]!).arrayBuffer())).toBe('Gamebryo File Format');
    expect(a.byKey.get('meshes/furniture/chair')?.path).toBe('meshes/furniture/chair.dds');
  });
  it('не BSA', async () => { await expect(openBsa(file(new Uint8Array(40), 'x.bsa'))).rejects.toThrow(/не BSA/); });
});
