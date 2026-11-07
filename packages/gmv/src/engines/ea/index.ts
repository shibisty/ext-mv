// Electronic Arts: Need for Speed III / High Stakes (FCE) и контейнеры BIGF (VIV/BIG).
import { hasMagic, u32le } from '../../core/binary';
import { defineEngine } from '../../core/plugin';
import { FCE_MAGIC } from './magic';

export const eaEngine = defineEngine({
  id: 'ea',
  title: 'Electronic Arts (NFS3/HS, NFS World)',
  formats: [
    {
      id: 'ea-fce', title: 'NFS FCE3/FCE4', engine: 'ea', extensions: ['fce'], status: 'beta',
      sniff: (h) => (FCE_MAGIC[u32le(h, 0)] ? 1 : 0),
      load: async (main) => (await import('./fce')).convertFce(await main.arrayBuffer()),
    },
    {
      id: 'nfsw-car', title: 'NFS World: машина (CARS/<машина>/GEOMETRY.bin)', engine: 'ea', extensions: ['bin'], status: 'beta',
      pathPattern: /(^|\/)geometry\.bin$/,
      // чанк 0x80134000 (геометрия Black Box) в начале файла
      sniff: (h) => (u32le(h, 0) === 0x80134000 ? 1 : 0),
      load: async (main, ctx) => (await import('./nfsgeom')).loadNfsCar(main, ctx),
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
      hint: 'Откройте car.viv (контейнер BIGF) — внутри car.fce и car00.tga. Показывается LOD0. NFS World — отдельный пункт; NFS Underground/MW/Carbon, FIFA и Frostbite пока не читаются.' },
    { id: 'nfsworld', group: 'Игры', title: 'Need for Speed: World (Black Box) — машины', engine: 'ea', formats: ['nfsw-car'], extensions: [], status: 'beta', markers: ['nfsw.exe', 'CARS'],
      ui: { zUp: true },
      hint: 'Откройте «Папку игры» (папку с nfsw.exe) и выберите CARS/<машина>/GEOMETRY.bin — текстуры возьмутся из TEXTURES.BIN рядом и общего CARS/TEXTURES.BIN. Показан LOD A: кузов и стоковый обвес, остальные детали тюнинга — в списке мешей. Окраска кузова и номер создаются игрой на лету — они показаны цветом. Трассы пока не читаются.' },
  ],
});
