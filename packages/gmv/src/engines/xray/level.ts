// Скомпилированный уровень X-Ray (levels/<уровень>/level + level.geom): статическая геометрия для просмотра и сверки.
// level: 1 заголовок, 2 шейдеры («шейдер/текстура,лайтмап»), 3 визуалы (OGF-подобные чанки), 8 секторы.
// level.geom: 9 вершинные буферы (объявление D3DVERTEXELEMENT9 + данные), 10 индексные буферы.
// Визуал ссылается на буферы чанком GCONTAINER (ЧН/ЗП, 21) или VCONTAINER/ICONTAINER (ТЧ, 7/8); индексы — от начала своего куска VB.
import { boundsOf } from '../../core/geometry';
import { lzhufDecompress } from '../../core/codecs/lzhuf';
import type { LoadContext } from '../../core/plugin';
import type { Mesh, Model, VFile } from '../../core/types';

const FSL = { HEADER: 1, SHADERS: 2, VISUALS: 3, VB: 9, IB: 10, SWIS: 11 } as const;
const OGFL = { HEADER: 1, SWIDATA: 6, VCONTAINER: 7, ICONTAINER: 8, CHILDREN_L: 10, TREEDEF2: 12, SWICONTAINER: 20, GCONTAINER: 21 } as const;
/** Типы визуалов с собственной геометрией: обычный, прогрессивный, деревья. */
const GEOM_TYPES = new Set([0, 2, 7, 11]);

interface Chunk { id: number; data: Uint8Array }
function chunks(u8: Uint8Array): Chunk[] {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out: Chunk[] = [];
  let p = 0;
  while (p + 8 <= u8.length) {
    const raw = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > u8.length) break;
    let data = u8.subarray(p + 8, p + 8 + size);
    if (raw & 0x80000000) data = lzhufDecompress(data);
    out.push({ id: raw & 0x7fffffff, data });
    p += 8 + size;
  }
  return out;
}
const dvOf = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.byteLength);

interface VB { stride: number; count: number; data: DataView; pos: number; posType: number; nor: number; tc: number; tcType: number; tan: number; bin: number }

/** Вершинные буферы: объявление до D3DDECL_END (поток 0xFF), число вершин, данные. */
export function parseVBs(u: Uint8Array): VB[] {
  const dv = dvOf(u), n = dv.getUint32(0, true), out: VB[] = [];
  const SIZE: Record<number, number> = { 0: 4, 1: 8, 2: 12, 3: 16, 4: 4, 5: 4, 6: 4, 7: 8, 8: 4, 9: 8, 10: 4, 11: 8, 12: 4, 13: 8, 15: 4, 16: 8 };
  let p = 4;
  for (let k = 0; k < n; k++) {
    let stride = 0, pos = -1, posType = 2, nor = -1, tc = -1, tcType = 1, tan = -1, bin = -1;
    for (;;) {
      const stream = dv.getUint16(p, true), off = dv.getUint16(p + 2, true), type = dv.getUint8(p + 4), usage = dv.getUint8(p + 6), ui = dv.getUint8(p + 7);
      p += 8;
      if (stream === 0xff) break;
      stride = Math.max(stride, off + (SIZE[type] ?? 4));
      if (usage === 0 && pos < 0) { pos = off; posType = type; }
      else if (usage === 3) nor = off;
      else if (usage === 6) tan = off;
      else if (usage === 7) bin = off;
      else if (usage === 5 && ui === 0) { tc = off; tcType = type; }
    }
    const count = dv.getUint32(p, true);
    p += 4;
    out.push({ stride, count, data: new DataView(u.buffer, u.byteOffset + p, stride * count), pos, posType, nor, tc, tcType, tan, bin });
    p += stride * count;
  }
  return out;
}

export function parseIBs(u: Uint8Array): Uint16Array[] {
  const dv = dvOf(u), n = dv.getUint32(0, true), out: Uint16Array[] = [];
  let p = 4;
  for (let k = 0; k < n; k++) {
    const cnt = dv.getUint32(p, true);
    p += 4;
    const a = new Uint16Array(cnt);
    for (let i = 0; i < cnt; i++) a[i] = dv.getUint16(p + i * 2, true);
    out.push(a);
    p += cnt * 2;
  }
  return out;
}

export interface LevelVisual { type: number; shader: number; vb: number; vbOff: number; vbCount: number; ib: number; ibOff: number; ibCount: number; xform: Float32Array | null }

/** Окно индексов прогрессивного меша (SWI): смещение и число треугольников самого подробного уровня. */
type Slide = [offset: number, tris: number];
/** Первое окно SWI: 4×u32 резерв, u32 число окон, окна {u32 смещение, u16 треугольников, u16 вершин}. */
const firstSlide = (d: DataView, p: number): Slide | null => (p + 28 <= d.byteLength && d.getUint32(p + 16, true) > 0 ? [d.getUint32(p + 20, true), d.getUint16(p + 24, true)] : null);

