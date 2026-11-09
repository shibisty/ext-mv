// Valve: GoldSrc (Half-Life 1, MDL «IDST» v10: скелет, анимации, внешние T.mdl/01.mdl) и Source 1 (MDL v44–49 + VVD + VTX, статика).
import { cstr } from '../../core/binary';
import { boundsOf, computeNormals, makeIndices, skinnedBounds, sumTris } from '../../core/geometry';
import { quatMat } from '../../core/math';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { LoadContext } from '../../core/plugin';
import { decodeVtmbAnim, vtmbAnimList, vtmbBones, vtmbCompose, vtmbIncludes, vtmbNodes, vtmbSeqList } from './vtmbanim';
import type { DecodedImage, Mesh, Model, Motion, NodeChannel, NodeMotion, VFile } from '../../core/types';

// ================= GoldSrc =================
const angleQuat = (a: number[]): number[] => { // Quake AngleQuaternion -> [w,x,y,z]
  const sy = Math.sin(a[2]! * 0.5), cy = Math.cos(a[2]! * 0.5), sp = Math.sin(a[1]! * 0.5), cp = Math.cos(a[1]! * 0.5), sr = Math.sin(a[0]! * 0.5), cr = Math.cos(a[0]! * 0.5);
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
};
/** RLE-поток mstudioanimvalue_t. */
function animValue(u8: Uint8Array, dv: DataView, base: number, off: number, frame: number): number {
  let p = base + off, k = frame, valid = u8[p]!, total = u8[p + 1]!, guard = 0;
  while (total <= k && total > 0 && guard++ < 4096) { k -= total; p += (valid + 1) * 2; valid = u8[p]!; total = u8[p + 1]!; }
  return dv.getInt16(valid > k ? p + (k + 1) * 2 : p + valid * 2, true);
}

export interface GoldsrcExtra { tex?: ArrayBuffer | null; seq?: Map<number, ArrayBuffer> }

