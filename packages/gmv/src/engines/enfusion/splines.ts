// Сплайновые сущности мира Enfusion: дороги (RoadEntity — сама по себе или ребёнок RoadGeneratorEntity, у которого
// ширина и материал — в префабе генератора), реки (SplineShapeEntity + ребёнок RiverEntity, ширина по точкам —
// RiverPointData), озёра (PolylineShapeEntity + LakeGeneratorEntity, плоская вода на уровне берега) и провода ЛЭП
// (PowerlineEntity: Cables { Cable { StartPoint EndPoint } } — с провисом).
// Точки сплайна — относительно сущности; касательные — SplinePointData { InTangent OutTangent } (Эрмит), без них —
// Катмулл — Ром. Разобрано по файлам игры.
import type { LoadContext } from '../../core/plugin';
import type { DecodedImage, Mesh } from '../../core/types';
import { enfTextures, loadEmat } from './emat';
import { enfProp, type EnfNode } from './entext';
import { resolvePrefab } from './prefab';

export interface EbinObj { cls: string; props: Map<string, EbinVal> }
export type EbinVal = Uint8Array | EbinObj | EbinObj[];
export interface EbinEntity {
  cls: string; name: string; ref: number; props: Map<string, EbinVal>; parent: number;
  /** Мировая матрица (столбцы): родитель × coords/angles/scale. */
  world: Float64Array;
}
export interface EbinInstance { ref: number; coords: [number, number, number] | null; angles: [number, number, number] | null; scale: number; world: Float64Array; entity: number }
export interface Ebin { strings: string[]; guids: bigint[]; entities: EbinEntity[]; instances: EbinInstance[]; /** разбор остановлен на неизвестной конструкции */ error?: string }


export const ebVec = (v: EbinVal | undefined): [number, number, number] | null => {
  if (!(v instanceof Uint8Array) || v.length !== 12) return null;
  const d = new DataView(v.buffer, v.byteOffset, 12);
  return [d.getFloat32(0, true), d.getFloat32(4, true), d.getFloat32(8, true)];
};
export const ebF32 = (v: EbinVal | undefined): number | null => (v instanceof Uint8Array && v.length === 4 ? new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true) : null);
export const ebU = (v: EbinVal | undefined): number | null => {
  if (!(v instanceof Uint8Array)) return null;
  const d = new DataView(v.buffer, v.byteOffset, v.length);
  return v.length === 1 ? v[0]! : v.length === 2 ? d.getUint16(0, true) : v.length === 4 ? d.getUint32(0, true) : null;
};
export const ebList = (v: EbinVal | undefined): EbinObj[] => (Array.isArray(v) ? v : []);


type V3 = [number, number, number];
const xf = (m: Float64Array, p: V3): V3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
const xd = (m: Float64Array, p: V3): V3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2], m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2], m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

export interface SplinePoint { p: V3; tin?: V3; tout?: V3; width?: number }

/** Точки сплайна в мировых координатах (касательные и ширина — если заданы в точке). */
export function splinePoints(list: EbinObj[], world: Float64Array): SplinePoint[] {
  return list.map((o) => {
    const p = ebVec(o.props.get('Position')) ?? [0, 0, 0], pt: SplinePoint = { p: xf(world, p) };
    for (const d of ebList(o.props.get('Data'))) {
      const ti = ebVec(d.props.get('InTangent')), to = ebVec(d.props.get('OutTangent'));
      if (ti) pt.tin = xd(world, ti);
      if (to) pt.tout = xd(world, to);
      if (ebU(d.props.get('WidthOverride'))) { const w = ebF32(d.props.get('FixedWidth')); if (w && w > 0) pt.width = w; }
    }
    return pt;
  });
}

