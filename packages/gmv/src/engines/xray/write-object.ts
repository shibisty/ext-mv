// Запись исходного объекта X-Ray SDK (.object, версия 0x10, сглаживание рёбрами как в SDK 0.7 ЗП).
// Вход — треугольники в координатах X-Ray (левосторонние, Y вверх, внешняя нормаль = (b − a) × (c − a)).
import { EMESH, EOBJ } from './object';

export interface ObjectSurfaceIn {
  name: string;
  /** Текстура без расширения относительно gamedata/textures, например «wall\\wall_stucco_05». */
  texture: string;
  /** Шейдер движка (eshader), по умолчанию «default». */
  eshader?: string;
  /** Шейдер компилятора (cshader), по умолчанию «default». */
  cshader?: string;
  /** Игровой материал, по умолчанию «default». */
  gamemtl?: string;
  twoSided?: boolean;
}
export interface ObjectMeshIn {
  name: string;
  pos: ArrayLike<number>;
  /** Нормали вершин: по их разрывам находятся жёсткие рёбра. Нет — жёсткие рёбра по углу. */
  nor?: ArrayLike<number> | null;
  uv: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Номер поверхности для каждого треугольника или одна на весь меш. */
  surface: number | ArrayLike<number>;
}
export interface ObjectIn { meshes: ObjectMeshIn[]; surfaces: ObjectSurfaceIn[]; owner?: string; dynamic?: boolean; hardAngleDeg?: number }

