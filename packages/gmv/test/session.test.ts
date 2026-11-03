import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { file } from './helpers/bin';
import { MD5ANIM, MD5MESH, makeCastAnim, makeCastModel, makeDdsDxt1, makeDff, makeImgV2, makeMd2, makePak, makeQuakeMdl, makeTxd } from './helpers/fixtures';
import { makeZip } from './helpers/zip';

const enc = (s: string) => new TextEncoder().encode(s);
const u8 = (b: ArrayBuffer) => new Uint8Array(b);
function newSession(preset?: string) {
  const s = new ViewerSession(createRegistry(allEngines), preset);
  const log: string[] = [];
  s.on('status', (e) => log.push((e.error ? '!' : '') + e.text));
  return { s, log };
}

describe('ViewerSession', () => {
  beforeAll(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  it('пресет по умолчанию и неизвестный id', () => {
    expect(newSession().s.preset.id).toBe('stalker-soc');
    expect(newSession('nope').s.preset.id).toBe('stalker-soc');
    expect(newSession('doom3').s.preset.id).toBe('doom3');
  });

  it('модель другого формата переключает пресет', async () => {
    const { s } = newSession('stalker-soc'), presets: string[] = [];
    s.on('preset', (p) => presets.push(p.id));
    const m = await s.loadModel([file(makeMd2(), 'tris.md2')]);
    expect(m).not.toBeNull();
    expect(presets).toEqual(['quake2']);
    expect(s.motions[0]!.source).toBe('model');
  });

  it('Quake: палитра и модель из PAK, модель — из списка архива', async () => {
    const pal = new Uint8Array(768);
    pal.set([9, 8, 7], 3);
    const { s } = newSession('quake');
    await s.addFiles([file(makePak({ 'gfx/palette.lmp': pal, 'progs/ogre.mdl': u8(makeQuakeMdl()) }), 'pak0.pak')]);
    const { items, total } = s.archiveModels();
    expect(total).toBe(1);
    await s.openEntry(items[0]!);
    expect(s.model!.info.join()).toMatch(/palette\.lmp/);
    const tex = await s.resolveTexture(0);
    expect(tex.ok).toBe(true);
    expect(Array.from(tex.image!.rgba!.subarray(0, 3))).toEqual([9, 8, 7]);
  });

  it('Doom 3: pk4 — материал .mtr -> текстура, анимации из папки модели', async () => {
    const pk4 = makeZip({
      'models/test/test.md5mesh': MD5MESH,
      'models/test/idle.md5anim': MD5ANIM,
      'models/test/walk.md5anim': MD5ANIM,
      'materials/test.mtr': 'models/test/skin { diffusemap models/test/skin_d.tga }',
      'models/test/skin_d.dds': u8(makeDdsDxt1()),
    });
    const { s } = newSession('doom3');
    await s.addArchives([file(pk4, 'pak000.pk4')]);
    const items = s.archiveModels().items.filter((i) => i.entry.path.endsWith('.md5mesh'));
    await s.openEntry(items[0]!);
    expect(s.motions.map((m) => m.name).sort()).toEqual(['idle', 'walk']);
    const t = await s.resolveTexture(0);
    expect(t.label).toBe('4×4');
  });

  it('GTA SA: DFF из IMG, одноимённый TXD подхватывается', async () => {
    const img = makeImgV2({ 'infernus.dff': u8(makeDff()), 'infernus.txd': u8(makeTxd()) });
    const { s, log } = newSession('gtasa');
    await s.addArchives([file(img, 'gta3.img')]);
    await s.openEntry(s.archiveModels().items.find((i) => i.entry.path === 'infernus.dff')!);
    expect(log.some((l) => /TXD infernus\.txd: текстур 1/.test(l))).toBe(true);
    const t = await s.resolveTexture(0);
    expect([t.ok, t.label]).toEqual([true, '1×1']);
  });

  it('Cast: файл анимации через «модель» добавляется как анимация', async () => {
    const { s } = newSession('cod');
    await s.addFiles([file(makeCastModel(), 'gun.cast')]);
    await s.addFiles([file(makeCastAnim(), 'fire.cast')]);
    expect(s.motions.map((m) => [m.name, m.source])).toEqual([['fire', 'fire.cast']]);
  });

  it('ошибка загрузки сохраняет lastFailure для диагностики', async () => {
    const { s, log } = newSession('quake2');
    const bad = new Uint8Array(makeMd2());
    new DataView(bad.buffer).setInt32(4, 7, true); // версия 7 вместо 8 — сигнатура совпадает, загрузчик отказывает
    await s.loadModel([file(bad, 'broken.md2')]);
    expect(log.at(-1)).toMatch(/^!Ошибка: Не MD2/);
    expect(s.lastFailure?.format).toBe('idtech-md2');
  });

  it('ручная текстура для меша и папка с текстурами', async () => {
    const { s } = newSession('quake2');
    await s.loadModel([file(makeMd2(), 'tris.md2')]);
    expect((await s.resolveTexture(0)).label).toBe('нет файла');
    s.addTextures([file(makeDdsDxt1(8, 8), 'skin.dds', 'q2/models/test/skin.dds')]);
    expect((await s.resolveTexture(0)).label).toBe('8×8');
    expect(s.textures.find('Data\\Models\\Test\\skin.dds')?.name).toBe('skin.dds');
    s.setTextureOverride(0, file(makeDdsDxt1(16, 16), 'other.dds'));
    expect((await s.resolveTexture(0)).label).toBe('16×16');
  });

  it('«Папка игры»: Source-модель без .vvd — понятная ошибка', async () => {
    const { s, log } = newSession('source');
    const mdl = new Uint8Array(408);
    mdl.set(enc('IDST'));
    new DataView(mdl.buffer).setInt32(4, 48, true);
    s.addFolder([file(mdl, 'barrel.mdl', 'hl2/models/barrel.mdl')]);
    await s.openEntry(s.archiveModels().items[0]!);
    expect(log.at(-1)).toMatch(/barrel\.vvd/);
  });

  it('большая «Папка игры»: индекс кусками с прогрессом, результат как у синхронного; загрузка модели — с прогрессом', async () => {
    const { s } = newSession('quake2'), prog: Array<string | null> = [];
    s.on('progress', (p) => prog.push(p ? `${p.text}|${p.done ?? ''}/${p.total ?? ''}` : null));
    const files = Array.from({ length: 12001 }, (_, i) => file(new Uint8Array(4), `f${i}.txt`, `game/d${i % 7}/f${i}.txt`));
    files.push(file(makeMd2(), 'tris.md2', 'game/models/tris.md2'));
    const a = await s.addFolderAsync(files);
    expect(a.entries.length).toBe(12002);
    expect(a.lookup('models/tris.md2')).not.toBeNull();
    const steps = prog.filter((p) => p?.includes('/12002'));
    expect(steps.length).toBeGreaterThanOrEqual(3); // 0, 5000, 10000, 12002
    expect(steps.at(-1)).toMatch(/12002\/12002$/);
    expect(prog.at(-1)).toBeNull();
    prog.length = 0;
    await s.openEntry(s.archiveModels().items[0]!);
    expect(s.model).not.toBeNull();
    expect(prog[0]).toMatch(/tris\.md2/);
    expect(prog.at(-1)).toBeNull();
  });

  it('модель + анимация чужой игры в одном броске: анимация не теряется', async () => {
    const { s } = newSession('skyrimse');
    await s.addFiles([file(MD5MESH, 'guy.md5mesh'), file(MD5ANIM, 'run.md5anim')]);
    expect(s.preset.id).toBe('doom3');
    expect(s.motions.map((m) => m.name)).toEqual(['run']);
  });

  it('assimp-файл переключает на пресет, принимающий это расширение', async () => {
    const { s } = newSession('stalker-soc');
    const p = s.registry.presetForFormat('assimp', 'box.fbx');
    expect(p!.id).toBe('assimp-auto');
    expect(s.registry.presetForFormat('assimp', 'm.glb')!.id).toBe('source2');
  });

  it('текстура из папки модели: skin.* рядом (Quake II rerelease md5)', async () => {
    const { s } = newSession('doom3');
    const pk = makeZip({ 'models/ammo/x/md5/tris.md5mesh': MD5MESH.replace('models/test/skin', 'am_x'), 'models/ammo/x/md5/skin.dds': u8(makeDdsDxt1()), 'models/ammo/x/md5/skin_glow.dds': u8(makeDdsDxt1(8, 8)) });
    await s.addArchives([file(pk, 'pak0.pk4')]);
    await s.openEntry(s.archiveModels().items.find((i) => i.entry.path.endsWith('.md5mesh'))!);
    expect((await s.resolveTexture(0)).label).toBe('4×4');
  });
});
