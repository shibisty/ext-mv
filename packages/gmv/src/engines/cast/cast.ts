// Cast (.cast, DTZxPorter): контейнер моделей/анимаций/материалов. Основной формат выгрузки Greyhound / Wraith / Legion для Call of Duty и др.
import { fourCC } from '../../core/binary';
import { boundsOf, computeNormals, makeIndices, skinnedBounds, sumTris } from '../../core/geometry';
import { mulCol, quatMat, rigidInv } from '../../core/math';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import { MotionOnlyError, type Mesh, type Model, type NodeChannel, type NodeMotion } from '../../core/types';

const ID = { model: fourCC('modl'), mesh: fourCC('mesh'), skel: fourCC('skel'), bone: fourCC('bone'), matl: fourCC('matl'), file: fourCC('file'), anim: fourCC('anim'), curve: fourCC('curv') };
type TypedCtor = Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | BigUint64ArrayConstructor | Float32ArrayConstructor | Float64ArrayConstructor;
const TYPES: Record<number, [TypedCtor, number, number]> = {
  0x62: [Uint8Array, 1, 1], 0x68: [Uint16Array, 2, 1], 0x69: [Int32Array, 4, 1], 0x6c: [BigUint64Array, 8, 1], 0x66: [Float32Array, 4, 1], 0x64: [Float64Array, 8, 1],
  0x3276: [Float32Array, 4, 2], 0x3376: [Float32Array, 4, 3], 0x3476: [Float32Array, 4, 4],
};

export type CastValue = string | string[] | Uint8Array | Uint16Array | Int32Array | BigUint64Array | Float32Array | Float64Array;
export interface CastNode { id: number; hash: string; props: Record<string, CastValue>; kids: CastNode[] }
type NumArr = ArrayLike<number | bigint>;

export function parseCast(buf: ArrayBuffer): CastNode[] {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
  if (buf.byteLength < 16 || dv.getUint32(0, true) !== 0x74736163) throw new Error('Не Cast (нет сигнатуры «cast»)');
  const nRoots = dv.getUint32(8, true);
  let p = 16;
  const prop = (): { name: string; value: CastValue } => {
    const type = dv.getUint16(p, true), nameLen = dv.getUint16(p + 2, true), count = dv.getUint32(p + 4, true);
    p += 8;
    const name = dec.decode(u8.subarray(p, p + nameLen));
    p += nameLen;
    let value: CastValue;
    if (type === 0x73) {
      const list: string[] = [];
      for (let i = 0; i < count; i++) { let q = p; while (q < u8.length && u8[q]) q++; list.push(dec.decode(u8.subarray(p, q))); p = q + 1; }
      value = count === 1 ? list[0]! : list;
    } else {
      const t = TYPES[type];
      if (!t) throw new Error('Cast: неизвестный тип свойства 0x' + type.toString(16));
      const n = count * t[2], bytes = n * t[1];
      value = new t[0](buf.slice(p, p + bytes));
      p += bytes;
    }
    return { name, value };
  };
  const node = (): CastNode => {
    const id = dv.getUint32(p, true), hash = dv.getBigUint64(p + 8, true).toString(), nProps = dv.getUint32(p + 16, true), nKids = dv.getUint32(p + 20, true);
    p += 24;
    const props: Record<string, CastValue> = {};
    for (let i = 0; i < nProps; i++) { const q = prop(); props[q.name] = q.value; }
    const kids: CastNode[] = [];
    for (let i = 0; i < nKids; i++) kids.push(node());
    return { id, hash, props, kids };
  };
  const roots: CastNode[] = [];
  for (let i = 0; i < nRoots; i++) roots.push(node());
  return roots;
}

const arr = (v: CastValue | undefined): NumArr | null => (v && typeof v !== 'string' && !Array.isArray(v) ? (v as NumArr) : null);
const f32 = (v: CastValue | undefined): ArrayLike<number> | null => { const a = arr(v); return a && !(a instanceof BigUint64Array) ? (a as ArrayLike<number>) : null; };
const num = (props: Record<string, CastValue>, key: string, def: number): number => {
  const v = props[key];
  if (v === undefined) return def;
  if (typeof v === 'string') return Number(v);
  if (Array.isArray(v)) return def;
  return v.length ? Number(v[0]) : def;
};
const str = (v: CastValue | undefined, def = ''): string => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] ?? def : def);
/** cast: x,y,z,w -> [w,x,y,z] */
const xyzw = (a: ArrayLike<number>, i = 0) => [a[i * 4 + 3]!, a[i * 4]!, a[i * 4 + 1]!, a[i * 4 + 2]!];

