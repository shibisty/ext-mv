// Скелет из иерархии узлов (assimp, NIF, RenderWare, MD5, PSK, Cast, GoldSrc).
import { compose, matToTRS, mulColInto, sampleQuat, sampleVec, type TRS } from './math';
import type { Keys, Motion, SkeletonRuntime } from './types';

export interface SkeletonNode {
  name: string;
  parent: number;
  /** Локальная матрица (column-major). */
  local: ArrayLike<number>;
  /** Обратная bind-матрица кости (offset); null — узел не кость, skin = world. */
  offset: ArrayLike<number> | null;
  /** Служебный узел (меш, bind-смещение): не рисуется линией скелета. */
  helper?: boolean;
}

/** q·r (кватернионы [w, x, y, z]). */
function qmul(q: ArrayLike<number>, r: ArrayLike<number>): number[] {
  return [
    q[0]! * r[0]! - q[1]! * r[1]! - q[2]! * r[2]! - q[3]! * r[3]!,
    q[0]! * r[1]! + q[1]! * r[0]! + q[2]! * r[3]! - q[3]! * r[2]!,
    q[0]! * r[2]! - q[1]! * r[3]! + q[2]! * r[0]! + q[3]! * r[1]!,
    q[0]! * r[3]! + q[1]! * r[2]! - q[2]! * r[1]! + q[3]! * r[0]!,
  ];
}

/** Канал в точке сетки поз: билинейно по 4 соседним кадрам (перенос — линейно, поворот — нормированная сумма). */
function gridSample(c: { pos: Keys<number[]> | null; rot: Keys<number[]> | null }, g: { cols: number; rows: number; x: number; y: number }): { t: number[] | null; q: number[] | null } {
  const cx = Math.max(0, Math.min(g.cols - 1, g.x)), cy = Math.max(0, Math.min(g.rows - 1, g.y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(g.cols - 1, x0 + 1), y1 = Math.min(g.rows - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
  const taps: Array<[number, number]> = [[y0 * g.cols + x0, (1 - fx) * (1 - fy)], [y0 * g.cols + x1, fx * (1 - fy)], [y1 * g.cols + x0, (1 - fx) * fy], [y1 * g.cols + x1, fx * fy]];
  let t: number[] | null = null, q: number[] | null = null;
  if (c.pos) { t = [0, 0, 0]; for (const [f, w] of taps) { if (!w) continue; const v = sampleVec(c.pos, f); for (let k = 0; k < 3; k++) t[k] += w * v[k]!; } }
  if (c.rot) {
    q = [0, 0, 0, 0];
    let ref: number[] | null = null;
    for (const [f, w] of taps) {
      if (!w) continue;
      const v = sampleQuat(c.rot, f);
      if (!ref) ref = v;
      const sgn = ref[0]! * v[0]! + ref[1]! * v[1]! + ref[2]! * v[2]! + ref[3]! * v[3]! < 0 ? -w : w;
      for (let k = 0; k < 4; k++) q[k] += sgn * v[k]!;
    }
    const n = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
    q = q.map((v) => v / n);
  }
  return { t, q };
}

export class NodeSkeleton implements SkeletonRuntime {
  readonly n: number;
  readonly nodes: SkeletonNode[];
  readonly parent: number[];
  readonly world: Float32Array;
  readonly skin: Float32Array;
  readonly worldV: Float32Array[];
  readonly skinV: Float32Array[];
  private readonly rest: TRS[];
  private readonly w64: Float64Array[];
  private readonly tmp = new Float64Array(16);
  private readonly tmp2 = new Float64Array(16);

  constructor(nodes: SkeletonNode[]) {
    const n = (this.n = nodes.length);
    this.nodes = nodes;
    this.parent = nodes.map((x) => (x.helper ? -1 : x.parent));
    this.rest = nodes.map((nd) => matToTRS(nd.local));
    this.world = new Float32Array(16 * n);
    this.skin = new Float32Array(16 * n);
    const view = (a: Float32Array) => Array.from({ length: n }, (_, i) => a.subarray(16 * i, 16 * i + 16));
    this.worldV = view(this.world);
    this.skinV = view(this.skin);
    this.w64 = Array.from({ length: n }, () => new Float64Array(16));
  }

  pose(motion: Motion | null, time: number, loop: boolean): void {
    const m = motion && motion.kind === 'node' ? motion : null;
    const tickOf = (x: { duration: number; tps: number }): number => {
      const d = x.duration, tt = loop ? (d > 0 ? ((time % d) + d) % d : 0) : Math.min(Math.max(time, 0), d);
      return tt * x.tps;
    };
    const tick = m ? tickOf(m) : 0;
    const layers = m?.layers?.length ? m.layers.map((l) => ({ l, tick: l.frame ?? tickOf(l.motion) })) : null;
    for (let i = 0; i < this.n; i++) {
      const nd = this.nodes[i]!, ch = m ? m.chan.get(i) : undefined, rest = this.rest[i]!;
      let L: ArrayLike<number> = nd.local;
      if (ch || layers) {
        let t: ArrayLike<number> = ch?.pos ? sampleVec(ch.pos, tick) : rest.t, q: ArrayLike<number> = ch?.rot ? sampleQuat(ch.rot, tick) : rest.q;
        const s = ch?.scl ? sampleVec(ch.scl, tick) : rest.s;
        let touched = !!ch;
        if (layers) for (const { l, tick: lt } of layers) {
          const c = l.motion.chan.get(i);
          if (!c || (l.mask && !l.mask.has(i)) || (l.fill && ch)) continue;
          touched = true;
          if (l.grid && !c.add) { const g = gridSample(c, l.grid); if (g.t) t = g.t; if (g.q) q = g.q; continue; }
          if (c.add) {
            if (c.add.pos) { const d = sampleVec(c.add.pos, lt); t = [t[0]! + d[0]!, t[1]! + d[1]!, t[2]! + d[2]!]; }
            if (c.add.rot) q = qmul(q, sampleQuat(c.add.rot, lt));
          } else {
            if (c.pos) t = sampleVec(c.pos, lt);
            if (c.rot) q = sampleQuat(c.rot, lt);
          }
        }
        if (touched) { compose(t, q, s, this.tmp); L = this.tmp; }
      }
      const W = this.w64[i]!;
      if (nd.parent < 0) W.set(L); else mulColInto(this.w64[nd.parent]!, L, W);
      this.worldV[i]!.set(W);
      if (nd.offset) { mulColInto(W, nd.offset, this.tmp2); this.skinV[i]!.set(this.tmp2); }
      else this.skinV[i]!.set(W);
    }
  }
}
