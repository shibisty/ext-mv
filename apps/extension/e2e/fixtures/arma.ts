// Synthetic Arma files for tests: PBO, a rapified config, PAA, ODOL v73 (one visual LOD).
import { Bin } from './bin';

const asciiz = (b: Bin, s: string) => { b.bytes(new TextEncoder().encode(s)); b.u8(0); };

/** An LZO stream (compressed with liblzo2 lzo1x_1) and its source: repeats, LCG "noise", a run of zeros. */
export const LZO_SAMPLE_B64 =
  'ACAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMSAAAACYxwBhYmMgAAAAYwgAAAAAycZ+gWtL++L7VPa933wc4YcBvzHeVnIPR2dmh1mqiDxZ6lYTe9KFodg8VFUvN65lW9oCeZjM4xp2jl/ZmY8fPzbuQ3hNDfq+ptrkho7cKW1O/1bhcCD7j7FYBZDFCdxTzao7SJlS01KdBp/qtcIGE5hJsgEerDKIMZxSRpVxNo9X9jkdFvqIdPWYfBdcQbttcY4PcFnHARsvMz2RwB2lDQ2rM41+Xo8+5mh0pjqxw5MRqGTH28rgYOHzvwkAZ6LjJaAhMYfVYsWoT34uCWuUn7BtqZ5aC0ZwgLbPRwympSrYrPug67d5JHIjkkiAxaanhbfXjJDkq2NEUmbjnDMl+V6qunNgXUtxfr6pjFcZccPKXuUqM6yIUWahe3VnZJpp729WQqAdUcUC97uSRb5vDbY4zBD9u1RRHHsHlCeTfZLD1MalYVEBODinv/EEDRWbgB+D1aRpiHyftgHakxdFixKyAjNcUNbhVqStQkpc3YZh6QMS4Q+b6iYsYdxiSGttFOADhUpyRtqWyH0c0QU+5ZJwQ19sAwWz67MgNU1+ZlABNsAz4Q/JOC7pKRlPXrHRSYs7U/2fP+4lJTV7DRGvTBGMMtTaf9gWV+Gmzn3BrmK/E+SHTDrBswxZmUdYWr14fLpQAe0b6opJiO7WFIWrsCzeNZMRLQEc1yhDMOewCO15mRNR0jp3rT20+MfKAyLSycYnDwTOej/AaCzPcmoJwkIAcl5BNPiWaT+9OliRi+HMorGS3XehNf7zS7yx4zcRDcdlvvFh5V4G/zXHdold9G5KzLVUfvEVyKCZj1xwC+8UxuUKnBm0HUzOVgbcQhEl55ZvDyE93/lXRw3fK2r8d43V6dn5teDrcoQajkIUHYpuX5I6+wvl9uTAn0XWKoO/sc1qxL+M3t+y93n3YFf8Oz17LsucQXsnpeNIWBUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAIVYACD7zDkNZJpp729WQqAdUcUC97uSRREAAA==';
export function lzoSampleInput(): Uint8Array {
  const out: number[] = [];
  for (let r = 0; r < 20; r++) for (let i = 0; i < 50; i++) out.push(i);
  for (let r = 0; r < 300; r++) out.push(97, 98, 99);
  const noise: number[] = [];
  let x = 1;
  for (let i = 0; i < 700; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; noise.push((x >> 16) & 255); }
  out.push(...noise);
  for (let i = 0; i < 3000; i++) out.push(0);
  out.push(...noise.slice(0, 300));
  return Uint8Array.from(out);
}

/** BI LZSS: literals only (flag 0xFF per 8 bytes) + checksum. */
export function lzssLiterals(data: Uint8Array, signed = false): Uint8Array {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < data.length; i += 8) {
    out.push(0xff);
    for (let k = i; k < Math.min(data.length, i + 8); k++) { out.push(data[k]!); sum = (sum + (signed ? (data[k]! << 24) >> 24 : data[k]!)) | 0; }
  }
  out.push(sum & 255, (sum >>> 8) & 255, (sum >>> 16) & 255, (sum >>> 24) & 255);
  return Uint8Array.from(out);
}

