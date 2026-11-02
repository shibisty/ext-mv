// Загрузка модели F.E.A.R. Online: .mdl -> .mesh, материалы из базы игры (Game/database/Loki.gamedb) -> текстуры .tex.
import { normPath } from '../../core/binary';
import type { LoadContext } from '../../core/plugin';
import { MotionOnlyError, type Archive, type Mesh, type Model, type Motion, type VFile } from '../../core/types';
import { parseGameDb, type GameDb } from './gamedb';
import { parseLtMaterial, type LtMaterial } from './material';
import { NodeSkeleton } from '../../core/skeleton';
import { skinnedBounds } from '../../core/geometry';
import { buildLtMotion, ltSkeletonNodes, trackOrder, trackOrderFor } from './anim';
import { buildModel, parseMdl, parseMesh, pickLod, type LtMdl } from './model';

const dbCache = new WeakMap<Archive, Promise<GameDb | null>>();

/** База игры из открытых архивов/папок: database/loki.gamedb (или самая большая .gamedb в папке database). */
export async function findGameDb(archives: readonly Archive[]): Promise<GameDb | null> {
  for (const a of archives) {
    let p = dbCache.get(a);
    if (!p) {
      const cands = a.entries.filter((e) => /(^|\/)database\/[^/]+\.gamedb$/.test(e.path));
      cands.sort((x, y) => Number(/loki\.gamedb$/.test(y.path)) - Number(/loki\.gamedb$/.test(x.path)) || (y.size ?? 0) - (x.size ?? 0));
      const e = cands[0];
      p = e ? a.read(e).then((u) => { try { return parseGameDb(u); } catch (err) { console.warn(err); return null; } }) : Promise.resolve(null);
      dbCache.set(a, p);
    }
    const db = await p;
    if (db) return db;
  }
  return null;
}

/** Материалы модели по пути .mdl в базе (путь внутри папки игры может начинаться с «…/game/»). */
export function materialsFor(db: GameDb | null, mdlPath: string): string[] | null {
  if (!db) return null;
  const parts = normPath(mdlPath).split('/');
  for (let i = 0; i < parts.length; i++) {
    const hit = db.modelMaterials.get(parts.slice(i).join('/'));
    if (hit) return hit;
  }
  return null;
}

export async function readAny(ctx: LoadContext, path: string, main: VFile): Promise<Uint8Array | null> {
  const p = normPath(path);
  const direct = await ctx.readPath(p);
  if (direct) return direct;
  // папка игры: файлы лежат под «…/game/»; архив модели — рядом
  const prefix = main.path ? main.path.slice(0, Math.max(0, main.path.lastIndexOf('/game/') + 6)) : '';
  if (prefix) { const r = await ctx.readPath(prefix + p); if (r) return r; }
  const sib = await ctx.sibling(p.split('/').pop()!);
  return sib ? new Uint8Array(sib) : null;
}

export async function loadLithtechModel(main: VFile, ctx: LoadContext): Promise<Model> {
  let u: Uint8Array = new Uint8Array(await main.arrayBuffer());
  let mdlFile = main.path ?? main.name;
  // открыт .mesh — ищем одноимённый .mdl (LOD, палитры костей)
  if (String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) === 'MESH') {
    const mp = (main.path ?? main.name).replace(/\.mesh$/i, '.mdl');
    const mu = await readAny(ctx, mp, main);
    if (mu) { mdlFile = mp; const meshU = u; u = mu; return finish(parseMdl(u), meshU, mdlFile, main, ctx); }
    return finish(null, u, main.path ?? main.name, main, ctx);
  }
  const mdl = parseMdl(u);
  if (!mdl.meshPath) throw new MotionOnlyError('В .mdl нет геометрии — это набор анимаций (откройте модель персонажа или оружия)');
  const meshU = await readAny(ctx, mdl.meshPath, main);
  if (!meshU) throw new Error(`Не найдена геометрия ${mdl.meshPath} — откройте архивы игры (*.arch01) или папку Game`);
  return finish(mdl, meshU, mdlFile, main, ctx);
}

