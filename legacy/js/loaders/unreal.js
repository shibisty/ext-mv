// Unreal Engine 1–5 через экспорт ActorX: PSK (скелетная модель), PSKX (статическая), PSA (анимации).
// ANIMINFO = 168 байт: name[64], group[64], totalBones@128, rate@152, firstRawFrame@160, numRawFrames@164.
// Так сохраняют модели UModel (UEViewer) и FModel. Нативные пакеты (.upk/.pak/.uasset) здесь не читаются.
import { NodeSkeleton } from './assimp.js';
import { computeBounds } from './common.js';

const cstr = (u8, a, n) => { let s = ''; for (let i = 0; i < n && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; };
function readChunks(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), out = {}; let p = 0;
  while (p + 32 <= buf.byteLength) {
    const id = cstr(u8, p, 20), size = dv.getInt32(p + 24, true), count = dv.getInt32(p + 28, true);
    if (size < 0 || count < 0) break;
    out[id] = { size, count, start: p + 32 }; p += 32 + size * count;
  }
  return out;
}
// UE — левосторонняя система (Z вверх): отражаем Y, получаем правостороннюю Z-вверх
const mirrorQ = ([w, x, y, z]) => [w, -x, y, -z];
const conj = ([w, x, y, z]) => [w, -x, -y, -z];
function trMat(q, t) {
  const [w, x, y, z] = q, xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const R = [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)], m = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[r * 3 + c];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1; return m;
}
function mulCol(a, b) { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
function rigidInv(M) {
  const o = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = M[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(M[r * 4] * M[12] + M[r * 4 + 1] * M[13] + M[r * 4 + 2] * M[14]);
  o[15] = 1; return o;
}
function computeNormals(pos, idx) {
  const nv = pos.length / 3, nor = new Float32Array(nv * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const o of [a, b, c]) { nor[o] += x; nor[o + 1] += y; nor[o + 2] += z; }
  }
  for (let k = 0; k < nv; k++) { const l = Math.hypot(nor[k * 3], nor[k * 3 + 1], nor[k * 3 + 2]) || 1; nor[k * 3] /= l; nor[k * 3 + 1] /= l; nor[k * 3 + 2] /= l; }
  return nor;
}

function readBones(buf, c) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), out = [];
  for (let i = 0; i < c.count; i++) {
    const o = c.start + i * c.size, f = (k) => dv.getFloat32(o + 76 + k * 4, true);
    out.push({ name: cstr(u8, o, 64), parent: dv.getInt32(o + 72, true), q: [f(3), f(0), f(1), f(2)], p: [f(4), f(5), f(6)] });   // файл: x,y,z,w -> [w,x,y,z]
  }
  out.forEach((b, i) => { if (b.parent === i || b.parent < 0) b.parent = -1; });
  return out;
}
// Вариант трактовки кватернионов: 0 как есть, 1 root сопряжён (так пишет ActorX), 2 сопряжены не-root, 3 все
const useConj = (variant, isRoot) => variant === 3 || (variant === 1 && isRoot) || (variant === 2 && !isRoot);
const fixQ = (q, variant, isRoot) => mirrorQ(useConj(variant, isRoot) ? conj(q) : q);

function bindWorld(bones, variant) {
  const world = [];
  bones.forEach((b, i) => {
    const local = trMat(fixQ(b.q, variant, b.parent < 0), [b.p[0], -b.p[1], b.p[2]]);
    world[i] = b.parent < 0 ? local : mulCol(world[b.parent], local);
  });
  return world;
}

