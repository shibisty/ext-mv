// Синтетические файлы Survarium (Vostok): архив resources.NN.db, двоичный конфиг, converted_model.
import { Bin } from './bin';

type Tree = { [k: string]: Tree | Uint8Array | 'deleted' | { link: string } };

/** Архив .db: дерево папок и файлов; «deleted» — узел-удаление (0x800), { link } — ссылка на другой файл (0x200). */
export function makeVostokDb(files: Record<string, Uint8Array | 'deleted' | { link: string }>): Uint8Array {
  const root: Tree = {};
  for (const [p, v] of Object.entries(files)) {
    const parts = p.split('/');
    let t = root;
    for (const d of parts.slice(0, -1)) t = (t[d] ??= {}) as Tree;
    t[parts[parts.length - 1]!] = v;
  }
  const b = new Bin().ascii('little-endian').zeros(3).u32(0).u32(0).seek(0x400);
  const data: Array<[number, Uint8Array]> = [], nodeAt = new Map<string, number>(), links: Array<[number, string]> = [];
  const emit = (t: Tree, prefix: string): number => {
    let first = 0, prevNext = -1;
    for (const [name, v] of Object.entries(t)) {
      const S = b.length;
      const isDir = !(v instanceof Uint8Array) && v !== 'deleted' && !('link' in (v as object));
      const fl = isDir ? 5 : v === 'deleted' ? 0x804 : v instanceof Uint8Array ? 4 : 0x204;
      b.zeros(0x48).u16(fl).u8(0).cstr(name).align(8);
      if (prevNext >= 0) b.patchU32(prevNext, S); else first = S;
      prevNext = S + 0x30;
      nodeAt.set(prefix + name, S);
      if (isDir) { const c = emit(v as Tree, prefix + name + '/'); b.patchU32(S + 8, c); }
      else if (v instanceof Uint8Array) data.push([S, v]);
      else if (v !== 'deleted') links.push([S, (v as { link: string }).link]);
    }
    return first;
  };
  const first = emit(root, '');
  b.patchU32(0x3c0, first);
  const isz = b.length;
  for (const [S, d] of data) { b.patchU32(S, d.length); b.patchU32(S + 8, b.length); b.bytes(d); }
  for (const [S, target] of links) b.patchU32(S + 0x10, nodeAt.get(target)!);
  b.patchU32(0x10, nodeAt.size).patchU32(0x14, isz - 0x400);
  return b.toU8();
}

export type Cfg = { [k: string]: Cfg | CfgArr | string | number | number[] };
export type CfgArr = Array<Cfg | string | number | number[]>;

/** Двоичный конфиг: таблицы (0x30), строки (0x50), целые (0x10). */
export function makeVostokConfig(root: Cfg): Uint8Array {
  // узлы контейнеров (таблицы — объекты, массивы — 0x40) подряд, дети — после; массив из 3 чисел — f32×3 (0x70)
  type V = Cfg | CfgArr | string | number | number[];
  const isVec = (v: V): v is number[] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
  const isCont = (v: V) => typeof v === 'object' && !isVec(v);
  const nodes: Array<{ name: string; v: V }> = [{ name: '', v: root }];
  const childStart = new Map<number, number>();
  const queue: number[] = [0];
  for (let q = 0; q < queue.length; q++) {
    const idx = queue[q]!, v = nodes[idx]!.v as Cfg | CfgArr, start = nodes.length;
    const kids: Array<[string, V]> = Array.isArray(v) ? v.map((x) => ['', x as V]) : Object.entries(v) as Array<[string, V]>;
    childStart.set(idx, start);
    for (const [k, x] of kids) nodes.push({ name: k, v: x });
    kids.forEach(([, x], i) => { if (isCont(x)) queue.push(start + i); });
  }
  const b = new Bin(), strings: Array<[number, string]> = [], vecs: Array<[number, number[]]> = [];
  b.zeros(nodes.length * 16);
  const str = (x: string) => { const o = b.length; b.cstr(x); return o; };
  nodes.forEach((n, i) => {
    const o = i * 16, nameOff = i && n.name ? str(n.name) : 0;
    const v = n.v;
    if (isVec(v)) { vecs.push([o, v]); b.patchU32(o + 4, 0x70 << 8 | (12 << 16)); }
    else if (Array.isArray(v)) { b.patchU32(o, childStart.get(i)! * 16); b.patchU32(o + 4, 0x40 << 8 | (v.length << 16)); }
    else if (typeof v === 'object') { b.patchU32(o, childStart.get(i)! * 16); b.patchU32(o + 4, 0x30 << 8 | (Object.keys(v).length << 16)); }
    else if (typeof v === 'string') { strings.push([o, v]); b.patchU32(o + 4, 0x50 << 8 | ((v.length + 1) << 16)); }
    else if (Number.isInteger(v)) { b.patchI32(o, v); b.patchU32(o + 4, 0x10 << 8 | (4 << 16)); }
    else { const f = new DataView(new ArrayBuffer(4)); f.setFloat32(0, v, true); b.patchU32(o, f.getUint32(0, true)); b.patchU32(o + 4, 0x20 << 8 | (4 << 16)); }
    if (nameOff) b.patchU32(o + 8, nameOff);
  });
  for (const [o, x] of strings) b.patchU32(o, str(x));
  for (const [o, x] of vecs) { const at = b.length; b.f32s(...x); b.patchU32(o, at); }
  return b.toU8();
}

export function makeConvertedModel(pos: number[][], uvHalf: Array<[number, number]>, idx: number[]): Uint8Array {
  const b = new Bin().u32(3).u32(4 + pos.length * 28).u32(pos.length);
  pos.forEach((p, i) => b.f32s(...p).u32(0x3f008080).u32(0x3f008080).u32(0x3f008080).u16(uvHalf[i]![0]).u16(uvHalf[i]![1]));
  b.u32(4).u32(4 + idx.length * 2).u32(idx.length);
  for (const i of idx) b.u16(i);
  return b.u32(110).u32(4).u32(0).toU8();
}

/** .b-spline: каналы (9 на кость), каждый — узлы и значения (последняя пара — конец и −1e9). */
export function makeBSpline(channels: Array<{ knots: number[]; values: number[] }>): Uint8Array {
  const nb = channels.length / 9, b = new Bin().u16(nb).u16(0);
  const table = b.length;
  b.zeros(channels.length * 8);
  const data = b.length;
  channels.forEach((c, i) => {
    b.patchU32(table + i * 8, b.length - 4);
    b.u32(c.knots.length);
    c.knots.forEach((k, j) => b.f32(k).f32(j < c.values.length ? c.values[j]! : -1e9));
  });
  void data;
  return b.toU8();
}

/** bind_pose: кости в пространстве модели. */
export function makeBindPose(bones: Array<{ name: string; pos: number[]; euler?: number[] }>): Uint8Array {
  const b = new Bin().u16(bones.length);
  for (const x of bones) b.cstr(x.name).f32s(...x.pos).f32s(...(x.euler ?? [0, 0, 0])).f32s(1, 1, 1);
  return b.toU8();
}

/** Слой травы .veg: чанк 78 (маска — здесь пустая), 88 — позиции, 89 — нормали. */
export function makeVeg(pos: number[][], nor: number[][]): Uint8Array {
  const b = new Bin().u32(78).u32(12).u32(0).u32(2048).u32(0);
  b.u32(88).u32(pos.length * 12);
  for (const p of pos) b.f32s(...p);
  b.u32(89).u32(nor.length * 12);
  for (const n of nor) b.f32s(...n);
  return b.toU8();
}
