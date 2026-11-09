// 4A synthetics (Metro 2033): a level-3 QuickLZ packer (literals + short matches), a .vfi + .vfs index, a level.
import { Bin } from './bin';

/** QuickLZ level 3: matches of length 3 with offset 1..63 (a 1-byte code), the rest as literals. */
export function quicklzCompress(data: Uint8Array): Uint8Array {
  const items: Array<{ m: boolean; bytes: number[] }> = [], last = data.length - 11;
  for (let i = 0; i < data.length;) {
    let off = 0;
    if (i < last) for (let o = 1; o < 64 && o <= i; o++) if (data[i - o] === data[i] && data[i - o + 1] === data[i + 1] && data[i - o + 2] === data[i + 2]) { off = o; break; }
    if (off) { items.push({ m: true, bytes: [off << 2] }); i += 3; } else items.push({ m: false, bytes: [data[i++]!] });
  }
  const body: number[] = [];
  for (let k = 0; k < items.length; k += 31) {
    const group = items.slice(k, k + 31);
    let cw = 0x80000000;
    group.forEach((it, b) => { if (it.m) cw |= 1 << b; });
    body.push(cw & 0xff, (cw >>> 8) & 0xff, (cw >>> 16) & 0xff, cw >>> 24);
    for (const it of group) body.push(...it.bytes);
  }
  const out = new Bin().u8(0x7f).u32(9 + body.length).u32(data.length).bytes(body);
  return out.toU8();
}

/** .vfi index (archive name data.vfs0) and the data file: files maps a path (with "content\\") -> contents; compressed ones use QuickLZ. */
export function makeVfi(files: Array<{ path: string; data: Uint8Array; compress?: boolean }>): { vfi: Uint8Array; vfs: Uint8Array } {
  const vfs = new Bin(), recs = new Bin();
  vfs.u32(0).u32(0); // as in the game: data from byte 8
  files.forEach((f, i) => {
    const stored = f.compress ? quicklzCompress(f.data) : f.data, key = 0x5a + i, off = vfs.pos;
    vfs.bytes(stored);
    recs.u8(key).u8(1).u8(2).u8(3).u32(off).u32(f.data.length).u32(stored.length).u32(f.path.length + 1);
    for (let k = 0; k < f.path.length; k++) recs.u8(f.path.charCodeAt(k) ^ key);
    recs.u8(0);
  });
  const name = new Bin().cstr('data.vfs0').u32(vfs.pos), arc = new Bin();
  arc.u32(0).u32(name.length).bytes(name.toU8()).u32(1).u32(recs.length).bytes(recs.toU8()).u32(2).u32(4).u32(0);
  const vfi = new Bin().u32(0xffffffff).u32(20).u32(0).zeros(16).u32(0).u32(arc.length).bytes(arc.toU8());
  return { vfi: vfi.toU8(), vfs: vfs.toU8() };
}

/** 4A level: a 2×2 square in the XZ plane (normal +Y) with one texture. */
export function makeMetroLevel(): { level: Uint8Array; geom: Uint8Array } {
  const chunk = (b: Bin, id: number, body: Bin) => { b.u32(id).u32(body.length).bytes(body.toU8()); };
  const level = new Bin();
  chunk(level, 1, new Bin().u32(16));
  chunk(level, 2, new Bin().u16(1).cstr('geometry\\default').cstr('concrete\\floor_01').cstr('materials\\concrete').u32(0));
  const vis = new Bin(), v0 = new Bin();
  chunk(v0, 0x15, new Bin().u32(3).u32(0).u32(4).u32(0).u32(6));
  chunk(v0, 1, new Bin().u16(7).u16(0).zeros(60));
  chunk(vis, 0, v0);
  chunk(level, 3, vis);
  const vb = new Bin();
  // (b − a) × (c − a) = +Y for windings 0,2,1 / 0,3,2 in a left-handed system
  for (const [x, z, u, v] of [[0, 0, 0, 0], [2, 0, 2048, 0], [2, 2, 2048, 2048], [0, 2, 0, 2048]]) vb.f32s(x!, 0, z!).u8(127).u8(255).u8(127).u8(0).u32(0).u32(0).i16(u!).i16(v!).u32(0);
  const geom = new Bin();
  chunk(geom, 1, new Bin().u32(16));
  chunk(geom, 9, vb);
  chunk(geom, 10, new Bin().u16(0).u16(2).u16(1).u16(0).u16(3).u16(2));
  return { level: level.toU8(), geom: geom.toU8() };
}

const chunkOf = (b: Bin, id: number, body: Bin | Uint8Array) => { const u = body instanceof Bin ? body.toU8() : body; b.u32(id).u32(u.length).bytes(u); return b; };

