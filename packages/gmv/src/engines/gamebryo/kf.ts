// Анимации Gamebryo (.kf и последовательности внутри .nif): NiControllerSequence -> NodeMotion.
// Интерполяторы: NiTransformInterpolator + NiTransformData (ключи), NiBSpline(Comp)TransformInterpolator (B-сплайн 3-й степени).
// Кости сопоставляются по имени узла (Node Name в Controlled Block).
import type { Keys, NodeChannel, NodeMotion } from '../../core/types';
import { parseHeader, type NifHeader } from './nif';

/** Частота выборки B-сплайнов в ключи, кадров/с. */
const SPLINE_FPS = 30;
const FLT_MAX = 3.4e38;

class R {
  readonly dv: DataView;
  constructor(buf: ArrayBuffer, public pos: number, public end: number) { this.dv = new DataView(buf); }
  b() { return this.dv.getUint8(this.pos++); }
  w() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  d() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  f() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  s() { const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  skip(n: number) { this.pos += n; }
}

interface Ctx { buf: ArrayBuffer; h: NifHeader }
const reader = (c: Ctx, idx: number, type?: RegExp): R | null => {
  const b = c.h.blocks[idx];
  return b && (!type || type.test(b.type)) ? new R(c.buf, b.start, b.end) : null;
};
const str = (h: NifHeader, i: number) => (i >= 0 && i < h.strings.length ? h.strings[i]! : '');

/** Статическое значение NiQuatTransform: перенос, поворот (w,x,y,z), масштаб; FLT_MAX — «не задано». */
function quatTransform(r: R) {
  const t = [r.f(), r.f(), r.f()], q = [r.f(), r.f(), r.f(), r.f()], s = r.f();
  return { t: Math.abs(t[0]!) < FLT_MAX ? t : null, q: Math.abs(q[0]!) < FLT_MAX ? q : null, s: Math.abs(s) < FLT_MAX ? s : null };
}

/** Поворот из углов Эйлера XYZ (радианы) -> кватернион (w,x,y,z), порядок Rx·Ry·Rz. */
function eulerQuat(x: number, y: number, z: number): number[] {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2), cy = Math.cos(y / 2), sy = Math.sin(y / 2), cz = Math.cos(z / 2), sz = Math.sin(z / 2);
  return [cx * cy * cz - sx * sy * sz, sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz];
}

function floatKeys(r: R): Keys<number> {
  const n = r.d(), out: Keys<number> = [];
  if (!n) return out;
  const it = r.d();
  for (let k = 0; k < n; k++) { const t = r.f(), v = r.f(); if (it === 2) r.skip(8); else if (it === 3) r.skip(12); out.push([t, v]); }
  return out;
}
const sampleFloat = (keys: Keys<number>, t: number): number => {
  if (!keys.length) return 0;
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let k = 1; k < keys.length; k++) if (t <= keys[k]![0]) { const [t0, a] = keys[k - 1]!, [t1, b] = keys[k]!; return a + ((b - a) * (t - t0)) / (t1 - t0 || 1); }
  return keys[keys.length - 1]![1];
};

/** NiTransformData (NiKeyframeData): ключи поворота (кватернионы или XYZ), переноса, масштаба. */
function transformData(r: R): NodeChannel {
  let rot: Keys<number[]> | null = null, pos: Keys<number[]> | null = null, scl: Keys<number[]> | null = null;
  const nr = r.d();
  if (nr) {
    const type = r.d();
    if (type !== 4) {
      rot = [];
      for (let k = 0; k < nr; k++) { const t = r.f(); rot.push([t, [r.f(), r.f(), r.f(), r.f()]]); if (type === 3) r.skip(12); }
    } else {
      const ax = [floatKeys(r), floatKeys(r), floatKeys(r)];
      const times = [...new Set(ax.flatMap((a) => a.map((k) => k[0])))].sort((a, b) => a - b);
      rot = times.map((t) => [t, eulerQuat(sampleFloat(ax[0]!, t), sampleFloat(ax[1]!, t), sampleFloat(ax[2]!, t))]);
      if (!rot.length) rot = null;
    }
  }
  const nt = r.d();
  if (nt) {
    const it = r.d();
    pos = [];
    for (let k = 0; k < nt; k++) { const t = r.f(); pos.push([t, [r.f(), r.f(), r.f()]]); if (it === 2) r.skip(24); else if (it === 3) r.skip(12); }
  }
  const sk = floatKeys(r);
  if (sk.length) scl = sk.map(([t, v]) => [t, [v, v, v]]);
  return { pos, rot, scl };
}

