// Модели 4A Engine (Metro 2033): meshes/<…>.model, .mesh, .skeleton.
// Всё — чанки (u32 id, u32 размер). Модель: 0x01 заголовок (u16 версия, u16 шейдер?, AABB, сфера), 0x09 — меши
// (вложенные чанки 0, 1, 2…: 0x01 заголовок, 0x02 «текстура\0шейдер\0материал», 0x03 или 0x05 — вершины, 0x04 — индексы u16).
// 0x03 (статика): u32 тип, u32 число, вершины по 32 байта: позиция f32×3, нормаль/касательная/бинормаль D3DCOLOR, UV f32×2.
// 0x05 (скин): u8 n, n номеров костей скелета, n×60 байт (OBB костей), u32 число, вершины по 32 байта:
//   позиция s16×3 / 2720 (+ s16), нормаль, касательная, бинормаль, u8×4 кости (номер в таблице × 3), u8×4 веса, UV s16×2 / 2048.
// Скиновая .model: 0x14 имя скелета, 0x10 — u32 число LOD и строки имён мешей (через запятую) -> meshes/<имя>.mesh.
// .skeleton: 0x0d — u32 crc, u16 число костей; кость: имя, родитель, углы f32×3, позиция f32×3, u16.
// Поворот кости = Ry(y)·Rx(x)·Rz(z) (подобрано по геометрии: суставы лежат на осях конечностей), система левосторонняя, Y вверх.
// Вершины меша уже в позе привязки.
import { boundsOf, skinnedBounds } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { Archive, Mesh, Model, NodeMotion, VFile } from '../../core/types';
import { metroMotionHeader, parseMetroMotion } from './motion';

interface Chunk { id: number; data: Uint8Array }
export function metroChunks(u: Uint8Array): Chunk[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out: Chunk[] = [];
  for (let p = 0; p + 8 <= u.length;) {
    const id = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > u.length) break;
    out.push({ id, data: u.subarray(p + 8, p + 8 + size) });
    p += 8 + size;
  }
  return out;
}
const dvOf = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.byteLength);
const cstrs = (u: Uint8Array) => new TextDecoder('windows-1251').decode(u).split('\0');
const nrm = (dv: DataView, o: number, out: number[]) => {
  const x = (dv.getUint8(o + 2) / 255) * 2 - 1, y = (dv.getUint8(o + 1) / 255) * 2 - 1, z = (dv.getUint8(o) / 255) * 2 - 1, l = Math.hypot(x, y, z) || 1;
  out.push(x / l, y / l, z / l);
};

export interface MetroPart {
  texture: string; shader: string; material: string;
  pos: number[]; nor: number[]; uv: number[]; idx: number[];
  /** Для скина: по 4 номера костей скелета и веса на вершину. */
  bones?: number[]; weights?: number[];
}

/** Меши из содержимого чанка 0x09. */
export function parseMetroMeshes(model9: Uint8Array): MetroPart[] {
  const out: MetroPart[] = [];
  for (const m of metroChunks(model9)) {
    const sub = metroChunks(m.data), tx = sub.find((c) => c.id === 2), sv = sub.find((c) => c.id === 3), dvb = sub.find((c) => c.id === 5);
    const vbIdx = sub.findIndex((c) => c.id === 3 || c.id === 5), ib = vbIdx >= 0 ? sub[vbIdx + 1] : undefined;
    if ((!sv && !dvb) || !ib) continue;
    const [texture = '', shader = '', material = ''] = tx ? cstrs(tx.data) : [];
    const part: MetroPart = { texture, shader, material, pos: [], nor: [], uv: [], idx: [] };
    if (sv) {
      const d = dvOf(sv.data), n = d.getUint32(4, true);
      for (let i = 0; i < n && 8 + i * 32 + 32 <= sv.data.length; i++) {
        const o = 8 + i * 32;
        part.pos.push(d.getFloat32(o, true), d.getFloat32(o + 4, true), d.getFloat32(o + 8, true));
        nrm(d, o + 12, part.nor);
        part.uv.push(d.getFloat32(o + 24, true), d.getFloat32(o + 28, true));
      }
    } else {
      const u = dvb!.data, d = dvOf(u), nb = u[0]!, remap = Array.from(u.subarray(1, 1 + nb)), base = 1 + nb * 61, n = d.getUint32(base, true);
      part.bones = []; part.weights = [];
      for (let i = 0; i < n && base + 4 + i * 32 + 32 <= u.length; i++) {
        const o = base + 4 + i * 32;
        part.pos.push(d.getInt16(o, true) / 2720, d.getInt16(o + 2, true) / 2720, d.getInt16(o + 4, true) / 2720);
        nrm(d, o + 8, part.nor);
        let ws = 0;
        for (let k = 0; k < 4; k++) ws += u[o + 24 + k]!;
        for (let k = 0; k < 4; k++) { part.bones.push(remap[Math.floor(u[o + 20 + k]! / 3)] ?? 0); part.weights.push(ws ? u[o + 24 + k]! / ws : k === 0 ? 1 : 0); }
        part.uv.push(d.getInt16(o + 28, true) / 2048, d.getInt16(o + 30, true) / 2048);
      }
    }
    const d = dvOf(ib.data), c1 = d.getUint16(0, true), c2 = d.getUint16(2, true), max = (ib.data.length - 4) >> 1;
    const ni = Math.min(c2 ? c1 * 3 : max, max), nv = part.pos.length / 3;
    for (let i = 0; i < ni; i++) { const v = d.getUint16(4 + i * 2, true); part.idx.push(v < nv ? v : 0); }
    out.push(part);
  }
  return out;
}

