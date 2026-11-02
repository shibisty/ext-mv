// Модели Survarium (Vostok Games). Модель — папка «x.model» / «x.skinned_model» в архиве:
//   render/<часть>/converted_model — геометрия; состав LOD — settings/lod_hierrarchy (иначе по именам «lodN_…»);
//   settings — двоичный конфиг: material_settings/<часть>/material_name -> material_instances/<имя>.material;
//   материал — тоже двоичный конфиг: material/g_stage/effect/t_albedo|t_normal|t_smoothness|t_metalness/value -> textures/<путь>.dds,
//   effect/use_alpha_test/value = 1 — вырезание по альфе.
// Двоичный конфиг: узлы по 16 байт [u32 значение, u8, u8 тип, u16 размер/число, u32 смещение имени, 4 байта];
// тип 0x30 — таблица (значение — смещение первого из N детей), 0x40 — массив (дети без имён), 0x50 — строка (смещение), 0x10/0x00 — целое, 0x20 — число,
// 0x70 — 3 числа (смещение). Корень — узел 0 (без имени).
// converted_model — чанки [u32 тип, u32 размер]: 3 — вершины [u32 число, вершины], 4 — индексы [u32 число, u16…],
// 5/6/110/114 — кости и границы. Вершина: позиция f32×3, упакованные нормаль/касательная/бинормаль, UV — 2×f16
// (в конце вершины; у вершин с цветом (32 байта) UV перед цветом). Система координат левая (Y вверх), метры.
import { normPath } from '../../core/binary';
import { boundsOf, computeNormals, skinnedBounds } from '../../core/geometry';
import { NodeSkeleton } from '../../core/skeleton';
import { half } from '../../core/binary';
import type { LoadContext } from '../../core/plugin';
import type { Archive, Mesh, Model, NodeMotion, VFile } from '../../core/types';
import { LEVEL_MARK, MODEL_MARK, OUTFIT_MARK } from './db';
import { boneNames, buildMotion, parseBindPose, parseSkeleton, skeletonNodes, type BindBone, type VostokBone } from './anim';

export type CfgValue = string | number | number[] | CfgTable | CfgValue[] | null;
export interface CfgTable { [k: string]: CfgValue }

export function parseVostokConfig(u: Uint8Array): CfgTable {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const str = (o: number) => { let s = ''; for (let k = o; k < u.length && u[k]; k++) s += String.fromCharCode(u[k]!); return s; };
  const node = (o: number, depth: number): [string, CfgValue] => {
    if (o + 16 > u.length || depth > 32) throw new Error('Двоичный конфиг Vostok повреждён');
    const val = dv.getUint32(o, true), type = u[o + 5]!, size = dv.getUint16(o + 6, true), name = o ? str(dv.getUint32(o + 8, true)) : '';
    switch (type) {
      case 0x30: {
        const t: CfgTable = {};
        for (let i = 0; i < size; i++) { const [k, v] = node(val + 16 * i, depth + 1); t[k] = v; }
        return [name, t];
      }
      case 0x40: return [name, Array.from({ length: size }, (_, i) => node(val + 16 * i, depth + 1)[1])];
      case 0x50: return [name, str(val)];
      case 0x00: case 0x10: return [name, dv.getInt32(o, true)];
      case 0x20: return [name, dv.getFloat32(o, true)];
      case 0x70: return [name, [0, 4, 8].map((k) => dv.getFloat32(val + k, true))];
      default: return [name, null];
    }
  };
  if (u.length < 16) throw new Error('Двоичный конфиг Vostok пуст');
  return node(0, 0)[1] as CfgTable;
}

export const tbl = (v: CfgValue | undefined): CfgTable | null => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

export interface VostokGeometry {
  pos: Float32Array; uv: Float32Array; indices: Uint16Array | Uint32Array; count: number; stride: number;
  /** Скиновая часть (есть чанк 5): индексы костей (номера в bind_pose) и веса, по 4 на вершину. */
  bone?: Float32Array; weight?: Float32Array;
}

