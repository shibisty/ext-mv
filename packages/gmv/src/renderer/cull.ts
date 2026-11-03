// Отсечение невидимого для больших уровней: треугольники меша раскладываются по клеткам пространственной сетки
// (порядок индексов для рисования — по клеткам), у каждой клетки — рамка. В кадре рисуются только клетки, попавшие
// в пирамиду видимости и ближе дальности прорисовки; соседние видимые клетки сливаются в один вызов.
// Исходный порядок индексов не меняется: на него ссылаются экземпляры объектов (скрытие, подсветка, поворот).

export interface CellLayout {
  /** Индексы, переставленные по клеткам. */
  sorted: Uint16Array | Uint32Array;
  /** Для каждого исходного треугольника — его номер в sorted. */
  slot: Uint32Array;
  /** Для каждого исходного треугольника — его клетка. */
  cellOf: Uint32Array;
  /** Клетки: начало и число индексов в sorted, рамка (min xyz, max xyz). */
  start: Uint32Array;
  count: Uint32Array;
  box: Float32Array;
}

/** Рамка всего меша (одна клетка) — для мелких мешей. */
export function meshBox(pos: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const b = Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  for (let i = 0; i < indices.length; i++) {
    const o = indices[i]! * 3;
    for (let k = 0; k < 3; k++) { const v = pos[o + k]!; if (v < b[k]!) b[k] = v; if (v > b[3 + k]!) b[3 + k] = v; }
  }
  return b;
}

/**
 * Раскладка треугольников по клеткам сетки с шагом cell (по каждой оси не более 64 клеток).
 * null — меш целиком помещается в клетку или слишком мал (рисуется одним вызовом).
 */
export function buildCells(pos: ArrayLike<number>, indices: Uint16Array | Uint32Array, cell: number, minTris = 4096): CellLayout | null {
  const nt = Math.floor(indices.length / 3);
  if (nt < minTris || !(cell > 0)) return null;
  const all = meshBox(pos, indices);
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.min(64, Math.ceil((all[3 + k]! - all[k]!) / cell))));
  if (dims[0]! * dims[1]! * dims[2]! < 2) return null;
  const key = new Uint32Array(nt);
  for (let t = 0; t < nt; t++) {
    let k = 0;
    for (let a = 2; a >= 0; a--) {
      const c = (pos[indices[t * 3]! * 3 + a]! + pos[indices[t * 3 + 1]! * 3 + a]! + pos[indices[t * 3 + 2]! * 3 + a]!) / 3;
      const q = Math.min(dims[a]! - 1, Math.max(0, Math.floor((c - all[a]!) / cell)));
      k = k * dims[a]! + q;
    }
    key[t] = k;
  }
  // подсчётная сортировка по ключу клетки
  const nCells = dims[0]! * dims[1]! * dims[2]!, cnt = new Uint32Array(nCells + 1);
  for (let t = 0; t < nt; t++) cnt[key[t]! + 1]!++;
  const used: number[] = [];
  for (let c = 0; c < nCells; c++) if (cnt[c + 1]) used.push(c);
  for (let c = 0; c < nCells; c++) cnt[c + 1]! += cnt[c]!;
  const remap = new Int32Array(nCells).fill(-1);
  used.forEach((c, i) => { remap[c] = i; });
  const n = used.length, start = new Uint32Array(n), count = new Uint32Array(n), box = new Float32Array(n * 6);
  used.forEach((c, i) => { start[i] = cnt[c]! * 3; count[i] = (cnt[c + 1]! - cnt[c]!) * 3; box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], i * 6); });
  const fill = cnt.slice(0, nCells), sorted = indices instanceof Uint32Array ? new Uint32Array(nt * 3) : new Uint16Array(nt * 3);
  const slot = new Uint32Array(nt), cellOf = new Uint32Array(nt);
  for (let t = 0; t < nt; t++) {
    const s = fill[key[t]!]!++, ci = remap[key[t]!]!;
    slot[t] = s; cellOf[t] = ci;
    for (let j = 0; j < 3; j++) {
      const v = indices[t * 3 + j]!;
      sorted[s * 3 + j] = v;
      for (let k = 0; k < 3; k++) { const x = pos[v * 3 + k]!, o = ci * 6; if (x < box[o + k]!) box[o + k] = x; if (x > box[o + 3 + k]!) box[o + 3 + k] = x; }
    }
  }
  return { sorted, slot, cellOf, start, count, box };
}

/** Расширить рамки клеток треугольников [t0, t1) по текущим вершинам (объект сдвинут или повёрнут). */
export function growCells(L: CellLayout, pos: ArrayLike<number>, indices: ArrayLike<number>, t0: number, t1: number): void {
  for (let t = t0; t < t1; t++) {
    const o = L.cellOf[t]! * 6;
    for (let j = 0; j < 3; j++) {
      const v = indices[t * 3 + j]! * 3;
      for (let k = 0; k < 3; k++) { const x = pos[v + k]!; if (x < L.box[o + k]!) L.box[o + k] = x; if (x > L.box[o + 3 + k]!) L.box[o + 3 + k] = x; }
    }
  }
}

/**
 * Видимость рамки: pvm — проекция × вид × модель (column-major), eye — глаз в координатах модели, far — дальность
 * (рамка дальше — не видна). Рамка вне пирамиды, если все 8 углов по одну сторону одной из плоскостей отсечения.
 */
export function boxVisible(b: ArrayLike<number>, o: number, pvm: ArrayLike<number>, eye: ArrayLike<number> | null, far: number): boolean {
  if (eye && far < Infinity) {
    let d2 = 0;
    for (let k = 0; k < 3; k++) { const v = eye[k]!, lo = b[o + k]!, hi = b[o + 3 + k]!, d = v < lo ? lo - v : v > hi ? v - hi : 0; d2 += d * d; }
    if (d2 > far * far) return false;
  }
  let out = 0x3f;
  for (let c = 0; c < 8 && out; c++) {
    const x = b[o + (c & 1 ? 3 : 0)]!, y = b[o + 1 + (c & 2 ? 3 : 0)]!, z = b[o + 2 + (c & 4 ? 3 : 0)]!;
    const X = pvm[0]! * x + pvm[4]! * y + pvm[8]! * z + pvm[12]!, Y = pvm[1]! * x + pvm[5]! * y + pvm[9]! * z + pvm[13]!;
    const Z = pvm[2]! * x + pvm[6]! * y + pvm[10]! * z + pvm[14]!, W = pvm[3]! * x + pvm[7]! * y + pvm[11]! * z + pvm[15]!;
    let m = 0;
    if (X < -W) m |= 1; if (X > W) m |= 2; if (Y < -W) m |= 4; if (Y > W) m |= 8; if (Z < -W) m |= 16; if (Z > W) m |= 32;
    out &= m;
  }
  return out === 0;
}

/** Видимые участки sorted: [начало, число индексов] с объединением соседних клеток. */
export function visibleRanges(L: CellLayout, pvm: ArrayLike<number>, eye: ArrayLike<number> | null, far: number, out: number[] = []): number[] {
  out.length = 0;
  const n = L.start.length;
  for (let i = 0; i < n; i++) {
    if (!boxVisible(L.box, i * 6, pvm, eye, far)) continue;
    const s = L.start[i]!, c = L.count[i]!, k = out.length;
    if (k && out[k - 2]! + out[k - 1]! === s) out[k - 1]! += c; else out.push(s, c);
  }
  return out;
}