export function convertCast(roots: CastNode[]): Model {
  let model: CastNode | null = null;
  // как в v11: первая модель в каждом корне, побеждает последний корень
  for (const r of roots) { const k = r.kids.find((x) => x.id === ID.model); if (k) model = k; }
  if (!model) {
    const hasAnim = roots.some((r) => r.kids.some((k) => k.id === ID.anim));
    if (hasAnim) throw new MotionOnlyError('Это файл анимации Cast (не модель)');
    throw new Error('В Cast нет модели');
  }
  const skelNode = model.kids.find((k) => k.id === ID.skel), boneNodes = skelNode ? skelNode.kids.filter((k) => k.id === ID.bone) : [];
  // кости: локальные трансформы + мировой bind (offset)
  const n = boneNodes.length, world: Float64Array[] = new Array(n), local: Float64Array[] = new Array(n), memo: boolean[] = new Array(n).fill(false);
  const bones = boneNodes.map((b, i) => {
    let par = num(b.props, 'p', -1);
    if (par < 0 || par >= n || par === i) par = -1;
    return { name: str(b.props.n, `bone${i}`), parent: par, props: b.props };
  });
  const ID_M = () => quatMat([1, 0, 0, 0], [0, 0, 0]);
  const calc = (i: number): void => {
    if (memo[i]) return;
    memo[i] = true;
    const b = bones[i]!, pr = b.props;
    if (b.parent >= 0) calc(b.parent);
    const pw = b.parent >= 0 ? world[b.parent]! : null, s = f32(pr.s), sc = s && s.length >= 3 ? [s[0]!, s[1]!, s[2]!] : [1, 1, 1];
    const lp = f32(pr.lp), lr = f32(pr.lr), wp = f32(pr.wp), wr = f32(pr.wr);
    if (lp && lr) local[i] = quatMat(xyzw(lr), [lp[0]!, lp[1]!, lp[2]!], sc);
    if (wp && wr) world[i] = quatMat(xyzw(wr), [wp[0]!, wp[1]!, wp[2]!]);
    if (!world[i]) world[i] = pw ? mulCol(pw, local[i] ?? ID_M()) : local[i] ?? ID_M();
    if (!local[i]) local[i] = pw ? mulCol(rigidInv(pw), world[i]!) : world[i]!;
  };
  for (let i = 0; i < n; i++) calc(i);
  const nodes: SkeletonNode[] = bones.map((b, i) => ({ name: b.name, parent: b.parent, local: local[i]!, offset: rigidInv(world[i]!) }));
  // материалы
  const mats = new Map<string, { name: string; tex: string }>();
  for (const m of model.kids.filter((k) => k.id === ID.matl)) {
    const files = m.kids.filter((k) => k.id === ID.file).map((f) => ({ slot: str(f.props.n), path: str(f.props.p) }));
    const pick = files.find((f) => /albedo|diffuse|basecolor|base_color|color/i.test(f.slot)) ?? files[0];
    mats.set(m.hash, { name: str(m.props.n), tex: pick ? pick.path : '' });
  }
  const meshes: Mesh[] = [];
  for (const m of model.kids.filter((k) => k.id === ID.mesh)) {
    const pr = m.props, vp = f32(pr.vp), faces = arr(pr.f);
    if (!vp || !faces) continue;
    const nv = vp.length / 3, pos = Float32Array.from(vp), idx = Array.from(faces, Number), uv = new Float32Array(nv * 2);
    const u0 = f32(pr.u0), vn = f32(pr.vn);
    if (u0 && u0.length >= nv * 2) for (let k = 0; k < nv * 2; k++) uv[k] = u0[k]!;
    const nor = vn && vn.length >= nv * 3 ? Float32Array.from(Array.prototype.slice.call(vn, 0, nv * 3) as number[]) : computeNormals(pos, idx);
    const bone = new Float32Array(nv * 4), weight = new Float32Array(nv * 4), mi = num(pr, 'mi', 0), wb = arr(pr.wb), wv = f32(pr.wv);
    if (n && wb && wv && mi > 0) {
      for (let v = 0; v < nv; v++) {
        const l: Array<[number, number]> = [];
        for (let k = 0; k < mi; k++) { const w = wv[v * mi + k]!, b = Number(wb[v * mi + k]); if (w > 0 && b < n) l.push([b, w]); }
        l.sort((a, b) => b[1] - a[1]);
        const top = l.slice(0, 4), sum = top.reduce((s, x) => s + x[1], 0) || 1;
        if (!top.length) weight[v * 4] = 1;
        else top.forEach(([b, w], k) => { bone[v * 4 + k] = b; weight[v * 4 + k] = w / sum; });
      }
    } else for (let v = 0; v < nv; v++) weight[v * 4] = 1;
    const mref = arr(pr.m), mat = mref && mref.length ? mats.get(mref[0]!.toString()) : undefined;
    meshes.push({ name: str(pr.n, `mesh ${meshes.length}`), texture: mat ? mat.tex : '', shader: mat ? mat.name : '', vertexCount: nv, pos, nor, uv, bone, weight,
      indices: makeIndices(nv, idx), skinned: true });
  }
  if (!meshes.length) throw new Error('В Cast-модели нет мешей');
  let sk: NodeSkeleton | null = null, bounds;
  if (n) { sk = new NodeSkeleton(nodes); bounds = skinnedBounds(sk, meshes); }
  else bounds = boundsOf(meshes);
  const byName = new Map(bones.map((b, i) => [b.name.toLowerCase(), i]));
  return {
    meshes, skeleton: sk, motions: [], bounds, flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2,
    info: [`Cast: «${str(model.props.n, 'model')}», мешей ${meshes.length}, треугольников ${sumTris(meshes)}, костей ${n}, материалов ${mats.size}`,
      n ? 'Анимации: .cast с анимацией — кнопкой «+ анимация» или кликом в списке' : 'Статичная модель'],
    loadMotions: n ? async (file) => convertCastAnim(parseCast(await file.arrayBuffer()), byName, nodes) : undefined,
  };
}

