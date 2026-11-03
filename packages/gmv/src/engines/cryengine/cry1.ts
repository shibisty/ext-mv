// CryEngine 1 (Far Cry): контейнер «CryTek» версии 0x744 — .cgf (модели, персонажи), .cga (анимированные объекты), .caf (анимации).
// Заголовок: «CryTek\0\0», u32 тип файла (0xFFFF0000 — геометрия, 0xFFFF0001 — анимация), u32 версия 0x744, u32 смещение таблицы.
// Таблица: u32 число, записи {u32 тип, u32 версия, u32 смещение, u32 id}; размер чанка — до следующего чанка (или таблицы).
// Чанки (тип 0xCCCC00xx): 00 меш 0x744, 03 кости 0x290, 05 имена костей 0x745, 0B узел 0x823, 0C материал 0x746,
// 0D контроллер (0x826 — ключи узлов .cga, 0x827 — ключи костей .caf), 0E тайминг 0x918, 12 bind-позы костей.
// Единицы файлов — сантиметры (как в 3ds Max), ось Z вверх; при чтении переводятся в метры.
import { crc32 } from '../../core/writers/zip';
import { boundsOf, sumTris } from '../../core/geometry';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import { mulCol, rigidInv } from '../../core/math';
import type { Mesh, Model, NodeChannel, NodeMotion } from '../../core/types';

export const CRYTEK_MAGIC = 'CryTek';
const CT = { MESH: 0xcccc0000, BONEANIM: 0xcccc0003, BONENAMES: 0xcccc0005, NODE: 0xcccc000b, MTL: 0xcccc000c, CTRL: 0xcccc000d, TIMING: 0xcccc000e, BONEINIT: 0xcccc0012 } as const;
/** Метры из сантиметров файла. */
export const CRY1_SCALE = 0.01;

export interface Cry1Chunk { type: number; ver: number; off: number; id: number; size: number }
export interface Cry1File { fileType: number; chunks: Cry1Chunk[]; byId: Map<number, Cry1Chunk>; dv: DataView; u8: Uint8Array }

export const isCryTek = (u: Uint8Array): boolean => u.length >= 20 && String.fromCharCode(...u.subarray(0, 6)) === CRYTEK_MAGIC;

export function parseCry1(buf: ArrayBuffer | Uint8Array): Cry1File {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (!isCryTek(u8)) throw new Error('Не файл CryEngine 1 (нет сигнатуры CryTek)');
  const fileType = dv.getUint32(8, true), ver = dv.getUint32(12, true), tab = dv.getUint32(16, true);
  if (ver !== 0x744) throw new Error(`CryTek: версия 0x${ver.toString(16)} не поддерживается (нужна 0x744 — Far Cry)`);
  if (tab + 4 > u8.length) throw new Error('CryTek: таблица чанков за концом файла');
  const n = dv.getUint32(tab, true);
  if (n > 100000 || tab + 4 + n * 16 > u8.length) throw new Error('CryTek: неверная таблица чанков');
  const raw = Array.from({ length: n }, (_, i) => ({ type: dv.getUint32(tab + 4 + i * 16, true), ver: dv.getUint32(tab + 8 + i * 16, true), off: dv.getUint32(tab + 12 + i * 16, true), id: dv.getUint32(tab + 16 + i * 16, true), size: 0 }));
  const ends = [...raw.map((c) => c.off), tab].sort((a, b) => a - b);
  for (const c of raw) c.size = (ends.find((e) => e > c.off) ?? tab) - c.off;
  return { fileType, chunks: raw, byId: new Map(raw.map((c) => [c.id, c])), dv, u8 };
}

const cstr = (u8: Uint8Array, o: number, max: number) => { let e = o; while (e < o + max && e < u8.length && u8[e]) e++; return new TextDecoder('latin1').decode(u8.subarray(o, e)); };

