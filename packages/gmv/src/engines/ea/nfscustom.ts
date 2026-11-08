// NFS World: вид машины, который игра собирает сама — окраска (цвет), винилы (CARS/VINYLS/<хеш>.vyl) и колёса с дисками
// (библиотеки CARS/WHEELS*). Кузов покрыт «кожей» <машина>_SKIN1 — в файлах это заглушка 512×512 ровного серого; игра
// рисует в неё цвет и винилы по общей для всех машин раскладке: левый бок слева (перед — сверху, низ — к середине),
// правый — справа зеркально, капот — сверху посередине, багажник — снизу.
import type { LoadContext } from '../../core/plugin';
import type { DecodedImage } from '../../core/types';
import { bbBlocks, bbChunks, BB_GEOMETRY, binHash, readTpks, skipPad, unLzc, type BbTexture } from './blackbox';

/** Цвета окраски (линейка близка к стандартной палитре игры). */
export const PAINTS: Array<{ id: string; label: string; rgb: [number, number, number] }> = [
  { id: 'grey', label: 'серебристый', rgb: [0.62, 0.64, 0.68] },
  { id: 'white', label: 'белый', rgb: [0.9, 0.9, 0.9] },
  { id: 'black', label: 'чёрный', rgb: [0.06, 0.06, 0.07] },
  { id: 'red', label: 'красный', rgb: [0.65, 0.04, 0.04] },
  { id: 'orange', label: 'оранжевый', rgb: [0.85, 0.35, 0.02] },
  { id: 'yellow', label: 'жёлтый', rgb: [0.9, 0.72, 0.05] },
  { id: 'green', label: 'зелёный', rgb: [0.06, 0.4, 0.12] },
  { id: 'blue', label: 'синий', rgb: [0.04, 0.16, 0.55] },
  { id: 'lightblue', label: 'голубой', rgb: [0.25, 0.55, 0.85] },
  { id: 'purple', label: 'фиолетовый', rgb: [0.35, 0.08, 0.5] },
];

// ---------- винилы ----------
export interface VinylLayer { mask: Uint8Array; width: number; height: number; color: [number, number, number]; threshold: number }
export interface Vinyl { hash: number; layers: VinylLayer[] }

/**
 * .vyl: блоки .lzc → `0x8003ce00{0x3ce01 заголовок (число слоёв @8, хеш @16), 0x3ce02 слои по 208 байт (цвет ARGB @64,
 * хеш маски @204, порог @208)}` + TPK с масками SDM_<имя>_<слой> (L8, «поле расстояний»: порог 128 — край, внутри — ниже порога).
 */
export function parseVinyl(raw: Uint8Array): Vinyl | null {
  const u = unLzc(raw), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const top = bbChunks(u, 0, u.length), head = top.find((c) => c.id === 0x8003ce00);
  if (!head) return null;
  const kids = bbChunks(u, head.off, head.off + head.size);
  const h = kids.find((c) => c.id === 0x3ce01), l = kids.find((c) => c.id === 0x3ce02);
  if (!h || !l) return null;
  const n = dv.getUint32(h.off + 8, true), tex = readTpks(u), layers: VinylLayer[] = [];
  for (let k = 0; k < n && (k + 1) * 208 <= l.size + 4; k++) {
    const p = l.off + k * 208, argb = dv.getUint32(p + 64, true), th = dv.getUint32(p + 204, true), thr = p + 208 + 4 <= l.off + l.size ? dv.getUint32(p + 208, true) : 128;
    const t = tex.get(th);
    if (!t) continue;
    const d = t.data();
    if (d.length < t.width * t.height) continue;
    layers.push({ mask: d.subarray(0, t.width * t.height), width: t.width, height: t.height, color: [((argb >>> 16) & 255) / 255, ((argb >>> 8) & 255) / 255, (argb & 255) / 255], threshold: thr || 128 });
  }
  return layers.length ? { hash: dv.getUint32(h.off + 16, true), layers } : null;
}

/** Куда класть винил на коже: оба бока или капот. */
export type VinylPlace = 'sides' | 'hood';
interface Rect { u0: number; v0: number; u1: number; v1: number; flip: boolean; rot: boolean }
const PLACES: Record<VinylPlace, Rect[]> = {
  // бок: ось X картинки — вдоль машины (+V, к корме), ось Y — сверху вниз (+U к середине); правый — повёрнут на 180°
  sides: [{ u0: 0.09, v0: 0.2, u1: 0.27, v1: 0.78, flip: false, rot: true }, { u0: 0.73, v0: 0.2, u1: 0.91, v1: 0.78, flip: true, rot: true }],
  // капот: X картинки — слева направо (+U), Y — от носа к стеклу (+V)
  hood: [{ u0: 0.36, v0: 0.13, u1: 0.64, v1: 0.33, flip: false, rot: false }],
};

