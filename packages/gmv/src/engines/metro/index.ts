// 4A Engine (Metro 2033): архивы content.vfi + *.vfs, уровни (геометрия + объекты level.bin), модели, текстуры.
import { defineEngine, type GamePreset } from '../../core/plugin';

const ui: GamePreset['ui'] = { archives: true, archiveExts: ['vfi', 'vfs0', 'vfs1'], archiveLabel: 'Открыть content.vfi + .vfs…' };

export const metroEngine = defineEngine({
  id: 'metro',
  title: '4A Engine (Metro)',
  formats: [
    {
      id: 'metro-level',
      title: '4A: уровень (maps/<уровень>/level + level.geom_pc)',
      engine: 'metro',
      extensions: [],
      pathPattern: /(^|\/)maps\/[^/]+\/level$/,
      status: 'beta',
      // чанк 1 (4 байта) — версия 16 у Metro 2033 (у X-Ray там u16 14 + u16 качество)
      sniff: (h) => (h[0] === 1 && h[4] === 4 && h[8] === 16 && h[9] === 0 && h[10] === 0 ? 1 : 0),
      load: async (main, ctx) => (await import('./level')).loadMetroLevel(main, ctx),
      resolveTexture: async (mesh, _model, lib) => (await import('./level')).resolveMetroTexture(mesh.texture, lib),
    },
    {
      id: 'metro-model',
      title: '4A: модель (.model, .mesh + .skeleton)',
      engine: 'metro',
      extensions: ['model', 'mesh'],
      status: 'beta',
      // первый чанк — 0x01 заголовок (64 байта) или 0x09 меши
      sniff: (h) => ((h[0] === 1 && h[4] === 64 && h[1] === 0 && h[5] === 0) || (h[0] === 9 && h[1] === 0 && h[2] === 0 && h[3] === 0) ? 1 : 0),
      load: async (main, ctx) => (await import('./model')).loadMetroModel(main, ctx),
      resolveTexture: async (mesh, _model, lib) => (await import('./level')).resolveMetroTexture(mesh.texture, lib),
    },
  ],
  archives: [
    {
      id: 'metro-vfi',
      title: '4A: индекс .vfi + данные .vfs (Metro 2033)',
      engine: 'metro',
      extensions: ['vfi'],
      companionExtensions: ['vfs0', 'vfs1', 'vfs2'],
      // первый чанк — заголовок с id −1 и длиной 20
      sniff: (h) => (h[0] === 0xff && h[1] === 0xff && h[2] === 0xff && h[3] === 0xff && h[4] === 20 ? 1 : 0),
      open: async (file, siblings) => (await import('./vfs')).openVfi(file, siblings),
    },
  ],
  games: [
    { id: 'metro2033', group: 'Игры', title: 'Metro 2033 (2010)', engine: 'metro', formats: ['metro-level', 'metro-model'], hint: 'Выберите content.vfi вместе с content.vfs0 и textures.vfs0/1 (или папку игры) и откройте maps/<уровень>/level (геометрия и объекты уровня) или meshes/…/*.model.', ui, status: 'beta', markers: ['metro2033.exe', 'content.vfi'] },
  ],
});
