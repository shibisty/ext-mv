// Карты нормалей: варианты имени по диффузной текстуре, распознавание упаковки (RGB / RG (BC5) / AG (DXT5nm)), касательные.
import { baseName } from './binary';
import type { DecodedImage, Mesh } from './types';

/** Упаковка нормали в текстуре: xyz в RGB; только XY в RG (BC5/ATI2); X в альфе и Y в зелёном (DXT5nm, «swizzled»). */
export type NormalPacking = 'rgb' | 'rg' | 'ag';

/** Суффиксы диффузной текстуры и соответствующие суффиксы карты нормалей (по играм). */
const SWAPS: Array<[RegExp, string[]]> = [
  [/_c[oa]$/, ['_nohq', '_nofhq', '_no']], // Arma: _co/_ca -> _nohq
  [/__d(_a)?$/, ['__n_d', '__n']], // Spintires/MudRunner/SnowRunner: __d -> __n_d
  [/_diff(use)?(?=_\d{3}|$)/, ['_normal', '_n', '_ddn', '_nrm']], // GTA V ped: uppr_diff_000_a_uni -> uppr_normal_000; CryEngine _diff -> _ddn
  [/_b\.color$/, ['_nm.normal', '_n.normal', '_nm', '_n']], // BeamNG PBR: _b.color -> _nm.normal
  [/_(albedo|basecolor|base_color|color|col|alb)$/, ['_normal', '_n', '_nrm', '_nm']],
  [/_d$/, ['_n', '_nm', '_normal', '_ddn']],
  [/_c$/, ['_n', '_nm']],
  [/_dif$/, ['_nrm', '_nor', '_n']],
];
const PLAIN = ['_n', '_normal', '_nm', '_nrm', '_norm', '_ddn', '_local', '_bump_n', '_nohq'];

/** Имена-кандидаты карты нормалей (без расширения, с тем же путём) для диффузной текстуры. */
export function normalCandidates(diffuse: string): string[] {
  if (!diffuse) return [];
  const p = diffuse.replace(/\\/g, '/'), dir = p.slice(0, p.lastIndexOf('/') + 1), stem = baseName(p).replace(/\.(dds|tga|png|jpe?g|paa|pac|pct|vtf|bmp|pcx|gif|webp|wal)$/i, '').toLowerCase();
  const out = new Set<string>();
  for (const [re, subs] of SWAPS) if (re.test(stem)) for (const s of subs) out.add(stem.replace(re, s));
  // GTA V: uppr_diff_000_a_uni -> uppr_normal_000 (нормаль одна на все варианты цвета)
  const gta = /^([a-z]+)_diff_(\d{3})_[a-z]_[a-z]+$/.exec(stem);
  if (gta) out.add(`${gta[1]}_normal_${gta[2]}`);
  for (const s of PLAIN) out.add(stem + s);
  out.delete(stem);
  return [...out].map((n) => dir + n);
}

/**
 * Похоже ли изображение на карту нормалей и как оно упаковано. Выборка по сетке пикселей:
 * RGB — синий в среднем высокий; RG — синий почти постоянный и низкий (BC5); AG — красный постоянный, альфа меняется (DXT5nm).
 */
