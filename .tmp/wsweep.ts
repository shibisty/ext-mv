import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { createRegistry, ViewerSession, type BlobFile } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
const args = process.argv.slice(2); const s = new ViewerSession(createRegistry(allEngines), 'fear-online'); const arcs: File[] = [];
for (const root of args) {
  if (statSync(root).isDirectory()) { const lazy: BlobFile[] = []; const walk = async (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) await walk(p); else { const f = new File([await openAsBlob(p)], n); Object.defineProperty(f, 'webkitRelativePath', { value: relative(join(root, '..'), p) }); lazy.push(f); } } }; await walk(root); s.addFolder(lazy); }
  else arcs.push(new File([await openAsBlob(root)], basename(root)));
}
await s.addArchives(arcs);
for (const a of s.archives) for (const e of a.entries) {
  if (!e.path.endsWith('.wld')) continue;
  const t0 = Date.now(); const m = await s.loadModel([a.fileOf(e)]);
  if (!m) { console.log('FAIL', e.path, s.lastFailure?.error); continue; }
  const tris = m.meshes.reduce((n, x) => n + x.indices.length / 3, 0);
  console.log(e.path, Date.now() - t0, 'ms', 'meshes', m.meshes.length, 'tris', tris, '|', m.info.slice(1).join(' | ').slice(0, 300));
}
