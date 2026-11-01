// Режим разработки: vite build --watch в dist/dev-<браузер> с манифестом и assimpjs — папку можно сразу загрузить как распакованное расширение.
//   npm run dev            -> Chrome (dist/dev-chrome)
//   npm run dev -- firefox -> Firefox (dist/dev-firefox)
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { copyAssimp } from './assimp-lib.mjs';
import { buildManifest, TARGETS } from './manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = TARGETS.find((t) => process.argv.includes(t)) ?? 'chrome';
const out = join(root, 'dist', `dev-${target}`);
process.env.GMV_OUT_DIR = out;

const watcher = await build({ configFile: join(root, 'vite.config.ts'), mode: 'development', build: { watch: {} } });
watcher.on('event', (e) => {
  if (e.code !== 'END') return;
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(buildManifest(root, target), null, 2) + '\n');
  copyAssimp(join(out, 'lib'));
  console.log(`[${target}] готово: ${out} (перезагрузите расширение в браузере)`);
});
