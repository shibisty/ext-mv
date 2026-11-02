import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { parseLtarIndex } from '../packages/gmv/src/engines/lithtech/ltar';
const tot = new Map<string, [number, number, string]>();
for (const p of process.argv.slice(2)) {
  try {
    const b = await openAsBlob(p);
    const u = new Uint8Array(await b.slice(0, Math.min(b.size, 64 << 20)).arrayBuffer());
    for (const f of parseLtarIndex(u).files) { const e = f.path.split('.').pop()!; const t = tot.get(e) ?? [0, 0, f.path]; t[0]++; t[1] += f.size; tot.set(e, t); }
  } catch (e) { console.log('skip', basename(p), (e as Error).message.slice(0, 60)); }
}
for (const [e, [n, s, ex]] of [...tot].sort((a, b) => b[1][1] - a[1][1])) console.log(e.padEnd(10), n, (s / 1e6).toFixed(0) + 'MB', ex);
