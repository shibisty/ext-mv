// Gamebryo / Bethesda: NIF 20.2.0.7 + архивы BSA (Fallout 3/NV, Skyrim LE/SE).
import { ascii, hasMagic } from '../../core/binary';
import { defineEngine, type GamePreset, type LoadContext } from '../../core/plugin';

const ui: GamePreset['ui'] = { archives: true, archiveExts: ['bsa'], archiveLabel: 'Открыть .bsa…', zUp: true, motionLabel: '+ .kf' };

/** Известные скелеты персонажей (броня и одежда лежат отдельно от них). */
const KNOWN_SKELETONS = ['meshes/characters/_male/skeleton.nif', 'meshes/actors/character/character assets/skeleton.nif'];

/** skeleton.nif для скинованной модели: рядом, выше по папкам, затем известные пути персонажей. */
async function findSkeleton(path: string, ctx: LoadContext): Promise<{ skeleton: ArrayBuffer; skeletonName: string } | null> {
  const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  const near = await ctx.sibling('skeleton.nif');
  if (near) return { skeleton: near, skeletonName: 'skeleton.nif' };
  const parts = path.toLowerCase().replace(/\\/g, '/').split('/').slice(0, -1), tried = new Set<string>();
  for (let k = parts.length - 1; k >= 1; k--) tried.add([...parts.slice(0, k), 'skeleton.nif'].join('/'));
  for (const p of [...tried, ...KNOWN_SKELETONS]) {
    const u = await ctx.readPath(p).catch(() => null);
    if (u) return { skeleton: ab(u), skeletonName: p };
  }
  return null;
}
const game = (id: string, title: string, hint: string, markers: string[]): GamePreset => ({ id, group: 'Игры', title, engine: 'gamebryo', formats: ['gamebryo-nif'], hint, ui, status: 'stable', markers });

export const gamebryoEngine = defineEngine({
  id: 'gamebryo',
  title: 'Gamebryo (Bethesda)',
  formats: [
    {
      id: 'gamebryo-nif',
      title: 'NetImmerse/Gamebryo NIF',
      engine: 'gamebryo',
      extensions: ['nif'],
      motionExtensions: ['kf'],
      status: 'stable',
      sniff: (h) => (/^(Gamebryo|NetImmerse)/.test(ascii(h, 0, Math.min(h.length, 20))) ? 1 : 0),
      load: async (main, ctx) => {
        const { convertNif, hasSkin } = await import('./nif'), buf = await main.arrayBuffer();
        const skel = hasSkin(buf) && !/^skeleton/i.test(main.name) ? await findSkeleton(main.path ?? '', ctx) : null;
        return convertNif(buf, skel ?? {});
      },
    },
  ],
  archives: [
    {
      id: 'bsa',
      title: 'Bethesda BSA (v103–105)',
      engine: 'gamebryo',
      extensions: ['bsa'],
      sniff: (h) => (hasMagic(h, 'BSA\0') ? 1 : 0),
      open: async (file) => (await import('./bsa')).openBsa(file),
    },
  ],
  games: [
    game('fo3', 'Fallout 3', 'NIF 20.2.0.7. Откройте Meshes/Textures .bsa и выберите модель из списка (или загрузите .nif и текстуры файлами). Персонажи и существа — со скелетом (skeleton.nif) и анимациями .kf.', ['fallout3.esm']),
    game('fnv', 'Fallout: New Vegas', 'NIF 20.2.0.7. Архивы .bsa (zlib). Скининг по skeleton.nif, анимации .kf (characters/_male/locomotion/mtidle.kf и др.).', ['falloutnv.esm']),
    game('skyrim', 'The Elder Scrolls V: Skyrim (LE)', 'NIF 20.2.0.7, BSA v104. Скининг и анимации .kf (Havok .hkx не поддержан).', ['skyrim.esm']),
    game('skyrimse', 'The Elder Scrolls V: Skyrim Special Edition', 'BSTriShape, BSA v105 (LZ4). Скинованные меши SSE пока не показываются.', ['skyrim.esm', 'skyrimse.exe']),
  ],
});
