// assimp 'assjson' -> модель gmv. Поля сцены — как в экспортёре assimp JSON (rootnode, meshes, materials, animations).
import { computeNormals, makeIndices, skinnedBounds, sumTris, sumVerts } from '../../core/geometry';
import { identity, transpose } from '../../core/math';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { Keys, Mesh, Model, NodeChannel, NodeMotion, SurfaceInfo } from '../../core/types';

const TPS_DEFAULT = 25;

export interface AssNode { name: string; transformation?: number[]; meshes?: number[]; children?: AssNode[] }
export interface AssBone { name: string; offsetmatrix?: number[]; weights?: Array<[number, number]> }
export interface AssMesh {
  name?: string; materialindex: number; vertices?: number[]; normals?: number[]; faces?: number[][];
  texturecoords?: number[][]; numuvcomponents?: number[]; bones?: AssBone[];
}
export interface AssProp { key: string; semantic?: number; index?: number; type?: number; value: unknown }
export interface AssChannel { name?: string; nodename?: string; positionkeys?: Keys<number[]>; rotationkeys?: Keys<number[]>; scalingkeys?: Keys<number[]> }
export interface AssAnimation { name?: string; tickspersecond?: number; duration?: number; channels?: AssChannel[] }
export interface AssScene { rootnode: AssNode; meshes?: AssMesh[]; materials?: Array<{ properties?: AssProp[] }>; animations?: AssAnimation[] }

function matName(scene: AssScene, mi: number): string {
  for (const p of scene.materials?.[mi]?.properties ?? []) if (p.key === '?mat.name' && typeof p.value === 'string') return p.value;
  return '';
}
/** Файл диффузной текстуры: semantic 1 (DIFFUSE) или 12 (BASE_COLOR). */
function texOf(scene: AssScene, mi: number): string {
  for (const p of scene.materials?.[mi]?.properties ?? []) if (p.key === '$tex.file' && (p.semantic === 1 || p.semantic === 12) && typeof p.value === 'string') return p.value;
  return '';
}

/** PBR из материала assimp: METALNESS (15), DIFFUSE_ROUGHNESS (16), AO (17), glTF metallicRoughness (UNKNOWN 18: G — шероховатость, B — металличность). */
function surfaceOf(scene: AssScene, mi: number): SurfaceInfo | undefined {
  const props = scene.materials?.[mi]?.properties ?? [], tex = (sem: number) => props.find((p) => p.key === '$tex.file' && p.semantic === sem && typeof p.value === 'string')?.value as string | undefined;
  const num = (k: string) => { const v = props.find((p) => p.key === k)?.value; return typeof v === 'number' ? v : Array.isArray(v) && typeof v[0] === 'number' ? v[0] : undefined; };
  const mr = tex(18), metal = tex(15), rough = tex(16), ao = tex(17);
  const s: SurfaceInfo = {
    metallic: metal ? { map: metal, channel: metal === rough ? 2 : 0 } : mr ? { map: mr, channel: 2 } : undefined,
    roughness: rough ? { map: rough, channel: metal === rough ? 1 : 0 } : mr ? { map: mr, channel: 1 } : undefined,
    ao: ao ? { map: ao, channel: 0 } : undefined,
    metallicFactor: num('$mat.metallicFactor'), roughnessFactor: num('$mat.roughnessFactor'), source: 'assimp',
  };
  return s.metallic || s.roughness || s.ao || s.metallicFactor !== undefined || s.roughnessFactor !== undefined ? s : undefined;
}