async function finish(mdl: LtMdl | null, meshU: Uint8Array, mdlPath: string, main: VFile, ctx: LoadContext): Promise<Model> {
  const mesh = parseMesh(meshU);
  const info = [
    `LithTech Jupiter EX (F.E.A.R. Online): ${mdl ? 'MODL v42' : 'MESH без .mdl'}`,
    `Секций в .mesh: ${mesh.sections.length}${mdl ? `, секции LOD: ${pickLod(mdl, mesh).join(', ')}` : ''}`,
  ];
  if (mdl) info.push(`Узлов: ${mdl.nodes.length}${mdl.pieces.length ? `, куски: ${mdl.pieces.join(', ')}` : ''}`);
  const model = buildModel(mdl, mesh, info);
  if (mdl && mdl.nodes.length > 1) await addSkeleton(model, mdl, mdlPath, main, ctx);
  const db = await findGameDb(ctx.archives);
  let mats = materialsFor(db, mdlPath);
  if (mats) {
    info.push(`Материалы из базы игры: ${mats.filter(Boolean).length}`);
    // пустой слот в базе — деталь, которой у этого варианта нет (маска игрока «Mask_LOD» без маски): скрыта, включается в слоях
    const empty = model.meshes.filter((m) => (m.matId ?? 0) < mats!.length && !mats![m.matId ?? 0]);
    for (const m of empty) m.defaultHidden = true;
    if (empty.length) info.push(`Скрыты куски без материала в базе: ${[...new Set(empty.map((m) => m.name))].join(', ')}`);
  } else {
    mats = await folderMaterials(ctx.archives, mdlPath, Math.max(...model.meshes.map((m) => (m.matId ?? 0) + 1)));
    info.push(db ? 'Модели нет в базе игры — материалы подобраны по папке' : 'База игры (Game/database/Loki.gamedb) не открыта — материалы подобраны по папке');
  }
  const missing = await applyMaterials(model.meshes, (m) => mats?.[m.matId ?? 0], main, ctx);
  if (missing.length) info.push(`Не найдены материалы: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
  return model;
}

/** Материалы .mat -> текстуры мешей (диффузная, нормали, блик); возвращает пути ненайденных .mat. */
export async function applyMaterials(meshes: readonly Mesh[], pathOf: (m: Mesh) => string | undefined, main: VFile, ctx: LoadContext): Promise<string[]> {
  const cache = new Map<string, Promise<LtMaterial | null>>();
  const mat = (p: string) => {
    let r = cache.get(p);
    if (!r) { r = readAny(ctx, p, main).then((b) => { try { return b ? parseLtMaterial(b) : null; } catch { return null; } }); cache.set(p, r); }
    return r;
  };
  const missing = new Set<string>();
  for (const m of meshes) {
    const path = pathOf(m);
    if (!path) continue;
    m.material = path;
    const lm = await mat(path);
    if (!lm) { missing.add(path); continue; }
    m.shader = lm.shader;
    const t = lm.textures;
    m.texture = t.tDiffuseMap ?? t.tDiffuse ?? t.tBaseMap ?? Object.values(t)[0] ?? '';
    if (t.tNormalMap) m.normalMap = t.tNormalMap;
    if (t.tSpecularMap) m.surface = { specular: { map: t.tSpecularMap, channel: 1 }, source: 'LithTech .mat' };
    if (/alpha|cutout|clip|foliage|decal/i.test(lm.shader)) m.alphaTest = true;
  }
  return [...missing];
}

/** Без базы: .mat из папки модели и её подпапок materials/mat, по алфавиту — если их ровно столько, сколько материалов у модели. */
async function folderMaterials(archives: readonly Archive[], mdlPath: string, need: number): Promise<string[] | null> {
  const dir = normPath(mdlPath).replace(/[^/]*$/, '');
  for (const a of archives) {
    const list = a.entries.map((e) => e.path).filter((p) => p.startsWith(dir) && /\.mat$/.test(p) && !/(_drop|blood_|camo_)/.test(p) && p.slice(dir.length).split('/').length <= 2);
    if (list.length === need) return list.sort();
  }
  return null;
}

/** Анимации набора (.mdl + .anim) для модели с узлами nodes. */
async function motionsFrom(set: LtMdl, setPath: string, nodes: LtMdl['nodes'], own: boolean, main: VFile, ctx: LoadContext): Promise<{ list: Motion[]; bad: number } | null> {
  const ad = await readAny(ctx, setPath.replace(/\.mdl$/i, '.anim'), main);
  if (!ad || String.fromCharCode(ad[0]!, ad[1]!, ad[2]!, ad[3]!) !== 'ANIM') return null;
  const order = own ? trackOrder(nodes) : trackOrderFor(set.nodes, nodes).order;
  const list: Motion[] = [];
  let bad = 0;
  for (const rec of set.anims) {
    try { list.push(buildLtMotion(rec, ad, order)); } catch { bad++; }
  }
  return { list, bad };
}

const setCache = new WeakMap<Archive, Map<string, LtMdl | null>>();
/** Разобранный .mdl набора (кэш по архиву: общие наборы читаются при каждой загрузке модели). */
async function readSet(a: Archive, e: Archive['entries'][number]): Promise<LtMdl | null> {
  let m = setCache.get(a);
  if (!m) setCache.set(a, (m = new Map()));
  if (!m.has(e.path)) {
    let set: LtMdl | null = null;
    try { set = parseMdl(await a.read(e)); if (set.meshPath || !set.anims.length) set = null; } catch { set = null; }
    m.set(e.path, set);
  }
  return m.get(e.path)!;
}

/** Общие наборы анимаций персонажей ИИ (char/ai/global/male|female/anims): к модели их привязывает база игры по хешам. */
const SHARED_SETS = /^char\/ai\/global\/[^/]+\/anims?\/[^/]+\.mdl$/;

/**
 * Наборы анимаций к модели: .mdl без геометрии в той же папке и в подпапках anim/ и anims/ (на любой глубине:
 * у игроков — anim/1st, anim/3rd…), у персонажей — ещё общие наборы char/ai/global/…; берутся наборы, почти все узлы
 * которых есть у модели.
 */
async function nearbySets(mdlPath: string, mdl: LtMdl, ctx: LoadContext): Promise<Array<{ path: string; set: LtMdl }>> {
  const dir = normPath(mdlPath).replace(/[^/]*$/, ''), self = normPath(mdlPath), out: Array<{ path: string; set: LtMdl }> = [];
  const isChar = /(^|\/)charf?\//.test(dir), seen = new Set<string>();
  for (const a of ctx.archives) {
    for (const e of a.entries) {
      if (!e.path.endsWith('.mdl') || e.path === self || seen.has(e.path)) continue;
      const near = e.path.startsWith(dir) && (() => { const rest = e.path.slice(dir.length); return !rest.includes('/') || /^anims?\//.test(rest); })();
      if (!near && !(isChar && SHARED_SETS.test(e.path))) continue;
      seen.add(e.path);
      const set = await readSet(a, e);
      if (!set || !ctx.archives.some((x) => x.lookup(e.path.replace(/\.mdl$/, '.anim')))) continue;
      const { matched } = trackOrderFor(set.nodes, mdl.nodes);
      if (matched < set.nodes.length * 0.9 || matched < mdl.nodes.length * 0.5) continue;
      out.push({ path: e.path, set });
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

/** Анимации набора без чтения .anim: данные читаются при выборе (у игроков — тысячи анимаций). */
function lazyMotions(set: LtMdl, setPath: string, nodes: LtMdl['nodes'], main: VFile, ctx: LoadContext): Motion[] {
  const order = trackOrderFor(set.nodes, nodes).order, label = setPath.split('/').pop()!.replace(/\.mdl$/i, '');
  let ad: Promise<Uint8Array> | null = null;
  const data = () => (ad ??= readAny(ctx, setPath.replace(/\.mdl$/i, '.anim'), main).then((u) => {
    if (!u || String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'ANIM') throw new Error(`Не найден ${setPath.replace(/\.mdl$/i, '.anim')}`);
    return u;
  }));
  return set.anims.map((rec) => {
    const name = `${label}/${rec.name}`;
    return { kind: 'node', name, tps: 1000, chan: new Map(), duration: (rec.times[rec.times.length - 1] ?? 0) / 1000, frames: rec.times.length, source: label,
      load: async () => ({ ...buildLtMotion(rec, await data(), order), name, source: label }) } as Motion;
  });
}

/** Скелет из узлов .mdl, анимации из одноимённого .anim и наборов анимаций рядом. */
async function addSkeleton(model: Model, mdl: LtMdl, mdlPath: string, main: VFile, ctx: LoadContext): Promise<void> {
  const sk = new NodeSkeleton(ltSkeletonNodes(mdl.nodes));
  model.skeleton = sk;
  for (const m of model.meshes) m.skinned = true;
  model.bounds = skinnedBounds(sk, model.meshes);
  model.loadMotions = async (file) => {
    const set = parseMdl(new Uint8Array(await file.arrayBuffer()));
    if (!set.anims.length) throw new Error('В .mdl нет анимаций');
    const { matched } = trackOrderFor(set.nodes, mdl.nodes);
    if (!matched) throw new Error('Узлы набора анимаций не совпадают с узлами модели');
    const r = await motionsFrom(set, file.path ?? file.name, mdl.nodes, false, file, ctx);
    if (!r) throw new Error(`Не найден ${(file.path ?? file.name).replace(/\.mdl$/i, '.anim')}`);
    return r.list;
  };
  let bad = 0;
  if (mdl.anims.length) {
    const r = await motionsFrom(mdl, mdlPath, mdl.nodes, true, main, ctx);
    if (r) { model.motions.push(...r.list); bad += r.bad; } else model.info.push(`Анимаций в .mdl: ${mdl.anims.length}, но .anim не найден`);
  }
  const sets: string[] = [];
  for (const { path, set } of await nearbySets(mdlPath, mdl, ctx)) {
    model.motions.push(...lazyMotions(set, path, mdl.nodes, main, ctx));
    sets.push(path.split('/').pop()!);
  }
  const shown = sets.length > 6 ? `${sets.slice(0, 6).join(', ')} и ещё ${sets.length - 6}` : sets.join(', ');
  if (model.motions.length) model.info.push(`Анимаций: ${model.motions.length}${sets.length ? ` (наборов рядом: ${sets.length} — ${shown}; читаются при выборе)` : ''}${bad ? `, не прочитано ${bad}` : ''}`);
}
