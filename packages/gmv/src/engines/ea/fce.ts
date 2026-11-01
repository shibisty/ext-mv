// Need for Speed III: Hot Pursuit / High Stakes: FCE3 / FCE4 (car.fce). Таблицы частей ищутся по структуре (самопроверка),
// а не по зашитым смещениям: first/num вершин и треугольников обязаны образовать префиксные суммы.
import { emptyBounds, makeIndices, sumTris } from '../../core/geometry';
import type { Mesh, Model } from '../../core/types';
import { FCE_MAGIC } from './magic';
const HEADER_SIZES = [0x1f04, 0x2038, 0x2128];

interface Parts { o: number; n: number; first: number[]; num: number[]; tfirst: number[]; tnum: number[] }

function findParts(dv: DataView, hs: number, nVerts: number, nTris: number): Parts | null {
  const U = (o: number) => dv.getUint32(o, true);
  for (let o = 0x300; o + 1024 <= hs; o += 4) {
    if (U(o) !== 0 || U(o + 512) !== 0 || U(o + 256) === 0 || U(o + 768) === 0) continue;
    let n = 0, sv = 0, st = 0, ok = true;
    for (let i = 0; i < 64; i++) {
      const A = U(o + i * 4), B = U(o + 256 + i * 4), C = U(o + 512 + i * 4), D = U(o + 768 + i * 4);
      if (sv === nVerts && st === nTris) break;
      if (A !== sv || C !== st || (B === 0 && D === 0)) { ok = false; break; }
      sv += B; st += D; n = i + 1;
    }
    if (ok && n && sv === nVerts && st === nTris) {
      const rd = (base: number) => Array.from({ length: n }, (_, i) => U(base + i * 4));
      return { o, n, first: rd(o), num: rd(o + 256), tfirst: rd(o + 512), tnum: rd(o + 768) };
    }
  }
  return null;
}

interface Tri { part: number; page: number; v: number[]; u: number[]; w: number[] }

export function parseFce(buf: ArrayBuffer) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), U = (o: number) => dv.getUint32(o, true), F = (o: number) => dv.getFloat32(o, true);
  if (buf.byteLength < 0x20) throw new Error('FCE: файл слишком короткий');
  const ver = FCE_MAGIC[U(0)];
  if (!ver) throw new Error('Не FCE (неизвестная сигнатура 0x' + U(0).toString(16) + ')');
  const nTris = U(8), nVerts = U(12), vOff = U(0x14), nOff = U(0x18), tOff = U(0x1c);
  if (!nVerts || !nTris || nVerts > 200000 || nTris > 400000) throw new Error('FCE: неверные счётчики');
  let hs = 0, parts: Parts | null = null;
  for (const h of HEADER_SIZES) {
    if (h + vOff + nVerts * 12 > buf.byteLength || h + tOff + nTris * 56 > buf.byteLength || h + nOff + nVerts * 12 > buf.byteLength) continue;
    let ok = true;
    for (let i = 0; i < Math.min(nVerts, 64); i++) { const x = F(h + vOff + i * 12); if (!Number.isFinite(x) || Math.abs(x) > 1000) { ok = false; break; } }
    if (!ok) continue;
    const p = findParts(dv, h, nVerts, nTris);
    if (p) { hs = h; parts = p; break; }
  }
  if (!parts) throw new Error('FCE: не удалось найти таблицы частей (версия формата не распознана)');
  const n = parts.n, o = parts.o, P = parts;
  // имена частей: n слотов по 64 байта, каждое начинается с «:»
  let names = Array.from({ length: n }, (_, i) => `part ${i}`);
  for (let p = 0x20; p + 64 * n <= hs; p++) {
    if (u8[p] !== 0x3a) continue;
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      if (u8[p + 64 * i] !== 0x3a) ok = false;
      for (let k = 1; k < 8 && ok; k++) { const c = u8[p + 64 * i + k]!; if (c !== 0 && (c < 0x20 || c > 0x7e)) ok = false; }
    }
    if (ok) {
      names = Array.from({ length: n }, (_, i) => { let s = ''; for (let k = 0; k < 64 && u8[p + 64 * i + k]; k++) s += String.fromCharCode(u8[p + 64 * i + k]!); return s; });
      break;
    }
  }
  const pos = new Float32Array(nVerts * 3), nor = new Float32Array(nVerts * 3);
  for (let i = 0; i < nVerts * 3; i++) { pos[i] = F(hs + vOff + i * 4); nor[i] = F(hs + nOff + i * 4); }
  const partPos = Array.from({ length: n }, (_, i) => [F(o - 768 + i * 12), F(o - 768 + i * 12 + 4), F(o - 768 + i * 12 + 8)]);
  // вершины локальны относительно центра части? сравниваем центроиды с позициями частей
  let cs = 0, ps = 0;
  P.first.forEach((f, k) => {
    const c = [0, 0, 0];
    for (let v = 0; v < P.num[k]!; v++) for (let a = 0; a < 3; a++) c[a] += pos[(f + v) * 3 + a]! / P.num[k]!;
    cs += Math.hypot(...c);
    ps += Math.hypot(...partPos[k]!);
  });
  const local = cs < ps * 0.5 + 0.01 * n;
  const tris: Tri[] = [];
  for (let k = 0; k < n; k++)
    for (let t = P.tfirst[k]!; t < P.tfirst[k]! + P.tnum[k]!; t++) {
      const b = hs + tOff + t * 56, v = [U(b + 4), U(b + 8), U(b + 12)].map((x) => P.first[k]! + x);
      if (v.some((x) => x >= nVerts)) continue;
      tris.push({ part: k, page: U(b), v, u: [F(b + 32), F(b + 36), F(b + 40)], w: [F(b + 44), F(b + 48), F(b + 52)] });
    }
  return { ver, hs, names, pos, nor, partPos, local, tris, nVerts };
}