// ---------- rapified config ----------
export type RapIn = { [k: string]: string | number | RapIn | Array<string | number> | { __base: string; body: RapIn } };
/** A simplified rapify: classes (with body references), strings, floats, string/number arrays. "__base" is inheritance. */
export function rapify(root: RapIn): Uint8Array {
  const b = new Bin();
  b.u8(0); b.ascii('raP'); b.u32(0); b.u32(8); b.u32(0); // enum offset (unused)
  const cint = (n: number) => { while (n >= 0x80) { b.u8((n & 0x7f) | 0x80); n >>>= 7; } b.u8(n); };
  const body = (cls: RapIn, base: string) => {
    asciiz(b, base);
    const keys = Object.keys(cls);
    cint(keys.length);
    const patches: Array<[number, RapIn, string]> = [];
    for (const k of keys) {
      const v = cls[k]!;
      if (typeof v === 'string') { b.u8(1); b.u8(0); asciiz(b, k); asciiz(b, v); }
      else if (typeof v === 'number') { b.u8(1); b.u8(1); asciiz(b, k); b.f32(v); }
      else if (Array.isArray(v)) {
        b.u8(2); asciiz(b, k); cint(v.length);
        for (const e of v) { if (typeof e === 'string') { b.u8(0); asciiz(b, e); } else { b.u8(1); b.f32(e); } }
      } else {
        b.u8(0); asciiz(b, k);
        patches.push([b.pos, '__base' in v ? (v.body as RapIn) : (v as RapIn), '__base' in v ? (v.__base as string) : '']);
        b.u32(0);
      }
    }
    for (const [at, c, bs] of patches) { const here = b.pos; b.patchU32(at, here); body(c, bs); }
  };
  body(root, '');
  return b.toU8();
}

// ---------- PBO ----------
export function makePbo(prefix: string, files: Record<string, Uint8Array>): Uint8Array {
  const b = new Bin();
  b.u8(0); b.u32(0x56657273); b.u32(0); b.u32(0); b.u32(0); b.u32(0);
  asciiz(b, 'prefix'); asciiz(b, prefix); b.u8(0);
  for (const [n, d] of Object.entries(files)) { asciiz(b, n); b.u32(0); b.u32(d.length); b.u32(0); b.u32(0); b.u32(d.length); }
  b.u8(0); for (let i = 0; i < 5; i++) b.u32(0);
  for (const d of Object.values(files)) b.bytes(d);
  return b.toU8();
}

// ---------- PAA ----------
/** PAA DXT1 4×4 (one block): c0 = red, c1 = blue, every pixel is c0. LZO is not used. */
export function makePaaDxt1(): Uint8Array {
  const b = new Bin();
  b.u16(0xff01);
  b.ascii('GGATCGVA'); b.u32(4); b.u32(0xff0000ff);
  b.u16(0); // palette
  b.u16(4); b.u16(4); b.u8(8); b.u8(0); b.u8(0);
  b.u16(0xf800); b.u16(0x001f); b.u32(0);
  b.u16(0); b.u16(0);
  return b.toU8();
}
/** PAA ARGB8888 2×1, LZSS-compressed data. */
export function makePaaArgb(): Uint8Array {
  const px = Uint8Array.from([0, 0, 255, 255, 0, 255, 0, 128]); // BGRA: red, semi-transparent green
  const packed = lzssLiterals(px, true).subarray(0, -4);
  const sum = px.reduce((s, x) => (s + ((x << 24) >> 24)) | 0, 0);
  const b = new Bin();
  b.u16(0x8888); b.u16(0);
  b.u16(2); b.u16(1);
  const size = packed.length + 4;
  b.u8(size & 255); b.u8((size >> 8) & 255); b.u8(0);
  b.bytes(packed); b.u32(sum >>> 0);
  b.u16(0); b.u16(0);
  return b.toU8();
}

// ---------- ODOL v73 ----------
export interface OdolIn {
  /** Triangles/quads by section: a section = a texture + a face list. */
  sections: Array<{ texture: string; faces: number[][]; selection?: string }>;
  pos: number[][];
  uv: number[][];
  proxies?: Array<{ model: string; pos: number[]; section: number }>;
  boundingCenter?: number[];
}
export function makeOdol(m: OdolIn): Uint8Array {
  const b = new Bin(), v = 73;
  b.ascii('ODOL'); b.u32(v);
  b.u32(0); // appID
  asciiz(b, '');
  b.u32(2); b.f32(1); b.f32(1e15); // LODs: visual and "memory"
  // ModelInfo
  b.i32(0); b.f32(1); b.f32(1); b.i32(0); b.i32(0); b.i32(0); b.f32(0); b.f32(0); b.f32(0); b.u32(0); b.u32(0); b.f32(0);
  for (let i = 0; i < 6; i++) b.f32(0); // bbox
  b.f32(1); b.f32(1); // v70, v71
  for (let i = 0; i < 6; i++) b.f32(0); // bbox visual
  const bc = m.boundingCenter ?? [0, 0, 0];
  b.f32(bc[0]!); b.f32(bc[1]!); b.f32(bc[2]!);
  for (let i = 0; i < 6; i++) b.f32(0); // geometryCenter, centerOfMass
  for (let i = 0; i < 9; i++) b.f32(0); // invInertia
  b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0); // flags + AICovers
  for (let i = 0; i < 6; i++) b.f32(0); // ht/af/mf, mFact, tBody
  b.u8(0); b.i32(0); b.u8(0); b.f32(0); // forceNotAlpha, sbSource, preferShadowVolume, shadowOffset
  b.u8(0); // animated
  asciiz(b, 'TestSkeleton'); b.u8(0); b.u32(1); asciiz(b, 'bone'); asciiz(b, ''); asciiz(b, '');
  b.u8(0); // mapType
  b.u32(0); // massArray
  for (let i = 0; i < 5; i++) b.f32(0); // mass … explosionShielding
  b.u8(0); b.u8(0); // geometrySimple, geometryPhys
  for (let i = 0; i < 12; i++) b.u8(255);
  b.u32(0); b.u8(0); // minShadow, canBlend
  asciiz(b, 'weapon'); asciiz(b, ''); b.u8(0); b.u32(0);
  for (let i = 0; i < 2 * 3; i++) b.i32(-1); // preferred*Lod
  b.u8(0); // hasAnims
  const startAt = b.pos;
  b.u32(0); b.u32(0); b.u32(0); b.u32(0); // start[2], end[2]
  b.u8(1); b.u8(1); // permanent (not read)
  const lod0 = b.pos;
  b.patchU32(startAt, lod0);
  writeLod(b, m);
  const lod1 = b.pos;
  b.patchU32(startAt + 4, lod1);
  writeLod(b, { sections: [], pos: [], uv: [] });
  b.patchU32(startAt + 8, lod1); b.patchU32(startAt + 12, b.pos);
  return b.toU8();
}