// ---------- материалы ----------
export interface Cry1Mtl { name: string; shader: string; diffuse: string; bump: string; children: number[] }
/** Материал 0x746: имя «материал(шаблон шейдера)/тип поверхности», карты по 236 байт с 176 (окружение, диффузная, блик, прозрачность, рельеф…). */
export function readMtl(f: Cry1File, c: Cry1Chunk): Cry1Mtl {
  const full = cstr(f.u8, c.off + 16, 64), sh = /\(([^)]*)\)/.exec(full);
  // 0x746: слоты текстур по 236 байт с +176 (1 — diffuse, 4 — bump); старые 0x745: по 108 байт с +112 (1 — diffuse, 3 — opacity, 4 — bump)
  const old = c.ver === 0x745, base = old ? 112 : 176, stride = old ? 108 : 236, len = old ? 64 : 128;
  const tex = (slot: number) => (c.size >= base + (slot + 1) * stride ? cstr(f.u8, c.off + base + slot * stride, len).replace(/^\xff+/, '') : '');
  const nChildren = !old && c.size > 2552 ? (c.size - 2552) >> 2 : 0, children: number[] = [];
  for (let i = 0; i < nChildren; i++) children.push(f.dv.getInt32(c.off + 2552 + i * 4, true));
  return { name: full.replace(/\(.*$/, ''), shader: sh?.[1] ?? '', diffuse: nChildren ? '' : tex(1), bump: nChildren ? '' : tex(4), children };
}

// ---------- узлы ----------
export interface Cry1Node { id: number; name: string; object: number; parent: number; mtl: number; tm: number[]; pos: number[]; rot: number[]; scl: number[]; ctrl: [number, number, number] }
/** Узел 0x823: имя[64], объект, родитель, детей, материал, флаги, матрица 4×4 (строки, перенос в последней), позиция, поворот (x,y,z,w), масштаб, контроллеры. */
export function readNode(f: Cry1File, c: Cry1Chunk): Cry1Node {
  const d = f.dv, o = c.off, i32 = (k: number) => d.getInt32(o + k, true), f32 = (k: number) => d.getFloat32(o + k, true);
  return {
    id: c.id, name: cstr(f.u8, o + 16, 64), object: i32(80), parent: i32(84), mtl: i32(92),
    tm: Array.from({ length: 16 }, (_, k) => f32(100 + k * 4)), pos: [f32(164), f32(168), f32(172)], rot: [f32(176), f32(180), f32(184), f32(188)], scl: [f32(192), f32(196), f32(200)],
    ctrl: [i32(204), i32(208), i32(212)],
  };
}

