// Выгрузка любой загруженной модели или уровня в исходники X-Ray SDK (ЗП, SDK 0.7):
//   rawdata/objects/<префикс>/<имя>_<ячейка>.object   — геометрия, разбитая на ячейки сетки (для больших карт);
//   rawdata/levels/<имя>.level + <имя>/scene_object.part — сцена с этими объектами;
//   gamedata/textures/<префикс>/<текстура>.dds + .thm  — текстуры (DDS копируется как есть, остальное — без сжатия).
// Дальше: LevelEditor → свет, секторы/порталы, спавн → сборка xrLC/xrAI/xrDO.
import { encodeDdsRgba, hasAlpha } from '../../core/writers/dds';
import type { DecodedImage, Model } from '../../core/types';
import { visibleIndices } from '../../core/scene';
import { writeThm } from './thm';
import { writeObject, type ObjectMeshIn, type ObjectSurfaceIn } from './write-object';
import { writeScene, type SceneObjectOut } from './write-scene';

export interface TextureForExport {
  /** Имя исходной текстуры (для имени файла). */
  name: string;
  /** Исходный DDS — копируется без перекодирования. */
  dds?: Uint8Array;
  /** Иначе — декодированная картинка. */
  image?: DecodedImage | null;
}

export interface XrayExportOptions {
  /** Имя уровня/объекта: латиница, цифры, «_». */
  name: string;
  /** Папка внутри rawdata/objects и gamedata/textures. По умолчанию «gmv\\<имя>». */
  prefix?: string;
  /** Множитель единиц в метры (X-Ray: 1 = 1 м). */
  scale?: number;
  /** Размер ячейки разбиения, м; 0 — один объект. По умолчанию: 0 для моделей, 32 м для сцен больше 100 м или 60 тыс. треугольников, 64 м — больше 400 м. */
  cell?: number;
  /** Текстура меша по номеру (из сессии просмотра). */
  texture?: (meshIndex: number) => Promise<TextureForExport | null>;
  /** Скрытые меши не выгружаются. */
  hidden?: ReadonlySet<number>;
  /**
   * Объекты уровня (model.instances): true (по умолчанию) — каждая модель одним .object в «<префикс>\\props», в сцене — ссылки с позами;
   * false — объекты вливаются в геометрию ячеек.
   */
  instances?: boolean;
  /**
   * Источник — сам X-Ray (скомпилированный уровень, OGF, .object): имена текстур, шейдеры и материалы остаются игровыми,
   * текстуры не копируются (они уже есть в gamedata).
   */
  xraySource?: boolean;
}

export interface XrayExportResult { files: Map<string, Uint8Array>; report: string[] }

const clean = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tex';

/** Вершины меша в координатах X-Ray: поза bind, Z-вверх -> Y-вверх, правые -> левые (с разворотом обхода), масштаб. */
function toXray(model: Model, mi: number, scale: number): { pos: Float32Array; nor: Float32Array; indices: Uint32Array } {
  const m = model.meshes[mi]!, n = m.vertexCount, sk = model.skeleton, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  if (sk) sk.pose(null, 0, false);
  for (let v = 0; v < n; v++) {
    let x = m.pos[v * 3]!, y = m.pos[v * 3 + 1]!, z = m.pos[v * 3 + 2]!, a = m.nor[v * 3]!, b = m.nor[v * 3 + 1]!, c = m.nor[v * 3 + 2]!;
    if (sk && m.skinned) {
      let px = 0, py = 0, pz = 0, na = 0, nb = 0, nc = 0, ws = 0;
      for (let k = 0; k < 4; k++) {
        const w = m.weight[v * 4 + k]!;
        if (!w) continue;
        const M = sk.skinV[m.bone[v * 4 + k]!]!;
        ws += w;
        px += w * (x * M[0]! + y * M[4]! + z * M[8]! + M[12]!); py += w * (x * M[1]! + y * M[5]! + z * M[9]! + M[13]!); pz += w * (x * M[2]! + y * M[6]! + z * M[10]! + M[14]!);
        na += w * (a * M[0]! + b * M[4]! + c * M[8]!); nb += w * (a * M[1]! + b * M[5]! + c * M[9]!); nc += w * (a * M[2]! + b * M[6]! + c * M[10]!);
      }
      if (ws) { x = px; y = py; z = pz; a = na; b = nb; c = nc; }
    }
    if (model.defaultZUp) { [y, z] = [z, -y]; [b, c] = [c, -b]; }
    if (!model.flipZ) { z = -z; c = -c; }
    const l = Math.hypot(a, b, c) || 1;
    pos[v * 3] = x * scale; pos[v * 3 + 1] = y * scale; pos[v * 3 + 2] = z * scale;
    nor[v * 3] = a / l; nor[v * 3 + 1] = b / l; nor[v * 3 + 2] = c / l;
  }
  const indices = visibleIndices(model, mi);
  // отражение меняет обход: внешняя нормаль X-Ray = (b − a) × (c − a)
  if (!model.flipZ) for (let t = 0; t + 2 < indices.length; t += 3) { const q = indices[t + 1]!; indices[t + 1] = indices[t + 2]!; indices[t + 2] = q; }
  return { pos, nor, indices };
}

