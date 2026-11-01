// CryEngine: нативно CrCh (.cgf/.cga/.skin, статика) + материалы .mtl; Far Cry 1 / Star Citizen — через Cryengine Converter (Collada, движок assimp).
import { decodeText, normPath, u32le } from '../../core/binary';
import { defineEngine } from '../../core/plugin';
import { parseCryMtl } from './mtl';

const MAGIC_CRCH = 0x68437243, MAGIC_CRYT = 0x54797243, MAGIC_IVO = 0x6f766923;

export const cryengineEngine = defineEngine({
  id: 'cryengine',
  title: 'CryEngine',
  formats: [
    {
      id: 'cry-cgf', title: 'CryEngine CGF/CGA/SKIN (CrCh)', engine: 'cryengine', extensions: ['cgf', 'cga', 'skin', 'cgam', 'skinm'], status: 'beta',
      // CryT/#ivo тоже принимаем: загрузчик объяснит, как их сконвертировать
      sniff: (h) => { const m = u32le(h, 0); return m === MAGIC_CRCH ? 1 : m === MAGIC_CRYT || m === MAGIC_IVO ? 0.7 : 0; },
      async load(main) {
        const m = (await import('./cgf')).convertCgf(await main.arrayBuffer());
        m.meta = { ...m.meta, sourcePath: main.path ?? '' };
        return m;
      },
      // .mtl CryEngine: подматериал (MatID) -> Diffuse
      async resolveTexture(mesh, model, lib) {
        if (mesh.matId === undefined) return null;
        const cands: string[] = [], mtlName = model.meta?.mtlName as string | undefined, src = model.meta?.sourcePath as string | undefined;
        if (mtlName) cands.push(normPath(mtlName).replace(/^\//, '') + '.mtl');
        if (src) cands.push(src.replace(/\.[^./]+$/, '.mtl'));
        for (const p of cands) {
          const hit = lib.findEntry(p);
          if (!hit) continue;
          const list = await lib.memo('cry:mtl:' + p, async () => parseCryMtl(decodeText(await hit[0].read(hit[1]))));
          const tex = list[mesh.matId] !== undefined ? list[mesh.matId] : list[0];
          if (!tex) continue;
          const f = lib.find(tex);
          if (f) return f;
        }
        return null;
      },
    },
  ],
  games: [
    { id: 'cryengine', group: 'Игры', title: 'CryEngine 3/5 (Crysis 2/3, Hunt, KCD…) — .cgf/.cga/.skin, статика', engine: 'cryengine', formats: ['cry-cgf'], status: 'beta',
      ui: { archives: true, archiveExts: ['pak'], archiveLabel: 'Открыть .pak (ZIP)…', zUp: true },
      hint: 'Нативно читается только контейнер CrCh с потоковой геометрией (LOD0, без скелета и трансформов узлов); материалы .mtl → текстуры DDS. Проверено лишь на синтетике.' },
    { id: 'cryengine-dae', group: 'Игры', title: 'CryEngine (Far Cry 1, Crysis, MWO, ArcheAge, Star Citizen…) — через Cryengine Converter (Collada)', engine: 'assimp', formats: ['assimp'], extensions: ['dae'], ui: { zUp: true }, status: 'bridge',
      hint: 'Распакуйте .pak (это ZIP), сконвертируйте модели: cgf-converter <файл.cgf> -objectdir <папка данных> (Collada со скелетом), затем «Папка игры…» с папкой данных (Textures/…dds подхватятся).' },
  ],
});