export function parseConvertedModel(u: Uint8Array): VostokGeometry {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let vAt = -1, vCount = 0, vSize = 0, iAt = -1, iCount = 0, iSize = 0, skinned = false;
  for (let p = 0; p + 8 <= u.length;) {
    const t = dv.getUint32(p, true), s = dv.getUint32(p + 4, true), b = p + 8;
    if (b + s > u.length) throw new Error('converted_model: чанк выходит за конец файла');
    if (t === 3) { vCount = dv.getUint32(b, true); vAt = b + 4; vSize = s - 4; }
    else if (t === 4) { iCount = dv.getUint32(b, true); iAt = b + 4; iSize = s - 4; }
    else if (t === 5) skinned = true;
    p = b + s;
  }
  if (vAt < 0 || iAt < 0 || !vCount) throw new Error('converted_model: нет вершин или индексов');
  const stride = vSize / vCount, ib = iSize / iCount;
  if (!Number.isInteger(stride) || stride < 16 || (ib !== 2 && ib !== 4)) throw new Error(`converted_model: неизвестный формат вершин (${vSize} байт на ${vCount} вершин)`);
  // статика: позиция, 3×4 байта векторов, UV (+ цвет у 32 байт); скин: позиция, 4×u8 кости, f32 × (кости − 1) веса, векторы, UV
  const uvAt = stride === 32 && !skinned ? 24 : stride - 4, nw = skinned ? (stride - 32) / 4 : 0;
  if (skinned && (!Number.isInteger(nw) || nw < 0 || nw > 3)) throw new Error(`converted_model: скиновая вершина ${stride} байт не поддерживается`);
  const pos = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2);
  const bone = skinned ? new Float32Array(vCount * 4) : undefined, weight = skinned ? new Float32Array(vCount * 4) : undefined;
  for (let v = 0; v < vCount; v++) {
    const o = vAt + v * stride;
    pos[v * 3] = dv.getFloat32(o, true); pos[v * 3 + 1] = dv.getFloat32(o + 4, true); pos[v * 3 + 2] = dv.getFloat32(o + 8, true);
    uv[v * 2] = half(dv.getUint16(o + uvAt, true)); uv[v * 2 + 1] = half(dv.getUint16(o + uvAt + 2, true));
    if (bone && weight) {
      let rest = 1;
      for (let k = 0; k <= nw; k++) {
        bone[v * 4 + k] = u[o + 12 + k]!;
        const w = k < nw ? dv.getFloat32(o + 16 + k * 4, true) : rest;
        weight[v * 4 + k] = w; rest -= w;
      }
    }
  }
  const indices = vCount > 65535 || ib === 4 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  for (let i = 0; i < iCount; i++) {
    const x = ib === 2 ? dv.getUint16(iAt + i * 2, true) : dv.getUint32(iAt + i * 4, true);
    if (x >= vCount) throw new Error(`converted_model: индекс ${x} вне ${vCount} вершин`);
    indices[i] = x;
  }
  return { pos, uv, indices, count: vCount, stride, bone, weight };
}

export interface VostokMaterial { albedo?: string; normal?: string; smoothness?: string; metalness?: string; alphaTest?: boolean }

export function parseVostokMaterial(u: Uint8Array): VostokMaterial {
  const root = parseVostokConfig(u);
  const effect = tbl(tbl(tbl(root.material)?.g_stage)?.effect);
  const tex = (k: string) => { const v = tbl(effect?.[k])?.value; return typeof v === 'string' && v ? v : undefined; };
  // use_alpha_test — вырезание по альфе (трава, листва, сетки), порог alpha_ref
  const alphaTest = tbl(effect?.use_alpha_test)?.value === 1;
  return { albedo: tex('t_albedo'), normal: tex('t_normal'), smoothness: tex('t_smoothness'), metalness: tex('t_metalness'), ...(alphaTest ? { alphaTest } : {}) };
}

const texPath = (t: string) => `textures/${t}`;

