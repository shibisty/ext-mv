// id Tech 1–4: Quake MDL, Quake II MD2, Quake III MD3 (покадровая анимация вершин), Doom 3 / Quake 4 MD5 (скелет + .md5anim).
import { cstr, decodeText } from '../../core/binary';
import { boundsOf, computeNormals, makeIndices, skinnedBounds, sumTris } from '../../core/geometry';
import { mulCol, quatMat, rigidInv } from '../../core/math';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { Mesh, Model, Motion, NodeChannel, NodeMotion, VertexMotion } from '../../core/types';

type FrameMesh = Mesh & { frames: { pos: Float32Array[]; nor: Float32Array[] } };

/** Группировка кадров в анимации по имени без хвостовых цифр (stand01, stand02 -> stand). */
export function groupMotions(names: string[], fps: number): VertexMotion[] {
  const out: VertexMotion[] = [];
  names.forEach((n, i) => {
    const base = n.replace(/\d+$/, '') || n, last = out[out.length - 1];
    if (last && last.name === base) { last.count++; last.duration = last.count / fps; }
    else out.push({ kind: 'vertex', name: base, start: i, count: 1, fps, duration: 1 / fps });
  });
  return out.filter((m) => m.count > 1).length ? out : [{ kind: 'vertex', name: 'все кадры', start: 0, count: names.length, fps, duration: names.length / fps }];
}

function makeAnimate(meshes: FrameMesh[]) {
  return (motion: Motion | null, t: number, loop: boolean) => {
    const m = motion && motion.kind === 'vertex' ? motion : null;
    let f0 = 0, f1 = 0, a = 0;
    if (m) {
      const n = m.count;
      let fr = t * m.fps;
      fr = loop ? ((fr % n) + n) % n : Math.min(Math.max(fr, 0), n - 1);
      const i = Math.floor(fr);
      a = fr - i; f0 = m.start + i; f1 = m.start + (loop ? (i + 1) % n : Math.min(i + 1, n - 1));
    }
    for (const ms of meshes)
      for (const [dst, src] of [[ms.pos, ms.frames.pos], [ms.nor, ms.frames.nor]] as const) {
        const A = src[f0]!, B = src[f1]!;
        for (let k = 0; k < dst.length; k++) dst[k] = A[k]! + (B[k]! - A[k]!) * a;
      }
  };
}
function frameModel(meshes: FrameMesh[], names: string[], fps: number, info: string[]): Model {
  const motions = names.length > 1 ? groupMotions(names, fps) : [];
  return { meshes, skeleton: null, motions, bounds: boundsOf(meshes), flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, info, animate: makeAnimate(meshes) };
}
function frameMesh(name: string, texture: string, uv: Float32Array, indices: number[], framePos: Float32Array[]): FrameMesh {
  const nv = uv.length / 2, nors = framePos.map((p) => computeNormals(p, indices));
  return { name, texture, shader: '', vertexCount: nv, pos: Float32Array.from(framePos[0]!), nor: Float32Array.from(nors[0]!), uv,
    bone: new Float32Array(nv * 4), weight: new Float32Array(nv * 4), indices: makeIndices(nv, indices), skinned: false, dynamic: true, frames: { pos: framePos, nor: nors } };
}

