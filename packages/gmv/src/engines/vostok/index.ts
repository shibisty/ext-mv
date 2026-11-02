// Vostok Engine (Survarium): архивы resources.NN.db (с обновлениями), модели-папки *.model / *.skinned_model, материалы .material.
import { defineEngine, type GamePreset } from '../../core/plugin';

const ui: GamePreset['ui'] = { archives: true, archiveExts: ['db'], archiveLabel: 'Открыть resources.*.db…' };

export const vostokEngine = defineEngine({
  id: 'vostok',
  title: 'Vostok Engine (Survarium)',
  formats: [
    {
      id: 'vostok-model',
      title: 'Survarium: модель (папка *.model / *.skinned_model)',
      engine: 'vostok',
      extensions: ['model', 'skinned_model'],
      status: 'beta',
      sniff: (h) => (String.fromCharCode(...h.subarray(0, 13)) === 'VOSTOK-MODEL\n' ? 1 : 0),
      load: async (main, ctx) => (await import('./model')).loadVostokModel(main, ctx),
      afterLoad: async (ctx) => {
        const arc = ctx.main.archive;
        if (!arc || !ctx.model.loadMotions) return;
        const list = (await import('./model')).listVostokMotions(ctx.model, arc);
        if (list.length) ctx.addMotions(list, 'animations');
      },
    },
  ],
  archives: [
    {
      id: 'vostok-db',
      title: 'Survarium: архивы resources.NN.db',
      engine: 'vostok',
      extensions: ['db'],
      openFromFolder: true,
      sniff: (h) => (String.fromCharCode(...h.subarray(0, 13)) === 'little-endian' ? 1 : 0),
      open: async (file, siblings) => (await import('./db')).openVostokDb(file, siblings),
    },
  ],
  games: [
    {
      id: 'survarium',
      group: 'Игры',
      title: 'Survarium (2015)',
      engine: 'vostok',
      formats: ['vostok-model'],
      hint: 'Откройте папку game (или выберите все resources.*.db — обновления подключатся поверх) и выберите папку модели models/…/*.model или *.skinned_model.',
      ui,
      status: 'beta',
      markers: ['resources.00.db'],
    },
  ],
});
