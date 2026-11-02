import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { createRegistry, ViewerSession, type BlobFile } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
const [root, load, ...arcs] = process.argv.slice(2);
const s = new ViewerSession(createRegistry(allEngines), 'fear-online');
const lazy: BlobFile[] = []; const walk = async (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) await walk(p); else { const f = new File([await openAsBlob(p)], n); Object.defineProperty(f, 'webkitRelativePath', { value: relative(join(root!, '..'), p) }); lazy.push(f); } } };
await walk(root!); s.addFolder(lazy);
await s.addArchives(await Promise.all(arcs.map(async (p) => new File([await openAsBlob(p)], basename(p)))));
global.gc?.(); const m0 = process.memoryUsage();
const a = s.archives[0]!; const t0 = Date.now();
const m = (await s.loadModel([a.fileOf(a.entries.find((e) => e.path.endsWith(load!))!)]))!;
const t1 = Date.now(); global.gc?.(); const m1 = process.memoryUsage();
let bytes = 0, verts = 0, tris = 0; for (const x of m.meshes) { bytes += x.pos.byteLength + x.nor.byteLength + x.uv.byteLength + x.bone.byteLength + x.weight.byteLength + x.indices.byteLength; verts += x.vertexCount; tris += x.indices.length / 3; }
let pb = 0; for (const p of m.instances?.protos ?? []) for (const q of p.parts) pb += q.pos.byteLength + q.nor.byteLength + q.uv.byteLength + q.indices.byteLength;
console.log(load, 'ms', t1 - t0, 'meshes', m.meshes.length, 'verts', verts, 'tris', tris, 'meshMB', (bytes / 1e6).toFixed(0), 'protoMB', (pb / 1e6).toFixed(0), 'placements', m.instances?.placements.length, 'heapΔMB', ((m1.heapUsed - m0.heapUsed) / 1e6).toFixed(0), 'arrayBuffersΔMB', ((m1.arrayBuffers - m0.arrayBuffers) / 1e6).toFixed(0));