// ---------- меш ----------
export interface Cry1Mesh {
  id: number; nv: number; pos: Float32Array; nor: Float32Array;
  faces: Int32Array; mat: Int32Array; uvs: Float32Array | null; tfaces: Int32Array | null;
  links: Array<Array<[bone: number, offset: number[], weight: number]>> | null;
}
/** Меш 0x744: флаги (кости, цвета), вершин, UV, граней; вершины {p, n}, грани {v0,v1,v2, материал, сглаживание}, UV, UV-грани, связи с костями. */
export function readMesh(f: Cry1File, c: Cry1Chunk): Cry1Mesh {
  const d = f.dv, o = c.off, end = c.off + c.size;
  const hasBones = f.u8[o + 16]!, nv = d.getInt32(o + 20, true), nt = d.getInt32(o + 24, true), nf = d.getInt32(o + 28, true);
  if (nv < 0 || nf < 0 || nt < 0 || o + 36 + nv * 24 + nf * 20 > end) throw new Error('CryTek: меш обрезан');
  let p = o + 36;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++, p += 24) for (let k = 0; k < 3; k++) { pos[i * 3 + k] = d.getFloat32(p + k * 4, true); nor[i * 3 + k] = d.getFloat32(p + 12 + k * 4, true); }
  const faces = new Int32Array(nf * 3), mat = new Int32Array(nf);
  for (let i = 0; i < nf; i++, p += 20) { faces[i * 3] = d.getInt32(p, true); faces[i * 3 + 1] = d.getInt32(p + 4, true); faces[i * 3 + 2] = d.getInt32(p + 8, true); mat[i] = d.getInt32(p + 12, true); }
  let uvs: Float32Array | null = null, tfaces: Int32Array | null = null;
  if (nt > 0 && p + nt * 8 + nf * 12 <= end) {
    uvs = new Float32Array(nt * 2);
    for (let i = 0; i < nt * 2; i++, p += 4) uvs[i] = d.getFloat32(p, true);
    tfaces = new Int32Array(nf * 3);
    for (let i = 0; i < nf * 3; i++, p += 4) tfaces[i] = d.getInt32(p, true);
  }
  // связи с костями; у части статики флаг костей стоит, а связей нет (после UV сразу цвета вершин или конец) — тогда без них
  let links: Cry1Mesh['links'] = null;
  if (hasBones && p + nv * 4 <= end) {
    const ls: NonNullable<Cry1Mesh['links']> = [];
    let q = p, ok = true;
    for (let i = 0; i < nv && ok; i++) {
      const n = q + 4 <= end ? d.getInt32(q, true) : -1; q += 4;
      if (n < 1 || n > 64 || q + n * 20 > end) { ok = false; break; }
      const l: Array<[number, number[], number]> = [];
      for (let k = 0; k < n; k++, q += 20) l.push([d.getInt32(q, true), [d.getFloat32(q + 4, true), d.getFloat32(q + 8, true), d.getFloat32(q + 12, true)], d.getFloat32(q + 16, true)]);
      ls.push(l);
    }
    if (ok) links = ls;
  }
  return { id: c.id, nv, pos, nor, faces, mat, uvs, tfaces, links };
}

// ---------- кости ----------
export interface Cry1Bone { name: string; parent: number; ctrl: number; bind: number[] }
/** Скелет: BoneAnim 0x290 (u32 число, записи по 152 байта: id, родитель, детей, id контроллера = CRC-32 имени), имена (0x745), bind-позы (0x12: u32 меш, u32 число, матрицы 4×3 по строкам, мировые). */
export function readBones(f: Cry1File): Cry1Bone[] | null {
  const ba = f.chunks.find((c) => c.type === CT.BONEANIM), bn = f.chunks.find((c) => c.type === CT.BONENAMES), bi = f.chunks.find((c) => c.type === CT.BONEINIT);
  if (!ba || !bn) return null;
  const d = f.dv, n = d.getUint32(ba.off + 16, true);
  if (!n || n > 1024 || ba.off + 20 + n * 152 > ba.off + ba.size) return null;
  const names: string[] = [];
  { let p = bn.off + 4; const e = bn.off + bn.size; for (let i = 0; i < d.getUint32(bn.off, true) && p < e; i++) { const s = cstr(f.u8, p, e - p); names.push(s); p += s.length + 1; } }
  const bones: Cry1Bone[] = [];
  for (let i = 0; i < n; i++) {
    const o = ba.off + 20 + i * 152, id = d.getInt32(o, true);
    bones[id] = { name: names[id] ?? `bone${id}`, parent: d.getInt32(o + 4, true), ctrl: d.getUint32(o + 12, true), bind: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] };
  }
  if (bi && d.getUint32(bi.off + 4, true) === n)
    for (let i = 0; i < n; i++) bones[i]!.bind = Array.from({ length: 12 }, (_, k) => d.getFloat32(bi.off + 8 + i * 48 + k * 4, true));
  return bones;
}

