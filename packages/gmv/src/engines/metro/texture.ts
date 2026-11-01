// Текстуры 4A (Metro 2033): сырые блоки DXT без заголовка, разложенные по файлам размеров.
// «имя.512» — уровень 512 и вся цепочка mip-уровней ниже; «имя.1024», «имя.2048» — только свой верхний уровень.
// Формат определяется по размеру файла: DXT1 (8 байт на блок 4×4) или DXT5 (16 байт: альфа, карты рельефа *_bump).
const dxtSize = (w: number, h: number, bpb: number) => Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * bpb;
const chain = (s: number, bpb: number) => { let t = 0; for (let w = s; w >= 1; w >>= 1) t += dxtSize(w, w, bpb); return t; };

/** Формат и число mip-уровней куска по его размеру и стороне (из расширения). */
export function pieceFormat(side: number, bytes: number): { fourcc: 'DXT1' | 'DXT5'; mips: number } | null {
  for (const [fourcc, bpb] of [['DXT1', 8], ['DXT5', 16]] as const) {
    if (bytes === chain(side, bpb)) return { fourcc, mips: Math.log2(side) + 1 };
    if (bytes === dxtSize(side, side, bpb)) return { fourcc, mips: 1 };
  }
  return null;
}

/** Собрать DDS из кусков: sizes — стороны по убыванию (2048, 1024, 512), последний кусок — с цепочкой mip-уровней. */
export function ddsFromPieces(pieces: Array<{ side: number; data: Uint8Array }>): Uint8Array {
  const sorted = [...pieces].sort((a, b) => b.side - a.side);
  // берём непрерывную цепочку от наибольшего куска до куска с mip-уровнями
  const used: typeof sorted = [];
  let fourcc: 'DXT1' | 'DXT5' | null = null, levels = 0;
  for (const p of sorted) {
    const f = pieceFormat(p.side, p.data.length);
    if (!f || (fourcc && f.fourcc !== fourcc)) continue;
    if (used.length && p.side * 2 !== used[used.length - 1]!.side) continue;
    fourcc = f.fourcc; used.push(p); levels += f.mips;
    if (f.mips > 1) break;
  }
  if (!fourcc || !used.length) throw new Error('4A: неизвестный формат текстуры');
  const top = used[0]!.side, body = used.reduce((a, p) => a + p.data.length, 0), u = new Uint8Array(128 + body), dv = new DataView(u.buffer);
  dv.setUint32(0, 0x20534444, true); dv.setUint32(4, 124, true); dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000 | (levels > 1 ? 0x20000 : 0), true);
  dv.setUint32(12, top, true); dv.setUint32(16, top, true); dv.setUint32(20, dxtSize(top, top, fourcc === 'DXT1' ? 8 : 16), true); dv.setUint32(28, levels, true);
  dv.setUint32(76, 32, true); dv.setUint32(80, 0x4, true);
  for (let i = 0; i < 4; i++) dv.setUint8(84 + i, fourcc.charCodeAt(i));
  dv.setUint32(108, 0x1000 | (levels > 1 ? 0x400008 : 0), true);
  let p = 128;
  for (const x of used) { u.set(x.data, p); p += x.data.length; }
  return u;
}
