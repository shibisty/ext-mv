// Модели LithTech Jupiter EX (F.E.A.R. Online): .mdl (MODL v42 — узлы, анимации, сокеты, куски и LOD) + .mesh (геометрия).
// Разобрано по файлам игры, без внешних описаний.
//
// .mdl: «MODL», u32 42, 18×u32 (в т.ч. [0x10] число узлов, [0x24] размер таблицы строк), таблица строк с 0x50 (строки выровнены по 4),
// u32 × [0x4c] (команды анимаций), узлы по 37 байт в порядке обхода в глубину [u32 имя, u8, f32×3 позиция, f32×4 кватернион x,y,z,w, u32 число детей];
// далее анимации и сокеты; в конце — имена кусков, 10×u32 счётчиков, u16 длина + путь .mesh, 0 и 3 байта, затем
//   палитры костей секций (байты, всего [0]; номера — в порядке имён узлов в таблице строк), u16 × [1] (номера записей LOD), записи по 5×u32 × [2]
//   [кусок, начало палитры, длина палитры, номер секции .mesh, число секций], уровни LOD по 12 байт × [3]
//   [f32 дистанция, u32 первая запись (в u16-списке), u32 число записей]. Уровни идут группами с убывающей дистанцией;
//   LOD0 — уровень с дистанцией 0; если есть уровень 0.1, то он (0 у моделей игрока — вид от первого лица, без головы).
// .mesh: «MESH», u32 1, u32 1, u32 число секций, u32 число объявлений вершин, u32, u32 размер данных, u32 N + N байт палитр костей, u32 число секций,
//   u32 байт вершин, u32 байт индексов, вершины, индексы u16, объявления вершин
//   [u32 число элементов, элементы по 4 байта: поток, тип (1 float2, 2 float3, 3 float4, 4 4×u8, 8 2×s16 норм.), назначение, номер],
//   u32 число секций и секции по 9×u32 [0, вершин, первый индекс, первая вершина (в шагах своего объявления), треугольников,
//   номер материала, длина палитры костей, её начало в палитрах, объявление].
// Назначения элементов: 0 позиция, 1 нормаль, 2 касательная, 3 бинормаль, 4 UV, 5 цвет, 6 веса (D3DCOLOR), 7 индексы костей.
// Система координат левая (Y вверх, Z вперёд), единица — сантиметр.
import { boundsOf } from '../../core/geometry';
import type { Mesh, Model } from '../../core/types';

const TYPE_SIZE: Record<number, number> = { 1: 8, 2: 12, 3: 16, 4: 4, 8: 4 };

export interface LtNode { name: string; parent: number; pos: [number, number, number]; rot: [number, number, number, number]; nameOff: number }
export interface LtAnimRec { name: string; off: number; times: number[] }
export interface LtMdl {
  nodes: LtNode[];
  /**
   * Узлы в порядке их имён в таблице строк: в этом порядке нумеруются кости в палитрах .mesh и .mdl
   * и строки таблицы треков .anim.
   */
  nameOrder: number[];
  /** Анимации (данные — в одноимённом .anim). */
  anims: LtAnimRec[];
  meshPath: string | null;
  /** Секции .mesh ближнего LOD (без теней). */
  lod0: number[];
  /** Группы уровней LOD: секции каждого уровня. */
  lodGroups: Array<Array<{ dist: number; sections: number[] }>>;
  /** Палитры костей записей LOD (объединение палитр секций): номер секции -> узлы. */
  palettes: Map<number, number[]>;
  pieces: string[];
  /** Номер секции .mesh -> имя куска. */
  sectionPiece: Map<number, string>;
}