export function loadGoldsrc(buf: ArrayBuffer, extra: GoldsrcExtra = {}): Model {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), I = (o: number) => dv.getInt32(o, true), F = (o: number) => dv.getFloat32(o, true);
  if (buf.byteLength < 244 || I(0) !== 0x54534449 || I(4) !== 10) throw new Error('Не GoldSrc MDL (IDST v10)');
  const nBones = I(140), oBones = I(144), nSeq = I(164), oSeq = I(168), nSeqGroups = I(172), nTex = I(180), oTex = I(184), oSkin = I(200), nBody = I(204), oBody = I(208);
  if (!nBody && nTex) throw new Error('Это файл текстур GoldSrc (*T.mdl) — откройте основную модель, текстуры подхватятся сами');
  // текстуры: внутри файла или во внешнем *T.mdl
  // во внешнем *T.mdl лежат и текстуры, и таблица скинов (skinref -> текстура)
  let tb = { dv, u8, n: nTex, o: oTex, nSkinRef: I(192), oSkin };
  if (!nTex && extra.tex) {
    const d = new DataView(extra.tex);
    tb = { dv: d, u8: new Uint8Array(extra.tex), n: d.getInt32(180, true), o: d.getInt32(184, true), nSkinRef: d.getInt32(192, true), oSkin: d.getInt32(200, true) };
  }
  const skinTex = (ref: number) => (ref < tb.nSkinRef ? tb.dv.getInt16(tb.oSkin + ref * 2, true) : ref);
  const textures: Array<{ name: string; width: number; height: number; image: DecodedImage }> = [];
  for (let i = 0; i < tb.n; i++) {
    const o = tb.o + i * 80, flags = tb.dv.getInt32(o + 64, true), w = tb.dv.getInt32(o + 68, true), h = tb.dv.getInt32(o + 72, true), idx = tb.dv.getInt32(o + 76, true);
    const rgba = new Uint8Array(w * h * 4), pal = idx + w * h;
    for (let k = 0; k < w * h; k++) {
      const c = tb.u8[idx + k]!;
      rgba[k * 4] = tb.u8[pal + c * 3]!; rgba[k * 4 + 1] = tb.u8[pal + c * 3 + 1]!; rgba[k * 4 + 2] = tb.u8[pal + c * 3 + 2]!;
      rgba[k * 4 + 3] = flags & 0x40 && c === 255 ? 0 : 255;
    }
    textures.push({ name: cstr(tb.u8, o, 64), width: w, height: h, image: { width: w, height: h, rgba } });
  }
  // кости (bind = значения по умолчанию)
  const bones: Array<{ name: string; parent: number; val: number[]; sc: number[] }> = [];
  for (let i = 0; i < nBones; i++) {
    const o = oBones + i * 112, val: number[] = [], sc: number[] = [];
    for (let k = 0; k < 6; k++) { val.push(F(o + 64 + k * 4)); sc.push(F(o + 88 + k * 4)); }
    bones.push({ name: cstr(u8, o, 32), parent: I(o + 32), val, sc });
  }
  const nodes: SkeletonNode[] = bones.map((b) => ({ name: b.name, parent: b.parent, local: quatMat(angleQuat([b.val[3]!, b.val[4]!, b.val[5]!]), [b.val[0]!, b.val[1]!, b.val[2]!]), offset: null }));
  // геометрия: submodel 0 каждой части тела
  const meshes: Mesh[] = [];
  for (let bp = 0; bp < nBody; bp++) {
    const nm = I(oBody + bp * 76 + 64), mi = I(oBody + bp * 76 + 72);
    if (!nm) continue;
    // submodel 0; если он пустой (gibs: «concgibs1» без мешей) — первый непустой
    let m0 = mi;
    for (let k = 0; k < nm && !I(m0 + 72); k++) m0 = mi + (k + 1) * 112;
    if (m0 >= mi + nm * 112) continue;
    const nMesh = I(m0 + 72), oMesh = I(m0 + 76), oVInfo = I(m0 + 84), oVert = I(m0 + 88), oNorm = I(m0 + 100);
    for (let k = 0; k < nMesh; k++) {
      const mo2 = oMesh + k * 20, oTri = I(mo2 + 4), skinref = I(mo2 + 8), ti = skinTex(skinref);
      const tex = textures[ti] ?? { width: 256, height: 256, name: '', image: undefined };
      const map = new Map<string, number>(), pos: number[] = [], nor: number[] = [], uv: number[] = [], bone: number[] = [], tris: number[] = [];
      const vert = (vi: number, ni: number, s: number, t: number) => {
        const key = `${vi}|${ni}|${s}|${t}`;
        let v = map.get(key);
        if (v === undefined) {
          v = map.size; map.set(key, v);
          pos.push(F(oVert + vi * 12), F(oVert + vi * 12 + 4), F(oVert + vi * 12 + 8));
          nor.push(F(oNorm + ni * 12), F(oNorm + ni * 12 + 4), F(oNorm + ni * 12 + 8));
          uv.push(s / tex.width, t / tex.height);
          bone.push(u8[oVInfo + vi]!);
        }
        return v;
      };
      for (let p = oTri; ;) {
        let n = dv.getInt16(p, true);
        p += 2;
        if (n === 0) break;
        const fan = n < 0;
        n = Math.abs(n);
        const vs: number[] = [];
        for (let i = 0; i < n; i++, p += 8) vs.push(vert(dv.getInt16(p, true), dv.getInt16(p + 2, true), dv.getInt16(p + 4, true), dv.getInt16(p + 6, true)));
        for (let i = 2; i < n; i++) {
          if (fan) tris.push(vs[0]!, vs[i - 1]!, vs[i]!);
          else if (i & 1) tris.push(vs[i - 1]!, vs[i - 2]!, vs[i]!);
          else tris.push(vs[i - 2]!, vs[i - 1]!, vs[i]!);
        }
      }
      const nv = map.size, b4 = new Float32Array(nv * 4), w4 = new Float32Array(nv * 4);
      for (let v = 0; v < nv; v++) { b4[v * 4] = Math.min(bone[v]!, nBones - 1); w4[v * 4] = 1; }
      meshes.push({ name: `body ${bp} / mesh ${k}`, texture: tex.name, shader: '', image: tex.image, vertexCount: nv, pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: Float32Array.from(uv),
        bone: b4, weight: w4, indices: Uint16Array.from(tris), skinned: true });
    }
  }
  if (!meshes.length) throw new Error('В MDL нет геометрии');
  const sk = new NodeSkeleton(nodes), bounds = skinnedBounds(sk, meshes), motions: NodeMotion[] = [];
  for (let s = 0; s < nSeq; s++) {
    const o = oSeq + s * 176, label = cstr(u8, o, 32), fps = F(o + 32) || 30, frames = I(o + 56), animIdx = I(o + 124), group = I(o + 156);
    const ext = group === 0 ? null : extra.seq?.get(group);
    const src = group === 0 ? { dv, u8 } : ext ? { dv: new DataView(ext), u8: new Uint8Array(ext) } : null;
    if (!src || frames <= 0) continue;
    const chan = new Map<number, NodeChannel>();
    for (let b = 0; b < nBones; b++) {
      const base = animIdx + b * 12, offs: number[] = [];
      for (let j = 0; j < 6; j++) offs.push(src.dv.getUint16(base + j * 2, true));
      const pos: Array<[number, number[]]> = [], rot: Array<[number, number[]]> = [];
      for (let f = 0; f < frames; f++) {
        const v: number[] = [];
        for (let j = 0; j < 6; j++) v.push(bones[b]!.val[j]! + (offs[j] ? animValue(src.u8, src.dv, base, offs[j]!, f) * bones[b]!.sc[j]! : 0));
        pos.push([f, [v[0]!, v[1]!, v[2]!]]);
        rot.push([f, angleQuat([v[3]!, v[4]!, v[5]!])]);
      }
      chan.set(b, { pos, rot, scl: null });
    }
    motions.push({ kind: 'node', name: label, tps: fps, chan, duration: frames / fps, frames });
  }
  const info = [`GoldSrc MDL: костей ${nBones}, мешей ${meshes.length}, треугольников ${sumTris(meshes)}, текстур ${textures.length}`,
    `Анимаций: ${motions.length} из ${nSeq}${nSeqGroups > 1 && motions.length < nSeq ? ' (нет внешних файлов NN.mdl с остальными)' : ''}`];
  if (!nTex && !extra.tex) info.push('Текстуры во внешнем файле *T.mdl — выберите его вместе с моделью или откройте «Папку игры…»');
  return { meshes, skeleton: sk, motions, bounds, flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, info };
}