/** Значение открытого равномерного B-сплайна 3-й степени (n контрольных точек размерности dim) при u ∈ [0, 1]. */
export function bspline(cp: (i: number, c: number) => number, n: number, dim: number, u: number): number[] {
  if (n < 4) { // вырожденный случай: линейно между точками
    const x = Math.min(Math.max(u, 0), 1) * Math.max(0, n - 1), i = Math.min(Math.floor(x), Math.max(0, n - 2)), a = x - i;
    return Array.from({ length: dim }, (_, c) => (n > 1 ? cp(i, c) * (1 - a) + cp(i + 1, c) * a : cp(0, c)));
  }
  const m = n - 3, t = Math.min(Math.max(u, 0), 1) * m, knot = (i: number) => Math.min(Math.max(i - 3, 0), m);
  const k = Math.min(Math.floor(t) + 3, n - 1);
  const d = [0, 1, 2, 3].map((j) => Array.from({ length: dim }, (_, c) => cp(j + k - 3, c)));
  for (let r = 1; r <= 3; r++)
    for (let j = 3; j >= r; j--) {
      const i = j + k - 3, den = knot(i + 4 - r) - knot(i), a = den ? (t - knot(i)) / den : 0;
      for (let c = 0; c < dim; c++) d[j]![c] = (1 - a) * d[j - 1]![c]! + a * d[j]![c]!;
    }
  return d[3]!;
}

/** NiBSplineTransformInterpolator / NiBSplineCompTransformInterpolator -> ключи с шагом 1/SPLINE_FPS. */
function splineChannel(c: Ctx, r: R, comp: boolean, t0: number): NodeChannel | null {
  const start = r.f(), stop = r.f(), dataRef = r.i(), basisRef = r.i();
  const st = quatTransform(r), handles = [r.d(), r.d(), r.d()]; // перенос, поворот, масштаб
  const range = comp ? [r.f(), r.f(), r.f(), r.f(), r.f(), r.f()] : null; // смещение и половина диапазона: перенос, поворот, масштаб
  const dr = reader(c, dataRef, /^NiBSplineData$/), br = reader(c, basisRef, /^NiBSplineBasisData$/);
  const ch: NodeChannel = { pos: st.t ? [[0, st.t]] : null, rot: st.q ? [[0, st.q]] : null, scl: st.s !== null ? [[0, [st.s, st.s, st.s]]] : null };
  if (!dr || !br) return ch;
  const nf = dr.d(), floats = new Float32Array(nf);
  for (let k = 0; k < nf; k++) floats[k] = dr.f();
  const nc = dr.d(), shorts = new Int16Array(nc);
  for (let k = 0; k < nc; k++) shorts[k] = dr.s();
  const n = br.d(), dur = Math.max(0, stop - start), steps = Math.max(1, Math.round(dur * SPLINE_FPS));
  const track = (which: number, dim: number): Keys<number[]> | null => {
    const hd = handles[which]!;
    if (hd === 0xffff || hd === 0xffffffff || !n) return null;
    const cp = comp
      ? (i: number, k: number) => range![which * 2]! + (range![which * 2 + 1]! * (shorts[hd + i * dim + k] ?? 0)) / 32767
      : (i: number, k: number) => floats[hd + i * dim + k] ?? 0;
    const keys: Keys<number[]> = [];
    for (let s = 0; s <= steps; s++) keys.push([start - t0 + (dur * s) / steps, bspline(cp, n, dim, s / steps)]);
    return keys;
  };
  const pos = track(0, 3), rot = track(1, 4), scl = track(2, 1);
  if (pos) ch.pos = pos;
  if (rot) ch.rot = rot.map(([t, q]) => { const l = Math.hypot(...q) || 1; return [t, q.map((v) => v / l)]; });
  if (scl) ch.scl = scl.map(([t, [v]]) => [t, [v!, v!, v!]]);
  return ch;
}

