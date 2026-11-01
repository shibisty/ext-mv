// CryEngine (.cgf/.cga/.skin) в контейнере «CrCh» с потоковой геометрией (DataStream / MeshSubsets). Только статика (LOD0, поза покоя),
// без трансформов узлов и скелета. Раскладка проверяется по границам чанков; при несовпадении — понятная ошибка.
import { half } from '../../core/binary';
import { boundsOf, computeNormals, makeIndices, sumTris } from '../../core/geometry';
import type { Mesh, Model } from '../../core/types';

const T = { stream: 0xcccc0016, subsets: 0xcccc0017, mtlname: 0xcccc0014 };
const S = { POS: 0, NORMALS: 1, UV: 2, INDICES: 5 };
export const CRY_MAGIC = { CrCh: 0x68437243, CryT: 0x54797243, ivo: 0x6f766923 };

interface CgfChunk { type: number; ver: number; id: number; size: number; off: number }
interface Stream { type: number; n: number; bpe: number; data: number }

export function parseChunks(buf: ArrayBuffer): { ver: number; chunks: CgfChunk[] } {
  const dv = new DataView(buf), U = (o: number) => dv.getUint32(o, true), magic = buf.byteLength >= 4 ? U(0) : 0;
  if (magic === CRY_MAGIC.CryT) throw new Error('Контейнер «CryT/CryTek» (Far Cry 1, MWO, ArcheAge) нативно не читается — сконвертируйте Cryengine Converter в Collada (.dae)');
  if (magic === CRY_MAGIC.ivo) throw new Error('Формат «#ivo» (Star Citizen) нативно не читается — сконвертируйте Cryengine Converter в Collada (.dae)');
  if (magic !== CRY_MAGIC.CrCh || buf.byteLength < 16) throw new Error('Не CryEngine CGF (нет сигнатуры CrCh)');
  const ver = U(4), n = U(8), tab = U(12);
  if (n <= 0 || n > 100000 || tab + n * 20 > buf.byteLength) throw new Error('CGF: неверная таблица чанков');
  const chunks: CgfChunk[] = [];
  for (let i = 0; i < n; i++) {
    const o = tab + i * 20, c = { type: U(o), ver: U(o + 4) & 0x7fffffff, id: U(o + 8), size: U(o + 12), off: U(o + 16) };
    if (c.off + c.size > buf.byteLength) throw new Error(`CGF: раскладка таблицы чанков версии 0x${ver.toString(16)} не распознана`);
    chunks.push(c);
  }
  return { ver, chunks: chunks.sort((a, b) => a.off - b.off) };
}

function readStream(dv: DataView, c: CgfChunk): Stream | null {
  for (const skip of [0, 16, 20]) { // тело чанка может начинаться с повторного заголовка
    const p = c.off + skip;
    if (p + 24 > c.off + c.size) continue;
    const type = dv.getUint32(p + 4, true), n = dv.getUint32(p + 8, true), bpe = dv.getUint32(p + 12, true);
    if (type > 20 || !n || !bpe || bpe > 64 || p + 24 + n * bpe > c.off + c.size) continue;
    return { type, n, bpe, data: p + 24 };
  }
  return null;
}
function readSubsets(dv: DataView, c: CgfChunk): Array<{ first: number; count: number; mat: number }> | null {
  for (const skip of [0, 16, 20]) {
    const p = c.off + skip;
    if (p + 16 > c.off + c.size) continue;
    const n = dv.getUint32(p + 4, true);
    if (!n || n > 4096) continue;
    const rs = Math.floor((c.off + c.size - p - 16) / n); // размер записи зависит от версии (36–48), берём из размера чанка
    if (rs < 28 || rs > 64) continue;
    const out: Array<{ first: number; count: number; mat: number }> = [];
    for (let i = 0; i < n; i++) { const o = p + 16 + i * rs; out.push({ first: dv.getUint32(o, true), count: dv.getUint32(o + 4, true), mat: dv.getUint32(o + 16, true) }); }
    return out;
  }
  return null;
}