// ---------- Quake II: MD2 ----------
export function loadMd2(buf: ArrayBuffer): Model {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (buf.byteLength < 68 || dv.getUint32(0, true) !== 0x32504449 || dv.getInt32(4, true) !== 8) throw new Error('Не MD2 (IDP2 v8)');
  const I = (o: number) => dv.getInt32(o, true);
  const skinW = I(8), skinH = I(12), frameSize = I(16), nSkins = I(20), nTris = I(32), nFrames = I(40);
  const oSkins = I(44), oSt = I(48), oTris = I(52), oFrames = I(56);
  const map = new Map<number, number>(), xyzOf: number[] = [], stOf: number[] = [], indices: number[] = [];
  for (let t = 0; t < nTris; t++)
    for (let c = 0; c < 3; c++) {
      const xi = dv.getUint16(oTris + t * 12 + c * 2, true), si = dv.getUint16(oTris + t * 12 + 6 + c * 2, true), key = xi + si * 65536;
      let v = map.get(key);
      if (v === undefined) { v = xyzOf.length; map.set(key, v); xyzOf.push(xi); stOf.push(si); }
      indices.push(v);
    }
  const nv = xyzOf.length, uv = new Float32Array(nv * 2);
  for (let v = 0; v < nv; v++) { uv[v * 2] = dv.getInt16(oSt + stOf[v]! * 4, true) / skinW; uv[v * 2 + 1] = dv.getInt16(oSt + stOf[v]! * 4 + 2, true) / skinH; }
  const framePos: Float32Array[] = [], names: string[] = [];
  for (let f = 0; f < nFrames; f++) {
    const b = oFrames + f * frameSize;
    const sc = [dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)], tr = [dv.getFloat32(b + 12, true), dv.getFloat32(b + 16, true), dv.getFloat32(b + 20, true)];
    names.push(cstr(u8, b + 24, 16));
    const pos = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) { const o = b + 40 + xyzOf[v]! * 4; for (let k = 0; k < 3; k++) pos[v * 3 + k] = u8[o + k]! * sc[k]! + tr[k]!; }
    framePos.push(pos);
  }
  if (!framePos.length) throw new Error('В MD2 нет кадров');
  const skin = nSkins ? cstr(u8, oSkins, 64) : '';
  const m = frameMesh('md2', skin, uv, indices, framePos);
  return frameModel([m], names, 10, [`Quake II MD2: вершин ${nv}, треугольников ${nTris}, кадров ${nFrames}`, skin ? `Скин: ${skin}` : 'Скин не указан (выберите текстуру вручную)']);
}

// ---------- Quake III: MD3 ----------
export function loadMd3(buf: ArrayBuffer): Model {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (buf.byteLength < 108 || dv.getUint32(0, true) !== 0x33504449 || dv.getInt32(4, true) !== 15) throw new Error('Не MD3 (IDP3 v15)');
  const nFrames = dv.getInt32(76, true), nTags = dv.getInt32(80, true), nSurf = dv.getInt32(84, true), oSurf = dv.getInt32(100, true);
  const meshes: FrameMesh[] = [];
  let off = oSurf, tris = 0;
  for (let s = 0; s < nSurf; s++) {
    const I = (o: number) => dv.getInt32(off + o, true);
    const name = cstr(u8, off + 4, 64), nF = I(72), nSh = I(76), nV = I(80), nT = I(84), oT = I(88), oSh = I(92), oSt = I(96), oX = I(100), end = I(104);
    const idx: number[] = [];
    for (let k = 0; k < nT * 3; k++) idx.push(dv.getInt32(off + oT + k * 4, true));
    const uv = new Float32Array(nV * 2);
    for (let k = 0; k < nV * 2; k++) uv[k] = dv.getFloat32(off + oSt + k * 4, true);
    const framePos: Float32Array[] = [];
    for (let f = 0; f < nF; f++) {
      const p = new Float32Array(nV * 3);
      for (let v = 0; v < nV; v++) { const o = off + oX + (f * nV + v) * 8; for (let k = 0; k < 3; k++) p[v * 3 + k] = dv.getInt16(o + k * 2, true) / 64; }
      framePos.push(p);
    }
    meshes.push(frameMesh(name || `surface ${s}`, nSh ? cstr(u8, off + oSh, 64) : '', uv, idx, framePos));
    tris += nT;
    off += end;
  }
  if (!meshes.length) throw new Error('В MD3 нет поверхностей');
  const names = Array.from({ length: nFrames }, () => '');
  const model = frameModel(meshes, names, 15, [`Quake III MD3: поверхностей ${meshes.length}, треугольников ${tris}, кадров ${nFrames}, тегов ${nTags}`, 'Теги (привязка частей игрока/оружия) не используются.']);
  if (nFrames > 1) model.motions = [{ kind: 'vertex', name: 'все кадры', start: 0, count: nFrames, fps: 15, duration: nFrames / 15 }];
  return model;
}

