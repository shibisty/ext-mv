// Исходный объект X-Ray SDK (.object, «EOBJ»): меши с вершинами, гранями, UV-картами (vmap) и группами сглаживания,
// поверхности (шейдер движка, шейдер компилятора, игровой материал, текстура). Координаты X-Ray: левосторонние, Y вверх.
export const EOBJ = {
  MAIN: 0x7777, VERSION: 0x0900, FLAGS: 0x0903, SURFACES: 0x0905, SURFACES2: 0x0906, SURFACES3: 0x0907, MESHES: 0x0910,
  USERDATA: 0x0912, LIB_VERSION: 0x0916, BONES: 0x0921, REVISION: 0x0922, LOD_REF: 0x0925,
} as const;
export const EMESH = {
  VERSION: 0x1000, NAME: 0x1001, FLAGS: 0x1002, BBOX: 0x1004, VERTS: 0x1005, FACES: 0x1006, VMREFS: 0x1008, SFACE: 0x1009,
  OPTIONS: 0x1010, VMAPS1: 0x1011, VMAPS2: 0x1012, SG: 0x1013,
} as const;

/** Флаги объекта (EditObject): динамический, прогрессивный, LOD, HOM, многократное использование, глушитель звука, HQ-экспорт. */
export const EOBJ_FLAG = { DYNAMIC: 1, PROGRESSIVE: 2, USING_LOD: 4, HOM: 8, MULTIPLE_USAGE: 16, SOUND_OCCLUDER: 32, HQ_EXPORT: 64 } as const;

export interface XrSurface {
  name: string; eshader: string; cshader: string; gamemtl: string; texture: string; vmap: string; flags: number; fvf: number;
}
export interface XrVmap {
  name: string; dim: number; poly: boolean; type: number;
  /** size × dim значений. */
  data: Float32Array;
  vertices: Uint32Array;
  /** Для «поли»-карт: номер грани каждой записи. */
  faces: Uint32Array | null;
}
export interface XrEditMesh {
  name: string; flags: number; options: [number, number];
  points: Float32Array;
  /** По 3 угла на грань: [точка, vmref]. */
  faces: Uint32Array;
  sg: Uint32Array | null;
  /** vmref -> список [номер vmap, индекс в vmap]. */
  vmrefs: Array<Array<[number, number]>>;
  /** Поверхность -> номера граней. */
  sfaces: Array<{ surface: string; faces: Uint32Array }>;
  vmaps: XrVmap[];
}
export interface XrObject {
  version: number; flags: number; userdata: string; lodRef: string;
  surfaces: XrSurface[]; meshes: XrEditMesh[];
  revision: { owner: string; created: number; modifier: string; modified: number } | null;
  /** Чанки верхнего уровня, которые читатель не разбирает (кости, анимации…): сохраняются как есть. */
  extra: Array<{ id: number; data: Uint8Array }>;
}

/** Символ Windows-1251 (строки SDK: имена текстур и материалов бывают русскими). */
const cp1251 = (c: number) => String.fromCharCode(c < 128 ? c : c >= 0xc0 ? c + 0x350 : c === 0xa8 ? 0x401 : c === 0xb8 ? 0x451 : c);

class R {
  readonly dv: DataView; readonly u8: Uint8Array;
  constructor(readonly buf: ArrayBuffer, public pos: number, public end: number) { this.dv = new DataView(buf); this.u8 = new Uint8Array(buf); }
  b() { return this.dv.getUint8(this.pos++); }
  w() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  d() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  sz() { let s = ''; while (this.pos < this.end) { const c = this.u8[this.pos++]!; if (!c) break; s += cp1251(c); } return s; }
}

/** Чанки [id u32, размер u32] в диапазоне. */
export function chunksOf(buf: ArrayBuffer, start: number, end: number): Array<{ id: number; start: number; end: number }> {
  const dv = new DataView(buf), out: Array<{ id: number; start: number; end: number }> = [];
  let p = start;
  while (p + 8 <= end) {
    const id = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > end) throw new Error(`.object: чанк 0x${id.toString(16)} выходит за границы`);
    out.push({ id, start: p + 8, end: p + 8 + size });
    p += 8 + size;
  }
  return out;
}

