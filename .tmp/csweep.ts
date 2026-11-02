import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { createRegistry, ViewerSession } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
await s.addArchives(await Promise.all(process.argv.slice(2).map(async (p) => new File([await openAsBlob(p)], basename(p)))));
let n = 0, withSets = 0, fail = 0, nan = 0, t0 = Date.now(); const ex: string[] = [];
for (const a of s.archives) for (const e of a.entries) {
  if (!e.path.endsWith('.mdl') || !/^char\/ai\/[^/]+\/[^/]+\.mdl$/.test(e.path)) continue;
  const m = await s.loadModel([a.fileOf(e)]); if (!m) { fail++; continue; } n++;
  const lazy = s.motions.filter((x) => x.load); if (lazy.length) withSets++;
  if (lazy.length && m.skeleton) { let mo; try { mo = await lazy[Math.floor(lazy.length / 2)]!.load!(); } catch (er) { ex.push("LOADFAIL " + e.path + " " + (er as Error).message); continue; } m.skeleton.pose(mo, mo.duration / 2, true); if (m.skeleton.skin.some((x) => !Number.isFinite(x))) nan++; }
  if (ex.length < 12) ex.push(`${e.path}: ${s.motions.length} (${[...new Set(lazy.map((x) => x.source))].length} наборов)`);
}
console.log({ n, withSets, fail, nan, ms: Date.now() - t0 }); console.log(ex.join('\n'));
