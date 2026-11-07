// Модели Enfusion (.xob, «FORM»/«XOB9»): HEAD — строки, материалы (.emat), кости, описания LOD; LODS — данные LOD цепочками
// LZ4 (блоки {u24 размер, u8 флаг: бит 7 — последний}, словарь — предыдущий вывод).
// Секция LOD (один материал): индексы u16 ×3T, ещё раз те же треугольники по «касательным» вершинам, позиции float×3
// (+ u32 индекс веса у скиннинга), нормали 11:11:10, цвета BGRA (флаг 0x20000000), UV snorm16 в границах набора,
// касательные вершины {u32 вершина, по 8 байт на набор UV}, веса {4×u8 кость палитры, 3×f32}.
// Раскладка — по открытому разбору arma-file-formats-rs (как справке), код свой. Оси: Y вверх, левая система → flipZ.
import { boundsOf, skinnedBounds, sumTris, sumVerts } from '../../core/geometry';
import type { NodeSkeleton } from '../../core/skeleton';
import type { NodeLayer, NodeMotion } from '../../core/types';
import { anmMotion, parseAnm, xobSkeleton, type Anm } from './anm';
import type { LoadContext } from '../../core/plugin';
import type { DecodedImage, Mesh, Model, VFile } from '../../core/types';
import { lz4Chain } from './edds';
import { loadEmat, type EnfMaterial } from './emat';

export const XOB_SKINNED = 0x10000000, XOB_COLORS = 0x20000000;

export interface XobSection {
  /** Имя секции (объекта) из таблицы строк: младшие 16 бит первого поля (Basebody_Torso, Body_NoSkin, Barrel). */
  name: string;
  format: number; tris: number; verts: number; tverts: number; weights: number; material: number;
  uvSets: Array<{ u0: number; u1: number; v0: number; v1: number }>; palette: number[];
}
export interface XobLod { factor: number; offset: number; csize: number; size: number; sections: XobSection[] }
export interface XobBone { name: string; t: [number, number, number]; q: [number, number, number, number]; next: number; child: number }
export interface XobHead { /** радиус модели (из заголовка) */ radius: number; strings: string[]; materials: Array<{ name: string; path: string }>; bones: XobBone[]; lods: XobLod[] }

const tag4 = (u: Uint8Array, p: number) => String.fromCharCode(u[p]!, u[p + 1]!, u[p + 2]!, u[p + 3]!);
const be32 = (u: Uint8Array, p: number) => ((u[p]! << 24) | (u[p + 1]! << 16) | (u[p + 2]! << 8) | u[p + 3]!) >>> 0;

export function xobChunks(u: Uint8Array): Map<string, { off: number; size: number }> {
  if (tag4(u, 0) !== 'FORM' || tag4(u, 8) !== 'XOB9') throw new Error(tag4(u, 0) === 'FORM' ? `XOB: версия ${tag4(u, 8)} не поддерживается` : 'Не модель Enfusion (нет FORM/XOB9)');
  const end = Math.min(u.length, be32(u, 4) + 8), out = new Map<string, { off: number; size: number }>();
  let p = 12;
  while (p + 8 <= end) {
    const t = tag4(u, p), size = be32(u, p + 4);
    out.set(t, { off: p + 8, size });
    p += 8 + size;
  }
  return out;
}