/** 4A binary config field: [name, type, value]; a section/array value holds nested fields. */
export type CfgSpec = [string, string, unknown];

/** 4A binary config (type 5): data + string table. Array: count and rec_NNNN sections. */
export function makeMetroConfig(fields: CfgSpec[]): Uint8Array {
  const strings: string[] = [], idx = (s: string) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  const crc = (s: string) => { let c = ~0; for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i); for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  // names go into the table in advance so that section crcs (large numbers) do not collide with indices
  const section = (name: string, list: CfgSpec[]): Bin => { const b = new Bin().u8(5).u32(idx(name)); writeFields(b, list); return b; };
  const writeFields = (b: Bin, list: CfgSpec[]) => {
    for (const [name, type, v] of list) {
      if (type === 'section') { const s = section(name, v as CfgSpec[]); b.u32(Math.max(crc(name), 0x10000)).u32(s.length).bytes(s.toU8()); continue; }
      b.u32(idx(name)).u32(idx(type));
      if (type === 'array') { const s = section(name, v as CfgSpec[]); b.u32(Math.max(crc(name), 0x10000)).u32(s.length).bytes(s.toU8()); continue; }
      const base = type.split(',').pop()!.trim();
      if (v === null) continue; // hint
      if (base === 'stringz') b.u32(idx(v as string));
      else if (base === 'u8' || base === 'bool' || base === 'bool8') b.u8(v as number);
      else if (base === 'u16' || base === 'uobject_link') b.u16(v as number);
      else if (base === 'u32') b.u32(v as number);
      else if (base === 'fp32') b.f32(v as number);
      else if (base === 'matrix' || base === 'vec3f') b.f32s(...(v as number[]));
      else throw new Error('makeMetroConfig: тип ' + type);
    }
  };
  const data = new Bin(); writeFields(data, fields);
  const st = new Bin().u32(strings.length); for (const s of strings) st.cstr(s);
  const out = new Bin().u8(5); chunkOf(out, 1, data); chunkOf(out, 2, st);
  return out.toU8();
}

/** level.bin: "levl", size, QuickLZ. */
export const packLevelBin = (cfg: Uint8Array) => new Bin().ascii('levl').u32(cfg.length).bytes(quicklzCompress(cfg)).toU8();

export const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** level.bin object with a model and a pose (matrix by rows, translation in the last row). */
export function metroEntity(name: string, cls: string, visual: string, pose: number[], parent = 0xffff): CfgSpec {
  return [name, 'section', [
    ['version', 'u16', 16], ['class', 'stringz', cls], ['static_data_key', 'stringz', ''], ['id', 'u16', 1], ['parent_id', 'u16', parent],
    ['att_bone_id', 'locator_str', null], ['att_bone_id', 'stringz', ''], ['att_offset', 'pose, matrix', IDENT],
    ['oflags', 'bool8', 0], ['', 'pose, matrix', pose], ['name', 'name', null], ['name', 'stringz', name],
    ['visual', 'ref_model', null], ['visual', 'stringz', visual], ['backlight_ref', 'entity_link, uobject_link', 0xffff], ['dao_val', 'fp32', 1],
  ]];
}

/** Static .model: one mesh, a triangle in the XY plane. */
export function makeStaticModel(texture = 'props\\box'): Uint8Array {
  const vb = new Bin().u32(2).u32(3);
  for (const [x, y, u, v] of [[0, 0, 0, 0], [1, 0, 1, 0], [0, 1, 0, 1]]) vb.f32s(x!, y!, 0).u8(127).u8(127).u8(0).u8(0).u32(0).u32(0).f32s(u!, v!);
  const mesh = new Bin();
  chunkOf(mesh, 1, new Bin().u16(7).u16(0xffff).zeros(60));
  chunkOf(mesh, 2, new Bin().cstr(texture).cstr('geometry\\default').cstr('materials\\wood'));
  chunkOf(mesh, 3, vb);
  chunkOf(mesh, 4, new Bin().u32(3).u16(0).u16(1).u16(2));
  const meshes = chunkOf(new Bin(), 0, mesh);
  return chunkOf(new Bin(), 9, meshes).toU8();
}

