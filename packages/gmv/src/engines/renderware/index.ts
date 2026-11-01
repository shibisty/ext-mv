// RenderWare (GTA III / Vice City / San Andreas): DFF + TXD, архивы IMG v1/v2.
import { hasMagic, u32le } from '../../core/binary';
import { defineEngine, type GamePreset } from '../../core/plugin';
// TXD разбирается синхронно, поэтому модуль подключается статически (он небольшой).
import { parseTxd } from './txd';

const ui: GamePreset['ui'] = { archives: true, archiveExts: ['img', 'dir'], archiveLabel: 'Открыть .img (+ .dir для III/VC)…', zUp: true };
const game = (id: string, title: string, hint: string, markers: string[]): GamePreset => ({ id, group: 'Игры', title, engine: 'renderware', formats: ['rw-dff'], hint, ui, status: 'beta', markers });

export const renderwareEngine = defineEngine({
  id: 'renderware',
  title: 'RenderWare',
  formats: [
    {
      id: 'rw-dff',
      title: 'RenderWare DFF',
      engine: 'renderware',
      extensions: ['dff'],
      status: 'beta',
      // первый чанк — Clump (0x10) или словарь UV-анимаций (0x2B) перед ним
      sniff: (h) => (u32le(h, 0) === 0x10 ? 1 : u32le(h, 0) === 0x2b ? 0.6 : 0.2),
      load: async (main) => (await import('./dff')).convertDff(await main.arrayBuffer()),
      // модель из архива: подгружаем одноимённый .txd рядом
      async afterLoad({ main, addTextureDictionary }) {
        if (!main.archive || !main.path) return;
        const e = main.archive.lookup(main.path.replace(/\.dff$/, '.txd'));
        if (e) await addTextureDictionary(main.archive.fileOf(e));
      },
    },
  ],
  archives: [
    {
      id: 'img',
      title: 'GTA IMG (v1 .img + .dir, v2 VER2)',
      engine: 'renderware',
      extensions: ['img'],
      companionExtensions: ['dir'],
      sniff: (h) => (hasMagic(h, 'VER2') ? 1 : 0.5),
      async open(file, siblings) {
        const base = file.name.toLowerCase().replace(/\.img$/, '');
        const dir = siblings.find((x) => x.name.toLowerCase() === base + '.dir') ?? null;
        return (await import('./img')).openImg(file, dir);
      },
    },
  ],
  dictionaries: [{ id: 'txd', extensions: ['txd'], parse: (buf) => parseTxd(buf) }],
  games: [
    game('gta3', 'Grand Theft Auto III', 'DFF + TXD из gta3.img. Для IMG v1 выберите .img и одноимённый .dir вместе. Анимации (IFP) — позже.', ['gta3.exe']),
    game('gtavc', 'Grand Theft Auto: Vice City', 'DFF + TXD из gta3.img (IMG v1: .img + .dir).', ['gta-vc.exe']),
    game('gtasa', 'Grand Theft Auto: San Andreas', 'DFF + TXD из gta3.img / player.img (IMG v2, один файл). Скин персонажей поддержан.', ['gta_sa.exe']),
  ],
});
