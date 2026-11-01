// Синтетический ресурс RAGE (RSC7) для тестов: drawable (.ydr) или словарь (.ydd) с одной геометрией,
// шейдером «DiffuseSampler» и встроенной DXT1-текстурой; отдельный словарь текстур (.ytd).
import { deflateRawSync } from 'node:zlib';
import { joaat } from '../../src/engines/rage/rsc';

const SEG = 0x2000; // размер каждого сегмента: флаги 1 << 17 (16 × 0x200)
const FLAGS = 1 << 17;

class Seg {
  u8 = new Uint8Array(SEG);
  dv = new DataView(this.u8.buffer);
  top = 0;
  constructor(readonly base: number) {}
  alloc(n: number) { const at = this.top; this.top += (n + 15) & ~15; return at; }
  /** Указатель на блок системного сегмента. */
  p(at: number, target: number) { this.dv.setUint32(at, 0x50000000 + target, true); this.dv.setUint32(at + 4, 0, true); }
  /** Указатель на данные графического сегмента. */
  g(at: number, target: number) { this.dv.setUint32(at, 0x60000000 + target, true); this.dv.setUint32(at + 4, 0, true); }
  str(s: string) { const at = this.alloc(s.length + 1); for (let i = 0; i < s.length; i++) this.u8[at + i] = s.charCodeAt(i); return at; }
}

function pack(sys: Seg, gfx: Seg): Uint8Array {
  const body = new Uint8Array(SEG * 2);
  body.set(sys.u8, 0); body.set(gfx.u8, SEG);
  const z = deflateRawSync(body), out = new Uint8Array(16 + z.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x37435352, true); dv.setUint32(4, 165, true); dv.setUint32(8, FLAGS, true); dv.setUint32(12, FLAGS, true);
  out.set(z, 16);
  return out;
}

/** Текстура DXT1 4×4 (красная) в системном сегменте, данные — в графическом. */
function texture(sys: Seg, gfx: Seg, name: string): number {
  const t = sys.alloc(0x90), nm = sys.str(name);
  sys.p(t + 0x28, nm);
  sys.dv.setUint16(t + 0x50, 4, true); sys.dv.setUint16(t + 0x52, 4, true); sys.dv.setUint16(t + 0x54, 1, true); sys.dv.setUint16(t + 0x56, 8, true);
  sys.dv.setUint32(t + 0x58, 0x31545844, true); sys.u8[t + 0x5d] = 1;
  const d = gfx.alloc(8);
  gfx.dv.setUint16(d, 0xf800, true); gfx.dv.setUint16(d + 2, 0x001f, true);
  sys.g(t + 0x70, d);
  return t;
}
function texDict(sys: Seg, gfx: Seg, names: string[]): number {
  const td = sys.alloc(0x40), list = sys.alloc(8 * names.length);
  names.forEach((n, i) => sys.p(list + i * 8, texture(sys, gfx, n)));
  sys.p(td + 0x30, list); sys.dv.setUint16(td + 0x38, names.length, true); sys.dv.setUint16(td + 0x3a, names.length, true);
  return td;
}