/** Skinned model: .model (skeleton + mesh name), .mesh (two bone vertices), .skeleton (a root and a child). */
export function makeSkinnedModel(): { model: Uint8Array; mesh: Uint8Array; skeleton: Uint8Array } {
  const model = new Bin();
  chunkOf(model, 1, new Bin().u16(8).u16(3).zeros(60));
  chunkOf(model, 0x14, new Bin().cstr('dynamic\\test\\rig'));
  chunkOf(model, 0x10, new Bin().u32(2).cstr('dynamic\\test\\body').cstr(''));
  // bones in the file are alphabetical: "a_child" (parent "root") before "root"
  const sk = new Bin().u32(0x1234).u16(2);
  sk.cstr('a_child').cstr('root').f32s(0, Math.PI / 2, 0).f32s(1, 0, 0).u16(0);
  sk.cstr('root').cstr('').f32s(0, 0, 0).f32s(0, 1, 0).u16(0);
  const skeleton = chunkOf(chunkOf(chunkOf(new Bin(), 1, new Bin().u32(1)), 0x0d, sk), 0x13, new Bin().cstr('test\\rig')).toU8();
  // the mesh bone table: [1 (root), 0 (a_child)]; the vertex holds number × 3
  const vb = new Bin().u8(2).u8(1).u8(0).zeros(2 * 60).u32(3);
  for (const [x, y, z, b] of [[0, 2720, 0, 0], [2720, 2720, 0, 3], [0, 5440, 0, 0]]) vb.i16(x!).i16(y!).i16(z!).i16(1).u8(127).u8(255).u8(127).u8(0).u32(0).u32(0).u8(b!).u8(0).u8(0).u8(0).u8(255).u8(0).u8(0).u8(0).i16(1024).i16(2048);
  const m = new Bin();
  chunkOf(m, 1, new Bin().u16(7).u16(5).zeros(60));
  chunkOf(m, 2, new Bin().cstr('act\\body').cstr('geometry\\skin').cstr('materials\\flesh'));
  chunkOf(m, 5, vb);
  chunkOf(m, 4, new Bin().u32(3).u16(0).u16(1).u16(2));
  const mesh = chunkOf(new Bin(), 9, chunkOf(new Bin(), 0, m)).toU8();
  return { model: model.toU8(), mesh, skeleton };
}

/**
 * 4A .motion: bones (numbers in the skeleton file); each has a keyed rotation (quaternions [x,y,z,w]) or a single one,
 * a keyed position (with scale/offset) or a constant one.
 */
export function makeMotion(crc: number, nBones: number, keys: number, tracks: Array<{ bone: number; rot: number[][]; pos: number[][]; small3?: boolean }>): Uint8Array {
  const h = new Bin().u32(8).u32(crc).u16(nBones), mask = new Uint8Array(16);
  for (const t of tracks) mask[t.bone >> 3]! |= 1 << (t.bone & 7);
  h.bytes(mask);
  const info = new Bin().u16(0).f32(1).f32(3).f32(3).u32(keys).u16(0).u16(keys - 1).zeros(32);
  const d = new Bin();
  for (const t of [...tracks].sort((a, b) => a.bone - b.bone)) {
    const animRot = t.rot.length > 1, animPos = t.pos.length > 1;
    d.u8((animPos ? 1 : 0) | (animRot ? 2 : 0) | 4 | (t.small3 ? 0x20 : 0)).u32(0x11223344).u32(0x55667788);
    for (const q of t.rot) {
      if (t.small3) {
        // "smallest three": the largest component is dropped, its index is in the low bits of the first two numbers
        const idx = [0, 1, 2, 3].reduce((m, k) => (Math.abs(q[k]!) > Math.abs(q[m]!) ? k : m), 0), sg = q[idx]! < 0 ? -1 : 1;
        const rest = q.filter((_, k) => k !== idx).map((v) => Math.round((v * sg) / Math.SQRT1_2 * 32767));
        rest[0] = (rest[0]! & ~1) | (idx >> 1); rest[1] = (rest[1]! & ~1) | (idx & 1);
        d.i16(rest[0]!).i16(rest[1]!).i16(rest[2]!);
        continue;
      }
      const s = q[3]! < 0 ? -1 : 1; d.i16(Math.round(q[0]! * s * 32767)).i16(Math.round(q[1]! * s * 32767)).i16(Math.round(q[2]! * s * 32767));
    }
    if (animPos) {
      d.u32(0).u32(0);
      const lo = [0, 1, 2].map((a) => Math.min(...t.pos.map((p) => p[a]!))), hi = [0, 1, 2].map((a) => Math.max(...t.pos.map((p) => p[a]!)));
      const off = lo.map((l, a) => (l + hi[a]!) / 2), sc = lo.map((l, a) => (hi[a]! - l) / 2 / 32767 || 1e-9);
      for (const p of t.pos) for (let a = 0; a < 3; a++) d.i16(Math.round((p[a]! - off[a]!) / sc[a]!));
      d.f32s(...sc).f32s(...off);
    } else d.f32s(...t.pos[0]!);
  }
  const out = new Bin();
  for (const [id, b] of [[0, h], [1, info], [2, d]] as const) out.u32(id).u32(b.length).bytes(b.toU8());
  return out.toU8();
}
