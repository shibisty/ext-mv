import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { parseLtarIndex } from '../packages/gmv/src/engines/lithtech/ltar';
for (const p of process.argv.slice(2)) { const u = new Uint8Array(await (await openAsBlob(p)).slice(0, 4 << 20).arrayBuffer()); try { console.log(parseLtarIndex(u).files.filter((f) => f.path.endsWith('.mdl')).map((f) => f.path).join('\n')); } catch (e) { console.log(p, (e as Error).message); } }
