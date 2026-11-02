// База игры LithTech Jupiter EX (F.E.A.R. Online: Game/database/Loki.gamedb, сигнатура «GADB», версия 6).
// Материалы моделей записаны не в .mdl, а здесь: запись категории (Character/Models, Props, оружие…) содержит путь .mdl
// и список .mat — прямо или через ссылку на запись-структуру (_Structures/MaterialSets).
// Формат: «GADB», u32 версия, u32 размер блока строк, u32 категорий, u32 записей, u32 значений, u32 атрибутов;
// блок строк (с нулём, выровнены по 4); атрибуты по 8 байт [u32 хэш имени, u8 тип, u8 число значений, u16 номер значения в записи];
// u32 число категорий и подряд категории [u32 имя, u32 число записей, u32] с их записями
// [u32 имя, u32 число значений, u32 число атрибутов, u32 первый атрибут, u32 хэш, значения u32 × N].
// Тип атрибута: младшие 4 бита — 1 целое, 2 число, 3/4 строка (смещение в блоке строк), 9 ссылка (u16 категория << 16 | u16 запись).

export interface GameDb {
  /** Путь .mdl (нижний регистр, «/») -> материалы по номерам (пусто — без материала). */
  modelMaterials: Map<string, string[]>;
  categories: number;
  records: number;
}

/** Атрибуты со списком материалов, по убыванию предпочтения (найдены по записям оружия, персонажей и предметов). */
const MAT_ATTR_PRIORITY = new Map<number, number>([[0xe9db0857, 0], [0x610e3b97, 1]]);

export function parseGameDb(u: Uint8Array): GameDb {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 28 || String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'GADB') throw new Error('Не база LithTech (нет «GADB»)');
  const bl = dv.getUint32(8, true), ncat = dv.getUint32(12, true), nattr = dv.getUint32(24, true);
  const B = 28, td = new TextDecoder('latin1');
  const strCache = new Map<number, string | null>();
  const str = (o: number): string | null => {
    if (o >= bl || (o > 0 && u[B + o - 1] !== 0) || !u[B + o]) return null;
    let s = strCache.get(o);
    if (s === undefined) { let e = B + o; while (e < B + bl && u[e]) e++; s = td.decode(u.subarray(B + o, e)); strCache.set(o, s); }
    return s;
  };
  const attrAt = B + bl;
  let p = attrAt + nattr * 8;
  if (dv.getUint32(p, true) !== ncat) throw new Error('База LithTech: неожиданная структура (число категорий)');
  p += 4;
  interface Rec { na: number; ast: number; vals: number }
  const cats: Array<{ name: string; recs: Rec[] }> = [];
  let total = 0;
  for (let c = 0; c < ncat; c++) {
    const name = str(dv.getUint32(p, true)) ?? '', nr = dv.getUint32(p + 4, true);
    p += 12;
    const recs: Rec[] = [];
    for (let r = 0; r < nr; r++) {
      const nv = dv.getUint32(p + 4, true), na = dv.getUint32(p + 8, true), ast = dv.getUint32(p + 12, true);
      recs.push({ na, ast, vals: p + 20 });
      p += 20 + nv * 4;
      if (p > u.length) throw new Error('База LithTech обрезана');
    }
    total += nr;
    cats.push({ name, recs });
  }
  const structCat = cats.findIndex((c) => c.name === '_Structures');
  const attrs = (r: Rec) => Array.from({ length: r.na }, (_, i) => {
    const a = attrAt + (r.ast + i) * 8;
    return { hash: dv.getUint32(a, true), type: u[a + 4]! & 15, count: u[a + 5]!, idx: dv.getUint16(a + 6, true) };
  });
  const val = (r: Rec, i: number) => dv.getUint32(r.vals + i * 4, true);

  /** Списки материалов записи (и вложенных структур): [приоритет, список]. */
  const matLists = (r: Rec, depth: number, out: Array<[number, Array<string | null>]>) => {
    for (const a of attrs(r)) {
      if (a.type === 3 || a.type === 4) {
        const list = Array.from({ length: a.count }, (_, i) => str(val(r, a.idx + i)));
        if (list.some((s) => s && /\.mat$/i.test(s))) out.push([(MAT_ATTR_PRIORITY.get(a.hash) ?? 5) + depth * 10, list]);
      } else if (a.type === 9 && depth < 2 && structCat >= 0) {
        for (let i = 0; i < a.count; i++) {
          const v = val(r, a.idx + i);
          if (v === 0xffffffff || v >>> 16 !== structCat) continue;
          const sr = cats[structCat]!.recs[v & 0xffff];
          if (sr) matLists(sr, depth + 1, out);
        }
      }
    }
  };

  const modelMaterials = new Map<string, string[]>(), rank = new Map<string, number>();
  for (const c of cats) {
    for (const r of c.recs) {
      let models: string[] | null = null;
      for (const a of attrs(r)) {
        if (a.type !== 3 && a.type !== 4) continue;
        for (let i = 0; i < a.count; i++) {
          const s = str(val(r, a.idx + i));
          if (s && /\.mdl$/i.test(s)) (models ??= []).push(s.replace(/\\/g, '/').toLowerCase());
        }
      }
      if (!models) continue;
      const lists: Array<[number, Array<string | null>]> = [];
      matLists(r, 0, lists);
      if (!lists.length) continue;
      lists.sort((a, b) => a[0] - b[0]);
      const [pri, best] = lists[0]!;
      for (const m of models) {
        // первая запись с лучшим приоритетом (у оружия есть и варианты с кровью/камуфляжем — их пропускаем)
        if ((rank.get(m) ?? 1e9) <= pri) continue;
        rank.set(m, pri);
        modelMaterials.set(m, best.map((s) => s ?? ''));
      }
    }
  }
  return { modelMaterials, categories: ncat, records: total };
}
