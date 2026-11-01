// ZIP (pk3 — Quake III, pk4 — Doom 3 / Quake 4): читается только центральный каталог; данные — по требованию (store / deflate).
import { buildArchive } from './common.js';
import { normPath } from './bsa.js';

async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function openZip(file) {
  const tailLen = Math.min(file.size, 65557), tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  const tdv = new DataView(tail.buffer); let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tdv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error(`${file.name}: не ZIP (нет конца каталога)`);
  const cdSize = tdv.getUint32(e + 12, true), cdOff = tdv.getUint32(e + 16, true);
  if (cdOff === 0xffffffff) throw new Error(`${file.name}: ZIP64 не поддерживается`);
  const buf = await file.slice(cdOff, cdOff + cdSize).arrayBuffer(), dv = new DataView(buf), u8 = new Uint8Array(buf), entries = [];
  for (let p = 0; p + 46 <= buf.byteLength && dv.getUint32(p, true) === 0x02014b50;) {
    const method = dv.getUint16(p + 10, true), comp = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    let n = ''; for (let i = 0; i < nl; i++) n += String.fromCharCode(u8[p + 46 + i]);
    if (!n.endsWith('/')) entries.push({ path: normPath(n), method, comp, size, off });
    p += 46 + nl + xl + cl;
  }
  return buildArchive(file.name, 0, entries, async (en) => {
    const lh = new DataView(await file.slice(en.off, en.off + 30).arrayBuffer());
    const start = en.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const data = new Uint8Array(await file.slice(start, start + en.comp).arrayBuffer());
    if (en.method === 0) return data;
    if (en.method === 8) return inflateRaw(data);
    throw new Error('метод сжатия ZIP ' + en.method + ' не поддерживается');
  });
}