/** Отсчёты сплайна примерно через step метров (Эрмит по касательным точек, иначе Катмулл — Ром). */
export function sampleSpline(pts: SplinePoint[], closed: boolean, step = 2): Array<{ p: V3; w?: number }> {
  const n = pts.length, out: Array<{ p: V3; w?: number }> = [];
  if (n < 2) return pts.map((x) => ({ p: x.p, w: x.width }));
  const P = (i: number) => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))]!;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = P(i), b = P(i + 1);
    const ta = a.tout ?? sub(P(i + 1).p, P(i - 1).p).map((v) => v / 2) as V3;
    const tb = b.tin ?? sub(P(i + 2).p, P(i).p).map((v) => v / 2) as V3;
    const k = Math.max(1, Math.min(64, Math.ceil(len(sub(b.p, a.p)) / step)));
    for (let s = 0; s < k; s++) {
      const t = s / k, t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      const w = a.width !== undefined || b.width !== undefined ? (a.width ?? b.width!) * (1 - t) + (b.width ?? a.width!) * t : undefined;
      out.push({ p: [0, 1, 2].map((c) => h00 * a.p[c]! + h10 * ta[c]! + h01 * b.p[c]! + h11 * tb[c]!) as V3, w });
    }
  }
  const last = closed ? P(0) : P(n - 1);
  out.push({ p: last.p, w: last.width });
  return out;
}

/** Накопитель геометрии по материалам. */
class Batch {
  pos: number[] = []; uv: number[] = []; idx: number[] = [];
  constructor(public name: string, public material: string, public color: number[]) {}
  /** Лента вдоль отсчётов шириной w (по горизонтали), приподнятая на lift; обе стороны. */
  ribbon(s: Array<{ p: V3; w?: number }>, width: number, lift: number, vScale: number): void {
    if (s.length < 2) return;
    const base = this.pos.length / 3;
    let dist = 0;
    for (let k = 0; k < s.length; k++) {
      const a = s[Math.max(0, k - 1)]!.p, b = s[Math.min(s.length - 1, k + 1)]!.p, p = s[k]!.p;
      if (k) dist += len(sub(p, s[k - 1]!.p));
      let dx = b[0] - a[0], dz = b[2] - a[2];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const hw = (s[k]!.w ?? width) / 2;
      this.pos.push(p[0] - dz * hw, p[1] + lift, p[2] + dx * hw, p[0] + dz * hw, p[1] + lift, p[2] - dx * hw);
      const v = (dist * vScale) / Math.max(0.1, s[k]!.w ?? width);
      this.uv.push(0, v, 1, v);
    }
    for (let k = 0; k + 1 < s.length; k++) {
      const a = base + k * 2, b = a + 1, c = a + 2, d = a + 3;
      this.idx.push(a, c, b, b, c, d, a, b, c, b, d, c);
    }
  }
  /** Провод с провисом: крестовина из двух узких лент. */
  cable(a: V3, b: V3, thick: number): void {
    const L = len(sub(b, a)), sag = 0.02 * L + 0.2, n = Math.max(2, Math.min(16, Math.ceil(L / 4)));
    const pts: V3[] = [];
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]); }
    const dir = sub(b, a), hl = Math.hypot(dir[0], dir[2]) || 1, side: V3 = [-dir[2] / hl * thick, 0, dir[0] / hl * thick], up: V3 = [0, thick, 0];
    for (const off of [side, up]) {
      const base = this.pos.length / 3;
      for (const p of pts) { this.pos.push(p[0] - off[0], p[1] - off[1], p[2] - off[2], p[0] + off[0], p[1] + off[1], p[2] + off[2]); this.uv.push(0, 0, 1, 0); }
      for (let k = 0; k < n; k++) { const q = base + k * 2; this.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3, q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
  }
  /** Плоский многоугольник (уши) на высоте y. */
  polygon(pts: V3[], y: number): void {
    const base = this.pos.length / 3, P = pts.map((p) => [p[0], p[2]] as [number, number]);
    for (const p of pts) { this.pos.push(p[0], y, p[2]); this.uv.push(p[0] / 8, p[2] / 8); }
    for (const [a, b, c] of earcut(P)) this.idx.push(base + a, base + c, base + b, base + a, base + b, base + c);
  }
  mesh(): Mesh | null {
    if (!this.idx.length) return null;
    const pos = new Float32Array(this.pos), n = pos.length / 3, nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) nor[i * 3 + 1] = 1;
    return { name: this.name, texture: this.material, material: this.material, vertexCount: n, pos, nor, uv: new Float32Array(this.uv), bone: new Float32Array(0), weight: new Float32Array(0), indices: new Uint32Array(this.idx), skinned: false, color: this.color };
  }
}