// ================= Source 1 =================
function parseVvd(buf: ArrayBuffer) {
  const dv = new DataView(buf), I = (o: number) => dv.getInt32(o, true), F = (o: number) => dv.getFloat32(o, true);
  if (buf.byteLength < 64 || I(0) !== 0x56534449) throw new Error('Не VVD');
  const nLod0 = I(16), nFix = I(48), fixOff = I(52), vOff = I(56), tOff = I(60), total = Math.floor((tOff - vOff) / 48) || nLod0;
  let order: number[] | null = null;
  if (nFix > 0) {
    order = [];
    for (let i = 0; i < nFix; i++) { const lod = I(fixOff + i * 12), src = I(fixOff + i * 12 + 4), n = I(fixOff + i * 12 + 8); if (lod >= 0) for (let k = 0; k < n; k++) order.push(src + k); }
  }
  const count = order ? order.length : nLod0, pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const o = vOff + (order ? order[i]! : i) * 48;
    if (o + 48 > buf.byteLength || (order && order[i]! >= total)) throw new Error('VVD: вершина вне файла');
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = F(o + 16 + k * 4); nor[i * 3 + k] = F(o + 28 + k * 4); }
    uv[i * 2] = F(o + 40); uv[i * 2 + 1] = F(o + 44);
  }
  return { count, pos, nor, uv };
}

interface BodyPart { meshes: Array<{ material: number; numVertices: number; vertexOffset: number }>; vertBase: number; cumBase?: number }

/** VTX: раскладка различается между версиями — перебираем размеры заголовков и проверяем границы. */
function parseVtx(buf: ArrayBuffer, parts: BodyPart[], vvdCount: number, sgSize: number, meshSize: number): number[][][] {
  const dv = new DataView(buf), I = (o: number) => dv.getInt32(o, true), U16 = (o: number) => dv.getUint16(o, true), out: number[][][] = [];
  const nBP = I(28), oBP = I(32);
  if (nBP !== parts.length) throw new Error('VTX: число частей тела не совпадает');
  for (let b = 0; b < nBP; b++) {
    const bp = oBP + b * 8, nModels = I(bp), mOff = I(bp + 4), res: number[][] = [];
    if (nModels < 1) { out.push(res); continue; }
    const model = bp + mOff, lod = model + I(model + 4), nMesh = I(lod), meshOff = I(lod + 4);
    if (nMesh !== parts[b]!.meshes.length) throw new Error('VTX: число мешей не совпадает');
    for (let k = 0; k < nMesh; k++) {
      const mesh = lod + meshOff + k * meshSize, nSG = I(mesh), sgOff = I(mesh + 4), idx: number[] = [];
      if (nSG < 0 || nSG > 4096) throw new Error('VTX: странное число strip group');
      for (let g = 0; g < nSG; g++) {
        const sg = mesh + sgOff + g * sgSize, nV = I(sg), vOff = I(sg + 4), nI = I(sg + 8), iOff = I(sg + 12);
        if (nV < 0 || nI < 0 || sg + vOff + nV * 9 > buf.byteLength || sg + iOff + nI * 2 > buf.byteLength) throw new Error('VTX: выход за границы');
        for (let i = 0; i < nI; i++) {
          const vi = U16(sg + iOff + i * 2);
          if (vi >= nV) throw new Error('VTX: индекс вне группы');
          const orig = U16(sg + vOff + vi * 9 + 4), gi = parts[b]!.vertBase + parts[b]!.meshes[k]!.vertexOffset + orig;
          if (gi >= vvdCount) throw new Error('VTX: вершина вне VVD');
          idx.push(gi);
        }
      }
      res.push(idx);
    }
    out.push(res);
  }
  return out;
}

/**
 * VTX Troika (VTMB, версия 107): меш = u16 strip group, u16 флаги, i32 смещение; strip group 20 байт =
 * u16 вершин, u16 индексов, u32 ?, i32 смещения вершин/индексов/полос. Размер вершины разный (2 байта у статики,
 * 12 со скинингом) — считаем по разрыву до следующего блока; номер вершины меша — последние 2 байта.
 */
