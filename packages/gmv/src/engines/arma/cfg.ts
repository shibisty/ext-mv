// Конфиги Arma: сбор config.bin из открытых PBO, разбор классов CfgVehicles/CfgWeapons в «что показать».
import { normPath } from '../../core/binary';
import type { Archive } from '../../core/types';
import { isRap, mergeRap, parseRap, rapBase, rapGet, type RapClass, type RapValue } from './rap';

const parsed = new WeakMap<Archive, RapClass | null>();

/** config.bin одного архива (кэш). */
export async function archiveConfig(a: Archive): Promise<RapClass | null> {
  if (parsed.has(a)) return parsed.get(a)!;
  let cfg: RapClass | null = null;
  const e = a.entries.find((x) => /(^|\/)config\.bin$/.test(x.path) && !x.path.includes('/config/'));
  if (e) {
    try {
      const u8 = await a.read(e);
      if (isRap(u8)) cfg = parseRap(u8);
    } catch { cfg = null; }
  }
  parsed.set(a, cfg);
  return cfg;
}

/** Общий конфиг всех открытых PBO. */
export async function mergedConfig(archives: readonly Archive[]): Promise<RapClass> {
  const list: RapClass[] = [];
  for (const a of archives) if (a.kind === 'pbo') { const c = await archiveConfig(a); if (c) list.push(c); }
  return mergeRap(list);
}

/** Путь модели из конфига -> путь в архивах: «\Mod\x\y.p3d» -> «mod/x/y.p3d». */
export const modelPath = (p: string): string => {
  const n = normPath(p).replace(/^\/+/, '');
  return n && !/\.p3d$/.test(n) ? `${n}.p3d` : n;
};
export const texPath = (p: string): string => normPath(p).replace(/^\/+/, '');

export const str = (v: RapValue | undefined): string => (typeof v === 'string' ? v : '');
export const strs = (v: RapValue | undefined): string[] => (Array.isArray(v) ? v.flat(4).filter((x): x is string => typeof x === 'string') : []);

/** Значение с наследованием в общем корне. */
export const get = (c: RapClass, key: string, root: RapClass) => rapGet(c, key, root);
/** Вложенный класс с наследованием (ItemInfo, WeaponSlotsInfo, LinkedItems…). */
export function sub(c: RapClass, name: string, root: RapClass): RapClass | null {
  const seen = new Set<RapClass>();
  for (let cur: RapClass | null = c; cur && !seen.has(cur); cur = rapBase(cur, root)) {
    seen.add(cur);
    const hit = cur.classes.get(name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export type ClassKind = 'unit' | 'vehicle' | 'uniform' | 'wearable' | 'weapon' | 'item';
export interface ClassRef { cfg: 'cfgvehicles' | 'cfgweapons'; cls: string; kind: ClassKind; title: string }

/** Классы, которые стоит показывать отдельными «моделями»: определяют модель, текстуры или снаряжение сами. */
export function listClasses(cfg: RapClass): ClassRef[] {
  const out: ClassRef[] = [];
  const own = (c: RapClass, k: string) => c.values.has(k);
  for (const c of cfg.classes.get('cfgvehicles')?.classes.values() ?? []) {
    if (!(own(c, 'model') || own(c, 'hiddenselectionstextures') || own(c, 'linkeditems'))) continue;
    if (c.values.get('scope') === 0) continue;
    const isMan = own(c, 'uniformclass') || own(c, 'linkeditems') || /soldier|man|_f$/i.test(c.base) && own(c, 'hiddenselectionstextures');
    out.push({ cfg: 'cfgvehicles', cls: c.name, kind: isMan ? 'unit' : 'vehicle', title: str(c.values.get('displayname')) || c.name });
  }
  for (const c of cfg.classes.get('cfgweapons')?.classes.values() ?? []) {
    const info = c.classes.get('iteminfo');
    if (!(own(c, 'model') || own(c, 'hiddenselectionstextures') || info || c.classes.has('linkeditems'))) continue;
    if (c.values.get('scope') === 0) continue;
    const kind: ClassKind = info?.values.has('uniformclass') ? 'uniform' : info?.values.has('uniformmodel') ? 'wearable' : c.classes.has('weaponslotsinfo') || c.classes.has('linkeditems') || /rifle|pistol|launcher|mgun|smg/i.test(c.base) ? 'weapon' : 'item';
    out.push({ cfg: 'cfgweapons', cls: c.name, kind, title: str(c.values.get('displayname')) || c.name });
  }
  return out;
}

/** Текстуры скрытых выделений класса: имя выделения (нижний регистр) -> путь. */
export function hiddenTextures(c: RapClass, root: RapClass): Map<string, string> {
  const tex = strs(get(c, 'hiddenselectionstextures', root));
  let sels = strs(get(c, 'hiddenselections', root));
  if (!sels.length && tex.length) sels = ['camo', 'camo1', 'camo2', 'camo3', 'camo4', 'camo5'].slice(0, tex.length); // базовые классы игры не открыты
  const out = new Map<string, string>();
  sels.forEach((s, i) => { if (tex[i]) out.set(s.toLowerCase(), tex[i]!); });
  return out;
}