// ---------- Quake: MDL ----------
export function loadMdl(buf: ArrayBuffer, palette: Uint8Array | null): Model {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (buf.byteLength < 84 || dv.getUint32(0, true) !== 0x4f504449 || dv.getInt32(4, true) !== 6) throw new Error('Не MDL (IDPO v6)');
  const F = (o: number) => dv.getFloat32(o, true), I = (o: number) => dv.getInt32(o, true);
  const sc = [F(8), F(12), F(16)], tr = [F(20), F(24), F(28)], nSkins = I(48), sw = I(52), sh = I(56), nV = I(60), nT = I(64), nF = I(68);
  let p = 84, skin: Uint8Array | null = null;
  for (let i = 0; i < nSkins; i++) {
    const group = I(p);
    p += 4;
    if (group === 0) { if (!skin) skin = u8.slice(p, p + sw * sh); p += sw * sh; }
    else { const n = I(p); p += 4 + n * 4; if (!skin) skin = u8.slice(p, p + sw * sh); p += n * sw * sh; }
  }
  const st: Array<{ seam: number; s: number; t: number }> = [];
  for (let i = 0; i < nV; i++, p += 12) st.push({ seam: I(p), s: I(p + 4), t: I(p + 8) });
  const tris: Array<{ front: number; v: number[] }> = [];
  for (let i = 0; i < nT; i++, p += 16) tris.push({ front: I(p), v: [I(p + 4), I(p + 8), I(p + 12)] });
  const map = new Map<number, number>(), vOf: number[] = [], uvArr: number[] = [], indices: number[] = [];
  for (const t of tris)
    for (const vi of t.v) {
      const back = !t.front && st[vi]!.seam, key = vi * 2 + (back ? 1 : 0);
      let v = map.get(key);
      if (v === undefined) { v = vOf.length; map.set(key, v); vOf.push(vi); uvArr.push((st[vi]!.s + (back ? sw / 2 : 0) + 0.5) / sw, (st[vi]!.t + 0.5) / sh); }
      indices.push(v);
    }
  const frames: Float32Array[] = [], names: string[] = [];
  const readFrame = (q: number) => {
    names.push(cstr(u8, q + 8, 16));
    const pos = new Float32Array(vOf.length * 3);
    for (let v = 0; v < vOf.length; v++) for (let k = 0; k < 3; k++) pos[v * 3 + k] = u8[q + 24 + vOf[v]! * 4 + k]! * sc[k]! + tr[k]!;
    frames.push(pos);
    return q + 24 + nV * 4;
  };
  for (let f = 0; f < nF; f++) {
    const type = I(p);
    p += 4;
    if (type === 0) p = readFrame(p);
    else { const n = I(p); p += 4 + 8 + n * 4; for (let k = 0; k < n; k++) p = readFrame(p); }
  }
  if (!frames.length) throw new Error('В MDL нет кадров');
  const m = frameMesh('mdl', '', Float32Array.from(uvArr), indices, frames);
  const rgba = new Uint8Array(sw * sh * 4);
  if (skin)
    for (let i = 0; i < sw * sh; i++) {
      const c = skin[i]!;
      if (palette) { rgba[i * 4] = palette[c * 3]!; rgba[i * 4 + 1] = palette[c * 3 + 1]!; rgba[i * 4 + 2] = palette[c * 3 + 2]!; }
      else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = c;
      rgba[i * 4 + 3] = 255;
    }
  m.image = { width: sw, height: sh, rgba };
  return frameModel([m], names, 10, [`Quake MDL: вершин ${vOf.length}, треугольников ${nT}, кадров ${frames.length}`,
    palette ? 'Палитра: gfx/palette.lmp' : 'Палитра Quake не найдена (откройте pak0.pak) — текстура в градациях серого']);
}