/** Матрица 4×3 по строкам (вектор-строка) → column-major 4×4, перенос в метрах. */
function rows43(m: ArrayLike<number>, scale = CRY1_SCALE): Float64Array {
  const o = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 3 + c]!; // строка r (ось) → столбец r
  o[12] = m[9]! * scale; o[13] = m[10]! * scale; o[14] = m[11]! * scale; o[15] = 1;
  return o;
}
/** Обратная аффинная матрица (column-major; узлы бывают с масштабом). */
function affineInv(m: ArrayLike<number>): Float64Array {
  const a = m[0]!, b = m[4]!, c = m[8]!, d = m[1]!, e = m[5]!, f = m[9]!, g = m[2]!, h = m[6]!, i = m[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1;
  const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
  const o = new Float64Array(16);
  // r — строки обратной 3×3: r[row*3+col]
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) o[col * 4 + row] = r[row * 3 + col]!;
  for (let row = 0; row < 3; row++) o[12 + row] = -(o[row]! * m[12]! + o[4 + row]! * m[13]! + o[8 + row]! * m[14]!);
  o[15] = 1;
  return o;
}

/** Матрица узла 4×4 по строкам → column-major, перенос в метрах. */
function rows44(m: ArrayLike<number>): Float64Array { return rows43([m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!, m[12]!, m[13]!, m[14]!]); }

// ---------- анимации ----------
/** Тайминг 0x918: секунд на тик, тиков на кадр, диапазон кадров. */
export function readTiming(f: Cry1File): { secsPerTick: number; ticksPerFrame: number; start: number; end: number } {
  const c = f.chunks.find((x) => x.type === CT.TIMING);
  if (!c) return { secsPerTick: 1 / 4800, ticksPerFrame: 160, start: 0, end: 0 };
  const d = f.dv;
  return { secsPerTick: d.getFloat32(c.off + 16, true) || 1 / 4800, ticksPerFrame: d.getInt32(c.off + 20, true) || 160, start: d.getInt32(c.off + 56, true), end: d.getInt32(c.off + 60, true) };
}

/** Кватернион [w,x,y,z] из логарифма (вектор поворота: ось · половина угла). */
const expQuat = (v: number[]): number[] => { const a = Math.hypot(v[0]!, v[1]!, v[2]!); if (a < 1e-12) return [1, 0, 0, 0]; const s = Math.sin(a) / a; return [Math.cos(a), v[0]! * s, v[1]! * s, v[2]! * s]; };

/**
 * Анимация .caf: контроллеры 0x827 {u32 ключей, u32 id = CRC-32 имени кости} и ключи {i32 время (тики), позиция, логарифм поворота}.
 * Поворот ключа в принятой у нас записи — сопряжённый (проверено по позе покоя персонажа: голова и таз совпадают с bind).
 */
export function readCaf(f: Cry1File, bones: readonly Cry1Bone[], name: string): NodeMotion {
  const t = readTiming(f), byCtrl = new Map(bones.map((b, i) => [b.ctrl, i])), chan = new Map<number, NodeChannel>();
  let maxT = 0;
  for (const c of f.chunks) {
    if (c.type !== CT.CTRL || c.ver !== 0x827) continue;
    const d = f.dv, nk = d.getUint32(c.off, true), id = d.getUint32(c.off + 4, true), bi = byCtrl.get(id);
    if (bi === undefined || c.off + 8 + nk * 28 > c.off + c.size) continue;
    const pos: Array<[number, number[]]> = [], rot: Array<[number, number[]]> = [];
    for (let k = 0; k < nk; k++) {
      const o = c.off + 8 + k * 28, time = d.getInt32(o, true) * t.secsPerTick;
      pos.push([time, [d.getFloat32(o + 4, true) * CRY1_SCALE, d.getFloat32(o + 8, true) * CRY1_SCALE, d.getFloat32(o + 12, true) * CRY1_SCALE]]);
      const q = expQuat([d.getFloat32(o + 16, true), d.getFloat32(o + 20, true), d.getFloat32(o + 24, true)]);
      rot.push([time, [q[0]!, -q[1]!, -q[2]!, -q[3]!]]);
      maxT = Math.max(maxT, time);
    }
    chan.set(bi, { pos, rot, scl: null });
  }
  const duration = Math.max(maxT, (t.end - t.start) * t.ticksPerFrame * t.secsPerTick);
  return { kind: 'node', name, tps: 1, chan, duration, frames: Math.round(duration * 30) + 1 };
}

