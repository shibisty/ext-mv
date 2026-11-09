// Builder of synthetic binary files for tests.
export class Bin {
  private buf = new Uint8Array(256);
  private dv = new DataView(this.buf.buffer);
  pos = 0;
  le = true;

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf);
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  get length() { return this.pos; }
  u8(v: number) { this.ensure(1); this.dv.setUint8(this.pos, v); this.pos += 1; return this; }
  i8(v: number) { this.ensure(1); this.dv.setInt8(this.pos, v); this.pos += 1; return this; }
  u16(v: number) { this.ensure(2); this.dv.setUint16(this.pos, v, this.le); this.pos += 2; return this; }
  i16(v: number) { this.ensure(2); this.dv.setInt16(this.pos, v, this.le); this.pos += 2; return this; }
  u32(v: number) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, this.le); this.pos += 4; return this; }
  i32(v: number) { this.ensure(4); this.dv.setInt32(this.pos, v, this.le); this.pos += 4; return this; }
  u32be(v: number) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, false); this.pos += 4; return this; }
  u64(v: bigint) { this.ensure(8); this.dv.setBigUint64(this.pos, v, this.le); this.pos += 8; return this; }
  f32(v: number) { this.ensure(4); this.dv.setFloat32(this.pos, v, this.le); this.pos += 4; return this; }
  f32s(...v: number[]) { for (const x of v) this.f32(x); return this; }
  bytes(b: ArrayLike<number>) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  /** ASCII without a zero. */
  ascii(s: string) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
  /** ASCII + 0. */
  cstr(s: string) { return this.ascii(s).u8(0); }
  /** ASCII padded with zeros to n bytes. */
  fixed(s: string, n: number) { const start = this.pos; this.ascii(s.slice(0, n)); this.zeros(n - (this.pos - start)); return this; }
  zeros(n: number) { this.ensure(n); this.pos += n; return this; }
  /** Move to an offset (growing the buffer). */
  seek(p: number) { if (p > this.buf.length) this.ensure(p - this.pos); this.pos = p; return this; }
  /** Write a u32 at an offset without moving the position. */
  patchU32(at: number, v: number) { this.dv.setUint32(at, v >>> 0, this.le); return this; }
  patchI32(at: number, v: number) { this.dv.setInt32(at, v, this.le); return this; }
  align(n: number) { while (this.pos % n) this.u8(0); return this; }
  toArrayBuffer(): ArrayBuffer { return this.buf.slice(0, this.pos).buffer; }
  toU8(): Uint8Array { return this.buf.slice(0, this.pos); }
}

/** A browser-style File (Node 20+ has a global File). */
export function file(data: ArrayBuffer | Uint8Array | string, name: string, relPath?: string): File {
  const f = new File([data as BlobPart], name);
  if (relPath) Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
  return f;
}

/** An in-memory VFile (like an archive entry). */
export function vfile(data: ArrayBuffer | Uint8Array, name: string, path?: string) {
  const ab = data instanceof Uint8Array ? data.slice().buffer : data;
  return { name, path, arrayBuffer: async () => ab.slice(0) };
}
