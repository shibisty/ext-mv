// Spintires / MudRunner: кэш мешей Media/MeshCache/* (файлы без расширения).
// u32 длина XML + XML <CombineXMesh> (материалы по частям меша) + двоичная часть:
//   u32 0x01337B44, u32 число узлов, bbox, u32 ?, затем узлы:
//   i16 родитель, u16 номер, u32 ?, u32 длина имени, имя\0, матрица 4×4 (D3D, строки), u32 число вершин (0 — без меша)
//   меш: u32 граней, имя, u32 1, u32 костей, кости × матрица, [группы костей], max(костей,1) × u16 номер узла,
//        bbox, диапазоны атрибутов (D3DXATTRIBUTERANGE), объявление вершин (D3DVERTEXELEMENT9), вершины, индексы, u32 номер.
//   Узлы коллизий («cdt…») имеют другой формат — пропускаются поиском следующего заголовка.
import { half } from '../../core/binary';
import type { Mesh } from '../../core/types';

// D3DDECLTYPE: FLOAT1..4, D3DCOLOR, UBYTE4, SHORT2, SHORT4, UBYTE4N, SHORT2N, SHORT4N, USHORT2N, USHORT4N, UDEC3, DEC3N, FLOAT16_2, FLOAT16_4
const TYPE_SIZE = [4, 8, 12, 16, 4, 4, 4, 8, 4, 4, 8, 4, 8, 4, 4, 4, 8];

export interface StMaterial { parts: string[]; diffuse: string; normal: string; shading: string; specular: string; name: string; alpha: boolean }
export interface StNode { index: number; parent: number; name: string; local: Float32Array; world: Float32Array; mesh: Mesh | null; skinned: boolean; material?: string }
export interface StFile { xml: string; materials: StMaterial[]; nodes: StNode[]; skipped: number; /** SnowRunner (сигнатура 0x0133EF63). */ snow: boolean }

export const isCombineXMesh = (head: Uint8Array): boolean => {
  if (head.length < 18) return false;
  const tag = '<CombineXMesh>';
  for (let i = 0; i < tag.length; i++) if (head[4 + i] !== tag.charCodeAt(i)) return false;
  return true;
};

function parseMaterials(xml: string): StMaterial[] {
  const out: StMaterial[] = [];
  for (const m of xml.matchAll(/<Material\b([^>]*)\/?>/g)) {
    const a = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]!)?.[1] ?? '';
    out.push({ parts: a('MeshParts').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean), diffuse: a('DiffuseMap') || a('AlbedoMap'), normal: a('NormalMap'), shading: a('ShadingMap'), specular: a('SpecularMap'), name: a('Name'), alpha: /alpha/i.test(a('Blending')) || a('AlphaKill') === 'true' });
  }
  return out;
}

/** Произведение матриц D3D (строки): a × b. */
function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k]! * b[k * 4 + c]!; o[r * 4 + c] = s; }
  return o;
}

