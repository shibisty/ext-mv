// Synthetic LithTech Jupiter EX files (F.E.A.R. Online): LTAR, TEXR, LTMI, GADB, MODL, MESH.
import { Bin } from './bin';

const pad4 = (b: Bin) => { while (b.length % 4) b.u8(0); };

/** LTAR v3 archive: files by folder (the folder record order = the file order). */
export function makeLtar(files: Record<string, Uint8Array>): Uint8Array {
  const byDir = new Map<string, Array<[string, Uint8Array]>>();
  for (const [p, d] of Object.entries(files)) {
    const i = p.lastIndexOf('\\'), dir = i < 0 ? '' : p.slice(0, i);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push([p.slice(i + 1), d]);
  }
  const names = new Bin(), off = new Map<string, number>();
  const name = (s: string) => { if (!off.has(s)) { off.set(s, names.length); names.cstr(s); pad4(names); } return off.get(s)!; };
  name('');
  const dirs = [...byDir.keys()], flat = dirs.flatMap((d) => byDir.get(d)!);
  for (const d of dirs) name(d);
  for (const [n] of flat) name(n);
  const nb = names.toU8(), head = 48 + nb.length + flat.length * 32 + dirs.length * 16;
  const b = new Bin().ascii('LTAR').u32(3).u32(nb.length).u32(dirs.length).u32(flat.length).u32(0).u32(0).u32(0).zeros(16).bytes(nb);
  let at = head;
  for (const [n, d] of flat) { b.u32(off.get(n)!).u64(BigInt(at)).u64(BigInt(d.length)).u64(BigInt(d.length)).u32(0); at += d.length; }
  for (const d of dirs) b.u32(off.get(d)!).u32(0xffffffff).u32(0xffffffff).u32(byDir.get(d)!.length);
  for (const [, d] of flat) b.bytes(d);
  return b.toU8();
}

export function makeTex(dds: ArrayBuffer): Uint8Array {
  return new Bin().ascii('TEXR').u32(1).u32(0x20100).bytes(new Uint8Array(dds)).toU8();
}

/** LTMI material: textures by parameter (tDiffuseMap…) and one number. */
export function makeMat(shader: string, textures: Record<string, string>): Uint8Array {
  const data = new Bin().f32(64);
  const offs: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(textures)) { offs.push([k, data.length]); data.cstr(v); pad4(data); }
  const db = data.toU8(), b = new Bin().ascii('LTMI').u32(4).u32(db.length).u16(offs.length).u16(1).u32(4).u32(0).u16(shader.length).ascii(shader).bytes(db).u32(5);
  b.u16('k_fMaxSpecularPower'.length).ascii('k_fMaxSpecularPower').u32(0).u16(1).u16(1);
  offs.forEach(([k, o], i) => b.u16(k.length).ascii(k).u32(o).u16(1).u16(i));
  return b.toU8();
}

