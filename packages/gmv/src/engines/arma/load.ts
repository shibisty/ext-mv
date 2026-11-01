// Загрузка Arma: отдельный P3D (+ текстуры из конфига, если класс найден) и «класс конфига»:
// оружие с обвесом из LinkedItems, форма/бронежилет/шлем с камуфляжем, солдат с экипировкой из linkedItems.
import { decodeText } from '../../core/binary';
import { boundsOf, sumTris, sumVerts } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { Mesh, Model, VFile } from '../../core/types';
import { get, hiddenTextures, mergedConfig, modelPath, str, strs, sub, texPath } from './cfg';
import { armaInfo, lodMeshes, odolToModel, pickLod, proceduralColor } from './model';
import { lodKind, parseOdol, type OdolModel } from './odol';
import type { RapClass } from './rap';

async function readModel(ctx: LoadContext, path: string): Promise<OdolModel | null> {
  const u8 = await ctx.readPath(path);
  return u8 ? parseOdol(u8) : null;
}

/** Применить текстуры скрытых выделений к мешам. */
function applyHidden(meshes: Mesh[], tex: Map<string, string>): number {
  let n = 0;
  for (const m of meshes) {
    const a = armaInfo(m);
    if (!a) continue;
    const hit = a.selections.map((s) => tex.get(s.toLowerCase())).find((t) => t !== undefined);
    if (!hit) continue;
    const col = proceduralColor(hit);
    if (col) { m.texture = ''; m.color = col; }
    else { m.texture = texPath(hit); m.color = undefined; }
    n++;
  }
  return n;
}

/** Классы, ссылающиеся на модель (CfgVehicles.model, CfgWeapons.model, ItemInfo.uniformModel). */
function classesForModel(root: RapClass, path: string): RapClass[] {
  const out: RapClass[] = [];
  for (const cfg of ['cfgvehicles', 'cfgweapons'])
    for (const c of root.classes.get(cfg)?.classes.values() ?? []) {
      const m = modelPath(str(get(c, 'model', root)));
      const um = modelPath(str(sub(c, 'iteminfo', root)?.values.get('uniformmodel')));
      if ((m === path || um === path) && c.values.has('hiddenselectionstextures')) out.push(c);
    }
  return out;
}

export async function loadP3d(main: VFile, ctx: LoadContext): Promise<Model> {
  const o = parseOdol(new Uint8Array(await main.arrayBuffer()));
  const { model } = odolToModel(o, main.name);
  if (main.path && ctx.archives.some((a) => a.kind === 'pbo')) {
    const root = await mergedConfig(ctx.archives), cls = classesForModel(root, main.path);
    if (cls.length) {
      applyHidden(model.meshes, hiddenTextures(cls[0]!, root));
      model.info.push(`Текстуры из класса ${cls[0]!.name}${cls.length > 1 ? ` (вариантов: ${cls.length}; остальные — в папке config/ архивов)` : ''}`);
    }
  }
  return model;
}

interface Part { title: string; path: string; tex: Map<string, string>; matrix?: Float32Array; from?: string }

