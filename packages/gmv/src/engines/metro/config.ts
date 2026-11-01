// Бинарный конфиг 4A Engine (Metro 2033): level.bin, *.bin из content/config.
// Файл: u8 тип (5 — «с отладочными именами»), чанк 1 — данные, чанк 2 — таблица строк (u32 число, строки с нулём).
// Поле данных: u32 индекс имени, u32 индекс типа («u32», «fp32», «stringz», «pose, matrix»…), значение.
// Строки (stringz) записаны индексом в таблице. Тип вида «particles, str_shared» без значения — подсказка редактору,
// за ней идёт то же поле с базовым типом. Секция: u32 crc32 имени, u32 размер, u8 флаги, u32 индекс имени, поля.
// Массив — поле типа «array» с секцией внутри: «count» u32 (−1 — до конца) и секции-элементы.
// Формат разобран по самому файлу (он самоописывающий); смысл полей сверен со схемами редактора уровней 4A (js/2033/levelbin.js).

export interface CfgNode {
  name: string;
  type: string;
  /** Число, строка, массив чисел или, для секции/массива, дочерние узлы. */
  value: number | string | number[] | CfgNode[] | null;
}

const BASE: Record<string, number> = {
  u8: 1, s8: 1, bool: 1, bool8: 1, u16: 2, s16: 2, u32: 4, s32: 4, fp32: 4, u64: 8, s64: 8,
  vec2f: 8, vec3f: 12, vec4f: 16, vec2i: 8, vec3i: 12, vec4i: 16, vec4s16: 8, matrix: 64, matrix_43: 48, stringz: 4,
};

export interface MetroConfig {
  strings: string[];
  root: CfgNode[];
}

function decodeStrings(u: Uint8Array): string[] {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), n = dv.getUint32(0, true), out: string[] = [];
  const dec = new TextDecoder('windows-1251');
  let p = 4;
  for (let i = 0; i < n && p < u.length; i++) { let e = p; while (e < u.length && u[e]) e++; out.push(dec.decode(u.subarray(p, e))); p = e + 1; }
  return out;
}

export function parseMetroConfig(u: Uint8Array): MetroConfig {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u[0] !== 5 && u[0] !== 4) throw new Error(`Конфиг 4A: тип ${u[0]} не поддерживается`);
  let p = 1, data: [number, number] | null = null, strings: string[] = [];
  while (p + 8 <= u.length) {
    const id = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > u.length) throw new Error('Конфиг 4A: чанк за концом файла');
    if (id === 1) data = [p + 8, p + 8 + size];
    else if (id === 2) strings = decodeStrings(u.subarray(p + 8, p + 8 + size));
    p += 8 + size;
  }
  if (!data) throw new Error('Конфиг 4A: нет чанка данных');
  const S = strings, str = (i: number) => S[i] ?? `#${i}`;

  const trail: string[] = [];
  const hintBase = new Map<string, string>(), GUESS = ['u16', 'u32', 'u8', 'u64', 'vec3f', 'vec4f'];
  const validAt = (q: number, end: number): boolean => {
    if (q === end) return true;
    if (q + 8 > end) return false;
    const a = dv.getUint32(q, true), b = dv.getUint32(q + 4, true);
    if (a < S.length) return b < S.length;
    return q + 8 + b <= end && (u[q + 8] === 5 || u[q + 8] === 4) && dv.getUint32(q + 9, true) < S.length;
  };
  const fields = (p: number, end: number): CfgNode[] => {
    const out: CfgNode[] = [];
    while (p + 8 <= end) {
      const a = dv.getUint32(p, true), b = dv.getUint32(p + 4, true);
      if (a >= S.length) { // секция: crc32 имени, размер
        const s = p + 8;
        const nm = str(dv.getUint32(s + 1, true));
        trail.push(nm);
        out.push({ name: nm, type: 'section', value: fields(s + 5, s + b) });
        trail.pop();
        p = s + b;
        continue;
      }
      p += 8;
      const name = str(a), type = str(b);
      if (type === 'array' && p + 4 <= end && dv.getUint32(p, true) < S.length) { out.push({ name, type: 'array-hint', value: null }); continue; } // «массив без ключа»: дальше count и секции в этой же секции
      if (type === 'array') {
        const size = dv.getUint32(p + 4, true), s = p + 8;
        out.push({ name, type, value: fields(s + 5, s + size) });
        p = s + size;
        continue;
      }
      if (type.endsWith('_array') && BASE[type.slice(0, -6)]) {
        const sz = BASE[type.slice(0, -6)]!, n = dv.getUint32(p, true);
        out.push({ name, type, value: Array.from({ length: n }, (_, i) => readBase(type.slice(0, -6), p + 4 + i * sz) as number) });
        p += 4 + n * sz;
        continue;
      }
      let base = BASE[type] ? type : type.split(',').pop()!.trim();
      if (!BASE[type]) {
        // подсказка без значения: следом то же поле
        if (p + 4 > end || dv.getUint32(p, true) === a) { out.push({ name, type, value: null }); continue; }
        // тип-подсказка со значением («entity_link, uobject_link» = u16): размер подбирается по следующему полю
        if (!BASE[base]) {
          let t = hintBase.get(type);
          if (!t) {
            t = GUESS.find((g) => validAt(p + BASE[g]!, end));
            if (!t) throw new Error(`Конфиг 4A: неизвестный тип «${type}» у поля «${name}» (${trail.join('/')})`);
            hintBase.set(type, t);
          }
          base = t;
        }
      }
      out.push({ name, type, value: readBase(base, p) });
      p += BASE[base]!;
    }
    return out;
  };
  const readBase = (t: string, p: number): number | string | number[] => {
    switch (t) {
      case 'u8': case 'bool': case 'bool8': return dv.getUint8(p);
      case 's8': return dv.getInt8(p);
      case 'u16': return dv.getUint16(p, true);
      case 's16': return dv.getInt16(p, true);
      case 'u32': return dv.getUint32(p, true);
      case 's32': return dv.getInt32(p, true);
      case 'fp32': return dv.getFloat32(p, true);
      case 'u64': case 's64': return Number(dv.getBigUint64(p, true));
      case 'stringz': return str(dv.getUint32(p, true));
      case 'vec4s16': return [0, 1, 2, 3].map((i) => dv.getInt16(p + i * 2, true));
      default: {
        const n = BASE[t]! / 4, int = t.endsWith('i');
        return Array.from({ length: n }, (_, i) => (int ? dv.getInt32(p + i * 4, true) : dv.getFloat32(p + i * 4, true)));
      }
    }
  };
  return { strings, root: fields(data[0], data[1]) };
}