/** Кожа кузова: цвет окраски и винил поверх (сглаженный край поля расстояний). */
export function composeSkin(size: number, paint: [number, number, number], vinyl: Vinyl | null, place: VinylPlace = 'sides'): DecodedImage {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { out[i * 4] = paint[0] * 255; out[i * 4 + 1] = paint[1] * 255; out[i * 4 + 2] = paint[2] * 255; out[i * 4 + 3] = 255; }
  if (vinyl) for (const r of PLACES[place]) {
    const x0 = Math.floor(r.u0 * size), x1 = Math.ceil(r.u1 * size), y0 = Math.floor(r.v0 * size), y1 = Math.ceil(r.v1 * size);
    for (const L of vinyl.layers) {
      // сохраняем пропорции картинки: вписываем в прямоугольник
      const ru = (x1 - x0), rv = (y1 - y0), imgW = r.rot ? rv : ru, imgH = r.rot ? ru : rv;
      const k = Math.min(imgW / L.width, imgH / L.height), w = L.width * k, h = L.height * k, ox = (imgW - w) / 2, oy = (imgH - h) / 2;
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        // координаты в картинке винила
        let ix: number, iy: number;
        if (r.rot) { ix = py - y0; iy = px - x0; } else { ix = px - x0; iy = py - y0; }
        if (r.flip) { ix = imgW - 1 - ix; iy = imgH - 1 - iy; }
        const sx = (ix - ox) / k, sy = (iy - oy) / k;
        if (sx < 0 || sy < 0 || sx >= L.width - 1 || sy >= L.height - 1) continue;
        const xi = sx | 0, yi = sy | 0, fx = sx - xi, fy = sy - yi, m = L.mask, W = L.width;
        const v = (m[yi * W + xi]! * (1 - fx) + m[yi * W + xi + 1]! * fx) * (1 - fy) + (m[(yi + 1) * W + xi]! * (1 - fx) + m[(yi + 1) * W + xi + 1]! * fx) * fy;
        // поле расстояний: внутри фигуры значения ниже порога
        const a = Math.max(0, Math.min(1, (L.threshold - v) / 12 + 0.5));
        if (a <= 0) continue;
        const o = (py * size + px) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = Math.round(out[o + c]! * (1 - a) + L.color[c]! * 255 * a);
      }
    }
  }
  return { width: size, height: size, rgba: out, name: 'кожа кузова' };
}

/** Ровная ли текстура (заглушка кожи): разброс яркости по выборке. */
export function isFlat(img: DecodedImage): boolean {
  const d = img.rgba;
  if (!d) return false;
  let mn = 765, mx = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { const v = d[i]! + d[i + 1]! + d[i + 2]!; mn = Math.min(mn, v); mx = Math.max(mx, v); }
  return mx - mn < 24;
}

const listCache = new WeakMap<object, Map<string, Promise<unknown>>>();
function cached<T>(ctx: LoadContext, key: string, make: () => Promise<T>): Promise<T> {
  const k = (ctx.archives[0] ?? listCache) as object;
  let m = listCache.get(k);
  if (!m) { m = new Map(); listCache.set(k, m); }
  if (!m.has(key)) m.set(key, make());
  return m.get(key) as Promise<T>;
}