/** GADB database: a Weapons category with a record (.mdl path + materials) and a Character/Models category with a reference to _Structures/MaterialSets. */
export function makeGameDb(weapon: { mdl: string; mats: string[] }, character: { mdl: string; mats: string[] }): Uint8Array {
  const blob = new Bin(), off = new Map<string, number>();
  const s = (x: string) => { if (!off.has(x)) { off.set(x, blob.length); blob.cstr(x); pad4(blob); } return off.get(x)!; };
  for (const x of ['', 'Weapons', 'G36', 'Character/Models', 'Guy', '_Structures', 'MaterialSets', weapon.mdl, character.mdl, ...weapon.mats, ...character.mats]) s(x);
  // attributes: 0..1 = weapon record, 2..3 = character, 4 = structure
  const attrs: Array<[number, number, number, number]> = [
    [0x00154655, 0x44, 1, 0], [0xe9db0857, 0x44, weapon.mats.length, 1],
    [0x00154655, 0x44, 1, 0], [0x168eed30, 0x09, 1, 1],
    [0x610e3b97, 0x44, character.mats.length, 0],
  ];
  const cats = new Bin();
  cats.u32(3);
  cats.u32(s('Weapons')).u32(1).u32(0);
  cats.u32(s('G36')).u32(1 + weapon.mats.length).u32(2).u32(0).u32(0x1234);
  cats.u32(s(weapon.mdl)); for (const m of weapon.mats) cats.u32(s(m));
  cats.u32(s('Character/Models')).u32(1).u32(0);
  cats.u32(s('Guy')).u32(2).u32(2).u32(2).u32(0x5678).u32(s(character.mdl)).u32((2 << 16) | 0);
  cats.u32(s('_Structures')).u32(1).u32(0);
  cats.u32(s('MaterialSets')).u32(character.mats.length).u32(1).u32(4).u32(0x9abc);
  for (const m of character.mats) cats.u32(s(m));
  const bb = blob.toU8(), b = new Bin().ascii('GADB').u32(6).u32(bb.length).u32(3).u32(3).u32(0).u32(attrs.length).bytes(bb);
  for (const [h, t, c, i] of attrs) b.u32(h).u8(t).u8(c).u16(i);
  return b.bytes(cats.toU8()).toU8();
}

export interface TestSection { pos: number[][]; uv: number[][]; tris: number[][]; material: number; floatUv?: boolean }

/** MESH: sections with their own declarations (64 bytes with s16 UVs or 68 with float2 UVs), plus a shadow section without UVs. */
export function makeMesh(sections: TestSection[]): Uint8Array {
  const vb = new Bin(), ib = new Bin(), recs: number[][] = [];
  let vstart = 0, istart = 0;
  const all = [...sections, { pos: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], uv: [], tris: [[0, 1, 2]], material: 3, shadow: true } as TestSection & { shadow?: boolean }];
  for (const s of all) {
    const shadow = 'shadow' in s, stride = shadow ? 28 : s.floatUv ? 68 : 64;
    while (vb.length % stride) vb.u8(0);
    vstart = vb.length / stride;
    for (let v = 0; v < s.pos.length; v++) {
      vb.f32s(...s.pos[v]!);
      if (shadow) { vb.f32s(0, 1, 0).u32(0); continue; }
      if (s.floatUv) vb.f32s(...s.uv[v]!); else vb.i16(Math.round(s.uv[v]![0]! * 32767)).i16(Math.round(s.uv[v]![1]! * 32767));
      vb.f32s(0, 1, 0, 1, 0, 0, 0, 0, 1).u32(0xffffffff).u8(0).u8(0).u8(255).u8(0).u32(0);
    }
    recs.push([0, s.pos.length, istart, vstart, s.tris.length, s.material, 1, recs.length * 4, shadow ? 2 : s.floatUv ? 1 : 0]);
    for (const t of s.tris) for (const i of t) ib.u16(i);
    istart += s.tris.length * 3;
  }
  const vbb = vb.toU8(), ibb = ib.toU8(), b = new Bin().ascii('MESH').u32(1).u32(1).u32(recs.length).u32(3).u32(0).u32(0).u32(recs.length * 4);
  for (let k = 0; k < recs.length; k++) b.u32(1);
  b.u32(recs.length).u32(vbb.length).u32(ibb.length).bytes(vbb).bytes(ibb).u32(3);
  const full = (uvType: number) => { b.u32(8); for (const [t, u] of [[2, 0], [uvType, 4], [2, 1], [2, 2], [2, 3], [4, 5], [4, 6], [4, 7]]) b.u8(0).u8(t!).u8(u!).u8(0); };
  full(8); full(1);
  b.u32(3); for (const [t, u] of [[2, 0], [2, 1], [4, 7]]) b.u8(0).u8(t!).u8(u!).u8(0);
  b.u32(recs.length);
  for (const r of recs) for (const x of r) b.u32(x);
  return b.toU8();
}

