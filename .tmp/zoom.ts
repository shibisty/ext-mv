// уровень: вырезать куб вокруг точки и отрисовать с текстурами
import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { createRegistry, ViewerSession, type BlobFile } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
import { boundsOf } from '../packages/gmv/src/core/geometry';
import { renderPPM } from '../tools/render-ppm';
const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]!; args.splice(i, 2); return v; };
const instI = +opt('--i', '0'), load = opt('--load'), out = opt('--ppm'), at = opt('--at'), R = +opt('--r', '1500'), yaw = +opt('--yaw', '0.6'), pitch = +opt('--pitch', '0.4');
const s = new ViewerSession(createRegistry(allEngines), 'fear-online'); const arcs: File[] = [];
for (const root of args) {
  if (statSync(root).isDirectory()) { const files: BlobFile[] = []; const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(Object.defineProperty(new File([], n), 'webkitRelativePath', { value: relative(join(root, '..'), p) }) as unknown as BlobFile); } }; 
    // ленивые файлы
    const lazy: BlobFile[] = []; const walk2 = async (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) await walk2(p); else { const f = new File([await openAsBlob(p)], n); Object.defineProperty(f, 'webkitRelativePath', { value: relative(join(root, '..'), p) }); lazy.push(f); } } };
    await walk2(root); s.addFolder(lazy); void walk; void files;
  } else arcs.push(new File([await openAsBlob(root)], basename(root)));
}
await s.addArchives(arcs);
const hit = s.archives.flatMap((a) => a.entries.map((e) => [a, e] as const)).find(([, e]) => e.path.endsWith(load));
const m = (await s.loadModel([hit![0].fileOf(hit![1])]))!;
console.log(m.info.join('\n'));
let c: number[];
if (at === 'inst') { const p = m.instances!.placements[instI]!; c = [p.pose[12]!, p.pose[13]!, p.pose[14]!]; console.log('at', p.name, c); }
else c = at.split(',').map(Number);
const tex = new Map<number, { width: number; height: number; rgba?: Uint8Array }>();
const keep: typeof m.meshes = [];
for (const [i, me] of m.meshes.entries()) {
  const idx: number[] = [], map = new Map<number, number>(), P: number[] = [], N: number[] = [], U: number[] = [];
  const inside = (v: number) => [0, 1, 2].every((a) => Math.abs(me.pos[v * 3 + a]! - c[a]!) < R);
  for (let t = 0; t < me.indices.length; t += 3) {
    const tri = [me.indices[t]!, me.indices[t + 1]!, me.indices[t + 2]!];
    if (!tri.every(inside)) continue;
    for (const v of tri) { let j = map.get(v); if (j === undefined) { j = P.length / 3; map.set(v, j); P.push(me.pos[v * 3]!, me.pos[v * 3 + 1]!, me.pos[v * 3 + 2]!); N.push(me.nor[v * 3]!, me.nor[v * 3 + 1]!, me.nor[v * 3 + 2]!); U.push(me.uv[v * 2]!, me.uv[v * 2 + 1]!); } idx.push(j); }
  }
  if (!idx.length) continue;
  const r = await s.resolveTexture(i); if (r.image?.rgba) tex.set(keep.length, r.image as any);
  keep.push({ ...me, vertexCount: P.length / 3, pos: Float32Array.from(P), nor: Float32Array.from(N), uv: Float32Array.from(U), bone: new Float32Array(P.length / 3 * 4), weight: new Float32Array(P.length / 3 * 4).map((_, k) => (k % 4 ? 0 : 1)), indices: Uint32Array.from(idx) });
}
const mm = { ...m, meshes: keep, bounds: boundsOf(keep), instances: undefined };

renderPPM(mm as any, out, { tex, yaw, pitch });
console.log('meshes', keep.length);
