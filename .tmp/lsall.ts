import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { parseLtarIndex } from '../packages/gmv/src/engines/lithtech/ltar';
const re = new RegExp(process.argv[2]!);
for (const p of process.argv.slice(3)) { try { const b = await openAsBlob(p); const u = new Uint8Array(await b.slice(0, Math.min(b.size, 64 << 20)).arrayBuffer()); for (const f of parseLtarIndex(u).files) if (re.test(f.path)) console.log(basename(p), f.path, f.size); } catch { /* */ } }