/** Общие SWI уровня (level.geom, чанк 11; ЧН/ЗП): деревья TREE_PM ссылаются на них номером (чанк 20 визуала). */
export function parseSwis(u: Uint8Array): Array<Slide | null> {
  const d = dvOf(u), n = d.getUint32(0, true), out: Array<Slide | null> = [];
  let p = 4;
  for (let k = 0; k < n && p + 20 <= u.length; k++) { out.push(firstSlide(d, p)); p += 20 + d.getUint32(p + 16, true) * 8; }
  return out;
}

export function parseVisuals(u: Uint8Array, swis: Array<Slide | null> = []): LevelVisual[] {
  const out: LevelVisual[] = [];
  for (const v of chunks(u)) {
    const sub = chunks(v.data), hdr = sub.find((c) => c.id === OGFL.HEADER);
    if (!hdr) continue;
    const h = dvOf(hdr.data), type = h.getUint8(1), shader = h.getUint16(2, true);
    const g = sub.find((c) => c.id === OGFL.GCONTAINER), vc = sub.find((c) => c.id === OGFL.VCONTAINER), ic = sub.find((c) => c.id === OGFL.ICONTAINER);
    let vb = -1, vbOff = 0, vbCount = 0, ib = -1, ibOff = 0, ibCount = 0;
    if (g) { const d = dvOf(g.data); [vb, vbOff, vbCount, ib, ibOff, ibCount] = [0, 4, 8, 12, 16, 20].map((o) => d.getUint32(o, true)) as [number, number, number, number, number, number]; }
    else if (vc && ic) { const a = dvOf(vc.data), b = dvOf(ic.data); [vb, vbOff, vbCount] = [a.getUint32(0, true), a.getUint32(4, true), a.getUint32(8, true)]; [ib, ibOff, ibCount] = [b.getUint32(0, true), b.getUint32(4, true), b.getUint32(8, true)]; }
    // прогрессивный меш: в буфере индексов лежат все уровни детализации; берём первое «окно» SWI — самое подробное
    const swi = sub.find((c) => c.id === OGFL.SWIDATA), swc = sub.find((c) => c.id === OGFL.SWICONTAINER);
    const slide = swi ? firstSlide(dvOf(swi.data), 0) : swc && swc.data.length >= 4 ? swis[dvOf(swc.data).getUint32(0, true)] ?? null : null;
    if (slide) { const [off, tris] = slide; if (off + tris * 3 <= ibCount) { ibOff += off; ibCount = tris * 3; } }
    let xform: Float32Array | null = null;
    const td = sub.find((c) => c.id === OGFL.TREEDEF2);
    if (td) { const d = dvOf(td.data); xform = new Float32Array(16); for (let k = 0; k < 16; k++) xform[k] = d.getFloat32(k * 4, true); }
    out.push({ type, shader, vb, vbOff, vbCount, ib, ibOff, ibCount, xform });
  }
  return out;
}

/** Строка шейдера уровня «шейдер/текстура,лайтмап…» -> [шейдер, текстура]. */
export function splitShader(s: string): [string, string] {
  const i = s.indexOf('/');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1).split(',')[0]!];
}