class W {
  private buf = new Uint8Array(1 << 16);
  private dv = new DataView(this.buf.buffer);
  pos = 0;
  private need(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let s = this.buf.length * 2;
    while (s < this.pos + n) s *= 2;
    const b = new Uint8Array(s);
    b.set(this.buf);
    this.buf = b; this.dv = new DataView(b.buffer);
  }
  b(v: number) { this.need(1); this.dv.setUint8(this.pos++, v); return this; }
  w(v: number) { this.need(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; return this; }
  d(v: number) { this.need(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  f(v: number) { this.need(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; return this; }
  sz(s: string) { const e = encode1251(s); this.need(e.length + 1); this.buf.set(e, this.pos); this.pos += e.length; return this.b(0); }
  bytes(u: Uint8Array) { this.need(u.length); this.buf.set(u, this.pos); this.pos += u.length; return this; }
  /** Чанк: id, затем размер, заполняемый после тела. */
  chunk(id: number, body: (w: W) => void) {
    this.d(id);
    const at = this.pos;
    this.d(0);
    body(this);
    this.dv.setUint32(at, this.pos - at - 4, true);
    return this;
  }
  done() { return this.buf.slice(0, this.pos); }
}

/** Строки SDK — в кодировке Windows-1251 (имена текстур и материалов бывают русскими). */
function encode1251(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 128 ? c : c >= 0x410 && c <= 0x44f ? c - 0x350 : c === 0x401 ? 0xa8 : c === 0x451 ? 0xb8 : 0x3f;
  }
  return out;
}

interface Built {
  points: number[]; faces: number[]; sg: number[]; vmrefs: Array<[number, number]>;
  base: number[]; poly: Array<{ u: number; v: number; point: number; face: number }>;
  sfaces: Map<number, number[]>; bbox: [number[], number[]];
}

function build(m: ObjectMeshIn, hardCos: number): Built {
  const P = m.pos, I = m.indices, nt = Math.floor(I.length / 3);
  // сварка вершин: одна точка .object на позицию и нормаль. Углы с разными нормалями остаются разными точками,
  // поэтому SDK не сгладит то, что в исходнике было жёстким (и не потянет сглаживание через шов в соседний «веер»)
  const pointOf = new Map<string, number>(), vpoint = new Int32Array(P.length / 3), points: number[] = [], N0 = m.nor;
  const q = (x: number) => Math.round(x * 1000);
  for (let v = 0; v < P.length / 3; v++) {
    const k = `${P[v * 3]}|${P[v * 3 + 1]}|${P[v * 3 + 2]}` + (N0 ? `|${q(N0[v * 3]!)}|${q(N0[v * 3 + 1]!)}|${q(N0[v * 3 + 2]!)}` : '');
    let p = pointOf.get(k);
    if (p === undefined) { p = points.length / 3; pointOf.set(k, p); points.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!); }
    vpoint[v] = p;
  }
  const np = points.length / 3, base = new Array<number>(np * 2).fill(NaN), poly: Built['poly'] = [];
  const vmrefs: Array<[number, number]> = [], vmrefOf = new Map<string, number>(), faces: number[] = [];
  const ref = (vm: number, idx: number) => { const k = `${vm}|${idx}`; let r = vmrefOf.get(k); if (r === undefined) { r = vmrefs.length; vmrefOf.set(k, r); vmrefs.push([vm, idx]); } return r; };
  const sfaces = new Map<number, number[]>();
  const surf = (t: number) => (typeof m.surface === 'number' ? m.surface : m.surface[t] ?? 0);
  // базовая UV точки — из первого угла; отличающиеся углы — в «поли»-карту (разрывы UV)
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) { const v = I[t * 3 + k]!, p = vpoint[v]!; if (Number.isNaN(base[p * 2])) { base[p * 2] = m.uv[v * 2]!; base[p * 2 + 1] = m.uv[v * 2 + 1]!; } }
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k]!, p = vpoint[v]!, u = m.uv[v * 2]!, w = m.uv[v * 2 + 1]!;
      let r: number;
      if (u === base[p * 2] && w === base[p * 2 + 1]) r = ref(0, p);
      else { r = ref(1, poly.length); poly.push({ u, v: w, point: p, face: t }); }
      faces.push(p, r);
    }
    const s = surf(t);
    (sfaces.get(s) ?? sfaces.set(s, []).get(s)!).push(t);
  }
  // жёсткие рёбра (бит k — ребро k→k+1): нормали вершин по разные стороны ребра различаются, или угол граней больше порога
  const fn = (t: number) => {
    const a = vpoint[I[t * 3]!]! * 3, b = vpoint[I[t * 3 + 1]!]! * 3, c = vpoint[I[t * 3 + 2]!]! * 3;
    const ux = points[b]! - points[a]!, uy = points[b + 1]! - points[a + 1]!, uz = points[b + 2]! - points[a + 2]!, vx = points[c]! - points[a]!, vy = points[c + 1]! - points[a + 1]!, vz = points[c + 2]! - points[a + 2]!;
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    return [n[0]! / l, n[1]! / l, n[2]! / l];
  };
  const edgeFaces = new Map<string, Array<[number, number]>>();
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = vpoint[I[t * 3 + k]!]!, b = vpoint[I[t * 3 + ((k + 1) % 3)]!]!, key = a < b ? `${a}_${b}` : `${b}_${a}`;
    (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)!).push([t, k]);
  }
  const sg = new Array<number>(nt).fill(0);
  const N = m.nor;
  const vnor = (t: number, k: number) => { const v = I[t * 3 + k]!; return [N![v * 3]!, N![v * 3 + 1]!, N![v * 3 + 2]!]; };
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  for (const list of edgeFaces.values()) {
    if (list.length !== 2) { for (const [t, k] of list) sg[t]! |= 1 << k; continue; } // край или неманифолд — жёстко
    const [[t1, k1], [t2, k2]] = list as [[number, number], [number, number]];
    let hard: boolean;
    if (N) {
      // концы ребра: в грани t1 — углы k1 и k1+1, в t2 те же точки
      const p1 = vpoint[I[t1 * 3 + k1]!]!, cornerIn = (t: number, p: number) => [0, 1, 2].find((k) => vpoint[I[t * 3 + k]!] === p)!;
      const q1 = vpoint[I[t1 * 3 + ((k1 + 1) % 3)]!]!;
      hard = dot(vnor(t1, k1), vnor(t2, cornerIn(t2, p1))) < 0.999 || dot(vnor(t1, (k1 + 1) % 3), vnor(t2, cornerIn(t2, q1))) < 0.999;
    } else hard = dot(fn(t1), fn(t2)) < hardCos;
    if (hard) { sg[t1]! |= 1 << k1; sg[t2]! |= 1 << k2; }
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i++) { lo[i % 3] = Math.min(lo[i % 3]!, points[i]!); hi[i % 3] = Math.max(hi[i % 3]!, points[i]!); }
  return { points, faces, sg, vmrefs, base, poly, sfaces, bbox: [lo, hi] };
}