export function parseXobHead(u: Uint8Array, off: number): XobHead {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const radius = dv.getFloat32(off + 40, true);
  let p = off + 44;
  const nMat = dv.getUint16(p, true), nBone = dv.getUint16(p + 2, true), nLod = u[p + 4]!, nPoint = u[p + 5]!, nVol = dv.getUint32(p + 8, true), strSize = dv.getUint32(p + 12, true);
  p += 16;
  const strings = new TextDecoder().decode(u.subarray(p, p + strSize)).replace(/\0$/, '').split('\0');
  p += strSize;
  const str = (i: number) => strings[i] ?? '';
  const materials = [];
  for (let i = 0; i < nMat; i++, p += 4) materials.push({ name: str(dv.getUint16(p, true)), path: str(dv.getUint16(p + 2, true)) });
  const bones: XobBone[] = [];
  for (let i = 0; i < nBone; i++, p += 36) {
    const f = (k: number) => dv.getFloat32(p + 4 + k * 4, true);
    bones.push({ name: str(dv.getUint32(p, true)), t: [f(0), f(1), f(2)], q: [f(3), f(4), f(5), f(6)], next: dv.getUint16(p + 32, true), child: dv.getUint16(p + 34, true) });
  }
  p += nPoint * 12;
  const lods: XobLod[] = [];
  for (let l = 0; l < nLod; l++) {
    // у немногих моделей перед описаниями LOD есть ещё несколько байт (неизвестное поле) — ищем метку рядом
    if (tag4(u, p) !== 'LZO4' && l === 0) { for (let k = 1; k <= 64; k++) if (tag4(u, p + k) === 'LZO4') { p += k; break; } }
    if (tag4(u, p) !== 'LZO4') throw new Error(`XOB: описание LOD ${l} не найдено`);
    const nSec = dv.getUint32(p + 4, true), factor = dv.getFloat32(p + 12, true), nBB = dv.getUint32(p + 16, true);
    const lod: XobLod = { factor, offset: dv.getUint32(p + 20, true), csize: dv.getUint32(p + 24, true), size: dv.getUint32(p + 28, true), sections: [] };
    p += 32;
    for (let s = 0; s < nSec; s++) {
      const format = dv.getUint32(p, true);
      const q = p + 44, nUv = u[q + 14]!, nPal = u[q + 15]!;
      const sec: XobSection = {
        name: (() => { const n = str(format & 0xffff); return n.startsWith('{') ? '' : n; })(),
        format, tris: dv.getUint16(q, true) | (dv.getUint16(q + 18, true) << 16), verts: dv.getUint16(q + 2, true), tverts: dv.getUint16(q + 4, true),
        weights: dv.getUint16(q + 6, true), material: dv.getUint16(q + 12, true), uvSets: [], palette: [],
      };
      p = q + 20;
      for (let k = 0; k < nUv; k++, p += 20) sec.uvSets.push({ u0: dv.getFloat32(p, true), u1: dv.getFloat32(p + 4, true), v0: dv.getFloat32(p + 8, true), v1: dv.getFloat32(p + 12, true) });
      for (let k = 0; k < nPal; k++) sec.palette.push(u[p++]!);
      lod.sections.push(sec);
    }
    p += nBB * 28;
    lods.push(lod);
  }
  void nVol;
  return { radius: Number.isFinite(radius) && radius > 0 ? radius : 1, strings, materials, bones, lods };
}

/** Размер секции в распакованных данных LOD. */
export function sectionSize(s: XobSection): number {
  const sk = (s.format & XOB_SKINNED) !== 0, uv = s.uvSets.length;
  return s.tris * 12 + s.verts * ((sk ? 16 : 12) + 4 + (s.format & XOB_COLORS ? 4 : 0) + 4 * uv) + s.tverts * (4 + 8 * Math.max(1, uv)) + (sk ? s.weights * 16 : 0);
}

export interface XobGeometry { pos: Float32Array; nor: Float32Array; uv: Float32Array; uv2?: Float32Array; indices: Uint16Array | Uint32Array; bone?: Float32Array; weight?: Float32Array }

const unpackN = (v: number, out: Float32Array, o: number) => {
  let x = (v >>> 21) / 1023 - 1, y = ((v >>> 10) & 0x7ff) / 1023 - 1, z = (v & 0x3ff) / 511 - 1;
  const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
  out[o] = x; out[o + 1] = y; out[o + 2] = z;
};

