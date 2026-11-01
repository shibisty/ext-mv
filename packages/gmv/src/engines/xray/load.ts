import { boundsOf, makeIndices } from '../../core/geometry';
import type { Mesh, Model, VFile } from '../../core/types';
import { parseOGF, parseOMF } from './ogf';
import { XraySkeleton } from './skeleton';

export async function loadOgf(main: VFile): Promise<Model> {
  const m = parseOGF(await main.arrayBuffer());
  m.meshes.forEach((x, i) => { x.name = `#${i}`; });
  const meshes = m.meshes.map((x) => ({ ...x, name: x.name ?? '' }));
  const skel = XraySkeleton.auto(m.bones, meshes);
  const verts = meshes.reduce((a, x) => a + x.vertexCount, 0), i = m.info, info: string[] = [];
  info.push(`Тип: ${i.type}`, `Мешей: ${meshes.length}, вершин: ${verts}, треугольников: ${i.tris}`,
    `Костей: ${m.bones.length}${m.bones.length && !i.ikOk ? ' (IK-данные не разобраны — bind-поза неточна)' : ''}`);
  if (skel.bindVariant) info.push(`Углы костей: вариант ${skel.bindVariant}`);
  info.push(`Анимаций внутри: ${m.motions.length}`);
  if (i.motionRefs.length) info.push(`Внешние анимации (.omf): ${i.motionRefs.join(', ')}`);
  if (i.desc) info.push(`Источник: ${i.desc.source}`, `Автор: ${i.desc.owner ?? ''}`);
  return {
    meshes, skeleton: skel.n ? skel : null, motions: m.motions, bounds: m.bounds, flipZ: true, info,
    detectInvert: (motion) => (motion.kind === 'xray' ? skel.detectInvert(meshes, motion) : false),
    loadMotions: async (file) => parseOMF(await file.arrayBuffer(), m.bones),
  };
}

/** Исходный объект SDK (.object): меши по поверхностям, текстуры из поверхностей. */
export async function loadObject(main: VFile): Promise<Model> {
  const { parseObject, objectMeshes } = await import('./object');
  const o = parseObject(await main.arrayBuffer()), list = objectMeshes(o);
  if (!list.length) throw new Error('В объекте нет граней');
  const meshes: Mesh[] = list.map((x) => {
    const n = x.pos.length / 3;
    return {
      name: x.name, texture: x.surface?.texture ?? '', shader: x.surface?.eshader ?? '', material: x.surface?.gamemtl, vertexCount: n,
      pos: x.pos, nor: x.nor, uv: x.uv, bone: new Float32Array(n * 4), weight: new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)),
      indices: makeIndices(n, x.indices), skinned: false,
    };
  });
  const verts = meshes.reduce((a, m) => a + m.vertexCount, 0), tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  const info = [`X-Ray SDK .object: мешей ${o.meshes.length}, поверхностей ${o.surfaces.length}, вершин ${verts}, треугольников ${tris}`];
  for (const s of o.surfaces.slice(0, 12)) info.push(` • ${s.name}: ${s.texture} | ${s.eshader} | ${s.cshader} | ${s.gamemtl}`);
  if (o.revision) info.push(`Автор: ${o.revision.owner}`);
  if (o.extra.some((c) => c.id === 0x0921)) info.push('Кости и анимации объекта пока не показываются.');
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true, info };
}
