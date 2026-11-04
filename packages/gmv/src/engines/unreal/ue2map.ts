// Карты Unreal Engine 2 (Lineage II, MAPS/xx_yy.unr): ландшафт TerrainInfo и расстановка StaticMeshActor.
// Ландшафт: карта высот G16 (TerrainMap), шаг TerrainScale (X, Y — на клетку, Z — на 1/256 высоты от 32768),
// центр — Location; слои — текстуры с масками AlphaMap (наложение по вершинам, как у Far Cry 2), дыры —
// QuadVisibilityBitmap. Акторы: StaticMesh, Location, Rotation, DrawScale, DrawScale3D, Skins.
// Пространство UE — левое: Y отражается, ×0.01 — метры (как у мешей). BSP-геометрия (Model) пока не строится.
import { boundsOf } from '../../core/geometry';
import { LevelBuilder } from '../../core/levelbuilder';
import type { DecodedImage, Mesh, Model, VFile } from '../../core/types';
import { resolveObj } from './ue2archive';
import { material, staticMeshParts } from './ue2mesh';
import { decodeL2, propNum, propObj, readProps, skipStateFrame, UPackage, UReader, type UExport, type UProp } from './ue2pkg';
import { decodeUeTexture, readUeTextureMip, TEXF } from './ue2tex';

const S = 0.01;

/** Значение свойства-структуры Vector / Rotator (двоичные). */
export function propVec(p: Map<string, UProp>, k: string, def: number[]): number[] {
  const v = p.get(k)?.value as { struct?: string; data?: Uint8Array } | undefined;
  if (!v?.data || v.data.length < 12) return def;
  const dv = new DataView(v.data.buffer, v.data.byteOffset, 12);
  return v.struct === 'Rotator' ? [dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true)] : [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true)];
}

/** Оси поворота UE (Pitch, Yaw, Roll в 1/65536 оборота): X, Y, Z как в FRotationMatrix. */
export function rotatorAxes(r: number[]): number[][] {
  const a = (v: number) => (v * Math.PI) / 32768, P = a(r[0]!), Y = a(r[1]!), R = a(r[2]!);
  const CP = Math.cos(P), SP = Math.sin(P), CY = Math.cos(Y), SY = Math.sin(Y), CR = Math.cos(R), SR = Math.sin(R);
  return [[CP * CY, CP * SY, SP], [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP], [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP]];
}

/** Матрица актора в нашем пространстве (column-major): T(Location) · R(Rotation) · масштаб, с отражением Y. */
export function actorMatrix(loc: number[], rot: number[], scale: number[]): number[] {
  const ax = rotatorAxes(rot), sg = [1, -1, 1], M = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) M[c * 4 + r] = sg[r]! * ax[c]![r]! * scale[c]! * sg[c]!;
  M[12] = loc[0]! * S; M[13] = -loc[1]! * S; M[14] = loc[2]! * S; M[15] = 1;
  return M;
}

/** Массив ссылок (динамическое свойство-массив объектов). */
function objList(pkg: UPackage, p: UProp | undefined): number[] {
  const v = p?.value as { array?: Uint8Array } | undefined;
  if (!v?.array) return typeof p?.value === 'number' ? [p.value] : [];
  try { const r = new UReader(v.array, pkg.ver, pkg.lic); return r.arr((x) => x.idx(), 256); } catch { return []; }
}

interface Layer { tex: DecodedImage | null; name: string; alpha: Float32Array | null; us: number; vs: number }