/**
 * MODL v42: two nodes, body/shadow pieces; LODs: the "body" group has levels (100: section lodFar) and (0: sections 0…n-1), a shadow group.
 */
export function makeMdl(meshPath: string, nearSections: number, farSection: number, shadowSection: number): Uint8Array {
  const strs = new Bin(), off = new Map<string, number>();
  const s = (x: string) => { if (!off.has(x)) { off.set(x, strs.length); strs.cstr(x); pad4(strs); } return off.get(x)!; };
  for (const x of ['', 'Root', 'Gun', 'body', 'shadow']) s(x);
  const sb = strs.toU8(), b = new Bin().ascii('MODL').u32(42).u32(1).u32(1).u32(2).u32(2).u32(1).u32(0).u32(2).u32(sb.length).zeros(40).bytes(sb);
  b.u32(s('Root')).u8(0).f32s(0, 0, 0, 0, 0, 0, 1).u32(1);
  b.u32(s('Gun')).u8(0).f32s(0, 10, 0, 0, 0, 0, 1).u32(0);
  b.zeros(7); // "animations and sockets" are skipped by searching for the .mesh path
  const recs: number[][] = [];
  for (let k = 0; k < nearSections; k++) recs.push([0, k, 1, k, 1]);
  recs.push([0, nearSections, 1, farSection, 1], [1, nearSections + 1, 1, shadowSection, 1]);
  const list = recs.map((_, i) => i);
  b.u32(s('body')).u32(s('shadow'));
  b.u32(recs.length).u32(list.length).u32(recs.length).u32(3).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0);
  b.u16(meshPath.length).ascii(meshPath).u8(0).zeros(3);
  for (let k = 0; k < recs.length; k++) b.u8(1);
  for (const i of list) b.u16(i);
  for (const r of recs) for (const x of r) b.u32(x);
  // body group: 100 -> the far section, 0 -> the near ones; shadow group: 0
  b.f32(100).u32(nearSections).u32(1).f32(0).u32(0).u32(nearSections).f32(0).u32(nearSections + 1).u32(1);
  return b.toU8();
}

/**
 * MODL v42 with a skeleton: nodes Root (0, 0, 0) -> Arm (0, 10, 0); in the string table Arm comes before Root, so the track rows
 * and the bone numbers in palettes are in the order [Arm, Root]. Before the nodes, 2 u32 commands ([0x4c] = 2).
 * With meshPath: one section 0 (the body piece, LOD level 0); with anim: a "walk" animation (2 keys, 0 and 1000 ms).
 */
export function makeSkelMdl(meshPath: string | null, anim: boolean): Uint8Array {
  const strs = new Bin(), off = new Map<string, number>();
  const s = (x: string) => { if (!off.has(x)) { off.set(x, strs.length); strs.cstr(x); pad4(strs); } return off.get(x)!; };
  for (const x of ['', 'Arm', 'Root', 'walk', 'body']) s(x);
  const sb = strs.toU8(), h = new Array(18).fill(0);
  h[1] = anim ? 1 : 0; h[2] = 2; h[3] = meshPath ? 1 : 0; h[7] = sb.length; h[17] = 2;
  const b = new Bin().ascii('MODL').u32(42);
  for (const x of h) b.u32(x);
  b.bytes(sb).u32(0xdead).u32(0xbeef);
  b.u32(s('Root')).u8(0).f32s(0, 0, 0, 0, 0, 0, 1).u32(1);
  b.u32(s('Arm')).u8(0).f32s(0, 10, 0, 0, 0, 0, 1).u32(0);
  b.f32(0);
  if (anim) b.u32(0).u32(0).u32(0).u32(s('walk')).u32(0).u32(0).u32(0).u32(0).u32(2).u32(0xff000000).u32(0xff000000 | 1000);
  if (!meshPath) return b.toU8();
  b.u32(s('body'));
  b.u32(1).u32(1).u32(1).u32(1).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0);
  b.u16(meshPath.length).ascii(meshPath).u8(0).zeros(3);
  b.u8(1); // record palette: Root (the second row)
  b.u16(0);
  b.u32(0).u32(0).u32(1).u32(0).u32(1);
  b.f32(0).u32(0).u32(1);
  return b.toU8();
}

