// Синтетические файлы форматов для тестов. Раскладки — по описаниям форматов, проверено на парсерах gmv.
import { deflateSync } from 'node:zlib';
import { Bin } from './bin';

// ---------------- текстуры ----------------
export function makeDdsDxt1(w = 4, h = 4): ArrayBuffer {
  const b = new Bin().ascii('DDS ').u32(124).u32(0x1007).u32(h).u32(w).u32(0).u32(0).u32(1).zeros(44);
  b.u32(32).u32(4).ascii('DXT1').u32(0).u32(0).u32(0).u32(0).u32(0); // pixel format
  b.u32(0x1000).zeros(16); // caps
  const blocks = Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2);
  for (let i = 0; i < blocks; i++) b.u16(0xf800).u16(0x001f).u32(0); // все пиксели = c0 (красный)
  return b.toArrayBuffer();
}
export function makeDdsArgb(w: number, h: number, argb: number): ArrayBuffer {
  const b = new Bin().ascii('DDS ').u32(124).u32(0x100f).u32(h).u32(w).u32(w * 4).u32(0).u32(1).zeros(44);
  b.u32(32).u32(0x41).u32(0).u32(32).u32(0x00ff0000).u32(0x0000ff00).u32(0x000000ff).u32(0xff000000);
  b.u32(0x1000).zeros(16);
  for (let i = 0; i < w * h; i++) b.u32(argb);
  return b.toArrayBuffer();
}
/** TGA 24 бит, 2×2, снизу вверх: нижний ряд красный, верхний синий. RLE — тип 10. */
export function makeTga(rle: boolean): ArrayBuffer {
  const b = new Bin().u8(0).u8(0).u8(rle ? 10 : 2).u16(0).u16(0).u8(0).u16(0).u16(0).u16(2).u16(2).u8(24).u8(0);
  const red = [0, 0, 255], blue = [255, 0, 0]; // BGR
  if (!rle) b.bytes([...red, ...red, ...blue, ...blue]);
  else b.u8(0x81).bytes(red).u8(0x81).bytes(blue);
  return b.toArrayBuffer();
}
/** PCX 8 бит 2×1 с палитрой: индексы 1 и 2. */
export function makePcx(): ArrayBuffer {
  const b = new Bin().u8(10).u8(5).u8(1).u8(8).u16(0).u16(0).u16(1).u16(0).u16(72).u16(72).zeros(48).u8(0).u8(1).u16(2).u16(1).zeros(58);
  b.u8(1).u8(0xc1).u8(2); // 1 — литерал, 0xC1 2 — повтор 1 раз
  b.u8(12);
  const pal = new Uint8Array(768);
  pal.set([10, 20, 30], 3); pal.set([40, 50, 60], 6);
  b.bytes(pal);
  return b.toArrayBuffer();
}
/** VTF 7.2 RGBA8888 2×1. */
export function makeVtf(): ArrayBuffer {
  const b = new Bin().ascii('VTF\0').u32(7).u32(2).u32(80).u16(2).u16(1).u32(0).u16(1).u16(0).zeros(4).f32s(0, 0, 0).zeros(4).f32(1);
  b.i32(0).u8(1).i32(-1).u8(0).u8(0).u16(1);
  b.seek(80).bytes([255, 0, 0, 255, 0, 255, 0, 128]);
  return b.toArrayBuffer();
}

