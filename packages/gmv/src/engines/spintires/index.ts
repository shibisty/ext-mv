// Spintires / MudRunner (движок Павла Загребельного): кэш мешей Media/MeshCache/* + текстуры Media/TextureCache/*.dds.
import { defineEngine } from '../../core/plugin';
import { isCombineXMesh } from './mesh';

export const spintiresEngine = defineEngine({
  id: 'spintires',
  title: 'Spintires / MudRunner',
  codecs: [{ id: 'pct', extensions: ['pct'], decode: async (buf) => (await import('./pct')).decodePct(buf) }],
  formats: [
    {
      id: 'spintires-meshcache', title: 'MudRunner / Spintires MeshCache (CombineXMesh)', engine: 'spintires', extensions: ['xmesh'], status: 'beta',
      pathPattern: /(^|\/)(meshcache|_m|prebuild\/meshes)\/[^/.]+$/,
      sniff: (head) => (isCombineXMesh(head) ? 1 : 0),
      load: async (main, ctx) => (await import('./load')).loadMeshCache(main, ctx),
      resolveTexture: async (mesh, _model, lib) => (await import('./load')).resolveSpintiresTexture(mesh, lib),
    },
    {
      id: 'spintires-truck', title: 'MudRunner: машина из classes/trucks/*.xml (кузов + колёса + навесное)', engine: 'spintires', extensions: [], status: 'beta',
      pathPattern: /(^|\/)classes\/trucks\/[^/]+\.xml$/,
      sniff: (head) => { const t = new TextDecoder('latin1').decode(head); return /<(_templates|Truck|TruckAddon)\b/.test(t) ? 0.9 : 0; },
      load: async (main, ctx) => (await import('./load')).loadTruck(main, ctx),
      resolveTexture: async (mesh, _model, lib) => (await import('./load')).resolveSpintiresTexture(mesh, lib),
    },
  ],
  games: [
    {
      id: 'snowrunner', group: 'Игры', title: 'SnowRunner / Expeditions', engine: 'spintires', formats: ['spintires-meshcache', 'spintires-truck'], status: 'beta', ui: { archives: true, archiveExts: ['pak', 'zip'], archiveLabel: 'Открыть .pak мода (+ pc.pak с текстурами)…' }, markers: ['snowrunner.exe'],
      hint: 'Откройте .pak мода (zip): меши — prebuild/meshes/*, текстуры .pct — в pc.pak (откройте оба). Полные машины по classes/trucks/*.xml.',
    },
    {
      id: 'mudrunner', group: 'Игры', title: 'MudRunner / Spintires', engine: 'spintires', formats: ['spintires-meshcache', 'spintires-truck'], status: 'beta', markers: ['mudrunner.exe', 'spintires.exe'],
      hint: 'Откройте папку мода (с Media/ или _m/, _t/) через «Папку игры»: меши — файлы без расширения в MeshCache или _m, текстуры — TextureCache, _t, colors/default.',
    },
  ],
});
