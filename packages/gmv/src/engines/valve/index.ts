// Valve: GoldSrc и Source 1 (MDL), архивы VPK, текстуры VTF, материалы VMT. Source 2 — через glTF (см. движок assimp).
import { baseName, hasMagic, normPath, u32le } from '../../core/binary';
import { defineEngine } from '../../core/plugin';
import { decodeVTF } from './vtf';
import { matStem, vmtInfo, vmtKey } from './vmt';
import type { EngineMaps } from '../../core/plugin';
import type { Mesh } from '../../core/types';
import type { TextureLibrary, TextureSource } from '../../core/textures';

/** Файл текстуры по пути без расширения: .vtf или .tth+.ttz (VTMB, склеиваются в VTF). */
function textureFile(stem: string, lib: TextureLibrary): TextureSource | null {
  const t = lib.findEntry(stem + '.vtf');
  if (t) return t[0].fileOf(t[1]);
  const h = lib.findEntry(stem + '.tth');
  if (!h) return null;
  const z = lib.findEntry(stem + '.ttz');
  return { name: baseName(stem) + '.vtf', path: stem + '.vtf', arrayBuffer: async () => (await import('./tth')).tthToVtf(await h[0].read(h[1]), z ? await z[0].read(z[1]) : null) };
}

/** Текст итогового .vmt (patch -> include) по списку путей; null — не найден. */
async function vmtText(paths: readonly string[], lib: TextureLibrary): Promise<string | null> {
  for (let p of paths) {
    if (/\.vtf$/.test(p)) continue;
    for (let depth = 0; depth < 3; depth++) {
      const hit = lib.findEntry(p);
      if (!hit) break;
      const text = await lib.readText(hit), info = vmtInfo(text);
      if (info.include) { p = 'materials/' + matStem(info.include) + '.vmt'; continue; }
      return text;
    }
  }
  return null;
}

/** Текстура по списку путей .vmt: patch -> include, $basetexture -> .vtf или .tth+.ttz (VTMB). */
async function resolveVmt(paths: readonly string[], lib: TextureLibrary): Promise<TextureSource | null> {
  for (const p of paths) {
    if (/\.vtf$/.test(p)) { const t = textureFile(p.replace(/\.vtf$/, ''), lib); if (t) return t; continue; } // уже текстура (материал карты из pakfile)
    const text = await vmtText([p], lib), base = text ? vmtInfo(text).base : '';
    if (!base) continue;
    const t = textureFile('materials/' + matStem(base), lib);
    if (t) return t;
  }
  return null;
}

/** Карта нормалей материала: $bumpmap (у воды и Refract — $normalmap; у воды $bumpmap — анимированный du/dv). */
async function resolveVmtMaps(paths: readonly string[], lib: TextureLibrary): Promise<EngineMaps | null> {
  const text = await vmtText(paths, lib);
  if (!text) return null;
  const sh = vmtInfo(text).shader, nm = /^(water|refract)$/.test(sh) ? vmtKey(text, '$normalmap') : vmtKey(text, '$bumpmap');
  if (!nm || /_dudv$/i.test(nm)) return null;
  const src = textureFile('materials/' + matStem(nm), lib);
  if (!src) return null;
  const image = await lib.decode(src);
  return { normal: { image, packing: 'rgb', label: `N ${image.width}×${image.height}` } };
}

const vmtPaths = (mesh: Mesh): string[] => mesh.materialPaths?.length ? mesh.materialPaths : mesh.texture ? ['materials/' + mesh.texture + '.vmt'] : [];

