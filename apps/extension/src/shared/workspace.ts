// Открытые ресурсы, общие для страниц расширения: попап, боковая панель и вкладка просмотрщика продолжают с того же места.
// Хранится в IndexedDB расширения (общей для всех его страниц):
//  - дескрипторы файлов и папок (File System Access, Chromium) — без копирования, при открытии в другой странице браузер
//    может попросить подтвердить доступ;
//  - иначе (Firefox, выбор через <input>) — копии File, пока их суммарный размер не больше COPY_LIMIT.
import type { ArchiveItem, BlobFile, ViewerSession } from '@gmvjs/core';

export type Source =
  | { kind: 'file'; file: File }
  | { kind: 'handle'; handle: FileSystemFileHandle }
  | { kind: 'dir'; handle: FileSystemDirectoryHandle }
  | { kind: 'folder'; name: string; files: File[] };

export interface Workspace {
  at: number;
  /** Игра; auto — выбирать её по файлу. */
  preset: string;
  auto: boolean;
  sources: Source[];
  /** Что не сохранилось (слишком большое для копии): имена для подсказки. */
  skipped: string[];
  /** Открытая модель из архива или папки: архив по имени и путь внутри. */
  open?: { archive: string; path: string };
}

/** Сколько байт копий File держать (у дескрипторов предела нет). */
export const COPY_LIMIT = 64 * 1024 * 1024;
/** Сколько хранить: дольше — начинать с чистого окна. */
export const MAX_AGE = 24 * 3600_000;

const DB = 'gmv-workspace', STORE = 'state', KEY = 'last';

function openDb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((ok, fail) => {
    const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); ok(req.result); };
    t.onerror = t.onabort = () => { db.close(); fail(t.error); };
  }));
}

export async function loadWorkspace(): Promise<Workspace | null> {
  const w = await tx<Workspace | undefined>('readonly', (s) => s.get(KEY));
  return w && Date.now() - w.at < MAX_AGE && w.sources?.length ? w : null;
}
export const saveWorkspace = (w: Workspace): Promise<unknown> => tx('readwrite', (s) => s.put({ ...w, at: Date.now() }, KEY));
export const clearWorkspace = (): Promise<unknown> => tx('readwrite', (s) => s.delete(KEY));

export const sourceName = (s: Source): string => (s.kind === 'file' ? s.file.name : s.kind === 'folder' ? s.name : s.handle.name);

/**
 * Добавить источники к рабочему набору: одинаковые имена заменяются, копии File — пока помещаются в COPY_LIMIT.
 * Возвращает новый список и имена того, что не поместилось.
 */
export function mergeSources(old: readonly Source[], add: readonly Source[]): { sources: Source[]; skipped: string[] } {
  const byName = new Map<string, Source>();
  for (const s of [...old, ...add]) byName.set(sourceName(s), s);
  const sources: Source[] = [], skipped: string[] = [];
  let copied = 0;
  for (const s of byName.values()) {
    const size = s.kind === 'file' ? s.file.size : s.kind === 'folder' ? s.files.reduce((a, f) => a + f.size, 0) : 0;
    if (copied + size > COPY_LIMIT) { skipped.push(sourceName(s)); continue; }
    copied += size;
    sources.push(s);
  }
  return { sources, skipped };
}

// ---------- доступ к дескрипторам ----------
type Perm = { queryPermission?(o: { mode: 'read' }): Promise<PermissionState>; requestPermission?(o: { mode: 'read' }): Promise<PermissionState> };
const handlesOf = (w: Workspace): Array<FileSystemHandle & Perm> =>
  w.sources.flatMap((s) => (s.kind === 'handle' || s.kind === 'dir' ? [s.handle as FileSystemHandle & Perm] : []));

/** Нужно ли подтверждение доступа (браузер забыл разрешение на файлы или папки). */
export async function needsAccess(w: Workspace): Promise<boolean> {
  for (const h of handlesOf(w)) if ((await h.queryPermission?.({ mode: 'read' })) !== 'granted') return true;
  return false;
}
/** Попросить доступ ко всем дескрипторам — только из обработчика щелчка. */
export async function requestAccess(w: Workspace): Promise<boolean> {
  let ok = true;
  for (const h of handlesOf(w)) if ((await h.requestPermission?.({ mode: 'read' })) !== 'granted') ok = false;
  return ok;
}

const withPath = (f: File, path: string): BlobFile => {
  try { Object.defineProperty(f, 'webkitRelativePath', { value: path, configurable: true }); } catch { /* только чтение */ }
  return f;
};
async function walkDir(dir: FileSystemDirectoryHandle, prefix: string, out: BlobFile[], onCount?: (n: number) => void): Promise<void> {
  for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (h.kind === 'file') {
      out.push(withPath(await (h as FileSystemFileHandle).getFile(), prefix + h.name));
      if (onCount && out.length % 500 === 0) onCount(out.length);
    } else await walkDir(h as FileSystemDirectoryHandle, prefix + h.name + '/', out, onCount);
  }
}

/** Файлы и папки рабочего набора, готовые для сессии. */
export async function materialize(w: Workspace, onCount?: (n: number) => void): Promise<{ files: File[]; folders: BlobFile[][] }> {
  const files: File[] = [], folders: BlobFile[][] = [];
  for (const s of w.sources) {
    if (s.kind === 'file') files.push(s.file);
    else if (s.kind === 'handle') files.push(await s.handle.getFile());
    else if (s.kind === 'folder') folders.push(s.files);
    else { const list: BlobFile[] = []; await walkDir(s.handle, s.handle.name + '/', list, onCount); folders.push(list); }
  }
  return { files, folders };
}

/** Модель из папки или архива, открытая последней: найти её среди архивов сессии. */
export function findOpen(session: ViewerSession, open: Workspace['open']): ArchiveItem | null {
  if (!open) return null;
  for (const archive of session.archives) {
    if (archive.name !== open.archive) continue;
    const entry = archive.lookup(open.path);
    if (entry) return { archive, entry };
  }
  return null;
}

// ---------- явная передача в другую страницу ----------
// localStorage общий для страниц расширения и пишется синхронно: успевает до закрытия попапа
const HANDOFF_KEY = 'gmv-handoff';
export function markHandoff(to: 'side' | 'tab'): void {
  try { localStorage.setItem(HANDOFF_KEY, JSON.stringify({ to, at: Date.now() })); } catch { /* приватный режим */ }
}
/** Была ли только что передача в эту страницу (флаг снимается). */
export function takeHandoff(to: 'side' | 'tab'): boolean {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY);
    if (!raw) return false;
    const h = JSON.parse(raw) as { to: string; at: number };
    if (h.to !== to) return false;
    localStorage.removeItem(HANDOFF_KEY);
    return Date.now() - h.at < 60_000;
  } catch { return false; }
}

/** Открыть рабочий набор в сессии: игра, папки, файлы, затем модель из архива, если открыта была она. */
export async function restoreInto(session: ViewerSession, w: Workspace, onCount?: (n: number) => void): Promise<{ files: File[] }> {
  if (session.registry.game(w.preset)) session.setPreset(w.preset);
  const { files, folders } = await materialize(w, onCount);
  for (const list of folders) {
    const a = await session.addFolderAsync(list);
    await session.openFolderArchives(a);
  }
  if (files.length) await session.addFiles(files);
  const item = findOpen(session, w.open);
  if (item) await session.openEntry(item);
  return { files };
}