function parseMesh(buf: ArrayBuffer, start: number, end: number): XrEditMesh {
  const m: XrEditMesh = { name: '', flags: 0, options: [0, 0], points: new Float32Array(0), faces: new Uint32Array(0), sg: null, vmrefs: [], sfaces: [], vmaps: [] };
  for (const c of chunksOf(buf, start, end)) {
    const r = new R(buf, c.start, c.end);
    switch (c.id) {
      case EMESH.NAME: m.name = r.sz(); break;
      case EMESH.FLAGS: m.flags = r.b(); break;
      case EMESH.OPTIONS: m.options = [r.d(), r.d()]; break;
      case EMESH.VERTS: { const n = r.d(); m.points = new Float32Array(n * 3); for (let k = 0; k < n * 3; k++) m.points[k] = r.f(); break; }
      case EMESH.FACES: { const n = r.d(); m.faces = new Uint32Array(n * 6); for (let k = 0; k < n * 6; k++) m.faces[k] = r.d(); break; }
      case EMESH.SG: { const n = (c.end - c.start) >> 2; m.sg = new Uint32Array(n); for (let k = 0; k < n; k++) m.sg[k] = r.d(); break; }
      case EMESH.VMREFS: {
        const n = r.d();
        for (let k = 0; k < n; k++) { const cnt = r.b(), ref: Array<[number, number]> = []; for (let i = 0; i < cnt; i++) ref.push([r.d(), r.d()]); m.vmrefs.push(ref); }
        break;
      }
      case EMESH.SFACE: {
        const n = r.w();
        for (let k = 0; k < n; k++) { const surface = r.sz(), cnt = r.d(), faces = new Uint32Array(cnt); for (let i = 0; i < cnt; i++) faces[i] = r.d(); m.sfaces.push({ surface, faces }); }
        break;
      }
      case EMESH.VMAPS2: case EMESH.VMAPS1: {
        const n = r.d();
        for (let k = 0; k < n; k++) {
          const name = r.sz(), dim = r.b(), poly = c.id === EMESH.VMAPS2 ? r.b() !== 0 : false, type = r.b(), size = r.d();
          const data = new Float32Array(size * dim);
          for (let i = 0; i < size * dim; i++) data[i] = r.f();
          const vertices = new Uint32Array(size);
          for (let i = 0; i < size; i++) vertices[i] = r.d();
          let faces: Uint32Array | null = null;
          if (poly) { faces = new Uint32Array(size); for (let i = 0; i < size; i++) faces[i] = r.d(); }
          m.vmaps.push({ name, dim, poly, type, data, vertices, faces });
        }
        break;
      }
    }
    if (r.pos > c.end) throw new Error(`.object: чанк меша 0x${c.id.toString(16)} разобран неверно`);
  }
  return m;
}

export function parseObject(buf: ArrayBuffer): XrObject {
  const top = chunksOf(buf, 0, buf.byteLength).find((c) => c.id === EOBJ.MAIN);
  if (!top) throw new Error('Не объект X-Ray SDK (.object): нет чанка 0x7777');
  const o: XrObject = { version: 0, flags: 0, userdata: '', lodRef: '', surfaces: [], meshes: [], revision: null, extra: [] };
  for (const c of chunksOf(buf, top.start, top.end)) {
    const r = new R(buf, c.start, c.end);
    switch (c.id) {
      case EOBJ.VERSION: o.version = r.w(); break;
      case EOBJ.FLAGS: o.flags = r.d(); break;
      case EOBJ.USERDATA: o.userdata = r.sz(); break;
      case EOBJ.LOD_REF: o.lodRef = r.sz(); break;
      case EOBJ.MESHES: for (const mc of chunksOf(buf, c.start, c.end)) o.meshes.push(parseMesh(buf, mc.start, mc.end)); break;
      case EOBJ.SURFACES3: case EOBJ.SURFACES2: {
        const n = r.d();
        for (let k = 0; k < n; k++) {
          const s: XrSurface = { name: r.sz(), eshader: r.sz(), cshader: r.sz(), gamemtl: c.id === EOBJ.SURFACES3 ? r.sz() : 'default', texture: r.sz(), vmap: r.sz(), flags: r.d(), fvf: r.d(), };
          r.d(); // число наборов UV
          o.surfaces.push(s);
        }
        break;
      }
      case EOBJ.REVISION: o.revision = { owner: r.sz(), created: r.d(), modifier: r.sz(), modified: r.d() }; break;
      default: o.extra.push({ id: c.id, data: new Uint8Array(buf.slice(c.start, c.end)) });
    }
  }
  if (o.version !== 0x10) throw new Error(`.object версии 0x${o.version.toString(16)} не поддерживается (нужна 0x10, SDK ТЧ/ЧН/ЗП)`);
  return o;
}

/** Меш для показа: по грани на угол — точка + UV из vmref; нормали по группам сглаживания. */
export interface XrObjectMesh { name: string; surface: XrSurface | undefined; pos: Float32Array; nor: Float32Array; uv: Float32Array; indices: Uint32Array }

