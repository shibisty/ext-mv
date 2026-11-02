import { openAsBlob, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { openLtar } from '../packages/gmv/src/engines/lithtech/ltar';
const [out, pat, ...arcs] = process.argv.slice(2); const re = new RegExp(pat!);
let n = 0;
for (const p of arcs) { let a; try { a = await openLtar(new File([await openAsBlob(p)], basename(p))); } catch { continue; }
  for (const e of a.entries) if (re.test(e.path)) { const fp = out + '/' + e.path; mkdirSync(fp.replace(/[^/]*$/, ''), { recursive: true }); writeFileSync(fp, await a.read(e)); n++; } }
console.log('dumped', n);
