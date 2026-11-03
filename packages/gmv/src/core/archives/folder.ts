// «Папка игры»: loose-файлы выбранной папки как виртуальный архив (поиск по суффиксу пути, без чтения содержимого).
import { stripExt } from '../binary';
import type { Archive, ArchiveEntry, BlobFile } from '../types';
import { createArchive, TEXTURE_RE } from './common';

interface FolderEntry extends ArchiveEntry { src: BlobFile }

const relPath = (f: BlobFile): string => (f.webkitRelativePath || f.name).replace(/\\/g, '/');

/** Индекс папки: пути, полные и по суффиксам (собирается кусками — см. openFolderAsync). */
class FolderIndex {
  entries: FolderEntry[] = []; full = new Map<string, FolderEntry>(); byBase = new Map<string, FolderEntry>(); bySuffix = new Map<string, FolderEntry>(); root = '';
  add(f: BlobFile): void {
    const rel = relPath(f), path = rel.toLowerCase();
    if (!this.root && rel.includes('/')) this.root = rel.split('/')[0]!;
    const e: FolderEntry = { path, size: f.size, src: f };
    this.entries.push(e);
    if (!this.full.has(path)) this.full.set(path, e);
    const sp = path.split('/'), base = sp[sp.length - 1]!;
    if (!this.byBase.has(base)) this.byBase.set(base, e);
    for (let i = 0; i < sp.length; i++) { const k = sp.slice(i).join('/'); if (!this.bySuffix.has(k)) this.bySuffix.set(k, e); }
  }
  archive(): Archive {
    const { full, bySuffix } = this;
    return createArchive<FolderEntry>({
      name: this.root || 'папка',
      kind: 'folder',
      version: 0,
      entries: this.entries,
      byBase: this.byBase,
      lookup: (p) => full.get(p) ?? bySuffix.get(p) ?? null,
      read: async (e) => new Uint8Array(await e.src.arrayBuffer()),
      fileBytes: (e) => e.src.arrayBuffer(),
      blobOf: (e) => e.src,
      displayName: (e) => e.src.name,
      keepFirstTextureKey: true,
      // ключи по всем суффиксам пути: a/b/c, b/c, c — без привязки к корню папки
      textureKeys: (e) => {
        const parts = stripExt(e.path).split('/');
        return TEXTURE_RE.test(e.path) ? parts.map((_, i) => parts.slice(i).join('/')) : [];
      },
    });
  }
}

export function openFolder(files: readonly BlobFile[]): Archive {
  const ix = new FolderIndex();
  for (const f of files) ix.add(f);
  return ix.archive();
}

/** То же, но кусками по chunk файлов с передачей управления браузеру (большие папки игр — сотни тысяч файлов). */
export async function openFolderAsync(files: readonly BlobFile[], onProgress?: (done: number, total: number) => void, chunk = 5000): Promise<Archive> {
  const ix = new FolderIndex();
  for (let i = 0; i < files.length; i += chunk) {
    onProgress?.(i, files.length);
    await new Promise((r) => setTimeout(r, 0));
    for (let k = i; k < Math.min(files.length, i + chunk); k++) ix.add(files[k]!);
  }
  onProgress?.(files.length, files.length);
  await new Promise((r) => setTimeout(r, 0));
  return ix.archive();
}
