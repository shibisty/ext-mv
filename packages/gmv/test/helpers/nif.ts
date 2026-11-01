// Синтетические NIF 20.2.0.7 (Fallout 3/NV, BS version 34) для тестов: скинованный меш с двумя костями,
// отдельный skeleton.nif и .kf с NiTransformInterpolator и NiBSplineCompTransformInterpolator.
import { Bin } from './bin';

type BlockWriter = (b: Bin) => void;
interface Blk { type: string; write: BlockWriter }

class NifFile {
  strings: string[] = [];
  blocks: Blk[] = [];
  str(s: string) { let i = this.strings.indexOf(s); if (i < 0) i = this.strings.push(s) - 1; return i; }
  add(type: string, write: BlockWriter) { return this.blocks.push({ type, write }) - 1; }
  /** Резерв номера блока (для ссылок вперёд); содержимое — set(). */
  reserve(type: string) { return this.add(type, () => {}); }
  set(i: number, write: BlockWriter) { this.blocks[i]!.write = write; }
  build(roots = [0]): ArrayBuffer {
    const datas = this.blocks.map((blk) => { const b = new Bin(); blk.write(b); return b.toU8(); });
    const types = [...new Set(this.blocks.map((b) => b.type))];
    const o = new Bin();
    o.ascii('Gamebryo File Format, Version 20.2.0.7\n').u32(0x14020007).u8(1).u32(11).u32(this.blocks.length).u32(34);
    o.u8(1).u8(0).u8(1).u8(0).u8(1).u8(0); // автор, process script, export script (короткие строки «\0»)
    o.u16(types.length);
    for (const t of types) o.u32(t.length).ascii(t);
    for (const b of this.blocks) o.u16(types.indexOf(b.type));
    for (const d of datas) o.u32(d.length);
    o.u32(this.strings.length).u32(Math.max(0, ...this.strings.map((s) => s.length)));
    for (const s of this.strings) o.u32(s.length).ascii(s);
    o.u32(0); // группы
    for (const d of datas) o.bytes(d);
    o.u32(roots.length);
    for (const r of roots) o.i32(r);
    return o.toArrayBuffer();
  }
}

const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** NiAVObject (BS 34): имя, extra, контроллер, флаги u32, перенос, поворот, масштаб, свойства, коллизия. */
function av(b: Bin, name: number, t: number[], flags = 0, props: number[] = []) {
  b.u32(name).u32(0).i32(-1).u32(flags).f32s(...t, ...ID, 1).u32(props.length);
  for (const p of props) b.i32(p);
  b.i32(-1);
}
const node = (b: Bin, name: number, t: number[], kids: number[], flags = 0) => { av(b, name, t, flags); b.u32(kids.length); for (const k of kids) b.i32(k); b.u32(0); };
const transform = (b: Bin, t: number[]) => b.f32s(...ID, ...t, 1);

export interface SkinnedNifOptions {
  /** BSDismemberSkinInstance с частями тела по разбиениям (иначе NiSkinInstance без разбиения). */
  bodyParts?: number[];
}

/**
 * Скинованный «столбик» из двух квадов: нижний (z 0..10) на кости Bip01, верхний (z 10..20) на Bip01 Spine (z = 10).
 * Вершины на стыке (z = 10) — 50/50. С bodyParts: верхний квад — отдельное разбиение (например, «заглушка» 101).
 */
