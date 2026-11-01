// Манифест для браузера: manifests/base.json + manifests/<target>.json (глубокое слияние объектов).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TARGETS = ['chrome', 'firefox'];

export function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
}

export function buildManifest(root, target) {
  const read = (n) => JSON.parse(readFileSync(join(root, 'manifests', n), 'utf8'));
  return merge(read('base.json'), read(`${target}.json`));
}