// ---------------- архивы ----------------
export function makePak(files: Record<string, Uint8Array>): ArrayBuffer {
  const b = new Bin().ascii('PACK').u32(0).u32(0), dir: Array<[string, number, number]> = [];
  for (const [n, d] of Object.entries(files)) { dir.push([n, b.pos, d.length]); b.bytes(d); }
  const dirOff = b.pos;
  for (const [n, off, size] of dir) b.fixed(n, 56).u32(off).u32(size);
  b.patchU32(4, dirOff).patchU32(8, dir.length * 64);
  return b.toArrayBuffer();
}
export function makeBigf(files: Record<string, Uint8Array>): ArrayBuffer {
  const names = Object.keys(files), dirLen = names.reduce((a, n) => a + 8 + n.length + 1, 0), pool = 16 + dirLen;
  const b = new Bin().ascii('BIGF').u32(0).u32be(names.length).u32be(pool);
  let off = pool;
  for (const n of names) { b.u32be(off).u32be(files[n]!.length).cstr(n); off += files[n]!.length; }
  for (const n of names) b.bytes(files[n]!);
  return b.toArrayBuffer();
}
export function makeVpk(files: Record<string, Uint8Array>): ArrayBuffer {
  const tree = new Bin(), data = new Bin(), byExt = new Map<string, Array<[string, string, Uint8Array]>>();
  for (const [p, d] of Object.entries(files)) {
    const slash = p.lastIndexOf('/'), dir = slash < 0 ? ' ' : p.slice(0, slash), file = p.slice(slash + 1), dot = file.lastIndexOf('.');
    const ext = file.slice(dot + 1), name = file.slice(0, dot);
    if (!byExt.has(ext)) byExt.set(ext, []);
    byExt.get(ext)!.push([dir, name, d]);
  }
  for (const [ext, list] of byExt) {
    tree.cstr(ext);
    for (const [dir, name, d] of list) {
      tree.cstr(dir).cstr(name).u32(0).u16(0).u16(0x7fff).u32(data.pos).u32(d.length).u16(0xffff);
      data.bytes(d);
      tree.u8(0); // конец файлов в папке
    }
    tree.u8(0); // конец папок
  }
  tree.u8(0);
  return new Bin().u32(0x55aa1234).u32(1).u32(tree.length).bytes(tree.toU8()).bytes(data.toU8()).toArrayBuffer();
}

/** BSA v104 (zlib) или v105 (LZ4 frame, хранится «сырыми» блоками). Все файлы — в одной папке. */
export function makeBsa(version: 104 | 105, folder: string, files: Record<string, Uint8Array>, compress: boolean): ArrayBuffer {
  const names = Object.keys(files), rec = version === 105 ? 24 : 16;
  const totalFolder = folder.length + 1, totalFile = names.reduce((a, n) => a + n.length + 1, 0);
  const b = new Bin().ascii('BSA\0').u32(version).u32(36).u32(1 | 2 | (compress ? 4 : 0)).u32(1).u32(names.length).u32(totalFolder).u32(totalFile).u32(0);
  b.u64(0n).u32(names.length);
  if (version === 105) b.u32(0).u64(0n); else b.u32(0);
  b.u8(folder.length + 1).cstr(folder);
  const recPos: number[] = [];
  for (let i = 0; i < names.length; i++) { recPos.push(b.pos); b.u64(0n).u32(0).u32(0); }
  for (const n of names) b.cstr(n);
  names.forEach((n, i) => {
    const raw = files[n]!;
    let body: Uint8Array;
    if (!compress) body = raw;
    else if (version === 104) body = new Bin().u32(raw.length).bytes(deflateSync(raw)).toU8();
    else body = new Bin().u32(raw.length).bytes(lz4RawFrame(raw)).toU8();
    const off = b.pos;
    b.bytes(body);
    b.patchU32(recPos[i]! + 8, body.length).patchU32(recPos[i]! + 12, off);
  });
  void rec;
  return b.toArrayBuffer();
}
/** LZ4 frame из одного несжатого блока. */
export function lz4RawFrame(raw: Uint8Array): Uint8Array {
  return new Bin().u32(0x184d2204).u8(0x40).u8(0x40).u8(0).u32(0x80000000 | raw.length).bytes(raw).u32(0).toU8();
}
/** LZ4 frame со сжатым блоком: «abcd» + совпадение (смещение 4, длина 8) + «x» = «abcdabcdabcdx». */
export function lz4MatchFrame(): Uint8Array {
  const block = new Bin().u8(0x44).ascii('abcd').u16(4).u8(0x10).ascii('x').toU8();
  return new Bin().u32(0x184d2204).u8(0x40).u8(0x40).u8(0).u32(block.length).bytes(block).u32(0).toU8();
}
export function makeImgV2(files: Record<string, Uint8Array>): ArrayBuffer {
  const names = Object.keys(files), b = new Bin().ascii('VER2').u32(names.length);
  let sector = Math.ceil((8 + names.length * 32) / 2048);
  const at: number[] = [];
  for (const n of names) { const secs = Math.ceil(files[n]!.length / 2048) || 1; at.push(sector); b.u32(sector).u16(secs).u16(0).fixed(n, 24); sector += secs; }
  names.forEach((n, i) => { b.seek(at[i]! * 2048).bytes(files[n]!); });
  b.seek(sector * 2048);
  return b.toArrayBuffer();
}