export async function exportXraySdk(model: Model, o: XrayExportOptions): Promise<XrayExportResult> {
  const name = clean(o.name), prefix = (o.prefix ?? `gmv\\${name}`).replace(/\//g, '\\').replace(/\\+$/, ''), scale = o.scale ?? 1;
  const files = new Map<string, Uint8Array>(), report: string[] = [];
  const inst = o.instances !== false && model.instances && model.flipZ && !model.defaultZUp ? model.instances : null;
  const instMeshes = new Set(inst?.meshes ?? []);
  const meshIdx = model.meshes.map((_, i) => i).filter((i) => !o.hidden?.has(i) && model.meshes[i]!.indices.length >= 3);
  const geo = new Map(meshIdx.filter((i) => !instMeshes.has(i)).map((i) => [i, toXray(model, i, scale)]));
  // размер сцены -> ячейка
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const g of geo.values()) for (let i = 0; i < g.pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3]!, g.pos[i]!); hi[i % 3] = Math.max(hi[i % 3]!, g.pos[i]!); }
  const extent = Math.max(hi[0]! - lo[0]!, hi[2]! - lo[2]!);
  // авто: большие сцены режутся на ячейки, чтобы объекты в LevelEditor оставались удобными
  const triCount = [...geo.values()].reduce((a, g) => a + g.indices.length / 3, 0);
  const cell = o.cell ?? (extent > 400 ? 64 : extent > 100 || triCount > 60000 ? 32 : 0);

  // текстуры и поверхности: одна поверхность на текстуру (+ двусторонность по названию шейдера не угадываем)
  const surfaces: ObjectSurfaceIn[] = [], surfOfMesh = new Map<number, number>(), texOut = new Map<string, string>();
  let copied = 0, encoded = 0, missingTex = 0;
  for (const i of meshIdx) {
    const m = model.meshes[i]!, key = m.texture || `mesh_${i}`;
    if (o.xraySource) {
      // игровые имена: поверхность на сочетание текстуры, шейдера и материала
      const sk = `${m.texture}|${m.shader ?? ''}|${m.material ?? ''}`;
      let si = surfaces.findIndex((x) => `${x.texture}|${x.eshader}|${x.gamemtl}` === sk);
      if (si < 0) si = surfaces.push({ name: `${clean(m.texture.split('\\').pop() ?? 's')}_${surfaces.length}`, texture: m.texture, eshader: m.shader || 'default', gamemtl: m.material || 'default' }) - 1;
      surfOfMesh.set(i, si);
      continue;
    }
    let xname = texOut.get(key);
    if (!xname) {
      const base = clean(key.split(/[\\/]/).pop() ?? key);
      let cand = base, k = 1;
      while ([...texOut.values()].includes(`${prefix}\\${cand}`)) cand = `${base}_${k++}`;
      xname = `${prefix}\\${cand}`;
      texOut.set(key, xname);
      const t = o.texture ? await o.texture(i).catch(() => null) : null;
      const path = `gamedata/textures/${xname.replace(/\\/g, '/')}`;
      if (t?.dds && t.dds.length > 128) {
        files.set(`${path}.dds`, t.dds);
        const dv = new DataView(t.dds.buffer, t.dds.byteOffset), fourcc = String.fromCharCode(t.dds[84]!, t.dds[85]!, t.dds[86]!, t.dds[87]!);
        files.set(`${path}.thm`, writeThm({ width: dv.getUint32(16, true), height: dv.getUint32(12, true), alpha: fourcc !== 'DXT1' }));
        copied++;
      } else if (t?.image?.rgba) {
        const a = hasAlpha(t.image);
        files.set(`${path}.dds`, encodeDdsRgba({ width: t.image.width, height: t.image.height, rgba: t.image.rgba }));
        files.set(`${path}.thm`, writeThm({ width: t.image.width, height: t.image.height, alpha: a }));
        encoded++;
      } else missingTex++;
      surfaces.push({ name: cand, texture: xname });
    }
    surfOfMesh.set(i, surfaces.findIndex((s) => s.texture === xname));
  }

  // ячейки: треугольник относится к ячейке своего центра
  const cells = new Map<string, Map<number, number[]>>();
  for (const [i, g] of geo) {
    for (let t = 0; t + 2 < g.indices.length; t += 3) {
      let key = 'all';
      if (cell > 0) {
        const a = g.indices[t]! * 3, b = g.indices[t + 1]! * 3, c = g.indices[t + 2]! * 3;
        const cx = (g.pos[a]! + g.pos[b]! + g.pos[c]!) / 3, cz = (g.pos[a + 2]! + g.pos[b + 2]! + g.pos[c + 2]!) / 3;
        key = `${Math.floor((cx - lo[0]!) / cell)}_${Math.floor((cz - lo[2]!) / cell)}`;
      }
      const byMesh = cells.get(key) ?? cells.set(key, new Map()).get(key)!;
      (byMesh.get(i) ?? byMesh.set(i, []).get(i)!).push(t);
    }
  }
  const objects: Array<{ name: string; reference: string }> = [];
  let tris = 0;
  for (const [key, byMesh] of cells) {
    const meshes: ObjectMeshIn[] = [];
    for (const [i, list] of byMesh) {
      const g = geo.get(i)!, src = model.meshes[i]!, remap = new Map<number, number>(), pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
      for (const t of list) for (let k = 0; k < 3; k++) {
        const v = g.indices[t + k]!;
        let r = remap.get(v);
        if (r === undefined) {
          r = pos.length / 3; remap.set(v, r);
          pos.push(g.pos[v * 3]!, g.pos[v * 3 + 1]!, g.pos[v * 3 + 2]!); nor.push(g.nor[v * 3]!, g.nor[v * 3 + 1]!, g.nor[v * 3 + 2]!); uv.push(src.uv[v * 2]!, src.uv[v * 2 + 1]!);
        }
        idx.push(r);
      }
      tris += list.length;
      meshes.push({ name: clean(src.name || `mesh_${i}`), pos, nor, uv, indices: idx, surface: surfOfMesh.get(i)! });
    }
    const oname = cell > 0 ? `${name}_${key}` : name, reference = `${prefix}\\${oname}`;
    // поверхности объекта — только используемые им, с перенумерацией
    const used = [...new Set(meshes.map((m) => m.surface as number))], local = new Map(used.map((s, k) => [s, k]));
    for (const m of meshes) m.surface = local.get(m.surface as number)!;
    files.set(`rawdata/objects/${reference.replace(/\\/g, '/')}.object`, writeObject({ meshes, surfaces: used.map((s) => surfaces[s]!) }));
    objects.push({ name: oname, reference });
  }
  const scene: SceneObjectOut[] = objects.map((x) => ({ ...x, position: [0, 0, 0] }));
  let instTris = 0, protoCount = 0, mirrored = 0;
  if (inst) {
    // прототипы: один .object на модель; зеркальные позы (det < 0) поворотом не выразить — их геометрия вливается в отдельный объект
    const protoRef = new Map<number, string>(), used = new Set(inst.placements.map((p) => p.proto)), mirrorMeshes: ObjectMeshIn[] = [];
    const names = new Set<string>();
    const meshesOf = (pi: number, M: number[] | null): ObjectMeshIn[] => inst.protos[pi]!.parts.filter((pt) => !o.hidden?.has(pt.mesh) && surfOfMesh.has(pt.mesh) && pt.indices.length >= 3).map((pt, k) => {
      const n = pt.pos.length / 3, pos: number[] = [], nor: number[] = [];
      for (let v = 0; v < n; v++) {
        let x = pt.pos[v * 3]!, y = pt.pos[v * 3 + 1]!, z = pt.pos[v * 3 + 2]!, a = pt.nor[v * 3]!, b = pt.nor[v * 3 + 1]!, c = pt.nor[v * 3 + 2]!;
        if (M) {
          [x, y, z] = [x * M[0]! + y * M[4]! + z * M[8]! + M[12]!, x * M[1]! + y * M[5]! + z * M[9]! + M[13]!, x * M[2]! + y * M[6]! + z * M[10]! + M[14]!];
          [a, b, c] = [a * M[0]! + b * M[4]! + c * M[8]!, a * M[1]! + b * M[5]! + c * M[9]!, a * M[2]! + b * M[6]! + c * M[10]!];
          const l = Math.hypot(a, b, c) || 1; a /= l; b /= l; c /= l;
        }
        pos.push(x * scale, y * scale, z * scale); nor.push(a, b, c);
      }
      const indices = Array.from(pt.indices);
      if (M) for (let t = 0; t + 2 < indices.length; t += 3) { const q = indices[t + 1]!; indices[t + 1] = indices[t + 2]!; indices[t + 2] = q; }
      return { name: `part_${k}`, pos, nor, uv: pt.uv, indices, surface: surfOfMesh.get(pt.mesh)! };
    });
    const writeWith = (reference: string, meshes: ObjectMeshIn[]) => {
      const usedS = [...new Set(meshes.map((m) => m.surface as number))], local = new Map(usedS.map((x, k) => [x, k]));
      for (const m of meshes) m.surface = local.get(m.surface as number)!;
      files.set(`rawdata/objects/${reference.replace(/\\/g, '/')}.object`, writeObject({ meshes, surfaces: usedS.map((x) => surfaces[x]!) }));
    };
    for (const pl of inst.placements) {
      if (!used.has(pl.proto) || pl.hidden) continue;
      const M = pl.pose, R = [M[0]!, M[1]!, M[2]!, M[4]!, M[5]!, M[6]!, M[8]!, M[9]!, M[10]!];
      const sc = [Math.hypot(R[0]!, R[1]!, R[2]!), Math.hypot(R[3]!, R[4]!, R[5]!), Math.hypot(R[6]!, R[7]!, R[8]!)];
      const det = R[0]! * (R[4]! * R[8]! - R[5]! * R[7]!) - R[1]! * (R[3]! * R[8]! - R[5]! * R[6]!) + R[2]! * (R[3]! * R[7]! - R[4]! * R[6]!);
      if (det < 0) { const ms = meshesOf(pl.proto, M); mirrorMeshes.push(...ms); mirrored++; for (const m of ms) instTris += m.indices.length / 3; continue; }
      let ref = protoRef.get(pl.proto);
      if (ref === undefined) {
        const ms = meshesOf(pl.proto, null);
        if (!ms.length) { protoRef.set(pl.proto, ''); continue; }
        let base = clean(inst.protos[pl.proto]!.name.split(/[\\/]/).pop() ?? 'obj'), cand = base, k = 1;
        while (names.has(cand)) cand = `${base}_${k++}`;
        names.add(cand);
        ref = `${prefix}\\props\\${cand}`;
        writeWith(ref, ms);
        protoRef.set(pl.proto, ref);
        protoCount++;
      }
      if (!ref) continue;
      for (const pt of inst.protos[pl.proto]!.parts) instTris += pt.indices.length / 3;
      let nm = clean(pl.name), j = 1;
      while (names.has(nm)) nm = `${clean(pl.name)}_${j++}`;
      names.add(nm);
      scene.push({ name: nm, reference: ref, position: [M[12]! * scale, M[13]! * scale, M[14]! * scale], matrix: R.map((v, i) => v / sc[Math.floor(i / 3)]!), scale: sc });
    }
    if (mirrorMeshes.length) {
      const ref = `${prefix}\\${name}_mirrored`;
      writeWith(ref, mirrorMeshes);
      scene.push({ name: `${name}_mirrored`, reference: ref, position: [0, 0, 0] });
    }
  }
  for (const [path, data] of writeScene({ name, objects: scene })) files.set(`rawdata/levels/${path}`, data);

  report.push(
    `Объектов .object: ${objects.length}${cell > 0 ? ` (ячейки ${cell} м)` : ''}, треугольников: ${tris}, размер сцены: ${(hi[0]! - lo[0]!).toFixed(1)} × ${(hi[1]! - lo[1]!).toFixed(1)} × ${(hi[2]! - lo[2]!).toFixed(1)} м`,
    ...(inst ? [`Объекты уровня: ${inst.placements.length} экземпляров, ${protoCount} моделей в ${prefix}\\props (треугольников ${instTris})${mirrored ? `; зеркальных ${mirrored} — влиты в ${name}_mirrored` : ''}`] : []),
    o.xraySource ? `Текстуры, шейдеры и материалы — игровые (${surfaces.length} поверхностей), файлы текстур не копируются` : `Текстуры: ${copied} DDS скопировано, ${encoded} перекодировано в DDS без сжатия${missingTex ? `, ${missingTex} не найдено (объект ссылается на имя, файл положите сами)` : ''}`,
    `Сцена: rawdata/levels/${name}.level — откройте в LevelEditor, добавьте свет, секторы/порталы и спавн, затем соберите xrLC.`,
  );
  if (!o.xraySource) {
    report.push('Шейдеры поверхностей — «default», материал — «default»: настройте в редакторе (стекло, листва, двусторонние грани).');
    const mats = [...new Set(meshIdx.map((i) => model.meshes[i]!.material).filter((x): x is string => !!x))];
    if (mats.length) report.push(`Материалы исходника (для настройки game material): ${mats.slice(0, 30).join(', ')}${mats.length > 30 ? '…' : ''}`);
  }
  if (model.skeleton) report.push('Скелетная модель выгружена в bind-позе как статика (кости и анимации в .object пока не пишутся).');
  if (!model.flipZ) report.push('Координаты переведены в левостороннюю систему X-Ray (Z отражён, обход граней развёрнут).');
  return { files, report };
}
