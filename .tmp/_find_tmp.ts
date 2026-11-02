import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { openLtar } from '../packages/gmv/src/engines/lithtech/ltar';
import { parseMdl } from '../packages/gmv/src/engines/lithtech/model';
const target = process.argv[2]!; const arcs = [];
for (const p of process.argv.slice(3)) { try { arcs.push(await openLtar(new File([await openAsBlob(p)], basename(p)))); } catch { /* */ } }
let tn: Set<string> | null = null;
for (const a of arcs) { const e = a.lookup(target); if (e) tn = new Set(parseMdl(await a.read(e)).nodes.map((n) => n.name.toLowerCase())); }
console.log('target nodes', tn?.size);
for (const a of arcs) for (const e of a.entries) {
  if (!e.path.endsWith('.mdl')) continue;
  try { const m = parseMdl(await a.read(e)); if (m.meshPath || !m.anims.length) continue; const hit = m.nodes.filter((n) => tn!.has(n.name.toLowerCase())).length; if (hit > tn!.size * 0.6) console.log(e.path, m.nodes.length, hit, m.anims.length); } catch { /* */ }
}