/** Уровень: визуалы с геометрией, объединённые по шейдеру. */
export function levelModel(level: Uint8Array, geom: Uint8Array, name: string): Model {
  const top = chunks(level), g = chunks(geom);
  const sh = top.find((c) => c.id === FSL.SHADERS), vis = top.find((c) => c.id === FSL.VISUALS), hd = top.find((c) => c.id === FSL.HEADER);
  const vbc = g.find((c) => c.id === FSL.VB), ibc = g.find((c) => c.id === FSL.IB);
  if (!sh || !vis || !vbc || !ibc) throw new Error('Не уровень X-Ray: нет шейдеров, визуалов или буферов level.geom');
  const shaders: string[] = [];
  { const d = dvOf(sh.data), n = d.getUint32(0, true); let p = 4; for (let k = 0; k < n; k++) { let s = ''; while (p < sh.data.length && sh.data[p]) s += String.fromCharCode(sh.data[p++]!); p++; shaders.push(s); } }
  const swc = g.find((c) => c.id === FSL.SWIS);
  const vbs = parseVBs(vbc.data), ibs = parseIBs(ibc.data), visuals = parseVisuals(vis.data, swc ? parseSwis(swc.data) : []);
  const groups = new Map<number, { pos: number[]; nor: number[]; uv: number[]; idx: number[] }>();
  let used = 0, skipped = 0;
  for (const v of visuals) {
    if (!GEOM_TYPES.has(v.type) || v.vb < 0) continue;
    const vb = vbs[v.vb], ib = ibs[v.ib];
    if (!vb || !ib || vb.pos < 0 || v.vbOff + v.vbCount > vb.count || v.ibOff + v.ibCount > ib.length) { skipped++; continue; }
    if (vb.posType !== 2 && vb.posType !== 3) { skipped++; continue; } // сжатые позиции (деревья ЗП) — позже
    let gr = groups.get(v.shader);
    if (!gr) groups.set(v.shader, (gr = { pos: [], nor: [], uv: [], idx: [] }));
    const base = gr.pos.length / 3, d = vb.data, X = v.xform;
    for (let i = 0; i < v.vbCount; i++) {
      const o = (v.vbOff + i) * vb.stride;
      let x = d.getFloat32(o + vb.pos, true), y = d.getFloat32(o + vb.pos + 4, true), z = d.getFloat32(o + vb.pos + 8, true);
      let nx = 0, ny = 1, nz = 0;
      if (vb.nor >= 0) { nx = (d.getUint8(o + vb.nor + 2) / 255) * 2 - 1; ny = (d.getUint8(o + vb.nor + 1) / 255) * 2 - 1; nz = (d.getUint8(o + vb.nor) / 255) * 2 - 1; }
      if (X) { // строки-векторы: v·M
        [x, y, z] = [x * X[0]! + y * X[4]! + z * X[8]! + X[12]!, x * X[1]! + y * X[5]! + z * X[9]! + X[13]!, x * X[2]! + y * X[6]! + z * X[10]! + X[14]!];
        [nx, ny, nz] = [nx * X[0]! + ny * X[4]! + nz * X[8]!, nx * X[1]! + ny * X[5]! + nz * X[9]!, nx * X[2]! + ny * X[6]! + nz * X[10]!];
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      gr.pos.push(x, y, z); gr.nor.push(nx / l, ny / l, nz / l);
      let u = 0, w = 0;
      if (vb.tc >= 0) {
        if (vb.tcType === 1) { u = d.getFloat32(o + vb.tc, true); w = d.getFloat32(o + vb.tc + 4, true); }
        // SHORT4 — вершины деревьев и MU-моделей (машины, бочки, камни — визуалы TREE_ST/PM с матрицей): UV × 2048,
        // z, w — коэффициенты ветра (FTreeVisual); сверено по атласам техники во всех трёх играх (диапазон 0..2048)
        else if (vb.tcType === 7) { u = d.getInt16(o + vb.tc, true) / 2048; w = d.getInt16(o + vb.tc + 2, true) / 2048; }
        else { // SHORT2: координата × 1024, дробная поправка — в альфе касательной и бинормали
          const du = vb.tan >= 0 ? d.getUint8(o + vb.tan + 3) / 255 : 0, dv = vb.bin >= 0 ? d.getUint8(o + vb.bin + 3) / 255 : 0;
          u = (d.getInt16(o + vb.tc, true) + du) / 1024; w = (d.getInt16(o + vb.tc + 2, true) + dv) / 1024;
        }
      }
      gr.uv.push(u, w);
    }
    for (let i = 0; i < v.ibCount; i++) gr.idx.push(base + ib[v.ibOff + i]!);
    used++;
  }
  const meshes: Mesh[] = [...groups].map(([si, gr]) => {
    const [shader, texture] = splitShader(shaders[si] ?? ''), n = gr.pos.length / 3;
    return {
      name: `${texture || '?'} · ${shader}`, texture, shader, vertexCount: n, pos: Float32Array.from(gr.pos), nor: Float32Array.from(gr.nor), uv: Float32Array.from(gr.uv),
      bone: new Float32Array(n * 4), weight: new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), indices: Uint32Array.from(gr.idx), skinned: false,
    };
  }).filter((m) => m.indices.length);
  const ver = hd ? dvOf(hd.data).getUint16(0, true) : 0;
  const info = [`Уровень X-Ray (скомпилированный, версия ${ver}): ${name}`, `Визуалов ${visuals.length}, показано ${used}${skipped ? `, пропущено ${skipped}` : ''}; буферов VB ${vbs.length}, IB ${ibs.length}; шейдеров ${shaders.length}`, `Мешей (по шейдерам) ${meshes.length}, вершин ${meshes.reduce((a, m) => a + m.vertexCount, 0)}, треугольников ${meshes.reduce((a, m) => a + m.indices.length / 3, 0)}`];
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true, info };
}

export async function loadLevel(main: VFile, ctx: LoadContext): Promise<Model> {
  const geom = await ctx.sibling('level.geom');
  if (!geom) throw new Error('Рядом с level нет level.geom');
  const dir = (main.path ?? '').split('/').slice(-2, -1)[0] ?? '';
  const model = levelModel(new Uint8Array(await main.arrayBuffer()), new Uint8Array(geom), dir || main.name);
  // трава: level.details + высоты по level.cform
  const det = await ctx.sibling('level.details');
  if (det) {
    try {
      const { parseDetails, parseCForm, buildDetails } = await import('./details');
      const map = parseDetails(new Uint8Array(det)), cf = await ctx.sibling('level.cform');
      if (!cf) model.info.push('Трава: рядом нет level.cform — высоты не найти, трава не показана');
      else {
        const r = buildDetails(map, parseCForm(new Uint8Array(cf)));
        model.meshes.push(...r.meshes);
        model.bounds = boundsOf(model.meshes);
        const tris = r.meshes.reduce((a, m) => a + m.indices.length / 3, 0);
        model.info.push(`Трава (level.details): моделей ${map.models.length}, поставлено ${r.items} из ${r.candidates}${r.keep < 1 ? ` (прорежено до ${Math.round(r.keep * 100)} %)` : ''}, треугольников ${tris}`);
      }
    } catch (e) { model.info.push(`Трава: ${(e as Error).message}`); }
  }
  return model;
}
