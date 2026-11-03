// Dunia Engine (Far Cry 2): архивы .fat/.dat (имена по хешу, из XML-списков ресурсов игры), модели .xbg, материалы .xbm,
// текстуры .xbt, анимации .mab (скелет — *_ref.skeleton в папке модели или выше).
import { defineEngine, type GamePreset } from '../../core/plugin';

const ui: GamePreset['ui'] = { archives: true, archiveExts: ['fat', 'dat'], archiveLabel: 'Открыть *.fat + *.dat…' };

export const duniaEngine = defineEngine({
  id: 'dunia',
  title: 'Dunia Engine (Far Cry 2)',
  codecs: [{ id: 'xbt', extensions: ['xbt'], decode: async (buf) => (await import('./xbt')).decodeXbt(buf) }],
  formats: [
    {
      id: 'dunia-xbg',
      title: 'Far Cry 2: модель .xbg',
      engine: 'dunia',
      extensions: ['xbg'],
      motionExtensions: ['mab'],
      status: 'beta',
      sniff: (h) => (String.fromCharCode(...h.subarray(0, 4)) === 'HSEM' ? 1 : 0),
      load: async (main, ctx) => (await import('./xbg')).loadXbg(main, ctx),
      afterLoad: async (ctx) => {
        const arc = ctx.main.archive;
        if (!arc || !ctx.model.loadMotions) return;
        const list = (await import('./xbg')).listMabMotions(ctx.model, arc);
        if (list.length) ctx.addMotions(list, 'animations');
      },
    },
    {
      id: 'dunia-level',
      title: 'Far Cry 2: уровень (worlds/<мир>/maps/*.fc2level — карта 1×1 км с объектами; <мир>.fc2level — весь мир)',
      engine: 'dunia',
      extensions: ['fc2level'],
      status: 'beta',
      sniff: (h) => (String.fromCharCode(...h.subarray(0, 12)) === 'DUNIA-LEVEL\n' ? 1 : 0),
      load: async (main, ctx) => {
        const text = new TextDecoder().decode(await main.arrayBuffer());
        return (await import('./level')).loadDuniaLevel(text, main, ctx);
      },
    },
  ],
  archives: [
    {
      id: 'dunia-fat',
      title: 'Far Cry 2: архивы .fat + .dat',
      engine: 'dunia',
      extensions: ['fat'],
      companionExtensions: ['dat'],
      openFromFolder: true,
      sniff: (h) => (String.fromCharCode(...h.subarray(0, 4)) === '2TAF' ? 1 : 0),
      open: async (file, siblings) => (await import('./fat')).openDuniaArchive(file, siblings),
    },
  ],
  games: [
    {
      id: 'farcry2',
      group: 'Игры',
      title: 'Far Cry 2 (2008)',
      engine: 'dunia',
      formats: ['dunia-xbg', 'dunia-level'],
      hint: 'Откройте папку игры (или Data_Win32): архивы .fat/.dat подключатся сами, имена файлов берутся из списков ресурсов игры. Модели — graphics/…/*.xbg, уровни — worlds/<мир>/maps/*.fc2level (карта 1×1 км: ландшафт и объекты) и worlds/<мир>/<мир>.fc2level (весь мир — ландшафт).',
      ui,
      status: 'beta',
      markers: ['common.fat', 'worlds.fat'],
    },
  ],
});
