// Unreal Engine 1–5 через экспорт ActorX: PSK (скелетная модель), PSKX (статическая), PSA (анимации).
// ANIMINFO = 168 байт: name[64], group[64], totalBones@128, rate@152, firstRawFrame@160, numRawFrames@164.
// Так сохраняют модели UModel (UEViewer) и FModel. Нативные пакеты (.upk/.pak/.uasset) здесь не читаются.
import { cstr } from '../../core/binary';
import { boundsOf, computeNormals, makeIndices, skinnedBounds, sumTris } from '../../core/geometry';
import { mulCol, quatMat, rigidInv } from '../../core/math';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { Mesh, Model, NodeChannel, NodeMotion } from '../../core/types';

interface Chunk { size: number; count: number; start: number }
export function readPskChunks(buf: ArrayBuffer): Record<string, Chunk> {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), out: Record<string, Chunk> = {};
  let p = 0;
  while (p + 32 <= buf.byteLength) {
    const id = cstr(u8, p, 20), size = dv.getInt32(p + 24, true), count = dv.getInt32(p + 28, true);
    if (size < 0 || count < 0) break;
    out[id] = { size, count, start: p + 32 };
    p += 32 + size * count;
  }
  return out;
}
// UE — левосторонняя система (Z вверх): отражаем Y, получаем правостороннюю Z-вверх
const mirrorQ = ([w, x, y, z]: number[]) => [w!, -x!, y!, -z!];
const conj = ([w, x, y, z]: number[]) => [w!, -x!, -y!, -z!];

interface PskBone { name: string; parent: number; q: number[]; p: number[] }
function readBones(buf: ArrayBuffer, c: Chunk): PskBone[] {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), out: PskBone[] = [];
  for (let i = 0; i < c.count; i++) {
    const o = c.start + i * c.size, f = (k: number) => dv.getFloat32(o + 76 + k * 4, true);
    out.push({ name: cstr(u8, o, 64), parent: dv.getInt32(o + 72, true), q: [f(3), f(0), f(1), f(2)], p: [f(4), f(5), f(6)] }); // файл: x,y,z,w -> [w,x,y,z]
  }
  out.forEach((b, i) => { if (b.parent === i || b.parent < 0) b.parent = -1; });
  return out;
}
// Вариант трактовки кватернионов: 0 как есть, 1 root сопряжён (так пишет ActorX), 2 сопряжены не-root, 3 все
const useConj = (variant: number, isRoot: boolean) => variant === 3 || (variant === 1 && isRoot) || (variant === 2 && !isRoot);
const fixQ = (q: number[], variant: number, isRoot: boolean) => mirrorQ(useConj(variant, isRoot) ? conj(q) : q);

function bindWorld(bones: PskBone[], variant: number): Float64Array[] {
  const world: Float64Array[] = [];
  bones.forEach((b, i) => {
    const local = quatMat(fixQ(b.q, variant, b.parent < 0), [b.p[0]!, -b.p[1]!, b.p[2]!]);
    world[i] = b.parent < 0 ? local : mulCol(world[b.parent]!, local);
  });
  return world;
}

export function parsePsk(buf: ArrayBuffer) {
  const ch = readPskChunks(buf), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const P = ch.PNTS0000, W = ch.VTXW0000 ?? ch.VTXW3200, F = ch.FACE0000 ?? ch.FACE3200, wide = !!ch.VTXW3200, M = ch.MATT0000;
  if (!P || !W || !F) throw new Error('Не PSK/PSKX: нет PNTS/VTXW/FACE');
  const points = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) {
    points[i * 3] = dv.getFloat32(P.start + i * 12, true);
    points[i * 3 + 1] = -dv.getFloat32(P.start + i * 12 + 4, true);
    points[i * 3 + 2] = dv.getFloat32(P.start + i * 12 + 8, true);
  }
  const nw = W.count, pos = new Float32Array(nw * 3), uv = new Float32Array(nw * 2), wp = new Uint32Array(nw);
  for (let i = 0; i < nw; i++) {
    const o = W.start + i * W.size, pi = wide ? dv.getUint32(o, true) : dv.getUint16(o, true);
    wp[i] = pi;
    pos.set(points.subarray(pi * 3, pi * 3 + 3), i * 3);
    uv[i * 2] = dv.getFloat32(o + 4, true); uv[i * 2 + 1] = dv.getFloat32(o + 8, true);
  }
  const byMat = new Map<number, number[]>();
  for (let i = 0; i < F.count; i++) {
    const o = F.start + i * F.size;
    const a = wide ? dv.getUint32(o, true) : dv.getUint16(o, true), b = wide ? dv.getUint32(o + 4, true) : dv.getUint16(o + 2, true), c = wide ? dv.getUint32(o + 8, true) : dv.getUint16(o + 4, true);
    const mi = wide ? u8[o + 12]! : u8[o + 6]!;
    if (!byMat.has(mi)) byMat.set(mi, []);
    byMat.get(mi)!.push(a, b, c);
  }
  const mats: string[] = [];
  if (M) for (let i = 0; i < M.count; i++) mats.push(cstr(u8, M.start + i * M.size, 64));
  const bones = ch.REFSKELT ? readBones(buf, ch.REFSKELT) : [];
  const weights: Array<Array<[number, number]>> = []; // на точку: [[bone, w], ...]
  if (ch.RAWWEIGHTS && bones.length) {
    const R = ch.RAWWEIGHTS;
    for (let i = 0; i < P.count; i++) weights[i] = [];
    for (let i = 0; i < R.count; i++) { const o = R.start + i * R.size, pi = dv.getInt32(o + 4, true); if (weights[pi]) weights[pi]!.push([dv.getInt32(o + 8, true), dv.getFloat32(o, true)]); }
  }
  return { points, pos, uv, wp, byMat, mats, bones, weights };
}

