// Меши Unreal Engine 2 из пакетов (Lineage II): StaticMesh (.usx) и SkeletalMesh (.ukx) с анимациями MeshAnimation.
// Пространство UE — левое, Z вверх, сантиметры: в просмотрщике Y отражается (x, −y, z), ×0.01 — метры. Одно отражение
// делает исходный порядок вершин треугольников правильным (лицевые — против часовой).
import { boundsOf, skinnedBounds } from '../../core/geometry';
import { compose, mulCol } from '../../core/math';
import { NodeSkeleton, type SkeletonNode } from '../../core/skeleton';
import type { DecodedImage, Mesh, Model, NodeChannel, NodeMotion, VFile } from '../../core/types';
import { findMaterialByName, findMaterialMatching, resolveObj, ue2PackageOf } from './ue2archive';
import { propObj, readProps, UReader, type UExport, type UPackage, type UProp } from './ue2pkg';
import { decodeUeTexture, resolveMaterial } from './ue2tex';

const S = 0.01;

/** Массив структур в свойстве-массиве: у каждого элемента свой список свойств до «None». */
function structArray(pkg: UPackage, p: UProp | undefined): Array<Map<string, UProp>> {
  const v = p?.value as { array?: Uint8Array } | undefined;
  if (!v?.array) return [];
  const r = new UReader(v.array, pkg.ver, pkg.lic), n = r.idx(), out: Array<Map<string, UProp>> = [];
  for (let i = 0; i < n && r.pos < r.u8.length; i++) out.push(readProps(pkg, r));
  return out;
}
/** Массив ссылок на объекты в свойстве-массиве. */
function objArray(pkg: UPackage, p: UProp | undefined): number[] {
  const v = p?.value as { array?: Uint8Array } | undefined;
  if (!v?.array) return [];
  const r = new UReader(v.array, pkg.ver, pkg.lic);
  return r.arr((x) => x.idx(), 4096);
}
/** Ленивый массив: смещение конца (пропускаем) и обычный TArray. */
const lazy = <T>(r: UReader, fn: (r: UReader) => T, max?: number): T[] => { r.i32(); return r.arr(fn, max); };
const skip = (r: UReader, n: number) => { r.need(n); r.pos += n; };

// ---------- материалы ----------
interface MatInfo { name: string; image?: DecodedImage; alpha: 'none' | 'test' | 'blend'; twoSided: boolean; error?: string }
const texCache = new WeakMap<UPackage, Map<number, Promise<DecodedImage>>>();

export async function material(pkg: UPackage, ref: number): Promise<MatInfo> {
  const name = ref ? pkg.objPath(ref) : '';
  if (!ref) return { name: '', alpha: 'none', twoSided: false };
  try {
    const t = await resolveMaterial(pkg, ref, resolveObj);
    if (!t) return { name, alpha: 'none', twoSided: false, error: (await resolveObj(pkg, ref)) ? 'нет базовой текстуры' : `пакет «${pkg.objPath(ref).split('.')[0]}» не открыт` };
    let m = texCache.get(t.pkg);
    if (!m) texCache.set(t.pkg, (m = new Map()));
    const key = t.pkg.exports.indexOf(t.exp);
    let img = m.get(key);
    if (!img) m.set(key, (img = decodeUeTexture(t.pkg, t.exp, resolveObj).then((x) => ({ ...x, name: t.exp.name }))));
    return { name, image: await img, alpha: t.alpha, twoSided: t.twoSided };
  } catch (e) { return { name, alpha: 'none', twoSided: false, error: (e as Error).message }; }
}

export function makeMesh(name: string, mat: MatInfo, P: number[], N: number[], U: number[], I: number[], B?: number[], W?: number[]): Mesh {
  const nv = P.length / 3;
  return {
    name, texture: mat.name, vertexCount: nv, pos: Float32Array.from(P), nor: Float32Array.from(N), uv: Float32Array.from(U),
    bone: B ? Float32Array.from(B) : new Float32Array(nv * 4), weight: W ? Float32Array.from(W) : new Float32Array(nv * 4).map((_, k) => (k % 4 === 0 ? 1 : 0)),
    indices: nv > 65535 ? Uint32Array.from(I) : Uint16Array.from(I), skinned: !!B,
    ...(mat.image ? { image: mat.image } : {}), ...(mat.alpha !== 'none' ? { alphaTest: true } : {}),
  } as Mesh;
}