function interpolator(c: Ctx, idx: number, t0: number): NodeChannel | null {
  const blk = c.h.blocks[idx];
  if (!blk) return null;
  const r = new R(c.buf, blk.start, blk.end);
  if (blk.type === 'NiTransformInterpolator') {
    const st = quatTransform(r), data = r.i(), dr = reader(c, data, /^Ni(Transform|Keyframe)Data$/);
    const ch: NodeChannel = dr ? transformData(dr) : { pos: null, rot: null, scl: null };
    const shift = (k: Keys<number[]> | null) => (k ? k.map(([t, v]) => [t - t0, v] as [number, number[]]) : null);
    ch.pos = shift(ch.pos) ?? (st.t ? [[0, st.t]] : null);
    ch.rot = shift(ch.rot) ?? (st.q ? [[0, st.q]] : null);
    ch.scl = shift(ch.scl) ?? (st.s !== null ? [[0, [st.s, st.s, st.s]]] : null);
    return ch;
  }
  if (blk.type === 'NiBSplineCompTransformInterpolator') return splineChannel(c, r, true, t0);
  if (blk.type === 'NiBSplineTransformInterpolator') return splineChannel(c, r, false, t0);
  return null;
}

/** Все NiControllerSequence файла как анимации узлов; byName — имя узла (нижний регистр) -> индекс в скелете. */
export function parseSequences(buf: ArrayBuffer, byName: Map<string, number>, source: string): NodeMotion[] {
  let h: NifHeader;
  try { h = parseHeader(buf); } catch { return []; }
  const c: Ctx = { buf, h }, out: NodeMotion[] = [];
  h.blocks.forEach((blk) => {
    if (blk.type !== 'NiControllerSequence') return;
    try {
      const r = new R(buf, blk.start, blk.end), name = str(h, r.i()), nb = r.d();
      r.d(); // array grow by
      const cbs: Array<{ interp: number; node: string; ctrl: string }> = [];
      for (let k = 0; k < nb; k++) {
        const interp = r.i();
        r.i(); // контроллер
        r.b(); // приоритет
        const node = str(h, r.i());
        r.i(); // тип свойства
        const ctrl = str(h, r.i());
        r.i(); r.i(); // id контроллера, id интерполятора
        cbs.push({ interp, node, ctrl });
      }
      r.f(); r.i(); r.d(); r.f(); // вес, текстовые ключи, цикл, частота
      const start = r.f(), stop = r.f(), chan = new Map<number, NodeChannel>();
      r.i(); // менеджер
      const accum = str(h, r.i());
      for (const cb of cbs) {
        if (cb.ctrl && !/Transform|Keyframe/.test(cb.ctrl)) continue;
        const ni = byName.get(cb.node.toLowerCase());
        if (ni === undefined || chan.has(ni)) continue;
        const ch = interpolator(c, cb.interp, start);
        if (ch && (ch.pos || ch.rot || ch.scl)) chan.set(ni, ch);
      }
      // корень накопления (Bip01): его движение в игре уходит в перемещение актёра, а анимация задаёт Bip01 NonAccum
      // относительно него — поэтому на время анимации корень стоит в начале координат
      const ai = accum ? byName.get(accum.toLowerCase()) : undefined;
      if (chan.size && ai !== undefined && !chan.has(ai)) chan.set(ai, { pos: [[0, [0, 0, 0]]], rot: [[0, [1, 0, 0, 0]]], scl: null });
      if (chan.size) {
        const duration = Math.max(0, stop - start);
        out.push({ kind: 'node', name: name || `sequence ${out.length}`, tps: 1, chan, duration, frames: Math.round(duration * SPLINE_FPS) + 1, source });
      }
    } catch (e) { console.warn('NiControllerSequence:', e); }
  });
  return out;
}
