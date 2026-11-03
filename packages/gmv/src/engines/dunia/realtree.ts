// Деревья и кусты RealTree (Far Cry 2): в архиве — по хешу пути, имени нет; внутри — путь «…\Realtrees\RT_*.rta».
// Файл: u32 размер, u32 размер Havok-части, u32 136 (начало данных), 0, 0, u32 размер данных; с 24 — путь; с 136 — дамп
// памяти редактора (указатели — адреса; база — наименьший указатель − 0x360), после данных — список материалов (.mlm,
// читаются как .xbm: кора «RealtreeTrunk» и листва), затем — Havok (коллизия).
// Заголовок в 0x118: u32, u32, f32, u32 уровней ветвей, u32 узлов, ptr узлов, ptr, u32 ветвей, ptr, ptr параметров,
// u32 карточек листвы, ptr карточек.
// Узел (76 байт; поля со смещением 52 от начала записи): позиция f32×3, u32 — узлов до конца ветви (у начала ветви
// больше, чем у предыдущего узла — так ветви делятся), f32 масштаб уровня (ствол 1 или 2, ветви 0.5).
// Карточка листвы (92 байта): f32 размер с 16, нормаль с 20, касательная с 32, ось полукарточки с 68 (её длина = размер).
// Сетку дерева игра строит сама по параметрам ветвей — здесь приближение: ветви — трубки по узлам, листва — карточки
// шаблонов у концов ветвей.
import type { Mesh } from '../../core/types';

export interface RealTree { path: string; branches: Array<{ pts: number[][]; tips: number[]; scale: number }>; cards: Array<{ n: number[]; a: number[] }>; materials: string[]; height: number }

export const isRealTree = (u: Uint8Array): boolean => {
  if (u.length < 160) return false;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (dv.getUint32(8, true) !== 136) return false;
  const s = new TextDecoder('latin1').decode(u.subarray(24, 136));
  return /realtrees?\\/i.test(s);
};

export function parseRealTree(u: Uint8Array): RealTree {
  if (!isRealTree(u)) throw new Error('Не RealTree');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), dl = dv.getUint32(20, true);
  let e = u.indexOf(0, 24); if (e < 0 || e > 136) e = 136;
  const path = new TextDecoder('latin1').decode(u.subarray(24, e));
  const dataEnd = Math.min(u.length, 136 + dl);
  // база указателей: наименьший указатель-адрес в данных − 0x360 (первая структура после заголовка)
  let minPtr = Infinity;
  const hdr = Array.from({ length: 12 }, (_, i) => dv.getUint32(0x118 + i * 4, true));
  for (const i of [5, 6, 8, 9, 11]) if (hdr[i]! > 0x10000) minPtr = Math.min(minPtr, hdr[i]!);
  for (let o = 136; o + 4 <= dataEnd; o += 4) { const v = dv.getUint32(o, true); if (v >= 0x01000000 && v < minPtr && (v & 0xffff0000) === (minPtr & 0xffff0000)) minPtr = v; }
  if (!Number.isFinite(minPtr)) throw new Error('RealTree: нет указателей');
  const base = minPtr - 0x360, off = (p: number) => p - base + 0x88;
  const [nNodes, pNodes, nCards, pCards] = [hdr[4]!, hdr[5]!, hdr[10]!, hdr[11]!];
  const branches: RealTree['branches'] = [];
  let cur: RealTree['branches'][number] | null = null, height = 0;
  for (let r = 0; r < nNodes; r++) {
    const o = off(pNodes) + r * 76;
    if (o < 136 || o + 76 > dataEnd) break;
    const x = dv.getFloat32(o + 52, true), y = dv.getFloat32(o + 56, true), z = dv.getFloat32(o + 60, true), tip = dv.getUint32(o + 64, true), sc = dv.getFloat32(o + 68, true);
    if (tip > 100000 || ![x, y, z, sc].every(Number.isFinite) || Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1000) break;
    if (!cur || tip > cur.tips[cur.tips.length - 1]!) { cur = { pts: [], tips: [], scale: sc > 0 && sc < 10 ? sc : 1 }; branches.push(cur); }
    cur.pts.push([x, y, z]); cur.tips.push(tip);
    height = Math.max(height, z);
  }
  const cards: RealTree['cards'] = [];
  for (let i = 0; i < nCards; i++) {
    const o = off(pCards) + i * 92;
    if (o < 136 || o + 92 > dataEnd) break;
    const f = (k: number) => dv.getFloat32(o + k, true);
    const n = [f(20), f(24), f(28)], a = [f(68), f(72), f(76)];
    if (![...n, ...a].every(Number.isFinite) || Math.hypot(...a) > 50) continue;
    if (Math.hypot(...a) > 1e-3) cards.push({ n, a });
  }
  // материалы: строки «…\.mlm» после данных
  const materials: string[] = [];
  const tail = new TextDecoder('latin1').decode(u.subarray(dataEnd, Math.min(u.length, dataEnd + 4096)));
  for (const m of tail.matchAll(/graphics\\[\w\\ .-]+?\.mlm/gi)) materials.push(m[0]);
  return { path, branches: branches.filter((b) => b.pts.length >= 2), cards, materials, height };
}

