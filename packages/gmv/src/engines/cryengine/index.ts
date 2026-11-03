// CryEngine: нативно CryEngine 1 («CryTek» 0x744 — Far Cry: модели, персонажи со скелетом, .caf/.cal, .cga) и CrCh
// (.cgf/.cga/.skin, статика) + материалы .mtl; Star Citizen и прочее — через Cryengine Converter (Collada, движок assimp).
import { decodeText, normPath, u32le } from '../../core/binary';
import { defineEngine } from '../../core/plugin';
import { parseCryMtl } from './mtl';

const MAGIC_CRCH = 0x68437243, MAGIC_CRYT = 0x54797243, MAGIC_IVO = 0x6f766923;

export const cryengineEngine = defineEngine({
  id: 'cryengine',
  title: 'CryEngine',
  formats: [
    {
      id: 'cry1-level', title: 'Far Cry: уровень (.cry редактора + level.pak)', engine: 'cryengine', extensions: ['cry'], status: 'beta',
      sniff: (h) => (h[0] === 0x50 && h[1] === 0x4b ? 1 : 0),
      load: async (main, ctx) => (await import('./fc1level')).loadFc1Level(main, ctx),
    },
    {
      id: 'cry-cgf', title: 'CryEngine CGF/CGA/SKIN (CryTek — Far Cry, CrCh — CryEngine 3+)', engine: 'cryengine', extensions: ['cgf', 'cga', 'skin', 'cgam', 'skinm'], status: 'beta',
      motionExtensions: ['caf'],
      // CryTek (Far Cry) — нативно; #ivo тоже принимаем: загрузчик объяснит, как сконвертировать
      sniff: (h) => { const m = u32le(h, 0); return m === MAGIC_CRCH || m === MAGIC_CRYT ? 1 : m === MAGIC_IVO ? 0.7 : 0; },
      async load(main) {
        const buf = await main.arrayBuffer();
        if (u32le(new Uint8Array(buf, 0, 4), 0) === MAGIC_CRYT) {
          const { cry1Model, parseCry1, readCaf } = await import('./cry1');
          const m = cry1Model(buf, main.name), bones = m.meta?.cry1Bones as import('./cry1').Cry1Bone[] | undefined;
          m.meta = { ...m.meta, sourcePath: main.path ?? '' };
          if (bones) m.loadMotions = async (f) => [readCaf(parseCry1(await f.arrayBuffer()), bones, f.name.replace(/\.caf$/i, ''))];
          return m;
        }
        const m = (await import('./cgf')).convertCgf(buf);
        m.meta = { ...m.meta, sourcePath: main.path ?? '' };
        return m;
      },
      // персонажи Far Cry: анимации из .cal рядом с моделью (пути — от Objects/Characters/Animations), данные — при выборе
      async afterLoad(ctx) {
        const arc = ctx.main.archive, path = ctx.main.path ?? '', model = ctx.model;
        if (!arc || !model.loadMotions || !model.meta?.cry1Bones) return;
        const cal = arc.lookup(path.replace(/(_lod\d+)?\.[^./]+$/i, '.cal')) ?? arc.lookup(path.replace(/\.[^./]+$/, '.cal'));
        if (!cal) return;
        const { parseCal } = await import('./cry1');
        const list = parseCal(decodeText(await arc.read(cal))), root = path.replace(/objects\/.*$/i, '') + 'objects/characters/animations/';
        const seen = new Set<string>(), motions: import('../../core/types').NodeMotion[] = [];
        for (const { name, path: rel } of list) {
          const e = arc.lookup(normPath(root + rel)) ?? arc.lookup(normPath('objects/characters/animations/' + rel));
          if (!e || seen.has(name)) continue;
          seen.add(name);
          motions.push({ kind: 'node', name, tps: 1, chan: new Map(), duration: 0, load: async () => ({ ...(await model.loadMotions!(arc.fileOf(e)))[0]!, name }) } as import('../../core/types').NodeMotion);
        }
        if (motions.length) ctx.addMotions(motions, cal.path.split('/').pop()!);
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
    { id: 'farcry', group: 'Игры', title: 'Far Cry (CryEngine 1) — .cgf, .cga, персонажи и анимации', engine: 'cryengine', formats: ['cry-cgf', 'cry1-level'], status: 'beta', markers: ['FCData', 'Bin32/FarCry.exe'],
      ui: { archives: true, archiveExts: ['pak'], archiveLabel: 'Открыть .pak…', zUp: true, motionLabel: '+ .caf' },
      hint: 'Откройте «Папку игры» (FarCry) — архивы FCData/*.pak подключатся сами. Модели .cgf/.cga из Objects.pak, текстуры из Textures*.pak; у персонажей анимации из .cal рядом с моделью (сотни, читаются при выборе). Уровни — Levels/<уровень>/<уровень>.cry: ландшафт с цветом из level.pak, вода, объекты, сущности с моделями и растительность.' },
    { id: 'cryengine', group: 'Игры', title: 'CryEngine 3/5 (Crysis 2/3, Hunt, KCD…) — .cgf/.cga/.skin, статика', engine: 'cryengine', formats: ['cry-cgf'], status: 'beta',
      ui: { archives: true, archiveExts: ['pak'], archiveLabel: 'Открыть .pak (ZIP)…', zUp: true },
      hint: 'Нативно читается только контейнер CrCh с потоковой геометрией (LOD0, без скелета и трансформов узлов); материалы .mtl → текстуры DDS. Проверено лишь на синтетике.' },
    { id: 'cryengine-dae', group: 'Игры', title: 'CryEngine (Far Cry 1, Crysis, MWO, ArcheAge, Star Citizen…) — через Cryengine Converter (Collada)', engine: 'assimp', formats: ['assimp'], extensions: ['dae'], ui: { zUp: true }, status: 'bridge',
      hint: 'Распакуйте .pak (это ZIP), сконвертируйте модели: cgf-converter <файл.cgf> -objectdir <папка данных> (Collada со скелетом), затем «Папка игры…» с папкой данных (Textures/…dds подхватятся).' },
  ],
});
