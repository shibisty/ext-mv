// PBO (Arma, DayZ, OFP): заголовок из записей «имя\0 + 5×u32», запись-расширение «Vers» со свойствами (prefix=…), данные подряд.
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';
import { lzssDecompress } from './lzss';

interface PboEntry extends ArchiveEntry { off: number; size: number; orig: number; packed: boolean; virtual?: string; title?: string }
const FOLDER: Record<string, string> = { unit: 'units', vehicle: 'vehicles', uniform: 'uniforms', wearable: 'gear', weapon: 'weapons', item: 'items' };
const VERS = 0x56657273, CPRS = 0x43707273;

export interface PboHeader { props: Record<string, string>; entries: Array<{ name: string; mime: number; orig: number; size: number }>; dataStart: number }

/** Разбор заголовка; null — заголовок не уместился в буфер (нужно прочитать больше). */
export function parsePboHeader(u8: Uint8Array): PboHeader | null {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), props: Record<string, string> = {}, entries: PboHeader['entries'] = [];
  let p = 0;
  const str = (): string | null => {
    const e = u8.indexOf(0, p);
    if (e < 0) return null;
    let s = '';
    for (let i = p; i < e; i++) s += String.fromCharCode(u8[i]!);
    p = e + 1;
    return s;
  };
  for (;;) {
    const name = str();
    if (name === null || p + 20 > u8.length) return null;
    const mime = dv.getUint32(p, true), orig = dv.getUint32(p + 4, true), size = dv.getUint32(p + 16, true);
    p += 20;
    if (!name) {
      if (mime === VERS && !entries.length) {
        for (;;) { const k = str(); if (k === null) return null; if (!k) break; const v = str(); if (v === null) return null; props[k.toLowerCase()] = v; }
        continue;
      }
      break;
    }
    entries.push({ name, mime, orig, size });
  }
  return { props, entries, dataStart: p };
}

export async function openPbo(file: BlobFile): Promise<Archive> {
  let n = 1 << 16, h: PboHeader | null = null;
  for (;;) {
    const u8 = await readRange(file, 0, Math.min(n, file.size));
    h = parsePboHeader(u8);
    if (h || n >= file.size) break;
    n *= 4;
  }
  if (!h) throw new Error(`${file.name}: повреждённый заголовок PBO`);
  const prefix = normPath(h.props.prefix ?? file.name.replace(/\.(pbo|ebo|xbo)$/i, '')).replace(/\/+$/, '');
  const entries: PboEntry[] = [];
  let off = h.dataStart;
  for (const e of h.entries) {
    entries.push({ path: normPath(`${prefix}/${e.name}`), off, size: e.size, orig: e.orig || e.size, packed: e.mime === CPRS && e.orig > 0 && e.orig !== e.size });
    off += e.size;
  }
  // классы из config.bin — виртуальные файлы «config/<вид>/<класс>.armacfg» (оружие с обвесом, солдат с экипировкой…)
  const cfgEntry = entries.find((e) => e.path === `${prefix}/config.bin` || e.path === 'config.bin');
  if (cfgEntry) {
    try {
      const { parseRap, isRap } = await import('./rap');
      const { listClasses } = await import('./cfg');
      let u8 = await readRange(file, cfgEntry.off, cfgEntry.off + cfgEntry.size);
      if (cfgEntry.packed) u8 = lzssDecompress(u8, 0, cfgEntry.orig).data;
      if (isRap(u8))
        for (const c of listClasses(parseRap(u8)))
          entries.push({ path: normPath(`${prefix}/config/${FOLDER[c.kind]}/${c.cls}.armacfg`), off: 0, size: 0, orig: 0, packed: false, virtual: JSON.stringify({ cfg: c.cfg, cls: c.cls, kind: c.kind }), title: c.title });
    } catch { /* повреждённый конфиг — просто без классов */ }
  }
  return createArchive<PboEntry>({
    name: file.name, kind: 'pbo', version: 1, entries,
    displayName: (e) => (e.virtual ? `${e.title && e.title.toLowerCase() !== e.path.split('/').pop()!.replace(/\.armacfg$/, '') ? `${e.title} — ` : ''}${e.path.split('/').pop()}` : e.path.split('/').pop()!),
    async read(e) {
      if (e.virtual) return new TextEncoder().encode(e.virtual);
      const raw = await readRange(file, e.off, e.off + e.size);
      return e.packed ? lzssDecompress(raw, 0, e.orig).data : raw;
    },
  });
}
