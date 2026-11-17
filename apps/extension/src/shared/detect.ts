// Автоопределение: какими играми/форматами можно прочитать файл и какой выбрать, если пользователь не выбрал сам.
import { extOf } from '@gmvjs/core/binary';
import type { BlobFile, GamePreset, Registry, VFile } from '@gmvjs/core';

/** Файл, похожий на модель (не архив, не картинка, не отдельная анимация); без расширения — тоже (форматы по сигнатуре). */
export function isModelLike(registry: Registry, name: string): boolean {
  const ext = extOf(name);
  if (!ext) return true;
  if (registry.isArchive(name) || registry.isImage(name) || registry.motionOnlyExtensions.includes(ext)) return false;
  return registry.modelExtensions.includes(ext);
}

/** Игры и форматы, которыми читается файл: лучшие по сигнатуре первыми, без учёта текущего выбора. */
export async function readOptions(registry: Registry, file: VFile | BlobFile, limit = 6): Promise<GamePreset[]> {
  const d = await registry.detect(file, []);
  if (!d) return [];
  const ext = extOf(file.name), out: GamePreset[] = [];
  for (const c of d.candidates) {
    for (const g of registry.games) {
      if (out.length >= limit) return out;
      if (g.formats.includes(c.format.id) && (!ext || registry.presetExtensions(g).includes(ext)) && !out.includes(g)) out.push(g);
    }
  }
  return out;
}

/** Лучшая игра для набора файлов: по самому уверенному определению среди файлов-моделей. */
export async function bestPreset(registry: Registry, files: ReadonlyArray<VFile | BlobFile>): Promise<GamePreset | null> {
  let best: { name: string; id: string; confidence: number } | null = null;
  for (const f of files) {
    if (!isModelLike(registry, f.name)) continue;
    const d = await registry.detect(f, []);
    if (d && (!best || d.confidence > best.confidence)) best = { name: f.name, id: d.format.id, confidence: d.confidence };
  }
  return best ? registry.presetForFormat(best.id, best.name) ?? null : null;
}