/** Масштаб карточек листвы и показатель сужения ветвей (подобраны на глаз по кустам и фикусу). */
const LEAF_SCALE = 0.7, TAPER = 1.1;

const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm = (a: number[]) => { const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1; return [a[0]! / l, a[1]! / l, a[2]! / l]; };

/** Приближённая сетка: ветви — трубки (sides граней), листва — карточки у концов ветвей; bark/leaf — пути материалов .xbm. */
export function realTreeMeshes(t: RealTree, bark: { material?: string; texture: string; normal?: string }, leaf: { material?: string; texture: string; normal?: string }, sides = 4): Mesh[] {
  const R0 = Math.max(0.02, t.height * 0.025);
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  for (const b of t.branches) {
    const t0 = b.tips[0]! + 1, first = P.length / 3;
    let len = 0;
    b.pts.forEach((p, i) => {
      const d = norm(sub(b.pts[Math.min(i + 1, b.pts.length - 1)]!, b.pts[Math.max(i - 1, 0)]!));
      const up = Math.abs(d[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0], s1 = norm(cross(d, up)), s2 = cross(d, s1);
      const r = R0 * b.scale * Math.max(0.15, Math.pow((b.tips[i]! + 1) / t0, TAPER));
      if (i) len += Math.hypot(...sub(p, b.pts[i - 1]!));
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        const nx = s1[0]! * c + s2[0]! * s, ny = s1[1]! * c + s2[1]! * s, nz = s1[2]! * c + s2[2]! * s;
        P.push(p[0]! + nx * r, p[1]! + ny * r, p[2]! + nz * r); N.push(nx, ny, nz); U.push(k / sides, len);
      }
    });
    for (let i = 0; i + 1 < b.pts.length; i++) for (let k = 0; k < sides; k++) {
      const a = first + i * (sides + 1) + k, c = a + sides + 1;
      I.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const out: Mesh[] = [];
  const mk = (name: string, m: { material?: string; texture: string; normal?: string }, p: number[], n: number[], uv: number[], idx: number[], alpha: boolean): Mesh => ({
    name, texture: m.texture, material: m.material, normalMap: m.normal, vertexCount: p.length / 3, pos: Float32Array.from(p), nor: Float32Array.from(n), uv: Float32Array.from(uv),
    bone: new Float32Array(0), weight: new Float32Array(0), indices: p.length / 3 > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx), skinned: false, ...(alpha ? { alphaTest: true } : {}),
  });
  if (I.length) out.push(mk('RealTree · ветви (приближённо)', bark, P, N, U, I, false));
  // листва: у конца каждой ветви (кроме ствола) и у её середины — карточка шаблона (по кругу)
  if (t.cards.length) {
    const LP: number[] = [], LN: number[] = [], LU: number[] = [], LI: number[] = [];
    let k = 0;
    t.branches.forEach((b, bi) => {
      if (bi === 0 && t.branches.length > 1) return;
      for (const at of [b.pts.length - 1, Math.floor(b.pts.length / 2)]) {
        // карточка сужена (шаблон — полуразмер облака листвы, у концов ветвей оно меньше)
        const c = b.pts[at]!, card = t.cards[k++ % t.cards.length]!, A = card.a.map((v) => v * LEAF_SCALE), n = norm(card.n), B = cross(n, A);
        const v0 = LP.length / 3;
        for (const [sa, sb, u, v] of [[-1, -1, 0, 1], [1, -1, 1, 1], [1, 1, 1, 0], [-1, 1, 0, 0]] as const) {
          LP.push(c[0]! + A[0]! * sa + B[0]! * sb, c[1]! + A[1]! * sa + B[1]! * sb, c[2]! + A[2]! * sa + B[2]! * sb); LN.push(n[0]!, n[1]!, n[2]!); LU.push(u, v);
        }
        LI.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      }
    });
    if (LI.length) out.push(mk('RealTree · листва (приближённо)', leaf, LP, LN, LU, LI, true));
  }
  return out;
}