/** Триангуляция простого многоугольника отсечением ушей (берега озёр — до нескольких сотен точек). */
export function earcut(P: Array<[number, number]>): Array<[number, number, number]> {
  const n = P.length, out: Array<[number, number, number]> = [];
  if (n < 3) return out;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = P[i]!, b = P[(i + 1) % n]!; area += a[0] * b[1] - b[0] * a[1]; }
  const V = Array.from({ length: n }, (_, i) => (area > 0 ? i : n - 1 - i));
  const cross = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (V.length > 3 && guard++ < n * n) {
    let cut = false;
    for (let i = 0; i < V.length; i++) {
      const ia = V[(i + V.length - 1) % V.length]!, ib = V[i]!, ic = V[(i + 1) % V.length]!, a = P[ia]!, b = P[ib]!, c = P[ic]!;
      if (cross(a, b, c) <= 0) continue;
      if (V.some((v) => v !== ia && v !== ib && v !== ic && inside(P[v]!, a, b, c))) continue;
      out.push([ia, ib, ic]); V.splice(i, 1); cut = true; break;
    }
    if (!cut) break; // самопересечение — остаток веером
  }
  for (let i = 1; i + 1 < V.length; i++) out.push([V[0]!, V[i]!, V[i + 1]!]);
  return out;
}

export interface SplineStats { roads: number; rivers: number; lakes: number; cables: number }

