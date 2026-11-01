// Архивы 4A Engine (Metro 2033, 2010): индекс content.vfi + данные *.vfs0/1.
// .vfi — цепочка чанков [id u32, размер u32]: −1 — заголовок (GUID), 0..N — архивы. Внутри архива: 0 — имя файла .vfs и его размер,
// 1 — записи файлов [ключ u32, смещение, размер, сжатый размер, длина имени, имя XOR (младший байт ключа), 0], 2 — служебное.
// Сжатые файлы — цепочка блоков QuickLZ (уровень 3).
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import { quicklzDecompress } from '../../core/codecs/quicklz';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface VfsEntry extends ArchiveEntry { vfs: string; off: number; size: number; packed: number }

export function parseVfi(u: Uint8Array): Array<{ vfs: string; vfsSize: number; files: Array<{ path: string; off: number; size: number; packed: number }> }> {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out: ReturnType<typeof parseVfi> = [];
  let p = 0;
  while (p + 8 <= u.length) {
    const id = dv.getUint32(p, true), size = dv.getUint32(p + 8 - 4, true), body = p + 8;
    p = body + size;
    if (id === 0xffffffff) continue;
    const arc = { vfs: '', vfsSize: 0, files: [] as Array<{ path: string; off: number; size: number; packed: number }> };
    for (let q = body; q + 8 <= body + size;) {
      const sid = dv.getUint32(q, true), ss = dv.getUint32(q + 4, true), b = q + 8;
      q = b + ss;
      if (sid === 0) { let s = ''; for (let k = b; k < b + ss - 4 && u[k]; k++) s += String.fromCharCode(u[k]!); arc.vfs = s; arc.vfsSize = dv.getUint32(b + ss - 4, true); }
      else if (sid === 1) {
        for (let r = b; r + 20 <= b + ss;) {
          const key = u[r]!, off = dv.getUint32(r + 4, true), fsize = dv.getUint32(r + 8, true), packed = dv.getUint32(r + 12, true), nl = dv.getUint32(r + 16, true);
          let name = '';
          for (let k = 0; k < nl - 1; k++) name += String.fromCharCode(u[r + 20 + k]! ^ key);
          arc.files.push({ path: name, off, size: fsize, packed });
          r += 20 + nl;
        }
      }
    }
    out.push(arc);
  }
  return out;
}

/** Открыть content.vfi; файлы .vfs ищутся среди выбранных вместе с ним (или в той же папке). */
export async function openVfi(file: BlobFile, siblings: readonly BlobFile[]): Promise<Archive> {
  const arcs = parseVfi(await readRange(file, 0, file.size));
  const byName = new Map(siblings.map((f) => [f.name.toLowerCase(), f]));
  const entries: VfsEntry[] = [], missing: string[] = [];
  for (const a of arcs) {
    if (!byName.has(a.vfs.toLowerCase())) { missing.push(a.vfs); continue; }
    for (const f of a.files) if (f.size || f.packed) entries.push({ path: normPath(f.path.replace(/^content\\/i, '')), size: f.size, vfs: a.vfs.toLowerCase(), off: f.off, packed: f.packed });
  }
  if (!entries.length) throw new Error(`${file.name}: не найдены файлы данных ${missing.join(', ')} — выберите их вместе с .vfi (или папку игры)`);
  return createArchive<VfsEntry>({
    name: file.name,
    kind: 'metro-vfi',
    version: 2033,
    entries,
    async read(e) {
      const vfs = byName.get(e.vfs)!, u = await readRange(vfs, e.off, e.off + e.packed);
      return e.packed === e.size ? u : quicklzDecompress(u, e.size);
    },
  });
}