/** Анимации Cast: curve = (имя кости, свойство rq/tx/ty/tz, кадры, значения). Поддержан абсолютный режим. */
export function convertCastAnim(roots: CastNode[], byName: Map<string, number>, nodes: SkeletonNode[]): NodeMotion[] {
  const out: NodeMotion[] = [];
  for (const r of roots)
    for (const a of r.kids.filter((k) => k.id === ID.anim)) {
      const fps = num(a.props, 'fr', 30) || 30, chan = new Map<number, NodeChannel>(), bag = new Map<number, { pos: Map<number, number[]>; rot: Map<number, number[]> }>();
      let maxF = 0;
      for (const c of a.kids.filter((k) => k.id === ID.curve)) {
        const bi = byName.get(str(c.props.nn).toLowerCase()), kb = arr(c.props.kb), kv = f32(c.props.kv);
        if (bi === undefined || !kb || !kv) continue;
        const kp = str(c.props.kp), t = bag.get(bi) ?? { pos: new Map(), rot: new Map() };
        bag.set(bi, t);
        for (let i = 0; i < kb.length; i++) {
          const f = Number(kb[i]);
          maxF = Math.max(maxF, f);
          if (kp === 'rq') t.rot.set(f, xyzw(kv, i));
          else if (kp === 'tx' || kp === 'ty' || kp === 'tz') { const v = t.pos.get(f) ?? [NaN, NaN, NaN]; v['xyz'.indexOf(kp[1]!)] = kv[i]!; t.pos.set(f, v); }
        }
      }
      for (const [bi, t] of bag) {
        const L = nodes[bi]!.local, rest = [L[12]!, L[13]!, L[14]!];
        const pos = [...t.pos].sort((x, y) => x[0] - y[0]).map(([f, v]): [number, number[]] => [f, v.map((x, k) => (Number.isNaN(x) ? rest[k]! : x))]);
        const rot = [...t.rot].sort((x, y) => x[0] - y[0]);
        chan.set(bi, { pos: pos.length ? pos : null, rot: rot.length ? rot : null, scl: null });
      }
      if (chan.size) out.push({ kind: 'node', name: str(a.props.n, `anim ${out.length}`), tps: fps, chan, duration: (maxF + 1) / fps, frames: maxF + 1 });
    }
  return out;
}
