// Простейший ZIP для тестов (store или deflate через node:zlib).
import { deflateRawSync } from 'node:zlib';
import { Bin } from './bin';

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function makeZip(files: Record<string, Uint8Array | string>, deflate = true): Uint8Array {
  const w = new Bin(), central: Array<{ name: string; crc: number; comp: number; size: number; off: number; method: number }> = [];
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const body = deflate ? new Uint8Array(deflateRawSync(data)) : data, method = deflate ? 8 : 0, off = w.pos, crc = crc32(data);
    w.u32(0x04034b50).u16(20).u16(0).u16(method).u16(0).u16(0).u32(crc).u32(body.length).u32(data.length).u16(name.length).u16(0).ascii(name).bytes(body);
    central.push({ name, crc, comp: body.length, size: data.length, off, method });
  }
  const cdOff = w.pos;
  for (const c of central)
    w.u32(0x02014b50).u16(20).u16(20).u16(0).u16(c.method).u16(0).u16(0).u32(c.crc).u32(c.comp).u32(c.size).u16(c.name.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(c.off).ascii(c.name);
  const cdSize = w.pos - cdOff;
  w.u32(0x06054b50).u16(0).u16(0).u16(central.length).u16(central.length).u32(cdSize).u32(cdOff).u16(0);
  return w.toU8();
}
