// Drawable RAGE (GTA V, Gen8): модели LOD «High» -> геометрии (вершинный/индексный буферы) + шейдеры (текстуры).
import { half } from '../../core/binary';
import type { Mesh } from '../../core/types';
import { joaat, type Resource } from './rsc';

const DIFFUSE = new Set(['diffusesampler', 'texturesampler', 'diffusesampler2', 'platebgsampler'].map(joaat));
const BUMP = new Set(['bumpsampler', 'normalsampler', 'bumpsampler2'].map(joaat));
const TYPE_SIZE = [0, 4, 4, 8, 0, 8, 12, 16, 4, 4, 4, 0, 0, 0, 0, 0];

export interface ShaderInfo { name: number; diffuse: string; normal: string; textures: string[] }
export interface DrawableInfo { name: string; meshes: Mesh[]; shaders: ShaderInfo[]; embedded: number; bones: number }

/** Шейдеры группы: имена текстур (первая — диффузная по хэшу параметра). */
export function readShaders(r: Resource, sg: number): { shaders: ShaderInfo[]; texDict: number } {
  if (!sg) return { shaders: [], texDict: 0 };
  const texDict = r.ptr(sg + 0x8), shaders: ShaderInfo[] = [];
  for (const fx of r.ptrList(sg + 0x10)) {
    if (!fx) { shaders.push({ name: 0, diffuse: '', normal: '', textures: [] }); continue; }
    const pp = r.ptr(fx), n = r.u8at(fx + 0x10), name = r.u32(fx + 0x8);
    const textures: string[] = [];
    let diffuse = '', normal = '', dataSize = 0;
    for (let i = 0; i < n; i++) if (r.u8at(pp + i * 16)) dataSize += 16 * r.u8at(pp + i * 16);
    const hashesAt = pp + n * 16 + dataSize;
    for (let i = 0; i < n; i++) {
      const t = r.u8at(pp + i * 16);
      if (t !== 0) continue;
      const tex = r.ptr(pp + i * 16 + 8);
      if (!tex) continue;
      const tn = r.str(r.ptr(tex + 0x28));
      if (!tn) continue;
      textures.push(tn);
      const h = r.u32(hashesAt + i * 4);
      if (!diffuse && DIFFUSE.has(h)) diffuse = tn;
      if (!normal && BUMP.has(h)) normal = tn;
    }
    shaders.push({ name, diffuse: diffuse || textures[0] || '', normal, textures });
  }
  return { shaders, texDict };
}

function readGeometry(r: Resource, g: number): { pos: Float32Array; nor: Float32Array; uv: Float32Array; idx: Uint32Array } | null {
  const vb = r.ptr(g + 0x18), ib = r.ptr(g + 0x38);
  if (!vb || !ib) return null;
  const stride = r.u16(vb + 0x8), data = r.ptr(vb + 0x10) || r.ptr(vb + 0x20), n = r.u32(vb + 0x18), decl = r.ptr(vb + 0x30);
  if (!data || !decl || !n) return null;
  const flags = r.u32(decl), tlo = r.u32(decl + 8), thi = r.u32(decl + 12);
  const typeOf = (k: number) => (k < 8 ? (tlo >>> (k * 4)) & 0xf : (thi >>> ((k - 8) * 4)) & 0xf);
  const offs: number[] = new Array(16).fill(-1), types: number[] = new Array(16).fill(0);
  let o = 0;
  for (let k = 0; k < 16; k++) if ((flags >>> k) & 1) { offs[k] = o; types[k] = typeOf(k); o += TYPE_SIZE[types[k]!]!; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const vec = (base: number, t: number, out: Float32Array, at: number, cnt: number) => {
    if (t === 6 || t === 7 || t === 5 || t === 2) for (let c = 0; c < cnt; c++) out[at + c] = c < (t === 2 ? 1 : t === 5 ? 2 : 3) ? r.f32(base + c * 4) : 0;
    else if (t === 1 || t === 3) for (let c = 0; c < cnt; c++) out[at + c] = c < (t === 1 ? 2 : 4) ? half(r.u16(base + c * 2)) : 0;
    else if (t === 10) for (let c = 0; c < cnt; c++) out[at + c] = ((r.u8at(base + c) << 24) >> 24) / 127; // RGBA8 SNorm
    else if (t === 9 || t === 8) for (let c = 0; c < cnt; c++) out[at + c] = r.u8at(base + c) / 127.5 - 1;
  };
  for (let v = 0; v < n; v++) {
    const b = data + v * stride;
    if (offs[0]! >= 0) vec(b + offs[0]!, types[0]!, pos, v * 3, 3);
    if (offs[3]! >= 0) vec(b + offs[3]!, types[3]!, nor, v * 3, 3);
    if (offs[6]! >= 0) vec(b + offs[6]!, types[6]!, uv, v * 2, 2);
  }
  const ni = r.u32(ib + 0x8), ip = r.ptr(ib + 0x10), idx = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) idx[i] = r.u16(ip + i * 2);
  return { pos, nor, uv, idx };
}

/** Drawable по смещению (DrawableBase). lod: 0 — High. */
export function readDrawable(r: Resource, d: number, label = '', lod = 0): DrawableInfo {
  const { shaders, texDict } = readShaders(r, r.ptr(d + 0x10));
  const lists = [0x50, 0x58, 0x60, 0x68].map((o) => r.ptr(d + o));
  let list = lists[lod] || lists.find((x) => x) || 0;
  const meshes: Mesh[] = [];
  const models = list ? r.ptrList(list) : [];
  models.forEach((m, mi) => {
    const geoms = r.ptrList(m + 0x8), map = r.ptr(m + 0x20);
    geoms.forEach((g, gi) => {
      if (!g) return;
      const geo = readGeometry(r, g);
      if (!geo || !geo.idx.length) return;
      const si = map ? r.u16(map + gi * 2) : 0, sh = shaders[si];
      const n = geo.pos.length / 3;
      meshes.push({
        name: `${label}${models.length > 1 ? `m${mi}·` : ''}${gi}`, texture: sh?.diffuse ?? '', normalMap: sh?.normal || undefined, vertexCount: n, pos: geo.pos, nor: geo.nor, uv: geo.uv,
        bone: new Float32Array(n * 4), weight: new Float32Array(n * 4), indices: geo.idx, skinned: false, materialPaths: sh?.textures,
      });
    });
    list = 0;
  });
  const sk = r.ptr(d + 0x18);
  return { name: '', meshes, shaders, embedded: texDict, bones: sk ? r.u16(sk + 0x5e) : 0 };
}

/** Словарь drawable (.ydd): хэши имён и указатели. */
export function readDrawableDictionary(r: Resource): Array<{ hash: number; at: number }> {
  const hp = r.ptr(0x20), hn = r.u16(0x28), ds = r.ptr(0x30), dn = r.u16(0x38), out: Array<{ hash: number; at: number }> = [];
  for (let i = 0; i < dn; i++) { const at = r.ptr(ds + i * 8); if (at) out.push({ hash: i < hn && hp ? r.u32(hp + i * 4) : 0, at }); }
  return out;
}

/** Фрагмент (.yft): основной drawable и дополнительные (детали машин). */
export function readFragmentDrawables(r: Resource): number[] {
  const main = r.ptr(0x30), arr = r.ptr(0x38), cnt = r.u32(0x48), out: number[] = [];
  if (main) out.push(main);
  for (let i = 0; i < cnt && arr; i++) { const d = r.ptr(arr + i * 8); if (d) out.push(d); }
  return out;
}