export function parseMdl(u: Uint8Array): LtMdl {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 0x50 || String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'MODL') throw new Error('Не модель LithTech (нет «MODL»)');
  const ver = dv.getUint32(4, true);
  if (ver !== 42) throw new Error(`MODL версии ${ver} не поддерживается (известна 42 — F.E.A.R. Online)`);
  const nNodes = dv.getUint32(0x10, true), nPieces = dv.getUint32(0x14, true), ss = dv.getUint32(0x24, true);
  const S = 0x50, str = (o: number) => { let s = ''; for (let k = S + o; k < S + ss && u[k]; k++) s += String.fromCharCode(u[k]!); return s; };
  const nodes: LtNode[] = [];
  // перед узлами — таблица команд анимаций (u32 × [0x4c])
  let p = S + ss + 4 * dv.getUint32(0x4c, true);
  if (p + nNodes * 37 > u.length) throw new Error('MODL: узлы выходят за конец файла');
  const stack: Array<{ i: number; left: number }> = [];
  for (let i = 0; i < nNodes; i++, p += 37) {
    while (stack.length && stack[stack.length - 1]!.left === 0) stack.pop();
    const parent = stack.length ? stack[stack.length - 1]!.i : -1;
    if (stack.length) stack[stack.length - 1]!.left--;
    const f = (k: number) => dv.getFloat32(p + k, true);
    const nameOff = dv.getUint32(p, true);
    nodes.push({ name: str(nameOff), parent, pos: [f(5), f(9), f(13)], rot: [f(17), f(21), f(25), f(29)], nameOff });
    stack.push({ i, left: dv.getUint32(p + 33, true) });
  }
  const anims: LtAnimRec[] = [];
  try {
    let a = p + 4;
    for (let k = 0, n = dv.getUint32(0x0c, true); k < n; k++) {
      a += 12;
      const name = str(dv.getUint32(a, true)), off = dv.getUint32(a + 8, true), nk = dv.getUint32(a + 20, true);
      a += 24;
      if (a + nk * 4 > u.length || nk > 100000) throw new Error('обрезано');
      const times: number[] = [];
      for (let t = 0; t < nk; t++) times.push(dv.getUint32(a + t * 4, true) & 0xffffff);
      a += nk * 4;
      anims.push({ name, off, times });
    }
  } catch { anims.length = 0; }
  const nameOrder = nodes.map((_, i) => i).sort((a, b) => nodes[a]!.nameOff - nodes[b]!.nameOff);
  const res: LtMdl = { nodes, nameOrder, anims, meshPath: null, lod0: [], lodGroups: [], palettes: new Map(), pieces: [], sectionPiece: new Map() };
  // путь .mesh: u16 длина + строка, оканчивающаяся на «.mesh» и нулём
  let j = -1;
  for (let k = u.length - 6; k > p; k--) {
    if (u[k] === 0x2e && u[k + 1] === 0x6d && u[k + 2] === 0x65 && u[k + 3] === 0x73 && u[k + 4] === 0x68 && u[k + 5] === 0) { j = k + 5; break; }
  }
  if (j < 0) return res; // набор анимаций без геометрии
  let st = j;
  while (st > p && u[st - 1]! >= 32) st--;
  const len = j - st;
  if (dv.getUint16(st - 2, true) !== len) return res;
  res.meshPath = String.fromCharCode(...u.subarray(st, j));
  const cnt = Array.from({ length: 10 }, (_, k) => dv.getUint32(st - 2 - 40 + k * 4, true));
  for (let k = 0; k < nPieces; k++) res.pieces.push(str(dv.getUint32(st - 2 - 40 - nPieces * 4 + k * 4, true)));
  let q = j + 1 + 3;
  const pal = u.subarray(q, q + cnt[0]!); q += cnt[0]!;
  const list = Array.from({ length: cnt[1]! }, (_, k) => dv.getUint16(q + k * 2, true)); q += cnt[1]! * 2;
  const recs = Array.from({ length: cnt[2]! }, (_, k) => Array.from({ length: 5 }, (_, m) => dv.getUint32(q + k * 20 + m * 4, true))); q += cnt[2]! * 20;
  const lods = Array.from({ length: cnt[3]! }, (_, k) => ({ dist: dv.getFloat32(q + k * 12, true), first: dv.getUint32(q + k * 12 + 4, true), n: dv.getUint32(q + k * 12 + 8, true) }));
  if (q + cnt[3]! * 12 > u.length) throw new Error('MODL: таблица LOD выходит за конец файла');
  for (const r of recs) for (let s = 0; s < (r[4] || 1); s++) {
    res.palettes.set(r[3]! + s, Array.from(pal.subarray(r[1]!, r[1]! + r[2]!), (b) => res.nameOrder[b] ?? b));
    if (res.pieces[r[0]!]) res.sectionPiece.set(r[3]! + s, res.pieces[r[0]!]!);
  }
  // группы уровней: дистанции убывают, новая группа — когда дистанция не меньше предыдущей
  const groups: Array<typeof lods> = [];
  for (const l of lods) {
    const g = groups[groups.length - 1];
    if (g && l.dist < g[g.length - 1]!.dist) g.push(l); else groups.push([l]);
  }
  const secs = (l: (typeof lods)[number]) => {
    const out: number[] = [];
    for (let k = l.first; k < l.first + l.n; k++) {
      const r = recs[list[k]!];
      if (r) for (let s = 0; s < (r[4] || 1); s++) out.push(r[3]! + s);
    }
    return out;
  };
  const sel = new Set<number>();
  for (const g of groups) {
    res.lodGroups.push(g.map((l) => ({ dist: l.dist, sections: secs(l) })));
    // если рядом с уровнем 0 есть уровень 0.1, то 0 — вид от первого лица (у моделей игрока без головы): берём 0.1
    const pos = g.filter((l) => l.dist > 0 && l.dist < 1), from = pos.length ? pos : g;
    const best = from.reduce((a, b) => (b.dist < a.dist ? b : a));
    for (const k of secs(best)) sel.add(k);
  }
  res.lod0 = [...sel].sort((a, b) => a - b);
  return res;
}

