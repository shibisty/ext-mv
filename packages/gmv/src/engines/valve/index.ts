// Valve: GoldSrc и Source 1 (MDL), архивы VPK, текстуры VTF, материалы VMT. Source 2 — через glTF (см. движок assimp).
import { hasMagic, normPath, u32le } from '../../core/binary';
import { defineEngine } from '../../core/plugin';
import { decodeVTF } from './vtf';
import { vmtBase } from './vmt';

export const valveEngine = defineEngine({
  id: 'valve',
  title: 'Valve GoldSrc / Source',
  formats: [
    {
      id: 'valve-mdl', title: 'Valve MDL (GoldSrc v10, Source v44–49)', engine: 'valve', extensions: ['mdl'], status: 'beta',
      sniff: (h) => {
        if (!hasMagic(h, 'IDST')) return 0;
        const v = u32le(h, 4);
        // GoldSrc *T.mdl: только текстуры (частей тела нет) — это не модель, её подхватывает основной .mdl
        if (v === 10 && h.length >= 208 && u32le(h, 204) === 0 && u32le(h, 180) > 0) return 0;
        return v === 10 || (v >= 44 && v <= 49) ? 1 : 0.5;
      },
      load: async (main, ctx) => (await import('./mdl')).loadValveMdl(main, ctx),
      async resolveTexture(mesh, _model, lib) {
        for (const p of mesh.materialPaths ?? []) {
          const hit = lib.findEntry(p);
          if (!hit) continue;
          const tex = vmtBase(await lib.readText(hit));
          if (!tex) continue;
          const t = lib.findEntry('materials/' + normPath(tex).replace(/^\//, '') + '.vtf');
          if (t) return t[0].fileOf(t[1]);
        }
        return null;
      },
    },
  ],
  archives: [
    {
      id: 'vpk', title: 'Valve VPK v1/v2', engine: 'valve', extensions: ['vpk'],
      sniff: (h) => (u32le(h, 0) === 0x55aa1234 ? 1 : 0.5),
      async open(file, siblings) {
        const { openVpk, vpkPart } = await import('./vpk');
        const me = vpkPart(file.name);
        if (me && me[1] !== 'dir') return null; // части подключаются через *_dir.vpk
        const parts = new Map<number, typeof file>();
        if (me) for (const x of siblings) { const q = vpkPart(x.name); if (q && q[0] === me[0] && q[1] !== 'dir') parts.set(parseInt(q[1], 10), x); }
        return openVpk(file, parts);
      },
    },
  ],
  codecs: [{ id: 'vtf', extensions: ['vtf'], decode: (b) => decodeVTF(b) }],
  games: [
    { id: 'goldsrc', group: 'Игры', title: 'Half-Life 1 / Counter-Strike 1.6 (GoldSrc)', engine: 'valve', formats: ['valve-mdl'], ui: { zUp: true }, status: 'beta', markers: ['valve/liblist.gam'],
      hint: 'MDL с анимациями. Текстуры во внешнем *T.mdl и анимации в *01.mdl подтянутся, если открыть «Папку игры…» (папка models). Карты BSP/WAD пока нет.' },
    { id: 'source', group: 'Игры', title: 'Source: HL2, CS:S, TF2, GMod, L4D, Portal, CS:GO…', engine: 'valve', formats: ['valve-mdl'], status: 'beta', markers: ['gameinfo.txt'],
      ui: { archives: true, archiveExts: ['vpk'], archiveLabel: 'Открыть *_dir.vpk (+ части)…', zUp: true },
      hint: 'MDL + VVD + VTX (v44–49). Откройте *_dir.vpk вместе с *_000.vpk… или «Папку игры…». Материалы VMT/VTF подбираются сами. Пока без скелета и анимаций.' },
    { id: 'source2', group: 'Игры', title: 'Source 2: Dota 2, CS2, Half-Life: Alyx — через экспорт glTF', engine: 'assimp', formats: ['assimp'], extensions: ['glb', 'gltf'], ui: { zUp: true }, status: 'bridge',
      hint: 'Нативные vmdl_c/vtex_c пока не читаются. Экспортируйте модели в glTF/GLB в Source 2 Viewer (ValveResourceFormat) и откройте здесь.' },
  ],
});
