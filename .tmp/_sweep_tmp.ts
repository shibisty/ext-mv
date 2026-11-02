import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { createRegistry, ViewerSession } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
await s.addArchives(await Promise.all(process.argv.slice(2).map(async (p) => new File([await openAsBlob(p)], basename(p)))));
let ok = 0, anim = 0, fail = 0, nan = 0; const bad: string[] = [];
for (const a of s.archives) for (const e of a.entries) {
  if (!e.path.endsWith('.mdl')) continue;
  const m = await s.loadModel([a.fileOf(e)]);
  if (!m) { if (!/набор анимаций/.test(s.lastFailure?.error ?? '')) { fail++; bad.push(e.path + ': ' + s.lastFailure?.error); } continue; }
  ok++;
  if (s.motions.length && m.skeleton) {
    anim++;
    for (const mo of s.motions.slice(0, 5)) { m.skeleton.pose(mo, mo.duration / 2, true); if (m.skeleton.skin.some((x) => !Number.isFinite(x))) { nan++; bad.push(e.path + ' NaN ' + mo.name); break; } }
  }
}
console.log({ ok, anim, fail, nan }); console.log(bad.slice(0, 15).join('\n'));
