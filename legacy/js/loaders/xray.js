import { parseOGF, parseOMF } from '../ogf-parser.js';
import { Skeleton } from '../skeleton.js';

export async function load(files, main) {
  const m = parseOGF(await main.arrayBuffer());
  const skel = Skeleton.auto(m.bones, m.meshes);
  m.meshes.forEach((x, i) => { x.name = `#${i}`; });
  const verts = m.meshes.reduce((a, x) => a + x.vertexCount, 0), i = m.info, info = [];
  info.push(`Тип: ${i.type}`, `Мешей: ${m.meshes.length}, вершин: ${verts}, треугольников: ${i.tris}`,
    `Костей: ${m.bones.length}${m.bones.length && !i.ikOk ? ' (IK-данные не разобраны — bind-поза неточна)' : ''}`);
  if (skel.bindVariant) info.push(`Углы костей: вариант ${skel.bindVariant}`);
  info.push(`Анимаций внутри: ${m.motions.length}`);
  if (i.motionRefs.length) info.push(`Внешние анимации (.omf): ${i.motionRefs.join(', ')}`);
  if (i.desc) info.push(`Источник: ${i.desc.source}`, `Автор: ${i.desc.owner}`);
  return {
    meshes: m.meshes, skeleton: skel.n ? skel : null, motions: m.motions, bounds: m.bounds, flipZ: true, info,
    features: { omf: true, invertQuat: true },
    detectInvert: (motion) => skel.detectInvert(m.meshes, motion),
    loadMotions: async (file) => parseOMF(await file.arrayBuffer(), m.bones.length),
  };
}
