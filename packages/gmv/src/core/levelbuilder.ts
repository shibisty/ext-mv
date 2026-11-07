// Сборка уровня из экземпляров моделей: экземпляры складываются в общие меши по материалу (массивы выделяются один раз в конце),
// сцена InstancedScene хранит прототипы и расстановку (для выделения и скрытия объектов).
import type { InstancedScene, Mesh, PlacementRange } from './types';

/** Метка-ромб (свет, частицы): 6 вершин, 8 граней. */
export function markerMesh(name: string, size: number, color: number[]): Mesh {
  const s = size, P = [s, 0, 0, -s, 0, 0, 0, s, 0, 0, -s, 0, 0, 0, s, 0, 0, -s];
  const I = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  const pos = Float32Array.from(P), nor = Float32Array.from(P.map((v) => Math.sign(v)));
  return { name, texture: '', vertexCount: 6, pos, nor, uv: new Float32Array(12), bone: new Float32Array(0), weight: new Float32Array(0), indices: Uint16Array.from(I), skinned: false, color };
}

interface Group { index: number; key: string; name: string; proto: Mesh; hidden: boolean; nV: number; nI: number; items: Array<{ p: Mesh; M: ArrayLike<number>; flip: boolean }> }

/** Сборка сцены: экземпляры складываются в общие меши по материалу; массивы выделяются один раз в конце. */
export class LevelBuilder {
  readonly groups = new Map<string, Group>();
  readonly scene: InstancedScene = { meshes: [], protos: [], placements: [] };
  private readonly protoParts: number[][] = [];
  tris = 0;

  private group(key: string, name: string, p: Mesh, hidden: boolean): Group {
    let g = this.groups.get(key);
    if (!g) { g = { index: this.groups.size, key, name, proto: p, hidden, nV: 0, nI: 0, items: [] }; this.groups.set(key, g); }
    return g;
  }

  /** Прототип: части модели; kind — префикс ключа групп (трава отдельно от статики, чтобы её можно было скрыть). */
  proto(name: string, parts: Mesh[], kind: string, label: (p: Mesh) => string, hidden = false): number {
    const gs = parts.map((p) => this.group(`${kind}|${p.texture}|${p.material ?? ''}|${p.color?.join(',') ?? ''}`, label(p), p, hidden));
    this.protoParts.push(gs.map((g) => g.index));
    this.scene.protos.push({ name, parts: parts.map((p, i) => ({ mesh: gs[i]!.index, pos: p.pos, nor: p.nor, uv: p.uv, indices: Uint32Array.from(p.indices) })) });
    this.groupsByIndex = null;
    return this.scene.protos.length - 1;
  }

  private groupsByIndex: Group[] | null = null;

  place(pi: number, parts: Mesh[], M: ArrayLike<number>, name: string, layer: string): void {
    const byIndex = (this.groupsByIndex ??= [...this.groups.values()]);
    const det = M[0]! * (M[5]! * M[10]! - M[6]! * M[9]!) - M[1]! * (M[4]! * M[10]! - M[6]! * M[8]!) + M[2]! * (M[4]! * M[9]! - M[5]! * M[8]!);
    const ranges: PlacementRange[] = [];
    this.protoParts[pi]!.forEach((gi, partIndex) => {
      const g = byIndex[gi]!, p = parts[partIndex]!;
      ranges.push({ mesh: gi, part: partIndex, vStart: g.nV, vCount: p.vertexCount, iStart: g.nI, iCount: p.indices.length });
      g.items.push({ p, M, flip: det < 0 });
      g.nV += p.vertexCount; g.nI += p.indices.length;
      this.tris += p.indices.length / 3;
    });
    this.scene.placements.push({ proto: pi, name, pose: Array.from(M), group: layer, ranges });
  }

  build(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const g of this.groups.values()) {
      const pos = new Float32Array(g.nV * 3), nor = new Float32Array(g.nV * 3), uv = new Float32Array(g.nV * 2);
      const indices = g.nV > 65535 ? new Uint32Array(g.nI) : new Uint16Array(g.nI);
      let v0 = 0, i0 = 0;
      for (const { p, M, flip } of g.items) {
        const n = p.vertexCount;
        for (let i = 0; i < n; i++) {
          const x = p.pos[i * 3]!, y = p.pos[i * 3 + 1]!, z = p.pos[i * 3 + 2]!, o = (v0 + i) * 3;
          pos[o] = x * M[0]! + y * M[4]! + z * M[8]! + M[12]!; pos[o + 1] = x * M[1]! + y * M[5]! + z * M[9]! + M[13]!; pos[o + 2] = x * M[2]! + y * M[6]! + z * M[10]! + M[14]!;
          const nx = p.nor[i * 3]!, ny = p.nor[i * 3 + 1]!, nz = p.nor[i * 3 + 2]!;
          const ax = nx * M[0]! + ny * M[4]! + nz * M[8]!, ay = nx * M[1]! + ny * M[5]! + nz * M[9]!, az = nx * M[2]! + ny * M[6]! + nz * M[10]!, l = Math.hypot(ax, ay, az) || 1;
          nor[o] = ax / l; nor[o + 1] = ay / l; nor[o + 2] = az / l;
          uv[(v0 + i) * 2] = p.uv[i * 2]!; uv[(v0 + i) * 2 + 1] = p.uv[i * 2 + 1]!;
        }
        const idx = p.indices;
        for (let i = 0; i + 2 < idx.length; i += 3) {
          indices[i0 + i] = v0 + idx[i]!;
          indices[i0 + i + 1] = v0 + idx[flip ? i + 2 : i + 1]!;
          indices[i0 + i + 2] = v0 + idx[flip ? i + 1 : i + 2]!;
        }
        v0 += n; i0 += idx.length;
      }
      g.items = [];
      const P = g.proto;
      meshes.push({
        name: g.name, texture: P.texture, material: P.material, normalMap: P.normalMap, surface: P.surface, color: P.color, alphaTest: P.alphaTest, ...(P.image ? { image: P.image } : {}),
        vertexCount: g.nV, pos, nor, uv, bone: new Float32Array(0), weight: new Float32Array(0), indices, skinned: false, ...(g.hidden ? { defaultHidden: true } : {}),
      });
    }
    this.scene.meshes = meshes.map((_, i) => i);
    return meshes;
  }
}