export function skinnedNif(o: SkinnedNifOptions = {}): ArrayBuffer {
  const f = new NifFile();
  const root = f.reserve('NiNode'), bip = f.reserve('NiNode'), spine = f.reserve('NiNode'), shape = f.reserve('NiTriShape');
  const data = f.reserve('NiTriShapeData'), inst = f.reserve(o.bodyParts ? 'BSDismemberSkinInstance' : 'NiSkinInstance'), sd = f.reserve('NiSkinData');
  const part = o.bodyParts ? f.reserve('NiSkinPartition') : -1;
  f.set(root, (b) => node(b, f.str('Scene Root'), [0, 0, 0], [bip, shape]));
  f.set(bip, (b) => node(b, f.str('Bip01'), [0, 0, 0], [spine]));
  f.set(spine, (b) => node(b, f.str('Bip01 Spine'), [0, 0, 10], []));
  f.set(shape, (b) => { av(b, f.str('Body'), [0, 0, 0]); b.i32(data).i32(inst).u32(0).i32(-1).u8(0); });
  const pos = [[-1, 0, 0], [1, 0, 0], [-1, 0, 10], [1, 0, 10], [-1, 0, 20], [1, 0, 20]];
  const tris = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4];
  f.set(data, (b) => {
    b.u32(0).u16(pos.length).u8(0).u8(0).u8(1);
    for (const p of pos) b.f32s(...p);
    b.u16(1).u8(1); // 1 набор UV; нормали есть
    for (let k = 0; k < pos.length; k++) b.f32s(0, -1, 0);
    b.f32s(0, 0, 10, 12).u8(0);
    for (const p of pos) b.f32s((p[0]! + 1) / 2, 1 - p[2]! / 20);
    b.u16(0).i32(-1);
    if (o.bodyParts) b.u16(0).u32(0).u8(0); // треугольники только в разбиении
    else { b.u16(tris.length / 3).u32(tris.length).u8(1); for (const t of tris) b.u16(t); }
    b.u16(0);
  });
  f.set(inst, (b) => {
    b.i32(sd).i32(part).i32(root).u32(2).i32(bip).i32(spine);
    if (o.bodyParts) { b.u32(o.bodyParts.length); for (const p of o.bodyParts) b.u16(1).u16(p); }
  });
  // Skin Transform кости — обратная bind-матрица относительно корня: Bip01 в нуле, Spine на z = 10
  f.set(sd, (b) => {
    transform(b, [0, 0, 0]);
    b.u32(2).u8(1);
    transform(b, [0, 0, 0]); b.f32s(0, 0, 5, 6).u16(4);
    for (const [v, w] of [[0, 1], [1, 1], [2, 0.5], [3, 0.5]]) b.u16(v!).f32(w!);
    transform(b, [0, 0, -10]); b.f32s(0, 0, 15, 6).u16(4);
    for (const [v, w] of [[2, 0.5], [3, 0.5], [4, 1], [5, 1]]) b.u16(v!).f32(w!);
  });
  if (o.bodyParts) f.set(part, (b) => {
    // два разбиения по квадам; вершины — через карту, веса и индексы костей
    const parts = [{ map: [0, 1, 2, 3], tris: [0, 1, 3, 0, 3, 2], w: [[1, 0], [1, 0], [0.5, 0.5], [0.5, 0.5]] }, { map: [2, 3, 4, 5], tris: [0, 1, 3, 0, 3, 2], w: [[0.5, 0.5], [0.5, 0.5], [0, 1], [0, 1]] }];
    b.u32(parts.length);
    for (const p of parts) {
      b.u16(4).u16(2).u16(2).u16(0).u16(2).u16(0).u16(1);
      b.u8(1); for (const v of p.map) b.u16(v);
      b.u8(1); for (const w of p.w) b.f32s(...w);
      b.u8(1); for (const t of p.tris) b.u16(t);
      b.u8(1); for (let k = 0; k < 4; k++) b.u8(0).u8(1);
    }
  });
  return f.build();
}

/** skeleton.nif: Bip01 / Bip01 Spine (как в модели) + Bip01 Head. */
export function skeletonNif(): ArrayBuffer {
  const f = new NifFile();
  const root = f.reserve('NiNode'), bip = f.reserve('NiNode'), spine = f.reserve('NiNode'), head = f.reserve('NiNode');
  f.set(root, (b) => node(b, f.str('Scene Root'), [0, 0, 0], [bip]));
  f.set(bip, (b) => node(b, f.str('Bip01'), [0, 0, 0], [spine]));
  f.set(spine, (b) => node(b, f.str('Bip01 Spine'), [0, 0, 10], [head]));
  f.set(head, (b) => node(b, f.str('Bip01 Head'), [0, 0, 8], []));
  return f.build();
}

/**
 * .kf «Turn» (2 с): Bip01 Spine поворачивается на 90° вокруг Z ключами NiTransformData (линейно),
 * Bip01 едет по X сжатым B-сплайном: 4 одинаковые точки (x = 5) -> постоянный сдвиг.
 */
export function turnKf(): ArrayBuffer {
  const f = new NifFile();
  const seq = f.reserve('NiControllerSequence'), ti = f.reserve('NiTransformInterpolator'), td = f.reserve('NiTransformData');
  const bi = f.reserve('NiBSplineCompTransformInterpolator'), bd = f.reserve('NiBSplineData'), bb = f.reserve('NiBSplineBasisData');
  const ctrl = f.str('NiTransformController');
  f.set(seq, (b) => {
    b.u32(f.str('Turn')).u32(2).u32(1);
    for (const [interp, name] of [[ti, 'Bip01 Spine'], [bi, 'Bip01']] as const) b.i32(interp).i32(-1).u8(30).u32(f.str(name)).i32(-1).u32(ctrl).i32(-1).i32(-1);
    b.f32(1).i32(-1).u32(0).f32(1).f32(0).f32(2).i32(-1).u32(f.str('Bip01'));
  });
  const BIG = 3.4028234663852886e38;
  f.set(ti, (b) => b.f32s(BIG, BIG, BIG, BIG, BIG, BIG, BIG, BIG).i32(td));
  f.set(td, (b) => {
    const h = Math.SQRT1_2;
    b.u32(2).u32(1).f32s(0, 1, 0, 0, 0).f32s(2, h, 0, 0, h);
    b.u32(0).u32(0);
  });
  f.set(bi, (b) => {
    b.f32(0).f32(2).i32(bd).i32(bb).f32s(0, 0, 0, 1, 0, 0, 0, 1).u32(0).u32(0xffff).u32(0xffff);
    b.f32s(0, 10, 0, 1, 0, 1); // перенос: смещение 0, половина диапазона 10
  });
  f.set(bd, (b) => { b.u32(0).u32(12); for (let k = 0; k < 4; k++) b.i16(16384).i16(0).i16(0); });
  f.set(bb, (b) => b.u32(4));
  return f.build();
}