export interface MetroBone { name: string; parent: string; rot: number[]; pos: number[] }

/** Кости скелета; crc (u32 в начале чанка 0x0d) совпадает с crc в анимациях, motionFolders — папки motions (чанк 0x13). */
export function parseMetroSkeletonInfo(u: Uint8Array): { bones: MetroBone[]; crc: number; motionFolders: string[] } {
  const all = metroChunks(u), c = all.find((x) => x.id === 0x0d), m = all.find((x) => x.id === 0x13);
  const crc = c && c.data.length >= 4 ? dvOf(c.data).getUint32(0, true) : 0;
  const motionFolders = m ? (cstrs(m.data)[0] ?? '').split(',').map((x) => x.trim().toLowerCase().replace(/\\/g, '/')).filter(Boolean) : [];
  return { bones: parseMetroSkeleton(u), crc, motionFolders };
}

export function parseMetroSkeleton(u: Uint8Array): MetroBone[] {
  const c = metroChunks(u).find((x) => x.id === 0x0d);
  if (!c) throw new Error('В .skeleton нет чанка костей');
  const d = dvOf(c.data), n = d.getUint16(4, true), out: MetroBone[] = [], dec = new TextDecoder('windows-1251');
  let p = 6;
  const sz = () => { let e = p; while (e < c.data.length && c.data[e]) e++; const s = dec.decode(c.data.subarray(p, e)); p = e + 1; return s; };
  for (let i = 0; i < n && p < c.data.length; i++) {
    const name = sz(), parent = sz();
    const rot = [0, 1, 2].map((k) => d.getFloat32(p + k * 4, true)), pos = [0, 1, 2].map((k) => d.getFloat32(p + 12 + k * 4, true));
    p += 26;
    out.push({ name, parent, rot, pos });
  }
  return out;
}

/** Локальная матрица кости (column-major): Ry(y)·Rx(x)·Rz(z) и перенос. */
export function metroBoneLocal(rot: number[], pos: number[]): Float64Array {
  const [x, y, z] = rot as [number, number, number];
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  // R = Ry * Rx * Rz, элементы r[строка][столбец]
  const r = [
    [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
    [cx * sz, cx * cz, -sx],
    [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx],
  ];
  const m = new Float64Array(16);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) m[col * 4 + row] = r[row]![col]!;
  m[12] = pos[0]!; m[13] = pos[1]!; m[14] = pos[2]!; m[15] = 1;
  return m;
}

