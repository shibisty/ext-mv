// Модель P3D (ODOL) -> общая Model: один визуальный LOD, меши по секциям, скрытые выделения (camo…) для текстур из конфига.
import { boundsOf, sumTris, sumVerts } from '../../core/geometry';
import type { Mesh, Model, SurfaceInfo } from '../../core/types';
import { lodKind, parseOdol, type OdolLod, type OdolModel } from './odol';

export interface ArmaMeshInfo {
  /** Имена именованных выделений, в которые входит секция (camo, camo1, insignia…). */
  selections: string[];
  /** Номер секции в LOD. */
  section: number;
  /** Текстура секции из модели (может быть пустой у скрытых выделений). */
  texture: string;
  /** Материал (.rvmat). */
  material: string;
}

/** Процедурная текстура «#(argb,8,8,3)color(r,g,b,a)» -> цвет. */
export function proceduralColor(t: string): number[] | null {
  const m = /^#\(\w+,\d+,\d+,\d+\)color\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(t);
  return m ? [+m[1]!, +m[2]!, +m[3]!] : null;
}

/** Стадия _smdi rvmat: файл (G — блик, B — глянец) или процедурный цвет «#(argb,8,8,3)color(r,g,b,a,smdi)». */
export function smdiSurface(stage: string | undefined): SurfaceInfo | undefined {
  if (!stage) return undefined;
  const m = /color\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(stage);
  if (stage.startsWith('#')) return m ? { specularFactor: +m[2]!, roughnessFactor: 1 - +m[3]!, source: 'Arma smdi (цвет)' } : undefined;
  return { specular: { map: stage, channel: 1 }, gloss: { map: stage, channel: 2 }, source: 'Arma _smdi' };
}

/** Номер LOD для показа: первый визуальный (разрешение < 1000), иначе «вид пилота», иначе 0. */
export function pickLod(o: OdolModel, prefer?: number): number {
  if (prefer !== undefined && prefer >= 0 && prefer < o.resolutions.length) return prefer;
  const vis = o.resolutions.findIndex((r) => r < 1000);
  if (vis >= 0) return vis;
  const view = o.resolutions.findIndex((r) => r < 1300);
  return view >= 0 ? view : 0;
}