export interface LtSection { vcount: number; istart: number; vstart: number; tris: number; material: number; palCount: number; palOff: number; decl: number }
export interface LtMeshData {
  sections: LtSection[];
  decls: Array<Array<{ type: number; usage: number; index: number }>>;
  /** Палитры костей секций подряд (номера — в порядке имён узлов .mdl). */
  palettes: Uint8Array;
  u: Uint8Array;
  vAt: number;
  iAt: number;
}

export function parseMesh(u: Uint8Array): LtMeshData {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 40 || String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'MESH') throw new Error('Не геометрия LithTech (нет «MESH»)');
  const fb = dv.getUint32(28, true);
  let p = 32 + fb;
  const vb = dv.getUint32(p + 4, true), ib = dv.getUint32(p + 8, true);
  p += 12;
  const vAt = p, iAt = p + vb;
  let t = iAt + ib;
  if (t + 8 > u.length) throw new Error('MESH: данные выходят за конец файла');
  const nd = dv.getUint32(t, true); t += 4;
  const decls: LtMeshData['decls'] = [];
  for (let k = 0; k < nd; k++) {
    const n = dv.getUint32(t, true); t += 4;
    const els = [];
    for (let e = 0; e < n; e++, t += 4) els.push({ type: u[t + 1]!, usage: u[t + 2]!, index: u[t + 3]! });
    decls.push(els);
  }
  const ns = dv.getUint32(t, true); t += 4;
  const sections: LtSection[] = [];
  for (let k = 0; k < ns; k++, t += 36) {
    const w = (m: number) => dv.getUint32(t + m * 4, true);
    sections.push({ vcount: w(1), istart: w(2), vstart: w(3), tris: w(4), material: w(5), palCount: w(6), palOff: w(7), decl: w(8) });
  }
  if (t > u.length) throw new Error('MESH: таблица секций обрезана');
  return { sections, decls, palettes: u.subarray(32, 32 + fb), u, vAt, iAt };
}

export interface LtSectionMesh { section: number; material: number; mesh: Mesh }

