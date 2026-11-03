// Трава и мелкие детали X-Ray: модели .dm и карта level.details (ТЧ, ЧН, ЗП).
// .dm: шейдер, текстура (строки), u32 флаги, f32 мин./макс. масштаб, u32 вершин, u32 индексов, вершины {f32 x,y,z,u,v}, индексы u16.
// level.details — чанки: 0 заголовок (u32 версия 3, объектов, offs_x, offs_z, size_x, size_z), 1 модели (вложенные чанки .dm),
// 2 ячейки 2×2 м по 16 байт: u32 y_base:12 (×0.2 − 200 м), y_height:8 (×0.1 м), id0:6, id1:6; u32 id2:6, id3:6, свет…;
// 4×u16 плотности (по 4 бита на угол ячейки). Ячейка (x, z) лежит в мире с ((x − offs_x)·2, (z − offs_z)·2).
// Расстановку игра считает сама при показе (CDetailManager::cache_Decompress): сетка точек с дрожанием, выбор модели
// по интерполированной плотности с упорядоченным дизерингом, высота — луч вниз по коллизии уровня (level.cform),
// поворот вокруг Y и масштаб — случайные. Здесь тот же порядок; при большом числе треугольников трава прореживается.
import type { Mesh } from '../../core/types';

export interface DetailModel { shader: string; texture: string; flags: number; minScale: number; maxScale: number; pos: Float32Array; uv: Float32Array; indices: Uint16Array }

const dvOf = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.byteLength);

function chunks(u: Uint8Array): Map<number, Uint8Array> {
  const d = dvOf(u), out = new Map<number, Uint8Array>();
  for (let p = 0; p + 8 <= u.length; ) {
    const id = d.getUint32(p, true) & 0x7fffffff, size = d.getUint32(p + 4, true);
    if (p + 8 + size > u.length) break;
    out.set(id, u.subarray(p + 8, p + 8 + size));
    p += 8 + size;
  }
  return out;
}

export function parseDM(u: Uint8Array): DetailModel {
  const d = dvOf(u);
  let p = 0;
  const str = () => { const e = u.indexOf(0, p); if (e < 0) throw new Error('.dm: строка не закрыта'); const s = new TextDecoder('latin1').decode(u.subarray(p, e)); p = e + 1; return s; };
  const shader = str(), texture = str();
  if (p + 20 > u.length) throw new Error('.dm обрезан');
  const flags = d.getUint32(p, true), minScale = d.getFloat32(p + 4, true), maxScale = d.getFloat32(p + 8, true), nv = d.getUint32(p + 12, true), ni = d.getUint32(p + 16, true);
  p += 20;
  if (nv > 65536 || ni % 3 || p + nv * 20 + ni * 2 > u.length) throw new Error('.dm: неверное число вершин или индексов');
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), indices = new Uint16Array(ni);
  for (let i = 0; i < nv; i++, p += 20) { pos[i * 3] = d.getFloat32(p, true); pos[i * 3 + 1] = d.getFloat32(p + 4, true); pos[i * 3 + 2] = d.getFloat32(p + 8, true); uv[i * 2] = d.getFloat32(p + 12, true); uv[i * 2 + 1] = d.getFloat32(p + 16, true); }
  for (let i = 0; i < ni; i++, p += 2) indices[i] = d.getUint16(p, true);
  return { shader, texture, flags, minScale, maxScale, pos, uv, indices };
}

/** Меш модели .dm (нормали вверх — как освещается трава). */
export function dmMesh(m: DetailModel, name: string): Mesh {
  const n = m.pos.length / 3, nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) nor[i * 3 + 1] = 1;
  return { name, texture: m.texture, shader: m.shader, vertexCount: n, pos: m.pos, nor, uv: m.uv, bone: new Float32Array(n * 4), weight: new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), indices: m.indices, skinned: false, alphaTest: true };
}

export interface DetailsMap { version: number; offsX: number; offsZ: number; sizeX: number; sizeZ: number; models: DetailModel[]; slots: DataView }