/** Меши LOD. matrix (3×4, как у прокси Arma: 3×3 + перенос) — для вложенных моделей. */
/** center — ModelInfo.boundingCenter: вершины ODOL хранятся относительно него. */
export function lodMeshes(lod: OdolLod, prefix = '', matrix?: Float32Array, center: number[] = [0, 0, 0]): Mesh[] {
  const meshes: Mesh[] = [];
  const wide = lod.wide;
  // смещение грани в байтах (как в бинарных секциях): треугольник 16/8, четырёхугольник 20/10
  const offs = new Int32Array(lod.faces.length + 1);
  const tri = wide ? 16 : 8, quad = wide ? 20 : 10;
  for (let i = 0; i < lod.faces.length; i++) offs[i + 1] = offs[i]! + (lod.faces[i]!.length === 4 ? quad : tri);
  const inSel = (s: number) => lod.selections.filter((x) => x.sectional && x.sections.includes(s)).map((x) => x.name);
  const selOf = (s: number) => inSel(s).filter((n) => !/^proxy:/i.test(n));
  // треугольники-прокси (места для обвеса/снаряжения) в игре не рисуются; бинаризатор выносит их в свои секции
  const proxyCount = new Map<number, number>();
  for (const p of lod.proxies) proxyCount.set(p.section, (proxyCount.get(p.section) ?? 0) + 1);
  lod.sections.forEach((sec, si) => {
    // треугольник-прокси (место для обвеса/снаряжения) и вспышка выстрела (zasleh) в игре не видны
    const all = inSel(si);
    if (all.some((n) => /^proxy:/i.test(n)) || all.some((n) => /^zasleh/i.test(n))) return;
    const idx: number[] = [];
    const px = proxyCount.get(si) ?? 0;
    if (px) { let nf = 0; for (let f = 0; f < lod.faces.length && offs[f]! < sec.faceHi; f++) if (offs[f]! >= sec.faceLo) nf++; if (nf <= px) return; }
    for (let f = 0; f < lod.faces.length; f++) {
      if (offs[f]! < sec.faceLo) continue;
      if (offs[f]! >= sec.faceHi) break;
      const v = lod.faces[f]!;
      idx.push(v[0]!, v[1]!, v[2]!);
      if (v.length === 4) idx.push(v[0]!, v[2]!, v[3]!);
    }
    if (!idx.length) return;
    // компактный меш секции
    const map = new Map<number, number>(), order: number[] = [];
    const local = new Uint32Array(idx.length);
    idx.forEach((g, k) => { let l = map.get(g); if (l === undefined) { l = order.length; map.set(g, l); order.push(g); } local[k] = l; });
    const n = order.length, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    order.forEach((g, l) => {
      let x = lod.pos[g * 3]! + center[0]!, y = lod.pos[g * 3 + 1]! + center[1]!, z = lod.pos[g * 3 + 2]! + center[2]!, a = lod.nor[g * 3]!, b = lod.nor[g * 3 + 1]!, c = lod.nor[g * 3 + 2]!;
      if (matrix) {
        const M = matrix;
        [x, y, z] = [M[0]! * x + M[3]! * y + M[6]! * z + M[9]!, M[1]! * x + M[4]! * y + M[7]! * z + M[10]!, M[2]! * x + M[5]! * y + M[8]! * z + M[11]!];
        [a, b, c] = [M[0]! * a + M[3]! * b + M[6]! * c, M[1]! * a + M[4]! * b + M[7]! * c, M[2]! * a + M[5]! * b + M[8]! * c];
      }
      pos[l * 3] = x; pos[l * 3 + 1] = y; pos[l * 3 + 2] = z;
      nor[l * 3] = a; nor[l * 3 + 1] = b; nor[l * 3 + 2] = c;
      uv[l * 2] = lod.uv[g * 2]!; uv[l * 2 + 1] = lod.uv[g * 2 + 1]!;
    });
    const texture = sec.texture >= 0 ? lod.textures[sec.texture] ?? '' : '';
    const mat = sec.material >= 0 ? lod.materials[sec.material]?.name ?? '' : sec.materialName ?? '';
    const smdi = sec.material >= 0 ? lod.materials[sec.material]?.stages.find((t) => /_smdi\.pa[ac]$|,smdi\)$/i.test(t)) : undefined;
    const nohq = sec.material >= 0 ? lod.materials[sec.material]?.stages.find((t) => /_no(hq|fhq|fex|px)?\.pa[ac]$|_nohq/i.test(t)) : undefined;
    const sels = selOf(si);
    const mesh: Mesh = {
      name: `${prefix}${sels[0] ?? `секция ${si}`}`, texture: proceduralColor(texture) ? '' : texture, material: mat, normalMap: nohq && !/^#/.test(nohq) ? nohq : undefined,
      // _smdi: G — сила блика, B — глянец (схема spec/gloss, металличности нет)
      surface: smdiSurface(smdi), vertexCount: n, pos, nor, uv,
      bone: new Float32Array(n * 4), weight: new Float32Array(n * 4), indices: local, skinned: false,
    };
    const col = proceduralColor(texture);
    if (col) mesh.color = col;
    else if (/characters_f\\heads\\|\\hl_\w*_co\.paa$/i.test(texture)) mesh.color = [0.78, 0.6, 0.5]; // кожа из файлов игры: цвет, если текстуры нет
    (mesh as Mesh & { arma?: ArmaMeshInfo }).arma = { selections: sels, section: si, texture, material: mat };
    meshes.push(mesh);
  });
  return meshes;
}

export const armaInfo = (m: Mesh): ArmaMeshInfo | undefined => (m as Mesh & { arma?: ArmaMeshInfo }).arma;

export function odolToModel(o: OdolModel, name: string, lodIndex?: number): { model: Model; lod: OdolLod; lodIndex: number } {
  const li = pickLod(o, lodIndex), lod = o.lod(li);
  const meshes = lodMeshes(lod, '', undefined, o.boundingCenter);
  if (!meshes.length) throw new Error(`В LOD ${li} (${lodKind(o.resolutions[li]!)}) нет граней`);
  const lods = o.resolutions.map((r, i) => `${i === li ? '▶' : ' '}${i}: ${lodKind(r)}`).join(', ');
  const info = [
    `Arma P3D (ODOL v${o.version}): ${name}, LOD ${li} из ${o.resolutions.length}, мешей ${meshes.length}, вершин ${sumVerts(meshes)}, треугольников ${sumTris(meshes)}`,
    `LOD: ${lods}`,
  ];
  if (o.skeleton) info.push(`Скелет: ${o.skeleton.name} (${o.skeleton.bones.length} костей)`);
  if (lod.proxies.length) info.push(`Прокси: ${[...new Set(lod.proxies.map((p) => p.model))].slice(0, 8).join(', ')}${lod.proxies.length > 8 ? '…' : ''}`);
  return { model: { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true, info, meta: { arma: { lodIndex: li } } }, lod, lodIndex: li };
}

export { parseOdol };