/** Первое поле с именем (и, если задан, типом). Подсказки (value === null) пропускаются. */
export function cfgGet(nodes: CfgNode[], name: string): CfgNode | undefined {
  return nodes.find((n) => n.name === name && n.value !== null);
}
export const cfgStr = (nodes: CfgNode[], name: string): string => { const v = cfgGet(nodes, name)?.value; return typeof v === 'string' ? v : ''; };
export const cfgNum = (nodes: CfgNode[], name: string): number => { const v = cfgGet(nodes, name)?.value; return typeof v === 'number' ? v : 0; };

export interface MetroEntity {
  name: string;
  cls: string;
  staticData: string;
  id: number;
  parent: number;
  /** Матрица 4×4 по строкам (вектор-строка × M, перенос в последней строке), как в файле. */
  pose: number[] | null;
  /** Модель: «static\…», «dynamic\…» относительно content/meshes, без расширения. */
  visual: string;
  fields: CfgNode[];
}

/** Объекты уровня (level.bin / level.add.bin). */
export function metroEntities(cfg: MetroConfig): MetroEntity[] {
  const arr = cfgGet(cfg.root, 'entities');
  if (!arr || !Array.isArray(arr.value)) return [];
  const out: MetroEntity[] = [];
  for (const e of arr.value as CfgNode[]) {
    if (e.type !== 'section' || !Array.isArray(e.value)) continue;
    const f = e.value as CfgNode[];
    // первая матрица — att_offset (смещение от родителя), вторая (без имени) — положение объекта
    const mats = f.filter((x) => x.type === 'pose, matrix' && Array.isArray(x.value));
    const pose = (mats.find((x) => x.name !== 'att_offset') ?? null)?.value as number[] | null;
    out.push({
      name: cfgStr(f, 'name') || e.name, cls: cfgStr(f, 'class'), staticData: cfgStr(f, 'static_data_key'),
      id: cfgNum(f, 'id'), parent: cfgGet(f, 'parent_id') ? cfgNum(f, 'parent_id') : 0xffff, pose: pose ?? null, visual: cfgStr(f, 'visual'), fields: f,
    });
  }
  return out;
}