/** Детали класса: основная модель + надетое снаряжение / обвес. */
function partsOf(root: RapClass, cfgName: string, clsName: string, info: string[]): Part[] {
  const cfgs = { v: root.classes.get('cfgvehicles'), w: root.classes.get('cfgweapons') };
  const C = (cfgName === 'cfgvehicles' ? cfgs.v : cfgs.w)?.classes.get(clsName.toLowerCase());
  if (!C) throw new Error(`Класс ${clsName} не найден в ${cfgName}`);
  const parts: Part[] = [];
  const wearable = (w: RapClass, tag: string) => {
    const ii = sub(w, 'iteminfo', root), um = str(ii?.values.get('uniformmodel') ?? (ii ? get(ii, 'uniformmodel', root) : undefined));
    if (ii && str(get(ii, 'uniformclass', root))) {
      const u = cfgs.v?.classes.get(str(get(ii, 'uniformclass', root)).toLowerCase());
      if (u) { parts.push({ title: `${tag}${u.name}`, path: modelPath(str(get(u, 'model', root))), tex: hiddenTextures(u, root), from: u.name }); return true; }
      info.push(`Форма ${w.name}: класс ${str(get(ii, 'uniformclass', root))} не найден (из игры?)`);
      return false;
    }
    if (um && !/empty/i.test(um)) { parts.push({ title: `${tag}${w.name}`, path: modelPath(um), tex: hiddenTextures(w, root), from: w.name }); return true; }
    return false;
  };
  if (cfgName === 'cfgvehicles') {
    parts.push({ title: C.name, path: modelPath(str(get(C, 'model', root))), tex: hiddenTextures(C, root), from: C.name });
    // снаряжение: жилет, шлем, ПНВ, очки
    for (const it of strs(get(C, 'linkeditems', root))) {
      const w = cfgs.w?.classes.get(it.toLowerCase());
      if (!w) { if (!/^item(map|compass|watch|radio|gps)$/i.test(it)) info.push(`Нет класса снаряжения ${it} (из игры?)`); continue; }
      wearable(w, '');
    }
    return parts;
  }
  if (wearable(C, '')) return parts;
  // оружие / предмет
  parts.push({ title: C.name, path: modelPath(str(get(C, 'model', root))), tex: hiddenTextures(C, root), from: C.name });
  const linked = sub(C, 'linkeditems', root), slots = sub(C, 'weaponslotsinfo', root);
  const proxyOf = (slot: string) => (slots && slot ? str(get(sub(slots, slot, root) ?? slots, 'linkproxy', root)) : '');
  const used = new Set<string>();
  const attach = (slot: string, item: string, how: string) => {
    const w = cfgs.w?.classes.get(item.toLowerCase());
    if (!w) { info.push(`Обвес ${item} (${slot}): класс не найден (из игры или другого мода)`); return; }
    used.add(slot.toLowerCase());
    parts.push({ title: `${slot}: ${w.name}${how}`, path: modelPath(str(get(w, 'model', root))), tex: hiddenTextures(w, root), from: w.name, proxy: proxyOf(slot) } as Part & { proxy?: string });
  };
  // обвес «из коробки» (LinkedItems)
  if (linked) for (const li of linked.classes.values()) attach(str(get(li, 'slot', root)), str(get(li, 'item', root)), '');
  // остальные слоты: первый совместимый предмет из открытых модов (compatibleItems — массив или класс «item = 1»)
  if (slots) {
    const free: string[] = [];
    for (const sl of slots.classes.values()) {
      if (used.has(sl.name.toLowerCase()) || !str(get(sl, 'linkproxy', root))) continue;
      const ci = get(sl, 'compatibleitems', root), ciClass = sub(sl, 'compatibleitems', root);
      const items = [...strs(ci), ...(ciClass ? [...ciClass.values.keys()].filter((k) => ciClass.values.get(k) === 1) : [])];
      const avail = items.find((it) => cfgs.w?.classes.has(it.toLowerCase()));
      if (avail) attach(sl.name, avail, ' (совместимый)');
      else free.push(sl.name);
    }
    if (free.length) info.push(`Слоты без обвеса: ${free.join(', ')} — откройте вместе PBO мода с прицелами/глушителями, и совместимые предметы встанут сами`);
  }
  return parts;
}

export async function loadClass(main: VFile, ctx: LoadContext): Promise<Model> {
  const ref = JSON.parse(decodeText(await main.arrayBuffer())) as { cfg: string; cls: string; kind: string };
  const root = await mergedConfig(ctx.archives), info: string[] = [];
  const parts = partsOf(root, ref.cfg, ref.cls, info) as Array<Part & { proxy?: string }>;
  const meshes: Mesh[] = [];
  let base: { o: OdolModel; li: number } | null = null, loaded = 0, skeleton = '';
  for (const p of parts) {
    if (!p.path) { info.push(`${p.title}: модель не задана`); continue; }
    let o: OdolModel | null;
    try { o = await readModel(ctx, p.path); } catch (e) { info.push(`${p.title}: ${(e as Error).message}`); continue; }
    if (!o) { info.push(`${p.title}: нет файла ${p.path} (модель из игры или другого мода)`); continue; }
    const li = pickLod(o), lod = o.lod(li);
    let matrix: Float32Array | undefined;
    if (p.proxy && base) {
      const want = modelPath(p.proxy).replace(/\.p3d$/, '');
      const bl = base.o.lod(base.li);
      const px = bl.proxies.find((x) => modelPath(x.model).replace(/\.p3d$/, '') === want) ?? bl.proxies.find((x) => modelPath(x.model).split('/').pop()!.replace(/\.p3d$/, '') === want.split('/').pop());
      if (px) { matrix = px.matrix.slice(); const c = base.o.boundingCenter; matrix[9] += c[0]!; matrix[10] += c[1]!; matrix[11] += c[2]!; }
      else info.push(`${p.title}: в модели нет прокси ${p.proxy}`);
    }
    const ms = lodMeshes(lod, parts.length > 1 ? `${p.from ?? p.title} · ` : '', matrix, o.boundingCenter);
    applyHidden(ms, p.tex);
    meshes.push(...ms);
    loaded++;
    if (!base) base = { o, li };
    if (o.skeleton && !skeleton) skeleton = o.skeleton.name;
  }
  if (!meshes.length) throw new Error(`Класс ${ref.cls}: ни одной модели не загружено. ${info.join('; ')}`);
  const head = `Arma: ${ref.cls} (${ref.kind}), моделей ${loaded}/${parts.length}, мешей ${meshes.length}, вершин ${sumVerts(meshes)}, треугольников ${sumTris(meshes)}`;
  const lodInfo = base ? `LOD основной модели: ${base.li} (${lodKind(base.o.resolutions[base.li]!)})` : '';
  return {
    meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true,
    info: [head, ...parts.map((p) => `• ${p.title}: ${p.path}`), lodInfo, ...(skeleton ? [`Скелет: ${skeleton}`] : []), ...info].filter(Boolean),
    meta: { arma: { cls: ref.cls } },
  };
}
