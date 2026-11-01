// Rapified-конфиги Bohemia («\0raP»): config.bin, *.rvmat, model.cfg после бинаризации, mission.sqm.
// Классы с наследованием «class A: B», значения (строка/float/int), массивы (вложенные).

export type RapValue = string | number | RapValue[];
export interface RapClass {
  name: string;
  /** Имя родителя («class X: Parent»), пустая строка — без наследования. */
  base: string;
  /** Ключи в нижнем регистре. */
  values: Map<string, RapValue>;
  classes: Map<string, RapClass>;
  /** Объявления без тела: «class X;». */
  externs: Set<string>;
  parent: RapClass | null;
}

export const isRap = (u8: Uint8Array) => u8.length >= 4 && u8[0] === 0 && u8[1] === 0x72 && u8[2] === 0x61 && u8[3] === 0x50;

export function parseRap(u8: Uint8Array): RapClass {
  if (!isRap(u8)) throw new Error('Не rapified-конфиг (нет «\\0raP»)');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const utf8 = new TextDecoder();
  const str = (p: number): [string, number] => {
    let e = p;
    while (e < u8.length && u8[e]) e++;
    return [utf8.decode(u8.subarray(p, e)), e + 1];
  };
  const cint = (p: number): [number, number] => {
    let v = 0, sh = 0;
    for (let i = 0; i < 5; i++) { const b = u8[p++]!; v += (b & 0x7f) * 2 ** sh; sh += 7; if (b < 0x80) break; }
    return [v, p];
  };
  const array = (p: number): [RapValue[], number] => {
    let n: number;
    [n, p] = cint(p);
    const out: RapValue[] = [];
    for (let i = 0; i < n; i++) {
      const t = u8[p++];
      if (t === 0 || t === 4) { let s: string; [s, p] = str(p); out.push(s); }
      else if (t === 1) { out.push(dv.getFloat32(p, true)); p += 4; }
      else if (t === 2) { out.push(dv.getInt32(p, true)); p += 4; }
      else if (t === 3) { let a: RapValue[]; [a, p] = array(p); out.push(a); }
      else throw new Error(`rap: неизвестный тип элемента массива ${t}`);
    }
    return [out, p];
  };
  const body = (name: string, at: number, parent: RapClass | null, depth: number): RapClass => {
    if (depth > 64) throw new Error('rap: слишком глубокая вложенность');
    let [base, p] = str(at), n: number;
    [n, p] = cint(p);
    const c: RapClass = { name, base, values: new Map(), classes: new Map(), externs: new Set(), parent };
    for (let i = 0; i < n; i++) {
      const t = u8[p++];
      let key: string;
      if (t === 0) {
        [key, p] = str(p);
        const off = dv.getUint32(p, true);
        p += 4;
        c.classes.set(key.toLowerCase(), body(key, off, c, depth + 1));
      } else if (t === 1) {
        const st = u8[p++];
        [key, p] = str(p);
        if (st === 0 || st === 4) { let s: string; [s, p] = str(p); c.values.set(key.toLowerCase(), s); }
        else if (st === 1) { c.values.set(key.toLowerCase(), dv.getFloat32(p, true)); p += 4; }
        else if (st === 2) { c.values.set(key.toLowerCase(), dv.getInt32(p, true)); p += 4; }
        else throw new Error(`rap: неизвестный тип значения ${st}`);
      } else if (t === 2 || t === 5) {
        if (t === 5) p += 4; // флаг «+=»
        [key, p] = str(p);
        let a: RapValue[];
        [a, p] = array(p);
        c.values.set(key.toLowerCase(), a);
      } else if (t === 3) { [key, p] = str(p); c.externs.add(key.toLowerCase()); }
      else if (t === 4) { [key, p] = str(p); } // delete
      else throw new Error(`rap: неизвестный тип записи ${t} (смещение ${p - 1})`);
    }
    return c;
  };
  return body('', 16, null, 0);
}

/** Поиск значения с учётом наследования (родитель ищется по цепочке вложенности, как в движке). */
export function rapGet(c: RapClass, key: string, root?: RapClass): RapValue | undefined {
  const seen = new Set<RapClass>();
  for (let cur: RapClass | null = c; cur && !seen.has(cur); cur = rapBase(cur, root)) {
    seen.add(cur);
    const v = cur.values.get(key.toLowerCase());
    if (v !== undefined) return v;
  }
  return undefined;
}
/** Класс-родитель: ищется среди соседей и выше по вложенности; в дополнительном корне (другие config.bin) — тоже. */
export function rapBase(c: RapClass, root?: RapClass): RapClass | null {
  if (!c.base) return null;
  const k = c.base.toLowerCase();
  for (let p = c.parent; p; p = p.parent) { const hit = p.classes.get(k); if (hit && hit !== c) return hit; }
  if (root) {
    // тот же путь в объединённом корне: CfgWeapons/Base
    const path: string[] = [];
    for (let p = c.parent; p && p.parent; p = p.parent) path.unshift(p.name.toLowerCase());
    let node: RapClass | undefined = root;
    for (const seg of path) node = node?.classes.get(seg);
    const hit = node?.classes.get(k);
    if (hit && hit !== c) return hit;
  }
  return null;
}

/** Объединить несколько конфигов (разных PBO) в один корень: классы верхних уровней сливаются, последний побеждает. */
export function mergeRap(list: RapClass[]): RapClass {
  const root: RapClass = { name: '', base: '', values: new Map(), classes: new Map(), externs: new Set(), parent: null };
  const merge = (dst: RapClass, src: RapClass, depth: number) => {
    for (const [k, v] of src.values) dst.values.set(k, v);
    for (const [k, c] of src.classes) {
      const have = dst.classes.get(k);
      if (have && depth < 1) merge(have, c, depth + 1); // CfgWeapons, CfgVehicles… — сливаем содержимое
      else dst.classes.set(k, { ...c, values: new Map(c.values), classes: new Map(c.classes), externs: new Set(c.externs), parent: dst }); // копия: исходники из кэша не меняются
    }
  };
  for (const c of list) merge(root, c, 0);
  return root;
}