async function exportOf(main: VFile): Promise<{ pkg: UPackage; exp: UExport; r: UReader }> {
  const pkg = ue2PackageOf(main.archive);
  if (!pkg) throw new Error('Меш Unreal Engine 2 открывается из пакета (.usx/.ukx): откройте пакет или «Папку игры»');
  const { exp: i } = JSON.parse(new TextDecoder().decode(new Uint8Array(await main.arrayBuffer()))) as { exp: number };
  const exp = pkg.exports[i];
  if (!exp) throw new Error('Объект не найден в пакете');
  return { pkg, exp, r: await pkg.reader(exp) };
}

// ---------- StaticMesh ----------
export async function loadUe2StaticMesh(main: VFile): Promise<Model> {
  const { pkg, exp } = await exportOf(main);
  const sm = await staticMeshParts(pkg, exp);
  if (!sm.meshes.length) throw new Error(`${exp.name}: в StaticMesh нет треугольников`);
  const info = [`Unreal Engine 2 StaticMesh: ${pkg.objPath(pkg.exports.indexOf(exp) + 1)} (пакет v${pkg.ver}/${pkg.lic})`, `Секций ${sm.sections}, вершин ${sm.verts}, треугольников ${sm.tris}`];
  if (sm.missing.length) info.push(`Материалы без текстуры: ${[...new Set(sm.missing)].join('; ')}`);
  return { meshes: sm.meshes, skeleton: null, motions: [], bounds: boundsOf(sm.meshes), flipZ: false, defaultZUp: true, cameraYaw: 0, info };
}

/**
 * Части StaticMesh в нашем пространстве (метры, отражённая Y), по секциям с материалами.
 * skins — замены материалов секций (свойство Skins актора; ссылки в пакете skinPkg).
 */
export async function staticMeshParts(pkg: UPackage, exp: UExport, skins: number[] = [], skinPkg: UPackage = pkg): Promise<{ meshes: Mesh[]; missing: string[]; sections: number; verts: number; tris: number }> {
  const r = await pkg.reader(exp);
  const props = readProps(pkg, r);
  skip(r, 25 + 16); // BoundingBox, BoundingSphere
  const sections = r.arr((x) => { x.i32(); return { first: x.u16(), minV: x.u16(), maxV: x.u16(), unk: x.u16(), faces: x.u16() }; }, 4096);
  skip(r, 25); // BoundingBox ещё раз
  const verts = r.arr((x) => [x.f32(), x.f32(), x.f32(), x.f32(), x.f32(), x.f32()]); r.i32();
  r.arr((x) => x.bytes(4)); r.i32(); // цвета
  r.arr((x) => x.bytes(4)); r.i32(); // альфа
  const uvs = r.arr((x) => { const d = x.arr((y) => [y.f32(), y.f32()]); x.i32(); x.i32(); return d; }, 16);
  const idx = r.arr((x) => x.u16()); r.i32();
  const mats = structArray(pkg, props.get('Materials'));
  const meshes: Mesh[] = [], missing: string[] = [];
  const uv0 = uvs[0] ?? [];
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s]!;
    if (!sec.faces) continue;
    const mat = skins[s] ? await material(skinPkg, skins[s]!) : await material(pkg, mats[s] ? propObj(mats[s]!, 'Material') : 0);
    if (mat.error) missing.push(`${mat.name || '—'}: ${mat.error}`);
    const remap = new Map<number, number>(), P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    for (let k = 0; k < sec.faces * 3; k++) {
      const v = idx[sec.first + k];
      if (v === undefined || v >= verts.length) continue;
      let o = remap.get(v);
      if (o === undefined) {
        o = P.length / 3; remap.set(v, o);
        const x = verts[v]!;
        P.push(x[0]! * S, -x[1]! * S, x[2]! * S); N.push(x[3]!, -x[4]!, x[5]!);
        const t = uv0[v] ?? [0, 0]; U.push(t[0]!, t[1]!);
      }
      I.push(o);
    }
    if (I.length) meshes.push(makeMesh(`${s} · ${mat.name ? mat.name.split('.').pop() : 'без материала'}`, mat, P, N, U, I));
  }
  return { meshes, missing, sections: sections.length, verts: verts.length, tris: idx.length / 3 | 0 };
}

// ---------- SkeletalMesh ----------
interface Bone { name: string; q: number[]; t: number[]; parent: number }