/** Распаковать LOD и разобрать секции. */
export function readXobLod(u: Uint8Array, lod: XobLod): XobGeometry[] {
  const data = new Uint8Array(lod.size);
  lz4Chain(u, lod.offset, data, 0x80);
  const dv = new DataView(data.buffer);
  const out: XobGeometry[] = [];
  let p = 0;
  for (const s of lod.sections) {
    const start = p, sk = (s.format & XOB_SKINNED) !== 0, nUv = s.uvSets.length, n = s.verts;
    const idx = new Uint16Array(s.tris * 3);
    for (let i = 0; i < idx.length; i++) idx[i] = dv.getUint16(p + i * 2, true);
    p += s.tris * 12; // оба набора индексов
    const pos = new Float32Array(n * 3), wIdx = sk ? new Uint32Array(n) : null;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = dv.getFloat32(p, true); pos[i * 3 + 1] = dv.getFloat32(p + 4, true); pos[i * 3 + 2] = dv.getFloat32(p + 8, true);
      if (wIdx) wIdx[i] = dv.getUint32(p + 12, true);
      p += sk ? 16 : 12;
    }
    const nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++, p += 4) unpackN(dv.getUint32(p, true), nor, i * 3);
    if (s.format & XOB_COLORS) p += n * 4;
    const uvs = s.uvSets.map(() => new Float32Array(n * 2));
    for (let i = 0; i < n; i++) for (let k = 0; k < nUv; k++, p += 4) {
      const set = s.uvSets[k]!, a = (dv.getInt16(p, true) / 32767) * 0.5 + 0.5, b = (dv.getInt16(p + 2, true) / 32767) * 0.5 + 0.5;
      uvs[k]![i * 2] = set.u0 + (set.u1 - set.u0) * a; uvs[k]![i * 2 + 1] = set.v0 + (set.v1 - set.v0) * b;
    }
    p += s.tverts * (4 + 8 * Math.max(1, nUv));
    let bone: Float32Array | undefined, weight: Float32Array | undefined;
    if (sk) {
      const wb = p; p += s.weights * 16;
      bone = new Float32Array(n * 4); weight = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const w = wIdx![i]!;
        if (w >= s.weights) { weight[i * 4] = 1; continue; }
        const q = wb + w * 16, a = dv.getFloat32(q + 4, true), b = dv.getFloat32(q + 8, true), c = dv.getFloat32(q + 12, true);
        const ws = [a, b, c, Math.max(0, 1 - a - b - c)];
        for (let k = 0; k < 4; k++) { bone[i * 4 + k] = s.palette[data[q + k]!] ?? 0; weight[i * 4 + k] = ws[k]!; }
      }
    }
    if (p - start !== sectionSize(s)) throw new Error('XOB: размер секции не сходится');
    out.push({ pos, nor, uv: uvs[0] ?? new Float32Array(n * 2), uv2: uvs[1], indices: idx, bone, weight });
  }
  if (p !== data.length) throw new Error(`XOB: данные LOD ${p} из ${data.length} байт`);
  return out;
}

export interface XobMeshes { head: XobHead; meshes: Mesh[]; noTexture: string[]; lodCount: number; /** имена секций, по мешам */ sections: string[] }