function parseVtxTroika(buf: ArrayBuffer, parts: BodyPart[], vertCount: number): number[][][] {
  const dv = new DataView(buf), I = (o: number) => dv.getInt32(o, true), U16 = (o: number) => dv.getUint16(o, true), out: number[][][] = [];
  const nBP = I(28), oBP = I(32);
  if (nBP !== parts.length) throw new Error('VTX: число частей тела не совпадает');
  interface SG { b: number; k: number; nV: number; nI: number; vo: number; io: number }
  const groups: SG[] = [], starts: number[] = [];
  for (let b = 0; b < nBP; b++) {
    const bp = oBP + b * 8, nModels = I(bp);
    if (nModels < 1) continue;
    const model = bp + I(bp + 4), lod = model + I(model + 4), nMesh = I(lod), meshOff = lod + I(lod + 4);
    if (nMesh !== parts[b]!.meshes.length) throw new Error('VTX: число мешей не совпадает');
    for (let k = 0; k < nMesh; k++) {
      const ms = meshOff + k * 8, nSG = U16(ms), sgOff = ms + I(ms + 4);
      for (let g = 0; g < nSG; g++) {
        const sg = sgOff + g * 20, x: SG = { b, k, nV: U16(sg), nI: U16(sg + 2), vo: sg + I(sg + 8), io: sg + I(sg + 12) };
        if (x.vo < 0 || x.io < 0 || x.io + x.nI * 2 > buf.byteLength) throw new Error('VTX: выход за границы');
        groups.push(x);
      }
    }
  }
  // все блоки вершин/индексов файла (и LOD > 0) — чтобы найти конец каждого блока вершин
  const scan = (o: number, n: number, f: (o: number) => void) => { for (let i = 0; i < n; i++) f(o + i * 8); };
  for (let b = 0; b < nBP; b++) {
    const bp = oBP + b * 8;
    for (let mi = 0; mi < I(bp); mi++) {
      const model = bp + I(bp + 4) + mi * 8, nLod = I(model), lod0 = model + I(model + 4);
      for (let l = 0; l < nLod; l++) {
        const lod = lod0 + l * 12;
        scan(lod + I(lod + 4), I(lod), (ms) => { const sgOff = ms + I(ms + 4); for (let g = 0; g < U16(ms); g++) { const sg = sgOff + g * 20; starts.push(sg + I(sg + 8), sg + I(sg + 12)); } });
      }
    }
  }
  starts.push(buf.byteLength);
  starts.sort((a, b) => a - b);
  for (let b = 0; b < nBP; b++) out.push(parts[b]!.meshes.map(() => []));
  for (const x of groups) {
    if (!x.nV) continue;
    const next = starts.find((o) => o > x.vo) ?? buf.byteLength, part = parts[x.b]!, mesh = part.meshes[x.k]!, idx = out[x.b]![x.k]!;
    // обычно блок вершин кончается там, где начинается следующий; если между ними что-то ещё — пробуем 12 и 2 байта
    const fits = (sz: number) => { if (x.vo + x.nV * sz > buf.byteLength) return false; for (let i = 0; i < x.nV; i++) if (U16(x.vo + i * sz + sz - 2) >= mesh.numVertices) return false; return true; };
    const size = [Math.floor((next - x.vo) / x.nV), 12, 2].find((sz) => sz >= 2 && sz <= 16 && fits(sz));
    if (!size) throw new Error('VTX: не удалось определить размер вершины');
    for (let i = 0; i < x.nI; i++) {
      const vi = U16(x.io + i * 2);
      if (vi >= x.nV) throw new Error('VTX: индекс вне группы');
      const id = U16(x.vo + vi * size + size - 2), gi = part.vertBase + mesh.vertexOffset + id;
      if (id >= mesh.numVertices || gi >= vertCount) throw new Error('VTX: вершина вне меша');
      idx.push(gi);
    }
  }
  return out;
}

interface SourceVerts { count: number; pos: Float32Array; nor: Float32Array | null; uv: Float32Array; bone?: Float32Array; weight?: Float32Array }

