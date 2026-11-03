// Архивы X-Ray (.db, .db0…, .xdb): Чистое небо, Зов Припяти и моды. Файл — цепочка чанков [id u32, размер u32]:
// 0x29A — текстовый [header] (ЧН/ЗП), 0 — данные, 1 — таблица файлов (флаг 0x80000000 — сжата LZHUF).
// Запись таблицы: u16 длина, затем размер, сжатый размер, CRC, имя (без нуля), смещение в архиве.
// Сжатые файлы (размер ≠ сжатому) — LZO1X. Тень Чернобыля шифрует таблицу файлов — такие архивы не открываются.
import { normPath } from '../../core/binary';
import { createArchive, readRange } from '../../core/archives/common';
import { lzhufDecompress } from '../../core/codecs/lzhuf';
import { lzo1xDecompress } from '../../core/codecs/lzo';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';
import type { SocKey } from './soc-key';

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

/** Ключи «Тени Чернобыля», найденные в исполняемых файлах пользователя (по имени и размеру файла), — на время работы страницы. */
const socKeys = new Map<string, SocKey>();
/**
 * Найденные ключи хранятся и в localStorage страницы (только на компьютере пользователя): после того как ключ один раз
 * найден в его XR_3DA.exe, архивы ТЧ открываются и без exe. В сборку расширения ключи не попадают.
 */
const STORE = 'gmv.xray.socKeys';
function loadStored(): void {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(STORE) ?? '[]') as Array<[string, SocKey]>;
    for (const [id, k] of list) if (k && Number.isFinite(k.tableSeed) && Number.isFinite(k.encryptSeed) && Number.isFinite(k.iterations)) socKeys.set(id, k);
  } catch { /* хранилище недоступно — ключи только на время работы страницы */ }
}
function saveStored(): void {
  try { globalThis.localStorage?.setItem(STORE, JSON.stringify([...socKeys])); } catch { /* недоступно */ }
}
let storedLoaded = false;
/** Забыть найденные ключи, в том числе сохранённые (тесты, «сброс»). */
export const resetSocKeys = (): void => { socKeys.clear(); storedLoaded = true; try { globalThis.localStorage?.removeItem(STORE); } catch { /* недоступно */ } };

/** Разобрать таблицу: записи есть и лежат внутри архива. */
function tableEntries(table: Uint8Array, fileSize: number): DbEntry[] | null {
  try { const e = parseDbTable(table); return e.length && !e.some((x) => x.off + x.packed > fileSize) ? e : null; } catch { return null; }
}

export async function openXrayDb(file: BlobFile, siblings: readonly BlobFile[] = []): Promise<Archive> {
  const tab = await findTable(file);
  if (!tab) throw new Error(`${file.name}: не архив X-Ray (нет таблицы файлов)`);
  const raw = await readRange(file, tab.off, tab.off + tab.size);
  let entries: DbEntry[] | null = null;
  try { entries = tableEntries(tab.id & COMPRESSED ? lzhufDecompress(raw) : raw, file.size); } catch { entries = null; }
  if (!entries && tab.id & COMPRESSED) {
    // «Тень Чернобыля»: таблица зашифрована — ключ ищется в XR_3DA.exe, выбранном вместе с архивами (или в папке игры)
    const { findSocKey, socDecode } = await import('./soc-key');
    const check = (t: Uint8Array) => !!tableEntries(t, file.size);
    if (!storedLoaded) { storedLoaded = true; loadStored(); }
    for (const key of socKeys.values()) {
      try { entries = tableEntries(lzhufDecompress(socDecode(key, raw)), file.size); } catch { entries = null; }
      if (entries) break;
    }
    const exes = siblings.filter((f) => /\.exe$/i.test(f.name)).sort((a, b) => +!/xr_3da/i.test(a.name) - +!/xr_3da/i.test(b.name));
    const tried: string[] = [];
    for (const exe of entries ? [] : exes) {
      const id = `${exe.name}:${exe.size}`;
      if (socKeys.has(id)) continue;
      let key: SocKey | null = null;
      try { key = findSocKey(new Uint8Array(await exe.arrayBuffer()), raw, check); }
      catch (e) { tried.push(`${exe.webkitRelativePath || exe.name}: ${(e as Error).message}`); continue; }
      if (!key) { tried.push(`${exe.webkitRelativePath || exe.name} (${exe.size} Б) — ключ не найден`); continue; }
      socKeys.set(id, key);
      saveStored();
      entries = tableEntries(lzhufDecompress(socDecode(key, raw)), file.size);
      if (entries) break;
    }
    if (!entries)
      throw new Error(`${file.name}: таблица файлов зашифрована (архивы «Тени Чернобыля»). Откройте папку игры целиком («Папка игры…») или выберите кнопкой «Открыть .db…» сначала bin\\XR_3DA.exe, затем архивы — ключ берётся из него. ${tried.length ? `Проверены: ${tried.join('; ')}.` : `Исполняемых файлов игры среди выбранных нет (выбрано файлов: ${siblings.length}).`}`);
  }
  if (!entries) throw new Error(`${file.name}: таблица файлов повреждена.`);
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
