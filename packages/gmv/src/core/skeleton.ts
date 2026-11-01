// Скелет из иерархии узлов (assimp, NIF, RenderWare, MD5, PSK, Cast, GoldSrc).
import { compose, matToTRS, mulColInto, sampleQuat, sampleVec, type TRS } from './math';
import type { Motion, SkeletonRuntime } from './types';

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
    let tick = 0;
    if (m) {
      const d = m.duration;
      const tt = loop ? (d > 0 ? ((time % d) + d) % d : 0) : Math.min(Math.max(time, 0), d);
      tick = tt * m.tps;
    }
    for (let i = 0; i < this.n; i++) {
      const nd = this.nodes[i]!, ch = m ? m.chan.get(i) : undefined, rest = this.rest[i]!;
      let L: ArrayLike<number> = nd.local;
      if (ch) {
        compose(
          ch.pos ? sampleVec(ch.pos, tick) : rest.t,
          ch.rot ? sampleQuat(ch.rot, tick) : rest.q,
          ch.scl ? sampleVec(ch.scl, tick) : rest.s,
          this.tmp,
        );
        L = this.tmp;
      }
      const W = this.w64[i]!;
      if (nd.parent < 0) W.set(L); else mulColInto(this.w64[nd.parent]!, L, W);
      this.worldV[i]!.set(W);
      if (nd.offset) { mulColInto(W, nd.offset, this.tmp2); this.skinV[i]!.set(this.tmp2); }
      else this.skinV[i]!.set(W);
    }
  }
}