export function convertScene(scene: AssScene): Model {
  const nodes: SkeletonNode[] = [], inst: Array<{ m: number; node: number }> = [];
  (function walk(nd: AssNode, parent: number) {
    const idx = nodes.length;
    nodes.push({ name: nd.name, parent, local: nd.transformation ? transpose(nd.transformation) : identity(), offset: null });
    for (const m of nd.meshes ?? []) inst.push({ m, node: idx });
    for (const c of nd.children ?? []) walk(c, idx);
  })(scene.rootnode, -1);
  const byName = new Map<string, number>();
  nodes.forEach((x, i) => { if (!byName.has(x.name)) byName.set(x.name, i); });
  for (const sm of scene.meshes ?? [])
    for (const b of sm.bones ?? []) {
      const ni = byName.get(b.name);
      if (ni !== undefined && !nodes[ni]!.offset && b.offsetmatrix) nodes[ni]!.offset = transpose(b.offsetmatrix);
    }
  const meshes: Mesh[] = [];
  for (const it of inst) {
    const sm = scene.meshes?.[it.m];
    if (!sm) continue;
    const V = sm.vertices ?? [], n = V.length / 3;
    if (!n) continue;
    const tris: number[] = [];
    for (const f of sm.faces ?? []) for (let k = 1; k + 1 < f.length; k++) tris.push(f[0]!, f[k]!, f[k + 1]!);
    if (!tris.length) continue;
    const pos = Float32Array.from(V), uv = new Float32Array(n * 2);
    let nor: Float32Array;
    if (sm.normals && sm.normals.length === n * 3) {
      nor = Float32Array.from(sm.normals);
      for (let i = 0; i < n; i++) { const l = Math.hypot(nor[i * 3]!, nor[i * 3 + 1]!, nor[i * 3 + 2]!) || 1; nor[i * 3] /= l; nor[i * 3 + 1] /= l; nor[i * 3 + 2] /= l; }
    } else nor = computeNormals(pos, tris);
    const tc = sm.texturecoords?.[0], nc = sm.numuvcomponents?.[0] || 2;
    if (tc) for (let i = 0; i < n; i++) { uv[i * 2] = tc[i * nc]!; uv[i * 2 + 1] = 1 - tc[i * nc + 1]!; }
    const bone = new Float32Array(n * 4), weight = new Float32Array(n * 4);
    let rigid = -1;
    const getRigid = () => { if (rigid < 0) { rigid = nodes.length; nodes.push({ name: '#rigid', parent: it.node, local: identity(), offset: null }); } return rigid; };
    if (sm.bones && sm.bones.length) {
      const inf: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
      for (const b of sm.bones) {
        const ni = byName.get(b.name);
        if (ni === undefined) continue;
        for (const [v, w] of b.weights ?? []) if (v < n && w > 0) inf[v]!.push([ni, w]);
      }
      for (let v = 0; v < n; v++) {
        const l = inf[v]!.sort((p, q) => q[1] - p[1]).slice(0, 4), sum = l.reduce((s, x) => s + x[1], 0);
        if (!l.length) { bone[v * 4] = getRigid(); weight[v * 4] = 1; continue; }
        l.forEach(([ni, w], k) => { bone[v * 4 + k] = ni; weight[v * 4 + k] = w / sum; });
      }
    } else { const r = getRigid(); for (let v = 0; v < n; v++) { bone[v * 4] = r; weight[v * 4] = 1; } }
    meshes.push({ name: sm.name || `mesh ${it.m}`, texture: texOf(scene, sm.materialindex), material: matName(scene, sm.materialindex), surface: surfaceOf(scene, sm.materialindex), shader: '', vertexCount: n, pos, nor, uv, bone, weight,
      indices: makeIndices(n, tris), skinned: true });
  }
  if (!meshes.length) throw new Error('В сцене нет геометрии');
  const sk = new NodeSkeleton(nodes);
  const motions: NodeMotion[] = (scene.animations ?? []).map((a, i) => {
    const tps = a.tickspersecond && a.tickspersecond > 0 ? a.tickspersecond : TPS_DEFAULT, chan = new Map<number, NodeChannel>();
    let maxT = 0;
    for (const c of a.channels ?? []) {
      const ni = byName.get((c.name ?? c.nodename)!);
      if (ni === undefined) continue;
      const ch: NodeChannel = { pos: c.positionkeys?.length ? c.positionkeys : null, rot: c.rotationkeys?.length ? c.rotationkeys : null, scl: c.scalingkeys?.length ? c.scalingkeys : null };
      for (const k of [ch.pos, ch.rot, ch.scl]) if (k) maxT = Math.max(maxT, k[k.length - 1]![0]);
      chan.set(ni, ch);
    }
    return { kind: 'node', name: a.name || `anim ${i}`, tps, chan, duration: (a.duration && a.duration > 0 ? a.duration : maxT) / tps || 1 / tps };
  });
  const bounds = skinnedBounds(sk, meshes);
  return { meshes, skeleton: sk, motions, bounds, flipZ: false,
    info: [`Мешей: ${meshes.length}, вершин: ${sumVerts(meshes)}, треугольников: ${sumTris(meshes)}`, `Узлов/костей: ${sk.n}`, `Анимаций: ${motions.length}`] };
}
