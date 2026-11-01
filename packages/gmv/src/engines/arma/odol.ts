// ODOL — бинаризованные модели P3D (Arma: Armed Assault … Arma 3, DayZ), версии 28–75.
// Читаются заголовок, ModelInfo (чтобы дойти до адресов LOD), затем нужные LOD целиком:
// вершины, нормали, UV, грани, секции (текстура/материал), именованные выделения и прокси.
import { lzo1xDecompress } from '../../core/codecs/lzo';
import { lzssDecompress } from './lzss';

export interface OdolSection { faceLo: number; faceHi: number; texture: number; material: number; materialName?: string }
export interface OdolSelection { name: string; sectional: boolean; sections: number[]; vertices: Int32Array }
export interface OdolProxy { model: string; matrix: Float32Array; selection: number; bone: number; section: number }
export interface OdolLod {
  resolution: number;
  textures: string[];
  materials: Array<{ name: string; stages: string[] }>;
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  /** Грани: индексы вершин (3 или 4). */
  faces: Int32Array[];
  sections: OdolSection[];
  selections: OdolSelection[];
  proxies: OdolProxy[];
  properties: Array<[string, string]>;
  /** Индексы костей (подскелет -> скелет) и веса на вершину (до 4 пар «кость, вес»). */
  subSkeleton: Int32Array;
  boneRef: Uint8Array;
  /** Индексы граней int32 (v ≥ 69): влияет на смещения граней в секциях. */
  wide: boolean;
}
export interface OdolModel {
  version: number;
  resolutions: number[];
  skeleton: { name: string; bones: Array<[string, string]> } | null;
  modelClass: string;
  centerOfMass: number[];
  boundingCenter: number[];
  /** Ленивая загрузка LOD по номеру. */
  lod(i: number): OdolLod;
}