export function convertCgf(buf: ArrayBuffer): Model {
  const { ver, chunks } = parseChunks(buf), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const groups: Array<Record<number, Stream>> = [];
  let cur: Record<number, Stream> = {};
  for (const c of chunks) {
    if (c.type !== T.stream) continue;
    const s = readStream(dv, c);
    if (!s) continue;
    if (cur[s.type]) { groups.push(cur); cur = {}; }
    cur[s.type] = s;
  }
  if (Object.keys(cur).length) groups.push(cur);
  const subsetChunks = chunks.filter((c) => c.type === T.subsets).map((c) => readSubsets(dv, c)).filter((x): x is NonNullable<typeof x> => !!x);
  const gi = groups.findIndex((g) => g[S.POS] && g[S.INDICES]);
  if (gi < 0) throw new Error(`В CGF (версия 0x${ver.toString(16)}) не найдены потоки позиций/индексов (возможно, сжатый формат или иная версия)`);
  const g = groups[gi]!, P = g[S.POS]!, I = g[S.INDICES]!, nv = P.n;
  if (P.bpe !== 12 && P.bpe !== 16) throw new Error(`Формат позиций (${P.bpe} байт/вершина) не поддержан`);
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = dv.getFloat32(P.data + i * P.bpe + k * 4, true);
  const idx = new Uint32Array(I.n);
  for (let i = 0; i < I.n; i++) idx[i] = I.bpe === 2 ? dv.getUint16(I.data + i * 2, true) : dv.getUint32(I.data + i * 4, true);
  for (let i = 0; i < idx.length; i++) if (idx[i]! >= nv) throw new Error('CGF: индекс вершины вне диапазона (раскладка потока не совпала)');
  const uv = new Float32Array(nv * 2), U = g[S.UV];
  if (U && U.n >= nv)
    for (let i = 0; i < nv; i++) {
      if (U.bpe === 8) { uv[i * 2] = dv.getFloat32(U.data + i * 8, true); uv[i * 2 + 1] = dv.getFloat32(U.data + i * 8 + 4, true); }
      else if (U.bpe === 4) { uv[i * 2] = half(dv.getUint16(U.data + i * 4, true)); uv[i * 2 + 1] = half(dv.getUint16(U.data + i * 4 + 2, true)); }
    }
  const subsets = subsetChunks[Math.min(gi, subsetChunks.length - 1)] ?? [{ first: 0, count: idx.length, mat: 0 }];
  const nor = computeNormals(pos, idx), meshes: Mesh[] = [];
  for (const s of subsets) {
    if (s.first > idx.length || s.count > idx.length) continue; // запись не прошла проверку диапазона
    const list = idx.subarray(s.first, Math.min(idx.length, s.first + s.count));
    if (list.length < 3) continue;
    meshes.push({ name: `subset (mat ${s.mat})`, texture: '', matId: s.mat, shader: '', vertexCount: nv, pos, nor, uv, bone: new Float32Array(nv * 4), weight: new Float32Array(nv * 4),
      indices: makeIndices(nv, list), skinned: false });
  }
  if (!meshes.length) throw new Error('В CGF нет треугольников');
  // имя материала из чанка MtlName: самая длинная печатная ASCII-строка
  let mtlName = '';
  const mc = chunks.find((c) => c.type === T.mtlname);
  if (mc) {
    let run = '';
    for (let i = mc.off; i < mc.off + mc.size; i++) {
      const b = u8[i]!;
      if (b >= 0x20 && b < 0x7f) run += String.fromCharCode(b);
      else { if (run.length > mtlName.length) mtlName = run; run = ''; }
    }
    if (run.length > mtlName.length) mtlName = run;
  }
  return { meshes, skeleton: null, motions: [], bounds: boundsOf([{ pos }]), flipZ: false, defaultZUp: true, cameraYaw: Math.PI, meta: { mtlName },
    info: [`CryEngine CGF (CrCh 0x${ver.toString(16)}): вершин ${nv}, подмешей ${meshes.length}, треугольников ${sumTris(meshes)}${groups.length > 1 ? `, групп потоков ${groups.length} (показана №${gi})` : ''}`,
      'Только статика: трансформы узлов, скелет и анимации не применяются.', mtlName ? `Материал: ${mtlName}.mtl` : 'Имя .mtl не найдено — материал берётся рядом по имени файла'] };
}
