import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseMdl } from '../packages/gmv/src/engines/lithtech/model';
import { trackOrderFor } from '../packages/gmv/src/engines/lithtech/anim';
const [model, dir] = process.argv.slice(2);
const m = parseMdl(readFileSync(model!));
console.log('model nodes', m.nodes.length, 'anims', m.anims.length, 'lod', m.lod0);
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.mdl') ? [p] : []; });
let total = 0;
for (const f of walk(dir!)) { try { const s = parseMdl(readFileSync(f)); const r = trackOrderFor(s.nodes, m.nodes); total += s.anims.length; console.log(f.slice(dir!.length), 'nodes', s.nodes.length, 'match', r.matched, 'anims', s.anims.length, s.meshPath ? 'MESH' : ''); } catch (e) { console.log(f, (e as Error).message); } }
console.log('total anims', total);