/** Ландшафт: меш на слой (нижний — основа, остальные — наложение с прозрачностью по вершинам). */
async function terrain(pkg: UPackage, props: Map<string, UProp>, info: string[]): Promise<Mesh[]> {
  const hRef = propObj(props, 'TerrainMap'), hit = hRef ? await resolveObj(pkg, hRef) : null;
  if (!hit) { info.push(`Ландшафт: карта высот ${hRef ? pkg.objPath(hRef) : '—'} не найдена (откройте папку игры: Textures/T_xx_yy.utx)`); return []; }
  const hm = await readUeTextureMip(hit.pkg, hit.exp);
  if (hm.fmt !== TEXF.G16) { info.push(`Ландшафт: карта высот в формате ${hm.fmt}, ожидался G16`); return []; }
  const W = hm.w, H = hm.h, hv = new DataView(hm.data.buffer, hm.data.byteOffset, hm.data.byteLength);
  const sc = propVec(props, 'TerrainScale', [64, 64, 64]), loc = propVec(props, 'Location', [0, 0, 0]);
  const height = (i: number, j: number) => hv.getUint16((Math.min(H - 1, j) * W + Math.min(W - 1, i)) * 2, true);
  // видимость клеток: биты по клеткам (j·W + i), 1 — видна
  const vis = (props.get('QuadVisibilityBitmap')?.value as { array?: Uint8Array } | undefined)?.array;
  let visBits: Uint8Array | null = null;
  if (vis) { try { const r = new UReader(vis, pkg.ver, pkg.lic), n = r.idx(); visBits = r.bytes(Math.min(n * 4, r.u8.length - r.pos)); } catch { visBits = null; } }
  const quadVisible = (i: number, j: number) => { if (!visBits) return true; const b = j * W + i; return ((visBits[b >> 3] ?? 255) >> (b & 7)) & 1; };
  // вершины в нашем пространстве
  const nv = W * H, pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const v = j * W + i;
    const x = loc[0]! + (i - W / 2) * sc[0]!, y = loc[1]! + (j - H / 2) * sc[1]!, z = loc[2]! + ((height(i, j) - 32768) * sc[2]!) / 256;
    pos[v * 3] = x * S; pos[v * 3 + 1] = -y * S; pos[v * 3 + 2] = z * S;
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const v = j * W + i, zx = (height(i + 1, j) - height(Math.max(0, i - 1), j)) * sc[2]! / 256, zy = (height(i, j + 1) - height(i, Math.max(0, j - 1))) * sc[2]! / 256;
    const nx = -zx / (2 * sc[0]!), ny = zy / (2 * sc[1]!), l = Math.hypot(nx, ny, 1);
    nor[v * 3] = nx / l; nor[v * 3 + 1] = ny / l; nor[v * 3 + 2] = 1 / l;
  }
  const idx: number[] = [];
  for (let j = 0; j + 1 < H; j++) for (let i = 0; i + 1 < W; i++) {
    if (!quadVisible(i, j)) continue;
    const v = j * W + i;
    // порядок после отражения Y — против часовой сверху
    idx.push(v, v + W, v + 1, v + 1, v + W, v + W + 1);
  }
  // слои
  const layers: Layer[] = [];
  for (let k = 0; k < 32; k++) {
    const raw = props.get(k ? `Layers[${k}]` : 'Layers')?.value as { data?: Uint8Array } | undefined;
    if (!raw?.data) continue;
    let lp: Map<string, UProp>;
    try { lp = readProps(pkg, new UReader(raw.data, pkg.ver, pkg.lic)); } catch { continue; }
    const tRef = propObj(lp, 'Texture');
    if (!tRef) continue;
    const mat = await material(pkg, tRef);
    let alpha: Float32Array | null = null;
    const aRef = propObj(lp, 'AlphaMap'), aHit = aRef ? await resolveObj(pkg, aRef) : null;
    if (aHit) {
      try {
        const am = await readUeTextureMip(aHit.pkg, aHit.exp), img = am.fmt === TEXF.L8 || am.fmt === TEXF.G16 ? null : await decodeUeTexture(aHit.pkg, aHit.exp, resolveObj);
        alpha = new Float32Array(nv);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          const u = Math.min(am.w - 1, Math.floor((i * am.w) / W)), w = Math.min(am.h - 1, Math.floor((j * am.h) / H));
          alpha[j * W + i] = img ? img.rgba[(w * am.w + u) * 4 + 3]! / 255 : am.fmt === TEXF.L8 ? am.data[w * am.w + u]! / 255 : am.data[(w * am.w + u) * 2 + 1]! / 255;
        }
      } catch { alpha = null; }
    }
    layers.push({ tex: mat.image ?? null, name: mat.name, alpha, us: propNum(lp, 'UScale', 1) || 1, vs: propNum(lp, 'VScale', 1) || 1 });
  }
  if (!layers.length) layers.push({ tex: null, name: '', alpha: null, us: 1, vs: 1 });
  const meshes: Mesh[] = [];
  layers.forEach((L, k) => {
    // наложения с пустой маской пропускаются
    if (k > 0 && L.alpha && !L.alpha.some((a) => a > 0.02)) return;
    const uv = new Float32Array(nv * 2), tw = L.tex?.width ?? 256, th = L.tex?.height ?? 256;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const v = j * W + i;
      uv[v * 2] = ((i - W / 2) * sc[0]! + loc[0]!) / (L.us * tw); uv[v * 2 + 1] = ((j - H / 2) * sc[1]! + loc[1]!) / (L.vs * th);
    }
    // у наложения — только клетки, где маска не нулевая
    let tri = idx;
    if (k > 0 && L.alpha) { tri = []; for (let q = 0; q < idx.length; q += 3) if (L.alpha[idx[q]!]! > 0.02 || L.alpha[idx[q + 1]!]! > 0.02 || L.alpha[idx[q + 2]!]! > 0.02) tri.push(idx[q]!, idx[q + 1]!, idx[q + 2]!); }
    if (!tri.length) return;
    meshes.push({
      name: `Ландшафт · ${k === 0 ? 'основа' : 'слой ' + k} · ${L.name.split('.').pop() || '—'}`, texture: L.name, vertexCount: nv, pos, nor, uv, bone: new Float32Array(0), weight: new Float32Array(0),
      indices: Uint32Array.from(tri), skinned: false, ...(L.tex ? { image: L.tex } : { color: [0.4, 0.45, 0.3] }), ...(k > 0 && L.alpha ? { vertexAlpha: L.alpha } : {}),
    } as Mesh);
  });
  info.push(`Ландшафт ${W}×${H} клеток по ${sc[0]}×${sc[1]} uu (${((W * sc[0]!) / 100).toFixed(0)} м), слоёв ${meshes.length}`);
  return meshes;
}