class R {
  p = 0;
  dv: DataView;
  constructor(readonly u8: Uint8Array, readonly v: number) { this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  u8_() { return this.u8[this.p++]!; }
  bool() { return this.u8[this.p++] !== 0; }
  u16() { const x = this.dv.getUint16(this.p, true); this.p += 2; return x; }
  i32() { const x = this.dv.getInt32(this.p, true); this.p += 4; return x; }
  u32() { const x = this.dv.getUint32(this.p, true); this.p += 4; return x; }
  f32() { const x = this.dv.getFloat32(this.p, true); this.p += 4; return x; }
  vec() { return [this.f32(), this.f32(), this.f32()]; }
  skip(n: number) { this.p += n; }
  str() {
    const e = this.u8.indexOf(0, this.p);
    const end = e < 0 ? this.u8.length : e;
    let s = '';
    for (let i = this.p; i < end; i++) s += String.fromCharCode(this.u8[i]!);
    this.p = end + 1;
    return s;
  }
  /** Сжатый блок ожидаемого размера: LZO (v ≥ 44, флаг-байт с v64) или LZSS, если ≥ 1024 байт. */
  compressed(size: number): Uint8Array {
    if (size === 0) return new Uint8Array(0);
    if (this.v >= 44) {
      const packed = this.v >= 64 ? this.bool() : size >= 1024;
      if (!packed) { const out = this.u8.subarray(this.p, this.p + size); this.p += size; return out; }
      const out = new Uint8Array(size);
      this.p = lzo1xDecompress(this.u8, this.p, out);
      return out;
    }
    if (size < 1024) { const out = this.u8.subarray(this.p, this.p + size); this.p += size; return out; }
    const { data, end } = lzssDecompress(this.u8, this.p, size);
    this.p = end;
    return data;
  }
  /** Сжатый массив: u32 count + блок count*elem. */
  carr(elem: number): { n: number; data: Uint8Array } { const n = this.u32(); return { n, data: this.compressed(n * elem) }; }
  /** «Condensed»-массив: count, флаг «все одинаковые» (+ одно значение) или сжатый блок. */
  condensed(elem: number): { n: number; data: Uint8Array; fill: boolean } {
    const n = this.u32();
    if (this.bool()) { const one = this.u8.slice(this.p, this.p + elem); this.p += elem; return { n, data: one, fill: true }; }
    return { n, data: this.compressed(n * elem), fill: false };
  }
  /** Индексы вершин: u16 до v69, int32 после. */
  indexArray(): Int32Array {
    const w = this.v >= 69 ? 4 : 2, { n, data } = this.carr(w), dv = new DataView(data.buffer, data.byteOffset, data.byteLength), out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = w === 4 ? dv.getInt32(i * 4, true) : (dv.getUint16(i * 2, true) === 0xffff ? -1 : dv.getUint16(i * 2, true));
    return out;
  }
}

export function parseOdol(u8: Uint8Array): OdolModel {
  if (u8.length < 8 || String.fromCharCode(u8[0]!, u8[1]!, u8[2]!, u8[3]!) !== 'ODOL') {
    if (String.fromCharCode(u8[0]!, u8[1]!, u8[2]!, u8[3]!) === 'MLOD') throw new Error('MLOD (небинаризованный P3D) пока не поддержан — нужен бинаризованный ODOL из PBO');
    throw new Error('Не ODOL');
  }
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
  if (v < 28 || v > 75) throw new Error(`ODOL v${v} не поддержан (поддерживаются 28–75)`);
  const r = new R(u8, v);
  r.p = 8;
  if (v >= 59) r.u32(); // appID
  if (v >= 58) r.str(); // muzzleFlash / префикс
  if (v >= 74) r.skip(8);
  const nLods = r.u32(), resolutions: number[] = [];
  for (let i = 0; i < nLods; i++) resolutions.push(r.f32());

  // ---------- ModelInfo ----------
  r.i32(); r.f32(); r.f32(); r.i32(); r.i32(); r.i32(); r.vec(); r.u32(); r.u32(); r.f32(); // special … viewDensity
  r.vec(); r.vec(); // bbox
  if (v >= 70) r.f32();
  if (v >= 71) r.f32();
  if (v >= 52) { r.vec(); r.vec(); }
  const boundingCenter = r.vec();
  r.vec(); // geometryCenter
  const centerOfMass = r.vec();
  r.skip(36); // invInertia
  r.skip(4); // autoCenter, lockAutoCenter, canOcclude, canBeOccluded
  if (v >= 73) r.skip(1);
  if (v >= 42) r.skip(16);
  if (v >= 43) r.skip(8);
  if (v >= 33) r.skip(1);
  if (v >= 37) r.skip(5);
  if (v >= 48) r.skip(4);
  r.bool(); // animated
  // скелет
  let skeleton: OdolModel['skeleton'] = null;
  const skName = r.str();
  if (skName) {
    if (v >= 23) r.bool();
    const nb = r.u32(), bones: Array<[string, string]> = [];
    for (let i = 0; i < nb; i++) bones.push([r.str(), r.str()]);
    if (v > 40) r.str();
    skeleton = { name: skName, bones };
  }
  r.u8_(); // mapType
  { const n = r.u32(); r.compressed(n * 4); } // massArray
  r.skip(16); // mass, invMass, armor, invArmor
  if (v >= 72) r.skip(4);
  if (v >= 53) r.skip(1);
  if (v >= 54) r.skip(1);
  r.skip(12); // memory … hitpoints (12 байт)
  r.skip(4); // minShadow
  if (v >= 38) r.skip(1);
  const modelClass = r.str();
  r.str(); // damage
  r.bool(); // frequent
  if (v >= 31) r.skip(4);
  if (v >= 57) r.skip(nLods * 12);

  // ---------- анимации (только пропуск) ----------
  if (v >= 30 && r.bool()) {
    const nAnim = r.u32(), types: number[] = [];
    for (let i = 0; i < nAnim; i++) {
      const t = r.u32();
      types.push(t);
      r.str(); r.str(); r.skip(16);
      if (v >= 56) r.skip(8);
      r.skip(4);
      if (t <= 7) r.skip(8);
      else if (t === 8) r.skip(32);
      else if (t === 9) r.skip(v >= 55 ? 8 : 4);
      else throw new Error(`ODOL: неизвестный тип анимации ${t}`);
    }
    const nAnimLods = r.u32();
    for (let l = 0; l < nAnimLods; l++) { const nb = r.u32(); for (let b = 0; b < nb; b++) r.skip(4 * r.u32()); }
    for (let l = 0; l < nAnimLods; l++)
      for (let a = 0; a < nAnim; a++) if (r.i32() !== -1 && types[a]! !== 8 && types[a]! !== 9) r.skip(24);
  }

  const start: number[] = [], end: number[] = [];
  for (let i = 0; i < nLods; i++) start.push(r.u32());
  for (let i = 0; i < nLods; i++) end.push(r.u32());
  const cache = new Map<number, OdolLod>();
  return {
    version: v, resolutions, skeleton, modelClass, centerOfMass, boundingCenter,
    lod(i) {
      let l = cache.get(i);
      if (!l) {
        if (i < 0 || i >= nLods) throw new Error(`ODOL: нет LOD ${i}`);
        const lr = new R(u8, v);
        lr.p = start[i]!;
        l = readLod(lr, resolutions[i]!);
        cache.set(i, l);
      }
      return l;
    },
  };
}

function readLod(r: R, resolution: number): OdolLod {
  const v = r.v;
  // прокси
  const proxies: OdolProxy[] = [];
  for (let n = r.u32(), i = 0; i < n; i++) {
    const model = r.str(), m = new Float32Array(12);
    for (let k = 0; k < 12; k++) m[k] = r.f32();
    r.i32();
    const selection = r.i32(), bone = r.i32(), section = v >= 40 ? r.i32() : -1;
    proxies.push({ model, matrix: m, selection, bone, section });
  }
  const nSub = r.u32(), subSkeleton = new Int32Array(nSub);
  for (let i = 0; i < nSub; i++) subSkeleton[i] = r.i32();
  for (let n = r.u32(), i = 0; i < n; i++) r.skip(4 * r.u32()); // skeletonToSubSkeleton
  if (v >= 50) r.u32(); else r.condensed(4);
  if (v >= 51) r.f32();
  r.skip(8); // or/and hints
  r.skip(40); // bMin, bMax, bCenter, bRadius
  const textures: string[] = [];
  for (let n = r.u32(), i = 0; i < n; i++) textures.push(r.str());
  const materials: OdolLod['materials'] = [];
  for (let n = r.u32(), i = 0; i < n; i++) materials.push(readMaterial(r));
  r.indexArray(); // pointToVertex
  r.indexArray(); // vertexToPoint
  // грани
  const nFaces = r.u32();
  r.u32(); r.u16();
  const faces: Int32Array[] = new Array(nFaces);
  const wide = v >= 69;
  for (let i = 0; i < nFaces; i++) {
    const k = r.u8_(), f = new Int32Array(k);
    for (let j = 0; j < k; j++) f[j] = wide ? r.i32() : r.u16();
    faces[i] = f;
  }
  const sections: OdolSection[] = [];
  for (let n = r.u32(), i = 0; i < n; i++) {
    const faceLo = r.i32(), faceHi = r.i32();
    r.i32(); r.i32(); r.u32();
    const texture = r.dv.getInt16(r.p, true); r.p += 2;
    r.u32();
    const material = r.i32();
    const materialName = material === -1 ? r.str() : undefined;
    if (v >= 36) {
      r.skip(4 * r.u32());
      if (v >= 67 && r.i32() >= 1) r.skip(44);
    } else r.skip(4);
    sections.push({ faceLo, faceHi, texture, material, materialName });
  }
  const selections: OdolSelection[] = [];
  for (let n = r.u32(), i = 0; i < n; i++) {
    const name = r.str();
    r.indexArray(); // грани
    r.i32();
    const sectional = r.bool();
    const sc = r.carr(4), sdv = new DataView(sc.data.buffer, sc.data.byteOffset, sc.data.byteLength), sects: number[] = [];
    for (let k = 0; k < sc.n; k++) sects.push(sdv.getInt32(k * 4, true));
    const vertices = r.indexArray();
    r.compressed(r.u32()); // веса вершин
    selections.push({ name, sectional, sections: sects, vertices });
  }
  const properties: Array<[string, string]> = [];
  for (let n = r.u32(), i = 0; i < n; i++) properties.push([r.str(), r.str()]);
  for (let n = r.u32(), i = 0; i < n; i++) { r.f32(); r.skip(12 * r.u32()); } // кадры
  r.skip(12); // colorTop, color, special
  r.bool(); // vertexBoneRefIsSimple
  r.u32(); // sizeOfRestData
  if (v >= 50) r.condensed(4); // clip
  // UV
  const uvSets: Float32Array[] = [];
  const readUV = () => {
    let minU = 0, minV = 0, maxU = 1, maxV = 1;
    const disc = v >= 45;
    if (disc) { minU = r.f32(); minV = r.f32(); maxU = r.f32(); maxV = r.f32(); }
    const n = r.u32(), fill = r.bool(), el = disc ? 4 : 8;
    const data = fill ? r.u8.subarray(r.p, (r.p += el)) : r.compressed(n * el);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), out = new Float32Array(n * 2);
    const su = maxU - minU, sv = maxV - minV;
    for (let i = 0; i < n; i++) {
      const o = fill ? 0 : i * el;
      if (disc) {
        out[i * 2] = (dv.getInt16(o, true) + 32767) * (1 / 65536) * su + minU;
        out[i * 2 + 1] = (dv.getInt16(o + 2, true) + 32767) * (1 / 65536) * sv + minV;
      } else { out[i * 2] = dv.getFloat32(o, true); out[i * 2 + 1] = dv.getFloat32(o + 4, true); }
    }
    uvSets.push(out);
  };
  readUV();
  for (let n = r.u32(), i = 1; i < n; i++) readUV();
  // вершины и нормали
  const pv = r.carr(12), pdv = new DataView(pv.data.buffer, pv.data.byteOffset, pv.data.byteLength), pos = new Float32Array(pv.n * 3);
  for (let i = 0; i < pv.n * 3; i++) pos[i] = pdv.getFloat32(i * 4, true);
  const nor = new Float32Array(pv.n * 3);
  if (v >= 45) {
    const nc = r.condensed(4), ndv = new DataView(nc.data.buffer, nc.data.byteOffset, nc.data.byteLength);
    for (let i = 0; i < nc.n; i++) {
      const x = ndv.getInt32(nc.fill ? 0 : i * 4, true);
      const c = (s: number) => { let q = (x >> s) & 0x3ff; if (q > 511) q -= 1024; return q * (-1 / 511); };
      nor[i * 3] = c(0); nor[i * 3 + 1] = c(10); nor[i * 3 + 2] = c(20);
    }
  } else {
    const nc = r.condensed(12), ndv = new DataView(nc.data.buffer, nc.data.byteOffset, nc.data.byteLength);
    for (let i = 0; i < nc.n * 3; i++) nor[i] = ndv.getFloat32(nc.fill ? (i % 3) * 4 : i * 4, true);
  }
  // ST (касательные) — пропуск
  r.carr(v >= 45 ? 8 : 24);
  // веса костей: 12 байт на вершину (nSmall + 4 пары «индекс подскелета, вес»)
  const br = r.carr(12), boneRef = new Uint8Array(br.data);
  r.carr(32); // neighborBoneRef
  return { resolution, textures, materials, pos, nor, uv: uvSets[0] ?? new Float32Array(pv.n * 2), faces, sections, selections, proxies, properties, subSkeleton, boneRef, wide };
}