function skeletonNodes(bones: MetroBone[]): SkeletonNode[] {
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const parent = bones.map((b) => index.get(b.parent) ?? -1);
  const local = bones.map((b) => metroBoneLocal(b.rot, b.pos)), world: Float64Array[] = new Array(bones.length);
  const mul = (a: Float64Array, b: Float64Array) => {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    return o;
  };
  const visit = (i: number, depth = 0): Float64Array => {
    if (world[i]) return world[i]!;
    const p = parent[i]!;
    return (world[i] = p >= 0 && depth < 256 ? mul(visit(p, depth + 1), local[i]!) : local[i]!);
  };
  return bones.map((b, i) => {
    const w = visit(i), inv = new Float64Array(16);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) inv[c * 4 + r] = w[r * 4 + c]!;
    for (let r = 0; r < 3; r++) inv[12 + r] = -(w[r * 4]! * w[12]! + w[r * 4 + 1]! * w[13]! + w[r * 4 + 2]! * w[14]!);
    inv[15] = 1;
    return { name: b.name, parent: parent[i]!, local: local[i]!, offset: inv };
  });
}

export function partsToMeshes(parts: MetroPart[], skinned: boolean, keepEmpty = false): Mesh[] {
  return parts.filter((p) => keepEmpty || p.idx.length).map((p) => {
    const n = p.pos.length / 3, bone = new Float32Array(n * 4), weight = new Float32Array(n * 4);
    if (skinned && p.bones) { bone.set(p.bones); weight.set(p.weights!); } else for (let i = 0; i < n; i++) weight[i * 4] = 1;
    return {
      name: p.texture || '?', texture: p.texture, shader: p.shader, material: p.material, vertexCount: n,
      pos: Float32Array.from(p.pos), nor: Float32Array.from(p.nor), uv: Float32Array.from(p.uv), bone, weight,
      indices: n > 65535 ? Uint32Array.from(p.idx) : Uint16Array.from(p.idx), skinned: skinned && !!p.bones,
      alphaTest: /aref|wallmark|alpha/i.test(p.shader) || undefined,
      defaultHidden: /^\$|^light\\/i.test(p.texture) || undefined,
    };
  });
}

/** Корень «…/meshes/» по пути файла внутри архива или папки. */
export function meshesRoot(path: string): string {
  const p = path.toLowerCase().replace(/\\/g, '/'), i = p.lastIndexOf('meshes/');
  return i >= 0 ? path.slice(0, i + 7) : '';
}

export interface MetroModelData {
  parts: MetroPart[];
  bones: MetroBone[] | null;
  skeletonCrc: number;
  /** Папки анимаций относительно content/motions (из .skeleton). */
  motionFolders: string[];
  skeletonName: string;
  meshNames: string[];
  missing: string[];
}

/**
 * Разобрать .model/.mesh; для скиновой модели прочитать .mesh и .skeleton через read(путь относительно meshes/, с расширением).
 */
export async function readMetroModel(u: Uint8Array, read: (rel: string) => Promise<Uint8Array | null>): Promise<MetroModelData> {
  const top = metroChunks(u), res: MetroModelData = { parts: [], bones: null, skeletonCrc: 0, motionFolders: [], skeletonName: '', meshNames: [], missing: [] };
  const m9 = top.find((c) => c.id === 9);
  if (m9) res.parts.push(...parseMetroMeshes(m9.data));
  const sk = top.find((c) => c.id === 0x14), names = top.find((c) => c.id === 0x10);
  if (sk) res.skeletonName = cstrs(sk.data)[0] ?? '';
  if (names && names.data.length > 4) {
    const lods = cstrs(names.data.subarray(4)), lod0 = lods.find((s) => s) ?? '';
    res.meshNames = lod0.split(',').map((s) => s.trim()).filter(Boolean);
    for (const nm of res.meshNames) {
      const rel = nm.toLowerCase().replace(/\\/g, '/') + '.mesh', mu = await read(rel);
      if (!mu) { res.missing.push(rel); continue; }
      const c9 = metroChunks(mu).find((c) => c.id === 9);
      if (c9) res.parts.push(...parseMetroMeshes(c9.data));
    }
  }
  if (res.skeletonName) {
    const rel = res.skeletonName.toLowerCase().replace(/\\/g, '/') + '.skeleton', su = await read(rel);
    if (su) { const info = parseMetroSkeletonInfo(su); res.bones = info.bones; res.skeletonCrc = info.crc; res.motionFolders = info.motionFolders; } else res.missing.push(rel);
  }
  return res;
}