/**
 * .anim for makeSkelMdl: Arm has an animated rotation (0° -> 90° about Z), Root a constant position (0, 0, 10).
 */
export function makeAnim(): Uint8Array {
  const blk = new Bin();
  blk.u8(1).u8(0x80).u8(0x80).u8(0).u16(1).u16(1); // 2 keys, 1 constant, 1 animated
  blk.u8(255).u8(0).u8(1).u8(255); // Arm: rotation = track 0; Root: position = track 1 (the first constant one)
  blk.u16(24); // track 0 data
  blk.u8(0).u8(0).u8(1).u8(0); // animation keys -> (track key, fraction)
  blk.i16(0).i16(0).i16(200); // constant: position ×20
  blk.i16(0).i16(0).i16(0).i16(0).i16(0).i16(23170); // rotation: 0°, 90° about Z
  const d = blk.toU8();
  return new Bin().ascii('ANIM').u32(1).u32(d.length).bytes(d).toU8();
}

/** .wldclnt: one region (.wldmsh path and materials), prefab instances [path, position, quaternion x,y,z,w]. */
export function makeWldClnt(meshPath: string, mats: string[], insts: Array<[string, number[], number[]]>, statics: Array<[number[], number]> = []): Uint8Array {
  const b = new Bin().ascii('WLDC').u32(126);
  const h = new Array(10).fill(0);
  h[3] = insts.length; // [0x14] = prefab instance count
  h[6] = 1; // [0x20] = region count
  for (const x of h) b.u32(x);
  const str = (s: string) => b.u16(s.length).ascii(s);
  b.u32(1).u32(mats.length); str(meshPath); b.u32(0);
  for (const m of mats) str(m);
  for (const [path, pos, q] of insts) {
    b.f32s(pos[0]! - 1, pos[1]! - 1, pos[2]! - 1, pos[0]! + 1, pos[1]! + 1, pos[2]! + 1, ...pos, ...q).u32(1).u32(0).u32(0);
    str(path);
  }
  // static geometry group: [n, 0, 0, 0] + n × [box, u32, section number]
  b.u32(statics.length).zeros(12);
  for (const [box, k] of statics) b.f32s(...box).u32(0).u32(k);
  b.u32(5).zeros(12); // other tables follow
  return b.toU8();
}

/**
 * .inst "PRFB": one triangle (0,0,0) (10,0,0) (0,10,0) with UVs, material mat; 6 bytes of indices (a tail without alignment);
 * the header has one more material than there are strings (as in the game).
 */
export function makePrefab(mat: string): Uint8Array {
  const vb = new Bin();
  for (const [x, y] of [[0, 0], [10, 0], [0, 10]]) vb.f32s(x!, y!, 0).f32s(0, 0, 1).f32s(x! / 10, y! / 10);
  const vbb = vb.toU8(), ib = new Bin().u16(0).u16(1).u16(2).toU8();
  const b = new Bin().ascii('PRFB').u32(1).u32(0x1234).u32(1).u32(1).u32(1).u32(36).u32(1).u32(3).u32(vbb.length + 8).u32(2).u32(vbb.length).u32(ib.length);
  b.bytes(vbb).bytes(ib);
  b.u32(1).u32(3); for (const [t, u] of [[2, 0], [2, 1], [1, 4]]) b.u8(0).u8(t!).u8(u!).u8(0);
  b.u32(1); for (const x of [0, 3, 0, 0, 1, 0, 0, 0, 0]) b.u32(x);
  const s0 = b.length;
  b.cstr(mat); while ((b.length - s0) % 4) b.u8(0);
  b.u8(0x95).u8(0x02).u8(0);
  return b.toU8();
}
