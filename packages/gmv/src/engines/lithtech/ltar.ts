// Архивы LithTech Jupiter EX (F.E.A.R., F.E.A.R. 2/3, F.E.A.R. Online): *.Arch00 / *.Arch01, сигнатура «LTAR», версия 3.
// Заголовок 48 байт: «LTAR», u32 версия, u32 размер таблицы имён, u32 число папок, u32 число файлов, 3×u32, 16 байт (хэш).
// Затем таблица имён (строки с нулём, выровнены по 4), записи файлов по 32 байта
// [u32 имя, u64 смещение, u64 размер в архиве, u64 размер, u32 сжатие] и записи папок по 16 байт
// [u32 имя (полный путь), u32 первая вложенная, u32 следующая соседняя, u32 число файлов]. Файлы идут подряд по папкам
// в порядке записей папок. Сжатие (не 0) — zlib (в F.E.A.R. Online не встречается: все 25 тыс. файлов без сжатия).
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface LtarEntry extends ArchiveEntry { off: number; packed: number; size: number; comp: number }

export interface LtarIndex { version: number; files: Array<{ path: string; off: number; packed: number; size: number; comp: number }> }

/** Разобрать индекс (первые байты архива до конца записей папок). */
export function parseLtarIndex(u: Uint8Array): LtarIndex {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 48 || u[0] !== 0x4c || u[1] !== 0x54 || u[2] !== 0x41 || u[3] !== 0x52) throw new Error('Не архив LithTech (нет «LTAR»)');
  const version = dv.getUint32(4, true), nsz = dv.getUint32(8, true), ndir = dv.getUint32(12, true), nfile = dv.getUint32(16, true);
  if (version !== 3) throw new Error(`LTAR версии ${version} не поддерживается (известна 3)`);
  const names = 48, filesAt = names + nsz, dirsAt = filesAt + nfile * 32;
  if (dirsAt + ndir * 16 > u.length) throw new Error('Индекс LTAR обрезан');
  const name = (o: number) => { let s = ''; for (let k = names + o; k < filesAt && u[k]; k++) s += String.fromCharCode(u[k]!); return s; };
  const raw = Array.from({ length: nfile }, (_, i) => {
    const p = filesAt + i * 32;
    return { name: name(dv.getUint32(p, true)), off: Number(dv.getBigUint64(p + 4, true)), packed: Number(dv.getBigUint64(p + 12, true)), size: Number(dv.getBigUint64(p + 20, true)), comp: dv.getUint32(p + 28, true) };
  });
  const files: LtarIndex['files'] = [];
  let k = 0;
  for (let d = 0; d < ndir; d++) {
    const p = dirsAt + d * 16, dir = name(dv.getUint32(p, true)), cnt = dv.getUint32(p + 12, true);
    for (const f of raw.slice(k, k + cnt)) files.push({ path: normPath(dir ? `${dir}/${f.name}` : f.name), off: f.off, packed: f.packed, size: f.size, comp: f.comp });
    k += cnt;
  }
  return { version, files };
}

async function inflate(u: Uint8Array, size: number): Promise<Uint8Array> {
  const s = new Blob([u as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  const out = new Uint8Array(await new Response(s).arrayBuffer());
  if (out.length !== size) throw new Error(`LTAR: распаковано ${out.length} из ${size} байт`);
  return out;
}

export async function openLtar(file: BlobFile): Promise<Archive> {
  const head = await readRange(file, 0, 48), dv = new DataView(head.buffer, head.byteOffset, 48);
  const need = 48 + dv.getUint32(8, true) + dv.getUint32(16, true) * 32 + dv.getUint32(12, true) * 16;
  const idx = parseLtarIndex(await readRange(file, 0, need));
  const entries: LtarEntry[] = idx.files.filter((f) => !f.path.endsWith('.crc')).map((f) => ({ path: f.path, size: f.size, off: f.off, packed: f.packed, comp: f.comp }));
  return createArchive<LtarEntry>({
    name: file.name,
    kind: 'ltar',
    version: idx.version,
    entries,
    async read(e) {
      const u = await readRange(file, e.off, e.off + e.packed);
      return e.comp ? inflate(u, e.size) : u;
    },
  });
}