/** Кости в порядке «родитель раньше потомка» (в файле — по алфавиту) и перестановка старый номер -> новый. */
function topoOrder(bones: MetroBone[]): { sorted: MetroBone[]; remap: number[] } {
  const index = new Map(bones.map((b, i) => [b.name, i])), seen = new Uint8Array(bones.length), order: number[] = [];
  const visit = (i: number, depth = 0) => {
    if (seen[i]) return;
    seen[i] = 1;
    const p = index.get(bones[i]!.parent);
    if (p !== undefined && depth < 256) visit(p, depth + 1);
    order.push(i);
  };
  bones.forEach((_, i) => visit(i));
  const remap = new Array<number>(bones.length);
  order.forEach((old, nw) => { remap[old] = nw; });
  return { sorted: order.map((i) => bones[i]!), remap };
}

export function metroModelFromData(d: MetroModelData, name: string): Model {
  const skinned = !!d.bones && d.parts.some((p) => p.bones);
  const topo = skinned ? topoOrder(d.bones!) : null;
  const meshes = partsToMeshes(d.parts, skinned);
  if (topo) for (const m of meshes) if (m.skinned) for (let i = 0; i < m.bone.length; i++) m.bone[i] = topo.remap[m.bone[i]!] ?? 0;
  if (!meshes.length) throw new Error(`В модели 4A нет геометрии${d.missing.length ? ` (не найдены: ${d.missing.join(', ')})` : ''}`);
  const sk = topo ? new NodeSkeleton(skeletonNodes(topo.sorted)) : null;
  const tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  const info = [
    `Модель 4A (Metro 2033): ${name}`,
    `Мешей ${meshes.length}, вершин ${meshes.reduce((a, m) => a + m.vertexCount, 0)}, треугольников ${tris}`,
    ...(d.skeletonName ? [`Скелет ${d.skeletonName}: костей ${d.bones?.length ?? 0}`] : []),
    ...(d.meshNames.length ? [`Части: ${d.meshNames.join(', ')}`] : []),
    ...(d.missing.length ? [`Не найдены: ${d.missing.join(', ')} — откройте content.vfi или папку content`] : []),
  ];
  const model: Model = { meshes, skeleton: sk, motions: [], bounds: sk ? skinnedBounds(sk, meshes) : boundsOf(meshes), flipZ: true, info };
  if (topo) {
    const remap = (b: number) => topo.remap[b] ?? -1;
    model.meta = { metroSkeletonCrc: d.skeletonCrc, metroMotionFolders: d.motionFolders };
    model.loadMotions = async (file) => {
      const u = new Uint8Array(await file.arrayBuffer()), h = metroMotionHeader(u);
      if (d.skeletonCrc && h.skeletonCrc !== d.skeletonCrc) throw new Error(`анимация для другого скелета (crc ${h.skeletonCrc.toString(16)}, нужен ${d.skeletonCrc.toString(16)})`);
      return [parseMetroMotion(u, file.name.replace(/\.motion$/i, ''), remap)];
    };
  }
  return model;
}

/**
 * Анимации скелета из архива: motions/<папка из .skeleton>/**.motion. Список длинный (у людей ~2000), поэтому
 * анимации подгружаются при выборе (Motion.load).
 */
export function listMetroMotions(model: Model, archive: Archive, root: string): NodeMotion[] {
  const folders = (model.meta?.metroMotionFolders as string[] | undefined) ?? [];
  if (!folders.length || !model.loadMotions) return [];
  const prefixes = folders.map((f) => `${root}motions/${f.replace(/\/+$/, '')}/`), out: NodeMotion[] = [];
  for (const e of archive.entries) {
    if (!e.path.endsWith('.motion')) continue;
    const pre = prefixes.find((x) => e.path.startsWith(x));
    if (!pre) continue;
    const name = e.path.slice(pre.length).replace(/\.motion$/, '');
    out.push({
      kind: 'node', name, tps: 30, chan: new Map(), duration: 0,
      load: async () => (await model.loadMotions!(archive.fileOf(e)))[0]!,
    } as NodeMotion);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadMetroModel(main: VFile, ctx: LoadContext): Promise<Model> {
  const root = meshesRoot(main.path ?? '');
  const read = async (rel: string) => {
    const full = await ctx.readPath(root + rel);
    if (full) return full;
    const sib = await ctx.sibling(rel.split('/').pop()!);
    return sib ? new Uint8Array(sib) : null;
  };
  const d = await readMetroModel(new Uint8Array(await main.arrayBuffer()), read);
  return metroModelFromData(d, main.path ?? main.name);
}