// ---------- Doom 3 / Quake 4: MD5 ----------
const JOINT = /^"([^"]+)"\s+(-?\d+)\s+\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s+\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)/;
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
const quatW = (x: number, y: number, z: number) => -Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
const rotate = (q: number[], v: number[]) => { // q = [w,x,y,z]
  const [w, x, y, z] = q as [number, number, number, number];
  const cx = y * v[2]! - z * v[1]! + w * v[0]!, cy = z * v[0]! - x * v[2]! + w * v[1]!, cz = x * v[1]! - y * v[0]! + w * v[2]!;
  return [v[0]! + 2 * (y * cz - z * cy), v[1]! + 2 * (z * cx - x * cz), v[2]! + 2 * (x * cy - y * cx)];
};

interface Md5Joint { name: string; parent: number; pos: number[]; q: number[] }
interface Md5Mesh { shader: string; verts: Array<{ u: number; v: number; start: number; count: number }>; tris: Array<number[]>; weights: Array<{ joint: number; bias: number; pos: number[] }> }

export function parseMd5mesh(text: string): { joints: Md5Joint[]; meshes: Md5Mesh[] } {
  const L = lines(text), joints: Md5Joint[] = [], meshes: Md5Mesh[] = [];
  for (let i = 0; i < L.length; i++) {
    if (/^joints\s*\{/.test(L[i]!)) {
      for (i++; i < L.length && L[i] !== '}'; i++) {
        const m = JOINT.exec(L[i]!);
        if (m) joints.push({ name: m[1]!, parent: +m[2]!, pos: [+m[3]!, +m[4]!, +m[5]!], q: [quatW(+m[6]!, +m[7]!, +m[8]!), +m[6]!, +m[7]!, +m[8]!] });
      }
    } else if (/^mesh\s*\{/.test(L[i]!)) {
      const mesh: Md5Mesh = { shader: '', verts: [], tris: [], weights: [] };
      for (i++; i < L.length && L[i] !== '}'; i++) {
        const s = L[i]!;
        let m: RegExpExecArray | null;
        if ((m = /^shader\s+"([^"]*)"/.exec(s))) mesh.shader = m[1]!;
        else if ((m = /^vert\s+(\d+)\s+\(\s*(\S+)\s+(\S+)\s*\)\s+(\d+)\s+(\d+)/.exec(s))) mesh.verts[+m[1]!] = { u: +m[2]!, v: +m[3]!, start: +m[4]!, count: +m[5]! };
        else if ((m = /^tri\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(s))) mesh.tris[+m[1]!] = [+m[2]!, +m[3]!, +m[4]!];
        else if ((m = /^weight\s+(\d+)\s+(\d+)\s+(\S+)\s+\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)/.exec(s))) mesh.weights[+m[1]!] = { joint: +m[2]!, bias: +m[3]!, pos: [+m[4]!, +m[5]!, +m[6]!] };
      }
      meshes.push(mesh);
    }
  }
  if (!joints.length || !meshes.length) throw new Error('Не MD5mesh: нет joints/mesh');
  return { joints, meshes };
}

export function parseMd5anim(text: string, jointIndexByName: Map<string, number>): { fps: number; nFrames: number; chan: Map<number, NodeChannel> } {
  const L = lines(text);
  const num = (re: RegExp) => { for (const l of L) { const m = re.exec(l); if (m) return +m[1]!; } return 0; };
  const fps = num(/^frameRate\s+(\d+)/) || 24;
  const hier: Array<{ name: string; flags: number; start: number }> = [], base: Array<{ p: number[]; q: number[] }> = [], frames: number[][] = [];
  for (let i = 0; i < L.length; i++) {
    const h = /^(hierarchy|bounds|baseframe|frame)\s*(\d*)\s*\{/.exec(L[i]!);
    if (!h) continue;
    const vals: number[] = [];
    for (i++; i < L.length && L[i] !== '}'; i++) {
      if (h[1] === 'hierarchy') { const m = /^"([^"]+)"\s+(-?\d+)\s+(\d+)\s+(\d+)/.exec(L[i]!); if (m) hier.push({ name: m[1]!, flags: +m[3]!, start: +m[4]! }); }
      else if (h[1] === 'baseframe') { const m = /^\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)/.exec(L[i]!); if (m) base.push({ p: [+m[1]!, +m[2]!, +m[3]!], q: [+m[4]!, +m[5]!, +m[6]!] }); }
      else if (h[1] === 'frame') for (const t of L[i]!.split(/\s+/)) vals.push(+t);
    }
    if (h[1] === 'frame') frames[+h[2]!] = vals;
  }
  if (!hier.length || !frames.length) throw new Error('Не MD5anim: нет hierarchy/frame');
  const chan = new Map<number, NodeChannel>();
  hier.forEach((j, ji) => {
    const node = jointIndexByName.get(j.name.toLowerCase()) ?? ji, pos: Array<[number, number[]]> = [], rot: Array<[number, number[]]> = [];
    frames.forEach((vals, f) => {
      const p = base[ji]!.p.slice(), q = base[ji]!.q.slice();
      let k = j.start;
      if (j.flags & 1) p[0] = vals[k++]!;
      if (j.flags & 2) p[1] = vals[k++]!;
      if (j.flags & 4) p[2] = vals[k++]!;
      if (j.flags & 8) q[0] = vals[k++]!;
      if (j.flags & 16) q[1] = vals[k++]!;
      if (j.flags & 32) q[2] = vals[k++]!;
      pos.push([f, p]);
      rot.push([f, [quatW(q[0]!, q[1]!, q[2]!), q[0]!, q[1]!, q[2]!]]);
    });
    chan.set(node, { pos, rot, scl: null });
  });
  return { fps, nFrames: frames.length, chan };
}

