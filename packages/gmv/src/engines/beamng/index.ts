// BeamNG.drive: машина собирается из .pc (конфигурация) + .jbeam (детали и слоты) + .dae (меши flexbody) + *.materials.json.
import { defineEngine } from '../../core/plugin';

export const beamngEngine = defineEngine({
  id: 'beamng',
  title: 'BeamNG (Torque3D)',
  formats: [
    {
      id: 'beamng-pc', title: 'BeamNG: конфигурация машины (.pc)', engine: 'beamng', extensions: ['pc'], status: 'beta',
      sniff: (head) => {
        const t = new TextDecoder().decode(head);
        return /^\s*\{/.test(t) && /"(parts|mainPartName|format|model)"\s*:/.test(t) ? 1 : 0;
      },
      load: async (main, ctx) => (await import('./vehicle')).loadVehicle(main, ctx),
    },
  ],
  materials: [
    {
      id: 'beamng-materials',
      async resolve(mesh, lib) {
        if (!mesh.material) return null;
        const { collectMaterials } = await import('./vehicle');
        const mats = await lib.memo('beamng-materials', () => collectMaterials(lib.archives));
        const t = mats.get(mesh.material.toLowerCase());
        return t?.color ? lib.find(t.color) : null;
      },
    },
  ],
  games: [
    {
      id: 'beamng', group: 'Игры', title: 'BeamNG.drive', engine: 'beamng', formats: ['beamng-pc'], status: 'beta', ui: { zUp: true, archives: true, archiveExts: ['zip'], archiveLabel: 'Открыть мод (.zip)…' }, markers: ['beamng.drive.exe'],
      hint: 'Откройте мод (.zip) или папку vehicles/<машина> через «Папку игры» и выберите конфигурацию .pc. Детали, которых нет в моде (общие из игры), подтянутся, если открыт и content/vehicles игры.',
    },
  ],
});
