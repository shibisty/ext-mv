// PBR-поверхность: карты шероховатости/металличности/AO/блика сводятся в одну текстуру для шейдера:
// R — AO, G — шероховатость, B — металличность, A — сила блика неметалла (128 ≈ F0 0.04).
import { baseName } from './binary';
import type { ChannelRef, DecodedImage, SurfaceInfo } from './types';

/** Упакованные карты по имени диффузной (если материал их не указал): ORM/RMA/MRA и отдельные _roughness/_metallic/_ao. */
export function surfaceCandidates(diffuse: string): SurfaceInfo[] {
  if (!diffuse) return [];
  const p = diffuse.replace(/\\/g, '/'), dir = p.slice(0, p.lastIndexOf('/') + 1);
  const stem = baseName(p).replace(/\.(dds|tga|png|jpe?g|paa|pac|pct|vtf|bmp|pcx|gif|webp|wal)$/i, '').toLowerCase().replace(/_(d|diff|diffuse|albedo|basecolor|base_color|color|col|c|co|b\.color)$/, '');
  const at = (s: string) => dir + stem + s;
  const ch = (map: string, channel: ChannelRef['channel']): ChannelRef => ({ map, channel });
  return [
    { ao: ch(at('_orm'), 0), roughness: ch(at('_orm'), 1), metallic: ch(at('_orm'), 2), source: '_orm' }, // glTF / UE
    { roughness: ch(at('_rma'), 0), metallic: ch(at('_rma'), 1), ao: ch(at('_rma'), 2), source: '_rma' },
    { metallic: ch(at('_mra'), 0), roughness: ch(at('_mra'), 1), ao: ch(at('_mra'), 2), source: '_mra' },
    { roughness: ch(at('_roughness'), 0), metallic: ch(at('_metallic'), 0), ao: ch(at('_ao'), 0), source: '_roughness' },
    { roughness: ch(at('_rough'), 0), metallic: ch(at('_metal'), 0), source: '_rough' },
    { specular: ch(at('_smdi'), 1), gloss: ch(at('_smdi'), 2), source: 'Arma _smdi' },
  ];
}

const KEYS = ['ao', 'roughness', 'gloss', 'metallic', 'specular'] as const;

/** Все ссылки на карты поверхности (уникальные пути). */
export function surfaceMaps(s: SurfaceInfo): string[] {
  return [...new Set(KEYS.map((k) => s[k]?.map).filter((m): m is string => !!m && !m.startsWith('#')))];
}

/**
 * Свести карты в одну RGBA (AO, шероховатость, металличность, блик). images — декодированные карты по пути.
 * Размер — наибольший из карт; меньшие масштабируются ближайшим соседом. Нет ни одной карты — 1×1 из множителей.
 */
export function composeSurface(s: SurfaceInfo, images: Map<string, DecodedImage>): DecodedImage {
  let w = 1, h = 1;
  for (const img of images.values()) if (img.width * img.height > w * h) { w = img.width; h = img.height; }
  const out = new Uint8Array(w * h * 4);
  const rf = Math.round(255 * Math.min(1, Math.max(0, s.roughnessFactor ?? 1))), mf = Math.round(255 * Math.min(1, Math.max(0, s.metallicFactor ?? 1)));
  const sample = (ref: ChannelRef | undefined, x: number, y: number): number | null => {
    const img = ref ? (ref.image ?? images.get(ref.map)) : undefined;
    if (!ref || !img?.rgba) return null;
    const sx = Math.min(img.width - 1, ((x * img.width) / w) | 0), sy = Math.min(img.height - 1, ((y * img.height) / h) | 0);
    return img.rgba[(sy * img.width + sx) * 4 + ref.channel]!;
  };
  const hasRough = !!(s.roughness || s.gloss), hasMetal = !!s.metallic;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const ao = sample(s.ao, x, y), r = sample(s.roughness, x, y), g = sample(s.gloss, x, y), m = sample(s.metallic, x, y), sp = sample(s.specular, x, y);
      out[o] = ao ?? 255;
      // множитель glTF умножает карту; без карты — сам множитель (по умолчанию «средняя» шероховатость 0.6)
      out[o + 1] = r !== null ? (r * rf) / 255 : g !== null ? 255 - g : hasRough ? rf : s.roughnessFactor !== undefined ? rf : 153;
      out[o + 2] = m !== null ? (m * mf) / 255 : hasMetal ? mf : s.metallicFactor !== undefined ? mf : 0;
      out[o + 3] = sp ?? (s.specularFactor !== undefined ? Math.round(255 * Math.min(1, Math.max(0, s.specularFactor))) : 128);
    }
  return { width: w, height: h, rgba: out };
}