/** Записать .object. Возвращает байты файла. */
export function writeObject(o: ObjectIn): Uint8Array {
  const hardCos = Math.cos(((o.hardAngleDeg ?? 60) * Math.PI) / 180), now = Math.floor(Date.now() / 1000), w = new W();
  const sname = (i: number) => o.surfaces[i]?.name ?? `surface_${i}`;
  w.chunk(EOBJ.MAIN, (w) => {
    w.chunk(EOBJ.VERSION, (w) => w.w(0x10));
    w.chunk(EOBJ.USERDATA, (w) => w.sz(''));
    w.chunk(EOBJ.LOD_REF, (w) => w.sz(''));
    w.chunk(EOBJ.FLAGS, (w) => w.d(o.dynamic ? 1 : 0));
    w.chunk(EOBJ.MESHES, (w) => {
      o.meshes.forEach((m, mi) => w.chunk(mi, (w) => {
        const b = build(m, hardCos), np = b.points.length / 3, nt = b.faces.length / 6;
        w.chunk(EMESH.VERSION, (w) => w.w(0x11));
        w.chunk(EMESH.NAME, (w) => w.sz(m.name || `mesh_${mi}`));
        w.chunk(EMESH.BBOX, (w) => { for (const v of [...b.bbox[0], ...b.bbox[1]]) w.f(np ? v : 0); });
        w.chunk(EMESH.FLAGS, (w) => w.b(1)); // виден
        w.chunk(EMESH.OPTIONS, (w) => w.d(0).d(0));
        w.chunk(EMESH.VERTS, (w) => { w.d(np); for (const v of b.points) w.f(v); });
        w.chunk(EMESH.FACES, (w) => { w.d(nt); for (const v of b.faces) w.d(v); });
        w.chunk(EMESH.SG, (w) => { for (const v of b.sg) w.d(v); });
        w.chunk(EMESH.VMREFS, (w) => { w.d(b.vmrefs.length); for (const [vm, i] of b.vmrefs) w.b(1).d(vm).d(i); });
        w.chunk(EMESH.SFACE, (w) => {
          w.w(b.sfaces.size);
          for (const [s, list] of b.sfaces) { w.sz(sname(s)).d(list.length); for (const f of list) w.d(f); }
        });
        w.chunk(EMESH.VMAPS2, (w) => {
          w.d(b.poly.length ? 2 : 1);
          w.sz('Texture').b(2).b(0).b(0).d(np);
          for (let p = 0; p < np; p++) w.f(b.base[p * 2]!).f(b.base[p * 2 + 1]!);
          for (let p = 0; p < np; p++) w.d(p);
          if (b.poly.length) {
            w.sz('Texture').b(2).b(1).b(0).d(b.poly.length);
            for (const e of b.poly) w.f(e.u).f(e.v);
            for (const e of b.poly) w.d(e.point);
            for (const e of b.poly) w.d(e.face);
          }
        });
      }));
    });
    w.chunk(EOBJ.SURFACES3, (w) => {
      w.d(o.surfaces.length);
      for (const s of o.surfaces) w.sz(s.name).sz(s.eshader ?? 'default').sz(s.cshader ?? 'default').sz(s.gamemtl ?? 'default').sz(s.texture).sz('Texture').d(s.twoSided ? 1 : 0).d(0x112).d(1);
    });
    w.chunk(EOBJ.REVISION, (w) => w.sz(o.owner ?? 'gmv').d(now).sz(o.owner ?? 'gmv').d(now));
  });
  return w.done();
}
