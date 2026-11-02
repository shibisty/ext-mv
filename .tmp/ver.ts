import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { openLtar } from '../packages/gmv/src/engines/lithtech/ltar';
const c = new Map<string, string[]>();
for (const p of process.argv.slice(2)) { let a; try { a = await openLtar(new File([await openAsBlob(p)], basename(p))); } catch { continue; }
  for (const e of a.entries) { if (!/\.(mdl|inst)$/.test(e.path)) continue; const u = await a.read(e); const k = e.path.split('.').pop() + ':' + String.fromCharCode(...u.subarray(0, 4)) + ' v' + (u.length >= 8 ? new DataView(u.buffer, u.byteOffset, u.byteLength).getUint32(4, true) : 'short' + u.length); (c.get(k) ?? c.set(k, []).get(k)!).push(e.path); } }
for (const [k, v] of c) console.log(k, v.length, v.slice(0, 6).join(' '));
