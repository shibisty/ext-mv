// Arma (Real Virtuality 3/4, Enfusion-DayZ SA): PBO, PAA/PAC, бинаризованные P3D (ODOL) и config.bin.
import { hasMagic } from '../../core/binary';
import { defineEngine } from '../../core/plugin';

export const armaEngine = defineEngine({
  id: 'arma',
  title: 'Real Virtuality (Arma)',
  archives: [
    {
      id: 'pbo', title: 'PBO (Arma, DayZ)', engine: 'arma', extensions: ['pbo'],
      sniff: (head) => (head[0] === 0 && head[1] === 0x73 && head[2] === 0x72 && head[3] === 0x65 && head[4] === 0x56 ? 1 : head[0] ? 0.3 : 0),
      open: async (file) => (await import('./pbo')).openPbo(file),
    },
  ],
  codecs: [{ id: 'paa', extensions: ['paa', 'pac'], decode: async (buf) => (await import('./paa')).decodePaa(buf) }],
  formats: [
    {
      id: 'arma-p3d', title: 'Arma P3D (ODOL)', engine: 'arma', extensions: ['p3d'], status: 'beta',
      sniff: (head) => (hasMagic(head, 'ODOL') ? 1 : hasMagic(head, 'MLOD') ? 0.6 : 0),
      load: async (main, ctx) => (await import('./load')).loadP3d(main, ctx),
    },
    {
      id: 'arma-class', title: 'Arma: класс из config.bin (модель + камуфляж + снаряжение)', engine: 'arma', extensions: ['armacfg'], status: 'beta',
      load: async (main, ctx) => (await import('./load')).loadClass(main, ctx),
    },
  ],
  games: [
    {
      id: 'arma3', group: 'Игры', title: 'Arma 3', engine: 'arma', formats: ['arma-p3d', 'arma-class'], status: 'beta', ui: { archives: true, archiveExts: ['pbo'], archiveLabel: 'Открыть .pbo (можно все из addons)…' }, markers: ['arma3_x64.exe', 'arma3.exe'],
      hint: 'Откройте папку мода (@Mod/addons) через «Папку игры» или выберите .pbo. Модели .p3d — в архивах; в папке «config» каждого PBO — классы (оружие с обвесом, форма, бронежилеты, шлемы, солдаты с экипировкой) с текстурами из конфига.',
    },
    {
      id: 'arma2', group: 'Игры', title: 'Arma 2 / Operation Arrowhead / DayZ Mod', engine: 'arma', formats: ['arma-p3d', 'arma-class'], status: 'beta', ui: { archives: true, archiveExts: ['pbo'], archiveLabel: 'Открыть .pbo…' }, markers: ['arma2oa.exe', 'arma2.exe'],
      hint: 'PBO из папки AddOns; бинаризованные P3D.',
    },
  ],
});
