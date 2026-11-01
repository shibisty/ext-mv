// ZIP без сжатия (store) для выгрузки набора файлов одним архивом. Пути — через «/», имена в UTF-8 (флаг 0x800).
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function writeZip(files: Map<string, Uint8Array> | Array<[string, Uint8Array]>): Uint8Array {
  const list = [...files], enc = new TextEncoder(), parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [path, data] of list) {
    const name = enc.encode(path.replace(/\\/g, '/')), crc = crc32(data);
    const lh = new Uint8Array(30 + name.length), l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(8, 0, true);
    l.setUint16(10, time, true); l.setUint16(12, date, true); l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true); lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, off, true); ch.set(name, 46);
    parts.push(lh, data); central.push(ch);
    off += lh.length + data.length;
  }
  const cdSize = central.reduce((a, x) => a + x.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, list.length, true); e.setUint16(10, list.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  const out = new Uint8Array(off + cdSize + 22);
  let p = 0;
  for (const x of [...parts, ...central, end]) { out.set(x, p); p += x.length; }
  return out;
}