function drawable(sys: Seg, gfx: Seg, at: number, texName: string, embed: boolean, z: number) {
  // вершины: Position Float3 (тип 6), Normal Float3 (6), TexCoord0 Float2 (5) — флаги битов 0, 3, 6
  const decl = sys.alloc(16);
  sys.dv.setUint32(decl, (1 << 0) | (1 << 3) | (1 << 6), true); sys.dv.setUint16(decl + 4, 32, true); sys.u8[decl + 7] = 3;
  sys.dv.setUint32(decl + 8, (6 << 0) | (6 << 12) | (5 << 24), true);
  const verts = [[0, 0, z], [1, 0, z], [0, 1, z]], vd = gfx.alloc(32 * 3);
  verts.forEach((v, i) => { const o = vd + i * 32; v.forEach((c, k) => gfx.dv.setFloat32(o + k * 4, c, true)); gfx.dv.setFloat32(o + 20, 1, true); gfx.dv.setFloat32(o + 24, v[0]!, true); gfx.dv.setFloat32(o + 28, v[1]!, true); });
  const vb = sys.alloc(0x80);
  sys.dv.setUint16(vb + 8, 32, true); sys.g(vb + 0x10, vd); sys.dv.setUint32(vb + 0x18, 3, true); sys.p(vb + 0x30, decl);
  const id = gfx.alloc(6); [0, 1, 2].forEach((x, i) => gfx.dv.setUint16(id + i * 2, x, true));
  const ib = sys.alloc(0x60); sys.dv.setUint32(ib + 8, 3, true); sys.g(ib + 0x10, id);
  const geo = sys.alloc(0x98); sys.p(geo + 0x18, vb); sys.p(geo + 0x38, ib); sys.dv.setUint32(geo + 0x58, 3, true); sys.dv.setUint16(geo + 0x60, 3, true);
  const geos = sys.alloc(8); sys.p(geos, geo);
  const map = sys.alloc(2); sys.dv.setUint16(map, 0, true);
  const model = sys.alloc(0x30); sys.p(model + 8, geos); sys.dv.setUint16(model + 0x10, 1, true); sys.p(model + 0x20, map);
  const models = sys.alloc(8); sys.p(models, model);
  const hdr = sys.alloc(16); sys.p(hdr, models); sys.dv.setUint16(hdr + 8, 1, true); sys.dv.setUint16(hdr + 10, 1, true);
  // шейдер: один параметр-текстура с хэшем DiffuseSampler
  const tb = sys.alloc(0x50); sys.p(tb + 0x28, sys.str(texName));
  const params = sys.alloc(16 + 4); sys.u8[params] = 0; sys.p(params + 8, tb); sys.dv.setUint32(params + 16, joaat('DiffuseSampler'), true);
  const fx = sys.alloc(0x30); sys.p(fx, params); sys.u8[fx + 0x10] = 1;
  const fxs = sys.alloc(8); sys.p(fxs, fx);
  const sg = sys.alloc(0x40); sys.p(sg + 0x10, fxs); sys.dv.setUint16(sg + 0x18, 1, true);
  if (embed) sys.p(sg + 0x8, texDict(sys, gfx, [texName]));
  sys.p(at + 0x10, sg); sys.p(at + 0x50, hdr);
}

export function makeYdr(texName = 'body_diff', embed = true): Uint8Array {
  const sys = new Seg(0x50000000), gfx = new Seg(0x60000000);
  const root = sys.alloc(0xd0);
  drawable(sys, gfx, root, texName, embed, 0);
  return pack(sys, gfx);
}
/** Словарь из двух drawable (смещены по Z), текстуры — внешние. */
export function makeYdd(texName: string): Uint8Array {
  const sys = new Seg(0x50000000), gfx = new Seg(0x60000000);
  const root = sys.alloc(0x40), d0 = sys.alloc(0xd0), d1 = sys.alloc(0xd0);
  drawable(sys, gfx, d0, texName, false, 0); drawable(sys, gfx, d1, texName, false, 2);
  const hashes = sys.alloc(8), list = sys.alloc(16);
  sys.dv.setUint32(hashes, joaat('a'), true); sys.dv.setUint32(hashes + 4, joaat('b'), true);
  sys.p(list, d0); sys.p(list + 8, d1);
  sys.p(root + 0x20, hashes); sys.dv.setUint16(root + 0x28, 2, true); sys.p(root + 0x30, list); sys.dv.setUint16(root + 0x38, 2, true);
  return pack(sys, gfx);
}
export function makeYtd(names: string[]): Uint8Array {
  const sys = new Seg(0x50000000), gfx = new Seg(0x60000000);
  const root = sys.alloc(0x40);
  const td = texDict(sys, gfx, names);
  sys.u8.copyWithin(root, td, td + 0x40); // словарь — корневой блок
  return pack(sys, gfx);
}
