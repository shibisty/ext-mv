// Синтетические файлы Black Box (NFS World): чанки, блоки сжатия, JDLZ, кодировщик EA HUFF (коды по 2 бита),
// GEOMETRY.bin машины с одним объектом и пакет текстур TPK со сжатой записью.

export class B {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { this.u8(v); this.u8(v >> 8); return this; }
  i16(v: number) { return this.u16(v & 0xffff); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); return this; }
  f32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.u8(d.getUint8(i)); return this; }
  bytes(u: ArrayLike<number>) { for (let i = 0; i < u.length; i++) this.u8(u[i]!); return this; }
  str(s: string) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  pad(n: number, v = 0) { for (let i = 0; i < n; i++) this.u8(v); return this; }
  get u(): Uint8Array { return Uint8Array.from(this.b); }
}

export const chunk = (id: number, body: Uint8Array): Uint8Array => new B().u32(id).u32(body.length).bytes(body).u;
export const cat = (...parts: Uint8Array[]): Uint8Array => { const w = new B(); for (const p of parts) w.bytes(p); return w.u; };

/** JDLZ: «abc» литералами, затем короткая ссылка (расстояние 3, длина 6) → «abcabcabc». */
export function jdlzSample(): Uint8Array {
  const body = [0x08, 0x01, 0x61, 0x62, 0x63, 0x02, 0x03];
  return new B().str('JDLZ').u8(2).u8(0x10).u16(0).u32(9).u32(16 + body.length).bytes(body).u;
}

/** EA HUFF 0x30FB: до 4 символов, все коды длины 2; clue — символ-побег (повтор / конец). */
export function huffEncode(data: Uint8Array, clue: number): Uint8Array {
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  const num = (v: number) => {
    if (v < 4) { bits.push(1); put(v, 2); return; }
    let n = 3; while (v >= (1 << (n + 1)) - 4) n++;
    for (let z = 0; z < n - 2; z++) bits.push(0);
    bits.push(1); put(v - (1 << n) + 4, n);
  };
  const set = new Set([...data, clue]);
  for (let f = 0; set.size < 4; f++) set.add(f); // недостающие символы — заполнители
  const syms = [...set].sort((a, b) => a - b);
  if (syms.length !== 4) throw new Error('кодировщик теста: не больше 4 символов (с clue)');
  put(0x30fb, 16); put(data.length, 24); put(clue, 8);
  num(0); num(4); // длина 1 — 0 кодов, длина 2 — 4 кода: дерево полное
  let last = -1;
  for (const s of syms) { num(s - last - 1); last = s; } // «прыжок» по ещё не занятым байтам
  const code = (s: number) => put(syms.indexOf(s), 2);
  for (let i = 0; i < data.length;) {
    let run = 1; while (i + run < data.length && data[i + run] === data[i]) run++;
    code(data[i]!);
    if (run > 2) { code(clue); num(run - 1); i += run; } else i++;
  }
  code(clue); num(0); bits.push(1);
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(bits.length / 8 + 4);
  for (let i = 0; i < bits.length; i++) out[i >> 3]! |= bits[i]! << (7 - (i & 7));
  return out;
}

/** Блок сжатия 0x55441122: тело (JDLZ / «HUFF» + 16 байт заголовка / как есть) пишется в вывод со смещения outOff. */
export function block(body: Uint8Array, usize: number, outOff: number): Uint8Array {
  return new B().u32(0x55441122).u32(usize).u32(24 + body.length).u32(outOff).u32(0).u32(0).bytes(body).u;
}
export const huffBlock = (data: Uint8Array, clue: number, outOff: number): Uint8Array => {
  const h = huffEncode(data, clue);
  return block(new B().str('HUFF').u8(1).u8(0x10).u16(0).u32(data.length).u32(h.length + 16).bytes(h).u, data.length, outOff);
};

/** Вершина 32 байта: позиция s16/4096, UV s16/4096, цвет, нормаль s16/32767, касательная. */
export function vertex(w: B, p: [number, number, number], uv: [number, number], n: [number, number, number]): void {
  w.i16(Math.round(p[0] * 4096)).i16(Math.round(p[1] * 4096)).i16(Math.round(p[2] * 4096)).i16(4096);
  w.i16(Math.round(uv[0] * 4096)).i16(Math.round(uv[1] * 4096));
  w.u32(0xffffffff);
  w.i16(Math.round(n[0] * 32767)).i16(Math.round(n[1] * 32767)).i16(Math.round(n[2] * 32767)).i16(0);
  w.u32(0).u32(0);
}

