// Малый набор файлов Metro 2033 для проверки в браузере: загружает уровень (или модель) из content.vfi, записывает все
// прочитанные при этом файлы (и *_bump текстур) в новый subset.vfi + subset.vfs0 (без сжатия). Только для локальной отладки.
//   npx tsx tools/metro-subset.ts <папка Metro 2033> <путь в архиве, напр. maps/000/level> <папка вывода> [ещё пути…]
import { openAsBlob, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRegistry, ViewerSession } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
import { makeVfi } from '../packages/gmv/test/helpers/metro';

const [dir, ...rest] = process.argv.slice(2), out = rest.pop()!, targets = rest;
const s = new ViewerSession(createRegistry(allEngines), 'metro2033');
await s.addArchives(await Promise.all(['content.vfi', 'content.vfs0', 'textures.vfs0', 'textures.vfs1'].map(async (n) => new File([await openAsBlob(join(dir!, n))], n))));
const a = s.archives[0]!, used = new Map<string, Uint8Array>(), read0 = a.read.bind(a);
(a as { read: typeof a.read }).read = async (e) => { const u = await read0(e); used.set(e.path, u); return u; };
for (const t of targets) {
  // «+путь» — просто добавить файл (например, анимацию)
  if (t.startsWith('+')) { const e = a.lookup(t.slice(1)); if (e) used.set(e.path, await read0(e)); else console.log('нет', t); continue; }
  used.set(t, await read0(a.lookup(t)!));
  const m = await s.loadModel([a.fileOf(a.lookup(t)!)]);
  console.log(t, m?.info.join(' | '));
  if (m) for (let i = 0; i < m.meshes.length; i++) { await s.resolveTexture(i); await s.resolveNormal(i); await s.resolveSurface(i); }
}
// полные куски текстур (1024/2048) тоже, чтобы экспорт мог собрать DDS — не нужно для просмотра
const files = [...used].map(([p, data]) => ({ path: 'content\\' + p.replace(/\//g, '\\'), data }));
const { vfi, vfs } = makeVfi(files);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'content.vfi'), vfi);
writeFileSync(join(out, 'data.vfs0'), vfs);
console.log('files', files.length, 'MB', (vfs.length / 1048576).toFixed(1));
