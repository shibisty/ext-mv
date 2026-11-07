// Материалы Enfusion (.emat, текст): «Класс { Ключ значение … }», ссылки на текстуры — «{GUID}путь.edds».
// MatPBRBasic и родственные: BCRMap (цвет + шероховатость в альфе), NMOMap (нормаль XY, металл, AO), OpacityMap.
// MatPBRMulti (техника, здания): до 4 слоёв (Color_N — цвет в линейном пространстве, BCR_N — тайловая текстура), маска слоёв
// MaskMap (R/G/B — слои 2–4 поверх 1) и GlobalMCRMap в «глобальной» развёртке (UVSrcGlobalMaps) — запекаем в одну текстуру.
import type { LoadContext } from '../../core/plugin';
import type { DecodedImage, SurfaceInfo } from '../../core/types';
import { decodeEdds, eddsBytesNeeded } from './edds';
import { enfusionPath, readPakPrefix } from './pak';

export interface EnfMaterial {
  cls: string; texturePath: string; image?: DecodedImage; normal?: DecodedImage; color?: number[]; surface?: SurfaceInfo;
  alphaTest?: boolean; hidden?: boolean; uvSet: 0 | 1;
}

/** Разбор текста: класс и ключи верхнего уровня (вложенные блоки — с префиксом «Ключ.»). */
export function parseEmat(text: string): { cls: string; parent?: string; props: Map<string, string> } {
  const props = new Map<string, string>(), lines = text.split(/\r?\n/);
  const head = /^\s*(\w+)\s*(?::\s*"([^"]+)")?/.exec(text), cls = head?.[1] ?? '', parent = head?.[2];
  const stack: string[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '}') { stack.pop(); continue; }
    const m = /^(\w+)\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let [, key, val] = m as unknown as [string, string, string];
    if (val.endsWith('{')) { stack.push(key); continue; }
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    props.set([...stack, key].join('.'), val);
  }
  return { cls, parent, props };
}

const srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const col = (s: string | undefined): number[] | null => {
  const v = s?.split(/\s+/).map(Number);
  return v && v.length >= 3 && v.every(Number.isFinite) ? [srgb(v[0]!), srgb(v[1]!), srgb(v[2]!)] : null;
};

const TRANSPARENT = /Glass|Decal|TreeCrown|Grass|Particle|Cable/;
const HIDDEN = /^(MatLightPortal|MatLightSource|MatDummy|HDREffect|.*Effect|MatWaterPool|SubsurfaceProfile)$/;

interface Cache { key: unknown; mats: Map<string, Promise<EnfMaterial | null>>; tex: Map<string, Promise<DecodedImage | null>> }
let cache: Cache = { key: null, mats: new Map(), tex: new Map() };
const cacheOf = (ctx: LoadContext): Cache => {
  const key = ctx.archives[0] ?? null;
  if (cache.key !== key) cache = { key, mats: new Map(), tex: new Map() };
  return cache;
};

/** Режим «мир»: текстуры не больше texLimit, без карт нормалей (тысячи префабов уровня). */
export const enfTextures = { limit: 1024, lite: false };

export function loadTexture(ref: string | undefined, ctx: LoadContext, maxSide = enfTextures.limit): Promise<DecodedImage | null> {
  maxSide = Math.min(maxSide, enfTextures.limit);
  if (!ref || !/\.edds$/i.test(ref)) return Promise.resolve(null);
  const c = cacheOf(ctx), k = `${enfusionPath(ref)}@${maxSide}`;
  let p = c.tex.get(k);
  if (!p) {
    p = (async () => {
      // мипы — от меньшего к большему: для уменьшенной текстуры хватает начала файла
      const u = await readPakPrefix(ctx.archives, ref, 512, (h) => eddsBytesNeeded(h, maxSide), () => ctx.readPath(enfusionPath(ref)));
      if (!u) return null;
      return { ...decodeEdds(u.slice().buffer, maxSide), name: enfusionPath(ref) };
    })().catch(() => null);
    // кэш ограничен: при просмотре многих моделей подряд память не копится
    if (c.tex.size > 96) { c.tex.clear(); c.mats.clear(); }
    c.tex.set(k, p);
  }
  return p;
}

export function loadEmat(ref: string, ctx: LoadContext): Promise<EnfMaterial | null> {
  const c = cacheOf(ctx), key = `${enfusionPath(ref)}@${enfTextures.limit}${enfTextures.lite ? 'l' : ''}`;
  let p = c.mats.get(key);
  if (!p) { if (c.mats.size > 512) c.mats.clear(); p = buildMaterial(ref, ctx); c.mats.set(key, p); }
  return p;
}

