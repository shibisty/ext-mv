// Параметры текстуры X-Ray (.thm рядом с .dds в gamedata/textures): нужны SDK и компилятору xrLC.
// Чанки: 0x810 версия, 0x813 тип (картинка), 0x812 формат/флаги/размер, 0x814 вид (обычная, бамп, ландшафт),
// 0x815 детальная текстура, 0x816 материал, 0x817 бамп, 0x818 внешняя карта нормалей, 0x819 задержка затухания.
export const THM_FLAG = { MIPMAPS: 1, DITHER: 1 << 8, DIFFUSE_DETAIL: 1 << 23, IMPLICIT_LIGHTED: 1 << 24, HAS_ALPHA: 1 << 25, BUMP_DETAIL: 1 << 26 } as const;
/** Форматы сжатия, которыми SDK пересохраняет текстуру: DXT1, DXT1 с альфой, DXT3, DXT5, без сжатия. */
export const THM_FMT = { DXT1: 0, ADXT1: 1, DXT3: 2, DXT5: 3, RGBA: 6 } as const;

export interface ThmIn { width: number; height: number; alpha?: boolean; format?: number; detail?: string; detailScale?: number; bump?: string }

export function writeThm(t: ThmIn): Uint8Array {
  const parts: number[] = [];
  const u8 = (v: number) => parts.push(v & 0xff);
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => { u16(v & 0xffff); u16((v >>> 16) & 0xffff); };
  const f32 = (v: number) => { const b = new Uint8Array(new Float32Array([v]).buffer); for (const x of b) u8(x); };
  const sz = (s: string) => { for (let i = 0; i < s.length; i++) u8(s.charCodeAt(i)); u8(0); };
  const chunk = (id: number, body: () => void) => { u32(id); const at = parts.length; u32(0); body(); const n = parts.length - at - 4; parts[at] = n & 0xff; parts[at + 1] = (n >> 8) & 0xff; parts[at + 2] = (n >> 16) & 0xff; parts[at + 3] = (n >>> 24) & 0xff; };
  const flags = THM_FLAG.MIPMAPS | (t.alpha ? THM_FLAG.HAS_ALPHA | THM_FLAG.DITHER : 0) | (t.detail ? THM_FLAG.DIFFUSE_DETAIL : 0);
  chunk(0x810, () => u16(0x12));
  chunk(0x813, () => u32(1));
  chunk(0x812, () => { u32(t.format ?? (t.alpha ? THM_FMT.DXT5 : THM_FMT.DXT1)); u32(flags); u32(0); u32(0); u32(0); u32(0); u32(t.width); u32(t.height); });
  chunk(0x814, () => u32(0));
  chunk(0x815, () => { sz(t.detail ?? ''); f32(t.detailScale ?? 1); });
  chunk(0x816, () => { u32(1); f32(0); });
  chunk(0x817, () => { f32(0.05); u32(t.bump ? 2 : 1); sz(t.bump ?? ''); });
  chunk(0x818, () => sz(''));
  chunk(0x819, () => u8(0));
  return Uint8Array.from(parts);
}
