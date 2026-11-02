// LithTech Jupiter EX (F.E.A.R. Online): архивы LTAR (.arch00/.arch01), модели .mdl + .mesh, уровни .wld + .wldclnt + .wldmsh, префабы .inst, текстуры .tex, материалы .mat,
// база игры .gamedb (материалы моделей).
import { defineEngine, type GamePreset } from '../../core/plugin';

const ui: GamePreset['ui'] = { archives: true, archiveExts: ['arch01', 'arch00'], archiveLabel: 'Открыть архивы *.arch01…' };

export const lithtechEngine = defineEngine({
  id: 'lithtech',
  title: 'LithTech Jupiter EX',
  formats: [
    {
      id: 'lithtech-mdl',
      title: 'LithTech: модель (.mdl + .mesh, F.E.A.R. Online)',
      engine: 'lithtech',
      extensions: ['mdl', 'mesh'],
      motionExtensions: ['mdl'],
      status: 'beta',
      sniff: (h) => (h[0] === 0x4d && h[1] === 0x4f && h[2] === 0x44 && h[3] === 0x4c ? (h[4] === 42 ? 1 : 0.8) : h[0] === 0x4d && h[1] === 0x45 && h[2] === 0x53 && h[3] === 0x48 && h[4] === 1 && h[5] === 0 ? 0.9 : 0),
      load: async (main, ctx) => (await import('./load')).loadLithtechModel(main, ctx),
    },
    {
      id: 'lithtech-world',
      title: 'LithTech: уровень (.wld + .wldclnt + .wldmsh, F.E.A.R. Online)',
      engine: 'lithtech',
      extensions: ['wld'],
      status: 'beta',
      sniff: (h) => (h[0] === 0x57 && h[1] === 0x4c && h[2] === 0x44 && (h[3] === 0x50 || h[3] === 0x43) ? 1 : 0),
      load: async (main, ctx) => (await import('./world')).loadLithtechWorld(main, ctx),
    },
  ],
  archives: [
    {
      id: 'lithtech-ltar',
      title: 'LithTech: архив LTAR (.arch00, .arch01)',
      engine: 'lithtech',
      extensions: ['arch01', 'arch00'],
      openFromFolder: true,
      sniff: (h) => (h[0] === 0x4c && h[1] === 0x54 && h[2] === 0x41 && h[3] === 0x52 && h[4] === 3 ? 1 : 0),
      open: async (file) => (await import('./ltar')).openLtar(file),
    },
  ],
  codecs: [{ id: 'lithtech-tex', extensions: ['tex'], decode: async (buf) => (await import('./material')).decodeTex(buf) }],
  games: [
    {
      id: 'fear-online',
      group: 'Игры',
      title: 'F.E.A.R. Online (2014)',
      engine: 'lithtech',
      formats: ['lithtech-mdl', 'lithtech-world'],
      hint: 'Откройте папку игры (архивы *.arch01 и папка Game с базой Game/database/Loki.gamedb подключатся сами) и выберите модель .mdl: оружие weaponsf/…, персонажи charf/… и char/…, предметы models/…. Уровни: Game/worlds/…/<карта>.wld (геометрия и префабы). Анимации подключаются сами: свои, наборы из папки модели и её anim/ (у игроков — Game/charf/…/anim), общие наборы ИИ char/ai/global/…; читаются при выборе; другой набор — кнопкой «+ .mdl».',
      ui,
      status: 'beta',
      markers: ['engine.exe', 'models_00.arch01'],
    },
  ],
});
