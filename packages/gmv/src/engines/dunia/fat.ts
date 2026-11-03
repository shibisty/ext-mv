// Архивы Dunia (Far Cry 2): пара <имя>.fat (оглавление) + <имя>.dat (данные).
// .fat: «2TAF» (FAT2 в little-endian), u32 версия 5, u32 флаги (платформа/сжатие), u32 число записей, затем по 16 байт:
//   u32 хеш имени, u32 (размер после распаковки << 2 | схема: 0 — без сжатия, 1 — LZO1X),
//   u32 (младшие 2 бита смещения << 30 | размер в .dat), u32 смещение >> 2; в конце u32 0.
// Имён в архиве нет — только хеш: CRC-32 пути в нижнем регистре с обратными косыми («graphics\weapons\…\ak47.xbg»).
// Имена берутся из самой игры: XML-списки зависимостей ресурсов («<root>» с CGeometryResource / CMaterialResource /
// CTextureResource ID="…»), которые лежат в тех же архивах; остальные файлы доступны только по пути из ссылок (lookup).
// Текстура «x.xbt» читается из «x_mip0.xbt», если он есть: там старший уровень (до 1024²) отдельным XBT.
import { lzo1xDecompress } from '../../core/codecs/lzo';
import { crc32 } from '../../core/writers/zip';
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';

export interface FatEntry { hash: number; size: number; scheme: number; csize: number; off: number }

export function parseFat(u: Uint8Array): FatEntry[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 16 || dv.getUint32(0, true) !== 0x46415432) throw new Error('Не архив Dunia (нет «FAT2»)');
  const ver = dv.getUint32(4, true);
  if (ver !== 5) throw new Error(`Архив Dunia версии ${ver} не поддерживается (нужна 5 — Far Cry 2)`);
  const n = dv.getUint32(12, true);
  if (16 + n * 16 > u.length) throw new Error('.fat: оглавление обрезано');
  const out: FatEntry[] = [];
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 16, a = dv.getUint32(o + 4, true), b = dv.getUint32(o + 8, true), c = dv.getUint32(o + 12, true);
    // у несжатых записей (схема 0) размер после распаковки не записан (0) — это размер в .dat
    const scheme = a & 3, csize = b & 0x3fffffff;
    out.push({ hash: dv.getUint32(o, true), size: scheme === 0 ? csize : a >>> 2, scheme, csize, off: c * 4 + (b >>> 30) });
  }
  return out;
}

/** Распаковать запись; head — только первые head байт (для распознавания), без чтения всей записи. */
export async function readFatEntry(dat: BlobFile, e: FatEntry, head = 0): Promise<Uint8Array> {
  if (e.scheme === 0) return readRange(dat, e.off, e.off + (head ? Math.min(head, e.csize) : e.csize));
  if (e.scheme !== 1) throw new Error(`Dunia: схема сжатия ${e.scheme} не поддерживается`);
  if (head) {
    // начало потока LZO: литералы и ссылки назад укладываются в первые байты; распаковка обрывается, начало уже готово
    // буфер с запасом: первая серия литералов длиннее head не помещается в маленький буфер и не копируется вовсе
    // малое начало (распознавание по заголовку) — сначала из 512 байт; если не хватило (первая серия длиннее) — из 2048
    for (const take of head <= 64 ? [512, 2048] : [2048]) {
      const out = new Uint8Array(Math.min(Math.max(head, 1024), e.size));
      try { lzo1xDecompress(await readRange(dat, e.off, e.off + Math.min(e.csize, take)), 0, out); } catch { /* оборван — это ожидаемо */ }
      const r = out.subarray(0, Math.min(head, out.length));
      if (take >= e.csize || r.some((b) => b !== 0)) return r;
    }
    return new Uint8Array(0);
  }
  const out = new Uint8Array(e.size);
  lzo1xDecompress(await readRange(dat, e.off, e.off + e.csize), 0, out);
  return out;
}

