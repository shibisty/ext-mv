// Архивы Survarium (Vostok Games, движок — наследник X-Ray 2.0): game/resources.NN.db.
// Каждый .db — снимок дерева в памяти: «little-endian», u32 число узлов, u32 размер индекса, по 0x3c0 — указатель на первый узел.
// Узел (указатели — смещения в файле): +0 размер / +8 смещение данных (у папки +8 — первый вложенный), +0x10 цель ссылки,
// +0x30 следующий соседний, +0x48 u16 флаги, u8, имя с нулём. Флаги: 1 — папка, 4 — файл, 0x200 — ссылка на одинаковый файл
// (данные берутся у цели), 0x800 — файл удалён обновлением. Архивы с большим номером — обновления: перекрывают меньшие.
// Модели — папки «*.model» / «*.skinned_model» (render/<часть>/converted_model, settings…); для списка ресурсов
// они добавляются отдельной записью с путём папки.
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

interface DbEntry extends ArchiveEntry { file: BlobFile | null; off: number; size: number }

const DB_RE = /^resources\.(\d+)\.db$/i;
export const MODEL_DIR_RE = /\.(skinned_)?model$/;
/** Содержимое записи-папки модели: метка + путь. */
export const MODEL_MARK = 'VOSTOK-MODEL\n';

export interface DbNode { path: string; flags: number; size: number; off: number }

export function parseDbIndex(u: Uint8Array): DbNode[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (String.fromCharCode(...u.subarray(0, 13)) !== 'little-endian') throw new Error('Не архив Survarium (нет «little-endian»)');
  const Q = (o: number) => Number(dv.getBigUint64(o, true));
  const out: DbNode[] = [];
  const seen = new Set<number>();
  const walk = (start: number, prefix: string, depth: number) => {
    for (let S = start; S; S = Q(S + 0x30)) {
      if (S + 0x4c > u.length || seen.has(S) || depth > 64) throw new Error('Индекс .db повреждён');
      seen.add(S);
      const fl = dv.getUint16(S + 0x48, true);
      let e = S + 0x4b, name = '';
      while (e < u.length && u[e]) name += String.fromCharCode(u[e++]!);
      const path = prefix + name.toLowerCase();
      if (fl & 1) { walk(Q(S + 8), path + '/', depth + 1); continue; }
      let T = S;
      if (fl & 0x200) T = Q(S + 0x10);
      out.push({ path, flags: fl, size: T ? Q(T) : 0, off: T ? Q(T + 8) : 0 });
    }
  };
  walk(Q(0x3c0), '', 0);
  return out;
}

async function readIndex(f: BlobFile): Promise<DbNode[]> {
  const head = await readRange(f, 0, 0x400);
  const isz = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0x14, true);
  return parseDbIndex(await readRange(f, 0, Math.min(f.size, isz + 0x400)));
}

/** Все resources.NN.db одним архивом (обновления поверх основных); открывается по первому из выбранных. */
export async function openVostokDb(file: BlobFile, siblings: readonly BlobFile[]): Promise<Archive | null> {
  const dbs = siblings.filter((f) => DB_RE.test(f.name)).sort((a, b) => +DB_RE.exec(a.name)![1]! - +DB_RE.exec(b.name)![1]!);
  if (!dbs.length) dbs.push(file);
  if (dbs[0] !== file) return null; // остальные .db уже вошли в архив
  const map = new Map<string, DbEntry>();
  for (const f of dbs) {
    for (const n of await readIndex(f)) {
      if (n.flags & 0x800) { map.delete(n.path); continue; }
      map.set(n.path, { path: n.path, size: n.size, file: f, off: n.off });
    }
  }
  const dirs = new Set<string>();
  for (const p of map.keys()) {
    const m = /^(.*?\.(?:skinned_)?model)\//.exec(p);
    if (m) dirs.add(m[1]!);
  }
  for (const d of dirs) if (!map.has(d)) map.set(d, { path: d, size: 0, file: null, off: 0 });
  return createArchive<DbEntry>({
    name: dbs.length > 1 ? `${dbs[0]!.name} … ${dbs[dbs.length - 1]!.name}` : file.name,
    kind: 'vostok-db',
    version: 1,
    entries: [...map.values()],
    async read(e) {
      if (!e.file) return new TextEncoder().encode(MODEL_MARK + e.path);
      return readRange(e.file, e.off, e.off + e.size);
    },
  });
}