async function buildMaterial(ref: string, ctx: LoadContext): Promise<EnfMaterial | null> {
  // наследование: «Класс : "{GUID}родитель.emat" { … }» — ключи родителя, поверх них свои
  let cls = '';
  const props = new Map<string, string>(), chain: Map<string, string>[] = [];
  for (let r: string | undefined = ref, depth = 0; r && depth < 8; depth++) {
    const u = await ctx.readPath(enfusionPath(r));
    if (!u) { if (depth === 0) return null; break; }
    const e = parseEmat(new TextDecoder().decode(u));
    if (!cls) cls = e.cls;
    chain.unshift(e.props);
    r = e.parent;
  }
  for (const m of chain) for (const [k, v] of m) props.set(k, v);
  const mat: EnfMaterial = { cls, texturePath: '', uvSet: 0 };
  if (HIDDEN.test(cls)) { mat.hidden = true; return mat; }
  const nmo = enfTextures.lite ? null : await loadTexture(props.get('NMOMap') ?? props.get('GlobalNMOMap'), ctx);
  if (nmo) mat.normal = nmoToNormal(nmo);
  if (cls === 'MatPBRMulti') {
    mat.uvSet = /2/.test(props.get('UVSrcGlobalMaps') ?? '') ? 1 : 0;
    // один слой без маски и глобальных карт (одежда, части персонажей): BCR_1 — обычная текстура в развёртке 1
    if (!props.get('MaskMap') && !props.get('GlobalMCRMap') && !props.get('GlobalMCMap') && props.get('BCR_1')) {
      mat.uvSet = 0;
      const img = await loadTexture(props.get('BCR_1'), ctx);
      if (img) {
        const rgba = img.rgba!.slice();
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        mat.image = { width: img.width, height: img.height, rgba, name: enfusionPath(props.get('BCR_1')!) };
        mat.texturePath = mat.image.name!;
        const n1 = enfTextures.lite ? null : await loadTexture(props.get('NMO_1'), ctx);
        if (n1) mat.normal = nmoToNormal(n1);
        mat.surface = pbr(img, 3, n1, 'Enfusion BCR_1 + NMO_1');
        return mat;
      }
    }
    const baked = await bakeMulti(props, ctx, nmo);
    if (baked) {
      mat.image = baked.image; mat.texturePath = baked.path;
      // запечённая поверхность: R — AO (GlobalNMO), G — шероховатость, B — металличность слоёв по маске
      const ref = `#enf:${baked.path}:surface`, img = baked.surface;
      mat.surface = { roughness: { map: ref, channel: 1, image: img }, metallic: { map: ref, channel: 2, image: img }, ao: { map: ref, channel: 0, image: img }, source: 'Enfusion PBRMulti (слои по маске)' };
    } else mat.color = col(props.get('Color_1')) ?? undefined;
    return mat;
  }
  const base = props.get('BCRMap') ?? props.get('AlbedoMap') ?? props.get('CamoAlbedoMap') ?? props.get('BCRMap2');
  const img = await loadTexture(base, ctx);
  if (img) {
    mat.texturePath = enfusionPath(base!);
    const opacity = await loadTexture(props.get('OpacityMap'), ctx);
    const rgba = img.rgba!.slice();
    const glass = /Glass/.test(cls);
    // альфа BCR — шероховатость, не прозрачность
    if (opacity && opacity.width === img.width && opacity.height === img.height) for (let i = 3; i < rgba.length; i += 4) rgba[i] = opacity.rgba![i - 3]!;
    else if (!/Particle|MatCommon/.test(cls)) for (let i = 3; i < rgba.length; i += 4) rgba[i] = glass ? 90 : 255;
    mat.image = { width: img.width, height: img.height, rgba, name: mat.texturePath };
    if (opacity && TRANSPARENT.test(cls) && !glass) mat.alphaTest = true;
    // у _BCR в альфе шероховатость; _BC/_BCA (и Albedo частиц) её не несут
    mat.surface = pbr(/_bcr\.edds$/i.test(base!) ? img : null, 3, nmo, 'Enfusion BCR + NMO');
  } else mat.color = col(props.get('Color')) ?? (/Glass/.test(cls) ? [0.6, 0.7, 0.75] : undefined);
  return mat;
}

/** PBR Enfusion (схема metal/rough): шероховатость — альфа BCR (или MCR), металличность — B, AO — A карты NMO. */
function pbr(rough: DecodedImage | null, roughCh: 0 | 1 | 2 | 3, nmo: DecodedImage | null, source: string): SurfaceInfo | undefined {
  if (!rough && !nmo) return undefined;
  const s: SurfaceInfo = { source };
  if (rough) s.roughness = { map: `#enf:${rough.name ?? 'bcr'}`, channel: roughCh, image: rough };
  if (nmo) { s.metallic = { map: `#enf:${nmo.name ?? 'nmo'}`, channel: 2, image: nmo }; s.ao = { map: `#enf:${nmo.name ?? 'nmo'}`, channel: 3, image: nmo }; }
  else s.metallicFactor = 0;
  return s;
}

