// Выгрузка в Wavefront OBJ + MTL (Blender, 3ds Max, любой 3D-редактор): геометрия в bind-позе, Y вверх, правосторонняя система;
// текстуры — DDS рядом (исходный DDS копируется, остальное — без сжатия). Скрытые меши и экземпляры не выгружаются.
import type { ExportContext, ExportResult, ExportValues } from '../plugin';
import { visibleIndices } from '../scene';
import type { Model } from '../types';
import { encodeDdsRgba } from './dds';

const clean = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tex';

export async function exportObj(model: Model, v: ExportValues, ctx: ExportContext): Promise<ExportResult> {
  const name = clean(String(v.name || ctx.baseName)), scale = +(v.scale ?? 1) || 1, files = new Map<string, Uint8Array>(), enc = new TextEncoder();
  const sk = model.skeleton;
  if (sk) sk.pose(null, 0, false);
  const lines: string[] = [`# gmv: ${ctx.preset.title}`, `mtllib ${name}.mtl`], mtl: string[] = [], texOf = new Map<string, string>();
  let base = 1, tris = 0, meshes = 0, copied = 0, encoded = 0;
  for (let i = 0; i < model.meshes.length; i++) {
    if (ctx.hidden.has(i)) continue;
    const m = model.meshes[i]!, idx = visibleIndices(model, i);
    if (idx.length < 3) continue;
    // материал на текстуру
    const key = m.texture || `mesh_${i}`;
    let mat = texOf.get(key);
    if (!mat) {
      mat = `${clean(key.split(/[\\/]/).pop() ?? key)}_${texOf.size}`;
      texOf.set(key, mat);
      mtl.push(`newmtl ${mat}`, 'Kd 1 1 1');
      const t = await ctx.texture(i).catch(() => null);
      const file = `textures/${mat}.dds`;
      if (t?.dds && t.dds.length > 128) { files.set(file, t.dds); copied++; mtl.push(`map_Kd ${file}`); }
      else if (t?.image?.rgba) { files.set(file, encodeDdsRgba({ width: t.image.width, height: t.image.height, rgba: t.image.rgba })); encoded++; mtl.push(`map_Kd ${file}`); }
      mtl.push('');
    }
    lines.push(`o ${clean(m.name || 'mesh')}_${i}`, `usemtl ${mat}`);
    const n = m.vertexCount;
    for (let k = 0; k < n; k++) {
      let x = m.pos[k * 3]!, y = m.pos[k * 3 + 1]!, z = m.pos[k * 3 + 2]!, a = m.nor[k * 3]!, b = m.nor[k * 3 + 1]!, c = m.nor[k * 3 + 2]!;
      if (sk && m.skinned) {
        let px = 0, py = 0, pz = 0, na = 0, nb = 0, nc = 0, ws = 0;
        for (let j = 0; j < 4; j++) {
          const w = m.weight[k * 4 + j]!;
          if (!w) continue;
          const M = sk.skinV[m.bone[k * 4 + j]!]!;
          ws += w;
          px += w * (x * M[0]! + y * M[4]! + z * M[8]! + M[12]!); py += w * (x * M[1]! + y * M[5]! + z * M[9]! + M[13]!); pz += w * (x * M[2]! + y * M[6]! + z * M[10]! + M[14]!);
          na += w * (a * M[0]! + b * M[4]! + c * M[8]!); nb += w * (a * M[1]! + b * M[5]! + c * M[9]!); nc += w * (a * M[2]! + b * M[6]! + c * M[10]!);
        }
        if (ws) { x = px; y = py; z = pz; a = na; b = nb; c = nc; }
      }
      if (model.defaultZUp) { [y, z] = [z, -y]; [b, c] = [c, -b]; }
      if (model.flipZ) { z = -z; c = -c; }
      lines.push(`v ${(x * scale).toFixed(5)} ${(y * scale).toFixed(5)} ${(z * scale).toFixed(5)}`);
      lines.push(`vt ${m.uv[k * 2]!.toFixed(5)} ${(1 - m.uv[k * 2 + 1]!).toFixed(5)}`);
      const l = Math.hypot(a, b, c) || 1;
      lines.push(`vn ${(a / l).toFixed(4)} ${(b / l).toFixed(4)} ${(c / l).toFixed(4)}`);
    }
    for (let t = 0; t + 2 < idx.length; t += 3) {
      // отражённая (левая) система — обход разворачивается
      const p = [idx[t]!, model.flipZ ? idx[t + 2]! : idx[t + 1]!, model.flipZ ? idx[t + 1]! : idx[t + 2]!].map((q) => q + base);
      lines.push(`f ${p.map((q) => `${q}/${q}/${q}`).join(' ')}`);
    }
    base += n;
    tris += idx.length / 3;
    meshes++;
  }
  files.set(`${name}.obj`, enc.encode(lines.join('\n') + '\n'));
  files.set(`${name}.mtl`, enc.encode(mtl.join('\n')));
  return {
    files, name: `${name}_obj`,
    report: [
      `OBJ: ${meshes} мешей, ${tris} треугольников, ${texOf.size} материалов`,
      `Текстуры: ${copied} DDS скопировано, ${encoded} перекодировано в DDS без сжатия`,
      ...(sk ? ['Скелетная модель выгружена в bind-позе (кости и анимации OBJ не хранит).'] : []),
      ...(model.flipZ ? ['Координаты переведены в правостороннюю систему (Z отражён, обход граней развёрнут).'] : []),
    ],
  };
}