/** Геометрия секции как в файле (левая система; модель помечается flipZ). */
export function sectionMesh(m: LtMeshData, k: number, palette: number[] | undefined): LtSectionMesh | null {
  const s = m.sections[k]!, els = m.decls[s.decl];
  if (!els) throw new Error(`MESH: секция ${k} ссылается на объявление ${s.decl}`);
  let stride = 0;
  const at: Record<number, { off: number; type: number }> = {};
  for (const e of els) {
    const sz = TYPE_SIZE[e.type];
    if (sz === undefined) throw new Error(`MESH: неизвестный тип элемента вершины ${e.type}`);
    if (e.index === 0 && !(e.usage in at)) at[e.usage] = { off: stride, type: e.type };
    stride += sz;
  }
  if (!at[0] || !at[4]) return null; // тени и служебная геометрия без UV
  const { u } = m, dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (m.iAt + (s.istart + s.tris * 3) * 2 > u.length) throw new Error(`MESH: индексы секции ${k} выходят за границы данных`);
  // индексы — от первой вершины секции; у секций мира несколько секций делят один участок вершин,
  // и vcount — число вершин, а не размах индексов: берём вершины от наименьшего до наибольшего индекса
  const idx = new Uint16Array(s.tris * 3);
  let lo = 0xffff, hi = 0;
  for (let i = 0; i < idx.length; i++) { const v = dv.getUint16(m.iAt + (s.istart + i) * 2, true); idx[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!idx.length) return null;
  const n = hi - lo + 1, base = m.vAt + (s.vstart + lo) * stride;
  if (base + n * stride > m.iAt) throw new Error(`MESH: вершины секции ${k} выходят за границы данных`);
  if (lo) for (let i = 0; i < idx.length; i++) idx[i] -= lo;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), bone = new Float32Array(n * 4), weight = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const o = base + v * stride, P = o + at[0].off;
    pos[v * 3] = dv.getFloat32(P, true); pos[v * 3 + 1] = dv.getFloat32(P + 4, true); pos[v * 3 + 2] = dv.getFloat32(P + 8, true);
    if (at[1]) { const N = o + at[1].off; nor[v * 3] = dv.getFloat32(N, true); nor[v * 3 + 1] = dv.getFloat32(N + 4, true); nor[v * 3 + 2] = dv.getFloat32(N + 8, true); }
    const T = o + at[4].off;
    if (at[4].type === 8) { uv[v * 2] = dv.getInt16(T, true) / 32767; uv[v * 2 + 1] = dv.getInt16(T + 2, true) / 32767; }
    else { uv[v * 2] = dv.getFloat32(T, true); uv[v * 2 + 1] = dv.getFloat32(T + 4, true); }
    if (at[6] && at[7] && palette?.length) {
      const W = o + at[6].off, I = o + at[7].off, wb = [u[W + 2]!, u[W + 1]!, u[W]!, u[W + 3]!];
      let sum = 0;
      for (let c = 0; c < 4; c++) sum += wb[c]!;
      for (let c = 0; c < 4; c++) { bone[v * 4 + c] = palette[u[I + c]!] ?? 0; weight[v * 4 + c] = sum ? wb[c]! / sum : c === 0 ? 1 : 0; }
    } else { bone[v * 4] = palette?.[0] ?? 0; weight[v * 4] = 1; }
  }
  return {
    section: k,
    material: s.material,
    mesh: { name: `#${k}`, texture: '', vertexCount: n, pos, nor, uv, bone, weight, indices: idx, skinned: false },
  };
}

/**
 * Секции для показа: в каждой группе LOD — самый подробный уровень (больше всего вершин). Дистанции бывают обратными
 * (у брони игрока: 0 — вид от первого лица, только оружие; 10 — полная модель), поэтому выбор — по геометрии;
 * без .mesh — по дистанциям (lod0).
 */
export function pickLod(mdl: LtMdl, mesh: LtMeshData): number[] {
  if (!mdl.lodGroups.length) return mdl.lod0.length ? mdl.lod0 : mesh.sections.map((_, k) => k);
  const verts = (l: { sections: number[] }) => l.sections.reduce((n, k) => n + (mesh.sections[k]?.vcount ?? 0), 0);
  const sel = new Set<number>();
  for (const g of mdl.lodGroups) {
    // уровень 0 рядом с 0.1 — вид от первого лица (у моделей игрока без головы): не берём
    const fp = g.some((l) => l.dist > 0 && l.dist < 1), from = fp ? g.filter((l) => l.dist > 0) : g;
    let best = from[0]!;
    for (const l of from) if (verts(l) > verts(best) || (verts(l) === verts(best) && l.dist < best.dist)) best = l;
    for (const k of best.sections) sel.add(k);
  }
  return [...sel].sort((a, b) => a - b);
}

/** Палитра костей секции: из .mesh (у секции своя, часть палитры записи LOD), иначе из .mdl. */
export function sectionPalette(mdl: LtMdl | null, mesh: LtMeshData, k: number): number[] | undefined {
  const s = mesh.sections[k]!;
  if (mdl && s.palCount && s.palOff + s.palCount <= mesh.palettes.length) return Array.from(mesh.palettes.subarray(s.palOff, s.palOff + s.palCount), (b) => mdl.nameOrder[b] ?? b);
  return mdl?.palettes.get(k);
}

/** Собрать модель: секции LOD0 (или все с UV, если .mdl нет) с материалами из базы. */
export function buildModel(mdl: LtMdl | null, mesh: LtMeshData, info: string[]): Model {
  const list = mdl ? pickLod(mdl, mesh) : mesh.sections.map((_, k) => k);
  const meshes: Mesh[] = [];
  for (const k of list) {
    if (k >= mesh.sections.length) continue;
    const sm = sectionMesh(mesh, k, sectionPalette(mdl, mesh, k));
    if (!sm) continue;
    sm.mesh.name = mdl?.sectionPiece.get(k) ?? `#${k}`;
    sm.mesh.matId = sm.material;
    meshes.push(sm.mesh);
  }
  if (!meshes.length) throw new Error('В модели нет секций с UV');
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), info, flipZ: true };
}
