// Текстуры и материалы Unreal Engine 2: UTexture (мипы DXT1/3/5, RGBA8, P8 с палитрой, L8, G16) и цепочки материалов
// (Shader, FinalBlend, Combiner, модификаторы Tex*) — до базовой текстуры, которую можно показать.
import { decodeDXT } from '../../core/images/dds';
import { propNum, propObj, readProps, type UExport, type UPackage, type UProp, type UReader } from './ue2pkg';

/** ETextureFormat UE2. */
export const TEXF = { P8: 0, RGBA7: 1, RGB16: 2, DXT1: 3, RGB8: 4, RGBA8: 5, NODATA: 6, DXT3: 7, DXT5: 8, L8: 9, G16: 10, RRRGGGBBB: 11 } as const;

export const TEXTURE_CLASSES = new Set(['Texture', 'Cubemap', 'ScriptedTexture', 'Shader', 'FinalBlend', 'Combiner', 'TexPanner', 'TexScaler', 'TexRotator', 'TexOscillator',
  'TexEnvMap', 'TexCoordSource', 'TexMatrix', 'TexModifier', 'VariableTexPanner', 'MaterialSwitch', 'MaterialSequence', 'ColorModifier', 'OpacityModifier', 'ConstantColor', 'FadeColor', 'ParticleMaterial']);

/** Свойства материалов, по которым идём к базовой текстуре (в порядке приоритета). */
const CHAIN: Record<string, string[]> = {
  Shader: ['Diffuse', 'SelfIllumination', 'Specular', 'Opacity'],
  FinalBlend: ['Material'],
  Combiner: ['Material1', 'Material2', 'Mask'],
  MaterialSwitch: ['Materials[0]', 'Materials', 'Current'],
  MaterialSequence: ['SequenceItems'],
  ColorModifier: ['Material'],
  OpacityModifier: ['Material'],
  ParticleMaterial: ['BitmapMaterial'],
};
const MODIFIER = ['Material'];

/** Ссылка на объект: пакет и номер (для импорта — в другом пакете). */
export type ObjResolver = (pkg: UPackage, ref: number) => Promise<{ pkg: UPackage; exp: UExport } | null>;

export interface UeTextureInfo { pkg: UPackage; exp: UExport; alpha: 'none' | 'test' | 'blend'; twoSided: boolean }

/** Базовая текстура материала (с признаками прозрачности по пути: FinalBlend/Shader с Opacity, маскированная текстура). */
export async function resolveMaterial(pkg: UPackage, ref: number, resolve: ObjResolver, depth = 0, acc: { alpha: UeTextureInfo['alpha']; twoSided: boolean } = { alpha: 'none', twoSided: false }): Promise<UeTextureInfo | null> {
  if (!ref || depth > 12) return null;
  const hit = await resolve(pkg, ref);
  if (!hit) return null;
  const { pkg: p, exp: e } = hit;
  if (e.className === 'Texture' || e.className === 'Cubemap') {
    const props = readProps(p, await p.reader(e));
    if (acc.alpha === 'none' && (props.get('bMasked')?.value === true || props.get('bAlphaTexture')?.value === true)) acc.alpha = 'test';
    return { pkg: p, exp: e, ...acc };
  }
  const props = readProps(p, await p.reader(e));
  if (props.get('TwoSided')?.value === true) acc.twoSided = true;
  if (e.className === 'FinalBlend') { const fb = propNum(props, 'FrameBufferBlending'); if (fb === 2 || fb === 3) acc.alpha = acc.alpha === 'none' ? 'blend' : acc.alpha; if (props.get('AlphaTest')?.value === true) acc.alpha = 'test'; }
  if (e.className === 'Shader' && propObj(props, 'Opacity')) acc.alpha = acc.alpha === 'none' ? 'test' : acc.alpha;
  let chain = CHAIN[e.className] ?? MODIFIER;
  if (e.className === 'Combiner') {
    const op = propNum(props, 'CombineOperation');
    chain = op === 0 ? ['Material1', 'Material2'] : op === 7 ? ['Mask', 'Material2', 'Material1'] : ['Material2', 'Material1'];
    // карта окружения — не основа
    const m2 = propObj(props, 'Material2');
    if (op >= 2 && op <= 6 && m2 && /TexEnvMap/.test(p.objClass(m2))) chain = ['Material1', 'Material2'];
  }
  for (const k of chain) {
    const r = propObj(props, k);
    if (!r) continue;
    const t = await resolveMaterial(p, r, resolve, depth + 1, acc);
    if (t) return t;
  }
  return null;
}