/**
 * Анимация узлов .cga (контроллеры 0x826: тип, ключей, флаги, id): TCB3 (9) — {время, вектор, t, c, b, ein, eout},
 * TCBQ (10) — {время, ось·угол (x, y, z, угол), …}: поворот каждого ключа — относительно предыдущего (как TCB-ключи 3ds Max),
 * линейные 3 (3) — {время, вектор}, LinQ (4) — {время, кватернион}. Интерполяция — линейная/сферическая.
 */
function readNodeController(f: Cry1File, id: number, kind: 'pos' | 'rot' | 'scl', secsPerTick: number): Array<[number, number[]]> | null {
  const c = f.byId.get(id);
  if (!c || c.type !== CT.CTRL || c.ver !== 0x826) return null;
  const d = f.dv, type = d.getInt32(c.off + 16, true), nk = d.getInt32(c.off + 20, true), base = c.off + 32;
  const size = type === 9 ? 36 : type === 10 ? 40 : type === 3 ? 16 : type === 4 ? 20 : type === 6 ? 40 : 0;
  if (!size || nk <= 0 || base + nk * size > c.off + c.size) return null;
  const out: Array<[number, number[]]> = [];
  let acc = [1, 0, 0, 0];
  for (let k = 0; k < nk; k++) {
    const o = base + k * size, time = d.getInt32(o, true) * secsPerTick, v = [1, 2, 3, 4].map((j) => d.getFloat32(o + j * 4, true));
    if (kind === 'rot') {
      let q: number[];
      if (type === 10) { const h = v[3]! / 2, s = Math.sin(h); const dq = [Math.cos(h), v[0]! * s, v[1]! * s, v[2]! * s]; acc = qmul(acc, dq); q = acc; }
      else q = [v[3]!, v[0]!, v[1]!, v[2]!];
      out.push([time, [q[0]!, -q[1]!, -q[2]!, -q[3]!]]);
    } else out.push([time, kind === 'pos' ? [v[0]! * CRY1_SCALE, v[1]! * CRY1_SCALE, v[2]! * CRY1_SCALE] : [v[0]!, v[1]!, v[2]!]]);
  }
  return out;
}
const qmul = (a: number[], b: number[]): number[] => [
  a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]! - a[3]! * b[3]!,
  a[0]! * b[1]! + a[1]! * b[0]! + a[2]! * b[3]! - a[3]! * b[2]!,
  a[0]! * b[2]! - a[1]! * b[3]! + a[2]! * b[0]! + a[3]! * b[1]!,
  a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]! + a[3]! * b[0]!,
];

// ---------- модель ----------
/** Шаблоны шейдеров Far Cry, где альфа текстуры — прозрачность (листва, наклейки, стекло, вспышки); в «…GlossAlpha» альфа — блеск, не прозрачность. */
const CUTOUT = /plants|leaf|leaves|grass|fence|alphatest|alphablend|alphaadd|decal|glass|muzzle|flare|hologram/i;
export interface Cry1Options { /** Шаблоны шейдеров, которые не рисуются (NoDraw — служебная геометрия). */ hidden?: RegExp }