export function parseDetails(u: Uint8Array): DetailsMap {
  const c = chunks(u), h = c.get(0), objs = c.get(1), sl = c.get(2);
  if (!h || h.length < 24 || !objs || !sl) throw new Error('level.details: нет заголовка, моделей или ячеек');
  const hd = dvOf(h), [version, , offsX, offsZ, sizeX, sizeZ] = [0, 4, 8, 12, 16, 20].map((o) => hd.getUint32(o, true)) as [number, number, number, number, number, number];
  if (version !== 3) throw new Error(`level.details версии ${version} не поддерживается`);
  if (sizeX * sizeZ * 16 > sl.length) throw new Error('level.details: ячейки обрезаны');
  const models = [...chunks(objs)].sort((a, b) => a[0] - b[0]).map(([, b]) => parseDM(b));
  return { version, offsX, offsZ, sizeX, sizeZ, models, slots: dvOf(sl) };
}

/** Коллизия уровня (level.cform): u32 версия 4, вершин, треугольников, рамка (6×f32); вершины f32×3; треугольники {u32×3, u32 материал}. */
export interface CForm { verts: Float32Array; tris: Uint32Array }
export function parseCForm(u: Uint8Array): CForm {
  const d = dvOf(u), ver = d.getUint32(0, true), nv = d.getUint32(4, true), nt = d.getUint32(8, true);
  if (ver !== 4 || 36 + nv * 12 + nt * 16 > u.length) throw new Error('level.cform: неизвестный формат');
  const verts = new Float32Array(nv * 3), tris = new Uint32Array(nt * 3);
  for (let i = 0, p = 36; i < nv * 3; i++, p += 4) verts[i] = d.getFloat32(p, true);
  for (let i = 0, p = 36 + nv * 12; i < nt; i++, p += 16) { tris[i * 3] = d.getUint32(p, true); tris[i * 3 + 1] = d.getUint32(p + 4, true); tris[i * 3 + 2] = d.getUint32(p + 8, true); }
  return { verts, tris };
}

/** CRandom движка (как rand() MSVC). */
class CRandom {
  constructor(private s: number) {}
  next() { this.s = (Math.imul(this.s, 214013) + 2531011) >>> 0; return (this.s >>> 16) & 0x7fff; }
  randI(n: number) { return this.next() % n; }
  randF(a: number, b: number) { return a + ((b - a) * this.next()) / 32767; }
  randFs(r: number) { return this.randF(-r, r); }
}

/** Упорядоченный дизеринг 16×16 (матрица Байера, пороги 0..255). */
const DITHER = (() => {
  let m = [[0]];
  for (let n = 1; n < 16; n *= 2) m = Array.from({ length: n * 2 }, (_, y) => Array.from({ length: n * 2 }, (_, x) => 4 * m[y % n]![x % n]! + [[0, 2], [3, 1]][+(y >= n)]![+(x >= n)]!));
  return Uint8Array.from(m.flat());
})();
export const DETAIL_TRI_BUDGET = 1_500_000;
/** Плотность травы по умолчанию (r__detail_density): шаг сетки точек в метрах. */
const DENSITY = 0.3, SLOT = 2;

export interface DetailsResult { meshes: Mesh[]; items: number; candidates: number; keep: number }

/**
 * Расстановка деталей по карте и коллизии; budget — предел треугольников (лишнее прореживается равномерно).
 * Координаты — как у геометрии уровня (левосторонние, Y вверх).
 */
