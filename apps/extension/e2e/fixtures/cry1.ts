// Synthetic CryEngine 1 files (Far Cry, "CryTek" 0x744) for tests.
export type Chunk = { type: number; ver: number; id: number; body: Uint8Array };
export const enc = (s: string, n: number) => { const u = new Uint8Array(n); for (let i = 0; i < Math.min(s.length, n - 1); i++) u[i] = s.charCodeAt(i); return u; };

/** CryTek file: a 20-byte header, chunks (each with its own 16-byte header: type, version, offset, id), the table at the end. */
export function cryFile(chunks: Chunk[], fileType = 0xffff0000): ArrayBuffer {
  let off = 20;
  const placed = chunks.map((c) => { const o = off; off += 16 + c.body.length; return { ...c, off: o }; });
  const tab = off, out = new Uint8Array(tab + 4 + chunks.length * 16), dv = new DataView(out.buffer);
  out.set(enc('CryTek', 8)); dv.setUint32(8, fileType, true); dv.setUint32(12, 0x744, true); dv.setUint32(16, tab, true);
  for (const c of placed) {
    dv.setUint32(c.off, c.type, true); dv.setUint32(c.off + 4, c.ver, true); dv.setUint32(c.off + 8, c.off, true); dv.setUint32(c.off + 12, c.id, true);
    out.set(c.body, c.off + 16);
  }
  dv.setUint32(tab, chunks.length, true);
  placed.forEach((c, i) => { const o = tab + 4 + i * 16; dv.setUint32(o, c.type, true); dv.setUint32(o + 4, c.ver, true); dv.setUint32(o + 8, c.off, true); dv.setUint32(o + 12, c.id, true); });
  return out.buffer;
}

/** Node 0x823 (body without a header: name[64] at +0, object +64, parent +68, material +76, matrix +84, controllers +188). */
export function node(name: string, object: number, mtl: number, tm: number[], ctrl: [number, number, number] = [-1, -1, -1], parent = -1): Chunk {
  const b = new Uint8Array(200), dv = new DataView(b.buffer);
  b.set(enc(name, 64)); dv.setInt32(64, object, true); dv.setInt32(68, parent, true); dv.setInt32(76, mtl, true);
  tm.forEach((v, k) => dv.setFloat32(84 + k * 4, v, true));
  ctrl.forEach((v, k) => dv.setInt32(188 + k * 4, v, true));
  return { type: 0xcccc000b, ver: 0x823, id: 2, body: b };
}

/** Mesh 0x744: flags, vertex/UV/face counts, vertices {p, n}, faces {v0,v1,v2, material, smoothing}, UVs, UV faces, tail. */
export function mesh(pos: number[][], faces: number[][], uvs: number[][], tail: Uint8Array = new Uint8Array(0), hasBones = 0): Chunk {
  const nv = pos.length, nf = faces.length, nt = uvs.length;
  const b = new Uint8Array(20 + nv * 24 + nf * 20 + nt * 8 + nf * 12 + tail.length), dv = new DataView(b.buffer);
  b[0] = hasBones; dv.setInt32(4, nv, true); dv.setInt32(8, nt, true); dv.setInt32(12, nf, true); dv.setInt32(16, -1, true);
  let p = 20;
  for (const v of pos) { dv.setFloat32(p, v[0]!, true); dv.setFloat32(p + 4, v[1]!, true); dv.setFloat32(p + 8, v[2]!, true); dv.setFloat32(p + 20, 1, true); p += 24; }
  for (const f of faces) { f.forEach((x, k) => dv.setInt32(p + k * 4, x, true)); dv.setInt32(p + 12, 0, true); p += 20; }
  for (const t of uvs) { dv.setFloat32(p, t[0]!, true); dv.setFloat32(p + 4, t[1]!, true); p += 8; }
  for (const f of faces) { f.forEach((x, k) => dv.setInt32(p + k * 4, x, true)); p += 12; }
  b.set(tail, p);
  return { type: 0xcccc0000, ver: 0x744, id: 3, body: b };
}

/** Material: 0x746 = 236-byte slots from +176 (from the chunk start), 0x745 = 108 bytes from +112; diffuse is slot 1. */
export function mtl(name: string, diffuse: string, ver = 0x746): Chunk {
  const size = ver === 0x746 ? 2552 : 1208, b = new Uint8Array(size - 16);
  b.set(enc(name, 64));
  const base = ver === 0x746 ? 176 : 112, stride = ver === 0x746 ? 236 : 108;
  if (ver === 0x745) b.fill(0xff, base + stride - 28 - 16, base + stride - 16); // garbage before the name, as in game files
  b.set(enc(diffuse, 64), base + stride - 16);
  return { type: 0xcccc000c, ver, id: 1, body: b };
}

export const ident = (tx = 0, ty = 0, tz = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
export const tri = { pos: [[0, 0, 0], [100, 0, 0], [0, 0, 100]], faces: [[0, 1, 2]], uvs: [[0, 0], [1, 0], [0, 1]] };