/** Модель .cgf/.cga: меши узлов (матрица узла), материалы по граням; персонаж — скелет и скининг по связям вершин с костями. */
export function cry1Model(buf: ArrayBuffer, name = ''): Model {
  const f = parseCry1(buf);
  if (f.fileType === 0xffff0001) throw new Error('Это анимация CryEngine 1 (.caf) — откройте модель персонажа, анимации подключаются из её .cal');
  const nodes = f.chunks.filter((c) => c.type === CT.NODE).map((c) => readNode(f, c));
  const mtls = new Map<number, Cry1Mtl>();
  for (const c of f.chunks) if (c.type === CT.MTL) try { mtls.set(c.id, readMtl(f, c)); } catch { /* битый материал */ }
  const bones = readBones(f), t = readTiming(f);
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
  // мировые матрицы узлов (матрица узла — относительно родителя)
  const world: Float64Array[] = [];
  const worldOf = (i: number, depth = 0): Float64Array => {
    if (world[i]) return world[i]!;
    const n = nodes[i]!, L = rows44(n.tm), pi = nodeIndex.get(n.parent);
    return (world[i] = pi !== undefined && depth < 64 ? mulCol(worldOf(pi, depth + 1), L) : L);
  };
  // анимированные узлы .cga — скелет из узлов (каждый меш привязан к своему узлу)
  // контроллеры узлов; анимированной модель считается, только если ключи действительно меняются (у части статики — по одному ключу)
  const ctrls = nodes.map((n) => (['pos', 'rot', 'scl'] as const).map((k, j) => readNodeController(f, n.ctrl[j]!, k, t.secsPerTick)));
  const moves = (k: Array<[number, number[]]> | null) => !!k && k.length > 1 && k.some(([, v]) => v.some((x, j) => Math.abs(x - k[0]![1][j]!) > 1e-4));
  const animated = !bones && ctrls.some((c) => c.some(moves));
  const skelNodes: SkeletonNode[] = [];
  if (bones) {
    const bindW = bones.map((b) => rows43(b.bind));
    bones.forEach((b, i) => {
      const L = b.parent >= 0 ? mulCol(rigidInv(bindW[b.parent]!), bindW[i]!) : bindW[i]!;
      skelNodes.push({ name: b.name, parent: b.parent, local: L, offset: rigidInv(bindW[i]!) });
    });
  } else if (animated) nodes.forEach((n, i) => { const W = worldOf(i), pi = nodeIndex.get(n.parent); skelNodes.push({ name: n.name, parent: pi ?? -1, local: pi !== undefined ? mulCol(affineInv(worldOf(pi)), W) : W, offset: affineInv(W) }); });

  // меши: по узлу, грани разложены по материалам; вершины разворачиваются по углам граней (UV — по своей сетке)
  const groups = new Map<string, { mtl: Cry1Mtl | null; P: number[]; N: number[]; U: number[]; B: number[]; W: number[]; I: number[] }>();
  let nMesh = 0;
  nodes.forEach((n, ni) => {
    const mc = f.byId.get(n.object);
    if (!mc || mc.type !== CT.MESH) return;
    const m = readMesh(f, mc);
    nMesh++;
    const M = worldOf(ni), nodeMtl = mtls.get(n.mtl) ?? null;
    // вершины в метрах: у персонажа — из связей с костями (как считает движок), иначе — матрицей узла
    const P = new Float32Array(m.nv * 3), N = new Float32Array(m.nv * 3), bw: Array<Array<[number, number]>> = [];
    for (let v = 0; v < m.nv; v++) {
      const x = m.pos[v * 3]!, y = m.pos[v * 3 + 1]!, z = m.pos[v * 3 + 2]!;
      const l = bones && m.links?.[v];
      if (l && l.length) {
        let sx = 0, sy = 0, sz = 0, sw = 0;
        for (const [b, off, w] of l) {
          const bb = bones[b]?.bind;
          if (!bb) continue;
          sx += w * (off[0]! * bb[0]! + off[1]! * bb[3]! + off[2]! * bb[6]! + bb[9]!); sy += w * (off[0]! * bb[1]! + off[1]! * bb[4]! + off[2]! * bb[7]! + bb[10]!); sz += w * (off[0]! * bb[2]! + off[1]! * bb[5]! + off[2]! * bb[8]! + bb[11]!); sw += w;
        }
        sw = sw || 1;
        P[v * 3] = (sx / sw) * CRY1_SCALE; P[v * 3 + 1] = (sy / sw) * CRY1_SCALE; P[v * 3 + 2] = (sz / sw) * CRY1_SCALE;
        bw.push(l.map(([b, , w]) => [b, w] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, 4));
      } else {
        const X = x * CRY1_SCALE, Y = y * CRY1_SCALE, Z = z * CRY1_SCALE;
        P[v * 3] = M[0]! * X + M[4]! * Y + M[8]! * Z + M[12]!; P[v * 3 + 1] = M[1]! * X + M[5]! * Y + M[9]! * Z + M[13]!; P[v * 3 + 2] = M[2]! * X + M[6]! * Y + M[10]! * Z + M[14]!;
        bw.push(animated ? [[ni, 1]] : []);
      }
      const nx = m.nor[v * 3]!, ny = m.nor[v * 3 + 1]!, nz = m.nor[v * 3 + 2]!;
      let ax = M[0]! * nx + M[4]! * ny + M[8]! * nz, ay = M[1]! * nx + M[5]! * ny + M[9]! * nz, az = M[2]! * nx + M[6]! * ny + M[10]! * nz;
      if (l && l.length) { ax = nx; ay = ny; az = nz; }
      const len = Math.hypot(ax, ay, az) || 1;
      N[v * 3] = ax / len; N[v * 3 + 1] = ay / len; N[v * 3 + 2] = az / len;
    }
    const mirror = M[0]! * (M[5]! * M[10]! - M[6]! * M[9]!) - M[4]! * (M[1]! * M[10]! - M[2]! * M[9]!) + M[8]! * (M[1]! * M[6]! - M[2]! * M[5]!) < 0;
    const nf = m.faces.length / 3;
    for (let fi = 0; fi < nf; fi++) {
      const sub = nodeMtl?.children.length ? mtls.get(nodeMtl.children[m.mat[fi]!] ?? -1) ?? null : nodeMtl;
      const key = `${ni}|${sub ? sub.name + '|' + sub.diffuse : 'none'}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { mtl: sub, P: [], N: [], U: [], B: [], W: [], I: [] }));
      const order = mirror ? [0, 2, 1] : [0, 1, 2];
      for (const k of order) {
        const v = m.faces[fi * 3 + k]!;
        if (v < 0 || v >= m.nv) continue;
        g.P.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!); g.N.push(N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!);
        const tv = m.tfaces ? m.tfaces[fi * 3 + k]! : -1;
        g.U.push(m.uvs && tv >= 0 && tv * 2 + 1 < m.uvs.length ? m.uvs[tv * 2]! : 0, m.uvs && tv >= 0 && tv * 2 + 1 < m.uvs.length ? 1 - m.uvs[tv * 2 + 1]! : 0);
        const w = bw[v]!;
        for (let j = 0; j < 4; j++) { g.B.push(w[j]?.[0] ?? 0); g.W.push(w[j]?.[1] ?? (j === 0 && !w.length ? 1 : 0)); }
        g.I.push(g.I.length);
      }
    }
  });
  if (!nMesh) throw new Error('В файле CryEngine 1 нет мешей');
  const hidden = /^(nodraw|nouvmap|tbd)$/i;
  const meshes: Mesh[] = [...groups.values()].filter((g) => g.I.length).map((g, i) => {
    const n = g.P.length / 3, sh = g.mtl?.shader ?? '', tex = (g.mtl?.diffuse ?? '').replace(/\\/g, '/');
    // одинаковые вершины (позиция, нормаль, UV, кости) склеиваются
    const key = new Map<string, number>(), P: number[] = [], N: number[] = [], U: number[] = [], B: number[] = [], W: number[] = [], I: number[] = [];
    for (let v = 0; v < n; v++) {
      const k = `${g.P[v * 3]},${g.P[v * 3 + 1]},${g.P[v * 3 + 2]},${g.N[v * 3]!.toFixed(4)},${g.N[v * 3 + 1]!.toFixed(4)},${g.N[v * 3 + 2]!.toFixed(4)},${g.U[v * 2]},${g.U[v * 2 + 1]}`;
      let idx = key.get(k);
      if (idx === undefined) {
        idx = P.length / 3; key.set(k, idx);
        P.push(g.P[v * 3]!, g.P[v * 3 + 1]!, g.P[v * 3 + 2]!); N.push(g.N[v * 3]!, g.N[v * 3 + 1]!, g.N[v * 3 + 2]!); U.push(g.U[v * 2]!, g.U[v * 2 + 1]!);
        for (let j = 0; j < 4; j++) { B.push(g.B[v * 4 + j]!); W.push(g.W[v * 4 + j]!); }
      }
      I.push(idx);
    }
    const nv = P.length / 3, skinned = !!skelNodes.length;
    return {
      name: `${g.mtl?.name || 'mesh ' + i}${sh ? ' · ' + sh : ''}`, texture: tex, shader: sh, normalMap: g.mtl?.bump ? g.mtl.bump.replace(/\\/g, '/') : undefined,
      vertexCount: nv, pos: Float32Array.from(P), nor: Float32Array.from(N), uv: Float32Array.from(U),
      bone: skinned ? Float32Array.from(B) : new Float32Array(nv * 4), weight: skinned ? Float32Array.from(W) : new Float32Array(nv * 4).map((_, k) => (k % 4 === 0 ? 1 : 0)),
      indices: nv > 65535 ? Uint32Array.from(I) : Uint16Array.from(I), skinned,
      ...(hidden.test(sh) || /nodraw/i.test(tex) ? { defaultHidden: true } : {}), ...(CUTOUT.test(sh) && !/bark/i.test(sh) ? { alphaTest: true } : {}),
    } as Mesh;
  });
  const skeleton = skelNodes.length ? new NodeSkeleton(skelNodes) : null;
  const motions: NodeMotion[] = [];
  if (animated) {
    const chan = new Map<number, NodeChannel>();
    let dur = 0;
    nodes.forEach((n, i) => {
      const [pos, rot, scl] = ctrls[i]!;
      if (!pos && !rot && !scl) return;
      for (const k of [pos, rot, scl]) for (const [tt] of k ?? []) dur = Math.max(dur, tt);
      chan.set(i, { pos, rot, scl });
    });
    if (chan.size) motions.push({ kind: 'node', name: 'анимация объекта', tps: 1, chan, duration: dur || 1, frames: Math.round(dur * 30) + 1 });
  }
  const info = [
    `CryEngine 1 (Far Cry, 0x744): ${name}`,
    `Узлов ${nodes.length}, мешей ${nMesh}, материалов ${mtls.size}; частей ${meshes.length}, вершин ${meshes.reduce((a, m) => a + m.vertexCount, 0)}, треугольников ${sumTris(meshes)}`,
  ];
  if (bones) info.push(`Костей: ${bones.length} (bind-позы из BoneInitialPos)`);
  if (animated) info.push(`Анимированные узлы (.cga): ${motions[0]?.chan.size ?? 0}`);
  return { meshes, skeleton, motions, bounds: boundsOf(meshes), flipZ: false, defaultZUp: true, cameraYaw: 0, info, meta: { cry1Bones: bones ?? undefined } };
}

/** CRC-32 имени кости — id контроллера в .caf. */
export const cry1CtrlId = (name: string): number => crc32(new TextEncoder().encode(name)) >>> 0;

/** Список анимаций .cal: строки «имя = путь.caf» (путь — от Objects/Characters/Animations), «//» — комментарии. */
export function parseCal(text: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.replace(/\/\/.*$/, '').trim(), m = /^([^=\s#$]+)\s*=\s*(\S+\.caf)\s*$/i.exec(s);
    if (m) out.push({ name: m[1]!, path: m[2]!.replace(/\\/g, '/') });
  }
  return out;
}