// ---------------- id Tech ----------------
/** MD2: один треугольник, 2 кадра «stand01/stand02» (во втором кадре вершины сдвинуты по X). */
export function makeMd2(): ArrayBuffer {
  const nXyz = 3, frameSize = 40 + nXyz * 4, oSkins = 68, oSt = oSkins + 64, oTris = oSt + 3 * 4, oFrames = oTris + 12, oEnd = oFrames + 2 * frameSize;
  const b = new Bin().ascii('IDP2').i32(8).i32(64).i32(64).i32(frameSize).i32(1).i32(nXyz).i32(3).i32(1).i32(0).i32(2).i32(oSkins).i32(oSt).i32(oTris).i32(oFrames).i32(oEnd).i32(oEnd);
  b.fixed('models/test/skin.pcx', 64);
  b.i16(0).i16(0).i16(64).i16(0).i16(0).i16(64);
  b.u16(0).u16(1).u16(2).u16(0).u16(1).u16(2);
  for (const [name, dx] of [['stand01', 0], ['stand02', 10]] as const) {
    b.f32s(1, 1, 1).f32s(dx, 0, 0).fixed(name, 16);
    b.bytes([0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0]);
  }
  return b.toArrayBuffer();
}
/** MD3: одна поверхность, треугольник, 2 кадра. */
export function makeMd3(): ArrayBuffer {
  const nV = 3, nF = 2, oSurf = 108, sHead = 108, oT = sHead, oSh = oT + 12, oSt = oSh + 68, oX = oSt + nV * 8, end = oX + nF * nV * 8;
  const b = new Bin().ascii('IDP3').i32(15).fixed('test', 64).i32(0).i32(nF).i32(0).i32(1).i32(0).i32(0).i32(0).i32(oSurf).i32(oSurf + end);
  b.ascii('IDP3').fixed('body', 64).i32(0).i32(nF).i32(1).i32(nV).i32(1).i32(oT).i32(oSh).i32(oSt).i32(oX).i32(end);
  b.i32(0).i32(1).i32(2);
  b.fixed('models/test/body', 64).i32(0);
  b.f32s(0, 0, 1, 0, 0, 1);
  for (let f = 0; f < nF; f++) for (const [x, y, z] of [[0, 0, 0], [64, 0, 0], [0, 64 * (f + 1), 0]]) b.i16(x!).i16(y!).i16(z!).i16(0);
  return b.toArrayBuffer();
}
/** Quake MDL: скин 2×2 (индексы 1), один треугольник, один кадр. */
export function makeQuakeMdl(): ArrayBuffer {
  const b = new Bin().ascii('IDPO').i32(6).f32s(1, 1, 1).f32s(0, 0, 0).f32(1).f32s(0, 0, 0).i32(1).i32(2).i32(2).i32(3).i32(1).i32(1).i32(0).i32(0).f32(1);
  b.i32(0).bytes([1, 1, 1, 1]);
  b.i32(0).i32(0).i32(0).i32(0).i32(1).i32(0).i32(0).i32(0).i32(1);
  b.i32(1).i32(0).i32(1).i32(2);
  b.i32(0).bytes([0, 0, 0, 0, 10, 10, 10, 0]).fixed('frame1', 16).bytes([0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0]);
  return b.toArrayBuffer();
}
export const MD5MESH = `MD5Version 10
commandline ""
numJoints 2
numMeshes 1
joints {
  "root" -1 ( 0 0 0 ) ( 0 0 0 )   // корень
  "b1" 0 ( 0 0 1 ) ( 0 0 0 )
}
mesh {
  shader "models/test/skin"
  numverts 3
  vert 0 ( 0 0 ) 0 1
  vert 1 ( 1 0 ) 1 1
  vert 2 ( 0 1 ) 2 1
  numtris 1
  tri 0 0 1 2
  numweights 3
  weight 0 0 1 ( 0 0 0 )
  weight 1 0 1 ( 1 0 0 )
  weight 2 1 1 ( 0 1 0 )
}
`;
export const MD5ANIM = `MD5Version 10
numFrames 2
numJoints 2
frameRate 24
numAnimatedComponents 1
hierarchy {
  "root" -1 0 0
  "b1" 0 1 0
}
bounds {
  ( 0 0 0 ) ( 1 1 1 )
  ( 0 0 0 ) ( 1 1 1 )
}
baseframe {
  ( 0 0 0 ) ( 0 0 0 )
  ( 0 0 1 ) ( 0 0 0 )
}
frame 0 {
  0
}
frame 1 {
  2
}
`;