/** Имена винилов: строки GLOBAL/commerce.bin, хеш имени Black Box совпадает с именем файла .vyl. */
export function vinylList(ctx: LoadContext, gameRoot: string): Promise<Array<{ id: string; label: string }>> {
  return cached(ctx, 'vinyls:' + gameRoot, async () => {
    const dir = `${gameRoot}cars/vinyls/`, hashes = new Set<number>();
    for (const a of ctx.archives) for (const e of a.entries) if (e.path.startsWith(dir) && e.path.endsWith('.vyl')) hashes.add(parseInt(e.path.slice(dir.length, -4), 16));
    if (!hashes.size) return [];
    const names = new Map<number, string>();
    const com = await ctx.readPath(gameRoot + 'global/commerce.bin');
    if (com) {
      let s = '';
      for (let i = 0; i <= com.length; i++) {
        const c = com[i] ?? 0;
        if (c >= 0x20 && c < 0x7f) { s += String.fromCharCode(c); continue; }
        if (s.length >= 3) { const h = binHash(s); if (hashes.has(h) && !names.has(h)) names.set(h, s); }
        s = '';
      }
    }
    return [...hashes].map((h) => ({ id: h.toString(16).toUpperCase().padStart(8, '0'), label: names.get(h) ?? `0x${h.toString(16).padStart(8, '0')}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });
}

export async function loadVinyl(ctx: LoadContext, gameRoot: string, id: string): Promise<Vinyl | null> {
  const u = await ctx.readPath(`${gameRoot}cars/vinyls/${id.toLowerCase()}.vyl`);
  return u ? parseVinyl(u) : null;
}

// ---------- колёса (шина с диском) из библиотек ----------
export interface WheelItem { id: string; label: string; lib: string; name: string }

/** Имена объектов GEOMETRY.bin с таблицей 0x134004 (каждый объект распаковывается — только заголовок). */
export function geometryNames(u: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out: Array<{ name: string; data: Uint8Array }> = [];
  const top = bbChunks(u, 0, u.length).find((c) => c.id === BB_GEOMETRY);
  if (!top) return out;
  const find = (off: number, end: number, depth: number): { off: number; size: number } | null => {
    for (const c of bbChunks(u, off, end)) {
      if (c.id === 0x134004) return c;
      if ((c.id & 0x80000000) && depth > 0) { const r = find(c.off, c.off + c.size, depth - 1); if (r) return r; }
    }
    return null;
  };
  const table = find(top.off, top.off + top.size, 2);
  if (!table) return out;
  for (let i = 0; i + 36 <= table.size; i += 36) {
    const e = table.off + i, off = dv.getUint32(e + 4, true), cs = dv.getUint32(e + 8, true), us = dv.getUint32(e + 12, true);
    if (!us || off >= u.length) continue;
    let o: Uint8Array;
    try { o = bbBlocks(u, off, cs, us); } catch { continue; }
    const obj = bbChunks(o, 0, o.length).find((c) => c.id === 0x80134010);
    const hdr = obj && bbChunks(o, obj.off, obj.off + obj.size).find((c) => c.id === 0x134011);
    if (!hdr) continue;
    let name = '';
    for (let k = skipPad(o, hdr.off, hdr.off + hdr.size) + 0xa0; k < hdr.off + hdr.size && o[k]; k++) name += String.fromCharCode(o[k]!);
    out.push({ name, data: o });
  }
  return out;
}

/** Колёса всех библиотек CARS/WHEELS*: «БРЕНД STYLE01 18″» (LOD A). */
export function wheelList(ctx: LoadContext, carsRoot: string): Promise<WheelItem[]> {
  return cached(ctx, 'wheels:' + carsRoot, async () => {
    const libs = new Set<string>();
    for (const a of ctx.archives) for (const e of a.entries) {
      const m = /^(.*\/)?(wheels\d*)\/geometry\.bin$/.exec(e.path);
      if (m && e.path.startsWith(carsRoot)) libs.add(m[2]!);
    }
    const out: WheelItem[] = [];
    for (const lib of [...libs].sort()) {
      const u = await ctx.readPath(`${carsRoot}${lib}/geometry.bin`);
      if (!u) continue;
      for (const { name } of geometryNames(u)) {
        const m = /^(.+)_STYLE(\d+)_(\d+)_\d+_A$/.exec(name);
        if (!m) continue;
        out.push({ id: `${lib}/${name}`, label: `${m[1]!.replace(/_/g, ' ')} ${+m[2]!} — ${m[3]}″`, lib, name });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  });
}

/** Объект колеса и текстуры его библиотеки. */
export async function loadWheel(ctx: LoadContext, carsRoot: string, id: string): Promise<{ data: Uint8Array; name: string; tex: Map<number, BbTexture> } | null> {
  const [lib, name] = id.split('/') as [string, string];
  const u = await ctx.readPath(`${carsRoot}${lib}/geometry.bin`);
  if (!u) return null;
  const obj = geometryNames(u).find((x) => x.name === name);
  if (!obj) return null;
  const tex = new Map<number, BbTexture>();
  const t = await ctx.readPath(`${carsRoot}${lib}/textures.bin`);
  if (t) try { readTpks(unLzc(t), tex); } catch { /* нет пакета */ }
  return { data: obj.data, name, tex };
}
