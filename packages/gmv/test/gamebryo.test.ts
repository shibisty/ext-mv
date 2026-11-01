import { describe, expect, it } from 'vitest';
import type { Model, NodeMotion } from '../src/index';
import { convertNif, hasSkin, parseSkin, parseHeader } from '../src/engines/gamebryo/nif';
import { bspline, parseSequences } from '../src/engines/gamebryo/kf';
import { skeletonNif, skinnedNif, turnKf } from './helpers/nif';

/** Вершины меша в текущей позе скелета. */
function posed(m: Model, mi = 0): number[][] {
  const me = m.meshes[mi]!, sk = m.skeleton!, out: number[][] = [];
  for (let v = 0; v < me.vertexCount; v++) {
    const o = [0, 0, 0], x = me.pos[v * 3]!, y = me.pos[v * 3 + 1]!, z = me.pos[v * 3 + 2]!;
    for (let k = 0; k < 4; k++) {
      const w = me.weight[v * 4 + k]!, M = sk.skinV[me.bone[v * 4 + k]!]!;
      if (!w) continue;
      for (let c = 0; c < 3; c++) o[c] += w * (M[c]! * x + M[4 + c]! * y + M[8 + c]! * z + M[12 + c]!);
    }
    out.push(o);
  }
  return out;
}
const close = (a: number[][], b: number[][]) => a.forEach((p, i) => p.forEach((v, c) => expect(v).toBeCloseTo(b[i]![c]!, 4)));
const file = (buf: ArrayBuffer, name: string) => ({ name, arrayBuffer: async () => buf }) as never;

describe('Gamebryo NIF: скининг и анимации', () => {
  it('NiSkinInstance + NiSkinData: веса, bind-поза совпадает с исходными вершинами', () => {
    const buf = skinnedNif();
    expect(hasSkin(buf)).toBe(true);
    const h = parseHeader(buf), skin = parseSkin(buf, h, h.blocks.findIndex((b) => b.type === 'NiSkinInstance'));
    expect(skin.bones).toHaveLength(2);
    expect(skin.weights.map((l) => l.length)).toEqual([4, 4]);
    const m = convertNif(buf);
    expect(m.meshes).toHaveLength(1);
    expect(Array.from(m.meshes[0]!.weight.slice(8, 10))).toEqual([0.5, 0.5]); // вершина 2 — на стыке
    m.skeleton!.pose(null, 0, false);
    close(posed(m), [[-1, 0, 0], [1, 0, 0], [-1, 0, 10], [1, 0, 10], [-1, 0, 20], [1, 0, 20]]);
    expect(m.bounds.max[2]).toBeCloseTo(20);
  });

  it('skeleton.nif: кости модели заменяются узлами скелета по имени', () => {
    const m = convertNif(skinnedNif(), { skeleton: skeletonNif(), skeletonName: 'skeleton.nif' });
    expect(m.info.join('\n')).toMatch(/Скелет: skeleton\.nif \(4 узлов, совпало с моделью 3\)/);
    m.skeleton!.pose(null, 0, false);
    close(posed(m), [[-1, 0, 0], [1, 0, 0], [-1, 0, 10], [1, 0, 10], [-1, 0, 20], [1, 0, 20]]);
  });

  it('.kf: NiTransformData (кватернионы) и сжатый B-сплайн двигают кости', async () => {
    const m = convertNif(skinnedNif(), { skeleton: skeletonNif() });
    const [mo] = (await m.loadMotions!(file(turnKf(), 'turn.kf'))) as NodeMotion[];
    expect(mo!.name).toBe('Turn');
    expect(mo!.duration).toBe(2);
    expect(mo!.chan.size).toBe(2);
    m.skeleton!.pose(mo!, 2, false);
    // Bip01 сдвинут по X на 5; Spine повёрнут на 90° вокруг Z: верхние вершины (x = ±1) уходят в y = ±1
    const p = posed(m);
    expect(p[0]![0]).toBeCloseTo(4, 3);
    expect(p[4]![0]).toBeCloseTo(5, 3);
    expect(p[4]![1]).toBeCloseTo(-1, 3);
    expect(p[5]![1]).toBeCloseTo(1, 3);
    expect(p[5]![2]).toBeCloseTo(20, 3);
  });

  it('.kf без подходящих костей — ошибка', async () => {
    const m = convertNif(skinnedNif());
    expect(parseSequences(turnKf(), new Map(), 'x')).toEqual([]);
    await expect(m.loadMotions!(file(skinnedNif(), 'body.nif'))).rejects.toThrow(/NiControllerSequence/);
  });

  it('BSDismemberSkinInstance: треугольники из разбиений, заглушки расчленения скрыты', () => {
    const all = convertNif(skinnedNif({ bodyParts: [0, 3] }));
    expect(all.meshes[0]!.indices.length).toBe(12);
    const capped = convertNif(skinnedNif({ bodyParts: [0, 101] }));
    expect(capped.meshes[0]!.indices.length).toBe(6);
    expect(() => convertNif(skinnedNif({ bodyParts: [101, 201] }))).toThrow(/геометрии/);
  });

  it('B-сплайн 3-й степени: концы — крайние точки, постоянные точки — константа', () => {
    const pts = [0, 3, 7, 2, 9];
    expect(bspline((i) => pts[i]!, 5, 1, 0)[0]).toBeCloseTo(0);
    expect(bspline((i) => pts[i]!, 5, 1, 1)[0]).toBeCloseTo(9);
    expect(bspline(() => 4, 6, 1, 0.37)[0]).toBeCloseTo(4);
    expect(bspline((i) => i, 2, 1, 0.5)[0]).toBeCloseTo(0.5); // меньше 4 точек — линейно
  });
});