/** Встроенный материал (бинаризованный .rvmat): нужны имя и текстуры стадий. */
function readMaterial(r: R): { name: string; stages: string[] } {
  const name = r.str(), mv = r.u32();
  r.skip(6 * 16 + 4 + 16); // 6 цветов RGBA, specularPower, pixel/vertex shader, mainLight, fogMode
  if (mv === 3) r.skip(1);
  if (mv >= 6) r.str(); // surface
  if (mv >= 4) r.skip(8);
  const nStages = mv > 6 ? r.u32() : 0, nTexGens = mv > 8 ? r.u32() : 0;
  const stages: string[] = [];
  const stageTex = () => { if (mv >= 5) r.skip(4); const t = r.str(); if (mv >= 8) r.skip(4); if (mv >= 11) r.skip(1); return t; };
  if (mv < 8) for (let i = 0; i < nStages; i++) { r.skip(4 + 48); stages.push(stageTex()); }
  else {
    for (let i = 0; i < nStages; i++) stages.push(stageTex());
    for (let i = 0; i < nTexGens; i++) r.skip(4 + 48);
  }
  if (mv >= 10) stageTex(); // stageTI
  return { name, stages };
}

/** Тип LOD по разрешению: визуальные < 1000, «вид из кабины» 1000–1200, далее тени/геометрия/память. */
export function lodKind(res: number): string {
  if (res < 1000) return `визуальный ${res.toFixed(res % 1 ? 2 : 0)}`;
  if (res < 1200) return 'вид пилота';
  if (res < 1300) return 'вид стрелка';
  if (res >= 1e4 && res < 2e4) return 'тень';
  const near = (x: number) => Math.abs(res - x) < x * 0.01;
  if (near(1e13)) return 'геометрия';
  if (near(1e15)) return 'память';
  if (near(2e15)) return 'land contact';
  if (near(3e15)) return 'roadway';
  if (near(4e15)) return 'пути';
  if (near(5e15)) return 'hitpoints';
  if (near(6e15)) return 'геометрия обзора';
  if (near(7e15)) return 'геометрия огня';
  return `служебный ${res.toExponential(1)}`;
}
