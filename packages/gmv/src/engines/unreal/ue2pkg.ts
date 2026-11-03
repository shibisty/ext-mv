// Пакеты Unreal Engine 2 (.usx, .utx, .ukx, .unr, .u): заголовок, таблицы имён, импорта и экспорта, свойства объектов.
// Lineage II шифрует пакеты: заголовок UTF-16 «Lineage2VerNNN» (28 байт), дальше — XOR одним байтом: Ver111 — 0xAC,
// Ver121 — байт зависит от имени файла, но восстанавливается по сигнатуре пакета 0x9E2A83C1 (первый байт C1).
// Шифрование RSA (Ver41x, поздние хроники) не поддерживается.

export const UE_PKG_MAGIC = 0x9e2a83c1;

/** Lineage2VerNNN → номер или 0. */
export function l2Version(u: Uint8Array): number {
  if (u.length < 28) return 0;
  let s = '';
  for (let i = 0; i < 28; i += 2) s += String.fromCharCode(u[i]! | (u[i + 1]! << 8));
  const m = /^Lineage2Ver(\d{3})$/.exec(s);
  return m ? +m[1]! : 0;
}

/** Расшифровка пакета Lineage II (или сам пакет, если он не зашифрован). */
export function decodeL2(u: Uint8Array, name = ''): Uint8Array {
  const v = l2Version(u);
  if (!v) return u;
  let key: number;
  if (v === 111) key = 0xac;
  else if (v >= 120 && v <= 121) key = u[28]! ^ 0xc1;
  else throw new Error(`${name || 'Файл'}: шифрование Lineage2Ver${v} (RSA поздних хроник) не поддерживается — откройте файлы клиента Prelude/C1–C4 или распакуйте пакет утилитой (l2encdec).`);
  const out = new Uint8Array(u.length - 28);
  for (let i = 0; i < out.length; i++) out[i] = u[28 + i]! ^ key;
  return out;
}

