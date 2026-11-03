// Пакет UE2 как архив: объекты — записи. Текстуры и материалы — «<пакет>/<группа>/<имя>.utex» (декодируются в RGBA,
// материалы — по цепочке до базовой текстуры), статические меши — «.ue2sm», скелетные — «.ue2skm».
// Ссылки между пакетами (меш из .usx → материал из .utx) разрешаются по открытым пакетам сессии (по имени пакета).
import { createArchive, readRange } from '../../core/archives/common';
import type { Archive, ArchiveEntry, BlobFile } from '../../core/types';
import { packageRanges, UPackage, type UExport } from './ue2pkg';
import { decodeUeTexture, resolveMaterial, TEXTURE_CLASSES, type ObjResolver } from './ue2tex';

export interface Ue2Entry extends ArchiveEntry { exp: number; kind: 'tex' | 'sm' | 'skm' }
export type Ue2Archive = Archive & { ue2: UPackage };

/** Открытые пакеты по имени (нижний регистр, без расширения). */
const opened = new Map<string, UPackage>();
const pathIndex = new WeakMap<UPackage, Map<string, UExport>>();

export const packageName = (file: string): string => file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase();

function exportsByPath(pkg: UPackage): Map<string, UExport> {
  let m = pathIndex.get(pkg);
  if (!m) {
    m = new Map();
    pkg.exports.forEach((e, i) => { const k = pkg.objPath(i + 1).toLowerCase(); if (!m!.has(k) || TEXTURE_CLASSES.has(e.className)) m!.set(k, e); m!.set(`${k}|${e.className.toLowerCase()}`, e); });
    pathIndex.set(pkg, m);
  }
  return m;
}

/** Объект по ссылке: экспорт этого пакета или импорт из другого открытого пакета. */
export const resolveObj: ObjResolver = async (pkg, ref) => {
  if (ref > 0) { const exp = pkg.exports[ref - 1]; return exp ? { pkg, exp } : null; }
  if (ref < 0) {
    const im = pkg.imports[-ref - 1];
    if (!im) return null;
    // путь внутри пакета-источника и сам пакет — по цепочке outer
    const parts: string[] = [im.name];
    let o = im.outer, top = '';
    for (let k = 0; o && k < 16; k++) {
      const p = o < 0 ? pkg.imports[-o - 1] : pkg.exports[o - 1];
      if (!p) break;
      if (o < 0 && !(p as { outer: number }).outer) { top = p.name; break; }
      parts.unshift(p.name); o = p.outer;
    }
    const src = opened.get(top.toLowerCase());
    if (!src) return null;
    const idx = exportsByPath(src), key = parts.join('.').toLowerCase();
    const exp = idx.get(`${key}|${im.className.toLowerCase()}`) ?? idx.get(key);
    return exp ? { pkg: src, exp } : null;
  }
  return null;
};

/** Текстура/материал по имени объекта во всех открытых пакетах (у моделей персонажей Lineage II текстуры назначает игра). */
let nameIndex: { size: number; map: Map<string, { pkg: UPackage; ref: number }> } | null = null;
export function findMaterialByName(name: string): { pkg: UPackage; ref: number } | null {
  if (!nameIndex || nameIndex.size !== opened.size) {
    const map = new Map<string, { pkg: UPackage; ref: number }>();
    for (const pkg of opened.values()) pkg.exports.forEach((e, i) => { if (TEXTURE_CLASSES.has(e.className)) { const k = e.name.toLowerCase(); if (!map.has(k) || e.className !== 'Texture') map.set(k, { pkg, ref: i + 1 }); } });
    nameIndex = { size: opened.size, map };
  }
  return nameIndex.map.get(name.toLowerCase()) ?? null;
}
/** Первая по имени (по алфавиту) текстура, имя которой подходит под шаблон. */
export function findMaterialMatching(re: RegExp): { pkg: UPackage; ref: number } | null {
  findMaterialByName('');
  let best: string | null = null;
  for (const k of nameIndex!.map.keys()) if (re.test(k) && (best === null || k < best)) best = k;
  return best ? nameIndex!.map.get(best)! : null;
}

export async function openUe2Package(file: BlobFile): Promise<Ue2Archive> {
  const head = await readRange(file, 0, Math.min(file.size, 128));
  const rr = packageRanges((s, e) => readRange(file, s, e), head, file.name);
  const pkg = await UPackage.open(rr.read, rr.size(file.size), file.name);
  const pname = packageName(file.name);
  opened.set(pname, pkg);
  const entries: Ue2Entry[] = [];
  pkg.exports.forEach((e, i) => {
    const kind = TEXTURE_CLASSES.has(e.className) ? 'tex' : e.className === 'StaticMesh' ? 'sm' : e.className === 'SkeletalMesh' ? 'skm' : null;
    if (!kind || e.size <= 0) return;
    const path = `${pname}/${pkg.objPath(i + 1).toLowerCase().replace(/\./g, '/')}.${kind === 'tex' ? 'utex' : kind === 'sm' ? 'ue2sm' : 'ue2skm'}`;
    entries.push({ path, exp: i, kind, size: e.size });
  });
  const arch = createArchive<Ue2Entry>({
    name: file.name, kind: 'ue2', version: pkg.ver, entries,
    // текстуры: ключи и с пакетом, и без него (ссылки из моделей бывают «Пакет.Группа.Имя» и просто «Имя»)
    textureKeys: (e) => { const k = e.path.replace(/\.utex$/, ''); return [k, k.slice(k.indexOf('/') + 1)]; },
    keepFirstTextureKey: true,
    async read(e) {
      if (e.kind === 'tex') {
        const t = await resolveMaterial(pkg, e.exp + 1, resolveObj);
        if (!t) throw new Error(`${pkg.objPath(e.exp + 1)}: у материала не найдена базовая текстура`);
        const img = await decodeUeTexture(t.pkg, t.exp, resolveObj);
        return packRgba(img.width, img.height, img.rgba);
      }
      // меш: номер экспорта и имя пакета (сам пакет загрузчик берёт у архива)
      return new TextEncoder().encode(JSON.stringify({ exp: e.exp }));
    },
  }) as Ue2Archive;
  arch.ue2 = pkg;
  return arch;
}

/** RGBA в простой контейнер для кодека «utex»: «GMVR», ширина, высота, пиксели. */
export function packRgba(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + rgba.length), dv = new DataView(out.buffer);
  out.set([0x47, 0x4d, 0x56, 0x52]); dv.setUint32(4, w, true); dv.setUint32(8, h, true); out.set(rgba, 12);
  return out;
}
export function unpackRgba(buf: ArrayBuffer): { width: number; height: number; rgba: Uint8Array } {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0, true) !== 0x52564d47) throw new Error('Не текстура пакета Unreal');
  const width = dv.getUint32(4, true), height = dv.getUint32(8, true);
  return { width, height, rgba: new Uint8Array(buf, 12, width * height * 4) };
}

export const ue2PackageOf = (a: Archive | undefined): UPackage | null => (a && 'ue2' in a ? (a as Ue2Archive).ue2 : null);
