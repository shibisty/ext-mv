// Enfusion (Arma Reforger): архивы .pak (FORM/PAC1), модели .xob (XOB9), материалы .emat, текстуры .edds.
import { hasMagic } from '../../core/binary';
import { defineEngine, type GamePreset } from '../../core/plugin';

const ui: GamePreset['ui'] = { archives: true, archiveExts: ['pak'], archiveLabel: 'Открыть .pak (addons/*/data*.pak)…' };

export const enfusionEngine = defineEngine({
  id: 'enfusion',
  title: 'Enfusion (Arma Reforger)',
  archives: [
    {
      id: 'enfusion-pak', title: 'Enfusion PAK (Arma Reforger)', engine: 'enfusion', extensions: ['pak'],
      openFromFolder: (head) => hasMagic(head, 'FORM') && head[8] === 0x50 && head[9] === 0x41 && head[10] === 0x43 && head[11] === 0x31,
      sniff: (h) => (hasMagic(h, 'FORM') && String.fromCharCode(h[8]!, h[9]!, h[10]!, h[11]!) === 'PAC1' ? 1 : 0),
      open: async (file) => (await import('./pak')).openEnfusionPak(file),
    },
  ],
  codecs: [{ id: 'edds', extensions: ['edds'], decode: async (buf) => (await import('./edds')).decodeEdds(buf) }],
  formats: [
    {
      id: 'enfusion-xob', title: 'Enfusion XOB (Arma Reforger)', engine: 'enfusion', extensions: ['xob'], status: 'beta',
      sniff: (h) => (hasMagic(h, 'FORM') && String.fromCharCode(h[8]!, h[9]!, h[10]!, h[11]!) === 'XOB9' ? 1 : 0),
      load: async (main, ctx) => (await import('./xob')).loadXob(main, ctx),
    },
    {
      id: 'enfusion-world', title: 'Enfusion: мир .ent (ландшафт и объекты)', engine: 'enfusion', extensions: ['ent'], status: 'beta',
      sniff: (h) => (hasMagic(h, 'EBIN') ? 1 : 0),
      load: async (main, ctx) => (await import('./world')).loadEnfusionWorld(main, ctx),
    },
    {
      id: 'enfusion-et', title: 'Enfusion: префаб .et (техника, персонажи, оружие в сборе)', engine: 'enfusion', extensions: ['et'], status: 'beta',
      // текст: «Класс [: "{GUID}родитель.et"] {»
      sniff: (h) => (/^\s*[A-Za-z_]\w*\s*(:\s*"\{[0-9A-F]{16}\}[^"]*")?\s*\{/.test(new TextDecoder().decode(h.subarray(0, 200))) ? 0.8 : 0),
      load: async (main, ctx) => (await import('./prefab')).loadPrefabModel(main, ctx),
    },
  ],
  games: [
    {
      id: 'reforger', group: 'Игры', title: 'Arma Reforger (Enfusion)', engine: 'enfusion', formats: ['enfusion-et', 'enfusion-xob', 'enfusion-world'], status: 'beta', ui,
      markers: ['ArmaReforgerSteam.exe', 'addons'],
      hint: 'Откройте «Папку игры» (Arma Reforger или её addons): архивы .pak подключатся сами. Собранные объекты — префабы Prefabs/…/*.et: техника с дверями, колёсами и крышей, персонажи с головой, формой и снаряжением, оружие с обвесом. Отдельные модели — Assets/…/*.xob (техника, оружие, персонажи, здания, растительность); материал .emat и текстуры .edds находятся по ссылкам из модели. Показан старший LOD. Миры — worlds/<мир>/<мир>.ent (Arland, Everon = Eden, Cain…): ландшафт с цветом и объекты (здания, растительность, камни) по LOD попроще; нужна «Папка игры» целиком (resourceDatabase.rdb в addons).',
    },
  ],
});