const strList = (v: CfgValue | undefined): string[] =>
  (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter((x): x is string => typeof x === 'string');

/**
 * Части модели нужного LOD: render/<часть>/converted_model. Состав LOD — settings/lod_hierrarchy (LOD0/LOD1/LOD2 → surfaces,
 * unassigned — во всех); части, не упомянутые там, берутся, если по имени не похожи на дальний LOD. Без списка — по именам:
 * «lodN_…» — дальние (если других частей нет — берётся ближний «lodN_»).
 */
export function modelParts(arc: Archive, dir: string, settings: CfgTable | null = null, lod = 0) {
  const all = arc.entries.filter((e) => e.path.startsWith(dir + '/render/') && e.path.endsWith('/converted_model'))
    .map((e) => ({ entry: e, name: e.path.slice(dir.length + 8, -'/converted_model'.length) }))
    .filter((p) => !p.name.includes('/'));
  const h = tbl(settings?.lod_hierrarchy);
  if (h) {
    const levels = Object.keys(h).filter((k) => /^LOD\d+$/.test(k)).sort((a, b) => +a.slice(3) - +b.slice(3));
    const listed = new Set(Object.values(h).flatMap((v) => strList(tbl(v)?.surfaces)));
    const pick = (k: string | undefined) => new Set([...(k ? strList(tbl(h[k])?.surfaces) : []), ...strList(tbl(h.unassigned)?.surfaces)]);
    for (let l = Math.min(lod, levels.length - 1); l >= 0; l--) {
      const want = pick(levels[l]);
      const parts = all.filter((p) => want.has(p.name) || (!listed.has(p.name) && !/(^|_)lod_?\d/.test(p.name)));
      if (parts.length) return parts;
    }
  }
  const near = all.filter((p) => !/^lod\d+_/.test(p.name));
  if (near.length) return near;
  // у части моделей (участки рельефа, листы металла) все части — «lodN_…»: берём ближний уровень
  const lods = all.map((p) => +/^lod(\d+)_/.exec(p.name)![1]!);
  const min = Math.min(...lods);
  return all.filter((_, i) => lods[i] === min);
}

/** Скелет скиновой модели: <модель>/skeleton -> animations/skeletons/….skeleton (иерархия), render/bind_pose (поза, порядок костей в вершинах). */
async function readSkeletonRef(arc: Archive, dir: string): Promise<{ path: string; bones: VostokBone[]; bind: BindBone[] } | null> {
  const se = arc.lookup(dir + '/skeleton'), be = arc.lookup(dir + '/render/bind_pose');
  const ref = se ? parseVostokConfig(await arc.read(se)).skeleton : null;
  const path = typeof ref === 'string' ? normPath(ref).replace(/^resources\//, '') + '.skeleton' : '';
  const ske = path ? arc.lookup(path) : null;
  if (!ske || !be) return null;
  return { path, bones: parseSkeleton(await arc.read(ske)), bind: parseBindPose(await arc.read(be)) };
}

/** Меши модели-папки с материалами. bones — кости общего скелета (для скиновых частей), иначе статика. */
export async function modelMeshes(arc: Archive, dir: string, bones: VostokBone[] | null, bind: BindBone[] | null, lod = 0): Promise<{ meshes: Mesh[]; missing: string[]; parts: number; matsOk: boolean }> {
  const settingsE = arc.lookup(dir + '/settings');
  let settings: CfgTable | null = null;
  if (settingsE) { try { settings = parseVostokConfig(await arc.read(settingsE)); } catch { /* без материалов */ } }
  const matNames = tbl(settings?.material_settings);
  const parts = modelParts(arc, dir, settings, lod);
  if (!parts.length) throw new Error(`В ${dir} нет частей render/*/converted_model`);
  const idx = bones ? new Map(bones.map((b, i) => [b.name, i])) : null;
  const bindToNode = idx && bind ? bind.map((b) => idx.get(b.name) ?? 0) : null;
  const meshes: Mesh[] = [], missing: string[] = [];
  for (const p of parts) {
    const g = parseConvertedModel(await arc.read(p.entry));
    const n = g.count, bone = new Float32Array(n * 4), weight = new Float32Array(n * 4);
    const skinned = !!(bindToNode && g.bone && g.weight);
    if (skinned) {
      for (let i = 0; i < n * 4; i++) { bone[i] = bindToNode![g.bone![i]!] ?? 0; weight[i] = g.weight![i]!; }
    } else for (let i = 0; i < n; i++) weight[i * 4] = 1;
    const mesh: Mesh = { name: p.name, texture: '', vertexCount: n, pos: g.pos, nor: computeNormals(g.pos, g.indices), uv: g.uv, bone, weight, indices: g.indices, skinned };
    const mname = tbl(matNames?.[p.name])?.material_name;
    if (typeof mname === 'string' && mname) {
      mesh.material = mname;
      const me = arc.lookup(`material_instances/${normPath(mname)}.material`);
      if (me) {
        try {
          const m = parseVostokMaterial(await arc.read(me));
          if (m.albedo) mesh.texture = texPath(m.albedo);
          if (m.normal) mesh.normalMap = texPath(m.normal);
          if (m.alphaTest) mesh.alphaTest = true;
          if (m.smoothness || m.metalness) mesh.surface = { ...(m.smoothness ? { gloss: { map: texPath(m.smoothness), channel: 0 as const } } : {}), ...(m.metalness ? { metallic: { map: texPath(m.metalness), channel: 0 as const } } : {}), source: 'Survarium .material' };
        } catch { missing.push(mname); }
      } else missing.push(mname);
    }
    if (!mesh.texture) {
      const ep = arc.lookup(`${dir}/render/${p.name}/export_properties`);
      if (ep) { try { const t = tbl(parseVostokConfig(await arc.read(ep)).source)?.texture_name; if (typeof t === 'string') mesh.texture = texPath(t); } catch { /* нет имени */ } }
    }
    meshes.push(mesh);
  }
  return { meshes, missing, parts: parts.length, matsOk: !!matNames };
}

const missingInfo = (missing: string[]) => `Не найдены материалы: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`;

/** Анимации .b-spline к костям bones (чтение при выборе — listVostokMotions). */
function attachMotions(model: Model, arc: Archive, bones: VostokBone[], path: string): void {
  model.meta = { vostokSkeleton: path };
  model.loadMotions = async (file) => {
    const u = new Uint8Array(await file.arrayBuffer()), fp = file.path ?? file.name;
    const bn = arc.lookup(fp.replace(/\.b-spline$/, '.bones_names'));
    const names = bn ? boneNames(await arc.read(bn)) : [];
    return [buildMotion(file.name.replace(/\.b-spline$/, ''), u, names, bones)];
  };
}

export async function loadVostokModel(main: VFile, ctx: LoadContext): Promise<Model> {
  const u = new Uint8Array(await main.arrayBuffer());
  const text = new TextDecoder().decode(u.subarray(0, Math.min(u.length, 4096)));
  if (text.startsWith(OUTFIT_MARK)) return loadVostokOutfit(text, main, ctx);
  if (text.startsWith(LEVEL_MARK)) return (await import('./level')).loadVostokLevel(text, main, ctx);
  if (!text.startsWith(MODEL_MARK)) throw new Error('Откройте папку модели *.model / *.skinned_model из архивов resources.*.db');
  const dir = normPath(text.slice(MODEL_MARK.length));
  const arc = main.archive ?? ctx.archives.find((a) => a.lookup(dir));
  if (!arc) throw new Error('Модель Survarium открывается только из архивов resources.*.db');
  const info = [`Survarium (Vostok): ${dir.split('/').pop()}`];
  let sk: Awaited<ReturnType<typeof readSkeletonRef>> = null;
  if (dir.endsWith('.skinned_model')) {
    try {
      sk = await readSkeletonRef(arc, dir);
      info.push(sk ? `Скелет: ${sk.path} (${sk.bones.length} костей)` : 'Скелет не найден (нет .skeleton или bind_pose)');
    } catch (e) { info.push(`Скелет не прочитан: ${(e as Error).message}`); }
  }
  const r = await modelMeshes(arc, dir, sk?.bones ?? null, sk?.bind ?? null);
  info.splice(1, 0, `Частей: ${r.parts}${r.matsOk ? '' : ' (нет settings — материалы по export_properties)'}`);
  if (r.missing.length) info.push(missingInfo(r.missing));
  const skeleton = sk ? new NodeSkeleton(skeletonNodes(sk.bones, sk.bind)) : null;
  const model: Model = { meshes: r.meshes, skeleton, motions: [], bounds: skeleton ? skinnedBounds(skeleton, r.meshes) : boundsOf(r.meshes), info, flipZ: true };
  if (sk) attachMotions(model, arc, sk.bones, sk.path);
  return model;
}

/**
 * Комплект персонажа (запись «*.outfit» — см. db.ts): части одного комплекта (торс, ноги, ботинки, руки, шлем, маска, рюкзак)
 * и голова — на общем скелете; bind-позы частей объединяются по именам костей.
 */
async function loadVostokOutfit(text: string, main: VFile, ctx: LoadContext): Promise<Model> {
  const dirs = text.slice(OUTFIT_MARK.length).split('\n').map((s) => normPath(s.trim())).filter(Boolean);
  const arc = main.archive ?? ctx.archives.find((a) => a.lookup(dirs[0]!));
  if (!arc || !dirs.length) throw new Error('Комплект Survarium открывается только из архивов resources.*.db');
  const refs: Array<{ dir: string; sk: Awaited<ReturnType<typeof readSkeletonRef>> }> = [];
  for (const d of dirs) { try { refs.push({ dir: d, sk: await readSkeletonRef(arc, d) }); } catch { refs.push({ dir: d, sk: null }); } }
  const base = refs.find((r) => r.sk)?.sk;
  if (!base) throw new Error('У частей комплекта не найден скелет');
  // общая bind-поза: кости всех частей (первая встреча)
  const bind: BindBone[] = [], seen = new Set<string>();
  for (const r of refs) for (const b of r.sk?.path === base.path ? r.sk.bind : []) if (!seen.has(b.name)) { seen.add(b.name); bind.push(b); }
  const meshes: Mesh[] = [], missing: string[] = [], used: string[] = [], skipped: string[] = [];
  for (const r of refs) {
    if (!r.sk || r.sk.path !== base.path) { skipped.push(r.dir.split('/').pop()!); continue; }
    try {
      const m = await modelMeshes(arc, r.dir, base.bones, r.sk.bind);
      const label = r.dir.split('/').pop()!.replace(/\.skinned_model$/, '');
      for (const x of m.meshes) x.name = `${label} · ${x.name}`;
      meshes.push(...m.meshes); missing.push(...m.missing); used.push(label);
    } catch { skipped.push(r.dir.split('/').pop()!); }
  }
  if (!meshes.length) throw new Error('Части комплекта не прочитаны');
  const skeleton = new NodeSkeleton(skeletonNodes(base.bones, bind));
  const info = [`Survarium (Vostok): комплект ${main.name.replace(/\.outfit$/, '')}`, `Части: ${used.join(', ')}`, `Скелет: ${base.path} (${base.bones.length} костей)`];
  if (skipped.length) info.push(`Пропущены (другой скелет или не прочитаны): ${skipped.join(', ')}`);
  if (missing.length) info.push(missingInfo(missing));
  const model: Model = { meshes, skeleton, motions: [], bounds: skinnedBounds(skeleton, meshes), info, flipZ: true };
  attachMotions(model, arc, base.bones, base.path);
  return model;
}

/**
 * Анимации к скелету модели (данные читаются при выборе): у оружия — animations/single/weapons/<оружие>/item/…,
 * у персонажей (скелеты вне weapons/) — все …/player/… и прочие animations/single/…, кроме чужих item/.
 */
export function listVostokMotions(model: Model, archive: Archive): NodeMotion[] {
  const sk = model.meta?.vostokSkeleton as string | undefined;
  if (!sk || !model.loadMotions) return [];
  const m = /^animations\/skeletons\/weapons\/([^/.]+)/.exec(sk);
  const weapon = m ? m[1]! : null;
  const out: NodeMotion[] = [];
  for (const e of archive.entries) {
    if (!e.path.endsWith('.b-spline') || !e.path.startsWith('animations/single/')) continue;
    const rel = e.path.slice('animations/single/'.length);
    if (weapon ? !rel.startsWith(`weapons/${weapon}/item/`) : /\/item\//.test(rel) || rel.startsWith('fx/') || rel.startsWith('objects/')) continue;
    out.push({ kind: 'node', name: rel.replace(/\.b-spline$/, ''), tps: 30, chan: new Map(), duration: 0, load: async () => (await model.loadMotions!(archive.fileOf(e)))[0]! } as NodeMotion);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