/** Меши старшего LOD с материалами. remap — замена материала по имени (MeshObject.Materials префаба). */
export async function xobMeshes(u: Uint8Array, ctx: LoadContext, remap?: Map<string, string>, lodIndex = 0): Promise<XobMeshes> {
  const ch = xobChunks(u), head = ch.get('HEAD');
  if (!head) throw new Error('XOB: нет чанка HEAD');
  const h = parseXobHead(u, head.off);
  if (!h.lods.length) throw new Error('XOB: в модели нет LOD (только коллизии)');
  const lod = h.lods[Math.max(0, Math.min(h.lods.length - 1, lodIndex))]!, geo = readXobLod(u, lod);
  const mats = new Map<number, EnfMaterial | null>(), meshes: Mesh[] = [], noTexture: string[] = [], sections: string[] = [];
  const secNames = new Set(lod.sections.map((s) => s.name.toLowerCase()));
  for (const [i, s] of lod.sections.entries()) {
    const g = geo[i]!, m = h.materials[s.material];
    const path = (m && remap?.get(m.name)) || m?.path;
    if (!mats.has(s.material)) {
      const mt = path ? await loadEmat(path, ctx).catch(() => null) : null;
      mats.set(s.material, mt);
      if (!mt?.image) noTexture.push(path?.replace(/^\{[0-9A-F]+\}/i, '') ?? '?');
    }
    const mat = mats.get(s.material) ?? null;
    const n = s.verts;
    const mesh: Mesh = {
      name: s.name && s.name !== m?.name ? `${s.name} (${m?.name ?? s.material})` : `${m?.name ?? 'материал ' + s.material}`, texture: mat?.texturePath ?? path ?? '', material: path, vertexCount: n,
      pos: g.pos, nor: g.nor, uv: g.uv, bone: g.bone ?? new Float32Array(n * 4), weight: g.weight ?? new Float32Array(n * 4).map((_, k) => (k % 4 ? 0 : 1)), indices: g.indices, skinned: !!g.bone,
    };
    if (mat?.uvSet === 1 && g.uv2) mesh.uv = g.uv2;
    if (mat?.image) mesh.image = mat.image as DecodedImage;
    else mesh.color = mat?.color ?? [0.7, 0.7, 0.7];
    if (mat?.normal) mesh.normalImage = mat.normal;
    if (mat?.surface) mesh.surface = mat.surface;
    if (mat?.alphaTest) mesh.alphaTest = true;
    // служебные материалы и наклейки без текстуры закрыли бы поверхность сплошным цветом
    if (mat?.hidden || (!mat?.image && (/Decal/.test(mat?.cls ?? '') || /decal|graffiti/i.test(path ?? '')))) mesh.defaultHidden = true;
    // ранения тела: «Basebody_Torso_wound» рядом с «Basebody_Torso» — показывается целая версия
    if (/_wound$/i.test(s.name) && secNames.has(s.name.toLowerCase().replace(/_wound$/, ''))) mesh.defaultHidden = true;
    meshes.push(mesh);
    sections.push(s.name);
  }
  return { head: h, meshes, noTexture, lodCount: h.lods.length, sections };
}

export async function loadXob(main: VFile, ctx: LoadContext): Promise<Model> {
  const u = new Uint8Array(await main.arrayBuffer());
  const { head: h, meshes, noTexture } = await xobMeshes(u, ctx);
  const info: string[] = [];
  if (!meshes.some((m) => !m.defaultHidden)) for (const m of meshes) delete m.defaultHidden;
  const shown = meshes.filter((m) => !m.defaultHidden);
  // скелет и анимации — у моделей со скинингом
  let skeleton: NodeSkeleton | null = null, motions: NodeMotion[] = [];
  if (h.bones.length && meshes.some((m) => m.skinned)) {
    try { skeleton = xobSkeleton(h); motions = listAnms(ctx, skeleton, main.path ?? ''); } catch (e) { info.push(`Скелет не построен: ${(e as Error).message}`); }
  }
  if (!skeleton) for (const m of meshes) m.skinned = false;
  info.unshift(`Enfusion XOB: LOD 1 из ${h.lods.length}, секций ${meshes.length}, вершин ${sumVerts(meshes)}, треугольников ${sumTris(meshes)}${h.bones.length ? `, костей ${h.bones.length}` : ''}${skeleton ? `, анимаций в списке ${motions.length}` : ''}`);
  if (noTexture.length) info.push(`Без текстуры (цвет материала): ${noTexture.slice(0, 6).join(', ')}${noTexture.length > 6 ? '…' : ''}`);
  return { meshes, skeleton, motions, bounds: skeleton ? skinnedBounds(skeleton, shown.length ? shown : meshes) : boundsOf(shown.length ? shown : meshes), flipZ: true, info };
}

/**
 * Анимации .anm для скелета (читаются при выборе). Имена в игре: p_* — анимации персонажа (лежат и в папках оружия,
 * техники, предметов), m_* / i_* — самого оружия / предмета (кости w_* / i_*), животные — anims/anm/animals/<вид>.
 * У людей (кости Hips/Spine1/Head): anims/anm/** кроме животных и w_/v_/m_/i_*, и p_*.anm из assets/**; у остального — .anm из папки
 * ассета (Assets/<раздел>/<вид>/<модель>/…) кроме p_*; у животных — ещё anims/anm/animals/**.
 * При загрузке проверяется, что кости анимации есть в скелете (иначе — ошибка вместо «разваленной» позы).
 */