export function loadMd5(text: string): Model {
  const { joints, meshes: src } = parseMd5mesh(text);
  const abs = joints.map((j) => quatMat(j.q, j.pos));
  const nodes: SkeletonNode[] = joints.map((j, i) => ({
    name: j.name, parent: j.parent, offset: rigidInv(abs[i]!), local: j.parent >= 0 ? mulCol(rigidInv(abs[j.parent]!), abs[i]!) : abs[i]!,
  }));
  const meshes: Mesh[] = src.map((s, mi) => {
    const nv = s.verts.length, pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), bone = new Float32Array(nv * 4), weight = new Float32Array(nv * 4);
    for (let v = 0; v < nv; v++) {
      const vt = s.verts[v];
      if (!vt) continue;
      uv[v * 2] = vt.u; uv[v * 2 + 1] = vt.v;
      const ws = s.weights.slice(vt.start, vt.start + vt.count).filter(Boolean), p = [0, 0, 0];
      for (const w of ws) { const j = joints[w.joint]!, r = rotate(j.q, w.pos); for (let k = 0; k < 3; k++) p[k] += w.bias * (j.pos[k]! + r[k]!); }
      pos.set(p, v * 3);
      const top = ws.slice().sort((a, b) => b.bias - a.bias).slice(0, 4), sum = top.reduce((a, w) => a + w.bias, 0) || 1;
      top.forEach((w, k) => { bone[v * 4 + k] = w.joint; weight[v * 4 + k] = w.bias / sum; });
    }
    const idx: number[] = [];
    for (const t of s.tris) if (t) idx.push(t[0]!, t[1]!, t[2]!);
    return { name: `mesh ${mi}`, texture: s.shader, shader: s.shader, vertexCount: nv, pos, nor: computeNormals(pos, idx), uv, bone, weight, indices: makeIndices(nv, idx), skinned: true };
  });
  const sk = new NodeSkeleton(nodes), bounds = skinnedBounds(sk, meshes), byName = new Map(joints.map((j, i) => [j.name.toLowerCase(), i]));
  return {
    meshes, skeleton: sk, motions: [], bounds, flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2,
    info: [`MD5mesh: костей ${joints.length}, мешей ${meshes.length}, треугольников ${sumTris(meshes)}`, 'Анимации: .md5anim (из папки модели в pk4 подгружаются сами)'],
    loadMotions: async (file) => {
      const a = parseMd5anim(decodeText(await file.arrayBuffer()), byName);
      const m: NodeMotion = { kind: 'node', name: file.name.replace(/\.[^.]+$/, ''), tps: a.fps, chan: a.chan, duration: a.nFrames / a.fps, frames: a.nFrames };
      return [m];
    },
  };
}
