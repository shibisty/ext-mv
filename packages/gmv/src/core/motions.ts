// Сочетание анимаций частей тела X-Ray (ноги + торс + голова).
import type { Motion, XrayMotion } from './types';

/** Часть «эффект»: анимация одной кости поверх остальных (esmFX). */
export const XRAY_FX_PART = 'эффект';

/**
 * Слои для анимации одной части тела (как в игре: ноги и торс играют разные анимации): для каждой другой части —
 * её анимация с наибольшим числом общих слов в имени («norm_torso_2_walk_0» → «norm_walk_fwd_0»), при равенстве — «idle»/«stand».
 */
export function autoLayers(main: XrayMotion, list: readonly Motion[]): XrayMotion[] {
  if (!main.part || main.part === XRAY_FX_PART) return [];
  const words = (n: string) => n.toLowerCase().split(/[_\s]+/).filter((w) => w && !/^\d+$/.test(w) && !['norm', 'torso', 'legs', 'head'].includes(w));
  const mw = new Set(words(main.name));
  const best = new Map<string, [XrayMotion, number]>();
  for (const x of list) {
    if (x.kind !== 'xray' || !x.part || x.part === main.part || x.part === XRAY_FX_PART || x.load) continue;
    const w = words(x.name);
    const score = w.filter((k) => mw.has(k)).length * 10 + (w.some((k) => k === 'idle' || k === 'stand') ? 2 : 0) - w.length * 0.1 - (x.name.endsWith('_') ? 1 : 0);
    const cur = best.get(x.part);
    if (!cur || score > cur[1]) best.set(x.part, [x, score]);
  }
  return [...best.values()].map(([x]) => x);
}