export const valveEngine = defineEngine({
  id: 'valve',
  title: 'Valve GoldSrc / Source',
  formats: [
    {
      id: 'valve-mdl', title: 'Valve MDL (GoldSrc v10, Source v44–49, VTMB v2531)', engine: 'valve', extensions: ['mdl'], status: 'beta',
      sniff: (h) => {
        if (!hasMagic(h, 'IDST')) return 0;
        const v = u32le(h, 4);
        // GoldSrc *T.mdl: только текстуры (частей тела нет) — это не модель, её подхватывает основной .mdl
        if (v === 10 && h.length >= 208 && u32le(h, 204) === 0 && u32le(h, 180) > 0) return 0;
        return v === 10 || (v >= 44 && v <= 49) || v === 2531 ? 1 : 0.5;
      },
      load: async (main, ctx) => (await import('./mdl')).loadValveMdl(main, ctx),
      resolveTexture: (mesh, _model, lib) => resolveVmt(mesh.materialPaths ?? [], lib),
      resolveMaps: (mesh, _model, lib) => resolveVmtMaps(mesh.materialPaths ?? [], lib),
    },
    {
      id: 'valve-bsp', title: 'Source BSP (VTMB v17; v19–21 без проверки)', engine: 'valve', extensions: ['bsp'], status: 'beta',
      sniff: (h) => (hasMagic(h, 'VBSP') ? 1 : 0),
      load: async (main, ctx) => (await import('./bsp')).loadSourceBsp(main, ctx),
      resolveTexture: (mesh, _model, lib) => resolveVmt(vmtPaths(mesh), lib),
      resolveMaps: (mesh, _model, lib) => resolveVmtMaps(vmtPaths(mesh), lib),
    },
  ],
  archives: [
    {
      id: 'vpk', title: 'Valve VPK v1/v2', engine: 'valve', extensions: ['vpk'],
      sniff: (h, name) => (u32le(h, 0) === 0x55aa1234 ? 1 : /^pack\d{3}\.vpk$/i.test(name) ? 0 : 0.5),
      async open(file, siblings) {
        const { openVpk, vpkPart } = await import('./vpk');
        const me = vpkPart(file.name);
        if (me && me[1] !== 'dir') return null; // части подключаются через *_dir.vpk
        const parts = new Map<number, typeof file>();
        if (me) for (const x of siblings) { const q = vpkPart(x.name); if (q && q[0] === me[0] && q[1] !== 'dir') parts.set(parseInt(q[1], 10), x); }
        return openVpk(file, parts);
      },
    },
    {
      id: 'vpk-troika', title: 'VPK Troika (Vampire: The Masquerade – Bloodlines, packNNN.vpk)', engine: 'valve', extensions: ['vpk'],
      sniff: (h, name) => (u32le(h, 0) !== 0x55aa1234 && /^pack\d{3}\.vpk$/i.test(name) ? 1 : 0),
      openFromFolder: (h, name) => u32le(h, 0) !== 0x55aa1234 && /^pack\d{3}\.vpk$/i.test(name),
      async open(file) {
        if (file.size <= 9) return null; // пустые pack100/pack102
        return (await import('./vpkTroika')).openTroikaVpk(file);
      },
    },
  ],
  codecs: [{ id: 'vtf', extensions: ['vtf'], decode: (b) => decodeVTF(b) }],
  games: [
    { id: 'goldsrc', group: 'Игры', title: 'Half-Life 1 / Counter-Strike 1.6 (GoldSrc)', engine: 'valve', formats: ['valve-mdl'], ui: { zUp: true }, status: 'beta', markers: ['valve/liblist.gam'],
      hint: 'MDL с анимациями. Текстуры во внешнем *T.mdl и анимации в *01.mdl подтянутся, если открыть «Папку игры…» (папка models). Карты BSP/WAD пока нет.' },
    { id: 'source', group: 'Игры', title: 'Source: HL2, CS:S, TF2, GMod, L4D, Portal, CS:GO…', engine: 'valve', formats: ['valve-mdl'], status: 'beta', markers: ['gameinfo.txt'],
      ui: { archives: true, archiveExts: ['vpk'], archiveLabel: 'Открыть *_dir.vpk (+ части)…', zUp: true },
      hint: 'MDL + VVD + VTX (v44–49). Откройте *_dir.vpk вместе с *_000.vpk… или «Папку игры…». Материалы VMT/VTF подбираются сами. У персонажей — скелет и анимации, свои и общие из include-моделей (models/character/shared/…, ~1 500 на персонажа, кадры читаются при выборе).' },
    { id: 'vtmb', group: 'Игры', title: 'Vampire: The Masquerade – Bloodlines (Troika Source)', engine: 'valve', formats: ['valve-mdl', 'valve-bsp'], status: 'beta', markers: ['vampire/pack001.vpk'],
      ui: { archives: true, archiveExts: ['vpk'], archiveLabel: 'Открыть packNNN.vpk…', zUp: true },
      hint: 'Модели MDL v2531 (+ .dx80.vtx) и карты BSP v17 (maps/*.bsp: браши, дисплейсменты, карта освещения, реквизит). Текстуры .tth/.ttz через VMT. Откройте «Папку игры…» — папку игры целиком: Vampire/pack*.vpk и Unofficial_Patch подключатся сами. У персонажей — скелет и анимации, свои и общие из include-моделей (models/character/shared/…, ~1 500 на персонажа, кадры читаются при выборе).' },
    { id: 'source2', group: 'Игры', title: 'Source 2: Dota 2, CS2, Half-Life: Alyx — через экспорт glTF', engine: 'assimp', formats: ['assimp'], extensions: ['glb', 'gltf'], ui: { zUp: true }, status: 'bridge',
      hint: 'Нативные vmdl_c/vtex_c пока не читаются. Экспортируйте модели в glTF/GLB в Source 2 Viewer (ValveResourceFormat) и откройте здесь.' },
  ],
});
