import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseWldClient } from '../packages/gmv/src/engines/lithtech/world';
import { parseMesh } from '../packages/gmv/src/engines/lithtech/model';
const root = process.argv[2]!;
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.wldclnt') ? [p] : []; });
for (const f of walk(root)) {
  const u = readFileSync(f); const c = parseWldClient(u); const dv = new DataView(u.buffer, u.byteOffset);
  const counts = c.regions.map((r) => { try { const p = join(root, '..', r.mesh.replace(/\\/g, '/').replace(/^worlds\//i, 'worlds/')); return parseMesh(readFileSync(p.replace(/(worlds\/.*)/i, (m) => m))).sections.length; } catch (e) { return -1; } });
  const st = c.staticSections; const mx = st ? Math.max(...st) : -1;
  console.log(f.split('/').slice(-1)[0], 'hdr', [8, 12, 16, 20].map((o) => dv.getUint32(o, true)).join(','), 'inst', c.instances.length, 'static', st?.size, 'max', mx, 'secs', counts.join('+'), '=', counts.reduce((a, b) => a + b, 0));
}
