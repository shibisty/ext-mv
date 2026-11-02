import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { createRegistry, ViewerSession, type BlobFile } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
import { boundsOf } from '../packages/gmv/src/core/geometry';
import { renderPPM } from '../tools/render-ppm';
const [root, load, out, which] = process.argv.slice(2);
const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
const lazy: BlobFile[] = []; const walk = async (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) await walk(p); else { const f = new File([await openAsBlob(p)], n); Object.defineProperty(f, 'webkitRelativePath', { value: relative(join(root!, '..'), p) }); lazy.push(f); } } };
await walk(root!); s.addFolder(lazy);
const a = s.archives[0]!; const m = (await s.loadModel([a.fileOf(a.entries.find((e) => e.path.endsWith(load!))!)]))!;
const keep = m.meshes.filter((x) => (which === 'wm') === !!x.defaultHidden);
let far = 0, tot = 0; for (const x of keep) { const b = boundsOf([x]); tot++; if (Math.max(...b.min.map(Math.abs), ...b.max.map(Math.abs)) > 3000) far++; }
console.log('meshes', keep.length, 'far-from-origin', far, 'tris', keep.reduce((n, x) => n + x.indices.length / 3, 0), 'bounds', JSON.stringify(boundsOf(keep)));
renderPPM({ ...m, meshes: keep, bounds: boundsOf(keep), instances: undefined }, out!, { yaw: 0.6, pitch: 0.5 });
