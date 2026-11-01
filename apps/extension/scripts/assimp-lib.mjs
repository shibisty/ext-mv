// Копирование assimpjs (WASM) из node_modules в lib/ расширения с патчем под CSP MV3.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { patchAssimp } from './patch-assimp.mjs';

const FILES = ['assimpjs-all.js', 'assimpjs-all.wasm', 'assimpjs.js', 'assimpjs.wasm', 'license.assimp.txt', 'license.assimpjs.txt'];

export function copyAssimp(lib) {
  let pkgDir;
  try { pkgDir = dirname(createRequire(import.meta.url).resolve('assimpjs/package.json')); }
  catch { console.warn('assimpjs не установлен (npm i): форматы assimp будут недоступны, пока не положить файлы в lib/'); return 0; }
  mkdirSync(lib, { recursive: true });
  let copied = 0;
  for (const f of FILES) {
    const src = join(pkgDir, 'dist', f);
    if (!existsSync(src)) continue;
    if (f.endsWith('.js')) writeFileSync(join(lib, f), patchAssimp(readFileSync(src, 'utf8'))); // без eval для CSP MV3
    else cpSync(src, join(lib, f));
    copied++;
  }
  console.log(`assimpjs: скопировано файлов ${copied}`);
  return copied;
}