/** Меши из VTX (LOD 0) по общему массиву вершин; материалы — через таблицу скинов и пути cdtextures. */
function sourceMeshes(parts: BodyPart[], vvd: SourceVerts, vtxBuf: ArrayBuffer, texNames: string[], skin0: number[], cd: string[]): Mesh[] {
  let tri: number[][][] | null = null, lastErr: unknown;
  if (vtxBuf.byteLength >= 36 && new DataView(vtxBuf).getInt32(0, true) === 107) tri = parseVtxTroika(vtxBuf, parts, vvd.count);
  if (!tri) for (const [sg, ms] of [[25, 9], [33, 9], [25, 12], [33, 12]] as const) { try { tri = parseVtx(vtxBuf, parts, vvd.count, sg, ms); break; } catch (e) { lastErr = e; } }
  if (!tri) for (const p of parts) p.vertBase = p.cumBase ?? 0;
  if (!tri) for (const [sg, ms] of [[25, 9], [33, 9]] as const) { try { tri = parseVtx(vtxBuf, parts, vvd.count, sg, ms); break; } catch (e) { lastErr = e; } }
  if (!tri) throw new Error('Не удалось разобрать VTX: ' + (lastErr instanceof Error ? lastErr.message : ''));
  const meshes: Mesh[] = [];
  parts.forEach((p, b) => p.meshes.forEach((m, k) => {
    const idx = tri![b]![k];
    if (!idx || !idx.length) return;
    const map = new Map<number, number>(), src: number[] = [];
    const local = idx.map((g) => { let v = map.get(g); if (v === undefined) { v = src.length; map.set(g, v); src.push(g); } return v; });
    const n = src.length, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const bone = new Float32Array(n * 4), weight = new Float32Array(n * 4);
    src.forEach((g, i) => {
      pos.set(vvd.pos.subarray(g * 3, g * 3 + 3), i * 3); if (vvd.nor) nor.set(vvd.nor.subarray(g * 3, g * 3 + 3), i * 3); uv.set(vvd.uv.subarray(g * 2, g * 2 + 2), i * 2);
      if (vvd.bone && vvd.weight) { bone.set(vvd.bone.subarray(g * 4, g * 4 + 4), i * 4); weight.set(vvd.weight.subarray(g * 4, g * 4 + 4), i * 4); }
    });
    const name = texNames[skin0[m.material] !== undefined ? skin0[m.material]! : m.material] ?? '';
    const dirs = cd.length ? cd : [''];
    const paths = dirs.map((d) => `materials/${d && !d.endsWith('/') ? d + '/' : d}${name}.vmt`.replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/'));
    const indices = makeIndices(n, local);
    meshes.push({ name: `body ${b} / mesh ${k}`, texture: name, materialPaths: paths, shader: '', vertexCount: n, pos, nor: vvd.nor ? nor : computeNormals(pos, indices), uv,
      bone, weight, indices, skinned: !!vvd.bone });
  }));
  if (!meshes.length) throw new Error('В Source-модели нет геометрии');
  return meshes;
}

/**
 * MDL v2531 — ранний Source студии Troika (VTMB): имя модели 128 байт (заголовок сдвинут на +88 от v44),
 * вершины лежат в самом MDL (44 байта: веса 12, позиция, нормаль, UV), VVD нет; индексы — обычный .dx80.vtx.
 */
export function loadVtmb(mdl: ArrayBuffer, vtxBuf: ArrayBuffer, skin = 0): Model {
  const dv = new DataView(mdl), u8 = new Uint8Array(mdl), I = (o: number) => dv.getInt32(o, true), F = (o: number) => dv.getFloat32(o, true);
  if (I(0) !== 0x54534449 || I(4) !== 2531) throw new Error('Не MDL v2531 (VTMB)');
  const nTex = I(292), oTex = I(296), nCd = I(300), oCd = I(304), nSkinRef = I(308), oSkin = I(316), nBody = I(320), oBody = I(324);
  const texNames: string[] = [];
  for (let i = 0; i < nTex; i++) { const o = oTex + i * 20; texNames.push(cstr(u8, o + I(o), 128)); }
  const cd: string[] = [];
  for (let i = 0; i < nCd; i++) cd.push(cstr(u8, I(oCd + i * 4), 256).replace(/\\/g, '/').toLowerCase());
  const skin0: number[] = [], fam = Math.max(0, Math.min(skin, I(312) - 1));
  for (let i = 0; i < nSkinRef; i++) skin0.push(dv.getInt16(oSkin + (fam * nSkinRef + i) * 2, true));
  // тип вершин модели (@156): 0 — 44 байта (веса, float позиция/нормаль/UV); 1 — 12 байт (u16 позиция × масштаб + смещение,
  // u8 нормаль, u8 U/V); 2 — 8 байт (u8 позиция / 255 × размер + смещение). Нормали типов 1–2 грубые — пересчитываем.
  interface Chunk { off: number; n: number; type: number; o: number[]; s: number[] }
  const parts: BodyPart[] = [], chunks: Chunk[] = [];
  let cum = 0;
  for (let b = 0; b < nBody; b++) {
    const bp = oBody + b * 16, nModels = I(bp + 4), mo = bp + I(bp + 12);
    if (!nModels) { parts.push({ meshes: [], vertBase: cum, cumBase: cum }); continue; }
    const nMesh = I(mo + 136), oMesh = mo + I(mo + 140), numVerts = I(mo + 144), vOff = mo + I(mo + 148), type = I(mo + 156), meshes: BodyPart['meshes'] = [];
    const size = type === 0 ? 44 : type === 1 ? 12 : type === 2 ? 8 : 0;
    if (!size) throw new Error(`MDL v2531: тип вершин ${type} не поддерживается`);
    if (nMesh < 0 || nMesh > 4096 || numVerts < 0 || vOff + numVerts * size > mdl.byteLength) throw new Error('MDL v2531: неожиданная раскладка модели');
    for (let k = 0; k < nMesh; k++) { const o = oMesh + k * 60; meshes.push({ material: I(o), numVertices: I(o + 8), vertexOffset: I(o + 12) }); }
    parts.push({ meshes, vertBase: cum, cumBase: cum });
    chunks.push({ off: vOff, n: numVerts, type, o: [F(mo + 160), F(mo + 164), F(mo + 168)], s: [F(mo + 172), F(mo + 176), F(mo + 180)] });
    cum += numVerts;
  }
  const pos = new Float32Array(cum * 3), nor = new Float32Array(cum * 3), uv = new Float32Array(cum * 2);
  const vb = vtmbBones(mdl), skinned = vb.length > 1 && chunks.some((c) => c.type === 0);
  const vbone = new Float32Array(cum * 4), vweight = new Float32Array(cum * 4);
  let g = 0, compact = false;
  for (const c of chunks)
    for (let i = 0; i < c.n; i++, g++) {
      if (c.type === 0) {
        const o = c.off + i * 44;
        for (let k = 0; k < 3; k++) { pos[g * 3 + k] = F(o + 12 + k * 4); nor[g * 3 + k] = F(o + 24 + k * 4); }
        // веса u8[3] (сумма 255) и кости i16[3]
        const sw = u8[o]! + u8[o + 1]! + u8[o + 2]! || 1;
        for (let k = 0; k < 3; k++) { const bi = dv.getInt16(o + 4 + k * 2, true); if (u8[o + k] && bi >= 0 && bi < vb.length) { vbone[g * 4 + k] = bi; vweight[g * 4 + k] = u8[o + k]! / sw; } }
        if (!u8[o] && !u8[o + 1] && !u8[o + 2]) vweight[g * 4] = 1;
        uv[g * 2] = F(o + 36); uv[g * 2 + 1] = F(o + 40);
      } else if (c.type === 1) {
        const o = c.off + i * 12; compact = true;
        for (let k = 0; k < 3; k++) pos[g * 3 + k] = c.o[k]! + dv.getUint16(o + k * 2, true) * c.s[k]!;
        uv[g * 2] = u8[o + 9]! / 255; uv[g * 2 + 1] = u8[o + 11]! / 255;
      } else {
        const o = c.off + i * 8; compact = true;
        for (let k = 0; k < 3; k++) pos[g * 3 + k] = c.o[k]! + (u8[o + k]! / 255) * c.s[k]!;
        uv[g * 2] = u8[o + 5]! / 255; uv[g * 2 + 1] = u8[o + 7]! / 255;
      }
    }
  // у сжатых вершин (тип 1–2) весов нет — привязка к корню
  if (skinned) { let g2 = 0; for (const c of chunks) { if (c.type) for (let i = 0; i < c.n; i++) vweight[(g2 + i) * 4] = 1; g2 += c.n; } }
  const meshes = sourceMeshes(parts, { count: cum, pos, nor: compact ? null : nor, uv, ...(skinned ? { bone: vbone, weight: vweight } : {}) }, vtxBuf, texNames, skin0, cd);
  const info = [`VTMB MDL v2531: частей тела ${nBody}, мешей ${meshes.length}, треугольников ${sumTris(meshes)}, текстур ${nTex}, костей ${vb.length}`];
  if (!skinned) return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, info };
  const sk = new NodeSkeleton(vtmbNodes(vb)), target = new Map(vb.map((b, i) => [b.name.toLowerCase(), i] as const));
  const motions: NodeMotion[] = vtmbAnimList(mdl).map((d) => decodeVtmbAnim(mdl, d, vb, target));
  return { meshes, skeleton: sk, motions, bounds: skinnedBounds(sk, meshes), flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, info };
}

