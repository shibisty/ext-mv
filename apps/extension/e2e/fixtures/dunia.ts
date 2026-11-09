// Synthetic Dunia files (Far Cry 2): .fat/.dat, LZO1X (repeats), the HSEM container (.xbg/.xbm), .xbt.
import { crc32 } from '@gmvjs/core/writers/zip';
import { Bin } from './bin';

export const fc2Hash = (p: string) => crc32(new TextEncoder().encode(p.replace(/\//g, '\\').toLowerCase()));

/** LZO1X: prefix + chunk as literals, then chunk repeated by a back reference (M3) up to total bytes; the end marker. */
export function lzoRepeat(prefix: string, chunk: string, total: number): { packed: Uint8Array; plain: Uint8Array } {
  const lit = prefix + chunk;
  if (lit.length < 4 || lit.length > 238) throw new Error('lzoRepeat: литералов 4..238');
  const b = new Bin().u8(lit.length + 17).ascii(lit);
  const plain = new Uint8Array(total);
  plain.set(new TextEncoder().encode(lit));
  let op = lit.length;
  while (op < total) {
    const len = Math.min(total - op, 2000);
    const t = len - 2;
    if (t <= 31) b.u8(32 | t);
    else { b.u8(32); let r = t - 31; while (r > 255) { b.u8(0); r -= 255; } b.u8(r); }
    b.u16((chunk.length - 1) << 2);
    for (let i = 0; i < len; i++, op++) plain[op] = plain[op - chunk.length]!;
  }
  b.u8(0x11).u8(0).u8(0);
  return { packed: b.toU8(), plain };
}

export interface FatFile { path: string; data: Uint8Array; packed?: Uint8Array }

/** .fat + .dat: uncompressed records (or with ready LZO in packed). */
export function makeFat(files: FatFile[]): { fat: Uint8Array; dat: Uint8Array } {
  const dat = new Bin(), fat = new Bin().ascii('2TAF').u32(5).u32(0x301).u32(files.length);
  for (const f of files) {
    dat.align(4);
    const off = dat.length, body = f.packed ?? f.data;
    dat.bytes(body);
    fat.u32(fc2Hash(f.path)).u32((f.data.length << 2) | (f.packed ? 1 : 0)).u32(((off & 3) << 30) | body.length).u32(off >>> 2);
  }
  return { fat: fat.u32(0).toU8(), dat: dat.toU8() };
}

type ChunkSpec = { tag: string; data: Uint8Array; kids?: ChunkSpec[] };

function chunk(b: Bin, c: ChunkSpec): void {
  const at = b.length;
  b.ascii([...c.tag].reverse().join('')).u32(1).u32(0).u32(c.data.length).u32(c.kids?.length ?? 0);
  for (const k of c.kids ?? []) chunk(b, k);
  b.bytes(c.data);
  b.patchU32(at + 8, b.length - at);
}

export function makeHsem(chunks: ChunkSpec[]): Uint8Array {
  const b = new Bin().ascii('HSEM').u16(0x2a).u16(6).u32(0).u32(0).u32(0).u32(0).u32(0).u32(chunks.length);
  for (const c of chunks) chunk(b, c);
  return b.toU8();
}

const str = (b: Bin, s: string) => b.u32(s.length).cstr(s);

/** .xbm material: name, shader, textures by slot. */
export function makeXbm(name: string, shader: string, textures: Record<string, string>): Uint8Array {
  const b = new Bin().u32(0).u8(0);
  str(b, name); str(b, shader);
  b.u32(Object.keys(textures).length);
  for (const [slot, p] of Object.entries(textures)) { str(b, p); str(b, slot); }
  b.u32(0);
  return makeHsem([{ tag: 'DMTL', data: b.toU8() }]);
}

/**
 * .xbg model: a 1×1 square in the XY plane (Z up), one LOD, one "BOX_LOD0" part with node 0, material 0.
 * s16 vertices with a 1/1024 multiplier; triangles written clockwise (as in the game).
 * skinned: "Root" and "Bone" (child) nodes, 40-byte vertices fully on "Bone", O2BM is identity matrices.
 */
export function makeXbg(material: string, opts: { skinned?: boolean } = {}): Uint8Array {
  const sk = !!opts.skinned, fmt = sk ? 0xbda : 0xbca, stride = sk ? 40 : 32;
  const rm = new Bin().u32(1).u32(0); str(rm, material);
  const names = sk ? ['Root', 'Bone'] : ['BOX'];
  const nd = new Bin().u32(names.length).u32(0);
  names.forEach((n, i) => { nd.i32(-1).i32(-1).i32(i - 1).f32s(0, 0, 0, 1, 0, 0, 0, 1, 1, 1).i32(-1).f32(1).f32(1); str(nd, n); nd.u32(0); });
  const sid = new Bin().u32(1).u32(0).u16(0).u16(0);
  const skn = new Bin().u32(1).f32s(10, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0).u32(0).u32(0); str(skn, 'BOX_LOD0');
  const cl = new Bin().u32(1).u16(0).u16(2).u16(2).u16(6).u16(stride).u16(4).u16(fmt);
  for (let i = 0; i < 48; i++) cl.u16(sk && i === 0 ? 1 : 0xffff);
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const lods = new Bin().u32(1).f32(10).u32(1).u32(fmt).u32(stride).u32(4).u32(0).u32(1).u32(0).u32(0).u32(0).u32(0).u32(3).u32(0).u32(0);
  const vb = new Bin();
  for (const [x, y] of pts) {
    vb.i16(x! * 1024).i16(y! * 1024).i16(0).i16(1).i16(x! * 1024).i16(y! * 1024).i16(0).i16(0);
    if (sk) vb.u8(0xff).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0);
    vb.u8(0xff).u8(0x80).u8(0x80).u8(0).u32(0xffffffff).u32(0).u32(0);
  }
  const extra = sk ? [{ tag: 'O2BM', data: (() => { const o = new Bin().u32(2); for (let i = 0; i < 2; i++) o.f32s(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); return o.toU8(); })() }] : [];
  return buildWithLods(rm, nd, sid, skn, cl, lods, vb, extra);
}

function buildWithLods(rm: Bin, nd: Bin, sid: Bin, skn: Bin, cl: Bin, lods: Bin, vb: Bin, extra: ChunkSpec[] = []): Uint8Array {
  // LODS aligns vertices and indices to 16 from the file start: build the file knowing where the LODS data begins
  const first: ChunkSpec[] = [
    { tag: 'RMTL', data: rm.toU8() }, { tag: 'NODE', data: nd.toU8() }, ...extra, { tag: 'SKID', data: sid.toU8() },
    { tag: 'SKND', data: skn.toU8(), kids: [{ tag: 'CLUS', data: cl.toU8() }] },
  ];
  const head = makeHsem(first);
  const lodsAt = head.length + 20;
  const d = new Bin().bytes(lods.toU8()).u32(vb.length);
  const pad = (n: number) => { while ((lodsAt + d.length) % n) d.u8(0); };
  pad(16); d.bytes(vb.toU8());
  d.u32(6); pad(16);
  for (const i of [0, 2, 1, 0, 3, 2]) d.u16(i); // clockwise: (0,2,1) and (0,3,2)
  const pc = new Bin().f32(0).f32(1 / 1024), uc = new Bin().f32(0).f32(1 / 1024);
  return makeHsem([...first, { tag: 'LODS', data: d.toU8() }, { tag: 'PCMP', data: pc.toU8() }, { tag: 'UCMP', data: uc.toU8() }]);
}

/** .xbt: a TBX header + DDS. */
export function makeXbt(dds: ArrayBuffer): Uint8Array {
  return new Bin().ascii('TBX').u8(0).u32(0x0b).u32(0x20).u32(2).zeros(16).bytes(new Uint8Array(dds)).toU8();
}

const QK = 4.315969e-5, QH = 0.7071068;
/** Quaternion [w,x,y,z] -> 6 .mab bytes (the largest component is dropped). */
export function packQuat(q: number[]): [number, number, number] {
  let [w, x, y, z] = q as [number, number, number, number];
  const xyzw = [x, y, z, w], big = xyzw.reduce((bi, v, i) => (Math.abs(v) > Math.abs(xyzw[bi]!) ? i : bi), 0);
  if (xyzw[big]! < 0) { w = -w; x = -x; y = -y; z = -z; }
  const enc = (f: number) => Math.round((f + QH) / QK) & 0x7fff;
  // dropped: x = (0,0) y,z,w; y = (1,0) x,z,w; z = (0,1) x,y,w; w = (1,1) x,y,z
  const [f1, f2, f3, A, B] = big === 0 ? [y, z, w, 0, 0] : big === 1 ? [x, z, w, 1, 0] : big === 2 ? [x, y, w, 0, 1] : [x, y, z, 1, 1];
  return [enc(f1) | (A << 15), enc(f2) | (B << 15), enc(f3)];
}

export interface MabSpec {
  keys: number; duration: number;
  constRot?: Array<[number, number[]]>; rotKeys?: Array<[number, Array<number[] | null>]>;
  constPos?: Array<[number, number[]]>; posKeys?: Array<[number, number[][]]>;
  /** keyed root motion */
  rootPos?: number[][]; rootRot?: number[][];
}

/** Far Cry 2 .mab (version 2): masks, constant and keyed rotation/translation sections; null in keys = a missing key. */
export function makeMab(s: MabSpec): Uint8Array {
  const b = new Bin().u8(0x4c).u8(0).u8(2).u8(0).u32(0).zeros(8);
  const mask = (bones: number[]) => { const w = [0, 0, 0, 0, 0]; for (const x of bones) w[x >> 5] |= 1 << (x & 31); for (const v of w) b.u32(v >>> 0); };
  const cr = s.constRot ?? [], rk = s.rotKeys ?? [], cp = s.constPos ?? [], pk = s.posKeys ?? [];
  mask(cr.map((x) => x[0])); mask(rk.map((x) => x[0])); mask(cp.map((x) => x[0])); mask(pk.map((x) => x[0]));
  b.zeros(0x84 - b.length).f32(s.duration);
  const offAt = b.length; b.zeros(40); b.align(16);
  const offs: number[] = new Array(10).fill(0);
  const sec = (i: number, write: () => void) => { b.align(16); offs[i] = b.length - 0x10; write(); };
  const q6 = (q: number[]) => { for (const v of packQuat(q)) b.u16(v); };
  if (s.rootPos) sec(0, () => { b.u16(0).u16(s.rootPos!.length).u32(0); for (const v of s.rootPos!) b.f32s(...v); });
  if (s.rootRot) sec(1, () => { b.u16(0).u16(s.rootRot!.length).u32(0); for (const q of s.rootRot!) q6(q); });
  sec(2, () => { b.u32(cr.length).u32(0); for (const [, q] of cr) q6(q); });
  sec(3, () => {
    const start = b.length, nb = rk.length, nblk = nb ? Math.ceil(s.keys / 8) : 0;
    b.u16(nb).u16(s.keys).u32(0);
    const tbl = b.length; b.zeros((nblk + 1) * 4);
    for (let bi = 0; bi < nblk; bi++) {
      b.patchU32(tbl + bi * 4, b.length - start);
      for (const [, keys] of rk) q6(keys[bi * 8]!);
      const masks = rk.map(([, keys]) => { let m = 0; for (let k = 0; k < 7; k++) if (keys[bi * 8 + 1 + k]) m |= 1 << k; return m; });
      for (const m of masks) b.u8(m);
      b.align(2);
      rk.forEach(([, keys], t) => { for (let k = 0; k < 7; k++) if (masks[t]! & (1 << k)) q6(keys[bi * 8 + 1 + k]!); });
    }
    b.patchU32(tbl + nblk * 4, b.length - start);
  });
  sec(4, () => { b.u32(cp.length).u32(0); for (const [, v] of cp) b.f32s(...v); });
  sec(5, () => { b.u16(pk.length).u16(s.keys).u32(0); for (const [, list] of pk) for (const v of list) b.f32s(...v); });
  b.align(16);
  offs.forEach((o, i) => b.patchU32(offAt + i * 4, o));
  return b.toU8();
}

/** .skeleton: bones [name, parent, quaternion wxyz, position]; the root has a 0x01 flag after its name (as in the game). */
export function makeSkeleton(bones: Array<{ name: string; parent: number; rot: number[]; pos: number[] }>): Uint8Array {
  const H = 0x3ade68b1, b = new Bin().ascii('LKS').u8(0).u32(0x12).u32(H).u32(7).u16(bones.length).u16(0);
  bones.forEach((x, i) => {
    b.u32(H).u32(7).f32s(x.rot[1]!, x.rot[2]!, x.rot[3]!, x.rot[0]!, ...x.pos, 0).u16(i).u16(x.parent < 0 ? 0xffff : x.parent).u16(0xffff).u16(0xffff).u16(0);
    b.u32(i * 7919).u32(x.name.length).ascii(x.name).u8(x.parent < 0 ? 1 : 0).zeros(5);
  });
  return b.toU8();
}

/** .fcb object for makeFcb: type (class name or hash), values (name/hash -> bytes), children. */
export interface FcbSpec { type: string | number; values?: Array<[string | number, Uint8Array]>; kids?: FcbSpec[] }
const fcbH = (n: string | number) => (typeof n === 'number' ? n >>> 0 : crc32(new TextEncoder().encode(n)) >>> 0);
const cnt = (b: Bin, n: number) => (n < 0xfe ? b.u8(n) : b.u8(0xff).u32(n));
export const fv = {
  u32: (v: number) => new Bin().u32(v).toU8(),
  f32: (v: number) => new Bin().f32(v).toU8(),
  vec3: (x: number, y: number, z: number) => new Bin().f32s(x, y, z).toU8(),
  str: (s: string) => new Bin().cstr(s).toU8(),
};
/** .fcb ("nbCF", version 2) without references. */
export function makeFcb(root: FcbSpec): Uint8Array {
  const b = new Bin().ascii('nbCF').u16(2).u16(0).u32(0).u32(0);
  const obj = (o: FcbSpec) => {
    cnt(b, o.kids?.length ?? 0); b.u32(fcbH(o.type)); cnt(b, o.values?.length ?? 0);
    for (const [k, v] of o.values ?? []) { b.u32(fcbH(k)); cnt(b, v.length); b.bytes(v); }
    for (const k of o.kids ?? []) obj(k);
  };
  obj(root);
  return b.toU8();
}

export interface RmlSpec { name: string; attrs?: Record<string, string>; kids?: RmlSpec[] }
/** Dunia binary XML: the tree, then the string table. */
export function makeRml(root: RmlSpec): Uint8Array {
  const strs = new Map<string, number>(); let st = '';
  const sid = (s: string) => { let i = strs.get(s); if (i === undefined) { i = st.length; strs.set(s, i); st += s + '\0'; } return i; };
  const body = new Bin(); let nodes = 1, attrs = 0;
  const node = (n: RmlSpec) => {
    const a = Object.entries(n.attrs ?? {});
    cnt(body, sid(n.name)); cnt(body, sid('')); cnt(body, a.length); cnt(body, n.kids?.length ?? 0);
    attrs += a.length; nodes += n.kids?.length ?? 0;
    for (const [k, v] of a) { cnt(body, 0); cnt(body, sid(k)); cnt(body, sid(v)); }
    for (const k of n.kids ?? []) node(k);
  };
  node(root);
  const out = new Bin().u8(0).u8(0); cnt(out, st.length); cnt(out, nodes); cnt(out, attrs);
  return out.bytes(body.toU8()).ascii(st).toU8();
}

/** Sector terrain (23536 bytes): height h(x, y), 4 layer slots, vertex mask mask(x, y). */
export function makeTerrain(id: number, h: (x: number, y: number) => number, slots: number[], mask: (x: number, y: number) => number, water = 0): Uint8Array {
  const b = new Bin().u32(0xe9001052).u32(7).u32(23536 - 20).u32(23536 - 40).u32(0).u32(id).u32(0).f32(0).f32(100);
  for (const s of slots) b.u8(s);
  b.seek(0x3c).f32(water);
  b.seek(0x250);
  for (let y = 0; y < 65; y++) for (let x = 0; x < 65; x++) b.u16(Math.round(h(x, y) * 128)).u8(0x7f).u8(mask(x, y));
  b.seek(23536);
  return b.toU8();
}

/** RealTree (.rtr): a trunk of 3 nodes, a branch of 2 (scale 0.5), one foliage card; bark and foliage materials. */
export function makeRealTree(barkMlm: string, leafMlm: string): Uint8Array {
  const BASE = 0x0dad0000, DL = 0x900, b = new Bin();
  b.u32(0).u32(0).u32(136).u32(0).u32(0).u32(DL).ascii('graphics\\Vegetation\\Test\\Realtrees\\RT_Test.rta');
  b.seek(0x118).u32(1).u32(1).f32(0.9).u32(2).u32(5).u32(BASE + 0x400).u32(BASE + 0x360).u32(2).u32(BASE + 0x360).u32(BASE + 0x360).u32(1).u32(BASE + 0x800);
  const nodes: Array<[number, number, number, number, number]> = [[0, 0, 0, 2, 1], [0, 0, 1, 1, 1], [0, 0, 2, 0, 1], [0, 0, 1, 1, 0.5], [1, 0, 1.5, 0, 0.5]];
  nodes.forEach(([x, y, z, tip, sc], i) => { b.seek(0x400 + 0x88 + i * 76 + 52).f32s(x, y, z).u32(tip).f32(sc); });
  b.seek(0x800 + 0x88 + 20).f32s(0, 0, 1); b.seek(0x800 + 0x88 + 68).f32s(0.5, 0, 0);
  b.seek(136 + DL).u32(2).u32(barkMlm.length).cstr(barkMlm).u32(leafMlm.length).cstr(leafMlm);
  const u = b.toU8();
  new DataView(u.buffer).setUint32(0, u.length - 8, true);
  return u;
}
