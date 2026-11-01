// SnowRunner .pct (prebuild/textures/pct): блоки «u16 тег, u32 абсолютный конец»:
// 0xF0 «TCIP», 0x102 размеры (w, h, глубина, грани), 0xF2 формат, 0xF9 число мипов, 0x107 таблица (смещение, размер) мипов,
// 0xFF данные (мипы от крупного к мелкому). Форматы 0x33/0x34 — BC7 (1 байт на пиксель), 0.5 байта на пиксель — BC1.
import { decodeBC7 } from '../../core/images/bc7';
import { decodeDXT } from '../../core/images/dds';
import type { DecodedImage } from '../../core/types';

export function decodePct(buf: ArrayBuffer, maxSide = 2048): DecodedImage {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), ch = new Map<number, [number, number]>();
  for (let p = 0; p + 6 <= u8.length; ) {
    const tag = dv.getUint16(p, true), end = dv.getUint32(p + 2, true);
    if (end <= p || end > u8.length + 16) break;
    ch.set(tag, [p + 6, Math.min(end, u8.length)]);
    if (tag === 0xff) break;
    p = end;
  }
  const dims = ch.get(0x102), data = ch.get(0xff);
  if (!ch.has(0xf0) || !dims || !data) throw new Error('PCT: нет заголовка или данных');
  const w = dv.getUint32(dims[0], true), h = dv.getUint32(dims[0] + 4, true);
  const fmt = ch.has(0xf2) ? dv.getUint32(ch.get(0xf2)![0], true) : 0, mips = ch.has(0xf9) ? dv.getUint32(ch.get(0xf9)![0], true) : 1;
  const tbl = ch.get(0x107), list: Array<[number, number]> = [];
  if (tbl) for (let q = tbl[0]; q + 8 <= tbl[1] && list.length < mips; q += 8) list.push([dv.getUint32(q, true), dv.getUint32(q + 4, true)]);
  if (!list.length) list.push([0, data[1] - data[0]]);
  const px = Array.from({ length: mips }, (_, k) => Math.max(1, w >> k) * Math.max(1, h >> k)).reduce((a, b) => a + b, 0);
  const bpp = (data[1] - data[0]) / px;
  let k = 0;
  while (k + 1 < list.length && Math.max(w >> k, h >> k) > maxSide) k++;
  const mw = Math.max(1, w >> k), mh = Math.max(1, h >> k), off = data[0] + list[k]![0];
  if (bpp > 0.75 && bpp < 1.25) return { width: mw, height: mh, rgba: decodeBC7(u8, off, mw, mh) };
  if (bpp > 0.4 && bpp < 0.6) return { width: mw, height: mh, rgba: decodeDXT(new DataView(buf, off), 0, mw, mh, 1) };
  throw new Error(`PCT: формат 0x${fmt.toString(16)} (${bpp.toFixed(2)} байт/пиксель) не поддержан`);
}
