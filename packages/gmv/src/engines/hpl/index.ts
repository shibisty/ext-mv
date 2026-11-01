// HPL (Penumbra, Amnesia): модели Collada через assimp + материалы .mat.
import { baseName } from '../../core/binary';
import { defineEngine, type GamePreset } from '../../core/plugin';
import { matDiffuse } from './mat';

const ui: GamePreset['ui'] = { zUp: true };
const game = (id: string, title: string, hint: string): GamePreset => ({ id, group: 'Игры', title, engine: 'hpl', formats: ['hpl-dae'], hint, ui, status: 'beta' });

export const hplEngine = defineEngine({
  id: 'hpl',
  title: 'HPL Engine',
  formats: [
    {
      id: 'hpl-dae', title: 'HPL Collada (.dae) + .mat', engine: 'hpl', extensions: ['dae'], status: 'beta',
      load: async (main, ctx) => (await import('../assimp/runtime')).loadWithAssimp(ctx.files, main),
    },
  ],
  materials: [
    {
      // HPL2 .mat рядом с моделью (поиск по имени материала в «Папке игры»)
      id: 'hpl-mat',
      async resolve(mesh, lib) {
        if (!mesh.material) return null;
        const base = baseName(mesh.material).toLowerCase().replace(/\.[^.]+$/, '');
        const hit = lib.findByBase(base + '.mat');
        if (!hit) return null;
        const tex = matDiffuse(await lib.readText(hit));
        return tex ? lib.find(tex) : null;
      },
    },
  ],
  games: [
    game('penumbra', 'Penumbra: Overture / Black Plague / Requiem (HPL1)', 'Модели Collada (.dae) через assimp. Выберите «Папку игры» — модели и текстуры найдутся сами.'),
    game('amnesia', 'Amnesia: The Dark Descent (HPL2)', 'Модели .dae (Collada) + материалы .mat. Скелеты и анимации — внутри .dae. Бинарный .msh пока не поддержан.'),
    game('amfp', 'Amnesia: A Machine for Pigs (HPL2)', 'Как для TDD: .dae + .mat.'),
  ],
});