export function analyzeNormalMap(img: DecodedImage): { normal: boolean; packing: NormalPacking } {
  const d = img.rgba;
  if (!d) return { normal: true, packing: 'rgb' }; // ImageBitmap (браузерные PNG/JPG) — считаем обычной RGB-нормалью
  const n = img.width * img.height, step = Math.max(1, Math.floor(n / 4096));
  let cnt = 0, r = 0, g = 0, b = 0, a = 0, rv = 0, av = 0, unit = 0;
  const r0 = d[0]!, a0 = d[3]!;
  for (let i = 0; i < n; i += step) {
    const o = i * 4, R = d[o]!, G = d[o + 1]!, B = d[o + 2]!, A = d[o + 3]!;
    r += R; g += G; b += B; a += A; cnt++;
    rv += Math.abs(R - r0); av += Math.abs(A - a0);
    const x = R / 127.5 - 1, y = G / 127.5 - 1, z = B / 127.5 - 1, len = Math.hypot(x, y, z);
    if (len > 0.75 && len < 1.25 && z > -0.1) unit++;
  }
  r /= cnt; g /= cnt; b /= cnt; a /= cnt; rv /= cnt; av /= cnt;
  // DXT5nm (Arma _nohq и др.): красный пустой (0/255) или постоянный, X — в альфе (в среднем около середины)
  if ((r < 16 || r > 239 || rv < 6) && a > 60 && a < 196 && (av > 2 || Math.abs(a - 128) < 24) && g > 60 && g < 196) return { normal: true, packing: 'ag' };
  if (b < 40 && r > 60 && r < 196 && g > 60 && g < 196) return { normal: true, packing: 'rg' };
  return { normal: b > 150 && unit / cnt > 0.6 && r > 70 && r < 185 && g > 70 && g < 185, packing: 'rgb' };
}

/** Касательные по UV (накопление по треугольникам), xyz + знак битангенса в w. */
export function computeTangents(m: Pick<Mesh, 'pos' | 'nor' | 'uv' | 'indices' | 'vertexCount'>): Float32Array {
  const n = m.vertexCount, t = new Float32Array(n * 3), bt = new Float32Array(n * 3), out = new Float32Array(n * 4);
  const P = m.pos, U = m.uv, I = m.indices;
  for (let k = 0; k + 2 < I.length; k += 3) {
    const a = I[k]!, b = I[k + 1]!, c = I[k + 2]!;
    const e1x = P[b * 3]! - P[a * 3]!, e1y = P[b * 3 + 1]! - P[a * 3 + 1]!, e1z = P[b * 3 + 2]! - P[a * 3 + 2]!;
    const e2x = P[c * 3]! - P[a * 3]!, e2y = P[c * 3 + 1]! - P[a * 3 + 1]!, e2z = P[c * 3 + 2]! - P[a * 3 + 2]!;
    const du1 = U[b * 2]! - U[a * 2]!, dv1 = U[b * 2 + 1]! - U[a * 2 + 1]!, du2 = U[c * 2]! - U[a * 2]!, dv2 = U[c * 2 + 1]! - U[a * 2 + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const f = 1 / det;
    const tx = f * (dv2 * e1x - dv1 * e2x), ty = f * (dv2 * e1y - dv1 * e2y), tz = f * (dv2 * e1z - dv1 * e2z);
    const bx = f * (du1 * e2x - du2 * e1x), by = f * (du1 * e2y - du2 * e1y), bz = f * (du1 * e2z - du2 * e1z);
    for (const v of [a, b, c]) { t[v * 3] += tx; t[v * 3 + 1] += ty; t[v * 3 + 2] += tz; bt[v * 3] += bx; bt[v * 3 + 1] += by; bt[v * 3 + 2] += bz; }
  }
  for (let v = 0; v < n; v++) {
    const nx = m.nor[v * 3]!, ny = m.nor[v * 3 + 1]!, nz = m.nor[v * 3 + 2]!;
    let tx = t[v * 3]!, ty = t[v * 3 + 1]!, tz = t[v * 3 + 2]!;
    // Грам — Шмидт: касательная перпендикулярна нормали
    const dn = tx * nx + ty * ny + tz * nz;
    tx -= nx * dn; ty -= ny * dn; tz -= nz * dn;
    let len = Math.hypot(tx, ty, tz);
    if (len < 1e-8) { // нет UV-градиента: любая перпендикулярная
      const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
      tx = ay * nz - 0 * ny; ty = 0 * nx - ax * nz; tz = ax * ny - ay * nx;
      len = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= len; ty /= len; tz /= len;
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    const w = cx * bt[v * 3]! + cy * bt[v * 3 + 1]! + cz * bt[v * 3 + 2]! < 0 ? -1 : 1;
    out[v * 4] = tx; out[v * 4 + 1] = ty; out[v * 4 + 2] = tz; out[v * 4 + 3] = w;
  }
  return out;
}