export function loadSource(mdl: ArrayBuffer, vvdBuf: ArrayBuffer, vtxBuf: ArrayBuffer): Model {
  const dv = new DataView(mdl), u8 = new Uint8Array(mdl), I = (o: number) => dv.getInt32(o, true);
  if (I(0) !== 0x54534449) throw new Error('Не Source MDL');
  const version = I(4);
  if (version < 44 || version > 49) throw new Error(`Source MDL v${version} пока не поддерживается (44–49)`);
  const nTex = I(204), oTex = I(208), nCd = I(212), oCd = I(216), nSkinRef = I(220), oSkin = I(228), nBody = I(232), oBody = I(236);
  const texNames: string[] = [];
  for (let i = 0; i < nTex; i++) { const o = oTex + i * 64; texNames.push(cstr(u8, o + I(o), 128)); }
  const cd: string[] = [];
  for (let i = 0; i < nCd; i++) cd.push(cstr(u8, I(oCd + i * 4), 256).replace(/\\/g, '/').toLowerCase());
  const skin0: number[] = [];
  for (let i = 0; i < nSkinRef; i++) skin0.push(dv.getInt16(oSkin + i * 2, true));
  const parts: BodyPart[] = [];
  let cum = 0;
  for (let b = 0; b < nBody; b++) {
    const bp = oBody + b * 16, nModels = I(bp + 4), mo = bp + I(bp + 12);
    if (!nModels) { parts.push({ meshes: [], vertBase: 0 }); continue; }
    const nMesh = I(mo + 72), oMesh = mo + I(mo + 76), numVerts = I(mo + 80), vIdx = I(mo + 84), meshes: BodyPart['meshes'] = [];
    for (let k = 0; k < nMesh; k++) { const o = oMesh + k * 116; meshes.push({ material: I(o), numVertices: I(o + 8), vertexOffset: I(o + 12) }); }
    const base = vIdx % 48 === 0 ? vIdx / 48 : cum;
    parts.push({ meshes, vertBase: base, cumBase: cum });
    cum += numVerts;
  }
  const vvd = parseVvd(vvdBuf);
  const meshes = sourceMeshes(parts, vvd, vtxBuf, texNames, skin0, cd);
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2,
    info: [`Source MDL v${version}: частей тела ${nBody}, мешей ${meshes.length}, треугольников ${sumTris(meshes)}`, 'LOD 0, поза покоя. Скелет и анимации (sequences/.ani) — следующая часть.'] };
}

// ================= вход =================
export async function loadValveMdl(main: VFile, ctx: LoadContext): Promise<Model> {
  const buf = await main.arrayBuffer(), dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getInt32(0, true) !== 0x54534449) throw new Error('Не Valve MDL (нет сигнатуры IDST)');
  const version = dv.getInt32(4, true), base = main.name.toLowerCase().replace(/\.mdl$/, '');
  if (version === 10) {
    const extra: GoldsrcExtra = { seq: new Map() }, nGroups = dv.getInt32(172, true);
    extra.tex = await ctx.sibling(base + 't.mdl');
    for (let g = 1; g < nGroups; g++) { const b = await ctx.sibling(`${base}${String(g).padStart(2, '0')}.mdl`); if (b) extra.seq!.set(g, b); }
    return loadGoldsrc(buf, extra);
  }
  if (version >= 44 && version <= 49) {
    const vvd = await ctx.sibling(base + '.vvd');
    let vtx: ArrayBuffer | null = null;
    for (const s of ['.dx90.vtx', '.dx80.vtx', '.sw.vtx', '.vtx']) { vtx = await ctx.sibling(base + s); if (vtx) break; }
    if (!vvd || !vtx) throw new Error(`Для Source-модели нужны ${base}.vvd и ${base}.dx90.vtx рядом (выберите их вместе или откройте «Папку игры…»/VPK)`);
    return loadSource(buf, vvd, vtx);
  }
  if (version === 2531) {
    let vtx: ArrayBuffer | null = null;
    // модель из папки мода (Unofficial_Patch) может брать .vtx из packNNN.vpk: ищем и по пути от models/
    const rel = main.path && /(^|\/)models\//.test(main.path) ? main.path.slice(main.path.search(/(^|\/)models\//)).replace(/^\//, '').replace(/\.mdl$/, '') : '';
    for (const s of ['.dx80.vtx', '.dx7_2bone.vtx', '.vtx']) {
      vtx = await ctx.sibling(base + s);
      if (!vtx && rel) { const r = await ctx.readPath(rel + s); if (r) vtx = r.slice().buffer; }
      if (vtx) break;
    }
    if (!vtx) throw new Error(`Для модели VTMB нужен ${base}.dx80.vtx рядом (выберите его вместе с .mdl или откройте папку игры)`);
    const model = loadVtmb(buf, vtx);
    if (model.skeleton) await vtmbIncludeMotions(model, buf, (p) => ctx.readPath(p));
    return model;
  }
  throw new Error(`Valve MDL версии ${version} не поддерживается`);
}

