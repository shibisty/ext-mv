// Electronic Arts: Need for Speed III / High Stakes (FCE) и контейнеры BIGF (VIV/BIG).
import { hasMagic, u32le } from '../../core/binary';
import { defineEngine } from '../../core/plugin';
import { FCE_MAGIC } from './magic';

export const eaEngine = defineEngine({
  id: 'ea',
  title: 'Electronic Arts (NFS3/HS)',
  formats: [
    {
      id: 'ea-fce', title: 'NFS FCE3/FCE4', engine: 'ea', extensions: ['fce'], status: 'beta',
      sniff: (h) => (FCE_MAGIC[u32le(h, 0)] ? 1 : 0),
      load: async (main) => (await import('./fce')).convertFce(await main.arrayBuffer()),
    },
  ],
  archives: [
    {
      id: 'bigf', title: 'EA BIGF (VIV/BIG)', engine: 'ea', extensions: ['viv', 'big'],
      sniff: (h) => (hasMagic(h, 'BIGF') || hasMagic(h, 'BIG4') ? 1 : 0),
      open: async (file) => (await import('./bigf')).openBigf(file),
    },
  ],
  games: [
    { id: 'nfs34', group: 'Игры', title: 'Need for Speed III: Hot Pursuit / NFS: High Stakes — автомобили (FCE)', engine: 'ea', formats: ['ea-fce'], status: 'beta',
      ui: { archives: true, archiveExts: ['viv', 'big'], archiveLabel: 'Открыть car.viv…' },
      hint: 'Откройте car.viv (контейнер BIGF) — внутри car.fce и car00.tga. Показывается LOD0. Остальные игры EA (NFS Underground/MW/Carbon, FIFA, Frostbite) пока не читаются.' },
  ],
});