/** Хеш имени файла Dunia (FC2): CRC-32 пути в нижнем регистре, разделитель «\». */
export const duniaHash = (path: string): number => crc32(new TextEncoder().encode(path.replace(/\//g, '\\').toLowerCase())) >>> 0;

/** Пути из XML-списков зависимостей (ID="…" и crc_ID). */
export function namesFromResourceXml(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/ID="([^"]+\.[A-Za-z0-9]{2,5})"/g)) out.push(m[1]!);
  return out;
}

interface DuniaEntry extends ArchiveEntry { fe: FatEntry; dat: BlobFile; text?: string }

/** Запись .fat вместе с её .dat. */
export interface FatRef { fe: FatEntry; dat: BlobFile }

/** Мир (уровень): worlds/<имя>/generated/<имя>.game.xml и .sectorsdep.fcb. */
export interface DuniaWorld {
  name: string;
  gameXml: FatRef;
  /** .dat мира и смещение его .sectorsdep.fcb. */
  dat: BlobFile;
  end: number;
  /** Файлы мира без имён (сектора, ландшафт): записи того же .dat между концом предыдущего мира и этим .sectorsdep.fcb. */
  files(): FatRef[];
}
export interface DuniaArchiveApi {
  duniaWorld(name: string): DuniaWorld | null;
  duniaWorlds(): DuniaWorld[];
  /** Все записи .dat по порядку смещений. */
  datRefs(dat: BlobFile): FatRef[];
  readRef(r: FatRef, head?: number): Promise<Uint8Array>;
  /** Запись по хешу имени (ссылки коллекций уровней — хеши путей моделей) и её имя, если известно. */
  refByHash(h: number): FatRef | undefined;
  nameOfHash(h: number): string | undefined;
}

/** Метка виртуального файла уровня (worlds/<мир>/….fc2level): дальше JSON с миром и областью секторов. */
export const LEVEL_MARK = 'DUNIA-LEVEL\n';
export interface LevelSpec { world: string; name: string; x0: number; y0: number; w: number; h: number; terrainOnly?: boolean }

/** Миры Far Cry 2 (одиночная игра, сетевые карты, DLC); дополняются найденными в списках ресурсов. */
const KNOWN_WORLDS = ['world1', 'world2', 'tmpla', 'mp_02_s_shanty', 'mp_06_m_ranch', 'mp_07_m_dogon', 'mp_08_m_colony', 'mp_10_l_fishingvillage',
  'mp_11_l_savanna', 'mp_12_l_fueldepot', 'mp_14_woodlands', 'mp_15_mine', 'mp_16_airbase', 'mp_17_dunes', 'mp_18_greenhouse', 'mp_21_town',
  'mp_24_dusttown', 'mp_25_prison', 'mp_dlc01_resort', 'mp_dlc02_lake', 'mp_dlc04_bridge', 'mp_dlc05_clinic', 'mp_dlc09_jungle', 'mp_dlc_gym'];

const FAT_RE = /\.fat$/i;
/** Звук и шейдеры: моделей и текстур в них нет. */
const SKIP_RE = /^(sound|sound_english|shadersobj)\.fat$/i;
/** Порядок: обновление patch — последним (перекрывает). */
const rank = (name: string) => (/^patch\.fat$/i.test(name) ? 3 : /^common\.fat$/i.test(name) ? 0 : /^worlds/i.test(name) ? 1 : 2);
const relPath = (f: BlobFile) => (f.webkitRelativePath || f.name).replace(/\\/g, '/');

/** Кандидаты в XML-списки: сжатые (LZO) записи от 256 КБ, хорошо сжатые (текст). */
const isListCandidate = (e: FatEntry) => e.scheme === 1 && e.size >= 256 * 1024 && e.size / Math.max(1, e.csize) >= 3;

/**
 * Все .fat из выбранных (или из папки игры) одним архивом; открывается по первому. Имена — из XML-списков ресурсов.
 */
export async function openDuniaArchive(file: BlobFile, siblings: readonly BlobFile[]): Promise<Archive | null> {
  const fats = siblings.filter((f) => FAT_RE.test(f.name) && !SKIP_RE.test(f.name));
  if (!fats.includes(file)) fats.push(file);
  fats.sort((a, b) => rank(a.name) - rank(b.name) || relPath(a).localeCompare(relPath(b)));
  if (fats[0] !== file) return null; // остальные .fat уже вошли в архив
  const byHash = new Map<number, { fe: FatEntry; dat: BlobFile }>();
  const missingDat: string[] = [];
  for (const f of fats) {
    const want = relPath(f).replace(FAT_RE, '.dat').toLowerCase();
    const dat = siblings.find((s) => relPath(s).toLowerCase() === want) ?? siblings.find((s) => s.name.toLowerCase() === f.name.replace(FAT_RE, '.dat').toLowerCase());
    if (!dat) { missingDat.push(f.name); continue; }
    for (const fe of parseFat(new Uint8Array(await f.arrayBuffer()))) byHash.set(fe.hash, { fe, dat });
  }
  if (!byHash.size) throw new Error(`Нет .dat рядом с ${missingDat.join(', ') || file.name}: выберите пары .fat + .dat или папку Data_Win32`);
  // имена из XML-списков ресурсов
  const names = new Map<number, string>(), seenSize = new Set<string>();
  for (const { fe, dat } of byHash.values()) {
    if (!isListCandidate(fe)) continue;
    const k = `${fe.size}/${fe.csize}`;
    if (seenSize.has(k)) continue; // копии одного списка в разных мирах
    let head: Uint8Array;
    try { head = await readFatEntry(dat, fe, 16); } catch { continue; }
    if (String.fromCharCode(...head.subarray(0, 6)) !== '<root>') continue;
    seenSize.add(k);
    try {
      const text = new TextDecoder('latin1').decode(await readFatEntry(dat, fe));
      for (const n of namesFromResourceXml(text)) { const h = duniaHash(n); if (byHash.has(h) && !names.has(h)) names.set(h, n); }
    } catch { /* список повреждён — пропускаем */ }
  }
  // миры: game.xml + sectorsdep.fcb; файлы мира — участок .dat до его sectorsdep (миры пишутся в .dat подряд)
  const worldNames = new Set(KNOWN_WORLDS);
  for (const n of names.values()) { const m = /^worlds\\([^\\]+)\\/i.exec(n); if (m) worldNames.add(m[1]!.toLowerCase()); }
  const worlds = new Map<string, { name: string; gx: FatRef; end: number; dat: BlobFile; start: number }>();
  for (const w of worldNames) {
    const gx = byHash.get(duniaHash(`worlds\\${w}\\generated\\${w}.game.xml`)), sd = byHash.get(duniaHash(`worlds\\${w}\\generated\\${w}.sectorsdep.fcb`));
    if (gx && sd) worlds.set(w, { name: w, gx, end: sd.fe.off, dat: sd.dat, start: 0 });
  }
  for (const w of worlds.values()) for (const o of worlds.values()) if (o.dat === w.dat && o.end < w.end && o.end > w.start) w.start = o.end;
  const levelEntries: DuniaEntry[] = [];
  await Promise.all([...worlds.values()].map(async (w) => {
    const spec = (name: string, x0: number, y0: number, cw: number, ch: number, terrainOnly = false): LevelSpec => ({ world: w.name, name, x0, y0, w: cw, h: ch, ...(terrainOnly ? { terrainOnly } : {}) });
    const add = (path: string, sp: LevelSpec) => { const text = LEVEL_MARK + JSON.stringify(sp); levelEntries.push({ path, size: text.length, fe: w.gx.fe, dat: w.gx.dat, text }); };
    let maps: Array<{ name: string; x: number; y: number; cx: number; cy: number }> = [], gx = 0, gy = 0;
    try {
      const { xmlElements } = await import('./rml');
      for (const el of xmlElements(await readFatEntry(w.gx.dat, w.gx.fe))) {
        if (el.name === 'GridMapSectors' && !gx) { gx = +el.attrs.CountX! || 0; gy = +el.attrs.CountY! || 0; }
        if (el.name === 'Map' && el.attrs.Name) maps.push({ name: el.attrs.Name.split(/[\\/]/).pop()!.replace(/\.nomad$/i, ''), x: +el.attrs.SectorOffsetX! || 0, y: +el.attrs.SectorOffsetY! || 0, cx: +el.attrs.CountX! || 0, cy: +el.attrs.CountY! || 0 });
      }
    } catch { maps = []; }
    maps = maps.filter((m) => m.cx > 0 && m.cy > 0);
    if (maps.length > 1) {
      // большой мир: карты по 16×16 секторов (1 км) с объектами + весь мир одним ландшафтом
      const W = Math.max(...maps.map((m) => m.x + m.cx)), H = Math.max(...maps.map((m) => m.y + m.cy));
      add(`worlds/${w.name}/${w.name}.fc2level`, spec(w.name, 0, 0, W, H, true));
      for (const m of maps) add(`worlds/${w.name}/maps/${m.name.toLowerCase()}.fc2level`, spec(m.name, m.x, m.y, m.cx, m.cy));
    } else {
      const m = maps[0];
      add(`worlds/${w.name}/${w.name}.fc2level`, spec(m?.name ?? w.name, m?.x ?? 0, m?.y ?? 0, m?.cx || gx || 16, m?.cy || gy || 16));
    }
  }));
  const levelIndex = new Map(levelEntries.map((e) => [e.path, e]));
  const entries: DuniaEntry[] = [...levelEntries], byPath = new Map<number, DuniaEntry>();
  const entryOf = (h: number, path: string): DuniaEntry | null => {
    let e = byPath.get(h);
    if (e) return e;
    let x = byHash.get(h);
    if (!x) return null;
    // текстура высокого качества: старший уровень лежит отдельно в «<имя>_mip0.xbt» (полный XBT/DDS 1024²) — берём его
    if (/\.xbt$/i.test(path)) { const hd = byHash.get(duniaHash(path.replace(/\.xbt$/i, '_mip0.xbt'))); if (hd && hd.fe.size > 0) x = hd; }
    e = { path, size: x.fe.size, fe: x.fe, dat: x.dat };
    byPath.set(h, e);
    return e;
  };
  for (const [h, n] of names) entries.push(entryOf(h, n.replace(/\\/g, '/').toLowerCase())!);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const refs = [...byHash.values()];
  const byDat = new Map<BlobFile, FatRef[]>();
  const datRefs = (dat: BlobFile) => {
    let l = byDat.get(dat);
    if (!l) { l = refs.filter((r) => r.dat === dat).sort((a, b) => a.fe.off - b.fe.off); byDat.set(dat, l); }
    return l;
  };
  const worldOf = (w: { name: string; gx: FatRef; end: number; dat: BlobFile; start: number }): DuniaWorld => ({
    name: w.name, gameXml: w.gx, dat: w.dat, end: w.end, files: () => datRefs(w.dat).filter((r) => r.fe.off >= w.start && r.fe.off < w.end),
  });
  const api: DuniaArchiveApi = {
    duniaWorld(name) { const w = worlds.get(name.toLowerCase()); return w ? worldOf(w) : null; },
    duniaWorlds: () => [...worlds.values()].map(worldOf),
    datRefs,
    readRef: (r, head) => readFatEntry(r.dat, r.fe, head),
    refByHash: (h) => byHash.get(h >>> 0),
    nameOfHash: (h) => names.get(h >>> 0),
  };
  const arch = createArchive<DuniaEntry>({
    name: fats.length > 1 ? `${fats[0]!.name} … (${fats.length} .fat)` : file.name,
    kind: 'dunia-fat',
    version: 5,
    entries,
    // путь из ссылок модели/материала — по хешу, даже если его нет в списках
    lookup: (p) => { const k = p.replace(/\\/g, '/').toLowerCase(); return levelIndex.get(k) ?? entryOf(duniaHash(p), k); },
    read: (e) => (e.text !== undefined ? Promise.resolve(new TextEncoder().encode(e.text)) : readFatEntry(e.dat, e.fe)),
    findTexture: (p) => (/\.xbt$/i.test(p) ? entryOf(duniaHash(p), p.replace(/\\/g, '/').toLowerCase()) : null),
  });
  return Object.assign(arch, api);
}

/** Миры архива Dunia (для уровней), если архив — Dunia. */
export const duniaApi = (a: unknown): DuniaArchiveApi | null => (a && typeof (a as DuniaArchiveApi).duniaWorld === 'function' ? (a as DuniaArchiveApi) : null);