/** Модель по пути в архивах (реквизит карт): VTMB v2531 + .dx80.vtx или Source v44–49 + .vvd + .vtx. */
export async function loadMdlByPath(path: string, read: (p: string) => Promise<Uint8Array | null>, skin = 0, anims = false): Promise<Model | null> {
  const ab = (u: Uint8Array | null) => (u ? (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? (u.buffer as ArrayBuffer) : u.slice().buffer) : null);
  const mdl = ab(await read(path));
  if (!mdl || mdl.byteLength < 8) return null;
  const v = new DataView(mdl).getInt32(4, true), base = path.replace(/\.mdl$/, '');
  const first = async (exts: string[]) => { for (const e of exts) { const b = ab(await read(base + e)); if (b) return b; } return null; };
  if (v === 2531) {
    const vtx = await first(['.dx80.vtx', '.dx7_2bone.vtx', '.vtx']);
    if (!vtx) return null;
    const m = loadVtmb(mdl, vtx, skin);
    if (anims && m.skeleton) await vtmbIncludeMotions(m, mdl, read);
    return m;
  }
  if (v >= 44 && v <= 49) {
    const vvd = await first(['.vvd']), vtx = await first(['.dx90.vtx', '.dx80.vtx', '.sw.vtx', '.vtx']);
    return vvd && vtx ? loadSource(mdl, vvd, vtx) : null;
  }
  return null;
}

/** Общие анимации VTMB из include-моделей (рекурсивно): список сразу, данные кадров — при выборе. */
export async function vtmbIncludeMotions(model: Model, buf: ArrayBuffer, read: (p: string) => Promise<Uint8Array | null>): Promise<void> {
  const vb = vtmbBones(buf), target = new Map(vb.map((b, i) => [b.name.toLowerCase(), i] as const));
  const seen = new Set<string>(), names = new Set(model.motions.map((m) => m.name.toLowerCase())), queue = vtmbIncludes(buf);
  let files = 0, missing = 0;
  const deltas = new Set<Motion>();
  vtmbAnimList(buf).forEach((d) => { if (d.flags & 0x10) { const m = model.motions.find((x) => x.name === d.name); if (m) deltas.add(m); } });
  // последовательности со смешиванием (бег/ходьба по направлениям): анимации читаются при выборе
  let blends = 0;
  const addBlends = (ib: ArrayBuffer, src: ReturnType<typeof vtmbBones>, label: string) => {
    const descs = new Map(vtmbAnimList(ib).map((d) => [d.index, d] as const));
    for (const sq of vtmbSeqList(ib)) {
      const ds = sq.anims.map((i) => descs.get(i));
      if (ds.some((d) => !d)) continue;
      const first = ds[0]!, name = `${sq.name} ⇄ ${sq.params.map((p) => p.name).join(', ')}`;
      if (names.has(name.toLowerCase())) continue;
      names.add(name.toLowerCase());
      const stub: NodeMotion = { kind: 'node', name, tps: first.fps, chan: new Map(), duration: Math.max(1, first.frames - 1) / first.fps, frames: first.frames, source: label,
        load: async () => {
          const cache = new Map<number, NodeMotion>();
          const motions = ds.map((d) => { let mo = cache.get(d!.index); if (!mo) cache.set(d!.index, (mo = decodeVtmbAnim(ib, d!, src, target))); return mo; });
          // середина сетки по умолчанию (move_yaw 0 — вперёд)
          return { ...motions[0]!, name, blend: { motions, cols: sq.cols, rows: sq.rows, x: (sq.cols - 1) / 2, y: (sq.rows - 1) / 2, params: sq.params } };
        } };
      model.motions.push(stub);
      blends++;
    }
  };
  addBlends(buf, vb, 'model');
  while (queue.length && seen.size < 64) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const u = await read(path);
    if (!u) { missing++; continue; }
    const ib = u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? (u.buffer as ArrayBuffer) : u.slice().buffer;
    if (ib.byteLength < 420 || new DataView(ib).getInt32(4, true) !== 2531) continue;
    files++;
    queue.push(...vtmbIncludes(ib));
    const src = vtmbBones(ib), label = path.split('/').pop()!.replace(/\.mdl$/, '');
    addBlends(ib, src, label);
    for (const d of vtmbAnimList(ib)) {
      // одноимённые анимации разных файлов (idle01 у pc_idles и misc) — обе, вторая с именем файла
      const dup = names.has(d.name.toLowerCase()), name = dup ? `${d.name} (${label})` : d.name;
      if (names.has(name.toLowerCase())) continue;
      names.add(name.toLowerCase());
      const stub: NodeMotion = { kind: 'node', name, tps: d.fps, chan: new Map(), duration: Math.max(1, d.frames - 1) / d.fps, frames: d.frames, source: label,
        load: async () => decodeVtmbAnim(ib, d, src, target) };
      model.motions.push(stub);
      if (d.flags & 0x10) deltas.add(stub);
    }
  }
  // частичные (…_layer) и дельта-анимации (…_delta, флаг 0x10) показываем поверх базовой стойки
  const rest = vb.map((b) => ({ t: b.pos, q: [b.q[3]!, b.q[0]!, b.q[1]!, b.q[2]!] }));
  const plain = (m: Motion) => m.name.toLowerCase().replace(/ \(.*\)$/, '');
  const byName = new Map<string, Motion>();
  for (const m of model.motions) if (!byName.has(plain(m))) byName.set(plain(m), m);
  const isOverlay = (m: Motion) => deltas.has(m) || /_layer$/.test(plain(m));
  let layered = 0;
  for (const m of model.motions) {
    if (m.kind !== 'node' || !isOverlay(m)) continue;
    const stem = plain(m).replace(/_(layer|delta)$/, ''), prefix = stem.split('_')[0]!;
    const base = [byName.get(`${prefix}_idle`), byName.get(stem)].find((x) => x && !isOverlay(x)) ?? pickIdle(model.motions.filter((x) => !isOverlay(x)));
    if (!base || base.kind !== 'node') continue;
    const own = m.load ?? null, eager: NodeMotion = { ...m };
    const mode = deltas.has(m) ? 'add' : 'fill';
    m.load = async () => {
      const top = (own ? await own() : eager) as NodeMotion;
      const b = (base.load && !base.chan.size ? await base.load() : base) as NodeMotion;
      return { ...vtmbCompose(b, top, mode, rest), name: m.name };
    };
    (m as NodeMotion).source = `${m.source && m.source !== 'model' ? m.source + ' · ' : ''}${mode === 'add' ? '+' : 'поверх'} ${base.name}`;
    layered++;
  }
  if (files || missing) model.info.push(`Анимации: своих и общих ${model.motions.length} (include-моделей ${files}${missing ? `, не найдено ${missing}` : ''}); частичных и дельта-анимаций поверх стойки ${layered}; смешиваемых последовательностей ${blends}`);
}