/** NMO (X, Y, металл, AO) → карта нормалей RGB (Z восстановлен). */
function nmoToNormal(img: DecodedImage): DecodedImage {
  const s = img.rgba!, out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 4) {
    const x = s[i]! / 127.5 - 1, y = s[i + 1]! / 127.5 - 1;
    out[i] = s[i]!; out[i + 1] = s[i + 1]!; out[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255); out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, rgba: out, name: img.name };
}

/** Слои MatPBRMulti → одна текстура в глобальной развёртке: цвет слоя (Color_N × средний тон BCR_N), смешанный по маске, × MCR. */
async function bakeMulti(props: Map<string, string>, ctx: LoadContext, nmo: DecodedImage | null): Promise<{ image: DecodedImage; surface: DecodedImage; path: string } | null> {
  const layers: Array<{ c: number[]; r: number; m: number } | null> = [];
  for (let k = 1; k <= 4; k++) {
    if (k > 1 && props.get(`Enabled_${k}`) === '0') { layers.push(null); continue; }
    const c = col(props.get(`Color_${k}`)), bcr = await loadTexture(props.get(`BCR_${k}`), ctx, 64);
    if (!c && !bcr) { layers.push(null); continue; }
    let tone = [0.5, 0.5, 0.5], rough = 0.6;
    if (bcr?.rgba) { const a = [0, 0, 0, 0]; const n = bcr.width * bcr.height; for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) a[j]! += bcr.rgba[i * 4 + j]!; tone = a.slice(0, 3).map((v) => v / n / 255); rough = a[3]! / n / 255; }
    // Color_N — множитель к тайловой текстуре (в линейном пространстве около 0,05–0,2): нормируем к тону 0,5
    const cc = c ? c.map((v, j) => Math.min(1, (v * tone[j]!) / 0.5)) : tone;
    // Roughness_N / Metalness_N — множитель к альфе BCR_N и металличность слоя
    const rk = Number(props.get(`Roughness_${k}`) ?? 1), mk = Number(props.get(`Metalness_${k}`) ?? 0);
    layers.push({ c: cc, r: Math.min(1, Math.max(0.02, rough * (Number.isFinite(rk) ? rk : 1))), m: Math.min(1, Math.max(0, Number.isFinite(mk) ? mk : 0)) });
  }
  const maskRef = props.get('MaskMap'), mcrRef = props.get('GlobalMCRMap') ?? props.get('GlobalMCMap');
  const bs = enfTextures.lite ? 128 : 1024, mask = await loadTexture(maskRef, ctx, bs), mcr = await loadTexture(mcrRef, ctx, bs);
  const base = layers[0] ?? layers.find((l) => l) ?? null;
  if (!base) return null;
  const ref = mcr ?? mask;
  if (!ref) return null;
  const w = ref.width, h = ref.height, out = new Uint8Array(w * h * 4), surf = new Uint8Array(w * h * 4);
  const sample = (img: DecodedImage | null, x: number, y: number, ch: number) => {
    if (!img?.rgba) return -1;
    const sx = Math.min(img.width - 1, (x * img.width / w) | 0), sy = Math.min(img.height - 1, (y * img.height / h) | 0);
    return img.rgba[(sy * img.width + sx) * 4 + ch]! / 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = base.c.slice(), r = base.r, mt = base.m;
    for (let k = 1; k < 4; k++) {
      const l = layers[k];
      if (!l) continue;
      const m = sample(mask, x, y, k - 1);
      if (m > 0) { c = c.map((v, j) => v + (l.c[j]! - v) * m); r += (l.r - r) * m; mt += (l.m - mt) * m; }
    }
    // GlobalMCRMap: RGB — общий цвет-множитель (0,5 — нейтрально), A — шероховатость
    const o = (y * w + x) * 4;
    for (let j = 0; j < 3; j++) { const f = mcr ? Math.min(1.6, sample(mcr, x, y, j) * 2) : 1; out[o + j] = Math.min(255, c[j]! * f * 255); }
    out[o + 3] = 255;
    // шероховатость слоёв × альфа MCR (0,5 — нейтрально); AO — альфа общей NMO
    const mr = mcr ? sample(mcr, x, y, 3) : 0.5;
    surf[o] = nmo ? Math.round(Math.max(0, sample(nmo, x, y, 3)) * 255) : 255;
    surf[o + 1] = Math.round(Math.min(1, r * Math.min(2, mr * 2)) * 255);
    surf[o + 2] = Math.round(mt * 255);
    surf[o + 3] = 128;
  }
  const path = enfusionPath(mcrRef ?? maskRef ?? '');
  return { image: { width: w, height: h, rgba: out, name: path }, surface: { width: w, height: h, rgba: surf, name: path + ':surface' }, path };
}