// ---------------- X-Ray ----------------
const ogfChunk = (b: Bin, id: number, body: Uint8Array) => b.u32(id).u32(body.length).bytes(body);
/** OGF v4: статичный меш (stride 32) или скелетный (stride 64, 1 кость, анимация с константной позой). */
export function makeOgf(skinned: boolean): ArrayBuffer {
  const b = new Bin();
  ogfChunk(b, 1, new Bin().u8(4).u8(skinned ? 3 : 0).u16(0).f32s(0, 0, 0, 1, 1, 0).f32s(0, 0, 0, 1).toU8());
  ogfChunk(b, 2, new Bin().cstr('act\\act_stalker').cstr('models\\model').toU8());
  const v = new Bin().u32(skinned ? 0x12071980 : 0x112).u32(3);
  for (const [x, y, z, u, w] of [[0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [0, 1, 0, 0, 1]]) {
    if (!skinned) v.f32s(x!, y!, z!).f32s(0, 0, 1).f32s(u!, w!);
    else v.u16(0).u16(0).f32s(x!, y!, z!).f32s(0, 0, 1).f32s(1, 0, 0).f32s(0, 1, 0).f32(0).f32s(u!, w!);
  }
  ogfChunk(b, 3, v.toU8());
  ogfChunk(b, 4, new Bin().u32(3).u16(0).u16(1).u16(2).toU8());
  if (skinned) {
    ogfChunk(b, 13, new Bin().u32(1).cstr('root').cstr('').zeros(60).toU8());
    const sub0 = new Bin().u32(1).toU8();
    const sub1 = new Bin().cstr('idle').u32(2).u8(2).i16(0).i16(0).i16(0).i16(32767).f32s(0, 0.5, 0).toU8();
    const motions = new Bin();
    ogfChunk(motions, 0, sub0);
    ogfChunk(motions, 1, sub1);
    ogfChunk(b, 14, motions.toU8());
  }
  return b.toArrayBuffer();
}

// ---------------- Unreal ActorX ----------------
const pskChunk = (b: Bin, id: string, size: number, count: number) => b.fixed(id, 20).i32(0x1e83b9).i32(size).i32(count);
/** PSK: 2 кости, 3 точки/вершины, 1 треугольник, материал «M_Test». */
export function makePsk(): ArrayBuffer {
  const b = new Bin();
  pskChunk(b, 'ACTRHEAD', 0, 0);
  pskChunk(b, 'PNTS0000', 12, 3); b.f32s(0, 0, 0, 1, 0, 0, 0, 0, 1);
  pskChunk(b, 'VTXW0000', 16, 3); for (let i = 0; i < 3; i++) b.u16(i).u16(0).f32s(i === 1 ? 1 : 0, i === 2 ? 1 : 0).u8(0).u8(0).u16(0);
  pskChunk(b, 'FACE0000', 12, 1); b.u16(0).u16(1).u16(2).u8(0).u8(0).u32(1);
  pskChunk(b, 'MATT0000', 88, 1); b.fixed('M_Test', 64).zeros(24);
  pskChunk(b, 'REFSKELT', 120, 2);
  for (const [name, parent, z] of [['root', 0, 0], ['b1', 0, 1]] as const) b.fixed(name, 64).u32(0).i32(name === 'root' ? 1 : 0).i32(parent).f32s(0, 0, 0, 1).f32s(0, 0, z).f32(0).f32s(1, 1, 1);
  pskChunk(b, 'RAWWEIGHTS', 12, 3); b.f32(1).i32(0).i32(0).f32(1).i32(1).i32(0).f32(1).i32(2).i32(1);
  return b.toArrayBuffer();
}
/** PSA: анимация «walk» 2 кадра, кость b1 сдвигается по X. */
export function makePsa(): ArrayBuffer {
  const b = new Bin();
  pskChunk(b, 'ANIMHEAD', 0, 0);
  pskChunk(b, 'BONENAMES', 120, 2);
  for (const n of ['root', 'b1']) b.fixed(n, 64).zeros(56);
  pskChunk(b, 'ANIMINFO', 168, 1); b.fixed('walk', 64).fixed('none', 64).i32(2).i32(0).i32(0).i32(0).f32(1).f32(1).f32(10).i32(0).i32(0).i32(2);
  pskChunk(b, 'ANIMKEYS', 32, 4);
  for (const x of [0, 2]) { b.f32s(0, 0, 0).f32s(0, 0, 0, 1).f32(0.1); b.f32s(x, 0, 1).f32s(0, 0, 0, 1).f32(0.1); }
  return b.toArrayBuffer();
}

// ---------------- Cast ----------------
const fcc = (s: string) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
type Prop = [name: string, type: number, write: (b: Bin) => number];
const str = (n: string, v: string): Prop => [n, 0x73, (b) => { b.cstr(v); return 1; }];
const f32p = (n: string, type: number, comps: number, v: number[]): Prop => [n, type, (b) => { b.f32s(...v); return v.length / comps; }];
const u8p = (n: string, v: number[]): Prop => [n, 0x62, (b) => { b.bytes(v); return v.length; }];
const u16p = (n: string, v: number[]): Prop => [n, 0x68, (b) => { for (const x of v) b.u16(x); return v.length; }];
const i32p = (n: string, v: number[]): Prop => [n, 0x69, (b) => { for (const x of v) b.i32(x); return v.length; }];
const u64p = (n: string, v: bigint[]): Prop => [n, 0x6c, (b) => { for (const x of v) b.u64(x); return v.length; }];
interface CNode { id: string; hash?: bigint; props?: Prop[]; kids?: CNode[] }
function castNode(b: Bin, n: CNode): void {
  b.u32(fcc(n.id)).u32(0).u64(n.hash ?? 0n).u32(n.props?.length ?? 0).u32(n.kids?.length ?? 0);
  for (const [name, type, write] of n.props ?? []) {
    const head = b.pos;
    b.u16(type).u16(name.length).u32(0).ascii(name);
    const count = write(b);
    b.patchU32(head + 4, count);
  }
  for (const k of n.kids ?? []) castNode(b, k);
}
function castFile(roots: CNode[]): ArrayBuffer {
  const b = new Bin().u32(0x74736163).u32(1).u32(roots.length).u32(0);
  for (const r of roots) castNode(b, r);
  return b.toArrayBuffer();
}
export function makeCastModel(): ArrayBuffer {
  return castFile([{ id: 'root', kids: [{ id: 'modl', props: [str('n', 'gun')], kids: [
    { id: 'skel', kids: [
      { id: 'bone', props: [str('n', 'tag_origin'), i32p('p', [-1]), f32p('lp', 0x3376, 3, [0, 0, 0]), f32p('lr', 0x3476, 4, [0, 0, 0, 1])] },
      { id: 'bone', props: [str('n', 'j_bolt'), i32p('p', [0]), f32p('lp', 0x3376, 3, [0, 0, 1]), f32p('lr', 0x3476, 4, [0, 0, 0, 1])] },
    ] },
    { id: 'matl', hash: 77n, props: [str('n', 'gun_mtl')], kids: [{ id: 'file', props: [str('n', 'albedo'), str('p', 'images/gun_col.png')] }] },
    { id: 'mesh', props: [str('n', 'body'), f32p('vp', 0x3376, 3, [0, 0, 0, 1, 0, 0, 0, 1, 0]), u16p('f', [0, 1, 2]), f32p('u0', 0x3276, 2, [0, 0, 1, 0, 0, 1]),
      u8p('mi', [1]), u8p('wb', [0, 0, 1]), f32p('wv', 0x66, 1, [1, 1, 1]), u64p('m', [77n])] },
  ] }] }]);
}
export function makeCastAnim(): ArrayBuffer {
  return castFile([{ id: 'root', kids: [{ id: 'anim', props: [str('n', 'fire'), f32p('fr', 0x66, 1, [30])], kids: [
    { id: 'curv', props: [str('nn', 'j_bolt'), str('kp', 'tx'), u8p('kb', [0, 9]), f32p('kv', 0x66, 1, [0, 3])] },
  ] }] }]);
}

// ---------------- RenderWare ----------------
const RW_SA = 0x1803ffff;
const rw = (type: number, body: Uint8Array) => new Bin().u32(type).u32(body.length).u32(RW_SA).bytes(body).toU8();
const rwCat = (...parts: Uint8Array[]) => { const b = new Bin(); for (const p of parts) b.bytes(p); return b.toU8(); };
/** DFF: один кадр «chassis», геометрия-треугольник с текстурой «body». */
export function makeDff(): ArrayBuffer {
  const frame = new Bin().u32(1).f32s(1, 0, 0, 0, 1, 0, 0, 0, 1).f32s(0, 0, 0).i32(-1).u32(0).toU8();
  const frameList = rw(0x0e, rwCat(rw(1, frame), rw(3, rw(0x253f2fe, new TextEncoder().encode('chassis')))));
  const g = new Bin().u32(0x4 | 0x2).u32(1).u32(3).u32(1);
  g.f32s(0, 0, 1, 0, 0, 1); // uv
  g.u16(1).u16(0).u16(0).u16(2); // треугольник: b, a, mat, c
  g.f32s(0, 0, 0, 1).u32(1).u32(0); // сфера, hasV, hasN
  g.f32s(0, 0, 0, 1, 0, 0, 0, 1, 0);
  const tex = rw(6, rwCat(rw(1, new Bin().u16(0x1102).u16(0).toU8()), rw(2, new Bin().cstr('body').align(4).toU8()), rw(2, new Bin().u32(0).toU8())));
  const mat = rw(7, rwCat(rw(1, new Bin().u32(0).bytes([255, 128, 0, 255]).u32(0).u32(1).f32s(1, 1, 1).toU8()), tex));
  const matList = rw(8, rwCat(rw(1, new Bin().u32(1).i32(-1).toU8()), mat));
  const geom = rw(0x0f, rwCat(rw(1, g.toU8()), matList, rw(3, new Uint8Array(0))));
  const geoList = rw(0x1a, rwCat(rw(1, new Bin().u32(1).toU8()), geom));
  const atomic = rw(0x14, rw(1, new Bin().u32(0).u32(0).u32(5).u32(0).toU8()));
  return rw(0x10, rwCat(rw(1, new Bin().u32(1).u32(0).u32(0).toU8()), frameList, geoList, atomic)).slice().buffer;
}
/** TXD: одна текстура «body» 1×1 в формате 8888 (BGRA). */
export function makeTxd(): ArrayBuffer {
  const st = new Bin().u32(9).u32(0x1102).fixed('body', 32).fixed('', 32).u32(0x500).u32(0x15).u16(1).u16(1).u8(32).u8(1).u8(4).u8(0).u32(4).bytes([0, 0, 255, 255]);
  return rw(0x16, rwCat(rw(1, new Bin().u16(1).u16(0).toU8()), rw(0x15, rwCat(rw(1, st.toU8()), rw(3, new Uint8Array(0)))))).slice().buffer;
}

// ---------------- CryEngine ----------------
/** CGF CrCh 0x746: потоки позиций/UV/индексов, подмеш с MatID 2, имя материала. */
export function makeCgf(): ArrayBuffer {
  const pos = new Bin().u32(0).u32(0).u32(3).u32(12).zeros(8).f32s(0, 0, 0, 1, 0, 0, 0, 1, 0).toU8();
  const uv = new Bin().u32(0).u32(2).u32(3).u32(8).zeros(8).f32s(0, 0, 1, 0, 0, 1).toU8();
  const idx = new Bin().u32(0).u32(5).u32(3).u32(4).zeros(8).u32(0).u32(1).u32(2).toU8();
  const sub = new Bin().u32(0).u32(1).zeros(8).u32(0).u32(3).u32(0).u32(3).u32(2).zeros(16).toU8();
  const mtl = new Bin().fixed('objects/props/box', 128).toU8();
  const chunks: Array<[number, Uint8Array]> = [[0xcccc0014, mtl], [0xcccc0016, pos], [0xcccc0016, uv], [0xcccc0016, idx], [0xcccc0017, sub]];
  const b = new Bin().ascii('CrCh').u32(0x746).u32(chunks.length).u32(0);
  const at: number[] = [];
  for (const [, body] of chunks) { at.push(b.pos); b.bytes(body).align(4); }
  b.patchU32(12, b.pos);
  chunks.forEach(([type, body], i) => b.u32(type).u32(0x900).u32(i).u32(body.length).u32(at[i]!));
  return b.toArrayBuffer();
}
export const CRY_MTL = `<Material MtlFlags="524544">
 <SubMaterials>
  <Material Name="a" Shader="Illum"><Textures><Texture Map="Bumpmap" File="textures/a_ddn.dds"/></Textures></Material>
  <Material Name="b" Shader="Illum"/>
  <Material Name="c" Shader="Illum"><Textures><Texture Map="Diffuse" File="textures/box_diff.dds"/></Textures></Material>
 </SubMaterials>
</Material>`;

// ---------------- EA FCE ----------------
/** FCE3: одна часть «:HB» (кузов), треугольник со страницей текстуры 0. */
export function makeFce(): ArrayBuffer {
  const hs = 0x1f04, nV = 3, nT = 1, vOff = 0, nOff = nV * 12, tOff = nOff + nV * 12;
  const b = new Bin().u32(0x00101014).u32(0).u32(nT).u32(nV).u32(0).u32(vOff).u32(nOff).u32(tOff);
  b.seek(0x104).f32s(0, 0, 0); // позиция части
  const o = 0x404;
  b.seek(o).u32(0); b.seek(o + 256).u32(nV); b.seek(o + 512).u32(0); b.seek(o + 768).u32(nT);
  b.seek(0xe04).fixed(':HB', 64);
  b.seek(hs + vOff).f32s(0, 0, 0, 4, 0, 0, 0, 0, 2); // длина 4 (x), ширина 2 (z), высота 0
  b.seek(hs + nOff).f32s(0, 1, 0, 0, 1, 0, 0, 1, 0);
  b.seek(hs + tOff).u32(0).u32(0).u32(1).u32(2).zeros(16).f32s(0, 1, 0).f32s(0, 0, 1);
  return b.toArrayBuffer();
}