export function parseMeshCache(buf: ArrayBuffer): StFile {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  const xmlLen = dv.getUint32(0, true);
  const xml = new TextDecoder('latin1').decode(u8.subarray(4, 4 + xmlLen)).replace(/\0+$/, '');
  let p = 4 + xmlLen;
  const magic = dv.getUint32(p, true);
  if (magic !== 0x01337b44 && magic !== 0x0133ef63 && magic !== 0x0133a186) throw new Error(`MeshCache: неизвестная сигнатура 0x${magic.toString(16)} после XML`);
  const total = dv.getUint32(p + 4, true);
  p += 8 + 24 + 4;
  const nodes: StNode[] = [];
  let skipped = 0;
  const str = (at: number, len: number) => { let s = ''; for (let i = 0; i < len - 1; i++) s += String.fromCharCode(u8[at + i]!); return s; };
  // номера узлов не обязательно по порядку (у колёс корень — последний номер); родитель — уже прочитанный узел
  const byId = new Map<number, StNode>();
  const isNode = (at: number): boolean => {
    if (at + 12 + 64 > u8.length) return false;
    const par = dv.getInt16(at, true), i = dv.getUint16(at + 2, true), ln = dv.getUint32(at + 8, true);
    if (i >= total || byId.has(i) || (par === -2 ? byId.size > 0 : !byId.has(par)) || ln < 1 || ln > 128 || at + 12 + ln + 64 > u8.length) return false;
    if (u8[at + 12 + ln - 1] !== 0) return false;
    for (let k = 0; k < ln - 1; k++) { const c = u8[at + 12 + k]!; if (c < 32 || c > 126) return false; }
    const m = at + 12 + ln, f = (k: number) => dv.getFloat32(m + k * 4, true);
    return Math.abs(f(15) - 1) < 1e-4 && Math.abs(f(3)) < 1e-4 && Math.abs(f(7)) < 1e-4 && Math.abs(f(11)) < 1e-4;
  };
  const matNames = parseMaterials(xml).map((m) => m.name).filter((n) => n.length > 1);
  const readMesh = (at: number, owner: string): { mesh: Mesh; skinned: boolean; end: number; material: string } => {
    const vc = dv.getUint32(at, true), fc = dv.getUint32(at + 4, true), nl = dv.getUint32(at + 8, true);
    if (!vc || vc > 4_000_000 || fc > 8_000_000 || nl > 256) throw new Error('bad mesh');
    const head = at + 12 + nl;
    // объявление вершин ищем по сигнатуре: u32 n (1..16), n элементов (первый — поток 0, смещение 0), D3DDECL_END {FF 00 00 00 11 00 00 00}.
    // Между именем и объявлением — кости, группы, bbox, диапазоны (у MudRunner и SnowRunner по-разному).
    let q = -1;
    for (let s = head, lim = Math.min(u8.length - 16, head + (1 << 20)); s < lim; s++) {
      const nd = dv.getUint32(s, true);
      if (nd < 1 || nd > 16 || dv.getUint32(s + 4, true) !== 0) continue;
      const e = s + 4 + nd * 8;
      if (e + 8 <= u8.length && u8[e] === 0xff && u8[e + 1] === 0 && u8[e + 4] === 0x11) { q = s; break; }
    }
    if (q < 0) throw new Error('no decl');
    // имя материала в заголовке меша (SnowRunner): одна из строк Name из XML
    let material = '';
    const region = new TextDecoder('latin1').decode(u8.subarray(head, q));
    for (const n of matNames) if (region.includes(n + '\0')) { material = n; break; }
    const nd = dv.getUint32(q, true);
    q += 4;
    let stride = 0, oPos = -1, tPos = 2, oUV = -1, tUV = 1, oNor = -1, tNor = 4, skinned = false;
    for (let k = 0; k < nd; k++) {
      const e = q + k * 8, off = dv.getUint16(e + 2, true), type = u8[e + 4]!, usage = u8[e + 6]!, ui = u8[e + 7]!;
      stride = Math.max(stride, off + (TYPE_SIZE[type] ?? 4));
      if (usage === 0 && oPos < 0) { oPos = off; tPos = type; }
      else if (usage === 5 && ui === 0) { oUV = off; tUV = type; }
      else if ((usage === 3 || (usage === 5 && ui === 1)) && oNor < 0) { oNor = off; tNor = type; }
      else if (usage === 1 || usage === 2) skinned = true;
    }
    q += 8 * (nd + 1);
    if (q + stride * vc > u8.length) throw new Error('vertices out of range');
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2);
    for (let v = 0; v < vc; v++) {
      const b = q + v * stride;
      if (tPos === 16) for (let c = 0; c < 3; c++) pos[v * 3 + c] = half(dv.getUint16(b + oPos + c * 2, true));
      else for (let c = 0; c < 3; c++) pos[v * 3 + c] = dv.getFloat32(b + oPos + c * 4, true);
      if (oUV >= 0) {
        if (tUV === 1) { uv[v * 2] = dv.getFloat32(b + oUV, true); uv[v * 2 + 1] = dv.getFloat32(b + oUV + 4, true); }
        else if (tUV === 15) { uv[v * 2] = half(dv.getUint16(b + oUV, true)); uv[v * 2 + 1] = half(dv.getUint16(b + oUV + 2, true)); }
      }
      if (oNor >= 0) {
        const n = b + oNor;
        if (tNor === 4) { nor[v * 3] = u8[n + 2]! / 127.5 - 1; nor[v * 3 + 1] = u8[n + 1]! / 127.5 - 1; nor[v * 3 + 2] = u8[n]! / 127.5 - 1; } // D3DCOLOR: B G R A
        else if (tNor === 8 || tNor === 5) { nor[v * 3] = u8[n]! / 127.5 - 1; nor[v * 3 + 1] = u8[n + 1]! / 127.5 - 1; nor[v * 3 + 2] = u8[n + 2]! / 127.5 - 1; }
        else if (tNor === 2) { nor[v * 3] = dv.getFloat32(n, true); nor[v * 3 + 1] = dv.getFloat32(n + 4, true); nor[v * 3 + 2] = dv.getFloat32(n + 8, true); }
      }
    }
    q += stride * vc;
    const wide = vc > 65535, idx = new Uint32Array(fc * 3);
    if (q + (wide ? 4 : 2) * fc * 3 > u8.length) throw new Error('indices out of range');
    for (let i = 0; i < fc * 3; i++) idx[i] = wide ? dv.getUint32(q + i * 4, true) : dv.getUint16(q + i * 2, true);
    q += (wide ? 4 : 2) * fc * 3;
    if (magic === 0x01337b44) q += 4; // номер меша (MudRunner); у SnowRunner хвост другой — следующий узел найдётся поиском
    const mesh: Mesh = { name: owner, texture: '', vertexCount: vc, pos, nor, uv, bone: new Float32Array(vc * 4), weight: new Float32Array(vc * 4), indices: idx, skinned: false };
    return { mesh, skinned, end: q, material };
  };

  for (let fi = 0; fi < total; fi++) {
    if (!isNode(p)) {
      let q = p;
      while (q < u8.length - 80 && !isNode(q)) q++;
      if (q >= u8.length - 80) break;
      skipped += q - p;
      p = q;
    }
    const parent = dv.getInt16(p, true), id = dv.getUint16(p + 2, true), ln = dv.getUint32(p + 8, true), name = str(p + 12, ln);
    p += 12 + ln;
    const local = new Float32Array(u8.slice(p, p + 64).buffer);
    p += 64;
    const par = parent >= 0 ? byId.get(parent) : undefined;
    const node: StNode = { index: id, parent, name, local, world: par ? mul(local, par.world) : local, mesh: null, skinned: false };
    nodes.push(node);
    byId.set(id, node);
    if (/^cdt|_cdt$/i.test(name) && !/^bone/i.test(name)) continue; // коллизия
    const vc = dv.getUint32(p, true);
    if (!vc) { p += 4; continue; }
    try {
      const r = readMesh(p, name);
      node.mesh = r.mesh; node.skinned = r.skinned; node.material = r.material; p = r.end;
    } catch { /* неизвестный блок — следующий узел найдётся поиском */ }
  }
  return { xml, materials: parseMaterials(xml), nodes, skipped, snow: magic === 0x0133ef63 };
}

/** Перевести вершины статического меша в пространство модели. */
export function applyWorld(m: Mesh, w: Float32Array): void {
  for (let v = 0; v < m.vertexCount; v++) {
    const x = m.pos[v * 3]!, y = m.pos[v * 3 + 1]!, z = m.pos[v * 3 + 2]!;
    m.pos[v * 3] = x * w[0]! + y * w[4]! + z * w[8]! + w[12]!;
    m.pos[v * 3 + 1] = x * w[1]! + y * w[5]! + z * w[9]! + w[13]!;
    m.pos[v * 3 + 2] = x * w[2]! + y * w[6]! + z * w[10]! + w[14]!;
    const a = m.nor[v * 3]!, b = m.nor[v * 3 + 1]!, c = m.nor[v * 3 + 2]!;
    m.nor[v * 3] = a * w[0]! + b * w[4]! + c * w[8]!;
    m.nor[v * 3 + 1] = a * w[1]! + b * w[5]! + c * w[9]!;
    m.nor[v * 3 + 2] = a * w[2]! + b * w[6]! + c * w[10]!;
  }
}