/** Меши дорог, рек, озёр и проводов мира. pathOf — GUID-ссылка (номер в таблице) → путь ресурса. */
export async function splineMeshes(eb: Ebin, pathOf: (ref: number) => string | undefined, ctx: LoadContext, heightAt?: (x: number, z: number) => number | null): Promise<{ meshes: Mesh[]; stats: SplineStats }> {
  // отсчёты не ниже показанного ландшафта (он грубее настоящего — иначе дорога местами уходит под землю)
  const drape = (s: Array<{ p: V3; w?: number }>) => { if (heightAt) for (const x of s) { const h = heightAt(x.p[0], x.p[2]); if (h !== null && h > x.p[1]) x.p = [x.p[0], h, x.p[2]]; } return s; };
  const batches = new Map<string, Batch>(), stats: SplineStats = { roads: 0, rivers: 0, lakes: 0, cables: 0 };
  const images = new Map<string, Promise<{ image?: DecodedImage; alphaTest?: boolean } | null>>();
  const batch = (key: string, name: string, material: string, color: number[]) => { let b = batches.get(key); if (!b) batches.set(key, b = new Batch(name, material, color)); return b; };
  const refOf = (e: EbinEntity | EbinObj, k: string) => { const r = ebU(e.props.get(k)); return r === null ? undefined : pathOf(r); };
  // настройки дороги из префаба генератора: первая RoadEntity в блоке детей
  const genRoad = new Map<string, Promise<EnfNode | null>>();
  const prefabRoad = (path: string) => {
    let p = genRoad.get(path);
    if (!p) { p = resolvePrefab(path, ctx).then((n) => n?.children.find((c) => !c.header.length)?.children.find((c) => /Road|River/.test(c.header[0] ?? '')) ?? (n && /River/.test(n.header[0] ?? '') ? n : null)); genRoad.set(path, p); }
    return p;
  };
  const children = new Map<number, number[]>();
  eb.entities.forEach((e, i) => { if (e.parent >= 0) { const l = children.get(e.parent) ?? []; l.push(i); children.set(e.parent, l); } });
  for (const [i, e] of eb.entities.entries()) {
    if (e.cls === 'RoadEntity') {
      const par = e.parent >= 0 ? eb.entities[e.parent]! : null, pref = par?.ref !== undefined && par.ref >= 0 ? pathOf(par.ref) : undefined;
      const def = pref ? await prefabRoad(pref) : null;
      const width = ebF32(e.props.get('Width')) ?? Number(enfProp(def ?? undefined, 'Width') ?? 4);
      const vs = ebF32(e.props.get('VScale')) ?? Number(enfProp(def ?? undefined, 'VScale') ?? 1);
      const mat = refOf(e, 'Material') ?? enfProp(def ?? undefined, 'Material') ?? '';
      const pts = splinePoints(ebList(e.props.get('SplinePoints')), e.world);
      if (pts.length < 2) continue;
      batch(`road ${mat}`, `дороги · ${mat.replace(/^.*\//, '').replace(/\.emat$/i, '') || 'без материала'}`, mat, [0.42, 0.4, 0.36]).ribbon(drape(sampleSpline(pts, ebU(e.props.get('IsClosedSpline')) === 1)), width || 4, 0.12, vs || 1);
      stats.roads++;
    } else if (e.cls === 'SplineShapeEntity' || e.cls === 'PolylineShapeEntity') {
      const kids = (children.get(i) ?? []).map((k) => eb.entities[k]!);
      const pts = splinePoints(ebList(e.props.get('Points')), e.world);
      if (pts.length < 2) continue;
      const river = kids.find((k) => k.cls === 'RiverEntity'), lake = kids.find((k) => k.cls === 'LakeGeneratorEntity');
      if (river) {
        const pref = river.ref >= 0 ? pathOf(river.ref) : undefined, def = pref ? await prefabRoad(pref) : null;
        const width = ebF32(river.props.get('Width')) ?? Number(enfProp(def ?? undefined, 'Width') ?? 5);
        const mat = refOf(river, 'Material') ?? enfProp(def ?? undefined, 'Material') ?? '';
        const up = ebF32(river.props.get('SplineOffsetUp')) ?? Number(enfProp(def ?? undefined, 'SplineOffsetUp') ?? 0.1);
        batch('water', 'вода · реки и озёра', mat, [0.16, 0.28, 0.33]).ribbon(drape(sampleSpline(pts, false, 3)), width, up + 0.05, 0.2);
        stats.rivers++;
      } else if (lake) {
        const ys = pts.map((p) => p.p[1]).sort((a, b) => a - b), y = ys[Math.floor(ys.length / 2)]! + (ebF32(lake.props.get('m_fWaterSurfaceOffset')) ?? 0);
        batch('water', 'вода · реки и озёра', refOf(lake, 'm_MaterialName') ?? '', [0.16, 0.28, 0.33]).polygon(e.cls === 'SplineShapeEntity' ? sampleSpline(pts, true, 4).map((s) => s.p) : pts.map((p) => p.p), y);
        stats.lakes++;
      }
    } else if (e.cls === 'PowerlineEntity') {
      for (const c of ebList(e.props.get('Cables'))) {
        const a = ebVec(c.props.get('StartPoint')), b = ebVec(c.props.get('EndPoint'));
        if (!a || !b) continue;
        batch('cable', 'провода ЛЭП', '', [0.1, 0.1, 0.1]).cable(xf(e.world, a), xf(e.world, b), 0.03);
        stats.cables++;
      }
    }
  }
  // текстуры дорог (как у объектов мира: до 256 px)
  const meshes: Mesh[] = [];
  const prev = { ...enfTextures };
  enfTextures.limit = 256; enfTextures.lite = true;
  try {
    for (const b of batches.values()) {
      const m = b.mesh();
      if (!m) continue;
      if (b.material && b.name.startsWith('дороги')) {
        let p = images.get(b.material);
        if (!p) { p = loadEmat(b.material, ctx).then((x) => (x ? { image: x.image, alphaTest: x.alphaTest } : null)).catch(() => null); images.set(b.material, p); }
        const t = await p;
        if (t?.image) { m.image = t.image; delete m.color; m.texture = t.image.name ?? b.material; if (t.alphaTest) m.alphaTest = true; }
      }
      meshes.push(m);
    }
  } finally { enfTextures.limit = prev.limit; enfTextures.lite = prev.lite; }
  return { meshes, stats };
}