export async function loadUe2Map(main: VFile): Promise<Model> {
  const data = decodeL2(new Uint8Array(await main.arrayBuffer()), main.name);
  const pkg = UPackage.fromBytes(data, main.name);
  const info: string[] = [`Карта Unreal Engine 2: ${main.name} (пакет v${pkg.ver}/${pkg.lic})`];
  const ground: Mesh[] = [];
  const B = new LevelBuilder(), protos = new Map<string, { pi: number; parts: Mesh[] } | null>(), missing = new Set<string>();
  let placed = 0, actors = 0, models = 0;
  for (const e of pkg.exports) {
    const cls = e.className;
    if (cls !== 'TerrainInfo' && !/StaticMeshActor$/.test(cls)) { if (cls === 'Model') models++; continue; }
    let props: Map<string, UProp>;
    try { const r = await pkg.reader(e); skipStateFrame(e, r); props = readProps(pkg, r); } catch { continue; }
    if (cls === 'TerrainInfo') { try { ground.push(...(await terrain(pkg, props, info))); } catch (er) { info.push(`Ландшафт: ошибка — ${(er as Error).message}`); } continue; }
    actors++;
    if (props.get('bHidden')?.value === true) continue;
    const smRef = propObj(props, 'StaticMesh');
    if (!smRef) continue;
    const skins = objList(pkg, props.get('Skins'));
    const key = `${pkg.objPath(smRef)}|${skins.join(',')}`;
    let pr = protos.get(key);
    if (pr === undefined) {
      pr = null;
      const hit = await resolveObj(pkg, smRef);
      if (hit && hit.exp.className === 'StaticMesh') {
        try {
          const sm = await staticMeshParts(hit.pkg, hit.exp, skins, pkg);
          if (sm.meshes.length) pr = { pi: B.proto(key, sm.meshes, 'sm', (p) => `объекты · ${(p.texture || p.name).split('.').pop()}`), parts: sm.meshes };
        } catch { missing.add(pkg.objPath(smRef)); }
      } else missing.add(pkg.objPath(smRef));
      protos.set(key, pr);
    }
    if (!pr) continue;
    const ds = propNum(props, 'DrawScale', 1) || 1, d3 = propVec(props, 'DrawScale3D', [1, 1, 1]);
    const M = actorMatrix(propVec(props, 'Location', [0, 0, 0]), propVec(props, 'Rotation', [0, 0, 0]), [d3[0]! * ds, d3[1]! * ds, d3[2]! * ds]);
    B.place(pr.pi, pr.parts, M, e.name, pkg.objPath(smRef).split('.')[0] ?? 'StaticMesh');
    placed++;
  }
  info.push(`Объектов StaticMesh: ${placed} из ${actors}, разных мешей ${[...protos.values()].filter(Boolean).length}`);
  if (missing.size) info.push(`Не найдено мешей: ${missing.size} (${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? '…' : ''}) — откройте «Папку игры» с StaticMeshes`);
  if (models) info.push(`BSP (Model: ${models}) не показывается — на картах Lineage II это небо-зона (купол, облака) и объёмы`);
  const meshes = [...B.build(), ...ground];
  if (!meshes.length) throw new Error(`${main.name}: на карте нет ни ландшафта, ни объектов (нужны пакеты из папки игры)`);
  info.push(`Треугольников: ${Math.round(meshes.reduce((a, m) => a + m.indices.length / 3, 0)).toLocaleString('ru')}`);
  return { meshes, instances: B.scene, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: false, defaultZUp: true, cameraYaw: 0, info };
}
