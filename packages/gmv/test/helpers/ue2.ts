// Синтетические пакеты Unreal Engine 2 (Lineage II): таблицы имён/импорта/экспорта, свойства с тегами, шифрование Ver111/121.

export class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { this.u8(v); this.u8(v >> 8); return this; }
  i32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); return this; }
  f32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.u8(d.getUint8(i)); return this; }
  idx(v: number) {
    const neg = v < 0; let a = Math.abs(v);
    let first = (neg ? 0x80 : 0) | (a & 0x3f); a >>>= 6;
    if (a) first |= 0x40;
    this.u8(first);
    while (a) { let b = a & 0x7f; a >>>= 7; if (a) b |= 0x80; this.u8(b); }
    return this;
  }
  str(s: string) { this.idx(s.length + 1); for (const c of s) this.u8(c.charCodeAt(0)); this.u8(0); return this; }
  bytes(u: ArrayLike<number>) { for (let i = 0; i < u.length; i++) this.u8(u[i]!); return this; }
  get u(): Uint8Array { return Uint8Array.from(this.b); }
}

export interface PkgObj { cls: number; name: string; outer?: number; flags?: number; body: (names: (s: string) => number) => Uint8Array }

/** Пакет: names — все имена (None обязательно), imports — [пакет класса, класс, outer, имя], exports — объекты. */
export function makeUe2Package(names: string[], imports: Array<[string, string, number, string]>, exports: PkgObj[], ver = 123, lic = 16): Uint8Array {
  const ni = (s: string) => { const i = names.indexOf(s); if (i < 0) throw new Error('нет имени ' + s); return i; };
  const bodies = exports.map((e) => e.body(ni));
  const w = new W();
  const hdr = 64;
  w.i32(0x9e2a83c1).u16(ver).u16(lic).i32(1).i32(names.length).i32(hdr).i32(exports.length).i32(0).i32(imports.length).i32(0);
  for (let i = 0; i < 16; i++) w.u8(0);
  w.i32(1).i32(exports.length).i32(names.length);
  while (w.b.length < hdr) w.u8(0);
  for (const n of names) { w.str(n); w.i32(0); }
  const offs: number[] = [];
  for (const b of bodies) { offs.push(w.b.length); w.bytes(b); }
  const io = w.b.length;
  for (const [cp, cn, outer, n] of imports) { w.idx(ni(cp)); w.idx(ni(cn)); w.i32(outer); w.idx(ni(n)); }
  const eo = w.b.length;
  exports.forEach((e, i) => { w.idx(e.cls); w.idx(0); w.i32(e.outer ?? 0); w.idx(ni(e.name)); w.i32(e.flags ?? 0x70004); w.idx(bodies[i]!.length); w.idx(offs[i]!); });
  const u = w.u, dv = new DataView(u.buffer);
  dv.setInt32(24, eo, true); dv.setInt32(32, io, true);
  return u;
}

/** Шифрование Lineage II: заголовок UTF-16 «Lineage2VerNNN» + XOR (Ver111 — 0xAC, Ver121 — key). */
export function l2Encrypt(u: Uint8Array, ver: 111 | 121 = 111, key = 0x5a): Uint8Array {
  const tag = `Lineage2Ver${ver}`, out = new Uint8Array(28 + u.length), k = ver === 111 ? 0xac : key;
  for (let i = 0; i < tag.length; i++) out[i * 2] = tag.charCodeAt(i);
  for (let i = 0; i < u.length; i++) out[28 + i] = u[i]! ^ k;
  return out;
}

/** Свойства: [имя, тип, значение] (2 int, 3 bool, 5 object, 9 array — байты как есть), затем None. */
export function props(ni: (s: string) => number, list: Array<[string, number, number | boolean | Uint8Array | { struct: string; data: Uint8Array; index?: number }]>): W {
  const w = new W();
  for (const [n, t, v] of list) {
    w.idx(ni(n));
    if (t === 3) { w.u8(3 | (v ? 0x80 : 0)); continue; }
    if (t === 10) {
      const st = v as { struct: string; data: Uint8Array; index?: number };
      const code = st.data.length === 12 ? 3 : 5;
      w.u8(10 | (code << 4) | (st.index ? 0x80 : 0)).idx(ni(st.struct));
      if (code === 5) w.u8(st.data.length);
      if (st.index) w.u8(st.index);
      w.bytes(st.data); continue;
    }
    if (t === 4) { w.u8(4 | (2 << 4)).f32(v as number); continue; }
    if (t === 2) { w.u8(2 | (2 << 4)).i32(v as number); continue; }
    if (t === 1) { w.u8(1).u8(v as number); continue; }
    if (t === 5) { const x = new W().idx(v as number).u; w.u8(5 | (5 << 4)).u8(x.length).bytes(x); continue; }
    const x = v as Uint8Array; w.u8(t | (5 << 4)).u8(x.length).bytes(x);
  }
  w.idx(ni('None'));
  return w;
}

export const vec3 = (x: number, y: number, z: number): Uint8Array => new W().f32(x).f32(y).f32(z).u;
export const rot3 = (p: number, y: number, r: number): Uint8Array => new W().i32(p).i32(y).i32(r).u;
