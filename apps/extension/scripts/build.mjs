// Сборка расширения: Vite -> dist/.build, затем dist/chrome и dist/firefox со своими манифестами, проверка полноты и zip-архивы.
import { cpSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { buildManifest, TARGETS } from './manifest.mjs';
import { copyAssimp } from './assimp-lib.mjs';
import { listFiles, zipDir } from './zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist'), stage = join(dist, '.build');
const mode = process.argv.includes('--dev') ? 'development' : 'production';

// 1. Vite
process.env.GMV_OUT_DIR = stage;
await build({ configFile: join(root, 'vite.config.ts'), mode, logLevel: 'warn' });

// 2. assimpjs (WASM) — мост для glTF/FBX/OBJ/DAE…
copyAssimp(join(stage, 'lib'));

// 3. цели + проверка полноты копирования (fs.cpSync на некоторых машинах молча пропускал файлы)
const stageFiles = listFiles(stage).map((f) => relative(stage, f));
for (const t of TARGETS) {
  const out = join(dist, t);
  rmSync(out, { recursive: true, force: true });
  cpSync(stage, out, { recursive: true });
  const manifest = buildManifest(root, t);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const missing = stageFiles.filter((f) => !existsSync(join(out, f)) || statSync(join(out, f)).size !== statSync(join(stage, f)).size);
  const refs = [manifest.background?.service_worker, ...(manifest.background?.scripts ?? []), ...Object.values(manifest.icons ?? {}), 'viewer.html'].filter(Boolean);
  const badRefs = refs.filter((r) => !existsSync(join(out, r)));
  if (missing.length || badRefs.length) {
    console.error(`[${t}] неполная сборка:`, { missing, badRefs });
    process.exit(1);
  }
  const z = zipDir(out, join(dist, `gmv-${t}-${manifest.version}.zip`));
  console.log(`[${t}] файлов ${stageFiles.length + 1}, zip ${(z.bytes / 1024).toFixed(0)} КБ -> dist/gmv-${t}-${manifest.version}.zip`);
}
