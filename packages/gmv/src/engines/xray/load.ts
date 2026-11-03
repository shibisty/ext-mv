import { boundsOf, makeIndices } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { Mesh, Model, VFile, XrayMotion } from '../../core/types';
import { parseOGF, parseOMF, type OgfBone } from './ogf';
import { XraySkeleton } from './skeleton';

/** Внешние анимации по расширению: .omf (по именам костей из S_SMPARAMS), .skl/.skls (ActorEditor). */
async function motionsFromFile(file: VFile, bones: OgfBone[], skel: XraySkeleton, parts?: Array<{ name: string; bones: string[] }>): Promise<XrayMotion[]> {
  const buf = await file.arrayBuffer(), ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'skl' || ext === 'skls') {
    const { parseSkl, parseSMotions, smotionToXray } = await import('./smotion');
    const u = new Uint8Array(buf), list = ext === 'skl' ? [parseSkl(u)] : parseSMotions(u);
    return list.map((sm) => smotionToXray(sm, bones.map((b) => b.name), (r, p, o) => skel.local(r, p, o), parts));
  }
  return parseOMF(buf, bones);
}

/** Анимации из S_MOTION_REFS / ссылок объекта: meshes/<ссылка>.omf в открытых архивах и папках. */
async function referencedMotions(refs: readonly string[], bones: OgfBone[], ctx?: LoadContext): Promise<{ list: XrayMotion[]; missing: string[] }> {
  const list: XrayMotion[] = [], missing: string[] = [];
  if (!ctx || !bones.length) return { list, missing };
  for (const ref of refs) {
    const rel = ref.replace(/\\/g, '/').toLowerCase().replace(/\.omf$/, '') + '.omf';
    let u: Uint8Array | null = null;
    for (const p of [`meshes/${rel}`, `gamedata/meshes/${rel}`, rel]) { u = await ctx.readPath(p).catch(() => null); if (u) break; }
    if (!u) { missing.push(ref); continue; }
    try {
      const src = rel.split('/').pop()!;
      for (const x of parseOMF(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer, bones)) list.push({ ...x, source: src });
    } catch { missing.push(ref); }
  }
  return { list, missing };
}
const refsInfo = (refs: readonly string[], n: number, missing: readonly string[]) =>
  `Внешние анимации (.omf): ${refs.join(', ')}${n ? ` — подключено ${n}` : ''}${missing.length ? ` (не найдены: ${missing.join(', ')} — откройте папку gamedata или архивы игры)` : ''}`;

export async function loadOgf(main: VFile, ctx?: LoadContext): Promise<Model> {
  const m = parseOGF(await main.arrayBuffer());
  const { list: ext, missing } = await referencedMotions(m.info.motionRefs, m.bones, ctx);
  m.motions.push(...ext);
  m.meshes.forEach((x, i) => { x.name = `#${i}`; });
  const meshes = m.meshes.map((x) => ({ ...x, name: x.name ?? '' }));
  const skel = XraySkeleton.auto(m.bones, meshes);
  const verts = meshes.reduce((a, x) => a + x.vertexCount, 0), i = m.info, info: string[] = [];
  info.push(`Тип: ${i.type}`, `Мешей: ${meshes.length}, вершин: ${verts}, треугольников: ${i.tris}`,
    `Костей: ${m.bones.length}${m.bones.length && !i.ikOk ? ' (IK-данные не разобраны — bind-поза неточна)' : ''}`);
  if (skel.bindVariant) info.push(`Углы костей: вариант ${skel.bindVariant}`);
  info.push(`Анимаций внутри: ${m.motions.length - ext.length}`);
  if (i.motionRefs.length) info.push(refsInfo(i.motionRefs, ext.length, missing));
  if (i.desc) info.push(`Источник: ${i.desc.source}`, `Автор: ${i.desc.owner ?? ''}`);
  return {
    meshes, skeleton: skel.n ? skel : null, motions: m.motions, bounds: m.bounds, flipZ: true, info,
    detectInvert: (motion) => (motion.kind === 'xray' ? skel.detectInvert(meshes, motion) : false),
    loadMotions: async (file) => motionsFromFile(file, m.bones, skel),
  };
}

/** Исходный объект SDK (.object): меши по поверхностям, текстуры из поверхностей. */
export async function loadObject(main: VFile, ctx?: LoadContext): Promise<Model> {
  const { parseObject, objectMeshes, objectSkeleton } = await import('./object');
  const o = parseObject(await main.arrayBuffer()), sk = objectSkeleton(o);
  const boneOfMap = sk ? new Map(sk.bones.map((b, i) => [b.wmap.toLowerCase(), i])) : undefined;
  if (sk) sk.bones.forEach((b, i) => { if (!boneOfMap!.has(b.name.toLowerCase())) boneOfMap!.set(b.name.toLowerCase(), i); });
  const list = objectMeshes(o, 'auto', boneOfMap);
  if (!list.length) throw new Error('В объекте нет граней');
  const meshes: Mesh[] = list.map((x) => {
    const n = x.pos.length / 3;
    return {
      name: x.name, texture: x.surface?.texture ?? '', shader: x.surface?.eshader ?? '', material: x.surface?.gamemtl, vertexCount: n,
      pos: x.pos, nor: x.nor, uv: x.uv, bone: x.bone ?? new Float32Array(n * 4), weight: x.weight ?? new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)),
      indices: makeIndices(n, x.indices), skinned: !!x.bone,
    };
  });
  const verts = meshes.reduce((a, m) => a + m.vertexCount, 0), tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  const info = [`X-Ray SDK .object: мешей ${o.meshes.length}, поверхностей ${o.surfaces.length}, вершин ${verts}, треугольников ${tris}`];
  for (const s of o.surfaces.slice(0, 12)) info.push(` • ${s.name}: ${s.texture} | ${s.eshader} | ${s.cshader} | ${s.gamemtl}`);
  if (o.revision) info.push(`Автор: ${o.revision.owner}`);
  const model: Model = { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true, info };
  if (!sk) return model;
  // скелет: bind-поза из костей объекта (те же углы setXYZi, что в IK-данных OGF)
  const bones: OgfBone[] = sk.bones.map((b) => ({ name: b.name, parent: b.parent, rot: b.rot, pos: b.pos }));
  const skel = XraySkeleton.auto(bones, meshes);
  const parts = sk.parts.length ? sk.parts : undefined;
  if (sk.motions) {
    try {
      const { parseSMotions, smotionToXray } = await import('./smotion');
      for (const sm of parseSMotions(sk.motions)) model.motions.push(smotionToXray(sm, bones.map((b) => b.name), (r, p, x) => skel.local(r, p, x), parts));
    } catch (e) { info.push(`Анимации объекта не прочитаны: ${(e as Error).message}`); }
  }
  const own = model.motions.length;
  const { list: ext, missing } = await referencedMotions(sk.motionRefs, bones, ctx);
  model.motions.push(...ext);
  info.push(`Костей: ${bones.length}${skel.bindVariant ? ` (углы: вариант ${skel.bindVariant})` : ''}, частей тела: ${sk.parts.length}, анимаций внутри: ${own}`);
  if (sk.motionRefs.length) info.push(refsInfo(sk.motionRefs, ext.length, missing));
  return {
    ...model, skeleton: skel,
    detectInvert: (motion) => (motion.kind === 'xray' ? skel.detectInvert(meshes, motion) : false),
    loadMotions: async (file) => motionsFromFile(file, bones, skel, parts),
  };
}
