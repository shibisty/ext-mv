// Electronic Arts: Need for Speed III / High Stakes (FCE) и контейнеры BIGF (VIV/BIG).
import { hasMagic, u32le } from '../../core/binary';
import { defineEngine } from '../../core/plugin';
import { FCE_MAGIC } from './magic';

/** Город (L5RA.BUN) и номерные секции потоковой загрузки (STREAML5RA_5407.BUN); файлы с хешем в имени — библиотеки. */
const TRACK_RE = /(^|\/)tracks\/(stream[a-z]\d[a-z]{2}_\d+|[a-z]\d[a-z]{2})\.bun$/i, TRACK_NAME_RE = /^(stream[a-z]\d[a-z]{2}_\d+|[a-z]\d[a-z]{2})\.bun$/i;

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
    {
      id: 'nfsw-track', title: 'NFS World: трасса (TRACKS/L5RA.BUN — город целиком, STREAML5RA_<N>.BUN — секция)', engine: 'ea', extensions: ['bun'], status: 'beta',
      pathPattern: TRACK_RE,
      sniff: (_h, name) => (TRACK_NAME_RE.test(name) ? 1 : 0),
      load: async (main, ctx) => (await import('./nfstrack')).loadNfsTrack(main, ctx),
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
    { id: 'nfsworld', group: 'Игры', title: 'Need for Speed: World (Black Box) — машины и город', engine: 'ea', formats: ['nfsw-car', 'nfsw-track'], extensions: [], status: 'beta', markers: ['nfsw.exe', 'CARS'],
      ui: { zUp: true },
      hint: 'Откройте «Папку игры» (папку с nfsw.exe). Машины: CARS/<машина>/GEOMETRY.bin — текстуры из TEXTURES.BIN рядом, CARS/TEXTURES.BIN и GLOBAL; показан LOD A: кузов и стоковый обвес, колёса и тормозные диски расставлены по аркам кузова, остальные детали тюнинга — в списке мешей. Панель «Вид модели»: цвет окраски, винил (CARS/VINYLS, на бока или капот) и колёса с дисками из библиотек CARS/WHEELS*; номер — фон «мирового» номера; LOD B–E — в списке мешей. Город: TRACKS/L5RA.BUN — весь город (около минуты, бюджет 7 млн треугольников), TRACKS/STREAML5RA_<N>.BUN — одна секция; общие объекты и текстуры берутся из файлов STREAML5RA_0x*.BUN.' },
  ],
});