/** Анимация для позы персонажа на карте: заданная сущностью, иначе «idle» (свои — раньше общих). */
export function pickIdle(motions: readonly Motion[], wanted?: string): Motion | null {
  // анимации игрока (pc_idles и т. п.) — в последнюю очередь: у NPC в игре свои
  const order = [...motions.filter((m) => !/^pc|pcidles/i.test(m.source ?? '')), ...motions.filter((m) => /^pc|pcidles/i.test(m.source ?? ''))];
  const by = (f: (n: string) => boolean) => order.find((m) => f(m.name.toLowerCase().replace(/ \(.*\)$/, '')));
  const w = wanted?.toLowerCase().replace(/^@/, '');
  return (w && w !== 'none' ? by((n) => n === w) : undefined) ?? by((n) => n === 'idle01' || n === 'idle' || n === 'idle1')
    ?? by((n) => /^stance_.*idle_1$/.test(n)) ?? by((n) => /^idle/.test(n)) ?? by((n) => /(^|_)idle$/.test(n) && !/feed|layer/.test(n))
    ?? order.find((m) => !m.source) ?? null;
}

/** Запечь позу (кадр t анимации) в вершины скинованных мешей — для статичных персонажей на картах. */
export async function bakePose(model: Model, motion: Motion | null, t = 0): Promise<Mesh[]> {
  const sk = model.skeleton;
  if (!sk) return model.meshes;
  let mo = motion;
  if (mo?.load && mo.kind === 'node' && !mo.chan.size) mo = await mo.load();
  sk.pose(mo, t, false);
  const S = (sk as NodeSkeleton).skinV;
  return model.meshes.map((m) => {
    if (!m.skinned) return m;
    const n = m.vertexCount, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      const x = m.pos[v * 3]!, y = m.pos[v * 3 + 1]!, z = m.pos[v * 3 + 2]!, a = m.nor[v * 3]!, b = m.nor[v * 3 + 1]!, c = m.nor[v * 3 + 2]!;
      for (let k = 0; k < 4; k++) {
        const w = m.weight[v * 4 + k]!;
        if (!w) continue;
        const M = S[m.bone[v * 4 + k]!]!;
        pos[v * 3] += w * (M[0]! * x + M[4]! * y + M[8]! * z + M[12]!); pos[v * 3 + 1] += w * (M[1]! * x + M[5]! * y + M[9]! * z + M[13]!); pos[v * 3 + 2] += w * (M[2]! * x + M[6]! * y + M[10]! * z + M[14]!);
        nor[v * 3] += w * (M[0]! * a + M[4]! * b + M[8]! * c); nor[v * 3 + 1] += w * (M[1]! * a + M[5]! * b + M[9]! * c); nor[v * 3 + 2] += w * (M[2]! * a + M[6]! * b + M[10]! * c);
      }
      const l = Math.hypot(nor[v * 3]!, nor[v * 3 + 1]!, nor[v * 3 + 2]!) || 1;
      for (let k = 0; k < 3; k++) nor[v * 3 + k] /= l;
    }
    return { ...m, pos, nor, skinned: false };
  });
}