const pad11 = (n: number) => new B().pad(n, 0x11).u;

/** Объект 0x80134010: имя, единичная матрица, один подмеш (текстура tex) из треугольника. */
export function nfsObject(name: string, tex: number): Uint8Array {
  const hdr = new B().pad(64);
  for (let k = 0; k < 16; k++) hdr.f32(k % 5 === 0 ? 1 : 0);
  hdr.pad(0xa0 - hdr.b.length).str(name).u8(0);
  while (hdr.b.length % 4) hdr.u8(0);
  const mh = new B().pad(8, 0x11).u32(0).u32(0).u32(18).u32(0).u32(1).u32(0).u32(1).pad(24);
  const sub = new B().pad(4, 0x11).u32(0).u32(tex).u32(8).u32(0);
  for (let k = 0; k < 6; k++) sub.f32(0);
  sub.pad(64 - sub.b.length + 4).u32(3).u32(3).u32(1).u32(0);
  sub.pad(4 + 116 - sub.b.length);
  const idx = new B().pad(4, 0x11).u16(0).u16(1).u16(2).u16(0);
  const vb = new B().pad(8, 0x11);
  vertex(vb, [0, 0, 0], [0, 0], [0, 0, 1]); vertex(vb, [1, 0, 0], [1, 0], [0, 0, 1]); vertex(vb, [0, 0.5, 0.25], [0, 1], [0, 0, 1]);
  const mesh = chunk(0x80134100, cat(chunk(0x134900, mh.u), chunk(0x134b02, sub.u), chunk(0x134b03, idx.u), chunk(0x134b01, vb.u), chunk(0x134c02, new B().str('BODY').u32(0).u)));
  return chunk(0x80134010, cat(chunk(0x134011, hdr.u), chunk(0x134012, new B().u32(tex).u32(0).u), mesh));
}

/** GEOMETRY.bin: таблица объектов, затем объекты — первый в блоке JDLZ-обёртке «как есть», второй без блоков. */
export function nfsGeometry(objs: Array<{ hash: number; data: Uint8Array; packed?: boolean }>): Uint8Array {
  const head = 24 + objs.length * 36; // 0x80134000{0x80134001{0x134004{таблица}}}
  let off = head;
  const bodies = objs.map((o) => (o.packed ? cat(block(o.data.subarray(0, 40), o.data.length, 0), block(o.data.subarray(40), o.data.length, 40)) : o.data));
  const table = new B();
  objs.forEach((o, i) => { table.u32(o.hash).u32(off).u32(bodies[i]!.length).u32(o.data.length).u32(0).u32(0x200).pad(12); off += bodies[i]!.length; });
  const top = chunk(0x80134000, chunk(0x80134001, chunk(0x134004, table.u)));
  return cat(top, ...bodies);
}

/** TPK со сжатой записью: пиксели (HUFF или как есть) + TextureInfo 212 байт (хеш, размеры, имя, FourCC). */
export function nfsTpk(hash: number, name: string, w: number, h: number, fourcc: string, pixels: Uint8Array, huff = false): Uint8Array {
  const info = new B().pad(12).u32(hash).pad(8).u32(pixels.length).u32(0).u32(w).u32(h);
  info.pad(144 - info.b.length).u8(name.length + 1).str(name).u8(0);
  info.pad(192 - info.b.length).str(fourcc).pad(212 - 196);
  const us = pixels.length + 212;
  const entries = new B(), head = (body: Uint8Array) => chunk(0xb3310000, cat(chunk(0x33310001, new B().u32(9).str('CARTEMPLATETEXTURES_TEST').pad(124 - 28).u), chunk(0x33310002, new B().u32(hash).u32(0).u), body));
  const placeholder = chunk(0x33310003, new B().pad(36).u);
  const blocks = cat(huff ? huffBlock(pixels, 0x7f, 0) : block(pixels, pixels.length, 0), block(info.u, info.u.length, pixels.length));
  const dataStart = 8 + head(placeholder).length + 8 + 8; // TPK, заголовок, 0xB3320000, 0x33320002 — смещения в файле
  entries.u32(hash).u32(dataStart).u32(blocks.length).u32(us).u32(212).u32(0x600).pad(12);
  return chunk(0xb3300000, cat(head(chunk(0x33310003, entries.u)), chunk(0xb3320000, chunk(0x33320002, blocks))));
}

export { pad11 };
