import { describe, expect, it } from 'vitest';
import { boxVisible, buildCells, growCells, visibleRanges } from '../src/renderer/cull';
import { lookAt, mulCol, perspective } from '../src/renderer/mat4';

/** Ряд из n квадратов 1×1 вдоль X (y = 0), между ними шаг 10. */
function strip(n: number) {
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * 10, v = pos.length / 3;
    pos.push(x, 0, 0, x + 1, 0, 0, x + 1, 0, 1, x, 0, 1);
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}

describe('отсечение по клеткам', () => {
  it('треугольники разложены по клеткам, перестановка обратима, рамки охватывают треугольники', () => {
    const { pos, idx } = strip(100);
    const L = buildCells(pos, idx, 50, 16)!;
    expect(L.start.length).toBe(20); // 1000 / 50
    const back = new Uint32Array(idx.length);
    for (let t = 0; t < idx.length / 3; t++) for (let j = 0; j < 3; j++) back[t * 3 + j] = L.sorted[L.slot[t]! * 3 + j]!;
    expect(Array.from(back)).toEqual(Array.from(idx));
    for (let t = 0; t < idx.length / 3; t++) {
      const c = L.cellOf[t]!, s = L.slot[t]! * 3;
      expect(s >= L.start[c]! && s < L.start[c]! + L.count[c]!).toBe(true);
      expect(pos[idx[t * 3]! * 3]!).toBeGreaterThanOrEqual(L.box[c * 6]!);
      expect(pos[idx[t * 3]! * 3]!).toBeLessThanOrEqual(L.box[c * 6 + 3]!);
    }
    expect(buildCells(pos, idx, 5000, 16)).toBeNull(); // всё в одной клетке
    expect(buildCells(pos, idx, 50)).toBeNull(); // мало треугольников
  });

  it('видны только клетки в пирамиде и ближе дальности; соседние сливаются', () => {
    const { pos, idx } = strip(100);
    const L = buildCells(pos, idx, 50, 16)!;
    // камера у начала ряда смотрит вдоль +X
    const pvm = mulCol(perspective(0.8, 1, 0.1, 5000), lookAt([-20, 5, 0.5], [100, 0, 0.5], [0, 1, 0]));
    const all = visibleRanges(L, pvm, [-20, 5, 0.5], Infinity);
    expect(all).toEqual([0, idx.length]); // всё впереди — одним участком
    const near = visibleRanges(L, pvm, [-20, 5, 0.5], 120);
    expect(near.length).toBe(2);
    expect(near[1]! / 3).toBeLessThan(idx.length / 3 / 4);
    // камера смотрит назад — ничего
    const back = mulCol(perspective(0.8, 1, 0.1, 5000), lookAt([-20, 5, 0.5], [-100, 0, 0.5], [0, 1, 0]));
    expect(visibleRanges(L, back, [-20, 5, 0.5], Infinity)).toEqual([]);
    expect(boxVisible(Float32Array.of(-1, -1, -1, 1, 1, 1), 0, back, null, Infinity)).toBe(false);
  });

  it('сдвинутый объект расширяет рамку своей клетки', () => {
    const { pos, idx } = strip(100);
    const L = buildCells(pos, idx, 50, 16)!;
    const c = L.cellOf[0]!;
    pos[1] = 30; // вершина 0 поднята
    growCells(L, pos, idx, 0, 1);
    expect(L.box[c * 6 + 4]).toBe(30);
  });
});