export function objectMeshes(o: XrObject, smoothing: 'auto' | 'cop' | 'soc' = 'auto'): XrObjectMesh[] {
  const out: XrObjectMesh[] = [];
  for (const m of o.meshes) {
    const nf = m.faces.length / 6, P = m.points;
    // нормали граней
    const fn = new Float32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      const a = m.faces[f * 6]! * 3, b = m.faces[f * 6 + 2]! * 3, c = m.faces[f * 6 + 4]! * 3;
      const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!, vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
      // нормаль = (b − a) × (c − a): так же, как у скомпилированного уровня (сверено на labx8: обход граней сохраняется)
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      fn[f * 3] = nx; fn[f * 3 + 1] = ny; fn[f * 3 + 2] = nz;
    }
    // грани вокруг точки
    const around: number[][] = Array.from({ length: P.length / 3 }, () => []);
    for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) around[m.faces[f * 6 + k * 2]!]!.push(f);
    // ЗП (SDK 0.7): в sg по биту на ребро грани (бит k — ребро k→k+1 жёсткое); ТЧ/ЧН: маска групп сглаживания.
    // Флага формата в файле нет: значения меньше 8 у всех граней считаем рёбрами (как выяснено на объектах SDK 0.7).
    const sgv = m.sg, copEdges = smoothing === 'cop' || (smoothing === 'auto' && !!sgv && sgv.every((v) => v < 8));
    const hard = new Set<string>();
    if (copEdges) for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) if ((sgv![f]! >> k) & 1) {
      const a = m.faces[f * 6 + k * 2]!, b = m.faces[f * 6 + ((k + 1) % 3) * 2]!;
      hard.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
    const others = (f: number, pt: number) => { const r: number[] = []; for (let k = 0; k < 3; k++) { const q = m.faces[f * 6 + k * 2]!; if (q !== pt) r.push(q); } return r; };
    /** Грани, нормали которых сглаживаются с гранью f в точке pt. */
    const smoothFan = (f: number, pt: number): number[] => {
      if (!sgv) return around[pt]!;
      if (!copEdges) { const g0 = sgv[f]!; return g0 ? around[pt]!.filter((g) => g === f || (sgv[g]! & g0) !== 0) : [f]; }
      const seen = new Set([f]), stack = [f];
      while (stack.length) {
        const g = stack.pop()!;
        for (const q of others(g, pt)) {
          if (hard.has(pt < q ? `${pt}_${q}` : `${q}_${pt}`)) continue;
          for (const h of around[pt]!) if (!seen.has(h) && others(h, pt).includes(q)) { seen.add(h); stack.push(h); }
        }
      }
      return [...seen];
    };
    const uvOf = (vmref: number): [number, number] => {
      const ref = m.vmrefs[vmref];
      if (!ref) return [0, 0];
      for (const [vm, idx] of ref) { const map = m.vmaps[vm]; if (map && map.type === 0 && map.dim === 2) return [map.data[idx * 2]!, map.data[idx * 2 + 1]!]; }
      return [0, 0];
    };
    for (const sf of m.sfaces.length ? m.sfaces : [{ surface: o.surfaces[0]?.name ?? '', faces: Uint32Array.from({ length: nf }, (_, i) => i) }]) {
      const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [], key = new Map<string, number>();
      for (const f of sf.faces) {
        for (let k = 0; k < 3; k++) {
          const pt = m.faces[f * 6 + k * 2]!, vr = m.faces[f * 6 + k * 2 + 1]!;
          let nx = 0, ny = 0, nz = 0;
          for (const g of smoothFan(f, pt)) { nx += fn[g * 3]!; ny += fn[g * 3 + 1]!; nz += fn[g * 3 + 2]!; }
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          const [u, v] = uvOf(vr), k2 = `${pt}|${u}|${v}|${nx.toFixed(3)}|${ny.toFixed(3)}|${nz.toFixed(3)}`;
          let vi = key.get(k2);
          if (vi === undefined) {
            vi = pos.length / 3; key.set(k2, vi);
            pos.push(P[pt * 3]!, P[pt * 3 + 1]!, P[pt * 3 + 2]!); nor.push(nx, ny, nz); uv.push(u, v);
          }
          idx.push(vi);
        }
      }
      if (idx.length) out.push({ name: `${m.name}: ${sf.surface}`, surface: o.surfaces.find((s) => s.name === sf.surface), pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: Float32Array.from(uv), indices: Uint32Array.from(idx) });
    }
  }
  return out;
}
