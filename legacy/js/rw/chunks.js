// RenderWare binary stream: заголовок чанка 12 байт (type, size, library stamp).
export function rwVersion(stamp) {
  return (stamp & 0xffff0000) ? ((((stamp >>> 14) & 0x3ff00) | ((stamp >>> 16) & 0x3f) | 0x30000) >>> 0) : ((stamp << 8) >>> 0);
}
export function chunks(buf, start, end) {
  const dv = new DataView(buf), list = []; let p = start;
  while (p + 12 <= end) {
    const type = dv.getUint32(p, true), size = dv.getUint32(p + 4, true), stamp = dv.getUint32(p + 8, true);
    list.push({ type, size, ver: rwVersion(stamp), start: p + 12, end: Math.min(p + 12 + size, end) });
    p += 12 + size;
  }
  return list;
}
export const cstr = (u8, a, b) => { let s = ''; for (let i = a; i < b && u8[i]; i++) s += String.fromCharCode(u8[i]); return s; };
