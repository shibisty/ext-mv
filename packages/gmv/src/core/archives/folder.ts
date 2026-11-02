// «Папка игры»: loose-файлы выбранной папки как виртуальный архив (поиск по суффиксу пути, без чтения содержимого).
import { stripExt } from '../binary';
import type { Archive, ArchiveEntry, BlobFile } from '../types';
import { createArchive, TEXTURE_RE } from './common';

interface FolderEntry extends ArchiveEntry { src: BlobFile }

const relPath = (f: BlobFile): string => (f.webkitRelativePath || f.name).replace(/\\/g, '/');

export function openFolder(files: readonly BlobFile[]): Archive {
  const entries: FolderEntry[] = [], full = new Map<string, FolderEntry>(), byBase = new Map<string, FolderEntry>(), bySuffix = new Map<string, FolderEntry>();
  let root = '';
  for (const f of files) {
    const rel = relPath(f), path = rel.toLowerCase();
    if (!root && rel.includes('/')) root = rel.split('/')[0]!;
    const e: FolderEntry = { path, size: f.size, src: f };
    entries.push(e);
    if (!full.has(path)) full.set(path, e);
    const sp = path.split('/'), base = sp[sp.length - 1]!;
    if (!byBase.has(base)) byBase.set(base, e);
    for (let i = 0; i < sp.length; i++) { const k = sp.slice(i).join('/'); if (!bySuffix.has(k)) bySuffix.set(k, e); }
  }
  return createArchive<FolderEntry>({
    name: root || 'папка',
    kind: 'folder',
    version: 0,
    entries,
    byBase,
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