export function anmFits(path: string, human: boolean, animal: boolean, prefix: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  // *_ADD — аддитивные слои (дыхание, наклоны): сами по себе дают «разваленную» позу
  if (/_add\.anm$/i.test(base)) return false;
  // *_offset — опорные точки IK движка в координатах модели, не анимации
  if (/_offset\.anm$/i.test(base)) return false;
  if (human) {
    if (/^[wvmi]_/.test(base)) return false; // анимации оружия, техники, предметов, лежащие рядом с анимациями персонажа
    if (path.startsWith('anims/anm/')) return !path.startsWith('anims/anm/animals/');
    return path.startsWith('assets/') && !path.startsWith('assets/animals/') && base.startsWith('p_');
  }
  if (animal && path.startsWith('anims/anm/animals/')) return true;
  return path.startsWith(prefix) && !base.startsWith('p_');
}

/** Доля костей анимации, найденных в скелете (служебные Scene_Root/EntityPosition/Collision/*_IK_Target не считаются). */
export function anmCoverage(a: Anm, boneIndex: Map<string, number>): { hit: number; total: number } {
  let hit = 0, total = 0;
  for (const t of a.tracks) {
    const n = t.name.toLowerCase();
    if (n === 'scene_root' || n === 'entityposition' || n === 'collision' || n.endsWith('_ik_target')) continue;
    total++;
    if (boneIndex.has(n)) hit++;
  }
  return { hit, total };
}

/**
 * Служебные позы IK («*_offset»: голова и кисть в координатах модели, 1,5 м над землёй) — не анимации:
 * у не корневой кости перенос намного длиннее её собственной кости.
 */
export function anmIsModelSpace(a: Anm, sk: NodeSkeleton, boneIndex: Map<string, number>): string | null {
  for (const t of a.tracks) {
    if (t.additive || !t.pos.length) continue;
    const n = t.name.toLowerCase(), i = boneIndex.get(n);
    // служебные кости (опоры предметов, цели IK, камера, коллизия, корни) законно уходят далеко — смотрим только кожу
    if (i === undefined || /^(scene_root|entityposition|hips|root)$|prop|ik|target|camera|collision|weapon/.test(n)) continue;
    const node = sk.nodes[i]!, L = node.local, bind = Math.hypot(L[12]!, L[13]!, L[14]!), v = t.pos[0]![1];
    if (Math.hypot(v[0]!, v[1]!, v[2]!) > Math.max(0.5, bind * 4)) return t.name;
  }
  return null;
}

/** Слои игрока: сетки прицеливания (aimspace), дыхание, аддитивные `_ADD`. */
const LAYER_RE = /aimspace|breath|_add\.anm$|\/layered\//i;