export function parsePsk(buf) {
  const ch = readChunks(buf), dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (!ch.PNTS0000 || !(ch.VTXW0000 || ch.VTXW3200) || !(ch.FACE0000 || ch.FACE3200)) throw new Error('Не PSK/PSKX: нет PNTS/VTXW/FACE');
  const P = ch.PNTS0000, W = ch.VTXW0000 || ch.VTXW3200, F = ch.FACE0000 || ch.FACE3200, wide = !!ch.VTXW3200, M = ch.MATT0000;
  const points = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) { points[i * 3] = dv.getFloat32(P.start + i * 12, true); points[i * 3 + 1] = -dv.getFloat32(P.start + i * 12 + 4, true); points[i * 3 + 2] = dv.getFloat32(P.start + i * 12 + 8, true); }
  const nw = W.count, pos = new Float32Array(nw * 3), uv = new Float32Array(nw * 2), wp = new Uint32Array(nw);
  for (let i = 0; i < nw; i++) {
    const o = W.start + i * W.size, pi = wide ? dv.getUint32(o, true) : dv.getUint16(o, true); wp[i] = pi;
    pos.set(points.subarray(pi * 3, pi * 3 + 3), i * 3); uv[i * 2] = dv.getFloat32(o + 4, true); uv[i * 2 + 1] = dv.getFloat32(o + 8, true);
  }
  const byMat = new Map();
  for (let i = 0; i < F.count; i++) {
    const o = F.start + i * F.size, a = wide ? dv.getUint32(o, true) : dv.getUint16(o, true), b = wide ? dv.getUint32(o + 4, true) : dv.getUint16(o + 2, true), c = wide ? dv.getUint32(o + 8, true) : dv.getUint16(o + 4, true);
    const mi = wide ? u8[o + 12] : u8[o + 6]; if (!byMat.has(mi)) byMat.set(mi, []); byMat.get(mi).push(a, b, c);
  }
  const mats = []; if (M) for (let i = 0; i < M.count; i++) mats.push(cstr(u8, M.start + i * M.size, 64));
  const bones = ch.REFSKELT ? readBones(buf, ch.REFSKELT) : [];
  const weights = []; // на точку: [[bone, w], ...]
  if (ch.RAWWEIGHTS && bones.length) {
    const R = ch.RAWWEIGHTS; for (let i = 0; i < P.count; i++) weights[i] = [];
    for (let i = 0; i < R.count; i++) { const o = R.start + i * R.size, pi = dv.getInt32(o + 4, true); if (weights[pi]) weights[pi].push([dv.getInt32(o + 8, true), dv.getFloat32(o, true)]); }
  }
  return { points, pos, uv, wp, byMat, mats, bones, weights };
}

