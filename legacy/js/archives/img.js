// IMG: v1 (GTA III / Vice City: .dir + .img) и v2 (San Andreas: «VER2»). Размеры и смещения — в секторах по 2048 байт.
const SECTOR = 2048;
const name24 = (u8, a) => { let s = ''; for (let i = 0; i < 24 && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s.toLowerCase(); };

export async function openImg(imgFile, dirFile) {
  const head = new Uint8Array(await imgFile.slice(0, 8).arrayBuffer());
  const v2 = String.fromCharCode(head[0], head[1], head[2], head[3]) === 'VER2';
  let entries = [];
  if (v2) {
    const count = new DataView(head.buffer).getUint32(4, true);
    const buf = await imgFile.slice(8, 8 + count * 32).arrayBuffer(), dv = new DataView(buf), u8 = new Uint8Array(buf);
    for (let i = 0; i < count; i++) {
      const o = i * 32, streaming = dv.getUint16(o + 4, true), inArch = dv.getUint16(o + 6, true);
      entries.push({ path: name24(u8, o + 8), off: dv.getUint32(o, true) * SECTOR, size: (inArch || streaming) * SECTOR, file: null });
    }
  } else {
    if (!dirFile) throw new Error(`${imgFile.name}: для IMG v1 (GTA III/VC) выберите вместе с ним одноимённый .dir`);
    const buf = await dirFile.arrayBuffer(), dv = new DataView(buf), u8 = new Uint8Array(buf);
    for (let o = 0; o + 32 <= buf.byteLength; o += 32)
      entries.push({ path: name24(u8, o + 8), off: dv.getUint32(o, true) * SECTOR, size: dv.getUint32(o + 4, true) * SECTOR, file: null });
  }
  const index = new Map(entries.map((e) => [e.path, e]));
  const arch = {
    name: imgFile.name, version: v2 ? 2 : 1, entries, index, byKey: new Map(),
    async read(e) { return new Uint8Array(await imgFile.slice(e.off, e.off + e.size).arrayBuffer()); },
    fileOf(e) {
      if (!e.file) e.file = { name: e.path, path: e.path, archive: arch, arrayBuffer: async () => { const d = await arch.read(e); return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength); } };
      return e.file;
    },
  };
  return arch;
}