export class UReader {
  dv: DataView;
  pos = 0;
  constructor(public u8: Uint8Array, public ver = 0, public lic = 0) { this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  need(n: number): void { if (this.pos + n > this.u8.length || n < 0) throw new Error(`Unreal: чтение за концом данных (${this.pos}+${n} > ${this.u8.length})`); }
  u8v(): number { this.need(1); return this.u8[this.pos++]!; }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32(): number { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  /** FCompactIndex: знак и 6 бит в первом байте, дальше по 7 бит. */
  idx(): number {
    let b = this.u8v();
    const neg = b & 0x80;
    let v = b & 0x3f;
    if (b & 0x40) {
      let shift = 6;
      for (let i = 0; i < 4; i++) { b = this.u8v(); v |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    }
    return neg ? -v : v;
  }
  vec(): [number, number, number] { return [this.f32(), this.f32(), this.f32()]; }
  /** FString: compact-длина (отрицательная — UTF-16), с нулём в конце. */
  str(): string {
    const n = this.idx();
    if (!n) return '';
    if (n > 0) { this.need(n); const s = new TextDecoder('latin1').decode(this.u8.subarray(this.pos, this.pos + n - 1)); this.pos += n; return s; }
    const m = -n; this.need(m * 2);
    let s = '';
    for (let i = 0; i < m - 1; i++) s += String.fromCharCode(this.dv.getUint16(this.pos + i * 2, true));
    this.pos += m * 2;
    return s;
  }
  bytes(n: number): Uint8Array { this.need(n); const b = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  /** TArray: compact-число и элементы. */
  arr<T>(fn: (r: UReader) => T, max = 1 << 24): T[] {
    const n = this.idx();
    if (n < 0 || n > max) throw new Error(`Unreal: неверная длина массива ${n} @${this.pos}`);
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = fn(this);
    return out;
  }
}

export interface UImport { classPackage: string; className: string; outer: number; name: string }
export interface UExport { classIndex: number; superIndex: number; outer: number; name: string; flags: number; size: number; offset: number; className: string }

/** Чтение расшифрованного диапазона [off, end) пакета (смещения — без заголовка Lineage). */
export type RangeReader = (off: number, end: number) => Promise<Uint8Array>;

/** Доступ к пакету по диапазонам: XOR одним байтом позволяет расшифровывать любой кусок отдельно. */
export function packageRanges(read: (off: number, end: number) => Promise<Uint8Array>, head: Uint8Array, name = ''): { size: (n: number) => number; read: RangeReader } {
  const v = l2Version(head), skip = v ? 28 : 0;
  let key = 0;
  if (v === 111) key = 0xac;
  else if (v >= 120 && v <= 121) key = head[28]! ^ 0xc1;
  else if (v) decodeL2(head, name); // бросит понятную ошибку
  return {
    size: (n) => n - skip,
    read: async (off, end) => { const u = await read(off + skip, end + skip); if (!key) return u; const o = new Uint8Array(u.length); for (let i = 0; i < u.length; i++) o[i] = u[i]! ^ key; return o; },
  };
}

export class UPackage {
  ver = 0; lic = 0; flags = 0;
  names: string[] = [];
  imports: UImport[] = [];
  exports: UExport[] = [];
  private constructor(public readonly fileName: string, private readonly readRange: RangeReader) {}

  /** Пакет целиком в памяти (расшифрованный). */
  static fromBytes(data: Uint8Array, fileName = ''): UPackage {
    const p = new UPackage(fileName, async (o, e) => data.subarray(o, e));
    p.parseTables(data, 0, data, 0, data.length);
    return p;
  }

  /** Пакет по диапазонам: читаются только заголовок, таблица имён и таблицы импорта/экспорта (обычно в конце файла). */
  static async open(read: RangeReader, size: number, fileName = ''): Promise<UPackage> {
    const p = new UPackage(fileName, read);
    const h = await read(0, Math.min(size, 64));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    if (h.length < 36 || dv.getUint32(0, true) !== UE_PKG_MAGIC) throw new Error(`${fileName || 'Файл'}: не пакет Unreal (нет сигнатуры 0x9E2A83C1)`);
    const no = dv.getInt32(16, true), eo = dv.getInt32(24, true), io = dv.getInt32(32, true), nn = dv.getInt32(12, true);
    if (no < 0 || no > size || eo < 0 || eo > size || io < 0 || io > size) throw new Error(`${fileName}: повреждённый заголовок пакета`);
    // имена: по оценке длины, с дочитыванием
    let nEnd = Math.min(size, no + Math.max(4096, nn * 48));
    let names = await read(no, nEnd);
    for (let k = 0; k < 6; k++) {
      try { p.names = []; const r = new UReader(names); for (let i = 0; i < nn; i++) { p.names.push(r.str()); r.u32(); } break; }
      catch (e) { if (nEnd >= size) throw e; nEnd = Math.min(size, no + (nEnd - no) * 4); names = await read(no, nEnd); }
    }
    const t0 = Math.min(io, eo), tail = await read(t0, size);
    p.parseTables(h, -1, tail, t0, size);
    return p;
  }

  private parseTables(head: Uint8Array, namesOff: number, tail: Uint8Array, tailOff: number, size: number): void {
    const r = new UReader(head);
    r.u32();
    this.ver = r.u16(); this.lic = r.u16(); this.flags = r.u32();
    if (this.ver < 61 || this.ver > 140) throw new Error(`${this.fileName}: версия пакета ${this.ver} — поддерживается Unreal Engine 2 (61–140)`);
    const nn = r.i32(), no = r.i32(), en = r.i32(), eo = r.i32(), inn = r.i32(), io = r.i32();
    if ([nn, en, inn].some((n) => n < 0 || n > 4_000_000) || [no, eo, io].some((o) => o < 0 || o > size)) throw new Error(`${this.fileName}: повреждённый заголовок пакета`);
    if (namesOff >= 0) { r.pos = no; this.names = []; for (let i = 0; i < nn; i++) { this.names.push(r.str()); r.u32(); } }
    const t = new UReader(tail);
    t.pos = io - tailOff;
    for (let i = 0; i < inn; i++) this.imports.push({ classPackage: this.names[t.idx()] ?? '', className: this.names[t.idx()] ?? '', outer: t.i32(), name: this.names[t.idx()] ?? '' });
    t.pos = eo - tailOff;
    for (let i = 0; i < en; i++) {
      const classIndex = t.idx(), superIndex = t.idx(), outer = t.i32(), name = this.names[t.idx()] ?? '', flags = t.u32(), sz = t.idx(), offset = sz > 0 ? t.idx() : 0;
      this.exports.push({ classIndex, superIndex, outer, name, flags, size: sz, offset, className: '' });
    }
    for (const e of this.exports) e.className = e.classIndex === 0 ? 'Class' : this.objName(e.classIndex);
  }

  /** Имя объекта по ссылке (>0 — экспорт, <0 — импорт). */
  objName(ref: number): string { return ref > 0 ? this.exports[ref - 1]?.name ?? '' : ref < 0 ? this.imports[-ref - 1]?.name ?? '' : ''; }
  /** Путь объекта по ссылке: Пакет.Группа.Имя (для экспорта — без имени своего пакета). */
  objPath(ref: number): string {
    const parts: string[] = [];
    for (let k = 0; ref && k < 16; k++) {
      if (ref > 0) { const e = this.exports[ref - 1]; if (!e) break; parts.unshift(e.name); ref = e.outer; }
      else { const im = this.imports[-ref - 1]; if (!im) break; parts.unshift(im.name); ref = im.outer; }
    }
    return parts.join('.');
  }
  /** Класс объекта по ссылке. */
  objClass(ref: number): string { return ref > 0 ? this.exports[ref - 1]?.className ?? '' : ref < 0 ? this.imports[-ref - 1]?.className ?? '' : ''; }
  /** Только начало объекта (до n байт) — для быстрых проверок. */
  async readerHead(e: UExport, n: number): Promise<UReader> { return new UReader(e.size > 0 ? await this.readRange(e.offset, e.offset + Math.min(e.size, n)) : new Uint8Array(0), this.ver, this.lic); }
  async reader(e: UExport): Promise<UReader> { return new UReader(e.size > 0 ? await this.readRange(e.offset, e.offset + e.size) : new Uint8Array(0), this.ver, this.lic); }
  name(i: number): string { return this.names[i] ?? `name#${i}`; }
}

export type UPropValue = number | boolean | string | number[] | { struct: string; data: Uint8Array } | { array: Uint8Array };
export interface UProp { name: string; type: number; index: number; value: UPropValue }

const PT = { BYTE: 1, INT: 2, BOOL: 3, FLOAT: 4, OBJECT: 5, NAME: 6, STRING: 7, CLASS: 8, ARRAY: 9, STRUCT: 10, VECTOR: 11, ROTATOR: 12, STR: 13, MAP: 14, FIXED: 15 } as const;

/** Свойства объекта (UE2 с тегами) до «None». Объекты — ссылками пакета, имена — строками. */
export function readProps(pkg: UPackage, r: UReader): Map<string, UProp> {
  const out = new Map<string, UProp>();
  for (let guard = 0; guard < 4096; guard++) {
    const name = pkg.name(r.idx());
    if (name === 'None') break;
    const info = r.u8v(), type = info & 15, sz = (info >> 4) & 7, isArr = !!(info & 0x80);
    const struct = type === PT.STRUCT ? pkg.name(r.idx()) : '';
    let size: number;
    switch (sz) { case 0: size = 1; break; case 1: size = 2; break; case 2: size = 4; break; case 3: size = 12; break; case 4: size = 16; break; case 5: size = r.u8v(); break; case 6: size = r.u16(); break; default: size = r.i32(); }
    let index = 0;
    if (isArr && type !== PT.BOOL) {
      const b = r.u8v();
      index = b < 128 ? b : b < 192 ? ((b & 0x7f) << 8) | r.u8v() : ((b & 0x3f) << 24) | (r.u8v() << 16) | (r.u8v() << 8) | r.u8v();
    }
    const end = r.pos + (type === PT.BOOL ? 0 : size);
    let value: UPropValue;
    const sub = new UReader(r.u8.subarray(r.pos, end), r.ver, r.lic);
    switch (type) {
      case PT.BOOL: value = isArr; break;
      case PT.BYTE: value = size >= 1 ? sub.u8v() : 0; break;
      case PT.INT: value = size >= 4 ? sub.i32() : 0; break;
      case PT.FLOAT: value = size >= 4 ? sub.f32() : 0; break;
      case PT.OBJECT: case PT.CLASS: value = size ? sub.idx() : 0; break;
      case PT.NAME: value = size ? pkg.name(sub.idx()) : ''; break;
      case PT.STR: case PT.STRING: value = size ? sub.str() : ''; break;
      case PT.VECTOR: value = size >= 12 ? sub.vec() : [0, 0, 0]; break;
      case PT.ROTATOR: value = size >= 12 ? [sub.i32(), sub.i32(), sub.i32()] : [0, 0, 0]; break;
      case PT.STRUCT: value = { struct, data: sub.u8 }; break;
      default: value = { array: sub.u8 };
    }
    if (type !== PT.BOOL) r.pos = end;
    out.set(index ? `${name}[${index}]` : name, { name, type, index, value });
  }
  return out;
}

export const propNum = (p: Map<string, UProp>, k: string, def = 0): number => { const v = p.get(k)?.value; return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : def; };
export const propObj = (p: Map<string, UProp>, k: string): number => { const v = p.get(k)?.value; return typeof v === 'number' ? v : 0; };
