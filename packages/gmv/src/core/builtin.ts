// Встроенный «движок» ядра: общие архивы (ZIP) и кодеки (DDS, TGA, PCX), которыми пользуются многие игры.
import { hasMagic } from './binary';
import { openZip } from './archives/zip';
import { decodeDDS } from './images/dds';
import { decodePCX } from './images/pcx';
import { decodeTGA } from './images/tga';
import { defineEngine } from './plugin';

export const coreEngine = defineEngine({
  id: 'core',
  title: 'Общие форматы',
  archives: [
    {
      id: 'zip',
      title: 'ZIP (pk3, pk4, iwd, CryEngine .pak)',
      engine: 'core',
      extensions: ['zip', 'pk3', 'pk4', 'iwd', 'pak'],
      sniff: (h) => (hasMagic(h, 'PK\x03\x04') || hasMagic(h, 'PK\x05\x06') ? 1 : 0),
      // .pak CryEngine (Far Cry, Crysis, KCD) в «Папке игры» открываются сами: читается только центральный каталог ZIP
      openFromFolder: (_h, name) => /\.pak$/i.test(name),
      open: (file) => openZip(file),
    },
  ],
  exporters: [
    {
      id: 'obj',
      title: 'OBJ + MTL (Blender, 3ds Max, любой 3D-редактор)',
      target: 'obj',
      description: 'Геометрия в bind-позе, UV, нормали и материалы с текстурами DDS — одним ZIP. Кости и анимации OBJ не хранит.',
      fields: [
        { id: 'name', label: 'Имя файла', type: 'text', default: (_m, base) => base },
        { id: 'scale', label: 'Масштаб', type: 'number', min: 0, step: 0.01, default: 1 },
      ],
      run: async (model, values, ctx) => (await import('./writers/obj')).exportObj(model, values, ctx),
    },
  ],
  codecs: [
    { id: 'dds', extensions: ['dds'], decode: (b) => decodeDDS(b) },
    { id: 'tga', extensions: ['tga'], decode: (b) => decodeTGA(b) },
    { id: 'pcx', extensions: ['pcx'], decode: (b) => decodePCX(b) },
  ],
});
