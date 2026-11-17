// Перетаскивание: файлы и папки (рекурсивный обход через webkitGetAsEntry, путь сохраняется в webkitRelativePath).
import type { BlobFile } from '@gmvjs/core';

export interface DropResult {
  /** Отдельные файлы. */
  files: File[];
  /** Содержимое брошенных папок (одна запись на папку). */
  folders: BlobFile[][];
  /**
   * Дескрипторы брошенного (File System Access, только Chromium): по ним файлы и папки открываются снова
   * в другой странице расширения без копирования. Пусто, если браузер их не даёт.
   */
  handles: FileSystemHandle[];
}

type HandleItem = DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> };

const withPath = (f: File, path: string): BlobFile => {
  try { Object.defineProperty(f, 'webkitRelativePath', { value: path, configurable: true }); } catch { /* только чтение — оставим имя */ }
  return f;
};

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((ok, fail) => {
    const out: FileSystemEntry[] = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) ok(out); else { out.push(...batch); next(); } }, fail);
    next();
  });
}

async function walk(entry: FileSystemEntry, prefix: string, out: BlobFile[], onCount?: (n: number) => void): Promise<void> {
  if (entry.isFile) {
    const f = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    out.push(withPath(f, prefix + entry.name));
    if (onCount && out.length % 500 === 0) onCount(out.length);
  } else if (entry.isDirectory) {
    for (const e of await readAll((entry as FileSystemDirectoryEntry).createReader())) await walk(e, prefix + entry.name + '/', out, onCount);
  }
}

/** onCount — сколько файлов уже найдено (обход большой папки идёт долго). */
export async function readDrop(dt: DataTransfer, onCount?: (n: number) => void): Promise<DropResult> {
  const files: File[] = [], folders: BlobFile[][] = [];
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file') as HandleItem[];
  // всё, что читает DataTransfer, — синхронно, до первого await: после обработчика drop элементы пустеют
  const handleJobs = items.map((i) => (typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  const plain = Array.from(dt.files);
  const found = await Promise.all(handleJobs);
  const handles = found.every(Boolean) ? (found as FileSystemHandle[]) : [];
  if (!entries.length || entries.some((e) => !e)) return { files: plain, folders, handles };
  for (const e of entries as FileSystemEntry[]) {
    if (e.isDirectory) { const list: BlobFile[] = []; onCount?.(0); await walk(e, '', list, onCount); folders.push(list); }
    else files.push(await new Promise<File>((ok, fail) => (e as FileSystemFileEntry).file(ok, fail)));
  }
  return { files, folders, handles };
}

/** Подписать окно на перетаскивание с подсветкой зоны. */
export function attachDrop(target: Window, overlay: HTMLElement, onDrop: (r: DropResult) => void, onCount?: (n: number) => void): void {
  let depth = 0;
  target.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; overlay.classList.add('on'); });
  target.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.classList.remove('on'); } });
  target.addEventListener('dragover', (e) => e.preventDefault());
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('on');
    if (e.dataTransfer) void readDrop(e.dataTransfer, onCount).then(onDrop);
  });
}
