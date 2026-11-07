// Архивы Enfusion (Arma Reforger, DayZ 1.x): IFF «FORM» (размер big-endian) + «PAC1», чанки HEAD (28 байт), DATA (данные
// файлов), FILE — дерево: запись {u8 тип (0 папка, 1 файл), u8 длина имени, имя}; у папки u32 число детей, у файла
// {u32 смещение в .pak, u32 размер в архиве, u32 исходный размер, u32, u16, u8 сжатие (1 — zlib), u8 уровень, u32 время}.
// Читаются только заголовок и дерево (у 2-гигабайтных .pak дерево — в конце файла).
import { createArchive, readRange } from '../../core/archives/common';
import { inflateZlib } from '../../core/codecs/zlib';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

export interface PakEntry extends ArchiveEntry { off: number; csize: number; usize: number; zlib: boolean; file: BlobFile }

const tag = (u: Uint8Array, p: number) => String.fromCharCode(u[p]!, u[p + 1]!, u[p + 2]!, u[p + 3]!);
const be32 = (u: Uint8Array, p: number) => ((u[p]! << 24) | (u[p + 1]! << 16) | (u[p + 2]! << 8) | u[p + 3]!) >>> 0;

/** Путь ресурса Enfusion → ключ записи: без «{GUID}», прямые косые, нижний регистр. */
export const enfusionPath = (ref: string): string => ref.replace(/^\{[0-9A-Fa-f]{16}\}/, '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

export const isEnfusionPak = (h: Uint8Array): boolean => h.length >= 12 && tag(h, 0) === 'FORM' && tag(h, 8) === 'PAC1';

/** Дерево FILE → записи (пути как в игре, в нижнем регистре для поиска). */
export function parsePakTree(b: Uint8Array, file: BlobFile): PakEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out: PakEntry[] = [], dec = new TextDecoder();
  let p = 0;
  const walk = (prefix: string, depth: number): void => {
    if (p + 2 > b.length || depth > 64) throw new Error('PAK: дерево FILE повреждено');
    const type = b[p]!, n = b[p + 1]!, name = dec.decode(b.subarray(p + 2, p + 2 + n));
    p += 2 + n;
    if (type === 0) {
      const count = dv.getUint32(p, true); p += 4;
      const dir = name ? `${prefix}${name}/` : prefix;
      for (let i = 0; i < count; i++) walk(dir, depth + 1);
    } else {
      const off = dv.getUint32(p, true), csize = dv.getUint32(p + 4, true), usize = dv.getUint32(p + 8, true), zlib = b[p + 18] !== 0;
      p += 24;
      out.push({ path: (prefix + name).toLowerCase(), size: usize, off, csize, usize, zlib, file });
    }
  };
  walk('', 0);
  return out;
}

export async function readPakEntry(e: PakEntry): Promise<Uint8Array> {
  const raw = await readRange(e.file, e.off, e.off + e.csize);
  if (!e.zlib) return raw;
  const u = await inflateZlib(raw);
  return u.length === e.usize ? u : u.subarray(0, e.usize);
}

/** Начало записи (n байт) — без чтения целиком, если запись не сжата; сжатая читается полностью. */
export async function readPakHead(e: PakEntry, n: number): Promise<Uint8Array> {
  if (e.zlib || e.csize <= n) return readPakEntry(e);
  return readRange(e.file, e.off, e.off + n);
}

/**
 * Начало ресурса по пути: сначала first байт, по ним need() говорит, сколько нужно всего (null — весь файл).
 * Сжатые записи и ресурсы не из .pak читаются целиком через fallback.
 */
export async function readPakPrefix(archives: readonly Archive[], path: string, first: number, need: (head: Uint8Array) => number | null, fallback: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
  const key = enfusionPath(path);
  for (const a of archives) {
    if (a.kind !== 'enfusion-pak') continue;
    const e = a.lookup(key) as PakEntry | null;
    if (!e) continue;
    if (e.zlib) return readPakEntry(e);
    const head = await readRange(e.file, e.off, e.off + Math.min(e.csize, first));
    const n = need(head);
    if (n === null || n >= e.csize) return head.length >= e.csize ? head : readPakEntry(e);
    return n <= head.length ? head.subarray(0, n) : readRange(e.file, e.off, e.off + n);
  }
  return fallback();
}

export async function openEnfusionPak(file: BlobFile): Promise<Archive> {
  const head = await readRange(file, 0, 12);
  if (!isEnfusionPak(head)) throw new Error('Не архив Enfusion (нет FORM/PAC1)');
  let p = 12, tree: Uint8Array | null = null;
  while (p + 8 <= file.size) {
    const h = await readRange(file, p, p + 8), t = tag(h, 0), size = be32(h, 4);
    if (t === 'FILE') { tree = await readRange(file, p + 8, p + 8 + size); break; }
    p += 8 + size;
  }
  if (!tree) throw new Error(`${file.name}: в архиве нет оглавления FILE`);
  const entries = parsePakTree(tree, file), byPath = new Map(entries.map((e) => [e.path, e]));
  return createArchive<PakEntry>({
    name: file.name, kind: 'enfusion-pak', version: 1, entries,
    read: readPakEntry,
    // ссылки ресурсов: «{GUID}Assets/…» — без GUID, без учёта регистра
    lookup: (path) => byPath.get(enfusionPath(path)) ?? null,
  });
}
