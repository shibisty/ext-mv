// id Tech 1–4: Quake (MDL), Quake II (MD2), Quake III (MD3), Doom 3 / Quake 4 (MD5). Архивы PAK и ZIP (pk3/pk4).
import { ascii, decodeText, hasMagic } from '../../core/binary';
import { defineEngine, type GamePreset } from '../../core/plugin';
import { loadSameDirMotions } from '../../core/session';
import { parseMtr } from './mtr';
import { TextureLibrary } from '../../core/textures';

const arch = (ext: string): GamePreset['ui'] => ({ archives: true, archiveExts: [ext], archiveLabel: `Открыть .${ext}…`, zUp: true });
const md5ui: GamePreset['ui'] = { ...arch('pk4'), motionLabel: '+ .md5anim' };

export const idtechEngine = defineEngine({
  id: 'idtech',
  normalY: 'gl',
  title: 'id Tech 1–4',
  formats: [
    {
      id: 'idtech-mdl', title: 'Quake MDL', engine: 'idtech', extensions: ['mdl'], status: 'beta',
      sniff: (h) => (hasMagic(h, 'IDPO') ? 1 : 0),
      async load(main, ctx) {
        const { loadMdl } = await import('./models');
        return loadMdl(await main.arrayBuffer(), await ctx.readPath('gfx/palette.lmp'));
      },
    },
    {
      id: 'idtech-md2', title: 'Quake II MD2', engine: 'idtech', extensions: ['md2'], status: 'beta',
      sniff: (h) => (hasMagic(h, 'IDP2') ? 1 : 0),
      load: async (main) => (await import('./models')).loadMd2(await main.arrayBuffer()),
    },
    {
      id: 'idtech-md3', title: 'Quake III MD3', engine: 'idtech', extensions: ['md3'], status: 'beta',
      sniff: (h) => (hasMagic(h, 'IDP3') ? 1 : 0),
      load: async (main) => (await import('./models')).loadMd3(await main.arrayBuffer()),
    },
    {
      id: 'idtech-md5', title: 'Doom 3 MD5mesh', engine: 'idtech', extensions: ['md5mesh'], motionExtensions: ['md5anim'], status: 'beta',
      sniff: (h) => (/MD5Version/.test(ascii(h, 0, Math.min(h.length, 64))) ? 1 : 0.2),
      load: async (main) => (await import('./models')).loadMd5(decodeText(await main.arrayBuffer())),
      async afterLoad(ctx) { await loadSameDirMotions(ctx, 'md5anim'); },
    },
  ],
  materials: [
    {
      // материалы .mtr (Doom 3 / Quake 4): имя шейдера -> diffusemap; работает и для .lwo/.ase через assimp
      id: 'idtech-mtr',
      async resolve(mesh, lib) {
        if (!mesh.texture) return null;
        const map = await lib.memo('idtech:mtr', async () => {
          const m = new Map<string, string>();
          for (const a of lib.archives)
            for (const e of a.entries)
              if (e.path.endsWith('.mtr')) { try { parseMtr(decodeText(await a.read(e)), m); } catch { /* пропуск */ } }
          return m;
        });
        if (!map.size) return null;
        for (const n of TextureLibrary.candidates(mesh.texture))
          for (const c of [map.get(n), n + '_d']) { if (!c) continue; const f = lib.find(c); if (f) return f; }
        return null;
      },
    },
  ],
  archives: [
    {
      id: 'pak', title: 'Quake PAK', engine: 'idtech', extensions: ['pak'],
      sniff: (h) => (hasMagic(h, 'PACK') ? 1 : 0),
      open: async (file) => (await import('./pak')).openPak(file),
    },
  ],
  games: [
    { id: 'quake', group: 'Игры', title: 'Quake (id Tech 2) — MDL', engine: 'idtech', formats: ['idtech-mdl'], ui: arch('pak'), status: 'beta', markers: ['id1/pak0.pak'],
      hint: 'Откройте pak0.pak: палитра (gfx/palette.lmp) берётся оттуда. Скин встроен в MDL.' },
    { id: 'quake2', group: 'Игры', title: 'Quake II — MD2', engine: 'idtech', formats: ['idtech-md2'], ui: arch('pak'), status: 'beta', markers: ['baseq2/pak0.pak'],
      hint: 'Модели из pak0.pak, скины PCX ищутся в архиве. Анимации — по группам кадров.' },
    { id: 'quake3', group: 'Игры', title: 'Quake III Arena — MD3', engine: 'idtech', formats: ['idtech-md3'], ui: arch('pk3'), status: 'beta', markers: ['baseq3/pak0.pk3'],
      hint: 'pk3 = ZIP. Текстуры TGA/JPG по имени шейдера; .shader-скрипты пока не разбираются.' },
    { id: 'doom3', group: 'Игры', title: 'Doom 3 — MD5 (id Tech 4)', engine: 'idtech', formats: ['idtech-md5'], ui: md5ui, status: 'beta', markers: ['base/pak000.pk4'],
      hint: 'pk4 = ZIP. Текстуры берутся из материалов .mtr, анимации .md5anim — из папки модели.' },
    { id: 'quake4', group: 'Игры', title: 'Quake 4 — MD5 (id Tech 4)', engine: 'idtech', formats: ['idtech-md5'], ui: md5ui, status: 'beta', markers: ['q4base/pak001.pk4'],
      hint: 'Тот же формат MD5, что в Doom 3.' },
  ],
});
