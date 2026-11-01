// Архивы X-Ray (.db, .db0…, .xdb): Чистое небо, Зов Припяти и моды. Файл — цепочка чанков [id u32, размер u32]:
// 0x29A — текстовый [header] (ЧН/ЗП), 0 — данные, 1 — таблица файлов (флаг 0x80000000 — сжата LZHUF).
// Запись таблицы: u16 длина, затем размер, сжатый размер, CRC, имя (без нуля), смещение в архиве.
// Сжатые файлы (размер ≠ сжатому) — LZO1X. Тень Чернобыля шифрует таблицу файлов — такие архивы не открываются.
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import { lzhufDecompress } from '../../core/codecs/lzhuf';
import { lzo1xDecompress } from '../../core/codecs/lzo';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface DbEntry extends ArchiveEntry { off: number; real: number; packed: number }

const CHUNK_HEADER = 1, COMPRESSED = 0x80000000;

/** Найти чанк таблицы файлов, пробегая заголовки чанков. */
async function findTable(file: BlobFile): Promise<{ id: number; off: number; size: number } | null> {
  let p = 0;
  for (let n = 0; n < 64 && p + 8 <= file.size; n++) {
    const h = await readRange(file, p, p + 8), dv = new DataView(h.buffer, h.byteOffset, 8);
    const id = dv.getUint32(0, true), size = dv.getUint32(4, true);
    if (p + 8 + size > file.size) return null;
    if ((id & ~COMPRESSED) >>> 0 === CHUNK_HEADER) return { id, off: p + 8, size };
    p += 8 + size;
  }
  return null;
}

/** Разбор таблицы файлов (распакованной). */
export function parseDbTable(t: Uint8Array): DbEntry[] {
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength), out: DbEntry[] = [];
  let q = 0;
  while (q + 2 <= t.length) {
    const bs = dv.getUint16(q, true);
    if (bs < 16 || q + 2 + bs > t.length) throw new Error(`таблица файлов повреждена (смещение ${q})`);
    const real = dv.getUint32(q + 2, true), packed = dv.getUint32(q + 6, true);
    let name = '';
    for (let k = q + 14; k < q + 2 + bs - 4; k++) name += String.fromCharCode(t[k]!);
    const off = dv.getUint32(q + 2 + bs - 4, true);
    q += 2 + bs;
    if (!real && !packed) continue; // папка
    out.push({ path: normPath(name), size: real, off, real, packed });
  }
  return out;
}

export async function openXrayDb(file: BlobFile): Promise<Archive> {
  const tab = await findTable(file);
  if (!tab) throw new Error(`${file.name}: не архив X-Ray (нет таблицы файлов)`);
  const raw = await readRange(file, tab.off, tab.off + tab.size);
  let table: Uint8Array;
  try { table = tab.id & COMPRESSED ? lzhufDecompress(raw) : raw; } catch { table = new Uint8Array(0); }
  let entries: DbEntry[] = [];
  try { entries = parseDbTable(table); } catch { entries = []; }
  if (!entries.length || entries.some((e) => e.off + e.packed > file.size))
    throw new Error(`${file.name}: таблица файлов зашифрована (архивы «Тени Чернобыля») или повреждена. Откройте распакованную папку gamedata.`);
  return createArchive<DbEntry>({
    name: file.name,
    kind: 'xray-db',
    version: 0,
    entries,
    async read(e) {
      const u = await readRange(file, e.off, e.off + e.packed);
      if (e.packed === e.real) return u;
      const out = new Uint8Array(e.real);
      lzo1xDecompress(u, 0, out);
      return out;
    },
  });
}