function writeLod(b: Bin, m: OdolIn) {
  const comp = (bytes: Uint8Array) => { b.u8(0); b.bytes(bytes); }; // "uncompressed" flag (v ≥ 64)
  const proxies = m.proxies ?? [];
  b.u32(proxies.length);
  proxies.forEach((p, i) => {
    asciiz(b, p.model);
    for (const x of [1, 0, 0, 0, 1, 0, 0, 0, 1]) b.f32(x);
    b.f32(p.pos[0]!); b.f32(p.pos[1]!); b.f32(p.pos[2]!);
    b.i32(i); b.i32(i); b.i32(-1); b.i32(p.section);
  });
  b.u32(0); b.u32(0); // subSkeletons
  b.u32(m.pos.length); b.f32(0); b.i32(0); b.i32(0);
  for (let i = 0; i < 10; i++) b.f32(0);
  b.u32(m.sections.length); for (const s of m.sections) asciiz(b, s.texture);
  b.u32(0); // materials
  b.u32(0); b.u32(0); // pointToVertex, vertexToPoint (empty)
  const faces = m.sections.flatMap((s) => s.faces);
  b.u32(faces.length); b.u32(0); b.u16(0);
  for (const f of faces) { b.u8(f.length); for (const i of f) b.i32(i); }
  b.u32(m.sections.length);
  let off = 0;
  m.sections.forEach((s, si) => {
    const lo = off;
    for (const f of s.faces) off += f.length === 4 ? 20 : 16;
    b.i32(lo); b.i32(off); b.i32(0); b.i32(0); b.u32(0); b.u16(si); b.u32(0); b.i32(-1); asciiz(b, '');
    b.u32(1); b.f32(1); b.i32(0);
  });
  const sels = m.sections.map((s, si) => [s.selection, si] as const).filter((x): x is [string, number] => !!x[0]);
  b.u32(sels.length);
  for (const [name, si] of sels) { asciiz(b, name); b.u32(0); b.i32(0); b.u8(1); b.u32(1); comp(Uint8Array.from([si, 0, 0, 0])); b.u32(0); b.u32(0); }
  b.u32(0); b.u32(0); // properties, frames
  b.i32(0); b.i32(0); b.i32(0); b.u8(0); b.u32(0);
  b.u32(m.pos.length); b.u8(1); b.i32(0); // clip: condensed, all equal
  // UV (quantized int16 in [0,1])
  b.f32(0); b.f32(0); b.f32(1); b.f32(1); b.u32(m.uv.length); b.u8(0);
  const uv = new Bin();
  for (const [u, vv] of m.uv) { uv.u16((Math.round(u! * 65536) - 32767) & 0xffff); uv.u16((Math.round(vv! * 65536) - 32767) & 0xffff); }
  if (m.uv.length) comp(uv.toU8());
  b.u32(1);
  b.u32(m.pos.length); if (m.pos.length) { const p = new Bin(); for (const q of m.pos) { p.f32(q[0]!); p.f32(q[1]!); p.f32(q[2]!); } comp(p.toU8()); }
  b.u32(m.pos.length); b.u8(1); b.i32(513 << 10); // condensed normals: all (0,1,0), a 10-bit −511 in the Y field
  b.u32(0); b.u32(0); b.u32(0); // ST, boneRef, neighborBoneRef
  b.u32(0); b.u8(0); // v67, v68
}
