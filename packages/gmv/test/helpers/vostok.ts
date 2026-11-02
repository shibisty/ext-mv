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

export type Cfg = { [k: string]: Cfg | string | number };

/** Двоичный конфиг: таблицы (0x30), строки (0x50), целые (0x10). */
export function makeVostokConfig(root: Cfg): Uint8Array {
  const nodes: Array<{ name: string; v: Cfg | string | number; at: number }> = [];
  const b = new Bin(), strings: Array<[number, string]> = [];
  // раскладка: узлы таблицы подряд, дети — после
  const place = (t: Cfg, at: number) => {
    const kids = Object.entries(t), start = nodes.length;
    for (const [k, v] of kids) nodes.push({ name: k, v, at: 0 });
    return { start, n: kids.length, at };
  };
  const tables: Array<{ t: Cfg; idx: number }> = [];
  nodes.push({ name: '', v: root, at: 0 });
  tables.push({ t: root, idx: 0 });
  const childStart = new Map<number, number>();
  for (let q = 0; q < tables.length; q++) {
    const { t, idx } = tables[q]!;
    const { start } = place(t, 0);
    childStart.set(idx, start);
    Object.values(t).forEach((v, i) => { if (typeof v === 'object') tables.push({ t: v, idx: start + i }); });
  }
  b.zeros(nodes.length * 16);
  const str = (s: string) => { const o = b.length; b.cstr(s); return o; };
  nodes.forEach((n, i) => {
    const o = i * 16, nameOff = i ? str(n.name) : 0;
    if (typeof n.v === 'object') { b.patchU32(o, childStart.get(i)! * 16); b.patchU32(o + 4, 0x30 << 8 | (Object.keys(n.v).length << 16)); }
    else if (typeof n.v === 'string') { strings.push([o, n.v]); b.patchU32(o + 4, 0x50 << 8 | ((n.v.length + 1) << 16)); }
    else { b.patchI32(o, n.v); b.patchU32(o + 4, 0x10 << 8 | (4 << 16)); }
    if (i) b.patchU32(o + 8, nameOff);
  });
  for (const [o, s] of strings) b.patchU32(o, str(s));
  return b.toU8();
}

/** converted_model: вершины по 28 байт (позиция, 3×4 байта упакованных векторов, UV 2×f16), индексы u16. */
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