/** Повороты UE (кватернион x, y, z, w; у некорневых костей — сопряжённый) в наше пространство с отражённой Y: [w, x, y, z]. */
const boneQuat = (x: number, y: number, z: number, w: number, root: boolean): number[] => (root ? [w, -x, y, -z] : [w, x, -y, z]);

export async function loadUe2SkeletalMesh(main: VFile): Promise<Model> {
  const { pkg, exp, r } = await exportOf(main);
  const props = readProps(pkg, r);
  skip(r, 25 + 16);
  // ULodMesh
  const version = r.i32();
  r.i32(); // VertexCount
  r.arr((x) => x.u32());
  if (version <= 1) throw new Error(`${exp.name}: старая версия меша ${version}`);
  const textures = r.arr((x) => x.idx(), 4096);
  const meshScale = r.vec(), meshOrigin = r.vec(), rot = [r.i32(), r.i32(), r.i32()];
  r.arr((x) => x.u16());
  r.arr((x) => x.bytes(8));
  r.arr((x) => x.u16());
  r.arr((x) => x.bytes(10));
  const lodMats = r.arr((x) => ({ flags: x.u32(), tex: x.i32() }), 4096);
  skip(r, 4 * 6);
  if (version >= 3) { r.i32(); r.idx(); skip(r, 12 + 12 + 12 + 4 + 12); }
  if (version >= 4) r.f32();
  if (version >= 5) r.i32();
  if (version >= 6) r.u8v();
  // USkeletalMesh
  r.arr((x) => x.vec());
  const bonesRaw = r.arr((x) => { const name = pkg.name(x.idx()); x.u32(); const q = [x.f32(), x.f32(), x.f32(), x.f32()], t = x.vec(); x.f32(); x.vec(); x.i32(); const parent = x.i32(); return { name, q, t, parent }; }, 1024);
  const animRef = r.idx();
  r.i32();
  r.arr((x) => { x.arr((y) => y.u16()); x.i32(); });
  r.arr((x) => x.bytes(4));
  r.arr((x) => x.idx()); r.arr((x) => x.idx()); r.arr((x) => x.bytes(48));
  const lods = r.arr((x) => readLod(x), 16);
  r.idx();
  const points = lazy(r, (x) => x.vec());
  const wedges = lazy(r, (x) => ({ v: x.u16(), u: x.f32(), w: x.f32() }));
  const tris = lazy(r, (x) => { const w = [x.u16(), x.u16(), x.u16()]; const m = x.u8v(); x.u8v(); x.u32(); return { w, m }; });
  const infl = lazy(r, (x) => ({ wt: x.f32(), p: x.u16(), b: x.u16() }));

  // геометрия: базовый меш; если пуст — LOD 0 (жёсткие секции и/или мягкие грани)
  let geo: { points: number[][]; wedges: Array<{ v: number; u: number; w: number }>; infl: Array<{ wt: number; p: number; b: number }>; faces: Array<{ w: number[]; m: number }> };
  if (points.length && wedges.length && tris.length) geo = { points, wedges, infl, faces: tris };
  else {
    const l = lods[0];
    if (!l || !l.points.length) throw new Error(`${exp.name}: в SkeletalMesh нет геометрии`);
    const faces: Array<{ w: number[]; m: number }> = [];
    if (!l.wedges.length && (l.stream.length || l.softIdx.length)) {
      // только поток вершин рендера (позиция, нормаль, UV) или точки и индексы секций: без влияний — привязка к корню
      const src = l.stream.length ? l.stream : l.points.map((p) => [p[0]!, p[1]!, p[2]!, 0, 0, 0, 0, 0]);
      const pts = src.map((v) => [v[0]!, v[1]!, v[2]!]), wd = src.map((v, i) => ({ v: i, u: v[6]!, w: v[7]! }));
      for (const s of l.soft) for (let i = 0; i < s.numFaces; i++) faces.push({ w: [0, 1, 2].map((k) => l.softIdx[s.firstFace * 3 + i * 3 + k] ?? 0), m: s.mat });
      for (const s of l.rigid) for (let i = 0; i < s.numFaces; i++) faces.push({ w: [0, 1, 2].map((k) => l.rigidIdx[s.firstFace * 3 + i * 3 + k] ?? 0), m: s.mat });
      geo = { points: pts, wedges: wd, infl: [], faces };
    } else {
    for (const s of l.soft) for (let i = 0; i < s.numFaces; i++) { const f = l.faces[s.firstFace + i]; if (f) faces.push({ w: f.w, m: s.mat }); }
    for (const s of l.rigid) for (let i = 0; i < s.numFaces; i++) faces.push({ w: [0, 1, 2].map((k) => l.rigidIdx[s.firstFace * 3 + i * 3 + k] ?? 0), m: s.mat });
    geo = { points: l.points, wedges: l.wedges, infl: l.infl, faces };
    }
  }

  // кости: локальные в нашем пространстве, мировые bind
  const bones: Bone[] = bonesRaw.map((b, i) => ({ name: b.name, q: boneQuat(b.q[0]!, b.q[1]!, b.q[2]!, b.q[3]!, i === 0), t: [b.t[0]! * S, -b.t[1]! * S, b.t[2]! * S], parent: i === 0 ? -1 : b.parent }));
  const local = bones.map((b) => { const m = new Float64Array(16); compose(b.t, b.q, [1, 1, 1], m); return m; });
  const world: Float64Array[] = [];
  bones.forEach((b, i) => { world[i] = b.parent >= 0 && b.parent < i ? mulCol(world[b.parent]!, local[i]!) : local[i]!; });
  // размещение меша (родитель корня): поворот RotOrigin · масштаб MeshScale · сдвиг −MeshOrigin
  const place = placement(meshScale, meshOrigin, rot);
  const nodes: SkeletonNode[] = [{ name: 'Mesh', parent: -1, local: place, offset: null, helper: true }];
  bones.forEach((b, i) => nodes.push({ name: b.name, parent: (b.parent >= 0 ? b.parent : -1) + 1, local: local[i]!, offset: affineInv(world[i]!) }));

  // влияния по точкам (до 4 самых весомых)
  const byPoint: Array<Array<[number, number]>> = geo.points.map(() => []);
  for (const f of geo.infl) if (f.p < byPoint.length && f.b < bones.length && f.wt > 1e-6) byPoint[f.p]!.push([f.b + 1, f.wt]);
  for (const l of byPoint) { l.sort((a, b) => b[1] - a[1]); if (l.length > 4) { l.length = 4; } const s = l.reduce((a, x) => a + x[1], 0) || 1; for (const x of l) x[1] /= s; }
  // нормали по точкам (по граням, в нашем пространстве)
  const PP = geo.points.map((p) => [p[0]! * S, -p[1]! * S, p[2]! * S]);
  const PN = geo.points.map(() => [0, 0, 0]);
  for (const f of geo.faces) {
    const [a, b, c] = f.w.map((w) => geo.wedges[w]?.v ?? 0) as [number, number, number];
    const A = PP[a], B = PP[b], C = PP[c];
    if (!A || !B || !C) continue;
    const e1 = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!], e2 = [C[0]! - A[0]!, C[1]! - A[1]!, C[2]! - A[2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) PN[v]![k]! += n[k]!;
  }
  // меши по материалам
  const groups = new Map<number, number[]>();
  for (const f of geo.faces) { let g = groups.get(f.m); if (!g) groups.set(f.m, (g = [])); g.push(...f.w); }
  const meshes: Mesh[] = [], missing: string[] = [];
  for (const [m, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    const lm = lodMats[m], texRef = lm ? textures[lm.tex] ?? 0 : textures[m] ?? 0;
    let mat = await material(pkg, texRef);
    if (!mat.image) {
      // текстуры персонажей назначает игра: «имя_mNN_хвост» → «имя_tSS_mNN_хвост» или «имя_tSS_хвост» (SS — номер секции)
      const mm = /^(.*?)_(m\d\d)((?:_[a-z]+)?)$/i.exec(exp.name), ss = String(m).padStart(2, '0');
      const cands: Array<string | RegExp> = mm ? [`${mm[1]}_t${ss}_${mm[2]}${mm[3]}`, `${mm[1]}_t${ss}${mm[3]}`, `${mm[1]}_t${ss}`] : [];
      // часть доспеха «раса_m003_l» → «раса_m003_tNN_l» (первый вариант); предмет на земле «drop_раса_m001_t17_l_m00» → «раса_m001_t17_l»
      const part = /^(.+_m\d{3})_([a-z]{1,2})$/i.exec(exp.name), drop = /^drop_(.+_m\d{3}_t\d\d_[a-z]{1,2})_m\d\d$/i.exec(exp.name);
      if (drop) cands.unshift(drop[1]!);
      if (part) cands.push(new RegExp(`^${part[1]!.toLowerCase()}_t\\d\\d_${part[2]!.toLowerCase()}$`));
      // варианты монстров: «ogre_mage_m00» → «ogre_t00», «wolf_bi_m00» → «wolf_t00», «virud_lizardman_shaman_a_m00» → «virud_lizardman_t00»;
      // у части текстур в пакете только исходники «…_tSS_ori»
      if (mm) {
        const words = mm[1]!.split('_');
        for (let k = words.length; k >= 1; k--) {
          const stem = words.slice(0, k).join('_');
          for (const suf of ['', '_ori', '_sh']) cands.push(`${stem}_t${ss}${suf}`);
        }
      }
      for (const c of cands) { const hit = typeof c === 'string' ? findMaterialByName(c) : findMaterialMatching(c); if (hit) { const g = await material(hit.pkg, hit.ref); if (g.image) { mat = { ...g, name: g.name + ' (по имени меша)' }; break; } } }
    }
    if (lm && lm.flags & 0x6) mat.alpha = mat.alpha === 'none' ? 'test' : mat.alpha;
    if (!mat.image) missing.push(`${m}: ${mat.name || 'нет текстуры в меше'}${mat.error ? ' — ' + mat.error : ''}`);
    const remap = new Map<number, number>(), P: number[] = [], N: number[] = [], U: number[] = [], B: number[] = [], W: number[] = [], I: number[] = [];
    for (const wi of list) {
      let o = remap.get(wi);
      if (o === undefined) {
        const w = geo.wedges[wi];
        if (!w || w.v >= PP.length) continue;
        o = P.length / 3; remap.set(wi, o);
        P.push(...PP[w.v]!);
        const n = PN[w.v]!, len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
        N.push(n[0]! / len, n[1]! / len, n[2]! / len);
        U.push(w.u, w.w);
        const inf = byPoint[w.v]!;
        for (let k = 0; k < 4; k++) { B.push(inf[k]?.[0] ?? (k === 0 ? 1 : 0)); W.push(inf[k]?.[1] ?? (k === 0 && !inf.length ? 1 : 0)); }
      }
      I.push(o);
    }
    if (I.length) meshes.push(makeMesh(`${m} · ${mat.name ? mat.name.split('.').pop() : 'материал ' + m}`, mat, P, N, U, I, B, W));
  }
  if (!meshes.length) throw new Error(`${exp.name}: в SkeletalMesh нет треугольников`);
  const skeleton = new NodeSkeleton(nodes);
  skeleton.pose(null, 0, false);

  // анимации: ссылка меша и наборы MeshAnimation этого пакета с теми же костями
  const motions: NodeMotion[] = [];
  const boneIdx = new Map(bones.map((b, i) => [b.name.toLowerCase(), i]));
  const sets: Array<{ pkg: UPackage; exp: UExport }> = [];
  const own = animRef ? await resolveObj(pkg, animRef) : null;
  if (own && own.exp.className === 'MeshAnimation') sets.push(own);
  else
    // ссылки нет — наборы пакета с теми же костями (по началу объекта: список костей)
    for (const e of pkg.exports) {
      if (e.className !== 'MeshAnimation') continue;
      try {
        const names = await animBones(pkg, e);
        if (names.filter((n) => boneIdx.has(n.toLowerCase())).length >= Math.max(3, names.length * 0.8) && names.length <= bones.length + 4) sets.push({ pkg, exp: e });
      } catch { /* не набор костей */ }
    }
  const animInfo: string[] = [];
  for (const s of sets) {
    try {
      const a = await readAnimation(s.pkg, s.exp);
      for (const seq of a.seqs) motions.push(toMotion(seq, a.bones, boneIdx, bones, s.exp.name, sets.length > 1));
      animInfo.push(`${s.exp.name}: ${a.seqs.length}`);
    } catch (e) { animInfo.push(`${s.exp.name}: ошибка — ${(e as Error).message}`); }
  }
  const info = [
    `Unreal Engine 2 SkeletalMesh: ${pkg.objPath(pkg.exports.indexOf(exp) + 1)} (пакет v${pkg.ver}/${pkg.lic}, меш v${version})`,
    `Костей ${bones.length}, точек ${geo.points.length}, вершин ${geo.wedges.length}, треугольников ${geo.faces.length}${points.length ? '' : ' (из LOD 0)'}`,
    animInfo.length ? `Анимации: ${animInfo.join('; ')}` : 'Анимаций для этого скелета в пакете нет',
  ];
  if (missing.length) info.push(`Материалы без текстуры: ${[...new Set(missing)].join("; ")}`);
  void props;
  return { meshes, skeleton, motions, bounds: skinnedBounds(skeleton, meshes), flipZ: false, defaultZUp: true, cameraYaw: Math.PI / 2, info }; // персонажи UE смотрят вдоль +X
}

interface Lod { points: number[][]; wedges: Array<{ v: number; u: number; w: number }>; infl: Array<{ wt: number; p: number; b: number }>; faces: Array<{ w: number[] }>; soft: Sec[]; rigid: Sec[]; rigidIdx: number[]; softIdx: number[]; stream: number[][] }
interface Sec { mat: number; firstFace: number; numFaces: number }

/** FStaticLODModel (общая схема UE2; особые поля Lineage — только у поздних хроник). */
function readLod(r: UReader): Lod {
  r.arr((x) => x.u32());
  r.arr((x) => x.bytes(16));
  r.i32();
  const sec = (x: UReader): Sec => { const mat = x.u16(); x.u16(); x.u16(); x.u16(); x.u16(); x.u16(); x.u16(); const firstFace = x.u16(), numFaces = x.u16(); return { mat, firstFace, numFaces }; };
  const soft = r.arr(sec, 4096), rigid = r.arr(sec, 4096);
  const softIdx = r.arr((x) => x.u16()); r.i32();
  const rigidIdx = r.arr((x) => x.u16()); r.i32();
  r.i32(); r.i32(); r.i32();
  const stream = r.arr((x) => [x.f32(), x.f32(), x.f32(), x.f32(), x.f32(), x.f32(), x.f32(), x.f32()]);
  const infl = lazy(r, (x) => ({ wt: x.f32(), p: x.u16(), b: x.u16() }));
  const wedges = lazy(r, (x) => ({ v: x.u16(), u: x.f32(), w: x.f32() }));
  const faces = lazy(r, (x) => { const w = [x.u16(), x.u16(), x.u16()]; x.u16(); return { w }; });
  const points = lazy(r, (x) => x.vec());
  skip(r, 4 * 6);
  return { points, wedges, infl, faces, soft, rigid, rigidIdx, softIdx, stream };
}

/** Матрица размещения меша в нашем пространстве: R(RotOrigin) · diag(MeshScale) · T(−MeshOrigin), с отражением Y. */
function placement(scale: number[], origin: number[], rot: number[]): Float64Array {
  const a = (v: number) => (v * Math.PI) / 32768, P = a(rot[0]!), Y = a(rot[1]!), R = a(rot[2]!);
  const CP = Math.cos(P), SP = Math.sin(P), CY = Math.cos(Y), SY = Math.sin(Y), CR = Math.cos(R), SR = Math.sin(R);
  const ax = [[CP * CY, CP * SY, SP], [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP], [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP]];
  // в UE: M = [ax0 ax1 ax2] (столбцы) · diag(s); в нашем: S·M·S (S — отражение Y)
  const m = new Float64Array(16), sg = [1, -1, 1];
  for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) m[c * 4 + rr] = sg[rr]! * ax[c]![rr]! * scale[c]! * sg[c]!;
  m[15] = 1;
  const o = [origin[0]! * S, -origin[1]! * S, origin[2]! * S];
  for (let rr = 0; rr < 3; rr++) m[12 + rr] = -(m[rr]! * o[0]! + m[4 + rr]! * o[1]! + m[8 + rr]! * o[2]!);
  return m;
}