export function loadPsk(buf: ArrayBuffer): Model {
  const d = parsePsk(buf), nw = d.pos.length / 3, skinned = d.bones.length > 0;
  const bone = new Float32Array(nw * 4), weight = new Float32Array(nw * 4);
  let sk: NodeSkeleton | null = null, variant = 1;
  if (skinned) {
    for (let i = 0; i < nw; i++) {
      const l = (d.weights[d.wp[i]!] ?? []).slice().sort((a, b) => b[1] - a[1]).slice(0, 4), sum = l.reduce((s, x) => s + x[1], 0) || 1;
      l.forEach(([b, w], k) => { bone[i * 4 + k] = Math.min(b, d.bones.length - 1); weight[i * 4 + k] = w / sum; });
      if (!l.length) weight[i * 4] = 1;
    }
    // выбираем трактовку кватернионов: вершины должны лежать рядом с «главной» костью
    let best = Infinity;
    const step = Math.max(1, Math.floor(nw / 1500));
    for (const v of [1, 0, 2, 3]) {
      const w = bindWorld(d.bones, v);
      let e = 0, n = 0;
      for (let i = 0; i < nw; i += step) { const M = w[bone[i * 4]!]!; e += Math.hypot(d.pos[i * 3]! - M[12]!, d.pos[i * 3 + 1]! - M[13]!, d.pos[i * 3 + 2]! - M[14]!); n++; }
      e /= n || 1;
      if (e < best * 0.97) { best = e; variant = v; }
    }
    const world = bindWorld(d.bones, variant);
    const nodes: SkeletonNode[] = d.bones.map((b, i) => ({ name: b.name, parent: b.parent, local: b.parent < 0 ? world[i]! : mulCol(rigidInv(world[b.parent]!), world[i]!), offset: rigidInv(world[i]!) }));
    sk = new NodeSkeleton(nodes);
  }
  const meshes: Mesh[] = [];
  for (const [mi, idx] of d.byMat) {
    meshes.push({ name: d.mats[mi] || `material ${mi}`, texture: d.mats[mi] ?? '', shader: '', vertexCount: nw, pos: d.pos, nor: computeNormals(d.pos, idx), uv: d.uv, bone, weight,
      indices: makeIndices(nw, idx), skinned: true });
  }
  if (!meshes.length) throw new Error('В PSK нет граней');
  const bounds = sk ? skinnedBounds(sk, meshes) : boundsOf([{ pos: d.pos }]);
  const byName = new Map(d.bones.map((b, i) => [b.name.toLowerCase(), i]));
  const info = [`${skinned ? 'PSK' : 'PSKX'}: вершин (wedges) ${nw}, треугольников ${sumTris(meshes)}, материалов ${meshes.length}`];
  if (skinned) info.push(`Костей: ${d.bones.length}, трактовка кватернионов: вариант ${variant}`, 'Анимации: добавьте .psa кнопкой');
  return { meshes, skeleton: sk, motions: [], bounds, flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, info,
    loadMotions: skinned ? async (file) => parsePsa(await file.arrayBuffer(), d.bones, byName, variant) : undefined };
}

export function parsePsa(buf: ArrayBuffer, skelBones: Array<{ parent: number }>, byName: Map<string, number>, variant: number): NodeMotion[] {
  const ch = readPskChunks(buf), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const AI = ch.ANIMINFO, K = ch.ANIMKEYS, BN = ch.BONENAMES;
  if (!AI || !K || !BN) throw new Error('Не PSA: нет ANIMINFO/ANIMKEYS/BONENAMES');
  const names: string[] = [];
  for (let i = 0; i < BN.count; i++) names.push(cstr(u8, BN.start + i * BN.size, 64).toLowerCase());
  const nodeOf = names.map((n) => byName.get(n) ?? -1), motions: NodeMotion[] = [];
  for (let s = 0; s < AI.count; s++) {
    const o = AI.start + s * AI.size, name = cstr(u8, o, 64), nb = dv.getInt32(o + 128, true), rate = dv.getFloat32(o + 152, true) || 30, first = dv.getInt32(o + 160, true), frames = dv.getInt32(o + 164, true);
    if (nb <= 0 || frames <= 0) continue;
    const chan = new Map<number, NodeChannel>();
    for (let b = 0; b < nb; b++) {
      const node = nodeOf[b] ?? -1;
      if (node < 0) continue;
      const pos: Array<[number, number[]]> = [], rot: Array<[number, number[]]> = [], root = skelBones[node]!.parent < 0;
      for (let f = 0; f < frames; f++) {
        const k = K.start + ((first + f) * nb + b) * K.size;
        const q = [dv.getFloat32(k + 24, true), dv.getFloat32(k + 12, true), dv.getFloat32(k + 16, true), dv.getFloat32(k + 20, true)];
        pos.push([f, [dv.getFloat32(k, true), -dv.getFloat32(k + 4, true), dv.getFloat32(k + 8, true)]]);
        rot.push([f, fixQ(q, variant, root)]);
      }
      chan.set(node, { pos, rot, scl: null });
    }
    motions.push({ kind: 'node', name, tps: rate, chan, duration: frames / rate, frames });
  }
  return motions;
}
