// Valve: GoldSrc (Half-Life 1, MDL «IDST» v10: скелет, анимации, внешние T.mdl/01.mdl) и Source 1 (MDL v44–49 + VVD + VTX, статика).
import { cstr } from '../../core/binary';
import { boundsOf, makeIndices, skinnedBounds, sumTris } from '../../core/geometry';
import { quatMat } from '../../core/math';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { LoadContext } from '../../core/plugin';
import type { DecodedImage, Mesh, Model, NodeChannel, NodeMotion, VFile } from '../../core/types';

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
  let tri: number[][][] | null = null, lastErr: unknown;
  for (const [sg, ms] of [[25, 9], [33, 9], [25, 12], [33, 12]] as const) { try { tri = parseVtx(vtxBuf, parts, vvd.count, sg, ms); break; } catch (e) { lastErr = e; } }
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
    src.forEach((g, i) => { pos.set(vvd.pos.subarray(g * 3, g * 3 + 3), i * 3); nor.set(vvd.nor.subarray(g * 3, g * 3 + 3), i * 3); uv.set(vvd.uv.subarray(g * 2, g * 2 + 2), i * 2); });
    const name = texNames[skin0[m.material] !== undefined ? skin0[m.material]! : m.material] ?? '';
    const dirs = cd.length ? cd : [''];
    const paths = dirs.map((d) => `materials/${d && !d.endsWith('/') ? d + '/' : d}${name}.vmt`.replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/'));
    meshes.push({ name: `body ${b} / mesh ${k}`, texture: name, materialPaths: paths, shader: '', vertexCount: n, pos, nor, uv, bone: new Float32Array(n * 4), weight: new Float32Array(n * 4),
      indices: makeIndices(n, local), skinned: false });
  }));
  if (!meshes.length) throw new Error('В Source-модели нет геометрии');
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
  throw new Error(`Valve MDL версии ${version} не поддерживается`);
}