export function loadPsk(buf) {
  const d = parsePsk(buf), nw = d.pos.length / 3, skinned = d.bones.length > 0;
  const bone = new Float32Array(nw * 4), weight = new Float32Array(nw * 4);
  let sk = null, variant = 1, notes = [];
  if (skinned) {
    for (let i = 0; i < nw; i++) {
      const l = (d.weights[d.wp[i]] || []).slice().sort((a, b) => b[1] - a[1]).slice(0, 4), sum = l.reduce((s, x) => s + x[1], 0) || 1;
      l.forEach(([b, w], k) => { bone[i * 4 + k] = Math.min(b, d.bones.length - 1); weight[i * 4 + k] = w / sum; });
      if (!l.length) weight[i * 4] = 1;
    }
    // выбираем трактовку кватернионов: вершины должны лежать рядом с «главной» костью
    let best = Infinity; const step = Math.max(1, Math.floor(nw / 1500));
    for (const v of [1, 0, 2, 3]) {
      const w = bindWorld(d.bones, v); let e = 0, n = 0;
      for (let i = 0; i < nw; i += step) { const bi = bone[i * 4], M = w[bi]; e += Math.hypot(d.pos[i * 3] - M[12], d.pos[i * 3 + 1] - M[13], d.pos[i * 3 + 2] - M[14]); n++; }
      e /= n || 1; if (e < best * 0.97) { best = e; variant = v; }
    }
    const world = bindWorld(d.bones, variant);
    const nodes = d.bones.map((b, i) => ({ name: b.name, parent: b.parent, local: b.parent < 0 ? world[i] : mulCol(rigidInv(world[b.parent]), world[i]), offset: rigidInv(world[i]) }));
    sk = new NodeSkeleton(nodes);
  }
  const meshes = [];
  for (const [mi, idx] of d.byMat) {
    const nor = computeNormals(d.pos, idx);
    meshes.push({ name: d.mats[mi] || `material ${mi}`, texture: d.mats[mi] || '', shader: '', vertexCount: nw, pos: d.pos, nor, uv: d.uv, bone, weight,
      indices: nw > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx), skinned: true });
  }
  if (!meshes.length) throw new Error('В PSK нет граней');
  let bounds;
  if (sk) bounds = computeBounds(sk, meshes);
  else { const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < d.pos.length; i++) { const k = i % 3; if (d.pos[i] < min[k]) min[k] = d.pos[i]; if (d.pos[i] > max[k]) max[k] = d.pos[i]; } bounds = { min, max }; }
  const tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0), byName = new Map(d.bones.map((b, i) => [b.name.toLowerCase(), i]));
  const info = [`${skinned ? 'PSK' : 'PSKX'}: вершин (wedges) ${nw}, треугольников ${tris}, материалов ${meshes.length}`];
  if (skinned) info.push(`Костей: ${d.bones.length}, трактовка кватернионов: вариант ${variant}`, 'Анимации: добавьте .psa кнопкой');
  return { meshes, skeleton: sk, motions: [], bounds, flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, info, features: { zUp: true },
    loadMotions: skinned ? async (file) => parsePsa(await file.arrayBuffer(), d.bones, byName, variant) : undefined };
}

export function parsePsa(buf, skelBones, byName, variant) {
  const ch = readChunks(buf), dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (!ch.ANIMINFO || !ch.ANIMKEYS || !ch.BONENAMES) throw new Error('Не PSA: нет ANIMINFO/ANIMKEYS/BONENAMES');
  const names = []; for (let i = 0; i < ch.BONENAMES.count; i++) names.push(cstr(u8, ch.BONENAMES.start + i * ch.BONENAMES.size, 64).toLowerCase());
  const nodeOf = names.map((n) => (byName.has(n) ? byName.get(n) : -1)), K = ch.ANIMKEYS, motions = [];
  for (let s = 0; s < ch.ANIMINFO.count; s++) {
    const o = ch.ANIMINFO.start + s * ch.ANIMINFO.size, name = cstr(u8, o, 64), nb = dv.getInt32(o + 128, true), rate = dv.getFloat32(o + 152, true) || 30, first = dv.getInt32(o + 160, true), frames = dv.getInt32(o + 164, true);
    if (nb <= 0 || frames <= 0) continue;
    const chan = new Map();
    for (let b = 0; b < nb; b++) {
      const node = nodeOf[b]; if (node < 0) continue; const pos = [], rot = [], root = skelBones[node].parent < 0;
      for (let f = 0; f < frames; f++) {
        const k = K.start + ((first + f) * nb + b) * K.size, q = [dv.getFloat32(k + 24, true), dv.getFloat32(k + 12, true), dv.getFloat32(k + 16, true), dv.getFloat32(k + 20, true)];
        pos.push([f, [dv.getFloat32(k, true), -dv.getFloat32(k + 4, true), dv.getFloat32(k + 8, true)]]); rot.push([f, fixQ(q, variant, root)]);
      }
      chan.set(node, { pos, rot, scl: null });
    }
    motions.push({ name, tps: rate, chan, duration: frames / rate, frames });
  }
  return motions;
}

export async function load(files, main) {
  const ext = main.name.split('.').pop().toLowerCase();
  if (ext !== 'psk' && ext !== 'pskx') throw new Error('Ожидается .psk или .pskx (экспорт UModel/FModel)');
  return loadPsk(await main.arrayBuffer());
}
