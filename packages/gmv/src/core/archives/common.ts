// Общая обвязка архива: индексы путей и текстур, «файл-подобные» объекты записей.
import { baseName, stripExt, toArrayBuffer } from '../binary';
import type { Archive, ArchiveEntry, BlobFile, VFile } from '../types';

/** Расширения, по которым запись попадает в индекс текстур (путь без расширения). */
export const TEXTURE_RE = /\.(dds|tga|png|jpe?g|pcx|bmp|webp|paa|pac|pct|tex|xbt)$/;

export interface ArchiveSpec<E extends ArchiveEntry> {
  name: string;
  kind: string;
  version: number;
  entries: E[];
  read(entry: E): Promise<Uint8Array>;
  /** Своя функция поиска (например, по суффиксу пути). */
  lookup?(path: string): E | null;
  byBase?: Map<string, E>;
  /** Дополнительные ключи текстур (по умолчанию — полный путь без расширения). */
  textureKeys?(entry: E): string[];
  /** Имя файла для показа (по умолчанию — последний сегмент пути). */
  displayName?(entry: E): string;
  /** При повторе ключа текстуры оставлять первую запись (по умолчанию — последнюю, как в архивах игр). */
  keepFirstTextureKey?: boolean;
  /** Своё содержимое файла (без копии через read). */
  fileBytes?(entry: E): Promise<ArrayBuffer>;
  /** Исходный файл записи (папка). */
  blobOf?(entry: E): BlobFile | null;
  /** Текстура по точному пути, которой нет в списке записей. */
  findTexture?(path: string): E | null;
}

export function createArchive<E extends ArchiveEntry>(spec: ArchiveSpec<E>): Archive {
  const index = new Map<string, ArchiveEntry>(), byKey = new Map<string, ArchiveEntry>(), files = new Map<ArchiveEntry, VFile>();
  for (const e of spec.entries) {
    index.set(e.path, e); // повторный путь (моды, дописанные архивы): побеждает последняя запись
    if (TEXTURE_RE.test(e.path)) {
      for (const k of spec.textureKeys ? spec.textureKeys(e) : [stripExt(e.path)]) if (!spec.keepFirstTextureKey || !byKey.has(k)) byKey.set(k, e);
    }
  }
  const arch: Archive = {
    name: spec.name,
    kind: spec.kind,
    version: spec.version,
    entries: spec.entries,
    index,
    byKey,
    byBase: spec.byBase,
    lookup: (p) => (spec.lookup ? spec.lookup(p) : (index.get(p) as E | undefined) ?? null),
    read: (e) => spec.read(e as E),
    blobOf: spec.blobOf ? (e) => spec.blobOf!(e as E) : undefined,
    findTexture: spec.findTexture ? (p) => spec.findTexture!(p) : undefined,
    fileOf(e) {
      let f = files.get(e);
      if (!f) {
        f = {
          name: spec.displayName ? spec.displayName(e as E) : baseName(e.path),
          path: e.path,
          archive: arch,
          arrayBuffer: spec.fileBytes ? () => spec.fileBytes!(e as E) : async () => toArrayBuffer(await spec.read(e as E)),
        };
        files.set(e, f);
      }
      return f;
    },
  };
  return arch;
}

/** Прочитать диапазон байт файла. */
export const readRange = async (file: Blob, start: number, end: number): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(start, end).arrayBuffer());