export function listAnms(ctx: LoadContext, sk: NodeSkeleton, modelPath: string, grip?: string): NodeMotion[] {
  const names = new Set(sk.nodes.map((n) => n.name.toLowerCase())), human = names.has('hips') && names.has('spine1') && names.has('head');
  const parts = modelPath.toLowerCase().split('/');
  const animal = !human && parts[0] === 'assets' && parts[1] === 'animals';
  const prefix = human ? 'anims/anm/' : parts.slice(0, Math.min(parts.length - 1, 4)).join('/') + '/';
  if (!human && parts.length < 3) return [];
  const boneIndex = new Map(sk.nodes.map((n, i) => [n.name.toLowerCase(), i]));
  // верх тела — Spine1 и всё, что ниже его по дереву (слой прицеливания не трогает ноги и таз основной анимации)
  const upper = new Set<number>(), s1 = boneIndex.get('spine1');
  if (s1 !== undefined) sk.nodes.forEach((_, i) => { for (let k = i, g = 0; k >= 0 && g < 256; k = sk.nodes[k]!.parent, g++) if (k === s1) { upper.add(i); break; } });
  // сетка прицеливания 3×3: строки — наклон (0 вниз, 2 вверх), столбцы — поворот корпуса (0 вправо, 2 влево);
  // полная поза стойки (ноги и таз тоже: при повороте ноги перекрещиваются), середина — прицел прямо
  const asLayer = (m: NodeMotion): Omit<NodeLayer, 'motion'> => (/aimspace/i.test(m.name)
    ? (m.frames === 9 ? { grid: { cols: 3, rows: 3, x: 1, y: 1 } } : { frame: Math.max(0, Math.floor(((m.frames ?? 1) - 1) / 2)), mask: upper })
    : /_ik$/i.test(m.name) ? { frame: 0, fill: true } : {}); // хват оружия: RightHandProp и пальцы, если их нет в анимации
  const mk = (a: LoadContext['archives'][number], e: LoadContext['archives'][number]['entries'][number], layer: boolean): NodeMotion => {
    const name = (e.path.startsWith('anims/anm/') ? e.path.slice(10) : e.path).replace(/\.anm$/, '');
    return {
      kind: 'node', name, tps: 30, chan: new Map(), duration: 0, source: e.path,
      ...(layer ? { asLayer } : {}),
      load: async () => {
        const anm = parseAnm(await a.read(e)), c = anmCoverage(anm, boneIndex);
        // животное на человеке, анимация оружия на персонаже и т. п.: костей скелета в анимации почти нет
        if (!c.total || c.hit < c.total * 0.6) throw new Error(`анимация не для этого скелета: найдено костей ${c.hit} из ${c.total}`);
        if (anmIsModelSpace(anm, sk, boneIndex)) throw new Error('это служебная поза для IK движка (точки в координатах модели), а не анимация');
        const r = anmMotion(anm, name, boneIndex, sk);
        if (layer) r.asLayer = asLayer;
        return r;
      },
    } as NodeMotion;
  };
  const out: NodeMotion[] = [], pool: NodeMotion[] = [], seen = new Set<string>();
  for (const a of ctx.archives) for (const e of a.entries) {
    if (!e.path.endsWith('.anm') || seen.has(e.path)) continue;
    const fits = anmFits(e.path, human, animal, prefix);
    const isLayer = human && ((LAYER_RE.test(e.path) && e.path.startsWith('anims/anm/player/') && !/_offset\.anm$/i.test(e.path)) || e.path === grip);
    if (!fits && !isLayer) continue;
    seen.add(e.path);
    if (fits) out.push(mk(a, e, false));
    if (isLayer) pool.push(mk(a, e, true));
  }
  // свои анимации персонажа (anims/anm/…) — первыми, анимации из папок предметов, оружия и техники — после
  const rank = (m: NodeMotion) => (m.name.startsWith('assets/') ? 1 : 0);
  out.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
  pool.sort((x, y) => x.name.localeCompare(y.name));
  if (pool.length) {
    const byBase = new Map(pool.map((p) => [p.name.slice(p.name.lastIndexOf('/') + 1).toLowerCase(), p.name]));
    const gripName = grip ? pool.find((p) => p.source === grip)?.name : undefined;
    for (const m of out) {
      m.layerPool = pool; m.layerAuto = [...(gripName ? [gripName] : []), ...autoAimLayer(m.name, byBase)];
      const load = m.load!;
      m.load = async () => { const r = (await load()) as NodeMotion; r.layerPool = m.layerPool; r.layerAuto = m.layerAuto; return r; };
    }
  }
  return out;
}

/**
 * Слой прицеливания для позы игрока: p_<оружие>_<стойка>_…_<ras|ads|low> → p_<оружие>_<стойка>_aimspace_body_<режим>
 * или p_<оружие>_<стойка>_aimspace_<режим> (Reforger держит корпус к цели этим слоем).
 */
export function autoAimLayer(name: string, byBase: Map<string, string>): string[] {
  const b = name.slice(name.lastIndexOf('/') + 1).toLowerCase(), m = /^p_([a-z0-9]+)_(erc|cro|pne)_.*?(ras|ads|low)(?:_|$)/.exec(b);
  if (!m || /aimspace/.test(b)) return [];
  for (const c of [`p_${m[1]}_${m[2]}_aimspace_body_${m[3]}`, `p_${m[1]}_${m[2]}_aimspace_${m[3]}`]) { const hit = byBase.get(c); if (hit) return [hit]; }
  return [];
}