export function convertFce(buf: ArrayBuffer): Model {
  const d = parseFce(buf), skip = /^:[mltp]/i, keep = (k: number) => !skip.test(d.names[k]!);
  let use = (k: number) => keep(k);
  if (!d.names.some((_, k) => keep(k))) use = () => true;
  const groups = new Map<number, { part: number; page: number; tris: Tri[] }>();
  for (const t of d.tris) {
    if (!use(t.part)) continue;
    const key = t.part * 1000 + (t.page & 0x3ff);
    if (!groups.has(key)) groups.set(key, { part: t.part, page: t.page, tris: [] });
    groups.get(key)!.tris.push(t);
  }
  const meshes: Mesh[] = [];
  for (const g of groups.values()) {
    const map = new Map<string, number>(), pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [], pp = d.local ? d.partPos[g.part]! : [0, 0, 0];
    for (const t of g.tris)
      for (let c = 0; c < 3; c++) {
        const gi = t.v[c]!, u = Number.isFinite(t.u[c]) ? t.u[c]! : 0, w = Number.isFinite(t.w[c]) ? t.w[c]! : 0, key = `${gi}|${u}|${w}`;
        let v = map.get(key);
        if (v === undefined) {
          v = map.size; map.set(key, v);
          for (let a = 0; a < 3; a++) { pos.push(d.pos[gi * 3 + a]! + pp[a]!); nor.push(d.nor[gi * 3 + a]!); }
          uv.push(u, 1 - w);
        }
        idx.push(v);
      }
    const nv = map.size;
    meshes.push({ name: `${d.names[g.part]} (tex ${g.page})`, texture: g.page === 0 ? 'car00' : `car${String(g.page).padStart(2, '0')}`, shader: '', vertexCount: nv,
      pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: Float32Array.from(uv), bone: new Float32Array(nv * 4), weight: new Float32Array(nv * 4), indices: makeIndices(nv, idx), skinned: false });
  }
  if (!meshes.length) throw new Error('FCE: нет видимой геометрии');
  // оси: самая длинная — вперёд (z), самая короткая — вверх (y), средняя — вбок (x)
  const { min, max } = emptyBounds();
  for (const m of meshes) for (let i = 0; i < m.pos.length; i++) { const k = i % 3; if (m.pos[i]! < min[k]!) min[k] = m.pos[i]!; if (m.pos[i]! > max[k]!) max[k] = m.pos[i]!; }
  const ext = [0, 1, 2].map((a) => max[a]! - min[a]!), order = [0, 1, 2].sort((a, b) => ext[a]! - ext[b]!), up = order[0]!, side = order[1]!, fwd = order[2]!;
  for (const m of meshes)
    for (const a of [m.pos, m.nor])
      for (let i = 0; i < a.length; i += 3) { const s = [a[i]!, a[i + 1]!, a[i + 2]!]; a[i] = s[side]!; a[i + 1] = s[up]!; a[i + 2] = s[fwd]!; }
  const b = { min: [min[side]!, min[up]!, min[fwd]!], max: [max[side]!, max[up]!, max[fwd]!] };
  return { meshes, skeleton: null, motions: [], bounds: b, flipZ: false, defaultZUp: false, cameraYaw: 0,
    info: [`NFS FCE${d.ver === 3 ? '3 (NFS3)' : d.ver === 4 ? '4 (NFS4 HS)' : '4M (MCO)'}: частей ${d.names.length}, показано мешей ${meshes.length}, треугольников ${sumTris(meshes)}`,
      `Заголовок 0x${d.hs.toString(16)}, вершины ${d.local ? 'локальны (смещены на позицию части)' : 'глобальны'}; оси подобраны по габаритам. Показан LOD0 (части :M/:L/:T скрыты).`, 'Текстура: car00.tga из того же VIV/папки.'] };
}