function affineInv(M: ArrayLike<number>): Float64Array {
  const a = M[0]!, b = M[4]!, c = M[8]!, d = M[1]!, e = M[5]!, f = M[9]!, g = M[2]!, h = M[6]!, i = M[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1;
  const inv = [A / det, B / det, C / det, -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det, (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det];
  const o = new Float64Array(16);
  for (let rr = 0; rr < 3; rr++) for (let cc = 0; cc < 3; cc++) o[cc * 4 + rr] = inv[rr * 3 + cc]!;
  for (let rr = 0; rr < 3; rr++) o[12 + rr] = -(o[rr]! * M[12]! + o[4 + rr]! * M[13]! + o[8 + rr]! * M[14]!);
  o[15] = 1;
  return o;
}

// ---------- MeshAnimation ----------
/** Имена костей набора: свойства, версия, RefBones — в начале объекта. */
async function animBones(pkg: UPackage, exp: UExport): Promise<string[]> {
  for (let n = 8192; ; n *= 4) {
    try {
      const r = await pkg.readerHead(exp, n);
      readProps(pkg, r); r.i32();
      return r.arr((x) => { const nm = pkg.name(x.idx()); x.u32(); x.i32(); return nm; }, 1024);
    } catch (e) { if (n >= exp.size) throw e; }
  }
}
interface Track { quat: number[][]; pos: number[][]; time: number[] }
interface Seq { name: string; frames: number; rate: number; trackTime: number; tracks: Track[] }
const animCache = new WeakMap<UExport, Promise<{ bones: string[]; seqs: Seq[] }>>();

function readAnimation(pkg: UPackage, exp: UExport): Promise<{ bones: string[]; seqs: Seq[] }> {
  let p = animCache.get(exp);
  if (!p) animCache.set(exp, (p = (async () => {
    const r = await pkg.reader(exp);
    readProps(pkg, r);
    r.i32(); // Version
    const bones = r.arr((x) => { const n = pkg.name(x.idx()); x.u32(); x.i32(); return n; }, 1024);
    const track = (x: UReader): Track => { x.u32(); const quat = x.arr((y) => [y.f32(), y.f32(), y.f32(), y.f32()]), pos = x.arr((y) => y.vec()), time = x.arr((y) => y.f32()); return { quat, pos, time }; };
    const moves = r.arr((x) => { x.vec(); const trackTime = x.f32(); x.i32(); x.u32(); x.arr((y) => y.i32()); const tracks = x.arr(track, 1024); track(x); return { trackTime, tracks }; }, 100000);
    const seqs = r.arr((x) => {
      if (pkg.ver >= 115) x.f32();
      const name = pkg.name(x.idx());
      x.arr((y) => y.idx());
      x.i32();
      const frames = x.i32();
      x.arr((y) => { y.f32(); y.idx(); if (pkg.ver >= 112) y.idx(); });
      const rate = x.f32();
      if (pkg.lic >= 1) { x.i32(); x.i32(); if (pkg.lic >= 2) x.i32(); x.idx(); }
      return { name, frames, rate };
    }, 100000);
    return { bones, seqs: seqs.map((s, i) => ({ ...s, trackTime: moves[i]?.trackTime ?? s.frames, tracks: moves[i]?.tracks ?? [] })) };
  })()));
  return p;
}

function toMotion(seq: Seq, animBones: string[], boneIdx: Map<string, number>, bones: Bone[], set: string, showSet: boolean): NodeMotion {
  const chan = new Map<number, NodeChannel>(), frames = Math.max(1, seq.frames), k = seq.trackTime > 0 ? frames / seq.trackTime : 1;
  seq.tracks.forEach((t, j) => {
    const bi = boneIdx.get((animBones[j] ?? '').toLowerCase());
    if (bi === undefined || !t.quat.length) return;
    const root = bi === 0, n = Math.max(t.quat.length, t.pos.length, 1);
    const times = t.time.length >= n ? t.time.map((x) => x * k) : Array.from({ length: n }, (_, i) => (i * frames) / n);
    const rot: Array<[number, number[]]> = [], pos: Array<[number, number[]]> = [];
    for (let i = 0; i < n; i++) {
      const q = t.quat[Math.min(i, t.quat.length - 1)]!;
      rot.push([times[i]!, boneQuat(q[0]!, q[1]!, q[2]!, q[3]!, root)]);
      const p = t.pos.length ? t.pos[Math.min(i, t.pos.length - 1)]! : null;
      pos.push([times[i]!, p ? [p[0]! * S, -p[1]! * S, p[2]! * S] : bones[bi]!.t]);
    }
    // зацикливание: последний ключ переходит в первый к концу последовательности
    if (n > 1 && times[n - 1]! < frames) { rot.push([frames, rot[0]![1]]); pos.push([frames, pos[0]![1]]); }
    chan.set(bi + 1, { pos, rot, scl: null });
  });
  const rate = seq.rate > 0 ? seq.rate : 30;
  return { kind: 'node', name: showSet ? `${seq.name} · ${set}` : seq.name, tps: rate, chan, duration: frames / rate, frames };
}