/** Мип 0 текстуры в RGBA. */
/** Мип 0 как есть: формат, размеры, данные (для карт высот G16 и масок). */
export async function readUeTextureMip(pkg: UPackage, e: UExport): Promise<{ fmt: number; w: number; h: number; data: Uint8Array; props: Map<string, UProp> }> {
  const r = await pkg.reader(e), props = readProps(pkg, r), fmt = propNum(props, 'Format');
  if (pkg.ver >= 123 && pkg.lic >= 16) r.i32(); // Lineage II: поле после свойств у всех материалов
  const m = readMips(r);
  if (!m) throw new Error(`${e.name}: у текстуры нет мипов`);
  return { fmt, ...m, props };
}

export async function decodeUeTexture(pkg: UPackage, e: UExport, resolve: ObjResolver): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const { fmt, props, ...m } = await readUeTextureMip(pkg, e);
  const { w, h, data } = m, n = w * h, out = new Uint8Array(n * 4);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (fmt) {
    case TEXF.DXT1: case TEXF.DXT3: case TEXF.DXT5: {
      const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2), need = bw * bh * (fmt === TEXF.DXT1 ? 8 : 16);
      if (data.length < need) throw new Error(`${e.name}: данные DXT обрезаны`);
      return { width: w, height: h, rgba: decodeDXT(dv, 0, w, h, fmt === TEXF.DXT1 ? 1 : fmt === TEXF.DXT3 ? 3 : 5) };
    }
    case TEXF.RGBA8: case TEXF.RGB8: {
      const bpp = fmt === TEXF.RGBA8 ? 4 : 3;
      for (let i = 0; i < n && i * bpp + bpp <= data.length; i++) { out[i * 4] = data[i * bpp + 2]!; out[i * 4 + 1] = data[i * bpp + 1]!; out[i * 4 + 2] = data[i * bpp]!; out[i * 4 + 3] = bpp === 4 ? data[i * bpp + 3]! : 255; }
      break;
    }
    case TEXF.L8: for (let i = 0; i < n && i < data.length; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i]!; out[i * 4 + 3] = 255; } break;
    case TEXF.G16: for (let i = 0; i < n && i * 2 + 1 < data.length; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i * 2 + 1]!; out[i * 4 + 3] = 255; } break;
    case TEXF.P8: {
      const pal = await readPalette(pkg, propObj(props, 'Palette'), resolve);
      const masked = props.get('bMasked')?.value === true;
      for (let i = 0; i < n && i < data.length; i++) {
        const c = data[i]!, o = c * 4;
        out[i * 4] = pal[o] ?? c; out[i * 4 + 1] = pal[o + 1] ?? c; out[i * 4 + 2] = pal[o + 2] ?? c; out[i * 4 + 3] = masked && c === 0 ? 0 : pal.length ? pal[o + 3] || 255 : 255;
      }
      break;
    }
    default: throw new Error(`${e.name}: формат текстуры ${fmt} не поддерживается`);
  }
  return { width: w, height: h, rgba: out };
}

/** FMipmap: ленивый массив (смещение конца, compact-длина, данные), USize, VSize, UBits, VBits. Первый непустой мип. */
function readMips(r: UReader): { w: number; h: number; data: Uint8Array } | null {
  const n = r.idx();
  for (let i = 0; i < n && i < 16; i++) {
    if (r.ver >= 63) r.i32();
    const len = r.idx(), data = r.bytes(len), w = r.i32(), h = r.i32();
    r.u8v(); r.u8v();
    if (len > 0 && w > 0 && h > 0) return { w, h, data };
  }
  return null;
}

/** UPalette: свойства, затем TArray<FColor> (R, G, B, A). */
async function readPalette(pkg: UPackage, ref: number, resolve: ObjResolver): Promise<Uint8Array> {
  const hit = ref ? await resolve(pkg, ref) : null;
  if (!hit) return new Uint8Array(0);
  const r = await hit.pkg.reader(hit.exp);
  readProps(hit.pkg, r);
  const n = r.idx();
  return r.bytes(Math.max(0, Math.min(256, n)) * 4).slice();
}

export const isTextureProps = (p: Map<string, UProp>): boolean => p.has('Format') && p.has('USize');