export function buildDetails(map: DetailsMap, cf: CForm, budget = DETAIL_TRI_BUDGET): DetailsResult {
  const { sizeX, sizeZ, offsX, offsZ, slots, models } = map, nObj = models.length;
  const dSize = Math.ceil(SLOT / DENSITY), jitter = DENSITY / 1.7;
  // непустые ячейки и их высоты
  const slotOk = new Uint8Array(sizeX * sizeZ), yLo = new Float32Array(sizeX * sizeZ), yHi = new Float32Array(sizeX * sizeZ);
  for (let i = 0; i < sizeX * sizeZ; i++) {
    const a = slots.getUint32(i * 16, true), b = slots.getUint32(i * 16 + 4, true);
    const ids = [(a >>> 20) & 63, (a >>> 26) & 63, b & 63, (b >>> 6) & 63];
    let any = false;
    for (let k = 0; k < 4; k++) if (ids[k]! < nObj && slots.getUint16(i * 16 + 8 + k * 2, true)) any = true;
    if (!any) continue;
    slotOk[i] = 1; yLo[i] = (a & 0xfff) * 0.2 - 200; yHi[i] = yLo[i]! + ((a >>> 12) & 0xff) * 0.1;
  }
  // треугольники коллизии по ячейкам (только непустые)
  const { verts: V, tris: T } = cf, nt = T.length / 3;
  const cnt = new Uint32Array(sizeX * sizeZ + 1);
  const forCells = (t: number, f: (cell: number) => void) => {
    const a = T[t * 3]! * 3, b = T[t * 3 + 1]! * 3, c = T[t * 3 + 2]! * 3;
    const x0 = Math.floor(Math.min(V[a]!, V[b]!, V[c]!) / SLOT) + offsX, x1 = Math.floor(Math.max(V[a]!, V[b]!, V[c]!) / SLOT) + offsX;
    const z0 = Math.floor(Math.min(V[a + 2]!, V[b + 2]!, V[c + 2]!) / SLOT) + offsZ, z1 = Math.floor(Math.max(V[a + 2]!, V[b + 2]!, V[c + 2]!) / SLOT) + offsZ;
    const ylo = Math.min(V[a + 1]!, V[b + 1]!, V[c + 1]!), yhi = Math.max(V[a + 1]!, V[b + 1]!, V[c + 1]!);
    for (let z = Math.max(0, z0); z <= Math.min(sizeZ - 1, z1); z++) for (let x = Math.max(0, x0); x <= Math.min(sizeX - 1, x1); x++) {
      const cell = z * sizeX + x;
      if (slotOk[cell] && yhi >= yLo[cell]! - 0.01 && ylo <= yHi[cell]! + 0.01) f(cell);
    }
  };
  for (let t = 0; t < nt; t++) forCells(t, (cell) => cnt[cell + 1]!++);
  for (let i = 0; i < sizeX * sizeZ; i++) cnt[i + 1]! += cnt[i]!;
  const fill = cnt.slice(0, sizeX * sizeZ), list = new Uint32Array(cnt[sizeX * sizeZ]!);
  for (let t = 0; t < nt; t++) forCells(t, (cell) => { list[fill[cell]!++] = t; });

  // проход по ячейкам: kind 0 — подсчёт треугольников, 1 — постановка
  const triOf = models.map((m) => m.indices.length / 3);
  const alpha = new Float32Array(16), ids = new Int32Array(4), sel: number[] = [];
  const walk = (emit: (obj: number, x: number, y: number, z: number, scale: number, yaw: number, cell: number) => void, needY: boolean) => {
    for (let dz = 0; dz < sizeZ; dz++) for (let dx = 0; dx < sizeX; dx++) {
      const cell = dz * sizeX + dx;
      if (!slotOk[cell]) continue;
      const o = cell * 16, a = slots.getUint32(o, true), b = slots.getUint32(o + 4, true);
      ids[0] = (a >>> 20) & 63; ids[1] = (a >>> 26) & 63; ids[2] = b & 63; ids[3] = (b >>> 6) & 63;
      for (let k = 0; k < 4; k++) { const pal = slots.getUint16(o + 8 + k * 2, true); for (let j = 0; j < 4; j++) alpha[k * 4 + j] = (255 * ((pal >> (j * 4)) & 15)) / 15; }
      const sx = dx - offsX, sz = dz - offsZ, seed = (0x12071980 ^ Math.imul(sx, sz)) >>> 0;
      const rSel = new CRandom(seed), rJit = new CRandom(seed), rYaw = new CRandom(seed), rScl = new CRandom(seed);
      const minX = sx * SLOT, minZ = sz * SLOT, top = yHi[cell]!, bottom = yLo[cell]!;
      for (let z = 0; z <= dSize; z++) for (let x = 0; x <= dSize; x++) {
        const shx = rJit.randI(16), shz = rJit.randI(16);
        sel.length = 0;
        const cx = Math.min(x, dSize - 1), cz = Math.min(z, dSize - 1), fx = cx / dSize, fz = cz / dSize;
        for (let k = 0; k < 4; k++) {
          if (ids[k]! >= nObj) continue;
          const c01 = alpha[k * 4]! * (1 - fx) + alpha[k * 4 + 1]! * fx, c02 = alpha[k * 4 + 2]! * (1 - fx) + alpha[k * 4 + 3]! * fx;
          const c = Math.min(255, Math.max(0, Math.floor(c01 * (1 - fz) + c02 * fz + 0.5)));
          if (c > DITHER[((cx + shx) % 16) * 16 + ((cz + shz) % 16)]!) sel.push(k);
        }
        if (!sel.length) continue;
        const obj = ids[sel.length === 1 ? sel[0]! : sel[rSel.randI(sel.length)]!]!;
        const px = (x / dSize) * SLOT + minX + rJit.randFs(jitter), pz = (z / dSize) * SLOT + minZ + rJit.randFs(jitter);
        let y = bottom - 5;
        if (needY) {
          for (let i = cnt[cell]!; i < cnt[cell + 1]!; i++) {
            const t = list[i]!, A = T[t * 3]! * 3, B = T[t * 3 + 1]! * 3, C = T[t * 3 + 2]! * 3;
            // вертикальный луч: барицентрические координаты в плоскости XZ
            const ax = V[A]!, az = V[A + 2]!, e1x = V[B]! - ax, e1z = V[B + 2]! - az, e2x = V[C]! - ax, e2z = V[C + 2]! - az;
            const det = e1x * e2z - e2x * e1z;
            if (Math.abs(det) < 1e-9) continue;
            const qx = px - ax, qz = pz - az, u = (qx * e2z - e2x * qz) / det, v = (e1x * qz - qx * e1z) / det;
            if (u < 0 || v < 0 || u + v > 1) continue;
            const yt = V[A + 1]! + u * (V[B + 1]! - V[A + 1]!) + v * (V[C + 1]! - V[A + 1]!);
            if (yt <= top + 1e-3 && yt > y) y = yt;
          }
          if (y < bottom) continue;
        }
        const m = models[obj]!, scale = rScl.randF(m.minScale * 0.5, m.maxScale * 0.9), yaw = rYaw.randF(0, Math.PI * 2);
        emit(obj, px, y, pz, scale, yaw, cell);
      }
    }
  };
  let candTris = 0, candidates = 0;
  walk((obj) => { candTris += triOf[obj]!; candidates++; }, false);
  const keep = candTris > budget ? budget / candTris : 1;
  const thin = new CRandom(0x5eed);
  const P: number[][] = models.map(() => []), U: number[][] = models.map(() => []), I: number[][] = models.map(() => []);
  let items = 0;
  walk((obj, x, y, z, s, yaw) => {
    if (keep < 1 && thin.next() / 32768 >= keep) return;
    const m = models[obj]!, c = Math.cos(yaw), sn = Math.sin(yaw), p = P[obj]!, base = p.length / 3;
    if (base + m.pos.length / 3 > 4_000_000) return;
    for (let i = 0; i < m.pos.length; i += 3) {
      const vx = m.pos[i]! * s, vy = m.pos[i + 1]! * s, vz = m.pos[i + 2]! * s;
      p.push(x + vx * c + vz * sn, y + vy, z - vx * sn + vz * c); // поворот вокруг Y (как Fmatrix::rotateY)
    }
    for (let i = 0; i < m.uv.length; i++) U[obj]!.push(m.uv[i]!);
    for (let i = 0; i < m.indices.length; i++) I[obj]!.push(base + m.indices[i]!);
    items++;
  }, true);
  const meshes: Mesh[] = [];
  models.forEach((m, k) => {
    if (!I[k]!.length) return;
    const n = P[k]!.length / 3, nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) nor[i * 3 + 1] = 1;
    meshes.push({ name: `Трава · ${m.texture}`, texture: m.texture, shader: m.shader, vertexCount: n, pos: Float32Array.from(P[k]!), nor, uv: Float32Array.from(U[k]!), bone: new Float32Array(n * 4), weight: new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), indices: Uint32Array.from(I[k]!), skinned: false, alphaTest: true });
  });
  return { meshes, items, candidates, keep };
}
